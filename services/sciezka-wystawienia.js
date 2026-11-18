'use strict';

// Ścieżka wystawienia (Ceny → „Ścieżka”): zbiera dane do services/sciezka-wystawienia-model.js i zapisuje gotowy
// JSON do `pulpit_snapshot` (klucz `sciezka_wystawienia`). Chodzi w OSOBNYM WĄTKU (services/watek.js, zasada 7):
// zapytanie do GT o ~4 tys. towarów, feed sklepu (~13 MB, ~5 s) i przegląd ~100 tys. wierszy katalogów to sekundy
// pracy, a API ma tylko podać gotowy tekst.
//
// Pętla wątku:
//   • pełny przebieg co SCIEZKA_WYSTAWIENIA_INTERWAL_MIN (domyślnie 15) i na życzenie z ekranu (↻ → klucz
//     `sciezka_wystawienia_zadanie`);
//   • co 15 s sprawdza, czy ktoś odhaczył kartę sklepu (`sklep_karty`) — wtedy przelicza sam model na danych
//     z ostatniego przebiegu (milisekundy), bez ponownego pytania GT i sklepu.
//
// Tylko ODCZYT: GT (SELECT), feed publiczny sklepu, pricing.db. Nic nie zapisuje poza własnym snapshotem.
// Pad GT = przebieg się nie zapisuje (ekran pokazuje poprzedni z godziną); pad feedu = ostatni udany feed do 24 h,
// potem krok „Sklep” = nieznany (nie „brak karty” — nie wiem ≠ zero).

const db = require('../db/database');
const { db: pdb } = require('../pricing/db');
const { query } = require('./gt-sql');
const { rozbierzWymiary, KOLUMNY, TYP_OBIEKTU_TOWAR } = require('./gt-atrybuty');
const { interwalMsZMinut } = require('./interwal');
const awarie = require('./awarie');
const { wWatku } = require('./watek');
const sm = require('./sciezka-wystawienia-model');

const KLUCZ = 'sciezka_wystawienia';
const KLUCZ_ZADANIE = 'sciezka_wystawienia_zadanie';
const FEED_URL = process.env.SKLEP_FEED_URL || 'https://poszukiwaczefrajdy.pl/feed/googlemerchant';
const FEED_WAZNY_MS = 24 * 60 * 60 * 1000;
const SPRAWDZ_MS = 15 * 1000;
const OPOZNIENIE_STARTU_MS = 90 * 1000;   // po rozjazdach/strefach — bez tłoku przy starcie

// Towary ze stanem dostępnym (stan − rezerwacja) na K4+K4G: to, co da się sprzedać przez internet. MAG/LS pomijamy —
// to sklep stacjonarny (decyzja usera 2026-11-18). Zestawy (rodzaj 8) też: sprzedajemy je online jak towar.
// Stan liczony w CTE, żeby dołączenie ceny/pól własnych nie mnożyło sum.
async function towaryZGt() {
  const r = await query(`
    WITH st AS (
      SELECT s.st_TowId, SUM(s.st_Stan) AS stan, SUM(s.st_StanRez) AS rez
      FROM tw_Stan s JOIN sl_Magazyn m ON m.mag_Id = s.st_MagId
      WHERE m.mag_Symbol IN ('K4', 'K4G')
      GROUP BY s.st_TowId
      HAVING SUM(s.st_Stan) - SUM(s.st_StanRez) > 0)
    SELECT t.tw_Id, t.tw_Symbol, t.tw_Nazwa, t.tw_PodstKodKresk AS ean, t.tw_Rodzaj, t.tw_SklepInternet AS sklep,
           st.stan, st.rez, c.tc_CenaBrutto3 AS cena3, g.grt_Nazwa AS grupa,
           pw.${KOLUMNY.waga} AS waga, pw.${KOLUMNY.wymiary} AS wymiary
    FROM st
    JOIN tw__Towar t ON t.tw_Id = st.st_TowId
    LEFT JOIN tw_Cena c ON c.tc_IdTowar = t.tw_Id
    LEFT JOIN sl_GrupaTw g ON g.grt_Id = t.tw_IdGrupa
    LEFT JOIN pw_Dane pw ON pw.pwd_TypObiektu = ${TYP_OBIEKTU_TOWAR} AND pw.pwd_IdObiektu = t.tw_Id
    WHERE t.tw_Rodzaj IN (1, 8) AND t.tw_Zablokowany = 0`);
  const mapa = new Map();
  for (const w of r.recordset ?? r) {
    if (mapa.has(w.tw_Id)) continue;
    mapa.set(w.tw_Id, {
      tw_id: w.tw_Id, symbol: String(w.tw_Symbol || '').trim(), nazwa: w.tw_Nazwa, ean: String(w.ean || '').trim() || null,
      grupa: w.grupa || '', zestaw: w.tw_Rodzaj === 8, stan: Number(w.stan) - Number(w.rez || 0),
      sklep: !!w.sklep, cena3: w.cena3 == null ? null : Number(w.cena3),
      waga: w.waga || null, wymiary: w.wymiary || null, wymiary_rozbite: rozbierzWymiary(w.wymiary),
    });
  }
  return [...mapa.values()];
}

let feedPamiec = null;   // { mapa, czas } — ostatni udany feed (pad sklepu nie zamienia kart w „brak”)
async function feedSklepu() {
  try {
    const odp = await fetch(FEED_URL, { signal: AbortSignal.timeout(90 * 1000) });
    if (!odp.ok) throw new Error(`HTTP ${odp.status}`);
    const mapa = sm.parsujFeed(await odp.text());
    if (mapa.size < 100) throw new Error(`feed podejrzanie krótki (${mapa.size} kart)`);
    feedPamiec = { mapa, czas: Date.now() };
    return { mapa, ok: true, czas: feedPamiec.czas };
  } catch (e) {
    awarie.blad('sciezka-wystawienia', `feed sklepu: ${e.message}`);
    if (feedPamiec && Date.now() - feedPamiec.czas < FEED_WAZNY_MS) return { mapa: feedPamiec.mapa, ok: false, czas: feedPamiec.czas, blad: e.message };
    return { mapa: null, ok: false, blad: e.message };
  }
}

// pricing.db: oferty, katalogi, ostatnie próby wystawienia — wszystko jednym przebiegiem, filtrowane do towarów ścieżki.
function danePricing(twIds) {
  const zbior = new Set(twIds);
  const allegro = new Map(), rynki = new Map();
  const doRynku = (tw, klucz) => {
    if (!rynki.has(tw)) rynki.set(tw, new Map());
    const m = rynki.get(tw);
    if (!m.has(klucz)) m.set(klucz, { oferty: [], katalog: null, wystawienie: null });
    return m.get(klucz);
  };
  const kluczeRynkow = new Set(sm.RYNKI.map((r) => r.klucz));
  const oferty = pdb.prepare(`SELECT platforma, rynek, tw_id, asin, cena, aktywna,
      (widziana >= datetime('now', '-${sm.OFERTA_SWIEZA_DNI} days')) AS swieza
    FROM oferty WHERE tw_id IS NOT NULL ORDER BY aktywna DESC, widziana DESC`).all();
  for (const o of oferty) {
    if (!zbior.has(o.tw_id)) continue;
    const wpis = { rynek: o.rynek, asin: o.asin, cena: o.cena, aktywna: o.aktywna ? 1 : 0, swieza: !!o.swieza };
    if (o.platforma === 'allegro') {
      if (!allegro.has(o.tw_id)) allegro.set(o.tw_id, []);
      allegro.get(o.tw_id).push(wpis);
    } else if (kluczeRynkow.has(`${o.platforma}:${o.rynek}`)) doRynku(o.tw_id, `${o.platforma}:${o.rynek}`).oferty.push(wpis);
  }
  for (const k of pdb.prepare('SELECT tw_id, platforma, rynek, produkt_id, dodac, mamy, ograniczenie FROM katalog').all()) {
    const kl = `${k.platforma}:${k.rynek}`;
    if (zbior.has(k.tw_id) && kluczeRynkow.has(kl)) doRynku(k.tw_id, kl).katalog = k;
  }
  for (const w of pdb.prepare(`SELECT w.tw_id, w.platforma, w.rynek, w.status, w.opis FROM wystawienia w
      JOIN (SELECT MAX(id) AS id FROM wystawienia GROUP BY tw_id, platforma, rynek) x ON x.id = w.id`).all()) {
    const kl = `${w.platforma}:${w.rynek}`;
    if (zbior.has(w.tw_id) && kluczeRynkow.has(kl)) doRynku(w.tw_id, kl).wystawienie = w;
  }
  return { allegro, rynki };
}

const odhaczenia = () => new Map(db.prepare('SELECT tw_id, karta_id, kto, czas FROM sklep_karty').all().map((r) => [r.tw_id, r]));
const wersjaOdhaczen = () => {
  const r = db.prepare('SELECT COUNT(*) AS n, MAX(czas) AS t, COALESCE(SUM(tw_id), 0) AS s FROM sklep_karty').get();
  return `${r.n}|${r.t}|${r.s}`;
};

// Znaczniki czasu w formacie bazy (UTC, „YYYY-MM-DD HH:MM:SS”) — ekran przelicza je jak każdy inny (dataZBazy).
const czasBazy = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

// Złożenie wyniku z zebranych danych (osobno, żeby odhaczenie przeliczało sam model bez GT i sklepu).
function zloz(wejscie) {
  const { towary, feed, pricing, start, ms } = wejscie;
  const karty = odhaczenia();
  const lista = towary.map((t) => {
    const ocena = sm.ocenTowar(t, {
      feed: feed.mapa?.get(sm.kluczSymbolu(t.symbol)) || null, feedZnany: !!feed.mapa,
      odhaczenie: karty.get(t.tw_id) || null,
      allegro: pricing.allegro.get(t.tw_id) || [], rynki: pricing.rynki.get(t.tw_id) || new Map(),
    });
    // Rynki bez wpisu w katalogu („nie sprawdzono”) pomijamy — to większość komórek, a ekran czyta brak klucza tak samo.
    const r = ocena.kroki.rynki.rynki;
    for (const k of Object.keys(r)) if (r[k].status === 'nie_sprawdzono') delete r[k];
    return { tw_id: t.tw_id, symbol: t.symbol, nazwa: t.nazwa, grupa: t.grupa, ean: t.ean, zestaw: t.zestaw || undefined,
      stan: t.stan, cena3: t.cena3, ...ocena };
  });
  return {
    obliczono: czasBazy(Date.now()), zebrano: czasBazy(start), ms,
    feed: { ok: feed.ok, kart: feed.mapa?.size ?? null, czas: feed.czas ? czasBazy(feed.czas) : null, blad: feed.blad || null },
    kroki: sm.KROKI, rynki: sm.RYNKI, konta_allegro: sm.KONTA_ALLEGRO,
    podsumowanie: sm.podsumuj(lista), towary: lista,
  };
}

const STMT_ZAPIS = db.prepare(`INSERT INTO pulpit_snapshot (klucz, wartosc, obliczono) VALUES (?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(klucz) DO UPDATE SET wartosc = excluded.wartosc, obliczono = CURRENT_TIMESTAMP`);
const zapisz = (wynik) => STMT_ZAPIS.run(KLUCZ, JSON.stringify(wynik));

let ostatnie = null, wersja = null, trwa = false, ostatniPelny = 0;

async function przebieg() {
  if (trwa) return null;
  trwa = true;
  const start = Date.now();
  try {
    const [towary, feed] = await Promise.all([towaryZGt(), feedSklepu()]);
    const pricing = danePricing(towary.map((t) => t.tw_id));
    ostatnie = { towary, feed, pricing, start, ms: Date.now() - start };
    wersja = wersjaOdhaczen();
    const wynik = zloz(ostatnie);
    zapisz(wynik);
    console.log(`[sciezka] ${wynik.towary.length} towarów, etapy ${JSON.stringify(wynik.podsumowanie.etapy)}, ${wynik.ms} ms${feed.ok ? '' : ` (feed: ${feed.blad})`}`);
    return wynik;
  } catch (e) {
    awarie.blad('sciezka-wystawienia', `przebieg: ${e.message}`);
    console.error('[sciezka] przebieg nieudany:', e.message);
    return null;
  } finally {
    ostatniPelny = Date.now();
    trwa = false;
  }
}

// Co 15 s: prośba o odświeżenie z ekranu → pełny przebieg; nowe odhaczenie karty → sam model na starych danych.
async function sprawdz() {
  if (trwa) return;
  try {
    const z = db.prepare('SELECT obliczono FROM pulpit_snapshot WHERE klucz = ?').get(KLUCZ_ZADANIE);
    if (z && new Date(String(z.obliczono).replace(' ', 'T') + 'Z').getTime() > ostatniPelny) { await przebieg(); return; }
    if (ostatnie && wersjaOdhaczen() !== wersja) {
      wersja = wersjaOdhaczen();
      zapisz(zloz(ostatnie));
    }
  } catch (e) { awarie.blad('sciezka-wystawienia', `sprawdzenie: ${e.message}`); }
}

function start() {
  ostatniPelny = Date.now();   // stara prośba o odświeżenie sprzed restartu nie odpala przebiegu w tłoku startu
  const interwal = interwalMsZMinut(process.env.SCIEZKA_WYSTAWIENIA_INTERWAL_MIN, 15, 'SCIEZKA_WYSTAWIENIA_INTERWAL_MIN');
  const timery = [
    setTimeout(przebieg, OPOZNIENIE_STARTU_MS),
    setInterval(przebieg, interwal),
    setInterval(sprawdz, SPRAWDZ_MS),
  ];
  if (!wWatku()) timery.forEach((t) => t.unref?.());
  return timery;
}

// Prośba z ekranu o świeży przebieg (główny wątek: jeden zapis, wątek podchwyci w ≤ 15 s).
function zlecOdswiezenie() {
  STMT_ZAPIS.run(KLUCZ_ZADANIE, '1');
}

// Odczyt dla trasy: surowy tekst JSON (bez parsowania 2 MB w głównym wątku) + kiedy policzono.
function odczytajSurowe() {
  return db.prepare('SELECT wartosc, obliczono FROM pulpit_snapshot WHERE klucz = ?').get(KLUCZ) || null;
}

module.exports = { start, przebieg, zloz, zlecOdswiezenie, odczytajSurowe, towaryZGt, KLUCZ };
