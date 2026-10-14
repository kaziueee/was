'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { pasDlaOferty } = require('../pricing/pas');

const w = { koszt: 60, waga: 1, docinalny: false };

test('darmowa wysyłka podnosi minimum o mniej więcej kwotę wysyłki (klient jej nie płaci)', () => {
  const std = pasDlaOferty(w, 'DE', 4.99);
  const free = pasDlaOferty(w, 'DE', 0);
  const roznica = free.min - std.min;
  assert.ok(roznica > 4 && roznica < 6, `różnica ${roznica}`);
});

test('ta sama cena daje mniejszy zysk przy darmowej wysyłce', () => {
  assert.ok(pasDlaOferty(w, 'DE', 0).ocen(30).zysk < pasDlaOferty(w, 'DE', 4.99).ocen(30).zysk);
});

test('bez obserwacji wysyłki — wartość z konfiguracji (4,99)', () => {
  assert.strictEqual(pasDlaOferty(w, 'DE', null).min, pasDlaOferty(w, 'DE', 4.99).min);
});

test('rynek bez reguł kalkulatora (PL) — brak pasa', () => {
  assert.strictEqual(pasDlaOferty(w, 'PL', 0), null);
});
