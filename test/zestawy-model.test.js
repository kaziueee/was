'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ileDoZlozenia, kosztZakupu } = require('../services/zestawy-model');

test('zestaw: minimum po składnikach, ilość na zestaw dzieli w dół', () => {
  const d = new Map([[1, 10], [2, 7]]);
  assert.strictEqual(ileDoZlozenia([{ skladnik: 1, liczba: 2 }, { skladnik: 2, liczba: 1 }], d), 5);
  assert.strictEqual(ileDoZlozenia([{ skladnik: 1, liczba: 3 }, { skladnik: 2, liczba: 1 }], d), 3);
});

test('zestaw: brak składnika na stanie albo ujemna dostępność (rezerwacja > stan) = 0', () => {
  assert.strictEqual(ileDoZlozenia([{ skladnik: 1, liczba: 1 }, { skladnik: 9, liczba: 1 }], new Map([[1, 4]])), 0);
  assert.strictEqual(ileDoZlozenia([{ skladnik: 1, liczba: 1 }], new Map([[1, -2]])), 0);
});

test('zestaw: skład nieokreślony albo zerowa ilość — nie zgadujemy (null)', () => {
  assert.strictEqual(ileDoZlozenia([], new Map()), null);
  assert.strictEqual(ileDoZlozenia(null, new Map()), null);
  assert.strictEqual(ileDoZlozenia([{ skladnik: 1, liczba: 0 }], new Map([[1, 5]])), null);
});

test('zestaw: zdublowany wiersz składnika sumuje ilość, liczba z GT jako money', () => {
  const d = new Map([[1, 9]]);
  assert.strictEqual(ileDoZlozenia([{ skladnik: 1, liczba: 1 }, { skladnik: 1, liczba: 2 }], d), 3);
  assert.strictEqual(ileDoZlozenia([{ skladnik: 1, liczba: '3.0000' }], new Map([[1, 9]])), 3);
});

test('koszt zakupu: zwykły towar = średnia dostaw na stanie, bez stanu kartoteka', () => {
  // NERE6192-E6218 (2026-10-21): kartoteka 23,94 zł z FZ 2022, cały stan z dostawy po 13,73
  assert.deepStrictEqual(kosztZakupu({ rodzaj: 1, koszt: 23.94, kosztDostaw: 13.73 }), { koszt: 13.73, zrodlo: 'dostawy', kartoteka: 23.94 });
  assert.deepStrictEqual(kosztZakupu({ rodzaj: 1, koszt: 12.5, kosztDostaw: null, kosztSkladnikow: 3 }), { koszt: 12.5, zrodlo: 'kartoteka', kartoteka: 12.5 });
  assert.strictEqual(kosztZakupu({ rodzaj: 1, koszt: 12.5, kosztDostaw: 0 }).zrodlo, 'kartoteka');
});

test('koszt zakupu: zestaw = suma składników (nie średnia dostaw zmontowanego zestawu)', () => {
  assert.strictEqual(kosztZakupu({ rodzaj: 8, koszt: 8.41, kosztDostaw: 11.1, kosztSkladnikow: 2.32, skladnikow: 3, skladnikowBezCeny: 0 }).koszt, 2.32);
  const z = kosztZakupu({ rodzaj: 8, koszt: 8.41, kosztSkladnikow: 2.32, skladnikow: 3, skladnikowBezCeny: 0 });
  assert.strictEqual(z.koszt, 2.32);
  assert.strictEqual(z.zrodlo, 'skladniki');
  assert.strictEqual(z.kartoteka, 8.41);
});

test('koszt zakupu: zestaw bez składu albo ze składnikiem bez ceny — kartoteka, nie połowiczna suma', () => {
  assert.strictEqual(kosztZakupu({ rodzaj: 8, koszt: 9, kosztSkladnikow: 4, skladnikow: 2, skladnikowBezCeny: 1 }).koszt, 9);
  assert.strictEqual(kosztZakupu({ rodzaj: 8, koszt: 9, kosztSkladnikow: null, skladnikow: 0 }).zrodlo, 'kartoteka');
  assert.ok(kosztZakupu({ rodzaj: 8, koszt: 9, skladnikow: 0 }).uwaga);
});
