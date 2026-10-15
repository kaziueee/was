'use strict';

// Kolumny ekranu Ceny = kanały sprzedaży, które obserwuje repricer. Jedna definicja dla workera
// (klucz pasa z kalkulatora), trasy /api/ceny (nagłówki, waluta) i ekranu — żeby nowy kanał
// nie wymagał dopisywania w trzech miejscach.
//   klucz       — klucz komórki/pasa: Amazon = kod rynku (jak dotąd), inne platformy = PLATFORMA_RYNEK
//   kalkulator  — nazwa rynku w config/rynki.js (brak = brak pasa min/max, repricer nie decyduje)
//   tylkoOdczyt — automatu nie da się włączyć (backend odrzuca, ekran nie pokazuje przełącznika)
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
];

const kluczKolumny = (platforma, rynek) => (platforma === 'amazon' ? rynek : `${String(platforma).toUpperCase()}_${rynek}`);
const kolumna = (platforma, rynek) => KOLUMNY.find((k) => k.klucz === kluczKolumny(platforma, rynek)) || null;

module.exports = { KOLUMNY, kluczKolumny, kolumna };
