'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

// moduł zakłada swoją tabelę przy wczytaniu — w teście na pustej bazie tymczasowej, nie na db/pricing.db
process.env.PRICING_DB = path.join(os.tmpdir(), `pricing-doplaty-${process.pid}.db`);
const { wpisDoplaty, oknoOd, TYPY } = require('../pricing/doplaty-allegro');

const wpis = (typ, kwota = '16.14', extra = {}) => ({ id: 'e1', occurredAt: '2026-10-28T06:06:12.000Z', type: { id: typ, name: '…' },
  value: { amount: kwota, currency: 'PLN' }, order: { id: '8eacb7c0-d295-11f1-9ef9-ef9dc7059ec8' }, ...extra });

test('wpis dopłaty: PS1/PSA/PSO z zamówieniem i kwotą PLN, reszta odpada', () => {
  assert.deepStrictEqual(wpisDoplaty(wpis('PS1'), 'NATROPIE'), { id: 'e1', konto: 'NATROPIE',
    zamowienie: '8eacb7c0-d295-11f1-9ef9-ef9dc7059ec8', czas: '2026-10-28T06:06:12.000Z', typ: 'PS1', kwota: 16.14 });
  for (const t of TYPY) assert.ok(wpisDoplaty(wpis(t), 'EKAJTEK'));
  assert.strictEqual(wpisDoplaty(wpis('SUC', '-18.40'), 'EKAJTEK'), null, 'prowizja to nie dopłata');
  assert.strictEqual(wpisDoplaty(wpis('PS1', '16.14', { order: null }), 'EKAJTEK'), null, 'bez zamówienia nie ma do czego doliczyć');
  assert.strictEqual(wpisDoplaty(wpis('PS1', '5', { value: { amount: '5', currency: 'CZK' } }), 'EKAJTEK'), null);
  assert.strictEqual(wpisDoplaty(wpis('PS1', '0'), 'EKAJTEK'), null);
  assert.strictEqual(wpisDoplaty(wpis('PS1', '-3.10'), 'EKAJTEK').kwota, -3.1, 'korekta dopłaty zostaje ze znakiem');
});

test('okno: ostatni wpis minus 2 h zakładki; bez znacznika 14 dni wstecz', () => {
  assert.strictEqual(oknoOd('2026-10-28T06:06:12.000Z'), '2026-10-28T04:06:12.000Z');
  const teraz = Date.parse('2026-10-30T12:00:00.000Z');
  assert.strictEqual(oknoOd(null, teraz), '2026-10-16T12:00:00.000Z');
  assert.strictEqual(oknoOd('śmieci', teraz), '2026-10-16T12:00:00.000Z');
});
