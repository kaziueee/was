'use strict';

// Adnotacja stref doklejana do tw_Pole1 (lokalizacja K4 w GT):
//   "M2-J14-P2"  ->  "M2-J14-P2 +D20 +Z3"   (20 szt. z dostawy i 3 ze zwrotu leza w strefie)
//
// PO CO: pole "Miejsce na magazynie" to jedyne, co widzi czlowiek szukajacy towaru z poziomu
// GT (wydruk, wyszukiwanie w Subiekcie). Przy pustej polce mowilo tylko adres pustej polki,
// a sztuki czekajace w strefie istnialy WYLACZNIE w WMS.
//
// To DOPISEK, nie czesc adresu:
//   - kto czyta tw_Pole1 jako KOD do rozwiazania (cel MM, dopasowanie lokalizacji, porownanie
//     zgodnosci) - MUSI przepuscic go przez bezAdnotacjiStref(),
//   - kto tylko wyswietla - zostawia, bo o to w tym chodzi.
//
// Osobny plik (a nie gt-fields), zeby dalo sie to testowac bez otwierania SQLite i GT -
// test/adnotacja-stref.test.js. gt-fields re-eksportuje te funkcje dla wygody wolajacych.

// Skroty te same, co kolumna "Strefa" na desktopie (komorkaStrefa w public/desktop/app.js) -
// magazynier zna je stamtad i nie musi uczyc sie drugiego alfabetu.
const SKROTY_STREF = { przywozka: 'P', dostawa: 'D', zwrot: 'Z', przyjecie_wewn: 'PW' };

// Kolejnosc wyswietlania - STALA, zeby pole nie "migalo" przy kazdym przebiegu joba
// (zmiana tekstu = kolejny UPDATE do GT bez powodu).
const KOLEJNOSC_STREF = ['przywozka', 'dostawa', 'zwrot', 'przyjecie_wewn'];

// Wszystko od " +SKROT<liczba>" do KONCA to adnotacja. Kotwica na koncu ($) sprawia, ze
// przypadkowy plus w srodku kodu nie zje polowy adresu.
const ADNOTACJA_RE = / \+[A-Z]{1,2}\d+(?: \+[A-Z]{1,2}\d+)*$/;

function bezAdnotacjiStref(tekst) {
  return String(tekst ?? '').replace(ADNOTACJA_RE, '').trim();
}

// strefy: { dostawa: 20, zwrot: 3, ... }. Zera i nieznane rodzaje pomijamy.
// `limit` = ile znakow zostalo w polu (tw_Pole1 to varchar(50)). Przycinamy OD KONCA, wiec
// przy ciasnocie zostaje to, co wyzej w KOLEJNOSC_STREF. Lepiej pokazac czesc niz nic -
// pelne liczby i tak sa na karcie produktu.
function zbudujAdnotacjeStref(strefy, limit = 50) {
  let wynik = '';
  for (const rodzaj of KOLEJNOSC_STREF) {
    const ilosc = Number(strefy?.[rodzaj]) || 0;
    if (ilosc <= 0) continue;
    const kawalek = ` +${SKROTY_STREF[rodzaj]}${ilosc}`;
    if (wynik.length + kawalek.length > limit) break;
    wynik += kawalek;
  }
  return wynik;
}

module.exports = { bezAdnotacjiStref, zbudujAdnotacjeStref, SKROTY_STREF, KOLEJNOSC_STREF };
