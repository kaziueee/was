'use strict';

// Model kodu lokalizacji - czyste funkcje, test bez SQLite/GT.
// Kanonizacja jest tu newralgiczna: kod zapisany w bazie w innej formie niz ta, o ktora
// pyta lookup, robi lokalizacje NIEWIDOCZNA dla skanu (tak zniknely L3P3 i C17P3 na
// produkcji). Test pilnuje, ze zapis i odczyt licza te sama postac.

const test = require('node:test');
const assert = require('node:assert');

const {
  rozbierzKod, normalizujKodLokalizacji, kanonicznyKodSiatki, golyKod,
} = require('../services/lokalizacje-model');

test('kod bez myslnikow dostaje postac kanoniczna', () => {
  assert.equal(normalizujKodLokalizacji('L3P3'), 'L3-P3');
  assert.equal(normalizujKodLokalizacji('C17P3'), 'C17-P3');
  assert.equal(normalizujKodLokalizacji('A8P2'), 'A8-P2');
  assert.equal(normalizujKodLokalizacji('M2A8P2'), 'M2-A8-P2');
});

test('kanonizacja jest idempotentna i odporna na spacje/wielkosc liter', () => {
  assert.equal(normalizujKodLokalizacji('L3-P3'), 'L3-P3');
  assert.equal(normalizujKodLokalizacji(' l3p3 '), 'L3-P3');
  assert.equal(normalizujKodLokalizacji('M2 A8 P2'), 'M2-A8-P2');
  assert.equal(normalizujKodLokalizacji(normalizujKodLokalizacji('L3P3')), 'L3-P3');
});

test('kod bez poziomu zostaje bez myslnika (podstawa regalu)', () => {
  assert.equal(normalizujKodLokalizacji('L3'), 'L3');
  assert.equal(normalizujKodLokalizacji('m2-b27'), 'M2-B27');
});

test('kody spoza siatki regalow zostaja nietkniete (poza trim/uppercase)', () => {
  assert.equal(normalizujKodLokalizacji('RB'), 'RB');
  assert.equal(normalizujKodLokalizacji(' biuro '), 'BIURO');
  assert.equal(normalizujKodLokalizacji('PIRAMIDA I-J'), 'PIRAMIDA I-J');
  // sklejony skan - NIE zgadujemy, co autor mial na mysli
  assert.equal(normalizujKodLokalizacji('B11B11'), 'B11B11');
  // symbol towaru przechodzacy przez ten sam lookup
  assert.equal(normalizujKodLokalizacji('ANGAB-15-U'), 'ANGAB-15-U');
});

test('kanonicznyKodSiatki mowi, czy kod w ogole jest z siatki regalow', () => {
  assert.equal(kanonicznyKodSiatki('L3P3'), 'L3-P3');
  assert.equal(kanonicznyKodSiatki('RB'), null);
  assert.equal(kanonicznyKodSiatki('B11B11'), null);
  assert.equal(kanonicznyKodSiatki('ANE0858U'), null);
  assert.equal(kanonicznyKodSiatki(''), null);
  assert.equal(kanonicznyKodSiatki(null), null);
});

test('golyKod zrownuje oba zapisy tej samej lokalizacji (fallback lookupu)', () => {
  assert.equal(golyKod('L3-P3'), golyKod('L3P3'));
  assert.equal(golyKod(' m2-a8-p2 '), 'M2A8P2');
});

test('kanoniczny kod dostaje prawidlowe cechy (przed kanonizacja byl typ "inny")', () => {
  assert.equal(rozbierzKod('L3P3', 'K4G').typ, 'inny');            // stan sprzed naprawy
  const po = rozbierzKod(normalizujKodLokalizacji('L3P3'), 'K4G');
  assert.equal(po.typ, 'paleta');                                   // K4G = zawsze paleta
  assert.equal(po.regal, 'L');
  assert.equal(po.kolumna, 3);
  assert.equal(po.hala, '1');
});
