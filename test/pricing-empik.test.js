'use strict';

const test = require('node:test');
const assert = require('node:assert');

const empik = require('../pricing/empik');
const { podsumujZamowienia } = require('../pricing/empik-zamowienia');
const { decyzja } = require('../pricing/model');
const { pasyZWyceny } = require('../pricing/pas');
const { kluczKolumny, kolumna } = require('../pricing/kolumny');

// Kształt z OF21 (Mirakl, pola z których korzystamy) — kwoty brutto w PLN.
const nasza = (o) => ({ offer_id: 5001, shop_sku: 'NERF5035', product_sku: '1590660825', product_title: 'Blaster', active: true,
  quantity: 7, price: 59.99, total_price: 68.98, min_shipping_price: 8.99, applicable_pricing: { price: 59.99 }, all_prices: [{ price: 59.99 }], ...o });
// Oferta z P11: nasza albo cudza.
const p11 = (shop, cena, wys, o = {}) => ({ shop_id: shop === 'Poszukiwacze Frajdy' ? 77 : 100 + cena, shop_name: shop, offer_id: 0, active: true,
  price: cena, total_price: Math.round((cena + wys) * 100) / 100, min_shipping_price: wys, ...o });
const SKLEP = { id: 77, nazwa: 'Poszukiwacze Frajdy' };

test('Empik: oferta z OF21 → wiersz ofert (SKU sklepu, numer produktu, cena brutto, stan)', () => {
  const o = empik.doOferty(nasza());
  assert.deepStrictEqual(o, { sku: 'NERF5035', produkt: '1590660825', nazwa: 'Blaster', cena: 59.99, ilosc: 7, aktywna: true });
  assert.strictEqual(empik.doOferty(nasza({ applicable_pricing: { price: 49.99 } })).cena, 49.99, 'cena, którą widzi klient (z promocją)');
  assert.strictEqual(empik.doOferty(nasza({ active: false })).aktywna, false);
  assert.strictEqual(empik.doOferty(nasza({ applicable_pricing: null, price: 0 })).cena, null, 'brak ceny ≠ 0 zł');
});

test('Empik: cena łączna = total_price, a bez niego cena + najtańsza dostawa', () => {
  assert.strictEqual(empik.cenaLaczna(nasza()), 68.98);
  assert.strictEqual(empik.cenaLaczna(nasza({ total_price: null })), 68.98);
  assert.strictEqual(empik.cenaLaczna(nasza({ total_price: null, min_shipping_price: null })), 59.99);
});

test('Empik: mamy najlepszą ofertę — Buy Box nasz, następny konkurent z dostawą', () => {
  const ob = empik.obserwacja([p11('Poszukiwacze Frajdy', 59.99, 8.99), p11('Sklep B', 64.99, 9.99), p11('Sklep C', 61, 14.99)], { sklep: SKLEP });
  assert.strictEqual(ob.bbNasz, true);
  assert.strictEqual(ob.cena, 59.99);
  assert.strictEqual(ob.wysylka, 8.99);
  assert.strictEqual(ob.bbCena, 68.98);
  assert.strictEqual(ob.najtanszaInna, 74.98, 'najtańsza cudza po cenie łącznej (B 74,98 < C 75,99)');
  assert.strictEqual(ob.ofert, 3);
  // model: podnosimy pod konkurenta (74,98 − 0,01 − 8,99 dostawy = 65,98)
  const d = decyzja(ob, { min: 50, max: 90 });
  assert.strictEqual(d.kod, 'podwyzka');
  assert.strictEqual(d.cel, 65.98);
});

test('Empik: przegrywamy — Buy Box = najlepsza cena łączna, model schodzi pod nią', () => {
  const ob = empik.obserwacja([p11('Sklep B', 57, 9.99), p11('Poszukiwacze Frajdy', 59.99, 8.99)], { sklep: SKLEP });
  assert.strictEqual(ob.bbNasz, false);
  assert.strictEqual(ob.bbCena, 66.99);
  assert.strictEqual(ob.najtanszaInna, 66.99);
  const d = decyzja(ob, { min: 40, max: 90 });
  assert.strictEqual(d.kod, 'obnizka');
  assert.strictEqual(d.cena, 57.99, '66,99 − 0,01 − 8,99 naszej dostawy');
});

test('Empik: kolejność liczymy sami (po cenie łącznej), remis zostawia kolejność Mirakl', () => {
  const ob = empik.obserwacja([p11('Poszukiwacze Frajdy', 70, 8.99), p11('Sklep B', 60, 9.99)], { sklep: SKLEP });
  assert.strictEqual(ob.bbNasz, false, 'P11 może zwrócić inną kolejność — decyduje cena łączna');
  const remis = empik.obserwacja([p11('Sklep B', 59.99, 8.99), p11('Poszukiwacze Frajdy', 59.99, 8.99)], { sklep: SKLEP });
  assert.strictEqual(remis.bbNasz, false, 'remis: wygrywa oferta, którą Mirakl dał wyżej (premium, ocena)');
});

test('Empik: naszą ofertę rozpoznajemy po offer_id, shop_id albo nazwie sklepu', () => {
  const lista = [p11('Sklep B', 55, 9.99), p11('X', 59.99, 8.99, { shop_id: null, shop_name: null, offer_id: 5001 })];
  assert.strictEqual(empik.obserwacja(lista, { offerId: 5001, sklep: SKLEP }).cena, 59.99, 'po offer_id');
  const poNazwie = [p11('Sklep B', 55, 9.99), p11(' poszukiwacze frajdy ', 59.99, 8.99, { shop_id: null })];
  assert.strictEqual(empik.obserwacja(poNazwie, { sklep: SKLEP }).cena, 59.99, 'po nazwie (bez wielkości liter i spacji)');
  assert.strictEqual(empik.obserwacja([p11('Sklep B', 55, 9.99)], { sklep: SKLEP }), null, 'nie ma nas wśród aktywnych ofert');
  assert.strictEqual(empik.obserwacja([p11('Poszukiwacze Frajdy', 59.99, 8.99, { active: false })], { sklep: SKLEP }), null);
});

test('Empik: dwie nasze oferty na produkcie bez offer_id w P11 — nie zgadujemy, która to ta', () => {
  const ob = empik.obserwacja([p11('Poszukiwacze Frajdy', 59.99, 8.99), p11('Poszukiwacze Frajdy', 61, 8.99), p11('Sklep B', 65, 9.99)], { sklep: SKLEP });
  assert.strictEqual(ob.bbNasz, null);
  assert.strictEqual(ob.cena, null);
  assert.strictEqual(decyzja(ob, { min: 40, max: 90 }).zmiana, false);
  // z offer_id wiadomo — Buy Box ma nasza druga oferta, nie konkurujemy sami ze sobą
  const z = empik.obserwacja([p11('Poszukiwacze Frajdy', 59.99, 8.99, { offer_id: 5002 }), p11('Poszukiwacze Frajdy', 61, 8.99, { offer_id: 5001 })],
    { offerId: 5001, sklep: SKLEP });
  assert.strictEqual(z.bbInnaNasza, true);
  assert.strictEqual(decyzja(z, { min: 40, max: 90 }).kod, 'bb_nasza_inna');
});

test('Empik: zmiana ceny — nie ruszamy ofert z promocją ani z kilkoma cenami (PRI01 by je skasował)', () => {
  assert.deepStrictEqual(empik.zmianaCeny(nasza(), 57.5), { sku: 'NERF5035', cena: 57.5 });
  assert.match(empik.zmianaCeny(nasza({ discount: { discount_price: 49.99 } }), 57).blad, /promocja/);
  assert.match(empik.zmianaCeny(nasza({ applicable_pricing: { price: 49.99, unit_discount_price: 49.99 } }), 57).blad, /promocja/);
  assert.match(empik.zmianaCeny(nasza({ all_prices: [{ price: 59.99 }, { price: 55, channel_code: 'X' }] }), 57).blad, /2 ceny/);
  assert.match(empik.zmianaCeny(nasza({ shop_sku: '' }), 57).blad, /SKU/);
  assert.match(empik.zmianaCeny(nasza(), 0).blad, /niepoprawna/);
});

test('Empik: plik PRI01 — średnik, cudzysłowy, kropka dziesiętna', () => {
  assert.strictEqual(empik.plikCen([{ sku: 'NERF5035', cena: 57.5 }, { sku: 'A"B', cena: 10 }]),
    '"offer-sku";"price"\n"NERF5035";"57.50"\n"A""B";"10.00"\n');
});

test('Empik: 429 — czekamy tyle, ile każe Retry-After, ale nie godzinę w środku przebiegu', () => {
  assert.strictEqual(empik.czekajMs('30', 1), 30_000);
  assert.strictEqual(empik.czekajMs(null, 2), 6_000);
  assert.strictEqual(empik.czekajMs('3600', 1), null);
});

test('Empik: link do karty produktu po numerze (z „p” albo bez)', () => {
  assert.strictEqual(empik.linkiOferty('1590660825').produkt, 'https://www.empik.com/-,p1590660825,zabawki-p');
  assert.strictEqual(empik.linkiOferty('p1590660825').produkt, 'https://www.empik.com/-,p1590660825,zabawki-p');
  assert.strictEqual(empik.linkiOferty(''), null);
  assert.strictEqual(empik.linkiOferty('ABC-1'), null);
});

test('Empik: kolumna tylko do odczytu, bez kalkulatora — repricer nie liczy pasa ani nie decyduje', () => {
  assert.strictEqual(kluczKolumny('empik', 'PL'), 'EMPIK_PL');
  const k = kolumna('empik', 'PL');
  assert.strictEqual(k.tylkoOdczyt, true);
  assert.strictEqual(k.kalkulator, undefined);
  const pasy = pasyZWyceny({ koszt: 30, waga: 1, docinalny: false });
  assert.strictEqual(pasy.EMPIK_PL, undefined);
  assert.strictEqual(decyzja({ cena: 59.99, bbNasz: false, bbCena: 50 }, {}).kod, 'brak_pasa');
});

test('Empik: pomiar z zamówień — prowizja od towaru i od całości, dostawa per metoda, bez anulowanych', () => {
  const linia = (price, shipping, fee, kat = 'Zabawki') => ({ price, shipping_price: shipping, commission_fee: fee, commission_vat: fee * 0.23, category_label: kat });
  const p = podsumujZamowienia([
    { order_state: 'SHIPPED', shipping_type_label: 'Paczkomaty InPost', order_lines: [linia(100, 11.99, 11.2)] },
    { order_state: 'RECEIVED', shipping_type_label: 'Paczkomaty InPost', order_lines: [linia(50, 0, 5)] },
    { order_state: 'CANCELED', shipping_type_label: 'KURIER', order_lines: [linia(500, 16.99, 0)] },
  ]);
  assert.strictEqual(p.razem.zamowien, 2);
  assert.strictEqual(p.razem.towar, 150);
  assert.strictEqual(p.razem['prow_%_towaru'], 10.8);
  assert.strictEqual(p.kategorie[0]['prow_%_calosci'], 10, '16,20 / (150 + 11,99)');
  assert.deepStrictEqual(p.dostawy.map((d) => [d.metoda, d.zamowien, d['gratis_%']]), [['Paczkomaty InPost', 2, 50]]);
});
