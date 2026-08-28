'use strict';

// Decyzje kolejki ruchow - czyste funkcje, test bez SQLite/GT (jak ruchy-model.test.js).
// Scenariusz przewodni to incydent NERG0319 z 2026-08-28 (patrz naglowek ruchy-kolejka.js).

const test = require('node:test');
const assert = require('node:assert');

const {
  klasyfikujOdpowiedzMostu, czyWstrzymac, czyPowtorzenie, dopasujPowtorzenie,
  czyPowtorzenieZamykaRuch, minutyMiedzy,
  LIMIT_ODMOW_SFERY, OKNO_POWTORZENIA_MIN,
  BRAK_MOSTU, ODMOWA_BIZNESOWA, ODMOWA_TECHNICZNA,
} = require('../services/ruchy-kolejka');

// --- klasyfikujOdpowiedzMostu: co liczy sie do limitu ponawiania ---

test('brak polaczenia z mostem NIE jest odmowa Sfery', () => {
  const k = klasyfikujOdpowiedzMostu({ ok: false, status: 0, dane: null, blad: 'Brak polaczenia z mostem GT' });
  assert.equal(k.rodzaj, BRAK_MOSTU);
  assert.equal(k.odSfery, false);
});

test('odpowiedz HTTP bez body tez nie jest odmowa Sfery', () => {
  // np. 502 od proxy albo most w trakcie startu - nie wiadomo, czy Sfera w ogole widziala zadanie
  const k = klasyfikujOdpowiedzMostu({ ok: false, status: 502, dane: null, blad: null });
  assert.equal(k.rodzaj, BRAK_MOSTU);
  assert.equal(k.odSfery, false);
});

test('odmowa biznesowa z nowego mostu liczy sie do limitu', () => {
  const k = klasyfikujOdpowiedzMostu({
    ok: false, status: 502, blad: null,
    dane: { sukces: false, blad: 'Brak towaru na magazynie zrodlowym (za malo sztuk do przesuniecia).', rodzaj: 'biznesowy' },
  });
  assert.equal(k.rodzaj, ODMOWA_BIZNESOWA);
  assert.equal(k.odSfery, true);
  assert.match(k.opis, /Brak towaru/);
});

test('blad techniczny Sfery tez liczy sie do limitu', () => {
  const k = klasyfikujOdpowiedzMostu({
    ok: false, status: 502, blad: null,
    dane: { sukces: false, blad: 'Blad Sfery 0x80040F1E', rodzaj: 'techniczny' },
  });
  assert.equal(k.rodzaj, ODMOWA_TECHNICZNA);
  assert.equal(k.odSfery, true);
});

test('stary most (bez pola rodzaj) - odpowiedz z bledem liczy sie jak odmowa techniczna', () => {
  // Node wdraza sie osobno od mostu; limit ma dzialac zanim most zostanie zaktualizowany
  const k = klasyfikujOdpowiedzMostu({ ok: false, status: 502, blad: null, dane: { sukces: false, blad: 'cokolwiek' } });
  assert.equal(k.rodzaj, ODMOWA_TECHNICZNA);
  assert.equal(k.odSfery, true);
});

// --- czyWstrzymac: limit ---

test('wstrzymujemy dopiero po osiagnieciu limitu odmow', () => {
  assert.equal(czyWstrzymac(0), false);
  assert.equal(czyWstrzymac(LIMIT_ODMOW_SFERY - 1), false);
  assert.equal(czyWstrzymac(LIMIT_ODMOW_SFERY), true);
  assert.equal(czyWstrzymac(LIMIT_ODMOW_SFERY + 5), true);
});

test('brak licznika (null/undefined) nie wstrzymuje', () => {
  assert.equal(czyWstrzymac(null), false);
  assert.equal(czyWstrzymac(undefined), false);
});

// --- minutyMiedzy: znaczniki UTC z SQLite ---

test('minutyMiedzy liczy roznice znacznikow z bazy', () => {
  assert.equal(minutyMiedzy('2026-08-28 11:35:56', '2026-08-28 11:36:16'), 20 / 60);
  assert.equal(minutyMiedzy('2026-08-28 11:00:00', '2026-08-28 12:30:00'), 90);
});

test('nieczytelny znacznik -> null (nie zgadujemy)', () => {
  assert.equal(minutyMiedzy(null, '2026-08-28 11:36:16'), null);
  assert.equal(minutyMiedzy('kiedys', '2026-08-28 11:36:16'), null);
});

// --- czyPowtorzenie: kiedy ruch jest duplikatem ---

// Oryginal: MM #5498, NERG0319, 15 szt. K4 -> BRK, odbity przez Sfere.
const NASZ = {
  id: 5498, artykul_gt_id: '89819', ilosc: 15,
  mag_zrodlo: 'K4', mag_cel: 'BRK', data_ruchu: '2026-08-28 11:35:56',
};
// Powtorka: ruch #5500, ta sama operacja 20 s pozniej, przeszla (MM 1242/2026).
const POWTORKA = {
  ruchId: 5500, dokNr: 'MM 1242/2026', artykul_gt_id: '89819', ilosc: 15,
  mag_zrodlo: 'K4', mag_cel: 'BRK', status: 'ok', data_ruchu: '2026-08-28 11:36:16',
};

test('reczne powtorzenie tuz po nieudanej probie = duplikat', () => {
  assert.equal(czyPowtorzenie(NASZ, POWTORKA), true);
  assert.equal(dopasujPowtorzenie(NASZ, [POWTORKA])?.dokNr, 'MM 1242/2026');
});

test('inna ilosc to nie powtorzenie', () => {
  // magazynier moze legalnie dolozyc kolejne sztuki tego samego towaru
  assert.equal(czyPowtorzenie(NASZ, { ...POWTORKA, ilosc: 10 }), false);
});

test('inny kierunek to nie powtorzenie', () => {
  assert.equal(czyPowtorzenie(NASZ, { ...POWTORKA, mag_cel: 'K4G' }), false);
  assert.equal(czyPowtorzenie(NASZ, { ...POWTORKA, mag_zrodlo: 'K4G' }), false);
});

test('inny towar to nie powtorzenie', () => {
  assert.equal(czyPowtorzenie(NASZ, { ...POWTORKA, artykul_gt_id: '89820' }), false);
});

test('kandydat, ktory sam nie przeszedl, nie zastepuje naszego ruchu', () => {
  assert.equal(czyPowtorzenie(NASZ, { ...POWTORKA, status: 'pending' }), false);
  assert.equal(czyPowtorzenie(NASZ, { ...POWTORKA, status: 'wstrzymany' }), false);
});

test('nasz wlasny dokument nie jest duplikatem samego siebie', () => {
  assert.equal(czyPowtorzenie(NASZ, { ...POWTORKA, ruchId: 5498 }), false);
});

test('ruch WCZESNIEJSZY nie jest powtorzeniem', () => {
  // powtorzenie to reakcja na blad, wiec zawsze idzie PO oryginale
  assert.equal(czyPowtorzenie(NASZ, { ...POWTORKA, data_ruchu: '2026-08-28 11:30:00' }), false);
});

test('ten sam ruch nazajutrz to normalna praca, nie duplikat', () => {
  assert.equal(czyPowtorzenie(NASZ, { ...POWTORKA, data_ruchu: '2026-08-29 11:36:16' }), false);
});

test('granica okna: tuz przed limitem duplikat, tuz za nim juz nie', () => {
  const przesun = (min) => {
    const t = new Date('2026-08-28T11:35:56Z').getTime() + min * 60000;
    return new Date(t).toISOString().replace('T', ' ').slice(0, 19);
  };
  assert.equal(czyPowtorzenie(NASZ, { ...POWTORKA, data_ruchu: przesun(OKNO_POWTORZENIA_MIN - 1) }), true);
  assert.equal(czyPowtorzenie(NASZ, { ...POWTORKA, data_ruchu: przesun(OKNO_POWTORZENIA_MIN + 1) }), false);
});

// --- czyPowtorzenieZamykaRuch: kiedy wolno zamknac sprawe bez czlowieka ---

test('ruch ze zrodlem na polce zamyka sie sam (stany juz uporzadkowane)', () => {
  // MM z lokalizacji: powtorka wymagala ponownego przypisania towaru, wiec obie strony zeszly raz
  assert.equal(czyPowtorzenieZamykaRuch({ lok_zrodlo_id: 284 }), true);
});

test('rozlozenie z puli i przyjecie z zewnatrz tylko wstrzymujemy', () => {
  // brak zrodla w WMS = powtorka mogla dolozyc ta sama ilosc drugi raz; o stanach decyduje czlowiek
  assert.equal(czyPowtorzenieZamykaRuch({ lok_zrodlo_id: null, mag_zrodlo_pula: 'K4' }), false);
  assert.equal(czyPowtorzenieZamykaRuch({ lok_zrodlo_id: null, mag_zrodlo_zewnetrzny: 'MAG' }), false);
  assert.equal(czyPowtorzenieZamykaRuch(null), false);
});

test('dopasujPowtorzenie przechodzi kandydatow i zwraca pierwszego pasujacego', () => {
  const inny = { ...POWTORKA, ruchId: 5501, dokNr: 'MM 9999/2026', ilosc: 3 };
  assert.equal(dopasujPowtorzenie(NASZ, [inny, POWTORKA])?.ruchId, 5500);
  assert.equal(dopasujPowtorzenie(NASZ, [inny]), null);
  assert.equal(dopasujPowtorzenie(NASZ, []), null);
  assert.equal(dopasujPowtorzenie(NASZ, undefined), null);
});
