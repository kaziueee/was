'use strict';

const test = require('node:test');
const assert = require('node:assert');

process.env.PRICING_DB = ':memory:';
const { zOdpowiedzi } = require('../pricing/obserwuj');

const JA = 'A297N0KEJID15J';
const oferta = (cena, wys, o) => ({ ListingPrice: { Amount: cena }, Shipping: { Amount: wys }, ...o });

test('dwie nasze oferty na jednym ASIN-ie — „moja" to tylko MyOffer, BB innej naszej = bbInnaNasza', () => {
  // przypadek NERE0011 / NERE0011-1 (2026-10-14): -1 za 24,99 bez wysyłki ma BB
  const obs = zOdpowiedzi({ Offers: [
    oferta(24.99, 0, { MyOffer: false, SellerId: JA, IsBuyBoxWinner: true }),
    oferta(27.49, 4.99, { MyOffer: true, SellerId: JA }),
    oferta(39.95, 0, { MyOffer: false, SellerId: 'INNY' }),
  ] });
  assert.strictEqual(obs.cena, 27.49);
  assert.strictEqual(obs.wysylka, 4.99);
  assert.strictEqual(obs.bbNasz, false);
  assert.strictEqual(obs.bbInnaNasza, true);
  assert.strictEqual(obs.najtanszaInna, 39.95);          // nasza druga oferta nie jest „konkurentem"
});

test('brak naszej oferty w odpowiedzi — cena null (nie bierzemy cudzej ani innej naszej)', () => {
  const obs = zOdpowiedzi({ Offers: [oferta(24.99, 0, { MyOffer: false, SellerId: JA, IsBuyBoxWinner: true })] });
  assert.strictEqual(obs.cena, null);
});

test('my mamy BB — bbNasz true, bbInnaNasza false', () => {
  const obs = zOdpowiedzi({ Offers: [oferta(20, 4.99, { MyOffer: true, SellerId: JA, IsBuyBoxWinner: true }), oferta(30, 0, { SellerId: 'X' })] });
  assert.strictEqual(obs.bbNasz, true);
  assert.strictEqual(obs.bbInnaNasza, false);
});
