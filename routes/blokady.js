const express = require('express');
const auth = require('../services/auth');
const blokady = require('../services/blokady');

const router = express.Router();

// wszystkie operacje na blokadach wymagaja zalogowania (musimy wiedziec KTO)
router.use(auth.wymagajSesji);

// GET /api/blokady/:artykul_gt_id - kto (jesli ktos) edytuje ten produkt
router.get('/:artykul_gt_id', (req, res) => {
  const b = blokady.status(req.params.artykul_gt_id);
  res.json(b ? { zajete: true, przez: b.imie, moje: b.token === req.uzytkownik.token } : { zajete: false });
});

// POST /api/blokady/:artykul_gt_id/zajmij - przejmij lock edycji
router.post('/:artykul_gt_id/zajmij', (req, res) => {
  const w = blokady.zajmij(req.params.artykul_gt_id, req.uzytkownik);
  if (w.zajete) return res.status(409).json(w); // 409: edytuje kto inny
  res.json(w);
});

// POST /api/blokady/:artykul_gt_id/heartbeat - odswiez lock (podczas edycji)
router.post('/:artykul_gt_id/heartbeat', (req, res) => {
  const nasze = blokady.heartbeat(req.params.artykul_gt_id, req.uzytkownik.token);
  res.json({ ok: nasze });
});

// POST /api/blokady/:artykul_gt_id/zwolnij - zwolnij lock (koniec edycji)
router.post('/:artykul_gt_id/zwolnij', (req, res) => {
  blokady.zwolnij(req.params.artykul_gt_id, req.uzytkownik.token);
  res.json({ ok: true });
});

module.exports = router;
