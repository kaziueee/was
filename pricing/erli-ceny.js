'use strict';

// Pilnowanie ceny na Erli (zasada usera 2026-11-26): cena produktu na Erli = cena oferty Allegro ekajtek + 5% (w górę
// do ,99), w obie strony — tańsze podnosimy, droższe obniżamy. Logika: pricing/erli-model.js (korektaCeny, testy). Woła worker repricera co PRICING_ERLI_MIN (domyślnie 60 min, poza kolejką
// przebiegów) i agent (`node scripts/erli-wystaw.js --ceny [--zapisz]`).
//
// Dopasowanie: produkt Erli → oferta Allegro ekajtek po numerze oferty (externalId = nr oferty — tak wyglądają
// wszystkie kopie), a gdy tej oferty już nie ma — po SKU (aktywna oferta ekajtek z tym SKU; przy kilku: najstarsza,
// czyli ta trzymana pod gołym SKU w `oferty`). Ceny Allegro z bazy repricera (sync co przebieg).
//
// Pomijamy: zarchiwizowane, z zamrożoną ceną (ręczna edycja w panelu Erli — API i tak by jej nie zmieniło) i bez
// oferty Allegro. Erli ignoruje też zmianę ceny produktu w trwającej promocji — wtedy następny przebieg spróbuje znowu.

const { db } = require('./db');
const erli = require('./erli');
const em = require('./erli-model');

const KONTO = 'EKAJTEK';
const MAX_ZMIAN = 500;                // na przebieg (domyślnie) — reszta w następnym
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const zl = (gr) => (gr / 100).toFixed(2);
const golySku = (s) => String(s || '').split('/')[0].trim().toUpperCase();

function cenyAllegro() {
  const wiersze = db.prepare(`SELECT asin AS oferta, sku, cena FROM oferty
      WHERE platforma = 'allegro' AND rynek = ? AND aktywna = 1 AND cena > 0 AND asin IS NOT NULL`).all(KONTO);
  const poId = new Map(), poSku = new Map();
  for (const w of wiersze) {
    poId.set(String(w.oferta), w.cena);
    if (!w.sku.includes('/') || !poSku.has(golySku(w.sku))) poSku.set(golySku(w.sku), w.cena);
  }
  return { poId, poSku, n: wiersze.length };
}

// → { sprawdzone, ponizej, powyzej, zmienione, zamrozone, bezAllegro, bledy, lista: [{externalId, sku, bylo, bedzie, allegro}] }
async function pilnujCen({ zapisz = false, log = console.log, maxZmian = MAX_ZMIAN } = {}) {
  const al = cenyAllegro();
  if (al.n < 100) throw new Error(`w bazie repricera tylko ${al.n} aktywnych ofert Allegro ${KONTO} — sync niekompletny, nie pilnuję`);
  const produkty = await erli.wszystkieProdukty(['externalId', 'sku', 'price', 'status', 'archived', 'frozen']);
  const w = { sprawdzone: 0, ponizej: 0, powyzej: 0, zmienione: 0, zamrozone: 0, bezAllegro: 0, bledy: 0, lista: [] };
  const zmiana = db.prepare('INSERT INTO zmiany (kto, oferta_id, akcja, opis) VALUES (?, NULL, ?, ?)');
  for (const p of produkty) {
    if (p.archived) continue;
    const allegro = al.poId.get(String(p.externalId)) ?? al.poSku.get(golySku(p.sku));
    if (allegro == null) { w.bezAllegro++; continue; }
    w.sprawdzone++;
    const nowa = em.korektaCeny(p.price, allegro);
    if (nowa == null) continue;
    if (nowa > p.price) w.ponizej++; else w.powyzej++;
    const poz = { externalId: p.externalId, sku: p.sku, bylo: p.price, bedzie: nowa, allegro };
    if (p.frozen?.price) { w.zamrozone++; w.lista.push({ ...poz, uwaga: 'cena zamrożona w panelu Erli' }); continue; }
    w.lista.push(poz);
    if (!zapisz || w.zmienione >= maxZmian) continue;
    try {
      await erli.api('PATCH', `/products/${encodeURIComponent(p.externalId)}`, { body: { price: nowa }, proby: 2 });
      w.zmienione++;
      zmiana.run('system:erli-ceny', 'erli_cena', `erli PL ${p.sku} (${p.externalId}): ${zl(p.price)} → ${zl(nowa)} zł (Allegro ${allegro} + 5%)`);
      await sleep(250);
    } catch (e) {
      w.bledy++;
      poz.uwaga = e.message;
      log(`[erli-ceny] ${p.sku} ${p.externalId}: ${e.message}`);
    }
  }
  if (zapisz && w.ponizej + w.powyzej - w.zamrozone > maxZmian) log(`[erli-ceny] ${w.ponizej + w.powyzej} cen do zmiany — zmieniono ${w.zmienione}, reszta w następnym przebiegu`);
  return w;
}

module.exports = { pilnujCen, cenyAllegro, MAX_ZMIAN };
