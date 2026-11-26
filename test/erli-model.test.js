'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const e = require('../pricing/erli-model');

test('cena Erli = Allegro × 1,05 w górę do ,99, w groszach', () => {
  assert.equal(e.cenaErliGrosze(109.99), 11599);     // 115,49 → 115,99
  assert.equal(e.cenaErliGrosze('50.00'), 5299);     // 52,50 → 52,99
  assert.equal(e.cenaErliGrosze(95.23), 9999);       // 99,99 dokładnie
  assert.equal(e.cenaErliGrosze(0), null);
  assert.equal(e.cenaErliGrosze(null), null);
});

test('pilnowanie ceny: dokładnie Allegro +5% (do ,99), w obie strony', () => {
  assert.equal(e.podlogaGrosze(100), 10500);
  assert.equal(e.korektaCeny(10299, 100), 10599);    // tańsza → w górę
  assert.equal(e.korektaCeny(15999, 100), 10599);    // droższa → w dół
  assert.equal(e.korektaCeny(10599, 100), null);     // równa celowi — zostaje
  assert.equal(e.korektaCeny(10000, null), null);    // brak ceny Allegro — nie ruszamy
});

test('adresy zdjęć z unikalnym dopiskiem', () => {
  assert.equal(e.zDopiskiem('https://a/1', 'erli-5'), 'https://a/1#erli-5');
  assert.equal(e.zDopiskiem('https://a/1#stary', 'x'), 'https://a/1#x');
  assert.equal(e.zDopiskiem('https://a/1', null), 'https://a/1');
});

test('HTML Allegro → dozwolone znaczniki Erli', () => {
  // Poziom nagłówków bez zmian — Erli sam obniża o jeden (test BARBBDS6).
  assert.equal(e.htmlDlaErli('<h1>TYTUŁ</h1><p>Tekst <b>gruby</b></p>'), '<h1>TYTUŁ</h1><p>Tekst <b>gruby</b></p>');
  assert.equal(e.htmlDlaErli('<h2>Pod</h2>\n<ul><li>a</li><li>b</li></ul>'), '<h2>Pod</h2><ul><li>a</li><li>b</li></ul>');
  assert.equal(e.htmlDlaErli('<h4>Mały</h4>'), '<h3>Mały</h3>');
  assert.equal(e.htmlDlaErli('<P class="x">A<br>B</P>'), '<p>A<br/>B</p>');
  assert.equal(e.htmlDlaErli('<h1><b>Gruby</b> tytuł</h1>'), '<h1>Gruby tytuł</h1>');
  assert.equal(e.htmlDlaErli('luzem <strong>x</strong><p>y</p>'), '<p>luzem <b>x</b></p><p>y</p>');
  assert.equal(e.htmlDlaErli('<p><a href="u">link</a> i <i>kursywa</i></p>'), '<p>link i kursywa</p>');
  assert.equal(e.htmlDlaErli('<ul> <li>a,</li>\n <li>b</li> </ul><p><b>Wiek: </b>3+</p>'), '<ul><li>a,</li><li>b</li></ul><p><b>Wiek: </b>3+</p>');
});

test('opis: sekcje 1–2 elementów, zdjęcia zostają', () => {
  const o = e.opisDlaErli({ sections: [
    { items: [{ type: 'IMAGE', url: 'https://a/1' }, { type: 'TEXT', content: '<h1>X</h1><p>y</p>' }] },
    { items: [{ type: 'TEXT', content: '   ' }] },
  ] });
  assert.deepEqual(o, { sections: [{ items: [{ type: 'IMAGE', url: 'https://a/1' }, { type: 'TEXT', content: '<h1>X</h1><p>y</p>' }] }] });
  assert.equal(e.opisDlaErli(null), null);
});

test('parametry Allegro → externalAttributes jak w obecnych kopiach', () => {
  const a = e.atrybutyZAllegro(
    [{ id: '225693', name: 'EAN (GTIN)', values: ['5010996254474'], valuesIds: null },
     { id: '248811', name: 'Marka', values: ['Play-Doh'], valuesIds: ['248811_1990010'] },
     { id: '223329', name: 'Wysokość', values: ['38.5'], valuesIds: null },
     { id: '1', name: 'Zakres', values: [], rangeValue: { from: '3', to: '8' } }],
    [{ id: '11323', name: 'Stan', values: ['Nowy'], valuesIds: ['11323_1'] }, { id: '248811', valuesIds: ['dubel'] }]);
  assert.deepEqual(a, [
    { type: 'string', id: '225693', source: 'allegro', values: ['5010996254474'], index: 0 },
    { type: 'dictionary', id: '248811', source: 'allegro', values: [{ id: '248811_1990010' }], index: 1 },
    { type: 'string', id: '223329', source: 'allegro', values: ['38.5'], index: 2 },
    { type: 'range', id: '1', source: 'allegro', values: { from: 3, to: 8 }, index: 3 },
    { type: 'dictionary', id: '11323', source: 'allegro', values: [{ id: '11323_1' }], index: 4 },
  ]);
});

const OFERTA = {
  id: '17715639226', name: 'PLAY-DOH KALENDARZ', category: { id: '93655' },
  parameters: [{ id: '11323', name: 'Stan', values: ['Nowy'], valuesIds: ['11323_1'] }],
  productSet: [{ product: { id: 'uuid', parameters: [
    { id: '225693', name: 'EAN (GTIN)', values: ['5010996254474'] },
    { id: '248811', name: 'Marka', values: ['Play-Doh'], valuesIds: ['248811_1990010'] }] },
  responsibleProducer: { id: 'aae2' }, responsiblePerson: null }],
  images: ['https://a.allegroimg.com/original/1', 'https://a.allegroimg.com/original/2'],
  description: { sections: [{ items: [{ type: 'TEXT', content: '<h1>T</h1>' }] }] },
  external: { id: 'HASF2377' }, sellingMode: { price: { amount: '109.99', currency: 'PLN' } },
  stock: { available: 15 }, taxSettings: { rates: [{ rate: '23.00', countryCode: 'PL' }, { rate: '21.00', countryCode: 'CZ' }] },
  publication: { status: 'ACTIVE' },
};

test('produkt Erli z oferty Allegro', () => {
  const p = e.produktZAllegro(OFERTA, { gramy: 874, cennikErli: 'DHL Inpost Poczta' });
  assert.equal(p.name, 'PLAY-DOH KALENDARZ');
  assert.equal(p.ean, '5010996254474');
  assert.equal(p.sku, 'HASF2377');
  assert.equal(p.price, 11599);
  assert.equal(p.stock, 15);
  assert.equal(p.weight, 874);
  assert.equal(p.taxRate, 'TAX_23');
  assert.equal(p.deliveryPriceList, 'DHL Inpost Poczta');
  assert.deepEqual(p.dispatchTime, { unit: 'hour', period: 24 });
  assert.deepEqual(p.externalCategories, [{ source: 'allegro', breadcrumb: [{ id: '93655' }], index: 0 }]);
  assert.deepEqual(p.externalReferences, [{ kind: 'allegro', id: '17715639226', source: 'api' }]);
  assert.deepEqual(p.externalResponsibleProducer, [{ externalId: 'aae2', source: 'allegro' }]);
  assert.equal(p.externalResponsiblePerson, undefined);
  assert.deepEqual(p.images, [{ url: 'https://a.allegroimg.com/original/1#erli-17715639226' }, { url: 'https://a.allegroimg.com/original/2#erli-17715639226' }]);
  assert.equal(p.description.sections[0].items[0].content, '<h1>T</h1>');
  assert.equal(e.produktZAllegro(OFERTA, { stan: 3 }).stock, 3);
});

const GT_OK = { sklep: true, cena3: 129.99, ean: '5010996254474', nazwa: 'Play-Doh kalendarz' };
const ok = (x = {}) => e.ocenKandydata({ oferta: OFERTA, sciezka: ['Allegro', 'Dziecko', 'Zabawki'], gt: GT_OK, wFeedzie: true, naErli: {}, cennikErli: 'DHL Inpost Poczta', ...x });

test('kandydat bez zastrzeżeń', () => assert.deepEqual(ok().blokady, []));

test('blokady zasad usera', () => {
  assert.match(ok({ gt: { ...GT_OK, sklep: false } }).blokady.join(), /sklep internetowy/);
  assert.match(ok({ gt: { ...GT_OK, cena3: 0 } }).blokady.join(), /Specjalna/);
  assert.match(ok({ gt: null }).blokady.join(), /nie pasuje/);
  assert.match(ok({ wagaBlad: 'brak wagi' }).blokady.join(), /brak wagi/);
  assert.match(ok({ wFeedzie: false }).blokady.join(), /Fenomie/);
  assert.match(ok({ wFeedzie: null }).blokady.join(), /feed sklepu/);
  assert.match(ok({ sciezka: ['Allegro', 'Dziecko', 'Zabawki', 'Pozostałe'] }).blokady.join(), /Pozostałe/);
  assert.match(ok({ oferta: { ...OFERTA, name: 'TEFAL PATELNIA' } }).blokady.join(), /Tefal/);
  assert.match(ok({ cennikErli: null }).blokady.join(), /cennika/);
  assert.match(ok({ naErli: { poId: { status: 'inactive', archived: true } } }).blokady.join(), /zarchiwizowany/);
  assert.match(ok({ naErli: { poSku: [{ externalId: '1', status: 'active' }] } }).blokady.join(), /ten SKU/);
  assert.match(ok({ oferta: { ...OFERTA, stock: { available: 0 } } }).blokady.join(), /bez stanu/);
  assert.match(ok({ oferta: { ...OFERTA, stock: { available: 2 } } }).blokady.join(), /od 3/);
  assert.deepEqual(ok({ oferta: { ...OFERTA, stock: { available: 3 } } }).blokady, []);
  assert.match(ok({ wariantPU: true }).blokady.join(), /uszkodzony/);
  assert.match(ok({ oferta: { ...OFERTA, description: { sections: [] } } }).blokady.join(), /bez opisu/);
  assert.match(ok({ wariantPU: null }).blokady.join(), /nie udało się sprawdzić/);
  assert.match(ok({ oferta: { ...OFERTA, name: 'LALKA USZKODZONE OPAKOWANIE' } }).blokady.join(), /uszkodzony/);
});

test('producent GPSR z Allegro → wpis słownika Erli', () => {
  const a = { id: '3e7b45ac', name: 'hot wheels, barbie', producerData: { tradeName: 'Mattel Europa, B.V.',
    address: { countryCode: 'NL', street: 'Gondel 1', postalCode: '1186 MJ', city: 'Amstelveen' }, contact: { email: 'x@mattel.com', phoneNumber: null } } };
  assert.deepEqual(e.producentErli(a).wpis, { name: 'Mattel Europa, B.V.', idempotenceKey: '3e7b45ac', properName: 'hot wheels, barbie',
    country: 'nl', address: 'Gondel 1', postalCode: '1186 MJ', city: 'Amstelveen', email: 'x@mattel.com', source: 'allegro' });
  assert.match(e.producentErli({ ...a, producerData: { ...a.producerData, contact: {} } }).blad, /e?mail/);
  assert.match(e.producentErli(null).blad, /brak danych/);
  const o = { id: 'p1', name: 'Osoba', personalData: { name: 'Jan Sp. z o.o.', address: { countryCode: 'PL', street: 'Ul 1', postalCode: '00-001', city: 'W' }, contact: { email: 'a@b.pl', phoneNumber: '123' } } };
  assert.equal(e.osobaErli(o).wpis.name, 'Jan Sp. z o.o.');
  assert.equal(e.osobaErli(o).wpis.phone, '123');
});
