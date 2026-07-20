'use strict';

// Adnotacja stref w tw_Pole1: "M2-J14-P2 +StD20 +StZ3". Czyste funkcje - test nie dotyka
// SQLite ani GT (jak test/rozbij-stan-k4.test.js).

const test = require('node:test');
const assert = require('node:assert');

const { bezAdnotacjiStref, zbudujAdnotacjeStref, zlozPole, decyzjaAdnotacji, SKROTY_STREF, KOLEJNOSC_STREF } =
  require('../services/adnotacja-stref');
// Kanoniczna lista rodzajow stref z modulu BEZ zaleznosci od GT/SQLite - inaczej ten test
// czystej logiki ciagnalby przez gt-dokumenty otwarcie db/wms.db i kolidowal rownolegle z
// innymi plikami testowymi ("database is locked").
const { KUBELKI_STREF } = require('../services/rozbicie-stanu');

// --- budowanie ---

test('buduje adnotacje z ilosci per rodzaj', () => {
  assert.equal(zbudujAdnotacjeStref({ dostawa: 20, zwrot: 3 }), ' +StD20 +StZ3');
});

test('zera i rodzaje bez sztuk sa pomijane', () => {
  assert.equal(zbudujAdnotacjeStref({ dostawa: 0, zwrot: 3, przywozka: 0 }), ' +StZ3');
  assert.equal(zbudujAdnotacjeStref({}), '');
  assert.equal(zbudujAdnotacjeStref(null), '');
});

test('kolejnosc jest STALA, niezalezna od kolejnosci kluczy wejscia', () => {
  const a = zbudujAdnotacjeStref({ zwrot: 3, przywozka: 1, dostawa: 20 });
  const b = zbudujAdnotacjeStref({ dostawa: 20, przywozka: 1, zwrot: 3 });
  assert.equal(a, b, 'ta sama tresc musi dac ten sam tekst - inaczej job pisalby do GT bez powodu');
  assert.equal(a, ' +StP1 +StD20 +StZ3');
});

test('przycina do limitu, zachowujac wczesniejsze rodzaje', () => {
  // ' +StP1' = 6 znakow, ' +StD20' = 7. Limit 6 miesci tylko pierwszy.
  assert.equal(zbudujAdnotacjeStref({ przywozka: 1, dostawa: 20 }, 6), ' +StP1');
  assert.equal(zbudujAdnotacjeStref({ przywozka: 1, dostawa: 20 }, 13), ' +StP1 +StD20');
  assert.equal(zbudujAdnotacjeStref({ dostawa: 20 }, 3), '', 'gdy nie miesci sie nic - pusto');
});

// --- zdejmowanie ---

test('zdejmuje adnotacje (nowy format St*), zostawiajac sam adres', () => {
  assert.equal(bezAdnotacjiStref('M2-J14-P2 +StD20 +StZ3'), 'M2-J14-P2');
  assert.equal(bezAdnotacjiStref('M2-J14-P2 +StZ3'), 'M2-J14-P2');
  assert.equal(bezAdnotacjiStref('M2-J14-P2 +StPW7'), 'M2-J14-P2');
});

test('KOMPAT WSTECZ: stary format bez prefiksu (+D20/+P1/+PW7) tez daje sie zdjac', () => {
  // dopiski zapisane przed zmiana skrotow (2026-07-20) musza dac sie zmigrowac/zdjac
  assert.equal(bezAdnotacjiStref('M2-J14-P2 +D20 +Z3'), 'M2-J14-P2');
  assert.equal(bezAdnotacjiStref('M2-A7 +P1'), 'M2-A7');
  assert.equal(bezAdnotacjiStref('M2-J14-P2 +PW7'), 'M2-J14-P2');
  assert.equal(bezAdnotacjiStref('+D20'), '');                   // stary znacznik na pustym polu
  assert.equal(bezAdnotacjiStref('M2-A7 +P1 +StZ3'), 'M2-A7');   // mieszanka stary+nowy w trakcie migracji
});

test('adres bez adnotacji zostaje nietkniety', () => {
  assert.equal(bezAdnotacjiStref('M2-J14-P2'), 'M2-J14-P2');
  assert.equal(bezAdnotacjiStref('  D3  '), 'D3');
  assert.equal(bezAdnotacjiStref(''), '');
  assert.equal(bezAdnotacjiStref(null), '');
  assert.equal(bezAdnotacjiStref(undefined), '');
});

test('adres z czlonem "zapas" (kod/zapas) przezywa zdjecie adnotacji', () => {
  assert.equal(bezAdnotacjiStref('M2-J14-P2/M2-B37 +StZ3'), 'M2-J14-P2/M2-B37');
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
  for (const rodzaj of Object.keys(KUBELKI_STREF)) {
    assert.ok(SKROTY_STREF[rodzaj], `rodzaj "${rodzaj}" nie ma skrotu w SKROTY_STREF`);
    assert.ok(KOLEJNOSC_STREF.includes(rodzaj), `rodzaj "${rodzaj}" nie ma miejsca w KOLEJNOSC_STREF`);
  }
});

test('skroty sa unikalne (inaczej dwa rodzaje zlalyby sie w polu)', () => {
  const skroty = Object.values(SKROTY_STREF);
  assert.equal(new Set(skroty).size, skroty.length, `duplikat w skrotach: ${skroty.join(', ')}`);
});

test('skroty maja prefiks "St" (Strefa) - nie myla sie z poziomem polki inline w adresie', () => {
  for (const skrot of Object.values(SKROTY_STREF)) {
    assert.ok(/^St[A-Z]{1,2}$/.test(skrot), `skrot "${skrot}" nie pasuje do wzorca St<litery>`);
  }
});

// --- pole bez adresu: sam znacznik "+StD20" (SKU bez domu, tylko sztuki w strefie) ---

test('znacznik na PUSTYM polu ("+StD20") daje sie zdjac mimo braku wiodacej spacji', () => {
  // job trimuje odczyt, wiec " +StD20" wraca jako "+StD20" - musi byc strippowalne, inaczej
  // znacznik zostalby na wieki (job pisalby go w kolko).
  assert.equal(bezAdnotacjiStref('+StD20'), '');
  assert.equal(bezAdnotacjiStref('+StD20 +StZ3'), '');
  assert.equal(bezAdnotacjiStref('+StPW7'), '');
});

test('pojedynczy plus w srodku/na koncu bez cyfry NIE jest znacznikiem', () => {
  assert.equal(bezAdnotacjiStref('A/B+C'), 'A/B+C');
  assert.equal(bezAdnotacjiStref('PAKIET + gratis'), 'PAKIET + gratis');
  assert.equal(bezAdnotacjiStref('+2GRATIS'), '+2GRATIS');   // po plusie cyfra, nie litera - nie nasz format
});

test('zapas na poczatku pola (bez adresu) tez przezywa - "C2P3" nie jest znacznikiem', () => {
  assert.equal(bezAdnotacjiStref('C2P3'), 'C2P3');
});

// --- zlozPole: skladanie docelowego tw_Pole1 ---

test('zlozPole: baza + adnotacja; pusta baza -> sam znacznik bez wiodacej spacji', () => {
  assert.equal(zlozPole('M2-A7', ' +StP1'), 'M2-A7 +StP1');
  assert.equal(zlozPole('M2-A7/C2P3', ' +StD20'), 'M2-A7/C2P3 +StD20');
  assert.equal(zlozPole('', ' +StD20'), '+StD20');       // brak adresu -> "+StD20", NIE " +StD20"
  assert.equal(zlozPole('', ''), '');
  assert.equal(zlozPole('M2-A7', ''), 'M2-A7');
});

test('zlozPole + bezAdnotacjiStref: stabilna runda dla pustej bazy (brak flip-flopa)', () => {
  const zapis = zlozPole('', zbudujAdnotacjeStref({ dostawa: 20 }));  // "+StD20"
  assert.equal(zapis, '+StD20');
  assert.equal(bezAdnotacjiStref(zapis), '');                        // baza po odczycie = "" (stabilnie)
});

// --- decyzjaAdnotacji: decyzja joba dla jednego pola ---

test('decyzja: dopisanie znacznika do adresu (dom WMS)', () => {
  const d = decyzjaAdnotacji({ base: 'M2-A7', obecne: 'M2-A7', adnotacja: ' +StP1', maDomWms: true });
  assert.deepEqual(d, { docelowe: 'M2-A7 +StP1', pisz: true, akcja: 'dopisane' });
});

test('decyzja: zdjecie znacznika po rozlozeniu (strefa = 0)', () => {
  const d = decyzjaAdnotacji({ base: 'M2-A7', obecne: 'M2-A7 +StP1', adnotacja: '', maDomWms: true });
  assert.deepEqual(d, { docelowe: 'M2-A7', pisz: true, akcja: 'zdjete' });
});

test('decyzja: MIGRACJA starego formatu - "M2-A7 +P1" -> "M2-A7 +StP1"', () => {
  // pole zapisane starym jobem: baza z WMS = "M2-A7", faktyczna przywozka = 1 (adnotacja nowa)
  const d = decyzjaAdnotacji({ base: 'M2-A7', obecne: 'M2-A7 +P1', adnotacja: ' +StP1', maDomWms: true });
  assert.deepEqual(d, { docelowe: 'M2-A7 +StP1', pisz: true, akcja: 'dopisane' });
});

test('decyzja: nic do zrobienia, gdy pole juz zgodne (nowy format)', () => {
  assert.equal(decyzjaAdnotacji({ base: 'M2-A7', obecne: 'M2-A7 +StP1', adnotacja: ' +StP1', maDomWms: true }).pisz, false);
  assert.equal(decyzjaAdnotacji({ base: 'M2-A7', obecne: 'M2-A7', adnotacja: '', maDomWms: true }).pisz, false);
});

test('decyzja: dom WMS chroni pole, gdy GT trzyma INNA baze (reczna edycja / zalegly sync)', () => {
  // baza WMS = "M2-A7", ale GT ma "CZYJES-AUTOR" - to NIE robota tego joba, zostawiamy
  const d = decyzjaAdnotacji({ base: 'M2-A7', obecne: 'CZYJES-AUTOR', adnotacja: ' +StP1', maDomWms: true });
  assert.equal(d.pisz, false);
  assert.equal(d.powod, 'baza-inna');
});

test('decyzja: BEZ domu straznik nie bije - dopisujemy do adresu z GT (tez smieciowego)', () => {
  // baza = to, co w GT bez dopisku (tak liczy job dla SKU bez domu)
  const smieciowa = 'RB/M2-B36-P1 /';
  const d = decyzjaAdnotacji({ base: smieciowa, obecne: smieciowa, adnotacja: ' +StD20', maDomWms: false });
  assert.deepEqual(d, { docelowe: 'RB/M2-B36-P1 / +StD20', pisz: true, akcja: 'dopisane' });
  assert.equal(bezAdnotacjiStref(d.docelowe), smieciowa, 'odwracalne - zdjecie odtwarza smieciowy adres');
});

test('decyzja: BEZ domu i BEZ adresu - sam znacznik na pustym polu, potem zdejmowalny', () => {
  const dopisz = decyzjaAdnotacji({ base: '', obecne: '', adnotacja: ' +StD20', maDomWms: false });
  assert.deepEqual(dopisz, { docelowe: '+StD20', pisz: true, akcja: 'dopisane' });
  // po zestarzeniu dokumentu (strefa=0): baza = bezAdnotacjiStref("+StD20") = "", znacznik znika
  const zdejmij = decyzjaAdnotacji({ base: '', obecne: '+StD20', adnotacja: '', maDomWms: false });
  assert.deepEqual(zdejmij, { docelowe: '', pisz: true, akcja: 'zdjete' });
});
