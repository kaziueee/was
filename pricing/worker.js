'use strict';

// Worker repricera — OSOBNY proces obok WMS (nie w app.js): awaria albo wolne API platformy
// nie może zatrzymać magazynu. Na SRV chodzi jako zadanie harmonogramu `WMS-Pricing`.
//
// Co przebieg (PRICING_INTERWAL_MIN, domyślnie 30 min):
//   1. raz na dobę — synchronizacja listy ofert z Amazona (pricing/sync-oferty.js)
//   2. obserwacja ofert: z włączonym automatem ZAWSZE, pozostałe ze stanem raz na
//      PRICING_PELNY_MIN (domyślnie 360 min) — żeby przed włączeniem automatu było widać,
//      co by zrobił, bez odpytywania całego katalogu co pół godziny
//   3. pas [min, max] i zysk z kalkulatora WMS (pricing/pas.js)
//   4. decyzja (pricing/model.js) → tabela `decyzje`
//
// Wysyłanie cen na Amazona — DWA klucze naraz, inaczej tryb Próba (decyzja tylko w bazie):
//   - PRICING_ZAPIS=1 w .env (globalny hamulec: bez niego worker nie wyśle niczego),
//   - oferty.zapis = 1 dla konkretnej oferty (node pricing/automat.js wysylanie wlacz <RYNEK> <SKU>).
// Oferta musi też mieć włączony automat (auto = 1). Wysyłamy tylko decyzje ze zmianą ceny.
//
//   node pricing/worker.js --raz [--pelny]   — jeden przebieg i koniec
//   node pricing/worker.js                   — w pętli

const { db, stan } = require('./db');
const { obserwuj } = require('./obserwuj');
const { pasyHurtem } = require('./pas');
const { decyzja, DOMYSLNE_REGULY } = require('./model');
const { synchronizuj } = require('./sync-oferty');
const { ustawCene } = require('./amazon');
const { interwalMsZMinut } = require('../services/interwal');

const PELNY_MS = interwalMsZMinut(process.env.PRICING_PELNY_MIN, 360, 'PRICING_PELNY_MIN');
const SYNC_MS = 24 * 60 * 60 * 1000;

const minelo = (klucz, ms) => {
  const s = stan.get(klucz);
  return !s || Date.now() - new Date(s.czas.replace(' ', 'T') + 'Z').getTime() >= ms;
};

async function przebieg({ pelny = false } = {}) {
  const wynik = {};
  if (minelo('sync_oferty', SYNC_MS)) {
    const s = await synchronizuj();
    stan.set('sync_oferty', JSON.stringify(s.map((x) => [x.rynek, x.ofert])));
    wynik.sync = s.reduce((a, x) => a + x.ofert, 0);
  }

  const pelnyTeraz = pelny || minelo('obserwacja_pelna', PELNY_MS);
  const zapisWlaczony = process.env.PRICING_ZAPIS === '1';
  const oferty = db.prepare(`SELECT id, rynek, sku, tw_id, auto, zapis FROM oferty
     WHERE platforma = 'amazon' AND aktywna = 1 AND ilosc > 0 AND tw_id IS NOT NULL
       AND (auto = 1 OR ?)`).all(pelnyTeraz ? 1 : 0);
  wynik.ofert = oferty.length;
  wynik.pelny = pelnyTeraz;
  if (!oferty.length) return wynik;

  const [obs, pasy] = await Promise.all([obserwuj(oferty), pasyHurtem(oferty.map((o) => o.tw_id))]);
  if (obs.bledyPaczek) wynik.bledy_paczek = obs.bledyPaczek;

  const zapisz = db.prepare(`INSERT INTO decyzje (oferta_id, cena_przed, cena_nowa, min, max, kod, powod, wyslano, auto, zysk, marza, zysk_nowa, blad)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const kody = {};
  const wysylka = { wyslane: 0, odrzucone: 0 };
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
    const pas = (pasy.get(o.tw_id) || {})[o.rynek] || null;
    const d = decyzja(ob, pas || {}, {}, {
      ostatniaPodwyzka: ostPodwyzka.get(o.id, okno) || null,
      blokadaPodwyzek: !!cofniecie.get(o.id, okno),
    });
    const teraz = pas && ob.cena ? pas.ocen(ob.cena) : null;
    const potem = pas && d.zmiana ? pas.ocen(d.cena) : teraz;
    let wyslano = 0, blad = null;
    if (zapisWlaczony && o.auto && o.zapis && d.zmiana && pas) {
      try {
        const w = await ustawCene(o.rynek, o.sku, d.cena);
        if (w.ok) { wyslano = 1; wysylka.wyslane++; }
        else { blad = w.blad || `Amazon: ${w.status}`; wysylka.odrzucone++; }
      } catch (e) { blad = e.message; wysylka.odrzucone++; }
      console.log(new Date().toISOString(), `[pricing] ${o.rynek} ${o.sku}: ${ob.cena} → ${d.cena} ${wyslano ? 'WYSŁANO' : 'NIE WYSŁANO: ' + blad}`);
    }
    wiersze.push([o.id, ob.cena, d.cena, pas?.min ?? null, pas?.max ?? null, d.kod, d.powod, wyslano, o.auto,
      teraz?.zysk ?? null, teraz?.marza ?? null, potem?.zysk ?? null, blad]);
    if (o.auto) kody[d.kod] = (kody[d.kod] || 0) + 1;
  }
  db.exec('BEGIN');
  try {
    for (const w of wiersze) zapisz.run(...w);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  if (wysylka.wyslane || wysylka.odrzucone) wynik.wysylka = wysylka;
  if (pelnyTeraz) stan.set('obserwacja_pelna', oferty.length);
  stan.set('przebieg', JSON.stringify(wynik));
  return { ...wynik, automat: kody };
}

async function przebiegBezpieczny(opcje) {
  const t0 = Date.now();
  try {
    const w = await przebieg(opcje);
    console.log(new Date().toISOString(), `[pricing] przebieg ${((Date.now() - t0) / 1000).toFixed(0)} s`, JSON.stringify(w));
  } catch (e) {
    // Błąd jednego przebiegu (API, GT) nie zabija procesu — następny spróbuje znowu.
    stan.set('blad', e.message);
    console.error(new Date().toISOString(), '[pricing] błąd przebiegu:', e.message);
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
      + (process.env.PRICING_ZAPIS === '1' ? 'WYSYŁANIE CEN WŁĄCZONE dla ofert z zapis = 1' : 'tryb Próba (PRICING_ZAPIS ≠ 1, bez wysyłania cen)'));
    let trwa = false;
    const tik = async () => { if (trwa) return; trwa = true; await przebiegBezpieczny(); trwa = false; };
    tik();
    setInterval(tik, ms);
  }
}
