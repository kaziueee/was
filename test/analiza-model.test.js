'use strict';

const test = require('node:test');
const assert = require('node:assert');
const m = require('../services/analiza-model');

test('rok temu = 364 dni wstecz, ten sam dzień tygodnia', () => {
  assert.strictEqual(m.rokTemu('2026-10-19'), '2025-10-20');
  assert.strictEqual(new Date('2026-10-19').getUTCDay(), new Date(m.rokTemu('2026-10-19')).getUTCDay());
  assert.strictEqual(m.rokTemu('2026-03-01'), '2025-03-02');
});

test('zakresy z dzisiejszym dniem: 7 dni / miesiąc / rok tylko z dni zamkniętych, dzień zostaje dzisiejszy', () => {
  const o = { dzis: '2026-10-21' };
  assert.deepStrictEqual(m.zakres('dzien', '2026-10-21', o).cur, ['2026-10-21', '2026-10-21']);
  assert.deepStrictEqual(m.zakres('t7', '2026-10-21', o).cur, ['2026-10-14', '2026-10-20']);
  assert.deepStrictEqual(m.zakres('mtd', '2026-10-21', o).cur, ['2026-10-01', '2026-10-20']);
  assert.deepStrictEqual(m.zakres('ytd', '2026-10-21', o).cur, ['2026-01-01', '2026-10-20']);
  // pierwszy dzień miesiąca / roku: „do wczoraj” to cały poprzedni miesiąc / rok
  assert.deepStrictEqual(m.zakres('mtd', '2026-11-01', { dzis: '2026-11-01' }).cur, ['2026-10-01', '2026-10-31']);
  assert.deepStrictEqual(m.zakres('ytd', '2027-01-01', { dzis: '2027-01-01' }).cur, ['2026-01-01', '2026-12-31']);
  // dzień z przeszłości — zakresy kończą się na nim
  assert.deepStrictEqual(m.zakres('t7', '2026-10-19', o).cur, ['2026-10-13', '2026-10-19']);
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

test('dni nietypowe: przestój integracji (weekend bez ZK, poniedziałek z zaległościami)', () => {
  const liczby = new Map();
  for (let i = 0; i < 50; i++) liczby.set(m.dodajDni('2025-09-10', i), 430);    // do 29.10 — sąsiedzi z obu stron
  liczby.set('2025-10-18', 2); liczby.set('2025-10-19', 0); liczby.set('2025-10-20', 1047);
  const w = m.dniNietypowe(liczby, m.dniZakresu(['2025-10-14', '2025-10-20']));
  assert.deepStrictEqual(w.map((x) => x.dzien), ['2025-10-18', '2025-10-19', '2025-10-20']);
  assert.strictEqual(w[2].mediana, 430);
  assert.deepStrictEqual(m.dniNietypowe(new Map([['2025-10-20', 5]]), ['2025-10-20']), []);   // brak sąsiadów — nic nie twierdzimy
});

test('dni nietypowe: sezonowy wzrost (2× w miesiąc) to nie przestój; dzisiejszy niepełny dzień nie jest oceniany', () => {
  const liczby = new Map();
  for (let i = 0; i < 60; i++) liczby.set(m.dodajDni('2025-11-01', i), Math.round(400 * (1 + i / 30)));   // 400 → 1200
  assert.deepStrictEqual(m.dniNietypowe(liczby, m.dniZakresu(['2025-11-05', '2025-12-25'])), []);
  liczby.set('2025-12-20', 80);                                                                        // dziś, po południu
  assert.deepStrictEqual(m.dniNietypowe(liczby, ['2025-12-19', '2025-12-20'], { dzis: '2025-12-20' }), []);
});

// Dni bez stanu wstecz: stan na koniec dnia = stan teraz − ruchy po tym dniu (docs/analiza-sprzedazy.md).
test('przedziały bez stanu: rekonstrukcja wstecz, dzisiejsze ruchy cofnięte', () => {
  // dziś 10.10, stan teraz 5 (dziś przyszła dostawa +5), 08.10 sprzedano 2 (z 2 do 0), 06.10 dostawa +2
  const ruchy = new Map([['2026-10-10', 5], ['2026-10-08', -2], ['2026-10-06', 2]]);
  const p = m.przedzialyBezStanu({ stanTeraz: 5, ruchy, dzis: '2026-10-10', od: '2026-10-01' });
  // koniec 09.10: 0, 08.10: 0, 07.10: 2, 06.10: 2, 05.10 i wcześniej: 0
  assert.deepStrictEqual(p, [['2026-10-01', '2026-10-05'], ['2026-10-08', '2026-10-09']]);
  assert.strictEqual(m.dniBezStanuWOknie(p, '2026-10-01', '2026-10-09'), 7);
  assert.strictEqual(m.dniBezStanuWOknie(p, '2026-10-06', '2026-10-07'), 0);
  assert.strictEqual(m.dniBezStanuWOknie(p, '2026-10-04', '2026-10-08'), 3, 'przecięcie z oknem, końce włącznie');
});

test('przedziały bez stanu: stan cały czas > 0 albo cały czas 0', () => {
  assert.deepStrictEqual(m.przedzialyBezStanu({ stanTeraz: 3, ruchy: new Map(), dzis: '2026-10-10', od: '2026-10-01' }), []);
  assert.deepStrictEqual(m.przedzialyBezStanu({ stanTeraz: 0, ruchy: new Map(), dzis: '2026-10-10', od: '2026-10-01' }), [['2026-10-01', '2026-10-09']]);
  assert.strictEqual(m.dniBezStanuWOknie([], '2026-10-01', '2026-10-09'), 0);
});

test('przedziały bez stanu: ujemny stan (błąd metody) liczy się jako brak, bez obcinania wcześniejszych dni', () => {
  // dziś 10.10 stan 0; 09.10 rozchód 3 → koniec 08.10 = 3; koniec 09.10 = 0. Gdyby GT miało stan −1, dni z −1 też zero.
  const p = m.przedzialyBezStanu({ stanTeraz: -1, ruchy: new Map([['2026-10-09', -3]]), dzis: '2026-10-10', od: '2026-10-07' });
  assert.deepStrictEqual(p, [['2026-10-09', '2026-10-09']], '08.10: −1 + 3 = 2 > 0');
});

// Telefon „Live”: godzina zamówienia (decyzja usera 2026-10-24 — lista w kolejności wpływu).
test('godzina zamówienia: Allegro z UUID, reszta z pierwszego wczytania tego samego dnia', () => {
  assert.deepStrictEqual(m.godzinaZamowienia({ godz_zam: '23:52', data_zam: '2026-10-22', data_zk: '2026-10-23' }),
    { dzien: '2026-10-22', godz: '23:52', zrodlo: 'uuid' }, 'UUID wygrywa — prawdziwa godzina złożenia');
  // pierwszy w UTC: 12:41 UTC = 14:41 w Warszawie (CEST)
  assert.deepStrictEqual(m.godzinaZamowienia({ data_zam: '2026-10-23', data_zk: '2026-10-23', pierwszy: '2026-10-23 12:41:07' }),
    { dzien: '2026-10-23', godz: '14:41', zrodlo: 'wms' });
  assert.deepStrictEqual(m.godzinaZamowienia({ data_zam: '2026-10-22', data_zk: '2026-10-22', pierwszy: '2026-10-23 06:00:00' }),
    { dzien: '2026-10-22', godz: null, zrodlo: null }, 'wczytane innego dnia — godzina wczytania to nie godzina wpływu');
  assert.deepStrictEqual(m.godzinaZamowienia({ data_zam: '2026-10-21', data_fs: '2026-10-21', pierwszy: null }),
    { dzien: '2026-10-21', godz: null, zrodlo: null }, 'FS bez ZK, sprzed kolumny');
  // przejście czasu: zimą +1 h (25.10.2026 koniec CEST)
  assert.strictEqual(m.godzinaZamowienia({ data_zk: '2026-11-02', pierwszy: '2026-11-02 12:41:07' }).godz, '13:41');
});
