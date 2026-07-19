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
//    synchronizowac: zwrot = dokument w GT, a "ile zostalo" = kubelek z rozbijStanK4.
//  - Wozek to FIZYCZNY przedmiot. Powstaje z zaznaczenia na liscie (snapshot), bo GT nie wie,
//    ktory zwrot jest sprawny - kazda korekta wchodzi PZ-em na K4 (0 pozycji PZ<-KFS na
//    BRK/K4R na zywej bazie). Tylko czlowiek trzymajacy towar to wie.
//  - Jeden wozek jest AKTYWNY i zbiera kolejne zwroty, dopoki ktos go nie zamknie ("odwoze").
//    Numer ("Wozek 3") to etykieta fizycznego wozka i wraca do puli po rozlozeniu - klucz w
//    URL-ach i audycie to nadal `id`.
//  - "Usun ze zwrotow" NIE ma tu endpointu: to POST /ruchy/rozloz z celem = lokalizacja
//    podstawowa i zrodlo_dok = numer PZ. Ta sama droga, co rozlozenie z wozka i z karty
//    produktu - jedno wejscie, jeden komplet inwariantow.
//  - Towar, ktory nie wraca na regal (uszkodzony / do reklamacji), idzie normalna operacja
//    na K4R/BRK z karty produktu ("Edytuj").

const MAG = 'K4';

// Sklada liste zwrotow do rozlozenia. Wspolne dla listy i dla weryfikacji przy tworzeniu wozka
// (backend nie wierzy kliencki - patrz POST /wozki).
//
// Ilosci NIE licze tu sam: to rozbijStanK4 na stanie GT i kopii WMS. Druga
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

const klucz = (p) => `${p.artykul_gt_id}|${p.zrodlo_dok}`;

// Etykieta liczona w BACKENDZIE, nie w kazdym froncie z osobna: Zebra i desktop mialy juz
// wlasne `nazwa || "Wozek " + id` i przy dolozeniu numeru rozjechalyby sie z soba.
//
// `nazwa` NIE bierze tu udzialu, choc kolumna zostaje na historie. Byla wpisywana recznie w
// promptcie, ktorego juz nie ma, i po zmianie numeracji zaczela klamac: wozek id=5/numer=5 ma
// w bazie nazwe "Wozek 4" (ktos ja tak wpisal). Numer jest jedynym zrodlem etykiety.
const etykietaWozka = (w) => `Wózek ${w.numer ?? w.id}`;

// Status 'rozlozony' to CACHE wyliczony z ruchow (patrz stanPozycjiWozka), nie niezalezne
// zrodlo prawdy - domykamy go leniwie przy kazdym odczycie, zeby numer wrocil do puli bez jobu.
function domknijRozlozone() {
  for (const w of db.prepare(`SELECT id FROM wozki WHERE status = 'zamkniety'`).all()) {
    const poz = db.prepare('SELECT * FROM pozycje_wozka WHERE wozek_id = ?').all(w.id);
    if (poz.every((p) => stanPozycjiWozka(p).zostalo <= 0)) {
      db.prepare(`UPDATE wozki SET status = 'rozlozony' WHERE id = ?`).run(w.id);
    }
  }
  // Otwarty, pusty i NIE aktywny - zostal po zdjeciu ostatniej pozycji. Nic juz na niego nie
  // trafi (doklada sie zawsze na najnowszy otwarty), wiec trzymalby swoj numer w nieskonczonosc.
  // Aktywny zostaje nawet pusty: wlasnie na niego idzie nastepne "Dodaj".
  const aktywny = aktywnyWozek();
  for (const w of db.prepare(`SELECT id FROM wozki WHERE status = 'otwarty'`).all()) {
    if (aktywny && w.id === aktywny.id) continue;
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM pozycje_wozka WHERE wozek_id = ?').get(w.id);
    if (n === 0) db.prepare(`UPDATE wozki SET status = 'rozlozony' WHERE id = ?`).run(w.id);
  }
}

// Najnizszy numer nieuzywany przez wozek W OBIEGU. Numery sie recykluja, bo oznaczaja fizyczne
// wozki - rozlozony wozek stoi pusty i jego numer jest znowu do wziecia.
function wolnyNumer() {
  const zajete = new Set(db.prepare(
    `SELECT numer FROM wozki WHERE status != 'rozlozony' AND numer IS NOT NULL`
  ).all().map((r) => Number(r.numer)));
  let n = 1;
  while (zajete.has(n)) n += 1;
  return n;
}

// Aktywny wozek = ten, na ktory ida kolejne zwroty. Zamkniecie ("odwoze") jest jedynym
// sposobem na przejscie do nastepnego - stad "najnowszy otwarty", a nie wybor z listy.
function aktywnyWozek() {
  return db.prepare(`SELECT * FROM wozki WHERE status = 'otwarty' ORDER BY id DESC LIMIT 1`).get() ?? null;
}

// Pozycje lezace na wozkach w obiegu, po kluczu (artykul|dokument).
function pozycjeNaWozkach() {
  const wiersze = db.prepare(
    `SELECT p.*, w.numer AS wozek_numer, w.status AS wozek_status
     FROM pozycje_wozka p JOIN wozki w ON w.id = p.wozek_id
     WHERE w.status != 'rozlozony'`
  ).all();
  return new Map(wiersze.map((r) => [klucz(r), r]));
}

const opisWozka = (r) => ({
  id: r.wozek_id,
  numer: r.wozek_numer,
  status: r.wozek_status,
  etykieta: etykietaWozka({ numer: r.wozek_numer, id: r.wozek_id }),
});

// GET /api/zwroty - JEDNA lista: wolne zwroty + te lezace na wozkach (z polem `wozek`).
// Rozdzielone tabele "zwroty" i "wozki" zmuszaly do zgadywania, gdzie wylladowal towar;
// filtrowanie po wozku robi front na tej samej liscie.
router.get('/', async (req, res) => {
  let pozycje;
  try {
    pozycje = await zbierzZwroty();
  } catch (err) {
    return res.status(503).json({ blad: 'Nie mozna pobrac zwrotow z GT (baza niedostepna). Sprobuj ponownie.' });
  }
  domknijRozlozone();
  const naWozkach = pozycjeNaWozkach();

  // Kluczem jest NUMER dokumentu, ktory w GT nie jest unikalny (dwa dok_Id moga miec ten sam
  // dok_NrPelny) - liste zbieram wiec przez zbior widzianych kluczy, a nie przez zdejmowanie z
  // mapy. Inaczej duplikat wyszedlby na ekran jako "wolny", choc dokument lezy juz na wozku.
  const widziane = new Set();
  const wynik = [];
  for (const p of pozycje) {
    const r = naWozkach.get(klucz(p));
    if (!r) { wynik.push({ ...p, zostalo: Number(p.ilosc), wozek: null }); continue; }
    widziane.add(klucz(p));
    const { zostalo } = stanPozycjiWozka(r);
    if (zostalo <= 0) continue;                       // rozlozony z wozka - zadania juz nie ma
    wynik.push({ ...p, ilosc: Number(r.ilosc), zostalo, wozek: opisWozka(r) });
  }

  // Pozycje wozka, ktorych zywy kubelek juz nie widzi (snapshot przezywa okno drobnicy - patrz
  // komentarz przy pozycje_wozka). Bez tego towar realnie lezacy na wozku zniknalby z ekranu.
  for (const [k, r] of naWozkach) {
    if (widziane.has(k)) continue;
    const { zostalo } = stanPozycjiWozka(r);
    if (zostalo <= 0) continue;
    wynik.push({
      artykul_gt_id: r.artykul_gt_id,
      symbol: r.artykul_symbol,
      nazwa: r.artykul_nazwa,
      ean: r.artykul_ean,
      zrodlo_dok: r.zrodlo_dok,
      dok_zrodlowy: null,
      data: null,
      ilosc: Number(r.ilosc),
      zostalo,
      lokalizacja_kod: r.lok_podpowiedz,
      lok_zrodlo: null,
      stan_k4: null,
      wozek: opisWozka(r),
    });
  }

  wynik.sort(doRozlozenia.wgLokalizacji);

  // Oznaczenie "nie znaleziono na wozku" - pozycja zdjeta z wozka przez /brak wraca tu wolna,
  // ale z chorągiewką: inaczej po powrocie na liste nie dalo by sie jej odroznic od zwyklego
  // zwrotu i sygnal ginalby po raz drugi.
  const braki = otwarteBraki();
  for (const p of wynik) {
    const b = braki.get(klucz(p));
    p.brak = b
      ? { czas: b.czas, uzytkownik: b.uzytkownik, wozek_id: b.wozek_id, wozek_numer: b.wozek_numer }
      : null;
  }

  // Wozki w obiegu = pasek filtrow na desktopie. Liczniki biore z TEJ SAMEJ listy, ktora leci
  // do tabeli - inaczej chip obiecywalby inna liczbe, niz tabela pokaze po kliknieciu.
  const liczniki = new Map();
  for (const p of wynik) {
    if (p.wozek) liczniki.set(p.wozek.id, (liczniki.get(p.wozek.id) ?? 0) + 1);
  }
  const wozki = db.prepare(`SELECT * FROM wozki WHERE status != 'rozlozony' ORDER BY numer, id`)
    .all()
    .map((w) => ({
      id: w.id, numer: w.numer, status: w.status, etykieta: etykietaWozka(w),
      pozycji: liczniki.get(w.id) ?? 0,
    }));

  const wolne = wynik.filter((p) => !p.wozek).length;
  const aktywny = aktywnyWozek();
  res.json({
    pozycje: wynik,
    razem: wynik.length,
    wolne,
    na_wozkach: wynik.length - wolne,
    braki: wynik.filter((p) => p.brak).length,
    wozki,
    aktywny_wozek: aktywny
      ? { id: aktywny.id, numer: aktywny.numer, status: aktywny.status, etykieta: etykietaWozka(aktywny) }
      : null,
    nastepny_numer: wolnyNumer(),
  });
});

// POST /api/zwroty/wozki - doklada zaznaczone pozycje na AKTYWNY wozek; gdy zadnego nie ma,
// zaklada nowy. Body: { pozycje: [{ artykul_gt_id, zrodlo_dok }], wozek_id? }
//
// Wozek nie jest "utworzony raz z zaznaczenia": towar wraca do strefy przez caly dzien i
// doklada sie go do tego samego fizycznego wozka, az ktos go odwiezie ("Zamknij"). Dopiero
// wtedy nastepne zwroty ida na kolejny. wozek_id pozwala wskazac inny OTWARTY wozek, gdy w
// obiegu jest wiecej niz jeden (dwie osoby, dwie strefy).
//
// Backend NIE ufa ilosciom z klienta - przelicza liste sam i bierze ilosc z wlasnego rozbicia.
// Klient wskazuje tylko KTORE pozycje (zasada 5: front to UX, nie autorytet).
router.post('/wozki', async (req, res) => {
  const { pozycje: wybrane, wozek_id } = req.body ?? {};
  if (!Array.isArray(wybrane) || !wybrane.length) {
    return res.status(400).json({ blad: 'Pole "pozycje" musi byc niepusta lista' });
  }

  let aktualne;
  try {
    aktualne = await zbierzZwroty();
  } catch (err) {
    return res.status(503).json({ blad: 'Nie mozna zweryfikowac zwrotow w GT - nic nie doszlo na wozek. Sprobuj ponownie.' });
  }
  const poKluczu = new Map(aktualne.map((p) => [klucz(p), p]));

  domknijRozlozone();
  let wozek = null;
  if (wozek_id != null) {
    wozek = db.prepare('SELECT * FROM wozki WHERE id = ?').get(wozek_id);
    if (!wozek) return res.status(404).json({ blad: 'Nie ma takiego wozka' });
    if (wozek.status !== 'otwarty') {
      return res.status(409).json({ blad: `Wozek jest juz ${wozek.status} - odwieziony wozek nie przyjmuje nowych pozycji` });
    }
  } else {
    wozek = aktywnyWozek();
  }

  const naWozkach = pozycjeNaWozkach();
  const doWozka = [];
  const odrzucone = [];
  for (const w of wybrane) {
    const k = `${w.artykul_gt_id}|${w.zrodlo_dok}`;
    const p = poKluczu.get(k);
    const juz = naWozkach.get(k);
    if (juz) {
      const gdzie = wozek && juz.wozek_id === wozek.id ? 'juz na tym wozku' : `juz na wozku ${opisWozka(juz).etykieta}`;
      odrzucone.push({ ...w, powod: gdzie });
      continue;
    }
    if (!p) { odrzucone.push({ ...w, powod: 'juz rozlozone lub poza oknem zwrotow' }); continue; }
    doWozka.push(p);
  }
  if (!doWozka.length) {
    return res.status(409).json({ blad: 'Zadna z zaznaczonych pozycji nie jest juz do rozlozenia', odrzucone });
  }

  const operator = req.uzytkownik?.imie ?? null;
  const utworzony = !wozek;
  db.exec('BEGIN');
  try {
    if (!wozek) {
      const r = db.prepare(`INSERT INTO wozki (numer, status, utworzyl) VALUES (?, 'otwarty', ?)`)
        .run(wolnyNumer(), operator);
      wozek = db.prepare('SELECT * FROM wozki WHERE id = ?').get(r.lastInsertRowid);
    }
    const ins = db.prepare(`
      INSERT INTO pozycje_wozka (wozek_id, artykul_gt_id, artykul_symbol, artykul_nazwa,
                                 artykul_ean, zrodlo_dok, ilosc, lok_podpowiedz)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const p of doWozka) {
      ins.run(wozek.id, p.artykul_gt_id, p.symbol, p.nazwa, p.ean, p.zrodlo_dok, p.ilosc, p.lokalizacja_kod);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const pozycji = db.prepare('SELECT COUNT(*) AS n FROM pozycje_wozka WHERE wozek_id = ?').get(wozek.id).n;
  audyt.zapisz({
    uzytkownik: operator,
    akcja: utworzony ? 'wozek_utworzony' : 'wozek_dolozono',
    magazyn: MAG,
    ilosc: doWozka.length,
    wynik: 'ok',
    po: { wozek_id: wozek.id, numer: wozek.numer, dodane: doWozka.length, pozycji },
  });
  res.status(201).json({
    wozek_id: wozek.id,
    numer: wozek.numer,
    etykieta: etykietaWozka(wozek),
    utworzony,
    dodane: doWozka.length,
    pozycji,
    odrzucone,
  });
});

// GET /api/zwroty/wozki - lista wozkow (dla Zebry: "Wozek 1 - 20 SKU - zamkniety").
router.get('/wozki', (req, res) => {
  domknijRozlozone();
  const wozki = db.prepare(`SELECT * FROM wozki ORDER BY id DESC`).all();
  for (const w of wozki) {
    const poz = db.prepare('SELECT * FROM pozycje_wozka WHERE wozek_id = ?').all(w.id).map(stanPozycjiWozka);
    w.etykieta = etykietaWozka(w);
    w.pozycji = poz.length;
    w.do_rozlozenia = poz.filter((p) => p.zostalo > 0).length;
  }
  res.json({ wozki, razem: wozki.length });
});

// GET /api/zwroty/wozki/:id - pozycje wozka + ile z kazdej zostalo (liczone z ruchow).
router.get('/wozki/:id', (req, res) => {
  const w = db.prepare('SELECT * FROM wozki WHERE id = ?').get(req.params.id);
  if (!w) return res.status(404).json({ blad: 'Nie ma takiego wozka' });
  w.etykieta = etykietaWozka(w);
  const pozycje = db.prepare('SELECT * FROM pozycje_wozka WHERE wozek_id = ? ORDER BY lok_podpowiedz, artykul_symbol')
    .all(w.id).map(stanPozycjiWozka);
  res.json({ wozek: w, pozycje, do_rozlozenia: pozycje.filter((p) => p.zostalo > 0).length });
});

// POST /api/zwroty/wozki/:id/zdejmij - "to nie mialo tu trafic". Body: { artykul_gt_id, zrodlo_dok }
//
// Odwrotnosc dokladania, nie zalatwienie zadania: pozycja wraca na liste wolnych zwrotow i
// dalej czeka na odniesienie.
//
// Oba wyjscia z wozka (to i /brak) zdejmuja pozycje - roznia sie SLADEM. Tu jest korekta
// pomylki przy dokladaniu, wiec audyt 'wozek_zdjeto' z wynikiem ok i czysty powrot na liste.
// Tam jest zgloszenie "wozek obiecuje towar, ktorego na nim nie ma", wiec pozycja wraca
// oznaczona jako nie znaleziona i wisi jako sprawa, dopoki ktos jej nie domknie.
router.post('/wozki/:id/zdejmij', (req, res) => {
  const { artykul_gt_id, zrodlo_dok } = req.body ?? {};
  if (!artykul_gt_id) return res.status(400).json({ blad: 'Pole "artykul_gt_id" jest wymagane' });
  if (!zrodlo_dok) return res.status(400).json({ blad: 'Pole "zrodlo_dok" jest wymagane' });
  const w = db.prepare('SELECT * FROM wozki WHERE id = ?').get(req.params.id);
  if (!w) return res.status(404).json({ blad: 'Nie ma takiego wozka' });
  const p = db.prepare('SELECT * FROM pozycje_wozka WHERE wozek_id = ? AND artykul_gt_id = ? AND zrodlo_dok = ?')
    .get(w.id, String(artykul_gt_id), String(zrodlo_dok));
  if (!p) return res.status(404).json({ blad: 'Nie ma takiej pozycji na tym wozku' });

  db.prepare('DELETE FROM pozycje_wozka WHERE id = ?').run(p.id);
  audyt.zapisz({
    uzytkownik: req.uzytkownik?.imie ?? null,
    akcja: 'wozek_zdjeto',
    artykul_gt_id: String(artykul_gt_id),
    artykul_symbol: p.artykul_symbol,
    magazyn: MAG,
    lokalizacja: p.lok_podpowiedz,
    ilosc: p.ilosc,
    wynik: 'ok',
    dok_gt_numer: String(zrodlo_dok),
    przed: { wozek_id: w.id, numer: w.numer },
  });
  res.json({ zdjete: true });
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
    po: { wozek_id: w.id, numer: w.numer },
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
// Pozycja SPADA z wozka i wraca na liste wolnych zwrotow, oznaczona jako "nie znaleziono".
// Wczesniej zostawala na wozku: zadanie wracalo przy kazdym wejsciu w wozek, a jedynym
// sladem byl raport, ktorego zaden ekran nie pokazywal. Oznaczona pozycja na glownej liscie
// jest widoczna tam, gdzie i tak sie patrzy, i mozna ja normalnie obsluzyc (dolozyc na inny
// wozek, rozlozyc, zalatwic).
router.post('/wozki/:id/brak', (req, res) => {
  const { artykul_gt_id, zrodlo_dok } = req.body ?? {};
  if (!artykul_gt_id) return res.status(400).json({ blad: 'Pole "artykul_gt_id" jest wymagane' });
  if (!zrodlo_dok) return res.status(400).json({ blad: 'Pole "zrodlo_dok" jest wymagane' });
  const w = db.prepare('SELECT * FROM wozki WHERE id = ?').get(req.params.id);
  if (!w) return res.status(404).json({ blad: 'Nie ma takiego wozka' });
  const p = db.prepare('SELECT * FROM pozycje_wozka WHERE wozek_id = ? AND artykul_gt_id = ? AND zrodlo_dok = ?')
    .get(w.id, String(artykul_gt_id), String(zrodlo_dok));
  if (!p) return res.status(404).json({ blad: 'Nie ma takiej pozycji na tym wozku' });

  const operator = req.uzytkownik?.imie ?? null;
  // audyt PRZED zdjeciem: gdyby zapis padl, pozycja zostaje na wozku (widoczne zadanie),
  // zamiast zniknac bez sladu
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
    przed: { wozek_id: w.id, numer: w.numer },
  });
  db.prepare('DELETE FROM pozycje_wozka WHERE id = ?').run(p.id);
  res.status(201).json({ zgloszone: true, zdjete_z_wozka: true });
});

// Otwarte "nie znaleziono na wozku", po kluczu (artykul|dokument). Para wypada, gdy pozniej
// ktos ja rozlozyl (ruch z tym zrodlo_dok) albo recznie domknal.
//
// Jedno zrodlo dla oznaczenia na liscie zwrotow i dla raportu - dwie implementacje "co jest
// jeszcze otwarte" rozjechalyby sie przy pierwszej zmianie regul domykania.
function otwarteBraki() {
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

  const otwarte = new Map();
  for (const z of zgloszenia) {
    // rozlozone po zgloszeniu = towar sie znalazl, sprawa nieaktualna. Liczymy z ruchow, wiec
    // rozlozenie z KAZDEJ drogi (wozek, karta produktu, desktop) domyka to samo.
    const rozlozono = gtDokumenty.iloscRozlozonaZDokumentu(z.artykul_gt_id, MAG, z.zrodlo_dok);
    if (rozlozono >= Number(z.ilosc)) continue;
    let przed = {};
    try { przed = JSON.parse(z.przed) || {}; } catch { przed = {}; }
    delete z.przed;
    otwarte.set(`${z.artykul_gt_id}|${z.zrodlo_dok}`, {
      ...z, wozek_id: przed.wozek_id ?? null, wozek_numer: przed.numer ?? null,
    });
  }
  return otwarte;
}

// GET /api/zwroty/raport - otwarte "nie znaleziono na wozku". Ten sam wzorzec domykania co
// raporty sciezek - zeby wpiac to w istniejacy panel "Sprawy", a nie robic trzeciego,
// osobnego raportu do recznego pilnowania.
router.get('/raport', (req, res) => {
  const pozycje = [...otwarteBraki().values()];
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
