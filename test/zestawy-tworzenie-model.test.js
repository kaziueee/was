'use strict';

const test = require('node:test');
const assert = require('node:assert');

const m = require('../services/zestawy-tworzenie-model');

// Wartosci z OKITRADE 2026-11-18 (oba skladniki Psi Patrol maja identyczne pola).
const polaSpin = () => ({
  'Waga produktu': '0,2', 'Waga opakowania Tworzywa': '0,001', 'Waga opakowania Karton': '0,01',
  'Waga opakowania Zbiorcze': '0,4', 'Ilość w opakowaniu zbiorczym': '6',
});

const gtOk = () => ({
  symbolZajety: false,
  eanZajety: false,
  skladniki: new Map([
    ['SPIN20148931', { tw_Id: 93820, rodzaj: 1, usuniety: false, koszt: 15.71, grupa_id: 307, pola: polaSpin() }],
    ['SPIN20148929', { tw_Id: 93824, rodzaj: 1, usuniety: false, koszt: 25.24, grupa_id: 307, pola: polaSpin() }],
  ]),
});

const spec = () => ({
  symbol: 'SPIN20148931Z2',
  nazwa: 'Psi Patrol Rubble z buldożerem + Marshall z wozem',
  ean: '5900805605095',
  skladniki: [{ symbol: 'SPIN20148931', ilosc: 1 }, { symbol: 'SPIN20148929', ilosc: 1 }],
  ceny: [{ poziom: 3, brutto: 89.99 }, { poziom: 5, netto: 13 }],
});

test('EAN-13: cyfra kontrolna z puli firmy', () => {
  assert.ok(m.eanPoprawny('5900805605095'));
  assert.ok(m.eanPoprawny('5900805605088'));
  assert.ok(!m.eanPoprawny('5900805605096'));
  assert.ok(!m.eanPoprawny('590080560509'));
});

test('cena kartotekowa = suma kosztow skladnikow x ilosc (jak NERG1132Z4)', () => {
  assert.strictEqual(m.cenaKartotekowa([
    { koszt: 39, ilosc: 1 }, { koszt: 0.47, ilosc: 3 }, { koszt: 1.11, ilosc: 1 }, { koszt: 0.73, ilosc: 1 },
  ]), 42.25);
});

test('poprawna specyfikacja nie ma bledow', () => {
  assert.deepStrictEqual(m.sprawdzSpecyfikacje(spec(), gtOk()), []);
});

test('nazwa ponad 50 znakow, zajety symbol i EAN, zly skladnik', () => {
  const s = spec();
  s.nazwa = 'x'.repeat(51);
  s.skladniki.push({ symbol: 'BRAK', ilosc: 1 });
  const gt = gtOk();
  gt.symbolZajety = true;
  gt.eanZajety = true;
  const bledy = m.sprawdzSpecyfikacje(s, gt).join(' | ');
  for (const fragment of ['limit GT 50', 'juz istnieje', 'uzywa juz inny', 'BRAK nie istnieje']) {
    assert.ok(bledy.includes(fragment), `brak: ${fragment} w ${bledy}`);
  }
});

test('skladnik-komplet i cena z brutto i netto naraz sa odrzucane', () => {
  const gt = gtOk();
  gt.skladniki.get('SPIN20148929').rodzaj = 8;
  const s = spec();
  s.ceny = [{ poziom: 3, brutto: 1, netto: 1 }];
  const bledy = m.sprawdzSpecyfikacje(s, gt).join(' | ');
  assert.ok(bledy.includes('rodzaj 8'));
  assert.ok(bledy.includes('brutto ALBO netto'));
});

test('zadanie dla mostu: tw_Id skladnikow, koszt, grupa z pierwszego skladnika', () => {
  const z = m.zbudujZadanie(spec(), gtOk(), { podglad: true });
  assert.deepStrictEqual(z.skladniki, [{ tw_id: 93820, ilosc: 1 }, { tw_id: 93824, ilosc: 1 }]);
  assert.strictEqual(z.cena_kartotekowa, 40.95);
  assert.strictEqual(z.grupa_id, 307);
  assert.strictEqual(z.sklep_internetowy, true);
  assert.strictEqual(z.podglad, true);
});

test('zestaw Psi Patrol: wagi produktu i opakowan sumowane, op. zbiorcze puste', () => {
  const z = m.zbudujZadanie(spec(), gtOk(), { podglad: false });
  assert.deepStrictEqual(z.pola_wlasne, {
    'Waga produktu': '0,4', 'Waga opakowania Karton': '0,02',
    'Waga opakowania Tworzywa': '0,002', 'Waga opakowania Zbiorcze': '0,8',
  });
});

test('wagi: ilosc mnozy, "0" przechodzi, liczba bez przecinka (gramy?) blokuje', () => {
  const skl = [
    { symbol: 'A', ilosc: 3, pola: { 'Waga produktu': '0,132' } },
    { symbol: 'B', ilosc: 1, pola: { 'Waga produktu': '0' } },
  ];
  assert.deepStrictEqual(m.sumaWag('Waga produktu', skl, { wymagane: true }), { wartosc: '0,396', bledy: [] });
  skl[1].pola['Waga produktu'] = '916';
  assert.match(m.sumaWag('Waga produktu', skl, { wymagane: true }).bledy[0], /niejednoznaczne/);
});

test('wagi opakowan: wszystkie puste = brak pola, czesc pusta = blad', () => {
  const skl = [{ symbol: 'A', ilosc: 1, pola: {} }, { symbol: 'B', ilosc: 1, pola: {} }];
  assert.deepStrictEqual(m.sumaWag('Waga opakowania Karton', skl, { wymagane: false }), { wartosc: null, bledy: [] });
  skl[0].pola['Waga opakowania Karton'] = '0,01';
  assert.match(m.sumaWag('Waga opakowania Karton', skl, { wymagane: false }).bledy[0], /B nie ma/);
});

test('reczna waga niezgodna z suma skladnikow = blad', () => {
  const s = spec();
  s.pola_wlasne = { 'Waga produktu': '0,5', 'Wymiary': '42x22x8' };
  assert.ok(m.sprawdzSpecyfikacje(s, gtOk()).some((b) => b.includes('rozni sie od sumy')));
  s.pola_wlasne['Waga produktu'] = '0,4';
  assert.deepStrictEqual(m.sprawdzSpecyfikacje(s, gtOk()), []);
  assert.strictEqual(m.zbudujZadanie(s, gtOk(), { podglad: true }).pola_wlasne.Wymiary, '42x22x8');
});

test('baterie: oba zapisy w GT, suma po typie', () => {
  assert.deepStrictEqual(m.parsujBaterie('3 x LR44 - T'), { ile: 3, typ: 'LR44', flaga: 'T' });
  assert.deepStrictEqual(m.parsujBaterie('3; AG13; T'), { ile: 3, typ: 'AG13', flaga: 'T' });
  const furby = [
    { symbol: 'G1698', ilosc: 1, pola: { Baterie: '3 x LR44 - T' } },
    { symbol: 'G1700', ilosc: 1, pola: { Baterie: '3;LR44;T' } },
  ];
  assert.strictEqual(m.baterieZestawu(furby).wartosc, '6;LR44;T');
});

test('baterie roznego typu wymagaja recznego wpisu', () => {
  const skl = [
    { symbol: 'A', ilosc: 1, pola: { 'Waga produktu': '0,1', Baterie: '3;LR44;T' } },
    { symbol: 'B', ilosc: 2, pola: { 'Waga produktu': '0,1', Baterie: '2;AAA;N' } },
  ];
  assert.ok(m.polaZestawu(skl, {}).bledy.some((b) => b.includes('roznego rodzaju')));
  const { pola, bledy } = m.polaZestawu(skl, { Baterie: '3;LR44;T + 4;AAA;N' });
  assert.deepStrictEqual(bledy, []);
  assert.strictEqual(pola.Baterie, '3;LR44;T + 4;AAA;N');
});

test('op. zbiorcze w pliku zestawu = blad (zostaje puste)', () => {
  const s = spec();
  s.pola_wlasne = { 'Ilość w opakowaniu zbiorczym': '6' };
  assert.ok(m.sprawdzSpecyfikacje(s, gtOk()).some((b) => b.includes('zostaje puste')));
});
