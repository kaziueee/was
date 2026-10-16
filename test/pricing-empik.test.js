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

test('Empik: oferta z eksportu OF52 → kształt OF21 (cena bazowa, rabat w terminie, usunięta = nieaktywna)', () => {
  const teraz = new Date('2026-10-16T12:00:00Z');
  const eksport = (o) => ({ offer_id: 208756900, shop_sku: 'NERF5035', product_sku: '1528221610', active: true, deleted: false, quantity: 10,
    min_shipping_price: 0, prices: [{ origin_price: 161.99, volume_prices: [{ quantity_threshold: 1, unit_origin_price: 161.99 }] }], ...o });
  const z = empik.zEksportu(eksport(), teraz);
  assert.deepStrictEqual(empik.doOferty(z), { sku: 'NERF5035', produkt: '1528221610', nazwa: null, cena: 161.99, ilosc: 10, aktywna: true });
  assert.strictEqual(empik.promocja(z), null);
  assert.deepStrictEqual(empik.zmianaCeny(z, 150), { sku: 'NERF5035', cena: 150 });
  assert.strictEqual(empik.doOferty(empik.zEksportu(eksport({ deleted: true }), teraz)).aktywna, false);

  const wTerminie = empik.zEksportu(eksport({ prices: [{ origin_price: 161.99, discount_price: 139.99, discount_start_date: '2026-10-01T00:00:00Z', discount_end_date: '2026-10-31T00:00:00Z' }] }), teraz);
  assert.strictEqual(empik.cenaOferty(wTerminie), 139.99, 'klient widzi cenę promocyjną');
  assert.match(empik.zmianaCeny(wTerminie, 150).blad, /promocja/);
  const zaplanowany = empik.zEksportu(eksport({ prices: [{ origin_price: 161.99, discount_price: 139.99, discount_start_date: '2026-11-01T00:00:00Z' }] }), teraz);
  assert.strictEqual(empik.cenaOferty(zaplanowany), 161.99, 'rabat jeszcze nie działa');
  assert.match(empik.zmianaCeny(zaplanowany, 150).blad, /promocja/, 'ale import cen skasowałby i zaplanowany');
});

test('Empik: lista ofert eksportem OF52 → OF53 → OF54 (atrapa API)', async () => {
  const http = require('node:http');
  const zapytania = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      zapytania.push({ m: req.method, u: req.url, auth: req.headers.authorization, ct: req.headers['content-type'], body });
      const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/api/offers/export/async') return json({ tracking_id: 'abc' });
      if (req.url === '/api/offers/export/async/status/abc') {
        return json(zapytania.filter((z) => z.u.includes('/status/')).length < 2 ? { status: 'PENDING' }
          : { status: 'COMPLETED', urls: [`http://127.0.0.1:${srv.address().port}/plik/1`] });
      }
      if (req.url === '/plik/1') return json([{ shop_sku: 'A1', product_sku: '111', active: true, quantity: 2, prices: [{ origin_price: 10 }] },
        { shop_sku: 'B2', product_sku: '222', active: false, quantity: 0, prices: [{ origin_price: 20 }] }]);
      res.writeHead(404); res.end('{}');
    });
  });
  await new Promise((r) => srv.listen(0, r));
  const env = { k: process.env.EMPIK_API_KEY, u: process.env.EMPIK_API_URL };
  process.env.EMPIK_API_KEY = 'klucz'; process.env.EMPIK_API_URL = `http://127.0.0.1:${srv.address().port}`;
  try {
    const lista = await empik.wszystkieOferty({ coMs: 5 });
    assert.deepStrictEqual(lista.map((o) => [o.shop_sku, o.active, empik.cenaOferty(o)]), [['A1', true, 10], ['B2', false, 20]]);
    const post = zapytania[0];
    assert.strictEqual(post.m, 'POST');
    assert.strictEqual(post.ct, 'application/json');
    assert.deepStrictEqual(JSON.parse(post.body), { export_type: 'application/json', include_inactive_offers: true });
    assert.ok(zapytania.every((z) => z.auth === 'klucz'), 'klucz w nagłówku także przy pobieraniu pliku');
  } finally {
    srv.close();
    if (env.k === undefined) delete process.env.EMPIK_API_KEY; else process.env.EMPIK_API_KEY = env.k;
    if (env.u === undefined) delete process.env.EMPIK_API_URL; else process.env.EMPIK_API_URL = env.u;
  }
});
