'use strict';

// Pas cenowy [min, max] dla oferty — z kalkulatora WMS (services/cennik.js → config/rynki.js),
// tej samej matematyki co zakładka Cennik. min = cena przy docelowej marży (domyślnie 20%),
// max = min × MNOZNIK_MAX. Wycena hurtem po tw_Id (jedno zapytanie GT na 500 towarów).
//
// Amazon PL nie ma jeszcze reguł w config/rynki.js → brak pasa → repricer nie decyduje (brak_pasa).

const { wycenaHurtem } = require('../services/cennik');
const rynki = require('../config/rynki');

const MNOZNIK_MAX = 1.5;
const NAZWA_RYNKU = { DE: 'Amazon DE', FR: 'Amazon FR', IT: 'Amazon IT', ES: 'Amazon ES', NL: 'Amazon NL' };

// wycena (z wycenaHurtem) → { DE: {min, max, koszt, waga, ocen(cena) → {zysk, marza}}, FR: ... }
// `ocen` liczy zysk (zł) i marżę (%) przy DOWOLNEJ cenie tą samą matematyką co Cennik
// (rynki.wycenaPrzyCenie) — repricer zapisuje je przy każdej decyzji, ekran tylko czyta.
function pasyZWyceny(w) {
  if (!w) return {};
  const g = { ...rynki.DOMYSLNE, waga: w.waga, docinanie: w.docinalny, docinanieOn: false };
  const out = {};
  for (const [kraj, nazwa] of Object.entries(NAZWA_RYNKU)) {
    const r = w.rynki.find((x) => x.nazwa === nazwa);
    const def = rynki.RYNKI.find((x) => x.nazwa === nazwa);
    if (r && def && r.cena > 0 && !r.blad) {
      out[kraj] = {
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

// twIds → Map(tw_Id → pasy wszystkich rynków)
async function pasyHurtem(twIds) {
  const wyceny = await wycenaHurtem(twIds);
  return new Map([...wyceny].map(([id, w]) => [id, pasyZWyceny(w)]));
}

module.exports = { pasyHurtem, pasyZWyceny, MNOZNIK_MAX };
