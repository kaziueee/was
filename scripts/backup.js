'use strict';

// Reczny backup bazy WMS z linii polecen.
//   node scripts/backup.js                  -> zwykly backup + rotacja
//   node scripts/backup.js pre-deploy        -> backup z etykieta (bez rotacji, nigdy nie kasowany)
//   node scripts/backup.js <etykieta>        -> backup z dowolna etykieta (bez rotacji)
//
// Pre-deploy: wywolaj PRZED deployem/migracja/zmiana bazy (np. z deploy.ps1).

const backup = require('../services/backup');

const etykieta = process.argv[2] || null;
const wynik = backup.zrobBackup({ etykieta, rotuj: !etykieta });

if (wynik.ok) {
  console.log(`OK: ${wynik.plik}`);
  process.exit(0);
} else {
  console.error(`BLAD: ${wynik.powod}`);
  process.exit(1);
}
