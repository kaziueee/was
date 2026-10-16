'use strict';

// Pomiar kosztów sprzedaży na Empiku z zamówień (Mirakl OR11) — pod kalkulator (config/rynki.js):
// prowizja jako % od ceny towaru i od całości (towar + dostawa), per kategoria, oraz ile klient płaci
// za dostawę per metoda (i jak często 0 — Empik Premium). Tylko odczyt, tylko sumy — bez danych klientów.
//
//   node pricing/empik-zamowienia.js [--dni 60]
//
// Pola linii zamówienia: price (towar, brutto przy TAX_INCLUDED), shipping_price, commission_fee
// (prowizja bez VAT), commission_vat, total_commission (z VAT), category_label. Zamówienie:
// shipping_type_label (metoda dostawy), order_state.

require('dotenv').config({ quiet: true });
const empik = require('./empik');

const zaokr = (x, n = 2) => Math.round(x * 10 ** n) / 10 ** n;
const pct = (a, b) => (b > 0 ? zaokr((a / b) * 100, 2) : null);
// Zamówienia anulowane i odrzucone nie płacą prowizji — nie zaniżamy nimi stawki.
const BEZ_PROWIZJI = new Set(['CANCELED', 'REFUSED']);

// Czysta funkcja (testy w test/pricing-empik.test.js): orders z OR11 → { kategorie, dostawy, razem }.
function podsumujZamowienia(orders) {
  const kat = new Map(), dost = new Map();
  const razem = { zamowien: 0, linii: 0, towar: 0, dostawa: 0, prowizja: 0, prowizjaZVat: 0 };
  for (const z of orders || []) {
    if (BEZ_PROWIZJI.has(z.order_state)) continue;
    razem.zamowien++;
    const metoda = z.shipping_type_label || z.shipping_type_code || '?';
    const d = dost.get(metoda) || { metoda, zamowien: 0, suma: 0, zero: 0, kwoty: new Map() };
    let wys = 0;
    for (const l of z.order_lines || []) {
      const towar = Number(l.price) || 0, w = Number(l.shipping_price) || 0;
      const p = Number(l.commission_fee) || 0, pv = Number(l.total_commission ?? (p + (Number(l.commission_vat) || 0))) || 0;
      wys += w;
      razem.linii++; razem.towar += towar; razem.dostawa += w; razem.prowizja += p; razem.prowizjaZVat += pv;
      const nazwa = l.category_label || l.category_code || '?';
      const k = kat.get(nazwa) || { kategoria: nazwa, linii: 0, towar: 0, dostawa: 0, prowizja: 0 };
      k.linii++; k.towar += towar; k.dostawa += w; k.prowizja += p;
      kat.set(nazwa, k);
    }
    d.zamowien++; d.suma += wys;
    if (wys < 0.005) d.zero++;
    const klucz = wys.toFixed(2);
    d.kwoty.set(klucz, (d.kwoty.get(klucz) || 0) + 1);
    dost.set(metoda, d);
  }
  const kategorie = [...kat.values()].sort((a, b) => b.towar - a.towar).map((k) => ({
    kategoria: k.kategoria, linii: k.linii, towar: zaokr(k.towar), prowizja: zaokr(k.prowizja),
    'prow_%_towaru': pct(k.prowizja, k.towar), 'prow_%_calosci': pct(k.prowizja, k.towar + k.dostawa) }));
  const dostawy = [...dost.values()].sort((a, b) => b.zamowien - a.zamowien).map((d) => ({
    metoda: d.metoda, zamowien: d.zamowien, srednio: zaokr(d.suma / d.zamowien), 'gratis_%': pct(d.zero, d.zamowien),
    kwoty: [...d.kwoty].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k}×${n}`).join(' ') }));
  return { kategorie, dostawy, razem: { ...razem, towar: zaokr(razem.towar), dostawa: zaokr(razem.dostawa), prowizja: zaokr(razem.prowizja),
    prowizjaZVat: zaokr(razem.prowizjaZVat), 'prow_%_towaru': pct(razem.prowizja, razem.towar),
    'prow_%_calosci': pct(razem.prowizja, razem.towar + razem.dostawa) } };
}

async function zamowieniaOd(od) {
  const wynik = [];
  for (let offset = 0; ;) {
    const { dane } = await empik.api('orders', { query: { start_date: od.toISOString(), order_tax_mode: 'TAX_INCLUDED', max: 100, offset } });
    const paczka = Array.isArray(dane?.orders) ? dane.orders : [];
    wynik.push(...paczka);
    offset += paczka.length;
    const razem = Number(dane?.total_count);
    if (!paczka.length || (razem > 0 ? wynik.length >= razem : paczka.length < 100)) return wynik;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

module.exports = { podsumujZamowienia };

if (require.main === module) {
  const i = process.argv.indexOf('--dni');
  const dni = i >= 0 ? Number(process.argv[i + 1]) || 60 : 60;
  zamowieniaOd(new Date(Date.now() - dni * 86400_000))
    .then((orders) => {
      const p = podsumujZamowienia(orders);
      console.log(`Empik, zamówienia z ${dni} dni (bez anulowanych):`);
      console.table([p.razem]);
      console.table(p.kategorie.slice(0, 25));
      console.table(p.dostawy);
      process.exit(0);
    })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
