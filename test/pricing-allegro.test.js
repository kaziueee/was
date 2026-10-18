'use strict';

const test = require('node:test');
const assert = require('node:assert');

const allegro = require('../pricing/allegro');
const { decyzja } = require('../pricing/model');
const { pasyZWyceny } = require('../pricing/pas');
const { kluczKolumny, kolumna } = require('../pricing/kolumny');
const filtry = require('../pricing/filtry-cen');
const rynki = require('../config/rynki');

// Kształt z GET /sale/offers (pola, z których korzystamy) — jak w odpowiedzi z 2026-10-16.
const surowa = (o = {}) => ({
  id: '17734419553', name: 'Nerf Elite 2.0', external: { id: 'NERF7376' },
  sellingMode: { format: 'BUY_NOW', price: { amount: '109.99', currency: 'PLN' }, priceAutomation: null },
  stock: { available: 12, sold: 7 }, publication: { status: 'ACTIVE' }, _konto: 'EKAJTEK', ...o,
});

test('Allegro: oferta z API → SKU z sygnatury, numer oferty, cena brutto PLN, stan, sprzedaż 30 dni', () => {
  const o = allegro.doOferty(surowa());
  assert.deepStrictEqual(o, { sku: 'NERF7376', id: '17734419553', nazwa: 'Nerf Elite 2.0', cena: 109.99, ilosc: 12, sprzedane30: 7, aktywna: true, regula: null });
  assert.strictEqual(allegro.doOferty(surowa({ sellingMode: { price: { amount: '25', currency: 'CZK' } } })).cena, null, 'inna waluta = nie zgadujemy ceny');
  assert.strictEqual(allegro.doOferty(surowa({ external: null })).sku, '', 'oferta bez sygnatury');
  assert.strictEqual(allegro.doOferty(surowa({ sellingMode: { price: { amount: '9.9', currency: 'PLN' }, priceAutomation: { rule: { id: 'r1' } } } })).regula, 'r1');
});

test('Allegro: ten sam SKU w kilku ofertach — najstarsza ma goły SKU, reszta SKU/numer', () => {
  const lista = [surowa({ id: '17900000001' }), surowa({ id: '9800000001' }), surowa({ id: '17900000002', external: { id: 'INNY' } }), surowa({ id: '1', external: null })];
  const k = allegro.kluczeOfert(lista);
  assert.strictEqual(k(lista[1]), 'NERF7376', 'krótszy numer = starsza oferta (porównanie jak liczb, nie napisów)');
  assert.strictEqual(k(lista[0]), 'NERF7376/17900000001');
  assert.strictEqual(k(lista[2]), 'INNY');
  assert.strictEqual(k(lista[3]), null);
  assert.strictEqual(allegro.skuGt('NERF7376/17900000001'), 'NERF7376');
  assert.strictEqual(allegro.skuGt('HASF8401-DE'), 'HASF8401-DE', 'dopiski SKU zostają dla mapowania');
});

test('Allegro: obserwacja bez konkurencji — w pasie stoimy, pod minimum od razu na minimum', () => {
  const ob = allegro.zOferty(surowa());
  assert.strictEqual(ob.cena, 109.99);
  assert.strictEqual(ob.konkurencjaNiedostepna, true);
  assert.strictEqual(ob.bbNasz, null);
  const w = decyzja(ob, { min: 80, max: 120 });
  assert.strictEqual(w.zmiana, false);
  assert.strictEqual(w.kod, 'bez_konkurencji');
  const pod = decyzja(ob, { min: 129.99, max: 195 });
  assert.strictEqual(pod.zmiana, true);
  assert.strictEqual(pod.kod, 'pod_min');
  assert.strictEqual(pod.cena, 129.99);
  // nad maksimum nie obniżamy — max ogranicza tylko podwyżki (jak na każdej platformie)
  assert.strictEqual(decyzja(ob, { min: 50, max: 75 }).zmiana, false);
});

test('Allegro: zmiana ceny = PATCH z samą ceną (kwota tekstem, 2 miejsca), odmowy przed wysłaniem', () => {
  const z = allegro.zmianaCeny(surowa(), 104.5);
  assert.deepStrictEqual(z, { body: { sellingMode: { price: { amount: '104.50', currency: 'PLN' } } }, cena: 104.5 });
  assert.match(allegro.zmianaCeny(surowa({ sellingMode: { format: 'BUY_NOW', price: { amount: '1', currency: 'PLN' }, priceAutomation: { rule: { id: 'x' } } } }), 10).blad, /reguł/);
  assert.match(allegro.zmianaCeny(surowa({ sellingMode: { format: 'AUCTION', price: { amount: '1', currency: 'PLN' } } }), 10).blad, /Kup Teraz/);
  assert.match(allegro.zmianaCeny(surowa({ sellingMode: { format: 'BUY_NOW', price: { amount: '1', currency: 'EUR' } } }), 10).blad, /PLN/);
  assert.match(allegro.zmianaCeny(surowa(), 0).blad, /niepoprawna/);
  assert.match(allegro.zmianaCeny({}, 10).blad, /numeru/);
});

test('Allegro: token ważny z zapasem 5 min; Retry-After w sekundach, za długi = bez ponowienia', () => {
  const teraz = Date.parse('2026-10-16T12:00:00Z');
  assert.strictEqual(allegro.tokenWazny({ wygasa: '2026-10-16T12:10:00Z' }, teraz), true);
  assert.strictEqual(allegro.tokenWazny({ wygasa: '2026-10-16T12:04:00Z' }, teraz), false);
  assert.strictEqual(allegro.tokenWazny(null, teraz), false);
  assert.strictEqual(allegro.czekajMs('3', 1), 3000);
  assert.strictEqual(allegro.czekajMs(null, 2), 4000);
  assert.strictEqual(allegro.czekajMs('3600', 1), null);
});

test('Allegro: dwie kolumny (konta) tylko do odczytu, minimum z kalkulatora rynku „Allegro”', () => {
  assert.strictEqual(kluczKolumny('allegro', 'EKAJTEK'), 'ALLEGRO_EKAJTEK');
  for (const konto of Object.keys(allegro.KONTA)) {
    const k = kolumna('allegro', konto);
    assert.ok(k, konto);
    assert.strictEqual(k.tylkoOdczyt, true);
    assert.strictEqual(k.bezKonkurencji, true);
    assert.strictEqual(k.kalkulator, 'Allegro');
  }
  const pasy = pasyZWyceny({ koszt: 40, waga: 1, docinalny: false });
  const def = rynki.RYNKI.find((r) => r.nazwa === 'Allegro');
  const g = { ...rynki.DOMYSLNE, waga: 1, docinanieOn: true };
  const oczek = rynki.policzRynek(40, def, g).cena;
  assert.strictEqual(pasy.ALLEGRO_EKAJTEK.min, oczek);
  // NaTropie bez Ads (rynekNadpisz) — minimum jak przy ads 0, czyli niższe niż ekajtek
  assert.strictEqual(pasy.ALLEGRO_NATROPIE.min, rynki.policzRynek(40, { ...def, ads: 0 }, g).cena);
  assert.ok(pasy.ALLEGRO_NATROPIE.min <= pasy.ALLEGRO_EKAJTEK.min);
  // ocen() przy cenie minimalnej = marża docelowa (20%) — ta sama matematyka co Cennik
  assert.ok(Math.abs(pasy.ALLEGRO_EKAJTEK.ocen(oczek).marza - 20) < 2);
});

test('Allegro: „w pasie, konkurencji nie widać” liczy się do sytuacji „Brak danych”', () => {
  assert.strictEqual(filtry.ofertaPasuje({ kod: 'bez_konkurencji' }, 'wszystkie', 'brak_danych'), true);
});

test('Allegro: User-Agent w formacie Nazwa/Wersja (+URL dokumentacji) — wymóg Allegro od 07.2026', () => {
  assert.match(allegro.USER_AGENT(), /^[A-Za-z][\w-]*\/[\w.]+ \(\+https:\/\/\S+\)$/);
  // wartość z generatora Allegro dla aplikacji „WMS Price” (18.10.2026) — zmiana = ponowne wygenerowanie
  assert.strictEqual(allegro.USER_AGENT(), 'WMS-Price/1.0 (+https://github.com/kaziueee/was/blob/main/pricing/allegro.js)');
});

test('Allegro: numer konta i uprawnienia z treści tokenu (bez /me — aplikacja nie ma profile:read)', () => {
  const jwt = (o) => ['x', Buffer.from(JSON.stringify(o)).toString('base64url'), 'y'].join('.');
  assert.deepStrictEqual(allegro.trescTokenu(jwt({ user_name: '21818279', scope: ['allegro:api:sale:offers:write'] })),
    { user_name: '21818279', scope: ['allegro:api:sale:offers:write'] });
  assert.strictEqual(allegro.trescTokenu('nie-jwt'), null);
  for (const k of Object.values(allegro.KONTA)) assert.match(k.id, /^\d+$/, k.login);
});

test('Allegro: ręczna zmiana ceny z ekranu obsługiwana (rejestr pricing/reczna-cena.js)', () => {
  const reczna = require('../pricing/reczna-cena');
  assert.strictEqual(reczna.obslugiwana('allegro'), true);
  assert.match(reczna.propagacja('allegro'), /od razu/);
});

test('Allegro w kalkulatorze: Ads z definicji rynku (1,32%), nie z DOMYSLNE (3%); progi dostawy z Rozliczeń', () => {
  const def = rynki.RYNKI.find((r) => r.nazwa === 'Allegro');
  assert.strictEqual(def.ads, 1.32);
  const g = { ...rynki.DOMYSLNE };
  // zysk przy cenie: prowizja + Ads liczone od ceny brutto, dopłata dostawy wg progu
  const c = 80, w = rynki.wycenaPrzyCenie(40, def, g, c);
  const oczek = c / 1.23 - c * (13.3 + 1.32) / 100 - 40 - rynki.doplataSmartAllegro(c) - g.obsluga;
  assert.ok(Math.abs(w.zysk - oczek) < 1e-9);
  assert.deepStrictEqual([44.99, 45, 64.99, 65, 99.99, 100, 149.99, 150, 199.99, 200, 499.99, 500].map(rynki.doplataSmartAllegro),
    [0, 2.5, 2.5, 3.75, 3.75, 5.82, 5.82, 7.33, 7.33, 7.43, 7.43, 12.16]);
});

