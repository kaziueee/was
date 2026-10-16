'use strict';

// Synchronizacja aktywnych ofert Allegro jednego konta do db/pricing.db (platforma 'allegro', rynek = konto:
// EKAJTEK / NATROPIE — pricing/allegro.js KONTA). Czyta Allegro i GT, cen nie zmienia. Zasady jak przy
// eMAG (pricing/sync-emag.js): nowe oferty wchodzą z automatem wyłączonym, ręczne powiązanie wygrywa
// z automatycznym dopasowaniem, oferta znikająca z listy dostaje aktywna = 0 (historia zostaje).
//
// Numer oferty Allegro siedzi w `asin`. SKU z kilkoma ofertami na koncie: klucz `SKU/numer` (allegro.kluczeOfert).
// Gdy pod tym samym kluczem pojawi się INNA oferta (np. zakończono najstarszą z duplikatów), automat się
// wyłącza — przełącznik dotyczył konkretnej oferty, nie SKU.
//
// `surowe` = wynik allegro.wszystkieOferty(konto), gdy worker już go ma (obserwacja czyta tę samą listę).
//
// Uruchomienie: node pricing/sync-allegro.js EKAJTEK|NATROPIE

const allegro = require('./allegro');
const { db } = require('./db');
const { mapaKartoteki, przypisz } = require('./sync-oferty');

async function synchronizujAllegro(konto, surowe = null) {
  const lista = surowe || await allegro.wszystkieOferty(konto);
  const mapa = await mapaKartoteki();
  const reczne = new Map(db.prepare("SELECT sku, tw_id, symbol_gt FROM powiazania WHERE platforma = 'allegro'").all()
    .map((p) => [String(p.sku).trim().toUpperCase(), p]));
  const klucz = allegro.kluczeOfert(lista);

  const upsert = db.prepare(`
    INSERT INTO oferty (platforma, rynek, sku, asin, tw_id, symbol_gt, dopasowanie, nazwa, cena, ilosc, kanal, aktywna, widziana)
    VALUES ('allegro', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, CURRENT_TIMESTAMP)
    ON CONFLICT (platforma, rynek, sku) DO UPDATE SET
      auto = CASE WHEN oferty.asin IS NOT excluded.asin THEN 0 ELSE oferty.auto END,
      asin = excluded.asin, tw_id = excluded.tw_id, symbol_gt = excluded.symbol_gt, dopasowanie = excluded.dopasowanie, nazwa = excluded.nazwa,
      cena = excluded.cena, ilosc = excluded.ilosc, aktywna = 1, widziana = CURRENT_TIMESTAMP`);
  const wygas = db.prepare(`UPDATE oferty SET aktywna = 0 WHERE platforma = 'allegro' AND rynek = ? AND widziana < ?`);

  const start = db.prepare("SELECT strftime('%Y-%m-%d %H:%M:%S','now','-1 second') AS t").get().t;
  let dopasowane = 0, regulyAllegro = 0, duplikaty = 0;
  const brak = [];
  db.exec('BEGIN');
  try {
    for (const surowa of lista) {
      const o = allegro.doOferty(surowa);
      const k = klucz(surowa);
      if (!k) continue;                            // oferta bez SKU (sygnatury) — nie dopasujemy do GT
      if (k !== o.sku) duplikaty++;
      if (o.regula) regulyAllegro++;
      // Ręczne powiązanie per klucz oferty (SKU/numer), potem po gołym SKU.
      const t = (reczne.has(k.toUpperCase()) ? przypisz(k, mapa, reczne) : null) || przypisz(o.sku, mapa, reczne);
      if (t) dopasowane++; else brak.push(o.sku);
      upsert.run(konto, k, o.id, t ? t.tw_Id : null, t ? t.tw_Symbol : null, t ? t.dopasowanie : null, o.nazwa, o.cena, o.ilosc);
    }
    // Pusta lista = najpewniej awaria po stronie Allegro, nie „wszystko zniknęło" — nie wygaszamy.
    const wygasle = lista.length ? wygas.run(konto, start).changes : 0;
    db.exec('COMMIT');
    return { rynek: `Allegro ${konto}`, ofert: lista.length, aktywne: lista.length, dopasowane, brak: brak.length, duplikaty,
      reguly_allegro: regulyAllegro, wygasle, przyklady_brak: brak.slice(0, 5).join(' ') };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { synchronizujAllegro };

if (require.main === module) {
  require('../config/env');
  const konto = String(process.argv[2] || '').toUpperCase();
  if (!allegro.KONTA[konto]) { console.error(`Użycie: node pricing/sync-allegro.js <${Object.keys(allegro.KONTA).join('|')}>`); process.exit(1); }
  synchronizujAllegro(konto)
    .then((p) => { console.table([p]); process.exit(0); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
