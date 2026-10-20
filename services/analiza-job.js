'use strict';

// Job modułu analiz sprzedaży (docs/analiza-sprzedazy.md) — dosypuje sprzedaż z GT do db/sprzedaz.db.
//   bieżący (co ANALIZA_INTERWAL_MIN, domyślnie 15 min): FS z ostatnich 4 dni (faktura bywa do 3 dni po zamówieniu)
//     i ZK jeszcze bez FS — tak dzisiejsze zamówienia są na ekranie od razu; plus stany sprzedawanych towarów,
//   nocny (raz na dobę, pierwszy przebieg po 2:00): ostatnie 14 dni na nowo (korekty, późne FS), kartoteka
//     sprzedawanych i trzymanych towarów, zdjęcie stanów wszystkich towarów ze stanem.
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
  const w = await dane.wczytajOkno(dodajDni(dzis, -3), dodajDni(dzis, 1));
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
  const tw = db.prepare(`SELECT DISTINCT p.tw_id FROM pozycje p JOIN zamowienia z ON z.id = p.zam_id WHERE z.data_zam >= ?
    UNION SELECT tw_id FROM stany WHERE dzien >= ?`).all(dodajDni(dzis, -400), dodajDni(dzis, -7)).map((x) => x.tw_id);
  await dane.odswiezTowary(tw);
  const stany = await dane.zdjecieStanow(dzis);
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
