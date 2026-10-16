'use strict';

// Prowizja Empik per kategoria — mierzona z zamówień (Mirakl OR11), bo API sprzedawcy nie podaje tabeli
// prowizji. Prowizja linii = commission_fee (netto) / (cena + dostawa, brutto) — tak Empik ją nalicza
// (rozliczenie 30.09–15.10.2026: 2 565,87 zł przy 24 327,97 zł = 10,55%, tyle samo co średnia z OR11).
//
// Stawki zmieniły się 20.07.2026 (dzień maila o pakietach abonamentowych): 12 → 11,7%, 9,5 → 8,6%,
// 11,5 → 10,9%, 7 → 6,7%, 8,5 → 7,7%; 10,5% bez zmian. Pomiar 180 dni, 2523 linie — przed 20.07 ani jednej
// nowej stawki, od 20.07 ani jednej starej. Dlatego:
//   - kategoria sprzedana od 20.07 → dominanta z tych zamówień,
//   - sprzedana tylko wcześniej → jej stara stawka (wszystkie zmiany 20.07 były obniżkami, więc to górne
//     oszacowanie — minimum wyjdzie raczej za wysokie niż za niskie),
//   - nigdy niesprzedana → brak; kalkulator bierze stawkę domyślną rynku (config/rynki.js, średnia 10,55%).
// Remis dominanty rozstrzyga wyższa stawka (ostrożniej dla minimum).
//
// Worker odświeża stawki raz na dobę (zapis w pricing.db/stan `empik_stawki`), a obserwacja przypisuje
// stawkę ofercie po kategorii produktu z P11 (oferty.prowizja) — dalej jak na eMAG (pricing/pas.js).

const empik = require('./empik');
const { stan } = require('./db');

const OD_ZMIANY = '2026-07-20';
const BEZ_PROWIZJI = new Set(['CANCELED', 'REFUSED']);

// Stawka % jednej linii zamówienia (do 0,1 — prowizja jest w groszach, więc dokładniej się nie da).
function stawkaLinii(l) {
  const baza = (Number(l?.price) || 0) + (Number(l?.shipping_price) || 0);
  if (!(baza > 0) || l?.commission_fee == null || l.commission_fee === '') return null;
  return Math.round((Number(l.commission_fee) / baza) * 1000) / 10;
}

// orders (OR11) → { kod_kategorii: { stawka, linii, nazwa, zrodlo: 'po' | 'przed' } }
function stawkiKategorii(orders, od = OD_ZMIANY) {
  const zbierz = { po: new Map(), przed: new Map() };
  const nazwy = new Map();
  for (const z of orders || []) {
    if (BEZ_PROWIZJI.has(z.order_state)) continue;
    const okres = String(z.created_date || '').slice(0, 10) >= od ? 'po' : 'przed';
    for (const l of z.order_lines || []) {
      const s = stawkaLinii(l);
      if (s == null || !l.category_code) continue;
      const kod = String(l.category_code);
      nazwy.set(kod, l.category_label || null);
      const m = zbierz[okres].get(kod) || zbierz[okres].set(kod, new Map()).get(kod);
      m.set(s, (m.get(s) || 0) + 1);
    }
  }
  const wynik = {};
  for (const okres of ['po', 'przed']) {
    for (const [kod, m] of zbierz[okres]) {
      if (wynik[kod]) continue;
      const [stawka] = [...m].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
      wynik[kod] = { stawka, linii: [...m.values()].reduce((a, b) => a + b, 0), nazwa: nazwy.get(kod), zrodlo: okres };
    }
  }
  return wynik;
}

// Zamówienia z ostatnich `dni` (OR11, po 100, z przerwą — limit Empik jest godzinowy).
async function zamowieniaOd(od) {
  const wynik = [];
  for (let offset = 0; ;) {
    const { dane } = await empik.api('orders', { query: { start_date: od.toISOString(), order_tax_mode: 'TAX_INCLUDED', max: 100, offset } });
    const paczka = Array.isArray(dane?.orders) ? dane.orders : [];
    wynik.push(...paczka);
    offset += paczka.length;
    const razem = Number(dane?.total_count);
    if (!paczka.length || (razem > 0 ? wynik.length >= razem : paczka.length < 100)) return wynik;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function odswiezStawki(dni = 180) {
  const kategorie = stawkiKategorii(await zamowieniaOd(new Date(Date.now() - dni * 86400_000)));
  stan.set('empik_stawki', JSON.stringify(kategorie));
  return Object.keys(kategorie).length;
}

function stawkiZapisane() {
  try { return JSON.parse(stan.get('empik_stawki')?.wartosc || '{}'); } catch { return {}; }
}

module.exports = { OD_ZMIANY, stawkaLinii, stawkiKategorii, zamowieniaOd, odswiezStawki, stawkiZapisane };
