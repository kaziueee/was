'use strict';

const test = require('node:test');
const assert = require('node:assert');

const km = require('../pricing/katalogi-model');
const wm = require('../pricing/wystawianie-model');

test('EAN: 12 cyfr dostaje zero, GTIN-14 z zerem traci je, śmieci = null', () => {
  assert.strictEqual(km.normalizujEan('630509602001'), '0630509602001');
  assert.strictEqual(km.normalizujEan('05010996304018'), '5010996304018');
  assert.strictEqual(km.normalizujEan(' 5010996304018 '), '5010996304018');
  assert.strictEqual(km.normalizujEan('ABC123'), null);
  assert.strictEqual(km.normalizujEan('12345'), null);
});

test('find_by_eans: wynik jako obiekt po EAN, wygrywa produkt, do którego wolno dodać ofertę', () => {
  const m = km.zEmagFindByEans({
    5010996304018: { products: [
      { part_number_key: 'ZLY', product_name: 'X', brand_name: 'Furby', doc_category_id: 1, allowed_to_add_offer: false },
      { part_number_key: 'DLSLY03BM', product_name: 'Jucarie Furby', brand_name: 'Furby', doc_category_id: 2753, category_name: 'Jucarii de plus', allowed_to_add_offer: true, vendor_has_offer: false, hotness: 'HOT' },
    ] },
    123: { products: [{ part_number_key: 'NIE' }] },          // niepoprawny EAN — pomijamy
    3168430082489: [],                                          // eMAG nie zna EAN-u
  });
  assert.strictEqual(m.size, 1);
  assert.deepStrictEqual(m.get('5010996304018'), { produkt_id: 'DLSLY03BM', nazwa: 'Jucarie Furby', marka: 'Furby', kategoria: 'Jucarii de plus',
    kategoria_id: '2753', dodac: 1, mamy: 0, hotness: 'HOT' });
});

test('odrzucenie marki rozpoznawane po treści eMAG', () => {
  assert.ok(km.odrzucenieMarki('Brandul face parte din categorii cu risc ridicat. Trimite documentele prin Mesagerie'));
  assert.ok(!km.odrzucenieMarki('Product name should not be empty'));
});

test('powód braku kandydata: oferta, brak produktu, zakaz, ograniczenie, stan', () => {
  assert.strictEqual(km.powodBraku({ produkt_id: 'P' }), null);
  assert.strictEqual(km.powodBraku({ produkt_id: 'P' }, { mamyOferte: true }), 'mamy ofertę');
  assert.strictEqual(km.powodBraku({ produkt_id: null }), 'brak produktu na rynku');
  assert.strictEqual(km.powodBraku({ produkt_id: 'P', dodac: 0 }), 'platforma nie pozwala dodać oferty');
  assert.strictEqual(km.powodBraku({ produkt_id: 'P', ograniczenie: 'Amazon: APPROVAL_REQUIRED' }), 'Amazon: APPROVAL_REQUIRED');
  assert.strictEqual(km.powodBraku({ produkt_id: 'P' }, { stan: 0 }), 'brak stanu');
});

test('waga z GT: tylko zapis z przecinkiem jest jednoznacznie w kg', () => {
  assert.deepStrictEqual(wm.wagaGramy('0,112'), { g: 112 });
  assert.deepStrictEqual(wm.wagaGramy('1.31'), { g: 1310 });
  assert.match(wm.wagaGramy('916').blad, /bez przecinka/);
  assert.match(wm.wagaGramy('').blad, /brak wagi/);
  assert.match(wm.wagaGramy('0,0001').blad, /mniej niż 1 g/);
});

test('wymiary cm → mm', () => {
  assert.deepStrictEqual(wm.wymiaryMm({ dlugosc: 13, szerokosc: 10, wysokosc: 6 }), { length: 130, width: 100, height: 60 });
  assert.deepStrictEqual(wm.wymiaryMm({ dlugosc: 25.5, szerokosc: 17.5, wysokosc: 5.5 }), { length: 255, width: 175, height: 55 });
  assert.match(wm.wymiaryMm(null).blad, /brak wymiarów/);
});

test('netto z 4 miejscami daje dokładnie cenę brutto (Furby 67,99 RON → 56,19 netto)', () => {
  const n = wm.nettoZBrutto(67.99, 0.21);
  assert.strictEqual(Math.round(n * 1.21 * 100) / 100, 67.99);
  assert.strictEqual(wm.nettoZBrutto(169.99, 0.21), 140.4876);
  assert.strictEqual(wm.nettoZBrutto(0, 0.21), null);
});

test('stan dostępny = Razem − rezerwacje, bez ujemnych magazynów', () => {
  const st = { K4: { ilosc: 10, rezerwacja: 3 }, K4G: { ilosc: 5, rezerwacja: 0 }, MAG: { ilosc: 1, rezerwacja: 4 }, BRK: { ilosc: 99, rezerwacja: 0 } };
  assert.strictEqual(wm.stanDostepny(st, ['K4', 'K4G', 'MAG', 'LS']), 12);
  assert.strictEqual(wm.stanDostepny(null, ['K4']), null);
});

const pozycja = (z = {}) => ({
  platforma: 'emag', rynek: 'RO', tw_id: 1, sku: 'HASF9703-G1700', ean: '5010996304018', cena: 67.99, ilosc: 5,
  katalog: { produkt_id: 'DLSLY03BM', nazwa: 'Jucarie Interactiva Furby', marka: 'Furby', kategoria_id: '2753' },
  waga: '0,112', wymiary: { dlugosc: 13, szerokosc: 10, wysokosc: 6 }, pas: { min: 59.99, max: 89.99 }, ...z,
});

test('ocena pozycji: komplet przechodzi, braki danych osobno („do uzupełnienia”), cena pod minimum ostrzega', () => {
  assert.deepStrictEqual(wm.ocenPozycje(pozycja()), { blokady: [], brakuje: [], ostrzezenia: [] });
  const o = wm.ocenPozycje(pozycja({ ean: null, waga: '112', wymiary: null, ilosc: 0 }));
  assert.deepStrictEqual(o.brakuje.map((b) => b.pole), ['EAN', 'waga', 'wymiary']);
  assert.match(o.brakuje[1].tekst, /bez przecinka/);
  assert.deepStrictEqual(o.blokady, ['brak stanu dostępnego']);
  assert.strictEqual(wm.powodyBlokady(o).length, 4);              // braki danych też zatrzymują wysyłkę
  assert.strictEqual(wm.ocenPozycje(pozycja({ cena: 50 })).ostrzezenia[0].kod, 'pod_minimum');
  assert.match(wm.ocenPozycje(pozycja({ rynek: 'HU' })).blokady[0], /czeka na test/);
  assert.match(wm.ocenPozycje(pozycja({ platforma: 'amazon', rynek: 'DE' })).blokady[0], /Amazon/);
});

test('oferta eMAG: EAN zawsze w treści, cena netto, zakres min/max szeroki wokół pasa', () => {
  const { oferta, netto } = wm.ofertaEmag(pozycja(), 9000010);
  assert.strictEqual(oferta.id, 9000010);
  assert.deepStrictEqual(oferta.ean, ['5010996304018']);
  assert.strictEqual(oferta.part_number_key, 'DLSLY03BM');
  assert.strictEqual(oferta.part_number, 'HASF9703-G1700');
  assert.strictEqual(oferta.category_id, 2753);
  assert.strictEqual(oferta.vat_id, 9);
  assert.strictEqual(oferta.sale_price, netto);
  assert.deepStrictEqual(oferta.stock, [{ warehouse_id: 1, value: 5 }]);
  assert.ok(oferta.min_sale_price * 1.21 <= 59.99 * 0.9 + 0.01);
  assert.ok(oferta.max_sale_price * 1.21 >= 67.99 * 2.5 - 0.01);
  assert.match(wm.ofertaEmag(pozycja({ rynek: 'XX' }), 1).blad, /VAT/);
});

test('wymiary eMAG w mm i g', () => {
  assert.deepStrictEqual(wm.wymiaryEmag(pozycja(), 9000010).pomiar, { id: 9000010, length: 130, width: 100, height: 60, weight: 112 });
  assert.ok(wm.wymiaryEmag(pozycja({ waga: '' }), 1).blad);
});

test('Empik P31: kluczem produktu product_sku, EAN normalizowany, inne typy referencji pomijane', () => {
  const m = km.zEmpikP31([
    { category_code: '15-2-10-2-6-3', category_label: 'Dzikie', product_id: '4059433552262', product_id_type: 'EAN', product_sku: '1359986823', product_title: 'Schleich, figurka' },
    { product_id: '196214111172', product_id_type: 'EAN', product_sku: '1605015406', product_title: 'Karty Pokémon' },
    { product_id: '4059433552262', product_id_type: 'EAN', product_sku: 'DRUGI' },           // duplikat EAN — pierwszy wygrywa
    { product_id: 'X1', product_id_type: 'SHOP_SKU', product_sku: 'NIE' },
  ]);
  assert.strictEqual(m.size, 2);
  assert.deepStrictEqual(m.get('4059433552262'), { produkt_id: '1359986823', nazwa: 'Schleich, figurka', marka: null, kategoria: 'Dzikie',
    kategoria_id: '15-2-10-2-6-3', dodac: null, mamy: 0, hotness: null });
  assert.strictEqual(m.get('0196214111172').produkt_id, '1605015406');
  assert.ok(km.RYNKI_KATALOGU.some((r) => r.platforma === 'empik' && r.rynek === 'PL'));
});

test('Empik: klasa logistyczna 2, gdy mieści się w paczkomacie C, inaczej 3', () => {
  assert.strictEqual(wm.klasaLogistycznaEmpik({ dlugosc: 46, szerokosc: 31, wysokosc: 31 }, 900), '2');
  assert.strictEqual(wm.klasaLogistycznaEmpik({ dlugosc: 76.5, szerokosc: 28.6, wysokosc: 8 }, 900), '3');   // NERE8875 — za długi
  assert.strictEqual(wm.klasaLogistycznaEmpik({ dlugosc: 40, szerokosc: 40, wysokosc: 40 }, 900), '3');
  assert.strictEqual(wm.klasaLogistycznaEmpik({ dlugosc: 30, szerokosc: 20, wysokosc: 10 }, 26000), '3');    // > 25 kg
});

test('Empik OF01: wiersz po EAN, cena brutto z kropką, tryb update; plik CSV ze średnikami', () => {
  const o = wm.ofertaEmpik(pozycja({ platforma: 'empik', rynek: 'PL', cena: 123.9 }));
  assert.deepStrictEqual(o.wiersz, { sku: 'HASF9703-G1700', 'product-id': '5010996304018', 'product-id-type': 'EAN', price: '123.90', quantity: 5,
    state: '11', 'logistic-class': '2', 'leadtime-to-ship': 1, 'update-delete': 'update' });
  const plik = wm.plikOfertEmpik([o.wiersz]).split('\n');
  assert.strictEqual(plik[0], '"sku";"product-id";"product-id-type";"price";"quantity";"state";"logistic-class";"leadtime-to-ship";"update-delete"');
  assert.strictEqual(plik[1], '"HASF9703-G1700";"5010996304018";"EAN";"123.90";"5";"11";"2";"1";"update"');
  assert.ok(wm.ofertaEmpik(pozycja({ platforma: 'empik', waga: '112' })).blad);
  assert.deepStrictEqual(wm.ocenPozycje(pozycja({ platforma: 'empik', rynek: 'PL' })).blokady, []);
});

test('Empik OF03: raport błędów → SKU → treść', () => {
  const r = wm.bledyImportuEmpik('"sku";"product-id";"error-line";"error-message"\n"ab-1";"590";"2";"Produkt nie istnieje"\n"X;2";"1";"3";"Cena ""zero"""\n');
  assert.strictEqual(r.get('AB-1'), 'Produkt nie istnieje');
  assert.strictEqual(r.get('X;2'), 'Cena "zero"');
});

test('cena rynku: Kaufland bez naszych ofert, w centach → zł; Empik bez naszego sklepu', () => {
  assert.deepStrictEqual(km.cenaRynkuKaufland({ units: [{ price: 2499 }, { price: 1999, id_unit: 5 }, { price: 2199 }] }), { cena: 21.99, ofert: 2 });
  assert.strictEqual(km.cenaRynkuKaufland({ units: [{ price: 1999, id_offer: 'X' }] }), null);
  const of = [{ shop_name: 'Poszukiwacze Frajdy', price: 70 }, { shop_name: 'Yupi', applicable_pricing: { price: 84.5 }, price: 90 }, { shop_name: 'Inny', price: 99.99, active: false }];
  assert.deepStrictEqual(km.cenaRynkuEmpik(of, 'Poszukiwacze Frajdy'), { cena: 84.5, ofert: 1 });
});

test('cena startowa: rynek droższy → cena rynku, tańszy albo brak → minimum', () => {
  assert.strictEqual(km.cenaStartowa(78.99, 99.99), 99.99);
  assert.strictEqual(km.cenaStartowa(78.99, 60), 78.99);
  assert.strictEqual(km.cenaStartowa(78.99, null), 78.99);
  assert.strictEqual(km.cenaStartowa(null, 50), 50);
});

test('Amazon: EAN na kilku ASIN-ach — wygrywa model z symbolu, potem karta z jednym EAN-em', () => {
  const motu = { asin: 'B0CBQTGDWZ', eany: ['0194735243563', '0194735262649'], model: 'HYC48' };
  const hw = { asin: 'B0DMWGSC2L', eany: ['0194735262649'], model: 'JBL02' };
  assert.strictEqual(km.wybierzAsin([motu, hw], 'HWHHBL96-JBL02').asin, 'B0DMWGSC2L');
  assert.strictEqual(km.wybierzAsin([motu, hw], 'COS-INNEGO').asin, 'B0DMWGSC2L');      // jedyny EAN
  assert.strictEqual(km.wybierzAsin([motu, hw], 'X').wieloznaczny, true);
  assert.deepStrictEqual(km.wybierzAsin([hw], 'X'), { ...hw, wieloznaczny: false });
  assert.strictEqual(km.wybierzAsin([], 'X'), null);
});

test('błąd zapisu eMAG: marka przed siecią (treść z linkiem https), sieć, inna odmowa', () => {
  const marka = 'eMAG product_offer/save: ERROR: Pentru a putea comercializa produse din acest brand, este necesar să trimiti documentele specifice prin intermediul Mesageriei … "Categorii cu risc crescut".Acceseaza pagina https://marketplace.emag.ro/infocenter/lista-categorii-cu-risc-ridicat/ - Product id: 9000010';
  assert.strictEqual(km.rodzajBleduEmag(marka), 'marka');
  assert.strictEqual(km.rodzajBleduEmag('eMAG product_offer/save: HTTP 502'), 'siec');
  assert.strictEqual(km.rodzajBleduEmag('eMAG product_offer/save: The operation was aborted due to timeout'), 'siec');
  assert.strictEqual(km.rodzajBleduEmag('eMAG product_offer/save: ERROR: Invalid sale price'), 'odmowa');
});
