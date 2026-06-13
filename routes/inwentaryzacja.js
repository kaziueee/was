'use strict';

const express = require('express');
const db = require('../db/database');
const { MAGAZYNY_WMS } = require('../config/magazyny');
const { pobierzProdukt } = require('../services/gt-produkty');
const gtBridge = require('../services/gt-bridge');
const gtFields = require('../services/gt-fields');

const router = express.Router();

// GET /api/inwentaryzacja - lista (filtry: ?status=, ?magazyn=)
router.get('/', (req, res) => {
  const { status, magazyn } = req.query;
  let sql = 'SELECT * FROM inwentaryzacje WHERE 1=1';
  const params = [];

  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (magazyn) {
    sql += ' AND magazyn = ?';
    params.push(magazyn);
  }
  sql += ' ORDER BY data_otwarcia DESC';

  res.json(db.prepare(sql).all(...params));
});

// GET /api/inwentaryzacja/otwarta/:magazyn - otwarta inwentaryzacja dla magazynu (lub null) -
// do sprawdzenia na ekranie inwentaryzacji, czy wznowic istniejacy spis
router.get('/otwarta/:magazyn', (req, res) => {
  const wynik = db.prepare(
    "SELECT * FROM inwentaryzacje WHERE magazyn = ? AND status = 'otwarta'"
  ).get(req.params.magazyn);
  res.json(wynik ?? null);
});

// POST /api/inwentaryzacja - otworz nowy spis dla magazynu (K4 lub K4G).
// Snapshot pozycji = biezacy stan WMS (ilosc_gt) dla wszystkich lokalizacji
// tego magazynu z zapasem > 0 - zgodnie z inwariantem "suma WMS = stan GT"
// to jest oczekiwana ilosc per lokalizacja w momencie otwarcia spisu.
router.post('/', (req, res) => {
  const { magazyn, operator } = req.body ?? {};

  if (!MAGAZYNY_WMS.includes(magazyn)) {
    return res.status(400).json({ blad: `Pole "magazyn" musi byc jednym z: ${MAGAZYNY_WMS.join(', ')}` });
  }

  const otwarta = db.prepare("SELECT id FROM inwentaryzacje WHERE magazyn = ? AND status = 'otwarta'").get(magazyn);
  if (otwarta) {
    return res.status(409).json({ blad: `Dla magazynu ${magazyn} jest juz otwarta inwentaryzacja (id ${otwarta.id})` });
  }

  let id;
  db.exec('BEGIN');
  try {
    const wynik = db.prepare('INSERT INTO inwentaryzacje (magazyn, operator) VALUES (?, ?)').run(magazyn, operator ?? null);
    id = wynik.lastInsertRowid;

    const snapshot = db.prepare(`
      SELECT s.lokalizacja_id, s.artykul_gt_id, s.artykul_symbol, s.ilosc
      FROM stany_lokalizacji s
      JOIN lokalizacje l ON l.id = s.lokalizacja_id
      WHERE l.magazyn = ? AND s.ilosc > 0
    `).all(magazyn);

    const wstaw = db.prepare(`
      INSERT INTO pozycje_inwentaryzacji (inwentaryzacja_id, lokalizacja_id, artykul_gt_id, artykul_symbol, ilosc_gt)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const p of snapshot) {
      wstaw.run(id, p.lokalizacja_id, p.artykul_gt_id, p.artykul_symbol, p.ilosc);
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  res.status(201).json(db.prepare('SELECT * FROM inwentaryzacje WHERE id = ?').get(id));
});

// statystyki spisu: ile pozycji, ile zliczonych, ile z roznica
function statystyki(id) {
  return db.prepare(`
    SELECT
      COUNT(*) AS pozycje_total,
      COUNT(ilosc_liczona) AS zliczone,
      SUM(CASE WHEN ilosc_liczona IS NOT NULL AND roznica != 0 THEN 1 ELSE 0 END) AS z_roznica
    FROM pozycje_inwentaryzacji WHERE inwentaryzacja_id = ?
  `).get(id);
}

// GET /api/inwentaryzacja/:id - szczegoly spisu + statystyki
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ blad: 'Nieprawidlowe id' });

  const inwentaryzacja = db.prepare('SELECT * FROM inwentaryzacje WHERE id = ?').get(id);
  if (!inwentaryzacja) return res.status(404).json({ blad: 'Inwentaryzacja nie istnieje' });

  res.json({ ...inwentaryzacja, statystyki: statystyki(id) });
});

// GET /api/inwentaryzacja/:id/pozycje - lista pozycji spisu (filtry: ?lokalizacja_id=,
// ?roznice=1 tylko z roznica != 0, ?nieskanowane=1 tylko ilosc_liczona IS NULL)
router.get('/:id/pozycje', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ blad: 'Nieprawidlowe id' });

  const { lokalizacja_id, roznice, nieskanowane } = req.query;
  let sql = `
    SELECT p.*, l.kod AS lokalizacja_kod
    FROM pozycje_inwentaryzacji p
    JOIN lokalizacje l ON l.id = p.lokalizacja_id
    WHERE p.inwentaryzacja_id = ?
  `;
  const params = [id];

  if (lokalizacja_id) {
    sql += ' AND p.lokalizacja_id = ?';
    params.push(Number(lokalizacja_id));
  }
  if (roznice) {
    sql += ' AND p.ilosc_liczona IS NOT NULL AND p.roznica != 0';
  }
  if (nieskanowane) {
    sql += ' AND p.ilosc_liczona IS NULL';
  }
  sql += ' ORDER BY l.kod, p.artykul_symbol';

  res.json(db.prepare(sql).all(...params));
});

// GET /api/inwentaryzacja/:id/lokalizacja/:kod - po skanie etykiety lokalizacji:
// co powinno tu byc wg snapshotu + co juz zliczono w ramach tego spisu
router.get('/:id/lokalizacja/:kod', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ blad: 'Nieprawidlowe id' });

  const inwentaryzacja = db.prepare('SELECT * FROM inwentaryzacje WHERE id = ?').get(id);
  if (!inwentaryzacja) return res.status(404).json({ blad: 'Inwentaryzacja nie istnieje' });

  const lokalizacja = db.prepare('SELECT * FROM lokalizacje WHERE kod = ?').get(req.params.kod);
  if (!lokalizacja) return res.status(404).json({ blad: 'Lokalizacja nie znaleziona' });
  if (lokalizacja.magazyn !== inwentaryzacja.magazyn) {
    return res.status(400).json({ blad: `Lokalizacja ${lokalizacja.kod} nie jest w magazynie ${inwentaryzacja.magazyn} objetym tym spisem` });
  }

  const pozycje = db.prepare(`
    SELECT * FROM pozycje_inwentaryzacji WHERE inwentaryzacja_id = ? AND lokalizacja_id = ?
    ORDER BY artykul_symbol
  `).all(id, lokalizacja.id);

  res.json({ lokalizacja, pozycje });
});

// POST /api/inwentaryzacja/:id/skan - zapis policzonej ilosci dla (lokalizacja, artykul).
// body: { lokalizacja_id, artykul_gt_id, ilosc, operator, artykul_symbol? }
// artykul_symbol wymagany tylko gdy para (lokalizacja, artykul) nie byla w snapshocie
// (magazynier znalazl SKU na lokalizacji, gdzie wg WMS nic nie powinno byc).
router.post('/:id/skan', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ blad: 'Nieprawidlowe id' });

  const inwentaryzacja = db.prepare('SELECT * FROM inwentaryzacje WHERE id = ?').get(id);
  if (!inwentaryzacja) return res.status(404).json({ blad: 'Inwentaryzacja nie istnieje' });
  if (inwentaryzacja.status !== 'otwarta') {
    return res.status(409).json({ blad: `Inwentaryzacja ma status '${inwentaryzacja.status}' - skanowanie dotyczy tylko 'otwarta'` });
  }

  const { lokalizacja_id, artykul_gt_id, ilosc, operator, artykul_symbol } = req.body ?? {};

  if (!Number.isInteger(lokalizacja_id)) {
    return res.status(400).json({ blad: 'Pole "lokalizacja_id" jest wymagane' });
  }
  if (!artykul_gt_id) {
    return res.status(400).json({ blad: 'Pole "artykul_gt_id" jest wymagane' });
  }
  const ilo = Number(ilosc);
  if (!Number.isFinite(ilo) || ilo < 0) {
    return res.status(400).json({ blad: 'Pole "ilosc" musi byc liczba >= 0' });
  }

  const lokalizacja = db.prepare('SELECT * FROM lokalizacje WHERE id = ?').get(lokalizacja_id);
  if (!lokalizacja) return res.status(404).json({ blad: 'Lokalizacja nie istnieje' });
  if (lokalizacja.magazyn !== inwentaryzacja.magazyn) {
    return res.status(400).json({ blad: `Lokalizacja ${lokalizacja.kod} nie jest w magazynie ${inwentaryzacja.magazyn} objetym tym spisem` });
  }

  const pozycja = db.prepare(
    'SELECT * FROM pozycje_inwentaryzacji WHERE inwentaryzacja_id = ? AND lokalizacja_id = ? AND artykul_gt_id = ?'
  ).get(id, lokalizacja_id, artykul_gt_id);

  if (pozycja) {
    db.prepare('UPDATE pozycje_inwentaryzacji SET ilosc_liczona = ?, operator = ? WHERE id = ?')
      .run(ilo, operator ?? null, pozycja.id);
  } else {
    if (!artykul_symbol) {
      return res.status(400).json({ blad: 'Pole "artykul_symbol" jest wymagane - ten artykul nie byl w snapshocie tej lokalizacji' });
    }
    db.prepare(`
      INSERT INTO pozycje_inwentaryzacji (inwentaryzacja_id, lokalizacja_id, artykul_gt_id, artykul_symbol, ilosc_gt, ilosc_liczona, operator)
      VALUES (?, ?, ?, ?, 0, ?, ?)
    `).run(id, lokalizacja_id, artykul_gt_id, artykul_symbol, ilo, operator ?? null);
  }

  res.json(db.prepare(
    'SELECT * FROM pozycje_inwentaryzacji WHERE inwentaryzacja_id = ? AND lokalizacja_id = ? AND artykul_gt_id = ?'
  ).get(id, lokalizacja_id, artykul_gt_id));
});

// GET /api/inwentaryzacja/:id/raport - raport roznic (tylko pozycje zliczone z roznica != 0)
// + podsumowanie pozycji nieskanowanych (potencjalny niedobor, jesli spis zostanie
// zamkniety z "zeruj_niespisane")
router.get('/:id/raport', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ blad: 'Nieprawidlowe id' });

  const inwentaryzacja = db.prepare('SELECT * FROM inwentaryzacje WHERE id = ?').get(id);
  if (!inwentaryzacja) return res.status(404).json({ blad: 'Inwentaryzacja nie istnieje' });

  const roznice = db.prepare(`
    SELECT p.*, l.kod AS lokalizacja_kod
    FROM pozycje_inwentaryzacji p
    JOIN lokalizacje l ON l.id = p.lokalizacja_id
    WHERE p.inwentaryzacja_id = ? AND p.ilosc_liczona IS NOT NULL AND p.roznica != 0
    ORDER BY l.kod, p.artykul_symbol
  `).all(id);

  const nieskanowane = db.prepare(`
    SELECT COUNT(*) AS liczba, COALESCE(SUM(ilosc_gt), 0) AS suma_ilosc_gt
    FROM pozycje_inwentaryzacji WHERE inwentaryzacja_id = ? AND ilosc_liczona IS NULL
  `).get(id);

  res.json({
    inwentaryzacja,
    nadwyzki: roznice.filter((p) => p.roznica > 0),
    niedobory: roznice.filter((p) => p.roznica < 0),
    nieskanowane,
  });
});

// dla pozycji znalezionych przy spisie, ktore nie mialy wczesniej wiersza w stany_lokalizacji
// (nowy SKU na tej lokalizacji) potrzebujemy nazwy/EAN do zalozenia wiersza - najpierw szukamy
// w innych lokalizacjach WMS tego artykulu, w ostatnim razie pytamy katalog GT po symbolu
async function znajdzNazweEan(artykulGtId, artykulSymbol) {
  const istniejacy = db.prepare(
    'SELECT artykul_nazwa, artykul_ean FROM stany_lokalizacji WHERE artykul_gt_id = ? LIMIT 1'
  ).get(artykulGtId);
  if (istniejacy) return { nazwa: istniejacy.artykul_nazwa, ean: istniejacy.artykul_ean };

  const produkt = await pobierzProdukt(artykulSymbol).catch(() => null);
  if (produkt) return { nazwa: produkt.nazwa, ean: produkt.ean };

  return { nazwa: artykulSymbol, ean: null };
}

// POST /api/inwentaryzacja/:id/zamknij - zamkniecie spisu: wystawia PW (nadwyzki) / RW
// (niedobory) w GT wg sumy roznic per artykul, aktualizuje stany_lokalizacji do policzonych
// ilosci i synchronizuje pola lokalizacyjne GT. body: { operator, zeruj_niespisane }
router.post('/:id/zamknij', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ blad: 'Nieprawidlowe id' });

  const inwentaryzacja = db.prepare('SELECT * FROM inwentaryzacje WHERE id = ?').get(id);
  if (!inwentaryzacja) return res.status(404).json({ blad: 'Inwentaryzacja nie istnieje' });
  if (inwentaryzacja.status !== 'otwarta') {
    return res.status(409).json({ blad: `Inwentaryzacja ma status '${inwentaryzacja.status}' - zamykanie dotyczy tylko 'otwarta'` });
  }

  const { operator, zeruj_niespisane } = req.body ?? {};

  const nieskanowane = db.prepare(
    'SELECT COUNT(*) AS liczba FROM pozycje_inwentaryzacji WHERE inwentaryzacja_id = ? AND ilosc_liczona IS NULL'
  ).get(id).liczba;

  if (nieskanowane > 0 && !zeruj_niespisane) {
    return res.status(409).json({
      blad: `${nieskanowane} pozycji nie zostalo zliczonych - policz je albo ustaw "zeruj_niespisane": true, aby potraktowac jako 0`,
      nieskanowane,
    });
  }

  if (nieskanowane > 0) {
    db.prepare('UPDATE pozycje_inwentaryzacji SET ilosc_liczona = 0 WHERE inwentaryzacja_id = ? AND ilosc_liczona IS NULL').run(id);
  }

  try {
    // roznice per artykul - suma po wszystkich lokalizacjach magazynu objetych spisem
    const roznice = db.prepare(`
      SELECT artykul_gt_id, artykul_symbol, SUM(roznica) AS suma
      FROM pozycje_inwentaryzacji
      WHERE inwentaryzacja_id = ?
      GROUP BY artykul_gt_id, artykul_symbol
      HAVING SUM(roznica) != 0
    `).all(id);

    const nadwyzki = roznice.filter((r) => r.suma > 0).map((r) => ({ artykul_gt_id: r.artykul_gt_id, ilosc: r.suma }));
    const niedobory = roznice.filter((r) => r.suma < 0).map((r) => ({ artykul_gt_id: r.artykul_gt_id, ilosc: -r.suma }));

    let numerPw = null;
    let numerRw = null;

    if (nadwyzki.length > 0) {
      const odp = await gtBridge.wystawPW({ magazyn: inwentaryzacja.magazyn, pozycje: nadwyzki, operator: operator ?? null });
      if (!odp.ok || !odp.dane?.sukces) {
        return res.status(502).json({ blad: `Nie udalo sie wystawic PW w GT: ${odp.blad ?? odp.dane?.blad ?? `status ${odp.status}`}`, etap: 'PW' });
      }
      numerPw = odp.dane.numer_dokumentu ?? null;
    }

    if (niedobory.length > 0) {
      const odp = await gtBridge.wystawRW({ magazyn: inwentaryzacja.magazyn, pozycje: niedobory, operator: operator ?? null });
      if (!odp.ok || !odp.dane?.sukces) {
        return res.status(502).json({ blad: `Nie udalo sie wystawic RW w GT: ${odp.blad ?? odp.dane?.blad ?? `status ${odp.status}`}`, etap: 'RW' });
      }
      numerRw = odp.dane.numer_dokumentu ?? null;
    }

    const pozycje = db.prepare('SELECT * FROM pozycje_inwentaryzacji WHERE inwentaryzacja_id = ?').all(id);

    // dla nowo znalezionych SKU (brak wiersza w stany_lokalizacji) dociagamy nazwe/EAN
    // przed transakcja, bo wymaga to ew. zapytania do GT
    const nazwaEanMap = new Map();
    for (const p of pozycje) {
      if (Number(p.ilosc_liczona) <= 0) continue;
      const stan = db.prepare('SELECT 1 FROM stany_lokalizacji WHERE lokalizacja_id = ? AND artykul_gt_id = ?')
        .get(p.lokalizacja_id, p.artykul_gt_id);
      if (!stan) {
        nazwaEanMap.set(`${p.lokalizacja_id}:${p.artykul_gt_id}`, await znajdzNazweEan(p.artykul_gt_id, p.artykul_symbol));
      }
    }

    const artykulyDoSync = new Set();

    db.exec('BEGIN');
    try {
      for (const p of pozycje) {
        artykulyDoSync.add(p.artykul_gt_id);
        const stan = db.prepare('SELECT * FROM stany_lokalizacji WHERE lokalizacja_id = ? AND artykul_gt_id = ?')
          .get(p.lokalizacja_id, p.artykul_gt_id);

        if (stan) {
          if (Number(p.ilosc_liczona) === stan.ilosc) continue;
          if (Number(p.ilosc_liczona) > 0) {
            db.prepare('UPDATE stany_lokalizacji SET ilosc = ?, ostatnia_zmiana = CURRENT_TIMESTAMP, operator = ? WHERE id = ?')
              .run(p.ilosc_liczona, operator ?? null, stan.id);
          } else if (inwentaryzacja.magazyn === 'K4') {
            // K4: stale miejsce SKU zostaje, nawet gdy spis wykazal 0
            db.prepare('UPDATE stany_lokalizacji SET ilosc = 0, ostatnia_zmiana = CURRENT_TIMESTAMP, operator = ? WHERE id = ?')
              .run(operator ?? null, stan.id);
          } else {
            db.prepare('DELETE FROM stany_lokalizacji WHERE id = ?').run(stan.id);
          }
        } else if (Number(p.ilosc_liczona) > 0) {
          const { nazwa, ean } = nazwaEanMap.get(`${p.lokalizacja_id}:${p.artykul_gt_id}`);
          db.prepare(`
            INSERT INTO stany_lokalizacji (lokalizacja_id, artykul_gt_id, artykul_symbol, artykul_nazwa, artykul_ean, ilosc, operator)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(p.lokalizacja_id, p.artykul_gt_id, p.artykul_symbol, nazwa, ean, p.ilosc_liczona, operator ?? null);
        }
      }

      db.prepare('UPDATE pozycje_inwentaryzacji SET zatwierdzona = 1 WHERE inwentaryzacja_id = ?').run(id);
      db.prepare("UPDATE inwentaryzacje SET status = 'zamknieta', data_zamkniecia = CURRENT_TIMESTAMP WHERE id = ?").run(id);

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    // odswiez pola lokalizacyjne w GT dla zmienionych artykulow - najlepszy wysilek,
    // ewentualna nieswiezosc zostanie nadpisana przy najblizszym ruchu na tym artykule
    const syncGt = {};
    for (const artykulGtId of artykulyDoSync) {
      const wynik = await gtFields.synchronizujLokalizacje(artykulGtId, new Set([inwentaryzacja.magazyn]));
      if (wynik) {
        syncGt[artykulGtId] = wynik.ok && wynik.dane?.sukces ? 'ok' : (wynik.blad ?? wynik.dane?.blad ?? `status ${wynik.status}`);
      }
    }

    res.json({
      inwentaryzacja: db.prepare('SELECT * FROM inwentaryzacje WHERE id = ?').get(id),
      dokumenty: { pw: numerPw, rw: numerRw },
      sync_gt: syncGt,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
