'use strict';

// Obserwacja ofert eMAG RO: nasza cena, Buy Box („buy button") i cena zwycięzcy — wszystko z tej
// samej listy product_offer/read, którą czyta synchronizacja (jedno pobranie na przebieg, ~32
// zapytania). Zapisujemy obserwacje tylko podanych ofert, tak jak przy Amazonie.

const emag = require('./emag');
const { db } = require('./db');

// oferty: [{ id, sku }]; surowe: wynik emag.wszystkieOferty() (gdy null — pobieramy)
async function obserwujEmag(oferty, surowe = null) {
  const lista = surowe || await emag.wszystkieOferty();
  const poSku = new Map(lista.map((o) => [String(o.part_number || '').trim().toUpperCase(), o]));
  const zapisz = db.prepare(`INSERT INTO obserwacje (oferta_id, cena, wysylka, bb_nasz, bb_cena, bb_fba, najtansza_inna, ofert, bb_nasza_inna)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const b = (v) => (v == null ? null : v ? 1 : 0);
  const wynik = new Map();
  db.exec('BEGIN');
  try {
    for (const o of oferty) {
      const surowa = poSku.get(String(o.sku).trim().toUpperCase());
      if (!surowa) continue;
      const obs = emag.zOferty(surowa);
      wynik.set(o.id, obs);
      zapisz.run(o.id, obs.cena, obs.wysylka, b(obs.bbNasz), obs.bbCena, b(obs.bbFba), obs.najtanszaInna, obs.ofert, b(obs.bbInnaNasza));
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return wynik;
}

module.exports = { obserwujEmag };
