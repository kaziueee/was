'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { sumujWpisy, skladnik, oplatyZamowienia, DOSTAWA_ZAMKNIETA_DNI } = require('../services/analiza-billing');

const U = '8ed9bb5c-d295-11f1-8662-23ea4c574d41';

test('składniki: dopłata, prowizja, dostawa po nazwie (każdy przewoźnik ma inne id), reszta = inne', () => {
  assert.strictEqual(skladnik('PS1', 'Rabat transakcyjny w programie Allegro Ceny'), 'doplata');
  assert.strictEqual(skladnik('PSA', ''), 'doplata');
  assert.strictEqual(skladnik('SUC', 'Prowizja od sprzedaży'), 'prowizja');
  assert.strictEqual(skladnik('FSF', 'Prowizja od sprzedaży oferty wyróżnionej'), 'prowizja');
  assert.strictEqual(skladnik('DPB', 'Opłata za dostawę DPD Allegro Delivery'), 'dostawa');
  assert.strictEqual(skladnik('XYZ', 'Opłata dodatkowa za dostawę Nowy Kurier'), 'dostawa');
  assert.strictEqual(skladnik('REF', 'Zwrot kosztów'), 'inne');
});

test('sumy: wpis z obu źródeł raz, per płatność i składnik, klucz małymi literami', () => {
  const zywe = [{ id: 'A', platnosc: U.toUpperCase(), typ: 'PS1', kwota: 16.14 }, { id: 'B', platnosc: U, typ: 'SUC', nazwa: 'Prowizja', kwota: -18.4 }];
  const noc = [{ id: 'A', platnosc: U, typ: 'PS1', kwota: 16.14 }, { id: 'C', platnosc: U, typ: 'DPB', nazwa: 'Opłata za dostawę DPD', kwota: -8.99 },
    { id: 'D', platnosc: null, typ: 'SUC', kwota: -3 }];
  const m = sumujWpisy(zywe, noc);
  assert.deepStrictEqual(m.get(U), { doplata: 16.14, prowizja: -18.4, dostawa: -8.99, inne: null });
  assert.strictEqual(m.size, 1, 'wpis bez płatności (jeszcze nie dopytany) pomijamy');
});

test('hybryda: brak składnika = szacunek, dostawa po 7 dniach bez wpisu = 0', () => {
  assert.deepStrictEqual(oplatyZamowienia(undefined, 0), { doplata: 0, oplaty: null });
  const swieze = oplatyZamowienia({ doplata: 16.14, prowizja: -18.4, dostawa: null, inne: null }, 1);
  assert.deepStrictEqual(swieze, { doplata: 16.14, oplaty: { prowizja: 18.4, dostawa: null, inne: 0 } });
  assert.strictEqual(oplatyZamowienia({ doplata: null, prowizja: -18.4, dostawa: null, inne: null }, DOSTAWA_ZAMKNIETA_DNI).oplaty.dostawa, 0);
  assert.strictEqual(oplatyZamowienia({ doplata: null, prowizja: -18.4, dostawa: -8.99, inne: 2 }, 1).oplaty.inne, -2, 'zwrot kosztów obniża koszty');
  assert.deepStrictEqual(oplatyZamowienia({ doplata: 16.14, prowizja: null, dostawa: null, inne: null }, 30),
    { doplata: 16.14, oplaty: null }, 'sama dopłata bez opłat = billing niepełny, opłaty z kalkulatora');
});
