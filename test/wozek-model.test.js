'use strict';

// Testy arytmetyki pozycji wozka zwrotow - services/wozek-model.js.
// Uruchomienie: node --test test/
//
// Sedno: pozycja dolozona na wozek PO czesciowym rozlozeniu dokumentu nie moze znikac z listy.
// Regresja z produkcji (BKR1904, 2026-07-20): snapshot 1 - rozlozono 3 = 0 -> pozycja przepadala.

const test = require('node:test');
const assert = require('node:assert/strict');

const { zostaloPozycji } = require('../services/wozek-model');

test('pozycja dolozona przed rozlozeniem: baza 0 = stare zachowanie (ilosc - rozlozono)', () => {
  assert.equal(zostaloPozycji(4, 0, 0), 4);   // nic nie rozlozono
  assert.equal(zostaloPozycji(4, 1, 0), 3);   // rozlozono 1 z 4
  assert.equal(zostaloPozycji(4, 4, 0), 0);   // rozlozono calosc -> zadanie domkniete
  assert.equal(zostaloPozycji(4, 9, 0), 0);   // rozlozono wiecej (inne wejscia) -> nie schodzi ponizej 0
});

test('REGRESJA BKR1904: reszta dolozona po czesciowym rozlozeniu zostaje widoczna', () => {
  // Dokument PZ 2950 = 4 szt.; rozlozono 3; pozostala 1 trafia na wozek jako snapshot=1, baza=3.
  assert.equal(zostaloPozycji(1, 3, 3), 1, 'przed poprawka bylo 1 - 3 = 0 i pozycja znikala');
  // Rozlozenie tej ostatniej sztuki (rozlozonoDokument rosnie do 4) domyka zadanie.
  assert.equal(zostaloPozycji(1, 4, 3), 0);
  // Kolejne rozlozenia z dokumentu (np. korekta) nie wpychaja wyniku ponizej 0.
  assert.equal(zostaloPozycji(1, 6, 3), 0);
});

test('baza dziala dla dowolnej czesci: 2 z 5 dolozone po rozlozeniu 3', () => {
  // Dokument = 5; rozlozono 3; 2 szt. dolozone na wozek (snapshot=2, baza=3).
  assert.equal(zostaloPozycji(2, 3, 3), 2);   // nic nowego po dolozeniu
  assert.equal(zostaloPozycji(2, 4, 3), 1);   // rozlozono 1 z tych 2
  assert.equal(zostaloPozycji(2, 5, 3), 0);   // rozlozono obie
});

test('cofniecie ruchu (rozlozonoDokument spada ponizej bazy) nie psuje pozycji', () => {
  // Baza 3, ale ktos cofnal rozlozenie i teraz z dokumentu widac tylko 2 rozlozone.
  // odDolozenia = max(2 - 3, 0) = 0 -> pozycja pokazuje pelny snapshot.
  assert.equal(zostaloPozycji(1, 2, 3), 1);
});

test('odpornosc na typy: DECIMAL z SQLite (stringi/null) nie wywala rachunku', () => {
  assert.equal(zostaloPozycji('1', '3', '3'), 1);
  assert.equal(zostaloPozycji(1, 3, null), 0);        // null baza -> 0, stare zachowanie
  assert.equal(zostaloPozycji(1, null, 3), 1);        // brak rozlozenia
});
