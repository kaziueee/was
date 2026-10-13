'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { kandydaciSymbolu, dopasujSymbol } = require('../pricing/mapowanie');

const mapa = new Map([
  ['NERF4178', { tw_Id: 1, tw_Symbol: 'NERF4178' }],
  ['HASF8401', { tw_Id: 2, tw_Symbol: 'HASF8401' }],
  ['BARDWK44-GRB91', { tw_Id: 3, tw_Symbol: 'BARDWK44-GRB91' }],
]);

test('SKU równy symbolowi GT pasuje wprost', () => {
  assert.deepStrictEqual(dopasujSymbol('NERF4178', mapa), { tw_Id: 1, tw_Symbol: 'NERF4178', wprost: true });
});

test('dopisek -1 / -2 to ten sam towar', () => {
  assert.strictEqual(dopasujSymbol('NERF4178-1', mapa).tw_Id, 1);
  assert.strictEqual(dopasujSymbol('NERF4178-1', mapa).wprost, false);
});

test('kod kraju na końcu to ten sam towar', () => {
  assert.strictEqual(dopasujSymbol('HASF8401-DE', mapa).tw_Id, 2);
  assert.strictEqual(dopasujSymbol('hasf8401fr', mapa).tw_Id, 2);
});

test('wariant z myślnikiem w samym symbolu GT nie jest obcinany, gdy istnieje', () => {
  assert.strictEqual(dopasujSymbol('BARDWK44-GRB91', mapa).tw_Id, 3);
});

test('nieznany SKU — brak dopasowania, bez zgadywania po prefiksie', () => {
  assert.strictEqual(dopasujSymbol('BARDWK44-XYZ', mapa), null);
  assert.deepStrictEqual(kandydaciSymbolu(''), []);
});
