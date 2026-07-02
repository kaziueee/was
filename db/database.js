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

// migracja: dodaj dok_gt_id (PK dokumentu GT) do ruchy. dok_NrPelny NIE jest unikalny
// (numeracja MM resetuje sie per magazyn/rok), wiec sam numer nie identyfikuje dokumentu
// jednoznacznie - dok_Id (PK sl. dok__Dokument) domyka gwarancje zgodnosci numeru WMS<->GT.
if (!kolumnyRuchow.some((k) => k.name === 'dok_gt_id')) {
  db.exec('ALTER TABLE ruchy ADD COLUMN dok_gt_id INTEGER');
  console.log('Migracja: dodano kolumne dok_gt_id do ruchy');
}

// migracja: licznik prob wystawienia MM (Faza A#3 - prewencja duplikatow). Rosnie o 1
// tuz przed kazdym wywolaniem mostu. Gdy > 0, ruch byl juz probowany - przy ponowieniu
// najpierw szukamy w GT dokumentu z kluczem WMS-RUCH:<id> (odpowiedz HTTP mogla zaginac),
// zamiast wystawiac drugi MM. Na happy-path (proba 1) pre-check pomijamy (brak skanu GT).
if (!kolumnyRuchow.some((k) => k.name === 'mm_proby')) {
  db.exec('ALTER TABLE ruchy ADD COLUMN mm_proby INTEGER NOT NULL DEFAULT 0');
  console.log('Migracja: dodano kolumne mm_proby do ruchy');
}

// migracja: dodaj zapas_kod do stany_lokalizacji - adnotacja "zapas" dla K4
// (wyjatek: towar w 2 miejscach, np. zbior A1 + nadmiar P5 -> GT tw_Pole1 "A1/P5").
// Decyzja A z PROGRESS.md - nie dzielimy ilosci, to tylko wskaznik.
if (!kolumnyStanow.some((k) => k.name === 'zapas_kod')) {
  db.exec('ALTER TABLE stany_lokalizacji ADD COLUMN zapas_kod TEXT');
  console.log('Migracja: dodano kolumne zapas_kod do stany_lokalizacji');
}

// migracja: cechy strukturalne lokalizacji (hala/regal/alejka/strona/kolumna/poziom/typ).
// Wyliczane z kodu deterministycznie (services/lokalizacje-model) - do filtrowania/
// raportowania na przyszlosc. Istniejace wiersze backfillowane z ich kodu.
const kolumnyLok = db.prepare("PRAGMA table_info(lokalizacje)").all();
if (!kolumnyLok.some((k) => k.name === 'typ')) {
  for (const kol of ['hala TEXT', 'regal TEXT', 'alejka INTEGER', 'strona TEXT', 'kolumna INTEGER', 'typ TEXT']) {
    db.exec(`ALTER TABLE lokalizacje ADD COLUMN ${kol}`);
  }
  const { rozbierzKod } = require('../services/lokalizacje-model');
  const wiersze = db.prepare('SELECT id, kod, magazyn FROM lokalizacje').all();
  const upd = db.prepare('UPDATE lokalizacje SET hala=?, regal=?, alejka=?, strona=?, kolumna=?, typ=? WHERE id=?');
  db.exec('BEGIN');
  for (const w of wiersze) {
    const c = rozbierzKod(w.kod, w.magazyn);
    upd.run(c.hala, c.regal, c.alejka, c.strona, c.kolumna, c.typ, w.id);
  }
  db.exec('COMMIT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_lok_typ ON lokalizacje(typ)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_lok_alejka ON lokalizacje(alejka)');
  console.log(`Migracja: dodano cechy strukturalne lokalizacji (backfill ${wiersze.length} wierszy)`);
}

// migracja: usun kolumne poziom - wynika wprost z kodu lokalizacji, nie trzymamy osobno
if (kolumnyLok.some((k) => k.name === 'poziom')) {
  db.exec('ALTER TABLE lokalizacje DROP COLUMN poziom');
  console.log('Migracja: usunieto kolumne poziom z lokalizacje (wynika z kodu)');
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

// audyt biznesowy "kto/co/gdzie/kiedy" (Faza A#2) - jeden strumien: ruchy + zmiany
// lokalizacji/planu/zapasu. OSOBNY od logu awarii (services/awarie.js, pliki) i od tabeli
// ruchy (operacyjna/kolejka). Append-only. Patrz PROGRESS.md "Specyfikacja: logi + backup".
db.exec(`CREATE TABLE IF NOT EXISTS audyt (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  czas DATETIME DEFAULT CURRENT_TIMESTAMP,
  uzytkownik TEXT,
  akcja TEXT NOT NULL,
  artykul_gt_id TEXT,
  artykul_symbol TEXT,
  magazyn TEXT,
  lokalizacja TEXT,
  przed TEXT,
  po TEXT,
  ilosc DECIMAL,
  wynik TEXT,
  ruch_id INTEGER,
  dok_gt_numer TEXT,
  szczegoly TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_audyt_czas ON audyt(czas)');
db.exec('CREATE INDEX IF NOT EXISTS idx_audyt_artykul ON audyt(artykul_gt_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_audyt_uzytkownik ON audyt(uzytkownik)');

// Uzytkownicy + logowanie (Faza A#4). PIN opcjonalny (pin_hash/pin_salt NULL = bez PIN).
// Rola: 'admin' (zarzadza userami) | 'magazynier'. Dezaktywacja (aktywny=0) zamiast
// usuwania - zachowuje slad "kto" w audycie/ruchach.
db.exec(`CREATE TABLE IF NOT EXISTS uzytkownicy (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  imie TEXT NOT NULL UNIQUE,
  pin_hash TEXT,
  pin_salt TEXT,
  rola TEXT NOT NULL DEFAULT 'magazynier',
  aktywny INTEGER NOT NULL DEFAULT 1,
  utworzono DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Sesje: token -> uzytkownik. "Kto" wyprowadzany z tokenu (backend = zrodlo prawdy),
// nie z pola tekstowego. ostatnia_aktywnosc do wygaszania nieaktywnych sesji.
db.exec(`CREATE TABLE IF NOT EXISTS sesje (
  token TEXT PRIMARY KEY,
  uzytkownik_id INTEGER NOT NULL REFERENCES uzytkownicy(id),
  imie TEXT NOT NULL,
  rola TEXT NOT NULL,
  utworzono DATETIME DEFAULT CURRENT_TIMESTAMP,
  ostatnia_aktywnosc DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Blokady edycji produktu (twarda blokada): 1 wiersz = 1 produkt aktualnie edytowany.
// heartbeat odswiezany przez klienta; lock wygasa po bezczynnosci (patrz services/blokady).
db.exec(`CREATE TABLE IF NOT EXISTS blokady_edycji (
  artykul_gt_id TEXT PRIMARY KEY,
  uzytkownik_id INTEGER,
  imie TEXT,
  token TEXT,
  czas_start DATETIME DEFAULT CURRENT_TIMESTAMP,
  heartbeat DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Seed: pierwszy admin, gdy brak uzytkownikow (bez PIN - mozna od razu wejsc i zalozyc reszte).
if (db.prepare('SELECT COUNT(*) AS c FROM uzytkownicy').get().c === 0) {
  db.prepare("INSERT INTO uzytkownicy (imie, rola) VALUES ('Admin', 'admin')").run();
  console.log("Seed: utworzono uzytkownika 'Admin' (rola admin, bez PIN)");
}

module.exports = db;
