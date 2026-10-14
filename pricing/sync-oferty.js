'use strict';

// Synchronizacja listy naszych ofert Amazon (DE, FR, IT, ES, NL, PL) do db/pricing.db.
// Tylko odczyt z Amazona i GT. Nowe oferty wchodzą z WYŁĄCZONYM automatem (auto = 0) —
// włączenie to decyzja człowieka. Oferty, których nie ma już w raporcie, dostają aktywna = 0
// (wiersz zostaje, żeby nie zgubić historii obserwacji i decyzji).
//
// Uruchomienie: node pricing/sync-oferty.js [DE FR ...]

const amazon = require('./amazon');
const { db } = require('./db');
const { query } = require('../services/gt-sql');
const { dopasujSymbol } = require('./mapowanie');

async function mapaKartoteki() {
  const r = await query('SELECT tw_Id, tw_Symbol FROM tw__Towar');
  return new Map(r.recordset.map((t) => [String(t.tw_Symbol).trim().toUpperCase(), { tw_Id: t.tw_Id, tw_Symbol: t.tw_Symbol.trim() }]));
}

// Ręczne powiązanie wygrywa; potem automat (wprost / po obcięciu dopisku).
function przypisz(sku, mapa, reczne) {
  const r = reczne.get(String(sku).trim().toUpperCase());
  if (r) return { tw_Id: r.tw_id, tw_Symbol: r.symbol_gt, dopasowanie: 'reczne' };
  const t = dopasujSymbol(sku, mapa);
  return t ? { ...t, dopasowanie: t.wprost ? 'wprost' : 'obciete' } : null;
}

async function synchronizuj(rynki = Object.keys(amazon.RYNKI_AMAZON)) {
  const mapa = await mapaKartoteki();
  const reczne = new Map(db.prepare("SELECT sku, tw_id, symbol_gt FROM powiazania WHERE platforma = 'amazon'").all()
    .map((p) => [String(p.sku).trim().toUpperCase(), p]));
  const wyniki = await Promise.all(rynki.map(async (k) => ({ k, oferty: await amazon.aktywneOferty(k) })));

  const upsert = db.prepare(`
    INSERT INTO oferty (platforma, rynek, sku, asin, tw_id, symbol_gt, dopasowanie, nazwa, cena, ilosc, kanal, aktywna, widziana)
    VALUES ('amazon', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT (platforma, rynek, sku) DO UPDATE SET
      asin = excluded.asin, tw_id = excluded.tw_id, symbol_gt = excluded.symbol_gt, dopasowanie = excluded.dopasowanie, nazwa = excluded.nazwa,
      cena = excluded.cena, ilosc = excluded.ilosc, kanal = excluded.kanal, aktywna = 1, widziana = CURRENT_TIMESTAMP`);
  const wygas = db.prepare(`UPDATE oferty SET aktywna = 0 WHERE platforma = 'amazon' AND rynek = ? AND widziana < ?`);

  const podsumowanie = [];
  for (const { k, oferty } of wyniki) {
    const start = db.prepare("SELECT strftime('%Y-%m-%d %H:%M:%S','now','-1 second') AS t").get().t;
    let dopasowane = 0;
    const brak = [];
    db.exec('BEGIN');
    try {
      for (const o of oferty) {
        const t = przypisz(o.sku, mapa, reczne);
        if (t) dopasowane++; else brak.push(o.sku);
        upsert.run(k, o.sku, o.asin, t ? t.tw_Id : null, t ? t.tw_Symbol : null, t ? t.dopasowanie : null,
          o.nazwa, o.cena, o.ilosc, o.kanal);
      }
      // Pusty raport = najpewniej awaria po stronie Amazona, nie „wszystko zniknęło" — nie wygaszamy.
      const wygasle = oferty.length ? wygas.run(k, start).changes : 0;
      db.exec('COMMIT');
      podsumowanie.push({ rynek: k, ofert: oferty.length, dopasowane, brak: brak.length, wygasle, przyklady_brak: brak.slice(0, 5).join(' ') });
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return podsumowanie;
}

module.exports = { synchronizuj, mapaKartoteki, przypisz };

if (require.main === module) {
  const rynki = process.argv.slice(2).map((x) => x.toUpperCase()).filter((x) => amazon.RYNKI_AMAZON[x]);
  synchronizuj(rynki.length ? rynki : undefined)
    .then((p) => { console.table(p); process.exit(0); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
