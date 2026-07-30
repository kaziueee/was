'use strict';

// Czyste funkcje budowania CSV do kopii awaryjnej. Test nie dotyka SQLite ani GT
// (generujPliki, ktore czyta baze, jest testowane osobno smoke-em na zywej db).

const test = require('node:test');
const assert = require('node:assert');

const {
  polecsv, liczbaPl, grupujPoSku, csvPlaski, csvZbiorczy, csvHistoria,
} = require('../services/backup-czytelne');

// --- polecsv: cytowanie ---

test('polecsv cytuje pole z separatorem, cudzyslowem lub nowa linia', () => {
  assert.equal(polecsv('proste'), 'proste');
  assert.equal(polecsv('a;b'), '"a;b"');                 // separator -> cytat
  assert.equal(polecsv('a,b'), 'a,b');                   // przecinek NIE lamie sep ';' -> bez cytatu
  assert.equal(polecsv('ma "cudzyslow"'), '"ma ""cudzyslow"""'); // podwojenie "
  assert.equal(polecsv('linia\ndruga'), '"linia\ndruga"');
  assert.equal(polecsv(null), '');
  assert.equal(polecsv(undefined), '');
});

// --- liczbaPl: kropka -> przecinek, calkowite bez ulamka ---

test('liczbaPl: calkowita bez ulamka, ulamek z przecinkiem', () => {
  assert.equal(liczbaPl(6), '6');
  assert.equal(liczbaPl(700), '700');
  assert.equal(liczbaPl(0.61), '0,61');
  assert.equal(liczbaPl('3'), '3');
  assert.equal(liczbaPl(null), '');
  assert.equal(liczbaPl('brak'), '');
});

// --- grupujPoSku: 1 SKU = 1 wiersz ---

test('grupujPoSku sumuje stan i skleja lokalizacje jednego SKU', () => {
  const wiersze = [
    { symbol: 'POLLY', nazwa: 'Polly Pocket', magazyn: 'K4G', lokalizacja: 'M2-A1-P3', ilosc: 7 },
    { symbol: 'POLLY', nazwa: 'Polly Pocket', magazyn: 'K4G', lokalizacja: 'M2-B1-P3', ilosc: 3 },
  ];
  const [g] = grupujPoSku(wiersze);
  assert.equal(g.symbol, 'POLLY');
  assert.equal(g.razem, 10);                                    // 7 + 3
  assert.equal(g.lokalizacje, 'K4G: M2-A1-P3(7); M2-B1-P3(3)'); // '; ' miedzy polkami tego samego magazynu
});

test('grupujPoSku: K4 przed K4G, magazyny rozdzielone " | "', () => {
  const wiersze = [
    { symbol: 'X', nazwa: 'X', magazyn: 'K4G', lokalizacja: 'D2-P2', ilosc: 300 },
    { symbol: 'X', nazwa: 'X', magazyn: 'K4', lokalizacja: 'M2-F28', ilosc: 1 },
  ];
  const [g] = grupujPoSku(wiersze);
  // K4 musi byc pierwszy mimo ze w wejsciu byl drugi
  assert.equal(g.lokalizacje, 'K4: M2-F28(1) | K4G: D2-P2(300)');
  assert.equal(g.razem, 301);
});

test('grupujPoSku: rozne SKU osobno, kolejnosc wejscia zachowana', () => {
  const wiersze = [
    { symbol: 'A', nazwa: 'A', magazyn: 'K4', lokalizacja: 'C2', ilosc: 30 },
    { symbol: 'B', nazwa: 'B', magazyn: 'K4', lokalizacja: 'C3', ilosc: 5 },
  ];
  const g = grupujPoSku(wiersze);
  assert.equal(g.length, 2);
  assert.deepEqual(g.map((x) => x.symbol), ['A', 'B']);
});

// --- csvZbiorczy: naglowek + cytowanie komorki z ';' ---

test('csvZbiorczy: naglowek i cytowanie komorki lokalizacji zawierajacej ";"', () => {
  const wiersze = [
    { symbol: 'POLLY', nazwa: 'Polly Pocket', magazyn: 'K4G', lokalizacja: 'M2-A1-P3', ilosc: 7 },
    { symbol: 'POLLY', nazwa: 'Polly Pocket', magazyn: 'K4G', lokalizacja: 'M2-B1-P3', ilosc: 3 },
  ];
  const linie = csvZbiorczy(wiersze).trim().split('\n');
  assert.equal(linie[0], 'symbol;nazwa;razem;lokalizacje');
  // komorka lokalizacji ma ';', wiec CALA musi byc w cudzyslowie
  assert.equal(linie[1], 'POLLY;Polly Pocket;10;"K4G: M2-A1-P3(7); M2-B1-P3(3)"');
});

// --- csvPlaski: 1 wiersz na polke ---

test('csvPlaski: naglowek + wiersz per polka, ilosc jako liczba', () => {
  const wiersze = [
    { symbol: 'BAR', nazwa: 'Barbie, kolor', magazyn: 'K4', lokalizacja: 'M2-D18', ilosc: 6, ostatnia_zmiana: '2026-07-06 12:15:53' },
  ];
  const linie = csvPlaski(wiersze).trim().split('\n');
  assert.equal(linie[0], 'symbol;nazwa;magazyn;lokalizacja;ilosc;ostatnia_zmiana');
  // nazwa ma przecinek - przy separatorze ';' NIE wymaga cytowania
  assert.equal(linie[1], 'BAR;Barbie, kolor;K4;M2-D18;6;2026-07-06 12:15:53');
});

// --- csvHistoria: puste z_lokalizacji przy LOK ---

test('csvHistoria: LOK ma puste zrodlo, kolejnosc kolumn stala', () => {
  const wiersze = [
    { data: '2026-07-23 10:24:21', symbol: 'NERCHIBAN2', typ: 'LOK', z_lokalizacji: null, na_lokalizacje: 'RB', ilosc: 1, kto: 'Mateusz', status: 'ok' },
  ];
  const linie = csvHistoria(wiersze).trim().split('\n');
  assert.equal(linie[0], 'data;symbol;typ;z_lokalizacji;na_lokalizacje;ilosc;kto;status');
  assert.equal(linie[1], '2026-07-23 10:24:21;NERCHIBAN2;LOK;;RB;1;Mateusz;ok');
});

// --- pusta baza: same naglowki, bez wywalki ---

test('puste wejscie: same naglowki', () => {
  assert.equal(csvZbiorczy([]).trim(), 'symbol;nazwa;razem;lokalizacje');
  assert.equal(csvPlaski([]).trim(), 'symbol;nazwa;magazyn;lokalizacja;ilosc;ostatnia_zmiana');
  assert.equal(csvHistoria([]).trim(), 'data;symbol;typ;z_lokalizacji;na_lokalizacje;ilosc;kto;status');
});
