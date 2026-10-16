'use strict';

// Obserwacja ofert Empik: nasza cena, „Buy Box” (najlepsza oferta produktu po cenie łącznej) i najtańsza
// cudza oferta — z P11 (oferty wszystkich sklepów, 100 produktów na zapytanie, najwyżej 5 zapytań na
// minutę, więc ~13 s przerwy; 1000 produktów ≈ 2 min). Zapisujemy obserwacje tylko podanych ofert.
// Niezmieniony stan nie dostaje nowego wiersza, tylko `widziana` w ostatnim (pricing/bez-zmian.js).
//
// Naszą ofertę w P11 rozpoznaje empik.obserwacja() — po offer_id z OF21 (gdy mamy listę z tego
// przebiegu), inaczej po shop_id / nazwie sklepu z A01. A01 wolno wołać raz na dobę — trzymamy go w `stan`.

const empik = require('./empik');
const { db, stan } = require('./db');
const { takaSamaObserwacja } = require('./bez-zmian');
const { stawkiZapisane } = require('./empik-prowizje');

const DOBA_MS = 24 * 60 * 60 * 1000;

// Nasz sklep z A01, odświeżany raz na dobę. Gdy A01 nie odpowie, bierzemy ostatni znany (nawet stary).
async function naszSklep() {
  const s = stan.get('empik_sklep');
  let zapisany = null;
  try { zapisany = s ? JSON.parse(s.wartosc) : null; } catch { /* uszkodzony wpis = pobierz na nowo */ }
  if (zapisany && Date.now() - new Date(s.czas.replace(' ', 'T') + 'Z').getTime() < DOBA_MS) return zapisany;
  try {
    const nowy = await empik.sklep();
    stan.set('empik_sklep', JSON.stringify(nowy));
    return nowy;
  } catch (e) {
    if (zapisany) return zapisany;
    throw e;
  }
}

// oferty: [{ id, sku, asin (= product_sku Empik), prowizja }]; surowe: lista OF21 z tego przebiegu albo null.
// Przy okazji przypisuje ofercie stawkę prowizji jej kategorii (P11 podaje kategorię produktu) — używa jej
// minimum z kalkulatora od następnego przebiegu, tak jak stawek eMAG.
async function obserwujEmpik(oferty, { surowe = null, sklep = null } = {}) {
  const s = sklep || await naszSklep();
  const idPoSku = new Map((surowe || []).map((o) => [String(o.shop_sku || '').trim().toUpperCase(), o.offer_id]));
  const p11 = await empik.ofertyProduktow(oferty.map((o) => o.asin));
  const zapisz = db.prepare(`INSERT INTO obserwacje (oferta_id, cena, wysylka, bb_nasz, bb_cena, bb_fba, najtansza_inna, ofert, bb_nasza_inna)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const ostatnia = db.prepare('SELECT * FROM obserwacje WHERE oferta_id = ? ORDER BY id DESC LIMIT 1');
  const stawki = stawkiZapisane();
  const ustawProwizje = db.prepare('UPDATE oferty SET prowizja = ?, prowizja_czas = CURRENT_TIMESTAMP WHERE id = ?');
  const widziana = db.prepare('UPDATE obserwacje SET widziana = CURRENT_TIMESTAMP WHERE id = ?');
  const b = (v) => (v == null ? null : v ? 1 : 0);
  const wynik = new Map();
  let nowe = 0;
  db.exec('BEGIN');
  try {
    for (const o of oferty) {
      const stawka = stawki[p11.kategorie?.get(String(o.asin))]?.stawka;
      if (stawka > 0 && Math.abs(stawka - (o.prowizja || 0)) > 0.001) ustawProwizje.run(stawka, o.id);
      const obs = empik.obserwacja(p11.get(String(o.asin)), { offerId: idPoSku.get(String(o.sku).trim().toUpperCase()) ?? null, sklep: s });
      if (!obs) continue;                       // naszej oferty nie ma wśród aktywnych ofert produktu
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

module.exports = { obserwujEmpik, naszSklep };
