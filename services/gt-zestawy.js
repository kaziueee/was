'use strict';

// Sklad zestawow (rodzaj 8) MAJACYCH STAN NA K4 - do pokazania "ile sztuk skladnika jest
// zamrozone w zestawach" przy karcie produktu (analogia do rezerwacji ZK).
//
// ZW poza zakresem (decyzja usera): liczy sie WYLACZNIE zmontowany zestaw fizycznie lezacy
// na K4, bo tylko on zaburza liczenie polki skladnika. Zestaw na K4 trzyma swoje skladniki
// (tez towary K4), wiec ich sztuki sa fizycznie na K4, ale zaksiegowane pod SKU zestawu:
//   fizycznie_na_polce(skladnik) = st_Stan_K4(skladnik) + wZestawach(skladnik)
//   wZestawach(skladnik)         = SUM po zestawach na K4:  st_Stan_K4(zestaw) * kpl_Liczba
//
// Zbior zestawow-na-K4 jest MALY (rzad kilku-kilkudziesieciu), wiec czytamy go hurtem raz i
// cache'ujemy z krotkim TTL - zamiast round-tripa do GT per produkt.
//
// tw_Komplet: kpl_IdKomplet=zestaw, kpl_IdSkladnik=skladnik, kpl_Liczba(money)=ile na 1 zestaw.
// Wielokrotnosc ("2-pak") siedzi w kpl_Liczba (potwierdzone: brak zdublowanych wierszy) - ale
// mape odwrotna i tak budujemy SUMUJAC per (skladnik, zestaw), na wypadek recznego dubla.
//
// EDGE 1: zestaw w zestawie (skladnik rodzaj 8) istnieje, rzadki. V1 liczy JEDEN poziom - nie
//         rozwijamy zagniezdzonego skladu. Znacznik luki: patrz TODO nizej.
// EDGE 2: zestaw rodzaj 8 na K4 bez wierszy w tw_Komplet (np. NERCHIKUL10C) - sklad
//         nieokreslony, pomijamy w atrybucji, oznaczamy flaga.
//
// Rzuca gdy GT SQL niedostepny - wywolujacy (endpoint) mapuje na 503, jak inne ekrany GT-only.

const { query } = require('./gt-sql');

const RODZAJ_ZESTAW = 8;
const MAG_K4_SYMBOL = 'K4';
const TTL_MS = 60 * 1000; // krotki - zestawy na K4 zmieniaja sie rzadko, ale nie podajemy stale bez konca

let cache = null; // { czas, dane }

// Czyta z GT model zestawow na K4 i buduje dwie mapy (opis w rozbudujModel wyzej).
async function zbudujModel() {
  // 1. Zestawy rodzaj 8 ze stanem na K4
  const { recordset: zestawyRows } = await query(
    `SELECT t.tw_Id, t.tw_Symbol, t.tw_Nazwa, s.st_Stan, s.st_StanRez
     FROM tw__Towar t
     JOIN tw_Stan s ON s.st_TowId = t.tw_Id
     JOIN sl_Magazyn m ON m.mag_Id = s.st_MagId
     WHERE t.tw_Rodzaj = @rodzaj AND m.mag_Symbol = @mag AND s.st_Stan > 0`,
    { rodzaj: RODZAJ_ZESTAW, mag: MAG_K4_SYMBOL }
  );

  const zestawy = new Map();       // zestawId -> model zestawu
  const wgSkladnikaMapa = new Map(); // skladnikId -> Map<zestawId, wpis> (dedup/suma)

  for (const r of zestawyRows) {
    zestawy.set(r.tw_Id, {
      tw_Id: r.tw_Id,
      symbol: String(r.tw_Symbol || '').trim(),
      nazwa: r.tw_Nazwa || '',
      stan_k4: Number(r.st_Stan) || 0,
      rez_k4: Number(r.st_StanRez) || 0,
      skladniki: [],
      sklad_nieokreslony: false,
    });
  }
  if (zestawy.size === 0) return { zestawy, wgSkladnika: new Map() };

  // 2. Sklad tych zestawow + dane skladnika
  const ids = [...zestawy.keys()];
  const parametry = {};
  const inList = ids.map((id, i) => { parametry[`z${i}`] = id; return `@z${i}`; }).join(',');
  const { recordset: skladRows } = await query(
    `SELECT k.kpl_IdKomplet AS zestaw_id, k.kpl_IdSkladnik AS skladnik_id, k.kpl_Liczba AS liczba,
            st.tw_Symbol AS skladnik_symbol, st.tw_Nazwa AS skladnik_nazwa, st.tw_Rodzaj AS skladnik_rodzaj
     FROM tw_Komplet k
     JOIN tw__Towar st ON st.tw_Id = k.kpl_IdSkladnik
     WHERE k.kpl_IdKomplet IN (${inList})`,
    parametry
  );

  for (const r of skladRows) {
    const zestaw = zestawy.get(r.zestaw_id);
    if (!zestaw) continue;
    const liczba = Number(r.liczba) || 0;

    zestaw.skladniki.push({
      id: r.skladnik_id,
      symbol: String(r.skladnik_symbol || '').trim(),
      nazwa: r.skladnik_nazwa || '',
      rodzaj: r.skladnik_rodzaj, // TODO(zestaw-w-zestawie): rodzaj===8 => sklad zagniezdzony, V1 nie rozwija
      liczba,
    });

    // Mapa odwrotna - dedup po zestawie, SUMA liczby (obrona przed recznym dublem wiersza)
    if (!wgSkladnikaMapa.has(r.skladnik_id)) wgSkladnikaMapa.set(r.skladnik_id, new Map());
    const wpisy = wgSkladnikaMapa.get(r.skladnik_id);
    const istn = wpisy.get(r.zestaw_id);
    if (istn) istn.liczba += liczba;
    else wpisy.set(r.zestaw_id, { zestaw_id: r.zestaw_id, symbol: zestaw.symbol, nazwa: zestaw.nazwa, liczba, stan_k4: zestaw.stan_k4 });
  }

  // EDGE 2: zestaw na K4 bez skladu w GT
  for (const zestaw of zestawy.values()) {
    if (zestaw.skladniki.length === 0) zestaw.sklad_nieokreslony = true;
  }

  const wgSkladnika = new Map();
  for (const [skladnikId, wpisy] of wgSkladnikaMapa) wgSkladnika.set(skladnikId, [...wpisy.values()]);
  return { zestawy, wgSkladnika };
}

async function pobierzModel() {
  if (cache && (Date.now() - cache.czas) < TTL_MS) return cache.dane;
  const dane = await zbudujModel();
  cache = { czas: Date.now(), dane };
  return dane;
}

function sumujZamrozenie(wpisy) {
  return (wpisy || []).reduce((s, w) => s + w.liczba * w.stan_k4, 0);
}

// Ile sztuk danego skladnika jest zamrozone w zestawach lezacych na K4.
async function wZestawach(twId) {
  const { wgSkladnika } = await pobierzModel();
  return sumujZamrozenie(wgSkladnika.get(Number(twId)));
}

// Wersja wsadowa: Map<String(id), liczba> dla listy id - jeden model, bez N zapytan do GT.
async function wZestawachMapa(twIds) {
  const { wgSkladnika } = await pobierzModel();
  const wynik = new Map();
  for (const id of twIds) wynik.set(String(id), sumujZamrozenie(wgSkladnika.get(Number(id))));
  return wynik;
}

// Rozbicie do panelu na karcie produktu (lazy). Dwie strony jednego zjawiska:
//   jako_skladnik: w jakich zestawach na K4 ten towar wystepuje i ile sztuk zamraza
//   jako_zestaw:   jesli ten towar SAM jest zestawem na K4 - jego sklad (lub flaga nieokreslony)
async function rozbicieDlaProduktu(twId) {
  const id = Number(twId);
  const { zestawy, wgSkladnika } = await pobierzModel();

  const jakoSkladnik = (wgSkladnika.get(id) || [])
    .map((w) => ({
      zestaw_id: w.zestaw_id, symbol: w.symbol, nazwa: w.nazwa,
      liczba: w.liczba, stan_zestawu: w.stan_k4, zamraza: w.liczba * w.stan_k4,
    }))
    .sort((a, b) => b.zamraza - a.zamraza);

  const z = zestawy.get(id);
  const jakoZestaw = z
    ? {
        stan_k4: z.stan_k4,
        sklad_nieokreslony: z.sklad_nieokreslony,
        skladniki: z.skladniki.map((s) => ({ id: s.id, symbol: s.symbol, nazwa: s.nazwa, liczba: s.liczba, rodzaj: s.rodzaj })),
      }
    : null;

  return {
    jako_skladnik: jakoSkladnik,
    w_zestawach: jakoSkladnik.reduce((s, w) => s + w.zamraza, 0),
    jako_zestaw: jakoZestaw,
  };
}

// Test/diagnostyka - wymusza swiezy odczyt (pomija cache).
function wyczyscCache() { cache = null; }

module.exports = { wZestawach, wZestawachMapa, rozbicieDlaProduktu, zbudujModel, wyczyscCache };
