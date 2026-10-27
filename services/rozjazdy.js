'use strict';

// Job detekcji rozjazdow GT vs WMS - zob. CLAUDE.md "Obsluga rozjazdow":
//   GT > WMS       -> ekran "do zlokalizowania" (live, routes/lokalizacje.js, deficyt_k4g)
//   GT < WMS w K4  -> auto-korekta (1 SKU = 1 lokalizacja - sprowadzamy ilosc do stanu GT)
//   GT < WMS w K4G -> wpis do tabeli rozjazdy (status='nowy') - magazynier decyduje
//                     z ktorej lokalizacji odjac, zob. routes/rozjazdy.js (POST /:id/resolve)
//
// Uruchamiane co 10 min (start()) oraz na zadanie przez POST /api/rozjazdy/detekcja. Zapisy calego
// przebiegu ida w jednej transakcji - services/rozjazdy-przebieg.js (dlaczego: tamze).

const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const { pobierzStanyGt } = require('./gt-produkty');
const audyt = require('./audyt');
const awarie = require('./awarie');
const { interwalMsZMinut } = require('./interwal');
const { zastosujPrzebieg, opisPrzebiegu } = require('./rozjazdy-przebieg');

// Log przebiegow: jedna linia co 10 min do logs/rozjazdy-YYYY-MM-DD.log (stdout WMS-Node na SRV
// nie trafia do zadnego pliku). Po nim widac, czy przestoje z logs/petla-*.log (sekunda 2 cyklu)
// to ten job i ktora jego czesc. Zapis asynchroniczny - log nie moze sam blokowac petli.
const LOG_DIR = path.join(__dirname, '..', 'logs');
const TRZYMAJ_DNI = 30;
const dwie = (n) => String(n).padStart(2, '0');
const dzien = (d = new Date()) => `${d.getFullYear()}-${dwie(d.getMonth() + 1)}-${dwie(d.getDate())}`;

function logPrzebiegu(opis) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFile(path.join(LOG_DIR, `rozjazdy-${dzien()}.log`), `${new Date().toISOString()} ${opis}\n`, () => {});
  } catch { /* log nie moze wywrocic joba */ }
}

function sprzatajLogi() {
  try {
    const granica = Date.now() - TRZYMAJ_DNI * 864e5;
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (/^rozjazdy-\d{4}-\d{2}-\d{2}\.log$/.test(f) && fs.statSync(path.join(LOG_DIR, f)).mtimeMs < granica) fs.unlinkSync(path.join(LOG_DIR, f));
    }
  } catch { /* bez sprzatania */ }
}

// K4 = pick floor z zywa sprzedaza (Sellasist zbija stan GT bez wiedzy WMS), wiec kopia WMS
// szybko sie starzeje. Job scala WMS do GT - im czesciej, tym mniejsze okno rozjazdu na K4.
// Domyslnie 10 min; nadpisywalne w .env przez ROZJAZDY_INTERWAL_MIN (minuty).
function interwalZKonfiguracji() {
  return interwalMsZMinut(process.env.ROZJAZDY_INTERWAL_MIN, 10, 'rozjazdy');
}
const DOMYSLNY_INTERWAL_MS = interwalZKonfiguracji();

// suma ilosci WMS per (artykul, magazyn) dla K4/K4G - tylko artykuly z zapasem > 0
function sumyWms() {
  return db.prepare(`
    SELECT s.artykul_gt_id, s.artykul_symbol, l.magazyn, SUM(s.ilosc) AS ilosc_wms
    FROM stany_lokalizacji s
    JOIN lokalizacje l ON l.id = s.lokalizacja_id
    WHERE l.magazyn IN ('K4', 'K4G')
    GROUP BY s.artykul_gt_id, l.magazyn
    HAVING SUM(s.ilosc) > 0
  `).all();
}

// artykuly z otwartym ('nowy') rozjazdem K4G, ktorych nie obejmuje juz sumyWms()
// (np. cala ilosc w K4G zostala wyzerowana inna operacja od czasu detekcji) -
// traktujemy jak ilosc_wms = 0, wiec roznica = ilosc_gt - 0 >= 0 -> do wyjasnienia
function osieroconeRozjazdyK4G(pokryteArtykuly) {
  const wszystkie = db.prepare(
    "SELECT DISTINCT artykul_gt_id FROM rozjazdy WHERE magazyn = 'K4G' AND status = 'nowy'"
  ).all();
  return wszystkie.filter((w) => !pokryteArtykuly.has(w.artykul_gt_id));
}

async function wykonajDetekcjeRozjazdow() {
  let t = performance.now();
  const wiersze = sumyWms();
  const pokryteArtykulyK4G = new Set(wiersze.filter((w) => w.magazyn === 'K4G').map((w) => w.artykul_gt_id));
  const osierocone = osieroconeRozjazdyK4G(pokryteArtykulyK4G);
  const sumy_ms = performance.now() - t;

  const idy = [...new Set([...wiersze.map((w) => w.artykul_gt_id), ...osierocone.map((w) => w.artykul_gt_id)])];
  t = performance.now();
  const stanyMap = idy.length > 0 ? await pobierzStanyGt(idy) : new Map();
  const gt_ms = performance.now() - t;

  // audyt.zapisz pisze tym samym polaczeniem (db/database), wiec wpisy audytu sa w transakcji przebiegu
  t = performance.now();
  const wynik = zastosujPrzebieg(db, { wiersze, osierocone, stanyMap, zapiszAudyt: audyt.zapisz });
  const zapis_ms = performance.now() - t;

  logPrzebiegu(opisPrzebiegu(wynik, { sumy_ms, gt_ms, zapis_ms }));
  return wynik;
}

// Uruchamia job w tle co interwalMs. Timer.unref(), zeby nie blokowal zamkniecia procesu.
function start(interwalMs = DOMYSLNY_INTERWAL_MS) {
  const timer = setInterval(() => {
    wykonajDetekcjeRozjazdow().catch((err) => awarie.blad('rozjazdy', `przebieg nieudany: ${err.message}`));
  }, interwalMs);
  timer.unref?.();
  const sprzatanie = setInterval(sprzatajLogi, 864e5);
  sprzatanie.unref?.();
  return timer;
}

module.exports = { wykonajDetekcjeRozjazdow, start };
