'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { sumujWpisy } = require('../services/analiza-doplaty');

test('dopłaty: wpis z obu źródeł liczy się raz, sumy per płatność, klucz małymi literami', () => {
  const zywe = [{ id: 'A', platnosc: '8ED9BB5C-D295-11F1-8662-23EA4C574D41', kwota: 16.14 }, { id: 'B', platnosc: 'p2', kwota: 5 }];
  const noc = [{ id: 'A', platnosc: '8ed9bb5c-d295-11f1-8662-23ea4c574d41', kwota: 16.14 }, { id: 'C', platnosc: 'p2', kwota: 1.1 },
    { id: 'D', platnosc: null, kwota: 3 }];
  const m = sumujWpisy(zywe, noc);
  assert.strictEqual(m.get('8ed9bb5c-d295-11f1-8662-23ea4c574d41'), 16.14);
  assert.strictEqual(m.get('p2'), 6.1);
  assert.strictEqual(m.size, 2, 'wpis bez płatności (jeszcze nie dopytany) pomijamy');
});
