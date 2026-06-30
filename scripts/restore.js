'use strict';

// Przywracanie bazy WMS z backupu - patrz PROGRESS.md "Specyfikacja: logi + backup".
//
//   node scripts/restore.js                 -> pokaz dostepne backupy (nic nie zmienia)
//   node scripts/restore.js <nazwa_pliku>   -> przywroc baze z tego backupu
//
// BEZPIECZENSTWO:
//  - skrypt ODMAWIA dzialania, gdy serwer WMS dziala (trzymalby plik) - najpierw zatrzymaj
//    serwer (stop-wms.command albo Ctrl+C w oknie serwera);
//  - przed podmiana robi backup OBECNEJ bazy z etykieta "pre-restore" (nic nie ginie);
//  - kopiuje wybrany backup na db/wms.db i kasuje stare pliki -wal/-shm.

const path = require('path');
const fs = require('fs');
const net = require('net');

const DB_DIR = path.join(__dirname, '..', 'db');
const DB_PATH = path.join(DB_DIR, 'wms.db');
const BACKUP_DIR = process.env.WMS_BACKUP_DIR || path.join(DB_DIR, 'backups');
const PORT = process.env.PORT || 3000;

function listaBackupow() {
  let pliki;
  try { pliki = fs.readdirSync(BACKUP_DIR); } catch { return []; }
  return pliki
    .filter((n) => n.startsWith('wms_') && n.endsWith('.db'))
    .map((n) => {
      const st = fs.statSync(path.join(BACKUP_DIR, n));
      return { nazwa: n, size: st.size, mtime: st.mtime, mtimeMs: st.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// Czy serwer nasluchuje na PORT? (wtedy trzyma baze - nie wolno podmieniac pliku)
function serwerDziala() {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: PORT }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(800, () => { s.destroy(); resolve(false); });
  });
}

function dwie(n) { return String(n).padStart(2, '0'); }
function znacznik() { const d = new Date(); return `${d.getFullYear()}-${dwie(d.getMonth() + 1)}-${dwie(d.getDate())}_${dwie(d.getHours())}${dwie(d.getMinutes())}`; }

async function main() {
  const arg = process.argv[2];
  const backupy = listaBackupow();

  if (!arg) {
    if (!backupy.length) { console.log(`Brak backupow w ${BACKUP_DIR}`); return; }
    console.log(`Dostepne backupy (${BACKUP_DIR}):\n`);
    for (const b of backupy.slice(0, 40)) {
      console.log(`  ${b.nazwa.padEnd(40)} ${Math.round(b.size / 1024)} KB   ${b.mtime.toLocaleString('pl-PL')}`);
    }
    console.log(`\nAby przywrocic:  node scripts/restore.js <nazwa_pliku>`);
    return;
  }

  const zrodlo = path.isAbsolute(arg) ? arg : path.join(BACKUP_DIR, arg);
  if (!fs.existsSync(zrodlo)) { console.error(`BLAD: nie ma pliku ${zrodlo}`); process.exit(1); }

  if (await serwerDziala()) {
    console.error(`BLAD: serwer WMS dziala na porcie ${PORT}. Najpierw go zatrzymaj (stop-wms.command / Ctrl+C), potem ponow.`);
    process.exit(1);
  }

  // 1. backup obecnej bazy (zeby przywracanie tez bylo odwracalne)
  if (fs.existsSync(DB_PATH)) {
    const ratunkowy = path.join(BACKUP_DIR, `wms_pre-restore_${znacznik()}.db`);
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.copyFileSync(DB_PATH, ratunkowy);
    console.log(`Obecna baza zachowana jako: ${path.basename(ratunkowy)}`);
  }

  // 2. podmiana + kasacja starych -wal/-shm (backup z VACUUM INTO jest spojny, bez WAL)
  fs.copyFileSync(zrodlo, DB_PATH);
  for (const sufiks of ['-wal', '-shm']) {
    try { fs.unlinkSync(DB_PATH + sufiks); } catch { /* brak = ok */ }
  }

  console.log(`OK: przywrocono baze z ${path.basename(zrodlo)}.`);
  console.log(`Teraz uruchom serwer: ./start-wms.command  (albo node app.js)`);
}

main();
