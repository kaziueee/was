'use strict';

// Ręczna zmiana ceny jednej oferty eMAG (RO/HU/BG) — do testu zapisu i do korekt (worker robi to sam
// przy automacie). Bez --zapisz tylko pokazuje, co by wysłał. Cena brutto w walucie rynku.
//   node pricing/emag-cena.js <SKU> <cena brutto> [--kraj HU]            — podgląd
//   node pricing/emag-cena.js <SKU> <cena brutto> [--kraj HU] --zapisz   — wysyła i po chwili czyta ofertę
//
// Zapis zostawia ślad jak korekta z ekranu: decyzja `korekta` (wyslano = 1) i wpis w `zmiany`.

require('dotenv').config({ quiet: true });
const emag = require('./emag');
const { db } = require('./db');

const KTO = process.env.PRICING_KTO || process.env.USERNAME || process.env.USER || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function opisz(s) {
  const o = emag.zOferty(s);
  const b = (x) => (Number(x) > 0 ? emag.doOferty({ ...s, sale_price: x }).cena : '—');
  return `${s.part_number} (id ${s.id}, PNK ${s.part_number_key}): ${o.cena} brutto (netto ${s.sale_price}, ${s._kraj || 'RO'}), `
    + `Buy Box ${o.bbNasz ? 'NASZ' : o.bbNasz === false ? `INNY (${o.bbCena})` : '?'}, ofert ${o.ofert}, `
    + `zakres w eMAG ${b(s.min_sale_price)}–${b(s.max_sale_price)} brutto, status ${s.status}, stan ${s.general_stock}`;
}

async function main(argv) {
  // --kraj HU|BG (domyślnie RO); reszta: <SKU> <cena brutto w walucie rynku> [--zapisz]
  const i = argv.indexOf('--kraj');
  const kraj = i >= 0 ? String(argv[i + 1] || '').toUpperCase() : 'RO';
  const [sku, cena, flaga] = argv.filter((x, n) => n !== i && n !== i + 1);
  if (!emag.KRAJE[kraj] || !sku || !(Number(cena) > 0)) throw new Error('Użycie: node pricing/emag-cena.js <SKU> <cena brutto> [--kraj RO|HU|BG] [--zapisz]');
  const lista = await emag.ofertaPoSku(sku, kraj);
  if (lista.length !== 1) throw new Error(`SKU ${sku}: ${lista.length} ofert w eMAG — oczekiwano dokładnie jednej`);
  const s = lista[0];
  console.log('Teraz: ', opisz(s));
  const z = emag.zmianaCeny(s, cena);
  if (z.blad) throw new Error(z.blad);
  console.log(`Wyślę: ${JSON.stringify(z.body)}  (= ${z.cena} brutto, ${kraj})`);
  if (flaga !== '--zapisz') { console.log('Podgląd — nic nie wysłano (dodaj --zapisz).'); return; }

  const w = await emag.ustawCene(s, cena);
  const of = db.prepare("SELECT id FROM oferty WHERE platforma = 'emag' AND rynek = ? AND sku = ?").get(kraj, s.part_number);
  if (of) {
    db.prepare(`INSERT INTO decyzje (oferta_id, cena_przed, cena_nowa, cena_cel, kod, powod, wyslano, auto, blad)
                VALUES (?, ?, ?, ?, 'korekta', ?, ?, 0, ?)`)
      .run(of.id, emag.zOferty(s).cena, z.cena, z.cena, `ręczna zmiana ceny (${KTO || 'CLI'})`, w.ok ? 1 : 0, w.ok ? null : w.blad);
    if (w.ok) db.prepare("INSERT INTO zmiany (kto, oferta_id, akcja, opis) VALUES (?, ?, 'korekta_ceny', ?)")
      .run(KTO, of.id, `${kraj} ${s.part_number}: ${emag.zOferty(s).cena} → ${z.cena}`);
  }
  if (!w.ok) throw new Error(`eMAG odrzucił: ${w.blad}`);
  console.log('eMAG przyjął zapis. Czytam ofertę ponownie…');
  const t0 = Date.now();
  for (const czekaj of [5, 25, 30]) {
    await sleep(czekaj * 1000);
    const [t] = await emag.ofertaPoSku(sku, kraj);
    console.log(`po ~${Math.round((Date.now() - t0) / 1000)} s: `, t ? opisz(t) : 'brak oferty w odpowiedzi');
    if (t && Math.abs(Number(t.sale_price) - z.netto) < 0.00005) break;
  }
}

main(process.argv.slice(2)).then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
