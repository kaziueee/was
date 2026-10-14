'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { takaSamaObserwacja, takaSamaDecyzja } = require('../pricing/bez-zmian');

const obs = { cena: 99.9, wysylka: 0, bb_nasz: 1, bb_cena: 99.9, bb_fba: 0, najtansza_inna: null, ofert: 3, bb_nasza_inna: 0 };

test('ta sama obserwacja — REAL z bazy vs liczba z JS, boolean vs 1/0', () => {
  const zBazy = { ...obs, id: 7, czas: '2026-10-14 10:00:00', cena: 99.90000000001 };
  assert.ok(takaSamaObserwacja(zBazy, { ...obs, bb_nasz: true, bb_fba: false, bb_nasza_inna: false }));
});

test('zmiana ceny, Buy Boxa albo liczby ofert = nowy wiersz', () => {
  assert.ok(!takaSamaObserwacja(obs, { ...obs, cena: 98.9 }));
  assert.ok(!takaSamaObserwacja(obs, { ...obs, bb_nasz: 0 }));
  assert.ok(!takaSamaObserwacja(obs, { ...obs, ofert: 4 }));
  assert.ok(!takaSamaObserwacja(obs, { ...obs, najtansza_inna: 97.5 }));
});

test('NULL ≠ 0 i brak poprzedniej obserwacji = nowy wiersz', () => {
  assert.ok(!takaSamaObserwacja({ ...obs, bb_nasz: null }, { ...obs, bb_nasz: 0 }));
  assert.ok(!takaSamaObserwacja(undefined, obs));
  assert.ok(!takaSamaObserwacja(obs, null));
});

test('decyzja: zmiana kodu, minimum albo zysku = zapis; ta sama = pomijamy', () => {
  const d = { kod: 'obnizka', cena_przed: 99.9, cena_nowa: 94.9, cena_cel: 89.99, min: 70, max: 105, zysk: 20, zysk_nowa: 17, zysk_cel: 14 };
  assert.ok(takaSamaDecyzja({ ...d, id: 1, powod: 'cokolwiek' }, { ...d }));
  assert.ok(!takaSamaDecyzja(d, { ...d, kod: 'bez_zmian' }));
  assert.ok(!takaSamaDecyzja(d, { ...d, min: 72 }));     // zmienił się koszt w GT
  assert.ok(!takaSamaDecyzja(d, { ...d, zysk: 19.5 }));
});
