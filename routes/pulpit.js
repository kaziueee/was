'use strict';

// Pulpit magazyniera (Faza 5) - jeden agregat metryk do desktopowej zakladki "Pulpit".
// Wszystkie sekcje poza `statusy` licza sie z lokalnej wms.db w milisekundach (bez mostu GT):
//   zajetosc  - zajete/wolne lokalizacje per magazyn (lokalizacje + stany_lokalizacji)
//   zaleglosci- ruchy pending/error, rozjazdy nowe (kolejka pracy)
//   trendy    - MM/LOK, nowe SKU na K4, naplyw do BRK w oknach 1/7/30 dni (audyt)
//   ludzie    - ranking magazynierow z audytu
// `statusy` czytane z gotowego snapshotu (services/pulpit-snapshot) - moze byc null,
// gdy job jeszcze nie policzyl albo most GT byl niedostepny. Front degraduje sie sam.
//
// Read-only: pulpit nie zmienia zadnego stanu, wiec nie dotyka inwariantow (CLAUDE.md).

const express = require('express');
const db = require('../db/database');
const snapshot = require('../services/pulpit-snapshot');

const router = express.Router();

const MAGAZYNY_WMS = ['K4', 'K4G'];

// Akcje audytu grupowane do metryk trendow/ludzi.
const AKCJE_MM = ['MM', 'MM-zewn'];
const AKCJE_LOK = ['LOK', 'przypisanie', 'przyjecie', 'Uzupelnienie'];

// wiek w pelnych dniach od daty ISO (UTC) do teraz; null gdy brak daty
function wiekDni(dataIso) {
  if (!dataIso) return null;
  const ms = Date.now() - new Date(dataIso.replace(' ', 'T') + 'Z').getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}

function placeholders(tab) {
  return tab.map(() => '?').join(', ');
}

// --- zajetosc lokalizacji ---
function zajetosc() {
  const aktywne = db.prepare(
    "SELECT magazyn, COUNT(*) AS c FROM lokalizacje WHERE aktywna = 1 GROUP BY magazyn"
  ).all();
  const zajete = db.prepare(`
    SELECT l.magazyn, COUNT(DISTINCT l.id) AS c
    FROM lokalizacje l JOIN stany_lokalizacji s ON s.lokalizacja_id = l.id
    WHERE l.aktywna = 1 AND s.ilosc > 0
    GROUP BY l.magazyn
  `).all();

  const mapAkt = new Map(aktywne.map((r) => [r.magazyn, r.c]));
  const mapZaj = new Map(zajete.map((r) => [r.magazyn, r.c]));

  return MAGAZYNY_WMS.map((mag) => {
    const aktywnych = mapAkt.get(mag) || 0;
    const zajetych = mapZaj.get(mag) || 0;
    return {
      magazyn: mag,
      aktywnych,
      zajetych,
      wolnych: Math.max(0, aktywnych - zajetych),
      procent: aktywnych > 0 ? Math.round((zajetych / aktywnych) * 100) : 0,
    };
  });
}

// --- zaleglosci / kolejka pracy ---
function zaleglosci() {
  const ruchy = db.prepare(
    "SELECT status, COUNT(*) AS c, MIN(data_ruchu) AS najstarszy FROM ruchy WHERE status IN ('pending','error') GROUP BY status"
  ).all();
  const mapRuchy = new Map(ruchy.map((r) => [r.status, r]));
  const pending = mapRuchy.get('pending') || { c: 0, najstarszy: null };
  const error = mapRuchy.get('error') || { c: 0, najstarszy: null };

  const rozjazdy = db.prepare(
    "SELECT COUNT(*) AS c, MIN(wykryty) AS najstarszy FROM rozjazdy WHERE status = 'nowy'"
  ).get();

  return {
    ruchy_pending: pending.c,
    ruchy_pending_wiek_dni: wiekDni(pending.najstarszy),
    ruchy_error: error.c,
    ruchy_error_wiek_dni: wiekDni(error.najstarszy),
    rozjazdy_nowe: rozjazdy.c,
    rozjazdy_wiek_dni: wiekDni(rozjazdy.najstarszy),
  };
}

// zlicza wpisy audytu z danej grupy akcji w oknie (dni wstecz)
function liczAudyt(akcje, dni) {
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM audyt
     WHERE akcja IN (${placeholders(akcje)}) AND czas >= datetime('now', ?)`
  ).get(...akcje, `-${dni} days`);
  return row.c;
}

// SKU, ktorych PIERWSZA lokalizacja na K4 (pierwszy wpis audytu magazyn=K4)
// padla w oknie [dni wstecz .. teraz] - "nowe produkty na K4"
function noweSkuK4(dni) {
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM (
       SELECT artykul_gt_id, MIN(czas) AS pierwsza
       FROM audyt
       WHERE magazyn = 'K4' AND akcja IN (${placeholders(AKCJE_LOK)}) AND artykul_gt_id IS NOT NULL
       GROUP BY artykul_gt_id
     ) WHERE pierwsza >= datetime('now', ?)`
  ).get(...AKCJE_LOK, `-${dni} days`);
  return row.c;
}

// szt. przesuniete do BRK (braki) w oknie - kierunek zapisany w audyt.lokalizacja
// jako "... -> BRK" (MM i MM-zewn koncza sie symbolem magazynu docelowego). Wskaznik
// jakosci dostaw/skali reklamacji. Liczymy przeplyw brutto (bez odejmowania zwrotow z BRK).
function naplywBrk(dni) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(ilosc), 0) AS szt, COUNT(*) AS ile FROM audyt
     WHERE akcja IN (${placeholders(AKCJE_MM)}) AND lokalizacja LIKE '%→ BRK'
       AND czas >= datetime('now', ?)`
  ).get(...AKCJE_MM, `-${dni} days`);
  return { szt: row.szt, operacji: row.ile };
}

function trendy() {
  const okno = (dni) => ({
    mm: liczAudyt(AKCJE_MM, dni),
    lok: liczAudyt(AKCJE_LOK, dni),
    nowe_sku_k4: noweSkuK4(dni),
    brk: naplywBrk(dni),
  });
  return { d1: okno(1), d7: okno(7), d30: okno(30) };
}

// --- ludzie: ranking magazynierow z audytu (7 dni). Pomija operacje systemowe. ---
function ludzie() {
  const mmIn = placeholders(AKCJE_MM);
  const lokIn = placeholders(AKCJE_LOK);
  return db.prepare(
    `SELECT uzytkownik,
       SUM(CASE WHEN czas >= datetime('now','-1 day') THEN 1 ELSE 0 END) AS dzis,
       SUM(CASE WHEN czas >= datetime('now','-7 days') THEN 1 ELSE 0 END) AS d7,
       SUM(CASE WHEN akcja IN (${mmIn}) AND czas >= datetime('now','-7 days') THEN 1 ELSE 0 END) AS mm7,
       SUM(CASE WHEN akcja IN (${lokIn}) AND czas >= datetime('now','-7 days') THEN 1 ELSE 0 END) AS lok7,
       MAX(czas) AS ostatnia
     FROM audyt
     WHERE uzytkownik IS NOT NULL AND uzytkownik NOT LIKE 'system:%'
       AND czas >= datetime('now','-7 days')
     GROUP BY uzytkownik
     ORDER BY d7 DESC, dzis DESC`
  ).all(...AKCJE_MM, ...AKCJE_LOK);
}

// --- statusy zgodnosci ze snapshotu (moze byc null) ---
function statusy() {
  const snap = snapshot.odczytaj('statusy_zgodnosci');
  if (!snap) return null;
  return { ...snap.wartosc, obliczono: snap.obliczono };
}

// --- liczniki kafli "do zrobienia" ze snapshotu (moze byc null) ---
// Wymagaja GT, wiec tak jak statusy ida ze snapshotu - pulpit ma sie ladowac natychmiast
// i dzialac, gdy Subiekt lezy. Kafel klika sie na zywa liste, wiec ewentualna godzinna
// nieaktualnosc licznika nie wprowadza nikogo w blad na dluzej niz jedno klikniecie.
function kafle() {
  const snap = snapshot.odczytaj('kafle_do_zrobienia');
  if (!snap) return null;
  return { ...snap.wartosc, obliczono: snap.obliczono };
}

// GET /api/pulpit - caly pulpit w jednym strzale. Sekcje lokalne zawsze obecne;
// `statusy` = null gdy snapshot jeszcze nie policzony. Front decyduje wg roli,
// co pokazac (KPI wlasciciela vs kolejka magazyniera).
router.get('/', (req, res, next) => {
  try {
    res.json({
      zajetosc: zajetosc(),
      zaleglosci: zaleglosci(),
      trendy: trendy(),
      ludzie: ludzie(),
      statusy: statusy(),
      kafle: kafle(),
      teraz: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
