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

// Liczba [kg] -> tekst do WYSWIETLENIA: 2 miejsca, PRZECINEK (locale PL - tak jak pole DHL
// obok na ekranie Parametry). NIE do zapisu w GT czytanym przez BaseLinker - od tego formatWagaGt.
function formatWaga(n) {
  return Number(n).toFixed(2).replace('.', ',');
}

// Liczba [kg] -> tekst do ZAPISU w polu GT czytanym przez BaseLinker: 2 miejsca, KROPKA.
// BaseLinker parsuje te wartosc jako liczbe, a przecinkowy tekst ("1,64") mu sie rozjezdza
// (stad user zaczal od pola liczbowego - ale kropka w tekstowym zalatwia to bez nowego pola).
function formatWagaGt(n) {
  return Number(n).toFixed(2);
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
// Zwraca { waga, wagaGt, karton_kod, zrodlo } gdy sa wymiary, inaczej null:
//   waga   = "0,75" (PRZECINEK) - do WYSWIETLENIA (ekran Parametry, locale PL)
//   wagaGt = "0.75" (KROPKA)    - do ZAPISU w polu GT czytanym przez BaseLinker
// Gdy produkt nie miesci sie w zadnym kartonie (wiekszy od najwiekszego) - FALLBACK na gola
// wage gabarytowa produktu (ten sam wzor obj/DZIELNIK_DHL, zrodlo "wymiar").
function liczWageKartonZListy(lista, wymiary) {
  const dims = normalizujWymiary(wymiary);
  if (!dims) return null;
  const k = dobierzKartonZListy(lista, dims);
  const kg = k
    ? wagaGabarytowa(k)
    : Math.max((dims.dlugosc * dims.szerokosc * dims.wysokosc) / DZIELNIK_DHL, WAGA_GAB_MIN);
  return {
    waga: formatWaga(kg),
    wagaGt: formatWagaGt(kg),
    karton_kod: k ? k.kod : null,
    zrodlo: k ? 'karton' : 'wymiar',
  };
}

// --- Docinka kartonu ---------------------------------------------------------------------
// Najmniejszy pasujacy karton bywa sporo wiekszy od towaru i wpycha paczke w wyzszy prog DHL:
// NERF7376 (61x29x7) = 3,10 kg gabarytowej (prog 5), a w kartonie P0 70x38x8 = 5,32 kg (prog 10).
// Na FR to 24,13 zl roznicy na paczce (analiza sprzedazy FR, 2026-10-01). Wtedy pakujacy dostaje
// polecenie: dotnij karton do wymiaru produktu - paczka wazy wtedy tyle, co waga gabarytowa
// samego towaru (pole "Waga gabarytowa DHL", pwd_Tekst09, ten sam wzor).
//
// GRANICA (decyzja usera 2026-10-02): docinamy tylko, gdy karton przerzuca paczke przez prog
// 5 kg albo wyzszy, a docięty karton spada do nizszego progu. Ponizej 5 kg nigdy - progi 1/3/5 kg
// roznia sie o 0,10-3,85 zl na paczce (do DE grosze), a na calym asortymencie to ~3 000 SKU, przy
// ktorych pakujacy cialby za darmo. Od 5 kg w gore kazde przejscie oszczedza realnie na KAZDYM
// rynku (10->5 kg: DE 4,20 zl, FR 24,13 zl). Progi sa wspolne dla rynkow DHL Parcel Connect
// (1/3/5/10/20/31,5 kg), wiec granica w kg jest ta sama wszedzie - kwota w zl tylko informacyjnie.
//
// Docięty karton nigdy nie lezy na towarze na styk - scianka tektury i zgiecie dokladaja swoje.
// Liczymy wiec z wymiarem produktu + DOCINKA_ZAPAS_CM z KAZDEJ strony (decyzja usera 2026-10-01:
// 0,5 cm). Bez tego oznaczalismy towary tuz pod progiem (SIM75818: 4,88 kg na styk, 5,51 kg
// realnie), przy ktorych pakujacy cialby na darmo. Polecenie podaje ten sam wymiar z zapasem.
//
// Towar we WLASNYM kartonie wysylkowym ("Ilosc w opakowaniu zbiorczym" = 1, pwd_Tekst04) nie
// dostaje kartonu dodatkowego, wiec nie ma czego docinac - pole zostaje puste.
//
// Waga rozliczeniowa = max(rzeczywista, gabarytowa): gdy towar jest ciezki, docinka nic nie da
// i nie oznaczamy. Waga rzeczywista w GT ma historycznie MIESZANE jednostki (gramy jako liczby
// calkowite) - nie zgadujemy; zawyzona waga po prostu tlumi oznaczenie (blad w bezpieczna strone).

const { DHL_STAWKI } = require('./rynki');

const DOCINKA_OD_KG = 5;      // docinamy tylko paczki z kartonem CIEZSZYM niz ten prog (patrz wyzej)
const DOCINKA_TAK = 'tak';    // wartosc pola GT "Docinanie kartonu"; puste = nie docinaj
const DOCINKA_ZAPAS_CM = 0.5; // luz z kazdej strony towaru po docieciu (wymiar + 2 x zapas)

// Gorne granice progow wagowych (kg) - z umowy DHL, wspolne dla rynkow.
const PROGI_DHL = [...new Set(Object.values(DHL_STAWKI).flatMap((t) => t.map(([kg]) => kg)))]
  .sort((a, b) => a - b);

// Prog (gorna granica kg), w ktory wpada waga rozliczeniowa; Infinity = ponad 31,5 kg (niestandard).
function progDla(kg) {
  return PROGI_DHL.find((p) => kg <= p + 1e-9) ?? Infinity;
}

// Stawka netto PLN na rynku `kraj` dla wagi rozliczeniowej, albo null (powyzej 31,5 kg).
function stawkaDla(kraj, kg) {
  const hit = DHL_STAWKI[kraj].find(([max]) => kg <= max + 1e-9);
  return hit ? hit[1] : null;
}

// Najwieksza oszczednosc (PLN netto) po wszystkich rynkach - tylko do POKAZANIA, decyzje podejmuje prog kg przy przejsciu z wagi `z` na `na`.
// Wyjscie spoza progow (>31,5 kg) do progu = Infinity: to paczka niestandardowa, zawsze warto.
function oszczednosc(z, na) {
  let max = 0, kraj = null;
  for (const k of Object.keys(DHL_STAWKI)) {
    const a = stawkaDla(k, z), b = stawkaDla(k, na);
    if (b === null) continue;
    const r = a === null ? Infinity : a - b;
    if (r > max) { max = r; kraj = k; }
  }
  return { zl: max, kraj };
}

const fmtCm = (n) => String(n).replace('.', ',');

// "Ilosc w opakowaniu zbiorczym" = 1 -> towar ma wlasny karton wysylkowy. Pole reczne (tekst),
// wiec tolerujemy "1", " 1 ", "1,0"; wszystko inne (puste, "2", "0") = karton dodatkowy potrzebny.
function maWlasnyKarton(iloscZbiorcze) {
  const n = Number(String(iloscZbiorcze ?? '').trim().replace(',', '.'));
  return String(iloscZbiorcze ?? '').trim() !== '' && n === 1;
}

// Ocena docinki dla towaru. Zwraca null (brak wymiarow / brak pasujacego kartonu - wtedy waga
// "z kartonu" i tak jest waga samego produktu) albo:
//   { potrzebna: false, karton_kod, kg_przed }  - karton nie przerzuca paczki przez prog >= 5 kg
//   { potrzebna: false, wlasny_karton: true }   - towar jedzie we wlasnym kartonie
//   { potrzebna: true, karton_kod, wymiary, kg_przed, kg_po, oszczednosc_zl, rynek, polecenie, tekst }
// `wymiary` = wymiar DOCIETEGO kartonu (produkt + zapas z kazdej strony).
// `tekst` = wartosc pola GT "Docinanie kartonu": 'tak' albo '' (decyzja usera - samo oznaczenie).
// `polecenie` = pelny opis dla ekranu ("DOTNIJ P0 do 62x30x8").
// opcje: { iloscZbiorcze (pwd_Tekst04), zapasCm }.
function ocenDocinkeZListy(lista, wymiary, wagaRzecz = 0, opcje = {}) {
  const zapas = opcje.zapasCm ?? DOCINKA_ZAPAS_CM;
  const dims = normalizujWymiary(wymiary);
  if (!dims) return null;
  if (maWlasnyKarton(opcje.iloscZbiorcze)) return { potrzebna: false, wlasny_karton: true, karton_kod: null, tekst: '' };
  const karton = dobierzKartonZListy(lista, dims);
  if (!karton) return null;
  const rzecz = Number(String(wagaRzecz ?? '').replace(',', '.'));
  const wr = Number.isFinite(rzecz) && rzecz > 0 ? rzecz : 0;

  const kgPrzed = Math.max(wr, wagaGabarytowa(karton));
  const cel = [dims.dlugosc, dims.szerokosc, dims.wysokosc].map((n) => +(n + 2 * zapas).toFixed(2));
  const kgPo = Math.max(wr, (cel[0] * cel[1] * cel[2]) / DZIELNIK_DHL, WAGA_GAB_MIN);
  const baza = { karton_kod: karton.kod, kg_przed: +kgPrzed.toFixed(2), potrzebna: false, tekst: '' };

  const przed = progDla(kgPrzed);
  if (kgPrzed <= DOCINKA_OD_KG + 1e-9 || progDla(kgPo) >= przed) return baza;
  const zysk = oszczednosc(kgPrzed, kgPo);

  const wymiaryTekst = cel.map(fmtCm).join('x');
  return {
    ...baza,
    potrzebna: true,
    wymiary: wymiaryTekst,
    kg_po: +kgPo.toFixed(2),
    oszczednosc_zl: Number.isFinite(zysk.zl) ? +zysk.zl.toFixed(2) : null,
    rynek: zysk.kraj,
    polecenie: `DOTNIJ ${karton.kod} do ${wymiaryTekst}`,
    tekst: DOCINKA_TAK,
  };
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
  formatWagaGt,
  normalizujWymiary,
  dobierzKartonZListy,
  dobierzKarton,
  liczWageKartonZListy,
  sprawdzKarton,
  PROGI_DHL,
  DOCINKA_OD_KG,
  DOCINKA_TAK,
  DOCINKA_ZAPAS_CM,
  maWlasnyKarton,
  ocenDocinkeZListy,
};
