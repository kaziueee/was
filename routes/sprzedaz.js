'use strict';

// Zadanie sprzedazowe - lista SKU, ktorym chcemy podbic sprzedaz, i efekt liczony z FS w GT.
// Montowane z auth.wymagajRoli('admin', 'biuro') - takze odczyt (app.js).
//   GET    /api/sprzedaz/zadania        lista + sprzedaz (od startu, 7 dni, srednia/tydz. przed)
//   POST   /api/sprzedaz/zadania        { kod, od_dnia? }  kod = SKU lub EAN, od_dnia domyslnie dzis
//   DELETE /api/sprzedaz/zadania/:id

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { znajdzTowarPoKodzie } = require('../services/gt-produkty');
const { sprzedazDziennaFs } = require('../services/gt-sprzedaz');
const sprzedazDb = require('../db/sprzedaz');
const { dzisLokalnie, zakresOd, podsumujSprzedaz } = require('../services/sprzedaz-model');

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;

// Sprzedaż dzienna z bazy modułu analiz (db/sprzedaz.db) — ta sama definicja co dotąd: FS z K4, data faktury, bez
// paragonów (status 'zafakturowane'). Bez czekania na GT. Gdy historia modułu nie sięga `od` (świeże wdrożenie,
// zanim scripts/analiza-wczytaj.js wczytał przeszłość), liczymy jak dawniej z GT — inaczej „przed startem” wyszłoby 0.
async function sprzedazDzienna(twIds, od) {
  const hist = sprzedazDb.meta.get('historia_od')?.wartosc;
  if (!hist || hist > od) return sprzedazDziennaFs(twIds, od);
  const idy = [...new Set(twIds.map(Number))].filter(Number.isInteger);
  const wynik = new Map();
  if (!idy.length) return wynik;
  const r = sprzedazDb.db.prepare(`SELECT p.tw_id, z.data_fs dzien, SUM(p.szt) szt FROM pozycje p JOIN zamowienia z ON z.id = p.zam_id
    WHERE z.status = 'zafakturowane' AND z.data_fs >= ? AND p.tw_id IN (${idy.map(() => '?').join(',')}) GROUP BY p.tw_id, z.data_fs`).all(od, ...idy);
  for (const w of r) {
    const k = String(w.tw_id);
    if (!wynik.has(k)) wynik.set(k, []);
    wynik.get(k).push({ dzien: w.dzien, szt: Number(w.szt) || 0 });
  }
  return wynik;
}

router.get('/zadania', async (req, res) => {
  const zadania = db.prepare('SELECT * FROM zadania_sprzedazowe ORDER BY od_dnia DESC, id DESC').all();
  const dzis = dzisLokalnie();
  if (!zadania.length) return res.json({ gt_ok: true, dzis, zadania: [] });

  let sprzedaz = null;
  try {
    const od = zadania.map((z) => zakresOd(z.od_dnia, dzis)).sort()[0];
    sprzedaz = await sprzedazDzienna(zadania.map((z) => z.artykul_gt_id), od);
  } catch (e) {
    // GT nie odpowiada: lista zostaje (to wiedza WMS), liczb nie zgadujemy - front pokaze "—"
    console.error('[sprzedaz] GT:', e.message);
  }
  res.json({
    gt_ok: !!sprzedaz,
    dzis,
    zadania: zadania.map((z) => ({
      ...z,
      ...(sprzedaz ? podsumujSprzedaz(sprzedaz.get(String(z.artykul_gt_id)) || [], z.od_dnia, dzis) : {}),
    })),
  });
});

router.post('/zadania', async (req, res, next) => {
  try {
    const kod = String(req.body?.kod || '').trim();
    if (!kod) return res.status(400).json({ blad: 'Podaj SKU lub EAN' });
    const odDnia = req.body?.od_dnia ? String(req.body.od_dnia) : dzisLokalnie();
    if (!DATA_RE.test(odDnia) || Number.isNaN(Date.parse(odDnia))) {
      return res.status(400).json({ blad: 'Niepoprawna data startu' });
    }

    let towar;
    try { towar = await znajdzTowarPoKodzie(kod); }
    catch { return res.status(503).json({ blad: 'Subiekt GT nie odpowiada - spróbuj za chwilę' }); }
    if (!towar) return res.status(404).json({ blad: `Nie znaleziono towaru: ${kod}` });

    const jest = db.prepare('SELECT id FROM zadania_sprzedazowe WHERE artykul_gt_id = ?').get(towar.artykul_gt_id);
    if (jest) return res.status(409).json({ blad: `${towar.symbol} jest już na liście` });

    const r = db.prepare(`INSERT INTO zadania_sprzedazowe (artykul_gt_id, symbol, nazwa, od_dnia, dodal)
      VALUES (?, ?, ?, ?, ?)`).run(towar.artykul_gt_id, towar.symbol, towar.nazwa, odDnia, req.uzytkownik?.imie || null);
    res.status(201).json({ id: r.lastInsertRowid, ...towar, od_dnia: odDnia });
  } catch (e) { next(e); }
});

router.delete('/zadania/:id', (req, res) => {
  const r = db.prepare('DELETE FROM zadania_sprzedazowe WHERE id = ?').run(Number(req.params.id));
  if (!r.changes) return res.status(404).json({ blad: 'Nie ma takiej pozycji' });
  res.status(204).end();
});

module.exports = router;
