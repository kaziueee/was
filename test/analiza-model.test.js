'use strict';

const test = require('node:test');
const assert = require('node:assert');
const m = require('../services/analiza-model');

test('rok temu = 364 dni wstecz, ten sam dzień tygodnia', () => {
  assert.strictEqual(m.rokTemu('2026-10-19'), '2025-10-20');
  assert.strictEqual(new Date('2026-10-19').getUTCDay(), new Date(m.rokTemu('2026-10-19')).getUTCDay());
  assert.strictEqual(m.rokTemu('2026-03-01'), '2025-03-02');
});

test('zakresy: dzień, 7 dni, miesiąc i rok do dziś, każdy z odpowiednikiem sprzed 364 dni', () => {
  assert.deepStrictEqual(m.zakres('dzien', '2026-10-19'), { cur: ['2026-10-19', '2026-10-19'], prev: ['2025-10-20', '2025-10-20'] });
  assert.deepStrictEqual(m.zakres('t7', '2026-10-19'), { cur: ['2026-10-13', '2026-10-19'], prev: ['2025-10-14', '2025-10-20'] });
  assert.deepStrictEqual(m.zakres('mtd', '2026-10-19'), { cur: ['2026-10-01', '2026-10-19'], prev: ['2025-10-02', '2025-10-20'] });
  assert.deepStrictEqual(m.zakres('ytd', '2026-10-19'), { cur: ['2026-01-01', '2026-10-19'], prev: ['2025-01-02', '2025-10-20'] });
  assert.strictEqual(m.zakres('rok', '2026-10-19'), null);
});

test('kurs dokumentu: HUF w GT jest za 100 Ft, reszta za 1', () => {
  assert.ok(Math.abs(m.kursDokumentu('HUF', 1.2008) - 0.012008) < 1e-12);
  assert.strictEqual(m.kursDokumentu('EUR', 4.3786), 4.3786);
  assert.strictEqual(m.kursDokumentu('PLN', 0), 1);
  assert.strictEqual(m.kursDokumentu('', null), 1);
});

test('UUID v1 zamówienia Allegro → prawdziwy czas złożenia (ZK z 20.10.2025 złożone 18.10)', () => {
  assert.strictEqual(m.czasZUuidV1('01acd4ab-aba6-11f0-8dd9-c5aff975466e').toISOString(), '2025-10-17T22:09:52.951Z');
  assert.deepStrictEqual(m.dzienICzasPl(m.czasZUuidV1('01acd4ab-aba6-11f0-8dd9-c5aff975466e')), { dzien: '2025-10-18', godz: '00:09' });
  assert.strictEqual(m.czasZUuidV1('6e3e0543-abd4-41f0-8dd9-c5aff975466e'), null);   // wersja 4 — brak czasu
  assert.strictEqual(m.czasZUuidV1('Am302-7328303-6994704-1'), null);
  assert.strictEqual(m.czasZUuidV1(null), null);
});

test('data zamówienia: Allegro z UUID, inaczej ZK, bez ZK — FS; UUID z innego okresu ignorowany', () => {
  assert.deepStrictEqual(m.dataZamowienia({ uuid: '01acd4ab-aba6-11f0-8dd9-c5aff975466e', dataZk: '2025-10-20', dataFs: '2025-10-20' }),
    { dzien: '2025-10-18', godz: '00:09', zrodlo: 'uuid' });
  assert.deepStrictEqual(m.dataZamowienia({ uuid: null, dataZk: '2026-10-19', dataFs: '2026-10-20' }), { dzien: '2026-10-19', godz: null, zrodlo: 'zk' });
  assert.deepStrictEqual(m.dataZamowienia({ dataFs: '2026-10-20' }), { dzien: '2026-10-20', godz: null, zrodlo: 'fs' });
  // UUID z 2025 przy ZK z 2026 — to nie ten identyfikator, zostaje data ZK
  assert.strictEqual(m.dataZamowienia({ uuid: '01acd4ab-aba6-11f0-8dd9-c5aff975466e', dataZk: '2026-10-20' }).zrodlo, 'zk');
});

test('flagi: nowość < 30 dni, kończy się < 30 dni zapasu, nadmiar przy szybszym tempie, zalega 180 dni', () => {
  const dzis = '2026-10-20';
  assert.deepStrictEqual(m.flagiTowaru({ stan: 10, szt30: 30, szt180: 50, szt365: 60, pierwszePrzyjecie: '2026-10-05', dzis }), ['nowosc', 'konczy']);
  // HWHJBD90: 602 szt., 69 w 30 dni, słaby rok — przy tempie z roku byłby nadmiar, przy szybszym nie
  assert.deepStrictEqual(m.flagiTowaru({ stan: 602, szt30: 69, szt180: 150, szt365: 250, dzis }), []);
  assert.deepStrictEqual(m.flagiTowaru({ stan: 5000, szt30: 3, szt180: 10, szt365: 20, dzis }), ['nadmiar']);
  assert.deepStrictEqual(m.flagiTowaru({ stan: 40, szt30: 0, szt180: 0, szt365: 3, dzis }), ['nadmiar', 'zalega']);
  assert.deepStrictEqual(m.flagiTowaru({ stan: 40, pierwszePrzyjecie: '2026-10-10', dzis }), ['nowosc']);   // nowość bez sprzedaży nie zalega
  assert.deepStrictEqual(m.flagiTowaru({ stan: 0, szt30: 5, dzis }), []);
  assert.strictEqual(m.dniZapasu(602, 69), 262);
  assert.strictEqual(m.dniZapasu(10, 0), null);
});

test('zwrot z pozycji KFS: zmniejszenie ilości i obniżka ceny jako dodatnie wartości zwrotu', () => {
  assert.deepStrictEqual(m.zwrotZPozycji({ znak: -1, ilosc: 1, netto: 54.45 }), { szt: 1, netto: 54.45 });
  assert.deepStrictEqual(m.zwrotZPozycji({ znak: 1, ilosc: 0, netto: -11.12 }), { szt: -0, netto: 11.12 });
  assert.deepStrictEqual(m.zwrotZPozycji({ znak: 1, ilosc: 0, netto: 0 }), { szt: -0, netto: -0 });
});
