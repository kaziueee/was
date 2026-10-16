'use strict';

const test = require('node:test');
const assert = require('node:assert');
const g = require('../pricing/granice');
const { decyzja } = require('../pricing/model');

// Pas z kalkulatora jak z pricing/pas.js: min, max = min × 1,5, ocen liniowa (koszt 10, zysk = cena − 10).
const kalk = (min = 20) => ({ min, max: +(min * 1.5).toFixed(2), ocen: (c) => ({ zysk: +(c - 10).toFixed(2), marza: +(((c - 10) / c) * 100).toFixed(1) }) });

test('walidujCene: przecinek, zaokrąglenie, zero i śmieci', () => {
  assert.deepStrictEqual(g.walidujCene('19,999'), { cena: 20 });
  assert.deepStrictEqual(g.walidujCene(' 7 114,99 '), { cena: 7114.99 });   // forinty ze spacją tysięcy
  assert.ok(g.walidujCene('0').blad);
  assert.ok(g.walidujCene('-5').blad);
  assert.ok(g.walidujCene('abc').blad);
  assert.ok(g.walidujCene('').blad);
});

test('walidujGranice: puste = kalkulator, min > 0, max ≥ min', () => {
  assert.deepStrictEqual(g.walidujGranice('', null, kalk()), { min: null, max: null });
  assert.deepStrictEqual(g.walidujGranice('18,5', '40', kalk()), { min: 18.5, max: 40 });
  assert.match(g.walidujGranice('0', '', kalk()).blad, /minimum/);
  assert.match(g.walidujGranice('', '-1', kalk()).blad, /maksimum/);
  assert.match(g.walidujGranice('30', '25', kalk()).blad, /poniżej minimum 30,00/);
  assert.match(g.walidujGranice('x', '', kalk()).blad, /niepoprawne minimum/);
});

test('walidujGranice: samo max sprawdzane względem minimum z kalkulatora', () => {
  assert.deepStrictEqual(g.walidujGranice('', '25', kalk(20)), { min: null, max: 25 });
  assert.match(g.walidujGranice('', '15', kalk(20)).blad, /poniżej minimum z kalkulatora \(20,00\)/);
  // rynek bez kalkulatora albo padnięte GT — samo max nie daje pasa
  assert.match(g.walidujGranice('', '15', null).blad, /podaj też minimum/);
});

test('zGranicami: bez ręcznych = kalkulator', () => {
  const p = g.zGranicami(kalk(20), {});
  assert.strictEqual(p.min, 20);
  assert.strictEqual(p.max, 30);
  assert.strictEqual(p.zrodlo_min, 'kalkulator');
  assert.strictEqual(p.zrodlo_max, 'kalkulator');
  assert.deepStrictEqual(p.ocen(25), { zysk: 15, marza: 60 });
  assert.strictEqual(g.zGranicami(null, {}), null);
});

test('zGranicami: ręczne min niżej niż kalkulator nie ścina max (miejsca na podwyżki)', () => {
  const p = g.zGranicami(kalk(20), { min_reczne: 15 });
  assert.strictEqual(p.min, 15);
  assert.strictEqual(p.max, 30);           // max(30, 15 × 1,5 = 22,5)
  assert.strictEqual(p.zrodlo_min, 'reczne');
  assert.strictEqual(p.zrodlo_max, 'kalkulator');
  assert.strictEqual(p.kalk_min, 20);
});

test('zGranicami: ręczne min nad dawnym max podnosi max do min × 1,5', () => {
  const p = g.zGranicami(kalk(20), { min_reczne: 40 });
  assert.strictEqual(p.min, 40);
  assert.strictEqual(p.max, 60);
  assert.strictEqual(p.zrodlo_max, 'z_min');
  assert.strictEqual(p.blad, undefined);
});

test('zGranicami: ręczne max wygrywa; sprzeczne z minimum kalkulatora = blad', () => {
  assert.strictEqual(g.zGranicami(kalk(20), { max_reczne: 26 }).max, 26);
  assert.strictEqual(g.zGranicami(kalk(20), { min_reczne: 18, max_reczne: 21 }).zrodlo_max, 'reczne');
  // koszt urósł po zapisie granic: kalkulator daje min 30, a ręczne max zostało 26
  const p = g.zGranicami(kalk(30), { max_reczne: 26 });
  assert.match(p.blad, /maksimum 26,00 poniżej minimum 30,00 z kalkulatora/);
});

test('zGranicami: ręczne min daje pas tam, gdzie kalkulator nie zna rynku (bez wyceny)', () => {
  const p = g.zGranicami(null, { min_reczne: 49.99 });
  assert.strictEqual(p.min, 49.99);
  assert.strictEqual(p.max, 74.99);
  assert.strictEqual(p.ocen(60), null);
  assert.strictEqual(g.zGranicami(null, { max_reczne: 80 }), null);   // samo max bez minimum = brak pasa
});

test('model: automat bierze ręczne granice — ręczne min to podłoga, sprzeczne granice = stoi', () => {
  const obs = { cena: 18, wysylka: 0, bbNasz: false, bbCena: 16, bbFba: false, najtanszaInna: 16, ofert: 3 };
  // z kalkulatora (min 20): cena pod minimum → od razu na minimum
  assert.strictEqual(decyzja(obs, g.zGranicami(kalk(20), {})).cena, 20);
  // ręczne min 15: schodzimy do Buy Boxa minus krok (pierwszy schodek −5%)
  const d = decyzja(obs, g.zGranicami(kalk(20), { min_reczne: 15 }));
  assert.strictEqual(d.kod, 'obnizka_limit');
  assert.strictEqual(d.cel, 15.99);
  const sprz = decyzja(obs, g.zGranicami(kalk(30), { max_reczne: 26 }) || {});
  assert.strictEqual(sprz.kod, 'brak_pasa');
  assert.strictEqual(sprz.zmiana, false);
});

test('ocenCene: w pasie bez ostrzeżeń, zysk i marża przy wpisanej cenie', () => {
  const r = g.ocenCene(25, { teraz: 24, pas: g.zGranicami(kalk(20), {}) });
  assert.deepStrictEqual(r.ostrzezenia, []);
  assert.strictEqual(r.zysk, 15);
  assert.strictEqual(r.marza, 60);
});

test('ocenCene: pod minimum, strata, nad max, skok — każde do potwierdzenia', () => {
  const pas = g.zGranicami(kalk(20), {});
  assert.deepStrictEqual(g.ocenCene(9, { teraz: 21, pas }).ostrzezenia.map((x) => x.kod), ['pod_min', 'strata', 'skok']);
  assert.deepStrictEqual(g.ocenCene(31, { teraz: 29, pas }).ostrzezenia.map((x) => x.kod), ['nad_max']);
  assert.deepStrictEqual(g.ocenCene(19.5, { teraz: 21, pas }).ostrzezenia.map((x) => x.kod), ['pod_min']);
  // literówka: 1999 zamiast 19,99
  assert.ok(g.ocenCene(1999, { teraz: 19.99, pas: g.zGranicami(kalk(20), { max_reczne: 5000 }) }).ostrzezenia.some((x) => x.kod === 'skok'));
  // ręczne minimum podpisane jako ręczne
  assert.match(g.ocenCene(14, { pas: g.zGranicami(kalk(20), { min_reczne: 15 }) }).ostrzezenia[0].tekst, /ręczne/);
});

test('ocenCene: brak pasa, brak wyceny, padnięte GT, niepewne dopasowanie', () => {
  assert.deepStrictEqual(g.ocenCene(25, { pas: null }).ostrzezenia.map((x) => x.kod), ['brak_pasa']);
  assert.deepStrictEqual(g.ocenCene(55, { pas: g.zGranicami(null, { min_reczne: 49.99 }) }).ostrzezenia.map((x) => x.kod), ['brak_wyceny']);
  assert.deepStrictEqual(g.ocenCene(25, { pas: null, gtOk: false }).ostrzezenia.map((x) => x.kod), ['brak_gt']);
  assert.strictEqual(g.ocenCene(25, { pas: g.zGranicami(kalk(20), {}), niepewneDopasowanie: true }).ostrzezenia[0].kod, 'dopasowanie');
});

test('ocenGranice: ręczne min pod kalkulatorem = marża poniżej progu, pod kosztem = strata', () => {
  assert.deepStrictEqual(g.ocenGranice({ min: null }, kalk(20)), []);
  assert.deepStrictEqual(g.ocenGranice({ min: 22 }, kalk(20)), []);
  assert.strictEqual(g.ocenGranice({ min: 15 }, kalk(20))[0].kod, 'marza');
  assert.match(g.ocenGranice({ min: 15 }, kalk(20))[0].tekst, /marża przy minimum 33,3%/);
  assert.strictEqual(g.ocenGranice({ min: 8 }, kalk(20))[0].kod, 'strata');
  assert.strictEqual(g.ocenGranice({ min: 15 }, null)[0].kod, 'brak_wyceny');
  assert.strictEqual(g.ocenGranice({ min: 15 }, null, { gtOk: false })[0].kod, 'brak_gt');
});
