const express = require('express');
const { pobierzUzupelnienia } = require('../services/uzupelnienia');

const router = express.Router();

// GET /api/uzupelnienia - lista "Uzupelnienia K4" (towary do sciagniecia z K4 Gora
// na K4) z rozbiciem rezerwacji na kanaly wysylki. GT-centryczne - blad polaczenia
// z GT propagujemy jako 500 (bez danych z GT lista nie ma sensu).
router.get('/', async (req, res, next) => {
  try {
    const pozycje = await pobierzUzupelnienia();
    res.json({ pozycje, total: pozycje.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
