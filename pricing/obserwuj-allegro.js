'use strict';

// Obserwacja ofert Allegro: nasza cena z tej samej listy /sale/offers, którą czyta synchronizacja (jedno
// pobranie na konto i przebieg, ~4 zapytania). Konkurencji API nie podaje (pricing/allegro.js), więc
// obserwacja to sama cena — i prawie zawsze ta sama: niezmieniony stan podbija tylko `widziana`
// w ostatnim wierszu (pricing/bez-zmian.js), zamiast dopisywać ~5000 wierszy co pół godziny.

const allegro = require('./allegro');
const { db } = require('./db');
const { takaSamaObserwacja } = require('./bez-zmian');

// oferty: [{ id, sku, rynek, asin }] — `asin` = numer oferty Allegro, `rynek` = konto.
// surowe: oferty z allegro.wszystkieOferty(konto), z polem `_konto` (może być kilka kont naraz).
const klucz = (konto, id) => `${konto}|${id}`;
async function obserwujAllegro(oferty, surowe) {
  const poId = new Map((surowe || []).map((o) => [klucz(o._konto, o.id), o]));
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
      const surowa = poId.get(klucz(o.rynek, o.asin));
      if (!surowa) continue;
      const obs = allegro.zOferty(surowa);
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

module.exports = { obserwujAllegro };
