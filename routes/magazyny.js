const express = require('express');
const { MAGAZYNY } = require('../config/magazyny');

const router = express.Router();

// GET /api/magazyny - lista magazynow (filtr: ?typ=wms|zewnetrzny)
router.get('/', (req, res) => {
  const { typ } = req.query;
  const lista = typ ? MAGAZYNY.filter((m) => m.typ === typ) : MAGAZYNY;
  res.json(lista);
});

module.exports = router;
