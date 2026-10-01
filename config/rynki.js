'use strict';

// Reguly wyceny na marketplace - czysty modul (bez DB/GT), testowalny jak config/kartony.
// Zasada #5: reguly biznesowe zyja w backendzie; panel desktopu tylko wyswietla wynik.
//
// Model (spojny dla wszystkich rynkow):
//   koszty   = koszt_zakupu + NASZ koszt wysylki + obsluga        (w walucie rynku)
//   total    = cena_towaru + wysylka_klienta  (to placi kupujacy; prowizja i VAT licza sie od total)
//   cena_towaru = total - wysylka_klienta
//   prowizja i VAT (kraju) sa wliczone w mianownik D; marza liczona od przychodu netto.
// Zrodla liczb: Allegro - realne rozliczenia (~94 tys. zam.); Amazon EU - umowa DHL Parcel Connect;
// koszt zakupu - tw_Cena.tc_CenaNetto0 z GT (patrz services/cennik.js).

// --- parametry wspolne (preset; panel pracownika ich nie edytuje) ---
const DOMYSLNE = {
  marza: 20,        // % od przychodu netto (gdy tryb 'marza')
  tryb: 'marza',    // 'marza' | 'zysk' | 'kotwica' (FR/IT/ES/NL celuja w zysk Amazon DE + bufor)
  celZysk: 20,      // docelowy zysk netto w zl (gdy tryb 'zysk')
  bufor: 5,         // bufor zwrotow (zl) doliczany do zysku-kotwicy DE na rynkach kotwiczacych (tryb 'kotwica')
  obsluga: 3,       // pakowanie/robocizna, zl na zamowienie
  minzysk: 5,       // prog min. zysku netto (zl) - podbija cene
  eur: 4.20,        // PLN za 1 EUR (ostrozny kurs)
  ron: 0.90,        // PLN za 1 RON
  paliwowa: 14,     // doplata paliwowa DHL %
  vatProwizji: 23,  // prowizja Amazon to netto -> dolicz VAT (reverse-charge PL)
  ads: 3,           // narzut Allegro Ads/promo %
  waga: 1,          // waga rozliczeniowa (kg) - do stawki DHL
};

// Rynki (preset). typ: 'allegro' | 'amazon-dhl' | 'flat'.
const RYNKI = [
  { nazwa: 'Allegro',     kraj: 'PL', waluta: 'PLN', vat: 23, prowizja: 13.3, typ: 'allegro' },
  { nazwa: 'Amazon DE',   kraj: 'DE', waluta: 'EUR', vat: 19, prowizja: 15, wysKlient: 4.99, typ: 'amazon-dhl' },
  // kotwica:true -> w trybie 'kotwica' celuja w zysk Amazon DE + bufor (zamiast wlasnej marzy) - drozsze zwroty
  { nazwa: 'Amazon FR',   kraj: 'FR', waluta: 'EUR', vat: 20, prowizja: 15, wysKlient: 4.99, typ: 'amazon-dhl', kotwica: true },
  { nazwa: 'Amazon IT',   kraj: 'IT', waluta: 'EUR', vat: 22, prowizja: 15, wysKlient: 4.99, typ: 'amazon-dhl', kotwica: true },
  { nazwa: 'Amazon ES',   kraj: 'ES', waluta: 'EUR', vat: 21, prowizja: 15, wysKlient: 4.99, typ: 'amazon-dhl', kotwica: true },
  { nazwa: 'Amazon NL',   kraj: 'NL', waluta: 'EUR', vat: 21, prowizja: 15, wysKlient: 4.99, typ: 'amazon-dhl', kotwica: true },
  // eMag RO usunięty z listy do czasu domknięcia (prowizja realna ~16,37%, wysyłka Paxy realnie ~2,10 EUR/paczka).
  // Dane i jak wznowić: pliki wiedzy emag-oplaty-realne + paxy-stawki (Projekty AI/ERP DASHBOARD).
  // Kaufland DE: ta sama umowa DHL do Niemiec co Amazon DE (koszt po wadze). Prowizja 13% dla zabawek
  // (kauflandglobalmarketplace.com/en/conditions) - od ceny BRUTTO wraz z wysylka, netto + VAT -> model amazon-dhl.
  { nazwa: 'Kaufland DE', kraj: 'DE', waluta: 'EUR', vat: 19, prowizja: 13, wysKlient: 4.99, typ: 'amazon-dhl' },
];

// DHL Parcel Connect - cena netto PLN po rabacie, wg wagi (umowa Okitrade 06.2026). NASZ koszt.
const DHL_STAWKI = {
  DE: [[1, 13.80], [3, 13.90], [5, 14.30], [10, 18.50], [20, 29.26], [31.5, 43.68]],
  FR: [[1, 20.90], [3, 22.95], [5, 24.70], [10, 48.83], [20, 80.39], [31.5, 98.32]],
  IT: [[1, 19.50], [3, 20.70], [5, 21.66], [10, 32.96], [20, 38.69], [31.5, 41.80]],
  ES: [[1, 21.08], [3, 24.93], [5, 26.57], [10, 37.49], [20, 48.98], [31.5, 61.33]],
  NL: [[1, 18.93], [3, 20.99], [5, 22.55], [10, 28.50], [20, 36.93], [31.5, 52.59]],
};

// Allegro: dopłata Smart NETTO (po rabacie) wg progu wartosci zamowienia. 0 ponizej 45 zl (nie-Smart).
const ALLEGRO_PROGI = [[45, 0], [65, 2.1], [100, 3.2], [150, 5.5], [200, 7.6], [500, 7.5], [Infinity, 11]];

// --- helpery (czyste) ---
const kursDla = (waluta, g) => (waluta === 'EUR' ? +g.eur || 0 : waluta === 'RON' ? +g.ron || 0 : 1);

// zaokraglenie do NAJBLIZSZEJ koncowki ,99 (nie zawsze w gore - inaczej cena tuz nad cala zlotowka
// skakalaby o ~1 i marza rozjezdzalaby sie w gore).
function do99(x) {
  const hi = Math.floor(x) + 0.99, lo = hi - 1;
  const best = (x - lo) < (hi - x) ? lo : hi;
  return best > 0 ? best : hi;
}

// docelowy total: tryb 'marza' -> koszty/D; tryb 'zysk' -> taki, ze zysk netto = celZysk (waluta rynku).
function totalCelu(koszty, D, denomZysk, kurs, g) {
  if (g.tryb === 'zysk') return (koszty + (+g.celZysk || 0) / kurs) / denomZysk;
  return koszty / D;
}

function doplataSmartAllegro(cena) {
  for (const [gr, d] of ALLEGRO_PROGI) if (cena < gr) return d;
  return 11;
}

function stawkaDHL(kraj, waga) {
  const t = DHL_STAWKI[kraj];
  if (!t) return null;
  for (const [maxW, cena] of t) if (waga <= maxW) return cena;
  return null; // powyzej 31,5 kg - poza Parcel Connect
}

// --- wycena jednego rynku -> { nazwa, kraj, waluta, cena, zysk, marza, status, detal } ---
function wynik(r, pola) {
  return { nazwa: r.nazwa, kraj: r.kraj, waluta: r.waluta, ...pola };
}

function policzFlat(kosztPLN, r, g) {
  const kurs = kursDla(r.waluta, g);
  if (kurs <= 0) return wynik(r, { blad: 'brak kursu', status: 'bad' });
  const v = (+r.vat || 0) / 100, p = (+r.prowizja || 0) / 100, m = (+g.marza || 0) / 100;
  const kosztWys = +r.wysylka || 0, S = +r.wysKlient || 0;
  const koszty = kosztPLN / kurs + kosztWys + (+g.obsluga || 0) / kurs;
  const D = (1 - m) / (1 + v) - p, denomZysk = 1 / (1 + v) - p;
  if (D <= 0 || denomZysk <= 0) return wynik(r, { blad: 'reguły niespójne', status: 'bad' });
  const totalCel = totalCelu(koszty, D, denomZysk, kurs, g);
  const totalFloor = (koszty + (+g.minzysk || 0) / kurs) / denomZysk;
  const floorBinds = totalFloor > totalCel + 1e-9;
  let pb = do99(Math.max(totalCel, totalFloor) - S);
  if (pb < 0.99) pb = 0.99;
  const total = pb + S, pn = total / (1 + v);
  const zysk = total * denomZysk - koszty;
  return wynik(r, { cena: pb, zysk: zysk * kurs, marza: pn > 0 ? zysk / pn * 100 : 0,
    status: floorBinds ? 'warn' : 'ok', detal: { kosztWys, wysKlient: S } });
}

function policzAllegro(kosztPLN, r, g) {
  const v = (+r.vat || 0) / 100, m = (+g.marza || 0) / 100;
  const p = ((+r.prowizja || 0) + (+g.ads || 0)) / 100; // prowizja + Ads (% od ceny)
  const obs = +g.obsluga || 0;
  const D = (1 - m) / (1 + v) - p, denomZysk = 1 / (1 + v) - p;
  if (D <= 0 || denomZysk <= 0) return wynik(r, { blad: 'reguły niespójne', status: 'bad' });
  let dost = 0, pb = 0;
  for (let it = 0; it < 6; it++) {
    pb = totalCelu(kosztPLN + dost + obs, D, denomZysk, 1, g);
    const nd = doplataSmartAllegro(pb);
    if (Math.abs(nd - dost) < 1e-9) { dost = nd; break; }
    dost = nd;
  }
  const pbFloor = (kosztPLN + dost + obs + (+g.minzysk || 0)) / denomZysk;
  const floorBinds = pbFloor > pb + 1e-9;
  pb = do99(Math.max(pb, pbFloor));
  dost = doplataSmartAllegro(pb);
  const pn = pb / (1 + v), zysk = pb * denomZysk - (kosztPLN + dost + obs);
  return wynik(r, { cena: pb, zysk, marza: pn > 0 ? zysk / pn * 100 : 0,
    status: floorBinds ? 'warn' : 'ok', detal: { dostawaSmart: dost, oplataPct: pb > 0 ? (pb * p + dost) / pb * 100 : 0 } });
}

function policzAmazonDHL(kosztPLN, r, g) {
  const kurs = kursDla('EUR', g);
  if (kurs <= 0) return wynik(r, { blad: 'brak kursu', status: 'bad' });
  const stawka = stawkaDHL(r.kraj, +g.waga || 0);
  if (stawka == null) return wynik(r, { blad: 'waga > 31,5 kg', status: 'bad' });
  const kosztDHL = stawka * (1 + (+g.paliwowa || 0) / 100) / kurs;
  const S = +r.wysKlient || 0;
  const v = (+r.vat || 0) / 100, m = (+g.marza || 0) / 100;
  const p = ((+r.prowizja || 0) / 100) * (1 + (+g.vatProwizji || 0) / 100); // prowizja netto + VAT
  const koszty = kosztPLN / kurs + kosztDHL + (+g.obsluga || 0) / kurs;
  const D = (1 - m) / (1 + v) - p, denomZysk = 1 / (1 + v) - p;
  if (D <= 0 || denomZysk <= 0) return wynik(r, { blad: 'reguły niespójne', status: 'bad' });
  const totalCel = totalCelu(koszty, D, denomZysk, kurs, g);
  const totalFloor = (koszty + (+g.minzysk || 0) / kurs) / denomZysk;
  const floorBinds = totalFloor > totalCel + 1e-9;
  let pb = do99(Math.max(totalCel, totalFloor) - S);
  if (pb < 0.99) pb = 0.99;
  const total = pb + S, pn = total / (1 + v);
  const zysk = total * denomZysk - koszty;
  return wynik(r, { cena: pb, zysk: zysk * kurs, marza: pn > 0 ? zysk / pn * 100 : 0,
    status: floorBinds ? 'warn' : 'ok', detal: { kosztDHL, wysKlient: S, waga: +g.waga || 0 } });
}

function policzRynek(kosztPLN, r, g) {
  if (r.typ === 'allegro') return policzAllegro(kosztPLN, r, g);
  if (r.typ === 'amazon-dhl') return policzAmazonDHL(kosztPLN, r, g);
  return policzFlat(kosztPLN, r, g);
}

// Tryb 'kotwica': rynki bazowe (Allegro, Amazon DE, Kaufland DE) licza sie na marzy, a rynki z
// flaga `kotwica` (Amazon FR/IT/ES/NL) celuja w TEN SAM zysk netto co Amazon DE + `bufor` (zl,
// poduszka na drozsze zwroty) - zamiast wlasnej marzy. Dzieki temu wysoka wysylka na dalekich
// rynkach nie winduje ceny: robimy zysk jak na DE + bufor, kosztem nizszej marzy %.
function policzKotwica(kosztPLN, g) {
  const koszt = +kosztPLN || 0;
  const gMarza = { ...g, tryb: 'marza' };
  const de = RYNKI.find((r) => r.nazwa === 'Amazon DE');
  if (!de) return RYNKI.map((r) => policzRynek(koszt, r, gMarza)); // brak DE -> wszystko na marzy
  const zyskDE = policzRynek(koszt, de, gMarza).zysk || 0;         // zl
  const gKotwica = { ...g, tryb: 'zysk', celZysk: zyskDE + (+g.bufor || 0) };
  return RYNKI.map((r) => {
    const w = policzRynek(koszt, r, r.kotwica ? gKotwica : gMarza);
    if (r.kotwica) { w.kotwica = true; w.detal = { ...w.detal, celZysk: gKotwica.celZysk, zyskDE }; }
    return w;
  });
}

// Wszystkie rynki dla danego kosztu zakupu (PLN netto). `nadpisz` - czesciowe nadpisanie DOMYSLNE
// (np. { waga, tryb } z panelu). Zwraca tablice wynikow gotowa do wyswietlenia.
function policzWszystkie(kosztPLN, nadpisz = {}) {
  const g = { ...DOMYSLNE, ...nadpisz };
  if (g.tryb === 'kotwica') return policzKotwica(+kosztPLN || 0, g);
  return RYNKI.map((r) => policzRynek(+kosztPLN || 0, r, g));
}

module.exports = {
  DOMYSLNE, RYNKI, DHL_STAWKI, ALLEGRO_PROGI,
  do99, totalCelu, kursDla, doplataSmartAllegro, stawkaDHL,
  policzRynek, policzKotwica, policzWszystkie,
};
