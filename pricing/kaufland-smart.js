'use strict';

// Wyłączenie Smart Pricing Kauflandu na wszystkich ofertach storefrontu, na których działa (minimum < cena).
// Cena i minimum = cena, za którą oferta stoi TERAZ — klient nie widzi zmiany, a dalej cenę ustawia tylko
// repricer (pricing/kaufland.js wylaczenieSmartPricing). Bez --zapisz tylko podgląd.
//   node pricing/kaufland-smart.js [--rynek DE]            — lista ofert z działającym Smart Pricing i co by poszło
//   node pricing/kaufland-smart.js [--rynek DE] --zapisz   — wysyła i po chwili czyta oferty jeszcze raz
//
// Każda wysłana zmiana zostawia ślad jak korekta z ekranu: decyzja `korekta` i wpis `smart_pricing_wyl` w `zmiany`.

require('../config/env');
const kaufland = require('./kaufland');
const { db } = require('./db');

const KTO = process.env.PRICING_KTO || process.env.USERNAME || process.env.USER || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eur = (c) => (c == null ? '—' : (c / 100).toFixed(2));

async function main(argv) {
  const i = argv.indexOf('--rynek');
  const rynek = i >= 0 ? String(argv[i + 1] || '').toUpperCase() : 'DE';
  if (!kaufland.STOREFRONTY[rynek]) throw new Error(`Nieznany storefront ${rynek}`);
  const zapisz = argv.includes('--zapisz');
  const lista = (await kaufland.wszystkieUnits(rynek)).filter(kaufland.smartPricing);
  console.log(`Kaufland ${rynek}: Smart Pricing działa na ${lista.length} ofertach`);
  console.log('SKU               status     live  stan  cena    minimum  sprzedaje  →  nowa cena = minimum');
  for (const u of lista) {
    const z = kaufland.wylaczenieSmartPricing(u);
    console.log(`${String(u.id_offer).padEnd(17)} ${u.status.padEnd(10)} ${String(u.is_live).padEnd(5)} ${String(u.amount).padStart(4)}  `
      + `${eur(u.listing_price).padStart(6)}  ${eur(u.minimum_price).padStart(7)}  ${eur(u.price).padStart(9)}  →  ${z.blad ? `BŁĄD: ${z.blad}` : z.cena.toFixed(2)}`);
  }
  if (!zapisz) { console.log('Podgląd — nic nie wysłano (dodaj --zapisz).'); return; }

  const oferta = db.prepare("SELECT id FROM oferty WHERE platforma = 'kaufland' AND rynek = ? AND sku = ?");
  const decyzja = db.prepare(`INSERT INTO decyzje (oferta_id, cena_przed, cena_nowa, cena_cel, kod, powod, wyslano, auto, blad)
                              VALUES (?, ?, ?, ?, 'korekta', ?, ?, 0, ?)`);
  const zmiana = db.prepare("INSERT INTO zmiany (kto, oferta_id, akcja, opis) VALUES (?, ?, 'smart_pricing_wyl', ?)");
  let ok = 0;
  for (const u of lista) {
    const z = kaufland.wylaczenieSmartPricing(u);
    const w = z.blad ? { ok: false, blad: z.blad } : await kaufland.ustawCene(u, z.cena, z);
    const of = oferta.get(rynek, u.id_offer);
    const przed = (u.price ?? u.listing_price) / 100;
    if (of) {
      decyzja.run(of.id, przed, z.cena ?? null, z.cena ?? null, `wyłączenie Smart Pricing Kaufland (${KTO || 'CLI'}): cena ${eur(u.listing_price)}, minimum ${eur(u.minimum_price)} → ${z.cena}`,
        w.ok ? 1 : 0, w.ok ? null : w.blad);
      if (w.ok) zmiana.run(KTO, of.id, `Kaufland ${rynek} ${u.id_offer}: cena ${eur(u.listing_price)} / minimum ${eur(u.minimum_price)} → ${z.cena} / ${z.cena}`);
    }
    console.log(`${u.id_offer}: ${w.ok ? `OK (cena ${w.listing}, minimum ${w.minimum})` : `ODRZUCONE: ${w.blad}`}`);
    if (w.ok) ok++;
    await sleep(200);
  }
  console.log(`Wysłano ${ok} z ${lista.length}. Czytam oferty ponownie za 2 min…`);
  await sleep(120_000);
  const po = (await kaufland.wszystkieUnits(rynek)).filter((u) => lista.some((x) => x.id_unit === u.id_unit));
  for (const u of po) console.log(`${String(u.id_offer).padEnd(17)} cena ${eur(u.listing_price)}  minimum ${eur(u.minimum_price)}  sprzedaje ${eur(u.price)}  Smart Pricing ${kaufland.smartPricing(u) ? 'NADAL DZIAŁA' : 'wyłączony'}`);
}

main(process.argv.slice(2)).then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
