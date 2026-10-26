'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { zmianyHurtPln, wyliczHurtPln, wymagaZapisu } = require('../services/sellasist-hurt-pln-model');

const produkt = (id, hurt, hurtPln) => ({
  product_id: String(id),
  symbol: `S${id}`,
  pricesfieldsvalues: [
    ...(hurt == null ? [] : [{ name: 'Hurt', pricesfield_id: 2, value: hurt }]),
    { name: 'EUR', pricesfield_id: 5, value: 27.75 },
    ...(hurtPln == null ? [] : [{ name: 'Hurt_PLN', pricesfield_id: 6, value: hurtPln }]),
  ],
});

test('Hurt (EUR) × kurs, zaokraglone do grosza', () => {
  assert.strictEqual(wyliczHurtPln(42.66, 4.4026), 187.81);
  assert.strictEqual(wyliczHurtPln(0, 4.4026), null);
  assert.strictEqual(wyliczHurtPln(null, 4.4026), null);
  assert.strictEqual(wyliczHurtPln(10, 0), null);
});

test('pusty Hurt_PLN zawsze do zapisu, zblizony w tolerancji nie', () => {
  assert.strictEqual(wymagaZapisu(null, 100), true);
  assert.strictEqual(wymagaZapisu(0, 100), true);
  assert.strictEqual(wymagaZapisu(100.5, 100), false);
  assert.strictEqual(wymagaZapisu(102, 100), true);
  assert.strictEqual(wymagaZapisu(100.5, 100, 0), true);
});

test('zmiany: bez Hurtu pomijamy, rowne pomijamy', () => {
  const { zmiany, bezHurtu } = zmianyHurtPln([
    produkt(1, 42.66, null),
    produkt(2, null, null),
    produkt(3, 0, null),
    produkt(4, 10, 44.03),
    produkt(5, 10, 40),
  ], 4.4026);
  assert.strictEqual(bezHurtu, 2);
  assert.deepStrictEqual(zmiany.map((z) => [z.product_id, z.nowa]), [[1, 187.81], [5, 44.03]]);
});

test('tolerancja 0 przepisuje drobne roznice, ale nie identyczne', () => {
  const { zmiany } = zmianyHurtPln([produkt(4, 10, 44.03), produkt(6, 10, 44.1)], 4.4026, { tolerancja: 0 });
  assert.deepStrictEqual(zmiany.map((z) => z.product_id), [6]);
});

test('Hurt wpisany w PLN (wyszloby > 2× ceny) - zapisujemy, ale zglaszamy jako podejrzany', () => {
  const p = { ...produkt(7, 20.99, null), price: '20.99' };
  const ok = { ...produkt(8, 4, null), price: '19.99' };
  const { zmiany, podejrzane } = zmianyHurtPln([p, ok], 4.4026);
  assert.deepStrictEqual(podejrzane.map((z) => z.symbol), ['S7']);
  assert.deepStrictEqual(zmiany.map((z) => z.symbol), ['S7', 'S8']);
});
