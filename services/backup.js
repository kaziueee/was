'use strict';

// Backup bazy WMS (db/wms.db) - patrz PROGRESS.md "Specyfikacja: logi + backup".
//
// Zasady:
//  1. NIGDY nie nadpisujemy - kazdy backup to nowy plik z data (VACUUM INTO -> spojna
//     kopia bez plikow -wal/-shm).
//  2. Integrity-guard: przed backupem PRAGMA integrity_check na zywej bazie; jesli
//     uszkodzona -> alarm + NIE rotujemy (zepsuty stan nie wyprze dobrej historii).
//  3. Rotacja warstwowa (dziadek-ojciec-syn): godzinowe ~48 (2 dni) + dzienne ~30
//     (miesiac) + miesieczne ~12 (rok) => ~90 plikow na stale, ~9 MB.
//  4. Drugie miejsce: jesli ustawione WMS_BACKUP_MIRROR, kopiujemy tam dzienne/miesieczne.
//  5. Pre-deploy: backup z etykieta jest WYLACZONY z rotacji (nigdy nie kasowany).
//
// Harmonogram: co godzine w godzinach pracy (7-20) + 1 nocny (2:00).

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const db = require('../db/database');
const awarie = require('./awarie');

const DB_PATH = path.join(__dirname, '..', 'db', 'wms.db');
const BACKUP_DIR = process.env.WMS_BACKUP_DIR || path.join(__dirname, '..', 'db', 'backups');
const MIRROR_DIR = process.env.WMS_BACKUP_MIRROR || null; // drugie miejsce (opcjonalne)
const LOG_DIR = path.join(__dirname, '..', 'logs');

// Retencja (warstwy)
const TRZYMAJ_GODZINOWE = 48; // ostatnie ~2 dni, kazda godzina
const TRZYMAJ_DZIENNE = 30; // ostatni ~miesiac, 1/dzien
const TRZYMAJ_MIESIECZNE = 12; // ostatni ~rok, 1/miesiac

// Harmonogram
const GODZ_PRACY_OD = 7;
const GODZ_PRACY_DO = 20;
const GODZ_NOCNY = 2;

const PREFIX = 'wms_';
const ROZSZ = '.db';
// wms_2026-07-01_1400.db (zwykly) | wms_pre-deploy_2026-07-01_1400.db (etykieta)
const RE_ZWYKLY = /^wms_(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})\.db$/;

function dwie(n) { return String(n).padStart(2, '0'); }

function znacznikCzasu(d = new Date()) {
  return `${d.getFullYear()}-${dwie(d.getMonth() + 1)}-${dwie(d.getDate())}_${dwie(d.getHours())}${dwie(d.getMinutes())}`;
}

function log(poziom, wiadomosc) {
  const linia = `${new Date().toISOString()} [backup] ${poziom}: ${wiadomosc}`;
  if (poziom === 'BLAD') console.error(linia); else console.log(linia);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const plik = path.join(LOG_DIR, `backup-${znacznikCzasu().slice(0, 10)}.log`);
    fs.appendFileSync(plik, linia + '\n');
  } catch (e) {
    console.error(`${new Date().toISOString()} [backup] BLAD: nie moge zapisac logu: ${e.message}`);
  }
  // bledy backupu trafiaja TEZ do wspolnego logu awarii (Faza A#2)
  if (poziom === 'BLAD') awarie.blad('backup', wiadomosc);
}

// Sprawdza spojnosc zywej bazy. Zwraca true/false.
function bazaZdrowa() {
  try {
    const w = db.prepare('PRAGMA integrity_check').get();
    return w && w.integrity_check === 'ok';
  } catch (e) {
    log('BLAD', `integrity_check rzucil wyjatek: ${e.message}`);
    return false;
  }
}

// Weryfikuje, ze powstaly plik backupu da sie otworzyc i jest spojny.
function backupZdrowy(sciezka) {
  let kopia;
  try {
    kopia = new DatabaseSync(sciezka, { readOnly: true });
    const w = kopia.prepare('PRAGMA integrity_check').get();
    return w && w.integrity_check === 'ok';
  } catch (e) {
    log('BLAD', `weryfikacja backupu ${path.basename(sciezka)} nie powiodla sie: ${e.message}`);
    return false;
  } finally {
    try { kopia?.close(); } catch { /* ignore */ }
  }
}

// Robi jeden backup. etykieta != null => plik pre-deploy (wylaczony z rotacji), bez rotacji.
// Zwraca { ok, plik } albo { ok:false, powod }.
function zrobBackup({ etykieta = null, rotuj = true } = {}) {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });

    // 1. integrity-guard: nie backupujemy uszkodzonej bazy i NIE rotujemy (zachowujemy historie)
    if (!bazaZdrowa()) {
      log('BLAD', 'ALARM: integrity_check zywej bazy != ok - pomijam backup i rotacje (chronie dobre kopie)');
      return { ok: false, powod: 'integrity_check zywej bazy nie przeszedl' };
    }

    // 2. VACUUM INTO -> spojna kopia (bez -wal/-shm). Nowy plik z data, nigdy nie nadpisujemy.
    const nazwa = etykieta
      ? `${PREFIX}${etykieta}_${znacznikCzasu()}${ROZSZ}`
      : `${PREFIX}${znacznikCzasu()}${ROZSZ}`;
    let docel = path.join(BACKUP_DIR, nazwa);
    // kolizja nazwy (ten sam minut) - dodaj sekundy
    if (fs.existsSync(docel)) {
      docel = path.join(BACKUP_DIR, nazwa.replace(ROZSZ, `${dwie(new Date().getSeconds())}${ROZSZ}`));
    }
    db.exec(`VACUUM INTO '${docel.replace(/'/g, "''")}'`);

    // 3. weryfikacja powstalego pliku
    if (!backupZdrowy(docel)) {
      log('BLAD', `ALARM: backup ${path.basename(docel)} powstal, ale nie przeszedl integrity_check`);
      return { ok: false, powod: 'backup nie przeszedl weryfikacji' };
    }

    const kb = Math.round(fs.statSync(docel).size / 1024);
    log('INFO', `backup OK: ${path.basename(docel)} (${kb} KB)${etykieta ? ' [etykieta, bez rotacji]' : ''}`);

    // checkpoint WAL: scal -wal do glownego pliku i przytnij (WAL urosl do 4 MB bez tego)
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) { log('BLAD', `wal_checkpoint: ${e.message}`); }

    // 4. mirror do drugiego miejsca (jesli ustawione)
    skopiujDoMirror(docel);

    // 5. rotacja (tylko dla zwyklych, nie dla etykietowanych)
    if (rotuj && !etykieta) rotujBackupy();

    return { ok: true, plik: docel };
  } catch (e) {
    log('BLAD', `zrobBackup rzucil wyjatek: ${e.message}`);
    return { ok: false, powod: e.message };
  }
}

function skopiujDoMirror(sciezkaPliku) {
  if (!MIRROR_DIR) return;
  try {
    fs.mkdirSync(MIRROR_DIR, { recursive: true });
    fs.copyFileSync(sciezkaPliku, path.join(MIRROR_DIR, path.basename(sciezkaPliku)));
  } catch (e) {
    log('BLAD', `mirror do ${MIRROR_DIR} nie powiodl sie: ${e.message}`);
  }
}

// Rotacja warstwowa. Kasuje tylko ZWYKLE pliki spoza warstw; etykietowane (pre-deploy)
// sa pomijane (nigdy nie kasowane). Najnowsze 48 = godzinowe, potem 1/dzien przez 30 dni,
// potem 1/miesiac przez 12 miesiecy.
function rotujBackupy() {
  let pliki;
  try {
    pliki = fs.readdirSync(BACKUP_DIR)
      .map((nazwa) => {
        const m = nazwa.match(RE_ZWYKLY);
        if (!m) return null; // pomijamy etykietowane i nie-backupowe
        const [, rok, mies, dzien, godz, min] = m;
        return { nazwa, data: new Date(+rok, +mies - 1, +dzien, +godz, +min) };
      })
      .filter(Boolean)
      .sort((a, b) => b.data - a.data); // najnowsze pierwsze
  } catch (e) {
    log('BLAD', `rotacja: nie moge odczytac katalogu: ${e.message}`);
    return;
  }

  const trzymaj = new Set();

  // warstwa godzinowa: najnowsze N
  pliki.slice(0, TRZYMAJ_GODZINOWE).forEach((p) => trzymaj.add(p.nazwa));

  // warstwa dzienna: najnowszy z kazdego dnia, do N dni (pliki sa posortowane malejaco,
  // wiec pierwsze trafienie danego dnia = najnowszy tego dnia)
  const dni = new Set();
  for (const p of pliki) {
    const klucz = `${p.data.getFullYear()}-${p.data.getMonth()}-${p.data.getDate()}`;
    if (!dni.has(klucz)) {
      if (dni.size >= TRZYMAJ_DZIENNE) break;
      dni.add(klucz);
      trzymaj.add(p.nazwa);
    }
  }

  // warstwa miesieczna: najnowszy z kazdego miesiaca, do N miesiecy
  const miesiace = new Set();
  for (const p of pliki) {
    const klucz = `${p.data.getFullYear()}-${p.data.getMonth()}`;
    if (!miesiace.has(klucz)) {
      if (miesiace.size >= TRZYMAJ_MIESIECZNE) break;
      miesiace.add(klucz);
      trzymaj.add(p.nazwa);
    }
  }

  let skasowano = 0;
  for (const p of pliki) {
    if (trzymaj.has(p.nazwa)) continue;
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, p.nazwa));
      skasowano++;
    } catch (e) {
      log('BLAD', `rotacja: nie moge skasowac ${p.nazwa}: ${e.message}`);
    }
  }
  if (skasowano) log('INFO', `rotacja: skasowano ${skasowano} starych, zostaje ${trzymaj.size}`);
}

// --- harmonogram ---

let timer = null;

function czyCzasNaBackup(d = new Date()) {
  const g = d.getHours();
  return (g >= GODZ_PRACY_OD && g <= GODZ_PRACY_DO) || g === GODZ_NOCNY;
}

function zaplanujKolejny() {
  // wyceluj w poczatek nastepnej godziny (+5s marginesu)
  const teraz = new Date();
  const nast = new Date(teraz);
  nast.setHours(teraz.getHours() + 1, 0, 5, 0);
  const opoznienie = nast - teraz;
  timer = setTimeout(() => {
    if (czyCzasNaBackup()) zrobBackup();
    zaplanujKolejny();
  }, opoznienie);
  if (timer.unref) timer.unref(); // nie blokuj zamkniecia procesu
}

function start() {
  if (process.env.WMS_BACKUP_DISABLED === '1') {
    log('INFO', 'backup wylaczony (WMS_BACKUP_DISABLED=1)');
    return;
  }
  // backup od razu przy starcie (restart = swieza migawka), potem co godzine
  zrobBackup();
  zaplanujKolejny();
  log('INFO', `harmonogram: co godzine ${GODZ_PRACY_OD}-${GODZ_PRACY_DO} + nocny ${GODZ_NOCNY}:00; katalog ${BACKUP_DIR}${MIRROR_DIR ? `; mirror ${MIRROR_DIR}` : ''}`);
}

function stop() {
  if (timer) { clearTimeout(timer); timer = null; }
}

module.exports = { start, stop, zrobBackup, rotujBackupy, bazaZdrowa, BACKUP_DIR };
