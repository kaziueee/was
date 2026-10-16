'use strict';

// Podgląd i ręczna zmiana ceny jednej oferty Empik — do testu zapisu i do korekt (worker robi to sam
// przy automacie, ale kanał jest na razie tylko do odczytu). Cena BRUTTO w zł.
//   node pricing/empik-cena.js <SKU>                       — oferta, wszystkie oferty produktu (P11), nasz „Buy Box”
//   node pricing/empik-cena.js <SKU> <cena>                — j.w. + plik, który poszedłby do Empiku
//   node pricing/empik-cena.js <SKU> <cena> --zapisz       — wysyła (PRI01), czeka na status importu (PRI02)
//                                                            i czyta P11, aż nowa cena się pokaże (do ~15 min)
//
// Zapis zostawia ślad jak korekta z ekranu: decyzja `korekta` (wyslano = 1) i wpis w `zmiany`.

require('../config/env');
const empik = require('./empik');
const { db } = require('./db');
const { naszSklep } = require('./obserwuj-empik');

const KTO = process.env.PRICING_KTO || process.env.USERNAME || process.env.USER || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function opiszOferte(s) {
  return `${s.shop_sku} (offer_id ${s.offer_id}, produkt ${s.product_sku}): cena ${empik.cenaOferty(s)} zł, `
    + `dostawa od ${s.min_shipping_price ?? '?'} zł, stan ${s.quantity}, ${s.active ? 'aktywna' : 'NIEAKTYWNA'}`
    + `${empik.promocja(s) ? `, ⚠ ${empik.promocja(s)}` : ''} — ${s.product_title || ''}`;
}

async function konkurencja(s, sklep) {
  const p11 = await empik.ofertyProduktow([s.product_sku]);
  const oferty = p11.get(String(s.product_sku)) || [];
  console.log(`P11: ${oferty.length} aktywnych ofert na produkcie (kolejność Mirakl):`);
  console.table(oferty.map((o) => ({ sklep: o.shop_name, shop_id: o.shop_id, offer_id: o.offer_id, cena: empik.cenaOferty(o),
    dostawa: o.min_shipping_price, laczna: empik.cenaLaczna(o), stan: o.quantity })));
  const ob = empik.obserwacja(oferty, { offerId: s.offer_id, sklep });
  console.log('Obserwacja:', ob ? JSON.stringify(ob) : 'naszej oferty nie ma wśród aktywnych ofert produktu');
  console.log('Karta produktu (porównaj ofertę na górze z P11):', empik.linkiOferty(s.product_sku)?.produkt || '?');
  return ob;
}

async function main([sku, cena, flaga]) {
  if (!sku) throw new Error('Użycie: node pricing/empik-cena.js <SKU> [<cena brutto zł> [--zapisz]]');
  const sklep = await naszSklep();
  console.log(`Nasz sklep: ${sklep.nazwa} (shop_id ${sklep.id})`);
  const lista = await empik.ofertaPoSku(sku);
  if (lista.length !== 1) throw new Error(`SKU ${sku}: ${lista.length} ofert na Empiku — oczekiwano dokładnie jednej`);
  const s = lista[0];
  console.log('Teraz:', opiszOferte(s));
  const przed = await konkurencja(s, sklep);
  if (cena == null) return;

  const z = empik.zmianaCeny(s, cena);
  if (z.blad) throw new Error(z.blad);
  console.log(`Wyślę (PRI01):\n${empik.plikCen([z])}`);
  if (flaga !== '--zapisz') { console.log('Podgląd — nic nie wysłano (dodaj --zapisz).'); return; }

  const w = await empik.ustawCeny([{ surowa: s, cena }]);
  const r = w.wyniki[0];
  const of = db.prepare("SELECT id FROM oferty WHERE platforma = 'empik' AND rynek = 'PL' AND sku = ?").get(s.shop_sku);
  if (of) {
    db.prepare(`INSERT INTO decyzje (oferta_id, cena_przed, cena_nowa, cena_cel, kod, powod, wyslano, auto, blad)
                VALUES (?, ?, ?, ?, 'korekta', ?, ?, 0, ?)`)
      .run(of.id, empik.cenaOferty(s), z.cena, z.cena, `ręczna zmiana ceny (${KTO || 'CLI'}, import ${w.importId ?? '—'})`, r.ok ? 1 : 0, r.ok ? null : r.blad);
    if (r.ok) db.prepare("INSERT INTO zmiany (kto, oferta_id, akcja, opis) VALUES (?, ?, 'korekta_ceny', ?)")
      .run(KTO, of.id, `PL ${s.shop_sku}: ${empik.cenaOferty(s)} → ${z.cena}`);
  }
  if (!r.ok) throw new Error(`Empik nie przyjął pliku: ${r.blad}`);
  console.log(`Empik przyjął plik, import ${w.importId}. Czekam na status (PRI02, najwyżej raz na minutę)…`);
  const t0 = Date.now();
  const odStartu = () => `${Math.round((Date.now() - t0) / 1000)} s`;
  let st = null;
  for (let i = 0; i < 15; i++) {
    await sleep(65_000);
    st = await empik.statusImportu(w.importId);
    console.log(`po ${odStartu()}: import ${st ? `${st.status}${st.powod ? ` (${st.powod})` : ''}, zmienione ${st.zmienione}, błędne linie ${st.bledy}` : 'brak statusu'}`);
    if (st && ['COMPLETE', 'FAILED'].includes(st.status)) break;
  }
  if (st?.raport) { await sleep(65_000); console.log('Raport błędów (PRI03):\n' + await empik.raportBledow(w.importId)); }
  for (let i = 0; i < 12; i++) {
    const ob = await konkurencja((await empik.ofertaPoSku(sku))[0] || s, sklep);
    console.log(`po ${odStartu()}: cena w P11 ${ob?.cena ?? '?'} (było ${przed?.cena ?? '?'}, wysłano ${z.cena})`);
    if (ob && Math.abs(ob.cena - z.cena) < 0.005) break;
    await sleep(60_000);
  }
}

main(process.argv.slice(2)).then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
