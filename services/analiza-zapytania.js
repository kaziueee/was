'use strict';

// Moduł analiz sprzedaży — zapytania do db/sprzedaz.db wspólne dla API (routes/analiza.js) i raportu mailem
// (services/analiza-raport.js): jedna definicja liczb dla ekranu i maila. Nigdy GT; pricing.db best-effort.
//   przychód netto = cała faktura (towary + wysyłka klienta), suma na górze = internet (Sklep poza sumą — robi to
//   wyświetlanie, tu zwracamy wszystkie kanały), rok temu = −364 dni (docs/analiza-sprzedazy.md).

const { db, meta } = require('../db/sprzedaz');
const am = require('./analiza-model');
const { NAZWY_KANALOW } = require('./analiza-kanal');
const { dzisLokalnie } = require('./sprzedaz-model');
const { KOLUMNY, kluczKolumny } = require('../pricing/kolumny');

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;
const BAZY = {
  zam: { kol: 'data_zam', warunek: '1 = 1' },                                         // też ZK bez FS
  fs: { kol: 'data_fs', warunek: "status IN ('zafakturowane', 'paragon')" },
};
const POZA_SUMA = ['SKLEP'];   // jak /shared/sprzedaz-wspolne.js — paragony z MAG osobno

function parametry(q = {}) {
  const dzien = DATA_RE.test(String(q.dzien || '')) ? q.dzien : dzisLokalnie();
  const zakresNazwa = am.ZAKRESY.includes(q.zakres) ? q.zakres : 'dzien';
  const baza = BAZY[q.baza] ? q.baza : 'zam';
  return { dzien, zakresNazwa, baza, zakres: am.zakres(zakresNazwa, dzien, { dzis: dzisLokalnie() }), ...BAZY[baza] };
}

function stanWczytania() {
  return {
    historia_od: meta.get('historia_od')?.wartosc || null,
    historia_wczytana: meta.get('historia_wczytana')?.wartosc || null,
    biezacy: meta.get('biezacy')?.wartosc || null,
    nocny: meta.get('nocny')?.wartosc || null,
    blad: meta.get('blad')?.wartosc || null,
  };
}

function kanalyZakresu({ kol, warunek }, [od, doDnia]) {
  // netto = przychód netto CAŁEJ faktury: towary + wysyłka zapłacona przez klienta (jak FS i ERP Dashboard)
  const wiersze = db.prepare(`SELECT kanal, rynek, COUNT(*) zam, SUM(szt) szt, SUM(netto + IFNULL(wysylka_netto, 0)) netto, SUM(zysk) zysk,
      SUM(CASE WHEN zysk_zrodlo LIKE 'handlowa%' THEN netto + IFNULL(wysylka_netto, 0) ELSE 0 END) handl,
      SUM(CASE WHEN status = 'zamowione' THEN 1 ELSE 0 END) zamowione
    FROM zamowienia WHERE ${kol} BETWEEN ? AND ? AND ${warunek} GROUP BY kanal, rynek`).all(od, doDnia);
  const kanaly = {};
  for (const w of wiersze) {
    const k = kanaly[w.kanal] ||= { zam: 0, szt: 0, netto: 0, zysk: 0, handl: 0, zamowione: 0, rynki: {} };
    for (const p of ['zam', 'szt', 'netto', 'zysk', 'handl', 'zamowione']) k[p] += Number(w[p]) || 0;
    if (w.rynek) {
      const r = k.rynki[w.rynek] ||= { zam: 0, szt: 0, netto: 0, zysk: 0 };
      for (const p of ['zam', 'szt', 'netto', 'zysk']) r[p] += Number(w[p]) || 0;
    }
  }
  const zw = db.prepare('SELECT SUM(szt) szt, SUM(netto) netto FROM zwroty WHERE data BETWEEN ? AND ?').get(od, doDnia);
  return { kanaly, zwroty: { szt: Number(zw?.szt) || 0, netto: Number(zw?.netto) || 0 } };
}

// Suma kanałów bez tych „poza sumą” (internet).
function sumaInternetu(kanaly) {
  const s = { zam: 0, szt: 0, netto: 0, zysk: 0, handl: 0, zamowione: 0 };
  for (const [k, g] of Object.entries(kanaly)) { if (POZA_SUMA.includes(k)) continue; for (const p of Object.keys(s)) s[p] += g[p] || 0; }
  return s;
}

function podsumowanie(p) {
  const cur = kanalyZakresu(p, p.zakres.cur), prev = kanalyZakresu(p, p.zakres.prev);
  // dni nietypowe (przestój integracji, Black Friday) — tylko dla krótkich zakresów, gdzie psują porównanie
  let nietypowe = [];
  if (p.zakresNazwa === 'dzien' || p.zakresNazwa === 't7') {
    const dni = [...am.dniZakresu(p.zakres.prev), ...am.dniZakresu(p.zakres.cur)];
    const liczby = new Map(db.prepare(`SELECT ${p.kol} dzien, COUNT(*) n FROM zamowienia
      WHERE ${p.kol} BETWEEN ? AND ? AND status != 'paragon' GROUP BY ${p.kol}`)
      .all(am.dodajDni(p.zakres.prev[0], -3), am.dodajDni(p.zakres.cur[1], 3)).map((x) => [x.dzien, x.n]));
    nietypowe = am.dniNietypowe(liczby, dni, { dzis: dzisLokalnie() });
  }
  const st = stanWczytania();
  return {
    dzien: p.dzien, zakres: p.zakresNazwa, baza: p.baza, okresy: p.zakres, cur, prev, nietypowe,
    historia_pelna: !!(st.historia_od && st.historia_od <= p.zakres.prev[0]), wczytanie: st, nazwy: NAZWY_KANALOW,
  };
}

// --- produkty --------------------------------------------------------------------------------------------------
const lista = (ids) => ids.map(() => '?').join(',');

// Tempo sprzedaży (FS + zużycie w zestawach) z tabeli `tempa`, którą przelicza job (services/analiza-dane.js).
function tempa(ids) {
  const m = new Map(ids.map((id) => [id, { szt30: 0, szt180: 0, szt365: 0 }]));
  if (!ids.length) return m;
  for (const r of db.prepare(`SELECT tw_id, szt30, szt180, szt365 FROM tempa WHERE tw_id IN (${lista(ids)})`).all(...ids)) {
    m.set(r.tw_id, { szt30: r.szt30, szt180: r.szt180, szt365: r.szt365 });
  }
  return m;
}

// Repricer: oferty towaru (aktywne) z ostatnią obserwacją Buy Boxa + przypisana strategia. pricing.db pisze osobny
// proces — czytamy best-effort: brak bazy albo błąd = bez sekcji repricera, a nie błąd całego ekranu.
function repricer(ids) {
  const wynik = new Map();
  if (!ids.length) return wynik;
  try {
    const { db: pdb } = require('../pricing/db');
    const waluty = Object.fromEntries(KOLUMNY.map((k) => [k.klucz, k.waluta]));
    const oferty = pdb.prepare(`SELECT o.tw_id, o.platforma, o.rynek, o.auto, o.cena,
        (SELECT b.bb_nasz FROM obserwacje b WHERE b.oferta_id = o.id ORDER BY b.czas DESC LIMIT 1) bb
      FROM oferty o WHERE o.aktywna = 1 AND o.tw_id IN (${lista(ids)})`).all(...ids);
    for (const o of oferty) {
      const k = kluczKolumny(o.platforma, o.rynek);
      if (!waluty[k]) continue;
      const t = wynik.get(o.tw_id) || wynik.set(o.tw_id, { oferty: {}, strategia: null }).get(o.tw_id);
      const x = t.oferty[k] ||= { k, auto: false, bb: null, cena: o.cena, n: 0, waluta: waluty[k] };
      x.n += 1; x.auto = x.auto || !!o.auto; if (o.bb === 1 || x.bb == null) x.bb = o.bb;
    }
    for (const s of pdb.prepare(`SELECT st.tw_id, s.nazwa, s.aktywna, st.do FROM strategie_towarow st JOIN strategie s ON s.id = st.strategia_id
        WHERE st.tw_id IN (${lista(ids)})`).all(...ids)) {
      const t = wynik.get(s.tw_id) || wynik.set(s.tw_id, { oferty: {}, strategia: null }).get(s.tw_id);
      t.strategia = { nazwa: s.nazwa, aktywna: !!s.aktywna, do: s.do };
    }
  } catch (e) {
    console.error('[analiza] repricer:', e.message);
    return null;
  }
  return wynik;
}

// Stan dostępny ze zdjęcia: Razem − rezerwacje (zestaw: kompletów ze składników). Wiersze sprzed 2026-10-21 nie mają
// kolumny — wtedy Razem − rezerwacja K4 (rezerwacje poza K4 są rzadkie).
const dostepneZeStanu = (s) => (!s ? null : s.dostepne != null ? s.dostepne : Math.max(0, (s.razem || 0) - (s.rez_k4 || 0)));

// Ostatnie zdjęcie stanów każdego towaru.
function stanyTowarow(ids) {
  const m = new Map();
  if (!ids.length) return m;
  for (const s of db.prepare(`SELECT * FROM stany WHERE tw_id IN (${lista(ids)}) ORDER BY dzien DESC`).all(...ids)) if (!m.has(s.tw_id)) m.set(s.tw_id, s);
  return m;
}

// Karta towaru: kartoteka, stan, tempo, dni zapasu, flagi, repricer. t = { tw_id, szt, netto, zysk, kanaly }.
function uzupelnijTowary(lista_, { zRepricerem = true } = {}) {
  const ids = lista_.map((t) => t.tw_id);
  const dzis = dzisLokalnie();
  const towary = new Map(ids.length ? db.prepare(`SELECT * FROM towary WHERE tw_id IN (${lista(ids)})`).all(...ids).map((x) => [x.tw_id, x]) : []);
  const stany = stanyTowarow(ids), tp = tempa(ids), rep = zRepricerem ? repricer(ids) : null;
  const st = stanWczytania();
  const rok = !!(st.historia_od && st.historia_od <= am.dodajDni(dzis, -365));     // flagi z roku tylko przy pełnej historii
  return {
    rok,
    produkty: lista_.map((t) => {
      const k = towary.get(t.tw_id) || {}, s = stany.get(t.tw_id) || null, x = tp.get(t.tw_id);
      const stan = dostepneZeStanu(s);
      const flagi = s ? am.flagiTowaru({ stan, ...x, pierwszePrzyjecie: k.pierwsze_przyjecie, dzis })
        .filter((f) => rok || !['nadmiar', 'zalega'].includes(f)) : [];
      const r = rep ? rep.get(t.tw_id) : null;
      return {
        ...t, kanaly: (t.kanaly || []).sort((a, b) => b.netto - a.netto),
        symbol: k.symbol || null, nazwa: k.nazwa || null, grupa: k.grupa || null, zestaw: k.rodzaj === 8,
        stan: s ? { dostepne: stan, razem: s.razem, rez: s.rez ?? s.rez_k4, dzien: s.dzien, czas: s.czas } : null,
        szt30: x.szt30, dni_zapasu: stan != null ? am.dniZapasu(stan, x.szt30) : null, flagi,
        repricer: !zRepricerem || rep === null ? null : { oferty: Object.values(r?.oferty || {}), strategia: r?.strategia || null },
      };
    }),
  };
}

// Przegląd produktów = tylko sprzedaż z K4 (FS i ZK) — bez paragonów Sklepu z MAG (decyzja usera 2026-10-20).
// Sklep zostaje osobnym wierszem w tabeli kanałów („poza sumą”), ale nie miesza listy produktów.
function produkty(p, { sort = 'zysk', limit = 500, zRepricerem = true } = {}) {
  const wiersze = db.prepare(`SELECT x.tw_id, z.kanal, SUM(x.szt) szt, SUM(x.netto + IFNULL(x.wysylka, 0)) netto, SUM(x.zysk) zysk,
      MAX(CASE WHEN z.zysk_zrodlo LIKE 'handlowa%' THEN 1 ELSE 0 END) handl
    FROM pozycje x JOIN zamowienia z ON z.id = x.zam_id
    WHERE z.${p.kol} BETWEEN ? AND ? AND ${p.warunek.replace('status', 'z.status')} AND z.status != 'paragon'
    GROUP BY x.tw_id, z.kanal`).all(...p.zakres.cur);
  const tw = new Map();
  for (const w of wiersze) {
    const t = tw.get(w.tw_id) || tw.set(w.tw_id, { tw_id: w.tw_id, szt: 0, netto: 0, zysk: 0, kanaly: [] }).get(w.tw_id);
    t.szt += w.szt; t.netto += w.netto; t.zysk += w.zysk || 0;
    t.kanaly.push({ k: w.kanal, szt: w.szt, netto: w.netto, zysk: w.zysk, handl: !!w.handl });
  }
  const wszystkie = [...tw.values()].sort((a, b) => b[sort] - a[sort]);
  const { rok, produkty: lista_ } = uzupelnijTowary(wszystkie.slice(0, limit), { zRepricerem });
  return { dzien: p.dzien, zakres: p.zakresNazwa, baza: p.baza, razem: wszystkie.length, nazwy: NAZWY_KANALOW, historia_rok: rok, produkty: lista_ };
}

module.exports = { BAZY, POZA_SUMA, parametry, stanWczytania, kanalyZakresu, sumaInternetu, podsumowanie, produkty, uzupelnijTowary, tempa, stanyTowarow,
  dostepneZeStanu };
