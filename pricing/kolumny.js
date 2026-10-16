'use strict';

// Kolumny ekranu Ceny = kanały sprzedaży, które obserwuje repricer. Jedna definicja dla workera
// (klucz pasa z kalkulatora), trasy /api/ceny (nagłówki, waluta) i ekranu — żeby nowy kanał
// nie wymagał dopisywania w trzech miejscach.
//   klucz       — klucz komórki/pasa: Amazon = kod rynku (jak dotąd), inne platformy = PLATFORMA_RYNEK
//   kalkulator  — nazwa rynku w config/rynki.js (brak = brak pasa min/max, repricer nie decyduje)
//   tylkoOdczyt — automatu nie da się włączyć (backend odrzuca, ekran nie pokazuje przełącznika)
//   bezKonkurencji — platforma nie podaje cen innych sprzedawców (Allegro) — ekran mówi to wprost zamiast „—”
//   etykieta    — krótka nazwa kolumny w chipie kanału (domyślnie kod rynku: DE, RO…)
//   reguly      — nadpisania pricing/model.js w walucie kanału (krok obniżki, próg podwyżki); forint
//                 to ~0,012 zł, więc „0,01 pod konkurenta” nic by nie zmieniło na stronie

const KOLUMNY = [
  { klucz: 'DE', platforma: 'amazon', rynek: 'DE', nazwa: 'Amazon DE', waluta: '€', kalkulator: 'Amazon DE' },
  { klucz: 'FR', platforma: 'amazon', rynek: 'FR', nazwa: 'Amazon FR', waluta: '€', kalkulator: 'Amazon FR' },
  { klucz: 'IT', platforma: 'amazon', rynek: 'IT', nazwa: 'Amazon IT', waluta: '€', kalkulator: 'Amazon IT' },
  { klucz: 'ES', platforma: 'amazon', rynek: 'ES', nazwa: 'Amazon ES', waluta: '€', kalkulator: 'Amazon ES' },
  { klucz: 'NL', platforma: 'amazon', rynek: 'NL', nazwa: 'Amazon NL', waluta: '€', kalkulator: 'Amazon NL' },
  { klucz: 'PL', platforma: 'amazon', rynek: 'PL', nazwa: 'Amazon PL', waluta: 'zł' },
  { klucz: 'EMAG_RO', platforma: 'emag', rynek: 'RO', nazwa: 'eMAG RO', waluta: 'RON', kalkulator: 'eMAG RO' },  // automat od 2026-10-15
  // HU i BG: obserwacja od 2026-10-15, automat od tego samego dnia (decyzja usera po analizie Buy Boxów:
  // osobny automat i osobne minimum na każdy rynek, nie przeliczanie z RO)
  { klucz: 'EMAG_HU', platforma: 'emag', rynek: 'HU', nazwa: 'eMAG HU', waluta: 'Ft', kalkulator: 'eMAG HU', reguly: { krok: 1, progPodwyzki: 40 } },
  { klucz: 'EMAG_BG', platforma: 'emag', rynek: 'BG', nazwa: 'eMAG BG', waluta: '€', kalkulator: 'eMAG BG' },
  // Empik (Mirakl, od 2026-10-16): sama obserwacja. Bez `kalkulator`, dopóki nie znamy prowizji i kosztu
  // wysyłki Empik — bez pasa repricer nie decyduje (brak_pasa), tak jak Amazon PL. Automat dopiero po
  // ręcznym teście zapisu ceny (pricing/empik-cena.js) i decyzji usera.
  { klucz: 'EMPIK_PL', platforma: 'empik', rynek: 'PL', nazwa: 'Empik', waluta: 'zł', tylkoOdczyt: true },
  // Allegro (od 2026-10-16): dwa konta = dwie kolumny, rynek = konto (pricing/allegro.js KONTA). Sama
  // obserwacja: cen konkurencji API Allegro nie daje (pricing/allegro.js), więc repricer pilnuje tylko minimum
  // z kalkulatora (rynek „Allegro”: prowizja + Ads + dopłata Smart). Automat dopiero po ręcznym teście
  // zapisu (pricing/allegro-cena.js) i decyzji usera, jak go prowadzić bez danych o konkurencji.
  { klucz: 'ALLEGRO_EKAJTEK', platforma: 'allegro', rynek: 'EKAJTEK', nazwa: 'Allegro ekajtek', etykieta: 'ekajtek', waluta: 'zł', kalkulator: 'Allegro', tylkoOdczyt: true, bezKonkurencji: true },
  { klucz: 'ALLEGRO_NATROPIE', platforma: 'allegro', rynek: 'NATROPIE', nazwa: 'Allegro NaTropie', etykieta: 'NaTropie', waluta: 'zł', kalkulator: 'Allegro', tylkoOdczyt: true, bezKonkurencji: true },
];

const kluczKolumny = (platforma, rynek) => (platforma === 'amazon' ? rynek : `${String(platforma).toUpperCase()}_${rynek}`);
const kolumna = (platforma, rynek) => KOLUMNY.find((k) => k.klucz === kluczKolumny(platforma, rynek)) || null;

module.exports = { KOLUMNY, kluczKolumny, kolumna };
