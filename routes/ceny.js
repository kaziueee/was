'use strict';

// Ekran „Ceny" (repricer) — odczyt bazy repricera `db/pricing.db` + włączanie/wyłączanie automatu.
// Kanały (kolumny) z pricing/kolumny.js: Amazon DE…PL i eMAG RO (automat od 2026-10-15). Kanał oznaczony
// `tylkoOdczyt` — POST /automat odrzuca na nim włączenie automatu (zasada 5: blokada w backendzie).
// Liczy i obserwuje osobny proces (pricing/worker.js, zadanie WMS-Pricing); WMS tylko czyta jego
// wyniki i zapisuje decyzję człowieka: automat (auto = 1, ceny idą na Amazona) albo ręczny (0). Montowane z auth.wymagajRoli('admin') — na czas
// testów tylko administrator (decyzja usera 2026-10-13); biuro dostanie dostęp po testach.
//
//   GET  /api/ceny/macierz?q=&filtr=automat|szansa|podwyzka|ponizej|decyzja|wszystkie&kanal=&limit=   wiersze SKU × rynek
//        kanal = platforma (amazon, emag) albo klucz kolumny (DE, FR, …, EMAG_RO); puste = wszystkie
//   GET  /api/ceny/towar/:tw_id                                        karta SKU: wszystkie rynki towaru + historia
//   GET  /api/ceny/log?limit=                                          zmiany cen (auto) + działania ludzi
//   POST /api/ceny/automat  { ids: [oferta_id...], auto: true|false }  — tylko podane oferty, nigdy hurtem
//   GET  /api/ceny/powiazania                                          oferty do powiązania (bez GT / po obcięciu) + ręczne
//   POST /api/ceny/powiaz        { sku, kod }                          powiąż SKU z towarem GT (symbol/EAN)
//   POST /api/ceny/powiaz/potwierdz { sku }                            potwierdź obecne dopasowanie jako ręczne
//   POST /api/ceny/powiaz/usun   { sku }                               usuń ręczne powiązanie

const express = require('express');
const router = express.Router();
const { db, stan } = require('../pricing/db');
const { linkiOferty } = require('../pricing/amazon');
const emag = require('../pricing/emag');
const { KOLUMNY, kluczKolumny, kolumna } = require('../pricing/kolumny');
const { wycenaHurtem } = require('../services/cennik');
const { pobierzStanyGt, sumaRazem } = require('../services/gt-produkty');
const { pewneDopasowanie, znajdzTowar, powiaz, usunPowiazanie } = require('../pricing/powiazania');

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
const ZMIANY_KODY = ['podwyzka', 'podwyzka_limit', 'sonda', 'sonda_limit', 'obnizka', 'obnizka_limit', 'na_min', 'na_min_limit', 'pod_min', 'cofniecie'];

// Filtry „gdzie warto włączyć automat" — z ostatniej decyzji (liczonej też dla ofert ręcznych):
//   szansa   — nie mamy BB, a zwycięzca stoi nad naszą podłogą: zejście w pasie może dać BB
//              (bez remisu z FBA, BB pod podłogą i przegranej „nie przez cenę")
//   podwyzka — mamy BB, następny konkurent wyraźnie wyżej: automat podniósłby cenę; na eMAG także
//              „szukanie” (sonda) — BB nasz, ceny konkurencji nieznane, krok +3%
//   ponizej  — obecna cena poniżej minimum z kalkulatora (marża < 20%), bez względu na decyzję; nie
//              liczymy oferty, na którą podniesienie do minimum już poszło (czeka na potwierdzenie)
// Kolejność (po cenie DOCELOWEJ, nie pierwszym schodku): szansa od największego zysku po zejściu,
// podwyżka od największego zysku do zyskania na sztuce, poniżej minimum od najmniejszego zysku.
const zKodem = (...kody) => (o) => kody.includes(o.kod);
const ponizejMin = (o) => o.min > 0 && o.cena > 0 && o.cena < o.min - 0.005
  && !(o.wyslano && o.cena_nowa >= o.min - 0.005 && (!o.obs_czas || o.dec_czas > o.obs_czas));
const FILTRY = {
  szansa: { oferta: zKodem('obnizka', 'obnizka_limit'), wartosc: (o) => o.zysk_cel ?? o.zysk_nowa ?? -Infinity },
  podwyzka: { oferta: zKodem('podwyzka', 'podwyzka_limit', 'sonda', 'sonda_limit'), wartosc: (o) => (o.zysk_cel ?? o.zysk_nowa ?? 0) - (o.zysk ?? 0) },
  ponizej: { oferta: ponizejMin, wartosc: (o) => -(o.zysk ?? 0) },
};
const pasujeFiltr = (t, f) => Object.values(t.rynki).some(FILTRY[f].oferta);
const wartoscFiltra = (t, f) => Math.max(...Object.values(t.rynki).filter(FILTRY[f].oferta).map(FILTRY[f].wartosc));

// Ostatnia obserwacja i ostatnia decyzja każdej oferty — jedno zapytanie, korelowane po max(id).
const SQL_OFERTY = `
  SELECT o.id, o.platforma, o.rynek, o.sku, o.asin, o.tw_id, o.symbol_gt, o.nazwa, o.ilosc, o.auto, o.dopasowanie, o.genius, o.blokada,
         b.czas AS obs_czas, COALESCE(b.widziana, b.czas) AS obs_widziana, b.cena, b.wysylka, b.bb_nasz, b.bb_cena, b.bb_fba, b.najtansza_inna, b.ofert, b.bb_nasza_inna,
         d.kod, d.cena_nowa, d.powod, d.min, d.max, d.zysk, d.marza, d.zysk_nowa,
         d.czas AS dec_czas, d.wyslano, d.blad AS dec_blad, d.marza_nowa, d.cena_cel, d.zysk_cel
    FROM oferty o
    LEFT JOIN obserwacje b ON b.id = (SELECT MAX(id) FROM obserwacje WHERE oferta_id = o.id)
    LEFT JOIN decyzje d    ON d.id = (SELECT MAX(id) FROM decyzje WHERE oferta_id = o.id)
   WHERE o.aktywna = 1 AND o.tw_id IS NOT NULL AND o.ilosc > 0`;

// Filtr kanału (marketplace): platforma = wszystkie jej kolumny, klucz = jedna kolumna. Wybór zawęża
// i wiersze (towar musi mieć ofertę w kanale), i komórki — więc filtry „Szansa”, „Do podwyżki” i ich
// liczniki liczą się tylko z wybranego kanału. Platforma z jedną kolumną (eMAG RO) = jeden chip.
const kolumnyKanalu = (kanal) => KOLUMNY.filter((k) => k.platforma === kanal || k.klucz === kanal);
const zawez = (towary, kolumny) => {
  const kl = new Set(kolumny.map((k) => k.klucz));
  return towary.map((t) => ({ ...t, rynki: Object.fromEntries(Object.entries(t.rynki).filter(([k]) => kl.has(k))) }))
    .filter((t) => Object.keys(t.rynki).length);
};
// Chipy kanałów; n = ile towarów w kanale przechodzi BIEŻĄCY filtr (i wyszukiwanie).
function chipyKanalow(towary, pasuje) {
  const ile = (kol) => zawez(towary, kol).filter(pasuje).length;
  const chipy = [{ klucz: '', nazwa: 'Wszystkie kanały', n: towary.filter(pasuje).length }];
  for (const p of [...new Set(KOLUMNY.map((k) => k.platforma))]) {
    const kol = KOLUMNY.filter((k) => k.platforma === p);
    if (kol.length === 1) { chipy.push({ klucz: p, nazwa: kol[0].nazwa, n: ile(kol) }); continue; }
    chipy.push({ klucz: p, nazwa: `${kol[0].nazwa.split(' ')[0]} — wszystkie`, n: ile(kol) });
    for (const k of kol) chipy.push({ klucz: k.klucz, nazwa: k.rynek, n: ile([k]), rynek: true });
  }
  return chipy;
}

// Express 4 nie łapie odrzuconych obietnic — wyjątek w handlerze async wywróciłby cały WMS.
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/macierz', asyncH(async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const filtr = ['automat', 'szansa', 'podwyzka', 'ponizej', 'decyzja', 'wszystkie'].includes(req.query.filtr) ? req.query.filtr : 'automat';
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
  // Nieznany kanał = wszystkie (nie pusta macierz) — stary link albo kanał wycofany z kolumn.
  const kolKanalu = kolumnyKanalu(String(req.query.kanal || ''));
  const kanal = kolKanalu.length ? String(req.query.kanal) : '';
  const kolumnyW = kanal ? kolKanalu : KOLUMNY;

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
  const kazdy = [...towary.values()];
  const wszystkie = kanal ? zawez(kazdy, kolumnyW) : kazdy;
  const wiersze = wszystkie.filter(pasuje).sort(FILTRY[filtr] && !q
    ? (a, b) => wartoscFiltra(b, filtr) - wartoscFiltra(a, filtr)
    : (a, b) => String(a.symbol).localeCompare(String(b.symbol)));

  const pokazane = wiersze.slice(0, limit);
  const stanGt = await stanyGt(pokazane.map((t) => t.tw_id));
  for (const t of pokazane) t.stan_gt = stanGt ? stanGt(t.tw_id) : null;

  res.json({
    rynki: kolumnyW.map((k) => k.klucz),
    kolumny: kolumnyW.map(({ klucz, nazwa, waluta, tylkoOdczyt }) => ({ klucz, nazwa, waluta, tylko_odczyt: !!tylkoOdczyt })),
    kanal,
    kanaly: chipyKanalow(kazdy, pasuje),
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
      ponizej: wszystkie.filter((t) => pasujeFiltr(t, 'ponizej')).length,
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
  // Nieznany kanał = wszystkie (nie pusta macierz) — stary link albo kanał wycofany z kolumn.
  const kolKanalu = kolumnyKanalu(String(req.query.kanal || ''));
  const kanal = kolKanalu.length ? String(req.query.kanal) : '';
  const kolumnyW = kanal ? kolKanalu : KOLUMNY;
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
  const of = db.prepare('SELECT id, platforma, rynek, sku, auto, tw_id, dopasowanie FROM oferty WHERE id = ?');
  const ustaw = db.prepare('UPDATE oferty SET auto = ? WHERE id = ?');
  const log = db.prepare('INSERT INTO zmiany (kto, oferta_id, akcja, opis) VALUES (?, ?, ?, ?)');
  let zmienione = 0;
  const pominiete = [];
  db.exec('BEGIN');
  try {
    for (const id of ids) {
      const o = of.get(id);
      if (!o) { pominiete.push({ id, powod: 'nie ma oferty' }); continue; }
      if (auto && !o.tw_id) { pominiete.push({ id, sku: o.sku, powod: 'oferta bez towaru GT' }); continue; }
      if (auto && kolumna(o.platforma, o.rynek)?.tylkoOdczyt) { pominiete.push({ id, sku: o.sku, powod: `${o.platforma} ${o.rynek}: na razie tylko odczyt — automat niedostępny` }); continue; }
      // Automat tylko przy pewnym dopasowaniu do GT (wprost / ręczne) — zasada 5: wymuszone tu, nie na ekranie.
      if (auto && !pewneDopasowanie(o.dopasowanie)) {
        pominiete.push({ id, sku: o.sku, powod: 'dopasowanie do GT niepotwierdzone — potwierdź w zakładce „Do powiązania”' });
        continue;
      }
      if (o.auto === auto) continue;
      ustaw.run(auto, id);
      log.run(kto, id, auto ? 'automat_wl' : 'automat_wyl', `${o.rynek} ${o.sku}`);
      zmienione++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ ok: true, zmienione, pominiete });
});

// --- Do powiązania ---------------------------------------------------------------------------
router.get('/powiazania', (req, res) => {
  const bez = db.prepare(`SELECT sku, group_concat(rynek, ' ') AS rynki, max(nazwa) AS nazwa, max(ilosc) AS ilosc,
      max(asin) AS asin, min(rynek) AS rynek
    FROM oferty WHERE platforma = 'amazon' AND aktywna = 1 AND tw_id IS NULL GROUP BY sku ORDER BY max(ilosc) DESC, sku`).all();
  const doPotw = db.prepare(`SELECT sku, group_concat(rynek, ' ') AS rynki, max(nazwa) AS nazwa, max(ilosc) AS ilosc,
      max(asin) AS asin, min(rynek) AS rynek, symbol_gt, tw_id
    FROM oferty WHERE platforma = 'amazon' AND aktywna = 1 AND tw_id IS NOT NULL AND (dopasowanie IS NULL OR dopasowanie NOT IN ('wprost', 'reczne'))
    GROUP BY sku ORDER BY sku`).all();
  const reczne = db.prepare(`SELECT p.sku, p.symbol_gt, p.kto, p.czas, (SELECT group_concat(rynek, ' ') FROM oferty o WHERE o.platforma = p.platforma AND o.sku = p.sku) AS rynki
    FROM powiazania p WHERE p.platforma = 'amazon' ORDER BY p.czas DESC`).all();
  const z = (w) => ({ ...w, linki: linkiOferty(w.rynek, w.asin) });
  res.json({ bez: bez.map(z), do_potwierdzenia: doPotw.map(z), reczne });
});

router.post('/powiaz', asyncH(async (req, res) => {
  const sku = String(req.body?.sku || '').trim();
  if (!sku) return res.status(400).json({ blad: 'Podaj SKU oferty' });
  let towar;
  try { towar = await znajdzTowar(req.body?.kod); } catch (e) { return res.status(400).json({ blad: e.message }); }
  const n = powiaz('amazon', sku, towar, req.body.operator);
  res.json({ ok: true, sku, symbol: towar.tw_Symbol, nazwa: towar.tw_Nazwa, oferty: n });
}));

// Potwierdzenie obecnego (automatycznego) dopasowania — staje się ręcznym, więc automat jest dozwolony.
router.post('/powiaz/potwierdz', (req, res) => {
  const sku = String(req.body?.sku || '').trim();
  const o = db.prepare("SELECT tw_id, symbol_gt FROM oferty WHERE platforma = 'amazon' AND sku = ? AND tw_id IS NOT NULL LIMIT 1").get(sku);
  if (!o) return res.status(404).json({ blad: 'Oferta nie ma dopasowanego towaru — powiąż ją z symbolem GT' });
  const n = powiaz('amazon', sku, { tw_Id: o.tw_id, tw_Symbol: o.symbol_gt }, req.body.operator);
  res.json({ ok: true, sku, symbol: o.symbol_gt, oferty: n });
});

router.post('/powiaz/usun', (req, res) => {
  const sku = String(req.body?.sku || '').trim();
  if (!sku) return res.status(400).json({ blad: 'Podaj SKU oferty' });
  res.json({ ok: true, oferty: usunPowiazanie('amazon', sku, req.body.operator) });
});

module.exports = router;
