'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { interwalMsZMinut, MAX_MS } = require('../services/interwal');

test('zwykla wartosc z .env przelicza sie na milisekundy', () => {
  assert.strictEqual(interwalMsZMinut('10', 60), 10 * 60 * 1000);
});

test('brak wartosci / smieci / zero -> domyslna liczba minut', () => {
  for (const surowe of [undefined, '', 'co godzine', '0', '-5', NaN]) {
    assert.strictEqual(interwalMsZMinut(surowe, 30), 30 * 60 * 1000, `dla ${String(surowe)}`);
  }
});

// Sedno: setInterval trzyma opoznienie w 32 bitach, a Node zwija za duza wartosc do 1 ms -
// job miast "raz na 70 dni" leci tysiace razy na sekunde (i pisze do GT).
test('wartosc ponad limit setInterval jest scinana, NIE zawija sie do 1 ms', () => {
  const ms = interwalMsZMinut('100000', 10);   // 100 000 min = 6e9 ms > 2^31-1
  assert.strictEqual(ms, MAX_MS);
  assert.ok(ms > 1, 'nigdy nie schodzi do 1 ms');
  assert.ok(ms <= 2 ** 31 - 1, 'miesci sie w 32 bitach ze znakiem');
});

test('wartosc tuz pod limitem zostaje nietknieta', () => {
  const min = Math.floor(MAX_MS / 60000);      // ~35791 min
  assert.strictEqual(interwalMsZMinut(String(min), 10), min * 60 * 1000);
});

test('domyslna wartosc tez przechodzi przez clamp (zla stala w kodzie nie zapetli joba)', () => {
  assert.strictEqual(interwalMsZMinut(undefined, 99999), MAX_MS);
});
