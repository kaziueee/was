'use strict';

// Dopłaty Allegro do ceny dla modułu analiz sprzedaży: płatność (UUID w ZK) → kwota brutto PLN na całe zamówienie.
// Klient zapłacił mniej, Allegro dopłaciło różnicę do ceny oferty (billing PS1 / PSA / PSO — opis w
// pricing/doplaty-allegro.js). Faktura tego nie zna, więc dokładamy to do przychodu i zysku (config/rynki.js
// wycenaZamowienia, `doplata`).
//
// Dwa źródła, oba tylko do odczytu, łączone po numerze wpisu billingu (ten sam w obu — wpis liczy się raz):
//  - pricing.db `allegro_doplaty` — WMS-Pricing co 5 min, gdy aplikacja „WMS Price” ma uprawnienia billing/orders;
//  - rozliczenia.db `allegro_billing_wpis` + `allegro_order_payment` — Rozliczenia raz na dobę (03:00), cała historia
//    od 01.2025. Bez indeksu po typie wpisu: pełny przegląd ~436 tys. wpisów, ~120 ms na SRV (pomiar 2026-10-29) —
//    w wątku analiz, Zebr to nie dotyka.
// Brak pliku albo błąd = brak dopłat z tego źródła (best-effort, jak konto Allegro z Rozliczeń w analiza-dane).

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const TYPY = ['PS1', 'PSA', 'PSO'];
const PRICING_DB = () => process.env.PRICING_DB || path.join(__dirname, '..', 'db', 'pricing.db');
const ROZLICZENIA_DB = () => process.env.ROZLICZENIA_DB || 'C:\\Rozliczenia\\data\\rozliczenia.db';

function czytaj(plik, sql, par, opis) {
  if (!fs.existsSync(plik)) return [];
  let d = null;
  try {
    d = new DatabaseSync(plik, { readOnly: true });
    return d.prepare(sql).all(...par);
  } catch (e) {
    // brak tabeli (stary WMS-Pricing, inna wersja Rozliczeń) = brak źródła, nie błąd przebiegu
    if (!/no such table/.test(e.message)) console.warn(`[analiza] dopłaty Allegro (${opis}) niedostępne: ${e.message}`);
    return [];
  } finally { d?.close(); }
}

// Wpisy [{ id, platnosc, kwota }] → Map płatność → suma (każdy wpis raz). Czyste — test/analiza-doplaty.test.js.
function sumujWpisy(...zrodla) {
  const widziane = new Set(), m = new Map();
  for (const lista of zrodla) {
    for (const w of lista) {
      if (!w?.id || !w.platnosc || widziane.has(w.id)) continue;
      widziane.add(w.id);
      const k = String(w.platnosc).toLowerCase();
      m.set(k, Math.round(((m.get(k) || 0) + (Number(w.kwota) || 0)) * 100) / 100);
    }
  }
  return m;
}

// Dopłaty z wpisów od dnia `od` (YYYY-MM-DD). Wołający bierze `get(uuid)` dla swoich zamówień.
function doplatyOd(od) {
  const typy = TYPY.map(() => '?').join(',');
  const zywe = czytaj(PRICING_DB(), `SELECT id, platnosc, kwota FROM allegro_doplaty WHERE platnosc IS NOT NULL AND czas >= ?`, [od], 'WMS-Pricing');
  const noc = czytaj(ROZLICZENIA_DB(), `SELECT w.id, p.payment_id platnosc, w.kwota FROM allegro_billing_wpis w
    JOIN allegro_order_payment p ON p.order_id = w.order_id WHERE w.typ_id IN (${typy}) AND w.occurred_at >= ?`, [...TYPY, od], 'Rozliczenia');
  return sumujWpisy(zywe, noc);
}

module.exports = { TYPY, sumujWpisy, doplatyOd };
