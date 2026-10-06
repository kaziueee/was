'use strict';

// Kalkulator cen marketplace (config/rynki) - prog darmowej wysylki na Amazon DE.
// Czyste funkcje - bez SQLite i GT.

const test = require('node:test');
const assert = require('node:assert');

const rynki = require('../config/rynki');
const { RYNKI, DOMYSLNE, wysylkaKlienta, cenaDlaTotal, policzRynek, wycenaPrzyCenie } = rynki;

const DE = RYNKI.find((r) => r.nazwa === 'Amazon DE');
const FR = RYNKI.find((r) => r.nazwa === 'Amazon FR');
const G = { ...DOMYSLNE, waga: 1 };

test('wysylka klienta DE: przy 39,99 jeszcze placi, powyzej gratis', () => {
  assert.strictEqual(wysylkaKlienta(DE, 39.99), 4.99);
  assert.strictEqual(wysylkaKlienta(DE, 40), 0);
  assert.strictEqual(wysylkaKlienta(DE, 12.5), 4.99);
});

test('rynek bez progu (FR) - wysylka zawsze ta sama', () => {
  assert.strictEqual(wysylkaKlienta(FR, 39.99), 4.99);
  assert.strictEqual(wysylkaKlienta(FR, 120), 4.99);
});

test('cenaDlaTotal: pod progiem cena = total - wysylka', () => {
  const { pb, S } = cenaDlaTotal(30.2, DE);
  assert.strictEqual(S, 4.99);
  assert.ok(Math.abs(pb - 24.99) < 1e-9);
});

test('cenaDlaTotal: nad progiem caly total w cenie (bez wysylki) - omija "dziure" 40..total', () => {
  const { pb, S } = cenaDlaTotal(50.4, DE);   // 50,4 - 4,99 = 45,41 -> powyzej progu -> wysylka gratis
  assert.strictEqual(S, 0);
  assert.ok(Math.abs(pb - 49.99) < 1e-9);
});

test('cenaDlaTotal: total tuz nad progiem z wysylka zostaje na 39,99 + wysylka', () => {
  const { pb, S } = cenaDlaTotal(44.8, DE);   // 44,8 - 4,99 = 39,81 -> 39,99 (<= prog) + 4,99
  assert.strictEqual(S, 4.99);
  assert.ok(Math.abs(pb - 39.99) < 1e-9);
});

test('policzRynek DE: drogi towar - cena wyzsza o wysylke, marza nadal >= ~20%', () => {
  const koszt = 120; // zl
  const w = policzRynek(koszt, DE, { ...G, tryb: 'marza' });
  const bezProgu = policzRynek(koszt, { ...DE, darmowaOd: undefined }, { ...G, tryb: 'marza' });
  assert.ok(w.cena > 39.99);
  assert.strictEqual(w.detal.wysKlient, 0);
  assert.ok(w.cena - bezProgu.cena > 4);           // ~ +4,99 (zaokraglenie do ,99)
  assert.ok(w.marza > 19.5);
});

test('policzRynek DE: tani towar - bez zmian wzgledem modelu bez progu', () => {
  const koszt = 30;
  const w = policzRynek(koszt, DE, { ...G, tryb: 'marza' });
  const bezProgu = policzRynek(koszt, { ...DE, darmowaOd: undefined }, { ...G, tryb: 'marza' });
  assert.strictEqual(w.cena, bezProgu.cena);
  assert.strictEqual(w.detal.wysKlient, 4.99);
});

test('wycenaPrzyCenie DE: 39,99 z wysylka daje wiekszy zysk niz 40,00 bez wysylki', () => {
  const a = wycenaPrzyCenie(100, DE, G, 39.99);
  const b = wycenaPrzyCenie(100, DE, G, 40);
  assert.ok(a.zysk > b.zysk);
  assert.strictEqual(a.detal.wysKlient, 4.99);
  assert.strictEqual(b.detal.wysKlient, 0);
});

test('zgodnosc: cena z policzRynek daje przy wycenaPrzyCenie te sama marze', () => {
  for (const koszt of [20, 60, 120, 300]) {
    const w = policzRynek(koszt, DE, { ...G, tryb: 'marza' });
    const z = wycenaPrzyCenie(koszt, DE, G, w.cena);
    assert.ok(Math.abs(w.marza - z.marza) < 1e-6, `koszt ${koszt}`);
  }
});
