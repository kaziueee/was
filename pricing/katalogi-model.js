'use strict';

// Czysta logika katalogów platform (bez API, SQLite i GT — testy w test/katalogi-model.test.js). Skan i zapis:
// pricing/katalogi.js; ekran Ceny → „Do wystawienia”: routes/ceny-wystawianie.js.

// Rynki, których katalog skanujemy. Klucz = `${platforma}:${rynek}` (ten sam co w pricing/wystawianie-model.js).
const RYNKI_KATALOGU = [
  { platforma: 'emag', rynek: 'RO' }, { platforma: 'emag', rynek: 'HU' }, { platforma: 'emag', rynek: 'BG' },
  { platforma: 'kaufland', rynek: 'DE' },
  ...['DE', 'FR', 'IT', 'ES', 'NL', 'PL'].map((rynek) => ({ platforma: 'amazon', rynek })),
  { platforma: 'empik', rynek: 'PL' },
];
const kluczRynku = (platforma, rynek) => `${platforma}:${rynek}`;

// EAN z GT: same cyfry, 8/12/13/14 znaków. 12 cyfr (UPC) uzupełniamy zerem do EAN-13 — tak katalogi trzymają kody
// amerykańskie; GTIN-14 z wiodącym zerem = ten sam EAN-13. Inaczej null (nasze wewnętrzne kody, śmieci).
function normalizujEan(v) {
  const s = String(v || '').trim();
  if (!/^\d+$/.test(s) || ![8, 12, 13, 14].includes(s.length)) return null;
  if (s.length === 14 && s[0] === '0') return s.slice(1);
  return s.length === 12 ? `0${s}` : s;
}

const paczki = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

// eMAG documentation/find_by_eans: results = { "<ean>": { products: [...] } } (sprawdzone na SRV 2026-10-28; dokumentacja
// opisuje listę). Jeden EAN na kilku produktach eMAG: wygrywa ten, do którego wolno dodać ofertę. Zwraca Map(ean → wpis).
function zEmagFindByEans(results) {
  const mapa = new Map();
  for (const [e, wynik] of Object.entries(results || {})) {
    const ean = normalizujEan(e);
    if (!ean) continue;
    for (const p of wynik?.products || []) {
      const wpis = {
        produkt_id: p.part_number_key || null,
        nazwa: p.product_name || p.name || null,
        marka: p.brand_name || null,
        kategoria: p.category_name || null,
        kategoria_id: p.doc_category_id != null ? String(p.doc_category_id) : (p.category_id != null ? String(p.category_id) : null),
        dodac: (p.allowed_to_add_offer ?? p.allow_to_add_offer) ? 1 : 0,
        mamy: p.vendor_has_offer ? 1 : 0,
        hotness: p.hotness || null,
      };
      if (!wpis.produkt_id) continue;
      if (!mapa.has(ean) || (!mapa.get(ean).dodac && wpis.dodac)) mapa.set(ean, wpis);
    }
  }
  return mapa;
}

// Empik (Mirakl) P31 `GET /api/products?product_references=EAN|…`: products = [{ product_id: EAN, product_sku,
// product_title, category_code, category_label }] (sprawdzone na SRV 2026-10-30; marki P31 nie podaje). Kluczem
// produktu w Empiku jest product_sku — to on idzie do importu ofert. Zwraca Map(ean → wpis) jak zEmagFindByEans.
function zEmpikP31(products) {
  const mapa = new Map();
  for (const p of products || []) {
    if (p?.product_id_type && p.product_id_type !== 'EAN') continue;
    const ean = normalizujEan(p?.product_id);
    if (!ean || !p.product_sku || mapa.has(ean)) continue;
    mapa.set(ean, { produkt_id: String(p.product_sku), nazwa: p.product_title || null, marka: null,
      kategoria: p.category_label || null, kategoria_id: p.category_code || null, dodac: null, mamy: 0, hotness: null });
  }
  return mapa;
}

// Odrzucenie wystawienia przez eMAG z powodu marki („kategorii cu risc ridicat” — trzeba wysłać dokumenty przez
// Mesagerie). Taka marka nie przejdzie na tym rynku dla ŻADNEGO towaru, więc oznaczamy wszystkie (pricing/wystawianie.js).
const ODRZUCENIE_MARKI = /risc|risk|document/i;
const odrzucenieMarki = (komunikat) => ODRZUCENIE_MARKI.test(String(komunikat || ''));

// Dlaczego towar NIE jest kandydatem na rynku (null = jest). `k` = wiersz katalogu, `mamyOferte` = oferta w bazie
// repricera (aktywna albo wstrzymana), `stan` = stan dostępny (Razem − rezerwacje; null = GT nie odpowiedział).
function powodBraku(k, { mamyOferte = false, stan = null } = {}) {
  if (!k) return 'nie sprawdzono';
  if (mamyOferte || k.mamy) return 'mamy ofertę';
  if (!k.produkt_id) return 'brak produktu na rynku';
  if (k.dodac === 0) return 'platforma nie pozwala dodać oferty';
  if (k.ograniczenie) return k.ograniczenie;
  if (stan != null && stan <= 0) return 'brak stanu';
  return null;
}

module.exports = { RYNKI_KATALOGU, kluczRynku, normalizujEan, paczki, zEmagFindByEans, zEmpikP31, odrzucenieMarki, powodBraku };
