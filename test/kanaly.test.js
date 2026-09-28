'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { kanalZK } = require('../services/kanaly');

// Sedno: Amazon DE/FR wchodzi do GT dwiema droganami, a tylko jedna widac po zrodle.
// Wersja BaseLinkera podpisuje sie "marketplace", platforme trzyma w uwagach BEZ
// nawiasow ("Amazon_DE"), a kanal nazywa wprost w metodzie dostawy.
test('Amazon DE przez BaseLinkera (zrodlo "marketplace") -> DHL Connect', () => {
  assert.strictEqual(kanalZK({
    zrodlo: 'marketplace', dostawa: 'DHL DE Connect', oryg: '1724',
    uwagi: 'Zamówienie: 1724;Amazon_DE;028-6330583-6005910;;Hufnagel Con',
  }), 'DHL Connect');
});

test('Amazon FR ta sama droga -> DHL Connect', () => {
  assert.strictEqual(kanalZK({
    zrodlo: 'marketplace', dostawa: 'DHL DE Connect', oryg: '1266',
    uwagi: 'Zamówienie: 1266;Amazon_FR;406-4107786-7509931;;Françoise Barral',
  }), 'DHL Connect');
});

// Wiekszosc ZK z tej integracji nie ma w uwagach ZADNEGO tagu platformy - zostaje
// sama metoda dostawy. Na produkcji to 1059 z 1606 ZK (120 dni), wiec reguła oparta
// wylacznie na platformie zostawialaby je w "nieklasyfikowane".
test('marketplace bez tagu platformy w uwagach -> nadal DHL Connect (decyduje dostawa)', () => {
  assert.strictEqual(kanalZK({
    zrodlo: 'marketplace', dostawa: 'DHL DE Connect', oryg: '1717',
    uwagi: 'Zamówienie: 1717;[marketplace];MHRLYR5;;Esra Uysal',
  }), 'DHL Connect');
});

test('wariant nazwy uslugi ("DHL Connect", "DHL FR Connect") znaczy to samo', () => {
  for (const dostawa of ['DHL Connect', 'DHL FR Connect', 'dhl de connect']) {
    assert.strictEqual(kanalZK({ zrodlo: 'marketplace', dostawa }), 'DHL Connect', dostawa);
  }
});

test('natywne IDEA (puste pola wlasne, oryg "Am###..._IDEA") -> DHL Connect', () => {
  assert.strictEqual(kanalZK({
    zrodlo: null, dostawa: null, oryg: 'Am303-5677033-0396367-1_IDEA', uwagi: 'Szybka płatność',
  }), 'DHL Connect');
});

test('Kaufland kazda sciezka -> DHL Connect', () => {
  assert.strictEqual(kanalZK({ oryg: 'Kaufland_123_IDEA' }), 'DHL Connect');
  assert.strictEqual(kanalZK({ zrodlo: 'Kaufland.de', dostawa: 'brak' }), 'DHL Connect');
  assert.strictEqual(kanalZK({ uwagi: 'zam [kaufland] 998' }), 'DHL Connect');
});

// Wyjatek zweryfikowany na zywej bazie: Amazon PL jedzie InPostem, nie DHL Connect.
test('Amazon PL ("std-ez-pl") zostaje InPostem', () => {
  assert.strictEqual(kanalZK({ zrodlo: 'Amazon.de', dostawa: 'std-ez-pl' }), 'InPost');
});

test('kurier wg slownika metody dostawy', () => {
  assert.strictEqual(kanalZK({ zrodlo: 'Allegro - ekajtek_pl', dostawa: 'Allegro Paczkomaty24/7 InPost' }), 'InPost');
  assert.strictEqual(kanalZK({ zrodlo: 'Empik', dostawa: 'KURIER' }), 'DPD');
  assert.strictEqual(kanalZK({ zrodlo: 'Emag Rumunia', dostawa: 'courier cod' }), 'Emag');
});

test('rezerwacje reczne (puste pola, opis w oryg) zostaja nieklasyfikowane', () => {
  assert.strictEqual(kanalZK({ oryg: 'BRAKI INWENTARYZACYJNE' }), 'nieklasyfikowane');
  assert.strictEqual(kanalZK({}), 'nieklasyfikowane');
});
