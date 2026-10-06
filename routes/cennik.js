'use strict';

// GET /api/cennik/:sku[?waga=&tryb=&bufor=&anchor=&anchorCena=&docinanieOn=] - koszt z GT + ceny rynkow.
// tryb: 'marza' | 'zysk' | 'kotwica' (kotwica: FR/IT/ES/NL celuja w zysk Amazon DE + bufor zl).
// docinanieOn=1 -> caly cennik DHL o 1 prog nizej (dla towarow docinalnych - pole "Docinanie").
// Czysty odczyt z GT, ale tylko dla rol admin/biuro (app.js, auth.wymagajRoli). Nie robi zadnych ruchow/zapisow.

const express = require('express');
const router = express.Router();
const { wycenaPoSku } = require('../services/cennik');

router.get('/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku || '').trim();
    if (!sku) return res.status(400).json({ blad: 'Podaj SKU' });
    const nadpisz = {};
    if (req.query.waga != null && req.query.waga !== '') nadpisz.waga = Number(req.query.waga);
    if (req.query.tryb) nadpisz.tryb = String(req.query.tryb);
    if (req.query.bufor != null && req.query.bufor !== '') nadpisz.bufor = Number(req.query.bufor);
    if (req.query.anchor && req.query.anchorCena != null && req.query.anchorCena !== '')
      nadpisz.anchor = { nazwa: String(req.query.anchor), cena: Number(req.query.anchorCena) };
    if (req.query.docinanieOn === '1' || req.query.docinanieOn === 'true') nadpisz.docinanieOn = true;
    const wy = await wycenaPoSku(sku, nadpisz);
    if (!wy) return res.status(404).json({ blad: 'Nie znaleziono towaru: ' + sku });
    res.json(wy);
  } catch (e) { next(e); }
});

module.exports = router;
