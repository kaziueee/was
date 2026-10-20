'use strict';

// Kanał sprzedaży dokumentu — moduł analiz sprzedaży (docs/analiza-sprzedazy.md). Czysta funkcja (bez SQLite i GT),
// testy w test/analiza-kanal.test.js. Kanał rozstrzygamy RAZ, przy wczytaniu, i zapisujemy razem z regułą, która go
// dała — ekran mówi, ile sprzedaży stoi na regule zastępczej.
//
// Pole „Źródło” bywało puste albo „marketplace”, ale rynek niosą też: kategoria dokumentu (dok_KatId), numer
// zamówienia Amazona w uwagach FS (integracja „IDEA”, przed Sellasist) i kraj płatnika. Kaskada:
//   1. „Źródło” FS (pw_Dane −2, Tekst04)        4. kategoria ZK (Internet = Allegro, potwierdzone 2026-10-20)
//   2. „Źródło” ZK (pw_Dane −8, Tekst01)        5. numer zamówienia Amazona w uwagach FS → rynek z kraju płatnika
//   3. kategoria FS (Amazon_DE, Kaufland, …)    6. sam kraj płatnika + waluta
// Reguła kraju sprawdzona 2026-10-20 na 31 997 FS z numerem Amazona, których rynek znają rozliczenia Amazona
// (rozliczenia.db): 99,8% trafień; myli tylko Belgię (51 FS: 28 FR, 23 DE) i Holandię (15: 13 DE, 2 FR).

const { kolumnaZrodla, MARKETPLACE } = require('../pricing/pulpit-model');
const { KOLUMNY } = require('../pricing/kolumny');

const KLUCZE = new Set(KOLUMNY.map((k) => k.klucz));

// Kanały spoza repricera (nazwy wg projektu Rozliczenia, scripts/attribution.py). Kanały repricera mają nazwy
// z pricing/kolumny.js — jedna lista na oba ekrany.
const KANALY_DODATKOWE = {
  ALLEGRO: 'Allegro (inne konto)',
  MEDIA_EXPERT: 'Media Expert',
  FENOM: 'Sklep Fenom / Ceneo',
  INPOST_PAY: 'InPost Pay',
  ERLI: 'Erli',
  PIGU: 'Pigu (LT/LV/EE/FI)',
  AMAZON_EU: 'Amazon (rynek nieznany)',
  SKLEP: 'Sklep Kajtek (paragony)',
  INNE: 'Bez źródła',
};
const NAZWY_KANALOW = { ...Object.fromEntries(KOLUMNY.map((k) => [k.klucz, k.nazwa])), ...KANALY_DODATKOWE };

// „Źródło” spoza kolumn repricera
const ZRODLA = {
  tergpl: 'MEDIA_EXPERT', personal: 'FENOM', inpsa: 'INPOST_PAY', erli_connector: 'ERLI', erli: 'ERLI', pigu: 'PIGU',
};
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
  // BaseLinker pisze „amazon” na FS i „Amazon.de” na ZK zarówno dla Amazon PL (w PLN), jak i — do sierpnia 2026 —
  // dla Amazon EU (w EUR). W EUR rynek bierzemy z kraju płatnika (niżej, kaskada).
  if (z === 'amazon' || z === 'amazon.de') return String(waluta).toUpperCase() === 'PLN' ? 'PL' : null;
  if (/^allegro\s*-/.test(z)) {
    const k = kolumnaZrodla(zrodlo, 'PLN', KLUCZE);
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

function amazonZKraju(kraj) {
  if (KRAJ_AMAZON[kraj]) return [KRAJ_AMAZON[kraj], 'kraj'];
  if (KRAJ_AMAZON_NIEPEWNY[kraj]) return [KRAJ_AMAZON_NIEPEWNY[kraj], 'kraj_niepewny'];
  return ['AMAZON_EU', 'kraj_nieznany'];
}

// d: { zrodlo_fs, kat_fs, zrodlo_zk, kat_zk, kraj, waluta, uwagi } (dowolne pola mogą być puste)
// → { kanal, rynek, regula }; rynek = kraj sprzedaży (Allegro: PL/CZ/HU/SK z waluty, Amazon: rynek), regula = skąd.
function kanalDokumentu(d) {
  const waluta = String(d.waluta || '').toUpperCase();
  const zrodloAmazonEur = waluta !== 'PLN' && [d.zrodlo_fs, d.zrodlo_zk].some((z) => ['amazon', 'amazon.de'].includes(maly(z)));
  let kanal = null, regula = null;
  for (const [pole, kat, nazwa] of [[d.zrodlo_fs, d.kat_fs, 'zrodlo_fs'], [d.zrodlo_zk, d.kat_zk, 'zrodlo_zk']]) {
    if ((kanal = zeZrodla(pole, waluta, kat))) { regula = nazwa; break; }
  }
  if (!kanal) for (const [kat, nazwa] of [[d.kat_fs, 'kategoria_fs'], [d.kat_zk, 'kategoria_zk']]) {
    if ((kanal = zKategorii(kat, waluta))) { regula = nazwa; break; }
  }
  if (!kanal && (zrodloAmazonEur || NUMER_AMAZONA.test(String(d.uwagi || '')))) {
    [kanal, regula] = amazonZKraju(d.kraj);
    if (regula === 'kraj') regula = zrodloAmazonEur ? 'zrodlo_amazon_kraj' : 'numer_amazona_kraj';
  }
  if (!kanal && waluta === 'RON') [kanal, regula] = ['EMAG_RO', 'waluta'];
  if (!kanal && d.kraj === 'Bułgaria') [kanal, regula] = ['EMAG_BG', 'kraj'];
  if (!kanal && waluta === 'EUR' && KRAJ_AMAZON[d.kraj]) [kanal, regula] = [KRAJ_AMAZON[d.kraj], 'kraj'];
  if (!kanal) [kanal, regula] = ['INNE', 'brak'];
  kanal = tenKlucz(kanal) || 'INNE';
  const rynek = kanal.startsWith('ALLEGRO') ? (RYNEK_ALLEGRO[waluta] || waluta || null)
    : kanal.startsWith('EMAG_') || kanal.startsWith('KAUFLAND_') ? kanal.split('_')[1]
    : KLUCZE.has(kanal) && /^[A-Z]{2}$/.test(kanal) ? kanal : kanal === 'EMPIK_PL' ? 'PL' : null;
  return { kanal, rynek, regula };
}

module.exports = { kanalDokumentu, NAZWY_KANALOW, KANALY_DODATKOWE, NUMER_AMAZONA };
