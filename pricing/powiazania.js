'use strict';

// Ręczne powiązania SKU oferty z towarem GT — wspólne dla ekranu WMS (routes/ceny.js) i CLI
// (pricing/powiaz.js). Powiązanie jest per SKU (wszystkie rynki naraz), wygrywa z automatycznym
// dopasowaniem i przeżywa każdą synchronizację listy ofert.
//
// PEWNE DOPASOWANIE (decyzja usera 2026-10-14): automat cen wolno włączyć tylko na ofercie
// dopasowanej „wprost" (SKU = symbol GT) albo „ręcznie" (potwierdzone przez człowieka).
// Dopasowanie „po obcięciu dopisku" (-1/-2/-DE) bywa złe: NERE9533-1/-2 to NERE9533FFP, nie
// NERE9533 — automat liczyłby minimum i zysk od kosztu innego towaru.

const { db } = require('./db');
const { query } = require('../services/gt-sql');

const PEWNE = ['wprost', 'reczne'];
const pewneDopasowanie = (dopasowanie) => PEWNE.includes(dopasowanie);

// kod = symbol GT albo EAN → { tw_Id, tw_Symbol, tw_Nazwa }; błąd, gdy brak albo niejednoznaczny.
async function znajdzTowar(kod) {
  const k = String(kod || '').trim();
  if (!k) throw new Error('Podaj symbol GT albo EAN');
  const r = await query('SELECT tw_Id, tw_Symbol, tw_Nazwa FROM tw__Towar WHERE tw_Symbol = @k OR tw_PodstKodKresk = @k', { k });
  if (r.recordset.length > 1) throw new Error(`„${k}” pasuje do ${r.recordset.length} towarów — podaj symbol`);
  if (!r.recordset.length) throw new Error(`Nie ma w GT towaru „${k}”`);
  const t = r.recordset[0];
  return { tw_Id: t.tw_Id, tw_Symbol: String(t.tw_Symbol).trim(), tw_Nazwa: String(t.tw_Nazwa || '').trim() };
}

// Zapis powiązania SKU → towar (nadpisuje poprzednie) i natychmiastowa aktualizacja ofert.
function powiaz(platforma, sku, towar, kto) {
  db.exec('BEGIN');
  try {
    db.prepare(`INSERT INTO powiazania (platforma, sku, tw_id, symbol_gt, kto) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (platforma, sku) DO UPDATE SET tw_id = excluded.tw_id, symbol_gt = excluded.symbol_gt,
                kto = excluded.kto, czas = CURRENT_TIMESTAMP`).run(platforma, sku, towar.tw_Id, towar.tw_Symbol, kto || null);
    const oferty = db.prepare('SELECT id, rynek, tw_id, auto FROM oferty WHERE platforma = ? AND sku = ?').all(platforma, sku);
    for (const o of oferty) {
      // Zmiana towaru = inny koszt i inne minimum — automat wyłączamy, człowiek włączy go świadomie.
      const innyTowar = o.tw_id !== towar.tw_Id;
      db.prepare("UPDATE oferty SET tw_id = ?, symbol_gt = ?, dopasowanie = 'reczne', auto = ? WHERE id = ?")
        .run(towar.tw_Id, towar.tw_Symbol, innyTowar ? 0 : o.auto, o.id);
      db.prepare('INSERT INTO zmiany (kto, oferta_id, akcja, opis) VALUES (?, ?, ?, ?)').run(kto || null, o.id,
        innyTowar ? 'powiazanie' : 'powiazanie_potw',
        `${o.rynek} ${sku} → ${towar.tw_Symbol}${innyTowar && o.auto ? ' (automat wyłączony — inny towar)' : ''}`);
    }
    db.exec('COMMIT');
    return oferty.length;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Usunięcie ręcznego powiązania — oferty wracają do dopasowania automatycznego przy następnej
// synchronizacji; do tego czasu są bez towaru (i bez automatu).
function usunPowiazanie(platforma, sku, kto) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM powiazania WHERE platforma = ? AND sku = ?').run(platforma, sku);
    const oferty = db.prepare("SELECT id, rynek FROM oferty WHERE platforma = ? AND sku = ? AND dopasowanie = 'reczne'").all(platforma, sku);
    for (const o of oferty) {
      db.prepare('UPDATE oferty SET tw_id = NULL, symbol_gt = NULL, dopasowanie = NULL, auto = 0 WHERE id = ?').run(o.id);
      db.prepare('INSERT INTO zmiany (kto, oferta_id, akcja, opis) VALUES (?, ?, ?, ?)').run(kto || null, o.id, 'powiazanie_usun', `${o.rynek} ${sku}`);
    }
    db.exec('COMMIT');
    return oferty.length;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { PEWNE, pewneDopasowanie, znajdzTowar, powiaz, usunPowiazanie };
