'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { WAZNOSC_MS, normalizujSymbol, adresyRozmiarow, czyAktualny, rozmiarZParametru } = require('../services/zdjecia-model');

test('symbol porownujemy bez spacji brzegowych i wielkosci liter', () => {
  assert.strictEqual(normalizujSymbol('  ses66146b '), 'SES66146B');
  assert.strictEqual(normalizujSymbol(null), '');
});

test('miniatura /t/ -> oryginal pod /n/ z tym samym plikiem', () => {
  assert.deepStrictEqual(
    adresyRozmiarow('https://imge.pl/p/325802/t/60e49f8997f8272a7e3b981fa552a8e0.jpg'),
    {
      mini: 'https://imge.pl/p/325802/t/60e49f8997f8272a7e3b981fa552a8e0.jpg',
      duze: 'https://imge.pl/p/325802/n/60e49f8997f8272a7e3b981fa552a8e0.jpg',
    },
  );
});

test('adres w obcym ksztalcie zostaje dla obu rozmiarow - nie zgadujemy sciezki', () => {
  const url = 'https://cdn.example.com/foto/abc.jpg';
  assert.deepStrictEqual(adresyRozmiarow(url), { mini: url, duze: url });
  assert.strictEqual(adresyRozmiarow(null), null);
});

test('waznosc: znalezione zdjecie dluzej niz "brak zdjecia"', () => {
  const teraz = 1_000_000_000_000;
  const dzien = 24 * 60 * 60 * 1000;
  assert.strictEqual(czyAktualny({ url: 'x', sprawdzono: teraz - 2 * dzien }, teraz), true);
  assert.strictEqual(czyAktualny({ url: 'x', sprawdzono: teraz - WAZNOSC_MS.jest }, teraz), false);
  assert.strictEqual(czyAktualny({ url: null, sprawdzono: teraz - 2 * dzien }, teraz), false);
  assert.strictEqual(czyAktualny({ url: null, sprawdzono: teraz - 1000 }, teraz), true);
  assert.strictEqual(czyAktualny(null, teraz), false);
});

test('nieznany rozmiar = miniatura', () => {
  assert.strictEqual(rozmiarZParametru('duze'), 'duze');
  assert.strictEqual(rozmiarZParametru('ogromne'), 'mini');
  assert.strictEqual(rozmiarZParametru(undefined), 'mini');
});
