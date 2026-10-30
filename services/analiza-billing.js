'use strict';

// Billing Allegro dla modułu analiz sprzedaży: płatność (UUID w ZK) → opłaty i dopłaty zamówienia z billingu.
// Zysk Allegro liczymy hybrydowo (decyzja usera 2026-10-30): składnik, który Allegro już naliczyło, z billingu, reszta
// z kalkulatora (config/rynki.js wycenaZamowienia, `oplaty` i `doplata`). Opis źródeł: pricing/billing-allegro.js.
//
// Dwa źródła, oba tylko do odczytu, łączone po numerze wpisu billingu (ten sam w obu — wpis liczy się raz):
//  - pricing.db `allegro_billing` — WMS-Pricing co 5 min, gdy aplikacja „WMS Price” ma uprawnienia billing/orders;
//  - rozliczenia.db `allegro_billing_wpis` + `allegro_order_payment` — Rozliczenia raz na dobę (03:00), historia od
//    01.2025. Bez indeksu po dacie: ~270 ms na okno 45 dni na SRV (pomiar 2026-10-30) — w wątku analiz, Zebr nie dotyka.
// Brak pliku albo błąd = brak źródła (best-effort, jak konto Allegro z Rozliczeń w analiza-dane).
//
// Składniki (typy z billingu Rozliczeń 2025-01 – 2026-10; wpisy bez zamówienia — Ads, abonament, „Pobranie opłat
// z wpływów”, akcje promocyjne — nie trafiają tu wcale, bo nie mają order_id):
//   doplata  — PS1 „Rabat transakcyjny w programie Allegro Ceny”, PSA / PSO „Rabat AlleObniżka”: PRZYCHÓD poza fakturą
//   prowizja — SUC „Prowizja od sprzedaży”, FSF „…oferty wyróżnionej” (dodatnie = zwrot prowizji po zwrocie towaru)
//   dostawa  — „Opłata (dodatkowa) za dostawę …” — po NAZWIE, bo każdy przewoźnik ma własne id (HB4, DPB, DXP, ORB…)
//   inne     — reszta z zamówieniem: REF „Zwrot kosztów”, APF Allegro Pay, POK Ochrona Kupujących, CB2 bonus…

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DOPLATA = new Set(['PS1', 'PSA', 'PSO']);
const PROWIZJA = new Set(['SUC', 'FSF']);
// Opłata za dostawę przychodzi 1–3 dni po zamówieniu (99,9% do 7 dni), a ~9% zamówień nie dostaje jej wcale (pomiar
// 2026-10-30, 8183 zamówienia IX–X 2026: 757 bez dostawy). Po tym czasie brak wpisu znaczy „0”, nie „jeszcze nie ma”.
const DOSTAWA_ZAMKNIETA_DNI = 7;

const PRICING_DB = () => process.env.PRICING_DB || path.join(__dirname, '..', 'db', 'pricing.db');
const ROZLICZENIA_DB = () => process.env.ROZLICZENIA_DB || 'C:\\Rozliczenia\\data\\rozliczenia.db';

function skladnik(typ, nazwa) {
  if (DOPLATA.has(typ)) return 'doplata';
  if (PROWIZJA.has(typ)) return 'prowizja';
  if (/dostaw/i.test(nazwa || '')) return 'dostawa';
  return 'inne';
}

// Wpisy [{ id, platnosc, typ, nazwa, kwota }] → Map płatność → { doplata, prowizja, dostawa, inne } (sumy ze znakiem
// billingu; null = brak wpisu tego składnika). Każdy wpis raz. Czyste — test/analiza-billing.test.js.
function sumujWpisy(...zrodla) {
  const widziane = new Set(), m = new Map();
  for (const lista of zrodla) {
    for (const w of lista) {
      if (!w?.id || !w.platnosc || widziane.has(w.id)) continue;
      widziane.add(w.id);
      const k = String(w.platnosc).toLowerCase();
      const s = m.get(k) || m.set(k, { doplata: null, prowizja: null, dostawa: null, inne: null }).get(k);
      const c = skladnik(w.typ, w.nazwa);
      s[c] = Math.round(((s[c] || 0) + (Number(w.kwota) || 0)) * 100) / 100;
    }
  }
  return m;
}

// Billing zamówienia → wejście kalkulatora: KOSZTY brutto PLN (dodatnie = koszt) dla składników, które już są,
// null = szacuje kalkulator. dni — ile dni minęło od zamówienia (do zamknięcia składnika „dostawa”).
function oplatyZamowienia(b, dni) {
  if (!b) return { doplata: 0, oplaty: null };
  const koszt = (x) => (x == null ? null : Math.round(-x * 100) / 100);
  const jest = b.prowizja != null || b.dostawa != null || b.inne != null;
  return {
    doplata: Math.max(0, b.doplata || 0),
    oplaty: jest ? {
      prowizja: koszt(b.prowizja),
      dostawa: b.dostawa != null ? koszt(b.dostawa) : dni >= DOSTAWA_ZAMKNIETA_DNI ? 0 : null,
      inne: koszt(b.inne) || 0,
    } : null,
  };
}

function czytaj(plik, sql, par, opis) {
  if (!fs.existsSync(plik)) return [];
  let d = null;
  try {
    d = new DatabaseSync(plik, { readOnly: true });
    return d.prepare(sql).all(...par);
  } catch (e) {
    // brak tabeli (stary WMS-Pricing, inna wersja Rozliczeń) = brak źródła, nie błąd przebiegu
    if (!/no such table/.test(e.message)) console.warn(`[analiza] billing Allegro (${opis}) niedostępny: ${e.message}`);
    return [];
  } finally { d?.close(); }
}

// Billing z wpisów od dnia `od` (YYYY-MM-DD). Wołający bierze `get(uuid)` dla swoich zamówień.
function billingOd(od) {
  const zywe = czytaj(PRICING_DB(), `SELECT id, platnosc, typ, nazwa, kwota FROM allegro_billing WHERE platnosc IS NOT NULL AND czas >= ?`,
    [od], 'WMS-Pricing');
  const noc = czytaj(ROZLICZENIA_DB(), `SELECT w.id, p.payment_id platnosc, w.typ_id typ, w.typ nazwa, w.kwota FROM allegro_billing_wpis w
    JOIN allegro_order_payment p ON p.order_id = w.order_id WHERE w.occurred_at >= ?`, [od], 'Rozliczenia');
  return sumujWpisy(zywe, noc);
}

module.exports = { DOSTAWA_ZAMKNIETA_DNI, skladnik, sumujWpisy, oplatyZamowienia, billingOd };
