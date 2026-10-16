'use strict';

// Ręczna zmiana ceny jednej oferty Allegro — do testu zapisu i do korekt (automat na Allegro jest wyłączony:
// kanał `tylkoOdczyt`). Bez --zapisz tylko pokazuje, co by wysłał. Cena BRUTTO w PLN.
//   node pricing/allegro-cena.js <KONTO> <SKU albo numer oferty> <cena>             — podgląd
//   node pricing/allegro-cena.js <KONTO> <SKU albo numer oferty> <cena> --zapisz    — wysyła i czyta ofertę ponownie
//
// Zapis zostawia ślad jak korekta z ekranu: decyzja `korekta` (wyslano = 1) i wpis w `zmiany`.

require('../config/env');
const allegro = require('./allegro');
const { db } = require('./db');

const KTO = process.env.PRICING_KTO || process.env.USERNAME || process.env.USER || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function opisz(s) {
  const o = allegro.doOferty(s);
  const reg = o.regula ? `, REGUŁA CENOWA ALLEGRO ${o.regula}` : '';
  const zagr = Object.entries(s.additionalMarketplaces || {}).map(([k, v]) => `${k.replace('allegro-', '')} ${v?.sellingMode?.price?.amount ?? '—'} ${v?.sellingMode?.price?.currency ?? ''}${v?.sellingMode?.priceAutomation ? ' (reguła)' : ''}`).join(', ');
  return `${o.sku} (oferta ${o.id}): ${o.cena ?? '—'} zł, stan ${o.ilosc}, sprzedane 30 dni ${o.sprzedane30}${reg}${zagr ? `\n        inne rynki: ${zagr}` : ''}`;
}

async function znajdz(konto, kod) {
  if (/^\d{8,}$/.test(kod)) {
    const o = await allegro.ofertaPoId(konto, kod);
    return o ? [o] : [];
  }
  const s = await allegro.api(konto, '/sale/offers', { query: { 'external.id': kod, 'publication.status': 'ACTIVE', limit: 50 } });
  return ((s && s.offers) || []).filter((o) => String(o?.external?.id || '').trim().toUpperCase() === kod.toUpperCase()).map((o) => ({ ...o, _konto: konto }));
}

async function main([kontoArg, kod, cena, flaga]) {
  const konto = String(kontoArg || '').toUpperCase();
  if (!allegro.KONTA[konto] || !kod || !(Number(cena) > 0)) {
    throw new Error(`Użycie: node pricing/allegro-cena.js <${Object.keys(allegro.KONTA).join('|')}> <SKU|numer oferty> <cena brutto zł> [--zapisz]`);
  }
  const lista = await znajdz(konto, String(kod).trim());
  if (lista.length !== 1) throw new Error(`${kod}: ${lista.length} aktywnych ofert na ${konto} — podaj numer oferty${lista.length ? ` (${lista.map((o) => o.id).join(', ')})` : ''}`);
  const s = lista[0];
  console.log('Teraz: ', opisz(s));
  const z = allegro.zmianaCeny(s, cena);
  if (z.blad) throw new Error(z.blad);
  console.log(`Wyślę: PATCH /sale/product-offers/${s.id} ${JSON.stringify(z.body)}`);
  if (flaga !== '--zapisz') { console.log('Podgląd — nic nie wysłano (dodaj --zapisz).'); return; }

  const przed = allegro.doOferty(s).cena;
  const t0 = Date.now();
  const w = await allegro.ustawCene(s, cena);
  const of = db.prepare("SELECT id FROM oferty WHERE platforma = 'allegro' AND rynek = ? AND asin = ?").get(konto, String(s.id));
  if (of) {
    db.prepare(`INSERT INTO decyzje (oferta_id, cena_przed, cena_nowa, cena_cel, kod, powod, wyslano, auto, blad)
                VALUES (?, ?, ?, ?, 'korekta', ?, ?, 0, ?)`)
      .run(of.id, przed, z.cena, z.cena, `ręczna zmiana ceny (${KTO || 'CLI'})`, w.ok ? 1 : 0, w.ok ? null : w.blad);
    if (w.ok) db.prepare("INSERT INTO zmiany (kto, oferta_id, akcja, opis) VALUES (?, ?, 'korekta_ceny', ?)")
      .run(KTO, of.id, `${konto} ${allegro.doOferty(s).sku}: ${przed} → ${z.cena}`);
  }
  if (!w.ok) throw new Error(`Allegro odrzuciło: ${w.blad}`);
  console.log(`Allegro przyjęło zapis po ${((Date.now() - t0) / 1000).toFixed(1)} s${w.asynchronicznie ? ' (jeszcze przetwarza)' : ''}. Czytam ofertę ponownie…`);
  for (const czekaj of [3, 15, 45]) {
    await sleep(czekaj * 1000);
    const t = await allegro.ofertaPoId(konto, s.id);
    console.log(`po ~${Math.round((Date.now() - t0) / 1000)} s: `, t ? opisz(t) : 'brak oferty w odpowiedzi');
    if (t && Math.abs(allegro.doOferty(t).cena - z.cena) < 0.005) break;
  }
}

main(process.argv.slice(2)).then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
