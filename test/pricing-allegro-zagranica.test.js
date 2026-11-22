'use strict';

const test = require('node:test');
const assert = require('node:assert');

const az = require('../pricing/allegro-zagranica');
const rynki = require('../config/rynki');

const oferta = (id, pl, cz, sk, hu, reg = {}) => ({
  id, sellingMode: { format: 'BUY_NOW', price: { amount: String(pl), currency: 'PLN' } },
  additionalMarketplaces: {
    ...(cz != null ? { 'allegro-cz': { sellingMode: { price: { amount: String(cz), currency: 'CZK' }, priceAutomation: { rule: { id: reg.cz ?? '644bd75d07bd9c00ddaf5786', type: 'EXCHANGE_RATE' } } } } } : {}),
    ...(sk != null ? { 'allegro-sk': { sellingMode: { price: { amount: String(sk), currency: 'EUR' }, priceAutomation: { rule: { id: reg.sk ?? '644bd75d07bd9c00ddaf5786' } } } } } : {}),
    ...(hu != null ? { 'allegro-hu': { sellingMode: { price: { amount: String(hu), currency: 'HUF' }, priceAutomation: { rule: { id: reg.hu ?? '6863b926d59f9b0553b533db' } } } } } : {}),
    'allegro-business-pl': { sellingMode: { price: { amount: String(pl), currency: 'PLN' } } },
  },
});

test('rynek oferty: KONTO_KOD w obie strony', () => {
  assert.strictEqual(az.rynekOferty('EKAJTEK', 'CZ'), 'EKAJTEK_CZ');
  assert.deepStrictEqual({ ...az.zRynkuOferty('NATROPIE_HU'), def: undefined }, { konto: 'NATROPIE', kod: 'HU', def: undefined });
  assert.strictEqual(az.zRynkuOferty('EKAJTEK'), null);
  assert.strictEqual(az.zRynkuOferty('EKAJTEK_DE'), null);
});

test('ceny na rynkach z listy ofert (bez business-pl), reguła i waluta', () => {
  const c = az.cenyNaRynkach(oferta(1, 161.49, 893, 36.6, 14970));
  assert.deepStrictEqual(Object.keys(c), ['CZ', 'SK', 'HU']);
  assert.strictEqual(c.CZ.cena, 893);
  assert.strictEqual(c.HU.regula, '6863b926d59f9b0553b533db');
  assert.deepStrictEqual(az.cenyNaRynkach({}), {});
});

test('kurs przelicznika = mediana z ofert pod regułą rynku; HU bez narzutu 11%; za mało próbek = brak', () => {
  const lista = [
    oferta(1, 161.49, 893, 36.6, 14970), oferta(2, 35, 193, 7.93, 3245), oferta(3, 39.99, 221, 9.06, 3705),
    oferta(4, 100, 553, 22.66, 9270), oferta(5, 50, 277, 11.33, 4635),
    oferta(6, 50, 400, 20, 9000, { cz: 'inna', sk: 'inna', hu: 'inna' }),   // pod inną regułą — pomijana
  ];
  const k = az.kursyPrzelicznika(lista);
  assert.ok(Math.abs(k.CZ.kurs - 5.53) < 0.02, `CZ ${k.CZ.kurs}`);
  assert.strictEqual(k.CZ.n, 5);
  assert.ok(Math.abs(k.HU.kurs - 83.5) < 0.6, `HU ${k.HU.kurs}`);   // 14970 / (161,49 × 1,11) ≈ 83,5 Ft za zł
  assert.deepStrictEqual(az.kursyPrzelicznika(lista.slice(0, 4)), {});
});

test('zaokrąglenie do jednostki rynku', () => {
  assert.strictEqual(az.zaokraglij(892.2, az.definicja('CZ'), 'gora'), 893);
  assert.strictEqual(az.zaokraglij(14971, az.definicja('HU'), 'gora'), 14975);
  assert.strictEqual(az.zaokraglij(14972, az.definicja('HU')), 14970);
  assert.strictEqual(az.zaokraglij(36.601, az.definicja('SK'), 'gora'), 36.61);
});

test('podłoga: PL po kursie (HU +11%), NaTropie nie taniej niż ekajtek, brak danych = brak podłogi', () => {
  const cz = az.podloga({ cenaPl: 100, kurs: 5.53, def: az.definicja('CZ') });
  assert.strictEqual(cz.podloga, 553);
  const hu = az.podloga({ cenaPl: 100, kurs: 83.5, def: az.definicja('HU') });
  assert.strictEqual(hu.podloga, 9270);   // 100 × 83,5 × 1,11 = 9268,5 → 9270
  const nt = az.podloga({ cenaPl: 100, kurs: 5.53, def: az.definicja('CZ'), cenaGlownego: 640 });
  assert.strictEqual(nt.podloga, 640);
  assert.strictEqual(nt.zPl, 553);
  assert.strictEqual(az.podloga({ cenaPl: null, kurs: 5.53, def: az.definicja('CZ') }).podloga, null);
  assert.match(az.podloga({ cenaPl: 100, kurs: null, def: az.definicja('CZ') }).brak, /kursu/);
});

test('pas po podłodze: min podniesione, max nie niższe niż min; bez podłogi brak pasa', () => {
  const pas = { min: 500, max: 750, koszt: 60 };
  assert.deepStrictEqual(az.zPodloga(pas, { podloga: 553 }).min, 553);
  assert.strictEqual(az.zPodloga(pas, { podloga: 900 }).max, 1350);   // max od podłogi × 1,5 (jak pas)
  assert.strictEqual(az.zPodloga(pas, { podloga: 400 }).min, 500);
  const bez = az.zPodloga(pas, { podloga: null, brak: 'brak ceny PL tej oferty' });
  assert.strictEqual(bez.min, null);
  assert.match(bez.blad, /ceny PL/);
});

test('zapis ceny: tylko wskazany rynek, waluta rynku, jednostka; oferta bez rynku = błąd', () => {
  const z = az.zmianaCeny(oferta(7, 161.49, 893, 36.6, 14970), 'HU', 15012);
  assert.deepStrictEqual(z.body, { additionalMarketplaces: { 'allegro-hu': { sellingMode: { price: { amount: '15010', currency: 'HUF' } } } } });
  assert.strictEqual(z.regula, '6863b926d59f9b0553b533db');
  assert.strictEqual(az.zmianaCeny(oferta(7, 161.49, 893, 36.6, 14970), 'SK', 37).body.additionalMarketplaces['allegro-sk'].sellingMode.price.amount, '37.00');
  assert.match(az.zmianaCeny(oferta(7, 161.49, null, 36.6, 14970), 'CZ', 900).blad, /nie ma na rynku/);
  assert.match(az.zmianaCeny({ ...oferta(7, 1, 893), sellingMode: { format: 'AUCTION' } }, 'CZ', 900).blad, /Kup Teraz/);
});

test('polecenie zdjęcia reguły dotyczy jednej oferty i jednego rynku', () => {
  assert.deepStrictEqual(az.polecenieUsunieciaReguly(123, 'CZ'), {
    modification: { remove: [{ marketplace: { id: 'allegro-cz' } }] },
    offerCriteria: [{ offers: [{ id: '123' }], type: 'CONTAINS_OFFERS' }],
  });
});

test('kalkulator Allegro CZ/SK/HU: minimum spełnia marżę, cena w jednostkach rynku, ocena przy cenie = ta sama matematyka', () => {
  const g = { ...rynki.DOMYSLNE };
  for (const kod of ['CZ', 'SK', 'HU']) {
    const def = rynki.definicjaRynku(`Allegro ${kod}`);
    const m = rynki.policzRynek(60, def, g);
    assert.ok(m.cena > 0 && !m.blad, kod);
    assert.ok(m.marza >= g.marza - 1e-6, `${kod} marża ${m.marza}`);
    assert.strictEqual(az.zaokraglij(m.cena, az.definicja(kod), 'gora'), m.cena);
    const nizej = rynki.wycenaPrzyCenie(60, def, g, m.cena - def.jednostka);
    assert.ok(nizej.marza < g.marza, `${kod}: cena o jednostkę niżej nie powinna dawać marży`);
  }
  // HU: opłata lokalna 4,43% obniża zysk przy tej samej cenie w złotych
  const hu = rynki.wycenaPrzyCenie(60, rynki.definicjaRynku('Allegro HU'), g, 12735);
  assert.ok(hu.detal.lokalna > 0);
});
