'use strict';

const test = require('node:test');
const assert = require('node:assert');
const m = require('../services/stan-towaru-model');

const dzis = '2026-10-30';
const ocen = (x) => m.ocenTowar({ dzis, pierwszePrzyjecie: '2024-01-01', razem: x.dostepne ?? 0, ...x });

test('tempo = szybsze z 90 dni i roku, okno skrócone do wieku towaru', () => {
  assert.strictEqual(m.tempoDzienne({ szt90: 90, szt365: 100 }), 1);              // sezon: 90 dni wygrywa
  assert.strictEqual(m.tempoDzienne({ szt90: 0, szt365: 365 }), 1);               // cichy kwartał: rok wygrywa
  assert.strictEqual(m.tempoDzienne({ szt90: 60, szt365: 120, wiek: 120 }), 1);   // młody towar: rok = 120 dni
  assert.strictEqual(m.tempoDzienne({ szt90: 0, szt365: 0 }), 0);
});

test('kubełki wg zapasu w dniach', () => {
  const s = { ostatnia: '2026-10-29', szt90: 90, szt365: 90 };                  // 1 szt./dzień
  assert.strictEqual(ocen({ ...s, dostepne: 10 }).kub, 'konczy');
  assert.strictEqual(ocen({ ...s, dostepne: 30 }).kub, 'ok');
  assert.strictEqual(ocen({ ...s, dostepne: 180 }).kub, 'ok');
  assert.strictEqual(ocen({ ...s, dostepne: 181 }).kub, 'wolna');
  assert.strictEqual(ocen({ ...s, dostepne: 366 }).kub, 'nadmiar');
  assert.strictEqual(ocen({ ...s, dostepne: 366 }).dni, 366);
});

test('leżak = 0 szt. w 180 dni albo brak sprzedaży w historii', () => {
  assert.strictEqual(ocen({ dostepne: 5, ostatnia: '2026-04-01', szt365: 3 }).kub, 'lezak');
  assert.strictEqual(ocen({ dostepne: 5, ostatnia: null }).kub, 'lezak');
  assert.strictEqual(ocen({ dostepne: 5, ostatnia: '2026-05-10', szt365: 3 }).kub, 'nadmiar');   // 173 dni temu — jeszcze nie leżak
});

test('nowość < 60 dni od pierwszej dostawy — nawet bez sprzedaży', () => {
  assert.strictEqual(ocen({ dostepne: 50, pierwszePrzyjecie: '2026-09-15' }).kub, 'nowosc');
  assert.strictEqual(ocen({ dostepne: 50, pierwszePrzyjecie: '2026-08-01' }).kub, 'lezak');
});

test('brak: nic do sprzedania przy sprzedaży w 30 dni; bez sprzedaży — poza analizą', () => {
  assert.strictEqual(ocen({ dostepne: 0, szt30: 4, ostatnia: '2026-10-28' }).kub, 'brak');
  assert.strictEqual(ocen({ dostepne: 0, razem: 3, szt30: 0, ostatnia: '2026-01-01' }), null);   // cały stan zarezerwowany
  assert.strictEqual(ocen({ dostepne: 0, szt30: 0 }), null);
});

test('podsumowanie kafli', () => {
  const p = m.podsumuj([{ kub: 'lezak', razem: 3, wart: 10.4 }, { kub: 'lezak', razem: 2, wart: 5 }, { kub: 'ok', razem: 7, wart: 100 }]);
  assert.deepStrictEqual(p.kub.lezak, { sku: 2, szt: 5, wart: 15 });
  assert.deepStrictEqual(p.razem, { sku: 3, szt: 12, wart: 115 });
  assert.deepStrictEqual(p.kub.brak, { sku: 0, szt: 0, wart: 0 });
});

test('siła sprzedaży: szt. / 30 dni średnio z 90 dni, okno skrócone do wieku', () => {
  assert.strictEqual(m.silaSprzedazy({ szt90: 30 }), 'mocna');       // 10 / 30 dni
  assert.strictEqual(m.silaSprzedazy({ szt90: 29 }), 'srednia');
  assert.strictEqual(m.silaSprzedazy({ szt90: 9 }), 'srednia');       // 3 / 30 dni
  assert.strictEqual(m.silaSprzedazy({ szt90: 7 }), 'slaba');         // Bubblepops
  assert.strictEqual(m.silaSprzedazy({ szt90: 15, wiek: 45 }), 'mocna');
  // Nadmiar z hitem i z maruderem — ten sam kubełek, inna siła
  assert.strictEqual(ocen({ dostepne: 2080, ostatnia: '2026-10-29', szt90: 247, szt365: 1486 }).sila, 'mocna');
  const bubblepops = ocen({ dostepne: 455, ostatnia: '2026-10-25', szt90: 7, szt365: 69 });
  assert.deepStrictEqual([bubblepops.kub, bubblepops.sila], ['nadmiar', 'slaba']);
});
