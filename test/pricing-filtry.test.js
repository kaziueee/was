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
