'use strict';

const test = require('node:test');
const assert = require('node:assert');

const kaufland = require('../pricing/kaufland');
const { decyzja } = require('../pricing/model');
const { kluczKolumny, kolumna } = require('../pricing/kolumny');
const { pasyZWyceny } = require('../pricing/pas');

// Kształt GET /units (pola, z których korzystamy) — wg specyfikacji swagger.json z 2026-10-16.
const unit = (o) => ({ id_unit: 501, id_offer: 'NERF7376', id_product: 362524873, status: 'AVAILABLE', is_live: true,
  listing_price: 4499, price: 4499, minimum_price: null, shipping_rate: 499, amount: 7, storefront: 'de', _rynek: 'DE',
  product: { id_product: 362524873, title: 'Nerf Blaster', eans: ['5010993000000'], url: 'https://www.kaufland.de/product/362524873/' }, ...o });
// Wpis rankingu GET /buybox: cena TOWARU i wysyłka osobno, w centach; id_unit/id_offer tylko przy naszych.
const my = (o) => ({ buybox_rank: 1, seller: 'Okitrade', price: 4499, shipping_rate: 499, fulfillment_type: 'fulfilled_by_merchant',
  condition: 'NEW', id_unit: 501, id_offer: 'NERF7376', ...o });
const obcy = (o) => ({ buybox_rank: 2, seller: 'Spielwaren GmbH', price: 4699, shipping_rate: 0, fulfillment_type: 'fulfilled_by_merchant', condition: 'NEW', ...o });
const ranking = (...units) => ({ id_product: 362524873, storefront: 'de', condition: 'new', num_units: units.length, units });

test('Kaufland: podpis HMAC zgodny z wektorem testowym z dokumentacji Seller API', () => {
  assert.strictEqual(
    kaufland.podpis('POST', 'https://sellerapi.kaufland.com/v2/units/', '', 1411055926, 'a7d0cb1da1ddbc86c96ee5fedd341b7d8ebfbb2f5c83cfe0909f4e57f05dd403'),
    'da0b65f51c0716c1d3fa658b7eaf710583630a762a98c9af8e9b392bd9df2e2a');
  // metoda wielkimi literami niezależnie od wywołania; secret to napis, nie hex
  assert.strictEqual(kaufland.podpis('post', 'https://sellerapi.kaufland.com/v2/units/', '', 1411055926, 'a7d0cb1da1ddbc86c96ee5fedd341b7d8ebfbb2f5c83cfe0909f4e57f05dd403'),
    'da0b65f51c0716c1d3fa658b7eaf710583630a762a98c9af8e9b392bd9df2e2a');
});

test('Kaufland: adres zapytania = to, co podpisujemy (query w kolejności, tablica po przecinku, puste pomijane)', () => {
  assert.strictEqual(kaufland.adres('/units', { storefront: 'de', limit: 100, offset: 0, embedded: ['products'], id_offer: null }),
    'https://sellerapi.kaufland.com/v2/units?storefront=de&limit=100&offset=0&embedded=products');
  assert.strictEqual(kaufland.adres('/units', { id_offer: 'A B/1' }), 'https://sellerapi.kaufland.com/v2/units?id_offer=A%20B%2F1');
  assert.strictEqual(kaufland.adres('/info/storefront'), 'https://sellerapi.kaufland.com/v2/info/storefront');
});

test('Kaufland: nagłówki — klucz, timestamp, podpis tego samego URI i body; Content-Type tylko z body', () => {
  const stare = { k: process.env.KAUFLAND_CLIENT_KEY, s: process.env.KAUFLAND_SECRET_KEY };
  process.env.KAUFLAND_CLIENT_KEY = 'klient'; process.env.KAUFLAND_SECRET_KEY = 'sekret';
  try {
    const uri = 'https://sellerapi.kaufland.com/v2/units/501?storefront=de';
    const h = kaufland.naglowki('PATCH', uri, '{"listing_price":4299}', 1700000000);
    assert.strictEqual(h['Shop-Client-Key'], 'klient');
    assert.strictEqual(h['Shop-Timestamp'], '1700000000');
    assert.strictEqual(h['Shop-Signature'], kaufland.podpis('PATCH', uri, '{"listing_price":4299}', 1700000000, 'sekret'));
    assert.strictEqual(h['Content-Type'], 'application/json');
    assert.strictEqual(h['User-Agent'], 'Inhouse_development');
    assert.strictEqual(kaufland.naglowki('GET', uri, '', 1700000000)['Content-Type'], undefined);
  } finally {
    for (const [k, v] of [['KAUFLAND_CLIENT_KEY', stare.k], ['KAUFLAND_SECRET_KEY', stare.s]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('Kaufland: unit → wiersz oferty (centy → EUR, SKU z id_offer, produkt i EAN z embedded)', () => {
  const o = kaufland.doOferty(unit());
  assert.strictEqual(o.sku, 'NERF7376');
  assert.strictEqual(o.idProduktu, 362524873);
  assert.strictEqual(o.cena, 44.99);
  assert.strictEqual(o.wysylka, 4.99);
  assert.strictEqual(o.ilosc, 7);
  assert.strictEqual(o.aktywna, true);
  assert.strictEqual(o.ean, '5010993000000');
  assert.strictEqual(o.smart, false);
  // cena oferty = `price` (to, co widzi klient), nie `listing_price` — różnią się przy Smart Pricing
  assert.strictEqual(kaufland.doOferty(unit({ price: 3999, minimum_price: 3999 })).cena, 39.99);
  assert.strictEqual(kaufland.doOferty(unit({ minimum_price: 3999 })).smart, true, 'minimum < cena = Smart Pricing działa');
  assert.strictEqual(kaufland.doOferty(unit({ minimum_price: 4499 })).smart, false, 'minimum = cena — wyłączony (tak jest na 1060 z 1078 ofert)');
  assert.strictEqual(kaufland.doOferty(unit({ status: 'ONHOLD' })).aktywna, false);
  assert.strictEqual(kaufland.doOferty(unit({ id_offer: null })).sku, '');
});

test('Kaufland: mamy Buy Box — następny konkurent z wysyłką, podwyżka pod niego', () => {
  const ob = kaufland.zBuyboxa(ranking(my(), obcy()), unit());
  assert.strictEqual(ob.bbNasz, true);
  assert.strictEqual(ob.cena, 44.99);
  assert.strictEqual(ob.wysylka, 4.99);
  assert.strictEqual(ob.bbCena, 49.98);
  assert.strictEqual(ob.najtanszaInna, 46.99);           // 46,99 + 0 wysyłki
  assert.strictEqual(ob.ofert, 2);
  // landed konkurenta 46,99, nasza wysyłka 4,99 → cena towaru najwyżej 46,99 − 0,01 − 4,99 = 41,99:
  // już jesteśmy wyżej, więc to nie jest okazja do podwyżki
  assert.strictEqual(decyzja(ob, { min: 30, max: 60 }).kod, 'top');
  const ob2 = kaufland.zBuyboxa(ranking(my({ price: 3999 }), obcy({ price: 5499 })), unit({ price: 3999 }));
  const d = decyzja(ob2, { min: 30, max: 60 });
  assert.strictEqual(d.kod, 'podwyzka_limit');
  assert.strictEqual(d.cena, 43.99);                     // +10% na przebieg (cel 49,99)
  assert.strictEqual(d.cel, 49.99);
});

test('Kaufland: przegrywamy Buy Box — cena zwycięzcy z wysyłką, schodzimy pod niego', () => {
  const bb = ranking(obcy({ buybox_rank: 1, price: 4799, shipping_rate: 0 }), my({ buybox_rank: 2 }));
  const ob = kaufland.zBuyboxa(bb, unit());
  assert.strictEqual(ob.bbNasz, false);
  assert.strictEqual(ob.bbCena, 47.99);
  assert.strictEqual(ob.bbFba, false);
  assert.strictEqual(ob.najtanszaInna, 47.99);
  const d = decyzja(ob, { min: 30, max: 60 });
  assert.strictEqual(d.kod, 'obnizka');
  assert.strictEqual(d.cena, 42.99);                     // 47,99 − 0,01 − 4,99 naszej wysyłki
});

test('Kaufland: Buy Box nie tylko po cenie — tańsi od zwycięzcy nie obniżamy', () => {
  // zwycięzca droższy (krótszy czas dostawy) — nasza cena z wysyłką niższa
  const bb = ranking(obcy({ buybox_rank: 1, price: 5299, shipping_rate: 0 }), my({ buybox_rank: 2 }));
  const ob = kaufland.zBuyboxa(bb, unit());
  assert.strictEqual(ob.bbNasz, false);
  assert.strictEqual(decyzja(ob, { min: 30, max: 60 }).kod, 'przegrana_nie_cena');
});

test('Kaufland: Buy Box ma nasza inna oferta tego produktu — stoimy; zwycięzca FBK to „FBA” modelu', () => {
  const inna = ranking(my({ id_unit: 777, id_offer: 'NERF7376-1' }), my({ buybox_rank: 2 }));
  const ob = kaufland.zBuyboxa(inna, unit());
  assert.strictEqual(ob.bbNasz, false);
  assert.strictEqual(ob.bbInnaNasza, true);
  assert.strictEqual(ob.najtanszaInna, null, 'nasza druga oferta to nie konkurencja');
  assert.strictEqual(decyzja(ob, { min: 30, max: 60 }).kod, 'bb_nasza_inna');
  const fbk = kaufland.zBuyboxa(ranking(obcy({ buybox_rank: 1, price: 4499, shipping_rate: 499, fulfillment_type: 'fulfilled_by_kaufland' }), my({ buybox_rank: 2 })), unit());
  assert.strictEqual(fbk.bbFba, true);
  assert.strictEqual(decyzja(fbk, { min: 30, max: 60 }).kod, 'remis_fba');
});

test('Kaufland: nas nie ma w rankingu (poza top 10 / niewidoczna) — cena z unitu, Buy Box cudzy', () => {
  const ob = kaufland.zBuyboxa(ranking(obcy({ buybox_rank: 1 })), unit({ price: 4999 }));
  assert.strictEqual(ob.cena, 49.99);
  assert.strictEqual(ob.bbNasz, false);
  assert.strictEqual(ob.bbCena, 46.99);
  // pusty ranking = nie wiemy nic o Buy Boxie
  const pusty = kaufland.zBuyboxa({ id_product: 1, num_units: 0, units: [] }, unit());
  assert.strictEqual(pusty.bbNasz, null);
  assert.strictEqual(decyzja(pusty, { min: 30, max: 60 }).kod, 'brak_danych');
});

test('Kaufland: zmiana ceny = PATCH listing_price w centach na storefroncie oferty; minimum = cena przesuwa się razem z nią', () => {
  const z = kaufland.zmianaCeny(unit(), 42.99);
  assert.deepStrictEqual(z.body, { listing_price: 4299 });
  assert.strictEqual(z.sciezka, '/units/501');
  assert.deepStrictEqual(z.query, { storefront: 'de' });
  assert.strictEqual(z.cena, 42.99);
  assert.strictEqual(kaufland.zmianaCeny(unit(), 19.999).body.listing_price, 2000, 'zaokrąglenie do centa');
  // minimum = cena (Smart Pricing wyłączony): obie wartości idą razem — w dół i w górę
  assert.deepStrictEqual(kaufland.zmianaCeny(unit({ minimum_price: 4499 }), 39.99).body, { listing_price: 3999, minimum_price: 3999 });
  assert.deepStrictEqual(kaufland.zmianaCeny(unit({ minimum_price: 4499 }), 47.99).body, { listing_price: 4799, minimum_price: 4799 });
  // działający Smart Pricing (minimum < cena) — nie zapisujemy
  assert.match(kaufland.zmianaCeny(unit({ minimum_price: 4000 }), 43.99).blad, /Smart Pricing/);
  assert.match(kaufland.zmianaCeny(unit({ id_unit: null }), 40).blad, /id_unit/);
  assert.match(kaufland.zmianaCeny(unit(), 0).blad, /niepoprawna/);
  assert.deepStrictEqual(kaufland.zmianaCeny(unit({ _rynek: 'CZ' }), 400).query, { storefront: 'cz' });
});

test('Kaufland: blokada ceny tylko dla price_check_needed; link do produktu po id_product', () => {
  assert.match(kaufland.blokadaCeny([{ reason: 'gpsr_info_needed' }, { reason: 'price_check_needed', reason_description: 'The listed price needs a quick check.' }]), /price_check_needed/);
  assert.strictEqual(kaufland.blokadaCeny([{ reason: 'product_data_incomplete' }]), null);
  assert.strictEqual(kaufland.blokadaCeny(undefined), null);
  assert.deepStrictEqual(kaufland.linkiOferty(362524873, 'DE'), { produkt: 'https://www.kaufland.de/product/362524873/' });
  assert.strictEqual(kaufland.linkiOferty(null, 'DE'), null);
  assert.strictEqual(kaufland.linkiOferty(1, 'NL'), null, 'domeny nie zgadujemy');
});

test('Kaufland: kolumna KAUFLAND_DE tylko do odczytu, pas min/max z kalkulatora „Kaufland DE”', () => {
  assert.strictEqual(kluczKolumny('kaufland', 'DE'), 'KAUFLAND_DE');
  const k = kolumna('kaufland', 'DE');
  assert.ok(k, 'kolumna istnieje');
  assert.strictEqual(k.tylkoOdczyt, true);
  assert.strictEqual(k.kalkulator, 'Kaufland DE');
  const pasy = pasyZWyceny({ koszt: 40, waga: 1, docinalny: false });
  assert.ok(pasy.KAUFLAND_DE && pasy.KAUFLAND_DE.min > 0, 'minimum z kalkulatora');
  assert.strictEqual(pasy.KAUFLAND_DE.max, +(pasy.KAUFLAND_DE.min * 1.5).toFixed(2));
});
