'use strict';

// Job modułu analiz sprzedaży (docs/analiza-sprzedazy.md) — dosypuje sprzedaż z GT do db/sprzedaz.db.
//   bieżący (co ANALIZA_INTERWAL_MIN, domyślnie 15 min): wczoraj i dziś — FS (faktura dostaje datę wystawienia, więc
//     FS do zamówienia sprzed 3 dni wpada w dzisiejsze okno i zastępuje jego wiersz) i ZK jeszcze bez FS, plus stany
//     sprzedawanych towarów. Zmierzone 2026-10-20: ~0,6 s zapytań do GT (okno 4 dni: 1,8 s),
//   nocny (raz na dobę, pierwszy przebieg po 2:00): ostatnie 14 dni na nowo (korekty, FS z cofniętą datą, ZK, które
//     zniknęły), kartoteka towarów aktywnych i nowych, zdjęcie stanów wszystkich towarów ze stanem,
//   raz na dobę (pierwszy przebieg z nowym „wczoraj”): dni bez stanu odtworzone wstecz z dokumentów (~2 s, Trendy).
//     Trendy liczą się po przebiegu, więc filtr „Zakończone” ma świeże dni bez stanu od pierwszego przeliczenia dnia.
// Historię sprzed startu wczytuje raz scripts/analiza-wczytaj.js. Tylko SELECT-y do GT.
//   raport mailem (services/analiza-raport.js): raz dziennie od ANALIZA_RAPORT_GODZINA (7:00) za wczoraj, do
//     ANALIZA_RAPORT_DO, przez Gmail API z zakresem tylko do wysyłania; najwyżej 3 próby dziennie. Bez konfiguracji
//     (adresaci + GMAIL_*) — nic nie wysyła.
//   Trendy (services/analiza-trendy.js): po każdym przebiegu, gdy brak wyniku, zmienił się dzień albo minęła godzina.
// Chodzi w osobnym wątku (services/analiza-watek.js) — ZASADA usera: w ciągu dnia nic nie może przeszkadzać Zebrom.
// ANALIZA_WYLACZ=1 wyłącza job (np. lokalny WMS na kopii Z_KAJTEK, żeby nie mieszał danych w bazie modułu).

const dane = require('./analiza-dane');
const { db, meta } = require('../db/sprzedaz');
const { dodajDni } = require('./analiza-model');
const { dzisLokalnie } = require('./sprzedaz-model');
const { interwalMsZMinut } = require('./interwal');
const awarie = require('./awarie');
const gmail = require('./gmail-wysylka');
const { wWatku } = require('./watek');

const GODZINA_NOCNA = 2;
const OPOZNIENIE_STARTU_MS = 90 * 1000;   // po starcie WMS-Node daj wstać reszcie (most, joby GT)

const MAX_PROB_RAPORTU = 3;
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
  const bz = await dane.bezStanuJesliTrzeba(dzis);          // raz na dobę — pierwszy przebieg po północy albo po starcie
  meta.set('biezacy', new Date().toISOString());
  return { zamowien: w.zamowienia.length, towarow: tw.length, ...(bz ? { bez_stanu: bz } : {}) };
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
  const bz = await dane.bezStanuJesliTrzeba(dzis);
  meta.set('nocny', dzis);
  meta.set('biezacy', new Date().toISOString());
  return { zamowien: w.zamowienia.length, towarow: tw.length, stany, ...(bz ? { bez_stanu: bz } : {}) };
}

// Raport za wczoraj, jeśli jest pora i jeszcze nie poszedł. Licznik prób per dzień: błąd Gmaila (np. odwołana zgoda)
// nie może wysyłać co kwadrans przez cały dzień ani zasypywać logu.
async function raportJesliPora(teraz = new Date()) {
  const doKogo = process.env.ANALIZA_RAPORT_DO;
  if (!doKogo || !gmail.skonfigurowane()) return null;
  const dzis = dzisLokalnie(teraz);
  const godzina = Number(process.env.ANALIZA_RAPORT_GODZINA) || 7;
  if (teraz.getHours() < godzina || meta.get('raport')?.wartosc === dzis) return null;
  const p = meta.get('raport_proby')?.wartosc || '';
  const proby = p.startsWith(dzis + ':') ? Number(p.split(':')[1]) || 0 : 0;
  if (proby >= MAX_PROB_RAPORTU) return null;
  meta.set('raport_proby', `${dzis}:${proby + 1}`);
  const raport = require('./analiza-raport');
  const r = await raport.zbierzRaport(dodajDni(dzis, -1));
  const w = await gmail.wyslij({ do: doKogo, temat: raport.tematRaportu(r), html: raport.htmlRaportu(r), obrazy: r.obrazy });
  meta.set('raport', dzis);
  console.log(`[analiza] raport za ${dodajDni(dzis, -1)} wysłany (${w.id})`);
  return w;
}

async function przebieg(teraz = new Date()) {
  if (trwa) return null;              // poprzedni przebieg jeszcze trwa (GT wolne) — nie dokładamy drugiego
  trwa = true;
  try {
    let wynik = null;
    try {
      const nocnyDzis = meta.get('nocny')?.wartosc === dzisLokalnie(teraz);
      wynik = teraz.getHours() >= GODZINA_NOCNA && !nocnyDzis ? await nocny() : await biezacy();
    } catch (e) {
      awarie.blad('analiza', e.message);
      meta.set('blad', `${new Date().toISOString()} ${e.message}`);
    }
    // Trendy z tego, co już jest w bazie (dni zamknięte) — padnięte GT ich nie blokuje
    try {
      const t = require('./analiza-trendy').odswiezJesliTrzeba(teraz, { wymus: !!wynik?.bez_stanu });
      if (t) console.log(`[analiza] trendy policzone (${t.ms} ms, ${t.kb} KB, gzip ${t.gzKb} KB)`);
    } catch (e) { awarie.blad('analiza-trendy', e.message); }
    // raport osobno: padnięte GT nie blokuje maila z tego, co już jest w bazie, a błąd Gmaila — dosypywania danych
    try { await raportJesliPora(teraz); } catch (e) {
      awarie.blad('analiza-raport', e.message);
      meta.set('raport_blad', `${new Date().toISOString()} ${e.message}`);
    }
    return wynik;
  } finally {
    trwa = false;
  }
}

function start() {
  if (process.env.ANALIZA_WYLACZ === '1') { console.log('[analiza] job wyłączony (ANALIZA_WYLACZ=1)'); return null; }
  const ms = interwalMsZMinut(process.env.ANALIZA_INTERWAL_MIN, 15, 'ANALIZA_INTERWAL_MIN');
  const pierwszy = setTimeout(() => przebieg(), OPOZNIENIE_STARTU_MS);
  // w wątku analiz timery MUSZĄ trzymać pętlę (inaczej wątek kończy się od razu); zwalniamy je tylko w głównym
  if (!wWatku()) pierwszy.unref?.();
  const timer = setInterval(() => przebieg(), ms);
  if (!wWatku()) timer.unref?.();
  return timer;
}

module.exports = { start, przebieg, biezacy, nocny, raportJesliPora };
