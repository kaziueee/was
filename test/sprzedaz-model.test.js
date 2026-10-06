'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { dodajDni, dzisLokalnie, zakresOd, podsumujSprzedaz } = require('../services/sprzedaz-model');

test('dodajDni przechodzi przez granice miesiaca', () => {
  assert.strictEqual(dodajDni('2026-10-01', -1), '2026-09-30');
  assert.strictEqual(dodajDni('2026-10-06', -28), '2026-09-08');
});

test('dzisLokalnie bierze date lokalna, nie UTC', () => {
  assert.strictEqual(dzisLokalnie(new Date(2026, 9, 6, 0, 30)), '2026-10-06');
});

test('zakres siega po wczesniejsza z dat: 4 tyg. przed startem albo 7 dni wstecz', () => {
  assert.strictEqual(zakresOd('2026-10-01', '2026-10-06'), '2026-09-03');
  assert.strictEqual(zakresOd('2026-01-01', '2026-10-06'), '2025-12-04');
  assert.strictEqual(zakresOd('2026-10-06', '2026-10-06'), '2026-09-08');
});

test('trzy kolumny: od startu, ostatnie 7 dni, srednia tygodniowa przed startem', () => {
  const dni = [
    { dzien: '2026-09-03', szt: 2 },   // pierwszy dzien okna "przed" (start - 28)
    { dzien: '2026-09-02', szt: 50 },  // poza oknem "przed"
    { dzien: '2026-09-30', szt: 2 },   // przed startem
    { dzien: '2026-10-01', szt: 3 },   // dzien startu - liczy sie do "od startu"
    { dzien: '2026-09-29', szt: 1 },   // ostatnie 7 dni (06.10 - 6), ale przed startem
    { dzien: '2026-10-06', szt: 4 },
  ];
  assert.deepStrictEqual(podsumujSprzedaz(dni, '2026-10-01', '2026-10-06'), {
    od_startu: 7,
    ostatnie_7_dni: 7 + 2,              // 30.09 i 01.10 i 06.10 (29.09 juz poza oknem)
    przed_tygodniowo: 1.3,              // (2 + 2 + 1) / 4
  });
});

test('brak sprzedazy = zera, nie NaN', () => {
  assert.deepStrictEqual(podsumujSprzedaz([], '2026-10-01', '2026-10-06'),
    { od_startu: 0, ostatnie_7_dni: 0, przed_tygodniowo: 0 });
});
