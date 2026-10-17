'use strict';

// Adapter Empik Marketplace (EmpikPlace = platforma Mirakl, rynek PL): nasze oferty, ceny konkurencji na
// produkcie („Buy Box”) i zmiana ceny. Od 2026-10-16 TYLKO ODCZYT (pricing/kolumny.js `tylkoOdczyt`) —
// automat dopiero po ręcznym teście zapisu i decyzji usera.
//
// API: https://marketplace.empik.com/api/… (Mirakl; `GET /api/version` → 3.1316, sprawdzone 2026-10-16;
// `GET /api/offers` bez klucza → 401). Środowisko testowe: stg1.marketplace.empik.com (EMPIK_API_URL).
// Klucz sklepu (EMPIK_API_KEY w .env) generuje się w panelu sprzedawcy: menu użytkownika → „Klucz API”;
// idzie w nagłówku `Authorization: <klucz>` (bez „Bearer”; klucz w adresie Empik wyłączył 10.10.2023).
// Limit wywołań jest godzinowy — przekroczenie = 429 z Retry-After (sekundy).
//
// Używane wywołania Mirakl (dokumentacja developer.mirakl.com, seller API):
//   A01   GET  /api/account                         nasz shop_id i nazwa sklepu — najwyżej RAZ NA DOBĘ
//   OF52  POST /api/offers/export/async  → OF53 status → OF54 pliki   CAŁA lista naszych ofert (JSON) jednym
//              zleceniem: 6549 ofert w 16 s i 3 zapytaniach (2026-10-16). Pełny eksport najwyżej RAZ NA DOBĘ.
//   OF21  GET  /api/offers?max=100&offset=…         pojedyncze oferty (filtr `sku`). NIE do całej listy: Empik dławi
//              OF21 — 429 z Retry-After ~33 s; 66 stron szło 11–18 min i zatrzymało przebieg Amazona i eMAG (2026-10-16)
//   P11   GET  /api/products/offers?product_ids=…   aktywne oferty WSZYSTKICH sklepów na produkcie, do 100
//              produktów w zapytaniu, najwyżej 5 zapytań na minutę. Domyślne sortowanie „bestPrice”: cena
//              łączna (towar + najtańsza dostawa), potem premium i ocena sklepu.
//   PRI01 POST /api/offers/pricing/imports           plik CSV `"offer-sku";"price"` — najwyżej RAZ NA MINUTĘ,
//              więc wszystkie zmiany z przebiegu idą jednym plikiem. Zmienia WYŁĄCZNIE ceny (stan, opis,
//              czas wysyłki zostają), ale w trybie „usuń i zastąp”: cena, której nie wyślemy, znika — także
//              promocja (discount-price). Oferty z promocją albo kilkoma cenami nie ruszamy (zmianaCeny).
//   PRI02 GET  /api/offers/pricing/imports?import_id=…   status importu: WAITING / RUNNING / COMPLETE / FAILED
//   PRI03 GET  /api/offers/pricing/imports/{id}/error_report   CSV z odrzuconymi liniami
//   NIE OF24 (POST /api/offers): „Offer fields that are not sent are reset to their default value” —
//   wysłanie samej ceny wyzerowałoby stan i resztę oferty, którą prowadzi Sellasist.
//
// Kwoty w API Empik są BRUTTO (tryb TAX_INCLUDED), w PLN — bez przeliczania VAT jak na eMAG.
//
// DO SPRAWDZENIA na żywym API, zanim kanał zacznie decydować (dokumentacja tego nie rozstrzyga):
//   - czy oferta na górze P11 to ta, którą empik.com pokazuje na karcie produktu (nasz „Buy Box”),
//   - czy P11 podaje offer_id / shop_id cudzych i naszych ofert (dokumentacja: „value is always 0 / null”;
//     dlatego naszą ofertę rozpoznajemy po offer_id, shop_id ALBO nazwie sklepu — co działa),
//   - parametry stronicowania OF21 (max/offset — przy innych nazwach pętla i tak idzie po total_count),
//   - format product_sku (sam numer czy z „p”) — link do karty produktu,
//   - po ilu minutach cena z PRI01 jest widoczna w P11 i na stronie.

const URL_API = () => String(process.env.EMPIK_API_URL || 'https://marketplace.empik.com').replace(/\/+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const zaokr = (x) => Math.round(x * 100) / 100;
const liczba = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

const skonfigurowany = () => !!process.env.EMPIK_API_KEY;

// 429 / 5xx: ile czekać przed ponowieniem. Retry-After w sekundach; dłużej niż `maxMs` nie czekamy —
// limit jest godzinowy, a godzinne czekanie w środku przebiegu zatrzymałoby cały worker (także Amazona).
// null = nie ponawiamy, błąd idzie wyżej i następny przebieg spróbuje znowu.
function czekajMs(retryAfter, proba, maxMs = 120_000) {
  const s = liczba(retryAfter);
  const ms = s != null && s >= 0 ? s * 1000 : 3000 * proba;
  return ms <= maxMs ? ms : null;
}

// `url` = pełny adres zamiast /api/<sciezka> (pliki eksportu OF54 — adresy podaje OF53).
async function api(sciezka, { metoda = 'GET', query = null, body = undefined, proby = 3, timeoutMs = 60_000, naglowki = {}, url = null } = {}) {
  if (!skonfigurowany()) throw new Error('Empik: brak EMPIK_API_KEY w .env');
  const qs = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '')).toString() : '';
  for (let i = 1; ; i++) {
    let r, tekst;
    try {
      // Limit czasu obejmuje też czytanie odpowiedzi (lekcja z eMAG 2026-10-16: zawieszona strona listy
      // trzymała workera w nieskończoność, a blokada „trwa” zatrzymałaby wszystkie przebiegi do restartu).
      r = await fetch(url || `${URL_API()}/api/${sciezka}${qs}`, {
        method: metoda, headers: { Authorization: process.env.EMPIK_API_KEY, Accept: 'application/json', ...naglowki }, body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      tekst = await r.text();
    } catch (e) {
      if (i >= proby) throw new Error(`Empik ${sciezka}: ${e.message}`);
      await sleep(2000 * i);
      continue;
    }
    if (r.status === 401 || r.status === 403) throw new Error(`Empik ${sciezka}: HTTP ${r.status} — sprawdź EMPIK_API_KEY (panel sprzedawcy → Klucz API)`);
    if (r.status === 429 || r.status >= 500) {
      const ms = czekajMs(r.headers.get('retry-after'), i);
      if (i >= proby || ms == null) throw new Error(`Empik ${sciezka}: HTTP ${r.status}${r.status === 429 ? ` (limit, Retry-After ${r.headers.get('retry-after') ?? '?'} s)` : ''}`);
      await sleep(ms);
      continue;
    }
    let j = null;
    try { j = tekst ? JSON.parse(tekst) : null; } catch { /* PRI03 oddaje CSV, nie JSON */ }
    if (!r.ok) throw new Error(`Empik ${sciezka}: HTTP ${r.status} ${(j && (j.message || j.error)) || String(tekst || '').slice(0, 200)}`);
    return { dane: j, tekst, naglowki: r.headers };
  }
}

// --- Odczyt -----------------------------------------------------------------------------------------

// Nasz sklep (A01, najwyżej raz na dobę — wynik trzyma worker w pricing.db/stan).
async function sklep() {
  const { dane } = await api('account');
  return { id: liczba(dane?.shop_id), nazwa: dane?.shop_name ? String(dane.shop_name) : null };
}

// Wszystkie nasze oferty — eksport asynchroniczny (OF52 → OF53 → OF54), z nieaktywnymi. Wynik w kształcie
// OF21 (zEksportu), więc reszta adaptera nie rozróżnia źródła. Pełny eksport wolno zlecić raz na dobę;
// zlecenie powtórzone wcześniej Mirakl zwraca jako to samo tracking_id.
async function wszystkieOferty({ czekajMs = 10 * 60_000, coMs = 15_000 } = {}) {
  const { dane } = await api('offers/export/async', {
    metoda: 'POST', proby: 1,
    body: JSON.stringify({ export_type: 'application/json', include_inactive_offers: true }),
    naglowki: { 'Content-Type': 'application/json' },
  });
  const id = dane?.tracking_id;
  if (!id) throw new Error('Empik OF52: brak tracking_id w odpowiedzi');
  const koniec = Date.now() + czekajMs;
  for (;;) {
    await sleep(coMs);
    const { dane: s } = await api(`offers/export/async/status/${encodeURIComponent(id)}`);
    if (s?.status === 'FAILED') throw new Error(`Empik OF52: eksport nieudany ${JSON.stringify(s.error || {})}`);
    if (s?.status === 'COMPLETED') {
      const wynik = [];
      for (const url of s.urls || []) {
        const { dane: plik } = await api('', { url });
        wynik.push(...(Array.isArray(plik) ? plik : plik?.offers || plik?.data || []).map(zEksportu));
      }
      return wynik;
    }
    if (Date.now() > koniec) throw new Error(`Empik OF52: eksport ${id} nie skończył się w ${czekajMs / 60_000} min (status ${s?.status})`);
  }
}

// Oferta z eksportu OF52 → kształt OF21 (pola, z których korzysta adapter). Eksport podaje ceny jako
// `prices` [{ origin_price, discount_price?, … }] — bez kanałów jedna pozycja; więcej = ceny kanałowe/terminowe.
// Nie ma nazwy produktu (synchronizacja zostawia wtedy dotychczasową).
function zEksportu(o, teraz = new Date()) {
  const ceny = Array.isArray(o?.prices) ? o.prices : [];
  const c = ceny[0] || {};
  const bazowa = liczba(c.origin_price ?? c.unit_origin_price ?? c.price);
  const rabat = liczba(c.discount_price ?? c.unit_discount_price);
  // Rabat liczy się do ceny tylko w swoim terminie; do blokady zmiany ceny (`discount`) — zawsze,
  // także zaplanowany, bo import cen (PRI01) skasowałby go tak samo.
  const wTerminie = rabat > 0 && (!c.discount_start_date || new Date(c.discount_start_date) <= teraz)
    && (!c.discount_end_date || new Date(c.discount_end_date) >= teraz);
  return {
    offer_id: o?.offer_id, shop_sku: o?.shop_sku, product_sku: o?.product_sku, product_title: o?.product_title || null,
    active: o?.active === true && o?.deleted !== true, quantity: o?.quantity,
    price: bazowa, min_shipping_price: o?.min_shipping_price,
    applicable_pricing: { price: wTerminie ? rabat : bazowa, unit_discount_price: wTerminie ? rabat : null },
    discount: rabat > 0 ? { discount_price: rabat, start_date: c.discount_start_date || null, end_date: c.discount_end_date || null } : null,
    all_prices: ceny,
  };
}

// Jedna nasza oferta po SKU (OF21 z filtrem `sku`) — do zapisu ceny poza przebiegiem z pełną listą.
// Porównanie poniżej i tak wybierze właściwą ofertę, gdyby Empik filtr zignorował.
async function ofertaPoSku(sku) {
  const k = String(sku || '').trim().toUpperCase();
  const { dane } = await api('offers', { query: { sku, max: 100 } });
  return (dane?.offers || []).filter((o) => String(o.shop_sku || '').trim().toUpperCase() === k);
}

// Oferty wszystkich sklepów na produktach (P11), po 100 produktów; 5 zapytań/min → co 13 s.
// Zwraca Map(product_sku → [oferty w kolejności Mirakl]); `wynik.kategorie` = Map(product_sku → { kod, nazwa }
// kategorii Empik) — z tej samej odpowiedzi, do stawki prowizji (pricing/empik-prowizje.js).
async function ofertyProduktow(productSkus, { odstepMs = 13_000 } = {}) {
  const unikalne = [...new Set(productSkus.filter(Boolean).map(String))];
  const wynik = new Map();
  wynik.kategorie = new Map();
  for (let i = 0; i < unikalne.length; i += 100) {
    if (i) await sleep(odstepMs);
    const { dane } = await api('products/offers', { query: { product_ids: unikalne.slice(i, i + 100).join(',') } });
    for (const p of dane?.products || []) {
      wynik.set(String(p.product_sku), Array.isArray(p.offers) ? p.offers : []);
      if (p.category_code) wynik.kategorie.set(String(p.product_sku), { kod: String(p.category_code), nazwa: p.category_label || null });
    }
  }
  return wynik;
}

// Cena towaru oferty — `applicable_pricing.price` to cena, którą widzi klient (z aktywną promocją, jeśli jest);
// `price` zostaje dla starszych odpowiedzi. Brutto, PLN.
const cenaOferty = (o) => {
  const p = liczba(o?.applicable_pricing?.price ?? o?.price);
  return p > 0 ? zaokr(p) : null;
};
// Cena łączna (towar + najtańsza dostawa) — tak sortuje P11 („bestPrice”) i tak porównuje model.
const cenaLaczna = (o) => {
  const t = liczba(o?.total_price);
  if (t > 0) return zaokr(t);
  const c = cenaOferty(o);
  return c != null ? zaokr(c + (liczba(o?.min_shipping_price) || 0)) : null;
};

// Promocja albo więcej niż jedna cena na ofercie — PRI01 („usuń i zastąp”) by je skasował.
function promocja(o) {
  if (liczba(o?.discount?.discount_price) > 0) return `promocja ${o.discount.discount_price} zł`;
  if (liczba(o?.applicable_pricing?.unit_discount_price) > 0) return `promocja ${o.applicable_pricing.unit_discount_price} zł`;
  if (Array.isArray(o?.all_prices) && o.all_prices.length > 1) return `${o.all_prices.length} ceny na ofercie (kanały / terminy)`;
  return null;
}

// Surowa oferta z OF21 → wiersz `oferty` (product_sku idzie do kolumny `asin` — identyfikator produktu platformy).
function doOferty(o) {
  return {
    sku: String(o?.shop_sku || '').trim(),
    produkt: o?.product_sku != null && o.product_sku !== '' ? String(o.product_sku) : null,
    nazwa: o?.product_title || null,
    cena: cenaOferty(o),
    ilosc: Number(o?.quantity) || 0,
    aktywna: o?.active === true,
  };
}

const normNazwa = (s) => String(s || '').trim().toLowerCase();

// Oferty produktu z P11 → obserwacja w kształcie pricing/model.js dla JEDNEJ naszej oferty.
// `ta` = { offerId (z OF21), sklep: { id, nazwa } }. Naszą ofertę rozpoznajemy po offer_id, a gdy P11 go
// nie podaje — po sklepie, ale tylko wtedy, gdy mamy na produkcie jedną ofertę (dwie = nie wiemy, która
// to ta; zwracamy obserwację bez Buy Boxa, model nic nie zmieni). null = naszej oferty nie ma wśród
// aktywnych ofert produktu.
// „Buy Box” = oferta na górze listy po cenie łącznej (stabilnie, więc remis rozstrzyga kolejność Mirakl:
// premium, ocena sklepu). Czy Empik pokazuje na karcie produktu tę samą — DO SPRAWDZENIA na żywym API.
function obserwacja(ofertyProduktu, { offerId = null, sklep: s = {} } = {}) {
  const oferty = (ofertyProduktu || []).filter((o) => o && o.active !== false && cenaLaczna(o) != null);
  const naszSklep = (o) => (s.id != null && liczba(o.shop_id) != null && liczba(o.shop_id) === s.id)
    || (!!s.nazwa && !!o.shop_name && normNazwa(o.shop_name) === normNazwa(s.nazwa));
  const poId = offerId != null ? oferty.find((o) => liczba(o.offer_id) > 0 && liczba(o.offer_id) === liczba(offerId)) : null;
  const nasze = oferty.filter((o) => o === poId || naszSklep(o));
  const ta = poId || (nasze.length === 1 ? nasze[0] : null);
  if (!ta) {
    if (!nasze.length) return null;
    // dwie nasze oferty, a P11 nie mówi, która jest która — bez Buy Boxa (model: brak_danych)
    return { cena: null, wysylka: 0, bbNasz: null, bbInnaNasza: false, bbCena: null, bbFba: false, najtanszaInna: null, ofert: oferty.length };
  }
  const posort = oferty.map((o, i) => ({ o, i, l: cenaLaczna(o) })).sort((a, b) => a.l - b.l || a.i - b.i);
  const pierwsza = posort[0].o;
  const inne = posort.filter((x) => x.o !== ta && !nasze.includes(x.o));
  return {
    cena: cenaOferty(ta),
    wysylka: liczba(ta.min_shipping_price) || 0,
    bbNasz: pierwsza === ta,
    bbInnaNasza: pierwsza !== ta && nasze.includes(pierwsza),
    bbCena: posort[0].l,
    bbFba: false,
    najtanszaInna: inne.length ? inne[0].l : null,
    ofert: oferty.length,
  };
}

// --- Zapis ceny (PRI01) -----------------------------------------------------------------------------

// Czysta funkcja: surowa oferta z OF21 + cena BRUTTO → { sku, cena } albo { blad }.
function zmianaCeny(surowa, cenaBrutto) {
  const sku = String(surowa?.shop_sku || '').trim();
  if (!sku) return { blad: 'brak SKU oferty Empik (shop_sku)' };
  const p = promocja(surowa);
  if (p) return { blad: `${p} — import cen (PRI01) by ją skasował; zmień cenę ręcznie w panelu Empik` };
  const c = zaokr(Number(cenaBrutto));
  if (!(c > 0)) return { blad: `niepoprawna cena: ${cenaBrutto}` };
  return { sku, cena: c };
}

// Plik PRI01: średnik, pola w cudzysłowach, kropka dziesiętna, bez waluty.
const csvPole = (v) => `"${String(v).replace(/"/g, '""')}"`;
function plikCen(zmiany) {
  return ['"offer-sku";"price"', ...zmiany.map((z) => `${csvPole(z.sku)};${csvPole(z.cena.toFixed(2))}`)].join('\n') + '\n';
}

// Jedno wywołanie PRI01 dla wielu ofert. lista: [{ surowa, cena }]. Zwraca { importId, wyniki: [{ sku, ok, cena, blad }] }.
// `ok` = Empik PRZYJĄŁ plik; czy cena weszła, mówi dopiero PRI02/PRI03 (statusImportu) i obserwacja.
async function ustawCeny(lista) {
  const wyniki = lista.map(({ surowa, cena }) => ({ ...zmianaCeny(surowa, cena), sku: String(surowa?.shop_sku || '').trim() }));
  const doWyslania = wyniki.filter((w) => !w.blad);
  if (!doWyslania.length) return { importId: null, wyniki: wyniki.map((w) => ({ ...w, ok: false })) };
  const form = new FormData();
  form.append('file', new Blob([plikCen(doWyslania)], { type: 'text/csv' }), 'ceny.csv');
  try {
    // proby: 1 — ponowienie POST-a po zerwanym połączeniu mogłoby wysłać import drugi raz
    const { dane } = await api('offers/pricing/imports', { metoda: 'POST', body: form, proby: 1 });
    const importId = dane?.import_id ?? dane?.importId ?? null;
    return { importId, wyniki: wyniki.map((w) => ({ ...w, ok: !w.blad })) };
  } catch (e) {
    return { importId: null, wyniki: wyniki.map((w) => ({ ...w, ok: false, blad: w.blad || e.message })) };
  }
}

async function statusImportu(importId) {
  const { dane } = await api('offers/pricing/imports', { query: { import_id: importId } });
  const d = (dane?.data || [])[0];
  return d ? { status: d.status, powod: d.reason_status || null, zmienione: liczba(d.offers_updated), bledy: liczba(d.lines_in_error), raport: !!d.has_error_report } : null;
}

async function raportBledow(importId) {
  return (await api(`offers/pricing/imports/${encodeURIComponent(importId)}/error_report`)).tekst;
}

// --- Linki ------------------------------------------------------------------------------------------

// Karta produktu na empik.com po numerze produktu: `/-,p<numer>,zabawki-p` przekierowuje (301) na właściwy
// adres; segment kategorii może być dowolny niepusty (sprawdzone 2026-10-16 na p1590660825).
function linkiOferty(produkt) {
  const nr = String(produkt || '').trim().replace(/^p/i, '');
  return /^\d+$/.test(nr) ? { produkt: `https://www.empik.com/-,p${nr},zabawki-p` } : null;
}

module.exports = {
  api, sklep, wszystkieOferty, zEksportu, ofertaPoSku, ofertyProduktow, doOferty, obserwacja, cenaOferty, cenaLaczna, promocja,
  zmianaCeny, plikCen, ustawCeny, statusImportu, raportBledow, linkiOferty, czekajMs, skonfigurowany,
};
