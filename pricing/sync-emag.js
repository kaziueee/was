'use strict';

// Synchronizacja listy ofert eMAG RO do db/pricing.db (platforma 'emag', rynek 'RO'). Czyta eMAG
// i GT (ceny zmienia worker, nie synchronizacja). Te same zasady co Amazon (pricing/sync-oferty.js): nowe oferty wchodzą z automatem
// wyłączonym, ręczne powiązanie wygrywa z automatycznym dopasowaniem, oferta znikająca z listy
// dostaje aktywna = 0 (historia zostaje). Różnica: eMAG oddaje też oferty nieaktywne (status 0) —
// zapisujemy je z aktywna = 0, żeby karta SKU pokazała, że oferta istnieje, choć nie sprzedaje.
//
// `surowe` = wynik emag.wszystkieOferty(), gdy worker już go ma (obserwacja czyta tę samą listę).
//
// Uruchomienie: node pricing/sync-emag.js

const emag = require('./emag');
const { db } = require('./db');
const { mapaKartoteki, przypisz } = require('./sync-oferty');

async function synchronizujEmag(surowe = null) {
  const lista = surowe || await emag.wszystkieOferty();
  const mapa = await mapaKartoteki();
  const reczne = new Map(db.prepare("SELECT sku, tw_id, symbol_gt FROM powiazania WHERE platforma = 'emag'").all()
    .map((p) => [String(p.sku).trim().toUpperCase(), p]));

  const upsert = db.prepare(`
    INSERT INTO oferty (platforma, rynek, sku, asin, tw_id, symbol_gt, dopasowanie, nazwa, cena, ilosc, kanal, genius, aktywna, blokada, widziana)
    VALUES ('emag', 'RO', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (platforma, rynek, sku) DO UPDATE SET
      asin = excluded.asin, tw_id = excluded.tw_id, symbol_gt = excluded.symbol_gt, dopasowanie = excluded.dopasowanie, nazwa = excluded.nazwa,
      cena = excluded.cena, ilosc = excluded.ilosc, genius = excluded.genius, aktywna = excluded.aktywna, blokada = excluded.blokada,
      widziana = CURRENT_TIMESTAMP`);
  const wygas = db.prepare(`UPDATE oferty SET aktywna = 0 WHERE platforma = 'emag' AND rynek = 'RO' AND widziana < ?`);

  const start = db.prepare("SELECT strftime('%Y-%m-%d %H:%M:%S','now','-1 second') AS t").get().t;
  let aktywne = 0, dopasowane = 0, blokady = 0;
  const brak = [];
  db.exec('BEGIN');
  try {
    for (const surowa of lista) {
      const o = emag.doOferty(surowa);
      if (!o.sku) continue;
      const t = przypisz(o.sku, mapa, reczne);
      if (o.aktywna) {
        aktywne++;
        if (o.blokada) blokady++;
        if (t) dopasowane++; else brak.push(o.sku);
      }
      upsert.run(o.sku, o.pnk, t ? t.tw_Id : null, t ? t.tw_Symbol : null, t ? t.dopasowanie : null,
        o.nazwa, o.cena, o.ilosc, o.genius, o.aktywna ? 1 : 0, o.blokada);
    }
    // Pusta lista = najpewniej awaria po stronie eMAG, nie „wszystko zniknęło" — nie wygaszamy.
    const wygasle = lista.length ? wygas.run(start).changes : 0;
    db.exec('COMMIT');
    return { rynek: 'eMAG RO', ofert: lista.length, aktywne, blokady, dopasowane, brak: brak.length, wygasle, przyklady_brak: brak.slice(0, 5).join(' ') };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { synchronizujEmag };

if (require.main === module) {
  synchronizujEmag()
    .then((p) => { console.table([p]); process.exit(0); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
