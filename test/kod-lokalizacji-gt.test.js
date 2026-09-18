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

// tw_Pole8 (K4G) jest skladane przez WMS jako "kod(ilosc); kod(ilosc)" - nawias z iloscia
// jest czescia ZAPISU, nie kodu. Bez jego zdjecia "M2C6P2(3)" nie rownalo sie "M2C6P2", wiec
// skan lokalizacji K4G nie pokazywal towarow "tylko GT" w ogole: na produkcji taki ksztalt
// ma 1071 z 1511 niepustych pol (sprawdzone 2026-09-18).
test('ilosc w nawiasie (tw_Pole8) nie psuje dopasowania', () => {
  assert.ok(kodJestTokenemLokalizacji('M2-C6-P2(3)', 'M2-C6-P2'));
  assert.ok(kodJestTokenemLokalizacji('M2-C3-P3(126); M2-C4-P3(288)', 'M2-C4-P3'));
  assert.ok(kodJestTokenemLokalizacji('A7-P2(1140); M2-F31-P2(2400)', 'A7P2'));
  // obcięcie pola ("...") nie moze robic z sasiada trafienia
  assert.equal(kodJestTokenemLokalizacji('M2-A1-P2(3); M2-B...', 'M2-B1-P2'), false);
});

// Dopisek stref ("+StD20") dokleja do tw_Pole1 job strefowy - to nie jest czesc adresu.
test('dopisek stref nie jest lokalizacja', () => {
  assert.ok(kodJestTokenemLokalizacji('M2-J14-P2 +StD20 +StZ3', 'M2-J14-P2'));
  assert.equal(kodJestTokenemLokalizacji('+StD20', 'D20'), false);
});
