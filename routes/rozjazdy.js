'use strict';

const express = require('express');
const db = require('../db/database');
const gtFields = require('../services/gt-fields');
const { wykonajDetekcjeRozjazdow } = require('../services/rozjazdy');

const router = express.Router();

// GET /api/rozjazdy - lista rozjazdow (filtry: ?status=, ?magazyn=)
router.get('/', (req, res) => {
  const { status, magazyn } = req.query;
  let sql = 'SELECT * FROM rozjazdy WHERE 1=1';
  const params = [];

  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (magazyn) {
    sql += ' AND magazyn = ?';
    params.push(magazyn);
  }
  sql += ' ORDER BY wykryty DESC';

  res.json(db.prepare(sql).all(...params));
});

// POST /api/rozjazdy/detekcja - reczne wywolanie joba detekcji (np. przycisk
// "Odswiez" w raporcie rozjazdow na desktopie), poza standardowym harmonogramem co godzine
router.post('/detekcja', async (req, res, next) => {
  try {
    res.json(await wykonajDetekcjeRozjazdow());
  } catch (err) {
    next(err);
  }
});

// POST /api/rozjazdy/:id/resolve - rozwiazanie rozjazdu K4G: magazynier wskazuje,
// z ktorych lokalizacji odjac ile sztuk, tak by suma WMS wrocila do stanu GT.
// body: { korekty: [{lokalizacja_id, ilosc_po}], operator }
// (K4 jest auto-korygowane przez job - nie wymaga recznego rozwiazania)
router.post('/:id/resolve', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ blad: 'Nieprawidlowe id' });

  const rozjazd = db.prepare('SELECT * FROM rozjazdy WHERE id = ?').get(id);
  if (!rozjazd) return res.status(404).json({ blad: 'Rozjazd nie istnieje' });
  if (rozjazd.status !== 'nowy') {
    return res.status(409).json({ blad: `Rozjazd ma status '${rozjazd.status}' - rozwiazywanie dotyczy tylko 'nowy'` });
  }
  if (rozjazd.magazyn !== 'K4G') {
    return res.status(400).json({ blad: 'Tylko rozjazdy K4G wymagaja recznego rozwiazania (K4 jest auto-korygowane przez job)' });
  }

  const { korekty, operator } = req.body ?? {};

  const obecne = db.prepare(`
    SELECT s.id, s.lokalizacja_id, s.ilosc, l.kod
    FROM stany_lokalizacji s
    JOIN lokalizacje l ON l.id = s.lokalizacja_id
    WHERE s.artykul_gt_id = ? AND l.magazyn = 'K4G' AND s.ilosc > 0
  `).all(rozjazd.artykul_gt_id);

  const iloscWmsAktualna = obecne.reduce((suma, w) => suma + w.ilosc, 0);
  const wymaganaRedukcja = iloscWmsAktualna - rozjazd.ilosc_gt;

  // miedzy detekcja a rozwiazaniem stan WMS mogl sie juz zmienic (inny ruch) -
  // jesli roznica ustapila, oznacz jako wyjasniony bez wymagania korekt
  if (wymaganaRedukcja <= 0) {
    db.prepare(`
      UPDATE rozjazdy SET status = 'wyjasniony', wyjasniony = CURRENT_TIMESTAMP,
        ilosc_wms = ?, roznica = ?, opis = 'Rozjazd ustapil przed rozwiazaniem (stan WMS juz odpowiada GT)'
      WHERE id = ?
    `).run(iloscWmsAktualna, rozjazd.ilosc_gt - iloscWmsAktualna, id);
    return res.json({ wynik: 'juz_rozwiazany', rozjazd: db.prepare('SELECT * FROM rozjazdy WHERE id = ?').get(id) });
  }

  if (!Array.isArray(korekty) || korekty.length === 0) {
    return res.status(400).json({
      blad: `Pole "korekty" jest wymagane (lista {lokalizacja_id, ilosc_po}) - do odjecia razem ${wymaganaRedukcja} szt.`,
    });
  }

  const obecneMap = new Map(obecne.map((w) => [w.lokalizacja_id, w]));
  let sumaRedukcji = 0;
  for (const korekta of korekty) {
    const wiersz = obecneMap.get(korekta.lokalizacja_id);
    if (!wiersz) {
      return res.status(400).json({ blad: `Lokalizacja ${korekta.lokalizacja_id} nie ma zapasu tego artykulu w K4G` });
    }
    const iloscPo = Number(korekta.ilosc_po);
    if (!Number.isFinite(iloscPo) || iloscPo < 0 || iloscPo > wiersz.ilosc) {
      return res.status(400).json({ blad: `Nieprawidlowa "ilosc_po" dla lokalizacji ${wiersz.kod} (obecnie: ${wiersz.ilosc})` });
    }
    sumaRedukcji += wiersz.ilosc - iloscPo;
  }

  if (sumaRedukcji !== wymaganaRedukcja) {
    return res.status(400).json({
      blad: `Suma korekt (${sumaRedukcji} szt.) musi odpowiadac roznicy WMS - GT (${wymaganaRedukcja} szt.)`,
    });
  }

  db.exec('BEGIN');
  try {
    const opisCzesci = [];
    for (const korekta of korekty) {
      const wiersz = obecneMap.get(korekta.lokalizacja_id);
      const iloscPo = Number(korekta.ilosc_po);
      if (iloscPo > 0) {
        db.prepare('UPDATE stany_lokalizacji SET ilosc = ?, ostatnia_zmiana = CURRENT_TIMESTAMP, operator = ? WHERE id = ?')
          .run(iloscPo, operator ?? null, wiersz.id);
      } else {
        db.prepare('DELETE FROM stany_lokalizacji WHERE id = ?').run(wiersz.id);
      }
      opisCzesci.push(`${wiersz.kod}: ${wiersz.ilosc} -> ${iloscPo}`);
    }

    db.prepare(`
      UPDATE rozjazdy SET status = 'wyjasniony', wyjasniony = CURRENT_TIMESTAMP, operator = ?,
        ilosc_wms = ?, roznica = 0, opis = ?
      WHERE id = ?
    `).run(operator ?? null, rozjazd.ilosc_gt, `Korekta: ${opisCzesci.join('; ')}`, id);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return next(err);
  }

  // odswiez "Lokalizacja Gorna"/"Lokalizacja Zapas" w GT po zmianie lokalizacji K4G -
  // najlepszy wysilek, brak retry-queue (to nie ruch); ewentualna nieswiezosc pola
  // GT zostanie nadpisana przy najblizszym ruchu na tym artykule
  const syncGt = await gtFields.synchronizujLokalizacje(rozjazd.artykul_gt_id, new Set(['K4G']));
  const syncStatus = syncGt ? (syncGt.ok && syncGt.dane?.sukces ? 'ok' : (syncGt.blad ?? syncGt.dane?.blad ?? `status ${syncGt.status}`)) : null;

  res.json({
    wynik: 'rozwiazany',
    rozjazd: db.prepare('SELECT * FROM rozjazdy WHERE id = ?').get(id),
    sync_gt: syncStatus,
  });
});

module.exports = router;
