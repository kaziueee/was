'use strict';

const test = require('node:test');
const assert = require('node:assert');

process.env.PRICING_DB = ':memory:';
const { db } = require('../pricing/db');
const { pewneDopasowanie, powiaz, usunPowiazanie } = require('../pricing/powiazania');

const dodaj = (rynek, sku, tw, dop, auto) => db.prepare(
  "INSERT INTO oferty (platforma, rynek, sku, tw_id, symbol_gt, dopasowanie, auto) VALUES ('amazon', ?, ?, ?, ?, ?, ?)",
).run(rynek, sku, tw, tw ? 'S' + tw : null, dop, auto);
const oferta = (rynek, sku) => db.prepare("SELECT * FROM oferty WHERE rynek = ? AND sku = ?").get(rynek, sku);

test('pewne dopasowanie = wprost albo ręczne; obcięte i brak — nie', () => {
  assert.ok(pewneDopasowanie('wprost'));
  assert.ok(pewneDopasowanie('reczne'));
  assert.ok(!pewneDopasowanie('obciete'));
  assert.ok(!pewneDopasowanie(null));
});

test('powiązanie z INNYM towarem wyłącza automat na wszystkich rynkach tego SKU', () => {
  dodaj('DE', 'NERE9533-2', 1, 'obciete', 1);
  dodaj('FR', 'NERE9533-2', 1, 'obciete', 1);
  assert.strictEqual(powiaz('amazon', 'NERE9533-2', { tw_Id: 2, tw_Symbol: 'NERE9533FFP' }, 'test'), 2);
  for (const r of ['DE', 'FR']) {
    const o = oferta(r, 'NERE9533-2');
    assert.strictEqual(o.tw_id, 2);
    assert.strictEqual(o.dopasowanie, 'reczne');
    assert.strictEqual(o.auto, 0);
  }
});

test('potwierdzenie tego samego towaru zostawia automat i oznacza dopasowanie jako ręczne', () => {
  dodaj('DE', 'HASG0481-1', 5, 'obciete', 1);
  powiaz('amazon', 'HASG0481-1', { tw_Id: 5, tw_Symbol: 'S5' }, 'test');
  const o = oferta('DE', 'HASG0481-1');
  assert.strictEqual(o.dopasowanie, 'reczne');
  assert.strictEqual(o.auto, 1);
});

test('usunięcie ręcznego powiązania zdejmuje towar i automat', () => {
  usunPowiazanie('amazon', 'HASG0481-1', 'test');
  const o = oferta('DE', 'HASG0481-1');
  assert.strictEqual(o.tw_id, null);
  assert.strictEqual(o.auto, 0);
});
