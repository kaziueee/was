'use strict';

// Kartony wysylkowe uzywane w magazynie - dane referencyjne do doboru kartonu do
// produktu ("w co to zapakowac") i do liczenia wagi gabarytowej DHL. Zrodlo: lista
// usera (2026-07-21). Wszystkie wymiary w CENTYMETRACH.
//
// Waga gabarytowa DHL = dlugosc * szerokosc * wysokosc / 4000  [kg] - LICZONA z
// wymiarow, nigdy trzymana recznie (spojne z services/gt-atrybuty.js, DZIELNIK_DHL),
// zeby liczba nie rozjechala sie z wymiarami. Wazna konsekwencja: gab jest wprost
// proporcjonalna do objetosci, wiec "najmniejszy pasujacy karton" (najmniejsza
// objetosc) = zarazem "najnizsza waga gabarytowa" - jeden i ten sam ranking.
//
// Model dopasowania (dobierzKarton): ROTACJA DOZWOLONA - produkt wchodzi, jesli po
// posortowaniu bokow malejaco kazdy bok produktu <= odpowiadajacy bok kartonu. Jeden
// produkt = jeden karton. Bez grubosci scianek i wypelnienia (zapas bierze sie z
// wyboru wiekszego kartonu, nie z modelu). Regula zyje TU, w backendzie (zasada #5:
// backend = jedyne zrodlo prawdy dla regul; front tylko UX).

const DZIELNIK_DHL = 4000;   // spojne z services/gt-atrybuty.js
const WAGA_GAB_MIN = 0.01;   // jw. - drobiazg to nie "brak danych"

// wysokosc / szerokosc / dlugosc w cm (kolejnosc pol jak na liscie zrodlowej: H/W/L;
// dla dopasowania nieistotna, bo boki i tak sortujemy).
const KARTONY = [
  { kod: 'A1',            wysokosc: 7.5, szerokosc: 20,  dlugosc: 20 },
  { kod: 'A2',            wysokosc: 7.5, szerokosc: 25,  dlugosc: 28 },
  { kod: 'A-KleinPacket', wysokosc: 7.5, szerokosc: 25,  dlugosc: 35 },
  // A3 ma IDENTYCZNE wymiary co A-KleinPacket (7.5x25x35) - duplikat handlowy.
  // Zostawiony, bo to realny karton w obiegu; przy dopasowaniu przy rownej objetosci
  // wygrywa A-KleinPacket (wczesniejszy), wiec A3 nigdy nie jest "najmniejszy pasujacy".
  { kod: 'A3',            wysokosc: 7.5, szerokosc: 25,  dlugosc: 35 },
  { kod: 'A4',            wysokosc: 7.5, szerokosc: 30,  dlugosc: 40 },
  { kod: 'A5-Stabilo',    wysokosc: 7,   szerokosc: 15,  dlugosc: 45 },
  { kod: 'A6',            wysokosc: 7.5, szerokosc: 38,  dlugosc: 50 },
  { kod: 'B1',            wysokosc: 10,  szerokosc: 25,  dlugosc: 37 },
  { kod: 'B1W',           wysokosc: 15,  szerokosc: 25,  dlugosc: 37 },
  { kod: 'B2',            wysokosc: 10,  szerokosc: 30,  dlugosc: 40 },
  { kod: 'B2W',           wysokosc: 15,  szerokosc: 30,  dlugosc: 40 },
  { kod: 'B4',            wysokosc: 10,  szerokosc: 38,  dlugosc: 50 },
  { kod: 'B4W',           wysokosc: 15,  szerokosc: 38,  dlugosc: 50 },
  { kod: 'B5',            wysokosc: 10,  szerokosc: 38,  dlugosc: 57 },
  { kod: 'B5W',           wysokosc: 15,  szerokosc: 38,  dlugosc: 57 },
  { kod: 'B6',            wysokosc: 10,  szerokosc: 38,  dlugosc: 64 },
  { kod: 'B6W',           wysokosc: 18,  szerokosc: 38,  dlugosc: 64 },
  { kod: 'C1',            wysokosc: 26,  szerokosc: 30,  dlugosc: 31 },
  { kod: 'C2',            wysokosc: 28,  szerokosc: 38,  dlugosc: 44 },
  { kod: 'C-MAX',         wysokosc: 41,  szerokosc: 38,  dlugosc: 64 },
  { kod: 'N1',            wysokosc: 10,  szerokosc: 43,  dlugosc: 64 },
  { kod: 'P0',            wysokosc: 8,   szerokosc: 38,  dlugosc: 70 },
  { kod: 'P1',            wysokosc: 12,  szerokosc: 38,  dlugosc: 70 },
  { kod: 'P1W',           wysokosc: 20,  szerokosc: 38,  dlugosc: 70 },
  { kod: 'P2',            wysokosc: 30,  szerokosc: 51,  dlugosc: 61 },
  { kod: 'P4',            wysokosc: 7,   szerokosc: 27,  dlugosc: 90 },
  { kod: 'D1',            wysokosc: 10,  szerokosc: 40,  dlugosc: 82 },
  { kod: 'D2',            wysokosc: 10,  szerokosc: 40,  dlugosc: 90 },
  { kod: 'D2W',           wysokosc: 15,  szerokosc: 40,  dlugosc: 90 },
  { kod: 'D3',            wysokosc: 8,   szerokosc: 45,  dlugosc: 104 },
  // UWAGA: w liscie zrodlowej ten karton (20x45x104) byl zdublowany pod nazwa "D2"
  // (kolizja z D2 = 10x40x90). To footprint D3 (45x104) w wersji WYSOKIEJ; wlasciwa
  // nazwa "D3W" (konwencja B1/B1W, D2/D2W, B6/B6W), potwierdzona przez usera 2026-07-21.
  { kod: 'D3W',           wysokosc: 20,  szerokosc: 45,  dlugosc: 104 },
  { kod: 'XL-Pocztex',    wysokosc: 100, szerokosc: 100, dlugosc: 120 },
];

// Gorny limit realnego kartonu - to samo, co dla wymiarow towaru w gt-atrybuty.js.
const WYMIAR_MAX_CM = 1000;

// Objetosc kartonu [cm3].
function objetosc(k) {
  return k.wysokosc * k.szerokosc * k.dlugosc;
}

// Waga gabarytowa DHL [kg] dla kartonu - liczona z wymiarow (patrz naglowek).
function wagaGabarytowa(k) {
  return Math.max(objetosc(k) / DZIELNIK_DHL, WAGA_GAB_MIN);
}

// Boki kartonu posortowane malejaco - do testu obwiedni.
function bokiMalejaco(k) {
  return [k.wysokosc, k.szerokosc, k.dlugosc].sort((a, b) => b - a);
}

// Liczba [kg] -> tekst dla GT: 2 miejsca, przecinek. Ten sam ksztalt, co pole
// "Waga gabarytowa DHL" (gt-atrybuty.liczWageGabarytowa), zeby oba pola wygladaly tak samo.
function formatWaga(n) {
  return Number(n).toFixed(2).replace('.', ',');
}

// {dlugosc, szerokosc, wysokosc} (liczby albo teksty "25,5") -> znormalizowane liczby,
// albo null gdy wejscie nie jest obiektem albo ktorykolwiek wymiar nie jest liczba > 0.
// Odporne na null/undefined (czyszczenie wymiarow podaje null) - kolejnosc pol nieistotna.
function normalizujWymiary(wymiary) {
  if (!wymiary || typeof wymiary !== 'object') return null;
  const d = Number(String(wymiary.dlugosc).replace(',', '.'));
  const s = Number(String(wymiary.szerokosc).replace(',', '.'));
  const w = Number(String(wymiary.wysokosc).replace(',', '.'));
  if (![d, s, w].every((n) => Number.isFinite(n) && n > 0)) return null;
  return { dlugosc: d, szerokosc: s, wysokosc: w };
}

// Najmniejszy karton z PODANEJ listy, w ktory zmiesci sie produkt o danych wymiarach [cm].
// Rotacja dozwolona (boki sortowane malejaco po obu stronach). Przy rownej objetosci wygrywa
// wczesniejszy na liscie (Array.sort jest stabilny) - stad wazna jest kolejnosc `lista`
// (serwis podaje ja wg id, czyli w kolejnosci dodania). Zwraca obiekt kartonu albo null
// (gdy brak wymiarow albo produkt nie miesci sie w zadnym). Czysta funkcja - bez DB/stanu.
function dobierzKartonZListy(lista, wymiary) {
  const dims = normalizujWymiary(wymiary);
  if (!dims) return null;
  const p = [dims.dlugosc, dims.szerokosc, dims.wysokosc].sort((a, b) => b - a);
  const wgObjetosci = [...lista].sort((a, b) => objetosc(a) - objetosc(b));
  return (
    wgObjetosci.find((k) => {
      const b = bokiMalejaco(k);
      return p[0] <= b[0] && p[1] <= b[1] && p[2] <= b[2];
    }) || null
  );
}

// Wrapper na wbudowanej liscie KARTONY (dane seed) - dla testow i wstecznej zgodnosci.
// Konsumenci produkcyjni wolaja services/kartony (edytowalna lista z DB).
function dobierzKarton(wymiary) {
  return dobierzKartonZListy(KARTONY, wymiary);
}

// Waga gabarytowa "z kartonu" dla produktu o danych wymiarach, liczona z PODANEJ listy.
// Zwraca { waga: "0,75", karton_kod: "A1", zrodlo: "karton" } gdy cos pasuje; gdy nie pasuje
// zaden karton (produkt wiekszy od najwiekszego), a wymiary sa - FALLBACK na gola wage
// gabarytowa produktu (ten sam wzor obj/DZIELNIK_DHL, zrodlo: "wymiar"); gdy brak wymiarow - null.
function liczWageKartonZListy(lista, wymiary) {
  const dims = normalizujWymiary(wymiary);
  if (!dims) return null;
  const k = dobierzKartonZListy(lista, dims);
  if (k) return { waga: formatWaga(wagaGabarytowa(k)), karton_kod: k.kod, zrodlo: 'karton' };
  const kg = Math.max((dims.dlugosc * dims.szerokosc * dims.wysokosc) / DZIELNIK_DHL, WAGA_GAB_MIN);
  return { waga: formatWaga(kg), karton_kod: null, zrodlo: 'wymiar' };
}

// Walidacja jednego kartonu (dodanie/edycja). CZYSTA - nie sprawdza unikalnosci kodu
// (to wymaga listy z DB, robi to services/kartony). Zwraca {blad} albo {karton:{kod,...}}.
function sprawdzKarton({ kod, wysokosc, szerokosc, dlugosc } = {}) {
  const k = String(kod ?? '').trim();
  if (!k) return { blad: 'Kod kartonu jest wymagany.' };
  const pola = [['wysokosc', wysokosc], ['szerokosc', szerokosc], ['dlugosc', dlugosc]];
  const wart = {};
  for (const [nazwa, sur] of pola) {
    const n = Number(String(sur).replace(',', '.'));
    if (!Number.isFinite(n)) return { blad: `${nazwa}: nie jest liczbą.` };
    if (n <= 0) return { blad: `${nazwa}: musi być większa od zera.` };
    if (n > WYMIAR_MAX_CM) return { blad: `${nazwa}: ${n} cm to wartość nierealna.` };
    wart[nazwa] = n;
  }
  return { karton: { kod: k, ...wart } };
}

module.exports = {
  KARTONY,
  DZIELNIK_DHL,
  WAGA_GAB_MIN,
  objetosc,
  wagaGabarytowa,
  bokiMalejaco,
  formatWaga,
  normalizujWymiary,
  dobierzKartonZListy,
  dobierzKarton,
  liczWageKartonZListy,
  sprawdzKarton,
};
