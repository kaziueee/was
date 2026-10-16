'use strict';

// Synchronizacja listy ofert Empik (OF21) do db/pricing.db: platforma 'empik', rynek 'PL'. Czyta Empik
// i GT (ceny zmienia worker, nie synchronizacja). Zasady jak Amazon i eMAG (pricing/sync-oferty.js,
// pricing/sync-emag.js): nowe oferty wchodzą z automatem wyłączonym, ręczne powiązanie wygrywa
// z automatycznym dopasowaniem, oferta znikająca z listy dostaje aktywna = 0 (historia zostaje).
// Nieaktywne oferty Empik (active = false, np. stan 0) zapisujemy z aktywna = 0 — karta SKU pokaże,
// że oferta istnieje. Numer produktu Empik (product_sku) idzie do kolumny `asin` (link, P11).
//
// `surowe` = wynik empik.wszystkieOferty(), gdy worker już go ma.
//
// Uruchomienie: node pricing/sync-empik.js

require('dotenv').config({ quiet: true });
const empik = require('./empik');
const { db } = require('./db');
const { mapaKartoteki, przypisz } = require('./sync-oferty');

async function synchronizujEmpik(surowe = null) {
  const lista = surowe || await empik.wszystkieOferty();
  const mapa = await mapaKartoteki();
  const reczne = new Map(db.prepare("SELECT sku, tw_id, symbol_gt FROM powiazania WHERE platforma = 'empik'").all()
    .map((p) => [String(p.sku).trim().toUpperCase(), p]));

  const upsert = db.prepare(`
    INSERT INTO oferty (platforma, rynek, sku, asin, tw_id, symbol_gt, dopasowanie, nazwa, cena, ilosc, kanal, aktywna, widziana)
    VALUES ('empik', 'PL', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (platforma, rynek, sku) DO UPDATE SET
      asin = excluded.asin, tw_id = excluded.tw_id, symbol_gt = excluded.symbol_gt, dopasowanie = excluded.dopasowanie, nazwa = excluded.nazwa,
      cena = excluded.cena, ilosc = excluded.ilosc, aktywna = excluded.aktywna, widziana = CURRENT_TIMESTAMP`);
  const wygas = db.prepare(`UPDATE oferty SET aktywna = 0 WHERE platforma = 'empik' AND rynek = 'PL' AND widziana < ?`);

  const start = db.prepare("SELECT strftime('%Y-%m-%d %H:%M:%S','now','-1 second') AS t").get().t;
  let aktywne = 0, dopasowane = 0, promocje = 0;
  const brak = [];
  db.exec('BEGIN');
  try {
    for (const surowa of lista) {
      const o = empik.doOferty(surowa);
      if (!o.sku) continue;
      const t = przypisz(o.sku, mapa, reczne);
      if (o.aktywna) {
        aktywne++;
        if (empik.promocja(surowa)) promocje++;
        if (t) dopasowane++; else brak.push(o.sku);
      }
      upsert.run(o.sku, o.produkt, t ? t.tw_Id : null, t ? t.tw_Symbol : null, t ? t.dopasowanie : null,
        o.nazwa, o.cena, o.ilosc, o.aktywna ? 1 : 0);
    }
    // Pusta lista = najpewniej awaria po stronie Empik, nie „wszystko zniknęło" — nie wygaszamy.
    const wygasle = lista.length ? wygas.run(start).changes : 0;
    db.exec('COMMIT');
    return { rynek: 'Empik', ofert: lista.length, aktywne, promocje, dopasowane, brak: brak.length, wygasle, przyklady_brak: brak.slice(0, 5).join(' ') };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { synchronizujEmpik };

if (require.main === module) {
  synchronizujEmpik()
    .then((p) => { console.table([p]); process.exit(0); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
