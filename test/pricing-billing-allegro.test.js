'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

// moduł zakłada swoją tabelę przy wczytaniu — w teście na pustej bazie tymczasowej, nie na db/pricing.db
process.env.PRICING_DB = path.join(os.tmpdir(), `pricing-billing-${process.pid}.db`);
const { wpisBillingu, oknoOd } = require('../pricing/billing-allegro');

const wpis = (typ, kwota = '16.14', extra = {}) => ({ id: 'e1', occurredAt: '2026-10-28T06:06:12.000Z', type: { id: typ, name: 'Nazwa' },
  value: { amount: kwota, currency: 'PLN' }, order: { id: '8eacb7c0-d295-11f1-9ef9-ef9dc7059ec8' }, ...extra });

test('wpis billingu: każdy typ z zamówieniem i kwotą PLN; bez zamówienia (Ads, abonament) odpada', () => {
  assert.deepStrictEqual(wpisBillingu(wpis('PS1'), 'NATROPIE'), { id: 'e1', konto: 'NATROPIE',
    zamowienie: '8eacb7c0-d295-11f1-9ef9-ef9dc7059ec8', czas: '2026-10-28T06:06:12.000Z', typ: 'PS1', nazwa: 'Nazwa', kwota: 16.14 });
  assert.strictEqual(wpisBillingu(wpis('SUC', '-18.40'), 'EKAJTEK').kwota, -18.4);
  assert.strictEqual(wpisBillingu(wpis('NSP', '-207', { order: null }), 'EKAJTEK'), null);
  assert.strictEqual(wpisBillingu(wpis('PS1', '5', { value: { amount: '5', currency: 'CZK' } }), 'EKAJTEK'), null);
  assert.strictEqual(wpisBillingu(wpis('PS1', '0'), 'EKAJTEK'), null);
});

test('okno: ostatni wpis minus 2 h zakładki; bez znacznika 14 dni wstecz', () => {
  assert.strictEqual(oknoOd('2026-10-28T06:06:12.000Z'), '2026-10-28T04:06:12.000Z');
  const teraz = Date.parse('2026-10-30T12:00:00.000Z');
  assert.strictEqual(oknoOd(null, teraz), '2026-10-16T12:00:00.000Z');
  assert.strictEqual(oknoOd('śmieci', teraz), '2026-10-16T12:00:00.000Z');
});
