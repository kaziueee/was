'use strict';

// Moduł analiz sprzedaży — API (docs/analiza-sprzedazy.md). Czyta WYŁĄCZNIE db/sprzedaz.db (i pricing.db do
// stanu repricera), nigdy GT — tak ekrany są szybkie także na telefonie. Montowane z auth.wymagajRoli('admin',
// 'biuro'), także odczyt (koszty zakupu i zysk nie są dla hali).
//   GET /api/analiza/stan                                     kiedy wczytano, od kiedy jest historia
//   GET /api/analiza/podsumowanie?dzien=&zakres=&baza=         kanały: bieżący zakres vs ten sam sprzed 364 dni
//   GET /api/analiza/produkty?dzien=&zakres=&baza=&sort=&limit= towary z kanałami, stanem, flagami i repricerem
// zakres: dzien | t7 | mtd | ytd · baza: zam (data zamówienia) | fs (data faktury) · sort: zysk | szt | netto

const express = require('express');
const router = express.Router();
const { db, meta } = require('../db/sprzedaz');
const am = require('../services/analiza-model');
const { NAZWY_KANALOW } = require('../services/analiza-kanal');
const { dzisLokalnie } = require('../services/sprzedaz-model');
const { KOLUMNY, kluczKolumny } = require('../pricing/kolumny');

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;
const BAZY = {
  zam: { kol: 'data_zam', warunek: '1 = 1' },                                         // też ZK bez FS
  fs: { kol: 'data_fs', warunek: "status IN ('zafakturowane', 'paragon')" },
};

function parametry(q) {
  const dzien = DATA_RE.test(String(q.dzien || '')) ? q.dzien : dzisLokalnie();
  const zakresNazwa = am.ZAKRESY.includes(q.zakres) ? q.zakres : 'dzien';
  const baza = BAZY[q.baza] ? q.baza : 'zam';
  return { dzien, zakresNazwa, baza, zakres: am.zakres(zakresNazwa, dzien), ...BAZY[baza] };
}

function stanWczytania() {
  return {
    historia_od: meta.get('historia_od')?.wartosc || null,
    biezacy: meta.get('biezacy')?.wartosc || null,
    nocny: meta.get('nocny')?.wartosc || null,
    blad: meta.get('blad')?.wartosc || null,
  };
}

router.get('/stan', (req, res) => res.json({ ...stanWczytania(), dzis: dzisLokalnie() }));

function kanalyZakresu({ kol, warunek }, [od, doDnia]) {
  const wiersze = db.prepare(`SELECT kanal, rynek, COUNT(*) zam, SUM(szt) szt, SUM(netto) netto, SUM(zysk) zysk,
      SUM(CASE WHEN zysk_zrodlo LIKE 'handlowa%' THEN netto ELSE 0 END) handl,
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

router.get('/podsumowanie', (req, res) => {
  const p = parametry(req.query);
  const cur = kanalyZakresu(p, p.zakres.cur), prev = kanalyZakresu(p, p.zakres.prev);
  // dni nietypowe (przestój integracji, Black Friday) — tylko dla krótkich zakresów, gdzie psują porównanie
  let nietypowe = [];
  if (p.zakresNazwa === 'dzien' || p.zakresNazwa === 't7') {
    const dni = [...am.dniZakresu(p.zakres.prev), ...am.dniZakresu(p.zakres.cur)];
    const liczby = new Map(db.prepare(`SELECT ${p.kol} dzien, COUNT(*) n FROM zamowienia
      WHERE ${p.kol} BETWEEN ? AND ? AND status != 'paragon' GROUP BY ${p.kol}`)
      .all(am.dodajDni(p.zakres.prev[0], -28), p.zakres.cur[1]).map((x) => [x.dzien, x.n]));
    nietypowe = am.dniNietypowe(liczby, dni);
  }
  const st = stanWczytania();
  res.json({
    dzien: p.dzien, zakres: p.zakresNazwa, baza: p.baza, okresy: p.zakres, cur, prev, nietypowe,
    historia_pelna: !!(st.historia_od && st.historia_od <= p.zakres.prev[0]), wczytanie: st, nazwy: NAZWY_KANALOW,
  });
});

// --- produkty --------------------------------------------------------------------------------------------------
const lista = (ids) => ids.map(() => '?').join(',');

// Tempo sprzedaży (FS + zużycie w zestawach) z tabeli `tempa`, którą przelicza job (services/analiza-dane.js).
function tempa(ids) {
  const m = new Map(ids.map((id) => [id, { szt30: 0, szt180: 0, szt365: 0 }]));
  for (const r of db.prepare(`SELECT tw_id, szt30, szt180, szt365 FROM tempa WHERE tw_id IN (${lista(ids)})`).all(...ids)) {
    m.set(r.tw_id, { szt30: r.szt30, szt180: r.szt180, szt365: r.szt365 });
  }
  return m;
}

// Repricer: oferty towaru (aktywne) z ostatnią obserwacją Buy Boxa + przypisana strategia. pricing.db pisze osobny
// proces — czytamy best-effort: brak bazy albo błąd = karta bez sekcji repricera, a nie błąd całego ekranu.
function repricer(ids) {
  const wynik = new Map();
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

router.get('/produkty', (req, res) => {
  const p = parametry(req.query);
  const sort = ['zysk', 'szt', 'netto'].includes(req.query.sort) ? req.query.sort : 'zysk';
  const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 2000);
  const wiersze = db.prepare(`SELECT x.tw_id, z.kanal, SUM(x.szt) szt, SUM(x.netto) netto, SUM(x.zysk) zysk,
      MAX(CASE WHEN z.zysk_zrodlo LIKE 'handlowa%' THEN 1 ELSE 0 END) handl
    FROM pozycje x JOIN zamowienia z ON z.id = x.zam_id
    WHERE z.${p.kol} BETWEEN ? AND ? AND ${p.warunek.replace('status', 'z.status')} GROUP BY x.tw_id, z.kanal`).all(...p.zakres.cur);
  const tw = new Map();
  for (const w of wiersze) {
    const t = tw.get(w.tw_id) || tw.set(w.tw_id, { tw_id: w.tw_id, szt: 0, netto: 0, zysk: 0, kanaly: [] }).get(w.tw_id);
    t.szt += w.szt; t.netto += w.netto; t.zysk += w.zysk || 0;
    t.kanaly.push({ k: w.kanal, szt: w.szt, netto: w.netto, zysk: w.zysk, handl: !!w.handl });
  }
  const wszystkie = [...tw.values()].sort((a, b) => b[sort] - a[sort]);
  const strona = wszystkie.slice(0, limit);
  const ids = strona.map((t) => t.tw_id);
  if (!ids.length) return res.json({ dzien: p.dzien, zakres: p.zakresNazwa, baza: p.baza, razem: 0, produkty: [], nazwy: NAZWY_KANALOW });

  const dzis = dzisLokalnie();
  const towary = new Map(db.prepare(`SELECT * FROM towary WHERE tw_id IN (${lista(ids)})`).all(...ids).map((x) => [x.tw_id, x]));
  const stany = new Map();
  for (const s of db.prepare(`SELECT * FROM stany WHERE tw_id IN (${lista(ids)}) ORDER BY dzien DESC`).all(...ids)) if (!stany.has(s.tw_id)) stany.set(s.tw_id, s);
  const tp = tempa(ids);
  const rep = repricer(ids);
  const st = stanWczytania();
  const rok = !!(st.historia_od && st.historia_od <= am.dodajDni(dzis, -365));     // flagi z roku tylko przy pełnej historii
  res.json({
    dzien: p.dzien, zakres: p.zakresNazwa, baza: p.baza, razem: wszystkie.length, nazwy: NAZWY_KANALOW, historia_rok: rok,
    produkty: strona.map((t) => {
      const k = towary.get(t.tw_id) || {}, s = stany.get(t.tw_id) || null, x = tp.get(t.tw_id);
      const stan = s ? (s.k4 || 0) + (s.k4g || 0) : null;
      const flagi = s ? am.flagiTowaru({ stan, ...x, pierwszePrzyjecie: k.pierwsze_przyjecie, dzis })
        .filter((f) => rok || !['nadmiar', 'zalega'].includes(f)) : [];
      const r = rep ? rep.get(t.tw_id) : null;
      return {
        ...t, kanaly: t.kanaly.sort((a, b) => b.netto - a.netto),
        symbol: k.symbol || null, nazwa: k.nazwa || null, grupa: k.grupa || null, zestaw: k.rodzaj === 8,
        stan: s ? { k4: s.k4, k4g: s.k4g, mag: s.mag, ls: s.ls, rez_k4: s.rez_k4, razem: s.razem, dzien: s.dzien, czas: s.czas } : null,
        szt30: x.szt30, dni_zapasu: stan != null ? am.dniZapasu(stan, x.szt30) : null, flagi,
        repricer: rep === null ? null : { oferty: Object.values(r?.oferty || {}), strategia: r?.strategia || null },
      };
    }),
  });
});

module.exports = router;
