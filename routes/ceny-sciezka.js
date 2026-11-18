'use strict';

// Ceny → „Ścieżka”: każdy towar ze stanem na K4/K4G z krokami wystawienia (Subiekt → sklep → Allegro → rynki).
// Liczy wątek services/sciezka-wystawienia.js; tu tylko podajemy gotowy tekst (bez parsowania w głównym wątku —
// zasada 7) i przyjmujemy ręczne odhaczenie karty sklepu. Montowane w routes/ceny.js pod /api/ceny/sciezka
// (admin + biuro, jak reszta Cen).
//
//   GET  /api/ceny/sciezka              gotowy snapshot (JSON z wątku) albo { brak: true }, gdy pierwszy jeszcze się liczy
//   POST /api/ceny/sciezka/odswiez      prośba o świeży przebieg (wątek podchwyci w ≤ 15 s, sam przebieg ~10–20 s)
//   POST /api/ceny/sciezka/karta        { tw_id, karta_id?, odhaczone }  karta w sklepie założona / cofnij odhaczenie

const express = require('express');
const db = require('../db/database');
const audyt = require('../services/audyt');
const sciezka = require('../services/sciezka-wystawienia');

module.exports = function sciezkaRouter({ asyncH }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const w = sciezka.odczytajSurowe();
    if (!w?.wartosc) return res.json({ brak: true });
    // Odhaczenia czytamy NA ŻYWO (mała tabela), żeby świeże odhaczenie było widać od razu, zanim wątek przeliczy.
    const karty = db.prepare('SELECT tw_id, karta_id, kto, czas FROM sklep_karty').all();
    res.type('application/json').send(`{"karty":${JSON.stringify(karty)},"snapshot":${w.wartosc}}`);
  });

  router.post('/odswiez', (req, res) => {
    sciezka.zlecOdswiezenie();
    res.json({ ok: true });
  });

  // Odhaczenie to wyłącznie informacja na ekranie („karta jest, czeka na BaseLinkera”) — nic od niego nie zależy,
  // ale idzie do audytu, żeby było widać, kto i kiedy to stwierdził.
  router.post('/karta', asyncH(async (req, res) => {
    const b = req.body || {};
    const twId = Number(b.tw_id);
    if (!Number.isInteger(twId) || twId <= 0) return res.status(400).json({ blad: 'tw_id musi być liczbą całkowitą' });
    const kto = b.operator || null;
    if (b.odhaczone === false) {
      const byl = db.prepare('SELECT * FROM sklep_karty WHERE tw_id = ?').get(twId);
      db.prepare('DELETE FROM sklep_karty WHERE tw_id = ?').run(twId);
      if (byl) audyt.zapisz({ uzytkownik: kto, akcja: 'sciezka_karta_cofnieta', artykul_gt_id: twId, artykul_symbol: byl.symbol, przed: byl });
      return res.json({ ok: true, odhaczone: false });
    }
    let kartaId = null;
    if (b.karta_id != null && String(b.karta_id).trim() !== '') {
      kartaId = Number(String(b.karta_id).trim());
      if (!Number.isInteger(kartaId) || kartaId <= 0) return res.status(400).json({ blad: 'numer karty w sklepie musi być liczbą całkowitą' });
    }
    const symbol = typeof b.symbol === 'string' ? b.symbol.trim().slice(0, 60) || null : null;
    db.prepare(`INSERT INTO sklep_karty (tw_id, symbol, karta_id, kto, czas) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT (tw_id) DO UPDATE SET symbol = excluded.symbol, karta_id = excluded.karta_id, kto = excluded.kto, czas = CURRENT_TIMESTAMP`)
      .run(twId, symbol, kartaId, kto);
    audyt.zapisz({ uzytkownik: kto, akcja: 'sciezka_karta_zalozona', artykul_gt_id: twId, artykul_symbol: symbol, po: { karta_id: kartaId } });
    res.json({ ok: true, odhaczone: true, karta_id: kartaId });
  }));

  return router;
};
