'use strict';

// Ekran „Ceny" (repricer) — odczyt bazy repricera `db/pricing.db` + włączanie/wyłączanie automatu.
// Kanały (kolumny) z pricing/kolumny.js: Amazon DE…PL i eMAG RO. eMAG jest TYLKO DO ODCZYTU —
// POST /automat odrzuca włączenie automatu na kanale `tylkoOdczyt` (zasada 5: blokada w backendzie).
// Liczy i obserwuje osobny proces (pricing/worker.js, zadanie WMS-Pricing); WMS tylko czyta jego
// wyniki i zapisuje decyzję człowieka: automat (auto = 1, ceny idą na Amazona) albo ręczny (0). Montowane z auth.wymagajRoli('admin') — na czas
// testów tylko administrator (decyzja usera 2026-10-13); biuro dostanie dostęp po testach.
//
//   GET  /api/ceny/macierz?q=&filtr=automat|szansa|podwyzka|decyzja|wszystkie&limit=   wiersze SKU × rynek
//   GET  /api/ceny/towar/:tw_id                                        karta SKU: wszystkie rynki towaru + historia
//   GET  /api/ceny/log?limit=                                          zmiany cen (auto) + działania ludzi
//   POST /api/ceny/automat  { ids: [oferta_id...], auto: true|false }  — tylko podane oferty, nigdy hurtem

const express = require('express');
const router = express.Router();
const { db, stan } = require('../pricing/db');
const { linkiOferty } = require('../pricing/amazon');
const emag = require('../pricing/emag');
const { KOLUMNY, kluczKolumny, kolumna } = require('../pricing/kolumny');
const { wycenaHurtem } = require('../services/cennik');
const { pobierzStanyGt, sumaRazem } = require('../services/gt-produkty');

// Stan z GT (master stanów) dla pokazanych towarów: Razem (bez BRK) i K4. GT padnięte = null,
// ekran pokazuje wtedy „—", a nie zero (zero to pewna informacja, której nie mamy).
async function stanyGt(twIds) {
  try {
    const m = await pobierzStanyGt(twIds);
    return (id) => {
      const s = m.get(String(id));
      return s ? { razem: sumaRazem(s), k4: s.K4?.ilosc ?? 0, k4_rez: s.K4?.rezerwacja ?? 0 } : null;
    };
  } catch (e) {
    console.error('[ceny] GT stany:', e.message);
    return null;
  }
}

// Linki do oferty — każda platforma po swojemu (Amazon po ASIN, eMAG po PNK trzymanym w `asin`).
const linki = (o) => (o.platforma === 'emag' ? emag.linkiOferty(o.asin) : linkiOferty(o.rynek, o.asin));
// Pola kanału doklejane do każdej oferty — ekran nie zgaduje waluty ani nazwy z kodu rynku.
const zKanalem = (o) => {
  const k = kolumna(o.platforma, o.rynek) || {};
  return { ...o, kolumna: kluczKolumny(o.platforma, o.rynek), kanal_nazwa: k.nazwa || `${o.platforma} ${o.rynek}`,
    waluta: k.waluta || '', tylko_odczyt: !!k.tylkoOdczyt, linki: linki(o) };
};
const ZMIANY_KODY = ['podwyzka', 'podwyzka_limit', 'obnizka', 'obnizka_limit', 'na_min', 'na_min_limit', 'pod_min', 'cofniecie'];

// Filtry „gdzie warto włączyć automat" — z ostatniej decyzji (liczonej też dla ofert ręcznych):
//   szansa   — nie mamy BB, a zwycięzca stoi nad naszą podłogą: zejście w pasie może dać BB
//              (bez remisu z FBA, BB pod podłogą i przegranej „nie przez cenę")
//   podwyzka — mamy BB, następny konkurent wyraźnie wyżej: automat podniósłby cenę
// Kolejność (po cenie DOCELOWEJ, nie pierwszym schodku): szansa od największego zysku po zejściu,
// podwyżka od największego zysku do zyskania na sztuce.
const FILTRY = {
  szansa: { kody: ['obnizka', 'obnizka_limit'], wartosc: (o) => o.zysk_cel ?? o.zysk_nowa ?? -Infinity },
  podwyzka: { kody: ['podwyzka', 'podwyzka_limit'], wartosc: (o) => (o.zysk_cel ?? o.zysk_nowa ?? 0) - (o.zysk ?? 0) },
};
const pasujeFiltr = (t, f) => Object.values(t.rynki).some((o) => FILTRY[f].kody.includes(o.kod));
const wartoscFiltra = (t, f) => Math.max(...Object.values(t.rynki).filter((o) => FILTRY[f].kody.includes(o.kod)).map(FILTRY[f].wartosc));

// Ostatnia obserwacja i ostatnia decyzja każdej oferty — jedno zapytanie, korelowane po max(id).
const SQL_OFERTY = `
  SELECT o.id, o.platforma, o.rynek, o.sku, o.asin, o.tw_id, o.symbol_gt, o.nazwa, o.ilosc, o.auto, o.dopasowanie, o.genius,
         b.czas AS obs_czas, b.cena, b.wysylka, b.bb_nasz, b.bb_cena, b.bb_fba, b.najtansza_inna, b.ofert, b.bb_nasza_inna,
         d.kod, d.cena_nowa, d.powod, d.min, d.max, d.zysk, d.marza, d.zysk_nowa,
         d.czas AS dec_czas, d.wyslano, d.blad AS dec_blad, d.marza_nowa, d.cena_cel, d.zysk_cel
    FROM oferty o
    LEFT JOIN obserwacje b ON b.id = (SELECT MAX(id) FROM obserwacje WHERE oferta_id = o.id)
    LEFT JOIN decyzje d    ON d.id = (SELECT MAX(id) FROM decyzje WHERE oferta_id = o.id)
   WHERE o.aktywna = 1 AND o.tw_id IS NOT NULL AND o.ilosc > 0`;

// Express 4 nie łapie odrzuconych obietnic — wyjątek w handlerze async wywróciłby cały WMS.
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/macierz', asyncH(async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const filtr = ['automat', 'szansa', 'podwyzka', 'decyzja', 'wszystkie'].includes(req.query.filtr) ? req.query.filtr : 'automat';
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);

  const oferty = db.prepare(SQL_OFERTY).all();
  const towary = new Map();
  for (const o of oferty) {
    let t = towary.get(o.tw_id);
    if (!t) towary.set(o.tw_id, t = { tw_id: o.tw_id, symbol: o.symbol_gt, nazwa: o.nazwa, rynki: {} });
    // Ten sam towar bywa wystawiony dwa razy na jednym rynku (SKU z dopiskiem -1) — w komórce
    // pokazujemy ofertę z większym stanem, resztę liczymy, żeby ekran nie ukrywał duplikatu.
    const kol = kluczKolumny(o.platforma, o.rynek);
    const byla = t.rynki[kol];
    if (!byla || (o.ilosc || 0) > (byla.ilosc || 0)) {
      t.rynki[kol] = { ...zKanalem(o), inne_oferty: (byla ? byla.inne_oferty + 1 : 0) };
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
    if (FILTRY[filtr]) return pasujeFiltr(t, filtr);
    return true;
  };
  const wszystkie = [...towary.values()];
  const wiersze = wszystkie.filter(pasuje).sort(FILTRY[filtr] && !q
    ? (a, b) => wartoscFiltra(b, filtr) - wartoscFiltra(a, filtr)
    : (a, b) => String(a.symbol).localeCompare(String(b.symbol)));

  const pokazane = wiersze.slice(0, limit);
  const stanGt = await stanyGt(pokazane.map((t) => t.tw_id));
  for (const t of pokazane) t.stan_gt = stanGt ? stanGt(t.tw_id) : null;

  res.json({
    rynki: KOLUMNY.map((k) => k.klucz),
    kolumny: KOLUMNY.map(({ klucz, nazwa, waluta, tylkoOdczyt }) => ({ klucz, nazwa, waluta, tylko_odczyt: !!tylkoOdczyt })),
    emag: { sync: stan.get('sync_emag'), blad: stan.get('blad_emag') },
    wysylanie: process.env.PRICING_ZAPIS === '1',    // globalny hamulec workera (ten sam .env)
    gt_ok: !!stanGt,
    przebieg: stan.get('przebieg'),
    obserwacja_pelna: stan.get('obserwacja_pelna'),
    blad: stan.get('blad'),
    liczniki: {
      automat: wszystkie.filter((t) => Object.values(t.rynki).some((o) => o.auto)).length,
      szansa: wszystkie.filter((t) => pasujeFiltr(t, 'szansa')).length,
      podwyzka: wszystkie.filter((t) => pasujeFiltr(t, 'podwyzka')).length,
      decyzja: wszystkie.filter((t) => Object.values(t.rynki).some((o) => ZMIANY_KODY.includes(o.kod))).length,
      wszystkie: wszystkie.length,
    },
    razem: wiersze.length,
    wiersze: pokazane,
  });
}));

// Karta SKU — wszystkie oferty towaru (każdy rynek, także bez stanu i z dopiskiem -1), ostatnia
// obserwacja i decyzja, historia do wykresu. Koszt i waga na żywo z GT; GT padnięte = karta bez nich.
router.get('/towar/:tw_id', asyncH(async (req, res) => {
  const twId = Number(req.params.tw_id);
  const oferty = db.prepare(SQL_OFERTY.replace('AND o.ilosc > 0', '') + ' AND o.tw_id = ? ORDER BY o.platforma, o.rynek, o.ilosc DESC').all(twId);
  if (!oferty.length) return res.status(404).json({ blad: 'Brak ofert dla tego towaru' });
  const decyzje = db.prepare(`SELECT czas, cena_przed, cena_nowa, cena_cel, zysk_cel, min, max, kod, powod, wyslano, blad, auto, zysk, zysk_nowa
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

  const stanGt = await stanyGt([twId]);
  res.json({
    tw_id: twId,
    stan_gt: stanGt ? stanGt(twId) : null,
    symbol: oferty[0].symbol_gt,
    nazwa: oferty[0].nazwa,
    gt_ok: !!gt,
    gt,
    przebieg: stan.get('przebieg'),
    oferty: oferty.map((o) => ({
      ...zKanalem(o),
      decyzje: decyzje.all(o.id),
      obserwacje: obserwacje.all(o.id).reverse(),
      zmiany: zmiany.all(o.id),
    })),
  });
}));

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
  const of = db.prepare('SELECT id, platforma, rynek, sku, auto, tw_id FROM oferty WHERE id = ?');
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
      if (auto && kolumna(o.platforma, o.rynek)?.tylkoOdczyt) { pominiete.push({ id, powod: `${o.platforma} ${o.rynek}: na razie tylko odczyt — automat niedostępny` }); continue; }
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
