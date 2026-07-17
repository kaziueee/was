const express = require('express');
const gtDokumenty = require('../services/gt-dokumenty');
const doRozlozenia = require('../services/do-rozlozenia');

const router = express.Router();

// Dostawy do rozlozenia (PZ <- FZ na K4).
//
// Dwa poziomy, bo dostawa to inne zwierze niz zwrot: 24 dokumenty na kwartal, ale srednio
// 715 szt. kazdy i do 43 SKU. Magazynier pracuje "fakturami" (przyjechala paleta od OSTOY),
// wiec najpierw wybiera dokument, a dopiero potem chodzi po jego towarach.
//
// Rachunek "ile zostalo" jest WSPOLNY ze zwrotami (services/do-rozlozenia) - ta sama funkcja,
// ten sam rozbijStanK4. Licznik SKU na liscie faktur i lista towarow w fakturze pochodza
// z jednego przebiegu, wiec nie moga sie rozjechac ("12 SKU" na liscie, 8 w srodku).
//
// Samo rozkladanie NIE ma tu endpointu: to POST /ruchy/rozloz, ten sam co dla wozka, "Usun ze
// zwrotow" i karty produktu. Jedno wejscie, jeden komplet inwariantow.

// GET /api/dostawy - lista faktur z czyms do rozlozenia.
router.get('/', async (req, res) => {
  let pozycje;
  try {
    pozycje = await doRozlozenia.zbierz(await gtDokumenty.pobierzTowaryZDostawamiK4(), 'dostawy');
  } catch (err) {
    return res.status(503).json({ blad: 'Nie mozna pobrac dostaw z GT (baza niedostepna). Sprobuj ponownie.' });
  }

  // grupujemy po dokumencie MAGAZYNOWYM (PZ), nie po fakturze: PZ to moment przyjecia i klucz
  // atrybucji ruchow. Jedna FZ moze wjechac dwoma PZ-tami i wtedy to dwa osobne zadania.
  const faktury = new Map();
  for (const p of pozycje) {
    if (!faktury.has(p.zrodlo_dok)) {
      faktury.set(p.zrodlo_dok, {
        zrodlo_dok: p.zrodlo_dok,
        dok_zrodlowy: p.dok_zrodlowy,
        kontrahent: p.kontrahent,
        data: p.data,
        sku: 0,
        sztuk: 0,
      });
    }
    const f = faktury.get(p.zrodlo_dok);
    f.sku += 1;
    f.sztuk += p.ilosc;
  }

  // najnowsze na gorze - swieza dostawa jest tym, co realnie stoi na rampie
  const lista = [...faktury.values()].sort((a, b) => String(b.data).localeCompare(String(a.data)));
  res.json({ faktury: lista, razem: lista.length });
});

// GET /api/dostawy/:dok - towary z JEDNEJ dostawy, ktore zostaly do rozlozenia.
// :dok = numer PZ (ruchy.zrodlo_dok), np. "PZ 1033/2026".
router.get('/:dok', async (req, res) => {
  const dok = String(req.params.dok || '').trim();
  if (!dok) return res.status(400).json({ blad: 'Brak numeru dokumentu' });

  let pozycje;
  try {
    pozycje = await doRozlozenia.zbierz(await gtDokumenty.pobierzTowaryZDostawamiK4(), 'dostawy');
  } catch (err) {
    return res.status(503).json({ blad: 'Nie mozna pobrac dostaw z GT (baza niedostepna). Sprobuj ponownie.' });
  }

  const zDok = pozycje.filter((p) => p.zrodlo_dok === dok).sort(doRozlozenia.wgLokalizacji);
  // Pusto = wszystko rozlozone (albo dokument spoza okna). To NIE jest 404: dokument istnieje,
  // po prostu nie ma juz zadania - front pokaze "dostawa rozlozona", a nie blad.
  res.json({
    zrodlo_dok: dok,
    dok_zrodlowy: zDok[0]?.dok_zrodlowy ?? null,
    kontrahent: zDok[0]?.kontrahent ?? null,
    pozycje: zDok,
    razem: zDok.length,
  });
});

module.exports = router;
