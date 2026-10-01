'use strict';

// GET /api/cennik/:sku[?waga=] - koszt zakupu z GT + sugerowane ceny na wszystkich rynkach.
// Czysty odczyt z GT (jak /api/zestawienia) - bez sesji. Nie robi zadnych ruchow/zapisow.

const express = require('express');
const router = express.Router();
const { wycenaPoSku } = require('../services/cennik');

router.get('/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku || '').trim();
    if (!sku) return res.status(400).json({ blad: 'Podaj SKU' });
    const nadpisz = {};
    if (req.query.waga != null && req.query.waga !== '') nadpisz.waga = Number(req.query.waga);
    const wy = await wycenaPoSku(sku, nadpisz);
    if (!wy) return res.status(404).json({ blad: 'Nie znaleziono towaru: ' + sku });
    res.json(wy);
  } catch (e) { next(e); }
});

module.exports = router;
