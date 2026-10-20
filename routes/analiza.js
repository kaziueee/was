'use strict';

// Moduł analiz sprzedaży — API (docs/analiza-sprzedazy.md). Czyta WYŁĄCZNIE db/sprzedaz.db (i pricing.db do
// stanu repricera), nigdy GT — tak ekrany są szybkie także na telefonie. Montowane z auth.wymagajRoli('admin',
// 'biuro'), także odczyt (koszty zakupu i zysk nie są dla hali). Liczby składa services/analiza-zapytania.js —
// to samo źródło co raport mailem (services/analiza-raport.js).
//   GET /api/analiza/stan                                     kiedy wczytano, od kiedy jest historia
//   GET /api/analiza/podsumowanie?dzien=&zakres=&baza=         kanały: bieżący zakres vs ten sam sprzed 364 dni
//   GET /api/analiza/produkty?dzien=&zakres=&baza=&sort=&limit= towary z kanałami, stanem, flagami i repricerem
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

router.get('/raport', async (req, res, next) => {
  try {
    const { zbierzRaport, htmlRaportu } = require('../services/analiza-raport');
    const r = await zbierzRaport(req.query.dzien, { tydzien: req.query.tydzien === '1', zdjecia: false });
    res.type('html').send(htmlRaportu(r, { podglad: true }));
  } catch (e) { next(e); }
});

module.exports = router;
