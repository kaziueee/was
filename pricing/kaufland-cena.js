'use strict';

// Ręczna zmiana ceny jednej oferty Kaufland — do testu zapisu i do korekt (worker robi to sam przy
// automacie). Bez --zapisz tylko pokazuje ofertę, Buy Box i to, co by wysłał. Cena TOWARU z VAT w walucie
// storefrontu (bez wysyłki — tę ustala grupa wysyłkowa w Kauflandzie).
//   node pricing/kaufland-cena.js <SKU> <cena> [--rynek DE]            — podgląd
//   node pricing/kaufland-cena.js <SKU> <cena> [--rynek DE] --zapisz   — wysyła i śledzi, kiedy cena wejdzie
//
// Zapis zostawia ślad jak korekta z ekranu: decyzja `korekta` (wyslano = 1) i wpis w `zmiany`.

require('../config/env');
const kaufland = require('./kaufland');
const { db } = require('./db');

const KTO = process.env.PRICING_KTO || process.env.USERNAME || process.env.USER || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function opisz(u) {
  const bb = await kaufland.buybox(u.id_product, u._rynek);
  const o = kaufland.zBuyboxa(bb, u);
  const top = (bb?.units || []).slice(0, 5).map((x) => `#${x.buybox_rank} ${x.id_unit ? 'MY' : x.seller} ${(x.price / 100).toFixed(2)}+${((x.shipping_rate || 0) / 100).toFixed(2)}`).join(' | ');
  return `${u.id_offer} (unit ${u.id_unit}, produkt ${u.id_product}, ${u._rynek}): listing ${u.listing_price / 100}, price ${u.price / 100}, `
    + `wysyłka ${(u.shipping_rate || 0) / 100}, min Smart Pricing ${u.minimum_price ? u.minimum_price / 100 : '—'}, stan ${u.amount}, ${u.status}, live ${u.is_live}\n`
    + `   Buy Box ${o.bbNasz ? 'NASZ' : o.bbNasz === false ? `INNY (${o.bbCena} z wys.)` : '?'}, ofert ${o.ofert}, cena wg rankingu ${o.cena}; ${top}`;
}

async function main(argv) {
  const i = argv.indexOf('--rynek');
  const rynek = i >= 0 ? String(argv[i + 1] || '').toUpperCase() : 'DE';
  const [sku, cena, flaga] = i >= 0 ? argv.filter((x, n) => n !== i && n !== i + 1) : argv;
  if (!kaufland.STOREFRONTY[rynek] || !sku || !(Number(cena) > 0)) throw new Error('Użycie: node pricing/kaufland-cena.js <SKU> <cena> [--rynek DE] [--zapisz]');
  const lista = await kaufland.unitPoSku(sku, rynek);
  if (lista.length !== 1) throw new Error(`SKU ${sku}: ${lista.length} ofert w Kauflandzie ${rynek} — oczekiwano dokładnie jednej`);
  const u = lista[0];
  console.log('Teraz: ', await opisz(u));
  const z = kaufland.zmianaCeny(u, cena);
  if (z.blad) throw new Error(z.blad);
  console.log(`Wyślę: PATCH ${z.sciezka}?storefront=${z.query.storefront} ${JSON.stringify(z.body)}  (= ${z.cena})`);
  if (flaga !== '--zapisz') { console.log('Podgląd — nic nie wysłano (dodaj --zapisz).'); return; }

  const przed = kaufland.doOferty(u).cena;
  const w = await kaufland.ustawCene(u, cena);
  const of = db.prepare("SELECT id FROM oferty WHERE platforma = 'kaufland' AND rynek = ? AND sku = ?").get(rynek, u.id_offer);
  if (of) {
    db.prepare(`INSERT INTO decyzje (oferta_id, cena_przed, cena_nowa, cena_cel, kod, powod, wyslano, auto, blad)
                VALUES (?, ?, ?, ?, 'korekta', ?, ?, 0, ?)`)
      .run(of.id, przed, z.cena, z.cena, `ręczna zmiana ceny (${KTO || 'CLI'})`, w.ok ? 1 : 0, w.ok ? null : w.blad);
    if (w.ok) db.prepare("INSERT INTO zmiany (kto, oferta_id, akcja, opis) VALUES (?, ?, 'korekta_ceny', ?)")
      .run(KTO, of.id, `Kaufland ${rynek} ${u.id_offer}: ${przed} → ${z.cena}`);
  }
  if (!w.ok) throw new Error(`Kaufland odrzucił: ${w.blad}`);
  console.log(`Kaufland przyjął zapis (listing_price w odpowiedzi: ${w.listing}). Śledzę, kiedy cena wejdzie do rankingu…`);
  const t0 = Date.now();
  for (const czekaj of [10, 50, 60, 120, 180, 300, 300]) {
    await sleep(czekaj * 1000);
    const [t] = await kaufland.unitPoSku(sku, rynek);
    if (!t) { console.log('brak oferty w odpowiedzi'); continue; }
    const opis = await opisz(t);
    console.log(`po ~${Math.round((Date.now() - t0) / 1000)} s: `, opis);
    const bb = kaufland.zBuyboxa(await kaufland.buybox(t.id_product, rynek), t);
    if (Math.abs((bb.cena ?? 0) - z.cena) < 0.005) { console.log('Cena widoczna w rankingu Buy Boxa.'); break; }
  }
}

main(process.argv.slice(2)).then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
