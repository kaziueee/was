'use strict';
if (require.main === module) require('../config/env');     // CLI: klucze przed bazą i adapterem

// Billing Allegro per zamówienie — na żywo, do modułu analiz sprzedaży (services/analiza-billing.js czyta tę tabelę).
//
// Zysk zamówień Allegro liczymy hybrydowo (decyzja usera 2026-10-30): składnik, który Allegro już naliczyło
// (prowizja, opłata za dostawę, dopłata Allegro Ceny, zwrot kosztów…), bierzemy z billingu, resztę szacuje kalkulator.
// Prowizja przychodzi w tej samej minucie co zamówienie, dostawa 1–3 dni później, zwrot kosztów nawet po miesiącu.
// Dopłata Allegro Ceny / AlleObniżka (PS1 / PSA / PSO) to przychód, którego faktura nie zna (HASF1460 NaTropie:
// FS 113,85 + PS1 16,14 = oferta 129,99; prowizja 18,40 od pełnej kwoty).
//
// Rozliczenia (C:\Rozliczenia) mają te same wpisy, ale pobierają billing raz na dobę (03:00) — dla „Dnia” i „Live”
// za późno, więc WMS-Pricing pobiera je sam co PRICING_BILLING_MIN (5 min) tokenami repricera. Wymaga w aplikacji
// „WMS Price” uprawnień allegro:api:billing:read (wpisy) i allegro:api:orders:read (zamówienie → płatność); bez nich
// Allegro odpowiada 403 i analiza bierze billing z Rozliczeń (z dobowym opóźnieniem).
//
// Klucz łączenia z GT: ZK trzyma identyfikator PŁATNOŚCI (pwd_Tekst05 / uwagi), billing — identyfikator ZAMÓWIENIA
// (checkout form). Most order → payment bierzemy z GET /order/checkout-forms/{id} raz na zamówienie.
// Wpisy bez zamówienia (Ads, abonament, „Pobranie opłat z wpływów”) pomijamy — nie są kosztem zamówienia.

const allegro = require('./allegro');
const { db, stan } = require('./db');

const NA_START_DNI = 14;          // pierwsze pobranie: tyle wstecz (analiza przelicza 14 dni co noc)
const ZAKLADKA_MS = 2 * 3600e3;   // okno nachodzi na poprzednie — wpis z opóźnionym occurredAt nie przepada
const MOSTOW_NA_PRZEBIEG = 1000;  // checkout-forms na przebieg (~300 zamówień dziennie; start z 14 dni ≈ 4 tys. → 4 przebiegi)

db.exec(`CREATE TABLE IF NOT EXISTS allegro_billing (
  id         TEXT PRIMARY KEY,      -- numer wpisu billingu (ten sam co allegro_billing_wpis.id w Rozliczeniach)
  konto      TEXT NOT NULL,         -- EKAJTEK | NATROPIE
  zamowienie TEXT NOT NULL,         -- order.id (checkout form)
  platnosc   TEXT,                  -- payment.id = UUID w ZK; NULL = jeszcze nie dopytane
  czas       TEXT NOT NULL,         -- occurredAt (UTC, ISO)
  typ        TEXT NOT NULL,         -- type.id (SUC, PS1, DPB…)
  nazwa      TEXT,                  -- type.name — po niej klasyfikujemy opłaty za dostawę (nowi przewoźnicy = nowe id)
  kwota      REAL NOT NULL,         -- brutto PLN, ze znakiem z billingu (opłata < 0, uznanie > 0)
  pobrano    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_allegro_billing_platnosc ON allegro_billing(platnosc);
CREATE INDEX IF NOT EXISTS idx_allegro_billing_zam ON allegro_billing(zamowienie);
CREATE INDEX IF NOT EXISTS idx_allegro_billing_czas ON allegro_billing(czas);`);

// --- czyste funkcje (test/pricing-billing-allegro.test.js) ------------------------------------------------------

// Wpis billingu → wiersz tabeli albo null (bez zamówienia, bez kwoty PLN).
function wpisBillingu(e, konto) {
  if (!e?.id || !e.order?.id || !e.occurredAt || !e.type?.id) return null;
  if (e.value?.currency && e.value.currency !== 'PLN') return null;
  const kwota = Number(e.value?.amount);
  if (!Number.isFinite(kwota) || kwota === 0) return null;
  return { id: String(e.id), konto, zamowienie: String(e.order.id), czas: e.occurredAt, typ: String(e.type.id), nazwa: e.type.name || null, kwota };
}

// Od kiedy pytać: ostatni widziany wpis minus zakładka; bez znacznika — NA_START_DNI wstecz.
function oknoOd(znacznik, teraz = Date.now()) {
  const t = Date.parse(znacznik || '');
  return new Date(Number.isFinite(t) ? t - ZAKLADKA_MS : teraz - NA_START_DNI * 86400e3).toISOString();
}

// --- pobieranie --------------------------------------------------------------------------------------------------

// Wpisy od `od`, po 100. API ogranicza offset + limit do 10 000 — przy takim oknie dzielimy je na pół (pierwszy
// przebieg: ~6 tys. wpisów z 14 dni na ekajtek, mieści się; zapas na sezon).
async function wpisyOd(konto, od, doCzasu = null) {
  const wynik = [];
  for (let offset = 0; ; offset += 100) {
    const r = await allegro.api(konto, '/billing/billing-entries',
      { query: { 'occurredAt.gte': od, 'occurredAt.lte': doCzasu, limit: 100, offset } });
    const paczka = r?.billingEntries || [];
    wynik.push(...paczka);
    if (paczka.length < 100) return wynik;
    if (offset >= 9_900) {
      const a = Date.parse(od), b = Date.parse(doCzasu || new Date().toISOString()), pol = new Date((a + b) / 2).toISOString();
      if (b - a < 3600e3) return wynik;      // godzina z 10 tys. wpisów — nie zdarza się; bierzemy, co jest
      return [...await wpisyOd(konto, od, pol), ...await wpisyOd(konto, pol, doCzasu)];
    }
  }
}

async function dlaKonta(konto) {
  const klucz = `billing_allegro_${konto}`;
  const od = oknoOd(stan.get(klucz)?.wartosc);
  const wiersze = (await wpisyOd(konto, od)).map((e) => wpisBillingu(e, konto)).filter(Boolean);
  const ins = db.prepare(`INSERT INTO allegro_billing (id, konto, zamowienie, czas, typ, nazwa, kwota) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET kwota = excluded.kwota, czas = excluded.czas, typ = excluded.typ, nazwa = excluded.nazwa`);
  db.exec('BEGIN');
  try { for (const w of wiersze) ins.run(w.id, w.konto, w.zamowienie, w.czas, w.typ, w.nazwa, w.kwota); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  // płatność znana z wcześniejszego wpisu tego samego zamówienia — bez pytania API
  db.prepare(`UPDATE allegro_billing SET platnosc = (SELECT b.platnosc FROM allegro_billing b WHERE b.zamowienie = allegro_billing.zamowienie
      AND b.platnosc IS NOT NULL LIMIT 1) WHERE platnosc IS NULL AND konto = ?`).run(konto);
  const najnowszy = wiersze.reduce((m, w) => (w.czas > m ? w.czas : m), stan.get(klucz)?.wartosc || '');
  if (najnowszy) stan.set(klucz, najnowszy);

  // zamówienie → płatność: jedno zapytanie na zamówienie, najnowsze najpierw (to one są na „Dniu” i w „Live”)
  const bez = db.prepare(`SELECT zamowienie FROM allegro_billing WHERE konto = ? AND platnosc IS NULL GROUP BY zamowienie
      ORDER BY MAX(czas) DESC LIMIT ?`).all(konto, MOSTOW_NA_PRZEBIEG).map((x) => x.zamowienie);
  const upd = db.prepare('UPDATE allegro_billing SET platnosc = ? WHERE zamowienie = ?');
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
async function pobierzBilling({ log = console.log, blad = console.error } = {}) {
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
        blad(new Date().toISOString(), `[pricing] billing Allegro ${konto}: brak uprawnień billing:read / orders:read w aplikacji „WMS Price” — `
          + `analiza bierze opłaty z Rozliczeń (raz na dobę). Dodaj uprawnienia i podepnij konto: node pricing/allegro-autoryzuj.js ${konto}`);
      } else blad(new Date().toISOString(), `[pricing] billing Allegro ${konto}:`, e.message);
    }
  }
  const s = Object.entries(wynik).filter(([, w]) => !w.blad && (w.wpisow || w.mostow));
  if (s.length) log(new Date().toISOString(), '[pricing] billing Allegro:', s.map(([k, w]) => `${k} ${w.wpisow} wpisów, ${w.mostow} zamówień${w.czeka ? ` (czeka ${w.czeka})` : ''}`).join('; '));
  return wynik;
}

module.exports = { wpisBillingu, oknoOd, pobierzBilling };

if (require.main === module) {
  pobierzBilling().then((w) => { console.log(JSON.stringify(w, null, 2)); process.exit(0); }, (e) => { console.error(e); process.exit(1); });
}
