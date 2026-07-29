'use strict';

// Kolejnosc obchodu "Ostatnie sztuki" - czyste funkcje, test bez SQLite/GT
// (jak adnotacja-stref.test.js).

const test = require('node:test');
const assert = require('node:assert');

const {
  bazySymboluWariantu, grupaObchodu, porownajObchod,
  GRUPA_ZWYKLA, GRUPA_WARIANT_PU, GRUPA_STREFA, GRUPA_PELNA_REZ, GRUPA_POLICZONE_NIEDAWNO,
} = require('../services/kolejnosc-obchodu');

// --- bazySymboluWariantu: kandydaci na symbol bazowy dla wariantu p/u ---

test('symbol bez koncowki p/u nie ma bazy', () => {
  assert.deepEqual(bazySymboluWariantu('BARDGW22'), []);
  assert.deepEqual(bazySymboluWariantu('ANE023X'), []);
  assert.deepEqual(bazySymboluWariantu(''), []);
  assert.deepEqual(bazySymboluWariantu(null), []);
});

test('goly suffiks p/u -> obcieta ostatnia litera', () => {
  assert.deepEqual(bazySymboluWariantu('ANE0858U'), ['ANE0858']);
  assert.deepEqual(bazySymboluWariantu('BARGNK01P'), ['BARGNK01']);
  // baza moze sama konczyc sie litera (CHI2131C + P) - to wciaz jedna forma
  assert.deepEqual(bazySymboluWariantu('CHI2131CP'), ['CHI2131C']);
});

test('separator przed litera daje DWIE formy bazy (z separatorem i bez)', () => {
  assert.deepEqual(bazySymboluWariantu('ANGAB-15-U'), ['ANGAB-15-', 'ANGAB-15']);
  assert.deepEqual(bazySymboluWariantu('X_1_P'), ['X_1_', 'X_1']);
});

test('rozpoznaje koncowke bez wzgledu na wielkosc liter i biale znaki', () => {
  assert.deepEqual(bazySymboluWariantu('ane0858u'), ['ane0858']);
  assert.deepEqual(bazySymboluWariantu('  BARGNK01P  '), ['BARGNK01']);
});

// --- grupaObchodu: przypisanie do grupy kolejnosci ---

const poz = (o) => ({ stan: 3, rezerwacja: 0, w_strefach: 0, ...o });

test('zwykla pozycja (nie p/u, bez strefy, bez pelnej rez) = grupa 0', () => {
  assert.equal(grupaObchodu(poz({}), {}), GRUPA_ZWYKLA);
});

test('wariant p/u = grupa 1 (gdy nie ma silniejszej cechy)', () => {
  assert.equal(grupaObchodu(poz({}), { jestWariantemPU: true }), GRUPA_WARIANT_PU);
});

test('sztuki w strefie = grupa 2', () => {
  assert.equal(grupaObchodu(poz({ w_strefach: 2 }), {}), GRUPA_STREFA);
});

test('caly stan K4 zarezerwowany = grupa 3', () => {
  assert.equal(grupaObchodu(poz({ stan: 3, rezerwacja: 3 }), {}), GRUPA_PELNA_REZ);
  assert.equal(grupaObchodu(poz({ stan: 2, rezerwacja: 5 }), {}), GRUPA_PELNA_REZ);
});

test('rezerwacja czesciowa NIE spycha na koniec (grupa 0)', () => {
  assert.equal(grupaObchodu(poz({ stan: 5, rezerwacja: 2 }), {}), GRUPA_ZWYKLA);
});

test('stan 0 nie jest "pelna rezerwacja" mimo rez>=stan', () => {
  assert.equal(grupaObchodu(poz({ stan: 0, rezerwacja: 0 }), {}), GRUPA_ZWYKLA);
});

test('policzone niedawno = grupa 4, bije KAZDA inna ceche', () => {
  assert.equal(grupaObchodu(poz({}), { sprawdzoneNiedawno: true }), GRUPA_POLICZONE_NIEDAWNO);
  // nawet gdy pozycja jest jednoczesnie p/u, w strefie i w pelni zarezerwowana
  assert.equal(
    grupaObchodu(poz({ stan: 3, rezerwacja: 3, w_strefach: 2 }), { jestWariantemPU: true, sprawdzoneNiedawno: true }),
    GRUPA_POLICZONE_NIEDAWNO
  );
});

test('priorytet cech: najdalsza wygrywa (policzone-niedawno > rez > strefa > p/u)', () => {
  // i w strefie, i zarezerwowana -> rezerwacja (3)
  assert.equal(grupaObchodu(poz({ stan: 3, rezerwacja: 3, w_strefach: 2 }), { jestWariantemPU: true }), GRUPA_PELNA_REZ);
  // i p/u, i w strefie -> strefa (2)
  assert.equal(grupaObchodu(poz({ w_strefach: 1 }), { jestWariantemPU: true }), GRUPA_STREFA);
});

// --- porownajObchod: pelny komparator ---

test('grupy ida w kolejnosci zwykle < p/u < strefa < pelna rez < policzone-niedawno, reszta po lokalizacji', () => {
  const ctx = { wariantyPU: new Set(['WAR-P']), sprawdzoneSku: new Set(['9']) };
  const lista = [
    { artykul_gt_id: '1', symbol: 'REZ', lokalizacja_kod: 'M2-A1-P1', stan: 2, rezerwacja: 2, w_strefach: 0 }, // grupa 3
    { artykul_gt_id: '2', symbol: 'ZWY-B', lokalizacja_kod: 'M2-B2-P1', stan: 3, rezerwacja: 0, w_strefach: 0 }, // grupa 0
    { artykul_gt_id: '3', symbol: 'STR', lokalizacja_kod: 'M2-A2-P1', stan: 3, rezerwacja: 0, w_strefach: 1 }, // grupa 2
    { artykul_gt_id: '4', symbol: 'WAR-P', lokalizacja_kod: 'M2-Z9-P1', stan: 3, rezerwacja: 0, w_strefach: 0 }, // grupa 1
    { artykul_gt_id: '5', symbol: 'ZWY-A', lokalizacja_kod: 'M2-A1-P1', stan: 3, rezerwacja: 0, w_strefach: 0 }, // grupa 0
    // policzone niedawno (SKU 9) - mimo lokalizacji A0 (najwczesniejszej) idzie na SAM koniec
    { artykul_gt_id: '9', symbol: 'POLICZ', lokalizacja_kod: 'M2-A0-P1', stan: 3, rezerwacja: 0, w_strefach: 0 }, // grupa 4
  ];
  const posortowane = [...lista].sort((a, b) => porownajObchod(a, b, ctx)).map((p) => p.symbol);
  assert.deepEqual(posortowane, ['ZWY-A', 'ZWY-B', 'WAR-P', 'STR', 'REZ', 'POLICZ']);
});

test('policzone-niedawno nie wyprzedza nieliczonych mimo najwczesniejszej lokalizacji', () => {
  // Odtwarza realny przypadek: SKU przypisano nowa lokalizacje po sprawdzeniu, wraca na liste.
  const ctx = { wariantyPU: new Set(), sprawdzoneSku: new Set(['77']) };
  const wroci = { artykul_gt_id: '77', symbol: 'WRACA', lokalizacja_kod: 'A1', stan: 2, rezerwacja: 0, w_strefach: 0 };
  const nowy = { artykul_gt_id: '88', symbol: 'NOWY', lokalizacja_kod: 'Z9', stan: 2, rezerwacja: 0, w_strefach: 0 };
  // mimo ze A1 < Z9, przypisany-po-sprawdzeniu (77) ma stac ZA nieliczonym (88)
  assert.ok(porownajObchod(wroci, nowy, ctx) > 0);
  assert.ok(porownajObchod(nowy, wroci, ctx) < 0);
});

test('w obrebie tej samej lokalizacji rozstrzyga symbol', () => {
  const ctx = { wariantyPU: new Set(), sprawdzoneSku: new Set() };
  const a = { artykul_gt_id: '1', symbol: 'AAA', lokalizacja_kod: 'M2-C3-P1', stan: 3, rezerwacja: 0, w_strefach: 0 };
  const b = { artykul_gt_id: '2', symbol: 'BBB', lokalizacja_kod: 'M2-C3-P1', stan: 3, rezerwacja: 0, w_strefach: 0 };
  assert.ok(porownajObchod(a, b, ctx) < 0);
  assert.ok(porownajObchod(b, a, ctx) > 0);
});
