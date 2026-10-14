'use strict';

// Pas cenowy [min, max] i zysk dla oferty — z kalkulatora WMS (services/cennik.js → config/rynki.js),
// tej samej matematyki co zakładka Cennik. min = cena przy docelowej marży (domyślnie 20%),
// max = min × MNOZNIK_MAX. Wycena z GT hurtem po tw_Id (jedno zapytanie na 500 towarów).
//
// WYSYŁKA Z OBSERWACJI (2026-10-14): kalkulator zakłada, że klient płaci za wysyłkę `wysKlient`
// z config/rynki.js (Amazon: 4,99 €). Oferta na innym cenniku wysyłki (np. darmowa) ma przychód
// niższy o tę kwotę — liczone „z założenia” minimum było za niskie, a zysk za wysoki. Dlatego pas
// i zysk liczymy z wysyłki, którą Amazon FAKTYCZNIE pokazuje przy tej ofercie (obserwacja).
// Gdy obserwacji brak — wartość z konfiguracji. Reguł szablonów (progi darmowej wysyłki) SP-API
// nie udostępnia, więc zmiana ceny przez próg nie jest tu przewidywana — następna obserwacja ją pokaże.
//
// Amazon PL nie ma jeszcze reguł w config/rynki.js → brak pasa → repricer nie decyduje (brak_pasa).

const { wycenaHurtem } = require('../services/cennik');
const rynki = require('../config/rynki');

const MNOZNIK_MAX = 1.5;
const NAZWA_RYNKU = { DE: 'Amazon DE', FR: 'Amazon FR', IT: 'Amazon IT', ES: 'Amazon ES', NL: 'Amazon NL' };

// Czysta funkcja: wycena towaru (z wycenaHurtem) + rynek + wysyłka płacona przez klienta (null =
// z konfiguracji) → { min, max, koszt, waga, wysylka, ocen(cena) → { zysk, marza } } albo null.
function pasDlaOferty(w, rynek, wysylka = null) {
  const def = rynki.RYNKI.find((x) => x.nazwa === NAZWA_RYNKU[rynek]);
  if (!w || !def) return null;
  const r = wysylka == null ? def : { ...def, wysKlient: Number(wysylka) };
  // Docinanie kartonu ZAWSZE uwzględnione (decyzja usera 2026-10-14): towar oznaczony „Docinanie
  // kartonu: tak” jedzie w przyciętym kartonie, czyli w niższym progu DHL.
  const g = { ...rynki.DOMYSLNE, waga: w.waga, docinanie: w.docinalny, docinanieOn: true };
  const c = rynki.policzRynek(+w.koszt || 0, r, g);
  if (!c || c.blad || !(c.cena > 0)) return null;
  return {
    min: c.cena, max: +(c.cena * MNOZNIK_MAX).toFixed(2), koszt: w.koszt, waga: w.waga, wysylka: r.wysKlient,
    ocen: (cena) => {
      const x = rynki.wycenaPrzyCenie(+w.koszt || 0, r, g, cena);
      return x.blad ? null : { zysk: +x.zysk.toFixed(2), marza: +x.marza.toFixed(1) };
    },
  };
}

// twIds → Map(tw_Id → wycena) — do pasDlaOferty
async function wycenyHurtem(twIds) {
  return wycenaHurtem(twIds);
}

module.exports = { pasDlaOferty, wycenyHurtem, MNOZNIK_MAX, NAZWA_RYNKU };
