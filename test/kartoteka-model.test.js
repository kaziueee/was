'use strict';

// Reguly odswiezania kopii kartoteki - test bez SQLite/GT (jak kolejnosc-obchodu.test.js).
// Scenariusz przewodni: Ulica Sezamkowa z 2026-09-16 (patrz naglowek services/kartoteka.js).

const test = require('node:test');
const assert = require('node:assert');

const { porownajKopie, rodzajZmiany, roznice, unikalneIdy } = require('../services/kartoteka-model');

const wiersz = (nad = {}) => ({
  id: 1,
  artykul_gt_id: '93795',
  artykul_symbol: 'SES66146E',
  artykul_nazwa: 'Ulica Sezamkowa pluszowa figurka Ernie 38 cm',
  artykul_ean: null,
  ...nad,
});

// --- porownajKopie ---

test('kopia zgodna z GT nie daje zadnej zmiany', () => {
  const zmiany = porownajKopie(wiersz(), {
    symbol: 'SES66146E', nazwa: 'Ulica Sezamkowa pluszowa figurka Ernie 38 cm', ean: null,
  });
  assert.equal(zmiany, null);
});

test('zamieniony symbol w Subiekcie wraca do kopii razem z nazwa', () => {
  const zmiany = porownajKopie(wiersz(), {
    symbol: 'SES66146B', nazwa: 'Ulica Sezamkowa pluszowa figurka Bert 38 cm', ean: null,
  });
  assert.deepEqual(zmiany, {
    artykul_symbol: 'SES66146B',
    artykul_nazwa: 'Ulica Sezamkowa pluszowa figurka Bert 38 cm',
  });
});

test('puste pole w GT NIE kasuje kopii (pusto = nikt nie wpisal, nie "ma byc puste")', () => {
  assert.equal(porownajKopie(wiersz(), { symbol: '', nazwa: '   ', ean: '' }), null);
});

test('roznica o same spacje to nie zmiana - inaczej job pisalby w kolko', () => {
  const zmiany = porownajKopie(wiersz({ artykul_symbol: 'SES66146E' }), {
    symbol: '  SES66146E ', nazwa: 'Ulica Sezamkowa pluszowa figurka Ernie 38 cm', ean: null,
  });
  assert.equal(zmiany, null);
});

test('pusty EAN w WMS uzupelniamy z GT - od niego zalezy skan przy padnietym GT', () => {
  const zmiany = porownajKopie(wiersz(), { symbol: 'SES66146E', nazwa: null, ean: '8710341661465' });
  assert.deepEqual(zmiany, { artykul_ean: '8710341661465' });
});

test('EAN w WMS zostaje, gdy GT nie ma podstawowego kodu', () => {
  const zmiany = porownajKopie(wiersz({ artykul_ean: '5901234567890' }), {
    symbol: 'SES66146E', nazwa: null, ean: null,
  });
  assert.equal(zmiany, null);
});

test('brak towaru w GT (lokalne id testowe) niczego nie rusza', () => {
  assert.equal(porownajKopie(wiersz({ artykul_gt_id: 'GT-100' }), null), null);
});

// --- rodzajZmiany: co trafia do Logu zmian, a co tylko do podsumowania ---

test('zmiana symbolu albo nazwy to zmiana tozsamosci', () => {
  assert.equal(rodzajZmiany({ artykul_symbol: 'X' }), 'tozsamosc');
  assert.equal(rodzajZmiany({ artykul_nazwa: 'X' }), 'tozsamosc');
  assert.equal(rodzajZmiany({ artykul_nazwa: 'X', artykul_ean: '1' }), 'tozsamosc');
});

test('samo dopisanie EAN nie jest zmiana tozsamosci', () => {
  assert.equal(rodzajZmiany({ artykul_ean: '1' }), 'ean');
});

// --- roznice: caly przebieg po wierszach ---

test('roznice poprawiaja kazdy wiersz artykulu z osobna', () => {
  const kartyGt = new Map([
    ['93795', { symbol: 'SES66146B', nazwa: 'Ulica Sezamkowa pluszowa figurka Bert 38 cm', ean: null }],
    ['93796', { symbol: 'SES66146E', nazwa: 'Ulica Sezamkowa pluszowa figurka Erni 40 cm', ean: null }],
  ]);
  const wynik = roznice([
    wiersz({ id: 3407 }),                                    // K4G Berta, kopia mowi "Ernie"
    wiersz({ id: 4948 }),                                    // K4 Berta, ta sama stara kopia
    wiersz({                                                  // Erni - kopia aktualna
      id: 4946, artykul_gt_id: '93796', artykul_symbol: 'SES66146E',
      artykul_nazwa: 'Ulica Sezamkowa pluszowa figurka Erni 40 cm',
    }),
  ], kartyGt);

  assert.equal(wynik.length, 2);
  assert.deepEqual(wynik.map((z) => z.wiersz.id), [3407, 4948]);
  assert.ok(wynik.every((z) => z.rodzaj === 'tozsamosc'));
  assert.equal(wynik[0].zmiany.artykul_symbol, 'SES66146B');
});

// --- unikalneIdy: wykrywanie kolizji symbolu ---

test('jeden symbol na dwoch tw_Id to kolizja', () => {
  assert.deepEqual(unikalneIdy(['93795', '93795', 93796]), ['93795', '93796']);
  assert.equal(unikalneIdy(['93795', '93795']).length, 1);
  assert.deepEqual(unikalneIdy(null), []);
});
