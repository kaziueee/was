'use strict';

// Kopia kartoteki GT w WMS - CZYSTE reguly (bez SQLite i GT), test: test/kartoteka-model.test.js.
//
// `stany_lokalizacji` trzyma symbol, nazwe i EAN artykulu jako KOPIE z GT, zapisana raz - przy
// wstawieniu wiersza. GT jest masterem kartoteki (zasada #2 w CLAUDE.md), a w Subiekcie symbol
// wolno zmienic w kazdej chwili; `tw_Id` nie zmienia sie nigdy. Kopia moze wiec tylko sie
// zestarzec - i starzeje sie po cichu, bo nic jej dotad nie odswiezalo.
//
// Regula porownania jest asymetryczna i to jest celowe:
//   - PUSTA wartosc w GT niczego nie kasuje. Puste pole w kartotece to najczesciej "nikt nie
//     wpisal", a nie "to ma byc puste" - wyczyszczenie kopii zabraloby jedyna etykiete, jaka
//     WMS ma dla tego wiersza (tak samo ostroznie traktujemy tw_Pole1 w gt-fields.js).
//   - EAN pusty w WMS UZUPELNIAMY z GT. Wiekszosc wierszy nie ma go wcale (na produkcji 105 na
//     4454), a to od niego zalezy awaryjny lookup po EAN, gdy GT nie odpowiada. Wartosc i tak
//     pochodzi z GT, wiec nie zgadujemy.
// Porownujemy po przycietych napisach - w polach GT trafiaja sie spacje na koncu (`M2-G6-P4 `),
// a roznica o spacje to nie zmiana kartoteki, tylko szum, ktory kazalby pisac w kolko.

function txt(v) {
  return String(v ?? '').trim();
}

// Co w kopii WMS rozjechalo sie z kartoteka GT. `kartaGt` to znormalizowane {symbol, nazwa, ean}
// (mapowanie z tw_Symbol/tw_Nazwa/tw_PodstKodKresk robi warstwa nad GT). Zwraca obiekt ze
// zmianami do zapisania (klucze = kolumny stany_lokalizacji) albo null, gdy wiersz jest aktualny.
function porownajKopie(wierszWms, kartaGt) {
  if (!kartaGt) return null;
  const zmiany = {};

  const symbol = txt(kartaGt.symbol);
  if (symbol && symbol !== txt(wierszWms.artykul_symbol)) zmiany.artykul_symbol = symbol;

  const nazwa = txt(kartaGt.nazwa);
  if (nazwa && nazwa !== txt(wierszWms.artykul_nazwa)) zmiany.artykul_nazwa = nazwa;

  const ean = txt(kartaGt.ean);
  if (ean && ean !== txt(wierszWms.artykul_ean)) zmiany.artykul_ean = ean;

  return Object.keys(zmiany).length > 0 ? zmiany : null;
}

// Rodzaj zmiany - rozdzielamy je, bo maja rozny ciezar. Zmiana symbolu/nazwy to zmiana
// TOZSAMOSCI: rzadka, warta wpisu w Logu zmian ("kto to przemianowal"). Samo dopisanie EAN
// to uzupelnienie pustego pola - przy pierwszym przebiegu jest ich tysiace i zasypalyby log.
function rodzajZmiany(zmiany) {
  return (zmiany.artykul_symbol || zmiany.artykul_nazwa) ? 'tozsamosc' : 'ean';
}

// Zmiany dla listy wierszy. `kartyGt` to Map<tw_Id jako string, {symbol, nazwa, ean}>.
// Wiersze artykulow, ktorych GT nie zna (kartoteka skasowana, lokalne id testowe typu "GT-100"),
// zostawiamy w spokoju - nie mamy z czym porownac.
function roznice(wiersze, kartyGt) {
  const wynik = [];
  for (const wiersz of wiersze) {
    const zmiany = porownajKopie(wiersz, kartyGt.get(String(wiersz.artykul_gt_id)));
    if (zmiany) wynik.push({ wiersz, zmiany, rodzaj: rodzajZmiany(zmiany) });
  }
  return wynik;
}

// Ile roznych tw_Id kryje sie pod jednym kodem. >1 znaczy, ze kopia symbolu (albo EAN)
// wskazuje na dwa RozNE towary - patrz "kolizja symbolu" w CLAUDE.md.
function unikalneIdy(idy) {
  return [...new Set((idy || []).map(String))];
}

module.exports = { porownajKopie, rodzajZmiany, roznice, unikalneIdy };
