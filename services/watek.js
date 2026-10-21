'use strict';

// Job w OSOBNYM WĄTKU (worker_threads) — zasada 7 w CLAUDE.md (user, 2026-10-21): w ciągu dnia nic nie może
// przeszkadzać Zebrom. WMS-Node obsługuje skany w jednym wątku, a node:sqlite i pętle po tysiącach wierszy liczą się
// synchronicznie, więc job w głównym wątku zatrzymuje na ten czas każdy skan. Wątek ma własną pętlę zdarzeń i własne
// połączenie z bazą (WAL: czytający nie czeka na piszącego); dostaje kopię process.env z chwili startu.
// Padnięcie wątku nie kładzie WMS-Node — startujemy go ponownie po minucie.
// Timery joba w wątku NIE mogą mieć unref() (wątek skończyłby się od razu) — `wWatku()` mówi jobowi, gdzie chodzi.

const path = require('path');
const { Worker, isMainThread, workerData } = require('worker_threads');

const RESTART_MS = 60 * 1000;

// modul: ścieżka do modułu joba z funkcją start(); nazwa: do logów
function uruchom(modul, nazwa) {
  if (!isMainThread) return null;
  let watek = null;
  const nowy = () => {
    watek = new Worker(__filename, { workerData: { modul, nazwa } });
    watek.on('error', (e) => {
      console.error(`[${nazwa}] wątek padł:`, e.message);
      try { require('./awarie').blad(`${nazwa}-watek`, e.stack || e.message); } catch { /* bez logu */ }
    });
    watek.on('exit', (kod) => {
      if (kod !== 0) console.error(`[${nazwa}] wątek zakończony (kod ${kod}) — start za ${RESTART_MS / 1000} s`);
      const t = setTimeout(nowy, RESTART_MS);
      t.unref?.();
    });
    watek.unref();
  };
  nowy();
  return { zatrzymaj: () => watek?.terminate() };
}

const wWatku = () => !isMainThread;

module.exports = { uruchom, wWatku };

// kod wątku: ten sam plik, uruchomiony jako Worker z workerData.modul. Dopiero PO module.exports — job sam wczytuje
// ten moduł (wWatku), a przy cyklu dostałby niedokończony eksport (złapane w teście 2026-10-21).
if (!isMainThread && workerData?.modul) require(path.resolve(workerData.modul)).start();
