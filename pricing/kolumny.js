'use strict';

// Kolumny ekranu Ceny = kanały sprzedaży, które obserwuje repricer. Jedna definicja dla workera
// (klucz pasa z kalkulatora), trasy /api/ceny (nagłówki, waluta) i ekranu — żeby nowy kanał
// nie wymagał dopisywania w trzech miejscach.
//   klucz       — klucz komórki/pasa: Amazon = kod rynku (jak dotąd), inne platformy = PLATFORMA_RYNEK
//   kalkulator  — nazwa rynku w config/rynki.js (brak = brak pasa min/max, repricer nie decyduje)
//   tylkoOdczyt — automatu nie da się włączyć (backend odrzuca, ekran nie pokazuje przełącznika)
//   wysylkaPoZgodzie — automat da się włączyć i liczy decyzje, ale cen nie wysyła, dopóki w .env nie ma
//                 tej zmiennej = 1 (Allegro od 2026-10-19: „automat, ale bez wysyłki”, decyzja usera)
//   bezKonkurencji — platforma nie podaje cen innych sprzedawców (Allegro) — ekran mówi to wprost zamiast „—”
//   rynekNadpisz — pola definicji rynku z config/rynki.js nadpisane tylko dla tej kolumny (NaTropie: bez Ads)
//   etykieta    — krótka nazwa kolumny w chipie kanału (domyślnie kod rynku: DE, RO…)
//   reguly      — nadpisania pricing/model.js w walucie kanału (krok obniżki, próg podwyżki); forint
//                 to ~0,012 zł, więc „0,01 pod konkurenta” nic by nie zmieniło na stronie

const KOLUMNY = [
  { klucz: 'DE', platforma: 'amazon', rynek: 'DE', nazwa: 'Amazon DE', waluta: '€', kalkulator: 'Amazon DE' },
  { klucz: 'FR', platforma: 'amazon', rynek: 'FR', nazwa: 'Amazon FR', waluta: '€', kalkulator: 'Amazon FR' },
  { klucz: 'IT', platforma: 'amazon', rynek: 'IT', nazwa: 'Amazon IT', waluta: '€', kalkulator: 'Amazon IT' },
  { klucz: 'ES', platforma: 'amazon', rynek: 'ES', nazwa: 'Amazon ES', waluta: '€', kalkulator: 'Amazon ES' },
  { klucz: 'NL', platforma: 'amazon', rynek: 'NL', nazwa: 'Amazon NL', waluta: '€', kalkulator: 'Amazon NL' },
  // Amazon PL: minimum z kalkulatora od 2026-10-22 (rynek „Amazon PL”: prowizja 6,15%, Easy Ship 4,29 zł za paczkę).
  { klucz: 'PL', platforma: 'amazon', rynek: 'PL', nazwa: 'Amazon PL', waluta: 'zł', kalkulator: 'Amazon PL' },
  { klucz: 'EMAG_RO', platforma: 'emag', rynek: 'RO', nazwa: 'eMAG RO', waluta: 'RON', kalkulator: 'eMAG RO' },  // automat od 2026-10-15
  // HU i BG: obserwacja od 2026-10-15, automat od tego samego dnia (decyzja usera po analizie Buy Boxów:
  // osobny automat i osobne minimum na każdy rynek, nie przeliczanie z RO)
  { klucz: 'EMAG_HU', platforma: 'emag', rynek: 'HU', nazwa: 'eMAG HU', waluta: 'Ft', kalkulator: 'eMAG HU', reguly: { krok: 1, progPodwyzki: 40 } },
  { klucz: 'EMAG_BG', platforma: 'emag', rynek: 'BG', nazwa: 'eMAG BG', waluta: '€', kalkulator: 'eMAG BG' },
  // Empik (Mirakl): obserwacja od 2026-10-16, możliwość automatu od 2026-10-18 (decyzja usera). Minimum
  // z kalkulatora (rynek „Empik”: prowizja per kategoria, wysyłka wg gabarytu, rekompensata Premium).
  // Cena idzie importem PRI01, jednym plikiem na przebieg (pricing/empik.js).
  { klucz: 'EMPIK_PL', platforma: 'empik', rynek: 'PL', nazwa: 'Empik', waluta: 'zł', kalkulator: 'Empik' },
  // Allegro (od 2026-10-16): dwa konta = dwie kolumny, rynek = konto (pricing/allegro.js KONTA). Cen
  // konkurencji API Allegro nie daje (pricing/allegro.js) — dają je raport „Czynniki Top oferty” wgrywany
  // z ekranu (pricing/allegro-top.js) i Niezbędnik dla ofert z automatem (pricing/konkurencja-allegro.js).
  // Minimum z kalkulatora (rynek „Allegro”: prowizja per oferta + Ads + dopłata Smart). Od 2026-10-19 automat
  // da się włączyć, ale wysyłka cen czeka na osobną decyzję usera (PRICING_ALLEGRO_WYSYLKA=1).
  { klucz: 'ALLEGRO_EKAJTEK', platforma: 'allegro', rynek: 'EKAJTEK', nazwa: 'Allegro ekajtek', etykieta: 'ekajtek', waluta: 'zł', kalkulator: 'Allegro',
    wysylkaPoZgodzie: 'PRICING_ALLEGRO_WYSYLKA', bezKonkurencji: true },
  // NaTropie na razie tylko obserwacja (decyzja usera 2026-10-21) — automat tylko na ekajtek.
  { klucz: 'ALLEGRO_NATROPIE', platforma: 'allegro', rynek: 'NATROPIE', nazwa: 'Allegro NaTropie', etykieta: 'NaTropie', waluta: 'zł', kalkulator: 'Allegro',
    tylkoOdczyt: true, wysylkaPoZgodzie: 'PRICING_ALLEGRO_WYSYLKA', bezKonkurencji: true,
    rynekNadpisz: { ads: 0 } },   // NaTropie nie prowadzi kampanii Ads (Rozliczenia III kw. 2026: 0 zł)
  // Kaufland DE: obserwacja od 2026-10-16, możliwość automatu od 2026-10-18 (decyzja usera po teście zapisu
  // 16.10: cena widoczna po 1–2 min, przez 1,5 doby nikt jej nie cofnął). Smart Pricing Kauflandu wyłączony
  // na wszystkich ofertach (pricing/kaufland-smart.js) — inaczej dwa automaty ciągnęłyby cenę.
  { klucz: 'KAUFLAND_DE', platforma: 'kaufland', rynek: 'DE', nazwa: 'Kaufland DE', waluta: '€', kalkulator: 'Kaufland DE' },
];

const kluczKolumny = (platforma, rynek) => (platforma === 'amazon' ? rynek : `${String(platforma).toUpperCase()}_${rynek}`);
const kolumna = (platforma, rynek) => KOLUMNY.find((k) => k.klucz === kluczKolumny(platforma, rynek)) || null;
// Czytane przy każdym wywołaniu, nie przy ładowaniu modułu — zdjęcie blokady to zmiana .env i restart procesu.
const wysylkaWstrzymana = (k) => !!k?.wysylkaPoZgodzie && process.env[k.wysylkaPoZgodzie] !== '1';

module.exports = { KOLUMNY, kluczKolumny, kolumna, wysylkaWstrzymana };
