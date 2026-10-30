'use strict';

// Ekran Ceny → „Do wystawienia”: nasze towary ze stanem, które na rynku mają gotową kartę produktu, a nie mają
// naszej oferty — z ceną startową i marżą z kalkulatora (pas wg strategii towaru, jak automat). Zaznaczasz →
// podgląd → wystaw. Montowane w routes/ceny.js pod /api/ceny/wystawianie (admin + biuro).
//
// Reguły wymuszone TU, nie na ekranie (zasada 5): pozycję zawsze budujemy od nowa z katalogu, GT i pasa — z klienta
// bierzemy tylko (tw_id, platforma, rynek, cena); blokady (brak EAN / wagi / wymiarów / stanu, rynek bez testu) nie
// przechodzą nigdy, ostrzeżenia (cena pod minimum) tylko z potwierdzeniem. Logika: pricing/wystawianie-model.js.
//
//   GET  /api/ceny/wystawianie                    kandydaci (filtry ?rynek=emag:RO&szukaj=…)
//   POST /api/ceny/wystawianie/podglad  { pozycje: [{tw_id, platforma, rynek, cena?}] }
//   POST /api/ceny/wystawianie          { pozycje, potwierdz, auto }        wystawia (≤ MAX_NA_RAZ)
//   GET  /api/ceny/wystawianie/historia            ostatnie próby + co czeka na podpięcie w Sellasist
//   POST /api/ceny/wystawianie/sellasist { ids, podpiete }                   odhaczenie podpięcia w Sellasist
//   POST /api/ceny/wystawianie/skan     { tw_id }                            odświeżenie katalogu jednego towaru

const express = require('express');
const { db, stan } = require('../pricing/db');
const wm = require('../pricing/wystawianie-model');
const { RYNKI_KATALOGU, kluczRynku, powodBraku } = require('../pricing/katalogi-model');
const { kluczKolumny, kolumna } = require('../pricing/kolumny');
const { pasyZWyceny } = require('../pricing/pas');
const strategieDane = require('../pricing/strategie-dane');
const { wycenaHurtem } = require('../services/cennik');
const { pobierzStanyGt } = require('../services/gt-produkty');
const { pobierzAtrybuty } = require('../services/gt-atrybuty');
const { MAGAZYNY_RAZEM } = require('../config/magazyny');

// Oferta „jest”, gdy sync widział ją w ostatnich 3 dniach (także nieaktywną — eMAG oddaje oferty ze statusem 0;
// drugie wystawienie tego samego towaru byłoby duplikatem). Próba w toku (wysłana, jeszcze niewidoczna) też wyklucza
// towar z listy; „blad” (nie wiadomo, czy powstała) — przez dobę: jeśli powstała, sync ją do tego czasu zobaczy.
const SQL_KANDYDACI = `SELECT k.* FROM katalog k
  WHERE k.produkt_id IS NOT NULL AND COALESCE(k.mamy, 0) = 0
    AND NOT EXISTS (SELECT 1 FROM oferty o WHERE o.platforma = k.platforma AND o.rynek = k.rynek AND o.tw_id = k.tw_id
                     AND o.widziana >= datetime('now', '-3 days'))
    AND NOT EXISTS (SELECT 1 FROM wystawienia w WHERE w.platforma = k.platforma AND w.rynek = k.rynek AND w.tw_id = k.tw_id
                     AND (w.status = 'wyslane' OR (w.status = 'blad' AND w.czas >= datetime('now', '-1 day'))))`;

module.exports = function wystawianieRouter({ asyncH }) {
  const router = express.Router();
  const blad = (res, kod, tekst, dodatki = {}) => res.status(kod).json({ blad: tekst, ...dodatki });

  // Wiersze katalogu → pełne pozycje (stan, pas, waga, wymiary, ocena). ceny = Map(klucz → cena z klienta).
  // GT padnięte = wyjątek → 503 (nie pokazujemy „zera” ani ceny bez kosztu).
  async function zbuduj(wiersze, ceny = new Map()) {
    const twIds = [...new Set(wiersze.map((k) => k.tw_id))];
    if (!twIds.length) return [];
    const [wyceny, stany, atrybuty, strategie] = await Promise.all([
      wycenaHurtem(twIds), pobierzStanyGt(twIds), pobierzAtrybuty(twIds),
      strategieDane.strategieDlaPasow(twIds).catch(() => ({ poTw: new Map() })),
    ]);
    const pasy = new Map();
    const out = [];
    for (const k of wiersze) {
      const w = wyceny.get(k.tw_id);
      if (!w) continue;
      if (!pasy.has(k.tw_id)) pasy.set(k.tw_id, pasyZWyceny(w, { strategia: strategie.poTw.get(k.tw_id) }));
      const kol = kolumna(k.platforma, k.rynek);
      const pas = pasy.get(k.tw_id)[kluczKolumny(k.platforma, k.rynek)] || null;
      const a = atrybuty.get(String(k.tw_id)) || {};
      const klucz = `${k.tw_id}|${k.platforma}|${k.rynek}`;
      const cenaKlienta = Number(ceny.get(klucz));
      const cena = cenaKlienta > 0 ? Math.round(cenaKlienta * 100) / 100 : pas?.min ?? null;
      const p = {
        tw_id: k.tw_id, sku: w.sku, nazwa: w.nazwa, ean: k.ean, platforma: k.platforma, rynek: k.rynek,
        katalog: { produkt_id: k.produkt_id, nazwa: k.nazwa, marka: k.marka, kategoria: k.kategoria, kategoria_id: k.kategoria_id, ograniczenie: k.ograniczenie },
        ilosc: wm.stanDostepny(stany.get(String(k.tw_id)), MAGAZYNY_RAZEM),
        waga: a.waga ?? null, wymiary: a.rozbite ?? null, cena, pas,
      };
      const ocena = wm.ocenPozycje(p);
      const przy = cena > 0 && pas?.ocen ? pas.ocen(cena) : null;
      out.push({
        klucz, tw_id: p.tw_id, sku: p.sku, nazwa: p.nazwa, ean: p.ean, platforma: p.platforma, rynek: p.rynek,
        kanal_nazwa: kol?.nazwa || `${p.platforma} ${p.rynek}`, waluta: kol?.waluta || '',
        produkt_id: k.produkt_id, nazwa_platformy: k.nazwa, marka: k.marka, kategoria: k.kategoria, hotness: k.hotness,
        stan: p.ilosc, waga: p.waga, wymiary: a.wymiary ?? null, cena, min: pas?.min ?? null, max: pas?.max ?? null,
        strategia: pas?.strategia?.nazwa ?? null, zysk: przy?.zysk ?? null, marza: przy?.marza ?? null,
        blokady: ocena.blokady, ostrzezenia: ocena.ostrzezenia, sprawdzono: k.sprawdzono,
        _pozycja: p,
      });
    }
    return out;
  }
  const bezWnetrza = (x) => { const { _pozycja, ...r } = x; return r; };

  // Lista kandydatów jest droga (GT: wycena + stany + atrybuty dla ~tysiąca towarów) — trzymamy ją 2 min.
  let cache = null;
  router.get('/', asyncH(async (req, res) => {
    const filtrRynku = String(req.query.rynek || '');
    const szukaj = String(req.query.szukaj || '').trim().toUpperCase();
    if (!cache || Date.now() - cache.czas > 120_000 || req.query.odswiez === '1') {
      let lista;
      try { lista = await zbuduj(db.prepare(SQL_KANDYDACI).all()); } catch (e) {
        console.error('[ceny/wystawianie] GT:', e.message);
        return blad(res, 503, 'Subiekt GT nie odpowiada — bez kosztu i stanu nie pokażemy cen do wystawienia');
      }
      // Bez stanu dostępnego to nie kandydat (towar w katalogu, ale całość zarezerwowana / zeszła od skanu).
      cache = { czas: Date.now(), lista: lista.filter((x) => powodBraku({ produkt_id: x.produkt_id, ograniczenie: null }, { stan: x.stan }) == null).map(bezWnetrza) };
    }
    const rynki = RYNKI_KATALOGU.map(({ platforma, rynek }) => {
      const klucz = kluczRynku(platforma, rynek);
      const r = wm.gotowyRynek(platforma, rynek);
      return { klucz, nazwa: kolumna(platforma, rynek)?.nazwa || klucz, gotowe: r.gotowe, powod: r.powod || null,
        n: cache.lista.filter((x) => kluczRynku(x.platforma, x.rynek) === klucz).length,
        // bez blokad (EAN, waga, wymiary, marka) — pomiar 2026-10-30: komplet wagi i wymiarów ma ~2,3 tys. z ~12,3 tys. towarów ze stanem
        gotowych: cache.lista.filter((x) => kluczRynku(x.platforma, x.rynek) === klucz && !x.blokady.length).length };
    });
    let pozycje = cache.lista;
    if (filtrRynku) pozycje = pozycje.filter((x) => kluczRynku(x.platforma, x.rynek) === filtrRynku);
    if (szukaj) pozycje = pozycje.filter((x) => [x.sku, x.ean, x.nazwa, x.marka].some((v) => String(v || '').toUpperCase().includes(szukaj)));
    let skan = null;
    try { skan = stan.get('skan_katalogow') ? { ...JSON.parse(stan.get('skan_katalogow').wartosc), czas: stan.get('skan_katalogow').czas } : null; } catch { skan = null; }
    const doSellasist = db.prepare("SELECT COUNT(*) AS n FROM wystawienia WHERE status IN ('wyslane', 'widoczna') AND sellasist = 0").get().n;
    res.json({ pozycje, rynki, skan, do_sellasist: doSellasist, max_na_raz: wm.MAX_NA_RAZ, lista_czas: new Date(cache.czas).toISOString() });
  }));

  // Pozycje z klienta → wiersze katalogu (tylko te, które wciąż są kandydatami) + ceny z klienta.
  function zWejscia(b) {
    const we = Array.isArray(b?.pozycje) ? b.pozycje : [];
    const kat = db.prepare(`${SQL_KANDYDACI} AND k.tw_id = ? AND k.platforma = ? AND k.rynek = ?`);
    const wiersze = [], ceny = new Map(), pominiete = [];
    const byly = new Set();
    for (const x of we) {
      const tw = Number(x?.tw_id), platforma = String(x?.platforma || ''), rynek = String(x?.rynek || '');
      const klucz = `${tw}|${platforma}|${rynek}`;
      if (!Number.isInteger(tw) || byly.has(klucz)) continue;
      byly.add(klucz);
      const k = kat.get(tw, platforma, rynek);
      if (!k) { pominiete.push({ tw_id: tw, platforma, rynek, powod: 'już nie jest kandydatem (mamy ofertę, próba w toku albo brak produktu)' }); continue; }
      wiersze.push(k);
      if (x.cena != null) ceny.set(klucz, x.cena);
    }
    return { wiersze, ceny, pominiete };
  }

  router.post('/podglad', asyncH(async (req, res) => {
    const { wiersze, ceny, pominiete } = zWejscia(req.body);
    if (wiersze.length > wm.MAX_NA_RAZ) return blad(res, 400, `Najwyżej ${wm.MAX_NA_RAZ} pozycji naraz`);
    let poz;
    try { poz = await zbuduj(wiersze, ceny); } catch (e) { return blad(res, 503, `Subiekt GT nie odpowiada: ${e.message}`); }
    res.json({ pozycje: poz.map(bezWnetrza), pominiete });
  }));

  router.post('/', asyncH(async (req, res) => {
    const b = req.body || {};
    const { wiersze, ceny, pominiete } = zWejscia(b);
    if (!wiersze.length) return blad(res, 400, 'Brak pozycji do wystawienia', { pominiete });
    if (wiersze.length > wm.MAX_NA_RAZ) return blad(res, 400, `Najwyżej ${wm.MAX_NA_RAZ} pozycji naraz`);
    let poz;
    try { poz = await zbuduj(wiersze, ceny); } catch (e) { return blad(res, 503, `Subiekt GT nie odpowiada: ${e.message}`); }
    const zablokowane = poz.filter((x) => x.blokady.length);
    const doWyslania = poz.filter((x) => !x.blokady.length);
    if (!doWyslania.length) return blad(res, 400, 'Żadna pozycja nie przeszła sprawdzenia', { zablokowane: zablokowane.map(bezWnetrza), pominiete });
    const ostrzezenia = doWyslania.flatMap((x) => x.ostrzezenia.map((o) => ({ ...o, tekst: `${x.sku} (${x.kanal_nazwa}): ${o.tekst}` })));
    if (ostrzezenia.length && b.potwierdz !== true) {
      return blad(res, 409, `Wymaga potwierdzenia: ${ostrzezenia.map((o) => o.tekst).join('; ')}`, { ostrzezenia, potwierdzenie: true });
    }
    cache = null;
    const wyniki = await require('../pricing/wystawianie').wystaw(doWyslania.map((x) => x._pozycja), { kto: b.operator || null, auto: b.auto !== false });
    res.json({ ok: true, wyniki, zablokowane: zablokowane.map(bezWnetrza), pominiete });
  }));

  router.get('/historia', (req, res) => {
    const wiersze = db.prepare(`SELECT w.*, o.aktywna AS of_aktywna, o.wstrzymana AS of_wstrzymana, o.blokada AS of_blokada, o.auto AS of_auto,
        o.ilosc AS of_ilosc, o.cena AS of_cena, o.asin AS of_asin
        FROM wystawienia w LEFT JOIN oferty o ON o.id = w.oferta_id ORDER BY w.id DESC LIMIT 300`).all();
    res.json({ wystawienia: wiersze.map((w) => ({ ...w, kanal_nazwa: kolumna(w.platforma, w.rynek)?.nazwa || `${w.platforma} ${w.rynek}`,
      waluta: kolumna(w.platforma, w.rynek)?.waluta || '' })) });
  });

  router.post('/sellasist', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(Number).filter(Number.isInteger))] : [];
    if (!ids.length) return blad(res, 400, 'Podaj ids');
    const podpiete = req.body?.podpiete === false ? 0 : 1;
    const ustaw = db.prepare("UPDATE wystawienia SET sellasist = ? WHERE id = ? AND status IN ('wyslane', 'widoczna')");
    const log = db.prepare('INSERT INTO zmiany (kto, oferta_id, akcja, opis) VALUES (?, ?, ?, ?)');
    let n = 0;
    db.exec('BEGIN');
    try {
      for (const id of ids) {
        const w = db.prepare('SELECT * FROM wystawienia WHERE id = ?').get(id);
        if (!w || !ustaw.run(podpiete, id).changes) continue;
        log.run(req.body.operator || null, w.oferta_id, podpiete ? 'sellasist_podpiete' : 'sellasist_odpiete', `${w.platforma} ${w.rynek} ${w.sku}`);
        n++;
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    res.json({ ok: true, zmienione: n });
  });

  router.post('/skan', asyncH(async (req, res) => {
    const tw = Number(req.body?.tw_id);
    if (!Number.isInteger(tw) || tw <= 0) return blad(res, 400, 'Podaj tw_id');
    try {
      const w = await require('../pricing/katalogi').skanuj({ twIds: [tw] });
      cache = null;
      res.json({ ok: true, ...w });
    } catch (e) { blad(res, 502, e.message); }
  }));

  return router;
};
