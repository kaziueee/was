const express = require('express');
const db = require('../db/database');
const { pobierzProdukt, szukajProdukty, listujProdukty, pobierzProduktyZUniwersum, LIMIT_WYSZUKIWANIA, SORT_KLUCZE } = require('../services/gt-produkty');
const { pobierzStatusLokalizacjiGt, pobierzPrzegladLokalizacji, ZGODNOSC } = require('../services/gt-fields');
const { pobierzZkRezerwujaceK4, pobierzDostawyK4, rozbijStanK4, RODZAJE_STREF } = require('../services/gt-dokumenty');
const doRozlozenia = require('../services/do-rozlozenia');
const doSprawdzenia = require('./do-sprawdzenia');
const { MAGAZYNY } = require('../config/magazyny');

const router = express.Router();

const LIMIT_PRODUKTOW_DOMYSLNY = 50;
const LIMIT_PRODUKTOW_MAX = 200;

const KODY_MAGAZYNOW = new Set(MAGAZYNY.map((m) => m.kod));
const KODY_ZGODNOSCI = new Set(Object.values(ZGODNOSC));
// Kody filtra "Strefa": trzy strefy z dokumentem (RODZAJE_STREF - czwarty rodzaj pojawi sie
// sam) + 'nieznany_przychod'. NP to nie strefa (nie ma dokumentu), ale user traktuje go na
// filtrach jako czwarta pozycje obok stref, wiec jedzie tym samym parametrem ?strefa=.
const KODY_STREF = new Set([...Object.keys(RODZAJE_STREF), 'nieznany_przychod']);

// Dokleja do listy produktow rozbicie deficytu K4 na dostawy (PZ<-FZ) i anonimowa reszte -
// ten sam obraz, co dostaje Zebra z /api/lokalizacje/skan/:kod (zob. routes/lokalizacje.js),
// zeby rozklad w panelu i na kolektorze mowily to samo.
//
// Nie blokuje listy, gdy GT SQL padnie: bez dostaw panel dziala jak dotad (deficyt bez opisu).
async function dolaczDostawyK4(produkty, wierszeWms) {
  const sumaK4 = new Map();
  for (const w of wierszeWms) {
    if (w.magazyn !== 'K4') continue;
    sumaK4.set(w.artykul_gt_id, (sumaK4.get(w.artykul_gt_id) || 0) + w.ilosc);
  }

  // Warunek to STAN, nie deficyt - jak w routes/lokalizacje.js. Strefy zaleza od stanu GT,
  // wiec przy nieaktualnej kopii polki deficyt bywa <= 0, a zwrot dalej lezy w strefie.
  const zeStanem = produkty.filter((p) => (p.stany_gt?.K4?.ilosc ?? 0) > 0);
  if (zeStanem.length === 0) return;

  let dostawyMap;
  try {
    dostawyMap = await pobierzDostawyK4(zeStanem.map((p) => p.artykul_gt_id));
  } catch {
    return;
  }

  const suma = (kubelek) => kubelek.reduce((s, d) => s + d.ilosc, 0);

  for (const p of zeStanem) {
    const stanK4 = p.stany_gt?.K4?.ilosc ?? 0;
    const wmsK4 = sumaK4.get(p.artykul_gt_id) || 0;
    const rozbicie = rozbijStanK4(stanK4, wmsK4, dostawyMap.get(String(p.artykul_gt_id)) || [], { artykul_gt_id: p.artykul_gt_id });
    if (rozbicie.dostawy.length > 0) p.dostawy_k4 = rozbicie.dostawy;
    if (rozbicie.zwroty.length > 0) p.zwroty_k4 = rozbicie.zwroty;
    if (rozbicie.przywozki.length > 0) p.przywozki_k4 = rozbicie.przywozki;
    if (rozbicie.przyjecia.length > 0) p.przyjecia_k4 = rozbicie.przyjecia;
    p.nieprzypisane_k4 = rozbicie.reszta; // zawsze - obecnosc = sygnal "rozbicie sie udalo"
    p.polka_k4 = rozbicie.polka;
    p.polka_k4_klamie = rozbicie.polka_klamie;

    // Zwiezle podsumowanie strefy do kolumny "Strefa" (desktop): P/D/Z/PW + NP. Liczymy TU,
    // a nie na froncie, zeby definicja byla jedna i ta sama, co na ekranie "Do sprawdzenia".
    //
    // PW (przyjecie wewnetrzne) = przychod Z DOKUMENTEM (PW). To ono zajmuje "buty NP": dawny
    // anonimowy "nieznany przychod" ma teraz nazwe i numer PW (decyzja usera 2026-07-18).
    //
    // NP (nieznany przychod) zostaje tylko dla reszty rozbicia BEZ dokumentu, i TYLKO gdy WMS
    // zna miejsce SKU (wmsK4 > 0). W Subiekcie nie ma zmiany stanu bez dokumentu, wiec NP
    // powinno byc ~0; gdy > 0, to sygnal "cos spoza okna albo kopia sie starzeje - sprawdz".
    // Gdy WMS nie zna SKU (wmsK4 === 0), reszta to "do zlokalizowania" (backlog migracyjny),
    // nie strefa - i do tej kolumny nie wchodzi.
    const strefa = {
      P: suma(rozbicie.przywozki),
      D: suma(rozbicie.dostawy),
      Z: suma(rozbicie.zwroty),
      PW: suma(rozbicie.przyjecia),
      NP: wmsK4 > 0 ? rozbicie.reszta : 0,
    };
    if (strefa.P || strefa.D || strefa.Z || strefa.PW || strefa.NP) p.strefa_k4 = strefa;
  }
}

// Parsuje liste wartosci rozdzielonych przecinkami (np. "K4,K4G"), odfiltrowujac
// te spoza dozwolonego zbioru - uzywane dla filtrow magazyn/zgodnosc/strefa.
function parsujListe(wartosc, dozwolone) {
  if (!wartosc) return [];
  return String(wartosc).split(',').map((s) => s.trim()).filter((s) => dozwolone.has(s));
}

// Zbior tw_Id majacych NIEPUSTY kubelek ktorejkolwiek z wybranych stref - OR, jak przy
// magazynach (decyzja usera). Strefa nie jest kolumna w GT: to wynik rozbicia deficytu na
// dokumenty, wiec zbioru nie da sie policzyc w SQL-u obok stanow. Liczymy go w Node i
// podajemy do listujProdukty gotowa lista id (patrz `tylkoIdy`).
//
// Rachunek robi doRozlozenia.zbierz - TEN SAM, co listy zwrotow/dostaw i karta produktu.
// Wlasny licznik tutaj rozjechalby filtr z ekranami: filtr mowilby "12 SKU", a po wejsciu
// w produkt bylo 8 (zob. komentarz na gorze services/do-rozlozenia.js).
//
// Koszt: para zapytan do GT na kazda zaznaczona strefe. Filtr jest uzywany okazjonalnie,
// a kandydaci to setki SKU (okno 90 dni na dostawy, 14 na zwroty/przywozki), nie caly katalog.
async function idyZeStrefami(strefy) {
  const zbiory = await Promise.all(strefy.map(async (rodzaj) => {
    // NP idzie innym torem niz strefy: nie ma dokumentu, wiec nie ma zapytania odwrotnego.
    // Bierzemy go z tego samego zrodla, co ekran "Do sprawdzenia" (zbierz + predykat), zeby
    // filtr i ekran nie mogly sie rozjechac. Koszt: ~800 ms, ale filtr jest okazjonalny.
    if (rodzaj === 'nieznany_przychod') {
      const pozycje = (await doSprawdzenia.zbierz()).filter(doSprawdzenia.RODZAJE.nieznany_przychod);
      return pozycje.map((p) => p.artykul_gt_id);
    }
    const { kubelek, kandydaci } = RODZAJE_STREF[rodzaj];
    const pozycje = await doRozlozenia.zbierz(await kandydaci(), kubelek);
    return pozycje.map((p) => p.artykul_gt_id);
  }));
  return [...new Set(zbiory.flat())];
}

// GET /api/produkty - paginowana lista wszystkich towarow z GT do tabeli
// kontrolnej "Produkty" (desktop): stany GT, lokalizacje WMS i zgodnosc
// GT<->WMS pol wlasnych. q opcjonalne (puste = caly katalog GT, sort wg SKU).
//
// Dwa tryby:
// - "katalog" (domyslny) - paginacja/sortowanie/filtrowanie magazynowe po
//   stronie SQL na calym katalogu GT (zob. listujProdukty).
// - "zbior_wms" (gdy filtr zgodnosc aktywny) - operuje na ograniczonym
//   "zbiorze WMS" (~2300-2400 towarow), filtruje/sortuje/paginuje w Node
//   (zob. pobierzProduktyZUniwersum) - bo Zgodnosc wymaga krzyzowania danych
//   WMS+GT dla kazdego produktu, co dla calego katalogu byloby bez sensu.
//
// Bledy polaczenia z GT propagujemy jako 500 - ta tabela jest GT-centryczna,
// w odroznieniu od ekranow Zebry nie ma sensu "degradowac" bez danych z GT.
router.get('/', async (req, res, next) => {
  try {
    const q = req.query.q;
    const limit = Math.min(Math.max(Number(req.query.limit) || LIMIT_PRODUKTOW_DOMYSLNY, 1), LIMIT_PRODUKTOW_MAX);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const sort = SORT_KLUCZE.includes(req.query.sort) ? req.query.sort : 'sku';
    const dir = req.query.dir === 'desc' ? 'desc' : 'asc';
    const magazyny = parsujListe(req.query.magazyn, KODY_MAGAZYNOW);
    const zgodnosc = parsujListe(req.query.zgodnosc, KODY_ZGODNOSCI);
    // OF (OBCIETE) = sumy WMS/GT zgodne, tylko pole GT za krotkie na wszystkie lokalizacje -
    // to NIE blad, wiec filtr "OK" ma pokazywac tez OF (spojnie z badge-ok na liscie/modalu).
    if (zgodnosc.includes(ZGODNOSC.ZGODNE) && !zgodnosc.includes(ZGODNOSC.OBCIETE)) {
      zgodnosc.push(ZGODNOSC.OBCIETE);
    }
    const zRezerwacja = req.query.z_rezerwacja === '1';
    const pokazZablokowane = req.query.pokaz_zablokowane === '1';
    const strefy = parsujListe(req.query.strefa, KODY_STREF);

    // null = brak filtru stref; TABLICA (takze pusta) = filtr aktywny. Pusta tablica musi dac
    // 0 wynikow, nie "wszystko" - stad rozroznienie zamiast samego sprawdzania dlugosci.
    const tylkoIdy = strefy.length > 0 ? await idyZeStrefami(strefy) : null;

    let lista, total, tryb;
    if (zgodnosc.length > 0) {
      ({ produkty: lista, total } = await pobierzProduktyZUniwersum({ q, limit, offset, sort, dir, magazyny, zgodnosc, zRezerwacja, pokazZablokowane, tylkoIdy }));
      tryb = 'zbior_wms';
    } else {
      ({ produkty: lista, total } = await listujProdukty({ q, limit, offset, sort, dir, magazyny, zRezerwacja, pokazZablokowane, tylkoIdy }));
      tryb = 'katalog';
    }

    if (lista.length === 0) {
      return res.json({ produkty: [], total, limit, offset, tryb });
    }

    const ids = lista.map((p) => p.artykul_gt_id);
    const placeholders = ids.map(() => '?').join(', ');
    const wiersze = db.prepare(`
      SELECT s.artykul_gt_id, l.kod, l.magazyn, s.ilosc
      FROM stany_lokalizacji s
      JOIN lokalizacje l ON l.id = s.lokalizacja_id
      WHERE s.artykul_gt_id IN (${placeholders}) AND s.ilosc > 0
    `).all(...ids);

    const wmsK4Map = new Map();
    const wmsK4gMap = new Map();
    for (const w of wiersze) {
      if (w.magazyn === 'K4') {
        wmsK4Map.set(w.artykul_gt_id, { kod: w.kod, ilosc: w.ilosc });
      } else if (w.magazyn === 'K4G') {
        if (!wmsK4gMap.has(w.artykul_gt_id)) wmsK4gMap.set(w.artykul_gt_id, []);
        wmsK4gMap.get(w.artykul_gt_id).push({ kod: w.kod, ilosc: w.ilosc });
      }
    }

    let produkty;
    if (tryb === 'katalog') {
      const przeglad = await pobierzPrzegladLokalizacji(ids);
      produkty = lista.map((p) => {
        const wmsK4g = wmsK4gMap.get(p.artykul_gt_id) || [];
        const zg = przeglad.get(p.artykul_gt_id);
        return {
          ...p,
          wms_k4: wmsK4Map.get(p.artykul_gt_id) || null,
          wms_k4g: wmsK4g,
          k4g_razem: wmsK4g.reduce((suma, l) => suma + l.ilosc, 0),
          lokalizacja_k4_gt: zg.k4.gt_tekst,
          lokalizacja_k4g_gt: zg.k4g.gt_tekst,
          zgodnosc: { k4: zg.k4.stan, k4g: zg.k4g.stan, ogolna: zg.ogolna },
        };
      });
    } else {
      produkty = lista.map((p) => {
        const wmsK4g = wmsK4gMap.get(p.artykul_gt_id) || [];
        return {
          ...p,
          wms_k4: wmsK4Map.get(p.artykul_gt_id) || null,
          wms_k4g: wmsK4g,
          k4g_razem: wmsK4g.reduce((suma, l) => suma + l.ilosc, 0),
        };
      });
    }

    await dolaczDostawyK4(produkty, wiersze);

    res.json({ produkty, total, limit, offset, tryb });
  } catch (err) {
    next(err);
  }
});

// Dolacza do produktow lokalizacja_gt: {tekst, zgodna} wg pol wlasnych GT
// (zob. services/gt-fields.js) - wspolne ze "stany_gt" pole karty produktu
// (public/zebra/karta-produktu.js). W razie bledu polaczenia z GT zwraca
// produkty bez zmian - niedostepnosc GT nie blokuje wyszukiwania.
async function dolaczLokalizacjeGt(produkty) {
  try {
    const status = await pobierzStatusLokalizacjiGt(produkty.map((p) => p.artykul_gt_id));
    return produkty.map((p) => ({ ...p, lokalizacja_gt: status.get(String(p.artykul_gt_id)) }));
  } catch (err) {
    return produkty;
  }
}

// GET /api/produkty/:artykulGtId/rezerwacje - otwarte ZK rezerwujace towar na K4
// (podglad "z czego wynika rezerwacja", lazy-load z karty towaru na Zebrze).
// Zawsze przez GT SQL - gdy baza niedostepna zwracamy 503 (jak inne ekrany GT-only).
// Dwuczlonowa sciezka, wiec nie koliduje z catch-all /:identyfikator ponizej.
router.get('/:artykulGtId/rezerwacje', async (req, res, next) => {
  const artykulGtId = Number(req.params.artykulGtId);
  if (!Number.isInteger(artykulGtId) || artykulGtId <= 0) {
    return res.status(400).json({ blad: 'Nieprawidłowy identyfikator towaru' });
  }
  try {
    const zk = await pobierzZkRezerwujaceK4(artykulGtId);
    res.json({ zk, suma: zk.reduce((s, r) => s + r.ilosc, 0) });
  } catch (err) {
    res.status(503).json({ blad: 'GT niedostępny — nie można odczytać rezerwacji ZK' });
  }
});

// GET /api/produkty/:identyfikator - szuka towaru w GT po symbolu lub EAN (1:1, do skanow).
// Jesli nie znaleziono dokladnego dopasowania, szuka po fragmencie nazwy/symbolu
// (wyszukiwanie reczne, gdy magazynier nie ma kodu kreskowego).
router.get('/:identyfikator', async (req, res, next) => {
  try {
    const identyfikator = req.params.identyfikator;

    const produkt = await pobierzProdukt(identyfikator);
    if (produkt) {
      const [wzbogacony] = await dolaczLokalizacjeGt([produkt]);
      return res.json(wzbogacony);
    }

    if (identyfikator.length >= 3) {
      const wyniki = await szukajProdukty(identyfikator);
      if (wyniki.length === 1) {
        const [wzbogacony] = await dolaczLokalizacjeGt(wyniki);
        return res.json(wzbogacony);
      }
      if (wyniki.length > 1) {
        const wzbogacone = await dolaczLokalizacjeGt(wyniki);
        return res.json({ wyniki: wzbogacone, obciete: wyniki.length >= LIMIT_WYSZUKIWANIA });
      }
    }

    res.status(404).json({ blad: 'Nie znaleziono towaru w GT o podanym symbolu/EAN/nazwie' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
