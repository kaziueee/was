'use strict';

// Obserwacja ofert Allegro: nasza cena z tej samej listy /sale/offers, którą czyta synchronizacja (jedno
// pobranie na konto i przebieg, ~4 zapytania). Konkurencji API nie podaje (pricing/allegro.js); dają ją dwa
// źródła i bierzemy NOWSZE z nich:
//   - raport „Czynniki Top oferty” wgrany z ekranu (pricing/allegro-top.js) — cena Top oferty jak Buy Box,
//   - sprawdzenie w Niezbędniku dla ofert z automatem (pricing/konkurencja-allegro.js) — ceny konkurentów; cel
//     pod minimum wybiera worker (doModelu), bo pas min/max liczy się równolegle z obserwacją.
// Bez żadnego z nich — tylko nasza cena (model pilnuje minimum). Niezmieniony stan podbija tylko `widziana`
// w ostatnim wierszu (pricing/bez-zmian.js), zamiast dopisywać ~5000 wierszy co pół godziny.

const allegro = require('./allegro');
const { db } = require('./db');
const { takaSamaObserwacja } = require('./bez-zmian');
const { raportyTop, zRaportu } = require('./allegro-top');
const konkurencja = require('./konkurencja-allegro');

const zBazy = (s) => (s ? Date.parse(String(s).replace(' ', 'T') + 'Z') : 0);

// oferty: [{ id, sku, rynek, asin, tw_id, ean }] — `asin` = numer oferty Allegro, `rynek` = konto, `ean` z GT (Niezbędnik).
// surowe: oferty z allegro.wszystkieOferty(konto), z polem `_konto` (może być kilka kont naraz).
const klucz = (konto, id) => `${konto}|${id}`;
async function obserwujAllegro(oferty, surowe) {
  const poId = new Map((surowe || []).map((o) => [klucz(o._konto, o.id), o]));
  const top = raportyTop();
  const konk = konkurencja.wyniki();
  const nasze = konkurencja.naszeKonta();
  const teraz = Date.now();
  const zapisz = db.prepare(`INSERT INTO obserwacje (oferta_id, cena, wysylka, bb_nasz, bb_cena, bb_fba, najtansza_inna, ofert, bb_nasza_inna)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const ostatnia = db.prepare('SELECT * FROM obserwacje WHERE oferta_id = ? ORDER BY id DESC LIMIT 1');
  const widziana = db.prepare('UPDATE obserwacje SET widziana = CURRENT_TIMESTAMP WHERE id = ?');
  const b = (v) => (v == null ? null : v ? 1 : 0);
  // Nasze oferty tego samego towaru (drugie konto, duplikaty SKU) — raport Top nie mówi, kto ma Top; równa cena = my.
  const cenaOferty = new Map(), poTw = new Map();
  for (const o of oferty) {
    const s = poId.get(klucz(o.rynek, o.asin));
    if (!s) continue;
    const c = allegro.doOferty(s).cena;
    cenaOferty.set(o.id, c);
    if (o.tw_id != null && c > 0) (poTw.get(o.tw_id) || poTw.set(o.tw_id, []).get(o.tw_id)).push({ id: o.id, c });
  }
  const wynik = new Map();
  let nowe = 0;
  db.exec('BEGIN');
  try {
    for (const o of oferty) {
      const surowa = poId.get(klucz(o.rynek, o.asin));
      if (!surowa) continue;
      const cena = cenaOferty.get(o.id);
      const wTop = top.get(klucz(o.rynek, o.asin));
      const inne = (poTw.get(o.tw_id) || []).filter((x) => x.id !== o.id).map((x) => x.c);
      const zTop = zRaportu(wTop, cena, teraz, undefined, inne);
      const zNsp = o.ean ? konkurencja.zNiezbednika(konk.get(o.ean), cena, nasze, teraz) : null;
      const obs = (zTop && zNsp ? (zBazy(wTop.raport_czas) > zBazy(zNsp.czas) ? zTop : zNsp) : zTop || zNsp) || allegro.zOferty(surowa);
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
