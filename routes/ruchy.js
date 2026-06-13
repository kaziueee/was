const express = require('express');
const db = require('../db/database');
const { MAGAZYNY_ZEWNETRZNE } = require('../config/magazyny');
const { wykonajRuchGT } = require('../services/ruchy-gt');

const router = express.Router();

// POST /api/ruchy/mm - zapisz przesuniecie MM i wystaw dokument MM w GT przez most C#
router.post('/mm', async (req, res, next) => {
  const { artykul_gt_id, lok_zrodlo_id, lok_cel_id, mag_cel_zewnetrzny, ilosc, operator } = req.body ?? {};

  if (!artykul_gt_id) {
    return res.status(400).json({ blad: 'Pole "artykul_gt_id" jest wymagane' });
  }
  if (!Number.isInteger(lok_zrodlo_id)) {
    return res.status(400).json({ blad: 'Pole "lok_zrodlo_id" jest wymagane' });
  }
  const ilo = Number(ilosc);
  if (!Number.isFinite(ilo) || ilo <= 0) {
    return res.status(400).json({ blad: 'Pole "ilosc" musi byc liczba > 0' });
  }
  const celWMS = lok_cel_id !== undefined && lok_cel_id !== null;
  const celZewnetrzny = !!mag_cel_zewnetrzny;
  if (celWMS === celZewnetrzny) {
    return res.status(400).json({ blad: 'Podaj dokladnie jedno z: lok_cel_id (lokalizacja WMS) lub mag_cel_zewnetrzny' });
  }
  if (celZewnetrzny && !MAGAZYNY_ZEWNETRZNE.includes(String(mag_cel_zewnetrzny).trim().toUpperCase())) {
    return res.status(400).json({ blad: `Pole "mag_cel_zewnetrzny" musi byc jednym z: ${MAGAZYNY_ZEWNETRZNE.join(', ')}` });
  }

  const zrodlo = db.prepare('SELECT * FROM lokalizacje WHERE id = ?').get(lok_zrodlo_id);
  if (!zrodlo) return res.status(404).json({ blad: 'Lokalizacja zrodlowa nie istnieje' });

  const stanZrodlo = db.prepare(
    'SELECT * FROM stany_lokalizacji WHERE lokalizacja_id = ? AND artykul_gt_id = ?'
  ).get(lok_zrodlo_id, artykul_gt_id);

  if (!stanZrodlo || stanZrodlo.ilosc < ilo) {
    return res.status(409).json({
      blad: `Niewystarczajaca ilosc na lokalizacji zrodlowej (dostepne: ${stanZrodlo ? stanZrodlo.ilosc : 0})`
    });
  }

  let cel = null;
  if (celWMS) {
    cel = db.prepare('SELECT * FROM lokalizacje WHERE id = ?').get(lok_cel_id);
    if (!cel) return res.status(404).json({ blad: 'Lokalizacja docelowa nie istnieje' });
    if (cel.id === zrodlo.id) {
      return res.status(400).json({ blad: 'Lokalizacja docelowa jest taka sama jak zrodlowa' });
    }
    if (cel.aktywna !== 1) {
      return res.status(409).json({ blad: 'Lokalizacja docelowa jest nieaktywna' });
    }
    if (cel.magazyn === zrodlo.magazyn) {
      return res.status(400).json({ blad: 'Lokalizacja docelowa jest w tym samym magazynie co zrodlowa - MM wymaga przesuniecia miedzy roznymi magazynami' });
    }
  }

  // blokada inwentaryzacji ('otwarta') dla magazynow zaangazowanych w ruch
  const magazynyDoSprawdzenia = new Set([zrodlo.magazyn]);
  if (cel) magazynyDoSprawdzenia.add(cel.magazyn);
  for (const mag of magazynyDoSprawdzenia) {
    const otwarta = db.prepare(
      "SELECT id FROM inwentaryzacje WHERE magazyn = ? AND status = 'otwarta'"
    ).get(mag);
    if (otwarta) {
      return res.status(409).json({ blad: `Inwentaryzacja w toku dla magazynu ${mag} - MM zablokowane` });
    }
  }

  // zasada: w K4 artykul moze miec tylko jedna lokalizacje
  if (cel && cel.magazyn === 'K4') {
    const obecneK4 = db.prepare(
      `SELECT s.lokalizacja_id, s.ilosc FROM stany_lokalizacji s
       JOIN lokalizacje l ON l.id = s.lokalizacja_id
       WHERE s.artykul_gt_id = ? AND l.magazyn = 'K4' AND s.ilosc > 0`
    ).all(artykul_gt_id);

    const poRuchu = new Map(obecneK4.map((r) => [r.lokalizacja_id, r.ilosc]));
    if (zrodlo.magazyn === 'K4') {
      const pozostanie = (poRuchu.get(zrodlo.id) ?? 0) - ilo;
      if (pozostanie > 0) poRuchu.set(zrodlo.id, pozostanie);
      else poRuchu.delete(zrodlo.id);
    }
    poRuchu.set(cel.id, (poRuchu.get(cel.id) ?? 0) + ilo);

    if (poRuchu.size > 1) {
      return res.status(409).json({ blad: 'W magazynie K4 artykul moze miec tylko jedna lokalizacje (1 SKU = 1 lokalizacja)' });
    }
  }

  let ruchId;
  let magazynDocelowy;

  db.exec('BEGIN');
  try {
    magazynDocelowy = cel ? cel.magazyn : String(mag_cel_zewnetrzny).trim().toUpperCase();

    const ruch = db.prepare(`
      INSERT INTO ruchy (typ, artykul_gt_id, artykul_symbol, lok_zrodlo_id, lok_cel_id, mag_cel_zewnetrzny, ilosc, status, operator)
      VALUES ('MM', ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      artykul_gt_id,
      stanZrodlo.artykul_symbol,
      lok_zrodlo_id,
      cel ? cel.id : null,
      cel ? null : magazynDocelowy,
      ilo,
      operator ?? null
    );
    ruchId = ruch.lastInsertRowid;

    const pozostanie = stanZrodlo.ilosc - ilo;
    if (pozostanie > 0) {
      db.prepare('UPDATE stany_lokalizacji SET ilosc = ?, ostatnia_zmiana = CURRENT_TIMESTAMP, operator = ? WHERE id = ?')
        .run(pozostanie, operator ?? null, stanZrodlo.id);
    } else if (zrodlo.magazyn === 'K4') {
      // K4 to magazyn szybkiego zbioru - lokalizacja zostaje jako stale miejsce SKU do uzupelnienia
      db.prepare('UPDATE stany_lokalizacji SET ilosc = 0, ostatnia_zmiana = CURRENT_TIMESTAMP, operator = ? WHERE id = ?')
        .run(operator ?? null, stanZrodlo.id);
    } else {
      db.prepare('DELETE FROM stany_lokalizacji WHERE id = ?').run(stanZrodlo.id);
    }

    if (cel) {
      const stanCel = db.prepare('SELECT * FROM stany_lokalizacji WHERE lokalizacja_id = ? AND artykul_gt_id = ?')
        .get(cel.id, artykul_gt_id);
      if (stanCel) {
        db.prepare('UPDATE stany_lokalizacji SET ilosc = ilosc + ?, ostatnia_zmiana = CURRENT_TIMESTAMP, operator = ? WHERE id = ?')
          .run(ilo, operator ?? null, stanCel.id);
      } else {
        db.prepare(`
          INSERT INTO stany_lokalizacji (lokalizacja_id, artykul_gt_id, artykul_symbol, artykul_nazwa, artykul_ean, ilosc, operator)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(cel.id, artykul_gt_id, stanZrodlo.artykul_symbol, stanZrodlo.artykul_nazwa, stanZrodlo.artykul_ean, ilo, operator ?? null);
      }

      if (cel.magazyn === 'K4') {
        // SKU ma teraz stale miejsce w cel.id - usun ewentualny stary, oprozniony wpis w innej lokalizacji K4
        db.prepare(`
          DELETE FROM stany_lokalizacji
          WHERE artykul_gt_id = ? AND ilosc = 0 AND lokalizacja_id != ?
            AND lokalizacja_id IN (SELECT id FROM lokalizacje WHERE magazyn = 'K4')
        `).run(artykul_gt_id, cel.id);
      }
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return next(err);
  }

  // ruch zapisany jako 'pending' - teraz probujemy dogonic strone GT (dokument MM
  // + pola lokalizacyjne). Blad Sfery nie cofa ruchu w WMS - ruch zostaje 'pending'
  // z opisem bledu (do retry przez POST /:id/retry lub job ponawiania).
  try {
    res.status(201).json(await wykonajRuchGT(ruchId));
  } catch (err) {
    next(err);
  }
});

// POST /api/ruchy/lok - zmiana lokalizacji w ramach tego samego magazynu (bez dokumentu GT),
// albo - gdy lok_zrodlo_id = null - przypisanie pierwszej lokalizacji w WMS produktowi,
// ktory ma juz stan w GT, ale nie ma jeszcze zadnej lokalizacji w WMS (wymaga wtedy
// artykul_symbol/artykul_nazwa w body, bo nie ma skad ich wziac ze stanu zrodlowego)
router.post('/lok', async (req, res, next) => {
  const { artykul_gt_id, lok_zrodlo_id, lok_cel_id, ilosc, operator, artykul_symbol, artykul_nazwa, artykul_ean } = req.body ?? {};

  if (!artykul_gt_id) {
    return res.status(400).json({ blad: 'Pole "artykul_gt_id" jest wymagane' });
  }
  const maZrodlo = lok_zrodlo_id !== undefined && lok_zrodlo_id !== null;
  if (maZrodlo && !Number.isInteger(lok_zrodlo_id)) {
    return res.status(400).json({ blad: 'Pole "lok_zrodlo_id" musi byc liczba calkowita lub null' });
  }
  if (!Number.isInteger(lok_cel_id)) {
    return res.status(400).json({ blad: 'Pole "lok_cel_id" jest wymagane' });
  }
  const ilo = Number(ilosc);
  if (!Number.isFinite(ilo) || ilo <= 0) {
    return res.status(400).json({ blad: 'Pole "ilosc" musi byc liczba > 0' });
  }
  if (!maZrodlo && (!artykul_symbol || !artykul_nazwa)) {
    return res.status(400).json({ blad: 'Pola "artykul_symbol" i "artykul_nazwa" sa wymagane, gdy produkt nie ma jeszcze lokalizacji w WMS (lok_zrodlo_id = null)' });
  }

  let zrodlo = null;
  let stanZrodlo = null;
  if (maZrodlo) {
    zrodlo = db.prepare('SELECT * FROM lokalizacje WHERE id = ?').get(lok_zrodlo_id);
    if (!zrodlo) return res.status(404).json({ blad: 'Lokalizacja zrodlowa nie istnieje' });

    stanZrodlo = db.prepare(
      'SELECT * FROM stany_lokalizacji WHERE lokalizacja_id = ? AND artykul_gt_id = ?'
    ).get(lok_zrodlo_id, artykul_gt_id);

    if (!stanZrodlo || stanZrodlo.ilosc < ilo) {
      return res.status(409).json({
        blad: `Niewystarczajaca ilosc na lokalizacji zrodlowej (dostepne: ${stanZrodlo ? stanZrodlo.ilosc : 0})`
      });
    }
  }

  const cel = db.prepare('SELECT * FROM lokalizacje WHERE id = ?').get(lok_cel_id);
  if (!cel) return res.status(404).json({ blad: 'Lokalizacja docelowa nie istnieje' });

  if (zrodlo && cel.id === zrodlo.id) {
    return res.status(400).json({ blad: 'Nowa lokalizacja jest taka sama jak obecna' });
  }
  if (cel.aktywna !== 1) {
    return res.status(409).json({ blad: 'Nowa lokalizacja jest nieaktywna' });
  }
  if (zrodlo && cel.magazyn !== zrodlo.magazyn) {
    return res.status(400).json({ blad: 'Nowa lokalizacja musi byc w tym samym magazynie - przesuniecie miedzy magazynami zrob przez MM' });
  }

  // blokada inwentaryzacji ('otwarta') dla magazynow zaangazowanych w ruch
  const magazynyDoSprawdzenia = new Set([cel.magazyn]);
  if (zrodlo) magazynyDoSprawdzenia.add(zrodlo.magazyn);
  for (const mag of magazynyDoSprawdzenia) {
    const otwarta = db.prepare(
      "SELECT id FROM inwentaryzacje WHERE magazyn = ? AND status = 'otwarta'"
    ).get(mag);
    if (otwarta) {
      return res.status(409).json({ blad: `Inwentaryzacja w toku dla magazynu ${mag} - zmiana lokalizacji zablokowana` });
    }
  }

  if (zrodlo) {
    // K4: 1 SKU = 1 lokalizacja - zmiana lokalizacji przenosi cale stale miejsce, nie czesc ilosci
    if (zrodlo.magazyn === 'K4' && ilo !== stanZrodlo.ilosc) {
      return res.status(400).json({ blad: 'W magazynie K4 mozna zmienic lokalizacje tylko dla calej ilosci (1 SKU = 1 lokalizacja)' });
    }
  } else if (cel.magazyn === 'K4') {
    // pierwsza lokalizacja w K4: artykul nie moze juz miec innej lokalizacji w K4 (1 SKU = 1 lokalizacja)
    const inna = db.prepare(
      `SELECT l.kod FROM stany_lokalizacji s
       JOIN lokalizacje l ON l.id = s.lokalizacja_id
       WHERE s.artykul_gt_id = ? AND l.magazyn = 'K4' AND s.ilosc > 0`
    ).get(artykul_gt_id);
    if (inna) {
      return res.status(409).json({ blad: `Artykul ma juz lokalizacje w K4 (${inna.kod}) - 1 SKU = 1 lokalizacja` });
    }
  }

  const symbol = stanZrodlo ? stanZrodlo.artykul_symbol : artykul_symbol;
  const nazwa = stanZrodlo ? stanZrodlo.artykul_nazwa : artykul_nazwa;
  const ean = stanZrodlo ? stanZrodlo.artykul_ean : (artykul_ean ?? null);

  let ruchId;

  db.exec('BEGIN');
  try {
    const ruch = db.prepare(`
      INSERT INTO ruchy (typ, artykul_gt_id, artykul_symbol, lok_zrodlo_id, lok_cel_id, ilosc, status, operator)
      VALUES ('LOK', ?, ?, ?, ?, ?, 'pending', ?)
    `).run(artykul_gt_id, symbol, zrodlo ? lok_zrodlo_id : null, lok_cel_id, ilo, operator ?? null);
    ruchId = ruch.lastInsertRowid;

    if (stanZrodlo) {
      const pozostanie = stanZrodlo.ilosc - ilo;
      if (pozostanie > 0) {
        db.prepare('UPDATE stany_lokalizacji SET ilosc = ?, ostatnia_zmiana = CURRENT_TIMESTAMP, operator = ? WHERE id = ?')
          .run(pozostanie, operator ?? null, stanZrodlo.id);
      } else {
        // przenosimy stale miejsce SKU - stara lokalizacja juz go nie reprezentuje
        db.prepare('DELETE FROM stany_lokalizacji WHERE id = ?').run(stanZrodlo.id);
      }
    }

    const stanCel = db.prepare('SELECT * FROM stany_lokalizacji WHERE lokalizacja_id = ? AND artykul_gt_id = ?')
      .get(lok_cel_id, artykul_gt_id);
    if (stanCel) {
      db.prepare('UPDATE stany_lokalizacji SET ilosc = ilosc + ?, ostatnia_zmiana = CURRENT_TIMESTAMP, operator = ? WHERE id = ?')
        .run(ilo, operator ?? null, stanCel.id);
    } else {
      db.prepare(`
        INSERT INTO stany_lokalizacji (lokalizacja_id, artykul_gt_id, artykul_symbol, artykul_nazwa, artykul_ean, ilosc, operator)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(lok_cel_id, artykul_gt_id, symbol, nazwa, ean, ilo, operator ?? null);
    }

    if (!zrodlo && cel.magazyn === 'K4') {
      // SKU ma teraz stale miejsce w cel.id - usun ewentualny stary, oprozniony wpis w innej lokalizacji K4
      db.prepare(`
        DELETE FROM stany_lokalizacji
        WHERE artykul_gt_id = ? AND ilosc = 0 AND lokalizacja_id != ?
          AND lokalizacja_id IN (SELECT id FROM lokalizacje WHERE magazyn = 'K4')
      `).run(artykul_gt_id, cel.id);
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return next(err);
  }

  // LOK nie generuje dokumentu GT - status 'ok'/'pending' zalezy wylacznie od synchronizacji pol lokalizacyjnych
  try {
    res.status(201).json(await wykonajRuchGT(ruchId));
  } catch (err) {
    next(err);
  }
});

// GET /api/ruchy - lista ruchow, opcjonalnie filtrowana po statusie (np. ?status=pending
// do podgladu kolejki przed/po retry)
router.get('/', (req, res) => {
  const { status } = req.query ?? {};
  if (status) {
    return res.json(db.prepare('SELECT * FROM ruchy WHERE status = ? ORDER BY data_ruchu DESC').all(status));
  }
  res.json(db.prepare('SELECT * FROM ruchy ORDER BY data_ruchu DESC').all());
});

// POST /api/ruchy/:id/retry - ponawia probe doslania ruchu 'pending' do GT
// (dokument MM jesli brakuje numeru, oraz sync pol lokalizacyjnych)
router.post('/:id/retry', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ blad: 'Niepoprawne id ruchu' });
  }

  const ruch = db.prepare('SELECT * FROM ruchy WHERE id = ?').get(id);
  if (!ruch) return res.status(404).json({ blad: 'Ruch nie istnieje' });
  if (ruch.status !== 'pending') {
    return res.status(409).json({ blad: `Ruch ma status '${ruch.status}' - ponawianie dotyczy tylko 'pending'` });
  }

  try {
    res.json(await wykonajRuchGT(id));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
