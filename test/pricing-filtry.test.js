'use strict';

const test = require('node:test');
const assert = require('node:assert');

const f = require('../pricing/filtry-cen');

const oferta = (o) => ({ auto: 0, kod: 'top', bb_nasz: 0, cena: 20, min: 15, ...o });
const towar = (symbol, ...rynki) => ({ symbol, rynki: Object.fromEntries(rynki.map((o, i) => [`K${i}`, oferta(o)])) });

test('filtry: zakres i sytuacja muszą się spełnić na TEJ SAMEJ ofercie', () => {
  // automat na DE (BB nasz), BB pod podłogą na FR bez automatu
  const t = towar('A', { auto: 1, bb_nasz: 1 }, { kod: 'pod_podloga' });
  assert.strictEqual(f.towarPasuje(t, 'automat', 'bb_pod_min'), false);
  assert.strictEqual(f.towarPasuje(t, 'reczne', 'bb_pod_min'), true);
  assert.strictEqual(f.towarPasuje(t, 'automat', 'bb'), true);
  assert.strictEqual(f.towarPasuje(t, 'wszystkie', 'bb_pod_min'), true);
});

test('filtry: każda sytuacja z kodów decyzji i obserwacji', () => {
  const p = (o, s) => f.ofertaPasuje(oferta(o), 'wszystkie', s);
  assert.ok(p({ kod: 'sonda' }, 'podwyzka') && p({ kod: 'podwyzka_limit' }, 'podwyzka'));
  assert.ok(p({ kod: 'top_bez_konkurencji' }, 'jedyna'));
  assert.ok(p({ kod: 'obnizka_limit' }, 'szansa'));
  // szansa bez FBA: tylko Amazon i tylko gdy BB trzyma oferta wysyłana przez sprzedawcę
  assert.ok(p({ kod: 'obnizka', platforma: 'amazon', bb_fba: 0 }, 'szansa_bez_fba'));
  assert.ok(!p({ kod: 'obnizka', platforma: 'amazon', bb_fba: 1 }, 'szansa_bez_fba'));
  assert.ok(!p({ kod: 'obnizka', platforma: 'amazon', bb_fba: null }, 'szansa_bez_fba'), 'nieznany zwycięzca = nie zgadujemy');
  assert.ok(!p({ kod: 'obnizka', platforma: 'emag', bb_fba: 0 }, 'szansa_bez_fba'), 'poza Amazonem FBA nie istnieje');
  assert.ok(!p({ kod: 'na_min', platforma: 'amazon', bb_fba: 0 }, 'szansa_bez_fba'));
  assert.ok(p({ kod: 'na_min' }, 'bb_pod_min') && p({ kod: 'na_min_limit' }, 'bb_pod_min') && p({ kod: 'pod_podloga' }, 'bb_pod_min'));
  assert.ok(p({ kod: 'remis_fba' }, 'remis') && p({ kod: 'przegrana_nie_cena' }, 'remis'));
  assert.ok(p({ kod: 'wojna_cenowa' }, 'wojna'));
  assert.ok(p({ blokada: 'Invalid price' }, 'zablokowane') && !p({}, 'zablokowane'));
  assert.ok(p({ kod: 'brak_pasa' }, 'brak_danych') && p({ kod: 'brak_ceny' }, 'brak_danych'));
  assert.ok(p({ cena: 12, min: 15 }, 'ponizej') && !p({ cena: 15, min: 15 }, 'ponizej'));
  // podniesienie do minimum już wysłane, platforma jeszcze nie pokazała — nie liczymy jako „poniżej”
  assert.ok(!p({ cena: 12, min: 15, wyslano: 1, cena_nowa: 15, dec_czas: '2026-10-15 16:30', obs_czas: '2026-10-15 16:00' }, 'ponizej'));
});

test('filtry: ręczne nie obejmują kanału tylko do odczytu; stary parametr filtr= mapowany', () => {
  assert.strictEqual(f.ofertaPasuje(oferta({ tylko_odczyt: true }), 'reczne', 'wszystkie'), false);
  assert.deepStrictEqual(f.parametry({ filtr: 'szansa' }), { zakres: 'wszystkie', sytuacja: 'szansa' });
  assert.deepStrictEqual(f.parametry({ filtr: 'automat' }), { zakres: 'automat', sytuacja: 'wszystkie' });
  assert.deepStrictEqual(f.parametry({ zakres: 'reczne', sytuacja: 'xyz' }), { zakres: 'reczne', sytuacja: 'wszystkie' });
  assert.deepStrictEqual(f.parametry({}), { zakres: 'automat', sytuacja: 'wszystkie' });
});

test('filtry: kolejność — poniżej minimum od najniższego zysku, bez rankingu po SKU; liczniki chipów', () => {
  const a = towar('A', { cena: 10, min: 15, zysk: -2 });
  const b = towar('B', { cena: 10, min: 15, zysk: -9 });
  const c = towar('C', { cena: 10, min: 15, zysk: 3 });
  assert.deepStrictEqual([a, b, c].sort(f.porownaj('wszystkie', 'ponizej')).map((t) => t.symbol), ['B', 'A', 'C']);
  assert.deepStrictEqual([c, a, b].sort(f.porownaj('wszystkie', 'jedyna')).map((t) => t.symbol), ['A', 'B', 'C']);
  const ch = f.chipy([a, b, towar('D', { auto: 1, bb_nasz: 1 })], 'automat', 'wszystkie');
  assert.strictEqual(ch.zakresy.find((x) => x.klucz === 'automat').n, 1);
  assert.strictEqual(ch.zakresy.find((x) => x.klucz === 'wszystkie').n, 3);
  assert.strictEqual(ch.sytuacje.find((x) => x.klucz === 'bb').n, 1);
  assert.strictEqual(ch.sytuacje.find((x) => x.klucz === 'ponizej').n, 0);   // przy zakresie „z automatem”
});

test('sortowanie po stanie: malejąco, bez stanu na końcu, remis zachowuje poprzednią kolejność', () => {
  const stan = { A: 5, B: null, C: 40, D: 5 };
  const w = ['A', 'B', 'C', 'D'].map((s) => ({ symbol: s })).sort(f.poStanie((t) => stan[t.symbol]));
  assert.deepStrictEqual(w.map((t) => t.symbol), ['C', 'A', 'D', 'B']);
  assert.strictEqual(f.sortuj('stan'), 'stan');
  assert.strictEqual(f.sortuj('cokolwiek'), '');
});

test('wiersze macierzy: druga oferta towaru na tym samym rynku dostaje własny wiersz, nie znika (XSH36786, 2026-10-20)', () => {
  const f = require('../pricing/filtry-cen');
  const of = (id, kol, ilosc, o = {}) => ({ id, tw_id: 88500, symbol_gt: 'XSH36786', nazwa: 'X-Shot', kolumna: kol, ilosc, sku: `S${id}`, ...o });
  const t = f.grupujTowary([of(1, 'ALLEGRO_EKAJTEK', 50), of(2, 'ALLEGRO_EKAJTEK', 50, { kod: 'obnizka' }), of(3, 'DE', 10), of(4, 'ALLEGRO_EKAJTEK', 70)],
    (o) => o.kolumna).get(88500);
  assert.strictEqual(t.rynki.ALLEGRO_EKAJTEK.id, 4);                    // największy stan w głównym wierszu
  assert.deepStrictEqual(t.dodatkowe.map((r) => Object.keys(r)), [['ALLEGRO_EKAJTEK'], ['ALLEGRO_EKAJTEK']]);
  assert.deepStrictEqual(t.dodatkowe.map((r) => r.ALLEGRO_EKAJTEK.id), [1, 2]);   // równy stan — kolejność z bazy
  assert.strictEqual(t.rynki.DE.id, 3);
  assert.strictEqual(f.ofertyTowaru(t).length, 4);
  assert.strictEqual(t.rynki.ALLEGRO_EKAJTEK.inne_oferty, 2);
  // filtr widzi ofertę z wiersza dodatkowego
  assert.strictEqual(f.towarPasuje(t, 'wszystkie', 'szansa'), true);
  assert.strictEqual(f.towarPasuje({ ...t, dodatkowe: [] }, 'wszystkie', 'szansa'), false);
});
