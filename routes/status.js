const express = require('express');
const { query } = require('../services/gt-sql');

const router = express.Router();

// GET /api/status - stan srodowiska dla ekranu logowania: nazwa bazy GT, czy jest
// polaczenie z GT (SQL) i czy odpowiada most (GtBridge). PUBLICZNY (pokazywany przed
// zalogowaniem). Kazde sprawdzenie ma krotki timeout - nie blokuje logowania.
router.get('/', async (req, res) => {
  const bazaEnv = process.env.GT_SQL_DATABASE || null;

  // GT: lekkie zapytanie potwierdza polaczenie i zwraca realna nazwe bazy
  let gt = false;
  let baza = bazaEnv;
  try {
    const r = await query('SELECT DB_NAME() AS db');
    gt = true;
    baza = r.recordset?.[0]?.db ?? bazaEnv;
  } catch {
    gt = false;
  }

  // Most: dowolna odpowiedz HTTP = proces zyje; blad polaczenia (ECONNREFUSED) = down
  let most = false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    await fetch((process.env.GT_BRIDGE_URL ?? 'http://localhost:5000') + '/', { signal: ctrl.signal });
    clearTimeout(t);
    most = true;
  } catch {
    most = false;
  }

  // Srodowisko testowe (Mac/dev) - flaga w .env WMS_TESTOWY=1. Produkcja jej nie ustawia,
  // wiec pasek "TESTOWY" tam sie nie pokaze, nawet gdyby kod tam trafil. Zob. public/shared/auth.js.
  res.json({ baza, gt, most, testowy: process.env.WMS_TESTOWY === '1' });
});

module.exports = router;
