'use strict';

// Kanał sprzedaży dokumentu — moduł analiz sprzedaży (docs/analiza-sprzedazy.md). Czysta funkcja (bez SQLite i GT),
// testy w test/analiza-kanal.test.js. Kanał rozstrzygamy RAZ, przy wczytaniu, i zapisujemy razem z regułą, która go
// dała — ekran mówi, ile sprzedaży stoi na regule zastępczej.
//
// Pole „Źródło” bywało puste albo „marketplace”, ale rynek niosą też: znacznik integracji w uwagach ZK
// („Zamówienie: 136773607;[emaghu];…”), numer oryginalny ZK z integracji IDEA („Kaufland_DEMBR6LU5-2_IDEA”), kategoria
// dokumentu (dok_KatId), numer zamówienia Amazona w uwagach FS i kraj płatnika. Kaskada:
//   1. „Źródło” FS (pw_Dane −2, Tekst04)        5. kategoria FS (Amazon_DE, Kaufland, …)
//   2. „Źródło” ZK (pw_Dane −8, Tekst01)        6. kategoria ZK (Internet = Allegro, potwierdzone 2026-10-20)
//   3. znacznik [kod] w uwagach ZK / FS          7. numer zamówienia Amazona w uwagach FS → rynek z kraju płatnika
//   4. numer oryginalny ZK (Kaufland_XX, Em-…-A) 8. sam kraj płatnika + waluta
// Reguła kraju sprawdzona 2026-10-20 na 31 997 FS z numerem Amazona, których rynek znają rozliczenia Amazona
// (rozliczenia.db): 99,8% trafień; myli tylko Belgię (51 FS: 28 FR, 23 DE) i Holandię (15: 13 DE, 2 FR).
// Kroki 3–4 i nazwy ZK z BaseLinkera („Emag Węgry”, „Kaufland.de”) dodane 2026-10-21: bez nich 974 FS eMAG HU
// (X.2024–XI.2025) lądowały w „Inne”, a 1920 FS Kauflandu (X–XII.2024 i V–VIII.2026) — z samego kraju w Amazon DE.
// Sprawdzone znacznikami na 383 tys. FS: każdy znacznik daje ten sam kanał, co „Źródło”, tam gdzie są oba.

const { kolumnaZrodla, MARKETPLACE } = require('../pricing/pulpit-model');
const { KOLUMNY } = require('../pricing/kolumny');

const KLUCZE = new Set(KOLUMNY.map((k) => k.klucz));

// Kanały spoza repricera (nazwy wg projektu Rozliczenia, scripts/attribution.py). Kanały repricera mają nazwy
// z pricing/kolumny.js — jedna lista na oba ekrany.
const KANALY_DODATKOWE = {
  ALLEGRO: 'Allegro (konto nieznane)',     // kategoria ZK „Internet” bez „Źródła” i bez śladu w Rozliczeniach (45 FS)
  MEDIA_EXPERT: 'Media Expert',
  FENOM: 'Sklep Fenom / Ceneo',
  INPOST_PAY: 'InPost Pay',
  ERLI: 'Erli',
  PIGU: 'Pigu (LT/LV/EE/FI)',
  AMAZON_EU: 'Amazon (rynek nieznany)',
  SKLEP: 'Sklep Kajtek (paragony)',
  INNE: 'Ręczne / bez źródła',             // po kaskadzie zostają tylko FS wystawione ręcznie (B2B, reklamacje, wymiany)
};
const NAZWY_KANALOW = { ...Object.fromEntries(KOLUMNY.map((k) => [k.klucz, k.nazwa])), ...KANALY_DODATKOWE };

// „Źródło” spoza kolumn repricera: kody integracji (FS, znacznik w uwagach) i nazwy z ZK BaseLinkera (literówka
// „Bługaria” jest w GT)
const ZRODLA = {
  tergpl: 'MEDIA_EXPERT', personal: 'FENOM', inpsa: 'INPOST_PAY', erli_connector: 'ERLI', erli: 'ERLI', pigu: 'PIGU',
  'emag rumunia': 'EMAG_RO', 'emag węgry': 'EMAG_HU', 'emag bułgaria': 'EMAG_BG', 'emag bługaria': 'EMAG_BG',
  'kaufland.de': 'KAUFLAND_DE',
};
const ZNACZNIK = /\[([a-z0-9_.-]+)\]/i;               // „Zamówienie: 136773607;[emaghu];1134850261;;…”
// Konto Allegro z projektu Rozliczenia (d.konto_allegro, dopisuje services/analiza-dane.js), gdy GT go nie niesie
const KONTA_ROZLICZEN = { ekajtek: 'ALLEGRO_EKAJTEK', natropie: 'ALLEGRO_NATROPIE' };
// numer oryginalny ZK z integracji IDEA: „Kaufland_DEMBR6LU5-2_IDEA”, „Em-40102271591978-A-1_IDEA” (Mirakl = Empik)
const NUMER_ZK = [[/^kaufland_([a-z]{2})/i, (m) => `KAUFLAND_${m[1].toUpperCase()}`], [/^em-\d+-a\b/i, () => 'EMPIK_PL']];
// Kategorie dokumentu (sl_Kategoria) — na FS i na ZK
const KATEGORIE = {
  amazon_pl: 'PL', emag_ro: 'EMAG_RO', emag_hu: 'EMAG_HU', emag_bg: 'EMAG_BG', empik: 'EMPIK_PL',
  allegro: 'ALLEGRO', internet: 'ALLEGRO', erli: 'ERLI', inpost_buy: 'INPOST_PAY', 'pf-fenom': 'FENOM',
};
// Kraj płatnika → rynek Amazona. Belgia i Holandia wg większości z rozliczeń (wyżej) — reguła „kraj niepewny”.
const KRAJ_AMAZON = { 'Niemcy': 'DE', 'Austria': 'DE', 'Francja': 'FR', 'Włochy': 'IT', 'Hiszpania': 'ES' };
const KRAJ_AMAZON_NIEPEWNY = { 'Belgia': 'FR', 'Holandia': 'DE' };
const RYNEK_ALLEGRO = { PLN: 'PL', CZK: 'CZ', HUF: 'HU', EUR: 'SK' };
const NUMER_AMAZONA = /(?:^|\D)\d{3}-\d{7}-\d{7}(?!\d)/;   // „Am302-7328303-6994704-1” — przed cyframi bywa litera

const maly = (s) => String(s || '').trim().toLowerCase();
const tenKlucz = (k) => (KLUCZE.has(k) || KANALY_DODATKOWE[k] ? k : null);

function zeZrodla(zrodlo, waluta, kategoria) {
  const z = maly(zrodlo);
  if (!z) return null;
  if (ZRODLA[z]) return ZRODLA[z];
  if (z.startsWith('fenom')) return 'FENOM';                 // ZK: „Fenom/Kup na ceneo”
  if (z === 'kaufland') return String(waluta).toUpperCase() === 'EUR' ? 'KAUFLAND_DE' : null;   // jedyny Kaufland w EUR
  // BaseLinker pisze „amazon” na FS i „Amazon.de” na ZK zarówno dla Amazon PL (w PLN), jak i — do sierpnia 2026 —
  // dla Amazon EU (w EUR). W EUR rynek bierzemy z kraju płatnika (niżej, kaskada).
  if (z === 'amazon' || z === 'amazon.de') return String(waluta).toUpperCase() === 'PLN' ? 'PL' : null;
  if (/^allegro\s*-/.test(z)) {
    const k = kolumnaZrodla(z.replace(/\./g, '_'), 'PLN', KLUCZE);   // „Allegro - Ekajtek.pl” = ekajtek_pl
    return KLUCZE.has(k) ? k : 'ALLEGRO';                    // konto spoza repricera (np. OutletZabawek-pl)
  }
  const k = kolumnaZrodla(zrodlo, waluta, KLUCZE, kategoria);
  return KLUCZE.has(k) ? k : null;                           // „marketplace” bez kategorii, nieznane — dalej w kaskadzie
}

function zKategorii(kategoria, waluta) {
  const k = maly(kategoria);
  if (!k) return null;
  if (KATEGORIE[k]) return KATEGORIE[k];
  const r = kolumnaZrodla('marketplace', waluta, KLUCZE, kategoria);   // Amazon_DE / Amazon_FR / Kaufland (EUR)
  return r !== MARKETPLACE ? r : null;
}

function zNumeruZk(numer) {
  for (const [wzor, kanal] of NUMER_ZK) {
    const m = String(numer || '').trim().match(wzor);
    if (m && KLUCZE.has(kanal(m))) return kanal(m);
  }
  return null;
}

function amazonZKraju(kraj) {
  if (KRAJ_AMAZON[kraj]) return [KRAJ_AMAZON[kraj], 'kraj'];
  if (KRAJ_AMAZON_NIEPEWNY[kraj]) return [KRAJ_AMAZON_NIEPEWNY[kraj], 'kraj_niepewny'];
  return ['AMAZON_EU', 'kraj_nieznany'];
}

// d: { zrodlo_fs, kat_fs, zrodlo_zk, kat_zk, kraj, waluta, uwagi, uwagi_zk, oryg_zk, konto_allegro } (dowolne pola
// mogą być puste; dla ZK bez FS jego własne uwagi idą w `uwagi`)
// → { kanal, rynek, regula }; rynek = kraj sprzedaży (Allegro: PL/CZ/HU/SK z waluty, Amazon: rynek), regula = skąd.
function kanalDokumentu(d) {
  const waluta = String(d.waluta || '').toUpperCase();
  const znacznik = (String(d.uwagi_zk || '').match(ZNACZNIK) || String(d.uwagi || '').match(ZNACZNIK) || [])[1] || '';
  const zrodloAmazonEur = waluta !== 'PLN' && [d.zrodlo_fs, d.zrodlo_zk, znacznik].some((z) => ['amazon', 'amazon.de'].includes(maly(z)));
  let kanal = null, regula = null;
  for (const [pole, kat, nazwa] of [[d.zrodlo_fs, d.kat_fs, 'zrodlo_fs'], [d.zrodlo_zk, d.kat_zk, 'zrodlo_zk'], [znacznik, d.kat_zk, 'znacznik']]) {
    if ((kanal = zeZrodla(pole, waluta, kat))) { regula = nazwa; break; }
  }
  if (!kanal && (kanal = zNumeruZk(d.oryg_zk))) regula = 'numer_zk';
  if (!kanal) for (const [kat, nazwa] of [[d.kat_fs, 'kategoria_fs'], [d.kat_zk, 'kategoria_zk']]) {
    if ((kanal = zKategorii(kat, waluta))) { regula = nazwa; break; }
  }
  if (!kanal && (zrodloAmazonEur || NUMER_AMAZONA.test(String(d.uwagi || '')))) {
    [kanal, regula] = amazonZKraju(d.kraj);
    if (regula === 'kraj') regula = zrodloAmazonEur ? 'zrodlo_amazon_kraj' : 'numer_amazona_kraj';
  }
  if (!kanal && waluta === 'RON') [kanal, regula] = ['EMAG_RO', 'waluta'];
  if (!kanal && d.kraj === 'Bułgaria') [kanal, regula] = ['EMAG_BG', 'kraj'];
  // sam kraj tylko przy „marketplace” z integracji (Sellasist VIII–X.2026): ręczna FS w EUR do Niemiec może być
  // Amazonem, Kauflandem albo sprzedażą poza platformą — tego kraj nie rozstrzyga
  const marketplace = [d.zrodlo_fs, d.zrodlo_zk].some((z) => maly(z) === 'marketplace');
  if (!kanal && marketplace && waluta === 'EUR' && KRAJ_AMAZON[d.kraj]) [kanal, regula] = [KRAJ_AMAZON[d.kraj], 'kraj'];
  if (!kanal) [kanal, regula] = ['INNE', 'brak'];
  if (kanal === 'ALLEGRO' && KONTA_ROZLICZEN[maly(d.konto_allegro)]) [kanal, regula] = [KONTA_ROZLICZEN[maly(d.konto_allegro)], 'konto_rozliczenia'];
  kanal = tenKlucz(kanal) || 'INNE';
  const rynek = kanal.startsWith('ALLEGRO') ? (RYNEK_ALLEGRO[waluta] || waluta || null)
    : kanal.startsWith('EMAG_') || kanal.startsWith('KAUFLAND_') ? kanal.split('_')[1]
    : KLUCZE.has(kanal) && /^[A-Z]{2}$/.test(kanal) ? kanal : kanal === 'EMPIK_PL' ? 'PL' : null;
  return { kanal, rynek, regula };
}

// Nazwa kanału do pokazania: Allegro poza Polską z krajem („Allegro ekajtek · CZ”) — Trendy i telefon „Live”.
const nazwaKanalu = (k, r) => (NAZWY_KANALOW[k] || k) + (String(k).startsWith('ALLEGRO') && r && r !== 'PL' ? ' · ' + r : '');

module.exports = { kanalDokumentu, nazwaKanalu, NAZWY_KANALOW, KANALY_DODATKOWE, NUMER_AMAZONA };
