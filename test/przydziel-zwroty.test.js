'use strict';

// Testy przydzialu zwrotow do rozmontowan - przydzielZwroty z services/rozbicie-stanu.js.
// Uruchomienie: node --test test/
//
// Czemu ta funkcja ma testy: decyduje, czy skladniki rozmontowanego zestawu dostana ZADANIE
// (leza na wozku zwrotow) czy zostana AUTO-DOPISANE na polke. Pomylka w druga strone kaze
// systemowi wpisac nieprawde o lokalizacji towaru.
//
// Pierwotnie bylo tu zwykle "czy zestaw ma jakikolwiek KFS w oknie" - i to sie sypalo, bo
// odpowiedz byla wspolna dla CALEGO SKU: jeden zwrocony egzemplarz uzyczal flagi kazdemu
// kolejnemu rozmontowaniu tego zestawu przez 14 dni. Na zywej bazie 34 ze 137 zestawow mialo
// wiecej rozmontowan oznaczonych "z zwrotu" niz kiedykolwiek wrocilo (NERCHIELIT100: 152 vs 65).
// Pytanie usera, ktore to wykrylo: "jak rozmontuje jeden zwrot, a potem kolejny taki sam, to
// on moze zlapac KFS nie od swojej sprzedazy?". Moze. Stad pula, ktora sie ZUZYWA.
//
// Test nie dotyka GT ani SQLite - przydzielZwroty to czysta funkcja. Import idzie z
// rozbicie-stanu (modul bez zaleznosci od db/GT), inaczej rownolegle pliki testowe kolidowalyby
// na db/wms.db otwieranym przez gt-dokumenty ("database is locked"). Okno KFS (dni) jest tu
// domyslne (14); produkcja wstrzykuje realne przez 3. argument.

const test = require('node:test');
const assert = require('node:assert/strict');

const { przydzielZwroty } = require('../services/rozbicie-stanu');

const DZIEN = 24 * 3600 * 1000;
const T0 = new Date('2026-07-01T00:00:00Z').getTime();
const dzien = (n) => new Date(T0 + n * DZIEN);

const rozm = (pw_nr, dni, zestawow = 1, zestaw_id = 1) =>
  ({ pw_nr, data: dzien(dni), zestaw_id, zestawow, zestaw_symbol: 'ZEST' });
const zwrot = (dni, ilosc = 1, zestaw_id = 1) => ({ zestaw_id, data: dzien(dni), ilosc });

const flagi = (wynik) => Object.fromEntries(wynik.map((r) => [r.pw_nr, r.z_zwrotu]));

test('PYTANIE USERA: drugie rozmontowanie tego samego zestawu NIE lapie cudzego KFS', () => {
  // jeden zwrot, dwa rozmontowania po 1 szt. - tylko pierwsze ma pokrycie
  const w = flagi(przydzielZwroty(
    [rozm('PW 1', 1), rozm('PW 2', 2)],
    [zwrot(0)],
  ));
  assert.equal(w['PW 1'], true, 'pierwsze zjada zwrocona sztuke');
  assert.equal(w['PW 2'], false, 'drugie zastaje pusta pule - to rozmontowanie ZE STANU');
});

test('ile zwrotow, tyle rozmontowan z zwrotu', () => {
  const w = flagi(przydzielZwroty(
    [rozm('PW 1', 1), rozm('PW 2', 2), rozm('PW 3', 3)],
    [zwrot(0), zwrot(0)],
  ));
  assert.deepEqual(w, { 'PW 1': true, 'PW 2': true, 'PW 3': false });
});

test('kolejnosc chronologiczna, nie kolejnosc wejscia', () => {
  // pozniejsze rozmontowanie podane PIERWSZE nie moze podebrac sztuki wczesniejszemu
  const w = flagi(przydzielZwroty(
    [rozm('PW pozne', 5), rozm('PW wczesne', 1)],
    [zwrot(0)],
  ));
  assert.equal(w['PW wczesne'], true);
  assert.equal(w['PW pozne'], false);
});

test('zwrot PO rozmontowaniu nie liczy sie do niego', () => {
  const w = flagi(przydzielZwroty([rozm('PW 1', 1)], [zwrot(5)]));
  assert.equal(w['PW 1'], false, 'nie mozna rozmontowac zwrotu, ktory jeszcze nie wrocil');
});

test('zwrot starszy niz okno (14 dni) juz nie pokrywa', () => {
  assert.equal(flagi(przydzielZwroty([rozm('PW 1', 14)], [zwrot(0)]))['PW 1'], true, 'granica okna wlacznie');
  assert.equal(flagi(przydzielZwroty([rozm('PW 1', 15)], [zwrot(0)]))['PW 1'], false, 'poza oknem');
});

test('pule licza sie ODDZIELNIE dla kazdego zestawu', () => {
  const w = flagi(przydzielZwroty(
    [rozm('PW A', 1, 1, 100), rozm('PW B', 1, 1, 200)],
    [zwrot(0, 1, 100)], // wrocil tylko zestaw 100
  ));
  assert.equal(w['PW A'], true);
  assert.equal(w['PW B'], false, 'zwrot innego zestawu nie pokrywa tego');
});

test('czesciowe pokrycie liczy sie jako "z zwrotu" (bezpieczny kierunek), ale zjada tylko swoje', () => {
  // rozmontowano 6 szt., wrocila 1 -> dokument dostaje ZADANIE (nie auto-dopis),
  // ale pula traci tylko 1 szt., wiec kolejne rozmontowanie juz nic nie zlapie
  const w = flagi(przydzielZwroty(
    [rozm('PW duze', 1, 6), rozm('PW kolejne', 2, 1)],
    [zwrot(0, 1)],
  ));
  assert.equal(w['PW duze'], true);
  assert.equal(w['PW kolejne'], false, 'pula zuzyta przez czesciowe pokrycie');
});

test('brak zwrotow = wszystko ze stanu', () => {
  const w = flagi(przydzielZwroty([rozm('PW 1', 1), rozm('PW 2', 2)], []));
  assert.deepEqual(w, { 'PW 1': false, 'PW 2': false });
});
