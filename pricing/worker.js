'use strict';

// Worker repricera — OSOBNY proces obok WMS (nie w app.js): awaria albo wolne API platformy
// nie może zatrzymać magazynu. Na SRV chodzi jako zadanie harmonogramu `WMS-Pricing`.
//
// Co przebieg (PRICING_INTERWAL_MIN, domyślnie 30 min):
//   1. raz na dobę — synchronizacja listy ofert z Amazona (pricing/sync-oferty.js); eMAG RO co
//      przebieg (pricing/sync-emag.js) — ta sama lista służy do obserwacji, więc to jedno pobranie
//      (~32 zapytania). eMAG jest TYLKO DO ODCZYTU: decyzje liczymy, ceny nie wychodzą.
//      Bez EMAG_RO_USER w .env część eMAG jest pomijana; jej błąd (np. IP spoza listy w panelu
//      eMAG) nie zatrzymuje przebiegu Amazona.
//   2. obserwacja ofert: z włączonym automatem ZAWSZE, pozostałe ze stanem raz na
//      PRICING_PELNY_MIN (domyślnie 360 min) — żeby przed włączeniem automatu było widać,
//      co by zrobił, bez odpytywania całego katalogu co pół godziny
//   3. pas [min, max] i zysk z kalkulatora WMS (pricing/pas.js)
//   4. decyzja (pricing/model.js) → tabela `decyzje`
//
// Dwa tryby oferty (decyzja usera 2026-10-13 — tryb Próba zlikwidowany):
//   - automat (auto = 1): decyzje ze zmianą ceny idą od razu na Amazona,
//   - ręczny  (auto = 0): nic nie wysyłamy; decyzja zapisuje się jako podpowiedź (pełny przegląd co 6 h).
// PRICING_ZAPIS=1 w .env to nie tryb, tylko globalny hamulec: bez niego worker nie wyśle niczego
// (awaryjne zatrzymanie wszystkich cen jedną zmianą; ekran pokazuje wtedy ostrzeżenie).
//
//   node pricing/worker.js --raz [--pelny]   — jeden przebieg i koniec
//   node pricing/worker.js                   — w pętli

const { db, stan } = require('./db');
const { obserwuj } = require('./obserwuj');
const { pasyHurtem } = require('./pas');
const { decyzja, DOMYSLNE_REGULY } = require('./model');
const { synchronizuj } = require('./sync-oferty');
const { synchronizujEmag } = require('./sync-emag');
const { obserwujEmag } = require('./obserwuj-emag');
const emag = require('./emag');
const { kluczKolumny } = require('./kolumny');
const { ustawCene } = require('./amazon');
const { pewneDopasowanie } = require('./powiazania');
const { interwalMsZMinut } = require('../services/interwal');

const PELNY_MS = interwalMsZMinut(process.env.PRICING_PELNY_MIN, 360, 'PRICING_PELNY_MIN');
// Które platformy obsługuje ten proces (domyślnie wszystkie). Do testów na drugiej maszynie:
// PRICING_PLATFORMY=emag nie dotyka API Amazona, więc nie zjada limitów workera na SRV.
const PLATFORMY = new Set(String(process.env.PRICING_PLATFORMY || 'amazon,emag').split(',').map((x) => x.trim().toLowerCase()));
const SYNC_MS = 24 * 60 * 60 * 1000;

const minelo = (klucz, ms) => {
  const s = stan.get(klucz);
  return !s || Date.now() - new Date(s.czas.replace(' ', 'T') + 'Z').getTime() >= ms;
};

async function przebieg({ pelny = false } = {}) {
  const wynik = {};
  if (PLATFORMY.has('amazon') && minelo('sync_oferty', SYNC_MS)) {
    const s = await synchronizuj();
    stan.set('sync_oferty', JSON.stringify(s.map((x) => [x.rynek, x.ofert])));
    wynik.sync = s.reduce((a, x) => a + x.ofert, 0);
  }

  // eMAG: lista ofert = synchronizacja + materiał do obserwacji. Błąd tylko odnotowujemy.
  let emagSurowe = null;
  if (PLATFORMY.has('emag') && emag.skonfigurowany()) {
    try {
      emagSurowe = await emag.wszystkieOferty();
      const s = await synchronizujEmag(emagSurowe);
      stan.set('sync_emag', JSON.stringify(s));
      wynik.emag = s.aktywne;
    } catch (e) {
      stan.set('blad_emag', e.message);
      console.error(new Date().toISOString(), '[pricing] eMAG:', e.message);
    }
  }

  const pelnyTeraz = pelny || minelo('obserwacja_pelna', PELNY_MS);
  const zapisWlaczony = process.env.PRICING_ZAPIS === '1';
  const oferty = db.prepare(`SELECT id, platforma, rynek, sku, tw_id, auto, genius, dopasowanie FROM oferty
     WHERE ((platforma = 'amazon' AND ?) OR (platforma = 'emag' AND ?)) AND aktywna = 1 AND ilosc > 0 AND tw_id IS NOT NULL
       AND (auto = 1 OR ?)`).all(PLATFORMY.has('amazon') ? 1 : 0, emagSurowe ? 1 : 0, pelnyTeraz ? 1 : 0);
  wynik.ofert = oferty.length;
  wynik.pelny = pelnyTeraz;
  if (!oferty.length) return wynik;

  const amazon = oferty.filter((o) => o.platforma === 'amazon');
  const emagOf = oferty.filter((o) => o.platforma === 'emag');
  const geniusPoTw = new Map(emagOf.filter((o) => o.genius != null).map((o) => [o.tw_id, !!o.genius]));
  const [obsA, obsE, pasy] = await Promise.all([
    amazon.length ? obserwuj(amazon) : new Map(),
    emagOf.length ? obserwujEmag(emagOf, emagSurowe) : new Map(),
    pasyHurtem(oferty.map((o) => o.tw_id), geniusPoTw),
  ]);
  if (obsA.bledyPaczek) wynik.bledy_paczek = obsA.bledyPaczek;
  const obs = { get: (id) => obsA.get(id) || obsE.get(id) };

  const zapisz = db.prepare(`INSERT INTO decyzje (oferta_id, cena_przed, cena_nowa, min, max, kod, powod, wyslano, auto, zysk, marza, zysk_nowa, blad, marza_nowa, cena_cel, zysk_cel)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const kody = {};
  const wysylka = { wyslane: 0, odrzucone: 0 };
  const doPotwierdzenia = [];   // oferty z przyjętą zmianą — sprawdzimy je jeszcze raz po kilku minutach
  // Decyzje liczymy w pamięci, a zapis do bazy robimy po wysłaniu — wywołania API nie mogą
  // trzymać otwartej transakcji SQLite (WMS czyta tę bazę w tym samym czasie).
  const wiersze = [];
  // Kontekst reguły „czułej na utratę BB" (pricing/model.js, reguła 6) — z historii decyzji tej oferty.
  const okno = `-${DOMYSLNE_REGULY.blokadaPodwyzekH} hours`;
  const ostPodwyzka = db.prepare(`SELECT cena_przed, cena_nowa FROM decyzje WHERE oferta_id = ? AND wyslano = 1
      AND cena_nowa > cena_przed AND czas >= datetime('now', ?) ORDER BY id DESC LIMIT 1`);
  const cofniecie = db.prepare(`SELECT 1 FROM decyzje WHERE oferta_id = ? AND kod LIKE 'cofniecie%'
      AND czas >= datetime('now', ?) LIMIT 1`);
  for (const o of oferty) {
    const ob = obs.get(o.id);
    if (!ob) { kody.brak_odpowiedzi = (kody.brak_odpowiedzi || 0) + 1; continue; }
    const pas = (pasy.get(o.tw_id) || {})[kluczKolumny(o.platforma, o.rynek)] || null;
    const d = decyzja(ob, pas || {}, {}, {
      ostatniaPodwyzka: ostPodwyzka.get(o.id, okno) || null,
      blokadaPodwyzek: !!cofniecie.get(o.id, okno),
    });
    const teraz = pas && ob.cena ? pas.ocen(ob.cena) : null;
    const potem = pas && d.zmiana ? pas.ocen(d.cena) : teraz;
    const celOc = pas && d.zmiana && d.cel !== d.cena ? pas.ocen(d.cel) : potem;
    let wyslano = 0, blad = null;
    // Druga linia obrony obok POST /automat: bez pewnego dopasowania do GT nie wysyłamy, nawet gdy
    // auto = 1 (np. włączone przed wprowadzeniem zasady albo przez bezpośredni zapis w bazie).
    // Wysyłamy WYŁĄCZNIE na Amazona — eMAG na razie tylko obserwujemy (auto i tak jest tam blokowane w routes/ceny.js).
    if (zapisWlaczony && o.auto && d.zmiana && pas && o.platforma === 'amazon' && pewneDopasowanie(o.dopasowanie)) {
      try {
        const w = await ustawCene(o.rynek, o.sku, d.cena);
        if (w.ok) { wyslano = 1; wysylka.wyslane++; doPotwierdzenia.push(o); }
        else { blad = w.blad || `Amazon: ${w.status}`; wysylka.odrzucone++; }
      } catch (e) { blad = e.message; wysylka.odrzucone++; }
      console.log(new Date().toISOString(), `[pricing] ${o.rynek} ${o.sku}: ${ob.cena} → ${d.cena} ${wyslano ? 'WYSŁANO' : 'NIE WYSŁANO: ' + blad}`);
    }
    wiersze.push([o.id, ob.cena, d.cena, pas?.min ?? null, pas?.max ?? null, d.kod, d.powod, wyslano, o.auto,
      teraz?.zysk ?? null, teraz?.marza ?? null, potem?.zysk ?? null, blad, potem?.marza ?? null,
      d.cel ?? null, celOc?.zysk ?? null]);
    if (o.auto) kody[d.kod] = (kody[d.kod] || 0) + 1;
  }
  db.exec('BEGIN');
  try {
    for (const w of wiersze) zapisz.run(...w);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  if (wysylka.wyslane || wysylka.odrzucone) wynik.wysylka = wysylka;
  if (doPotwierdzenia.length) wynik.doPotwierdzenia = doPotwierdzenia;
  if (pelnyTeraz) stan.set('obserwacja_pelna', oferty.length);
  stan.set('przebieg', JSON.stringify(wynik));
  return { ...wynik, automat: kody };
}

// Potwierdzenie po wysłaniu: Amazon pokazuje nową cenę po ~3 min, a pełny przebieg jest co 30.
// Sprawdzamy więc wysłane oferty jeszcze raz po PRICING_POTWIERDZENIE_MIN (domyślnie 5) — sama
// obserwacja, bez decyzji. Ekran WMS od razu ma wtedy faktyczny stan (cena i Buy Box po zmianie).
const POTWIERDZENIE_MS = interwalMsZMinut(process.env.PRICING_POTWIERDZENIE_MIN, 5, 'PRICING_POTWIERDZENIE_MIN');

async function przebiegBezpieczny(opcje) {
  const t0 = Date.now();
  try {
    const w = await przebieg(opcje);
    const doPotwierdzenia = w.doPotwierdzenia || [];
    delete w.doPotwierdzenia;
    console.log(new Date().toISOString(), `[pricing] przebieg ${((Date.now() - t0) / 1000).toFixed(0)} s`, JSON.stringify(w));
    return doPotwierdzenia;
  } catch (e) {
    // Błąd jednego przebiegu (API, GT) nie zabija procesu — następny spróbuje znowu.
    stan.set('blad', e.message);
    console.error(new Date().toISOString(), '[pricing] błąd przebiegu:', e.message);
    return [];
  }
}

async function potwierdz(oferty) {
  try {
    const obs = await obserwuj(oferty);
    for (const o of oferty) {
      const ob = obs.get(o.id);
      console.log(new Date().toISOString(), `[pricing] potwierdzenie ${o.rynek} ${o.sku}: na Amazonie ${ob ? ob.cena : '?'}`
        + `, Buy Box ${ob ? (ob.bbNasz ? 'nasz' : ob.bbNasz === false ? 'INNY' : '?') : '?'}`);
    }
  } catch (e) {
    console.error(new Date().toISOString(), '[pricing] błąd potwierdzenia:', e.message);
  }
}

module.exports = { przebieg };

// Log do pliku pisze SAM worker (logs/pricing.log), a zadanie harmonogramu uruchamia node.exe
// bezpośrednio. Wcześniej log szedł przez `cmd /c ... >> plik` — Stop-ScheduledTask zabijał wtedy
// tylko cmd, osierocony node działał dalej na starym kodzie i trzymał plik logu, przez co nowy
// start odbijał się błędem (2026-10-13).
function logujDoPliku() {
  const fs = require('fs');
  const path = require('path');
  const plik = path.join(__dirname, '..', 'logs', 'pricing.log');
  fs.mkdirSync(path.dirname(plik), { recursive: true });
  for (const metoda of ['log', 'error', 'warn']) {
    const oryg = console[metoda].bind(console);
    console[metoda] = (...a) => {
      oryg(...a);
      try { fs.appendFileSync(plik, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n'); } catch { /* log nie może zabić workera */ }
    };
  }
}

if (require.main === module) {
  if (process.argv.includes('--log')) logujDoPliku();
  if (process.argv.includes('--raz')) {
    przebiegBezpieczny({ pelny: process.argv.includes('--pelny') }).then(() => process.exit(0));
  } else {
    const ms = interwalMsZMinut(process.env.PRICING_INTERWAL_MIN, 30, 'PRICING_INTERWAL_MIN');
    console.log(`[pricing] worker startuje, przebieg co ${ms / 60000} min, `
      + (process.env.PRICING_ZAPIS === '1' ? 'oferty z automatem zmieniają ceny na Amazonie' : 'HAMULEC: PRICING_ZAPIS ≠ 1, żadna cena nie idzie na Amazona'));
    let trwa = false;
    const tik = async () => {
      if (trwa) return;
      trwa = true;
      const doPotwierdzenia = await przebiegBezpieczny();
      trwa = false;
      if (doPotwierdzenia.length) {
        setTimeout(async () => { if (trwa) return; trwa = true; await potwierdz(doPotwierdzenia); trwa = false; }, POTWIERDZENIE_MS);
      }
    };
    tik();
    setInterval(tik, ms);
  }
}
