'use strict';

// Zdjecia produktow - czysta logika (bez sieci, dysku, GT). Testy: test/zdjecia-model.test.js.
//
// Zrodlo zdjec to Sellasist (GT nie ma zadnego: tw_ZdjecieTw = 0 wierszy na OKITRADE), a klucz
// to SKU - Sellasist zna towar po symbolu, nie po tw_Id. Pomiar 2026-10-08: zdjecie ma 2585 z
// 2688 SKU ze stanem na K4/K4G, zero zduplikowanych symboli w katalogu Sellasist.
//
// CDN Sellasist (imge.pl) ma DWA rozmiary pod tym samym hashem: `/t/` miniatura (~100x160,
// kilkanascie KB) i `/n/` oryginal (~900x1500, do ~1 MB). Kazdy inny segment oddaje 200 z
// obrazkiem zastepczym, wiec innych rozmiarow nie zgadujemy. Nie skalujemy po swojej stronie
// (sharp = modul natywny, produkcja celowo ich nie ma): miniatura idzie na ekrany, oryginal
// tylko po tapnieciu w podglad.

const ROZMIARY = ['mini', 'duze'];

// Jak dlugo ufamy odpowiedzi Sellasist bez pytania ponownie. Znalezione zdjecie zmienia sie
// rzadko; "brak zdjecia" krocej, bo to zwykle towar, ktoremu ktos za chwile je doda.
const WAZNOSC_MS = {
  jest: 3 * 24 * 60 * 60 * 1000,
  brak: 24 * 60 * 60 * 1000,
};

// Symbol w obu systemach wpisuje czlowiek - porownujemy bez spacji brzegowych i wielkosci liter
// (7 SKU z K4 trafia dopiero po tej normalizacji).
function normalizujSymbol(symbol) {
  return String(symbol ?? '').trim().toUpperCase();
}

// image_url z listy produktow Sellasist wskazuje miniature (`/t/`). Oryginal ma ten sam plik
// pod `/n/`. Adres w innym ksztalcie (inny CDN) zostaje dla obu rozmiarow - lepiej pokazac
// duza miniature niz zgadnieta sciezke, ktora odda obrazek zastepczy.
function adresyRozmiarow(imageUrl) {
  if (!imageUrl) return null;
  const url = String(imageUrl);
  const m = url.match(/^(https?:\/\/[^/]+\/p\/\d+\/)[tn](\/[^/]+)$/);
  if (!m) return { mini: url, duze: url };
  return { mini: `${m[1]}t${m[2]}`, duze: `${m[1]}n${m[2]}` };
}

// Czy wpis z cache (meta: {url, sprawdzono}) mozna oddac bez pytania Sellasist.
function czyAktualny(meta, teraz = Date.now()) {
  if (!meta || typeof meta.sprawdzono !== 'number') return false;
  const ttl = meta.url ? WAZNOSC_MS.jest : WAZNOSC_MS.brak;
  return teraz - meta.sprawdzono < ttl;
}

// Rozmiar z query stringu - nieznany = miniatura (tania, bezpieczna domyslna).
function rozmiarZParametru(wartosc) {
  return ROZMIARY.includes(wartosc) ? wartosc : 'mini';
}

module.exports = { ROZMIARY, WAZNOSC_MS, normalizujSymbol, adresyRozmiarow, czyAktualny, rozmiarZParametru };
