'use strict';

// Reconciliacja MM: WMS <-> GT (Faza A#3, gwarancja numeru MM).
// Dla kazdego ruchu MM ze statusem 'ok' i numerem dokumentu sprawdza, czy w GT istnieje
// dokument o tym numerze + tw_Id, z ta sama iloscia. Rozjazdy (brak w GT / inna ilosc /
// mozliwy duplikat) -> ALARM do logu awarii. To siatka WYKRYWANIA (druga linia obrony).
// PREWENCJA duplikatow dziala juz wczesniej: klucz "WMS-RUCH:<id>" w dok_Uwagi + sprawdzenie
// przy ponowieniu (services/ruchy-gt.js + gt-dokumenty.js znajdzMMpoKluczu).

const db = require('../db/database');
const gtDokumenty = require('./gt-dokumenty');
const awarie = require('./awarie');

const CO_MS = 60 * 60 * 1000; // co godzine
let timer = null;

// Jednorazowy przebieg. Zwraca { sprawdzone, zgodne, rozjazdy:[...], gtNiedostepne }.
async function sprawdz() {
  const ruchy = db.prepare(
    `SELECT id, artykul_gt_id, artykul_symbol, ilosc, dok_gt_numer, dok_gt_id
     FROM ruchy
     WHERE typ='MM' AND status='ok' AND dok_gt_numer IS NOT NULL AND dok_gt_numer NOT LIKE '%MOCK%'`
  ).all();

  const rozjazdy = [];
  let zgodne = 0;

  for (const r of ruchy) {
    const znal = await gtDokumenty.znajdzMM(r.dok_gt_numer, r.artykul_gt_id);
    if (znal && znal.blad) {
      // GT SQL niedostepny - przerwij caly przebieg (nie spamuj alarmami per wiersz)
      awarie.blad('reconciliacja-mm', `GT SQL niedostepny - reconciliacja przerwana: ${znal.blad}`);
      return { sprawdzone: 0, zgodne: 0, rozjazdy: [], gtNiedostepne: true };
    }
    if (!znal) {
      rozjazdy.push({ ruch_id: r.id, numer: r.dok_gt_numer, symbol: r.artykul_symbol, powod: 'brak dokumentu w GT' });
      continue;
    }
    if (Math.abs(Number(znal.ilosc) - Number(r.ilosc)) > 0.001) {
      rozjazdy.push({ ruch_id: r.id, numer: r.dok_gt_numer, symbol: r.artykul_symbol, powod: `ilosc WMS=${r.ilosc} vs GT=${znal.ilosc}` });
      continue;
    }
    // domkniecie dok_Id, jesli wczesniej brak (np. GT bylo niedostepne przy tworzeniu)
    if (!r.dok_gt_id && znal.dok_Id) {
      db.prepare('UPDATE ruchy SET dok_gt_id = ? WHERE id = ?').run(znal.dok_Id, r.id);
    }
    zgodne++;
  }

  for (const x of rozjazdy) {
    awarie.blad('reconciliacja-mm', `ROZJAZD MM: ruch #${x.ruch_id} ${x.symbol} ${x.numer} - ${x.powod}`);
  }

  return { sprawdzone: ruchy.length, zgodne, rozjazdy, gtNiedostepne: false };
}

function start() {
  if (process.env.WMS_RECON_DISABLED === '1') return;
  // pierwszy przebieg po 2 min od startu (nie obciazaj GT przy bootowaniu), potem co godzine
  const pierwszy = setTimeout(() => { sprawdz().catch((e) => awarie.blad('reconciliacja-mm', e.message)); }, 2 * 60 * 1000);
  if (pierwszy.unref) pierwszy.unref();
  timer = setInterval(() => { sprawdz().catch((e) => awarie.blad('reconciliacja-mm', e.message)); }, CO_MS);
  if (timer.unref) timer.unref();
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { sprawdz, start, stop };
