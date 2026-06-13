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

module.exports = db;
