'use strict';

// Moduł analiz sprzedaży — API (docs/analiza-sprzedazy.md). Czyta WYŁĄCZNIE db/sprzedaz.db (i pricing.db do
// stanu repricera), nigdy GT — tak ekrany są szybkie także na telefonie. Montowane z auth.wymagajRoli('admin'),
// także odczyt (zysk, marża, koszt — decyzja usera 2026-10-21). Liczby składa services/analiza-zapytania.js —
// to samo źródło co raport mailem (services/analiza-raport.js).
//   GET /api/analiza/stan                                     kiedy wczytano, od kiedy jest historia
//   GET /api/analiza/podsumowanie?dzien=&zakres=&baza=         kanały: bieżący zakres vs ten sam sprzed 364 dni
//   GET /api/analiza/produkty?dzien=&zakres=&baza=&sort=&limit= towary z kanałami, stanem, flagami i repricerem
//   GET /api/analiza/trendy                                    Sprzedaż → Trendy: dni zamknięte do wczoraj (services/analiza-trendy.js)
//   GET /api/analiza/live?przed=&limit=                        telefon „Live”: ostatnie zamówienia po kolei (kursor „dzień|zk|fs”)
//   GET /api/analiza/oferty/:tw_id                             linki do ofert towaru na platformach (karta produktu w Trendach)
//   GET /api/analiza/raport?dzien=&tydzien=1                   podgląd maila (HTML) — to, co wyśle job
// zakres: dzien | t7 | mtd | ytd · baza: zam (data zamówienia) | fs (data faktury) · sort: zysk | szt | netto

const express = require('express');
const router = express.Router();
const q = require('../services/analiza-zapytania');
const { dzisLokalnie } = require('../services/sprzedaz-model');

router.get('/stan', (req, res) => res.json({ ...q.stanWczytania(), dzis: dzisLokalnie() }));

router.get('/podsumowanie', (req, res) => res.json(q.podsumowanie(q.parametry(req.query))));

router.get('/produkty', (req, res) => {
  const sort = ['zysk', 'szt', 'netto'].includes(req.query.sort) ? req.query.sort : 'zysk';
  const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 2000);
  res.json(q.produkty(q.parametry(req.query), { sort, limit }));
});

router.get('/live', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 100);
  res.json(q.live({ przed: req.query.przed || null, limit }));
});

// Trendy liczy wątek analiz (services/analiza-watek.js) — tu tylko gotowy JSON, bez liczenia w wątku Zebry
router.get('/trendy', (req, res) => {
  const t = require('../services/analiza-trendy');
  const gz = /\bgzip\b/.test(req.get('accept-encoding') || '');
  let g = t.gotowe({ gz });
  if (gz && g && !g.dane) g = t.gotowe();             // wynik sprzed kolumny gz — wysyłamy zwykły
  if (!g?.dane) return res.status(503).json({ blad: 'Trendy jeszcze się liczą (pierwsze ~2 minuty po starcie WMS) — odśwież za chwilę.' });
  res.set('Vary', 'Accept-Encoding').type('application/json');
  if (Buffer.isBuffer(g.dane) || g.dane instanceof Uint8Array) res.set('Content-Encoding', 'gzip').send(Buffer.from(g.dane));
  else res.send(g.dane);
});

router.get('/oferty/:tw', (req, res) => {
  const id = Number(req.params.tw);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ blad: 'Zły identyfikator towaru' });
  res.json(require('../services/analiza-trendy').ofertyTowarow(new Set([id]))[id] || {});
});

router.get('/raport', async (req, res, next) => {
  try {
    const { zbierzRaport, htmlRaportu } = require('../services/analiza-raport');
    const r = await zbierzRaport(req.query.dzien, { tydzien: req.query.tydzien === '1', zdjecia: false });
    res.type('html').send(htmlRaportu(r, { podglad: true }));
  } catch (e) { next(e); }
});

module.exports = router;
