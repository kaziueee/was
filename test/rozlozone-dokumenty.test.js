'use strict';

// Licznik "ile z dokumentu juz rozlozono" (services/rozlozone-dokumenty.js) na bazie w pamieci.
// Najwazniejszy przypadek: przenumerowanie PZ po zmianie daty FZ w Subiekcie (Intek, 2026-11-18)
// nie moze cofnac rozlozen - dokument rozpoznajemy po dok_Id.

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const { iloscRozlozona } = require('../services/rozlozone-dokumenty');

function baza(ruchy) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE ruchy (id INTEGER PRIMARY KEY, artykul_gt_id TEXT, mag_zrodlo_pula TEXT,
    zrodlo_dok TEXT, zrodlo_dok_id INTEGER, ilosc INTEGER, status TEXT)`);
  const ins = db.prepare('INSERT INTO ruchy (artykul_gt_id, mag_zrodlo_pula, zrodlo_dok, zrodlo_dok_id, ilosc, status) VALUES (?, ?, ?, ?, ?, ?)');
  for (const r of ruchy) ins.run(r.art ?? '95947', r.mag ?? 'K4', r.nr ?? null, r.id ?? null, r.ilosc, r.status ?? 'ok');
  return db;
}

test('przenumerowany PZ: rozlozenia ze starym numerem licza sie po dok_Id', () => {
  const db = baza([
    { nr: 'PZ 3954/2026', id: 6974580, ilosc: 72 },
    { nr: 'PZ 3954/2026', id: 6974580, ilosc: 24 },
  ]);
  assert.equal(iloscRozlozona(db, '95947', 'K4', 'PZ 4099/2026', 6974580), 96);
});

test('stare ruchy bez id dalej licza sie po numerze', () => {
  const db = baza([{ nr: 'PZ 100/2026', ilosc: 5 }, { nr: 'PZ 100/2026', id: 7, ilosc: 3 }]);
  assert.equal(iloscRozlozona(db, '95947', 'K4', 'PZ 100/2026', 7), 8);
  // wolajacy bez id (wozek zwrotow) - sam numer, wszystkie ruchy z tym numerem
  assert.equal(iloscRozlozona(db, '95947', 'K4', 'PZ 100/2026'), 8);
});

test('ruch z id INNEGO dokumentu nie liczy sie, nawet przy zgodnym numerze', () => {
  // stary numer zwolniony przy przenumerowaniu, a potem nadany innemu dokumentowi
  const db = baza([{ nr: 'PZ 3954/2026', id: 6974580, ilosc: 96 }]);
  assert.equal(iloscRozlozona(db, '95947', 'K4', 'PZ 3954/2026', 7000001), 0);
});

test('filtruje artykul, magazyn puli i ruchy z bledem', () => {
  const db = baza([
    { id: 1, ilosc: 10 },
    { id: 1, ilosc: 4, status: 'blad' },
    { id: 1, ilosc: 6, art: '1' },
    { id: 1, ilosc: 7, mag: 'K4G' },
  ]);
  assert.equal(iloscRozlozona(db, '95947', 'K4', 'PZ 1/2026', 1), 10);
});

test('bez numeru i bez id - zero', () => {
  const db = baza([{ nr: null, id: null, ilosc: 5 }]);
  assert.equal(iloscRozlozona(db, '95947', 'K4', null, null), 0);
});

// Dzien pierwszego rozlozenia - granica "wydanie do sklepu z palety czy z polki"
// (rozbicie-stanu: wydaneZPalety). data_ruchu w UTC, wynik w kalendarzu magazynu.
const { pierwszeRozlozenie, dzienLokalny } = require('../services/rozlozone-dokumenty');

function bazaZData(ruchy) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE ruchy (id INTEGER PRIMARY KEY, artykul_gt_id TEXT, mag_zrodlo_pula TEXT,
    zrodlo_dok TEXT, zrodlo_dok_id INTEGER, ilosc INTEGER, status TEXT, data_ruchu DATETIME)`);
  const ins = db.prepare('INSERT INTO ruchy (artykul_gt_id, mag_zrodlo_pula, zrodlo_dok, zrodlo_dok_id, ilosc, status, data_ruchu) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const r of ruchy) ins.run(r.art ?? '1', r.mag ?? 'K4', r.nr ?? null, r.id ?? null, r.ilosc ?? 1, r.status ?? 'ok', r.czas);
  return db;
}

test('pierwszeRozlozenie: najwczesniejszy ruch dokumentu, dzien lokalny', () => {
  const db = bazaZData([
    { id: 5, czas: '2026-11-26 07:34:41' },
    { id: 5, czas: '2026-11-24 23:30:00' },          // 25.11 00:30 w Polsce
    { id: 5, czas: '2026-11-20 10:00:00', status: 'blad' },
    { id: 6, czas: '2026-11-01 10:00:00' },
  ]);
  assert.equal(pierwszeRozlozenie(db, '1', 'K4', 'PZ 1/2026', 5), '2026-11-25');
  assert.equal(pierwszeRozlozenie(db, '1', 'K4', 'PZ 1/2026', 99), null);
  assert.equal(pierwszeRozlozenie(db, '1', 'K4', null, null), null);
});

test('dzienLokalny: UTC z SQLite na kalendarz magazynu (lato i zima)', () => {
  assert.equal(dzienLokalny('2026-07-19 22:30:00'), '2026-07-20');
  assert.equal(dzienLokalny('2026-11-26 22:59:59'), '2026-11-26');
  assert.equal(dzienLokalny('2026-11-26 23:00:00'), '2026-11-27');
  assert.equal(dzienLokalny('zle'), null);
});
