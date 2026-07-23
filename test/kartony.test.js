'use strict';

// Dobor kartonu i waga gabarytowa "z kartonu". Czyste funkcje - test nie dotyka SQLite ani GT
// (importuje config/kartony, ktore nie ma zaleznosci; services/kartony dodaje tylko zrodlo DB).

const test = require('node:test');
const assert = require('node:assert');

const {
  KARTONY, dobierzKartonZListy, dobierzKarton, liczWageKartonZListy, sprawdzKarton,
} = require('../config/kartony');

// Lista kontrolna (wys/szer/dl, cm). Objetosci: MINI=8, MALY=500, SREDNI=4000, DUZY=24000.
const LISTA = [
  { kod: 'MINI',   wysokosc: 2,  szerokosc: 2,  dlugosc: 2 },
  { kod: 'MALY',   wysokosc: 5,  szerokosc: 10, dlugosc: 10 },
  { kod: 'SREDNI', wysokosc: 10, szerokosc: 20, dlugosc: 20 },
  { kod: 'DUZY',   wysokosc: 20, szerokosc: 30, dlugosc: 40 },
];

// --- dobierzKartonZListy: dopasowanie ---

test('wybiera najmniejszy objetosciowo karton, ktory pomiesci produkt', () => {
  // 12x12x3 nie wchodzi w MALY [10,10,5], wchodzi w SREDNI [20,20,10]
  assert.equal(dobierzKartonZListy(LISTA, { dlugosc: 12, szerokosc: 12, wysokosc: 3 }).kod, 'SREDNI');
  // 3x3x3 wchodzi juz w MALY (MINI [2,2,2] za male)
  assert.equal(dobierzKartonZListy(LISTA, { dlugosc: 3, szerokosc: 3, wysokosc: 3 }).kod, 'MALY');
});

test('rotacja dozwolona - kolejnosc bokow produktu nieistotna', () => {
  const a = dobierzKartonZListy(LISTA, { dlugosc: 20, szerokosc: 3, wysokosc: 12 });
  const b = dobierzKartonZListy(LISTA, { dlugosc: 3, szerokosc: 12, wysokosc: 20 });
  assert.equal(a.kod, 'SREDNI');
  assert.equal(b.kod, 'SREDNI');
});

test('przy rownej objetosci wygrywa wczesniejszy na liscie (stabilny sort)', () => {
  const A = { kod: 'A', wysokosc: 10, szerokosc: 10, dlugosc: 10 }; // vol 1000
  const B = { kod: 'B', wysokosc: 5, szerokosc: 10, dlugosc: 20 };  // vol 1000, inny ksztalt
  const prod = { dlugosc: 4, szerokosc: 4, wysokosc: 4 };           // miesci sie w obu
  assert.equal(dobierzKartonZListy([A, B], prod).kod, 'A');
  assert.equal(dobierzKartonZListy([B, A], prod).kod, 'B');
});

test('produkt wiekszy od kazdego kartonu -> null', () => {
  assert.equal(dobierzKartonZListy(LISTA, { dlugosc: 50, szerokosc: 50, wysokosc: 50 }), null);
});

test('brak/zero/niepoprawne wymiary -> null (bez rzucania na null)', () => {
  assert.equal(dobierzKartonZListy(LISTA, { dlugosc: 0, szerokosc: 20, wysokosc: 5 }), null);
  assert.equal(dobierzKartonZListy(LISTA, {}), null);
  assert.equal(dobierzKartonZListy(LISTA, null), null);
  assert.equal(dobierzKartonZListy(LISTA, { dlugosc: 'abc', szerokosc: 10, wysokosc: 10 }), null);
});

// --- liczWageKartonZListy: waga + zrodlo ---

test('karton pasuje -> waga z kartonu (obj/4000), zrodlo karton', () => {
  // 12x12x3 -> SREDNI (obj 4000) -> 1,00 kg
  assert.deepEqual(
    liczWageKartonZListy(LISTA, { dlugosc: 12, szerokosc: 12, wysokosc: 3 }),
    { waga: '1,00', karton_kod: 'SREDNI', zrodlo: 'karton' }
  );
});

test('brak kartonu, ale sa wymiary -> FALLBACK gola waga, zrodlo wymiar', () => {
  // 50x50x50 -> nic nie pasuje -> 125000/4000 = 31,25
  assert.deepEqual(
    liczWageKartonZListy(LISTA, { dlugosc: 50, szerokosc: 50, wysokosc: 50 }),
    { waga: '31,25', karton_kod: null, zrodlo: 'wymiar' }
  );
});

test('drobiazg dostaje minimum 0,01 (nie "0,00" = brak danych)', () => {
  // 1x1x1 -> MINI (obj 8) -> 0,002 -> podniesione do 0,01
  assert.equal(liczWageKartonZListy(LISTA, { dlugosc: 1, szerokosc: 1, wysokosc: 1 }).waga, '0,01');
});

test('brak wymiarow -> null', () => {
  assert.equal(liczWageKartonZListy(LISTA, {}), null);
  assert.equal(liczWageKartonZListy(LISTA, null), null);
  assert.equal(liczWageKartonZListy(LISTA, { dlugosc: 0, szerokosc: 5, wysokosc: 5 }), null);
});

test('waga zawsze 2 miejsca po przecinku (przecinek, nie kropka)', () => {
  const r = liczWageKartonZListy(LISTA, { dlugosc: 12, szerokosc: 12, wysokosc: 3 });
  assert.match(r.waga, /^\d+,\d{2}$/);
});

// --- sprawdzKarton: walidacja ---

test('poprawny karton przechodzi walidacje', () => {
  const r = sprawdzKarton({ kod: 'B7', wysokosc: 10, szerokosc: 20, dlugosc: 30 });
  assert.deepEqual(r.karton, { kod: 'B7', wysokosc: 10, szerokosc: 20, dlugosc: 30 });
});

test('akceptuje wymiary jako tekst z przecinkiem', () => {
  const r = sprawdzKarton({ kod: 'X', wysokosc: '7,5', szerokosc: '25', dlugosc: '35' });
  assert.equal(r.karton.wysokosc, 7.5);
});

test('pusty kod, zero i wartosc nierealna -> blad', () => {
  assert.ok(sprawdzKarton({ kod: '  ', wysokosc: 10, szerokosc: 10, dlugosc: 10 }).blad);
  assert.ok(sprawdzKarton({ kod: 'X', wysokosc: 0, szerokosc: 10, dlugosc: 10 }).blad);
  assert.ok(sprawdzKarton({ kod: 'X', wysokosc: 10, szerokosc: 10, dlugosc: 1001 }).blad);
});

// --- sanity na realnej liscie seed (config KARTONY) ---

test('realny seed: plaski 30x20x2 -> A-KleinPacket 1,64 kg (goly wymiar dalby 0,30)', () => {
  assert.equal(dobierzKarton({ dlugosc: 30, szerokosc: 20, wysokosc: 2 }).kod, 'A-KleinPacket');
  assert.deepEqual(
    liczWageKartonZListy(KARTONY, { dlugosc: 30, szerokosc: 20, wysokosc: 2 }),
    { waga: '1,64', karton_kod: 'A-KleinPacket', zrodlo: 'karton' }
  );
});
