const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(__dirname, 'wms.db');
const INIT_SQL_PATH = path.join(__dirname, '001_init.sql');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const schemaExists = db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lokalizacje'"
).get();

if (!schemaExists) {
  const initSql = fs.readFileSync(INIT_SQL_PATH, 'utf8');
  db.exec(initSql);
  console.log('Baza zainicjalizowana z 001_init.sql');
}

// migracja: dodaj artykul_ean do stany_lokalizacji jesli brak (szukanie po EAN)
const kolumnyStanow = db.prepare("PRAGMA table_info(stany_lokalizacji)").all();
if (!kolumnyStanow.some((k) => k.name === 'artykul_ean')) {
  db.exec('ALTER TABLE stany_lokalizacji ADD COLUMN artykul_ean TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_stany_ean ON stany_lokalizacji(artykul_ean)');
  console.log('Migracja: dodano kolumne artykul_ean do stany_lokalizacji');
}

// migracja: dodaj mag_zrodlo_zewnetrzny do ruchy (przyjecie towaru z zewnatrz)
const kolumnyRuchow = db.prepare("PRAGMA table_info(ruchy)").all();
if (!kolumnyRuchow.some((k) => k.name === 'mag_zrodlo_zewnetrzny')) {
  db.exec('ALTER TABLE ruchy ADD COLUMN mag_zrodlo_zewnetrzny TEXT');
  console.log('Migracja: dodano kolumne mag_zrodlo_zewnetrzny do ruchy');
}

// migracja: dodaj zapas_kod do stany_lokalizacji - adnotacja "zapas" dla K4
// (wyjatek: towar w 2 miejscach, np. zbior A1 + nadmiar P5 -> GT tw_Pole1 "A1/P5").
// Decyzja A z PROGRESS.md - nie dzielimy ilosci, to tylko wskaznik.
if (!kolumnyStanow.some((k) => k.name === 'zapas_kod')) {
  db.exec('ALTER TABLE stany_lokalizacji ADD COLUMN zapas_kod TEXT');
  console.log('Migracja: dodano kolumne zapas_kod do stany_lokalizacji');
}

// plan lokalizacji z GT (K4 i K4G) - zachowany do pelnego przypisania. GT trzyma
// planowane lokalizacje (np. 3), ale pierwszy zapis WMS nadpisuje pole GT i reszta
// planu by przepadla. Tu trzymamy oryginalny tekst GT jako sciage, per magazyn,
// dopoki cos jest nieprzypisane.
const planKolumny = db.prepare("PRAGMA table_info(plan_lokalizacji)").all();
if (planKolumny.length > 0 && !planKolumny.some((k) => k.name === 'magazyn')) {
  db.exec('DROP TABLE plan_lokalizacji'); // plan to cache - bezpiecznie odtworzyc
  console.log('Migracja: przebudowa plan_lokalizacji (dodano magazyn)');
}
db.exec(`CREATE TABLE IF NOT EXISTS plan_lokalizacji (
  artykul_gt_id TEXT,
  magazyn TEXT DEFAULT 'K4G',
  tekst TEXT,
  utworzono TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (artykul_gt_id, magazyn)
)`);

module.exports = db;
