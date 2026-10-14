'use strict';

const test = require('node:test');
const assert = require('node:assert');

const rynki = require('../config/rynki');

const g = { ...rynki.DOMYSLNE, waga: 1 };
const rynek = (n) => rynki.RYNKI.find((r) => r.nazwa === n);

test('eMAG RO jest w kalkulatorze z realnymi stawkami (VAT 21%, prowizja 16% + Genius osobno, Paxy w EUR)', () => {
  const r = rynek('eMAG RO');
  assert.ok(r, 'brak eMAG RO w RYNKI');
  assert.strictEqual(r.waluta, 'RON');
  assert.strictEqual(r.vat, 21);
  assert.strictEqual(r.prowizja, 16);
  assert.strictEqual(r.oplataZam, 'GENIUS_RO');
  assert.strictEqual(r.typ, 'flat');
});

test('Genius eMAG RO: stała opłata za zamówienie wg progu ceny brutto (siatka od 01.01.2026)', () => {
  const r = rynek('eMAG RO');
  assert.strictEqual(rynki.oplataZamowienia(r, 39.99), 3);
  assert.strictEqual(rynki.oplataZamowienia(r, 40), 4);
  assert.strictEqual(rynki.oplataZamowienia(r, 49.99), 4);
  assert.strictEqual(rynki.oplataZamowienia(r, 74.99), 5);
  assert.strictEqual(rynki.oplataZamowienia(r, 75), 8);
  assert.strictEqual(rynki.oplataZamowienia(r, 500), 8);
  // rynek bez opłaty za zamówienie
  assert.strictEqual(rynki.oplataZamowienia({}, 100), 0);
});

test('Genius obniża zysk o pełną opłatę z progu, w jakim wylądowała cena', () => {
  const r = rynek('eMAG RO');
  const bez = { ...r, oplataZam: undefined };
  for (const cena of [39.99, 69.99, 139.99]) {
    const a = rynki.wycenaPrzyCenie(60, r, g, cena), b = rynki.wycenaPrzyCenie(60, bez, g, cena);
    const roznicaRon = (b.zysk - a.zysk) / g.ron;
    assert.ok(Math.abs(roznicaRon - rynki.oplataZamowienia(r, cena)) < 1e-9, `${cena}: ${roznicaRon}`);
    assert.strictEqual(a.detal.oplataZam, rynki.oplataZamowienia(r, cena));
  }
});

test('Genius: cena z kalkulatora nie wisi tuż pod progiem z opłatą policzoną z niższego progu', () => {
  // Cena celuje w marżę z opłatą z progu, w którym faktycznie wylądowała (iteracja jak dopłata Smart).
  const r = rynek('eMAG RO');
  for (let koszt = 5; koszt <= 40; koszt += 0.5) {
    const w = rynki.policzRynek(koszt, r, g);
    assert.strictEqual(w.detal.oplataZam, rynki.oplataZamowienia(r, w.cena), `koszt ${koszt}`);
    assert.ok(w.zysk >= g.minzysk - 0.6, `koszt ${koszt}: zysk ${w.zysk}`);  // ,99 do najbliższej: −0,5 RON
  }
});

test('wysyłka w EUR przeliczana na walutę rynku przez kurs EUR i kurs rynku', () => {
  const r = rynek('eMAG RO');
  const kurs = rynki.kursDla('RON', g);
  assert.ok(Math.abs(rynki.kosztWysylkiFlat(r, g, kurs) - 2.24 * g.eur / g.ron) < 1e-9);
  // rynek z `wysylka` w swojej walucie — bez przeliczania
  assert.strictEqual(rynki.kosztWysylkiFlat({ wysylka: 12 }, g, kurs), 12);
});

test('eMAG RO: cena z kalkulatora daje marżę ~20% (zaokrąglenie do ,99 tylko w górę o grosze)', () => {
  const w = rynki.policzRynek(60, rynek('eMAG RO'), g);   // koszt zakupu 60 zł netto
  assert.strictEqual(w.waluta, 'RON');
  assert.ok(/\.99$/.test(w.cena.toFixed(2)), w.cena);
  assert.ok(w.marza >= 19 && w.marza <= 22, `marża ${w.marza}`);
  assert.ok(w.zysk > 0);
});

// Zgodność dwóch dróg liczenia: koszt → cena (policzRynek) i cena → zysk (wycenaPrzyCenie) muszą
// dawać ten sam zysk przy tej samej cenie. Repricer liczy zysk drugą drogą, Cennik pierwszą —
// rozjazd oznaczałby, że ekran Ceny i zakładka Cennik mówią co innego o tym samym towarze.
test('zgodność policzRynek ↔ wycenaPrzyCenie na każdym rynku', () => {
  for (const r of rynki.RYNKI) {
    for (const koszt of [15, 60, 240]) {
      const a = rynki.policzRynek(koszt, r, g);
      if (a.blad) continue;
      const b = rynki.wycenaPrzyCenie(koszt, r, g, a.cena);
      assert.ok(Math.abs(a.zysk - b.zysk) < 0.01, `${r.nazwa} koszt ${koszt}: ${a.zysk} vs ${b.zysk}`);
      assert.ok(Math.abs(a.marza - b.marza) < 0.01, `${r.nazwa} koszt ${koszt}: marża ${a.marza} vs ${b.marza}`);
    }
  }
});
