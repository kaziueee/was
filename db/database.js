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

// migracja: dodaj mag_zrodlo_pula do ruchy - MM z NIEPRZYPISANEJ puli magazynu WMS
// (dostawa stoi na K4 wg GT, ale nie ma jeszcze lokalizacji WMS - jedzie prosto na K4G).
// Osobna kolumna, a NIE mag_zrodlo_zewnetrzny: to drugie znaczy "przyjecie z MAG/LS" i jest
// czytane przez Sciezki jako "swiezo dolozony stan, pomin przez 30 dni" (services/sciezki.js).
// Wpisanie tam 'K4' zatrulo by tamten filtr.
if (!kolumnyRuchow.some((k) => k.name === 'mag_zrodlo_pula')) {
  db.exec('ALTER TABLE ruchy ADD COLUMN mag_zrodlo_pula TEXT');
  console.log('Migracja: dodano kolumne mag_zrodlo_pula do ruchy');
}

// migracja: dodaj zrodlo_dok do ruchy - numer dokumentu GT, z ktorego pochodzi rozkladana
// pula (PZ dostawy albo PZ zwrotu). Bez tego "ile z tej dostawy juz rozlozono" trzeba by
// zgadywac heurystyka po sumie ruchow z mag_zrodlo_pula - a gdy SKU ma naraz dostawe i zwrot,
// nie da sie ich rozroznic i rozlozenie jednego zjadaloby licznik drugiego.
if (!kolumnyRuchow.some((k) => k.name === 'zrodlo_dok')) {
  db.exec('ALTER TABLE ruchy ADD COLUMN zrodlo_dok TEXT');
  console.log('Migracja: dodano kolumne zrodlo_dok do ruchy');
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

// Wozki zwrotow. Wozek to FIZYCZNY przedmiot: osoba wystawiajaca korekte klade na niego towar
// od reki, a potem go zamyka i odwozi. Dlatego jako jedyna sciezka ma wlasna tabele - reszta
// wystarcza sobie audytem, bo nie modeluje rzeczy z magazynu, tylko zdarzenia.
//
// Wozek powstaje z ZAZNACZENIA na liscie zwrotow (snapshot), nie z jobu pollujacego GT. Powod:
// GT nie odroznia zwrotu sprawnego od uszkodzonego - kazda korekta wchodzi PZ-em na K4
// (zweryfikowane na zywej bazie: 0 pozycji PZ<-KFS na BRK/K4R). Tylko czlowiek trzymajacy
// towar wie, czy jedzie na regal, czy na K4R/BRK - i to on zaznacza.
db.exec(`CREATE TABLE IF NOT EXISTS wozki (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nazwa TEXT,
  status TEXT NOT NULL DEFAULT 'otwarty',
  utworzono DATETIME DEFAULT CURRENT_TIMESTAMP,
  utworzyl TEXT,
  zamkniety DATETIME,
  zamknal TEXT
)`);

// numer = etykieta fizycznego wozka ("Wozek 3"), NIE klucz. Numery sie RECYKLUJA: rozlozony
// wozek oddaje swoj numer do puli, bo fizycznie stoi juz pusty i mozna go zaladowac na nowo.
// Dlatego kluczem w URL-ach i audycie zostaje `id` - numer 3 na przestrzeni miesiaca oznacza
// wiele roznych wozkow. Backfill: stare wozki dostaja numer = id (byly tak wyswietlane).
const kolumnyWozkow = db.prepare('PRAGMA table_info(wozki)').all();
if (!kolumnyWozkow.some((k) => k.name === 'numer')) {
  db.exec('ALTER TABLE wozki ADD COLUMN numer INTEGER');
  db.exec('UPDATE wozki SET numer = id WHERE numer IS NULL');
}

// Pozycja wozka. ilosc = SNAPSHOT z chwili tworzenia, NIE biezacy stan kubelka.
//
// Po co snapshot, skoro wszedzie indziej liczymy na zywo: kubelek zwrotu widzi tylko okno
// WMS_OKNO_DROBNICA_DNI (14 dni). Wozek stojacy dluzej mialby kubelek pusty i wygladalby na
// rozlozony, choc towar dalej na nim lezy. Snapshot jest odporny na okno.
//
// UWAGA: "ile juz rozlozono" NIE jest tu trzymane jako flaga - liczy sie je z ruchow, przez
// iloscRozlozonaZDokumentu(artykul, 'K4', zrodlo_dok). Wlasna flaga "rozlozone" rozjechalaby
// sie z rzeczywistoscia, gdy ktos rozlozy ten sam zwrot z karty produktu (zakladka Ruch).
// Snapshot mowi "ile tego bylo", ruchy mowia "ile zrobiono" - prawda o zrobieniu ma jedno zrodlo.
//
// rozlozono_baza = ile z dokumentu bylo rozlozone W CHWILI dolozenia pozycji na wozek. Nie jest
// to druga prawda o "zrobieniu" (ta wciaz plynie z ruchow), tylko PUNKT ZERO tej pozycji:
// stanPozycjiWozka liczy rozlozenia dopiero OD niego. Bez tego reszta dolozona po czesciowym
// rozlozeniu (snapshot juz pomniejszony) miala odjete to samo rozlozenie drugi raz i znikala z
// listy (BKR1904, 2026-07-20). Patrz services/wozek-model.js.
db.exec(`CREATE TABLE IF NOT EXISTS pozycje_wozka (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wozek_id INTEGER NOT NULL REFERENCES wozki(id) ON DELETE CASCADE,
  artykul_gt_id TEXT NOT NULL,
  artykul_symbol TEXT,
  artykul_nazwa TEXT,
  artykul_ean TEXT,
  zrodlo_dok TEXT NOT NULL,
  ilosc DECIMAL NOT NULL,
  lok_podpowiedz TEXT,
  rozlozono_baza DECIMAL NOT NULL DEFAULT 0,
  UNIQUE (wozek_id, artykul_gt_id, zrodlo_dok)
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_pozycje_wozka_wozek ON pozycje_wozka(wozek_id)');

// migracja: rozlozono_baza dla istniejacych baz (CREATE IF NOT EXISTS wyzej jej nie doda).
// Stare wiersze dostaja 0 = zachowanie sprzed poprawki, poprawne dla pozycji dolozonych, gdy z
// dokumentu nic jeszcze nie zeszlo (najczestszy przypadek). Patrz services/wozek-model.js.
const kolumnyPozWozka = db.prepare('PRAGMA table_info(pozycje_wozka)').all();
if (!kolumnyPozWozka.some((k) => k.name === 'rozlozono_baza')) {
  db.exec('ALTER TABLE pozycje_wozka ADD COLUMN rozlozono_baza DECIMAL NOT NULL DEFAULT 0');
  console.log('Migracja: dodano kolumne rozlozono_baza do pozycje_wozka');
}

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

// Pulpit (Faza 5): snapshot metryk drogich do policzenia na zywo (rozklad statusow
// zgodnosci GT<->WMS - krzyzuje ~2300 SKU z GT). Klucz-wartosc: wartosc to JSON,
// obliczono = kiedy job policzyl. Pulpit czyta gotowe liczby -> laduje sie natychmiast
// i dziala nawet gdy most GT chwilowo padnie. Odswiezane godzinnym jobem (services/pulpit-snapshot).
db.exec(`CREATE TABLE IF NOT EXISTS pulpit_snapshot (
  klucz TEXT PRIMARY KEY,
  wartosc TEXT,
  obliczono DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Seed: pierwszy admin, gdy brak uzytkownikow (bez PIN - mozna od razu wejsc i zalozyc reszte).
if (db.prepare('SELECT COUNT(*) AS c FROM uzytkownicy').get().c === 0) {
  db.prepare("INSERT INTO uzytkownicy (imie, rola) VALUES ('Admin', 'admin')").run();
  console.log("Seed: utworzono uzytkownika 'Admin' (rola admin, bez PIN)");
}

module.exports = db;
