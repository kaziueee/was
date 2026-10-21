'use strict';

// Pomiar pętli zdarzeń WMS-Node (zasada 7 w CLAUDE.md: w ciągu dnia nic nie może przeszkadzać Zebrom).
// Co 100 ms sprawdzamy, o ile spóźnił się timer — spóźnienie = tyle główny wątek był zajęty czymś synchronicznym
// (Zebra czekała na odpowiedź tyle samo). Ponad PROG_MS zapisujemy do logs/petla-YYYY-MM-DD.log z czasem od startu
// procesu: joby startują ze stałym przesunięciem (app.js), więc „sekunda w cyklu” mówi, który job to był.
// Koszt: jeden timer co 100 ms. Logi starsze niż TRZYMAJ_DNI kasowane raz na dobę.

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const PROG_MS = Number(process.env.WMS_PETLA_PROG_MS) || 100;
const KROK_MS = 100;
const TRZYMAJ_DNI = 30;

const dzien = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function zapisz(linia) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFile(path.join(LOG_DIR, `petla-${dzien()}.log`), linia + '\n', () => {});
  } catch { /* pomiar nie może wywrócić procesu */ }
}

function sprzataj() {
  try {
    const granica = Date.now() - TRZYMAJ_DNI * 864e5;
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (/^petla-\d{4}-\d{2}-\d{2}\.log$/.test(f) && fs.statSync(path.join(LOG_DIR, f)).mtimeMs < granica) fs.unlinkSync(path.join(LOG_DIR, f));
    }
  } catch { /* bez sprzątania */ }
}

function start() {
  if (process.env.WMS_PETLA_WYLACZ === '1') return null;
  const startProcesu = Date.now() - process.uptime() * 1000;
  let ost = Date.now();
  const t = setInterval(() => {
    const teraz = Date.now(), opoznienie = teraz - ost - KROK_MS;
    ost = teraz;
    if (opoznienie >= PROG_MS) {
      const s = Math.round((teraz - opoznienie - startProcesu) / 1000);
      zapisz(`${new Date(teraz - opoznienie).toISOString()} ${opoznienie} ms | ${s} s od startu | cykl 10 min: ${s % 600} s, 1 h: ${s % 3600} s`);
    }
  }, KROK_MS);
  t.unref?.();
  const s = setInterval(sprzataj, 864e5); s.unref?.();
  return t;
}

module.exports = { start };
