'use strict';

// Synchronizacja listy ofert Kaufland (units) do db/pricing.db (platforma 'kaufland', rynek = storefront,
// np. DE). Czyta Kaufland i GT (ceny zmienia worker, nie synchronizacja). Zasady jak eMAG
// (pricing/sync-emag.js): nowe oferty wchodzą z automatem wyłączonym, ręczne powiązanie wygrywa
// z automatycznym dopasowaniem, oferta znikająca z listy dostaje aktywna = 0 (historia zostaje).
// Unit bez `id_offer` (naszego SKU) pomijamy — nie ma czego dopasować do GT.
//
// `surowe` = wynik kaufland.wszystkieUnits(rynek), gdy worker już go ma (obserwacja czyta tę samą listę).
//
// Uruchomienie: node pricing/sync-kaufland.js [DE]

const kaufland = require('./kaufland');
const { db } = require('./db');
const { mapaKartoteki, przypisz } = require('./sync-oferty');

async function synchronizujKaufland(surowe = null, rynek = 'DE') {
  const lista = surowe || await kaufland.wszystkieUnits(rynek);
  const mapa = await mapaKartoteki();
  const reczne = new Map(db.prepare("SELECT sku, tw_id, symbol_gt FROM powiazania WHERE platforma = 'kaufland'").all()
    .map((p) => [String(p.sku).trim().toUpperCase(), p]));

  // Kaufland zdejmuje ofertę, gdy cena „wymaga sprawdzenia” (jak „Invalid price” na eMAG) — powód
  // pobieramy tylko dla ofert ze stanem, które nie są live (/units/status jest do zapytań na żądanie).
  const nieLive = lista.filter((u) => u.status === 'AVAILABLE' && u.is_live === false && Number(u.amount) > 0).map((u) => u.id_unit);
  let powody = new Map();
  if (nieLive.length) {
    try { powody = await kaufland.powodyNieLive(nieLive.slice(0, 200), rynek); } catch (e) {
      console.error(new Date().toISOString(), `[pricing] Kaufland ${rynek} powody nie-live:`, e.message);
    }
  }

  const upsert = db.prepare(`
    INSERT INTO oferty (platforma, rynek, sku, asin, tw_id, symbol_gt, dopasowanie, nazwa, cena, ilosc, kanal, aktywna, blokada, widziana)
    VALUES ('kaufland', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (platforma, rynek, sku) DO UPDATE SET
      asin = excluded.asin, tw_id = excluded.tw_id, symbol_gt = excluded.symbol_gt, dopasowanie = excluded.dopasowanie, nazwa = excluded.nazwa,
      cena = excluded.cena, ilosc = excluded.ilosc, aktywna = excluded.aktywna, blokada = excluded.blokada,
      widziana = CURRENT_TIMESTAMP`);
  const wygas = db.prepare(`UPDATE oferty SET aktywna = 0 WHERE platforma = 'kaufland' AND rynek = ? AND widziana < ?`);

  const start = db.prepare("SELECT strftime('%Y-%m-%d %H:%M:%S','now','-1 second') AS t").get().t;
  let aktywne = 0, dopasowane = 0, blokady = 0, bezSku = 0, smart = 0, nieWidoczne = 0;
  const brak = [];
  db.exec('BEGIN');
  try {
    for (const u of lista) {
      const o = kaufland.doOferty(u);
      if (!o.sku) { bezSku++; continue; }
      const t = przypisz(o.sku, mapa, reczne);
      const blokada = kaufland.blokadaCeny(powody.get(u.id_unit));
      if (o.aktywna) {
        aktywne++;
        if (blokada) blokady++;
        if (o.smart) smart++;
        if (!o.live) nieWidoczne++;
        if (t) dopasowane++; else brak.push(o.sku);
      }
      upsert.run(rynek, o.sku, o.idProduktu, t ? t.tw_Id : null, t ? t.tw_Symbol : null, t ? t.dopasowanie : null,
        o.nazwa, o.cena, o.ilosc, o.aktywna ? 1 : 0, blokada);
    }
    // Pusta lista = najpewniej awaria po stronie Kauflandu, nie „wszystko zniknęło" — nie wygaszamy.
    const wygasle = lista.length ? wygas.run(rynek, start).changes : 0;
    db.exec('COMMIT');
    return { rynek: `Kaufland ${rynek}`, ofert: lista.length, aktywne, nie_widoczne: nieWidoczne, blokady, smart_pricing: smart,
      bez_sku: bezSku, dopasowane, brak: brak.length, wygasle, przyklady_brak: brak.slice(0, 5).join(' ') };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { synchronizujKaufland };

if (require.main === module) {
  synchronizujKaufland(null, String(process.argv[2] || 'DE').toUpperCase())
    .then((p) => { console.table([p]); process.exit(0); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
