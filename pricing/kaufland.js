'use strict';

// Adapter Kaufland Global Marketplace (Seller API v2): nasze oferty (units), ranking Buy Boxa na
// produkcie i zmiana ceny. Na start TYLKO ODCZYT (pricing/kolumny.js `tylkoOdczyt`).
//
// Dokumentacja: https://sellerapi.kaufland.com/?page=rest-api, specyfikacja: /swagger.json (2026-10-16).
//   - Każde zapytanie podpisane: HMAC-SHA256 (hex) z `METODA\nURI\nBODY\nTIMESTAMP`, kluczem jest Secret
//     Key traktowany jako zwykły napis (NIE hex). URI pełne, z https:// i query. Timestamp w sekundach,
//     ±5 min od zegara Kauflandu. Klucze: KAUFLAND_CLIENT_KEY / KAUFLAND_SECRET_KEY w .env
//     (panel sprzedawcy → Einstellungen → API).
//   - Limit: 111 zapytań/s na sprzedawcę, wszystkie endpointy razem; ponad limit = 429.
//   - Ceny w CENTACH waluty storefrontu (EUR: de, at, sk, fr, it, es, nl; CZK: cz; PLN: pl) —
//     `listing_price`, `price`, `shipping_rate`, także w GET /buybox.
//
// Pola unit (GET /units), z których korzystamy:
//   id_unit        — id oferty w Kauflandzie (do PATCH), id_offer — NASZ identyfikator oferty (SKU)
//   id_product     — produkt Kauflandu (strona produktu, Buy Box); trzymamy go w `oferty.asin`
//   listing_price  — cena, którą ustawiamy; price — cena, za którą oferta faktycznie stoi (różni się,
//                    gdy cenę przestawia Smart Pricing Kauflandu, sterowany `minimum_price`)
//   shipping_rate  — wysyłka płacona przez klienta (z grupy wysyłkowej), amount — stan,
//   status         — AVAILABLE / ONHOLD / INCOMPLETE, is_live — czy oferta faktycznie widnieje w sklepie
//
// Pomiar na koncie OkiToys 2026-10-16: storefronty DE, CZ, SK — sprzedaje tylko DE (1078 ofert, 909
// widocznych); CZ i SK po 19 ofert, prawie wszystkie ONHOLD. id_offer = symbol GT (1077/1078 wprost).
// Wysyłka na każdej ofercie 4,99 € (grupa „Kurier DHL”, za zamówienie). Prowizja z
// POST /info/commission-rates/lookup: 13% + 0 stałej na 50/50 sprawdzonych EAN-ach (zabawki).
//
// GET /buybox?id_product&storefront&condition=new — do 10 najlepszych ofert produktu z ceną TOWARU
// (`price`, bez wysyłki) i wysyłką osobno; nasza oferta to wpis z `id_unit`/`id_offer` (te pola
// Kaufland pokazuje tylko właścicielowi). Ranga liczy się od ceny z wysyłką, vouchera i czasu dostawy.

const crypto = require('crypto');
require('../config/env');

const URL_API = 'https://sellerapi.kaufland.com/v2';
// Rynek w pricing.db = kod storefrontu wielkimi literami (jak eMAG: RO/HU/BG). Domena tylko do linku —
// dla es/nl nie wiemy, czy sklep już działa, więc bez linku zamiast zgadywać adres.
const STOREFRONTY = {
  DE: { sf: 'de', waluta: 'EUR', domena: 'kaufland.de' },
  AT: { sf: 'at', waluta: 'EUR', domena: 'kaufland.at' },
  SK: { sf: 'sk', waluta: 'EUR', domena: 'kaufland.sk' },
  CZ: { sf: 'cz', waluta: 'CZK', domena: 'kaufland.cz' },
  PL: { sf: 'pl', waluta: 'PLN', domena: 'kaufland.pl' },
  FR: { sf: 'fr', waluta: 'EUR', domena: 'kaufland.fr' },
  IT: { sf: 'it', waluta: 'EUR', domena: 'kaufland.it' },
  ES: { sf: 'es', waluta: 'EUR' },
  NL: { sf: 'nl', waluta: 'EUR' },
};
const sf = (rynek) => {
  const s = STOREFRONTY[String(rynek || '').toUpperCase()];
  if (!s) throw new Error(`Kaufland: nieznany storefront ${rynek}`);
  return s.sf;
};
const rynekUnitu = (u) => String(u?._rynek || u?.storefront || 'DE').toUpperCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const zaokr = (x) => Math.round(x * 100) / 100;
const zCentow = (c) => (c == null || !Number.isFinite(Number(c)) ? null : zaokr(Number(c) / 100));

const skonfigurowany = () => !!(process.env.KAUFLAND_CLIENT_KEY && process.env.KAUFLAND_SECRET_KEY);

// Podpis zapytania — czysta funkcja (wektor testowy z dokumentacji w test/pricing-kaufland.test.js).
function podpis(metoda, uri, body, timestamp, secret) {
  return crypto.createHmac('sha256', String(secret))
    .update([String(metoda).toUpperCase(), uri, body || '', String(timestamp)].join('\n'))
    .digest('hex');
}

// Query w kolejności podania; tablice jako lista po przecinku (tak opisuje `embedded` dokumentacja).
// Podpisujemy dokładnie ten napis, który idzie w URL — inaczej Kaufland odpowie „corrupted signature”.
function adres(sciezka, query = {}) {
  const qs = Object.entries(query)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(Array.isArray(v) ? v.join(',') : v)}`)
    .join('&');
  return `${URL_API}${sciezka}${qs ? `?${qs}` : ''}`;
}

function naglowki(metoda, uri, body, timestamp = Math.floor(Date.now() / 1000)) {
  const h = {
    Accept: 'application/json',
    'Shop-Client-Key': process.env.KAUFLAND_CLIENT_KEY,
    'Shop-Timestamp': String(timestamp),
    'Shop-Signature': podpis(metoda, uri, body, timestamp, process.env.KAUFLAND_SECRET_KEY),
    'User-Agent': 'Inhouse_development',
  };
  if (body) h['Content-Type'] = 'application/json';
  return h;
}

// Błąd z odpowiedzi „problem+json” Kauflandu: { type, message, errors: [{ field, message }] }.
function opisBledu(status, j) {
  const pola = (j?.errors || []).map((e) => `${e.field}: ${e.message}`).join('; ');
  return `HTTP ${status}${j?.type ? ` ${j.type}` : ''}${j?.message ? ` — ${j.message}` : ''}${pola ? ` (${pola})` : ''}`;
}

async function api(metoda, sciezka, { query, body, proby = 4, timeoutMs = 30_000 } = {}) {
  if (!skonfigurowany()) throw new Error('Kaufland: brak KAUFLAND_CLIENT_KEY / KAUFLAND_SECRET_KEY w .env');
  const uri = adres(sciezka, query);
  const tresc = body == null ? '' : JSON.stringify(body);
  for (let i = 1; ; i++) {
    let r, tekst;
    try {
      // Podpis i timestamp liczone przy KAŻDEJ próbie — ponowienie po minutach miałoby przeterminowany.
      // Limit czasu obejmuje też czytanie odpowiedzi (lekcja eMAG 16.10: zawieszony fetch trzymał
      // workera z blokadą „trwa” do restartu).
      r = await fetch(uri, { method: metoda, headers: naglowki(metoda, uri, tresc), body: tresc || undefined,
        signal: AbortSignal.timeout(timeoutMs) });
      tekst = await r.text();
    } catch (e) {
      if (i >= proby) throw new Error(`Kaufland ${metoda} ${sciezka}: ${e.message}`);
      await sleep(1500 * i);
      continue;
    }
    let j = null;
    try { j = tekst ? JSON.parse(tekst) : null; } catch { j = null; }
    if (r.status === 429 || r.status >= 500) {
      if (i >= proby) throw Object.assign(new Error(`Kaufland ${metoda} ${sciezka}: ${opisBledu(r.status, j)}`), { status: r.status });
      await sleep((r.status === 429 ? 2000 : 1500) * i);
      continue;
    }
    if (r.status === 401 || r.status === 403) {
      throw Object.assign(new Error(`Kaufland ${metoda} ${sciezka}: ${opisBledu(r.status, j)} — sprawdź KAUFLAND_CLIENT_KEY / KAUFLAND_SECRET_KEY i zegar maszyny`), { status: r.status });
    }
    if (!r.ok) throw Object.assign(new Error(`Kaufland ${metoda} ${sciezka}: ${opisBledu(r.status, j)}`), { status: r.status, typ: j?.type });
    return j;
  }
}

// Storefronty, które sprzedawca ma założone w panelu (niezależnie od ich statusu).
async function storefronty() {
  const j = await api('GET', '/info/storefront');
  return (j?.data || []).map((x) => (typeof x === 'string' ? x : x.storefront || x.code || x)).map((x) => String(x).toUpperCase());
}

// Wszystkie nasze oferty na storefroncie (strony po 100, z danymi produktu: tytuł, EAN-y, URL).
async function wszystkieUnits(rynek = 'DE') {
  const wynik = [];
  for (let offset = 0; ; offset += 100) {
    const j = await api('GET', '/units', { query: { storefront: sf(rynek), limit: 100, offset, embedded: ['products'] } });
    const paczka = j?.data || [];
    wynik.push(...paczka.map((u) => ({ ...u, _rynek: String(rynek).toUpperCase() })));
    const razem = Number(j?.pagination?.total);
    if (paczka.length < 100 || (razem > 0 && offset + 100 >= razem)) return wynik;
    await sleep(50);
  }
}

// Oferta po naszym SKU (id_offer) — do potwierdzenia po zapisie i do CLI. Filtr po id_offer jest po
// stronie Kauflandu; porównanie poniżej pilnuje, żeby nie wziąć cudzego dopasowania.
async function unitPoSku(sku, rynek = 'DE') {
  const k = String(sku).trim().toUpperCase();
  const j = await api('GET', '/units', { query: { storefront: sf(rynek), id_offer: sku, limit: 100, embedded: ['products'] } });
  return (j?.data || []).filter((u) => String(u.id_offer || '').trim().toUpperCase() === k)
    .map((u) => ({ ...u, _rynek: String(rynek).toUpperCase() }));
}

// Smart Pricing Kauflandu sam przestawia cenę między `minimum_price` a `listing_price` — przy nim nasz
// repricer i automat Kauflandu ciągnęłyby cenę w dwie strony, jak Automate Pricing na Amazonie.
// Pomiar 2026-10-16 (DE, 1078 ofert): `minimum_price` jest ustawione na KAŻDEJ ofercie, ale na 1060
// równe `listing_price` — Smart Pricing nie ma wtedy pola manewru (wyłączony). Działa na 18 ofertach,
// gdzie minimum < cena (np. JAK21940: 15,99 i minimum 14,00, sprzedaje się za 14,00).
const smartPricing = (u) => Number(u?.minimum_price) > 0 && Number(u.minimum_price) < Number(u.listing_price);

// Surowy unit z API → wiersz `oferty` (ceny w walucie storefrontu, z VAT — tak jak na stronie).
function doOferty(u) {
  const eany = (u.product?.eans || []).map(String);
  return {
    sku: String(u.id_offer || '').trim(),
    idUnit: u.id_unit,
    idProduktu: u.id_product ?? u.product?.id_product ?? null,
    nazwa: u.product?.title || null,
    ean: eany.find((e) => e.length === 13) || eany[0] || null,
    cena: zCentow(u.price ?? u.listing_price),
    cenaListy: zCentow(u.listing_price),
    wysylka: zCentow(u.shipping_rate) ?? 0,
    ilosc: Number(u.amount) || 0,
    aktywna: u.status === 'AVAILABLE',
    live: u.is_live !== false,
    smart: smartPricing(u),
  };
}

// Ranking Buy Boxa (data z GET /buybox) + nasz unit → obserwacja w kształcie pricing/model.js.
// Ceny konkurencji porównujemy Z WYSYŁKĄ (landed) — tak Kaufland liczy rangę i tak robi model.
function zBuyboxa(bb, u) {
  const oferty = (bb?.units || []).filter((x) => x && x.price != null);
  const naszaOferta = (x) => x.id_unit != null || x.id_offer != null;     // pola widoczne tylko właścicielowi
  const ta = (x) => Number(x.id_unit) === Number(u.id_unit);
  const landed = (x) => zaokr((Number(x.price) + (Number(x.shipping_rate) || 0)) / 100);
  const moja = oferty.find(ta);
  const rangi = oferty.map((x) => Number(x.buybox_rank)).filter((x) => x > 0);
  const zw = oferty.find((x) => Number(x.buybox_rank) === (rangi.length ? Math.min(...rangi) : 1)) || null;
  const inne = oferty.filter((x) => !naszaOferta(x)).map(landed);
  const bbNasz = zw ? ta(zw) : null;
  return {
    cena: moja ? zCentow(moja.price) : zCentow(u.price ?? u.listing_price),
    wysylka: (moja ? zCentow(moja.shipping_rate) : zCentow(u.shipping_rate)) ?? 0,
    bbNasz,
    // Buy Box ma nasza INNA oferta tego produktu (drugi unit, np. SKU z dopiskiem) — z sobą nie walczymy.
    bbInnaNasza: !!(zw && !bbNasz && naszaOferta(zw)),
    bbCena: zw ? landed(zw) : null,
    bbFba: zw ? zw.fulfillment_type === 'fulfilled_by_kaufland' : null,
    najtanszaInna: inne.length ? Math.min(...inne) : null,
    ofert: bb?.num_units != null ? Number(bb.num_units) : oferty.length || null,
  };
}

async function buybox(idProduktu, rynek = 'DE') {
  const j = await api('GET', '/buybox', { query: { id_product: idProduktu, storefront: sf(rynek), condition: 'new', limit: 10 } });
  return j?.data || null;
}

// Rankingi dla wielu produktów naraz: kilka zapytań równolegle (daleko pod limitem 111/s).
// Wynik: Map(`RYNEK|id_product` → data); błąd pojedynczego produktu = brak wpisu (bez obserwacji).
const kluczProduktu = (rynek, idProduktu) => `${String(rynek).toUpperCase()}|${idProduktu}`;
async function buyboxyHurtem(pary, { rownolegle = 6 } = {}) {
  const unikalne = [...new Map(pary.filter((p) => p.idProduktu).map((p) => [kluczProduktu(p.rynek, p.idProduktu), p])).values()];
  const wynik = new Map();
  let bledy = 0, ostatniBlad = null, i = 0;
  const pracownik = async () => {
    while (i < unikalne.length) {
      const p = unikalne[i++];
      try { wynik.set(kluczProduktu(p.rynek, p.idProduktu), await buybox(p.idProduktu, p.rynek)); } catch (e) {
        bledy++; ostatniBlad = e.message;
        if (e.status === 401 || e.status === 403) throw e;      // klucze — nie ma sensu męczyć reszty
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(rownolegle, unikalne.length) }, pracownik));
  if (bledy) Object.assign(wynik, { bledy, ostatniBlad });
  return wynik;
}

// Powody, dla których oferta nie jest widoczna (POST /units/status, najwyżej 20 id na zapytanie;
// dokumentacja: do sprawdzania na żądanie, nie do masowego odpytywania — wołamy tylko dla ofert
// ze stanem, które nie są live). Map(id_unit → [{ reason, reason_description }]).
async function powodyNieLive(idsUnit, rynek = 'DE') {
  const wynik = new Map();
  for (let i = 0; i < idsUnit.length; i += 20) {
    const j = await api('POST', '/units/status', { query: { storefront: sf(rynek) }, body: { unit_ids: idsUnit.slice(i, i + 20) } });
    for (const x of j?.data || []) if (x.status_code === 200 && x.is_live === false) wynik.set(x.id_unit, x.reasons || []);
    await sleep(200);
  }
  return wynik;
}

// Blokada ceny jak „Invalid price” na eMAG: Kaufland zdjął ofertę, bo cena wymaga sprawdzenia.
// Inne powody (dane produktu, GPSR, EPR) nie dotyczą ceny — nie pokazujemy ich jako blokady ceny.
function blokadaCeny(powody) {
  const p = (powody || []).find((x) => x.reason === 'price_check_needed');
  return p ? `${p.reason}: ${p.reason_description || 'cena do sprawdzenia'}` : null;
}

// Zmiana ceny = PATCH /units/{id_unit}?storefront=… z `listing_price` w centach (pozostałe pola zostają,
// bo PATCH zmienia tylko podane). Gdy oferta ma `minimum_price` równe cenie (Smart Pricing wyłączony —
// tak jest prawie wszędzie), przesuwamy je razem z ceną: obniżka pod stare minimum zostawiłaby ofertę
// niespójną, a podwyżka bez niego włączyłaby Smart Pricing (pole manewru od starej ceny do nowej).
// Na ofercie z działającym Smart Pricing nie zapisujemy wcale — dwa automaty na jednej cenie.
// Czysta funkcja: unit + cena → zapytanie albo { blad }.
function zmianaCeny(u, cena) {
  if (!u?.id_unit) return { blad: 'brak id_unit oferty Kaufland' };
  const c = zaokr(Number(cena));
  if (!(c > 0)) return { blad: `niepoprawna cena: ${cena}` };
  if (smartPricing(u)) {
    return { blad: `w Kauflandzie działa Smart Pricing (cena ${zCentow(u.listing_price)}, minimum ${zCentow(u.minimum_price)}) — wyłącz go w panelu Kaufland (minimum = cena), inaczej dwa automaty ciągną cenę` };
  }
  const centy = Math.round(c * 100);
  const body = Number(u.minimum_price) > 0 ? { listing_price: centy, minimum_price: centy } : { listing_price: centy };
  return { sciezka: `/units/${encodeURIComponent(u.id_unit)}`, query: { storefront: sf(rynekUnitu(u)) }, body, cena: c };
}

// Wyłączenie Smart Pricing na ofercie: cena i minimum = cena, za którą oferta stoi TERAZ (`price`, zwykle
// równa staremu minimum) — klient nie widzi zmiany, a cenę od tej chwili ustawia już tylko repricer.
// Podniesienie do starego `listing_price` byłoby podwyżką, o której decyduje człowiek, nie wyłączenie automatu.
function wylaczenieSmartPricing(u) {
  if (!u?.id_unit) return { blad: 'brak id_unit oferty Kaufland' };
  if (!smartPricing(u)) return { blad: 'Smart Pricing nie działa na tej ofercie (minimum = cena)' };
  const centy = Number(u.price) > 0 ? Number(u.price) : Number(u.listing_price);
  return { sciezka: `/units/${encodeURIComponent(u.id_unit)}`, query: { storefront: sf(rynekUnitu(u)) },
    body: { listing_price: centy, minimum_price: centy }, cena: zCentow(centy) };
}

// Wysłanie zmiany ceny. Zwraca { ok, cena, blad } — odmowa Kauflandu to wynik, nie wyjątek.
async function ustawCene(u, cena, z = zmianaCeny(u, cena)) {
  if (z.blad) return { ok: false, blad: z.blad };
  try {
    const j = await api('PATCH', z.sciezka, { query: z.query, body: z.body });
    const po = j?.data || j;
    return { ok: true, cena: z.cena, listing: zCentow(po?.listing_price), minimum: zCentow(po?.minimum_price) };
  } catch (e) {
    return { ok: false, blad: e.message };
  }
}

// Strona produktu (id_product trzymamy w `oferty.asin`).
const linkiOferty = (idProduktu, rynek = 'DE') => {
  const d = STOREFRONTY[String(rynek).toUpperCase()]?.domena;
  return idProduktu && d ? { produkt: `https://www.${d}/product/${encodeURIComponent(idProduktu)}/` } : null;
};

module.exports = {
  api, podpis, adres, naglowki, storefronty, wszystkieUnits, unitPoSku, doOferty, zBuyboxa, buybox, buyboxyHurtem,
  kluczProduktu, powodyNieLive, blokadaCeny, zmianaCeny, wylaczenieSmartPricing, ustawCene, linkiOferty, skonfigurowany, smartPricing, STOREFRONTY,
};
