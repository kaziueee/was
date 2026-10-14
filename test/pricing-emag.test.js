'use strict';

const test = require('node:test');
const assert = require('node:assert');

const emag = require('../pricing/emag');
const { decyzja } = require('../pricing/model');
const { pasyZWyceny } = require('../pricing/pas');
const { kluczKolumny, kolumna } = require('../pricing/kolumny');
const rynki = require('../config/rynki');

// Kształt z product_offer/read (pola, z których korzystamy) — wartości jak w realnej odpowiedzi 2026-10-14.
const surowa = (o) => ({ part_number: 'NERB9837', part_number_key: 'DHWWN4BBM', name: 'Blaster', status: 1, vat_id: 9,
  sale_price: 103.2975, best_offer_sale_price: 103.2975, buy_button_rank: 1, number_of_offers: 1,
  general_stock: 12, genius_eligibility: 1, genius_eligibility_type: 2, genius_computed: 2, ...o });

test('eMAG: oferta z API → cena BRUTTO (netto × 1,21), stan, Genius z genius_computed', () => {
  const o = emag.doOferty(surowa());
  assert.strictEqual(o.sku, 'NERB9837');
  assert.strictEqual(o.pnk, 'DHWWN4BBM');
  assert.strictEqual(o.cena, 124.99);
  assert.strictEqual(o.ilosc, 12);
  assert.strictEqual(o.aktywna, true);
  assert.strictEqual(o.genius, 1);
  assert.strictEqual(emag.doOferty(surowa({ genius_eligibility_type: 3, genius_computed: 0 })).genius, 0, '1/3/0 = Genius nieaktywny');
  assert.strictEqual(emag.doOferty(surowa({ status: 0 })).aktywna, false);
  assert.strictEqual(emag.doOferty(surowa({ vat_id: 77 })).cena, null, 'nieznany VAT = nie zgadujemy ceny brutto');
});

test('eMAG: przegrywamy Buy Box — cena zwycięzcy brutto to Buy Box i najtańsza inna', () => {
  const ob = emag.zOferty(surowa({ buy_button_rank: 3, number_of_offers: 3, best_offer_sale_price: 90.23 }));
  assert.strictEqual(ob.bbNasz, false);
  assert.strictEqual(ob.bbCena, 109.18);
  assert.strictEqual(ob.najtanszaInna, 109.18);
  assert.strictEqual(ob.wysylka, 0);
  assert.strictEqual(ob.konkurencjaNieznana, false);
});

test('eMAG: mamy Buy Box i są inne oferty — konkurencja nieznana, model nie podnosi w ciemno', () => {
  const ob = emag.zOferty(surowa({ number_of_offers: 4 }));
  assert.strictEqual(ob.bbNasz, true);
  assert.strictEqual(ob.najtanszaInna, null);
  assert.strictEqual(ob.konkurencjaNieznana, true);
  const d = decyzja(ob, { min: 100, max: 180 });
  assert.strictEqual(d.zmiana, false);
  assert.strictEqual(d.kod, 'top_konk_nieznana');
  // jedyna oferta na produkcie — dawny kod bez zmian
  assert.strictEqual(decyzja(emag.zOferty(surowa()), { min: 100, max: 180 }).kod, 'top_bez_konkurencji');
});

test('eMAG: mamy Buy Box, ale ktoś jest tańszy (bez Buy Boxa) — to jedyna znana cena konkurencji', () => {
  const ob = emag.zOferty(surowa({ number_of_offers: 2, best_offer_sale_price: 95 }));
  assert.strictEqual(ob.bbNasz, true);
  assert.strictEqual(ob.najtanszaInna, 114.95);
  assert.strictEqual(ob.konkurencjaNieznana, false);
});

test('eMAG: oferta bez rangi Buy Boxa — nie wiadomo, nic nie decydujemy', () => {
  const ob = emag.zOferty(surowa({ buy_button_rank: null, number_of_offers: 2 }));
  assert.strictEqual(ob.bbNasz, null);
  assert.strictEqual(decyzja(ob, { min: 100, max: 180 }).kod, 'brak_danych');
});

test('kolumny: Amazon zostaje pod kodem rynku, eMAG dostaje własny klucz i jest tylko do odczytu', () => {
  assert.strictEqual(kluczKolumny('amazon', 'DE'), 'DE');
  assert.strictEqual(kluczKolumny('emag', 'RO'), 'EMAG_RO');
  assert.strictEqual(kolumna('emag', 'RO').tylkoOdczyt, true);
  assert.strictEqual(kolumna('emag', 'RO').waluta, 'RON');
  assert.ok(!kolumna('amazon', 'DE').tylkoOdczyt);
});

test('pas eMAG RO: Genius z oferty (API) wygrywa z wymiarami z GT', () => {
  const w = { koszt: 20, waga: 1, docinalny: false, genius: true };   // wymiary mówią: mieści się w automacie
  const zGenius = pasyZWyceny(w).EMAG_RO;
  const bezGenius = pasyZWyceny(w, { genius: false }).EMAG_RO;
  const def = rynki.RYNKI.find((r) => r.nazwa === 'eMAG RO');
  assert.strictEqual(zGenius.min, rynki.policzRynek(20, def, { ...rynki.DOMYSLNE, waga: 1, genius: true }).cena);
  assert.strictEqual(bezGenius.min, rynki.policzRynek(20, def, { ...rynki.DOMYSLNE, waga: 1, genius: false }).cena);
  assert.notStrictEqual(zGenius.min, bezGenius.min);
  // Amazon bez zmian: klucz = kod rynku
  assert.ok(pasyZWyceny(w).DE.min > 0);
  assert.strictEqual(pasyZWyceny(w).PL, undefined, 'Amazon PL nie ma rynku w kalkulatorze');
});
