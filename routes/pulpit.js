'use strict';

// Pulpit magazyniera (Faza 5) - jeden agregat metryk do desktopowej zakladki "Pulpit".
// Wszystkie sekcje poza `statusy` licza sie z lokalnej wms.db w milisekundach (bez mostu GT):
//   zajetosc  - zajete/puste/wolne lokalizacje per magazyn (ze snapshotu, zweryfikowane w GT;
//               fallback na rachunek z samej wms.db, gdy snapshotu jeszcze nie ma)
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
const { statusLokalizacji, podsumuj } = require('../services/zajetosc-model');

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
// Kafel pokazuje liczby ZWERYFIKOWANE w GT - ze snapshotu (godzinny job), tak jak statusy
// zgodnosci i kafle "do zrobienia". Powod jest twardy: liczona samym WMS-em zajetosc potrafi
// pokazac "25% zajete" tam, gdzie ekran "Wolne miejsca" mowi 0 wolnych, bo kazdy pusty w WMS
// slot ma towar opisany wylacznie w polach GT. Naglowkowa liczba ma znaczyc "ile miejsca jest
// zajete", a nie "ile WMS o sobie wie" - inaczej kafel klamie dokladnie w tym przypadku, dla
// ktorego ten ekran powstal.
//
// Snapshot moze byc pusty (pierwsze minuty po starcie, padniety GT) - wtedy schodzimy na
// rachunek lokalny i front MOWI to wprost ("wolne wg WMS"), zamiast udawac zweryfikowane dane.
function zajetosc() {
  const snap = snapshot.odczytaj('zajetosc');
  if (snap) {
    // Stary snapshot (sprzed rozbicia na rodzaje miejsc) trzymal sama tablice per magazyn.
    // Moze lezec w bazie jeszcze przez godzine po wdrozeniu, wiec czytamy obie postacie.
    const podsumowanie = Array.isArray(snap.wartosc) ? snap.wartosc : snap.wartosc.podsumowanie;
    const grupy = Array.isArray(snap.wartosc) ? null : snap.wartosc.wolne_grupy;
    return {
      magazyny: podsumowanie.map((w) => ({ ...w, zrodlo: 'gt', obliczono: snap.obliczono })),
      grupy: grupy ? grupy.map((g) => ({ ...g, zrodlo: 'gt', obliczono: snap.obliczono })) : null,
    };
  }
  // Bez snapshotu nie liczymy rodzajow miejsc: "wolne" bez weryfikacji w GT to nie jest
  // liczba, na ktorej ktos ma oprzec decyzje "gdzie polozyc palete". Front pokazuje wtedy
  // stary widok per magazyn z dopiskiem "bez weryfikacji w GT".
  return { magazyny: zajetoscZWms(), grupy: null };
}

// Rachunek awaryjny: ten sam model, co ekran, ale w trybie TANIM - bez GT. `wGt: false` i
// `historia: true` znacza, ze wszystko puste laduje w jednym kubelku 'wolna'. Rozroznienie
// zajete / pusta polka (dom SKU ze stanem 0) zostaje - to czysta wiedza WMS i nie kosztuje nic.
function zajetoscZWms() {
  const wiersze = db.prepare(`
    SELECT l.magazyn, l.przeznaczenie,
           COUNT(s.id) AS pozycji, COALESCE(SUM(s.ilosc), 0) AS sztuk
    FROM lokalizacje l LEFT JOIN stany_lokalizacji s ON s.lokalizacja_id = l.id
    WHERE l.aktywna = 1
    GROUP BY l.id
  `).all();

  const pozycje = wiersze.map((w) => ({
    magazyn: w.magazyn,
    przeznaczenie: w.przeznaczenie,
    status: statusLokalizacji({ sztuk: Number(w.sztuk), pozycji: w.pozycji, wGt: false, historia: true }),
  }));

  // Magazyny bez ani jednej lokalizacji tez maja miec kafel (zerowy), stad dopelnienie.
  const policzone = new Map(podsumuj(pozycje).map((w) => [w.magazyn, w]));
  return MAGAZYNY_WMS.map((mag) => ({
    ...(policzone.get(mag) ?? {
      magazyn: mag, aktywnych: 0, magazynowych: 0, poza_analiza: 0,
      zajeta: 0, pusta_polka: 0, tylko_gt: 0, wolna: 0, nietknieta: 0,
      wolnych: 0, zajmowanych: 0, procent: 0,
    }),
    zrodlo: 'wms',   // front podpisuje kafel "wolne wg WMS" - patrz komentarz wyzej
  }));
}

// --- zaleglosci / kolejka pracy ---
function zaleglosci() {
  const ruchy = db.prepare(
    "SELECT status, COUNT(*) AS c, MIN(data_ruchu) AS najstarszy FROM ruchy WHERE status IN ('pending','error','wstrzymany') GROUP BY status"
  ).all();
  const mapRuchy = new Map(ruchy.map((r) => [r.status, r]));
  const pending = mapRuchy.get('pending') || { c: 0, najstarszy: null };
  const error = mapRuchy.get('error') || { c: 0, najstarszy: null };
  // 'wstrzymany' liczy sie do tego samego kafla co 'pending': to wciaz ruch czekajacy na
  // czlowieka, tylko job juz sam po niego nie wraca - tym bardziej ma byc widoczny.
  // 'duplikat' NIE wchodzi: jest zamkniety, nikt nie ma z nim nic do zrobienia.
  const wstrzymane = mapRuchy.get('wstrzymany') || { c: 0, najstarszy: null };

  const rozjazdy = db.prepare(
    "SELECT COUNT(*) AS c, MIN(wykryty) AS najstarszy FROM rozjazdy WHERE status = 'nowy'"
  ).get();

  return {
    ruchy_pending: pending.c + wstrzymane.c,
    ruchy_pending_wiek_dni: wiekDni(
      [pending.najstarszy, wstrzymane.najstarszy].filter(Boolean).sort()[0] ?? null
    ),
    ruchy_wstrzymane: wstrzymane.c,
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

// --- aktywnosc per AKCJA (okna 1/7/30 dni) do rozbicia po sciezkach obchodu ---
// Backend liczy GENERYCZNIE, per akcja - bez wiedzy o sciezkach. Grupowanie akcji w sciezki
// (Ostatnie sztuki / Wazenie / Zwroty ...) robi front wg SCIEZKI_AUDYT, zeby definicja sciezek
// zostala w JEDNYM miejscu (ta sama mapa buduje filtr i etykiety Logu zmian). Akcje spoza
// sciezek front po prostu zignoruje. WHERE ogranicza do 30 dni, wiec GROUP BY jest tani.
function aktywnoscAkcje() {
  return db.prepare(
    `SELECT akcja,
       SUM(CASE WHEN czas >= datetime('now','-1 day')  THEN 1 ELSE 0 END) AS d1,
       SUM(CASE WHEN czas >= datetime('now','-7 days') THEN 1 ELSE 0 END) AS d7,
       COUNT(*) AS d30
     FROM audyt
     WHERE czas >= datetime('now','-30 days')
     GROUP BY akcja`
  ).all();
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
      aktywnosc_akcje: aktywnoscAkcje(),
      statusy: statusy(),
      kafle: kafle(),
      teraz: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
