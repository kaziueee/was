'use strict';

const test = require('node:test');
const assert = require('node:assert');

const rynki = require('../config/rynki');

const g = { ...rynki.DOMYSLNE, waga: 1 };
const rynek = (n) => rynki.RYNKI.find((r) => r.nazwa === n);

test('eMAG RO jest w kalkulatorze z realnymi stawkami (VAT 21%, prowizja 16% + Genius osobno, Paxy w EUR)', () => {
  const r = rynek('eMAG RO');
  assert.ok(r, 'brak eMAG RO w RYNKI');
  assert.strictEqual(r.waluta, 'RON');
  assert.strictEqual(r.vat, 21);
  assert.strictEqual(r.prowizja, 16);
  assert.strictEqual(r.typ, 'flat');
  assert.strictEqual(r.genius.oplataZam, 'GENIUS_RO');
  assert.strictEqual(r.bezGenius.oplataZam, undefined, 'bez Genius nie ma opłaty Genius');
});

test('profil eMAG: Genius gdy wiemy, że tak, albo gdy nie wiemy; bez Genius tylko gdy wiemy, że nie', () => {
  const r = rynek('eMAG RO');
  assert.strictEqual(rynki.profilRynku(r, { genius: true }).profil, 'genius');
  assert.strictEqual(rynki.profilRynku(r, { genius: null }).profil, 'genius');
  assert.strictEqual(rynki.profilRynku(r, {}).profil, 'genius');
  const bez = rynki.profilRynku(r, { genius: false });
  assert.strictEqual(bez.profil, 'bezGenius');
  assert.strictEqual(bez.oplataZam, undefined);
  assert.ok(bez.wysylkaEur > rynki.profilRynku(r, {}).wysylkaEur, 'kurier do domu droższy niż automat');
  // rynek bez profili — bez zmian
  assert.strictEqual(rynki.profilRynku(rynek('Amazon DE'), { genius: false }), rynek('Amazon DE'));
});

test('automat paczkowy: towar mieści się w największej skrytce 47×44×39 cm w dowolnym ułożeniu', () => {
  assert.strictEqual(rynki.miesciSieWAutomacie({ dlugosc: 39, szerokosc: 47, wysokosc: 44 }), true);
  assert.strictEqual(rynki.miesciSieWAutomacie({ dlugosc: 60, szerokosc: 10, wysokosc: 10 }), false);
  assert.strictEqual(rynki.miesciSieWAutomacie({ dlugosc: 45, szerokosc: 45, wysokosc: 45 }), false);
  assert.strictEqual(rynki.miesciSieWAutomacie(null), null);
  assert.strictEqual(rynki.miesciSieWAutomacie({ dlugosc: 0, szerokosc: 10, wysokosc: 10 }), null);
});

test('towar bez Genius: bez opłaty Genius, droższy kurier, ale klient płaci 25 RON za dostawę', () => {
  const r = rynek('eMAG RO');
  const zG = rynki.wycenaPrzyCenie(20, r, { ...g, genius: true }, 81.99);
  const zB = rynki.wycenaPrzyCenie(20, r, { ...g, genius: false }, 81.99);
  assert.strictEqual(zG.detal.oplataZam, 8);
  assert.strictEqual(zB.detal.oplataZam, 0);
  assert.strictEqual(zG.detal.wysKlient, 0);
  assert.strictEqual(zB.detal.wysKlient, 25);
  // dopłata klienta liczy się po VAT i prowizji (jak cena towaru)
  const roznicaRon = (zB.zysk - zG.zysk) / g.ron;
  const wysylkaRon = (r.bezGenius.wysylkaEur - r.genius.wysylkaEur) * g.eur / g.ron;
  const zDoplaty = 25 * (1 / 1.21 - r.prowizja / 100 / 1.21);    // prowizja eMAG od netto
  const genius = 8 * r.genius.oplataZamUdzial;                    // opłata Genius oczekiwana (75%)
  assert.ok(Math.abs(roznicaRon - (zDoplaty + genius - wysylkaRon)) < 1e-9, roznicaRon);
});

test('Genius eMAG RO: stała opłata za zamówienie wg progu ceny brutto (siatka od 01.01.2026)', () => {
  const r = rynki.profilRynku(rynek('eMAG RO'), g);
  assert.strictEqual(rynki.oplataZamowienia(r, 39.99), 3);
  assert.strictEqual(rynki.oplataZamowienia(r, 40), 4);
  assert.strictEqual(rynki.oplataZamowienia(r, 49.99), 4);
  assert.strictEqual(rynki.oplataZamowienia(r, 74.99), 5);
  assert.strictEqual(rynki.oplataZamowienia(r, 75), 8);
  assert.strictEqual(rynki.oplataZamowienia(r, 500), 8);
  // rynek bez opłaty za zamówienie
  assert.strictEqual(rynki.oplataZamowienia({}, 100), 0);
});

test('Genius obniża zysk o opłatę z progu × udział zamówień klientów Genius (75%)', () => {
  const r = rynki.profilRynku(rynek('eMAG RO'), g);
  const bez = { ...r, oplataZam: undefined };
  for (const cena of [39.99, 69.99, 139.99]) {
    const a = rynki.wycenaPrzyCenie(60, r, g, cena), b = rynki.wycenaPrzyCenie(60, bez, g, cena);
    const roznicaRon = (b.zysk - a.zysk) / g.ron;
    assert.ok(Math.abs(roznicaRon - rynki.oplataZamowienia(r, cena) * 0.75) < 1e-9, `${cena}: ${roznicaRon}`);
    assert.strictEqual(a.detal.oplataZam, rynki.oplataZamowienia(r, cena));       // siatka — do pokazania
    assert.ok(Math.abs(a.detal.oplataZamOczek - rynki.oplataZamOczekiwana(r, cena)) < 1e-9);
  }
  // rynek bez `oplataZamUdzial` płaci pełną opłatę z każdego zamówienia
  assert.strictEqual(rynki.oplataZamOczekiwana({ oplataZam: 'GENIUS_RO' }, 100), 8);
});

test('prowizja eMAG liczona od ceny BEZ VAT (aneks 30.09.2026), Amazon/Allegro od brutto jak dotąd', () => {
  const r = rynek('eMAG RO');
  assert.ok(Math.abs(rynki.prowizjaUlamek(r) - 0.16 / 1.21) < 1e-12);
  assert.strictEqual(rynki.prowizjaUlamek(rynek('Allegro')), 0.133);
  // przy 89,99 RON (lalka, Genius): prowizja 16% × 74,37 netto = 11,90 RON, nie 16% × 89,99 = 14,40
  const bezProw = { ...r, prowizja: 0 };
  const a = rynki.wycenaPrzyCenie(23.13, r, { ...g, genius: true }, 89.99);
  const b = rynki.wycenaPrzyCenie(23.13, bezProw, { ...g, genius: true }, 89.99);
  assert.ok(Math.abs((b.zysk - a.zysk) / g.ron - 89.99 / 1.21 * 0.16) < 1e-9);
  // stawka oferty z eMAG (np. pluszak 18%) — nadpisanie `prowizja` w definicji rynku
  const c = rynki.wycenaPrzyCenie(23.13, { ...r, prowizja: 18 }, { ...g, genius: true }, 89.99);
  assert.ok(Math.abs((a.zysk - c.zysk) / g.ron - 89.99 / 1.21 * 0.02) < 1e-9);
});

test('Genius: cena z kalkulatora nie wisi tuż pod progiem z opłatą policzoną z niższego progu', () => {
  // Cena celuje w marżę z opłatą z progu, w którym faktycznie wylądowała (iteracja jak dopłata Smart).
  const r = rynek('eMAG RO');
  for (let koszt = 5; koszt <= 40; koszt += 0.5) {
    const w = rynki.policzRynek(koszt, r, g);
    assert.strictEqual(w.detal.oplataZam, rynki.oplataZamowienia(rynki.profilRynku(r, g), w.cena), `koszt ${koszt}`);
    assert.ok(w.zysk >= g.minzysk - 0.6, `koszt ${koszt}: zysk ${w.zysk}`);  // ,99 do najbliższej: −0,5 RON
  }
});

test('wysyłka w EUR przeliczana na walutę rynku przez kurs EUR i kurs rynku', () => {
  const r = rynki.profilRynku(rynek('eMAG RO'), g);
  const kurs = rynki.kursDla('RON', g);
  assert.ok(Math.abs(rynki.kosztWysylkiFlat(r, g, kurs) - r.wysylkaEur * g.eur / g.ron) < 1e-9);
  // rynek z `wysylka` w swojej walucie — bez przeliczania
  assert.strictEqual(rynki.kosztWysylkiFlat({ wysylka: 12 }, g, kurs), 12);
});

test('eMAG RO: cena z kalkulatora daje marżę ~20% (zaokrąglenie do ,99 tylko w górę o grosze)', () => {
  const w = rynki.policzRynek(60, rynek('eMAG RO'), g);   // koszt zakupu 60 zł netto
  assert.strictEqual(w.waluta, 'RON');
  assert.ok(/\.99$/.test(w.cena.toFixed(2)), w.cena);
  assert.ok(w.marza >= 19 && w.marza <= 22, `marża ${w.marza}`);
  assert.ok(w.zysk > 0);
});

// Zgodność dwóch dróg liczenia: koszt → cena (policzRynek) i cena → zysk (wycenaPrzyCenie) muszą
// dawać ten sam zysk przy tej samej cenie. Repricer liczy zysk drugą drogą, Cennik pierwszą —
// rozjazd oznaczałby, że ekran Ceny i zakładka Cennik mówią co innego o tym samym towarze.
test('zgodność policzRynek ↔ wycenaPrzyCenie na każdym rynku (i w obu profilach eMAG)', () => {
  for (const r of rynki.RYNKI) {
    for (const genius of [true, false, null]) {
      const gg = { ...g, genius };
      for (const koszt of [15, 60, 240]) {
        const a = rynki.policzRynek(koszt, r, gg);
        if (a.blad) continue;
        const b = rynki.wycenaPrzyCenie(koszt, r, gg, a.cena);
        assert.ok(Math.abs(a.zysk - b.zysk) < 0.01, `${r.nazwa} genius=${genius} koszt ${koszt}: ${a.zysk} vs ${b.zysk}`);
        assert.ok(Math.abs(a.marza - b.marza) < 0.01, `${r.nazwa} genius=${genius} koszt ${koszt}: marża ${a.marza} vs ${b.marza}`);
      }
    }
  }
});
