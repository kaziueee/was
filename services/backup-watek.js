'use strict';

// Backup wms.db w osobnym watku (services/watek.js, zasada 7 w CLAUDE.md) — synchroniczne integrity_check + VACUUM
// INTO (~0,36 s na SRV, co godzine 7-20) nie zatrzymuje Zebry. Skrypty (scripts/backup*.js) wolaja services/backup.js
// wprost, we wlasnym procesie — bez zmian.

const watek = require('./watek');

function start() {
  if (process.env.WMS_BACKUP_DISABLED === '1') return require('./backup').start();   // tylko log „wylaczony”
  return watek.uruchom(require.resolve('./backup'), 'backup');
}

module.exports = { start };
