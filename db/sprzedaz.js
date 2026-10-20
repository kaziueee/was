'use strict';

// Baza modułu analiz sprzedaży — OSOBNY plik `db/sprzedaz.db` (docs/analiza-sprzedazy.md). Ekrany czytają tylko
// stąd, nigdy GT — tak moduł jest szybki (wymóg usera 2026-10-20). Dane są pochodne: poza zdjęciami stanów,
// rezerwacji i kosztu z danego dnia da się je odbudować z GT skryptem `scripts/analiza-wczytaj.js`.
// Osobny plik, bo większy niż wms.db i z innym rytmem zapisu (wczytanie historii, job co kilkanaście minut).
//
// Tabele:
//   zamowienia — zamówienie (ZK; bez ZK sama FS; paragon PA): obie daty, kanał + reguła, sumy i zysk
//   pozycje    — towary zamówienia (tw_Rodzaj 1 i 8) z kosztem zakupu z dnia wczytania i zyskiem po rozkładzie
//   skladniki  — zużycie składników przez sprzedane zestawy (tw_Komplet) — pod zakupy i zapas składnika
//   zwroty     — pozycje korekt FS (KFS) z kanałem faktury pierwotnej; osobna kolumna, nie odejmujemy
//   towary     — kopia kartoteki: symbol, nazwa, grupa GT, rodzaj, pierwsze przyjęcie
//   stany      — zdjęcie stanów GT (K4, K4G, MAG, LS, rezerwacje) i stan dostępny z danego dnia
//   tempa      — sprzedaż 30/180/365 dni na towar (FS + zużycie w zestawach), przeliczana przez job — ekran tylko czyta
//   meta       — znaczniki jobów i wczytań

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.SPRZEDAZ_DB || path.join(__dirname, 'sprzedaz.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 15000');   // pisze job WMS-Node i skrypt wczytania historii

db.exec(`
CREATE TABLE IF NOT EXISTS zamowienia (
  id            TEXT PRIMARY KEY,        -- 'Z<zk_id>' gdy jest ZK, 'F<fs_id>' FS bez ZK, 'P<pa_id>' paragon
  zk_id         INTEGER,
  fs_id         INTEGER,
  numer         TEXT,                    -- numer FS (albo ZK / PA)
  status        TEXT NOT NULL,           -- 'zafakturowane' | 'zamowione' (ZK bez FS) | 'paragon'
  data_zam      TEXT NOT NULL,           -- dzień zamówienia (Allegro z UUID, inaczej ZK, bez ZK — FS)
  godz_zam      TEXT,                    -- 'HH:MM', gdy znana (Allegro UUID)
  data_zam_zrodlo TEXT,                  -- 'uuid' | 'zk' | 'fs'
  data_zk       TEXT,
  data_fs       TEXT,
  kanal         TEXT NOT NULL,
  rynek         TEXT,
  kanal_regula  TEXT,                    -- która reguła kaskady dała kanał (services/analiza-kanal.js)
  waluta        TEXT,
  kurs          REAL,                    -- PLN za 1 jednostkę waluty (HUF przeliczony z „za 100”)
  szt           REAL NOT NULL DEFAULT 0, -- towary (rodzaj 1 i 8)
  netto         REAL NOT NULL DEFAULT 0, -- towary, PLN netto
  wysylka_netto REAL,                    -- wysyłka zapłacona przez klienta (wiersze bez towaru / usługi), PLN netto
  wysylka_klienta REAL,                  -- to samo brutto w walucie dokumentu (wejście kalkulatora)
  zysk          REAL,                    -- PLN, po kosztach kanału (albo marża handlowa — zob. zysk_zrodlo)
  zysk_zrodlo   TEXT,                    -- 'kalkulator' | 'kalkulator_pl' (Allegro poza PL) | 'handlowa' | NULL
  wczytano      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_zam_data_zam ON zamowienia(data_zam);
CREATE INDEX IF NOT EXISTS idx_zam_data_fs ON zamowienia(data_fs);
CREATE INDEX IF NOT EXISTS idx_zam_fs ON zamowienia(fs_id);

CREATE TABLE IF NOT EXISTS pozycje (
  zam_id    TEXT NOT NULL,
  tw_id     INTEGER NOT NULL,
  rodzaj    INTEGER,
  szt       REAL NOT NULL,
  netto     REAL NOT NULL,                -- PLN, sam towar
  wysylka   REAL,                         -- udział pozycji w wysyłce klienta (PLN netto, wg wartości) — przychód = netto + wysylka
  cena_wal  REAL,                         -- brutto za sztukę w walucie dokumentu
  koszt     REAL,                         -- koszt zakupu za sztukę z dnia wczytania (PLN netto)
  zysk      REAL                          -- PLN, część zysku zamówienia
);
CREATE INDEX IF NOT EXISTS idx_poz_zam ON pozycje(zam_id);
CREATE INDEX IF NOT EXISTS idx_poz_tw ON pozycje(tw_id);

CREATE TABLE IF NOT EXISTS skladniki (
  zam_id    TEXT NOT NULL,
  zestaw_id INTEGER NOT NULL,
  tw_id     INTEGER NOT NULL,
  szt       REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skl_zam ON skladniki(zam_id);
CREATE INDEX IF NOT EXISTS idx_skl_tw ON skladniki(tw_id);

CREATE TABLE IF NOT EXISTS zwroty (
  kfs_id    INTEGER NOT NULL,
  fs_id     INTEGER,                      -- faktura pierwotna (dok_DoDokId)
  numer     TEXT,
  data      TEXT NOT NULL,
  kanal     TEXT,
  tw_id     INTEGER,                      -- NULL = zwrot wysyłki
  szt       REAL NOT NULL DEFAULT 0,      -- zwrócone sztuki (dodatnie)
  netto     REAL NOT NULL DEFAULT 0       -- wartość zwrotu PLN netto (dodatnia)
);
CREATE INDEX IF NOT EXISTS idx_zwr_data ON zwroty(data);
CREATE INDEX IF NOT EXISTS idx_zwr_kfs ON zwroty(kfs_id);

CREATE TABLE IF NOT EXISTS towary (
  tw_id     INTEGER PRIMARY KEY,
  symbol    TEXT,
  nazwa     TEXT,
  grupa     TEXT,
  rodzaj    INTEGER,
  pierwsze_przyjecie TEXT,
  odswiezono TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stany (
  tw_id     INTEGER NOT NULL,
  dzien     TEXT NOT NULL,
  k4        REAL, k4g REAL, mag REAL, ls REAL,
  rez_k4    REAL,
  razem     REAL,                         -- K4+K4G+MAG+LS (bez BRK i K4R, jak MAGAZYNY_RAZEM)
  rez       REAL,                         -- rezerwacje na tych samych magazynach
  dostepne  REAL,                         -- razem − rez; zestaw: ile kompletów da się złożyć ze składników
  czas      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tw_id, dzien)
);

CREATE TABLE IF NOT EXISTS tempa (
  tw_id     INTEGER PRIMARY KEY,
  szt30     REAL NOT NULL DEFAULT 0,
  szt180    REAL NOT NULL DEFAULT 0,
  szt365    REAL NOT NULL DEFAULT 0,
  dzien     TEXT NOT NULL                 -- dzień, na który policzone
);

CREATE TABLE IF NOT EXISTS meta (
  klucz     TEXT PRIMARY KEY,
  wartosc   TEXT,
  czas      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

// Migracje (baza powstała przed kolumną). Przychód = cała faktura — decyzja usera 2026-10-20 po porównaniu z Metabase.
const kolumny = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((k) => k.name);
if (!kolumny('zamowienia').includes('wysylka_netto')) db.exec('ALTER TABLE zamowienia ADD COLUMN wysylka_netto REAL');
if (!kolumny('pozycje').includes('wysylka')) db.exec('ALTER TABLE pozycje ADD COLUMN wysylka REAL');
// Stan dostępny (decyzja usera 2026-10-21: na ekranach „Razem minus rezerwacje”, zestaw po składnikach jak repricer)
if (!kolumny('stany').includes('rez')) db.exec('ALTER TABLE stany ADD COLUMN rez REAL');
if (!kolumny('stany').includes('dostepne')) db.exec('ALTER TABLE stany ADD COLUMN dostepne REAL');

const meta = {
  get: (k) => db.prepare('SELECT wartosc, czas FROM meta WHERE klucz = ?').get(k) || null,
  set: (k, v) => db.prepare(`INSERT INTO meta (klucz, wartosc, czas) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(klucz) DO UPDATE SET wartosc = excluded.wartosc, czas = excluded.czas`).run(k, v == null ? null : String(v)),
};

module.exports = { db, DB_PATH, meta };
