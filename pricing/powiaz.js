'use strict';

// Ręczne powiązanie SKU oferty z towarem GT (do czasu ekranu w WMS).
//   node pricing/powiaz.js <sku> <symbol GT lub EAN>      — powiąż (nadpisuje poprzednie)
//   node pricing/powiaz.js <sku> --usun                    — wróć do automatycznego dopasowania
//   node pricing/powiaz.js --lista                         — oferty bez towaru GT + ręczne powiązania
// Zmiana działa od razu na istniejących ofertach i przeżywa każdą kolejną synchronizację listy.

const { db } = require('./db');
const { query } = require('../services/gt-sql');

const PLATFORMA = 'amazon';

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
    db.prepare('DELETE FROM powiazania WHERE platforma = ? AND sku = ?').run(PLATFORMA, sku);
    db.prepare("UPDATE oferty SET tw_id = NULL, symbol_gt = NULL, dopasowanie = NULL WHERE platforma = ? AND sku = ? AND dopasowanie = 'reczne'").run(PLATFORMA, sku);
    console.log(`Usunięto ręczne powiązanie ${sku} — następna synchronizacja dopasuje automatycznie.`);
    return;
  }

  const r = await query(`SELECT tw_Id, tw_Symbol, tw_Nazwa FROM tw__Towar WHERE tw_Symbol = @cel OR tw_PodstKodKresk = @cel`, { cel });
  if (r.recordset.length !== 1) throw new Error(r.recordset.length ? `„${cel}" pasuje do ${r.recordset.length} towarów — podaj symbol` : `Nie ma w GT towaru „${cel}"`);
  const t = r.recordset[0];
  const symbol = t.tw_Symbol.trim();
  db.prepare(`INSERT INTO powiazania (platforma, sku, tw_id, symbol_gt, kto) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT (platforma, sku) DO UPDATE SET tw_id = excluded.tw_id, symbol_gt = excluded.symbol_gt, kto = excluded.kto, czas = CURRENT_TIMESTAMP`)
    .run(PLATFORMA, sku, t.tw_Id, symbol, process.env.USER || null);
  const n = db.prepare("UPDATE oferty SET tw_id = ?, symbol_gt = ?, dopasowanie = 'reczne' WHERE platforma = ? AND sku = ?").run(t.tw_Id, symbol, PLATFORMA, sku).changes;
  console.log(`${sku} → ${symbol} (${t.tw_Nazwa.trim()}), tw_Id ${t.tw_Id}; zaktualizowano ofert: ${n}`);
}

main(process.argv.slice(2)).then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
