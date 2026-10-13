'use strict';

// Adapter Amazon SP-API (region EU) dla repricera. Na razie TYLKO ODCZYT: uczestnictwo w rynkach,
// raport aktywnych ofert, Buy Box/oferty konkurencji. Zapis ceny (patchListingsItem) dojdzie
// osobnym krokiem — za zgodą usera, bo to zmiana widoczna dla klientów.
//
// Klucze w `.env` (prywatna aplikacja "WMS Pricing", self-authorized): SPAPI_CLIENT_ID,
// SPAPI_CLIENT_SECRET, SPAPI_REFRESH_TOKEN. Token LWA bez AWS SigV4.

require('dotenv').config();
const zlib = require('node:zlib');

const HOST = 'https://sellingpartnerapi-eu.amazon.com';

// Rynki, na których sprzedajemy (decyzja usera 2026-10-12). Kraj = klucz w config/rynki.js
// tam, gdzie kalkulator go zna (PL jeszcze nie).
const RYNKI_AMAZON = {
  DE: { id: 'A1PA6795UKMFR9', domena: 'Amazon.de', waluta: 'EUR' },
  FR: { id: 'A13V1IB3VIYZZH', domena: 'Amazon.fr', waluta: 'EUR' },
  IT: { id: 'APJ6JRA9NG5V4', domena: 'Amazon.it', waluta: 'EUR' },
  ES: { id: 'A1RKKUPIHCS9HS', domena: 'Amazon.es', waluta: 'EUR' },
  NL: { id: 'A1805IZSGTT6HS', domena: 'Amazon.nl', waluta: 'EUR' },
  PL: { id: 'A1C3SOZRARQ6R3', domena: 'Amazon.pl', waluta: 'PLN' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let token = null, tokenDo = 0;
async function dajToken() {
  if (token && Date.now() < tokenDo - 60_000) return token;
  const { SPAPI_CLIENT_ID, SPAPI_CLIENT_SECRET, SPAPI_REFRESH_TOKEN } = process.env;
  if (!SPAPI_CLIENT_ID || !SPAPI_CLIENT_SECRET || !SPAPI_REFRESH_TOKEN) {
    throw new Error('Brak kluczy SP-API w .env (SPAPI_CLIENT_ID / SPAPI_CLIENT_SECRET / SPAPI_REFRESH_TOKEN)');
  }
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: SPAPI_REFRESH_TOKEN,
      client_id: SPAPI_CLIENT_ID, client_secret: SPAPI_CLIENT_SECRET }),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error(`LWA: ${res.status} ${JSON.stringify(j).slice(0, 200)}`);
  token = j.access_token;
  tokenDo = Date.now() + (j.expires_in || 3600) * 1000;
  return token;
}

// Zapytanie z ponawianiem na 429 (limity SP-API są ciasne), 5xx i błędy sieci.
async function api(metoda, sciezka, body) {
  for (let proba = 0; ; proba++) {
    let res;
    try {
      res = await fetch(HOST + sciezka, {
        method: metoda,
        headers: { 'x-amz-access-token': await dajToken(), 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      // Błąd sieci / timeout (VPN, chwilowy brak łącza) — ponawiamy jak 429.
      if (proba < 6) { await sleep(2000 * 2 ** proba); continue; }
      throw new Error(`SP-API ${metoda} ${sciezka}: ${e.message}`);
    }
    if ((res.status === 429 || res.status >= 500) && proba < 6) { await sleep(2000 * 2 ** proba); continue; }
    const tekst = await res.text();
    const j = tekst ? JSON.parse(tekst) : {};
    if (!res.ok) throw new Error(`SP-API ${metoda} ${sciezka}: ${res.status} ${tekst.slice(0, 300)}`);
    return j;
  }
}

async function uczestnictwo() {
  const j = await api('GET', '/sellers/v1/marketplaceParticipations');
  return (j.payload || []).map((p) => ({ id: p.marketplace.id, kraj: p.marketplace.countryCode,
    nazwa: p.marketplace.name, aktywny: p.participation.isParticipating }));
}

// Raport → tekst. Raporty generują się od kilkudziesięciu sekund do kilku minut.
async function raport(reportType, marketplaceIds, opcje = {}) {
  const { reportId } = await api('POST', '/reports/2021-06-30/reports', { reportType, marketplaceIds, ...opcje });
  for (let i = 0; i < 90; i++) {
    await sleep(10_000);
    const s = await api('GET', `/reports/2021-06-30/reports/${reportId}`);
    if (s.processingStatus === 'DONE') {
      const d = await api('GET', `/reports/2021-06-30/documents/${s.reportDocumentId}`);
      const buf = Buffer.from(await (await fetch(d.url)).arrayBuffer());
      const dane = d.compressionAlgorithm === 'GZIP' ? zlib.gunzipSync(buf) : buf;
      return new TextDecoder(kodowanie(dane)).decode(dane);
    }
    if (s.processingStatus === 'CANCELLED') return '';            // brak danych w zakresie
    if (s.processingStatus === 'FATAL') throw new Error(`Raport ${reportType} ${reportId}: FATAL`);
  }
  throw new Error(`Raport ${reportType} ${reportId}: nie skończył się w 15 min`);
}

// Raporty płaskie Amazona w EU bywają w windows-1252 zamiast UTF-8 — sprawdzamy, czy bajty są poprawnym UTF-8.
function kodowanie(buf) {
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return 'utf-8'; } catch { return 'windows-1252'; }
}

function tsv(tekst) {
  const linie = tekst.split(/\r?\n/).filter(Boolean);
  if (!linie.length) return [];
  const naglowek = linie[0].split('\t');
  return linie.slice(1).map((l) => Object.fromEntries(l.split('\t').map((v, i) => [naglowek[i], v])));
}

// Aktywne oferty na jednym rynku: SKU, ASIN, cena, ilość, kanał wysyłki.
async function aktywneOferty(kraj) {
  const r = RYNKI_AMAZON[kraj];
  const wiersze = tsv(await raport('GET_MERCHANT_LISTINGS_DATA', [r.id]));
  return wiersze.map((w) => ({
    rynek: kraj,
    sku: w['seller-sku'],
    asin: w['asin1'] || w['product-id'] || null,
    nazwa: w['item-name'] || null,
    cena: Number(String(w['price'] || '').replace(',', '.')) || null,
    ilosc: Number(w['quantity'] || 0) || 0,
    kanal: w['fulfillment-channel'] || 'DEFAULT',      // DEFAULT = wysyłka sprzedawcy, AMAZON_EU = FBA
    status: w['status'] || null,
  })).filter((o) => o.sku);
}

// Linki do oferty na stronie Amazona. API nie zwraca adresu — składamy go z domeny rynku i ASIN-u
// (format /dp/<ASIN> jest stały). `?aod=1` otwiera od razu listę wszystkich ofert (kto ma Buy Box).
function linkiOferty(rynek, asin) {
  const r = RYNKI_AMAZON[rynek];
  if (!r || !asin) return null;
  const produkt = `https://www.${r.domena.toLowerCase()}/dp/${encodeURIComponent(asin)}`;
  return { produkt, oferty: `${produkt}?aod=1` };
}

module.exports = { RYNKI_AMAZON, dajToken, api, uczestnictwo, raport, aktywneOferty, tsv, linkiOferty };
