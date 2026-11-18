'use strict';

const test = require('node:test');
const assert = require('node:assert');

const sm = require('../services/sciezka-wystawienia-model');

const KOMPLET = {
  tw_id: 1, symbol: 'FUN02390', sklep: true, cena3: 69.99, ean: '830395023908', waga: '0,15',
  wymiary_rozbite: { dlugosc: 16, szerokosc: 11, wysokosc: 9 },
};

test('GT: komplet danych = brak braków', () => {
  assert.deepStrictEqual(sm.brakiGt(KOMPLET), []);
});

test('GT: flaga, cena Specjalna, EAN, waga bez przecinka, wymiary — każdy brak osobno', () => {
  const b = sm.brakiGt({ sklep: false, cena3: 0, ean: 'ABC', waga: '916', wymiary_rozbite: null });
  assert.deepStrictEqual(b.map((x) => x.pole), ['flaga', 'cena', 'ean', 'waga', 'wymiary']);
  assert.match(b.find((x) => x.pole === 'waga').tekst, /bez przecinka/);
});

test('GT: brak danych o fladze = brak flagi (nie zgadujemy)', () => {
  assert.deepStrictEqual(sm.brakiGt({ ...KOMPLET, sklep: undefined }).map((x) => x.pole), ['flaga']);
});

const FEED = `<?xml version="1.0"?><feed>
<entry><title><![CDATA[Funko]]></title><g:link>https://poszukiwaczefrajdy.pl/funko-maul</g:link><g:id>38240</g:id><g:price>69.99 PLN</g:price><g:mpn>FUN02390</g:mpn></entry>
<entry><g:id>100</g:id><g:price>10.00 PLN</g:price><g:mpn><![CDATA[ nerchikambt ]]></g:mpn></entry>
<entry><g:id>200</g:id><g:price>12.00 PLN</g:price><g:mpn>NERCHIKAMBT</g:mpn></entry>
<entry><g:id>abc</g:id><g:mpn>ZLE</g:mpn></entry>
<entry><g:id>300</g:id><g:price>5.00 PLN</g:price></entry>
</feed>`;

test('feed: symbol z g:mpn (wielkie litery, bez spacji, także CDATA), cena, link', () => {
  const f = sm.parsujFeed(FEED);
  assert.deepStrictEqual(f.get('FUN02390'), { id: 38240, cena: 69.99, link: 'https://poszukiwaczefrajdy.pl/funko-maul', duplikaty: 1 });
  assert.strictEqual(f.has('ZLE'), false);       // id nie jest liczbą
  assert.strictEqual(f.size, 2);                 // wpis bez mpn pominięty
});

test('feed: ten sam kod na dwóch kartach — najnowsza karta i licznik duplikatów', () => {
  const w = sm.parsujFeed(FEED).get('NERCHIKAMBT');
  assert.strictEqual(w.id, 200);
  assert.strictEqual(w.duplikaty, 2);
});

test('sklep: w feedzie z ceną = jest; odhaczenie bez feedu = czeka na Base; padnięty feed = nieznany, nie brak', () => {
  assert.strictEqual(sm.krokSklep({ feed: { id: 1, cena: 9.99 } }).status, 'jest');
  const c = sm.krokSklep({ feed: null, odhaczenie: { karta_id: 38249, czas: '2026-11-18 10:00:00', kto: 'ala' } });
  assert.strictEqual(c.status, 'czeka_na_base');
  assert.strictEqual(c.karta_id, 38249);
  assert.strictEqual(sm.krokSklep({ feed: null, feedZnany: false }).status, 'nieznany');
  assert.strictEqual(sm.krokSklep({ feed: null }).status, 'brak');
});

test('Allegro: aktywna świeża oferta na którymkolwiek koncie = krok zrobiony; stara = nieaktywna', () => {
  const a = sm.krokAllegro([{ rynek: 'NATROPIE', asin: '191', aktywna: 1, swieza: true, cena: 50 }]);
  assert.strictEqual(a.ok, true);
  assert.strictEqual(a.konta.EKAJTEK.status, 'brak');
  assert.strictEqual(a.konta.NATROPIE.oferta, '191');
  const b = sm.krokAllegro([{ rynek: 'EKAJTEK', asin: '7', aktywna: 0, swieza: false }]);
  assert.strictEqual(b.ok, false);
  assert.strictEqual(b.konta.EKAJTEK.status, 'nieaktywna');
  // aktywna, ale sync nie widział jej od dni — nie liczymy jako „jest”
  assert.strictEqual(sm.krokAllegro([{ rynek: 'EKAJTEK', aktywna: 1, swieza: false }]).ok, false);
});

test('rynek: kolejność rozstrzygania', () => {
  const kat = { produkt_id: 'PNK1', dodac: 1 };
  assert.strictEqual(sm.stanRynku({ oferty: [{ aktywna: 1, swieza: true, cena: 5 }], katalog: kat }).status, 'oferta');
  assert.strictEqual(sm.stanRynku({ katalog: kat, wystawienie: { status: 'wyslane' } }).status, 'w_toku');
  assert.strictEqual(sm.stanRynku({ oferty: [{ aktywna: 0 }], katalog: kat }).status, 'nieaktywna');
  assert.strictEqual(sm.stanRynku({ katalog: { ...kat, mamy: 1 } }).status, 'oferta');
  assert.strictEqual(sm.stanRynku({}).status, 'nie_sprawdzono');
  assert.strictEqual(sm.stanRynku({ katalog: { produkt_id: null } }).status, 'brak_karty');
  assert.strictEqual(sm.stanRynku({ katalog: { ...kat, dodac: 0 } }).status, 'zablokowane');
  assert.strictEqual(sm.stanRynku({ katalog: { ...kat, ograniczenie: 'marka Hasbro' } }).powod, 'marka Hasbro');
  assert.strictEqual(sm.stanRynku({ katalog: kat, wystawienie: { status: 'odrzucone', opis: 'EAN' } }).status, 'odrzucone');
  assert.strictEqual(sm.stanRynku({ katalog: kat }).status, 'mozna');
  assert.strictEqual(sm.stanRynku({ katalog: kat, gtOk: false }).status, 'czeka_na_dane');
});

test('rynki: tylko rynki gotowe do wystawiania (eMAG HU/BG bez testu nie trzymają towaru)', () => {
  const klucze = sm.RYNKI.map((r) => r.klucz);
  assert.ok(klucze.includes('emag:RO'));
  assert.ok(!klucze.includes('emag:HU'));
  const r = sm.krokRynki(new Map([['emag:RO', { katalog: { produkt_id: 'X' } }]]), true);
  assert.strictEqual(r.rynki['emag:RO'].status, 'mozna');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.mozna, 1);
  // te same dane, ale braki w GT — rynek czeka na dane, krok 4 nie trzyma towaru
  assert.strictEqual(sm.krokRynki(new Map([['emag:RO', { katalog: { produkt_id: 'X' } }]]), false).ok, true);
});

test('etap = pierwszy niezrobiony krok', () => {
  assert.strictEqual(sm.ocenTowar({ ...KOMPLET, sklep: false }).etap, 'gt');
  assert.strictEqual(sm.ocenTowar(KOMPLET, { feed: null }).etap, 'sklep');
  const wSklepie = { feed: { id: 1, cena: 69.99 } };
  assert.strictEqual(sm.ocenTowar(KOMPLET, wSklepie).etap, 'allegro');
  const zAllegro = { ...wSklepie, allegro: [{ rynek: 'EKAJTEK', aktywna: 1, swieza: true }] };
  assert.strictEqual(sm.ocenTowar(KOMPLET, { ...zAllegro, rynki: new Map([['empik:PL', { katalog: { produkt_id: '1' } }]]) }).etap, 'rynki');
  assert.strictEqual(sm.ocenTowar(KOMPLET, zAllegro).etap, 'gotowe');
});

test('podsumowanie liczy towary na etapach', () => {
  const p = sm.podsumuj([{ etap: 'gt' }, { etap: 'gt' }, { etap: 'gotowe' }]);
  assert.strictEqual(p.towarow, 3);
  assert.strictEqual(p.etapy.gt, 2);
  assert.strictEqual(p.etapy.sklep, 0);
  assert.strictEqual(p.etapy.gotowe, 1);
});
