'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { magazynyRuchu } = require('../services/ruchy-model');

const lista = (opcje) => [...magazynyRuchu(opcje)].sort();

test('MM miedzy lokalizacjami - oba magazyny', () => {
  assert.deepStrictEqual(lista({ magZrodlo: 'K4G', magCel: 'K4' }), ['K4', 'K4G']);
});

test('LOK bez zrodla - sam magazyn celu', () => {
  assert.deepStrictEqual(lista({ magCel: 'K4' }), ['K4']);
});

test('rozlozenie MM z puli K4 na K4G - pula K4 tez sie liczy (MATJFG56-JCR38)', () => {
  // Bez tego tw_Pole1 nie bylo przeliczane po tym, jak rozlozenie domknelo deficyt K4.
  assert.deepStrictEqual(
    lista({ magCel: 'K4G', magPula: 'K4', wmsZnaPule: true }),
    ['K4', 'K4G']
  );
});

test('pula bez wiersza WMS nie wchodzi - pusty tekst skasowalby adres istniejacy tylko w GT', () => {
  assert.deepStrictEqual(lista({ magCel: 'K4G', magPula: 'K4', wmsZnaPule: false }), ['K4G']);
});

test('pula normalizowana do wielkich liter (nie dubluje magazynu celu)', () => {
  assert.deepStrictEqual(lista({ magCel: 'K4', magPula: 'k4 ', wmsZnaPule: true }), ['K4']);
});

test('magazyn zewnetrzny/brak danych - pusty zbior (sync lokalizacji pomijany)', () => {
  assert.deepStrictEqual(lista({}), []);
  assert.deepStrictEqual(lista({ magZrodlo: null, magCel: null, magPula: null }), []);
});
