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
//   zmiany      — ręczne działania ludzi (włącz/wyłącz automat, ręczna cena, granice)
//   stan        — znaczniki czasu workera
//   katalog     — czy towar ma gotową kartę produktu na rynku (nocny skan, pricing/katalogi.js)
//   wystawienia — oferty założone z ekranu Ceny → „Do wystawienia” (pricing/wystawianie.js)

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.PRICING_DB || path.join(__dirname, '..', 'db', 'pricing.db');

const db = new DatabaseSync(DB_PATH);
// Bazę piszą trzy procesy: worker, WMS (przełącznik automatu na ekranie Ceny) i skrypty CLI. Bez
// czasu oczekiwania drugi piszący dostaje „database is locked” od razu, gdy worker akurat zapisuje
// przebieg (2026-10-15: emag-cena.js wysłał cenę BG, a wpis do logu przepadł). PRZED journal_mode —
// przełączenie na WAL też bierze blokadę, a procesy startujące razem na świeżej bazie padały na nim.
db.exec('PRAGMA busy_timeout = 15000');
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS oferty (
  id            INTEGER PRIMARY KEY,
  platforma     TEXT NOT NULL,              -- 'amazon' | 'emag' | 'empik' | ...
  rynek         TEXT NOT NULL,              -- 'DE', 'FR', 'PL', ...
  sku           TEXT NOT NULL,              -- SKU oferty na platformie
  asin          TEXT,                       -- identyfikator produktu na platformie: ASIN (Amazon) / PNK (eMAG)
  tw_id         INTEGER,                    -- tw__Towar.tw_Id (NULL = nie dopasowano)
  symbol_gt     TEXT,                       -- kopia do wyświetlania, kluczem jest tw_id
  dopasowanie   TEXT,                       -- 'wprost' | 'obciete' (SKU z dopiskiem -1/-DE) | 'reczne' | NULL = brak
  nazwa         TEXT,
  cena          REAL,                       -- cena towaru z ostatniej synchronizacji listy
  ilosc         INTEGER,
  kanal         TEXT,                       -- 'DEFAULT' = wysyłka sprzedawcy, 'AMAZON_EU' = FBA
  auto          INTEGER NOT NULL DEFAULT 0, -- 1 = automat zmienia cenę na platformie, 0 = ręczny (domyślnie)
  genius        INTEGER,                    -- eMAG: 1 = Genius aktywny (genius_computed > 0), 0 = nie; NULL = nie dotyczy
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
  bb_nasza_inna  INTEGER,                   -- 1 = Buy Box ma NASZA inna oferta tego samego ASIN-u
  widziana       TEXT                       -- ostatni przebieg, który widział TEN SAM stan (kanały tylko do odczytu)
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
  akcja       TEXT NOT NULL,                -- 'automat_wl' | 'automat_wyl' | 'korekta_ceny' | 'granice' | ...
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
if (!kolOferty.includes('genius')) db.exec('ALTER TABLE oferty ADD COLUMN genius INTEGER');
// Powód, dla którego platforma wstrzymała ofertę (eMAG „Invalid price” / Blocked / Draft, Kaufland — cena do
// sprawdzenia); NULL = sprzedaje się.
if (!kolOferty.includes('blokada')) db.exec('ALTER TABLE oferty ADD COLUMN blokada TEXT');
// eMAG: oferta włączona (status 1), ale platforma jej nie sprzedaje (Invalid price / Blocked / Draft) — wtedy
// aktywna = 0 (bez automatu i obserwacji), a wstrzymana = 1, żeby Ceny dalej ją pokazywały. `walidacja` = surowe
// offer_validation_status + validation_status z API (pricing/emag.js opisWalidacji).
if (!kolOferty.includes('wstrzymana')) db.exec('ALTER TABLE oferty ADD COLUMN wstrzymana INTEGER NOT NULL DEFAULT 0');
if (!kolOferty.includes('walidacja')) db.exec('ALTER TABLE oferty ADD COLUMN walidacja TEXT');
// Stawka prowizji platformy dla TEJ oferty (eMAG: commission/estimate, % od ceny bez VAT) i kiedy pobrana.
if (!kolOferty.includes('prowizja')) db.exec('ALTER TABLE oferty ADD COLUMN prowizja REAL');
if (!kolOferty.includes('prowizja_czas')) db.exec('ALTER TABLE oferty ADD COLUMN prowizja_czas TEXT');
// Kategoria produktu na platformie (Empik: kod i nazwa z P11) — z niej stawka prowizji oferty.
if (!kolOferty.includes('kategoria')) db.exec('ALTER TABLE oferty ADD COLUMN kategoria TEXT');
if (!kolOferty.includes('kategoria_nazwa')) db.exec('ALTER TABLE oferty ADD COLUMN kategoria_nazwa TEXT');
// Ręczne granice repricera dla TEJ oferty (kwota w walucie rynku); NULL = z kalkulatora (pricing/granice.js).
// Tylko w WMS — zakresu min/max w panelu platformy nie dotykamy (decyzja usera 2026-10-16).
if (!kolOferty.includes('min_reczne')) db.exec('ALTER TABLE oferty ADD COLUMN min_reczne REAL');
if (!kolOferty.includes('max_reczne')) db.exec('ALTER TABLE oferty ADD COLUMN max_reczne REAL');
// Allegro + Niezbędnik (pricing/konkurencja-allegro.js): EAN towaru z GT (klucz sprawdzenia konkurencji), jak często
// sprawdzać (godziny, NULL = domyślnie 4) i o ile przebijać konkurenta (zł, NULL = 1 gr) — ustawiane przy ofercie.
if (!kolOferty.includes('ean')) db.exec('ALTER TABLE oferty ADD COLUMN ean TEXT');
if (!kolOferty.includes('konk_co_h')) db.exec('ALTER TABLE oferty ADD COLUMN konk_co_h INTEGER');
if (!kolOferty.includes('konk_przebicie')) db.exec('ALTER TABLE oferty ADD COLUMN konk_przebicie REAL');
// Skąd EAN (allegro = produkt z katalogu Allegro, gt = Subiekt) i kiedy sprawdzony — odświeżany raz na dobę.
if (!kolOferty.includes('ean_zrodlo')) db.exec('ALTER TABLE oferty ADD COLUMN ean_zrodlo TEXT');
if (!kolOferty.includes('ean_czas')) db.exec('ALTER TABLE oferty ADD COLUMN ean_czas TEXT');
// `oferty.zapis` (osobny przełącznik wysyłania, tryb Próba) zlikwidowany 2026-10-13 — w starszych
// bazach kolumna zostaje, nic jej nie czyta: automat = wysyła, ręczny = nie.
const kolObs = db.prepare('PRAGMA table_info(obserwacje)').all().map((k) => k.name);
if (!kolObs.includes('bb_nasza_inna')) db.exec('ALTER TABLE obserwacje ADD COLUMN bb_nasza_inna INTEGER');
if (!kolObs.includes('widziana')) db.exec('ALTER TABLE obserwacje ADD COLUMN widziana TEXT');
const kolDecyzje = db.prepare('PRAGMA table_info(decyzje)').all().map((k) => k.name);
for (const [k, typ] of [['auto', 'INTEGER'], ['zysk', 'REAL'], ['marza', 'REAL'], ['zysk_nowa', 'REAL'], ['marza_nowa', 'REAL'], ['cena_cel', 'REAL'], ['zysk_cel', 'REAL']]) {
  if (!kolDecyzje.includes(k)) db.exec(`ALTER TABLE decyzje ADD COLUMN ${k} ${typ}`);
}

// Allegro: raport „Czynniki wpływające na wybór Top oferty” wgrany z ekranu Ceny (pricing/allegro-top.js).
// Jeden wiersz na ofertę (konto, numer oferty), nowszy raport nadpisuje. cena_top = cena Top oferty kwotowo.
db.exec(`CREATE TABLE IF NOT EXISTS allegro_top (
  konto        TEXT NOT NULL,              -- EKAJTEK | NATROPIE (pricing/allegro.js KONTA)
  oferta       TEXT NOT NULL,              -- numer oferty Allegro (= oferty.asin)
  produkt      TEXT,                       -- ID produktu w katalogu Allegro
  cena_ocena   TEXT,                       -- 'za wysoka' | 'odpowiednia'
  roznica      REAL,                       -- o ile nasza cena przewyższa Top ofertę (zł)
  cena_nasza   REAL,                       -- nasza cena w chwili importu
  cena_top     REAL,                       -- cena Top oferty (nasza − różnica), NULL gdy to my
  czynniki     TEXT,                       -- JSON: promowanie, jakosc, stan, zdjecia, gnc, dostawa
  raport_czas  TEXT NOT NULL,              -- kiedy wgrano raport (UTC)
  kto          TEXT,
  PRIMARY KEY (konto, oferta)
)`);

// Allegro: ostatnie sprawdzenie konkurencji w Niezbędniku per EAN (pricing/konkurencja-allegro.js). Jeden EAN
// obsługuje obie nasze oferty tego towaru (ekajtek i NaTropie). Nieudane sprawdzenie zostawia poprzedni wynik.
db.exec(`CREATE TABLE IF NOT EXISTS allegro_konkurencja (
  ean          TEXT PRIMARY KEY,
  czas         TEXT,                       -- kiedy Niezbędnik sprawdził (UTC); NULL = zlecone, jeszcze bez wyniku
  oferty       TEXT,                       -- JSON: oferty z wyniku (pricing/konkurencja-allegro.js zWyniku), ≤60
  wszystkich   INTEGER,                    -- ile ofert Allegro znalazło (wynik ma najwyżej 60)
  blad         TEXT,                       -- błąd ostatniego sprawdzenia (poprzedni wynik zostaje)
  raport       TEXT,                       -- id raportu Niezbędnika
  zlecono      TEXT                        -- kiedy ostatnio zlecone (harmonogram liczy od tego, gdy brak wyniku)
)`);

// Strategie cenowe per towar (pricing/strategie.js, zakładka Ceny → Strategie). Domyślna „All marża 20” nie ma
// wiersza: towar bez przypisania = dzisiejszy kalkulator. aktywna = 0 to PODGLĄD (pas liczony i pokazywany,
// automat go nie używa), 1 = automat używa (decyzja usera 2026-10-19: wdrożenie kontrolowane).
db.exec(`CREATE TABLE IF NOT EXISTS strategie (
  id           INTEGER PRIMARY KEY,
  nazwa        TEXT NOT NULL UNIQUE,
  typ          TEXT NOT NULL,              -- 'marza' | 'wyprzedaz' | 'za_rynkiem'
  parametry    TEXT NOT NULL,              -- JSON, komplet po walidacji (pricing/strategie.js walidujStrategie)
  aktywna      INTEGER NOT NULL DEFAULT 0, -- 0 = podgląd, 1 = automat używa
  kto          TEXT,
  czas         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  zmieniona    TEXT
)`);
// Jeden towar = najwyżej jedna strategia. `do` = ostatni dzień (lokalnie, włącznie); po nim worker zdejmuje
// przypisanie i zapisuje to w `zmiany` (strategia_koniec). Historia przypisań też w `zmiany`.
db.exec(`CREATE TABLE IF NOT EXISTS strategie_towarow (
  tw_id        INTEGER PRIMARY KEY,
  strategia_id INTEGER NOT NULL REFERENCES strategie(id),
  symbol_gt    TEXT,
  do           TEXT,
  kto          TEXT,
  czas         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);

// Katalogi platform (pricing/katalogi.js, nocny skan w workerze): czy nasz towar ze stanem ma na danym rynku gotową
// kartę produktu (eMAG PNK, ASIN, Kaufland id_product) — z tego ekran Ceny → „Do wystawienia” wybiera kandydatów.
// Jeden wiersz na (towar, platforma, rynek); towar bez produktu na rynku też ma wiersz (produkt_id NULL), żeby było
// wiadomo, że sprawdzony. `ograniczenie` = powód, dla którego platforma nie da nam wystawić (Amazon restrictions,
// eMAG marka z kategorii wysokiego ryzyka — z odrzuconego wystawienia); NULL = wolno.
db.exec(`CREATE TABLE IF NOT EXISTS katalog (
  tw_id        INTEGER NOT NULL,
  platforma    TEXT NOT NULL,
  rynek        TEXT NOT NULL,
  ean          TEXT NOT NULL,
  produkt_id   TEXT,                       -- PNK / ASIN / id_product; NULL = platforma nie zna EAN-u
  nazwa        TEXT,                       -- nazwa produktu NA PLATFORMIE (eMAG save jej wymaga)
  marka        TEXT,
  kategoria    TEXT,
  kategoria_id TEXT,                       -- eMAG doc_category_id (save jej wymaga)
  dodac        INTEGER,                    -- eMAG allowed_to_add_offer; NULL = platforma nie mówi
  mamy         INTEGER,                    -- platforma twierdzi, że mamy już ofertę (eMAG vendor_has_offer)
  hotness      TEXT,
  ograniczenie TEXT,
  sprawdzono   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tw_id, platforma, rynek)
)`);

// Najniższa cena TOWARU konkurencji na rynku (bez wysyłki, brutto w walucie rynku) — do propozycji ceny startowej.
// Kaufland /buybox, Empik P11; eMAG nie podaje cen cudzych ofert w API. Pisze nocny skan (pricing/katalogi.js).
const kolKatalog = db.prepare('PRAGMA table_info(katalog)').all().map((k) => k.name);
if (!kolKatalog.includes('cena_rynek')) db.exec('ALTER TABLE katalog ADD COLUMN cena_rynek REAL');
if (!kolKatalog.includes('ofert_rynek')) db.exec('ALTER TABLE katalog ADD COLUMN ofert_rynek INTEGER');
if (!kolKatalog.includes('cena_rynek_czas')) db.exec('ALTER TABLE katalog ADD COLUMN cena_rynek_czas TEXT');

// Oferty założone przez WMS (Ceny → „Do wystawienia”, pricing/wystawianie.js) — każda próba, także odrzucona.
// status: wyslane (platforma przyjęła, czekamy na sync) → widoczna (sync znalazł ofertę; gdy auto_po = 1 automat
// już włączony) | odrzucone (platforma odmówiła — opis) | blad (nie wiemy, czy powstała — sprawdzić w panelu).
// sellasist = 1, gdy user potwierdził podpięcie oferty w Sellasist (to on pilnuje potem stanu — decyzja 2026-10-30).
db.exec(`CREATE TABLE IF NOT EXISTS wystawienia (
  id           INTEGER PRIMARY KEY,
  czas         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  kto          TEXT,
  tw_id        INTEGER NOT NULL,
  platforma    TEXT NOT NULL,
  rynek        TEXT NOT NULL,
  sku          TEXT NOT NULL,
  ean          TEXT,
  produkt_id   TEXT,
  id_platformy TEXT,                       -- eMAG: nasze id oferty (vendor_ext_id)
  cena         REAL,                       -- brutto, waluta rynku
  ilosc        INTEGER,
  status       TEXT NOT NULL,
  opis         TEXT,
  auto_po      INTEGER NOT NULL DEFAULT 1,
  oferta_id    INTEGER,                    -- oferty.id po dopięciu przez sync
  sellasist    INTEGER NOT NULL DEFAULT 0
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_wyst_status ON wystawienia(status, platforma, rynek)');

const stan = {
  get: (k) => db.prepare('SELECT wartosc, czas FROM stan WHERE klucz = ?').get(k) || null,
  set: (k, v) => db.prepare(`INSERT INTO stan (klucz, wartosc, czas) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (klucz) DO UPDATE SET wartosc = excluded.wartosc, czas = CURRENT_TIMESTAMP`).run(k, String(v)),
};

module.exports = { db, DB_PATH, stan };
