'use strict';

// Reguly ekranu "Wolne miejsca". Test na czystych funkcjach - bez SQLite i bez GT.
//
// Sedno: "wolne" to NIE "brak wiersza w stany_lokalizacji". Slot bez wiersza bywa pelny
// (towar opisany tylko w polach GT), a slot z wierszem 0 sztuk na K4 jest pusty, ale nie
// wolny (dom SKU czekajacy na uzupelnienie).

const test = require('node:test');
const assert = require('node:assert');

const { STATUSY, statusLokalizacji, podsumuj } = require('../services/zajetosc-model');

test('wiersz WMS ze stanem = zajete', () => {
  assert.equal(statusLokalizacji({ sztuk: 12, pozycji: 1 }), STATUSY.ZAJETA);
  // kilka SKU na jednej lokalizacji K4G - nadal po prostu zajete
  assert.equal(statusLokalizacji({ sztuk: 40, pozycji: 3, historia: true }), STATUSY.ZAJETA);
});

test('wiersz WMS ze stanem 0 to dom SKU, a nie wolne miejsce', () => {
  assert.equal(statusLokalizacji({ sztuk: 0, pozycji: 1, historia: true }), STATUSY.PUSTA_POLKA);
});

test('pusto w WMS, ale GT opisuje tu towar -> tylko GT (nie wolne)', () => {
  assert.equal(statusLokalizacji({ sztuk: 0, pozycji: 0, wGt: true, historia: true }), STATUSY.TYLKO_GT);
  assert.equal(statusLokalizacji({ sztuk: 0, pozycji: 0, wGt: true, historia: false }), STATUSY.TYLKO_GT);
});

test('WMS jest masterem lokalizacji - wiersz w WMS bije wpis w GT', () => {
  // pole GT bywa nieodswiezone; gdy WMS ma wiersz, to on jest prawda (zasada #2)
  assert.equal(statusLokalizacji({ sztuk: 5, pozycji: 1, wGt: true }), STATUSY.ZAJETA);
  assert.equal(statusLokalizacji({ sztuk: 0, pozycji: 1, wGt: true }), STATUSY.PUSTA_POLKA);
});

test('puste wszedzie: z historia = wolne, bez historii = nigdy nietkniete', () => {
  assert.equal(statusLokalizacji({ historia: true }), STATUSY.WOLNA);
  assert.equal(statusLokalizacji({}), STATUSY.NIETKNIETA);
});

test('podsumowanie liczy procent od slotow MAGAZYNOWYCH, strefy maja wlasny licznik', () => {
  const [k4] = podsumuj([
    { magazyn: 'K4', przeznaczenie: 'towar', status: STATUSY.ZAJETA },
    { magazyn: 'K4', przeznaczenie: 'towar', status: STATUSY.PUSTA_POLKA },
    { magazyn: 'K4', przeznaczenie: 'towar', status: STATUSY.TYLKO_GT },
    { magazyn: 'K4', przeznaczenie: 'towar', status: STATUSY.WOLNA },
    { magazyn: 'K4', przeznaczenie: 'kartony', status: STATUSY.ZAJETA },
    { magazyn: 'K4', przeznaczenie: 'przyjecia', status: STATUSY.WOLNA },
  ]);

  assert.equal(k4.aktywnych, 6);
  assert.equal(k4.magazynowych, 4);
  assert.equal(k4.poza_analiza, 2);
  assert.equal(k4.wolnych, 1);
  // "tylko GT" i pusta polka NIE sa wolnym miejscem - stad 3/4, a nie 1/4
  assert.equal(k4.zajmowanych, 3);
  assert.equal(k4.procent, 75);
  // pusta strefa przyjec nie podbija liczby wolnych miejsc na towar
  assert.equal(k4.wolna, 1);
});

test('brak przeznaczenia (wiersze sprzed migracji) liczy sie jak towar', () => {
  const [k4g] = podsumuj([
    { magazyn: 'K4G', przeznaczenie: null, status: STATUSY.WOLNA },
    { magazyn: 'K4G', przeznaczenie: undefined, status: STATUSY.ZAJETA },
  ]);
  assert.equal(k4g.magazynowych, 2);
  assert.equal(k4g.poza_analiza, 0);
  assert.equal(k4g.procent, 50);
});

test('magazyny nie mieszaja sie ze soba', () => {
  const wynik = podsumuj([
    { magazyn: 'K4', przeznaczenie: 'towar', status: STATUSY.ZAJETA },
    { magazyn: 'K4G', przeznaczenie: 'towar', status: STATUSY.WOLNA },
  ]);
  assert.deepEqual(wynik.map((w) => [w.magazyn, w.procent]), [['K4', 100], ['K4G', 0]]);
});
