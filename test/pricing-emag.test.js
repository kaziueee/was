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

test('eMAG: nie mamy Buy Boxa, ale „najlepsza oferta” to my — nie gonimy własnej ceny', () => {
  // FPCNM42 15.10: nasze 209,98 = best_offer_sale_price, rank 2 — Buy Box ma oferta za 219,00
  const ob = emag.zOferty(surowa({ sale_price: 173.5372, best_offer_sale_price: 173.5372, buy_button_rank: 2, number_of_offers: 2 }));
  assert.strictEqual(ob.bbNasz, false);
  assert.strictEqual(ob.najtanszaNasza, true);
  assert.strictEqual(ob.bbCena, null);
  assert.strictEqual(ob.najtanszaInna, null);
  const d = decyzja(ob, { min: 170, max: 260 });
  assert.strictEqual(d.zmiana, false);
  assert.strictEqual(d.kod, 'przegrana_nie_cena');
  // remis co do grosza traktujemy tak samo — nie wiemy, czy Buy Box ma oferta w tej samej cenie
  assert.strictEqual(emag.zOferty(surowa({ best_offer_sale_price: 103.2975, buy_button_rank: 2 })).najtanszaNasza, true);
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

test('kolumny: Amazon zostaje pod kodem rynku, eMAG dostaje własny klucz i automat (od 2026-10-15)', () => {
  assert.strictEqual(kluczKolumny('amazon', 'DE'), 'DE');
  assert.strictEqual(kluczKolumny('emag', 'RO'), 'EMAG_RO');
  assert.ok(!kolumna('emag', 'RO').tylkoOdczyt);
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

test('eMAG: zmiana ceny — id + sale_price NETTO z 4 miejscami, dające dokładnie cenę brutto', () => {
  const z = emag.zmianaCeny(surowa({ id: 3, min_sale_price: 30.9892, max_sale_price: 568.1363 }), 433.45);
  assert.strictEqual(z.blad, undefined);
  assert.deepStrictEqual(z.body, { data: [{ id: 3, sale_price: 358.2231 }] });
  assert.strictEqual(Math.round(z.netto * 1.21 * 100) / 100, 433.45);
  for (const c of [124.99, 15.01, 1087.66, 9.9, 0.99]) {
    const n = emag.zmianaCeny(surowa({ id: 3 }), c).netto;
    assert.strictEqual(Math.round(n * 1.21 * 100) / 100, c, `brutto ${c}`);
  }
});

test('eMAG: zmiana ceny — poza zakresem min/max z eMAG albo bez id/VAT = odmowa, nic nie wysyłamy', () => {
  const o = surowa({ id: 3, min_sale_price: 30.9892, max_sale_price: 100 });
  assert.match(emag.zmianaCeny(o, 30).blad, /poniżej minimum ustawionego w eMAG \(37\.5 brutto\)/);
  assert.match(emag.zmianaCeny(o, 130).blad, /powyżej maksimum/);
  assert.match(emag.zmianaCeny(surowa({ id: 3, vat_id: 77 }), 50).blad, /VAT/);
  assert.match(emag.zmianaCeny(surowa(), 50).blad, /id/);
  assert.match(emag.zmianaCeny(o, 0).blad, /niepoprawna/);
});

test('eMAG: „Invalid price” z offer_validation_status → blokada z opisem eMAG (obiekt albo tekst JSON)', () => {
  const st = { value: 2, description: 'Invalid price', errors: 'Price seems to be too low compared to other prices' };
  assert.strictEqual(emag.doOferty(surowa({ offer_validation_status: st })).blokada,
    'Invalid price: Price seems to be too low compared to other prices');
  assert.strictEqual(emag.doOferty(surowa({ offer_validation_status: JSON.stringify(st) })).blokada.startsWith('Invalid price'), true);
  assert.strictEqual(emag.doOferty(surowa({ offer_validation_status: { value: 1, description: 'Saleable', errors: null } })).blokada, null);
  assert.strictEqual(emag.doOferty(surowa()).blokada, null);
});

test('pas eMAG: stawka prowizji oferty z eMAG nadpisuje domyślne 16% (tylko kolumna eMAG)', () => {
  const w = { koszt: 23.13, waga: 1.18, docinalny: false, genius: true };
  const zwykly = pasyZWyceny(w, { genius: true });
  const pluszak = pasyZWyceny(w, { genius: true, prowizja: 18 });
  assert.ok(pluszak.EMAG_RO.min > zwykly.EMAG_RO.min, 'wyższa prowizja = wyższe minimum');
  assert.strictEqual(pluszak.DE.min, zwykly.DE.min, 'Amazon bez zmian');
  const z16 = zwykly.EMAG_RO.ocen(89.99), z18 = pluszak.EMAG_RO.ocen(89.99);
  assert.ok(Math.abs((z16.zysk - z18.zysk) / rynki.DOMYSLNE.ron - 89.99 / 1.21 * 0.02) < 0.01);
});
