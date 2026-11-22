'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../services/zk-model');

const towary = [
  { tw_Id: 1, symbol: 'MATHXJ32', ean: '194735230914', kody: [], cena: 23, stan_mag: 9, rez_mag: 1, nazwa: 'Cars' },
  { tw_Id: 2, symbol: 'HASG0737', ean: '5010996327062', kody: [], cena: 19.24, stan_mag: 8, rez_mag: 0, nazwa: 'Spiderman' },
  { tw_Id: 3, symbol: 'HASF5206BB', ean: '5010994116705', kody: [], cena: 5, stan_mag: 30, rez_mag: 0, nazwa: 'Pidzamersi' },
  { tw_Id: 4, symbol: 'MATHRY42', ean: '194735188840', kody: [], cena: 11, stan_mag: 2, rez_mag: 0, nazwa: 'Farma' },
];
const gt = (nad = {}) => ({
  kontrahenci: [{ kh_Id: 307543 }], vat: { vat_Id: 7 }, walutaPoziomu: 'EUR', kluczZajety: null, towary, ...nad,
});
const spec = (nad = {}) => ({
  klucz: 'K4E-1', nip: '6981850013', magazyn_id: 4, waluta: 'EUR', vat: 'ue', poziom_ceny: 5, ...nad,
  pozycje: nad.pozycje || [{ ean: '0194735230914', ilosc: 2 }, { symbol: 'HASF5206BB', ilosc: 2 }],
});

test('golyNip zdejmuje prefiks kraju i separatory', () => {
  assert.equal(m.golyNip('PL 698-185-00-13'), '6981850013');
  assert.equal(m.golyNip('6981850013'), '6981850013');
});

test('EAN z zerem wiodacym trafia w towar zapisany bez zera', () => {
  assert.deepEqual(m.dopasujPozycje({ ean: '0194735230914' }, towary).map((t) => t.tw_Id), [1]);
});

test('symbol wygrywa z EAN-em (czlowiek rozstrzygnal, ktory towar)', () => {
  assert.deepEqual(m.dopasujPozycje({ symbol: 'hasf5206bb', ean: '5010996327062' }, towary).map((t) => t.tw_Id), [3]);
});

test('zadanie: ceny z GT, VAT ue, klucz w uwagach', () => {
  const { bledy, zadanie } = m.zbudujZk(spec(), gt(), { podglad: true });
  assert.deepEqual(bledy, []);
  assert.equal(zadanie.kontrahent_id, 307543);
  assert.equal(zadanie.vat_id, 7);
  assert.equal(zadanie.rezerwacja, true);
  assert.equal(zadanie.uwagi, 'WMS-ZK:K4E-1');
  assert.deepEqual(zadanie.pozycje, [{ tw_id: 1, ilosc: 2, cena_netto: 23 }, { tw_id: 3, ilosc: 2, cena_netto: 5 }]);
});

test('odmowa: klucz juz uzyty, zly kontrahent, waluta poziomu, nieznany towar', () => {
  assert.match(m.zbudujZk(spec(), gt({ kluczZajety: 'ZK 1/2026' }), {}).bledy.join(), /juz istnieje/);
  assert.match(m.zbudujZk(spec(), gt({ kontrahenci: [] }), {}).bledy.join(), /0 kontrahentow/);
  assert.match(m.zbudujZk(spec(), gt({ walutaPoziomu: 'PLN' }), {}).bledy.join(), /w PLN, a ZK w EUR/);
  assert.match(m.zbudujZk(spec({ pozycje: [{ ean: '123', ilosc: 1 }] }), gt(), {}).bledy.join(), /0 towarow/);
  assert.match(m.zbudujZk(spec({ pozycje: [{ symbol: 'MATHXJ32', ilosc: 1.5 }] }), gt(), {}).bledy.join(), /calkowita/);
  assert.match(m.zbudujZk(spec({ pozycje: [{ symbol: 'MATHXJ32', ilosc: 1 }, { ean: '194735230914', ilosc: 1 }] }), gt(), {}).bledy.join(), /wiecej niz raz/);
});

test('ilosc ponad dostepny stan magazynu = ostrzezenie, nie blad', () => {
  const w = m.zbudujZk(spec({ pozycje: [{ ean: '194735188840', ilosc: 12 }] }), gt(), {});
  assert.deepEqual(w.bledy, []);
  assert.match(w.ostrzezenia.join(), /MATHRY42: zamawiane 12, na magazynie 4 dostepne 2/);
});

test('sprawdzPodglad lapie cene przeliczona na PLN i nadpisany VAT', () => {
  const { zadanie } = m.zbudujZk(spec(), gt(), { podglad: true });
  const ok = {
    naglowek: { wartosc_netto: 56, waluta: 'EUR', kontrahent_id: 307543 },
    pozycje: [{ tw_id: 1, ilosc: 2, cena_netto: 23, vat_id: 7 }, { tw_id: 3, ilosc: 2, cena_netto: 5, vat_id: 7 }],
  };
  assert.deepEqual(m.sprawdzPodglad(zadanie, ok), []);
  const zle = structuredClone(ok);
  zle.pozycje[0].cena_netto = 102.49;
  zle.pozycje[1].vat_id = 100001;
  zle.naglowek.wartosc_netto = 214.98;
  const r = m.sprawdzPodglad(zadanie, zle);
  assert.equal(r.length, 3);
});
