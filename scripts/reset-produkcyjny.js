'use strict';

// Reset produkcyjny WMS: czyści dane operacyjne/statusy/logi zebrane wobec bazy
// TESTOWEJ, zostawiając fizyczny magazyn (lokalizacje) i użytkowników. Uruchamiać
// PRZY przełączeniu na produkcyjną bazę GT (inne tw_Id/stany => stare dane bez sensu).
//
//   node scripts/reset-produkcyjny.js         -> pokazuje co zrobi (dry-run), nie zmienia nic
//   node scripts/reset-produkcyjny.js --tak    -> wykonuje (po backupie)
//
// WAŻNE: zatrzymaj serwer (task WMS-Node) przed uruchomieniem - inaczej możliwe
// "database is locked" przy równoległych zapisach.

const backup = require('../services/backup');
const db = require('../db/database');

// Tabele czyszczone (dane liczone wobec starej bazy). Kolejność bez znaczenia (brak FK między nimi
// poza lok_* w ruchy -> lokalizacje, ale kasujemy ruchy, nie lokalizacje).
const DO_WYCZYSZCZENIA = [
  'stany_lokalizacji', // przypisania towar->lokalizacja (statusy "gdzie lezy produkt")
  'ruchy',             // log przesuniec / MM
  'audyt',             // log zdarzen (w tym sprawdzenia sciezek)
  'rozjazdy',          // rozjazdy GT<->WMS
  'pulpit_snapshot',   // zcache'owane statusy zgodnosci (przelicza sie)
  'plan_lokalizacji',  // cache planu z GT (odczyta sie z produkcji)
  'sesje',             // sesje logowania (wyloguje biezacych)
  'blokady_edycji',    // blokady edycji produktu
];

// NIE ruszamy: lokalizacje (fizyczny magazyn), uzytkownicy (realne konta).
const ZACHOWANE = ['lokalizacje', 'uzytkownicy'];

function policz(tabela) {
  try { return db.prepare(`SELECT COUNT(*) AS c FROM ${tabela}`).get().c; }
  catch { return '(brak tabeli)'; }
}

const wykonaj = process.argv.includes('--tak');

console.log('=== Reset produkcyjny WMS ===');
console.log('Stan przed:');
for (const t of [...DO_WYCZYSZCZENIA, ...ZACHOWANE]) {
  const znacznik = ZACHOWANE.includes(t) ? '[ZOSTAJE]' : '[czyszcze]';
  console.log(`  ${znacznik} ${t}: ${policz(t)}`);
}

if (!wykonaj) {
  console.log('\nDRY-RUN. Nic nie zmieniono. Aby wykonac: node scripts/reset-produkcyjny.js --tak');
  process.exit(0);
}

// 1) backup z etykieta (bez rotacji - nigdy nie skasowany)
console.log('\nBackup przed resetem...');
const wynik = backup.zrobBackup({ etykieta: 'pre-reset-produkcyjny', rotuj: false });
if (!wynik.ok) {
  console.error(`BLAD backupu: ${wynik.powod} - PRZERYWAM (nie czyszcze bez kopii).`);
  process.exit(1);
}
console.log(`Backup OK: ${wynik.plik}`);

// 2) czyszczenie w transakcji
db.exec('BEGIN');
try {
  for (const t of DO_WYCZYSZCZENIA) {
    db.exec(`DELETE FROM ${t}`);
    // wyzeruj autoincrement tam gdzie jest
    db.exec(`DELETE FROM sqlite_sequence WHERE name = '${t}'`);
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error(`BLAD czyszczenia: ${e.message} - wycofano (ROLLBACK).`);
  process.exit(1);
}

// 3) checkpoint WAL (spójny plik)
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

console.log('\nStan po:');
for (const t of [...DO_WYCZYSZCZENIA, ...ZACHOWANE]) {
  console.log(`  ${t}: ${policz(t)}`);
}
console.log('\nGOTOWE. Uruchom serwer (WMS-START.cmd / schtasks /Run /TN WMS-Node).');
