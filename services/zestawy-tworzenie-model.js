'use strict';

// Czysta logika zakladania nowego kompletu (rodzaj 8) - bez SQL i bez mostu, testy w
// test/zestawy-tworzenie-model.test.js. Uzywa jej scripts/zestaw-zaloz.js, ktory dokleja dane
// z GT i wola POST /api/komplet mostu. Przepis i dowody: docs/zestawy-tworzenie.md.

const DLUGOSC_SYMBOLU = 20; // tw__Towar.tw_Symbol varchar(20)
const DLUGOSC_NAZWY = 50;   // tw__Towar.tw_Nazwa varchar(50)
const PREFIKS_PULI_EAN = '5900805'; // pula GS1 firmy - rejestr w arkuszu "eany GS1", zakladka Kajtek+

// Cyfra kontrolna EAN-13 (wagi 1,3 od lewej na 12 cyfrach).
function cyfraKontrolnaEan13(dwanascie) {
  let suma = 0;
  for (let i = 0; i < 12; i++) suma += Number(dwanascie[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (suma % 10)) % 10;
}

function eanPoprawny(ean) {
  const s = String(ean || '');
  return /^\d{13}$/.test(s) && cyfraKontrolnaEan13(s.slice(0, 12)) === Number(s[12]);
}

// Cena kartotekowa kompletu = suma kosztow skladnikow x ilosc (tak maja istniejace komplety:
// NERG1132Z4 42,25 = 39 + 3x0,47 + 1,11 + 0,73). Sfera jej sama nie liczy.
function cenaKartotekowa(skladniki) {
  const suma = skladniki.reduce((s, k) => s + Number(k.koszt || 0) * Number(k.ilosc || 0), 0);
  return Math.round(suma * 100) / 100;
}

// Pola wlasne towaru (pw_Pole.pwp_Nazwa), ktore zestaw dziedziczy ze skladnikow - reguly usera
// 2026-11-18. Nazwy, nie kolumny: numer pwd_TekstNN rozni sie miedzy bazami (Z_KAJTEK vs OKITRADE).
const POLE_WAGI = 'Waga produktu';
const POLA_WAG_OPAKOWAN = ['Waga opakowania Karton', 'Waga opakowania Tworzywa', 'Waga opakowania Zbiorcze'];
const POLE_BATERII = 'Baterie';
const POLE_OP_ZBIORCZEGO = 'Ilość w opakowaniu zbiorczym';
const POLA_ZE_SKLADNIKOW = [POLE_WAGI, ...POLA_WAG_OPAKOWAN, POLE_BATERII];

function formatKg(kg) {
  return String(Math.round(kg * 1000) / 1000).replace('.', ',');
}

// Suma wagi (kg) skladnikow x ilosc. Wagi w GT sa tekstem o MIESZANYCH jednostkach (CLAUDE.md:
// z przecinkiem = kg, liczba calkowita = historycznie gramy), wiec nie zgadujemy: przyjmujemy
// "0" i liczby z przecinkiem; reszta = blad z nazwa skladnika do poprawienia w GT.
//   wymagane=true  (waga produktu): kazdy skladnik musi miec wage.
//   wymagane=false (wagi opakowan): wszystkie puste = pole zostaje puste; czesc pusta = blad,
//                                   bo suma bez nich bylaby zanizona.
function sumaWag(pole, skladniki, { wymagane }) {
  const bledy = [];
  const puste = skladniki.filter((s) => !String(s.pola?.[pole] ?? '').trim());
  if (!wymagane && puste.length === skladniki.length) return { wartosc: null, bledy };
  for (const s of puste) bledy.push(`skladnik ${s.symbol} nie ma "${pole}" w GT`);
  let suma = 0;
  for (const s of skladniki) {
    const tekst = String(s.pola?.[pole] ?? '').trim();
    if (!tekst) continue;
    if (!/^(0|\d+,\d+)$/.test(tekst)) {
      bledy.push(`skladnik ${s.symbol}: "${pole}" = "${tekst}" niejednoznaczne (bez przecinka = gramy czy kg?) - popraw w GT na kg z przecinkiem`);
      continue;
    }
    suma += Number(tekst.replace(',', '.')) * Number(s.ilosc);
  }
  return bledy.length ? { wartosc: null, bledy } : { wartosc: formatKg(suma), bledy };
}

// Baterie "ilosc;typ;T/N" (T = w zestawie, N = do dokupienia); w GT bywa tez "3; LR44; T"
// i stary zapis "3 x LR44 - T". Sumujemy po (typ, T/N): 2 x "3;LR44;T" -> "6;LR44;T".
// Rozne typy albo T z N w jednym zestawie = nie rozstrzygamy, czlowiek wpisuje recznie.
function parsujBaterie(tekst) {
  const t = String(tekst).trim();
  let m = t.match(/^(\d+)\s*;\s*([A-Za-z0-9]+)\s*;\s*([TN])$/i);
  if (!m) m = t.match(/^(\d+)\s*x\s*([A-Za-z0-9]+)\s*-\s*([TN])$/i);
  return m ? { ile: Number(m[1]), typ: m[2].toUpperCase(), flaga: m[3].toUpperCase() } : null;
}

function baterieZestawu(skladniki) {
  const bledy = [];
  const grupy = new Map();
  for (const s of skladniki) {
    const tekst = String(s.pola?.[POLE_BATERII] ?? '').trim();
    if (!tekst) continue;
    const b = parsujBaterie(tekst);
    if (!b) { bledy.push(`skladnik ${s.symbol}: baterie "${tekst}" w nieznanym formacie`); continue; }
    const klucz = `${b.typ};${b.flaga}`;
    grupy.set(klucz, (grupy.get(klucz) || 0) + b.ile * Number(s.ilosc));
  }
  if (bledy.length) return { wartosc: null, bledy, niejednoznaczne: false };
  if (grupy.size === 0) return { wartosc: null, bledy, niejednoznaczne: false };
  if (grupy.size > 1) {
    return { wartosc: null, bledy, niejednoznaczne: true, opis: [...grupy].map(([k, n]) => `${n};${k}`).join(' + ') };
  }
  const [[klucz, ile]] = [...grupy];
  return { wartosc: `${ile};${klucz}`, bledy, niejednoznaczne: false };
}

// Pola wlasne zestawu liczone ze skladnikow + kontrola tego, co ktos wpisal recznie w pliku.
//   skladniki: [{ symbol, ilosc, pola: { 'Waga produktu': '0,2', ... } }]
//   reczne:    spec.pola_wlasne
// Zwraca { pola, bledy }: pola gotowe do wyslania (puste pomijane).
function polaZestawu(skladniki, reczne = {}) {
  const bledy = [];
  const pola = {};
  const wyniki = [[POLE_WAGI, sumaWag(POLE_WAGI, skladniki, { wymagane: true })],
    ...POLA_WAG_OPAKOWAN.map((p) => [p, sumaWag(p, skladniki, { wymagane: false })])];
  for (const [pole, w] of wyniki) {
    bledy.push(...w.bledy);
    if (w.wartosc != null) pola[pole] = w.wartosc;
    if (reczne[pole] != null && w.wartosc != null && String(reczne[pole]).trim() !== w.wartosc) {
      bledy.push(`"${pole}" ${reczne[pole]} rozni sie od sumy skladnikow ${w.wartosc} - usun z pliku (liczy sie sama)`);
    }
  }

  const bat = baterieZestawu(skladniki);
  bledy.push(...bat.bledy);
  if (bat.niejednoznaczne) {
    if (reczne[POLE_BATERII] == null) bledy.push(`baterie skladnikow roznego rodzaju (${bat.opis}) - wpisz "${POLE_BATERII}" recznie w pliku`);
    else pola[POLE_BATERII] = String(reczne[POLE_BATERII]);
  } else if (bat.wartosc != null) {
    if (reczne[POLE_BATERII] != null && String(reczne[POLE_BATERII]).trim() !== bat.wartosc) {
      bledy.push(`"${POLE_BATERII}" ${reczne[POLE_BATERII]} rozni sie od sumy skladnikow ${bat.wartosc}`);
    }
    pola[POLE_BATERII] = bat.wartosc;
  }

  // Zestaw nie ma wlasnego kartonu zbiorczego (decyzja usera 2026-11-18): pole puste, a WMS czyta
  // puste jako "potrzebny karton wysylkowy" (maWlasnyKarton = tylko jednoznaczne 1).
  if (reczne[POLE_OP_ZBIORCZEGO] != null) bledy.push(`"${POLE_OP_ZBIORCZEGO}" zestawu zostaje puste - usun z pliku`);

  for (const [pole, wartosc] of Object.entries(reczne)) {
    if (!POLA_ZE_SKLADNIKOW.includes(pole) && pole !== POLE_OP_ZBIORCZEGO) pola[pole] = String(wartosc);
  }
  return { pola, bledy };
}

// Sprawdza specyfikacje zestawu wobec tego, co wiadomo z GT. Zwraca liste bledow (pusta = OK).
//   spec: { symbol, nazwa, ean, skladniki:[{symbol, ilosc}], ceny:[{poziom, brutto|netto}] }
//   gt:   { symbolZajety, eanZajety, skladniki: Map(symbol -> {tw_Id, rodzaj, usuniety}) }
function sprawdzSpecyfikacje(spec, gt) {
  const bledy = [];
  const symbol = String(spec.symbol || '');
  if (!symbol || symbol.length > DLUGOSC_SYMBOLU) bledy.push(`symbol pusty albo > ${DLUGOSC_SYMBOLU} znakow`);
  if (gt.symbolZajety) bledy.push(`symbol ${symbol} juz istnieje w GT`);

  const nazwa = String(spec.nazwa || '');
  if (!nazwa.trim()) bledy.push('nazwa pusta');
  if (nazwa.length > DLUGOSC_NAZWY) bledy.push(`nazwa ma ${nazwa.length} znakow, limit GT ${DLUGOSC_NAZWY}`);

  if (spec.ean) {
    if (!eanPoprawny(spec.ean)) bledy.push(`EAN ${spec.ean} ma zla cyfre kontrolna albo dlugosc`);
    else if (!String(spec.ean).startsWith(PREFIKS_PULI_EAN)) bledy.push(`EAN ${spec.ean} spoza puli firmy ${PREFIKS_PULI_EAN}`);
    if (gt.eanZajety) bledy.push(`EAN ${spec.ean} uzywa juz inny towar w GT`);
  }

  const skl = spec.skladniki || [];
  if (skl.length === 0) bledy.push('brak skladnikow');
  const widziane = new Set();
  for (const s of skl) {
    if (widziane.has(s.symbol)) bledy.push(`skladnik ${s.symbol} powtorzony - podaj ilosc w jednym wierszu`);
    widziane.add(s.symbol);
    const t = gt.skladniki.get(s.symbol);
    if (!t) { bledy.push(`skladnik ${s.symbol} nie istnieje w GT`); continue; }
    if (t.usuniety) bledy.push(`skladnik ${s.symbol} jest usuniety w GT`);
    if (t.rodzaj !== 1) bledy.push(`skladnik ${s.symbol} ma rodzaj ${t.rodzaj} (oczekiwany towar = 1)`);
    if (!(Number(s.ilosc) > 0)) bledy.push(`skladnik ${s.symbol}: ilosc musi byc > 0`);
  }

  // Pola wlasne liczone ze skladnikow (wagi, baterie) - tylko gdy wszystkie skladniki sa w GT.
  if (skl.length && skl.every((s) => gt.skladniki.has(s.symbol))) {
    bledy.push(...polaZestawu(wejsciePol(spec, gt), spec.pola_wlasne || {}).bledy);
  }

  for (const c of spec.ceny || []) {
    if (!(c.poziom >= 1 && c.poziom <= 10)) bledy.push(`cena: poziom ${c.poziom} poza 1..10`);
    const ileWartosci = (c.brutto != null ? 1 : 0) + (c.netto != null ? 1 : 0);
    if (ileWartosci !== 1) bledy.push(`cena poziom ${c.poziom}: podaj brutto ALBO netto`);
    const v = c.brutto != null ? c.brutto : c.netto;
    if (!(Number(v) >= 0)) bledy.push(`cena poziom ${c.poziom}: wartosc ${v} niepoprawna`);
  }
  return bledy;
}

function wejsciePol(spec, gt) {
  return spec.skladniki.map((s) => ({ symbol: s.symbol, ilosc: s.ilosc, pola: gt.skladniki.get(s.symbol).pola || {} }));
}

// Zadanie dla POST /api/komplet mostu. Wolac po sprawdzSpecyfikacje bez bledow.
function zbudujZadanie(spec, gt, { podglad }) {
  const { pola } = polaZestawu(wejsciePol(spec, gt), spec.pola_wlasne || {});
  const skladniki = spec.skladniki.map((s) => {
    const t = gt.skladniki.get(s.symbol);
    return { tw_id: t.tw_Id, ilosc: Number(s.ilosc), koszt: t.koszt };
  });
  return {
    symbol: spec.symbol,
    nazwa: spec.nazwa,
    grupa_id: spec.grupa_id ?? gt.skladniki.get(spec.skladniki[0].symbol).grupa_id ?? null,
    ean: spec.ean || null,
    sklep_internetowy: spec.sklep_internetowy !== false,
    cena_kartotekowa: cenaKartotekowa(skladniki),
    skladniki: skladniki.map(({ tw_id, ilosc }) => ({ tw_id, ilosc })),
    ceny: spec.ceny || [],
    pola_wlasne: pola,
    podglad: !!podglad,
  };
}

module.exports = {
  DLUGOSC_NAZWY, PREFIKS_PULI_EAN, POLA_ZE_SKLADNIKOW, POLE_OP_ZBIORCZEGO,
  cyfraKontrolnaEan13, eanPoprawny, cenaKartotekowa, sumaWag, parsujBaterie, baterieZestawu, polaZestawu,
  sprawdzSpecyfikacje, zbudujZadanie,
};
