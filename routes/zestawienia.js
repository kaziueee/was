const express = require('express');
const gtProdukty = require('../services/gt-produkty');
const gtDokumenty = require('../services/gt-dokumenty');
const doRozlozenia = require('../services/do-rozlozenia');

const router = express.Router();

// Zestawienia (desktop) - gotowe pytania "co przywiezc / czego brakuje". Czysty ODCZYT z GT,
// zadnych ruchow: kazda akcja idzie przez kartę produktu (modal), czyli tam, gdzie i tak sa
// wszystkie inwarianty.
//
// Zakladka "Przywozka" ma DWIE tabele, bo odpowiadaja na dwa rozne pytania:
//   1. co JUZ przyjechalo i lezy w strefie przyjec (nierozlozone MM z MAG/LS) - rozbite na
//      zrodlo, bo "przywiezione z Leszna" i "z MAG" to dla magazyniera dwie rozne rzeczy;
//   2. co DOPIERO trzeba przywiezc z MAG (rezerwacja na K4 przekracza stan hali, a zapas jest).

// GET /api/zestawienia/przywozka - obie tabele w jednym wywolaniu (jeden ekran = jedno pytanie
// do serwera; front nie musi ich synchronizowac).
router.get('/przywozka', async (req, res) => {
  let strefa, doPrzywiezienia;
  try {
    [strefa, doPrzywiezienia] = await Promise.all([
      gtDokumenty.pobierzTowaryZPrzywozkamiK4().then((k) => doRozlozenia.zbierz(k, 'przywozki')),
      gtProdukty.listujProdukty({ zestawienie: 'przywozka', limit: 500, sort: 'razem', dir: 'desc' }),
    ]);
  } catch (err) {
    return res.status(503).json({ blad: 'Nie mozna pobrac danych z GT (baza niedostepna). Sprobuj ponownie.' });
  }
  res.json({
    strefa: strefa.sort(doRozlozenia.wgLokalizacji),
    do_przywiezienia: doPrzywiezienia.produkty,
    razem_strefa: strefa.length,
    razem_do_przywiezienia: doPrzywiezienia.total,
  });
});

// GET /api/zestawienia/przywozka/strefa - sama tabela 1, dla Zebry. Osobno, bo Zebra rozklada
// towar i nie potrzebuje listy "co przywiezc" - a to drugie zapytanie do GT.
router.get('/przywozka/strefa', async (req, res) => {
  try {
    const kandydaci = await gtDokumenty.pobierzTowaryZPrzywozkamiK4();
    const pozycje = (await doRozlozenia.zbierz(kandydaci, 'przywozki')).sort(doRozlozenia.wgLokalizacji);
    res.json({ pozycje, razem: pozycje.length });
  } catch (err) {
    res.status(503).json({ blad: 'Nie mozna pobrac przywozek z GT (baza niedostepna). Sprobuj ponownie.' });
  }
});

// GET /api/zestawienia/leszno - hala ponizej progu, a w LS jest zapas.
router.get('/leszno', async (req, res) => {
  try {
    const r = await gtProdukty.listujProdukty({ zestawienie: 'leszno', limit: 500, sort: 'razem', dir: 'asc' });
    res.json({ produkty: r.produkty, razem: r.total });
  } catch (err) {
    res.status(503).json({ blad: 'Nie mozna pobrac danych z GT (baza niedostepna). Sprobuj ponownie.' });
  }
});

// GET /api/zestawienia/nadsprzedaz - obiecane wiecej, niz mamy gdziekolwiek.
router.get('/nadsprzedaz', async (req, res) => {
  try {
    const r = await gtProdukty.listujProdukty({ zestawienie: 'nadsprzedaz', limit: 500, sort: 'razem', dir: 'asc' });
    res.json({ produkty: r.produkty, razem: r.total });
  } catch (err) {
    res.status(503).json({ blad: 'Nie mozna pobrac danych z GT (baza niedostepna). Sprobuj ponownie.' });
  }
});

module.exports = router;
