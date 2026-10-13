'use strict';

// Ekran „Ceny" (repricer) — odczyt bazy repricera `db/pricing.db` + włączanie/wyłączanie automatu.
// Liczy i obserwuje osobny proces (pricing/worker.js, zadanie WMS-Pricing); WMS tylko czyta jego
// wyniki i zapisuje decyzję człowieka (auto = 0/1). Montowane z auth.wymagajRoli('admin') — na czas
// testów tylko administrator (decyzja usera 2026-10-13); biuro dostanie dostęp po testach.
//
//   GET  /api/ceny/macierz?q=&filtr=automat|decyzja|wszystkie&limit=   wiersze SKU × rynek
//   GET  /api/ceny/towar/:tw_id                                        karta SKU: wszystkie rynki towaru + historia
//   GET  /api/ceny/log?limit=                                          zmiany cen (auto) + działania ludzi
//   POST /api/ceny/automat  { ids: [oferta_id...], auto: true|false }  — tylko podane oferty, nigdy hurtem

const express = require('express');
const router = express.Router();
const { db, stan } = require('../pricing/db');
const { linkiOferty } = require('../pricing/amazon');
const { wycenaHurtem } = require('../services/cennik');

const RYNKI = ['DE', 'FR', 'IT', 'ES', 'NL', 'PL'];
const ZMIANY_KODY = ['podwyzka', 'podwyzka_limit', 'obnizka', 'obnizka_limit', 'na_min', 'na_min_limit', 'pod_min', 'cofniecie'];

// Ostatnia obserwacja i ostatnia decyzja każdej oferty — jedno zapytanie, korelowane po max(id).
const SQL_OFERTY = `
  SELECT o.id, o.rynek, o.sku, o.asin, o.tw_id, o.symbol_gt, o.nazwa, o.ilosc, o.auto, o.zapis, o.dopasowanie,
         b.czas AS obs_czas, b.cena, b.wysylka, b.bb_nasz, b.bb_cena, b.bb_fba, b.najtansza_inna, b.ofert,
         d.kod, d.cena_nowa, d.powod, d.min, d.max, d.zysk, d.marza, d.zysk_nowa,
         d.czas AS dec_czas, d.wyslano, d.blad AS dec_blad, d.marza_nowa
    FROM oferty o
    LEFT JOIN obserwacje b ON b.id = (SELECT MAX(id) FROM obserwacje WHERE oferta_id = o.id)
    LEFT JOIN decyzje d    ON d.id = (SELECT MAX(id) FROM decyzje WHERE oferta_id = o.id)
   WHERE o.platforma = 'amazon' AND o.aktywna = 1 AND o.tw_id IS NOT NULL AND o.ilosc > 0`;

router.get('/macierz', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const filtr = ['automat', 'decyzja', 'wszystkie'].includes(req.query.filtr) ? req.query.filtr : 'automat';
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);

  const oferty = db.prepare(SQL_OFERTY).all();
  const towary = new Map();
  for (const o of oferty) {
    let t = towary.get(o.tw_id);
    if (!t) towary.set(o.tw_id, t = { tw_id: o.tw_id, symbol: o.symbol_gt, nazwa: o.nazwa, rynki: {} });
    // Ten sam towar bywa wystawiony dwa razy na jednym rynku (SKU z dopiskiem -1) — w komórce
    // pokazujemy ofertę z większym stanem, resztę liczymy, żeby ekran nie ukrywał duplikatu.
    const byla = t.rynki[o.rynek];
    if (!byla || (o.ilosc || 0) > (byla.ilosc || 0)) {
      t.rynki[o.rynek] = { ...o, linki: linkiOferty(o.rynek, o.asin), inne_oferty: (byla ? byla.inne_oferty + 1 : 0) };
    }
    else byla.inne_oferty++;
  }

  const pasuje = (t) => {
    const of = Object.values(t.rynki);
    if (q && !(String(t.symbol).toLowerCase().includes(q) || String(t.nazwa || '').toLowerCase().includes(q)
      || of.some((o) => o.sku.toLowerCase().includes(q) || String(o.asin || '').toLowerCase() === q))) return false;
    if (q) return true;                                  // wyszukiwanie ma pierwszeństwo przed filtrem
    if (filtr === 'automat') return of.some((o) => o.auto);
    if (filtr === 'decyzja') return of.some((o) => ZMIANY_KODY.includes(o.kod));
    return true;
  };
  const wszystkie = [...towary.values()];
  const wiersze = wszystkie.filter(pasuje).sort((a, b) => String(a.symbol).localeCompare(String(b.symbol)));

  res.json({
    rynki: RYNKI,
    przebieg: stan.get('przebieg'),
    obserwacja_pelna: stan.get('obserwacja_pelna'),
    blad: stan.get('blad'),
    liczniki: {
      automat: wszystkie.filter((t) => Object.values(t.rynki).some((o) => o.auto)).length,
      decyzja: wszystkie.filter((t) => Object.values(t.rynki).some((o) => ZMIANY_KODY.includes(o.kod))).length,
      wszystkie: wszystkie.length,
    },
    razem: wiersze.length,
    wiersze: wiersze.slice(0, limit),
  });
});

// Karta SKU — wszystkie oferty towaru (każdy rynek, także bez stanu i z dopiskiem -1), ostatnia
// obserwacja i decyzja, historia do wykresu. Koszt i waga na żywo z GT; GT padnięte = karta bez nich.
router.get('/towar/:tw_id', async (req, res) => {
  const twId = Number(req.params.tw_id);
  const oferty = db.prepare(SQL_OFERTY.replace('AND o.ilosc > 0', '') + ' AND o.tw_id = ? ORDER BY o.rynek, o.ilosc DESC').all(twId);
  if (!oferty.length) return res.status(404).json({ blad: 'Brak ofert Amazon dla tego towaru' });
  const decyzje = db.prepare(`SELECT czas, cena_przed, cena_nowa, min, max, kod, powod, wyslano, blad, auto, zysk, zysk_nowa
                                FROM decyzje WHERE oferta_id = ? ORDER BY id DESC LIMIT 30`);
  const obserwacje = db.prepare(`SELECT czas, cena, wysylka, bb_nasz, bb_cena, bb_fba, najtansza_inna
                                   FROM obserwacje WHERE oferta_id = ? ORDER BY id DESC LIMIT 60`);
  const zmiany = db.prepare('SELECT czas, kto, akcja FROM zmiany WHERE oferta_id = ? ORDER BY id DESC LIMIT 20');

  let gt = null;
  try {
    const w = (await wycenaHurtem([twId])).get(twId);
    if (w) gt = { koszt: w.koszt, waga: w.waga, wagaZnana: w.wagaZnana, docinalny: w.docinalny };
  } catch (e) {
    console.error('[ceny] GT:', e.message);
  }

  res.json({
    tw_id: twId,
    symbol: oferty[0].symbol_gt,
    nazwa: oferty[0].nazwa,
    gt_ok: !!gt,
    gt,
    przebieg: stan.get('przebieg'),
    oferty: oferty.map((o) => ({
      ...o,
      linki: linkiOferty(o.rynek, o.asin),
      decyzje: decyzje.all(o.id),
      obserwacje: obserwacje.all(o.id).reverse(),
      zmiany: zmiany.all(o.id),
    })),
  });
});

router.get('/log', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
  const decyzje = db.prepare(`
    SELECT 'decyzja' AS typ, d.czas, o.rynek, o.sku, o.symbol_gt, d.cena_przed, d.cena_nowa, d.kod, d.powod,
           d.wyslano, d.zysk, d.zysk_nowa, NULL AS kto
      FROM decyzje d JOIN oferty o ON o.id = d.oferta_id
     WHERE d.auto = 1 AND d.cena_nowa <> d.cena_przed
     ORDER BY d.id DESC LIMIT ?`).all(limit);
  const zmiany = db.prepare(`
    SELECT 'zmiana' AS typ, z.czas, o.rynek, o.sku, o.symbol_gt, NULL AS cena_przed, NULL AS cena_nowa, z.akcja AS kod,
           z.opis AS powod, NULL AS wyslano, NULL AS zysk, NULL AS zysk_nowa, z.kto
      FROM zmiany z LEFT JOIN oferty o ON o.id = z.oferta_id
     ORDER BY z.id DESC LIMIT ?`).all(limit);
  res.json({ wpisy: [...decyzje, ...zmiany].sort((a, b) => (a.czas < b.czas ? 1 : -1)).slice(0, limit) });
});

router.post('/automat', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(Number).filter(Number.isInteger))] : [];
  const auto = req.body?.auto === true || req.body?.auto === 1 ? 1 : req.body?.auto === false || req.body?.auto === 0 ? 0 : null;
  if (!ids.length || auto === null) return res.status(400).json({ blad: 'Podaj ids (lista ofert) i auto (true/false)' });
  if (ids.length > 200) return res.status(400).json({ blad: 'Najwyżej 200 ofert naraz — automatu nie włączamy na cały katalog' });

  const kto = req.body.operator || null;              // wstrzyknięty z sesji (services/auth)
  const of = db.prepare('SELECT id, rynek, sku, auto, tw_id FROM oferty WHERE id = ?');
  const ustaw = db.prepare('UPDATE oferty SET auto = ? WHERE id = ?');
  const log = db.prepare('INSERT INTO zmiany (kto, oferta_id, akcja, opis) VALUES (?, ?, ?, ?)');
  let zmienione = 0;
  const pominiete = [];
  db.exec('BEGIN');
  try {
    for (const id of ids) {
      const o = of.get(id);
      if (!o) { pominiete.push({ id, powod: 'nie ma oferty' }); continue; }
      if (auto && !o.tw_id) { pominiete.push({ id, powod: 'oferta bez towaru GT' }); continue; }
      if (o.auto === auto) continue;
      ustaw.run(auto, id);
      log.run(kto, id, auto ? 'automat_wl' : 'automat_wyl', `${o.rynek} ${o.sku}`);
      zmienione++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ ok: true, zmienione, pominiete });
});

module.exports = router;
