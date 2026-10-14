'use strict';

// Obserwacja ofert eMAG RO: nasza cena, Buy Box („buy button") i cena zwycięzcy — wszystko z tej
// samej listy product_offer/read, którą czyta synchronizacja (jedno pobranie na przebieg, ~32
// zapytania). Zapisujemy obserwacje tylko podanych ofert, tak jak przy Amazonie.
//
// Obserwacja idzie w KAŻDYM przebiegu (darmowa — lista i tak jest pobrana), więc niezmieniony stan
// nie dostaje nowego wiersza, tylko `widziana` w ostatnim (pricing/bez-zmian.js).

const emag = require('./emag');
const { db } = require('./db');
const { takaSamaObserwacja } = require('./bez-zmian');

// oferty: [{ id, sku }]; surowe: wynik emag.wszystkieOferty() (gdy null — pobieramy)
async function obserwujEmag(oferty, surowe = null) {
  const lista = surowe || await emag.wszystkieOferty();
  const poSku = new Map(lista.map((o) => [String(o.part_number || '').trim().toUpperCase(), o]));
  const zapisz = db.prepare(`INSERT INTO obserwacje (oferta_id, cena, wysylka, bb_nasz, bb_cena, bb_fba, najtansza_inna, ofert, bb_nasza_inna)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const ostatnia = db.prepare('SELECT * FROM obserwacje WHERE oferta_id = ? ORDER BY id DESC LIMIT 1');
  const widziana = db.prepare('UPDATE obserwacje SET widziana = CURRENT_TIMESTAMP WHERE id = ?');
  const b = (v) => (v == null ? null : v ? 1 : 0);
  const wynik = new Map();
  let nowe = 0;
  db.exec('BEGIN');
  try {
    for (const o of oferty) {
      const surowa = poSku.get(String(o.sku).trim().toUpperCase());
      if (!surowa) continue;
      const obs = emag.zOferty(surowa);
      wynik.set(o.id, obs);
      const w = { cena: obs.cena, wysylka: obs.wysylka, bb_nasz: b(obs.bbNasz), bb_cena: obs.bbCena, bb_fba: b(obs.bbFba),
        najtansza_inna: obs.najtanszaInna, ofert: obs.ofert, bb_nasza_inna: b(obs.bbInnaNasza) };
      const prev = ostatnia.get(o.id);
      if (takaSamaObserwacja(prev, w)) { widziana.run(prev.id); continue; }
      zapisz.run(o.id, w.cena, w.wysylka, w.bb_nasz, w.bb_cena, w.bb_fba, w.najtansza_inna, w.ofert, w.bb_nasza_inna);
      nowe++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  wynik.nowe = nowe;
  return wynik;
}

module.exports = { obserwujEmag };
