'use strict';

// Pas cenowy [min, max] dla oferty — z kalkulatora WMS (services/cennik.js → config/rynki.js),
// tej samej matematyki co zakładka Cennik. min = cena przy docelowej marży (domyślnie 20%),
// max = min × MNOZNIK_MAX. Wycena hurtem po tw_Id (jedno zapytanie GT na 500 towarów).
//
// Klucze wyniku = klucze kolumn (pricing/kolumny.js): DE, FR, …, EMAG_RO. Kanał bez rynku w
// kalkulatorze (Amazon PL) → brak pasa → repricer nie decyduje (brak_pasa).
//
// eMAG: profil Genius / bez Genius rozstrzyga oferta z API (genius_computed), a gdy jej nie ma —
// wymiary z GT (services/cennik.js). Towar z Genius ma inny koszt (opłata Genius, tańsza wysyłka),
// więc i inne minimum.

const { wycenaHurtem } = require('../services/cennik');
const rynki = require('../config/rynki');
const { KOLUMNY } = require('./kolumny');

const MNOZNIK_MAX = 1.5;

// wycena (z wycenaHurtem) → { DE: {min, max, koszt, waga, ocen(cena) → {zysk, marza}}, …, EMAG_RO }
// `ocen` liczy zysk (zł) i marżę (%) przy DOWOLNEJ cenie tą samą matematyką co Cennik
// (rynki.wycenaPrzyCenie) — repricer zapisuje je przy każdej decyzji, ekran tylko czyta.
// opcje.genius — Genius oferty eMAG z API (true/false); brak = z wymiarów GT.
function pasyZWyceny(w, { genius } = {}) {
  if (!w) return {};
  const g = { ...rynki.DOMYSLNE, waga: w.waga, docinanie: w.docinalny, docinanieOn: false,
    genius: typeof genius === 'boolean' ? genius : w.genius };
  const out = {};
  for (const k of KOLUMNY) {
    const def = k.kalkulator && rynki.RYNKI.find((x) => x.nazwa === k.kalkulator);
    if (!def) continue;
    const r = rynki.policzRynek(w.koszt, def, g);
    if (r && r.cena > 0 && !r.blad) {
      out[k.klucz] = {
        min: r.cena, max: +(r.cena * MNOZNIK_MAX).toFixed(2), koszt: w.koszt, waga: w.waga,
        ocen: (cena) => {
          const x = rynki.wycenaPrzyCenie(w.koszt, def, g, cena);
          return x.blad ? null : { zysk: +x.zysk.toFixed(2), marza: +x.marza.toFixed(1) };
        },
      };
    }
  }
  return out;
}

// twIds → Map(tw_Id → pasy wszystkich kanałów). geniusPoTw: Map(tw_Id → true/false) z ofert eMAG.
async function pasyHurtem(twIds, geniusPoTw = new Map()) {
  const wyceny = await wycenaHurtem(twIds);
  return new Map([...wyceny].map(([id, w]) => [id, pasyZWyceny(w, { genius: geniusPoTw.get(id) })]));
}

module.exports = { pasyHurtem, pasyZWyceny, MNOZNIK_MAX };
