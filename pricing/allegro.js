'use strict';

// Adapter Allegro (REST API, allegro.pl): nasze oferty na dwóch kontach i zmiana ceny. Od 2026-10-16 TYLKO
// ODCZYT (pricing/kolumny.js `tylkoOdczyt`) — automat dopiero po ręcznym teście zapisu i decyzji usera.
//
// KONKURENCJI NIE WIDZIMY. `GET /offers/listing` (oferty innych sprzedawców) oddaje 403 AccessDenied
// aplikacjom niezweryfikowanym przez Allegro — sprawdzone 2026-10-16 tokenem aplikacji (client_credentials)
// i tokenem konta. Odpowiednik Buy Boxa („Top oferta” na stronie produktu) zna tylko automat cen samego
// Allegro (reguły FOLLOW_BY_TOP_OFFER_PRICE / FOLLOW_BY_ALLEGRO_MIN_PRICE z zakresem min/max na ofertę).
// Obserwacja ma więc tylko naszą cenę (`konkurencjaNiedostepna`), a decyzja pilnuje wyłącznie minimum.
//
// Dwa konta (decyzja usera 2026-10-16: oba w repricerze): ekajtek_pl (~3100 ofert, ~6400 szt./30 dni) i
// NaTropieZabawek (~2100 ofert, ~700 szt./30 dni). ~1800 SKU jest na obu — konta konkurują ze sobą,
// a API nie powie, które z nich ma „Top ofertę”.
//
// Autoryzacja: własna aplikacja „WMS Price” (ALLEGRO_CLIENT_ID / ALLEGRO_CLIENT_SECRET w .env, typ
// „bez dostępu do przeglądarki” = device flow) — NIE aplikacja systemu Rozliczenia (C:\Rozliczenia): ta ma
// tylko odczyt, a refresh token Allegro jest JEDNORAZOWY (po odświeżeniu stary działa jeszcze 60 s), więc
// dwa systemy na jednym tokenie wylogowywałyby się nawzajem. Tokeny kont trzymamy w pricing.db (tabela
// `allegro_tokeny`, nie w .env — każde odświeżenie daje nowy refresh token). Access token żyje 12 h,
// refresh 3 miesiące; worker odświeża sam, więc ponowna autoryzacja jest potrzebna tylko po >3 mies. przerwy.
// Konto podpina `node pricing/allegro-autoryzuj.js <KONTO>`.
//
// Wywołania (dokumentacja developer.allegro.pl, swagger 2026-10-16):
//   GET   /me                                       login konta — sprawdzamy, że token jest od właściwego
//   GET   /sale/offers?publication.status=ACTIVE    nasze oferty, do 1000 na stronę: external.id = nasz SKU,
//                                                   sellingMode.price (BRUTTO, PLN), stock.available,
//                                                   stock.sold (30 dni), sellingMode.priceAutomation
//   PATCH /sale/product-offers/{id}                 { sellingMode: { price } } — 200 = zmienione od razu,
//                                                   202 = w toku (Location → /operations/{id}: 202 / 303)
//   POST  /pricing/offer-fee-preview                prowizja dla oferty (kategoria + cena), limit 25 zapytań/s.
//                                                   Wymaga publication, parameters i promotion (puste wystarczą —
//                                                   sprawdzone 18.10). Kwota jak w rozliczeniach, czyli brutto:
//                                                   14,17% na HASG1435 wobec mediany 14,15% z Rozliczeń.

// `id` = numer użytkownika Allegro (pole `user_name` w tokenie). Po nim sprawdzamy, że zgodę dało właściwe
// konto — aplikacja „WMS Price” nie ma uprawnienia profile:read, więc /me odpowiada 403 (sprawdzone 18.10).
const KONTA = {
  EKAJTEK: { login: 'ekajtek_pl', id: '21818279', nazwa: 'Allegro ekajtek' },
  NATROPIE: { login: 'NaTropieZabawek', id: '40613543', nazwa: 'Allegro NaTropie' },
};
const API = 'https://api.allegro.pl';
const AUTH = 'https://allegro.pl/auth/oauth';
const MEDIA = 'application/vnd.allegro.public.v1+json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const zaokr = (x) => Math.round(x * 100) / 100;
const iso = (ms) => new Date(ms).toISOString();

const skonfigurowany = () => !!(process.env.ALLEGRO_CLIENT_ID && process.env.ALLEGRO_CLIENT_SECRET);
// Identyfikacja aplikacji — obowiązkowa od 07.2026 (Regulamin REST API pkt 3.4c, allegro/allegro-api#13126):
// `NazwaAplikacji/Wersja (+URL dokumentacji)`. Wartość DOKŁADNIE z generatora apps.developer.allegro.pl/user-agent
// dla naszej aplikacji (zarejestrowana jako „WMS Price”, 18.10.2026). Allegro używa jej do białej listy — nie
// zmieniać bez ponownego wygenerowania w Developer Apps (tam też walidator).
const USER_AGENT = () => process.env.ALLEGRO_USER_AGENT || 'WMS-Price/1.0 (+https://github.com/kaziueee/was/blob/main/pricing/allegro.js)';
const basic = () => 'Basic ' + Buffer.from(`${process.env.ALLEGRO_CLIENT_ID}:${process.env.ALLEGRO_CLIENT_SECRET}`).toString('base64');

// Baza dopiero przy pierwszym użyciu tokenów — czyste funkcje (testy, ekran WMS) nie dotykają SQLite.
let tabela = false;
function baza() {
  const { db } = require('./db');
  if (!tabela) { db.exec(SQL_TOKENY); tabela = true; }
  return db;
}
const SQL_TOKENY = `CREATE TABLE IF NOT EXISTS allegro_tokeny (
  konto         TEXT PRIMARY KEY,           -- klucz z KONTA (EKAJTEK, NATROPIE)
  login         TEXT,                       -- login Allegro z /me w chwili autoryzacji
  uzytkownik    TEXT,                       -- id użytkownika Allegro (z tokenu)
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  wygasa        TEXT NOT NULL,              -- ISO, koniec ważności access tokenu
  odswieza      TEXT,                       -- ISO: ktoś właśnie odświeża (zamek między procesami)
  czas          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;

// --- tokeny ------------------------------------------------------------------------------------

const wierszTokenu = (konto) => baza().prepare('SELECT * FROM allegro_tokeny WHERE konto = ?').get(konto) || null;
const kontaAutoryzowane = () => baza().prepare('SELECT konto FROM allegro_tokeny').all().map((r) => r.konto).filter((k) => KONTA[k]);

// Czy token wystarczy jeszcze na `zapasMs` (domyślnie 5 min — przebieg nie może paść w połowie).
const tokenWazny = (w, teraz = Date.now(), zapasMs = 5 * 60_000) => !!w && Date.parse(w.wygasa) - zapasMs > teraz;

function zapiszTokeny(konto, t, { login, uzytkownik } = {}) {
  const wygasa = iso(Date.now() + (Number(t.expires_in) || 43_199) * 1000);
  baza().prepare(`INSERT INTO allegro_tokeny (konto, login, uzytkownik, access_token, refresh_token, wygasa, odswieza, czas)
              VALUES (?, ?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP)
              ON CONFLICT (konto) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token,
                wygasa = excluded.wygasa, odswieza = NULL, czas = CURRENT_TIMESTAMP,
                login = COALESCE(excluded.login, allegro_tokeny.login), uzytkownik = COALESCE(excluded.uzytkownik, allegro_tokeny.uzytkownik)`)
    .run(konto, login || null, uzytkownik || null, t.access_token, t.refresh_token, wygasa);
}

// /device: client_id w adresie (tak w dokumentacji Allegro); /token: parametry w treści (standard OAuth,
// a authorization_code ma w dokumentacji Allegro body).
async function postAuth(sciezka, params) {
  const wAdresie = sciezka === 'device';
  const r = await fetch(`${AUTH}/${sciezka}${wAdresie ? `?${new URLSearchParams(params)}` : ''}`, {
    method: 'POST', headers: { Authorization: basic(), 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT() },
    body: wAdresie ? undefined : new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
}

// Odświeżenie tokenu konta. Refresh token jest jednorazowy, więc odświeża JEDEN proces naraz (worker,
// skrypt CLI): zamek = pole `odswieza` ustawiane warunkowym UPDATE-em (bez długiej transakcji — WMS pisze
// do tej bazy w tym samym czasie). Kto zamka nie dostał, czeka, aż drugi zapisze nowy token.
async function odswiez(konto) {
  const teraz = Date.now();
  const wziety = baza().prepare(`UPDATE allegro_tokeny SET odswieza = ? WHERE konto = ? AND (odswieza IS NULL OR odswieza < ?)`)
    .run(iso(teraz), konto, iso(teraz - 90_000)).changes;
  if (!wziety) {
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const w = wierszTokenu(konto);
      if (tokenWazny(w)) return w.access_token;
      if (w && !w.odswieza) break;               // drugi proces skończył, ale bez ważnego tokenu
    }
    throw new Error(`Allegro ${konto}: odświeżenie tokenu w innym procesie nie powiodło się albo trwa za długo`);
  }
  try {
    const w = wierszTokenu(konto);
    if (tokenWazny(w)) return w.access_token;            // inny proces zdążył przed naszym zamkiem
    const { status, j } = await postAuth('token', { grant_type: 'refresh_token', refresh_token: w.refresh_token });
    if (status !== 200 || !j.access_token) {
      throw new Error(`Allegro ${konto}: odświeżenie tokenu odrzucone (HTTP ${status} ${j.error || ''} ${j.error_description || ''})`
        + ' — podepnij konto ponownie: node pricing/allegro-autoryzuj.js ' + konto);
    }
    zapiszTokeny(konto, j);
    return j.access_token;
  } finally {
    baza().prepare('UPDATE allegro_tokeny SET odswieza = NULL WHERE konto = ?').run(konto);
  }
}

async function tokenDostepu(konto, { wymus = false } = {}) {
  if (!skonfigurowany()) throw new Error('Allegro: brak ALLEGRO_CLIENT_ID / ALLEGRO_CLIENT_SECRET w .env');
  if (!KONTA[konto]) throw new Error(`Allegro: nieznane konto ${konto} (znane: ${Object.keys(KONTA).join(', ')})`);
  const w = wierszTokenu(konto);
  if (!w) throw new Error(`Allegro ${konto}: konto niepodpięte — node pricing/allegro-autoryzuj.js ${konto}`);
  if (!wymus && tokenWazny(w)) return w.access_token;
  return odswiez(konto);
}

// --- zapytania ---------------------------------------------------------------------------------

// 429 / 5xx: ile czekać. Retry-After w sekundach; dłużej niż `maxMs` nie czekamy (przebieg nie może
// stać — błąd idzie wyżej, następny przebieg spróbuje znowu). null = nie ponawiamy.
function czekajMs(retryAfter, proba, maxMs = 60_000) {
  const s = Number(retryAfter);
  const ms = retryAfter != null && retryAfter !== '' && Number.isFinite(s) && s >= 0 ? s * 1000 : 2000 * proba;
  return ms <= maxMs ? ms : null;
}

const opisBledu = (j) => (j && Array.isArray(j.errors) ? j.errors.map((e) => e.userMessage || e.message || e.code).filter(Boolean).join('; ') : '');

// → { status, j, h } dla 2xx/3xx; wyjątek dla błędów (z opisem Allegro). 401 = jedno wymuszone
// odświeżenie tokenu i ponowienie (token mógł zostać unieważniony przed czasem).
async function zapytanie(konto, sciezka, { metoda = 'GET', query = null, body, proby = 3, timeoutMs = 60_000 } = {}) {
  const qs = query ? '?' + new URLSearchParams(Object.entries(query).flatMap(([k, v]) =>
    (Array.isArray(v) ? v : [v]).filter((x) => x != null && x !== '').map((x) => [k, String(x)]))).toString() : '';
  let odswiezony = false;
  for (let i = 1; ; i++) {
    const token = await tokenDostepu(konto);
    let r, tekst;
    try {
      // Limit czasu obejmuje też czytanie odpowiedzi (lekcja z eMAG 2026-10-16: zawieszony fetch trzymał
      // workera z blokadą „trwa” do restartu). Timeout = błąd sieci = ponowienie niżej.
      r = await fetch(`${API}${sciezka}${qs}`, {
        method: metoda,
        headers: { Authorization: `Bearer ${token}`, Accept: MEDIA, 'Accept-Language': 'pl-PL', 'User-Agent': USER_AGENT(),
          ...(body !== undefined ? { 'Content-Type': MEDIA } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'manual',           // 303 z /operations = „gotowe” — chcemy go zobaczyć, nie iść za nim
        signal: AbortSignal.timeout(timeoutMs),
      });
      tekst = await r.text();
    } catch (e) {
      if (i >= proby) throw new Error(`Allegro ${konto} ${metoda} ${sciezka}: ${e.message}`);
      await sleep(2000 * i);
      continue;
    }
    let j = null;
    try { j = tekst ? JSON.parse(tekst) : null; } catch { /* treść nie-JSON */ }
    if (r.status === 401 && !odswiezony) { odswiezony = true; await tokenDostepu(konto, { wymus: true }); i--; continue; }
    if (r.status === 429 || r.status >= 500) {
      const ms = czekajMs(r.headers.get('retry-after'), i);
      if (i >= proby || ms == null) throw new Error(`Allegro ${konto} ${metoda} ${sciezka}: HTTP ${r.status}`);
      await sleep(ms);
      continue;
    }
    if (r.status >= 400) {
      const e = new Error(`Allegro ${konto} ${metoda} ${sciezka}: HTTP ${r.status} ${opisBledu(j) || String(tekst || '').slice(0, 200)}`
        + (r.status === 403 ? ' — aplikacja bez uprawnienia (sale:offers:write?) albo oferta z innego konta' : ''));
      e.status = r.status;
      throw e;
    }
    return { status: r.status, j, h: r.headers };
  }
}
const api = async (konto, sciezka, opcje) => (await zapytanie(konto, sciezka, opcje)).j;

// Wszystkie AKTYWNE oferty konta, po 1000 na stronę (~3100 ofert = 4 zapytania). Surowe oferty dostają
// `_konto`, żeby dalsze funkcje (zapis ceny, potwierdzenie) wiedziały, z którego konta są.
async function wszystkieOferty(konto) {
  const wynik = [];
  for (let offset = 0; ; offset += 1000) {
    const s = await api(konto, '/sale/offers', { query: { 'publication.status': 'ACTIVE', limit: 1000, offset } });
    const paczka = (s && s.offers) || [];
    wynik.push(...paczka.map((o) => ({ ...o, _konto: konto })));
    if (paczka.length < 1000) return wynik;
  }
}

// Jedna oferta po jej numerze Allegro (do potwierdzenia ceny po zapisie) — ten sam kształt co lista.
async function ofertaPoId(konto, id) {
  const s = await api(konto, '/sale/offers', { query: { 'offer.id': String(id), limit: 1 } });
  const o = ((s && s.offers) || []).find((x) => String(x.id) === String(id));
  return o ? { ...o, _konto: konto } : null;
}

async function login(konto) { return (await api(konto, '/me'))?.login || null; }

// Treść tokenu (JWT): user_name = numer konta Allegro, scope = lista uprawnień. Bez weryfikacji podpisu —
// token przyszedł prosto z allegro.pl/auth/oauth/token, czytamy go tylko po to, żeby nie pomylić kont.
function trescTokenu(accessToken) {
  try { return JSON.parse(Buffer.from(String(accessToken).split('.')[1], 'base64url').toString()); } catch { return null; }
}

// --- kształt danych (czyste funkcje, testy w test/pricing-allegro.test.js) ---------------------

const cenaPln = (sm) => (sm && sm.price && sm.price.currency === 'PLN' && Number(sm.price.amount) > 0 ? zaokr(Number(sm.price.amount)) : null);

// Surowa oferta z API → wiersz `oferty`. `id` = numer oferty Allegro (trzymany w kolumnie `asin`).
function doOferty(o) {
  return {
    sku: String(o?.external?.id || '').trim(),
    id: o?.id ? String(o.id) : null,
    nazwa: o?.name || null,
    cena: cenaPln(o?.sellingMode),
    ilosc: Number(o?.stock?.available) || 0,
    sprzedane30: Number(o?.stock?.sold) || 0,
    aktywna: o?.publication?.status === 'ACTIVE',
    regula: o?.sellingMode?.priceAutomation?.rule?.id || null,
  };
}

// Klucz oferty w `oferty.sku`. Na jednym koncie ten sam SKU bywa w kilku ofertach (16.10: 150 SKU na
// ekajtek, 68 na NaTropie), a tabela ma UNIQUE (platforma, rynek, sku). Najstarsza oferta SKU (najniższy
// numer) dostaje goły SKU — klucz stabilny, gdy dochodzą nowe duplikaty; pozostałe `SKU/numer oferty`.
// Dopasowanie do GT zawsze po gołym SKU (skuGt).
const mniejszyNumer = (a, b) => (a.length !== b.length ? a.length < b.length : a < b);   // numery ofert = cyfry
function kluczeOfert(lista) {
  const najstarsza = new Map();
  for (const o of lista) {
    const sku = String(o?.external?.id || '').trim().toUpperCase();
    if (!sku || !o.id) continue;
    const b = najstarsza.get(sku);
    if (!b || mniejszyNumer(String(o.id), b)) najstarsza.set(sku, String(o.id));
  }
  return (o) => {
    const sku = String(o?.external?.id || '').trim();
    if (!sku || !o.id) return null;
    return najstarsza.get(sku.toUpperCase()) === String(o.id) ? sku : `${sku}/${o.id}`;
  };
}
const skuGt = (klucz) => String(klucz || '').replace(/\/\d+$/, '');

// Obserwacja w kształcie pricing/model.js: sama nasza cena — konkurencji API nie podaje (patrz nagłówek).
// Wysyłka 0: kalkulator liczy dopłatę Smart od ceny towaru (config/rynki.js), cennika dostawy nie czytamy.
function zOferty(o) {
  return {
    cena: cenaPln(o?.sellingMode),
    wysylka: 0,
    bbNasz: null,
    bbCena: null,
    bbFba: false,
    najtanszaInna: null,
    bbInnaNasza: false,
    konkurencjaNiedostepna: true,
    ofert: null,
  };
}

// Zmiana ceny: PATCH /sale/product-offers/{id} z samą ceną (inne pola oferty zostają). Czysta funkcja:
// surowa oferta + cena BRUTTO w PLN → { body, cena } albo { blad }.
function zmianaCeny(surowa, cena) {
  if (!surowa?.id) return { blad: 'brak numeru oferty Allegro' };
  if (surowa.sellingMode?.format && surowa.sellingMode.format !== 'BUY_NOW') return { blad: `format ${surowa.sellingMode.format} — zmieniamy tylko Kup Teraz` };
  if (surowa.sellingMode?.price?.currency && surowa.sellingMode.price.currency !== 'PLN') return { blad: `waluta ${surowa.sellingMode.price.currency} — oczekiwano PLN` };
  // Oferta pod regułą cenową Allegro (16.10: 13 ofert ekajtek, 4 NaTropie) — dwa automaty by się
  // przeciągały; regułę zdejmuje człowiek w panelu Allegro.
  if (surowa.sellingMode?.priceAutomation?.rule?.id) return { blad: 'oferta ma regułę cenową Allegro — najpierw zdejmij ją w Sales Center' };
  const c = zaokr(Number(cena));
  if (!(c > 0)) return { blad: `niepoprawna cena: ${cena}` };
  return { body: { sellingMode: { price: { amount: c.toFixed(2), currency: 'PLN' } } }, cena: c };
}

// Wysłanie zmiany ceny. { ok, cena, asynchronicznie, blad } — odmowa Allegro to wynik, nie wyjątek.
// 202 = Allegro przetwarza: dopytujemy /operations do ~30 s; nadal w toku = ok (potwierdzenie i tak
// sprawdzi ofertę po kilku minutach).
async function ustawCene(surowa, cena) {
  const z = zmianaCeny(surowa, cena);
  if (z.blad) return { ok: false, blad: z.blad };
  const konto = surowa._konto;
  try {
    const r = await zapytanie(konto, `/sale/product-offers/${encodeURIComponent(surowa.id)}`, { metoda: 'PATCH', body: z.body, proby: 2 });
    if (r.status !== 202) return { ok: true, cena: z.cena };
    const loc = r.h.get('location');
    const sciezka = loc ? loc.replace(/^https?:\/\/[^/]+/, '') : null;
    for (let i = 0; sciezka && i < 6; i++) {
      await sleep(Math.min(10, Number(r.h.get('retry-after')) || 5) * 1000);
      const s = await zapytanie(konto, sciezka);
      if (s.status === 303 || s.status === 200) return { ok: true, cena: z.cena };
    }
    return { ok: true, cena: z.cena, asynchronicznie: true };
  } catch (e) {
    return { ok: false, blad: e.message };
  }
}

// Podgląd opłat oferty — czyste funkcje: treść zapytania i stawka % ceny (prowizja brutto, jak pobiera Allegro).
function zapytaniePodgladu(surowa) {
  if (!surowa?.category?.id || !(cenaPln(surowa.sellingMode) > 0)) return null;
  return { offer: { id: String(surowa.id), name: surowa.name || String(surowa.id), category: { id: String(surowa.category.id) },
    sellingMode: { format: 'BUY_NOW', price: surowa.sellingMode.price }, publication: { duration: null }, parameters: [], promotion: {} },
  marketplaceId: 'allegro-pl' };
}
function stawkaZPodgladu(odp, cena) {
  const prow = ((odp && odp.commissions) || []).filter((c) => c.type === 'commissionFee' && c.fee?.currency === 'PLN');
  if (!prow.length || !(cena > 0)) return null;
  const s = prow.reduce((a, c) => a + (Number(c.fee.amount) || 0), 0) / cena * 100;
  return s > 0 && s < 100 ? Math.round(s * 100) / 100 : null;
}
// Stawka prowizji oferty (% ceny brutto) albo null (Allegro nie podało — kalkulator bierze stawkę rynku).
async function prowizjaOferty(surowa) {
  const body = zapytaniePodgladu(surowa);
  if (!body) return null;
  const r = await zapytanie(surowa._konto, '/pricing/offer-fee-preview', { metoda: 'POST', body, proby: 2, timeoutMs: 30_000 });
  return stawkaZPodgladu(r.j, cenaPln(surowa.sellingMode));
}

const linkiOferty = (id) => (id ? { produkt: `https://allegro.pl/oferta/${encodeURIComponent(id)}` } : null);

module.exports = {
  KONTA, USER_AGENT, skonfigurowany, kontaAutoryzowane, tokenDostepu, zapiszTokeny, postAuth, tokenWazny, czekajMs,
  api, zapytanie, wszystkieOferty, ofertaPoId, login, trescTokenu, zapytaniePodgladu, stawkaZPodgladu, prowizjaOferty, doOferty, kluczeOfert, skuGt, zOferty, zmianaCeny, ustawCene, linkiOferty,
};
