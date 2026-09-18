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

// --- rodzaje wolnego miejsca ---
// "Ile mam wolnego" bez rozbicia nie mowi, czy zmiesci sie paleta: polka regalowa na K4
// i miejsce paletowe na gorze to dwa rozne zasoby.

const { grupaMiejsca, podsumujWolne } = require('../services/zajetosc-model');

test('rodzaj miejsca: K4 półka przed K4 (pierwsze dopasowanie wygrywa)', () => {
  assert.equal(grupaMiejsca({ magazyn: 'K4', typ: 'polka' }), 'k4_polka');
  assert.equal(grupaMiejsca({ magazyn: 'K4', typ: 'trawers' }), 'k4');
  assert.equal(grupaMiejsca({ magazyn: 'K4', typ: 'paleta' }), 'k4');
  assert.equal(grupaMiejsca({ magazyn: 'K4', typ: 'inny' }), 'k4');
  // na gorze wszystko jest paletowe - typ nie ma znaczenia
  assert.equal(grupaMiejsca({ magazyn: 'K4G', typ: 'polka' }), 'k4g');
  assert.equal(grupaMiejsca({ magazyn: 'BRK', typ: 'paleta' }), null);
});

test('wolne w rozbiciu na rodzaje: nigdy nietkniete LICZY sie do wolnych', () => {
  const [k4g, polka, k4] = podsumujWolne([
    { magazyn: 'K4G', typ: 'paleta', przeznaczenie: 'towar', status: STATUSY.WOLNA },
    { magazyn: 'K4G', typ: 'paleta', przeznaczenie: 'towar', status: STATUSY.NIETKNIETA },
    { magazyn: 'K4G', typ: 'paleta', przeznaczenie: 'towar', status: STATUSY.ZAJETA },
    { magazyn: 'K4', typ: 'polka', przeznaczenie: 'towar', status: STATUSY.NIETKNIETA },
    { magazyn: 'K4', typ: 'trawers', przeznaczenie: 'towar', status: STATUSY.ZAJETA },
    { magazyn: 'K4', typ: 'paleta', przeznaczenie: 'towar', status: STATUSY.WOLNA },
  ]);

  assert.deepEqual([k4g.kod, polka.kod, k4.kod], ['k4g', 'k4_polka', 'k4']);
  // oba statusy "da sie tu cos polozyc" ida do jednej liczby, nietkniete tylko jako zastrzezenie
  assert.equal(k4g.wolnych, 2);
  assert.equal(k4g.nietknietych, 1);
  assert.equal(k4g.slotow, 3);
  assert.equal(k4g.procent, 33);
  assert.equal(polka.wolnych, 1);
  assert.equal(k4.wolnych, 1);
  assert.equal(k4.slotow, 2);
});

test('strefy poza analizą nie wchodzą do żadnego rodzaju miejsca', () => {
  const [, , k4] = podsumujWolne([
    { magazyn: 'K4', typ: 'paleta', przeznaczenie: 'kartony', status: STATUSY.WOLNA },
    { magazyn: 'K4', typ: 'paleta', przeznaczenie: 'przyjecia', status: STATUSY.WOLNA },
    { magazyn: 'K4', typ: 'paleta', przeznaczenie: 'towar', status: STATUSY.WOLNA },
  ]);
  assert.equal(k4.slotow, 1);
  assert.equal(k4.wolnych, 1);
});

test('rodzaj bez ani jednego slotu nadal jest na liście (kafel zerowy, nie znikający)', () => {
  const wynik = podsumujWolne([{ magazyn: 'K4G', typ: 'paleta', przeznaczenie: 'towar', status: STATUSY.WOLNA }]);
  assert.equal(wynik.length, 3);
  assert.equal(wynik.find((g) => g.kod === 'k4_polka').slotow, 0);
  assert.equal(wynik.find((g) => g.kod === 'k4_polka').procent, 0);
});

// STRAZNIK: zakladka "Wolne" musi pokazywac dokladnie to, co liczy kafel (STATUSY_WOLNE).
// Rozjazd objawil sie na produkcji jako "na kaflu 20, na liscie 1" - kafel liczyl wolne razem
// z nigdy nietknietymi, a zakladka filtrowala po samym statusie 'wolna'.
test('zakladka Wolne obejmuje te same statusy, co liczba na kaflu', () => {
  const { OPISY_STATUSOW, STATUSY_WOLNE } = require('../services/zajetosc-model');
  const wolne = OPISY_STATUSOW.find((s) => s.kod === STATUSY.WOLNA);
  assert.deepEqual([...wolne.obejmuje].sort(), [...STATUSY_WOLNE].sort());
});

test('kazda zakladka ma `obejmuje` (front filtruje po nim, nie po samym kodzie)', () => {
  const { OPISY_STATUSOW } = require('../services/zajetosc-model');
  for (const s of OPISY_STATUSOW) {
    assert.ok(Array.isArray(s.obejmuje) && s.obejmuje.length > 0, `brak obejmuje dla ${s.kod}`);
    assert.ok(s.obejmuje.includes(s.kod), `${s.kod} musi obejmowac sam siebie`);
  }
});
