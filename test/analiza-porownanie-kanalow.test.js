'use strict';

// Porównanie po kanałach (Sprzedaż → Dzień i Trendy, decyzja usera 2026-10-30: „wybieram Amazon DE i widzę spadki na
// kategoriach”) — zapytanie grup z filtrem kanału (services/analiza-zapytania.js), dane per kanał w paczce Trendów
// (services/analiza-trendy.js) i wiersze produktów z jednego kanału (public/shared/trendy-model.js). Baza tymczasowa.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const katalog = fs.mkdtempSync(path.join(os.tmpdir(), 'wms-porownanie-'));
process.env.SPRZEDAZ_DB = path.join(katalog, 'sprzedaz.db');
process.env.PRICING_DB = path.join(katalog, 'brak-pricing.db');

const { db } = require('../db/sprzedaz');
const q = require('../services/analiza-zapytania');
const trendy = require('../services/analiza-trendy');
const M = require('../public/shared/trendy-model');
const am = require('../services/analiza-model');

const DZIS = '2026-10-30', WCZORAJ = '2026-10-29', ROK = am.rokTemu(WCZORAJ);
let nr = 0;
function zamowienie(data, kanal, pozycje, rynek = null) {
  const id = 'Z' + (++nr);
  db.prepare(`INSERT INTO zamowienia (id, zk_id, status, data_zam, kanal, rynek, szt, netto, zysk) VALUES (?, ?, 'zafakturowane', ?, ?, ?, ?, ?, ?)`)
    .run(id, nr, data, kanal, rynek, pozycje.reduce((a, p) => a + p[1], 0), pozycje.reduce((a, p) => a + p[2], 0), pozycje.reduce((a, p) => a + p[3], 0));
  for (const [tw, szt, netto, zysk] of pozycje) db.prepare('INSERT INTO pozycje (zam_id, tw_id, szt, netto, zysk) VALUES (?, ?, ?, ?, ?)').run(id, tw, szt, netto, zysk);
}

db.prepare("INSERT INTO towary (tw_id, symbol, nazwa, grupa) VALUES (1, 'NERF1', 'Nerf', 'NERF'), (2, 'LEGO1', 'Lego', 'LEGO'), (3, 'X', 'Bez grupy', '')").run();
// wczoraj: Amazon DE sprzedał 1×NERF, FR 2×LEGO, Allegro CZ 1×NERF; rok temu: Amazon DE 5×NERF, 1×LEGO
zamowienie(WCZORAJ, 'DE', [[1, 1, 100, 20]]);
zamowienie(WCZORAJ, 'FR', [[2, 2, 300, 60]]);
zamowienie(WCZORAJ, 'ALLEGRO_EKAJTEK', [[1, 1, 90, 10]], 'CZ');
zamowienie(WCZORAJ, 'ALLEGRO_EKAJTEK', [[3, 1, 50, 5]], 'PL');
zamowienie(ROK, 'DE', [[1, 5, 500, 100], [2, 1, 150, 30]]);

const parametry = () => q.parametry({ dzien: WCZORAJ, zakres: 'dzien' });
const grupa = (wynik, g) => wynik.grupy.find((x) => x.grupa === g);

test('warunekKanalu: kanał, kanał z rynkiem Allegro, platforma, śmieci = wszystkie', () => {
  assert.deepStrictEqual(q.warunekKanalu('k:DE').args, ['DE']);
  assert.deepStrictEqual(q.warunekKanalu('k:ALLEGRO_EKAJTEK|CZ').args, ['ALLEGRO_EKAJTEK', 'CZ']);
  const p = q.warunekKanalu('p:Amazon');
  assert.ok(p.args.includes('DE') && p.args.includes('FR') && !p.args.includes('EMAG_RO'));
  for (const zly of ['', 'DE', "k:DE' OR 1=1", 'x:DE']) assert.deepStrictEqual(q.warunekKanalu(zly), { sql: '', args: [], kanal: '' });
});

test('grupy w jednym kanale vs rok temu — spadek NERF na Amazon DE', () => {
  const de = q.grupy(parametry(), { kanal: 'k:DE' });
  assert.equal(de.kanal, 'k:DE');
  assert.deepStrictEqual(grupa(de, 'NERF').cur, { szt: 1, netto: 100, zysk: 20, sku: 1 });
  assert.deepStrictEqual(grupa(de, 'NERF').prev, { szt: 5, netto: 500, zysk: 100, sku: 1 });
  assert.equal(grupa(de, 'LEGO').cur.netto, 0, 'LEGO zgasło na DE — zostaje na liście z zerem teraz');
  assert.equal(grupa(de, 'LEGO').prev.netto, 150);
  // cała platforma = DE + FR
  assert.equal(grupa(q.grupy(parametry(), { kanal: 'p:Amazon' }), 'LEGO').cur.netto, 300);
  // wszystkie kanały: NERF = DE + Allegro CZ, pusta grupa → „(bez grupy)”
  const wsz = q.grupy(parametry());
  assert.equal(grupa(wsz, 'NERF').cur.netto, 190);
  assert.equal(grupa(wsz, '(bez grupy)').cur.netto, 50);
  assert.equal(grupa(q.grupy(parametry(), { kanal: 'k:ALLEGRO_EKAJTEK|CZ' }), 'NERF').cur.netto, 90);
});

test('produkty z filtrem kanału liczą tylko ten kanał', () => {
  const de = q.produkty(parametry(), { kanal: 'k:DE', zRepricerem: false });
  assert.deepStrictEqual(de.produkty.map((p) => [p.tw_id, p.netto]), [[1, 100]]);
  assert.equal(q.produkty(parametry(), { zRepricerem: false }).produkty.length, 3);
});

test('Trendy: kanały per produkt → wiersze jednego kanału i platformy', () => {
  const X = trendy.policz(DZIS);
  assert.equal(X.platformy['Amazon DE'], 'Amazon');
  assert.equal(X.platformy['Allegro ekajtek · CZ'] || X.platformy[Object.keys(X.platformy).find((n) => n.includes('CZ'))], 'Allegro');
  const de = M.wiersze(X, 30, 'rok', 'k:Amazon DE');
  assert.deepStrictEqual(de.map((w) => [w.id, w.a.n, w.b.n]), [[1, 100, 500], [2, 0, 150]]);
  const amazon = M.wiersze(X, 30, 'rok', 'p:Amazon');
  assert.equal(amazon.find((w) => w.id === 2).a.n, 300, 'platforma sumuje rynki');
  assert.equal(M.wiersze(X, 30, 'rok').find((w) => w.id === 1).a.n, 190, 'bez kanału — jak dotąd');
  const wybor = M.kanalyDoWyboru(X, 30);
  assert.equal(wybor[0].platforma, 'Amazon');
  assert.deepStrictEqual(wybor[0].kanaly.map((k) => k.nazwa), ['Amazon FR', 'Amazon DE']);
  assert.equal(M.nazwaWyboru('p:Amazon'), 'Amazon — wszystkie rynki');
});
