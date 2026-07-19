const express = require('express');
const db = require('../db/database');

const router = express.Router();

// GET /api/audyt - log biznesowy "kto/co/gdzie/kiedy". Najnowsze pierwsze.
// Filtry: ?artykul_gt_id= (historia jednego SKU), ?uzytkownik=, ?akcja=, ?q= (SKU/lokalizacja),
//         ?limit= (domyslnie 300, max 1000), ?offset=
router.get('/', (req, res) => {
  const { artykul_gt_id, uzytkownik, akcja, q } = req.query ?? {};
  const limit = Math.min(Number(req.query.limit) || 300, 1000);
  const offset = Number(req.query.offset) || 0;

  const warunki = [];
  const param = [];
  if (artykul_gt_id) { warunki.push('a.artykul_gt_id = ?'); param.push(String(artykul_gt_id)); }
  if (uzytkownik) { warunki.push('a.uzytkownik = ?'); param.push(uzytkownik); }
  if (akcja) { warunki.push('a.akcja = ?'); param.push(akcja); }

  // Domyslnie log pokazuje TYLKO prace czlowieka. Wpisy jobow (uzytkownik 'system:<job>')
  // sa szumem przy pytaniu "kto to zmienil" - jest ich duzo, powstaja same i nikt za nie
  // nie odpowiada. Wchodza w dwoch przypadkach:
  //   - ?automaty=1 - przelacznik "U+A" w filtrze na desktopie,
  //   - gdy pytamy WPROST o akcje automatu (?akcja=korekta_auto) - proszenie o cos i
  //     dostawanie pustki byloby cicha porazka.
  // Rozpoznajemy po PREFIKSIE uzytkownika, a nie po liscie akcji: lista wymagalaby dopisania
  // przy kazdym nowym jobie i pierwszy zapomniany zasypywalby widok bez ostrzezenia.
  // NULL zostaje po stronie czlowieka - to akcja bez podanego operatora, nie automat.
  if (req.query.automaty !== '1' && !akcja) {
    warunki.push("(a.uzytkownik IS NULL OR a.uzytkownik NOT LIKE 'system:%')");
  }
  if (q) {
    warunki.push('(a.artykul_symbol LIKE ? OR a.lokalizacja LIKE ? OR a.artykul_gt_id LIKE ?)');
    const wzor = `%${q}%`;
    param.push(wzor, wzor, wzor);
  }
  const where = warunki.length ? `WHERE ${warunki.join(' AND ')}` : '';

  // LEFT JOIN ruchy -> ZYWY status ruchu (do przyciskow Ponow/Usun w Logu). ruchy.id to PK,
  // wiec join nie zwielokrotnia wierszy. Dla wpisow nie-ruchowych (edycja lokalizacji itd.)
  // oraz ruchow juz usunietych ruch_status = NULL.
  const wiersze = db.prepare(
    `SELECT a.id, a.czas, a.uzytkownik, a.akcja, a.artykul_gt_id, a.artykul_symbol, a.magazyn,
            a.lokalizacja, a.przed, a.po, a.ilosc, a.wynik, a.ruch_id, a.dok_gt_numer,
            r.status AS ruch_status, r.blad_opis AS ruch_blad
     FROM audyt a LEFT JOIN ruchy r ON r.id = a.ruch_id
     ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`
  ).all(...param, limit, offset);

  const total = db.prepare(`SELECT COUNT(*) AS c FROM audyt a ${where}`).get(...param).c;
  res.json({ wiersze, total, limit, offset });
});

module.exports = router;
