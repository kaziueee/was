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

  // Most: pytamy /api/zdrowie, bo "proces odpowiada na HTTP" to ZA MALO. Kestrel odpowiada
  // niezaleznie od Sfery, wiec przy zawieszonej Sferze stara wersja tego sprawdzenia (GET / i
  // "kazda odpowiedz = dziala") trzymala kropke na zielono przez cala awarie - tak bylo
  // 2026-08-05, gdy MM przez ~45 minut wpadaly w 'pending'. Teraz rozdzielamy dwie rzeczy:
  //   most  - czy proces odpowiada (jak dotad; front tego uzywa jako podstawowej kropki),
  //   sfera - jak skonczyla sie OSTATNIA realna operacja Sfery ('ok' | 'blad' | 'nieznany')
  //           plus 'zajety_od', gdy most stoi w trwajacym wywolaniu COM.
  // Stary most bez /api/zdrowie odpowie 404 - wtedy zostaje samo most=true, sfera='nieznany'
  // (zachowanie jak przed zmiana, zeby wdrozenie Node przed mostem niczego nie zepsulo).
  let most = false;
  let sfera = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch((process.env.GT_BRIDGE_URL ?? 'http://localhost:5000') + '/api/zdrowie', { signal: ctrl.signal });
    clearTimeout(t);
    most = true;
    if (res.ok) {
      const d = await res.json().catch(() => null);
      if (d) sfera = { stan: d.sfera, komunikat: d.komunikat, czas: d.czas, zajety_od: d.zajety_od, w_kolejce: d.w_kolejce };
    }
  } catch {
    most = false;
  }

  // Srodowisko testowe (Mac/dev) - flaga w .env WMS_TESTOWY=1. Produkcja jej nie ustawia,
  // wiec pasek "TESTOWY" tam sie nie pokaze, nawet gdyby kod tam trafil. Zob. public/shared/auth.js.
  res.json({ baza, gt, most, sfera, testowy: process.env.WMS_TESTOWY === '1' });
});

module.exports = router;
