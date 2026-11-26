'use strict';

// Klient Erli Shop API (https://erli.pl/svc/shop-api/doc/). Klucz `ERLI_API_KEY` z panelu Erli („Metoda integracji
// > Własna integracja po API”), na SRV w .env.dpapi. Ten sam klucz obsługuje działającą integrację (kopie ofert Allegro
// aktualizowane na bieżąco — 2026-11-26), więc używamy go oszczędnie: odczyty listy + POST nowych produktów.
//
//   GET  /me                       sklep (id, nazwa, zakresy klucza)
//   POST /products/_search         lista produktów, stronicowanie po externalId (`after`), do 200 na stronę
//   GET  /products/{externalId}    jeden produkt (404 = nie ma)
//   POST /products/{externalId}    nowy produkt — zapis ASYNCHRONICZNY (202), na stronie do ~20 min
//   GET  /delivery/priceLists      cenniki dostawy (nazwy = nazwy cenników Allegro)
//   GET/POST /dictionaries/responsibleProducers, /responsiblePersons   słownik GPSR (idempotenceKey = id z Allegro)
//
// Limit zapytań jest zmienny: ponad limit → 429 (czekamy i ponawiamy). Bez kasowania produktów — Erli ich nie usuwa,
// tylko archiwizuje (status / archived).

const API = 'https://erli.pl/svc/shop-api';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const skonfigurowany = () => !!process.env.ERLI_API_KEY;

async function api(metoda, sciezka, { body, proby = 4, timeoutMs = 60_000 } = {}) {
  if (!skonfigurowany()) throw new Error('brak ERLI_API_KEY (.env / .env.dpapi tej maszyny)');
  for (let i = 1; ; i++) {
    let r, tekst;
    try {
      r = await fetch(`${API}${sciezka}`, {
        method: metoda,
        headers: { Authorization: `Bearer ${process.env.ERLI_API_KEY}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      tekst = await r.text();
    } catch (e) {
      // POST nie ponawiamy po błędzie sieci — nie wiadomo, czy przeszedł.
      if (metoda !== 'GET' && !sciezka.endsWith('/_search')) throw Object.assign(new Error(`Erli ${metoda} ${sciezka}: ${e.message}`), { siec: true });
      if (i >= proby) throw new Error(`Erli ${metoda} ${sciezka}: ${e.message}`);
      await sleep(2000 * i);
      continue;
    }
    let j = null;
    try { j = tekst ? JSON.parse(tekst) : null; } catch { /* nie-JSON */ }
    if (r.status === 429 || r.status >= 500) {
      if (i >= proby) throw Object.assign(new Error(`Erli ${metoda} ${sciezka}: HTTP ${r.status}`), { status: r.status });
      const ra = Number(r.headers.get('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60_000) : 3000 * i);
      continue;
    }
    if (r.status >= 400) {
      const opis = j?.message || j?.error || String(tekst || '').slice(0, 400);
      throw Object.assign(new Error(`Erli ${metoda} ${sciezka}: HTTP ${r.status} ${opis}`), { status: r.status, j });
    }
    return { status: r.status, j };
  }
}

// Wszystkie produkty sklepu (~10 tys. = ~50 zapytań).
async function wszystkieProdukty(pola = ['externalId', 'sku', 'ean', 'status', 'archived', 'price', 'stock']) {
  const wynik = [];
  let after;
  for (;;) {
    const pagination = { sortField: 'externalId', limit: 200 };
    if (after) pagination.after = after;
    const { j } = await api('POST', '/products/_search', { body: { pagination, fields: pola } });
    if (!Array.isArray(j) || !j.length) return wynik;
    wynik.push(...j);
    after = j[j.length - 1].externalId;
    if (j.length < 200) return wynik;
  }
}

async function produkt(externalId) {
  try { return (await api('GET', `/products/${encodeURIComponent(externalId)}`)).j; } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function cenniki() {
  const { j } = await api('GET', '/delivery/priceLists');
  return Array.isArray(j) ? j : [];
}

// Słownik GPSR Erli: Map(idempotenceKey → wpis). rodzaj = 'Producers' | 'Persons'.
async function slownikGpsr(rodzaj) {
  const { j } = await api('GET', `/dictionaries/responsible${rodzaj}`);
  const l = Array.isArray(j) ? j : (j?.items || j?.data || []);
  return new Map(l.filter((x) => x?.idempotenceKey).map((x) => [String(x.idempotenceKey), x]));
}
// Nowy wpis słownika. 409 = ten idempotenceKey już jest — dla nas to sukces.
async function dodajDoSlownika(rodzaj, wpis) {
  try { return (await api('POST', `/dictionaries/responsible${rodzaj}`, { body: wpis, proby: 1 })).j; } catch (e) {
    if (e.status === 409) return null;
    throw e;
  }
}

// Nowy produkt. Bez ponowień (proby: 1): niepewny wynik sprawdza wołający przez produkt(externalId).
async function zalozProdukt(externalId, body) {
  return api('POST', `/products/${encodeURIComponent(externalId)}`, { body, proby: 1 });
}

module.exports = { API, skonfigurowany, api, wszystkieProdukty, produkt, cenniki, zalozProdukt, slownikGpsr, dodajDoSlownika };
