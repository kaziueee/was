'use strict';

// Dopłaty Allegro do ceny — na żywo, do modułu analiz sprzedaży (services/analiza-doplaty.js czyta tę tabelę).
//
// W programie Allegro Ceny (i AlleObniżce) klient płaci mniej niż cena oferty, a różnicę dopłaca Allegro — wpisem
// w billingu, nie na fakturze. Faktura w GT ma więc cenę klienta, a analiza bez tego zaniżała przychód i zysk
// (HASF1460 NaTropie: FS 113,85, oferta 129,99, billing PS1 +16,14; prowizja liczona od 129,99). Pomiar 2026-10-29
// na billingu z Rozliczeń: ~7,8 tys. zł brutto / 30 dni, 97% wpisów w ciągu 15 min od prowizji zamówienia.
//
// Rozliczenia (C:\Rozliczenia) mają te same wpisy, ale pobierają billing raz na dobę (03:00) — dla „Dnia” i „Live”
// za późno, więc WMS-Pricing pobiera je sam co PRICING_DOPLATY_MIN (5 min) tokenami repricera. Wymaga w aplikacji
// „WMS Price” uprawnień allegro:api:billing:read (wpisy) i allegro:api:orders:read (zamówienie → płatność); bez nich
// Allegro odpowiada 403 i analiza dalej bierze dopłaty z Rozliczeń (z dobowym opóźnieniem).
//
// Klucz łączenia z GT: ZK trzyma identyfikator PŁATNOŚCI (pwd_Tekst05 / uwagi), billing — identyfikator ZAMÓWIENIA
// (checkout form). Most order → payment bierzemy z GET /order/checkout-forms/{id} raz na zamówienie.

if (require.main === module) require('../config/env');     // CLI: klucze przed bazą i adapterem
const allegro = require('./allegro');
const { db, stan } = require('./db');

// PS1 „Rabat transakcyjny w programie Allegro Ceny”, PSA „Rabat AlleObniżka z oznaczeniem”, PSO „Rabat AlleObniżka”
// (stara nazwa, do 09.2025). Typy z billingu Rozliczeń 2025-01 – 2026-10; wszystkie per zamówienie, ~99% dodatnie.
const TYPY = ['PS1', 'PSA', 'PSO'];
const NA_START_DNI = 14;          // pierwsze pobranie: tyle wstecz (analiza przelicza 14 dni co noc)
const ZAKLADKA_MS = 2 * 3600e3;   // okno nachodzi na poprzednie — wpis z opóźnionym occurredAt nie przepada
const MOSTOW_NA_PRZEBIEG = 300;   // checkout-forms na przebieg (pierwszy przebieg: ~950 zamówień z 14 dni → 3–4 przebiegi)

db.exec(`CREATE TABLE IF NOT EXISTS allegro_doplaty (
  id         TEXT PRIMARY KEY,      -- numer wpisu billingu (ten sam co allegro_billing_wpis.id w Rozliczeniach)
  konto      TEXT NOT NULL,         -- EKAJTEK | NATROPIE
  zamowienie TEXT,                  -- order.id (checkout form)
  platnosc   TEXT,                  -- payment.id = UUID w ZK; NULL = jeszcze nie dopytane
  czas       TEXT NOT NULL,         -- occurredAt (UTC, ISO)
  typ        TEXT NOT NULL,
  kwota      REAL NOT NULL,         -- brutto PLN, ze znakiem z billingu
  pobrano    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_allegro_doplaty_platnosc ON allegro_doplaty(platnosc);
CREATE INDEX IF NOT EXISTS idx_allegro_doplaty_zam ON allegro_doplaty(zamowienie);`);

// --- czyste funkcje (test/pricing-doplaty-allegro.test.js) ------------------------------------------------------

// Wpis billingu → wiersz tabeli albo null (inny typ, bez zamówienia, bez kwoty PLN).
function wpisDoplaty(e, konto) {
  const typ = e?.type?.id;
  if (!TYPY.includes(typ) || !e.id || !e.order?.id || !e.occurredAt) return null;
  if (e.value?.currency && e.value.currency !== 'PLN') return null;
  const kwota = Number(e.value?.amount);
  if (!Number.isFinite(kwota) || kwota === 0) return null;
  return { id: String(e.id), konto, zamowienie: String(e.order.id), czas: e.occurredAt, typ, kwota };
}

// Od kiedy pytać: ostatni widziany wpis minus zakładka; bez znacznika — NA_START_DNI wstecz.
function oknoOd(znacznik, teraz = Date.now()) {
  const t = Date.parse(znacznik || '');
  return new Date(Number.isFinite(t) ? t - ZAKLADKA_MS : teraz - NA_START_DNI * 86400e3).toISOString();
}

// --- pobieranie --------------------------------------------------------------------------------------------------

async function wpisyOd(konto, od) {
  const wynik = [];
  for (let offset = 0; ; offset += 100) {
    const r = await allegro.api(konto, '/billing/billing-entries',
      { query: { 'type.id': TYPY, 'occurredAt.gte': od, limit: 100, offset } });
    const paczka = r?.billingEntries || [];
    wynik.push(...paczka);
    if (paczka.length < 100 || offset >= 9_900) return wynik;     // API: offset + limit ≤ 10 000
  }
}

async function dlaKonta(konto) {
  const klucz = `doplaty_allegro_${konto}`;
  const od = oknoOd(stan.get(klucz)?.wartosc);
  const wiersze = (await wpisyOd(konto, od)).map((e) => wpisDoplaty(e, konto)).filter(Boolean);
  const ins = db.prepare(`INSERT INTO allegro_doplaty (id, konto, zamowienie, czas, typ, kwota) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET kwota = excluded.kwota, czas = excluded.czas, typ = excluded.typ`);
  db.exec('BEGIN');
  try { for (const w of wiersze) ins.run(w.id, w.konto, w.zamowienie, w.czas, w.typ, w.kwota); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  const najnowszy = wiersze.reduce((m, w) => (w.czas > m ? w.czas : m), stan.get(klucz)?.wartosc || '');
  if (najnowszy) stan.set(klucz, najnowszy);

  // zamówienie → płatność: jedno zapytanie na zamówienie (wpisy PS1 i PSA tego samego zamówienia dzielą wynik)
  const bez = db.prepare(`SELECT DISTINCT zamowienie FROM allegro_doplaty WHERE konto = ? AND platnosc IS NULL ORDER BY czas DESC LIMIT ?`)
    .all(konto, MOSTOW_NA_PRZEBIEG).map((x) => x.zamowienie);
  const upd = db.prepare('UPDATE allegro_doplaty SET platnosc = ? WHERE zamowienie = ?');
  let mostow = 0;
  for (const z of bez) {
    const f = await allegro.api(konto, `/order/checkout-forms/${encodeURIComponent(z)}`);
    if (f?.payment?.id) { upd.run(String(f.payment.id).toLowerCase(), z); mostow++; }
  }
  return { wpisow: wiersze.length, mostow, czeka: bez.length - mostow };
}

// Przebieg na wszystkich podpiętych kontach. Błąd jednego konta nie zatrzymuje drugiego; 403 (brak uprawnień
// billing/orders w aplikacji) logujemy raz na godzinę, nie co 5 minut.
const ostatni403 = new Map();
async function pobierzDoplaty({ log = console.log, blad = console.error } = {}) {
  if (!allegro.skonfigurowany()) return null;
  const wynik = {};
  for (const konto of allegro.kontaAutoryzowane()) {
    try {
      wynik[konto] = await dlaKonta(konto);
      ostatni403.delete(konto);
    } catch (e) {
      wynik[konto] = { blad: e.message };
      if (e.status === 403) {
        if (Date.now() - (ostatni403.get(konto) || 0) < 3600e3) continue;
        ostatni403.set(konto, Date.now());
        blad(new Date().toISOString(), `[pricing] dopłaty Allegro ${konto}: brak uprawnień billing:read / orders:read w aplikacji „WMS Price” — `
          + `analiza bierze dopłaty z Rozliczeń (raz na dobę). Dodaj uprawnienia i podepnij konto: node pricing/allegro-autoryzuj.js ${konto}`);
      } else blad(new Date().toISOString(), `[pricing] dopłaty Allegro ${konto}:`, e.message);
    }
  }
  const s = Object.entries(wynik).filter(([, w]) => !w.blad && (w.wpisow || w.mostow));
  if (s.length) log(new Date().toISOString(), '[pricing] dopłaty Allegro:', s.map(([k, w]) => `${k} ${w.wpisow} wpisów, ${w.mostow} zamówień${w.czeka ? ` (czeka ${w.czeka})` : ''}`).join('; '));
  return wynik;
}

module.exports = { TYPY, wpisDoplaty, oknoOd, pobierzDoplaty };

if (require.main === module) {
  pobierzDoplaty().then((w) => { console.log(JSON.stringify(w, null, 2)); process.exit(0); }, (e) => { console.error(e); process.exit(1); });
}
