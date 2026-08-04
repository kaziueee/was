'use strict';

// Kolejnosc obchodu "Ostatnie sztuki" - czyste funkcje, test bez SQLite/GT
// (jak adnotacja-stref.test.js).

const test = require('node:test');
const assert = require('node:assert');

const {
  bazySymboluWariantu, grupaObchodu, porownajObchod, czyBiuro,
  GRUPA_ZWYKLA, GRUPA_BIURO, GRUPA_WARIANT_PU, GRUPA_STREFA, GRUPA_PELNA_REZ,
  GRUPA_POLICZONE_NIEDAWNO,
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

test('wariant p/u = grupa 2 (gdy nie ma silniejszej cechy)', () => {
  assert.equal(grupaObchodu(poz({}), { jestWariantemPU: true }), GRUPA_WARIANT_PU);
});

test('biuro = grupa 1 - za zwyklymi polkami, ale przed p/u', () => {
  // Kody biura sortuja sie po literach przed A1, wiec bez tej grupy obchod zaczynal sie
  // od wycieczki do biura (zyczenie usera 2026-08-04).
  for (const kod of ['biuro', 'BIURO', 'M2-BIURKO', 'RB/BIURO']) {
    assert.equal(grupaObchodu(poz({ lokalizacja_kod: kod }), {}), GRUPA_BIURO, kod);
    assert.ok(czyBiuro(kod), kod);
  }
  assert.equal(grupaObchodu(poz({ lokalizacja_kod: 'A1-P1' }), {}), GRUPA_ZWYKLA);
  // kod z siatki regalow nigdy nie udaje biura
  for (const kod of ['B11', 'M2-B27-P4', 'L3-P3', 'RB']) assert.equal(czyBiuro(kod), false, kod);
  // dalsza cecha wygrywa: p/u lezace w biurze idzie do p/u
  assert.equal(grupaObchodu(poz({ lokalizacja_kod: 'biuro' }), { jestWariantemPU: true }), GRUPA_WARIANT_PU);
});

test('sztuki w strefie = grupa 3', () => {
  assert.equal(grupaObchodu(poz({ w_strefach: 2 }), {}), GRUPA_STREFA);
});

test('caly stan K4 zarezerwowany = grupa 4', () => {
  assert.equal(grupaObchodu(poz({ stan: 3, rezerwacja: 3 }), {}), GRUPA_PELNA_REZ);
  assert.equal(grupaObchodu(poz({ stan: 2, rezerwacja: 5 }), {}), GRUPA_PELNA_REZ);
});

test('rezerwacja czesciowa NIE spycha na koniec (grupa 0)', () => {
  assert.equal(grupaObchodu(poz({ stan: 5, rezerwacja: 2 }), {}), GRUPA_ZWYKLA);
});

test('stan 0 nie jest "pelna rezerwacja" mimo rez>=stan', () => {
  assert.equal(grupaObchodu(poz({ stan: 0, rezerwacja: 0 }), {}), GRUPA_ZWYKLA);
});

test('pominiecie NIE jest cecha kolejnosci - pozycja zostaje w swojej grupie', () => {
  // Decyzja usera 2026-08-04: "Pomin" ma tylko przepuscic pozycje dalej w biezacym obchodzie.
  // Przy nastepnym stoi na swoim miejscu wg lokalizacji, chyba ze lapie ja inna regula.
  // Zadna flaga pominiecia nie istnieje - nieznane pola opcji nie moga zmienic grupy.
  assert.equal(grupaObchodu(poz({}), { pominieteNiedawno: true }), GRUPA_ZWYKLA);
  assert.equal(grupaObchodu(poz({ w_strefach: 2 }), { pominieteNiedawno: true }), GRUPA_STREFA);
});

test('policzone niedawno = grupa 5, bije KAZDA inna ceche', () => {
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

test('grupy ida w kolejnosci zwykle < biuro < p/u < strefa < pelna rez < policzone-niedawno, reszta po lokalizacji', () => {
  const ctx = { wariantyPU: new Set(['WAR-P']), sprawdzoneSku: new Set(['9']) };
  const lista = [
    { artykul_gt_id: '1', symbol: 'REZ', lokalizacja_kod: 'M2-A1-P1', stan: 2, rezerwacja: 2, w_strefach: 0 }, // grupa 4
    { artykul_gt_id: '2', symbol: 'ZWY-B', lokalizacja_kod: 'M2-B2-P1', stan: 3, rezerwacja: 0, w_strefach: 0 }, // grupa 0
    { artykul_gt_id: '3', symbol: 'STR', lokalizacja_kod: 'M2-A2-P1', stan: 3, rezerwacja: 0, w_strefach: 1 }, // grupa 3
    { artykul_gt_id: '4', symbol: 'WAR-P', lokalizacja_kod: 'M2-Z9-P1', stan: 3, rezerwacja: 0, w_strefach: 0 }, // grupa 2
    { artykul_gt_id: '5', symbol: 'ZWY-A', lokalizacja_kod: 'M2-A1-P1', stan: 3, rezerwacja: 0, w_strefach: 0 }, // grupa 0
    // biuro - kod sortuje sie przed A1, ale ma stac za regalami (grupa 1)
    { artykul_gt_id: '6', symbol: 'BIURKO', lokalizacja_kod: 'biuro', stan: 3, rezerwacja: 0, w_strefach: 0 },
    // policzone niedawno (SKU 9) - mimo lokalizacji A0 (najwczesniejszej) idzie na SAM koniec
    { artykul_gt_id: '9', symbol: 'POLICZ', lokalizacja_kod: 'M2-A0-P1', stan: 3, rezerwacja: 0, w_strefach: 0 }, // grupa 5
  ];
  const posortowane = [...lista].sort((a, b) => porownajObchod(a, b, ctx)).map((p) => p.symbol);
  assert.deepEqual(posortowane, ['ZWY-A', 'ZWY-B', 'BIURKO', 'WAR-P', 'STR', 'REZ', 'POLICZ']);
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

test('pominieta pozycja stoi na SWOIM miejscu wg lokalizacji, nie w ogonie', () => {
  // Sort nie wie nic o pominieciach - pozycja pominieta wczoraj wraca tam, gdzie stala.
  const ctx = { wariantyPU: new Set(), sprawdzoneSku: new Set() };
  const pominiety = { artykul_gt_id: '5', symbol: 'POMIN', lokalizacja_kod: 'A1', stan: 2, rezerwacja: 0, w_strefach: 0 };
  const zwykly = { artykul_gt_id: '6', symbol: 'ZWYKLY', lokalizacja_kod: 'Z9', stan: 2, rezerwacja: 0, w_strefach: 0 };
  const kolejnosc = [zwykly, pominiety].sort((a, b) => porownajObchod(a, b, ctx)).map((p) => p.symbol);
  assert.deepEqual(kolejnosc, ['POMIN', 'ZWYKLY']);
});

test('...chyba ze lapie ja inna regula (strefa spycha pominieta pozycje mimo wczesnej lokalizacji)', () => {
  const ctx = { wariantyPU: new Set(), sprawdzoneSku: new Set() };
  const wStrefie = { artykul_gt_id: '5', symbol: 'STREFA', lokalizacja_kod: 'A1', stan: 2, rezerwacja: 0, w_strefach: 2 };
  const zwykly = { artykul_gt_id: '6', symbol: 'ZWYKLY', lokalizacja_kod: 'Z9', stan: 2, rezerwacja: 0, w_strefach: 0 };
  assert.ok(porownajObchod(wStrefie, zwykly, ctx) > 0);
});

test('w obrebie tej samej lokalizacji rozstrzyga symbol', () => {
  const ctx = { wariantyPU: new Set(), sprawdzoneSku: new Set() };
  const a = { artykul_gt_id: '1', symbol: 'AAA', lokalizacja_kod: 'M2-C3-P1', stan: 3, rezerwacja: 0, w_strefach: 0 };
  const b = { artykul_gt_id: '2', symbol: 'BBB', lokalizacja_kod: 'M2-C3-P1', stan: 3, rezerwacja: 0, w_strefach: 0 };
  assert.ok(porownajObchod(a, b, ctx) < 0);
  assert.ok(porownajObchod(b, a, ctx) > 0);
});
