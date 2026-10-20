'use strict';

// Job modułu analiz sprzedaży (docs/analiza-sprzedazy.md) — dosypuje sprzedaż z GT do db/sprzedaz.db.
//   bieżący (co ANALIZA_INTERWAL_MIN, domyślnie 15 min): wczoraj i dziś — FS (faktura dostaje datę wystawienia, więc
//     FS do zamówienia sprzed 3 dni wpada w dzisiejsze okno i zastępuje jego wiersz) i ZK jeszcze bez FS, plus stany
//     sprzedawanych towarów. Zmierzone 2026-10-20: ~0,6 s zapytań do GT (okno 4 dni: 1,8 s),
//   nocny (raz na dobę, pierwszy przebieg po 2:00): ostatnie 14 dni na nowo (korekty, FS z cofniętą datą, ZK, które
//     zniknęły), kartoteka towarów aktywnych i nowych, zdjęcie stanów wszystkich towarów ze stanem.
// Historię sprzed startu wczytuje raz scripts/analiza-wczytaj.js. Tylko SELECT-y do GT.
// ANALIZA_WYLACZ=1 wyłącza job (np. lokalny WMS na kopii Z_KAJTEK, żeby nie mieszał danych w bazie modułu).

const dane = require('./analiza-dane');
const { db, meta } = require('../db/sprzedaz');
const { dodajDni } = require('./analiza-model');
const { dzisLokalnie } = require('./sprzedaz-model');
const { interwalMsZMinut } = require('./interwal');
const awarie = require('./awarie');

const GODZINA_NOCNA = 2;
const OPOZNIENIE_STARTU_MS = 90 * 1000;   // po starcie WMS-Node daj wstać reszcie (most, joby GT)

let trwa = false;

async function biezacy() {
  const dzis = dzisLokalnie();
  const w = await dane.wczytajOkno(dodajDni(dzis, -1), dodajDni(dzis, 1));
  const tw = [...new Set(w.pozycje.map((p) => p.tw_id))];
  if (tw.length) await dane.zdjecieStanow(dzis, tw);
  // tempo przeliczamy najwyżej raz na godzinę: zapytanie trwa ~0,7 s i blokuje WMS-Node (skany z Zebry), a dni
  // zapasu nie potrzebują dokładności co kwadrans
  const ostatnie = meta.get('tempa')?.czas;
  if (!ostatnie || Date.now() - new Date(ostatnie.replace(' ', 'T') + 'Z').getTime() > 3600e3) { dane.przeliczTempa(dzis); meta.set('tempa', dzis); }
  meta.set('biezacy', new Date().toISOString());
  return { zamowien: w.zamowienia.length, towarow: tw.length };
}

async function nocny() {
  const dzis = dzisLokalnie();
  const w = await dane.wczytajOkno(dodajDni(dzis, -14), dodajDni(dzis, 1));
  // kartoteka: tylko towary sprzedane w 14 dniach (symbol / nazwa / grupa mogły się zmienić) i te, których jeszcze nie
  // znamy. Całość (18,7 tys.) to ~8 s na GT co noc, a data pierwszego przyjęcia raz ustalona się nie zmienia.
  const stany = await dane.zdjecieStanow(dzis);
  const tw = db.prepare(`SELECT DISTINCT p.tw_id FROM pozycje p JOIN zamowienia z ON z.id = p.zam_id WHERE z.data_zam >= ?
    UNION SELECT s.tw_id FROM stany s WHERE s.dzien = ? AND s.tw_id NOT IN (SELECT tw_id FROM towary)
    UNION SELECT p.tw_id FROM pozycje p WHERE p.tw_id NOT IN (SELECT tw_id FROM towary)`).all(dodajDni(dzis, -14), dzis).map((x) => x.tw_id);
  await dane.odswiezTowary(tw);
  dane.przeliczTempa(dzis);
  meta.set('tempa', dzis);
  meta.set('nocny', dzis);
  meta.set('biezacy', new Date().toISOString());
  return { zamowien: w.zamowienia.length, towarow: tw.length, stany };
}

async function przebieg(teraz = new Date()) {
  if (trwa) return null;              // poprzedni przebieg jeszcze trwa (GT wolne) — nie dokładamy drugiego
  trwa = true;
  try {
    const nocnyDzis = meta.get('nocny')?.wartosc === dzisLokalnie(teraz);
    return teraz.getHours() >= GODZINA_NOCNA && !nocnyDzis ? await nocny() : await biezacy();
  } catch (e) {
    awarie.blad('analiza', e.message);
    meta.set('blad', `${new Date().toISOString()} ${e.message}`);
    return null;
  } finally {
    trwa = false;
  }
}

function start() {
  if (process.env.ANALIZA_WYLACZ === '1') { console.log('[analiza] job wyłączony (ANALIZA_WYLACZ=1)'); return null; }
  const ms = interwalMsZMinut(process.env.ANALIZA_INTERWAL_MIN, 15, 'ANALIZA_INTERWAL_MIN');
  const pierwszy = setTimeout(() => przebieg(), OPOZNIENIE_STARTU_MS);
  pierwszy.unref?.();
  const timer = setInterval(() => przebieg(), ms);
  timer.unref?.();
  return timer;
}

module.exports = { start, przebieg, biezacy, nocny };
