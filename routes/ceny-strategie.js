'use strict';

// Ekran Ceny → „Strategie”: biblioteka strategii cenowych, przypisania do towarów i podgląd skutków.
// Logika i walidacja: pricing/strategie.js (czyste, testy), zapis: pricing/strategie-dane.js. Montowane w
// routes/ceny.js pod /api/ceny/strategie — ten sam dostęp (admin + biuro). Każda reguła wymuszona TU (zasada 5):
// walidacja parametrów, data końca wyprzedaży, potwierdzenie ostrzeżeń i aktywacji.
//
//   GET  /api/ceny/strategie                       typy, domyślna, lista strategii z liczbą towarów
//   POST /api/ceny/strategie       { id?, nazwa, typ, parametry, potwierdz }   nowa (zawsze jako podgląd) / zmiana
//   POST /api/ceny/strategie/status { id, aktywna, potwierdz }                 podgląd ↔ aktywna
//   POST /api/ceny/strategie/usun   { id }                                     tylko bez przypisanych towarów
//   POST /api/ceny/strategie/przypisz { strategia_id, kody, do, potwierdz }    symbole / EAN-y, hurtem
//   POST /api/ceny/strategie/zdejmij  { tw_ids }                               towar wraca na domyślną
//   GET  /api/ceny/strategie/:id/podglad                                       min/max bez i ze strategią per oferta

const express = require('express');
const { db } = require('../pricing/db');
const s = require('../pricing/strategie');
const dane = require('../pricing/strategie-dane');
const { pasyZWyceny, opcjeZOfert } = require('../pricing/pas');
const { zGranicami } = require('../pricing/granice');
const { jednaNaTowar, dzienLokalny } = require('../pricing/pulpit-model');
const { wycenaHurtem } = require('../services/cennik');
const { znajdzTowar } = require('../pricing/powiazania');

const MAX_KODOW = 500;

module.exports = function strategieRouter({ SQL_OFERTY, zKanalem, cenaTeraz, asyncH }) {
  const router = express.Router();
  const blad = (res, kod, tekst, dodatki = {}) => res.status(kod).json({ blad: tekst, ...dodatki });
  const potwierdzenie = (res, ostrzezenia) => blad(res, 409, `Wymaga potwierdzenia: ${ostrzezenia.map((o) => o.tekst).join('; ')}`, { ostrzezenia, potwierdzenie: true });

  router.get('/', (req, res) => {
    res.json({
      typy: Object.entries(s.TYPY).map(([klucz, t]) => ({ klucz, ...t })),
      domyslna: { ...s.DOMYSLNA, opis: s.opisParametrow(s.DOMYSLNA) },
      strategie: dane.lista(),
      dzis: dzienLokalny(new Date()),
    });
  });

  router.post('/', (req, res) => {
    const b = req.body || {};
    const id = b.id != null && b.id !== '' ? Number(b.id) : null;
    const w = s.walidujStrategie(b);
    if (w.blad) return blad(res, 400, w.blad);
    if (w.nazwa.toLowerCase() === s.DOMYSLNA.nazwa.toLowerCase()) return blad(res, 400, `„${s.DOMYSLNA.nazwa}” to strategia domyślna — wybierz inną nazwę`);
    const byla = id != null ? dane.pobierz(id) : null;
    if (id != null && !byla) return blad(res, 404, 'nie ma takiej strategii');
    const ostrzezenia = s.ostrzezeniaStrategii(w);
    if (byla?.aktywna) {
      const n = dane.ileTowarow(id);
      ostrzezenia.push({ kod: 'aktywna', tekst: `strategia jest aktywna — zmiana od najbliższego przebiegu zmieni granice automatu dla ${n} towarów` });
    }
    if (ostrzezenia.length && b.potwierdz !== true) return potwierdzenie(res, ostrzezenia);
    try {
      res.json({ ok: true, strategia: dane.zapisz(id, w, b.operator) });
    } catch (e) { blad(res, e.status || 500, e.message); }
  });

  router.post('/status', (req, res) => {
    const b = req.body || {};
    const x = dane.pobierz(b.id);
    if (!x) return blad(res, 404, 'nie ma takiej strategii');
    const aktywna = b.aktywna === true || b.aktywna === 1;
    // Aktywacja zmienia ceny na żywo — bez wyraźnego potwierdzenia nie przełączamy (także przez API).
    if (aktywna && !x.aktywna && b.potwierdz !== true) {
      return potwierdzenie(res, [{ kod: 'aktywacja', tekst: `od najbliższego przebiegu automat użyje granic „${x.nazwa}” na ${dane.ileTowarow(x.id)} towarach (oferty z automatem)` }]);
    }
    try { res.json({ ok: true, strategia: dane.ustawStatus(x.id, aktywna, b.operator) }); } catch (e) { blad(res, e.status || 500, e.message); }
  });

  router.post('/usun', (req, res) => {
    try { dane.usun(req.body?.id, req.body?.operator); res.json({ ok: true }); } catch (e) { blad(res, e.status || 500, e.message); }
  });

  // Kod → towar: najpierw nasze oferty (symbol GT, SKU, EAN), potem kartoteka GT (symbol albo EAN).
  const zOfert = db.prepare(`SELECT DISTINCT tw_id, symbol_gt FROM oferty WHERE tw_id IS NOT NULL
      AND (UPPER(symbol_gt) = UPPER(?) OR UPPER(sku) = UPPER(?) OR ean = ?) LIMIT 2`);
  async function rozpoznaj(kod) {
    const lok = zOfert.all(kod, kod, kod);
    if (lok.length === 1) return { tw_id: lok[0].tw_id, symbol: lok[0].symbol_gt };
    const t = await znajdzTowar(kod);          // rzuca z opisem: brak / niejednoznaczny
    return { tw_id: t.tw_Id, symbol: t.tw_Symbol };
  }

  router.post('/przypisz', asyncH(async (req, res) => {
    const b = req.body || {};
    const st = dane.pobierz(b.strategia_id);
    if (!st) return blad(res, 404, 'nie ma takiej strategii');
    const kody = [...new Set((Array.isArray(b.kody) ? b.kody : String(b.kody || '').split(/[\s,;]+/)).map((k) => String(k).trim()).filter(Boolean))];
    if (!kody.length) return blad(res, 400, 'podaj symbole albo EAN-y towarów');
    if (kody.length > MAX_KODOW) return blad(res, 400, `najwyżej ${MAX_KODOW} towarów naraz`);
    const koniec = s.walidujKoniec(b.do, st, dzienLokalny(new Date()));
    if (koniec.blad) return blad(res, 400, koniec.blad);
    const towary = [], nieznalezione = [];
    for (const kod of kody) {
      try {
        const t = await rozpoznaj(kod);
        if (!towary.some((x) => x.tw_id === t.tw_id)) towary.push(t);
      } catch (e) { nieznalezione.push({ kod, powod: e.message }); }
    }
    if (!towary.length) return blad(res, 400, `żaden kod nie pasuje do towaru: ${nieznalezione.map((x) => x.powod).join('; ')}`, { nieznalezione });
    const juz = dane.przypisania({ twIds: towary.map((t) => t.tw_id) });
    const inne = towary.filter((t) => juz.get(t.tw_id) && juz.get(t.tw_id).strategia.id !== st.id);
    const ostrzezenia = [];
    if (inne.length) ostrzezenia.push({ kod: 'inna', tekst: `${inne.length} towarów ma inną strategię (${inne.slice(0, 5).map((t) => `${t.symbol}: ${juz.get(t.tw_id).strategia.nazwa}`).join(', ')}${inne.length > 5 ? '…' : ''}) — przejdą na „${st.nazwa}”` });
    if (st.aktywna) ostrzezenia.push({ kod: 'aktywna', tekst: `„${st.nazwa}” jest aktywna — granice automatu zmienią się od najbliższego przebiegu` });
    if (ostrzezenia.length && b.potwierdz !== true) return potwierdzenie(res, ostrzezenia);
    const w = dane.przypisz(st, towary, koniec.do, b.operator);
    res.json({ ok: true, ...w, nieznalezione });
  }));

  router.post('/zdejmij', (req, res) => {
    const ids = Array.isArray(req.body?.tw_ids) ? req.body.tw_ids.map(Number).filter(Number.isInteger) : [];
    if (!ids.length) return blad(res, 400, 'podaj tw_ids');
    res.json({ ok: true, zdjete: dane.zdejmij(ids, req.body.operator) });
  });

  // Podgląd: dla każdej oferty przypisanego towaru min/max bez strategii i ze strategią (oba po ręcznych granicach
  // oferty — odstępstwo wygrywa) i co automat zrobi od razu (pricing/strategie.js skutek).
  router.get('/:id/podglad', asyncH(async (req, res) => {
    const st = dane.pobierz(req.params.id);
    if (!st) return blad(res, 404, 'nie ma takiej strategii');
    const przyp = dane.przypisania({ strategiaId: st.id });
    const twIds = [...przyp.keys()];
    if (!twIds.length) return res.json({ strategia: { ...st, opis: s.opisParametrow(st) }, towary: [], gt_ok: true, podsumowanie: {} });
    const wszystkie = db.prepare(`${SQL_OFERTY} AND o.tw_id IN (${twIds.join(',')})`).all().map(zKanalem);
    const pokazane = jednaNaTowar(wszystkie);
    let wyceny = null;
    try { wyceny = await wycenaHurtem(twIds); } catch (e) { console.error('[ceny] strategie — wycena GT:', e.message); }
    const { poTw, zakonczone, stany } = await dane.strategieDlaPasow(twIds, { tylkoAktywne: false, przyp });
    const konce = new Map(zakonczone.map((z) => [z.tw_id, z.powod]));
    const podsumowanie = {};
    const towary = twIds.map((tw) => {
      const p = przyp.get(tw);
      const oferty = pokazane.filter((o) => o.tw_id === tw);
      const w = wyceny?.get(tw) || null;
      const opcje = opcjeZOfert(wszystkie.filter((o) => o.tw_id === tw));
      const bez = w ? pasyZWyceny(w, opcje) : {};
      const ze = w && poTw.get(tw) ? pasyZWyceny(w, { ...opcje, strategia: poTw.get(tw) }) : null;
      let referencja = null;
      const wiersze = oferty.map((o) => {
        const przed = zGranicami(bez[o.kolumna] || null, o);
        const po = ze ? zGranicami(ze[o.kolumna] || null, o) : null;
        if (po?.referencja) referencja = po.referencja;
        const cena = cenaTeraz(o);
        const sk = !w ? { kod: 'brak_gt', tekst: 'Subiekt nie odpowiada — bez kosztu nie policzymy granic' }
          : !ze ? { kod: 'koniec', tekst: 'przypisanie zakończone — strategia już nie działa' }
          : s.skutek({ auto: o.auto, cena, wysylka: o.wysylka, bb_nasz: o.bb_nasz, bb_cena: o.bb_cena }, przed, po);
        podsumowanie[sk.kod] = (podsumowanie[sk.kod] || 0) + (o.auto ? 1 : 0);
        const pas = (x) => (x ? { min: x.min, max: x.max, zrodlo_min: x.zrodlo_min, zrodlo_max: x.zrodlo_max, blad: x.blad || null } : null);
        return {
          id: o.id, kolumna: o.kolumna, kanal: o.kanal_nazwa, waluta: o.waluta, sku: o.sku, auto: !!o.auto, tylko_odczyt: o.tylko_odczyt,
          cena, bb_nasz: o.bb_nasz, bb_cena: o.bb_cena, wysylka: o.wysylka,
          bez: pas(przed), ze: pas(po), odstepstwo: o.min_reczne > 0 || o.max_reczne > 0,
          zysk_teraz: przed?.ocen(cena)?.zysk ?? null, zysk_min_ze: po?.min ? po.ocen(po.min)?.zysk ?? null : null,
          skutek: sk,
        };
      });
      return { tw_id: tw, symbol: p.symbol_gt || oferty[0]?.symbol_gt, nazwa: oferty[0]?.nazwa || null, do: p.do, kto: p.kto, czas: p.czas,
        koniec: konce.get(tw) || null, stan: stany.get(tw) ?? null, referencja, oferty: wiersze };
    }).sort((a, b) => String(a.symbol).localeCompare(String(b.symbol)));
    res.json({ strategia: { ...st, opis: s.opisParametrow(st) }, towary, gt_ok: !!wyceny, podsumowanie });
  }));

  return router;
};
