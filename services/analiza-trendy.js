'use strict';

// Sprzedaż → Trendy (desktop, docs/analiza-sprzedazy.md „Etap 2”): kafle okresów, trend tygodniowy z rokiem temu,
// miesiące r/r, udział kanałów, grupy GT i produkty (okna 7 i 30 dni vs poprzednie okno albo rok temu) z kanałami
// i sztukami tygodniowo do widoku produktu. Decyzje usera 2026-10-21: tylko DNI ZAMKNIĘTE (koniec = wczoraj), listy
// bez limitu (zawężają filtry na ekranie), grupy top 30 z wejściem w grupę.
// Czyta db/sprzedaz.db (internet — bez paragonów Sklepu) i oferty z pricing.db (tylko odczyt, linki do ofert).
// ZASADA usera 2026-10-21: w ciągu dnia nic nie może przeszkadzać Zebrom — liczenie (~2,8 s synchronicznego SQLite na
// SRV) idzie w wątku analiz (services/analiza-watek.js, wywołuje job), wynik ląduje w tabeli `gotowe`, a API go tylko
// podaje. Odświeżane raz na godzinę i przy zmianie dnia (Trendy kończą się na wczoraj, więc dzień otwarty ich nie rusza).

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { db, meta } = require('../db/sprzedaz');
const am = require('./analiza-model');
const { dzisLokalnie } = require('./sprzedaz-model');
const { nazwaKanalu } = require('./analiza-kanal');
const { dostepneZeStanu } = require('./analiza-zapytania');

const D = am.dodajDni;
const R = (x) => Math.round(x || 0);
const NETTO = 'z.netto + IFNULL(z.wysylka_netto, 0) + IFNULL(z.doplata_netto, 0)';
const INTERNET = "z.status != 'paragon'";
const OKNA = [7, 30];
const TYGODNIE_GRUP = 13;
const NOWOSC_DNI = 30;
const ODSWIEZ_CO_MS = 60 * 60 * 1000;
const PRICING_DB = process.env.PRICING_DB || path.join(__dirname, '..', 'db', 'pricing.db');

// Kanały w udziale tygodniowym — zgrubnie, żeby wykres miał ≤ 6 serii (stała kolejność kolorów na ekranie)
const GRUPA_KANALU = (k) => (k.startsWith('ALLEGRO') ? 'Allegro' : ['DE', 'FR', 'IT', 'ES', 'NL', 'PL', 'AMAZON_EU'].includes(k) ? 'Amazon'
  : k.startsWith('EMAG') ? 'eMAG' : k.startsWith('EMPIK') ? 'Empik' : k.startsWith('KAUFLAND') ? 'Kaufland' : 'Inne');
const ostatniaNiedziela = (d) => { let x = d; while (new Date(x + 'T12:00:00Z').getUTCDay() !== 0) x = D(x, -1); return x; };

function sumy(od, doDnia) {
  return db.prepare(`SELECT ROUND(SUM(${NETTO})) netto, ROUND(SUM(z.zysk)) zysk, IFNULL(SUM(z.szt), 0) szt, COUNT(*) zam
    FROM zamowienia z WHERE ${INTERNET} AND z.data_zam BETWEEN ? AND ?`).get(od, doDnia);
}

function kafle(koniec) {
  return [['7 dni', D(koniec, -6)], ['30 dni', D(koniec, -29)], ['Miesiąc do wczoraj', koniec.slice(0, 8) + '01'],
    ['Rok do wczoraj', koniec.slice(0, 5) + '01-01'], ['12 miesięcy', D(koniec, -364)]]
    .map(([nazwa, od]) => ({ nazwa, od, do: koniec, cur: sumy(od, koniec), prevOd: am.rokTemu(od), prevDo: am.rokTemu(koniec),
      prev: sumy(am.rokTemu(od), am.rokTemu(koniec)) }));
}

// Pełne tygodnie pon–nd od początku historii do ostatniej niedzieli przed końcem
function tygodnie(start, niedziela) {
  const tyg = new Map();
  for (const x of db.prepare(`SELECT date(z.data_zam, 'weekday 0', '-6 days') pon, z.kanal, SUM(${NETTO}) netto, SUM(z.zysk) zysk,
      SUM(z.szt) szt, COUNT(*) zam FROM zamowienia z WHERE ${INTERNET} AND z.data_zam BETWEEN ? AND ? GROUP BY pon, z.kanal`).all(start, niedziela)) {
    const t = tyg.get(x.pon) || tyg.set(x.pon, { pon: x.pon, netto: 0, zysk: 0, szt: 0, zam: 0, kan: {} }).get(x.pon);
    t.netto += x.netto; t.zysk += x.zysk; t.szt += x.szt; t.zam += x.zam;
    const k = GRUPA_KANALU(x.kanal);
    t.kan[k] = (t.kan[k] || 0) + x.netto;
  }
  return [...tyg.values()].filter((t) => t.pon >= start).sort((a, b) => a.pon.localeCompare(b.pon))
    .map((t) => ({ ...t, netto: R(t.netto), zysk: R(t.zysk), kan: Object.fromEntries(Object.entries(t.kan).map(([k, v]) => [k, R(v)])) }));
}

function okno(od, doDnia) {
  return new Map(db.prepare(`SELECT p.tw_id, SUM(p.szt) szt, SUM(p.netto + IFNULL(p.wysylka, 0) + IFNULL(p.doplata, 0)) netto, SUM(p.zysk) zysk
    FROM pozycje p JOIN zamowienia z ON z.id = p.zam_id WHERE ${INTERNET} AND z.data_zam BETWEEN ? AND ? GROUP BY p.tw_id`)
    .all(od, doDnia).map((x) => [x.tw_id, x]));
}

// Kanały produktu: [nazwa, szt, netto, zysk] × (teraz, poprzednie okno, rok temu), klucz kanału (do linku), dopłata Allegro
// teraz (część netto; services/analiza-billing.js)
function kanalyProduktow(P) {
  const m = new Map();
  const zbierz = (od, doDnia, off) => {
    for (const x of db.prepare(`SELECT p.tw_id, z.kanal, z.rynek, SUM(p.szt) szt, SUM(p.netto + IFNULL(p.wysylka, 0) + IFNULL(p.doplata, 0)) netto, SUM(p.zysk) zysk,
        SUM(IFNULL(p.doplata, 0)) doplata
        FROM pozycje p JOIN zamowienia z ON z.id = p.zam_id WHERE ${INTERNET} AND z.data_zam BETWEEN ? AND ?
        GROUP BY p.tw_id, z.kanal, z.rynek`).all(od, doDnia)) {
      const nazwa = nazwaKanalu(x.kanal, x.rynek), k = `${x.tw_id}|${nazwa}`;
      const w = m.get(k) || m.set(k, [x.tw_id, nazwa, 0, 0, 0, 0, 0, 0, 0, 0, 0, x.kanal, 0]).get(k);
      w[2 + off] += x.szt; w[3 + off] += x.netto; w[4 + off] += x.zysk;
      if (off === 0) w[12] += x.doplata || 0;
    }
  };
  zbierz(P.od, P.do, 0); zbierz(P.prevOd, P.prevDo, 3); zbierz(P.rokOd, P.rokDo, 6);
  const po = {};
  for (const w of m.values()) (po[w[0]] ||= []).push([w[1], ...w.slice(2, 11).map(R), w[11], ...(w[12] ? [R(w[12])] : [])]);
  return po;
}

// Oferty towarów z repricera → linki na stronę platformy, per klucz kanału (ten sam co kanał w analizie:
// kluczKolumny). Karta produktu pyta o jeden towar przy otwarciu (GET /api/analiza/oferty/:tw_id) — w paczce Trendów
// linki do wszystkich ~3 tys. towarów to +1,8 MB. Best-effort: brak pricing.db albo błąd = karta bez linków.
function ofertyTowarow(ids) {
  if (!ids.size || !fs.existsSync(PRICING_DB)) return {};
  let p = null;
  try {
    const { kluczKolumny } = require('../pricing/kolumny');
    const { linkiOferty } = require('../pricing/linki');
    p = new DatabaseSync(PRICING_DB, { readOnly: true });
    const wynik = {};
    const lista = [...ids].filter(Number.isInteger);
    for (let i = 0; i < lista.length; i += 900) {
      const czesc = lista.slice(i, i + 900);
      for (const o of p.prepare(`SELECT tw_id, platforma, rynek, asin, sku, auto, kanal FROM oferty WHERE aktywna = 1 AND tw_id IN (${czesc.map(() => '?').join(',')})
          ORDER BY auto DESC, id`).all(...czesc)) {
        const l = linkiOferty(o);
        if (!l?.produkt) continue;
        ((wynik[o.tw_id] ||= {})[kluczKolumny(o.platforma, o.rynek)] ||= []).push({ produkt: l.produkt, oferty: l.oferty || null, sku: o.sku,
          auto: !!o.auto, fba: o.kanal === 'AMAZON_EU' });
      }
    }
    return wynik;
  } catch (e) {
    console.warn(`[analiza] trendy — oferty z repricera niedostępne: ${e.message}`);
    return {};
  } finally { p?.close(); }
}

function policz(dzis) {
  const koniec = D(dzis, -1), niedziela = ostatniaNiedziela(koniec);
  const start = meta.get('historia_od')?.wartosc || D(koniec, -730);
  const tyg = tygodnie(start, niedziela);
  const miesiace = db.prepare(`SELECT substr(z.data_zam, 1, 7) m, ROUND(SUM(${NETTO})) netto, ROUND(SUM(z.zysk)) zysk, SUM(z.szt) szt, COUNT(*) zam
    FROM zamowienia z WHERE ${INTERNET} AND z.data_zam BETWEEN ? AND ? GROUP BY m ORDER BY m`).all(start, koniec);
  // bieżący miesiąc rok temu do tego samego dnia — r/r niepełnego miesiąca
  const miesiacRokTemu = sumy(`${+koniec.slice(0, 4) - 1}${koniec.slice(4, 8)}01`, `${+koniec.slice(0, 4) - 1}${koniec.slice(4)}`);

  // dni bez stanu (odtworzone wstecz z dokumentów — analiza-dane.odtworzBezStanu). Zasięg „od|do”: okno sięgające poza
  // niego nie ma danych (null), zamiast udawać, że towar był cały czas na stanie.
  const [bzOd, bzDo] = (meta.get('bez_stanu')?.wartosc || '|').split('|');
  const przedzialy = new Map();
  if (bzOd) for (const x of db.prepare('SELECT tw_id, od, do FROM bez_stanu').all()) (przedzialy.get(x.tw_id) || przedzialy.set(x.tw_id, []).get(x.tw_id)).push([x.od, x.do]);
  const znamBezStanu = (od, doDnia) => !!bzOd && od >= bzOd && doDnia <= bzDo;

  const produkty = {}, kanaly = {}, wszystkie = new Set();
  for (const dl of OKNA) {
    const od = D(koniec, -dl + 1);
    const P = { od, do: koniec, prevOd: D(od, -dl), prevDo: D(od, -1), rokOd: am.rokTemu(od), rokDo: am.rokTemu(koniec) };
    const cur = okno(P.od, P.do), prev = okno(P.prevOd, P.prevDo), rok = okno(P.rokOd, P.rokDo);
    const v = (m, id) => { const x = m.get(id); return x ? [R(x.szt), R(x.netto), R(x.zysk)] : [0, 0, 0]; };
    const ids = new Set([...cur.keys(), ...prev.keys(), ...rok.keys()]);
    produkty[dl] = { ...P, w: [...ids].map((id) => { wszystkie.add(id); return [id, ...v(cur, id), ...v(prev, id), ...v(rok, id)]; }) };
    // bz: { tw_id: [dni bez stanu teraz, w poprzednim oknie, rok temu] } — tylko niezerowe; null w trójce = poza zasięgiem
    if (znamBezStanu(P.od, P.do)) {
      const zakres = [[P.od, P.do], [P.prevOd, P.prevDo], [P.rokOd, P.rokDo]];
      const bz = {};
      for (const id of ids) {
        const p = przedzialy.get(id);
        if (!p) continue;
        const t = zakres.map(([a, b]) => (znamBezStanu(a, b) ? am.dniBezStanuWOknie(p, a, b) : null));
        if (t.some((x) => x > 0)) bz[id] = t;
      }
      produkty[dl].bz = bz;
    }
    kanaly[dl] = kanalyProduktow(P);
  }

  // kartoteka, stan dostępny (Razem − rez.; zestaw ze składników), tempo 30 dni
  const tow = new Map(db.prepare('SELECT tw_id, symbol, nazwa, grupa, rodzaj, pierwsze_przyjecie FROM towary').all().map((x) => [x.tw_id, x]));
  const st = new Map();
  for (const s of db.prepare('SELECT * FROM stany WHERE dzien >= ? ORDER BY dzien DESC').all(D(koniec, -7))) if (!st.has(s.tw_id)) st.set(s.tw_id, s);
  const tp = new Map(db.prepare('SELECT tw_id, szt30 FROM tempa').all().map((x) => [x.tw_id, x.szt30]));
  const info = {};
  for (const id of wszystkie) {
    const t = tow.get(id) || {}, dost = dostepneZeStanu(st.get(id)), sz = tp.get(id) || 0;
    info[id] = [t.symbol || String(id), t.nazwa || '', t.grupa || '(bez grupy)',
      t.pierwsze_przyjecie && t.pierwsze_przyjecie >= D(koniec, -NOWOSC_DNI + 1) ? 1 : 0,
      dost, dost != null && sz > 0 ? Math.round(dost / (sz / 30)) : null, t.rodzaj === 8 ? 1 : 0];
  }

  // grupy i produkty tygodniowo (13 pełnych tygodni + te same tygodnie rok temu)
  const od13 = D(niedziela, -TYGODNIE_GRUP * 7 + 1);
  const tygodnie13 = Array.from({ length: TYGODNIE_GRUP }, (_, i) => D(od13, i * 7));
  const grTyg = {};
  for (const x of db.prepare(`SELECT IFNULL(NULLIF(t.grupa, ''), '(bez grupy)') g, date(z.data_zam, 'weekday 0', '-6 days') pon,
      SUM(p.netto + IFNULL(p.wysylka, 0) + IFNULL(p.doplata, 0)) netto FROM pozycje p JOIN zamowienia z ON z.id = p.zam_id LEFT JOIN towary t ON t.tw_id = p.tw_id
      WHERE ${INTERNET} AND z.data_zam BETWEEN ? AND ? GROUP BY g, pon`).all(od13, niedziela)) (grTyg[x.g] ||= {})[x.pon] = R(x.netto);
  const tygProd = {};
  const idx = (pon, od) => Math.round((new Date(pon + 'T12:00:00Z') - new Date(od + 'T12:00:00Z')) / (7 * 864e5));
  for (const [od, doDnia, off] of [[od13, niedziela, 0], [am.rokTemu(od13), am.rokTemu(niedziela), TYGODNIE_GRUP]]) {
    for (const x of db.prepare(`SELECT p.tw_id, date(z.data_zam, 'weekday 0', '-6 days') pon, SUM(p.szt) szt FROM pozycje p
        JOIN zamowienia z ON z.id = p.zam_id WHERE ${INTERNET} AND z.data_zam BETWEEN ? AND ? GROUP BY p.tw_id, pon`).all(od, doDnia)) {
      const i = idx(x.pon, od);
      if (!wszystkie.has(x.tw_id) || i < 0 || i >= TYGODNIE_GRUP) continue;
      (tygProd[x.tw_id] ||= Array(2 * TYGODNIE_GRUP).fill(0))[off + i] = R(x.szt);
    }
  }
  return { dzis, koniec, ostatniaNiedz: niedziela, kafle: kafle(koniec), tygodnie: tyg, miesiace, miesiacRokTemu,
    produkty, kanaly, info, grTyg, tygodnie13, tygProd, bezStanu: bzOd ? { od: bzOd, do: bzDo } : null, wygenerowano: new Date().toISOString() };
}

// --- gotowy wynik (wątek analiz liczy, API podaje) -------------------------------------------------------------
// gz: true → skompresowana wersja (gdy jest), inaczej sam JSON
const gotowe = ({ gz = false } = {}) => db.prepare(`SELECT ${gz ? 'gz' : 'json'} dane, dzien, czas FROM gotowe WHERE klucz = 'trendy'`).get() || null;

function odswiez(dzis = dzisLokalnie()) {
  const t0 = Date.now();
  const json = JSON.stringify(policz(dzis)), gz = zlib.gzipSync(json, { level: 6 });
  db.prepare(`INSERT INTO gotowe (klucz, json, gz, dzien, czas) VALUES ('trendy', ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(klucz) DO UPDATE SET json = excluded.json, gz = excluded.gz, dzien = excluded.dzien, czas = excluded.czas`).run(json, gz, dzis);
  return { ms: Date.now() - t0, kb: Math.round(json.length / 1024), gzKb: Math.round(gz.length / 1024) };
}

// Woła job (w wątku analiz) po każdym przebiegu: liczy, gdy brak wyniku, zmienił się dzień albo minęła godzina.
// wymus — przelicz mimo świeżego wyniku (job właśnie odtworzył dni bez stanu, filtr „Zakończone” ich potrzebuje)
function odswiezJesliTrzeba(teraz = new Date(), { wymus = false } = {}) {
  const dzis = dzisLokalnie(teraz), g = db.prepare("SELECT dzien, czas FROM gotowe WHERE klucz = 'trendy'").get();
  const wiek = g ? teraz.getTime() - new Date(g.czas.replace(' ', 'T') + 'Z').getTime() : Infinity;
  if (!wymus && g && g.dzien === dzis && wiek < ODSWIEZ_CO_MS) return null;
  return odswiez(dzis);
}

module.exports = { policz, odswiez, odswiezJesliTrzeba, gotowe, ofertyTowarow, GRUPA_KANALU, ostatniaNiedziela };
