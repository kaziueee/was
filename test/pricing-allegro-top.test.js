'use strict';

const test = require('node:test');
const assert = require('node:assert');

process.env.PRICING_DB = ':memory:';
const top = require('../pricing/allegro-top');
const { db } = require('../pricing/db');

// Kształt arkuszy z services/xlsx-czytnik — kolumny jak w raporcie ekajtek z 19.10.2026.
const NAGL = ['ID oferty', 'ID produktu', 'Nazwa oferty', 'Promowanie', 'Jakość sprzedaży', 'Stan produktu', 'Jakość zdjęć',
  'Gwarancja najniższej ceny', 'Cena', 'Czas dostawy', 'Różnica w cenie'];
const wiersz = (oferta, cena, roznica, inne = {}) => [oferta, 'p-1', 'Hasbro coś', inne.promowanie || 'odpowiednie', 'odpowiednia',
  'odpowiedni', inne.zdjecia || 'odpowiednia', 'odpowiednia', cena, inne.dostawa || 'odpowiedni', roznica];
const arkusze = (wiersze, zakres = ['allegro-pl', '21818279']) => ({
  'Zakres danych': [['Rynek', 'Konto Allegro'], zakres],
  'Top oferta': [NAGL, ...wiersze],
});

test('raport Top: wiersze z numerem oferty, ocena ceny, różnica, czynniki; konto i rynek z „Zakres danych”', () => {
  const r = top.raportTopOferty(arkusze([wiersz('17734419553', 'za wysoka', 7.99, { dostawa: 'do poprawy' }),
    wiersz('17734419554', 'odpowiednia', null), [null, null, 'stopka']]));
  assert.strictEqual(r.uzytkownik, '21818279');
  assert.strictEqual(r.rynek, 'allegro-pl');
  assert.strictEqual(r.wiersze.length, 2);                  // wiersz bez numeru oferty pominięty
  assert.strictEqual(r.wiersze[0].roznica, 7.99);
  assert.strictEqual(r.wiersze[0].cena_ocena, 'za wysoka');
  assert.deepStrictEqual(top.doPoprawy(r.wiersze[0].czynniki), ['czas dostawy']);
  assert.strictEqual(r.wiersze[1].roznica, null);
});

test('raport Top: różnica jako tekst z przecinkiem też liczbą', () => {
  const r = top.raportTopOferty(arkusze([wiersz('1', 'za wysoka', '12,50')]));
  assert.strictEqual(r.wiersze[0].roznica, 12.5);
});

test('raport Top: inny plik albo zmieniony format → błąd z opisem, nie cichy import', () => {
  assert.throws(() => top.raportTopOferty({ Arkusz1: [['SKU', 'Cena']] }), /To nie jest raport/);
  assert.throws(() => top.raportTopOferty({ 'Top oferta': [['ID oferty', 'Różnica w cenie'], ['1', 2]] }), /brakuje kolumn: ID produktu/);
  assert.throws(() => top.raportTopOferty(arkusze([])), /nie ma żadnej oferty/);
});

test('cena Top kwotowo: nasza cena − różnica, tylko przy „za wysoka” i dodatniej różnicy', () => {
  assert.strictEqual(top.cenaTop(77.89, { cena_ocena: 'za wysoka', roznica: 7.99 }), 69.9);   // HASF9494
  assert.strictEqual(top.cenaTop(77.89, { cena_ocena: 'odpowiednia', roznica: null }), null);
  assert.strictEqual(top.cenaTop(77.89, { cena_ocena: 'za wysoka', roznica: 0 }), null);
  assert.strictEqual(top.cenaTop(null, { cena_ocena: 'za wysoka', roznica: 5 }), null);    // oferta nieznana repricerowi
});

const teraz = Date.parse('2026-10-19T12:00:00Z');
const wpis = (o) => ({ raport_czas: '2026-10-19 11:03:00', cena_ocena: 'za wysoka', cena_nasza: 77.89, cena_top: 69.9, ...o });

test('obserwacja z raportu: „za wysoka” → Top ma inny, jego cena = cel jak Buy Box', () => {
  const obs = top.zRaportu(wpis(), 77.89, teraz);
  assert.strictEqual(obs.bbNasz, false);
  assert.strictEqual(obs.bbCena, 69.9);
  assert.strictEqual(obs.konkurencjaNiedostepna, false);
  // cena konkurenta zostaje prawdziwa także po zmianie naszej ceny
  assert.strictEqual(top.zRaportu(wpis(), 74.99, teraz).bbCena, 69.9);
});

test('obserwacja z raportu: „odpowiednia” → my, ale tylko przy niezmienionej cenie; wyżej konkurencji nie znamy', () => {
  const ok = top.zRaportu(wpis({ cena_ocena: 'odpowiednia', cena_top: null }), 77.89, teraz);
  assert.strictEqual(ok.bbNasz, true);
  assert.strictEqual(ok.konkurencjaNiedostepna, true);
  assert.strictEqual(top.zRaportu(wpis({ cena_ocena: 'odpowiednia', cena_top: null }), 79.99, teraz), null);
});

test('obserwacja z raportu: raport starszy niż ważność albo brak wiersza → null (jak bez raportu)', () => {
  assert.strictEqual(top.zRaportu(wpis({ raport_czas: '2026-10-18 11:00:00' }), 77.89, teraz, 24), null);
  assert.ok(top.zRaportu(wpis({ raport_czas: '2026-10-18 13:00:00' }), 77.89, teraz, 24));
  assert.strictEqual(top.zRaportu(undefined, 77.89, teraz), null);
  assert.strictEqual(top.aktualny(wpis(), teraz, 1), true);
  assert.strictEqual(top.aktualny(wpis(), teraz + 3_600_000, 1), false);
});

test('zapis raportu: konto po numerze użytkownika, cena Top z naszej ceny, szanse vs minimum, wpis w zmianach', () => {
  const dodaj = db.prepare("INSERT INTO oferty (platforma, rynek, sku, asin, cena) VALUES ('allegro', 'EKAJTEK', ?, ?, ?)");
  const a = Number(dodaj.run('HASF9494', '100', 77.89).lastInsertRowid);
  const b = Number(dodaj.run('NERF7376', '200', 109.99).lastInsertRowid);
  dodaj.run('LEG1', '300', 50);
  db.prepare('INSERT INTO decyzje (oferta_id, min) VALUES (?, ?)').run(a, 60);   // Top 69,90 nad minimum → szansa
  db.prepare('INSERT INTO decyzje (oferta_id, min) VALUES (?, ?)').run(b, 100);  // Top 89,99 pod minimum
  const w = top.zapiszRaport(top.raportTopOferty(arkusze([wiersz('100', 'za wysoka', 7.99), wiersz('200', 'za wysoka', 20),
    wiersz('300', 'odpowiednia', null), wiersz('999', 'za wysoka', 1)])), 'Mati');
  assert.deepStrictEqual({ ...w, kategoria: undefined }, { konto: 'EKAJTEK', kategoria: undefined, wierszy: 4, dopasowane: 3,
    za_wysoka: 2, odpowiednia: 1, szanse: 1, ponizej_min: 1 });
  const m = top.raportyTop();
  assert.strictEqual(m.get('EKAJTEK|100').cena_top, 69.9);
  assert.strictEqual(m.get('EKAJTEK|200').cena_top, 89.99);
  assert.strictEqual(m.get('EKAJTEK|999').cena_nasza, null);   // oferta spoza repricera zapisana, bez ceny
  assert.strictEqual(m.get('EKAJTEK|100').kto, 'Mati');
  assert.match(db.prepare("SELECT opis FROM zmiany WHERE akcja = 'raport_top_allegro'").get().opis, /EKAJTEK: 4 ofert/);
  // nowszy raport nadpisuje ofertę, reszta zostaje
  top.zapiszRaport(top.raportTopOferty(arkusze([wiersz('100', 'odpowiednia', null)])), 'Mati');
  assert.strictEqual(top.raportyTop().get('EKAJTEK|100').cena_top, null);
  assert.strictEqual(top.raportyTop().get('EKAJTEK|200').cena_top, 89.99);
});

test('zapis raportu: obce konto albo inny rynek → odmowa z nazwą znanych kont', () => {
  assert.throws(() => top.zapiszRaport(top.raportTopOferty(arkusze([wiersz('1', 'za wysoka', 1)], ['allegro-pl', '123']))), /ekajtek_pl \(21818279\)/);
  assert.throws(() => top.zapiszRaport(top.raportTopOferty(arkusze([wiersz('1', 'za wysoka', 1)], ['allegro-cz', '21818279']))), /allegro-cz/);
});
