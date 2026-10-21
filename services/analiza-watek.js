'use strict';

// Moduł analiz sprzedaży w OSOBNYM WĄTKU (worker_threads). ZASADA usera 2026-10-21: w ciągu dnia nic nie może
// przeszkadzać Zebrom. WMS-Node obsługuje skany w jednym wątku, a SQLite (node:sqlite) i składanie zamówień liczą się
// synchronicznie — job analiz (co 15 min: zapis okna, tempo ~0,7 s, nocne stany) i Trendy (~2,8 s na SRV) zatrzymywały
// na ten czas każdy skan. W wątku mają własną pętlę zdarzeń; główny wątek tylko czyta gotowe wyniki z db/sprzedaz.db
// (WAL: czytający nie czeka na piszącego).
// Wątek dostaje kopię process.env z chwili startu (config/env już wczytany, klucze z .env.dpapi odszyfrowane).
// Padnięcie wątku nie kładzie WMS-Node — startujemy go ponownie po minucie.

const path = require('path');
const { Worker, isMainThread } = require('worker_threads');

const RESTART_MS = 60 * 1000;

function start() {
  if (!isMainThread) return null;
  if (process.env.ANALIZA_WYLACZ === '1') { console.log('[analiza] job wyłączony (ANALIZA_WYLACZ=1)'); return null; }
  let watek = null;
  const uruchom = () => {
    watek = new Worker(path.join(__dirname, 'analiza-watek.js'));
    watek.on('error', (e) => {
      console.error('[analiza] wątek padł:', e.message);
      try { require('./awarie').blad('analiza-watek', e.stack || e.message); } catch { /* bez logu */ }
    });
    watek.on('exit', (kod) => {
      if (kod !== 0) console.error(`[analiza] wątek zakończony (kod ${kod}) — start za ${RESTART_MS / 1000} s`);
      const t = setTimeout(uruchom, RESTART_MS);
      t.unref?.();
    });
    watek.unref();
  };
  uruchom();
  return { zatrzymaj: () => watek?.terminate() };
}

// kod wątku: ten sam plik, uruchomiony jako Worker
if (!isMainThread) require('./analiza-job').start();

module.exports = { start };
