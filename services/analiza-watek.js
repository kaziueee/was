'use strict';

// Moduł analiz sprzedaży w osobnym wątku (services/watek.js, zasada 7 w CLAUDE.md): job analiz (co 5 min: zapis
// okna, tempo ~0,7 s, nocne stany) i Trendy (~2,8 s SQLite na SRV) zatrzymywały w głównym wątku każdy skan Zebry.
// Główny wątek tylko czyta gotowe wyniki z db/sprzedaz.db.

const watek = require('./watek');

function start() {
  if (process.env.ANALIZA_WYLACZ === '1') { console.log('[analiza] job wyłączony (ANALIZA_WYLACZ=1)'); return null; }
  return watek.uruchom(require.resolve('./analiza-job'), 'analiza');
}

module.exports = { start };
