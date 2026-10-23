'use strict';

// Obserwacja ofert Kaufland: nasza cena, Buy Box i ceny konkurencji z rankingu GET /buybox (jedno
// zapytanie na produkt, kilka równolegle — limit Kauflandu to 111/s). Nasz unit (id_unit, cena,
// wysyłka) bierzemy z listy, którą czyta synchronizacja, więc tu dochodzą tylko rankingi.
//
// Obserwacja idzie w KAŻDYM przebiegu, więc niezmieniony stan nie dostaje nowego wiersza, tylko
// `widziana` w ostatnim (pricing/bez-zmian.js) — jak eMAG.

const kaufland = require('./kaufland');
const { db } = require('./db');
const { takaSamaObserwacja } = require('./bez-zmian');

const klucz = (rynek, sku) => `${String(rynek || 'DE').toUpperCase()}|${String(sku || '').trim().toUpperCase()}`;

// oferty: [{ id, sku, rynek }]; surowe: unity z kaufland.wszystkieUnits / unitPoSku (pole `_rynek`).
// naPostep — postęp pobierania rankingów (kaufland.buyboxyHurtem).
async function obserwujKaufland(oferty, surowe, { naPostep } = {}) {
  const poSku = new Map((surowe || []).map((u) => [klucz(u._rynek, u.id_offer), u]));
  const pary = [];
  for (const o of oferty) {
    const u = poSku.get(klucz(o.rynek, o.sku));
    if (u) pary.push({ o, u, rynek: o.rynek, idProduktu: u.id_product });
  }
  const rankingi = await kaufland.buyboxyHurtem(pary, { naPostep });

  const zapisz = db.prepare(`INSERT INTO obserwacje (oferta_id, cena, wysylka, bb_nasz, bb_cena, bb_fba, najtansza_inna, ofert, bb_nasza_inna)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const ostatnia = db.prepare('SELECT * FROM obserwacje WHERE oferta_id = ? ORDER BY id DESC LIMIT 1');
  const widziana = db.prepare('UPDATE obserwacje SET widziana = CURRENT_TIMESTAMP WHERE id = ?');
  const b = (v) => (v == null ? null : v ? 1 : 0);
  const wynik = new Map();
  let nowe = 0;
  db.exec('BEGIN');
  try {
    for (const { o, u, rynek, idProduktu } of pary) {
      const bb = rankingi.get(kaufland.kluczProduktu(rynek, idProduktu));
      if (!bb) continue;                                  // ranking nie przyszedł — bez obserwacji, bez decyzji
      const obs = kaufland.zBuyboxa(bb, u);
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
  if (rankingi.bledy) Object.assign(wynik, { bledy: rankingi.bledy, ostatniBlad: rankingi.ostatniBlad });
  return wynik;
}

module.exports = { obserwujKaufland };
