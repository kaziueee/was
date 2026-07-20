'use strict';

// Adnotacja stref doklejana do tw_Pole1 (lokalizacja K4 w GT):
//   "M2-J14-P2"  ->  "M2-J14-P2 +StD20 +StZ3"   (20 szt. z dostawy i 3 ze zwrotu leza w strefie)
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

// Skroty stref w dopisku tw_Pole1: prefiks "St" (Strefa) + litera rodzaju. Litery te same, co
// kolumna "Strefa" na desktopie (komorkaStrefa w public/desktop/app.js: P/D/Z/PW), ale w
// tw_Pole1 dostaja "St" - bo dopisek stoi INLINE przy adresie i samo "+P1" zlewa sie z poziomem
// polki ("M2-A7-P1"), a "+StP1" jest jednoznaczne. Na desktopie liter nie mylisz - stoja pod
// naglowkiem kolumny "Strefa".
const SKROTY_STREF = { przywozka: 'StP', dostawa: 'StD', zwrot: 'StZ', przyjecie_wewn: 'StPW' };

// Kolejnosc wyswietlania - STALA, zeby pole nie "migalo" przy kazdym przebiegu joba
// (zmiana tekstu = kolejny UPDATE do GT bez powodu).
const KOLEJNOSC_STREF = ['przywozka', 'dostawa', 'zwrot', 'przyjecie_wewn'];

// Wszystko od "+SKROT<liczba>" do KONCA to adnotacja. Kotwica na koncu ($) sprawia, ze
// przypadkowy plus w srodku kodu nie zje polowy adresu. Granica z przodu = POCZATEK POLA albo
// bialy znak, wiec lapiemy dwie formy:
//   "M2-A7 +StP1" - dopisek do adresu (SKU z domem/adresem w GT)
//   "+StD20"      - CALE pole to znacznik (SKU bez adresu, ma tylko sztuki w strefie; job pisze
//                   sam znacznik). Bez alternatywy ^ trim() odczytu ("+StD20") rozjechalby sie ze
//                   zdejmowaniem i znacznik zostalby na wieki.
// (?:St)? - rozpoznajemy TEZ stary format bez prefiksu ("+P1", "+D20"), zeby dopiski zapisane
//   przed zmiana skrotow (2026-07-20) dalo sie zdjac albo zmigrowac do nowego przy najblizszym
//   przebiegu joba. Zapisujemy zawsze nowy format - SKROTY_STREF ma juz "St".
// Separator "/zapas" (M2-A7/C2P3) NIE ma ani spacji, ani plusa - zapas przezywa zdjecie (test).
const ADNOTACJA_RE = /(?:^|\s)\+(?:St)?[A-Z]{1,2}\d+(?:\s+\+(?:St)?[A-Z]{1,2}\d+)*$/;

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

// Sklada docelowe tw_Pole1 z bazy (adres) i adnotacji (' +D20' albo ''). Gdy bazy nie ma
// (SKU bez adresu, tylko sztuki w strefie) zostaje sam znacznik BEZ wiodacej spacji - inaczej
// odczyt-z-trim ("+D20") rozjechalby sie z zapisem (" +D20") i job pisalby w kolko to samo pole.
function zlozPole(base, adnotacja) {
  return base ? `${base}${adnotacja}` : String(adnotacja || '').trimStart();
}

// Decyzja joba dla POJEDYNCZEGO pola tw_Pole1 - czysta, testowalna bez GT/SQLite.
//   base      - adres bazowy: prawda WMS (gdy znamy dom K4) albo GT-bez-dopisku (gdy nie znamy)
//   obecne    - aktualne tw_Pole1 z GT (juz .trim())
//   adnotacja - wynik zbudujAdnotacjeStref (np. ' +D20' albo '')
//   maDomWms  - czy base pochodzi z WMS; wtedy CHRONIMY pole, gdy GT trzyma INNA baze niz WMS
//               (reczna edycja / zalegly sync - to robota synchronizujLokalizacje, nie tego joba).
//               Bez domu base = bezAdnotacjiStref(obecne), wiec ten straznik nigdy nie bije.
// Zwraca { docelowe, pisz, akcja } - akcja: 'dopisane' | 'zdjete' (istotne tylko gdy pisz).
function decyzjaAdnotacji({ base, obecne, adnotacja, maDomWms }) {
  const docelowe = zlozPole(base, adnotacja);
  if (obecne === docelowe) return { docelowe, pisz: false };
  if (maDomWms && bezAdnotacjiStref(obecne) !== base) return { docelowe, pisz: false, powod: 'baza-inna' };
  return { docelowe, pisz: true, akcja: adnotacja ? 'dopisane' : 'zdjete' };
}

module.exports = {
  bezAdnotacjiStref, zbudujAdnotacjeStref, zlozPole, decyzjaAdnotacji, SKROTY_STREF, KOLEJNOSC_STREF,
};
