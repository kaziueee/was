'use strict';

// Log AWARII (techniczny) - patrz PROGRESS.md "Specyfikacja: logi + backup" (B).
// CELOWO pliki na dysku (nie baza): przetrwa awarie samej bazy, nie puchnie w wms.db.
//   logs/error-YYYY-MM-DD.log, rotacja dzienna, retencja RETENCJA_DNI.
//
// To jest log techniczny (wyjatki, nieudane wywolania mostu/GT, ruchy pending, bledy SQL,
// nieudane backupy). Audyt biznesowy "kto/co/kiedy" to OSOBNY mechanizm (services/audyt.js,
// tabela w wms.db).

const path = require('path');
const fs = require('fs');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const RETENCJA_DNI = 90;

function dwie(n) { return String(n).padStart(2, '0'); }
function dataPliku(d = new Date()) { return `${d.getFullYear()}-${dwie(d.getMonth() + 1)}-${dwie(d.getDate())}`; }

// Zapisuje wpis awarii. zrodlo = skad (np. 'express', 'most-gt', 'backup'), wiadomosc = opis,
// szczegoly = obiekt (np. {url, stack, status}) - serializowany do JSON.
function blad(zrodlo, wiadomosc, szczegoly = null) {
  let linia = `${new Date().toISOString()} [${zrodlo}] ${wiadomosc}`;
  if (szczegoly) {
    try { linia += ` | ${JSON.stringify(szczegoly)}`; }
    catch { linia += ` | (szczegoly nieserializowalne)`; }
  }
  console.error(linia);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, `error-${dataPliku()}.log`), linia + '\n');
  } catch (e) {
    console.error(`${new Date().toISOString()} [awarie] nie moge zapisac logu awarii: ${e.message}`);
  }
}

// Kasuje pliki error-*.log starsze niz RETENCJA_DNI.
function rotuj() {
  let pliki;
  try { pliki = fs.readdirSync(LOG_DIR); } catch { return; } // brak katalogu = nic do roboty
  const prog = Date.now() - RETENCJA_DNI * 24 * 60 * 60 * 1000;
  for (const nazwa of pliki) {
    const m = nazwa.match(/^error-(\d{4})-(\d{2})-(\d{2})\.log$/);
    if (!m) continue;
    const [, r, mi, d] = m;
    if (new Date(+r, +mi - 1, +d).getTime() < prog) {
      try { fs.unlinkSync(path.join(LOG_DIR, nazwa)); } catch { /* ignore */ }
    }
  }
}

let timer = null;

// Podpina globalne lapanie bledow (Express handler dodaj osobno w app.js) + rotacje.
function start() {
  process.on('uncaughtException', (e) => blad('uncaughtException', e.message, { stack: e.stack }));
  process.on('unhandledRejection', (powod) => {
    const e = powod instanceof Error ? powod : new Error(String(powod));
    blad('unhandledRejection', e.message, { stack: e.stack });
  });
  rotuj();
  timer = setInterval(rotuj, 24 * 60 * 60 * 1000); // raz na dobe
  if (timer.unref) timer.unref();
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

// Express error-handling middleware - loguje i zwraca czytelny 500 (bez wycieku stacka).
function middleware(err, req, res, next) {
  blad('express', err.message, { url: req.originalUrl, metoda: req.method, stack: err.stack });
  if (res.headersSent) return next(err);
  res.status(500).json({ blad: 'Blad serwera - zapisany w logu awarii' });
}

module.exports = { blad, rotuj, start, stop, middleware };
