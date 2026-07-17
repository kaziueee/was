const express = require('express');
const db = require('../db/database');
const audyt = require('../services/audyt');
const gtDokumenty = require('../services/gt-dokumenty');
const doRozlozenia = require('../services/do-rozlozenia');

const router = express.Router();

// Zwroty do rozlozenia (PZ <- KFS na K4) + wozki.
//
// Model (ustalenia z magazynierem):
//  - Lista zwrotow jest LICZONA NA ZYWO z GT, bez jobu i bez wlasnej tabeli. Nie ma czego
//    synchronizowac: zwrot = dokument w GT, a "ile zostalo" = kubelek z rozbijDeficytK4.
//  - Wozek to FIZYCZNY przedmiot. Powstaje z zaznaczenia na liscie (snapshot), bo GT nie wie,
//    ktory zwrot jest sprawny - kazda korekta wchodzi PZ-em na K4 (0 pozycji PZ<-KFS na
//    BRK/K4R na zywej bazie). Tylko czlowiek trzymajacy towar to wie.
//  - "Usun ze zwrotow" NIE ma tu endpointu: to POST /ruchy/rozloz z celem = lokalizacja
//    podstawowa i zrodlo_dok = numer PZ. Ta sama droga, co rozlozenie z wozka i z karty
//    produktu - jedno wejscie, jeden komplet inwariantow.
//  - Towar, ktory nie wraca na regal (uszkodzony / do reklamacji), idzie normalna operacja
//    na K4R/BRK z karty produktu ("Edytuj").

const MAG = 'K4';

// Sklada liste zwrotow do rozlozenia. Wspolne dla listy i dla weryfikacji przy tworzeniu wozka
// (backend nie wierzy kliencki - patrz POST /wozki).
//
// Ilosci NIE licze tu sam: to rozbijDeficytK4 na deficycie (stan GT - suma WMS). Druga
// implementacja licznika rozjechalaby liste z karta produktu - kolejnosc capowania kubelkow
// jest czescia definicji, nie detalem.
async function zbierzZwroty() {
  const kandydaci = await gtDokumenty.pobierzTowaryZeZwrotamiK4();
  const pozycje = await doRozlozenia.zbierz(kandydaci, 'zwroty');
  return pozycje.sort(doRozlozenia.wgLokalizacji);
}

// Ile z pozycji wozka juz rozlozono - z RUCHOW, nie z wlasnej flagi. Dzieki temu rozlozenie
// tego samego zwrotu z karty produktu zdejmuje pozycje takze z wozka.
function stanPozycjiWozka(p) {
  const rozlozono = gtDokumenty.iloscRozlozonaZDokumentu(p.artykul_gt_id, MAG, p.zrodlo_dok);
  const zostalo = Math.max(Number(p.ilosc) - rozlozono, 0);
  return { ...p, rozlozono, zostalo };
}

// GET /api/zwroty - lista zwrotow do rozlozenia (nieprzypisanych do zadnego wozka).
router.get('/', async (req, res) => {
  let pozycje;
  try {
    pozycje = await zbierzZwroty();
  } catch (err) {
    return res.status(503).json({ blad: 'Nie mozna pobrac zwrotow z GT (baza niedostepna). Sprobuj ponownie.' });
  }
  // pozycje juz zaladowane na OTWARTY/zamkniety wozek nie sa wolne - inaczej dwie osoby
  // zbudowalyby dwa wozki z tego samego towaru
  const naWozkach = new Set(db.prepare(
    `SELECT p.artykul_gt_id, p.zrodlo_dok FROM pozycje_wozka p
     JOIN wozki w ON w.id = p.wozek_id WHERE w.status != 'rozlozony'`
  ).all().map((r) => `${r.artykul_gt_id}|${r.zrodlo_dok}`));

  const wolne = pozycje.filter((p) => !naWozkach.has(`${p.artykul_gt_id}|${p.zrodlo_dok}`));
  res.json({ pozycje: wolne, razem: wolne.length, na_wozkach: pozycje.length - wolne.length });
});

// POST /api/zwroty/wozki - tworzy wozek z zaznaczonych pozycji.
// Body: { pozycje: [{ artykul_gt_id, zrodlo_dok }], nazwa? }
//
// Backend NIE ufa ilosciom z klienta - przelicza liste sam i bierze ilosc z wlasnego rozbicia.
// Klient wskazuje tylko KTORE pozycje (zasada 5: front to UX, nie autorytet).
router.post('/wozki', async (req, res) => {
  const { pozycje: wybrane, nazwa } = req.body ?? {};
  if (!Array.isArray(wybrane) || !wybrane.length) {
    return res.status(400).json({ blad: 'Pole "pozycje" musi byc niepusta lista' });
  }

  let aktualne;
  try {
    aktualne = await zbierzZwroty();
  } catch (err) {
    return res.status(503).json({ blad: 'Nie mozna zweryfikowac zwrotow w GT - wozek nie powstal. Sprobuj ponownie.' });
  }
  const poKluczu = new Map(aktualne.map((p) => [`${p.artykul_gt_id}|${p.zrodlo_dok}`, p]));

  const naWozkach = new Set(db.prepare(
    `SELECT p.artykul_gt_id, p.zrodlo_dok FROM pozycje_wozka p
     JOIN wozki w ON w.id = p.wozek_id WHERE w.status != 'rozlozony'`
  ).all().map((r) => `${r.artykul_gt_id}|${r.zrodlo_dok}`));

  const doWozka = [];
  const odrzucone = [];
  for (const w of wybrane) {
    const klucz = `${w.artykul_gt_id}|${w.zrodlo_dok}`;
    const p = poKluczu.get(klucz);
    if (!p) { odrzucone.push({ ...w, powod: 'juz rozlozone lub poza oknem zwrotow' }); continue; }
    if (naWozkach.has(klucz)) { odrzucone.push({ ...w, powod: 'juz na innym wozku' }); continue; }
    doWozka.push(p);
  }
  if (!doWozka.length) {
    return res.status(409).json({ blad: 'Zadna z zaznaczonych pozycji nie jest juz do rozlozenia', odrzucone });
  }

  const operator = req.uzytkownik?.imie ?? null;
  let wozekId;
  db.exec('BEGIN');
  try {
    const w = db.prepare(`INSERT INTO wozki (nazwa, status, utworzyl) VALUES (?, 'otwarty', ?)`)
      .run(nazwa ? String(nazwa).slice(0, 60) : null, operator);
    wozekId = w.lastInsertRowid;
    const ins = db.prepare(`
      INSERT INTO pozycje_wozka (wozek_id, artykul_gt_id, artykul_symbol, artykul_nazwa,
                                 artykul_ean, zrodlo_dok, ilosc, lok_podpowiedz)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const p of doWozka) {
      ins.run(wozekId, p.artykul_gt_id, p.symbol, p.nazwa, p.ean, p.zrodlo_dok, p.ilosc, p.lokalizacja_kod);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  audyt.zapisz({
    uzytkownik: operator, akcja: 'wozek_utworzony', magazyn: MAG,
    ilosc: doWozka.length, wynik: 'ok',
    po: { wozek_id: wozekId, pozycji: doWozka.length },
  });
  res.status(201).json({ wozek_id: wozekId, pozycji: doWozka.length, odrzucone });
});

// GET /api/zwroty/wozki - lista wozkow (dla Zebry: "Wozek 1 - 20 SKU - zamkniety").
router.get('/wozki', (req, res) => {
  const wozki = db.prepare(`SELECT * FROM wozki ORDER BY id DESC`).all();
  for (const w of wozki) {
    const poz = db.prepare('SELECT * FROM pozycje_wozka WHERE wozek_id = ?').all(w.id).map(stanPozycjiWozka);
    w.pozycji = poz.length;
    w.do_rozlozenia = poz.filter((p) => p.zostalo > 0).length;
  }
  res.json({ wozki, razem: wozki.length });
});

// GET /api/zwroty/wozki/:id - pozycje wozka + ile z kazdej zostalo (liczone z ruchow).
router.get('/wozki/:id', (req, res) => {
  const w = db.prepare('SELECT * FROM wozki WHERE id = ?').get(req.params.id);
  if (!w) return res.status(404).json({ blad: 'Nie ma takiego wozka' });
  const pozycje = db.prepare('SELECT * FROM pozycje_wozka WHERE wozek_id = ? ORDER BY lok_podpowiedz, artykul_symbol')
    .all(w.id).map(stanPozycjiWozka);
  res.json({ wozek: w, pozycje, do_rozlozenia: pozycje.filter((p) => p.zostalo > 0).length });
});

// POST /api/zwroty/wozki/:id/zamknij - "zamykam, odwoze" (kolejne zwroty pojda na nastepny wozek).
router.post('/wozki/:id/zamknij', (req, res) => {
  const w = db.prepare('SELECT * FROM wozki WHERE id = ?').get(req.params.id);
  if (!w) return res.status(404).json({ blad: 'Nie ma takiego wozka' });
  if (w.status !== 'otwarty') return res.status(409).json({ blad: `Wozek jest juz ${w.status}` });
  const operator = req.uzytkownik?.imie ?? null;
  db.prepare(`UPDATE wozki SET status='zamkniety', zamkniety=CURRENT_TIMESTAMP, zamknal=? WHERE id=?`)
    .run(operator, w.id);
  audyt.zapisz({
    uzytkownik: operator, akcja: 'wozek_zamkniety', magazyn: MAG, wynik: 'ok',
    po: { wozek_id: w.id },
  });
  res.json({ zamkniety: true });
});

// POST /api/zwroty/wozki/:id/brak - "tego nie ma na wozku".
// Body: { artykul_gt_id, zrodlo_dok }
//
// To INNY fakt niz "stan zero" ze sciezki obchodu: tam magazynier mowi "polka jest pusta"
// (porownywalne z GT), tu mowi "wozek nie zawiera tego, co lista obiecuje" - GT o wozkach nic
// nie wie, wiec nie ma czego porownywac. Stad wlasna akcja i zaden ruch WMS.
//
// Pozycja ZOSTAJE na wozku: zgloszenie braku to sygnal do wyjasnienia, nie skasowanie zadania.
// Zniknie sama, gdy ktos ja rozlozy (licznik z ruchow) - albo gdy sprawa zostanie domknieta.
router.post('/wozki/:id/brak', (req, res) => {
  const { artykul_gt_id, zrodlo_dok } = req.body ?? {};
  if (!artykul_gt_id) return res.status(400).json({ blad: 'Pole "artykul_gt_id" jest wymagane' });
  if (!zrodlo_dok) return res.status(400).json({ blad: 'Pole "zrodlo_dok" jest wymagane' });
  const p = db.prepare('SELECT * FROM pozycje_wozka WHERE wozek_id = ? AND artykul_gt_id = ? AND zrodlo_dok = ?')
    .get(req.params.id, String(artykul_gt_id), String(zrodlo_dok));
  if (!p) return res.status(404).json({ blad: 'Nie ma takiej pozycji na tym wozku' });

  const operator = req.uzytkownik?.imie ?? null;
  audyt.zapisz({
    uzytkownik: operator,
    akcja: 'zwrot_nieznaleziony',
    artykul_gt_id: String(artykul_gt_id),
    artykul_symbol: p.artykul_symbol,
    magazyn: MAG,
    lokalizacja: p.lok_podpowiedz,
    ilosc: p.ilosc,
    wynik: 'niezgodne',
    // dokument w DEDYKOWANEJ kolumnie, nie w JSON-ie "przed": raport grupuje po niej, a
    // grupowanie po stringu JSON rozjechaloby sie przy innej kolejnosci kluczy
    dok_gt_numer: String(zrodlo_dok),
    przed: { wozek_id: Number(req.params.id) },
  });
  res.status(201).json({ zgloszone: true });
});

// GET /api/zwroty/raport - otwarte "nie znaleziono na wozku". Para (artykul+dokument) wypada,
// gdy pozniej ktos ja rozlozyl (ruch z tym zrodlo_dok) albo recznie domknal. Ten sam wzorzec
// domykania co raporty sciezek - zeby wpiac to w istniejacy panel "Sprawy", a nie robic
// trzeciego, osobnego raportu do recznego pilnowania.
router.get('/raport', (req, res) => {
  const zgloszenia = db.prepare(`
    SELECT a.artykul_gt_id, a.artykul_symbol, a.lokalizacja AS lokalizacja_kod, a.ilosc,
           a.czas, a.uzytkownik, a.przed, a.dok_gt_numer AS zrodlo_dok
    FROM audyt a
    JOIN (
      SELECT artykul_gt_id, dok_gt_numer, MAX(id) AS max_id FROM audyt
      WHERE akcja IN ('zwrot_nieznaleziony', 'zwrot_brak_zamkniety')
      GROUP BY artykul_gt_id, dok_gt_numer
    ) ost ON ost.max_id = a.id
    WHERE a.akcja = 'zwrot_nieznaleziony'
    ORDER BY a.lokalizacja
  `).all();

  const pozycje = [];
  for (const z of zgloszenia) {
    // rozlozone po zgloszeniu = towar sie znalazl, sprawa nieaktualna. Liczymy z ruchow, wiec
    // rozlozenie z KAZDEJ drogi (wozek, karta produktu, desktop) domyka to samo.
    const rozlozono = gtDokumenty.iloscRozlozonaZDokumentu(z.artykul_gt_id, MAG, z.zrodlo_dok);
    if (rozlozono >= Number(z.ilosc)) continue;
    let przed = {};
    try { przed = JSON.parse(z.przed) || {}; } catch { przed = {}; }
    delete z.przed;
    pozycje.push({ ...z, wozek_id: przed.wozek_id ?? null });
  }
  res.json({ pozycje, razem: pozycje.length });
});

// POST /api/zwroty/niezgodnosc/zamknij - reczne "Zalatwione" dla zgloszonego braku.
router.post('/niezgodnosc/zamknij', (req, res) => {
  const { artykul_gt_id, artykul_symbol, zrodlo_dok, wozek_id, notatka } = req.body ?? {};
  if (!artykul_gt_id) return res.status(400).json({ blad: 'Pole "artykul_gt_id" jest wymagane' });
  if (!zrodlo_dok) return res.status(400).json({ blad: 'Pole "zrodlo_dok" jest wymagane' });
  audyt.zapisz({
    uzytkownik: req.uzytkownik?.imie ?? null,
    akcja: 'zwrot_brak_zamkniety',
    artykul_gt_id: String(artykul_gt_id),
    artykul_symbol: artykul_symbol ?? null,
    magazyn: MAG,
    wynik: 'zamkniete',
    // ta sama kolumna co przy zgloszeniu - inaczej wpis nie trafilby do tej samej grupy
    // MAX(id) i sprawa zostalaby otwarta
    dok_gt_numer: String(zrodlo_dok),
    przed: { wozek_id: wozek_id != null ? Number(wozek_id) : null },
    po: notatka ? { notatka: String(notatka).slice(0, 500) } : null,
  });
  res.status(201).json({ zamkniete: true });
});

module.exports = router;
