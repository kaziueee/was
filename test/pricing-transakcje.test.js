'use strict';

// pricing.db piszą dwa procesy naraz: WMS-Node (ekran Ceny — strategie, ręczna cena, wystawianie) i worker
// repricera (przebieg co kilka minut). Transakcja z samym `BEGIN` zaczyna od blokady odczytu; gdy potem chce
// pisać, a worker akurat trzyma blokadę zapisu, SQLite zwraca „database is locked” OD RAZU — busy_timeout
// (15 s w pricing/db.js) w tym miejscu nie działa (2026-11-28: przypisanie strategii na karcie produktu padało
// „Błąd serwera” w trakcie przebiegu). `BEGIN IMMEDIATE` bierze blokadę zapisu na starcie i czeka na swoją kolej.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const KORZEN = path.join(__dirname, '..');

function plikiJs(kat) {
  return fs.readdirSync(kat, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(kat, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : plikiJs(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}

test('każda transakcja na pricing.db zaczyna się od BEGIN IMMEDIATE', () => {
  const zle = [];
  for (const p of [...plikiJs(path.join(KORZEN, 'pricing')), ...plikiJs(path.join(KORZEN, 'routes')), ...plikiJs(path.join(KORZEN, 'scripts'))]) {
    const t = fs.readFileSync(p, 'utf8');
    // pliki z pricing/ i wszystko, co sięga po pricing/db (trasy Cen, skrypty)
    if (!p.includes(`${path.sep}pricing${path.sep}`) && !/pricing\/db'/.test(t)) continue;
    t.split('\n').forEach((l, i) => { if (/exec\(\s*['"`]BEGIN(\s+(DEFERRED|TRANSACTION))?\s*['"`]/i.test(l)) zle.push(`${path.relative(KORZEN, p)}:${i + 1}`); });
  }
  assert.deepStrictEqual(zle, [], 'zwykłe BEGIN na pricing.db — zamień na BEGIN IMMEDIATE');
});

// Zachowanie SQLite, na którym stoi powyższa reguła: drugi proces trzyma zapis przez ~1 s.
function trzymajZapis(plik, ms) {
  const kod = `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(${JSON.stringify(plik)});
    db.exec('BEGIN IMMEDIATE'); db.exec('INSERT INTO t VALUES (1)'); process.stdout.write('trzymam\\n');
    setTimeout(() => { db.exec('COMMIT'); }, ${ms});`;
  const p = spawn(process.execPath, ['--no-warnings', '-e', kod]);
  return new Promise((ok) => p.stdout.once('data', () => ok(p)));
}
function zapiszOdczytujac(plik, begin) {
  const db = new DatabaseSync(plik);
  db.exec('PRAGMA busy_timeout = 5000');
  try {
    db.exec(begin);
    db.prepare('SELECT COUNT(*) AS n FROM t').get();
    db.exec('INSERT INTO t VALUES (2)');
    db.exec('COMMIT');
    return 'ok';
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* nic */ }
    return e.message;
  } finally { db.close(); }
}

test('BEGIN IMMEDIATE czeka na cudzy zapis, zwykłe BEGIN pada od razu', async () => {
  const kat = fs.mkdtempSync(path.join(os.tmpdir(), 'pricing-tx-'));
  const plik = path.join(kat, 't.db');
  const db = new DatabaseSync(plik);
  db.exec('PRAGMA journal_mode = WAL'); db.exec('CREATE TABLE t (x)'); db.close();
  try {
    let p = await trzymajZapis(plik, 800);
    assert.match(zapiszOdczytujac(plik, 'BEGIN'), /locked/);
    await new Promise((ok) => p.once('exit', ok));
    p = await trzymajZapis(plik, 800);
    assert.strictEqual(zapiszOdczytujac(plik, 'BEGIN IMMEDIATE'), 'ok');
    await new Promise((ok) => p.once('exit', ok));
  } finally { fs.rmSync(kat, { recursive: true, force: true }); }
});
