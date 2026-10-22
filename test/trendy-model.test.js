'use strict';

// Oznaczenia na karcie produktu w Trendach (public/shared/trendy-model.js) — bez GT, bez bazy.
const { test } = require('node:test');
const assert = require('node:assert');
const { oznaczenia, filtruj } = require('../public/shared/trendy-model');

const wiersz = (nad = {}) => ({ id: 1, dost: 40, dni: 60, dp: 10, a: { s: 20, n: 1000, z: 200 }, b: { s: 18, n: 900, z: 180 }, prev: { s: 18, n: 900 }, ...nad });
const oferta = (nad = {}) => ({ id: 7, kanal_nazwa: 'Amazon DE', ilosc: 10, auto: 1, tylko_odczyt: false, bez_konkurencji: false,
  cena: 20, zysk: 4, bb_nasz: 1, bb_cena: 20, bb_nasza_inna: 0, blokada: null, granice: { min: 15 }, ...nad });
const kody = (lista) => lista.map((x) => x.kod);

test('kończy się: mało dni zapasu i sprzedaż nie spada', () => {
  const o = oznaczenia(wiersz({ dost: 6, dni: 9 }), [oferta(), oferta({ id: 8, tylko_odczyt: true, kanal_nazwa: 'Empik' })]);
  const k = o.find((x) => x.kod === 'konczy');
  assert.ok(k);
  assert.equal(k.waga, 'uwaga');
  assert.match(k.tekst, /~9 dni/);
  assert.deepStrictEqual(k.oferty, [7], 'kanał tylko do odczytu nie jest do podniesienia');
  assert.equal(k.produkt, true, 'oznaczenie całego towaru — ekran nie podświetla nim wierszy');
  assert.equal(oznaczenia(wiersz(), [oferta({ cena: 12 })]).find((x) => x.kod === 'pod_min').produkt, false);
});

test('kończy się — nie, gdy sprzedaż spada, stanu brak albo zapasu dużo', () => {
  assert.ok(!kody(oznaczenia(wiersz({ dost: 6, dni: 9, a: { s: 5, n: 100, z: 10 } }), [oferta()])).includes('konczy'));
  assert.ok(!kody(oznaczenia(wiersz({ dost: 0, dni: 0 }), [oferta()])).includes('konczy'));
  assert.ok(!kody(oznaczenia(wiersz({ dost: 40, dni: 14 }), [oferta()])).includes('konczy'), '14 dni to już nie „kończy się”');
  assert.ok(!kody(oznaczenia(wiersz({ dni: null }), [oferta()])).includes('konczy'), 'bez tempa nie zgadujemy');
});

test('zalega: dużo zapasu i wyraźny spadek', () => {
  assert.ok(kody(oznaczenia(wiersz({ dni: 200, dp: -45 }), [])).includes('zalega'));
  assert.ok(!kody(oznaczenia(wiersz({ dni: 200, dp: -10 }), [])).includes('zalega'));
  assert.ok(!kody(oznaczenia(wiersz({ dni: 200, dp: null }), [])).includes('zalega'), 'bez porównania nie ma spadku');
});

test('pod minimum, strata, Buy Box obcy, automat wyłączony — tylko oferty ze stanem', () => {
  const of = [
    oferta({ id: 1, cena: 12, granice: { min: 15 } }),                        // pod minimum
    oferta({ id: 2, kanal_nazwa: 'eMAG RO', zysk: -2.1 }),                    // strata
    oferta({ id: 3, kanal_nazwa: 'Amazon FR', bb_nasz: 0, bb_cena: 18.5 }),  // BB obcy
    oferta({ id: 4, kanal_nazwa: 'Kaufland DE', auto: 0 }),                   // ręczny
    oferta({ id: 5, kanal_nazwa: 'Amazon IT', ilosc: 0, auto: 0, zysk: -5, cena: 1 }),   // bez stanu — nic
  ];
  const o = oznaczenia(wiersz(), of);
  const po = (kod) => o.find((x) => x.kod === kod)?.oferty;
  assert.deepStrictEqual(po('pod_min'), [1]);
  assert.deepStrictEqual(po('strata'), [2]);
  assert.match(o.find((x) => x.kod === 'strata').tekst, /eMAG RO -2,10 zł/);
  assert.deepStrictEqual(po('bb_inny'), [3]);
  assert.deepStrictEqual(po('auto_wyl'), [4]);
});

test('Buy Box: nasza druga oferta i kanał bez danych o konkurencji to nie „ktoś inny”', () => {
  const o = oznaczenia(wiersz(), [
    oferta({ id: 1, bb_nasz: 0, bb_nasza_inna: 1, bb_cena: 19 }),
    oferta({ id: 2, bb_nasz: 0, bez_konkurencji: true, bb_cena: 19 }),
    oferta({ id: 3, bb_nasz: 0, bb_cena: null }),
    oferta({ id: 4, bb_nasz: 0, bb_cena: 19, cena: null }),                  // jeszcze nieobserwowana
  ]);
  assert.ok(!kody(o).includes('bb_inny'));
});

test('kanał tylko do odczytu nie dostaje „automat wyłączony”', () => {
  assert.ok(!kody(oznaczenia(wiersz(), [oferta({ auto: 0, tylko_odczyt: true })])).includes('auto_wyl'));
});

test('blokada platformy — także bez stanu', () => {
  const o = oznaczenia(wiersz(), [oferta({ ilosc: 0, blokada: 'Invalid price: too low' })]);
  assert.deepStrictEqual(o.find((x) => x.kod === 'blokada')?.oferty, [7]);
});

test('model działa poza przeglądarką — filtry też', () => {
  const lista = [wiersz({ id: 1 }), wiersz({ id: 2, a: { s: 0, n: 0, z: 0 } })];
  assert.deepStrictEqual(filtruj(lista, 'wszystkie', { prog: 30, baza: 1 }).map((w) => w.id), [1]);
});
