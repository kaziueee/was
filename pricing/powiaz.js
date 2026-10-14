'use strict';

// Ręczne powiązanie SKU oferty z towarem GT z linii poleceń (to samo robi zakładka
// „Do powiązania" na ekranie Ceny w WMS).
//   node pricing/powiaz.js <sku> <symbol GT lub EAN>      — powiąż (nadpisuje poprzednie)
//   node pricing/powiaz.js <sku> --usun                    — wróć do automatycznego dopasowania
//   node pricing/powiaz.js --lista                         — oferty bez towaru GT + ręczne powiązania

const { db } = require('./db');
const { znajdzTowar, powiaz, usunPowiazanie } = require('./powiazania');

const PLATFORMA = 'amazon';
const KTO = process.env.USERNAME || process.env.USER || null;

async function main([sku, cel]) {
  if (sku === '--lista') {
    console.log('Bez towaru GT:');
    console.table(db.prepare(`SELECT rynek, sku, nazwa FROM oferty WHERE platforma = ? AND aktywna = 1 AND tw_id IS NULL ORDER BY sku, rynek`).all(PLATFORMA));
    console.log('Powiązane ręcznie:');
    console.table(db.prepare(`SELECT sku, symbol_gt, tw_id, kto, czas FROM powiazania WHERE platforma = ? ORDER BY sku`).all(PLATFORMA));
    return;
  }
  if (!sku || !cel) throw new Error('Użycie: node pricing/powiaz.js <sku> <symbol GT | EAN> | --usun | --lista');

  if (cel === '--usun') {
    usunPowiazanie(PLATFORMA, sku, KTO);
    console.log(`Usunięto ręczne powiązanie ${sku} — następna synchronizacja dopasuje automatycznie.`);
    return;
  }
  const t = await znajdzTowar(cel);
  const n = powiaz(PLATFORMA, sku, t, KTO);
  console.log(`${sku} → ${t.tw_Symbol} (${t.tw_Nazwa}), tw_Id ${t.tw_Id}; zaktualizowano ofert: ${n}`);
}

main(process.argv.slice(2)).then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
