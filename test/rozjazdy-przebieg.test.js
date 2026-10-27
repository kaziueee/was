'use strict';

// Zapisujaca czesc joba rozjazdow (services/rozjazdy-przebieg.js) na bazie w pamieci - bez
// db/wms.db i bez GT. Najwazniejsze: caly przebieg to JEDNA transakcja (commit na kazdy zapis
// kosztowal na SRV ~70 ms glownego watku na korekte), wiec blad w polowie nie zostawia
// polowicznych korekt, a wpis audytu idzie w tej samej transakcji co zmiana polki.

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const { zastosujPrzebieg, opisPrzebiegu } = require('../services/rozjazdy-przebieg');

function baza() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE lokalizacje (id INTEGER PRIMARY KEY, kod TEXT, magazyn TEXT);
    CREATE TABLE stany_lokalizacji (id INTEGER PRIMARY KEY, lokalizacja_id INTEGER, artykul_gt_id TEXT,
      artykul_symbol TEXT, ilosc INTEGER, ostatnia_zmiana DATETIME, operator TEXT);
    CREATE TABLE rozjazdy (id INTEGER PRIMARY KEY, artykul_gt_id TEXT, artykul_symbol TEXT, magazyn TEXT,
      ilosc_gt INTEGER, ilosc_wms INTEGER, roznica INTEGER, status TEXT, opis TEXT,
      wykryty DATETIME DEFAULT CURRENT_TIMESTAMP, wyjasniony DATETIME);
    CREATE TABLE audyt (id INTEGER PRIMARY KEY, akcja TEXT, artykul_gt_id TEXT, przed TEXT, po TEXT);
    INSERT INTO lokalizacje VALUES (1, 'M2-A1-P1', 'K4'), (2, 'M2-A2-P1', 'K4'), (3, 'M2-C6-P2', 'K4G');
    INSERT INTO stany_lokalizacji (id, lokalizacja_id, artykul_gt_id, artykul_symbol, ilosc) VALUES
      (1, 1, '100', 'AAA', 10),
      (2, 2, '200', 'BBB', 5),
      (3, 3, '300', 'CCC', 8);
  `);
  return db;
}

// wpis audytu tym samym polaczeniem - jak services/audyt.js na globalnym db/database
const audytDo = (db) => (w) => db.prepare('INSERT INTO audyt (akcja, artykul_gt_id, przed, po) VALUES (?, ?, ?, ?)')
  .run(w.akcja, String(w.artykul_gt_id), JSON.stringify(w.przed), JSON.stringify(w.po));

const stany = (wpisy) => new Map(Object.entries(wpisy).map(([id, mag]) => [id, Object.fromEntries(
  Object.entries(mag).map(([m, ilosc]) => [m, { ilosc, rezerwacja: 0 }]))]));

const WIERSZE = [
  { artykul_gt_id: '100', artykul_symbol: 'AAA', magazyn: 'K4', ilosc_wms: 10 },
  { artykul_gt_id: '200', artykul_symbol: 'BBB', magazyn: 'K4', ilosc_wms: 5 },
  { artykul_gt_id: '300', artykul_symbol: 'CCC', magazyn: 'K4G', ilosc_wms: 8 },
];

test('korekty K4 sciagaja polke do GT, K4G < WMS otwiera rozjazd, audyt per korekta', () => {
  const db = baza();
  const wynik = zastosujPrzebieg(db, {
    wiersze: WIERSZE, osierocone: [],
    stanyMap: stany({ 100: { K4: 7 }, 200: { K4: 2 }, 300: { K4G: 6 } }),
    zapiszAudyt: audytDo(db),
  });

  assert.deepEqual(wynik, { sprawdzone: 3, korekty_k4: 2, rozjazdy_k4g_nowe: 1, rozjazdy_k4g_zaktualizowane: 0, rozjazdy_k4g_wyjasnione: 0 });
  assert.deepEqual(db.prepare('SELECT id, ilosc FROM stany_lokalizacji ORDER BY id').all().map((r) => ({ ...r })),
    [{ id: 1, ilosc: 7 }, { id: 2, ilosc: 2 }, { id: 3, ilosc: 8 }]);   // K4G nie korygowany automatem
  assert.equal(db.prepare("SELECT COUNT(*) n FROM rozjazdy WHERE magazyn = 'K4' AND status = 'wyjasniony'").get().n, 2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM rozjazdy WHERE magazyn = 'K4G' AND status = 'nowy'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audyt WHERE akcja = 'korekta_auto'").get().n, 2);
  assert.equal(db.isTransaction, false);
});

test('caly przebieg idzie w JEDNEJ transakcji - audyt pisze w jej srodku', () => {
  const db = baza();
  const wTransakcji = [];
  zastosujPrzebieg(db, {
    wiersze: WIERSZE, osierocone: [],
    stanyMap: stany({ 100: { K4: 7 }, 200: { K4: 2 }, 300: { K4G: 8 } }),
    zapiszAudyt: (w) => { wTransakcji.push(db.isTransaction); audytDo(db)(w); },
  });
  assert.deepEqual(wTransakcji, [true, true]);
  assert.equal(db.isTransaction, false);
});

test('blad w polowie przebiegu wycofuje WSZYSTKO - zadnych polowicznych korekt', () => {
  const db = baza();
  let wpisow = 0;
  assert.throws(() => zastosujPrzebieg(db, {
    wiersze: WIERSZE, osierocone: [],
    stanyMap: stany({ 100: { K4: 7 }, 200: { K4: 2 }, 300: { K4G: 6 } }),
    zapiszAudyt: (w) => { if (++wpisow === 2) throw new Error('awaria zapisu'); audytDo(db)(w); },
  }), /awaria zapisu/);

  assert.equal(db.isTransaction, false);   // nic nie zostalo otwarte dla nastepnych zapisow
  assert.deepEqual(db.prepare('SELECT ilosc FROM stany_lokalizacji ORDER BY id').all().map((r) => r.ilosc), [10, 5, 8]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM rozjazdy').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audyt').get().n, 0);
});

test('otwarty rozjazd K4G: aktualizowany, gdy roznica trwa; wyjasniany, gdy ustapila albo wiersz WMS zniknal', () => {
  const db = baza();
  db.exec(`INSERT INTO rozjazdy (artykul_gt_id, artykul_symbol, magazyn, ilosc_gt, ilosc_wms, roznica, status) VALUES
    ('300', 'CCC', 'K4G', 6, 8, -2, 'nowy'), ('400', 'DDD', 'K4G', 1, 3, -2, 'nowy')`);

  const trwa = zastosujPrzebieg(db, {
    wiersze: [WIERSZE[2]], osierocone: [],
    stanyMap: stany({ 300: { K4G: 5 } }), zapiszAudyt: audytDo(db),
  });
  assert.equal(trwa.rozjazdy_k4g_zaktualizowane, 1);
  assert.equal(db.prepare("SELECT roznica FROM rozjazdy WHERE artykul_gt_id = '300'").get().roznica, -3);

  const ustapil = zastosujPrzebieg(db, {
    wiersze: [WIERSZE[2]], osierocone: [{ artykul_gt_id: '400' }],
    stanyMap: stany({ 300: { K4G: 8 }, 400: { K4G: 1 } }), zapiszAudyt: audytDo(db),
  });
  assert.equal(ustapil.rozjazdy_k4g_wyjasnione, 2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM rozjazdy WHERE status = 'nowy'").get().n, 0);
});

test('K4 z dwiema polkami z zapasem nie jest korygowany automatem (1 SKU = 1 lokalizacja)', () => {
  const db = baza();
  db.exec("INSERT INTO stany_lokalizacji (id, lokalizacja_id, artykul_gt_id, artykul_symbol, ilosc) VALUES (4, 2, '100', 'AAA', 3)");
  const wynik = zastosujPrzebieg(db, {
    wiersze: [{ artykul_gt_id: '100', artykul_symbol: 'AAA', magazyn: 'K4', ilosc_wms: 13 }], osierocone: [],
    stanyMap: stany({ 100: { K4: 7 } }), zapiszAudyt: audytDo(db),
  });
  assert.equal(wynik.korekty_k4, 0);
  assert.deepEqual(db.prepare("SELECT ilosc FROM stany_lokalizacji WHERE artykul_gt_id = '100' ORDER BY id").all().map((r) => r.ilosc), [10, 3]);
});

test('linia logu ma liczby przebiegu i trzy czasy', () => {
  const linia = opisPrzebiegu(
    { sprawdzone: 3691, korekty_k4: 41, rozjazdy_k4g_nowe: 0, rozjazdy_k4g_zaktualizowane: 2, rozjazdy_k4g_wyjasnione: 1 },
    { sumy_ms: 17.4, gt_ms: 164.2, zapis_ms: 38.6 });
  assert.equal(linia, 'sprawdzone 3691, korekty K4 41, K4G nowe 0 / zaktualizowane 2 / wyjasnione 1 | sumy WMS 17 ms, GT 164 ms, zapis 39 ms');
});
