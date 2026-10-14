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
  // Docinanie kartonu ZAWSZE uwzględnione (decyzja usera 2026-10-14): towar oznaczony „Docinanie
  // kartonu: tak” jedzie w przyciętym kartonie, czyli w niższym progu DHL. Bez tego minimum było
  // wyższe niż w teście Automate Pricing z 06.10 (np. NERF7376 FR 47,99 zamiast 33,99 €).
  const g = { ...rynki.DOMYSLNE, waga: w.waga, docinanie: w.docinalny, docinanieOn: true };
  const out = {};
  for (const [kraj, nazwa] of Object.entries(NAZWA_RYNKU)) {
    // Minimum liczone TUTAJ z `g` (z docinaniem), nie brane z w.rynki — tamta wycena (services/cennik)
    // idzie z checkboxem docinania wyłączonym. Wcześniej docinanie działało tylko w `ocen`, a minimum
    // zostało bez niego: 2026-10-14 automat podniósł przez to FR NERF7376 33,99 → 47,99 €.
    const def = rynki.RYNKI.find((x) => x.nazwa === nazwa);
    const r = def ? rynki.policzRynek(+w.koszt || 0, def, g) : null;
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
