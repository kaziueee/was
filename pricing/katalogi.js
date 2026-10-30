'use strict';

// Skan katalogów platform: czy nasz towar ze stanem ma na rynku gotową kartę produktu (po EAN-ie) → tabela `katalog`
// (pricing/db.js). TYLKO ODCZYT platform i GT. Uruchamia go worker raz na dobę w nocy (pricing/worker.js) i ekran
// Ceny → „Do wystawienia” dla pojedynczego towaru (routes/ceny-wystawianie.js POST /skan). Klucze API i adres IP
// z listy eMAG są na SRV — z innej maszyny eMAG odpowie 401/403.
//
// Limity (pomiar 2026-10-28): eMAG find_by_eans do 100 EAN na zapytanie, odpowiedź ~25 s, 5/s · 200/min · 5000/dzień;
// Amazon searchCatalogItems 20 EAN, 2/s; restrictions 5/s (tylko ASIN-y, na których nie mamy oferty, raz na 7 dni);
// Kaufland /products/ean/{ean} — jeden EAN na zapytanie, 4 równolegle.
//
//   node pricing/katalogi.js [--rynki emag:RO,kaufland:DE] [--symbol NERF1234]   skan + podsumowanie

require('../config/env');
const { db, stan } = require('./db');
const { query } = require('../services/gt-sql');
const { MAGAZYNY_RAZEM, MAGAZYN_GT_ID } = require('../config/magazyny');
const m = require('./katalogi-model');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => console.log(new Date().toISOString(), `[katalogi] ${s}`);

// Towary do skanu: zwykłe (rodzaj 1 — zestawy mają zwykle nasze własne EAN-y), z poprawnym EAN-em i stanem Razem > 0.
// twIds / symbol zawężają (skan jednego towaru z ekranu).
async function towaryDoSkanu({ twIds = null, symbol = null } = {}) {
  const magi = MAGAZYNY_RAZEM.map((k) => MAGAZYN_GT_ID[k]).filter(Number.isInteger).join(',');
  const ids = twIds ? twIds.map(Number).filter((x) => Number.isInteger(x) && x > 0) : null;
  if (ids && !ids.length) return [];
  const r = await query(`SELECT t.tw_Id, t.tw_Symbol, t.tw_PodstKodKresk AS ean
      FROM tw__Towar t JOIN tw_Stan s ON s.st_TowId = t.tw_Id AND s.st_MagId IN (${magi})
     WHERE t.tw_Rodzaj = 1 AND ISNULL(t.tw_PodstKodKresk, '') <> ''
       ${ids ? `AND t.tw_Id IN (${ids.join(',')})` : ''} ${symbol ? 'AND t.tw_Symbol = @symbol' : ''}
     GROUP BY t.tw_Id, t.tw_Symbol, t.tw_PodstKodKresk
    HAVING SUM(s.st_Stan) > 0`, symbol ? { symbol } : undefined);
  return (r.recordset ?? r).map((w) => ({ tw_id: w.tw_Id, symbol: w.tw_Symbol, ean: m.normalizujEan(w.ean) })).filter((t) => t.ean);
}

// ---------- eMAG ----------
async function emagPoEan(eany, kraj) {
  const emag = require('./emag');
  if (!emag.skonfigurowany()) throw new Error('eMAG: brak EMAG_RO_USER / EMAG_RO_PASS');
  const auth = 'Basic ' + Buffer.from(`${process.env.EMAG_RO_USER}:${process.env.EMAG_RO_PASS}`).toString('base64');
  const host = `https://marketplace-api.emag.${emag.KRAJE[kraj].domena}`;
  const mapa = new Map();
  const czesci = m.paczki(eany, 100);
  for (const [i, cz] of czesci.entries()) {
    const qs = cz.map((e) => `eans[]=${encodeURIComponent(e)}`).join('&');
    let j = null;
    for (let proba = 1; proba <= 4; proba++) {
      try {
        const r = await fetch(`${host}/api-3/documentation/find_by_eans?${qs}`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(90_000) });
        if (r.status === 401 || r.status === 403) throw Object.assign(new Error(`HTTP ${r.status} — login albo IP spoza listy w panelu eMAG (skrypt spoza C:\\was nie wczyta .env)`), { twardy: true });
        if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
        j = await r.json();
        if (j.isError) throw Object.assign(new Error((j.messages || []).join(' ') || 'isError'), { twardy: true });
        break;
      } catch (e) {
        if (e.twardy || proba === 4) throw new Error(`eMAG ${kraj} find_by_eans: ${e.message}`);
        await sleep(5000 * proba);
      }
    }
    for (const [ean, wpis] of m.zEmagFindByEans(j.results)) mapa.set(ean, wpis);
    if ((i + 1) % 10 === 0) log(`eMAG ${kraj}: ${i + 1}/${czesci.length} zapytań`);
    await sleep(350);                                     // 200/min
  }
  return mapa;
}

// ---------- Amazon ----------
async function amazonPoEan(eany, kraj) {
  const amazon = require('./amazon');
  const mp = amazon.RYNKI_AMAZON[kraj].id;
  const mapa = new Map();
  for (const cz of m.paczki(eany, 20)) {
    const qs = new URLSearchParams({ identifiers: cz.join(','), identifiersType: 'EAN', marketplaceIds: mp, includedData: 'identifiers,summaries,productTypes', pageSize: '20' });
    const j = await amazon.api('GET', `/catalog/2022-04-01/items?${qs}`);
    for (const it of j.items || []) {
      const s = (it.summaries || []).find((x) => x.marketplaceId === mp) || it.summaries?.[0] || {};
      const typ = (it.productTypes || []).find((x) => x.marketplaceId === mp)?.productType || it.productTypes?.[0]?.productType || null;
      for (const grupa of it.identifiers || []) {
        for (const id of grupa.identifiers || []) {
          if (id.identifierType !== 'EAN') continue;
          const n = m.normalizujEan(id.identifier);
          if (n && cz.includes(n) && !mapa.has(n)) {
            mapa.set(n, { produkt_id: it.asin, nazwa: s.itemName || null, marka: s.brand || null,
              kategoria: s.browseClassification?.displayName || null, kategoria_id: typ, dodac: null, mamy: 0, hotness: null });
          }
        }
      }
    }
    await sleep(550);                                     // 2/s
  }
  return mapa;
}

async function amazonOgraniczenia(asin, kraj) {
  const amazon = require('./amazon');
  const qs = new URLSearchParams({ asin, sellerId: process.env.SPAPI_SELLER_ID || 'A297N0KEJID15J', marketplaceIds: amazon.RYNKI_AMAZON[kraj].id, conditionType: 'new_new' });
  const j = await amazon.api('GET', `/listings/2021-08-01/restrictions?${qs}`);
  const powody = [...new Set((j.restrictions || []).flatMap((r) => (r.reasons || []).map((p) => p.reasonCode || 'INNE')))];
  return powody.length ? `Amazon: ${powody.join(', ')}` : null;    // null = wolno sprzedawać
}

// ---------- Kaufland ----------
async function kauflandPoEan(eany, kraj) {
  const kaufland = require('./kaufland');
  const sf = kaufland.STOREFRONTY[kraj].sf;
  const mapa = new Map();
  let i = 0;
  const watek = async () => {
    while (i < eany.length) {
      const e = eany[i++];
      try {
        const j = await kaufland.api('GET', `/products/ean/${encodeURIComponent(e)}`, { query: { storefront: sf } });
        const p = j?.data || j;
        if (p?.id_product) mapa.set(e, { produkt_id: String(p.id_product), nazwa: p.title || null, marka: p.manufacturer || null,
          kategoria: p.category?.title || null, kategoria_id: p.category?.id_category != null ? String(p.category.id_category) : null, dodac: null, mamy: 0, hotness: null });
      } catch (err) {
        // 404 = Kaufland nie zna EAN-u, 400 = „Invalid EAN provided” (np. wewnętrzne kody 200…) — oba znaczą „brak
        // produktu” dla TEGO towaru; rzucenie zatrzymywało cały rynek (pierwszy skan 30.10: Kaufland DE pusty).
        if (err.status !== 404 && err.status !== 400) throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, watek));
  return mapa;
}

// ---------- zapis ----------
// Wynik skanu jednego rynku → katalog. `ograniczenie` przeżywa skan (to wiedza z odrzuconych wystawień i restrictions),
// chyba że skan przynosi własne (Amazon). Towar, którego platforma nie zna, dostaje wiersz z produkt_id NULL.
const upsert = db.prepare(`INSERT INTO katalog (tw_id, platforma, rynek, ean, produkt_id, nazwa, marka, kategoria, kategoria_id, dodac, mamy, hotness, sprawdzono)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT (tw_id, platforma, rynek) DO UPDATE SET ean = excluded.ean, produkt_id = excluded.produkt_id, nazwa = excluded.nazwa,
    marka = excluded.marka, kategoria = excluded.kategoria, kategoria_id = excluded.kategoria_id, dodac = excluded.dodac,
    mamy = excluded.mamy, hotness = excluded.hotness, sprawdzono = CURRENT_TIMESTAMP,
    ograniczenie = CASE WHEN excluded.produkt_id IS NOT katalog.produkt_id THEN NULL ELSE katalog.ograniczenie END`);
function zapiszRynek(platforma, rynek, towary, mapa) {
  let znane = 0;
  db.exec('BEGIN');
  try {
    for (const t of towary) {
      const p = mapa.get(t.ean);
      if (p) znane++;
      upsert.run(t.tw_id, platforma, rynek, t.ean, p?.produkt_id ?? null, p?.nazwa ?? null, p?.marka ?? null, p?.kategoria ?? null,
        p?.kategoria_id ?? null, p?.dodac ?? null, p?.mamy ?? 0, p?.hotness ?? null);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return znane;
}

// Amazon restrictions dla ASIN-ów, na których nie mamy oferty — każdy najwyżej raz na 7 dni (czas ostatniego
// sprawdzenia per ASIN w `stan`, klucz ogr_amazon_<rynek>). Wynik w katalog.ograniczenie (NULL = wolno sprzedawać).
async function ograniczeniaAmazon(rynek, twIds) {
  const wiersze = db.prepare(`SELECT k.tw_id, k.produkt_id FROM katalog k
      WHERE k.platforma = 'amazon' AND k.rynek = ? AND k.produkt_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM oferty o WHERE o.platforma = 'amazon' AND o.rynek = k.rynek AND o.tw_id = k.tw_id AND (o.aktywna = 1 OR o.wstrzymana = 1))`)
    .all(rynek).filter((w) => !twIds || twIds.has(w.tw_id));
  const klucz = `ogr_amazon_${rynek}`;
  let ocenione = {};
  try { ocenione = JSON.parse(stan.get(klucz)?.wartosc || '{}'); } catch { ocenione = {}; }
  const teraz = Date.now(), TYDZIEN = 7 * 864e5;
  const ustaw = db.prepare("UPDATE katalog SET ograniczenie = ? WHERE platforma = 'amazon' AND rynek = ? AND produkt_id = ?");
  let sprawdzone = 0;
  for (const asin of [...new Set(wiersze.map((w) => w.produkt_id))]) {
    if (ocenione[asin] && teraz - ocenione[asin] < TYDZIEN) continue;
    try { ustaw.run(await amazonOgraniczenia(asin, rynek), rynek, asin); ocenione[asin] = teraz; sprawdzone++; } catch (e) { log(`Amazon ${rynek} restrictions ${asin}: ${e.message}`); }
    await sleep(220);                                     // 5/s
  }
  stan.set(klucz, JSON.stringify(ocenione));
  return sprawdzone;
}

const SZUKAJ = {
  emag: (eany, rynek) => emagPoEan(eany, rynek),
  amazon: (eany, rynek) => amazonPoEan(eany, rynek),
  kaufland: (eany, rynek) => kauflandPoEan(eany, rynek),
};
const skonfigurowana = (platforma) => {
  if (platforma === 'emag') return require('./emag').skonfigurowany();
  if (platforma === 'kaufland') return require('./kaufland').skonfigurowany();
  if (platforma === 'amazon') return !!(process.env.SPAPI_CLIENT_ID && process.env.SPAPI_CLIENT_SECRET && process.env.SPAPI_REFRESH_TOKEN);
  return false;
};

// Skan: rynki = lista kluczy 'emag:RO' (domyślnie wszystkie z RYNKI_KATALOGU), twIds = tylko te towary.
// Błąd jednego rynku nie zatrzymuje pozostałych (wpis w `stan`, klucz blad_katalog).
async function skanuj({ rynki = null, twIds = null, symbol = null } = {}) {
  const t0 = Date.now();
  const towary = await towaryDoSkanu({ twIds, symbol });
  const eany = [...new Set(towary.map((t) => t.ean))];
  const wynik = { towary: towary.length, rynki: {}, bledy: {} };
  if (!towary.length) return wynik;
  const filtr = twIds ? new Set(towary.map((t) => t.tw_id)) : null;
  for (const { platforma, rynek } of m.RYNKI_KATALOGU) {
    const klucz = m.kluczRynku(platforma, rynek);
    if (rynki && !rynki.includes(klucz)) continue;
    if (!skonfigurowana(platforma)) { wynik.bledy[klucz] = 'brak kluczy API w .env'; continue; }
    try {
      const mapa = await SZUKAJ[platforma](eany, rynek);
      wynik.rynki[klucz] = zapiszRynek(platforma, rynek, towary, mapa);
      if (platforma === 'amazon') wynik.rynki[`${klucz} ograniczenia`] = await ograniczeniaAmazon(rynek, filtr);
    } catch (e) {
      wynik.bledy[klucz] = e.message;
      log(`${klucz}: ${e.message}`);
    }
  }
  wynik.sekund = Math.round((Date.now() - t0) / 1000);
  if (!twIds && !symbol) {
    stan.set('skan_katalogow', JSON.stringify(wynik));
    if (Object.keys(wynik.bledy).length) stan.set('blad_katalog', JSON.stringify(wynik.bledy));
  }
  return wynik;
}

// Marka odrzucona przez eMAG (kategoria wysokiego ryzyka) — znika z kandydatów na tym rynku dla wszystkich towarów
// tej marki, z treścią odrzucenia (pricing/wystawianie.js). Następny skan jej NIE kasuje (ten sam produkt_id).
function oznaczMarke(platforma, rynek, marka, opis) {
  if (!marka) return 0;
  return db.prepare('UPDATE katalog SET ograniczenie = ? WHERE platforma = ? AND rynek = ? AND UPPER(marka) = UPPER(?)')
    .run(`marka wymaga dokumentów: ${String(opis).slice(0, 200)}`, platforma, rynek, marka).changes;
}

module.exports = { skanuj, towaryDoSkanu, oznaczMarke, emagPoEan, amazonPoEan, kauflandPoEan };

if (require.main === module) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
  const rynki = arg('--rynki') ? arg('--rynki').split(',').map((s) => s.trim()) : null;
  skanuj({ rynki, symbol: arg('--symbol') })
    .then((w) => { console.log(JSON.stringify(w, null, 1)); process.exit(0); })
    .catch((e) => { console.error(`BŁĄD: ${e.message}`); process.exit(1); });
}
