'use strict';

// Dopasowanie kodu lokalizacji do pol wlasnych GT (tw_Pole1/tw_Pole8). Pola sa pisane RECZNIE
// i skompresowane ("M2-B3-P3 / M2-B4-P3", "C14P1 /L19P3 /"), wiec ta sama polka wystepuje tam
// w obu ortografiach. WMS trzyma jeden kod kanoniczny ("A1-P1"), wiec dopasowanie musi
// ignorowac myslnik - inaczej skan lokalizacji nie pokazuje towarow opisanych jako "A1P1".
//
// Test na czystej funkcji - bez GT i SQLite (kodJestTokenemLokalizacji nie dotyka zadnego z nich).

const test = require('node:test');
const assert = require('node:assert');

const { kodJestTokenemLokalizacji } = require('../services/gt-produkty');

test('kod z myslnikiem lapie pole GT zapisane BEZ myslnika (i odwrotnie)', () => {
  assert.ok(kodJestTokenemLokalizacji('A1P1', 'A1-P1'));
  assert.ok(kodJestTokenemLokalizacji('A1-P1', 'A1P1'));
  assert.ok(kodJestTokenemLokalizacji('C14P1 /L19P3 /', 'C14-P1'));
  assert.ok(kodJestTokenemLokalizacji('M2-B3-P3 / M2-B4-P3', 'M2B4P3'));
});

test('nadal wymaga PELNEGO czlonu, nie podciagu', () => {
  // "C16" nie moze lapac "M2-C16-P2" - to inna polka, nie inny zapis tej samej
  assert.equal(kodJestTokenemLokalizacji('M2-C16-P2', 'C16'), false);
  assert.equal(kodJestTokenemLokalizacji('A1-P1 / A2-P1', 'A1'), false);
});

test('wielkosc liter i puste pole', () => {
  assert.ok(kodJestTokenemLokalizacji('c14p1', 'C14-P1'));
  assert.equal(kodJestTokenemLokalizacji('', 'A1-P1'), false);
  assert.equal(kodJestTokenemLokalizacji(null, 'A1-P1'), false);
});
