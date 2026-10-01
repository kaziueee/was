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
// Najmniejszy pasujacy karton bywa za WYSOKI dla plaskiego towaru: NERF3885 (54x28x6) dostaje
// B5 (57x38x10) = 5,42 kg, czyli prog DHL 10 kg - a ten sam karton docięty do ~9 cm miesci sie
// w progu 5 kg. Na FR to 24,13 zl roznicy na paczce (analiza sprzedazy FR, 2026-10-01). Pakujacy
// tego nie policzy przy stole, wiec liczymy tu i wypisujemy mu gotowe polecenie do pola GT.
//
// Model: docinamy WYLACZNIE wysokosc kartonu (sciany pod klapami) - podstawa (szerokosc x dlugosc)
// zostaje. Towar musi wejsc w podstawe (rotacja dozwolona), a trzeci wymiar + ZAPAS wyznacza
// najnizsza mozliwa wysokosc. Sprawdzamy KAZDY karton z listy, nie tylko domyslny - inna podstawa
// po docieciu bywa tansza.
//
// Progi wagowe sa wspolne dla wszystkich rynkow DHL Parcel Connect (1/3/5/10/20/31,5 kg), ale
// SKOK ceny na progu jest rozny (FR 5->10 kg = +24,13 zl, DE = +4,20 zl). Oznaczamy tylko, gdy
// docinka oszczedza >= DOCINKA_PROG_ZL na NAJDROZSZYM rynku - przeskok 1->3 kg za 2 zl nie jest
// wart nozyka i zasmiecalby pole.
//
// Waga rozliczeniowa = max(rzeczywista, gabarytowa): gdy towar jest ciezki, docinka nic nie da
// i nie oznaczamy. Waga rzeczywista w GT ma historycznie MIESZANE jednostki (gramy jako liczby
// calkowite) - nie zgadujemy; zawyzona waga po prostu tlumi oznaczenie (blad w bezpieczna strone).

const { DHL_STAWKI } = require('./rynki');

const DOCINKA_ZAPAS_CM = 1;   // luz nad towarem po docieciu (wyscielka, zgiecie klap)
const DOCINKA_PROG_ZL = 5;    // minimalna oszczednosc netto PLN na paczce, zeby oznaczyc

// Gorne granice progow wagowych (kg) - z umowy DHL, wspolne dla rynkow.
const PROGI_DHL = [...new Set(Object.values(DHL_STAWKI).flatMap((t) => t.map(([kg]) => kg)))]
  .sort((a, b) => a - b);

// Najnizszy prog, w ktorym miesci sie waga, albo null (powyzej 31,5 kg = poza Parcel Connect).
function progDla(kg) {
  return PROGI_DHL.find((p) => kg <= p + 1e-9) ?? null;
}

// Stawka netto PLN na rynku `kraj` dla wagi rozliczeniowej, albo null (poza progami).
function stawkaDla(kraj, kg) {
  const hit = DHL_STAWKI[kraj].find(([max]) => kg <= max + 1e-9);
  return hit ? hit[1] : null;
}

// Najwieksza oszczednosc (PLN netto) po wszystkich rynkach przy przejsciu z wagi `z` na `na`.
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

// PELNE centymetry: DHL mierzy paczke z zaokragleniem, wiec "7,5 cm" przy granicy progu to loteria,
// a pakujacy i tak tnie na oko do kreski na miarce. "Do" zaokraglamy w dol, minimum w gore.
const wDol = (n) => Math.floor(n + 1e-9);
const wGore = (n) => Math.ceil(n - 1e-9);
const fmtCm = (n) => String(n).replace('.', ',');

// Najlepsza docinka jednego kartonu: probuje 3 sposoby ulozenia towaru (ktory bok idzie w gore),
// zwraca {karton, doCm, minCm, kg, prog} o najnizszym progu albo null, gdy towar nie wchodzi.
// doCm = do ilu cm MOZNA dociac i zostac w progu (wygodniej dla pakujacego niz "na styk"),
// minCm = nizej nie schodzic (towar + zapas).
function docinkaKartonu(k, p, wagaRzecz, zapas) {
  const podstawa = [k.szerokosc, k.dlugosc].sort((a, b) => b - a);
  const pole = k.szerokosc * k.dlugosc;
  let best = null;
  for (let i = 0; i < 3; i++) {
    const gora = p[i];
    const [a, b] = p.filter((_, j) => j !== i).sort((x, y) => y - x);
    if (a > podstawa[0] || b > podstawa[1]) continue;
    const minCm = wGore(gora + zapas);
    if (minCm > k.wysokosc) continue;
    const kgMin = Math.max(pole * minCm / DZIELNIK_DHL, WAGA_GAB_MIN);
    const prog = progDla(Math.max(wagaRzecz, kgMin));
    if (prog === null) continue;
    const doCm = Math.max(minCm, Math.min(k.wysokosc, wDol(prog * DZIELNIK_DHL / pole)));
    const kg = Math.max(pole * doCm / DZIELNIK_DHL, WAGA_GAB_MIN);
    if (!best || prog < best.prog || (prog === best.prog && doCm > best.doCm)) {
      best = { karton: k, doCm, minCm, kg, prog };
    }
  }
  return best;
}

// Ocena docinki dla towaru. Zwraca null (brak wymiarow / brak pasujacego kartonu) albo:
//   { potrzebna: false, karton_kod, ... }  - domyslny karton jest juz w najlepszym progu
//   { potrzebna: true, karton_kod, do_cm, min_cm, kg_po, kg_przed, oszczednosc_zl, rynek, tekst }
// `tekst` = gotowe polecenie do pola GT ("DOTNIJ B5 do 9,4 cm"); pusty, gdy docinka niepotrzebna.
// Remis progow rozstrzyga: karton domyslny (ten, po ktory pakujacy i tak siegnie) > wyzsza
// dopuszczalna wysokosc (mniej ciecia) > kolejnosc listy.
function ocenDocinkeZListy(lista, wymiary, wagaRzecz = 0, opcje = {}) {
  const zapas = opcje.zapasCm ?? DOCINKA_ZAPAS_CM;
  const progZl = opcje.progZl ?? DOCINKA_PROG_ZL;
  const dims = normalizujWymiary(wymiary);
  if (!dims) return null;
  const domyslny = dobierzKartonZListy(lista, dims);
  if (!domyslny) return null;
  const rzecz = Number(String(wagaRzecz ?? '').replace(',', '.'));
  const wr = Number.isFinite(rzecz) && rzecz > 0 ? rzecz : 0;

  const kgPrzed = Math.max(wr, wagaGabarytowa(domyslny));
  const baza = { karton_kod: domyslny.kod, kg_przed: +kgPrzed.toFixed(2), potrzebna: false, tekst: '' };

  const p = [dims.dlugosc, dims.szerokosc, dims.wysokosc];
  // Klucz sortowania = kolejnosc remisow z naglowka; pierwszy na liscie wygrywa przy pelnym remisie.
  const klucz = (d) => [d.prog, d.karton === domyslny ? 0 : 1, -d.doCm];
  const lepszy = (a, b) => {
    const ka = klucz(a), kb = klucz(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i];
    return false;
  };
  let best = null;
  for (const k of lista) {
    const d = docinkaKartonu(k, p, wr, zapas);
    if (d && (!best || lepszy(d, best))) best = d;
  }
  // Docinka ma sens tylko, gdy realnie tnie (doCm ponizej wysokosci kartonu) i zmienia prog.
  if (!best || best.doCm >= best.karton.wysokosc) return baza;
  const kgPo = Math.max(wr, best.kg);
  const zysk = oszczednosc(kgPrzed, kgPo);
  if (zysk.zl < progZl) return baza;

  return {
    ...baza,
    potrzebna: true,
    karton_kod: best.karton.kod,
    karton_domyslny: domyslny.kod,
    do_cm: best.doCm,
    min_cm: best.minCm,
    kg_po: +kgPo.toFixed(2),
    oszczednosc_zl: Number.isFinite(zysk.zl) ? +zysk.zl.toFixed(2) : null,
    rynek: zysk.kraj,
    tekst: `DOTNIJ ${best.karton.kod} do ${fmtCm(best.doCm)} cm`,
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
  DOCINKA_ZAPAS_CM,
  DOCINKA_PROG_ZL,
  ocenDocinkeZListy,
};
