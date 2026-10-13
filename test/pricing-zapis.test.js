'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { budujZmianeCeny } = require('../pricing/zapis-model');

const DE = 'A1PA6795UKMFR9';
const cena = (v) => [{ schedule: [{ value_with_tax: v }] }];

test('podmienia tylko our_price wpisu ALL, reszta oferty zostaje', () => {
  const po = [
    { marketplace_id: DE, currency: 'EUR', audience: 'ALL', our_price: cena(16.99), minimum_seller_allowed_price: cena(12) },
    { marketplace_id: DE, currency: 'EUR', audience: 'B2B', our_price: cena(15.5) },
  ];
  const z = budujZmianeCeny(po, DE, 18.69);
  assert.strictEqual(z.blad, undefined);
  assert.strictEqual(z.patches[0].op, 'replace');
  assert.strictEqual(z.patches[0].path, '/attributes/purchasable_offer');
  const [all, b2b] = z.patches[0].value;
  assert.deepStrictEqual(all.our_price, cena(18.69));
  assert.deepStrictEqual(all.minimum_seller_allowed_price, cena(12));   // nie skasowane
  assert.deepStrictEqual(b2b, po[1]);                                     // B2B nietknięte
  assert.deepStrictEqual(po[0].our_price, cena(16.99));                   // wejście niezmienione
});

test('oferta w regule Automate Pricing — odmowa', () => {
  const po = [{ marketplace_id: DE, audience: 'ALL', our_price: cena(21.99),
    automated_pricing_merchandising_rule_plan: [{ merchandising_rule: { rule_id: 'x' } }] }];
  assert.match(budujZmianeCeny(po, DE, 20).blad, /Automate Pricing/);
});

test('brak wpisu dla rynku albo zła cena — odmowa', () => {
  assert.ok(budujZmianeCeny([], DE, 20).blad);
  assert.ok(budujZmianeCeny([{ marketplace_id: DE, audience: 'ALL' }], DE, 0).blad);
});

test('cena zaokrąglona do grosza', () => {
  const z = budujZmianeCeny([{ marketplace_id: DE, audience: 'ALL', our_price: cena(10) }], DE, 18.6900000001);
  assert.strictEqual(z.cena, 18.69);
});
