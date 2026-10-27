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

test('eMAG: mamy Buy Box i są inne oferty — konkurencja nieznana, szukamy jej ceny krokiem +3%', () => {
  const ob = emag.zOferty(surowa({ number_of_offers: 4 }));
  assert.strictEqual(ob.bbNasz, true);
  assert.strictEqual(ob.najtanszaInna, null);
  assert.strictEqual(ob.konkurencjaNieznana, true);
  const d = decyzja(ob, { min: 100, max: 180 });
  assert.strictEqual(d.zmiana, true);
  assert.strictEqual(d.kod, 'sonda');
  assert.strictEqual(d.cena, 128.74);                 // 124,99 × 1,03
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
  // Amazon PL (kalkulator od 2026-10-22): Genius eMAG go nie dotyczy
  assert.strictEqual(pasyZWyceny(w).PL.min, pasyZWyceny(w, { genius: false }).PL.min);
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

test('eMAG: oferta włączona, której eMAG nie sprzedaje → nieaktywna, ale wstrzymana (Invalid price / Blocked / Draft)', () => {
  const zatwierdzony = [{ value: 9, description: 'Approved documentation', errors: null }];
  const invalid = emag.doOferty(surowa({ offer_validation_status: { value: 2, description: 'Invalid price', errors: 'Offer was rejected based on price criteria' },
    validation_status: zatwierdzony }));
  assert.deepStrictEqual([invalid.aktywna, invalid.wstrzymana], [false, true]);
  assert.strictEqual(invalid.walidacja, 'oferta 2 Invalid price · produkt 9 Approved documentation');

  const blocked = emag.doOferty(surowa({ offer_validation_status: { value: 1, description: 'Saleable' }, validation_status: [{ value: 10, description: 'Blocked' }] }));
  assert.deepStrictEqual([blocked.aktywna, blocked.wstrzymana, blocked.blokada.startsWith('Blocked')], [false, true, true]);
  const draft = emag.doOferty(surowa({ validation_status: JSON.stringify([{ value: 0, description: 'Draft' }]) }));
  assert.deepStrictEqual([draft.aktywna, draft.wstrzymana, draft.blokada.startsWith('Draft')], [false, true, true]);

  // EAN w weryfikacji obok zatwierdzonej dokumentacji — sprzedaje się, nie wstrzymujemy
  const ean = emag.doOferty(surowa({ offer_validation_status: { value: 1, description: 'Saleable' },
    validation_status: [...zatwierdzony, { value: 3, description: 'EAN validation pending' }] }));
  assert.deepStrictEqual([ean.aktywna, ean.wstrzymana, ean.blokada], [true, false, null]);
  assert.strictEqual(ean.walidacja, 'oferta 1 Saleable · produkt 9 Approved documentation / 3 EAN validation pending');

  // status 0 (wyłączona, stan 0) z „Invalid price” — zwykła nieaktywna, nie wstrzymana
  const wyl = emag.doOferty(surowa({ status: 0, offer_validation_status: { value: 2, description: 'Invalid price' } }));
  assert.deepStrictEqual([wyl.aktywna, wyl.wstrzymana], [false, false]);
  assert.strictEqual(emag.doOferty(surowa()).walidacja, null, 'brak pól walidacji = brak opisu');
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

test('eMAG HU/BG: cena brutto z VAT danego rynku, linki na właściwą domenę, automat z regułami w walucie rynku', () => {
  const hu = emag.doOferty(surowa({ _kraj: 'HU', vat_id: 1, sale_price: 7164.7146 }));
  assert.strictEqual(hu.cena, 9099.19);                                   // × 1,27
  const bg = emag.zOferty(surowa({ _kraj: 'BG', vat_id: 6, sale_price: 19.5232, best_offer_sale_price: 19.5232 }));
  assert.strictEqual(bg.cena, 23.43);                                     // × 1,20
  assert.strictEqual(emag.doOferty(surowa({ _kraj: 'HU', vat_id: 9 })).cena, null, 'vat_id z RO nie istnieje na HU');
  assert.strictEqual(emag.linkiOferty('D1', 'HU').produkt, 'https://www.emag.hu/-/pd/D1/');
  assert.strictEqual(kolumna('emag', 'HU').waluta, 'Ft');
  assert.ok(!kolumna('emag', 'BG').tylkoOdczyt && !kolumna('emag', 'HU').tylkoOdczyt, 'automat na HU i BG od 2026-10-15');
  // HU: krok w forintach — 1 Ft pod zwycięzcę, nie 0,01 Ft (niewidoczne na stronie)
  const dHu = decyzja({ cena: 9800, wysylka: 0, bbNasz: false, bbCena: 9500 }, { min: 8000, max: 12000 }, kolumna('emag', 'HU').reguly);
  assert.strictEqual(dHu.cena, 9499);
  assert.strictEqual(kolumna('emag', 'BG').reguly, undefined, 'BG w euro — reguły domyślne');
  // zapis ceny liczy netto z VAT rynku oferty
  const z = emag.zmianaCeny(surowa({ id: 7, _kraj: 'BG', vat_id: 6 }), 23.99);
  assert.strictEqual(Math.round(z.netto * 1.2 * 100) / 100, 23.99);
});

test('pas eMAG: stawka i Genius per kolumna (RO 16%, HU 18%) — ten sam towar, różne minimum', () => {
  const w = { koszt: 23.13, waga: 1.18, docinalny: false, genius: true };
  const p = pasyZWyceny(w, { genius: { EMAG_RO: true, EMAG_HU: false }, prowizja: { EMAG_RO: 16, EMAG_HU: 21 } });
  const p18 = pasyZWyceny(w, { genius: { EMAG_RO: true, EMAG_HU: false }, prowizja: { EMAG_RO: 16, EMAG_HU: 18 } });
  assert.ok(p.EMAG_HU && p.EMAG_BG && p.EMAG_RO);
  assert.ok(p.EMAG_HU.min > p18.EMAG_HU.min, 'wyższa stawka na HU = wyższe minimum na HU');
  assert.strictEqual(p.EMAG_RO.min, p18.EMAG_RO.min, 'RO bez zmian');
});
