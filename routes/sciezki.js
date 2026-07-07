const express = require('express');
const db = require('../db/database');
const audyt = require('../services/audyt');
const { pobierzK4NiskieStany, dostepneWGt, pobierzStanyGt } = require('../services/gt-produkty');

const router = express.Router();

// Sciezki (Faza 6) - proste zadania "obchodu" magazynu z checklista, wynik do audytu.
// Sciezka 1: "Ostatnie sztuki" - weryfikacja niskich stanow K4 (1..5 szt.). GT = master
// stanow (zasada 1), wiec prog liczymy po stanie GT w K4, NIE po WMS stany_lokalizacji
// (ta tabela nie trzyma ilosci per lokalizacja). Nie robi ruchow WMS - tylko zapisuje
// zdarzenie: 'sprawdzenie_stanu' (zgodne) lub 'sprawdzenie_niezgodne' (raport).

const STAN_MIN = 1;
const STAN_MAX = 5;
// Laczny stan (Razem = K4+K4G+MAG+LS, bez BRK) <= tego progu - odsiewa towary z niskim K4,
// ale z zapasem na innych magazynach (setki na K4G = kandydat do uzupelnienia, nie liczenia).
const RAZEM_MAX = 5;
// Ile dni po sprawdzeniu pary (artykul+lokalizacja) wypada z listy.
const DNI_POMIN_SPRAWDZONE = 180;
// Ile dni po przyjeciu z magazynu zewnetrznego (MAG/LS) pomijamy SKU - stan jest swiezy
// i znany (ktos swiadomie dolozyl kilka szt.), nie ma czego weryfikowac.
const DNI_POMIN_PRZYJECIE = 30;

// Prawda o stanie: WMS tam, gdzie istnieje wpis w stany_lokalizacji (WMS zapelnia sie
// z czasem - dla zlokalizowanych towarow trzyma ilosc per lokalizacja), GT jako fallback
// dla reszty. Zwraca { stan, zrodlo:'WMS'|'GT', lokalizacja_kod } albo null gdy brak w obu.
function wmsK4(artykul_gt_id) {
  return db.prepare(
    `SELECT s.ilosc AS stan, l.kod AS lokalizacja_kod
     FROM stany_lokalizacji s JOIN lokalizacje l ON l.id = s.lokalizacja_id
     WHERE l.magazyn = 'K4' AND s.artykul_gt_id = ? LIMIT 1`
  ).get(String(artykul_gt_id));
}

// GET /api/sciezki/ostatnie-sztuki - lista przystankow (towary K4 ze stanem 1..5, z lokalizacja
// K4), posortowana po kodzie lokalizacji = kolejnosc zbierania. Stan liczony wg reguly
// "WMS jest prawda tam gdzie istnieje, inaczej GT". Wyklucza:
//  - pary (artykul+lokalizacja) sprawdzone w ciagu DNI_POMIN_SPRAWDZONE dni,
//  - SKU z przyjeciem z zewnetrznego w ciagu DNI_POMIN_PRZYJECIE dni.
router.get('/ostatnie-sztuki', async (req, res, next) => {
  // WMS K4 (prawda tam gdzie istnieje) - 1 SKU = 1 lokalizacja K4
  const wmsRows = db.prepare(
    `SELECT s.artykul_gt_id, s.artykul_symbol AS symbol, s.artykul_nazwa AS nazwa,
            s.artykul_ean AS ean, s.ilosc AS stan, l.kod AS lokalizacja_kod
     FROM stany_lokalizacji s JOIN lokalizacje l ON l.id = s.lokalizacja_id
     WHERE l.magazyn = 'K4'`
  ).all();
  const wmsMa = new Set(wmsRows.map((r) => r.artykul_gt_id));
  // WMS-kandydaci: stan 1..5 (0 = pusta lok, osobna sciezka); laczny stan dolozymy z GT
  const wmsKandydaci = wmsRows.filter((w) => w.stan >= STAN_MIN && w.stan <= STAN_MAX);

  let gtRows;
  try {
    gtRows = await pobierzK4NiskieStany({ min: STAN_MIN, max: STAN_MAX, maxRazem: RAZEM_MAX });
  } catch (err) {
    return res.status(503).json({ blad: 'Nie mozna pobrac stanow GT (baza niedostepna). Sprobuj ponownie.' });
  }

  // Dla WMS-kandydatow "laczny stan" = K4 z WMS (prawda) + reszta magazynow z GT (K4G/MAG/LS).
  // WMS nie zna innych magazynow, wiec stan poza K4 bierzemy z GT.
  const innychMap = new Map();
  if (wmsKandydaci.length) {
    try {
      const stany = await pobierzStanyGt(wmsKandydaci.map((w) => w.artykul_gt_id));
      for (const w of wmsKandydaci) {
        const sg = stany.get(String(w.artykul_gt_id)) || {};
        innychMap.set(w.artykul_gt_id, ['K4G', 'MAG', 'LS'].reduce((s, k) => s + (sg[k]?.ilosc ?? 0), 0));
      }
    } catch (err) {
      return res.status(503).json({ blad: 'Nie mozna pobrac stanow GT (baza niedostepna). Sprobuj ponownie.' });
    }
  }

  const kandydaci = [];
  // GT tylko dla towarow, ktorych WMS jeszcze nie zna (fallback) - juz z filtrem Razem<=RAZEM_MAX
  for (const g of gtRows) {
    if (!wmsMa.has(g.artykul_gt_id)) {
      kandydaci.push({ artykul_gt_id: g.artykul_gt_id, symbol: g.symbol, nazwa: g.nazwa,
        ean: g.ean, lokalizacja_kod: g.lokalizacja_kod, stan: g.stan_k4, zrodlo: 'GT' });
    }
  }
  // WMS = prawda dla K4; bierz gdy laczny stan (K4_wms + inne_GT) <= RAZEM_MAX
  for (const w of wmsKandydaci) {
    const razem = w.stan + (innychMap.get(w.artykul_gt_id) ?? 0);
    if (razem <= RAZEM_MAX) {
      kandydaci.push({ artykul_gt_id: w.artykul_gt_id, symbol: w.symbol, nazwa: w.nazwa,
        ean: w.ean, lokalizacja_kod: w.lokalizacja_kod, stan: w.stan, zrodlo: 'WMS' });
    }
  }

  // zbiory wykluczen z SQLite (jedno zapytanie na kazdy) - filtrujemy w Node
  const sprawdzone = new Set(db.prepare(
    `SELECT DISTINCT artykul_gt_id, lokalizacja FROM audyt
     WHERE akcja IN ('sprawdzenie_stanu','sprawdzenie_niezgodne')
       AND czas >= datetime('now', ?)`
  ).all(`-${DNI_POMIN_SPRAWDZONE} days`).map((r) => `${r.artykul_gt_id}|${r.lokalizacja}`));

  const przyjete = new Set(db.prepare(
    `SELECT DISTINCT artykul_gt_id FROM ruchy
     WHERE mag_zrodlo_zewnetrzny IS NOT NULL AND data_ruchu >= datetime('now', ?)`
  ).all(`-${DNI_POMIN_PRZYJECIE} days`).map((r) => r.artykul_gt_id));

  const pozycje = kandydaci
    .filter((t) => !sprawdzone.has(`${t.artykul_gt_id}|${t.lokalizacja_kod}`) && !przyjete.has(t.artykul_gt_id))
    .sort((a, b) => (a.lokalizacja_kod || '').localeCompare(b.lokalizacja_kod || '')
      || (a.symbol || '').localeCompare(b.symbol || ''));

  res.json({ pozycje, razem: pozycje.length });
});

// POST /api/sciezki/ostatnie-sztuki/sprawdzenie - zapisz wynik sprawdzenia jednego przystanku.
// Body: { artykul_gt_id, artykul_symbol, lokalizacja_kod, ilosc_policzona, operator }.
// Porownuje policzone ze stanem GT w K4 (st_Stan). NIE robi ruchu WMS.
router.post('/ostatnie-sztuki/sprawdzenie', async (req, res, next) => {
  const { artykul_gt_id, artykul_symbol, lokalizacja_kod, ilosc_policzona, operator } = req.body ?? {};

  if (!artykul_gt_id) return res.status(400).json({ blad: 'Pole "artykul_gt_id" jest wymagane' });
  if (!lokalizacja_kod) return res.status(400).json({ blad: 'Pole "lokalizacja_kod" jest wymagane' });
  const policzone = Number(ilosc_policzona);
  if (!Number.isFinite(policzone) || policzone < 0) {
    return res.status(400).json({ blad: 'Pole "ilosc_policzona" musi byc liczba >= 0' });
  }

  // prawda: WMS jesli towar jest w WMS, inaczej GT
  const wms = wmsK4(artykul_gt_id);
  let stan, zrodlo;
  if (wms) {
    stan = Number(wms.stan);
    zrodlo = 'WMS';
  } else {
    try {
      const gt = await dostepneWGt(String(artykul_gt_id), 'K4');
      stan = Number(gt.stan);
      zrodlo = 'GT';
    } catch (err) {
      return res.status(503).json({ blad: 'Nie mozna zweryfikowac stanu GT (baza niedostepna). Sprobuj ponownie.' });
    }
  }

  const zgodne = policzone === stan;
  const roznica = policzone - stan;

  audyt.zapisz({
    uzytkownik: operator ?? null,
    akcja: zgodne ? 'sprawdzenie_stanu' : 'sprawdzenie_niezgodne',
    artykul_gt_id: String(artykul_gt_id),
    artykul_symbol: artykul_symbol ?? null,
    magazyn: 'K4',
    lokalizacja: lokalizacja_kod,
    ilosc: policzone,
    wynik: zgodne ? 'zgodne' : 'niezgodne',
    przed: { stan, zrodlo },
    po: { policzone },
  });

  res.status(201).json({ zgodne, stan, zrodlo, policzone, roznica });
});

// GET /api/sciezki/ostatnie-sztuki/raport - otwarte niezgodnosci: pary (artykul+lokalizacja),
// dla ktorych NAJNOWSZE sprawdzenie to 'sprawdzenie_niezgodne' (nie domkniete pozniejszym
// zgodnym sprawdzeniem). Posortowane po kodzie lokalizacji = kolejnosc zbierania.
router.get('/ostatnie-sztuki/raport', (req, res) => {
  const pozycje = db.prepare(`
    SELECT a.artykul_gt_id, a.artykul_symbol, a.magazyn, a.lokalizacja AS lokalizacja_kod,
           a.ilosc AS policzone, a.przed, a.czas, a.uzytkownik
    FROM audyt a
    JOIN (
      SELECT artykul_gt_id, lokalizacja, MAX(id) AS max_id
      FROM audyt
      WHERE akcja IN ('sprawdzenie_stanu','sprawdzenie_niezgodne')
      GROUP BY artykul_gt_id, lokalizacja
    ) ost ON ost.max_id = a.id
    WHERE a.akcja = 'sprawdzenie_niezgodne'
    ORDER BY a.lokalizacja
  `).all();

  // rozpakuj stan + zrodlo z pola "przed" (JSON) do plaskich pol dla frontu
  for (const p of pozycje) {
    let przed = {};
    try { przed = JSON.parse(p.przed) || {}; } catch { przed = {}; }
    // wsteczna zgodnosc ze starym formatem { stan_gt }
    p.stan = przed.stan ?? przed.stan_gt ?? null;
    p.zrodlo = przed.zrodlo ?? (przed.stan_gt != null ? 'GT' : null);
    delete p.przed;
  }

  res.json({ pozycje, razem: pozycje.length });
});

module.exports = router;
