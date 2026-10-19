'use strict';

// Niezbędnik Sprzedawcy (api.niezbedniksprzedawcy.pl) — ceny konkurencji na Allegro per EAN. Allegro przez
// swoje API ich nie podaje (pricing/allegro.js: /offers/listing = 403 dla nowych aplikacji), a Niezbędnik ma
// starszą, zweryfikowaną aplikację z dostępem do wyszukiwarki. Konto OKITRADE, pakiet sprawdzeń: 1 EAN w raporcie
// = 1 sprawdzenie (~0,002 zł). Korzystamy WYŁĄCZNIE z raportów konkurencji — ich repricera (offer-updates,
// `repricer.listings:write`) nie używamy: ceny zmienia nasz worker, dwa automaty na jednej ofercie gryzłyby się.
//
//   POST /v1/repricer/competitor-reports {marketplace_id, eans[≤10000], filters} → 202 {id}; wymaga
//        nagłówka Idempotency-Key — ten sam przy ponowieniu, inaczej powtórka zapłaciłaby drugi raz
//   GET  /v1/repricer/competitor-reports/{id}?limit≤100&cursor= → status + items[].result.offers (≤60 na EAN)
//   GET  /v1/repricer/usage → stan pakietu (bez kosztu)
// Klucz: NIEZBEDNIK_API_KEY (na SRV w .env.dpapi). Szukanie idzie po EAN jako frazie, więc w wynikach bywają
// inne produkty — odsiewa je pricing/konkurencja-allegro.js.

require('../config/env');
const crypto = require('crypto');

const BAZA = 'https://api.niezbedniksprzedawcy.pl';
const KONCOWE = new Set(['completed', 'partially_failed', 'failed']);
const skonfigurowany = () => !!process.env.NIEZBEDNIK_API_KEY;
const czekaj = (ms) => new Promise((r) => setTimeout(r, ms));

async function zapytanie(metoda, sciezka, body = null, { proby = 3, timeoutMs = 60_000 } = {}) {
  const idem = body ? crypto.randomUUID() : null;   // jeden na zlecenie — ponowienie to ta sama operacja
  for (let i = 1; ; i++) {
    let r;
    try {
      r = await fetch(BAZA + sciezka, {
        method: metoda,
        headers: { Authorization: `Bearer ${process.env.NIEZBEDNIK_API_KEY}`, Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': idem } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (i < proby) { await czekaj(2000 * i); continue; }
      throw new Error(`Niezbędnik: brak połączenia (${e.message})`);
    }
    const tekst = await r.text();
    let j = null;
    try { j = JSON.parse(tekst); } catch { /* treść nie-JSON — opis błędu z tekstu */ }
    if ((r.status === 429 || r.status >= 500) && i < proby) {
      const ra = r.headers.get('retry-after');
      await czekaj(Math.min(30, ra != null && ra !== '' && Number.isFinite(Number(ra)) ? Number(ra) : 2 ** i) * 1000);
      continue;
    }
    if (!r.ok) {
      const e = new Error(`Niezbędnik ${r.status}: ${j?.error?.message || tekst.slice(0, 200)}`);
      Object.assign(e, { status: r.status, kod: j?.error?.code || null, szczegoly: j?.error?.details || null });
      throw e;
    }
    return j;
  }
}

// Zlecenie raportu — zwraca { id, status, cost }. Brak sprawdzeń w pakiecie = 402 competitor_checks_required.
const zlecRaport = (eans, filtry = {}, rynek = 'allegro-pl') =>
  zapytanie('POST', '/v1/repricer/competitor-reports', { marketplace_id: rynek, eans, filters: filtry });

// Stan raportu; po zakończeniu wszystkie pozycje (strony po 100). `gotowy` = status końcowy.
async function raport(id) {
  const sciezka = `/v1/repricer/competitor-reports/${encodeURIComponent(id)}?limit=100`;
  const r = await zapytanie('GET', sciezka);
  if (!KONCOWE.has(r.status)) return { ...r, items: [], gotowy: false };
  const items = [...(r.items || [])];
  let cur = r.pagination?.has_more ? r.pagination.next_cursor : null;
  while (cur) {
    const n = await zapytanie('GET', `${sciezka}&cursor=${encodeURIComponent(cur)}`);
    items.push(...(n.items || []));
    cur = n.pagination?.has_more ? n.pagination.next_cursor : null;
  }
  return { ...r, items, gotowy: true };
}

// Stan pakietu: { active, total, used, remaining, valid_from, valid_until }.
const pakiet = async () => (await zapytanie('GET', '/v1/repricer/usage')).competitor_checks;

module.exports = { skonfigurowany, zapytanie, zlecRaport, raport, pakiet, KONCOWE };
