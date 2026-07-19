const express = require('express');
const db = require('../db/database');
const audyt = require('../services/audyt');
const gtDokumenty = require('../services/gt-dokumenty');
const { pobierzK4NiskieStany, pobierzK4PelnaRezerwacja, dostepneWGt, pobierzStanyGt, sumaRazem, sumaZapasK4 } = require('../services/gt-produkty');
const gtFields = require('../services/gt-fields');
const gtAtrybuty = require('../services/gt-atrybuty');

const router = express.Router();

// Suma kopii WMS dla K4 - do rozbicia stanu na strefy i polke (rozbijStanK4).
const sumaWmsK4 = (artykulGtId) => Number(db.prepare(
  `SELECT COALESCE(SUM(s.ilosc), 0) AS suma
   FROM stany_lokalizacji s JOIN lokalizacje l ON l.id = s.lokalizacja_id
   WHERE l.magazyn = 'K4' AND s.artykul_gt_id = ?`
).get(String(artykulGtId)).suma) || 0;

// Dokleja do pozycji obchodu `oczekiwana_polka` = stan GT - strefy oraz `w_strefach`.
// Jedno zapytanie o dokumenty na CALA liste (nie N+1 w petli). Gdy GT z dokumentami padnie,
// zwraca liste bez zmian - obchod ma dzialac, tylko bez odjecia stref.
async function dolaczOczekiwanaPolke(pozycje) {
  if (!pozycje.length) return pozycje;
  let dokMap;
  try {
    dokMap = await gtDokumenty.pobierzDostawyK4(pozycje.map((p) => p.artykul_gt_id));
  } catch {
    return pozycje.map((p) => ({ ...p, oczekiwana_polka: p.stan, w_strefach: 0 }));
  }
  return pozycje.map((p) => {
    const r = gtDokumenty.rozbijStanK4(p.stan, sumaWmsK4(p.artykul_gt_id), dokMap.get(String(p.artykul_gt_id)) || [],
      { artykul_gt_id: p.artykul_gt_id });
    return { ...p, oczekiwana_polka: p.stan - r.wDrodze, w_strefach: r.wDrodze };
  });
}

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

// Sciezka "Brak parametrow": ile pozycji naraz ciagniemy z GT. Backlog to ~1450 towarow,
// ale obchod i tak jest jednorazowo krotki - limit chroni przed ciagnieciem calosci na kolektor.
const LIMIT_BRAK_PARAMETROW = 500;
// Ile dni po sprawdzeniu pary (artykul+lokalizacja) wypada z listy.
const DNI_POMIN_SPRAWDZONE = 180;
// Ile dni pary POMINIETEJ ("Pomin" na obchodzie) nie pokazujemy. Krotkie okno, bo pominiecie
// to "nie teraz" (zastawiona lokalizacja, brak czasu), a nie "sprawdzone" - po 180 dniach jak
// przy sprawdzeniu zadanie by wyparowalo, a bez okna wracaloby jutro na to samo miejsce listy
// (sort po lokalizacji), wiec magazyniera witalaby zawsze ta sama blokada.
const DNI_POMIN_POMINIETE = 7;
// Ile dni po przyjeciu z magazynu zewnetrznego (MAG/LS) pomijamy SKU - stan jest swiezy
// i znany (ktos swiadomie dolozyl kilka szt.), nie ma czego weryfikowac.
const DNI_POMIN_PRZYJECIE = 30;

// Wspolny zapis sprawdzenia przystanku (obie sciezki). Porownuje policzone ze stanem K4
// z GT (Subiekt = master stanow), zapisuje do audytu pod podanymi akcjami. NIE robi ruchu WMS.
async function zapiszSprawdzenie(req, res, akcjaZgodne, akcjaNiezgodne) {
  const { artykul_gt_id, artykul_symbol, lokalizacja_kod, ilosc_policzona } = req.body ?? {};
  // "Kto" bierzemy z SESJI, nie z body: pole w body klient moze pominac albo podstawic cudze
  // imie (CLAUDE.md zasada 5 - backend jedynym zrodlem prawdy). Tak samo robi routes/zwroty.js.
  const operator = req.uzytkownik?.imie ?? null;
  if (!artykul_gt_id) return res.status(400).json({ blad: 'Pole "artykul_gt_id" jest wymagane' });
  if (!lokalizacja_kod) return res.status(400).json({ blad: 'Pole "lokalizacja_kod" jest wymagane' });
  const policzone = Number(ilosc_policzona);
  if (!Number.isFinite(policzone) || policzone < 0) {
    return res.status(400).json({ blad: 'Pole "ilosc_policzona" musi byc liczba >= 0' });
  }

  // K4 = stan zawsze z Subiekta (GT master). Porownujemy policzone ze stanem GT, nie
  // z kopia WMS (ta bywa nieaktualna - sprzedaz w Subiekcie zbija stan bez wiedzy WMS).
  //
  // ALE nie z CALYM stanem K4, tylko z tym, co moze lezec NA POLCE (stan GT - strefy).
  // Magazynier stoi przy regale i liczy polke; sztuki z nierozlozonej dostawy albo zwrotu
  // czekajacego w strefie sa wg GT na K4, ale fizycznie leza gdzie indziej. Bez tego odjecia
  // SKU ze zwrotem 2 szt. i stanem GT 3 dawal FALSZYWA NIEZGODNOSC: magazynier liczy na polce
  // 1, system oczekiwal 3. Przy zwrotach (1-2 szt.) to w pelni osiagalne - filtr stanu 1..5
  // maskuje to tylko przy duzych dostawach.
  let stan, zrodlo, wStrefach = 0;
  try {
    const gt = await dostepneWGt(String(artykul_gt_id), 'K4');
    const dok = (await gtDokumenty.pobierzDostawyK4([artykul_gt_id])).get(String(artykul_gt_id)) || [];
    const r = gtDokumenty.rozbijStanK4(gt.stan, sumaWmsK4(artykul_gt_id), dok, { artykul_gt_id });
    wStrefach = r.wDrodze;   // suma WSZYSTKICH kubelkow - nie skladamy jej recznie
    stan = Number(gt.stan) - wStrefach;
    zrodlo = 'GT';
  } catch (err) {
    return res.status(503).json({ blad: 'Nie mozna zweryfikowac stanu GT (baza niedostepna). Sprobuj ponownie.' });
  }

  const zgodne = policzone === stan;
  const roznica = policzone - stan;

  audyt.zapisz({
    uzytkownik: operator,
    akcja: zgodne ? akcjaZgodne : akcjaNiezgodne,
    artykul_gt_id: String(artykul_gt_id),
    artykul_symbol: artykul_symbol ?? null,
    magazyn: 'K4',
    lokalizacja: lokalizacja_kod,
    ilosc: policzone,
    wynik: zgodne ? 'zgodne' : 'niezgodne',
    // `stan` to juz oczekiwana POLKA (stan GT - strefy). w_strefach zapisujemy osobno, zeby
    // przy czytaniu starego raportu bylo widac, czemu oczekiwano akurat tyle.
    przed: { stan, zrodlo, w_strefach: wStrefach },
    po: { policzone },
  });

  res.status(201).json({ zgodne, stan, zrodlo, policzone, roznica, w_strefach: wStrefach });
}

// Wspolne "Pomin" - magazynier nie moze teraz sprawdzic pozycji (lokalizacja zastawiona,
// brak czasu). To NIE jest wynik liczenia, wiec:
//  - nie wchodzi do okna MAX(id) w raportNiezgodnosci: pominiecie po niezgodnosci NIE moze
//    jej domykac ("nie chcialo mi sie" != "zalatwione"),
//  - ma wlasne, krotkie okno wykluczenia (DNI_POMIN_POMINIETE), niezalezne od sprawdzonych.
// Skan nie jest wymagany - magazynier wlasnie mowi, ze do towaru nie dotarl.
function zapiszPominiecie(req, res, akcja) {
  const { artykul_gt_id, artykul_symbol, lokalizacja_kod } = req.body ?? {};
  const operator = req.uzytkownik?.imie ?? null;   // z sesji, nie z body (zob. zapiszSprawdzenie)
  if (!artykul_gt_id) return res.status(400).json({ blad: 'Pole "artykul_gt_id" jest wymagane' });
  if (!lokalizacja_kod) return res.status(400).json({ blad: 'Pole "lokalizacja_kod" jest wymagane' });
  audyt.zapisz({
    uzytkownik: operator,
    akcja,
    artykul_gt_id: String(artykul_gt_id),
    artykul_symbol: artykul_symbol ?? null,
    magazyn: 'K4',
    lokalizacja: lokalizacja_kod,
    wynik: 'pominiete',
  });
  res.status(201).json({ pominiete: true });
}

// Zbior par (artykul|lokalizacja) pominietych w oknie DNI_POMIN_POMINIETE - do wykluczenia z listy.
function paryPominiete(akcja) {
  return new Set(db.prepare(
    `SELECT DISTINCT artykul_gt_id, lokalizacja FROM audyt
     WHERE akcja = ? AND czas >= datetime('now', ?)`
  ).all(akcja, `-${DNI_POMIN_POMINIETE} days`).map((r) => `${r.artykul_gt_id}|${r.lokalizacja}`));
}

// Wspolny raport otwartych niezgodnosci: pary (artykul+lokalizacja), dla ktorych NAJNOWSZE
// sprawdzenie danej sciezki to "niezgodne" (nie domkniete pozniejszym zgodnym).
//
// Rezerwacja jest dociagana z GT NA ZYWO (nie z audytu), bo do decyzji "czym sie zajac
// najpierw" liczy sie stan dzisiejszy: rezerwacja sprzed dwoch tygodni juz nic nie mowi -
// ZK zdazyly powstac i zniknac. Ale GT NIE MOZE wywrocic raportu: przy niedostepnej bazie
// oddajemy rezerwacja=null i raport dziala dalej (to czysty odczyt audytu - zadnego 503).
async function raportNiezgodnosci(res, akcjaZgodne, akcjaNiezgodne, akcjaZamkniecia) {
  // Para wypada z raportu, gdy jej NAJNOWSZE zdarzenie to zgodne policzenie ALBO reczne
  // domkniecie ("Zalatwione", akcjaZamkniecia) - dlatego wszystkie trzy akcje wchodza do
  // okna MAX(id), a pokazujemy tylko te, gdzie najnowsze = niezgodne.
  const pozycje = db.prepare(`
    SELECT a.artykul_gt_id, a.artykul_symbol, a.magazyn, a.lokalizacja AS lokalizacja_kod,
           a.ilosc AS policzone, a.przed, a.czas, a.uzytkownik
    FROM audyt a
    JOIN (
      SELECT artykul_gt_id, lokalizacja, MAX(id) AS max_id
      FROM audyt
      WHERE akcja IN (?, ?, ?)
      GROUP BY artykul_gt_id, lokalizacja
    ) ost ON ost.max_id = a.id
    WHERE a.akcja = ?
    ORDER BY a.lokalizacja
  `).all(akcjaZgodne, akcjaNiezgodne, akcjaZamkniecia, akcjaNiezgodne);

  for (const p of pozycje) {
    let przed = {};
    try { przed = JSON.parse(p.przed) || {}; } catch { przed = {}; }
    p.stan = przed.stan ?? przed.stan_gt ?? null;
    p.zrodlo = przed.zrodlo ?? (przed.stan_gt != null ? 'GT' : null);
    delete p.przed;
    p.rezerwacja = null;
  }

  // GT tylko wzbogaca - blad tlumimy, bo raport ma dzialac takze przy padnietym Subiekcie
  if (pozycje.length) {
    try {
      const stany = await pobierzStanyGt(pozycje.map((p) => p.artykul_gt_id));
      for (const p of pozycje) {
        p.rezerwacja = stany.get(String(p.artykul_gt_id))?.K4?.rezerwacja ?? null;
      }
    } catch { /* GT niedostepny - rezerwacja zostaje null, front pokaze "—" */ }
  }

  res.json({ pozycje, razem: pozycje.length });
}

// Reczne domkniecie niezgodnosci ("Zalatwione"). Zapisuje wpis audytu, ktory staje sie
// najnowszym zdarzeniem pary (artykul+lokalizacja) - wiec para wypada z raportu, tak jak
// zamykalo ja zgodne policzenie. NIE robi ruchu WMS, nie dotyka GT (rozjazd naprawia sie
// gdzie indziej, np. korekta w Subiekcie; tu tylko odnotowujemy, ze ktos to ogarnal).
function zamknijNiezgodnosc(req, res, akcjaZamkniecia) {
  const { artykul_gt_id, artykul_symbol, lokalizacja_kod, notatka } = req.body ?? {};
  const operator = req.uzytkownik?.imie ?? null;   // z sesji, nie z body (zob. zapiszSprawdzenie)
  if (!artykul_gt_id) return res.status(400).json({ blad: 'Pole "artykul_gt_id" jest wymagane' });
  if (!lokalizacja_kod) return res.status(400).json({ blad: 'Pole "lokalizacja_kod" jest wymagane' });
  audyt.zapisz({
    uzytkownik: operator,
    akcja: akcjaZamkniecia,
    artykul_gt_id: String(artykul_gt_id),
    artykul_symbol: artykul_symbol ?? null,
    magazyn: 'K4',
    lokalizacja: lokalizacja_kod,
    wynik: 'zamkniete',
    po: notatka ? { notatka: String(notatka).slice(0, 500) } : null,
  });
  res.status(201).json({ zamkniete: true });
}

// GET /api/sciezki/ostatnie-sztuki - lista przystankow (towary K4 ze stanem 1..5, z lokalizacja
// K4), posortowana po kodzie lokalizacji = kolejnosc zbierania. Stan liczony wg reguly
// "WMS jest prawda tam gdzie istnieje, inaczej GT". Wyklucza:
//  - pary (artykul+lokalizacja) sprawdzone w ciagu DNI_POMIN_SPRAWDZONE dni,
//  - SKU z przyjeciem z zewnetrznego w ciagu DNI_POMIN_PRZYJECIE dni.
router.get('/ostatnie-sztuki', async (req, res, next) => {
  // WMS = master LOKALIZACJI: mowi, ktore SKU maja stale miejsce w K4 i jaki to kod.
  // ILOSC na K4 bierzemy zawsze z GT (Subiekt = master stanow), nie z kopii WMS.
  // 1 SKU = 1 lokalizacja K4, ale przejsciowo moze byc wiersz z ilosc=0 (zwolniona polka)
  // obok aktywnego - dedupujemy do jednego na SKU, preferujac ten z zapasem.
  const wmsWiersze = db.prepare(
    `SELECT s.artykul_gt_id, s.artykul_symbol AS symbol, s.artykul_nazwa AS nazwa,
            s.artykul_ean AS ean, s.ilosc AS wms_ilosc, l.kod AS lokalizacja_kod
     FROM stany_lokalizacji s JOIN lokalizacje l ON l.id = s.lokalizacja_id
     WHERE l.magazyn = 'K4'
     ORDER BY s.ilosc DESC`
  ).all();
  const wmsPoSku = new Map();
  for (const w of wmsWiersze) {
    if (!wmsPoSku.has(w.artykul_gt_id)) wmsPoSku.set(w.artykul_gt_id, w);
  }
  const wmsRows = [...wmsPoSku.values()];
  const wmsMa = new Set(wmsRows.map((r) => r.artykul_gt_id));

  let gtRows;
  try {
    gtRows = await pobierzK4NiskieStany({ min: STAN_MIN, max: STAN_MAX, maxRazem: RAZEM_MAX });
  } catch (err) {
    return res.status(503).json({ blad: 'Nie mozna pobrac stanow GT (baza niedostepna). Sprobuj ponownie.' });
  }

  // Dla SKU, ktore WMS zna (ma lokalizacje K4), stan K4 i "Razem" liczymy z GT na zywo.
  let stanyWmsMap = new Map();
  if (wmsRows.length) {
    try {
      stanyWmsMap = await pobierzStanyGt(wmsRows.map((w) => w.artykul_gt_id));
    } catch (err) {
      return res.status(503).json({ blad: 'Nie mozna pobrac stanow GT (baza niedostepna). Sprobuj ponownie.' });
    }
  }

  const kandydaci = [];
  // GT tylko dla towarow, ktorych WMS jeszcze nie zna (fallback) - juz z filtrem Razem<=RAZEM_MAX
  for (const g of gtRows) {
    if (!wmsMa.has(g.artykul_gt_id)) {
      kandydaci.push({ artykul_gt_id: g.artykul_gt_id, symbol: g.symbol, nazwa: g.nazwa,
        ean: g.ean, lokalizacja_kod: g.lokalizacja_kod, stan: g.stan_k4, rezerwacja: g.rez_k4 ?? 0, zrodlo: 'GT' });
    }
  }
  // WMS-known: lokalizacja z WMS, ale stan K4 i Razem (K4+K4G+MAG+LS) z GT. Bierzemy gdy
  // GT K4 w progu 1..5 i Razem <= RAZEM_MAX - dokladnie jak gałąź GT, tylko kod z WMS.
  for (const w of wmsRows) {
    const sg = stanyWmsMap.get(String(w.artykul_gt_id)) || {};
    const stanK4 = sg.K4?.ilosc ?? 0;
    const razem = sumaRazem(sg);   // z MAGAZYNY_RAZEM, nie z recznej listy - BRK ma wypadac
    if (stanK4 >= STAN_MIN && stanK4 <= STAN_MAX && razem <= RAZEM_MAX) {
      kandydaci.push({ artykul_gt_id: w.artykul_gt_id, symbol: w.symbol, nazwa: w.nazwa,
        ean: w.ean, lokalizacja_kod: w.lokalizacja_kod, stan: stanK4, rezerwacja: sg.K4?.rezerwacja ?? 0, zrodlo: 'GT' });
    }
  }

  // zbiory wykluczen z SQLite (jedno zapytanie na kazdy) - filtrujemy w Node
  const sprawdzone = new Set(db.prepare(
    `SELECT DISTINCT artykul_gt_id, lokalizacja FROM audyt
     WHERE akcja IN ('sprawdzenie_stanu','sprawdzenie_niezgodne','sprawdzenie_zamkniete')
       AND czas >= datetime('now', ?)`
  ).all(`-${DNI_POMIN_SPRAWDZONE} days`).map((r) => `${r.artykul_gt_id}|${r.lokalizacja}`));

  const przyjete = new Set(db.prepare(
    `SELECT DISTINCT artykul_gt_id FROM ruchy
     WHERE mag_zrodlo_zewnetrzny IS NOT NULL AND data_ruchu >= datetime('now', ?)`
  ).all(`-${DNI_POMIN_PRZYJECIE} days`).map((r) => r.artykul_gt_id));

  const pominiete = paryPominiete('sprawdzenie_pominiete');

  const przefiltrowane = kandydaci
    .filter((t) => !sprawdzone.has(`${t.artykul_gt_id}|${t.lokalizacja_kod}`) && !przyjete.has(t.artykul_gt_id)
      && !pominiete.has(`${t.artykul_gt_id}|${t.lokalizacja_kod}`))
    .sort((a, b) => (a.lokalizacja_kod || '').localeCompare(b.lokalizacja_kod || '')
      || (a.symbol || '').localeCompare(b.symbol || ''));

  // Oczekiwana POLKA = stan GT - strefy. Magazynier liczy regal, a nierozlozona dostawa albo
  // zwrot czekajacy w strefie leza gdzie indziej - bez tego odjecia lista mowilaby "3 szt.",
  // a na polce jest 1 (zob. zapiszSprawdzenie). Jedno zapytanie do GT na cala liste.
  // Gdy GT z dokumentami padnie, pokazujemy sam stan - lista dziala jak dotad.
  const pozycje = await dolaczOczekiwanaPolke(przefiltrowane);

  res.json({ pozycje, razem: pozycje.length });
});

// POST /api/sciezki/ostatnie-sztuki/sprawdzenie - zapisz wynik sprawdzenia jednego przystanku.
// Body: { artykul_gt_id, artykul_symbol, lokalizacja_kod, ilosc_policzona } - "kto" z sesji.
// Porownuje policzone z OCZEKIWANA POLKA (stan GT - strefy). NIE robi ruchu WMS.
router.post('/ostatnie-sztuki/sprawdzenie', (req, res) =>
  zapiszSprawdzenie(req, res, 'sprawdzenie_stanu', 'sprawdzenie_niezgodne'));

// GET /api/sciezki/ostatnie-sztuki/raport - otwarte niezgodnosci: pary (artykul+lokalizacja),
// dla ktorych NAJNOWSZE sprawdzenie to 'sprawdzenie_niezgodne' (nie domkniete pozniejszym
// zgodnym sprawdzeniem). Posortowane po kodzie lokalizacji = kolejnosc zbierania.
router.get('/ostatnie-sztuki/raport', (req, res, next) =>
  raportNiezgodnosci(res, 'sprawdzenie_stanu', 'sprawdzenie_niezgodne', 'sprawdzenie_zamkniete').catch(next));

// POST .../niezgodnosc/zamknij - reczne "Zalatwione" dla pary (artykul+lokalizacja).
router.post('/ostatnie-sztuki/niezgodnosc/zamknij', (req, res) =>
  zamknijNiezgodnosc(req, res, 'sprawdzenie_zamkniete'));

// POST /ostatnie-sztuki/pomin - "nie teraz": pozycja znika z obchodu na DNI_POMIN_POMINIETE dni.
router.post('/ostatnie-sztuki/pomin', (req, res) =>
  zapiszPominiecie(req, res, 'sprawdzenie_pominiete'));

// --- Sciezka 2: "K4 z pelna rezerwacja" - towary tylko w K4, caly stan zarezerwowany ---

// GET /api/sciezki/k4-rezerwacja - lista przystankow (GT: K4>0, rez>=stan, nic na K4G/MAG/LS),
// posortowana po lokalizacji. Wyklucza pary sprawdzone w ciagu DNI_POMIN_SPRAWDZONE dni
// (wlasne akcje 'sprawdzenie_rez*', niezalezne od "Ostatnich sztuk").
router.get('/k4-rezerwacja', async (req, res) => {
  let gtRows;
  try {
    gtRows = await pobierzK4PelnaRezerwacja();
  } catch (err) {
    return res.status(503).json({ blad: 'Nie mozna pobrac stanow GT (baza niedostepna). Sprobuj ponownie.' });
  }

  const sprawdzone = new Set(db.prepare(
    `SELECT DISTINCT artykul_gt_id, lokalizacja FROM audyt
     WHERE akcja IN ('sprawdzenie_rez','sprawdzenie_rez_niezgodne','sprawdzenie_rez_zamkniete')
       AND czas >= datetime('now', ?)`
  ).all(`-${DNI_POMIN_SPRAWDZONE} days`).map((r) => `${r.artykul_gt_id}|${r.lokalizacja}`));

  const pominiete = paryPominiete('sprawdzenie_rez_pominiete');

  const pozycje = gtRows
    .map((g) => ({ artykul_gt_id: g.artykul_gt_id, symbol: g.symbol, nazwa: g.nazwa,
      ean: g.ean, lokalizacja_kod: g.lokalizacja_kod, stan: g.stan_k4, rezerwacja: g.rez_k4, zrodlo: 'GT' }))
    .filter((t) => !sprawdzone.has(`${t.artykul_gt_id}|${t.lokalizacja_kod}`)
      && !pominiete.has(`${t.artykul_gt_id}|${t.lokalizacja_kod}`))
    .sort((a, b) => (a.lokalizacja_kod || '').localeCompare(b.lokalizacja_kod || '')
      || (a.symbol || '').localeCompare(b.symbol || ''));

  res.json({ pozycje, razem: pozycje.length });
});

router.post('/k4-rezerwacja/sprawdzenie', (req, res) =>
  zapiszSprawdzenie(req, res, 'sprawdzenie_rez', 'sprawdzenie_rez_niezgodne'));

router.get('/k4-rezerwacja/raport', (req, res, next) =>
  raportNiezgodnosci(res, 'sprawdzenie_rez', 'sprawdzenie_rez_niezgodne', 'sprawdzenie_rez_zamkniete').catch(next));

router.post('/k4-rezerwacja/niezgodnosc/zamknij', (req, res) =>
  zamknijNiezgodnosc(req, res, 'sprawdzenie_rez_zamkniete'));

router.post('/k4-rezerwacja/pomin', (req, res) =>
  zapiszPominiecie(req, res, 'sprawdzenie_rez_pominiete'));

// --- Sciezka 3: "Czysc zera" - zwalnianie slotow K4 po martwym towarze ---
//
// K4 to regal ZBIORU: slotow jest skonczenie wiele (~855) i kazdy zajety przez martwy
// towar to miejsce, ktorego nie dostanie towar rotujacy. Odkad lokalizacja K4 przezywa
// stan 0 (zob. CLAUDE.md, inwariant), zera same nie znikaja - ta sciezka jest zaworem.
//
// "Martwy" = stan GT na K4 zero I zapas zero, gdzie zapas = K4+K4G+LS (sumaZapasK4).
// Zera Z ZAPASEM celowo NIE wchodza: to robota dla Uzupelnien, ktore i tak je widza.
//
// MAG (Kajtek) NIE liczy sie do zapasu - decyzja usera 2026-07-19: towar lezacy w Kajtku
// nie wraca na K4 sam z siebie, wiec nie jest powodem, zeby blokowac slot na hali. To inne
// pytanie niz "Razem" na karcie produktu (tam MAG sie liczy) - stad osobna suma, nie filtr.
//
// Nie ma tu warunku "od X dni bez ruchu": u nas nie ma szybkorotujacego towaru z dostaw,
// wiec pusto na K4+K4G+LS znaczy pusto naprawde, a nie "chwilowo miedzy dostawami"
// (decyzja usera 2026-07-19). Przed omylkowym zwolnieniem chroni ponowne sprawdzenie
// stanu GT przy zatwierdzeniu i to, ze slot zwalnia czlowiek stojacy przy regale.

// GET /api/sciezki/czysc-zera - lista slotow K4 do zwolnienia, posortowana po kodzie
// lokalizacji = kolejnosc obchodu. Zrodlem zera jest GT (Subiekt = master stanow).
router.get('/czysc-zera', async (req, res) => {
  // WMS = master LOKALIZACJI: kazdy wiersz K4 to slot zajety przez SKU. Dwie roznice
  // wobec "Ostatnich sztuk":
  //  - NIE dedupujemy po SKU - gdy artykul trzyma dwa sloty, oba sa do zwolnienia,
  //  - NIE filtrujemy po s.ilosc - kopia WMS bywa stale-wysoka (sprzedaz w Subiekcie zbija
  //    stan bez wiedzy WMS), wiec o zerze decyduje wylacznie GT.
  const wmsRows = db.prepare(
    `SELECT s.artykul_gt_id, s.artykul_symbol AS symbol, s.artykul_nazwa AS nazwa,
            s.artykul_ean AS ean, s.ilosc AS wms_ilosc, l.kod AS lokalizacja_kod
     FROM stany_lokalizacji s JOIN lokalizacje l ON l.id = s.lokalizacja_id
     WHERE l.magazyn = 'K4'`
  ).all();
  if (!wmsRows.length) return res.json({ pozycje: [], razem: 0 });

  let stany;
  try {
    stany = await pobierzStanyGt(wmsRows.map((w) => w.artykul_gt_id));
  } catch (err) {
    return res.status(503).json({ blad: 'Nie mozna pobrac stanow GT (baza niedostepna). Sprobuj ponownie.' });
  }

  const sprawdzone = new Set(db.prepare(
    `SELECT DISTINCT artykul_gt_id, lokalizacja FROM audyt
     WHERE akcja IN ('zero_zwolnione','zero_niezgodne','zero_zamkniete')
       AND czas >= datetime('now', ?)`
  ).all(`-${DNI_POMIN_SPRAWDZONE} days`).map((r) => `${r.artykul_gt_id}|${r.lokalizacja}`));

  const pominiete = paryPominiete('zero_pominiete');

  const pozycje = wmsRows
    .map((w) => {
      const sg = stany.get(String(w.artykul_gt_id)) || {};
      // `razem` wystawiamy obok `zapas` tylko do pokazania czlowiekowi (ile jest w Kajtku,
      // skoro slot i tak zwalniamy). O wejsciu na liste decyduje WYLACZNIE `zapas`.
      return { ...w, stan: sg.K4?.ilosc ?? 0, zapas: sumaZapasK4(sg), razem: sumaRazem(sg), zrodlo: 'GT' };
    })
    .filter((t) => t.stan === 0 && t.zapas === 0)
    .filter((t) => !sprawdzone.has(`${t.artykul_gt_id}|${t.lokalizacja_kod}`)
      && !pominiete.has(`${t.artykul_gt_id}|${t.lokalizacja_kod}`))
    .sort((a, b) => (a.lokalizacja_kod || '').localeCompare(b.lokalizacja_kod || '')
      || (a.symbol || '').localeCompare(b.symbol || ''));

  res.json({ pozycje, razem: pozycje.length });
});

// POST /api/sciezki/czysc-zera/zwolnienie - potwierdzenie "pusto" na obchodzie.
// Body: { artykul_gt_id, artykul_symbol, lokalizacja_kod, ilosc_policzona } - "kto" z sesji.
//
// TO JEDYNE MIEJSCE W SYSTEMIE, GDZIE WOLNO SKASOWAC DOM K4. Inwariant "Lokalizacja K4
// przezywa stan 0" (CLAUDE.md) zabrania tego automatom, bo automat wnioskuje ze STANU, a
// stan zero znaczy "polka pusta", nie "towaru tu juz nie ma". Czlowiek stojacy przy regale
// ma dowod, ktorego automat nie ma - i tylko jego potwierdzenie zwalnia slot.
// Kto to czyta i chce "naprawic" spojnosc z inwariantem: nie, to jest ten wyjatek.
router.post('/czysc-zera/zwolnienie', async (req, res, next) => {
  const { artykul_gt_id, artykul_symbol, lokalizacja_kod, ilosc_policzona } = req.body ?? {};
  const operator = req.uzytkownik?.imie ?? null;   // z sesji, nie z body (zob. zapiszSprawdzenie)
  if (!artykul_gt_id) return res.status(400).json({ blad: 'Pole "artykul_gt_id" jest wymagane' });
  if (!lokalizacja_kod) return res.status(400).json({ blad: 'Pole "lokalizacja_kod" jest wymagane' });
  const policzone = Number(ilosc_policzona ?? 0);
  if (!Number.isFinite(policzone) || policzone < 0) {
    return res.status(400).json({ blad: 'Pole "ilosc_policzona" musi byc liczba >= 0' });
  }

  // Stan sprawdzamy PONOWNIE przy zatwierdzeniu, nie ufamy liscie: miedzy zbudowaniem
  // obchodu a dojsciem do regalu mogla przyjsc dostawa albo zwrot. Zwolnienie slotu jest
  // trudne do cofniecia (trzeba przypisac lokalizacje od nowa), wiec przy niedostepnym GT
  // wolimy 503 niz zgadywanie.
  let stanK4, zapas;
  try {
    const sg = (await pobierzStanyGt([artykul_gt_id])).get(String(artykul_gt_id)) || {};
    stanK4 = sg.K4?.ilosc ?? 0;
    zapas = sumaZapasK4(sg);   // K4+K4G+LS, bez MAG - ten sam rachunek co lista
  } catch (err) {
    return res.status(503).json({ blad: 'Nie mozna zweryfikowac stanu GT (baza niedostepna). Sprobuj ponownie.' });
  }

  // Niezgodnosc = cokolwiek przeczy "slot jest martwy": magazynier cos znalazl ALBO GT juz
  // nie pokazuje zera. Slotu NIE zwalniamy, zdarzenie idzie do raportu.
  if (policzone > 0 || stanK4 !== 0 || zapas !== 0) {
    audyt.zapisz({
      uzytkownik: operator,
      akcja: 'zero_niezgodne',
      artykul_gt_id: String(artykul_gt_id),
      artykul_symbol: artykul_symbol ?? null,
      magazyn: 'K4',
      lokalizacja: lokalizacja_kod,
      ilosc: policzone,
      wynik: 'niezgodne',
      przed: { stan: stanK4, zapas, zrodlo: 'GT' },
      po: { policzone },
    });
    return res.status(200).json({ zwolnione: false, stan: stanK4, zapas, policzone, zrodlo: 'GT' });
  }

  const wiersz = db.prepare(
    `SELECT s.id FROM stany_lokalizacji s JOIN lokalizacje l ON l.id = s.lokalizacja_id
     WHERE s.artykul_gt_id = ? AND l.magazyn = 'K4' AND l.kod = ?`
  ).get(String(artykul_gt_id), lokalizacja_kod);
  if (!wiersz) {
    return res.status(404).json({ blad: `Artykul nie ma juz wiersza WMS na lokalizacji ${lokalizacja_kod} (K4) - slot zwolniony wczesniej` });
  }

  db.prepare('DELETE FROM stany_lokalizacji WHERE id = ?').run(wiersz.id);

  audyt.zapisz({
    uzytkownik: operator,
    akcja: 'zero_zwolnione',
    artykul_gt_id: String(artykul_gt_id),
    artykul_symbol: artykul_symbol ?? null,
    magazyn: 'K4',
    lokalizacja: lokalizacja_kod,
    ilosc: 0,
    wynik: 'zwolnione',
    przed: { stan: stanK4, zapas, zrodlo: 'GT' },
  });

  // SKU stracilo (ten) dom w K4 - przeliczamy tw_Pole1. Gdy to byl jego OSTATNI wiersz K4,
  // obliczPolaLokalizacji zwroci "" i pole w GT sie wyczysci. To jedyne miejsce, w ktorym
  // takie wyczyszczenie jest zamierzone. Blad GT nie cofa zwolnienia (jak w DELETE /ruchy/:id) -
  // pole dosynchronizuje sie przy kolejnym ruchu; sygnalizujemy to w odpowiedzi.
  let lokSync = true;
  try {
    const wynik = await gtFields.synchronizujLokalizacje(String(artykul_gt_id), new Set(['K4']));
    if (wynik && !(wynik.ok && wynik.dane?.sukces)) lokSync = false;
  } catch (err) {
    lokSync = false;
  }

  res.status(201).json({ zwolnione: true, lokalizacja_kod, lok_sync: lokSync });
});

// GET /api/sciezki/czysc-zera/raport - otwarte niezgodnosci tej sciezki (cos lezalo na
// slocie, ktory GT uznaje za pusty - stan, o ktorym nikt nie wie).
router.get('/czysc-zera/raport', (req, res, next) =>
  raportNiezgodnosci(res, 'zero_zwolnione', 'zero_niezgodne', 'zero_zamkniete').catch(next));

router.post('/czysc-zera/niezgodnosc/zamknij', (req, res) =>
  zamknijNiezgodnosc(req, res, 'zero_zamkniete'));

router.post('/czysc-zera/pomin', (req, res) =>
  zapiszPominiecie(req, res, 'zero_pominiete'));

// --- Sciezka "Brak parametrow" (wymiary + waga) ---
//
// Inny GATUNEK sciezki niz pozostale: tu sie nie LICZY, tylko UZUPELNIA dane. Nie ma wiec
// "niezgodnosci" ani raportu - jest albo wpis, albo go nie ma. Zapis idzie przez
// PUT /api/produkty/:id/atrybuty (jedno miejsce walidacji), a nie przez wlasny endpoint;
// front przelacza sie na ekran Parametry (tryb 'parametry' w mapie SCIEZKI).
//
// Wymiary i waga w jednej liscie, bo magazynier trzyma towar w reku raz - zmierzy i zwazy
// za jednym podejsciem. Rozdzielenie oznaczaloby dwa obchody po ten sam towar.
router.get('/brak-parametrow', async (req, res) => {
  let kandydaci;
  try {
    kandydaci = await gtAtrybuty.pobierzBrakParametrow(LIMIT_BRAK_PARAMETROW);
  } catch (err) {
    return res.status(503).json({ blad: 'Nie mozna pobrac danych z GT (baza niedostepna). Sprobuj ponownie.' });
  }

  // WMS = master lokalizacji: dokladamy adres, zeby bylo wiadomo GDZIE isc. Bierzemy K4
  // ORAZ K4G - towary z najwiekszym zapasem (a wiec czolo listy) leza wlasnie na K4G, wiec
  // ograniczenie do K4 zostawialoby prawie cala liste bez adresu. K4 ma pierwszenstwo (dom
  // SKU), K4G jest fallbackiem.
  const lokalizacje = new Map();
  for (const r of db.prepare(
    `SELECT s.artykul_gt_id, l.magazyn, MIN(l.kod) AS kod
     FROM stany_lokalizacji s JOIN lokalizacje l ON l.id = s.lokalizacja_id
     WHERE l.magazyn IN ('K4', 'K4G')
     GROUP BY s.artykul_gt_id, l.magazyn`
  ).all()) {
    const biezaca = lokalizacje.get(r.artykul_gt_id);
    if (!biezaca || r.magazyn === 'K4') lokalizacje.set(r.artykul_gt_id, r.kod);
  }

  const pominiete = paryPominiete('parametry_pominiete');
  const pozycje = kandydaci
    // Adres: WMS ma pierwszenstwo (jest masterem lokalizacji), a gdy danego SKU nie zna -
    // kopia z pol wlasnych GT. Bez tego fallbacku obchod bylby prawie bezadresowy: WMS
    // trzyma lokalizacje tylko dla czesci asortymentu.
    .map((k) => ({ ...k, lokalizacja_kod: lokalizacje.get(k.artykul_gt_id) ?? k.lok_gt ?? null }))
    // Klucz musi byc sklejany DOKLADNIE tak jak w paryPominiete (`${id}|${lokalizacja}`),
    // lacznie z tym, ze null daje "null" - inaczej pominiecia towarow bez adresu K4
    // nigdy by sie nie dopasowaly i wracalyby na liste.
    .filter((k) => !pominiete.has(`${k.artykul_gt_id}|${k.lokalizacja_kod}`))
    // Kolejnosc obchodu, nie kolejnosc waznosci: sortujemy po kodzie lokalizacji jak
    // pozostale sciezki (GT dal nam liste posortowana po stanie - to byl tylko dobor
    // kandydatow do limitu). Towary bez adresu ida na koniec: da sie je zmierzyc, ale
    // nie da sie do nich celowo dojsc.
    .sort((a, b) => {
      if (!a.lokalizacja_kod) return b.lokalizacja_kod ? 1 : 0;
      if (!b.lokalizacja_kod) return -1;
      return a.lokalizacja_kod.localeCompare(b.lokalizacja_kod);
    });

  res.json({ pozycje, licznik: pozycje.length });
});

// Wlasny handler pominiecia, nie wspolny zapiszPominiecie: tam lokalizacja_kod jest
// WYMAGANA, a na tej sciezce towar moze lezec wylacznie na K4G i nie miec adresu w K4.
// Odrzucenie takiego pominiecia zablokowaloby przejscie dalej.
router.post('/brak-parametrow/pomin', (req, res) => {
  const { artykul_gt_id, artykul_symbol, lokalizacja_kod } = req.body ?? {};
  if (!artykul_gt_id) return res.status(400).json({ blad: 'Pole "artykul_gt_id" jest wymagane' });
  audyt.zapisz({
    uzytkownik: req.uzytkownik?.imie ?? null,
    akcja: 'parametry_pominiete',
    artykul_gt_id: String(artykul_gt_id),
    artykul_symbol: artykul_symbol ?? null,
    lokalizacja: lokalizacja_kod ?? null,
    wynik: 'pominiete',
  });
  res.status(201).json({ pominiete: true });
});

module.exports = router;
