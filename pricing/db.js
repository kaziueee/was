'use strict';

// Baza repricera — OSOBNY plik `db/pricing.db`, nie `wms.db`. Repricer chodzi jako osobny proces
// i zapisuje często (obserwacje co przebieg); wspólny plik z WMS oznaczałby walkę o blokadę zapisu
// z ruchami magazynowymi. WMS czyta tę bazę tylko do wyświetlania.
//
// Tabele:
//   oferty      — nasze oferty na rynkach (SKU rynku → tw_Id w GT) + stan automatu
//   powiazania  — ręczne SKU → tw_Id (wygrywa z automatem, przeżywa synchronizację)
//   obserwacje  — co widzieliśmy przy każdym przebiegu (nasza cena, Buy Box, konkurencja)
//   decyzje     — co repricer postanowił i czy wysłał (log „dlaczego ta cena")
//   zmiany      — ręczne działania ludzi (włącz/wyłącz automat)
//   stan        — znaczniki czasu workera

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.PRICING_DB || path.join(__dirname, '..', 'db', 'pricing.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS oferty (
  id            INTEGER PRIMARY KEY,
  platforma     TEXT NOT NULL,              -- 'amazon' | 'emag' | 'empik' | ...
  rynek         TEXT NOT NULL,              -- 'DE', 'FR', 'PL', ...
  sku           TEXT NOT NULL,              -- SKU oferty na platformie
  asin          TEXT,
  tw_id         INTEGER,                    -- tw__Towar.tw_Id (NULL = nie dopasowano)
  symbol_gt     TEXT,                       -- kopia do wyświetlania, kluczem jest tw_id
  dopasowanie   TEXT,                       -- 'wprost' | 'obciete' (SKU z dopiskiem -1/-DE) | 'reczne' | NULL = brak
  nazwa         TEXT,
  cena          REAL,                       -- cena towaru z ostatniej synchronizacji listy
  ilosc         INTEGER,
  kanal         TEXT,                       -- 'DEFAULT' = wysyłka sprzedawcy, 'AMAZON_EU' = FBA
  auto          INTEGER NOT NULL DEFAULT 0, -- 1 = automat zmienia cenę na platformie, 0 = ręczny (domyślnie)
  aktywna       INTEGER NOT NULL DEFAULT 1, -- 0 = zniknęła z raportu platformy
  widziana      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (platforma, rynek, sku)
);
CREATE INDEX IF NOT EXISTS idx_oferty_tw ON oferty(tw_id);

-- Ręczne powiązanie SKU oferty z towarem GT. Wygrywa z automatycznym dopasowaniem
-- (pricing/mapowanie.js) i przeżywa każdą synchronizację listy ofert. Potrzebne, gdy oferta
-- ma SKU niepodobne do symbolu GT albo gdy automat dopasował ją do złego towaru.
CREATE TABLE IF NOT EXISTS powiazania (
  platforma   TEXT NOT NULL,
  sku         TEXT NOT NULL,
  tw_id       INTEGER NOT NULL,
  symbol_gt   TEXT,
  kto         TEXT,
  czas        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (platforma, sku)
);

CREATE TABLE IF NOT EXISTS obserwacje (
  id             INTEGER PRIMARY KEY,
  oferta_id      INTEGER NOT NULL REFERENCES oferty(id),
  czas           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cena           REAL,
  wysylka        REAL,
  bb_nasz        INTEGER,                   -- 1/0/NULL
  bb_cena        REAL,                      -- landed (z wysyłką)
  bb_fba         INTEGER,
  najtansza_inna REAL,                      -- landed
  ofert          INTEGER,
  bb_nasza_inna  INTEGER                    -- 1 = Buy Box ma NASZA inna oferta tego samego ASIN-u
);
CREATE INDEX IF NOT EXISTS idx_obs_oferta ON obserwacje(oferta_id, czas);

CREATE TABLE IF NOT EXISTS decyzje (
  id          INTEGER PRIMARY KEY,
  oferta_id   INTEGER NOT NULL REFERENCES oferty(id),
  czas        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cena_przed  REAL,
  cena_nowa   REAL,
  min         REAL,
  max         REAL,
  kod         TEXT,
  powod       TEXT,
  wyslano     INTEGER NOT NULL DEFAULT 0,   -- 1 = wysłane na platformę (0 = ręczny / bez zmiany / hamulec / błąd)
  blad        TEXT,
  auto        INTEGER,                      -- czy automat był włączony w chwili decyzji
  zysk        REAL,                         -- zł/szt. przy cenie_przed (kalkulator WMS)
  marza       REAL,                         -- % przy cenie_przed
  zysk_nowa   REAL,                         -- zł/szt. przy cenie_nowa
  marza_nowa  REAL,                         -- % przy cenie_nowa
  cena_cel    REAL,                         -- cena docelowa (bez limitu schodka)
  zysk_cel    REAL                          -- zł/szt. przy cenie docelowej
);
CREATE INDEX IF NOT EXISTS idx_dec_oferta ON decyzje(oferta_id, czas);

-- Zmiany robione przez człowieka (włącz/wyłącz automat, powiązanie) — kto i kiedy.
CREATE TABLE IF NOT EXISTS zmiany (
  id          INTEGER PRIMARY KEY,
  czas        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  kto         TEXT,
  oferta_id   INTEGER,
  akcja       TEXT NOT NULL,                -- 'automat_wl' | 'automat_wyl' | ...
  opis        TEXT
);

-- Drobny stan workera (czas ostatniego pełnego przebiegu, synchronizacji listy).
CREATE TABLE IF NOT EXISTS stan (
  klucz       TEXT PRIMARY KEY,
  wartosc     TEXT,
  czas        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

// migracje dla baz założonych przed dodaniem kolumn
const kolOferty = db.prepare('PRAGMA table_info(oferty)').all().map((k) => k.name);
if (!kolOferty.includes('dopasowanie')) db.exec('ALTER TABLE oferty ADD COLUMN dopasowanie TEXT');
// `oferty.zapis` (osobny przełącznik wysyłania, tryb Próba) zlikwidowany 2026-10-13 — w starszych
// bazach kolumna zostaje, nic jej nie czyta: automat = wysyła, ręczny = nie.
const kolObs = db.prepare('PRAGMA table_info(obserwacje)').all().map((k) => k.name);
if (!kolObs.includes('bb_nasza_inna')) db.exec('ALTER TABLE obserwacje ADD COLUMN bb_nasza_inna INTEGER');
const kolDecyzje = db.prepare('PRAGMA table_info(decyzje)').all().map((k) => k.name);
for (const [k, typ] of [['auto', 'INTEGER'], ['zysk', 'REAL'], ['marza', 'REAL'], ['zysk_nowa', 'REAL'], ['marza_nowa', 'REAL'], ['cena_cel', 'REAL'], ['zysk_cel', 'REAL']]) {
  if (!kolDecyzje.includes(k)) db.exec(`ALTER TABLE decyzje ADD COLUMN ${k} ${typ}`);
}

const stan = {
  get: (k) => db.prepare('SELECT wartosc, czas FROM stan WHERE klucz = ?').get(k) || null,
  set: (k, v) => db.prepare(`INSERT INTO stan (klucz, wartosc, czas) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (klucz) DO UPDATE SET wartosc = excluded.wartosc, czas = CURRENT_TIMESTAMP`).run(k, String(v)),
};

module.exports = { db, DB_PATH, stan };
