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
  ron: 0.79,        // PLN za 1 RON (ostrozny: NBP 14.10.2026 = 0,8179; ~4% ponizej, jak EUR 4,20 przy 4,37)
  huf: 0.0115,      // PLN za 1 HUF (ostrozny: NBP 15.10.2026 = 0,011998; ~4% ponizej)
  paliwowa: 14,     // doplata paliwowa DHL %
  vatProwizji: 23,  // prowizja Amazon to netto -> dolicz VAT (reverse-charge PL)
  ads: 3,           // narzut Allegro Ads/promo %
  waga: 1,          // waga rozliczeniowa (kg) - do stawki DHL
};

// Rynki (preset). typ: 'allegro' | 'amazon-dhl' | 'flat'.
// 'flat': staly NASZ koszt wysylki na paczke — `wysylka` (w walucie rynku) albo `wysylkaEur` (w EUR,
// przeliczany kursem g.eur/kurs rynku: kurier fakturuje w EUR, a sprzedajemy np. w RON); opcjonalnie
// `oplataZam` = klucz OPLATY_ZAM — stala oplata za zamowienie wg progu ceny (np. Genius na eMAG).
const RYNKI = [
  { nazwa: 'Allegro',     kraj: 'PL', waluta: 'PLN', vat: 23, prowizja: 13.3, typ: 'allegro' },
  { nazwa: 'Amazon DE',   kraj: 'DE', waluta: 'EUR', vat: 19, prowizja: 15, wysKlient: 4.99, typ: 'amazon-dhl' },
  // kotwica:true -> w trybie 'kotwica' celuja w zysk Amazon DE + bufor (zamiast wlasnej marzy) - drozsze zwroty
  { nazwa: 'Amazon FR',   kraj: 'FR', waluta: 'EUR', vat: 20, prowizja: 15, wysKlient: 4.99, typ: 'amazon-dhl', kotwica: true },
  { nazwa: 'Amazon IT',   kraj: 'IT', waluta: 'EUR', vat: 22, prowizja: 15, wysKlient: 4.99, typ: 'amazon-dhl', kotwica: true },
  { nazwa: 'Amazon ES',   kraj: 'ES', waluta: 'EUR', vat: 21, prowizja: 15, wysKlient: 4.99, typ: 'amazon-dhl', kotwica: true },
  { nazwa: 'Amazon NL',   kraj: 'NL', waluta: 'EUR', vat: 21, prowizja: 15, wysKlient: 4.99, typ: 'amazon-dhl', kotwica: true },
  // eMAG RO (przywrócony 2026-10-14 pod repricer). Liczby z umowy Okitrade i realnych rozliczeń:
  //  - prowizja 16% od ceny BEZ VAT (`prowizjaOdNetto`) — aneks „Condiții comerciale” z 30.09.2026:
  //    zabawki 16% od 15.04.2026 (pluszaki i część niemowlęcych 18%); API eMAG
  //    `GET /api/v1/commission/estimate/{id}` podaje stawkę per oferta, a faktury C-MKTP to
  //    potwierdzają (1–15.09.2026: 2278 RON = 15,4% sprzedaży netto). Do 15.10.2026 kalkulator
  //    brał 16% od brutto — o ~2,8 pkt za dużo. Stawkę konkretnej oferty podaje repricer
  //    (pricing/pas.js, `prowizja`), 16% to domyślna. Maj–lipiec 2026 było −50% (akt dodatkowy
  //    z 31.03: rabat na start konta) — stąd ~8% na starych wyciągach. BEZ Genius — osobno, `oplataZam`,
  //  - VAT RO 21% (od 01.08.2025, ustawa 141/2025; wcześniej 19%).
  // Dwa profile, bo towar z Genius i bez Genius to inna wysyłka i inne opłaty (wybór: g.genius,
  // patrz profilRynku; nieznane = Genius, bo to ~85% paczek):
  //  - genius: towar mieszczący się w automacie. Prowizja Genius = osobna faktura E-MKTP, STAŁA kwota
  //    netto za zamówienie wg wartości brutto (siatka od 01.01.2026, GENIUS_RO), ale TYLKO od zamówień
  //    klientów Genius do automatu (aneks Genius z 30.09.2026, art. 6). Zmierzone na zamówieniach z
  //    API (flaga `genius_delivery_fee`), 16.08–13.10.2026: 284 z 394 zamówień produktów Genius do
  //    automatu = 72%; przyjęte 75% (decyzja usera 2026-10-15, z zapasem) — `oplataZamUdzial`, koszt
  //    oczekiwany na sztukę, bo przy wycenie nie wiemy, czy kupi klient Genius.
  //    Suma flag 1908 RON zgadza się z fakturami E-MKTP. Wysyłka Paxy „A – Genius"
  //    1,64 € + zwroty 0,14 € (2,00 € × 29 zwrotów / 414 paczek). Klient nie płaci nam za dostawę —
  //    przy automacie opłatę ustala i pobiera eMAG, my fakturujemy tylko towar (newsletter 29.09.2026).
  //  - bezGenius: towar za duży do automatu → kurier do domu (FanCourier przez Paxy: 3,99 €, za
  //    pobraniem 4,99 €, średnio 4,74 € w fakturze 03/2026) + zwroty 0,14 €; bez opłaty Genius.
  //    Za kuriera do domu klient płaci nam 25 RON brutto (cennik dostawy Okitrade, potwierdził user
  //    14.10.2026). Prowizję i VAT liczymy od całości (cena + dostawa) — eMAG bierze prowizję także
  //    od opłaty za dostawę (osobna pozycja faktury C-MKTP „Comision taxe livrare”).
  //  - „Contributie transport 5 RON + TVA” z aneksu NIE jest liczona: eMAG nie wystawił jej na żadnej
  //    fakturze do 15.10.2026 (invoice/read). Sprawdzić na fakturach za 16–31.10 (AWB z platformy).
  // Stawki Paxy z jednej faktury (03/2026, paxy-stawki.md) — do potwierdzenia kolejnymi; aneks od 19.10.2026.
  // Ceny w API eMAG są NETTO (bez VAT); kalkulator liczy brutto, przelicza adapter.
  { nazwa: 'eMAG RO',     kraj: 'RO', waluta: 'RON', vat: 21, prowizja: 16, prowizjaOdNetto: true, typ: 'flat',
    genius:    { oplataZam: 'GENIUS_RO', oplataZamUdzial: 0.75, wysylkaEur: 1.78, wysKlient: 0 },
    bezGenius: { wysylkaEur: 4.88, wysKlient: 25 } },
  // eMAG HU i BG (dodane 2026-10-15, na razie tylko obserwacja). To samo konto i ta sama umowa co RO;
  // liczby z API eMAG (16.08–15.10.2026) i faktur Paxy 08/2026 (0859 = HU, 0861 = BG):
  //  - prowizja 18% od ceny bez VAT (commission/estimate: 38/40 ofert HU i 39/40 BG = 18%, reszta 21%);
  //    stawkę konkretnej oferty i tak podaje repricer (pricing/pas.js),
  //  - VAT HU 27%, BG 20% (vat/read),
  //  - Genius: opłata za zamówienie klienta Genius — siatki nie znamy, średnia z flag zamówień:
  //    HU 509 HUF (5600 / 11 zam.), BG 1,25 € (16,20 / 13); udział zamówień Genius w zamówieniach do
  //    automatu: HU 11/57 = 19% → 20%, BG 13/43 = 30%,
  //  - wysyłka Paxy: „A – Genius” HU 1,64 €, BG 1,99 € + paliwo (HU 0,16, BG 0,19 €/paczkę) + zwroty
  //    (HU 0,04, BG 0,19 €/paczkę); kurier Sameday HU 3,99 / 4,99 € za pobraniem (śr. 4,59), BG 5,49 €
  //    + prowizja pobraniowa (~1,78 €/paczkę). Cennik z aneksu (BG 7,86 €) NIE odpowiada fakturom,
  //  - opłata za dostawę od klienta TRAFIA DO NAS (eMAG bierze od niej prowizję — pozycja faktury
  //    „Shipping tax commission”; pobrana kwota = towar brutto + dostawa). Średnio na każde zamówienie
  //    (order/read 16.08–15.10): HU automat 752 Ft (81% płaci 490–1280), kurier 1750 Ft; BG automat
  //    0,52 € (30% płaci), kurier 5 €. Na RO od 15.10 opłatę za automat pobiera eMAG (stąd tam 0).
  { nazwa: 'eMAG HU',     kraj: 'HU', waluta: 'HUF', vat: 27, prowizja: 18, prowizjaOdNetto: true, typ: 'flat',
    genius:    { oplataZam: 'GENIUS_HU', oplataZamUdzial: 0.2, wysylkaEur: 1.84, wysKlient: 752 },
    bezGenius: { wysylkaEur: 4.79, wysKlient: 1750 } },
  { nazwa: 'eMAG BG',     kraj: 'BG', waluta: 'EUR', vat: 20, prowizja: 18, prowizjaOdNetto: true, typ: 'flat',
    genius:    { oplataZam: 'GENIUS_BG', oplataZamUdzial: 0.3, wysylkaEur: 2.37, wysKlient: 0.52 },
    bezGenius: { wysylkaEur: 7.65, wysKlient: 5 } },
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

// Stale oplaty za zamowienie (w walucie rynku, netto) wg progu wartosci zamowienia BRUTTO: [ponizej, oplata].
// GENIUS_RO: prowizja Genius eMAG RO od 01.01.2026 (marketplace.emag.ro/infocenter, „How the Genius
// contribution is applied"): zamowienie klienta Genius z dostawa do automatu, z min. 1 produktem Genius.
// Fakturowana osobno (E-MKTP, co pol miesiaca). Faktura dla PL platnika VAT = odwrotne obciazenie, koszt = netto.
const OPLATY_ZAM = {
  GENIUS_RO: [[40, 3], [50, 4], [75, 5], [Infinity, 8]],
  GENIUS_HU: [[Infinity, 509]],     // HUF — średnia z zamówień (siatki HU nie znamy)
  GENIUS_BG: [[Infinity, 1.25]],    // EUR — średnia z zamówień (siatki BG nie znamy)
};

// Automat paczkowy eMAG (easybox): najwieksza skrytka 470 × 440 × 390 mm (eMAG Marketplace infocenter,
// „The easybox delivery conditions"). Towar wiekszy nie dostanie dostawy do automatu, wiec i Genius.
// Wagi NIE sprawdzamy: „Waga produktu" w GT ma historycznie mieszane jednostki (g/kg), a towar
// mieszczacy sie w 47×44×39 cm i tak prawie nigdy nie przekracza limitu skrytki.
const SKRYTKA_AUTOMATU_CM = [47, 44, 39];

// Czy towar o wymiarach {dlugosc, szerokosc, wysokosc} (cm, z GT) miesci sie w najwiekszej skrytce,
// w dowolnym ulozeniu. null = brak wymiarow (nie wiemy).
function miesciSieWAutomacie(wym) {
  if (!wym) return null;
  const t = [wym.dlugosc, wym.szerokosc, wym.wysokosc].map(Number);
  if (t.some((x) => !(x > 0))) return null;
  t.sort((a, b) => b - a);
  const s = [...SKRYTKA_AUTOMATU_CM].sort((a, b) => b - a);
  return t.every((x, i) => x <= s[i]);
}

// Rynek z profilem wysylki dla danego towaru: g.genius === false -> `bezGenius`, inaczej `genius`
// (nieznane = Genius, bo to wiekszosc paczek). Rynek bez profili zwracany bez zmian.
function profilRynku(r, g) {
  if (!r.genius) return r;
  const { genius, bezGenius, ...baza } = r;
  return { ...baza, ...(g && g.genius === false ? bezGenius : genius), profil: g && g.genius === false ? 'bezGenius' : 'genius' };
}

// --- helpery (czyste) ---
const kursDla = (waluta, g) => (waluta === 'EUR' ? +g.eur || 0 : waluta === 'RON' ? +g.ron || 0 : waluta === 'HUF' ? +g.huf || 0 : 1);

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

// obnizProg: docinanie kartonu (tylko FR) - bierzemy stawke o `obnizProg` progow nizej, bo doc
// przyciety karton wpada w nizszy przedzial wagowy DHL. Clamp do najnizszego progu.
function stawkaDHL(kraj, waga, obnizProg = 0) {
  const t = DHL_STAWKI[kraj];
  if (!t) return null;
  let idx = t.findIndex(([maxW]) => waga <= maxW);
  if (idx === -1) return null; // powyzej 31,5 kg - poza Parcel Connect
  idx = Math.max(0, idx - (+obnizProg || 0));
  return t[idx][1];
}

// --- wycena jednego rynku -> { nazwa, kraj, waluta, cena, zysk, marza, status, detal } ---
// NASZ koszt wysylki dla rynku 'flat' w walucie rynku (wysylkaEur przeliczana przez EUR).
function kosztWysylkiFlat(r, g, kurs) {
  if (r.wysylkaEur != null) return (+r.wysylkaEur || 0) * (+g.eur || 0) / kurs;
  return +r.wysylka || 0;
}

// Stala oplata za zamowienie rynku 'flat' (r.oplataZam = klucz OPLATY_ZAM) przy cenie brutto `cena`.
// Zamowienie = 1 sztuka (jak wszedzie w kalkulatorze), wiec prog liczymy od ceny towaru.
function oplataZamowienia(r, cena) {
  const progi = r.oplataZam && OPLATY_ZAM[r.oplataZam];
  if (!progi) return 0;
  for (const [gr, o] of progi) if (cena < gr) return o;
  return 0;
}

// Prowizja jako ułamek ceny BRUTTO (tak liczy cały kalkulator). Rynek z `prowizjaOdNetto` (eMAG)
// bierze % od ceny bez VAT, więc 16% netto = 16% / (1 + VAT) brutto.
function prowizjaUlamek(r) {
  const p = (+r.prowizja || 0) / 100;
  return r.prowizjaOdNetto ? p / (1 + (+r.vat || 0) / 100) : p;
}

// Oczekiwana opłata za zamówienie: siatka × udział zamówień, które ją faktycznie płacą
// (`oplataZamUdzial`, brak = każde zamówienie). eMAG Genius: tylko klienci Genius — 75%.
function oplataZamOczekiwana(r, cena) {
  return oplataZamowienia(r, cena) * (r.oplataZamUdzial ?? 1);
}

function wynik(r, pola) {
  return { nazwa: r.nazwa, kraj: r.kraj, waluta: r.waluta, ...pola };
}

function policzFlat(kosztPLN, rynek, g) {
  const r = profilRynku(rynek, g);
  const kurs = kursDla(r.waluta, g);
  if (kurs <= 0) return wynik(r, { blad: 'brak kursu', status: 'bad' });
  const v = (+r.vat || 0) / 100, p = prowizjaUlamek(r), m = (+g.marza || 0) / 100;
  const kosztWys = kosztWysylkiFlat(r, g, kurs), S = +r.wysKlient || 0;
  const kosztyBez = kosztPLN / kurs + kosztWys + (+g.obsluga || 0) / kurs;
  const D = (1 - m) / (1 + v) - p, denomZysk = 1 / (1 + v) - p;
  if (D <= 0 || denomZysk <= 0) return wynik(r, { blad: 'reguły niespójne', status: 'bad' });
  // Oplata za zamowienie zalezy od ceny, a cena od oplaty — dochodzimy iteracja (jak dopłata Smart
  // na Allegro). Wyzsza oplata = wyzsza cena, wiec prog sie nie przeskakuje w kolko.
  let opl = 0, totalCel = 0, totalFloor = 0;
  for (let it = 0; it < 6; it++) {
    totalCel = totalCelu(kosztyBez + opl, D, denomZysk, kurs, g);
    totalFloor = (kosztyBez + opl + (+g.minzysk || 0) / kurs) / denomZysk;
    const no = oplataZamOczekiwana(r, Math.max(totalCel, totalFloor) - S);
    if (Math.abs(no - opl) < 1e-9) break;
    opl = no;
  }
  const floorBinds = totalFloor > totalCel + 1e-9;
  let pb = do99(Math.max(totalCel, totalFloor) - S);
  if (pb < 0.99) pb = 0.99;
  opl = oplataZamOczekiwana(r, pb);              // ,99 moglo przesunac cene przez prog
  const total = pb + S, pn = total / (1 + v);
  const zysk = total * denomZysk - (kosztyBez + opl);
  return wynik(r, { cena: pb, zysk: zysk * kurs, marza: pn > 0 ? zysk / pn * 100 : 0,
    status: floorBinds ? 'warn' : 'ok',
    detal: { kosztWys, wysKlient: S, oplataZam: oplataZamowienia(r, pb), oplataZamOczek: opl, profil: r.profil } });
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
  // docinanie: globalny checkbox (g.docinanieOn) + produkt docinalny (g.docinanie) -> prog DHL o 1 nizej
  // dla CALEGO cennika DHL (wszystkie rynki amazon-dhl).
  const dociecie = !!(g.docinanieOn && g.docinanie);
  const stawka = stawkaDHL(r.kraj, +g.waga || 0, dociecie ? 1 : 0);
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
    status: floorBinds ? 'warn' : 'ok', detal: { kosztDHL, wysKlient: S, waga: +g.waga || 0, docinanie: dociecie } });
}

function policzRynek(kosztPLN, r, g) {
  if (r.typ === 'allegro') return policzAllegro(kosztPLN, r, g);
  if (r.typ === 'amazon-dhl') return policzAmazonDHL(kosztPLN, r, g);
  return policzFlat(kosztPLN, r, g);
}

// Zysk/marza dla rynku przy RECZNIE podanej cenie brutto (`cena`, w walucie rynku) - odwrotnosc
// wyceny (cena -> zysk, zamiast koszt -> cena). Reuzywa tej samej matematyki kosztow/denomZysk co
// policz* (duplikat "ogona", pokryty testem zgodnosci). zysk zwracany w zl (jak w policz*).
function wycenaPrzyCenie(kosztPLN, rynek, g, cena) {
  const r = profilRynku(rynek, g);
  const pb = +cena || 0;
  if (pb <= 0) return wynik(r, { blad: 'podaj cenę', status: 'bad' });
  if (r.typ === 'allegro') {
    const v = (+r.vat || 0) / 100, p = ((+r.prowizja || 0) + (+g.ads || 0)) / 100, obs = +g.obsluga || 0;
    const denomZysk = 1 / (1 + v) - p;
    const dost = doplataSmartAllegro(pb);
    const pn = pb / (1 + v), zysk = pb * denomZysk - (kosztPLN + dost + obs);
    return wynik(r, { cena: pb, zysk, marza: pn > 0 ? zysk / pn * 100 : 0, status: 'ok', reczna: true,
      detal: { dostawaSmart: dost, oplataPct: pb > 0 ? (pb * p + dost) / pb * 100 : 0 } });
  }
  // flat + amazon-dhl: total = cena + wysylka klienta; prowizja+VAT od total
  const S = +r.wysKlient || 0, v = (+r.vat || 0) / 100;
  let kurs, kosztWys, p, opl = 0;
  if (r.typ === 'amazon-dhl') {
    kurs = kursDla('EUR', g);
    if (kurs <= 0) return wynik(r, { blad: 'brak kursu', status: 'bad' });
    const stawka = stawkaDHL(r.kraj, +g.waga || 0, (g.docinanieOn && g.docinanie) ? 1 : 0);
    if (stawka == null) return wynik(r, { blad: 'waga > 31,5 kg', status: 'bad' });
    kosztWys = stawka * (1 + (+g.paliwowa || 0) / 100) / kurs;
    p = ((+r.prowizja || 0) / 100) * (1 + (+g.vatProwizji || 0) / 100);
  } else {
    kurs = kursDla(r.waluta, g);
    if (kurs <= 0) return wynik(r, { blad: 'brak kursu', status: 'bad' });
    kosztWys = kosztWysylkiFlat(r, g, kurs);
    p = prowizjaUlamek(r);
    opl = oplataZamOczekiwana(r, pb);
  }
  const koszty = kosztPLN / kurs + kosztWys + (+g.obsluga || 0) / kurs + opl;
  const denomZysk = 1 / (1 + v) - p;
  const total = pb + S, pn = total / (1 + v);
  const zysk = total * denomZysk - koszty;
  return wynik(r, { cena: pb, zysk: zysk * kurs, marza: pn > 0 ? zysk / pn * 100 : 0, status: 'ok', reczna: true,
    detal: r.typ === 'flat' ? { kosztWys, wysKlient: S, oplataZam: oplataZamowienia(r, pb), oplataZamOczek: opl, profil: r.profil } : { kosztWys, wysKlient: S } });
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

// Reczna kotwica cenowa: na rynku `anchorNazwa` ustawiamy RECZNIE cene `anchorCena`, a pozostale
// rynki liczymy tak, by trafic w TEN SAM zysk netto (zl) co rynek z reczna cena. "Wroc do bazy" =
// wywolanie bez anchora. W panelu edytowalne sa Allegro i Amazon DE.
function policzZRecznaCena(kosztPLN, g, anchorNazwa, anchorCena) {
  const koszt = +kosztPLN || 0;
  const r = RYNKI.find((x) => x.nazwa === anchorNazwa);
  if (!r) return policzWszystkie(koszt, g);                 // nieznany rynek -> baza
  const wA = wycenaPrzyCenie(koszt, r, g, anchorCena);
  if (wA.blad) return policzWszystkie(koszt, g);            // zla cena -> baza
  const gZysk = { ...g, tryb: 'zysk', celZysk: wA.zysk || 0 };
  return RYNKI.map((x) => {
    if (x.nazwa === anchorNazwa) return wA;                 // rynek z reczna cena - pokaz wpisana cene
    const w = policzRynek(koszt, x, gZysk);
    w.dopasowane = true;                                    // dopasowany do zysku recznej ceny
    return w;
  });
}

// Wszystkie rynki dla danego kosztu zakupu (PLN netto). `nadpisz` - czesciowe nadpisanie DOMYSLNE
// (np. { waga, tryb } z panelu). `nadpisz.anchor = { nazwa, cena }` -> reczna kotwica cenowa.
// Zwraca tablice wynikow gotowa do wyswietlenia.
function policzWszystkie(kosztPLN, nadpisz = {}) {
  const g = { ...DOMYSLNE, ...nadpisz };
  const a = nadpisz.anchor;
  if (a && a.nazwa && +a.cena > 0) return policzZRecznaCena(+kosztPLN || 0, g, a.nazwa, +a.cena);
  if (g.tryb === 'kotwica') return policzKotwica(+kosztPLN || 0, g);
  return RYNKI.map((r) => policzRynek(+kosztPLN || 0, r, g));
}

module.exports = {
  DOMYSLNE, RYNKI, DHL_STAWKI, ALLEGRO_PROGI, OPLATY_ZAM, SKRYTKA_AUTOMATU_CM,
  do99, totalCelu, kursDla, doplataSmartAllegro, stawkaDHL, kosztWysylkiFlat, oplataZamowienia, oplataZamOczekiwana,
  prowizjaUlamek,
  miesciSieWAutomacie, profilRynku,
  policzRynek, policzKotwica, wycenaPrzyCenie, policzZRecznaCena, policzWszystkie,
};
