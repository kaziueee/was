'use strict';

// Adnotacja stref w tw_Pole1: "M2-J14-P2 +D20 +Z3". Czyste funkcje - test nie dotyka
// SQLite ani GT (jak test/rozbij-stan-k4.test.js).

const test = require('node:test');
const assert = require('node:assert');

const { bezAdnotacjiStref, zbudujAdnotacjeStref, SKROTY_STREF, KOLEJNOSC_STREF } =
  require('../services/adnotacja-stref');
const { RODZAJE_STREF } = require('../services/gt-dokumenty');

// --- budowanie ---

test('buduje adnotacje z ilosci per rodzaj', () => {
  assert.equal(zbudujAdnotacjeStref({ dostawa: 20, zwrot: 3 }), ' +D20 +Z3');
});

test('zera i rodzaje bez sztuk sa pomijane', () => {
  assert.equal(zbudujAdnotacjeStref({ dostawa: 0, zwrot: 3, przywozka: 0 }), ' +Z3');
  assert.equal(zbudujAdnotacjeStref({}), '');
  assert.equal(zbudujAdnotacjeStref(null), '');
});

test('kolejnosc jest STALA, niezalezna od kolejnosci kluczy wejscia', () => {
  const a = zbudujAdnotacjeStref({ zwrot: 3, przywozka: 1, dostawa: 20 });
  const b = zbudujAdnotacjeStref({ dostawa: 20, przywozka: 1, zwrot: 3 });
  assert.equal(a, b, 'ta sama tresc musi dac ten sam tekst - inaczej job pisalby do GT bez powodu');
  assert.equal(a, ' +P1 +D20 +Z3');
});

test('przycina do limitu, zachowujac wczesniejsze rodzaje', () => {
  // ' +P1' = 4 znaki, ' +D20' = 5. Limit 6 miesci tylko pierwszy.
  assert.equal(zbudujAdnotacjeStref({ przywozka: 1, dostawa: 20 }, 6), ' +P1');
  assert.equal(zbudujAdnotacjeStref({ przywozka: 1, dostawa: 20 }, 9), ' +P1 +D20');
  assert.equal(zbudujAdnotacjeStref({ dostawa: 20 }, 3), '', 'gdy nie miesci sie nic - pusto');
});

// --- zdejmowanie ---

test('zdejmuje adnotacje, zostawiajac sam adres', () => {
  assert.equal(bezAdnotacjiStref('M2-J14-P2 +D20 +Z3'), 'M2-J14-P2');
  assert.equal(bezAdnotacjiStref('M2-J14-P2 +Z3'), 'M2-J14-P2');
  assert.equal(bezAdnotacjiStref('M2-J14-P2 +PW7'), 'M2-J14-P2');
});

test('adres bez adnotacji zostaje nietkniety', () => {
  assert.equal(bezAdnotacjiStref('M2-J14-P2'), 'M2-J14-P2');
  assert.equal(bezAdnotacjiStref('  D3  '), 'D3');
  assert.equal(bezAdnotacjiStref(''), '');
  assert.equal(bezAdnotacjiStref(null), '');
  assert.equal(bezAdnotacjiStref(undefined), '');
});

test('adres z czlonem "zapas" (kod/zapas) przezywa zdjecie adnotacji', () => {
  assert.equal(bezAdnotacjiStref('M2-J14-P2/M2-B37 +Z3'), 'M2-J14-P2/M2-B37');
  assert.equal(bezAdnotacjiStref('C2/C2P3'), 'C2/C2P3');
});

test('smieciowe pola z GT nie sa kaleczone', () => {
  // realne wartosci z produkcji - nie moga stracic znakow przez pomylke z adnotacja
  assert.equal(bezAdnotacjiStref('RB/M2-B37 - sciana /'), 'RB/M2-B37 - sciana /');
  assert.equal(bezAdnotacjiStref('A1 sciana /'), 'A1 sciana /');
  assert.equal(bezAdnotacjiStref('D10 /'), 'D10 /');
});

test('runda w obie strony: adres -> +adnotacja -> adres', () => {
  for (const adres of ['D3', 'M2-J14-P2', 'M2-J14-P2/M2-B37', 'A17P2']) {
    const zAdnotacja = `${adres}${zbudujAdnotacjeStref({ dostawa: 20, zwrot: 3 })}`;
    assert.equal(bezAdnotacjiStref(zAdnotacja), adres);
  }
});

// --- straznik przed cichym zgubieniem rodzaju ---

test('KAZDY rodzaj strefy ma skrot (nowy rodzaj nie wypadnie po cichu)', () => {
  for (const rodzaj of Object.keys(RODZAJE_STREF)) {
    assert.ok(SKROTY_STREF[rodzaj], `rodzaj "${rodzaj}" nie ma skrotu w SKROTY_STREF`);
    assert.ok(KOLEJNOSC_STREF.includes(rodzaj), `rodzaj "${rodzaj}" nie ma miejsca w KOLEJNOSC_STREF`);
  }
});

test('skroty sa unikalne (inaczej dwa rodzaje zlalyby sie w polu)', () => {
  const skroty = Object.values(SKROTY_STREF);
  assert.equal(new Set(skroty).size, skroty.length, `duplikat w skrotach: ${skroty.join(', ')}`);
});
