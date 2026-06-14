'use strict';

// Odczyt danych o towarach bezposrednio z bazy GT (SQL Server) - wyszukiwanie
// po symbolu/EAN, np. do uzupelnienia kartoteki WMS przy lokalizowaniu/MM, oraz
// paginowana lista do tabeli kontrolnej "Produkty" (desktop).
// Polaczenie tylko do odczytu, patrz services/gt-sql.js.

const { query, naCzesci } = require('./gt-sql');
const db = require('../db/database');
const { MAGAZYNY } = require('../config/magazyny');
const { escapeLike, podzielNaSlowa, LIMIT_WYSZUKIWANIA } = require('./wyszukiwanie');
const { pobierzPrzegladLokalizacji } = require('./gt-fields');

// buduje stany_gt w stalej kolejnosci K4, K4G, MAG, LS - kazdy magazyn ma
// ilosc i rezerwacje (0, jesli towar nie ma wiersza w tw_Stan dla magazynu)
function budujStanyGt(wpisyStanow) {
  const stany_gt = {};
  for (const m of MAGAZYNY) {
    const wpis = wpisyStanow.get(m.kod);
    stany_gt[m.kod] = {
      ilosc: wpis ? wpis.st_Stan : 0,
      rezerwacja: wpis ? wpis.st_StanRez : 0,
    };
  }
  return stany_gt;
}

// Szuka towaru po dokladnym symbolu lub EAN. Zwraca null, jesli nie znaleziono.
async function pobierzProdukt(identyfikator) {
  const towary = await query(`
    SELECT TOP 1 tw_Id, tw_Symbol, tw_Nazwa, tw_PodstKodKresk
    FROM tw__Towar
    WHERE tw_Symbol = @id OR tw_PodstKodKresk = @id
  `, { id: identyfikator });

  const towar = towary.recordset[0];
  if (!towar) return null;

  const stanyMap = await pobierzStanyGt([towar.tw_Id]);

  return {
    artykul_gt_id: String(towar.tw_Id),
    symbol: towar.tw_Symbol,
    nazwa: towar.tw_Nazwa,
    ean: towar.tw_PodstKodKresk || null,
    stany_gt: stanyMap.get(String(towar.tw_Id)),
  };
}

// Pobiera stany GT (tw_Stan) dla listy tw_Id - jedno zapytanie zbiorcze.
// Zwraca Map<tw_Id jako string, stanyGt> (zob. budujStanyGt) - dla id
// nienumerycznych (np. "GT-100" z lokalnych danych testowych WMS) lub
// nieznalezionych w GT zwraca stanyGt z samymi zerami, wiec kazdy wejsciowy
// id ma zawsze wpis w mapie wynikowej.
async function pobierzStanyGt(artykulGtIds) {
  const wynik = new Map();
  const idyNumeryczne = [];
  for (const id of new Set(artykulGtIds.map(String))) {
    const n = Number(id);
    if (Number.isInteger(n)) idyNumeryczne.push(n);
    else wynik.set(id, budujStanyGt(new Map()));
  }

  if (idyNumeryczne.length === 0) return wynik;

  const stanyPoTowarze = new Map();
  await Promise.all(naCzesci(idyNumeryczne, 1000).map(async (paczka) => {
    const parametry = {};
    const warunkiTowarow = paczka.map((id, i) => {
      parametry[`tow${i}`] = id;
      return `@tow${i}`;
    }).join(', ');
    const warunkiMagazynow = MAGAZYNY.map((m, i) => {
      parametry[`mag${i}`] = m.kod;
      return `@mag${i}`;
    }).join(', ');

    const stany = await query(`
      SELECT s.st_TowId, m.mag_Symbol, s.st_Stan, s.st_StanRez
      FROM tw_Stan s
      JOIN sl_Magazyn m ON m.mag_Id = s.st_MagId
      WHERE s.st_TowId IN (${warunkiTowarow}) AND m.mag_Symbol IN (${warunkiMagazynow})
    `, parametry);

    for (const row of stany.recordset) {
      if (!stanyPoTowarze.has(row.st_TowId)) stanyPoTowarze.set(row.st_TowId, new Map());
      stanyPoTowarze.get(row.st_TowId).set(row.mag_Symbol, row);
    }
  }));

  for (const id of idyNumeryczne) {
    wynik.set(String(id), budujStanyGt(stanyPoTowarze.get(id) || new Map()));
  }
  return wynik;
}

// Szuka towarow po pelnych slowach/ich poczatkach z nazwy lub po symbolu -
// wyszukiwanie reczne, gdy magazynier nie ma kodu kreskowego i zna tylko
// czesc nazwy. Kazde slowo z frazy musi pasowac do poczatku nazwy albo
// poczatku jakiegos wyrazu w nazwie (w dowolnej kolejnosci), wiec np.
// "Nerf Echo" znajdzie tez "Nerf N-Strike Elite Echo".
async function szukajProdukty(fraza, limit = LIMIT_WYSZUKIWANIA) {
  const slowa = podzielNaSlowa(fraza);
  if (slowa.length === 0) return [];

  const parametry = { limit };
  const warunkiSlow = slowa.map((slowo, i) => {
    parametry[`prefiks${i}`] = `${slowo}%`;
    parametry[`wSrodku${i}`] = `% ${slowo}%`;
    return `(tw_Nazwa LIKE @prefiks${i} ESCAPE '\\' OR tw_Nazwa LIKE @wSrodku${i} ESCAPE '\\')`;
  }).join(' AND ');

  parametry.symbolFraza = `${escapeLike(fraza.trim())}%`;

  const towary = await query(`
    SELECT TOP (@limit) tw_Id, tw_Symbol, tw_Nazwa, tw_PodstKodKresk
    FROM tw__Towar
    WHERE tw_Symbol LIKE @symbolFraza ESCAPE '\\'
       OR (${warunkiSlow})
    ORDER BY
      CASE WHEN tw_Nazwa LIKE @prefiks0 ESCAPE '\\' THEN 0 ELSE 1 END,
      tw_Nazwa
  `, parametry);

  const lista = towary.recordset;
  if (lista.length === 0) return [];

  const stanyMap = await pobierzStanyGt(lista.map((t) => t.tw_Id));

  const wyniki = lista.map((t) => ({
    artykul_gt_id: String(t.tw_Id),
    symbol: t.tw_Symbol,
    nazwa: t.tw_Nazwa,
    ean: t.tw_PodstKodKresk || null,
    stany_gt: stanyMap.get(String(t.tw_Id)),
  }));

  // produkty z najwiekszym lacznym stanem na gorze, reszta zachowuje
  // kolejnosc trafnosci/alfabetyczna z zapytania (sort jest stabilny)
  wyniki.sort((a, b) => sumaStanow(b.stany_gt) - sumaStanow(a.stany_gt));

  return wyniki;
}

function sumaStanow(stanyGt) {
  return Object.values(stanyGt).reduce((suma, w) => suma + w.ilosc, 0);
}

// === Sortowanie/agregacja dla listujProdukty i pobierzProduktyZUniwersum ===

// Wyrazenie SQL sumujace stan (st_Stan) dla danego magazynu w obrebie GROUP BY
// po tw_Id - uzywane w SELECT/HAVING/ORDER BY zapytania agregujacego.
function wyrazenieStanu(kodMagazynu) {
  return `COALESCE(SUM(CASE WHEN m.mag_Symbol = '${kodMagazynu}' THEN s.st_Stan END), 0)`;
}

// Jak wyzej, ale dla rezerwacji (st_StanRez) - uzywane w HAVING filtra
// "tylko z rezerwacja".
function wyrazenieRez(kodMagazynu) {
  return `COALESCE(SUM(CASE WHEN m.mag_Symbol = '${kodMagazynu}' THEN s.st_StanRez END), 0)`;
}

// Dozwolone klucze sortowania (i HAVING dla magazynow) - wspolne dla trybu
// katalogowego (SQL) i trybu "zbior WMS" (Node, zob. wartoscSortowania).
const SORT_WYRAZENIA = {
  sku: 't.tw_Symbol',
  nazwa: 't.tw_Nazwa',
  ean: 't.tw_PodstKodKresk',
  razem: `(${MAGAZYNY.map((m) => wyrazenieStanu(m.kod)).join(' + ')})`,
  k4: wyrazenieStanu('K4'),
  k4g: wyrazenieStanu('K4G'),
  mag: wyrazenieStanu('MAG'),
  ls: wyrazenieStanu('LS'),
};
const SORT_KLUCZE = Object.keys(SORT_WYRAZENIA);
const MAGAZYNY_WYRAZENIA = { K4: SORT_WYRAZENIA.k4, K4G: SORT_WYRAZENIA.k4g, MAG: SORT_WYRAZENIA.mag, LS: SORT_WYRAZENIA.ls };
const REZ_WYRAZENIA = Object.fromEntries(MAGAZYNY.map((m) => [m.kod, wyrazenieRez(m.kod)]));

// Wartosc danego "klucza sortowania" dla produktu zlozonego w JS - uzywane w
// trybie "zbior WMS" (pobierzProduktyZUniwersum), gdzie sortowanie/filtrowanie
// dzieje sie w Node, a nie w SQL.
function wartoscSortowania(p, klucz) {
  switch (klucz) {
    case 'sku': return p.symbol;
    case 'nazwa': return p.nazwa;
    case 'ean': return p.ean || '';
    case 'razem': return p.razem;
    case 'k4': return p.stany_gt.K4.ilosc;
    case 'k4g': return p.stany_gt.K4G.ilosc;
    case 'mag': return p.stany_gt.MAG.ilosc;
    case 'ls': return p.stany_gt.LS.ilosc;
    default: return p.symbol;
  }
}

// Mapuje wiersz wyniku zapytania agregujacego (kolumny stan_k4/rez_k4/...) na
// stany_gt w ksztalcie budujStanyGt.
function stanyGtZWiersza(row) {
  const stany_gt = {};
  for (const m of MAGAZYNY) {
    const k = m.kod.toLowerCase();
    stany_gt[m.kod] = { ilosc: row[`stan_${k}`], rezerwacja: row[`rez_${k}`] };
  }
  return stany_gt;
}

// Paginowana lista towarow z GT - do tabeli kontrolnej "Produkty" (desktop).
// q opcjonalne: puste = caly katalog, niepuste = dopasowanie po prefiksie
// symbolu/EAN albo po slowach z nazwy (jak szukajProdukty). Stany per magazyn
// (K4/K4G/MAG/LS) i "razem" liczone w jednym zapytaniu agregujacym (JOIN
// tw_Stan/sl_Magazyn + GROUP BY) - bez osobnego wywolania pobierzStanyGt.
// sort/dir - kolumna i kierunek sortowania (zob. SORT_KLUCZE). magazyny -
// filtr "produkt ma stan > 0 w ktoryms z wybranych magazynow" (HAVING).
// pokazZablokowane - jesli false (domyslnie), wyklucza tw_Zablokowany=1
// (stare/wylaczone produkty).
// Zwraca {produkty, total} - total to liczba wszystkich wynikow (bez limitu),
// do wyswietlenia "X-Y z Z" i obliczenia czy jest nastepna strona.
async function listujProdukty({ q, limit = 50, offset = 0, sort = 'sku', dir = 'asc', magazyny = [], zRezerwacja = false, pokazZablokowane = false } = {}) {
  const parametry = { limit, offset };
  let where = '1=1';

  const fraza = (q ?? '').trim();
  if (fraza) {
    const slowa = podzielNaSlowa(fraza);
    const warunkiSlow = slowa.map((slowo, i) => {
      parametry[`prefiks${i}`] = `${slowo}%`;
      parametry[`wSrodku${i}`] = `% ${slowo}%`;
      return `(t.tw_Nazwa LIKE @prefiks${i} ESCAPE '\\' OR t.tw_Nazwa LIKE @wSrodku${i} ESCAPE '\\')`;
    }).join(' AND ');
    parametry.symbolFraza = `${escapeLike(fraza)}%`;
    parametry.eanFraza = `${escapeLike(fraza)}%`;
    where = `(t.tw_Symbol LIKE @symbolFraza ESCAPE '\\' OR t.tw_PodstKodKresk LIKE @eanFraza ESCAPE '\\' OR (${warunkiSlow}))`;
  }

  if (!pokazZablokowane) {
    where += ' AND t.tw_Zablokowany = 0';
  }

  // Filtr magazynowy (stan > 0) i "z rezerwacja" (st_StanRez > 0) lacza sie przez
  // AND; oba w obrebie wybranych magazynow (lub wszystkich, gdy filtr magazynu pusty).
  const warunkiHaving = [];
  if (magazyny.length > 0) {
    warunkiHaving.push(`(${magazyny.map((m) => `${MAGAZYNY_WYRAZENIA[m]} > 0`).join(' OR ')})`);
  }
  if (zRezerwacja) {
    const kody = magazyny.length > 0 ? magazyny : MAGAZYNY.map((m) => m.kod);
    warunkiHaving.push(`(${kody.map((m) => `${REZ_WYRAZENIA[m]} > 0`).join(' OR ')})`);
  }
  const having = warunkiHaving.length > 0 ? `HAVING ${warunkiHaving.join(' AND ')}` : '';

  const wyrazenieSort = SORT_WYRAZENIA[sort];
  const kierunek = dir === 'desc' ? 'DESC' : 'ASC';

  const polaczenie = `
    FROM tw__Towar t
    LEFT JOIN tw_Stan s ON s.st_TowId = t.tw_Id
    LEFT JOIN sl_Magazyn m ON m.mag_Id = s.st_MagId
    WHERE ${where}
  `;

  const { recordset: [{ total }] } = await query(`
    SELECT COUNT(*) AS total FROM (
      SELECT t.tw_Id ${polaczenie}
      GROUP BY t.tw_Id
      ${having}
    ) x
  `, parametry);

  const { recordset: lista } = await query(`
    SELECT
      t.tw_Id, t.tw_Symbol, t.tw_Nazwa, t.tw_PodstKodKresk,
      COALESCE(SUM(CASE WHEN m.mag_Symbol = 'K4'  THEN s.st_Stan    END), 0) AS stan_k4,
      COALESCE(SUM(CASE WHEN m.mag_Symbol = 'K4'  THEN s.st_StanRez END), 0) AS rez_k4,
      COALESCE(SUM(CASE WHEN m.mag_Symbol = 'K4G' THEN s.st_Stan    END), 0) AS stan_k4g,
      COALESCE(SUM(CASE WHEN m.mag_Symbol = 'K4G' THEN s.st_StanRez END), 0) AS rez_k4g,
      COALESCE(SUM(CASE WHEN m.mag_Symbol = 'MAG' THEN s.st_Stan    END), 0) AS stan_mag,
      COALESCE(SUM(CASE WHEN m.mag_Symbol = 'MAG' THEN s.st_StanRez END), 0) AS rez_mag,
      COALESCE(SUM(CASE WHEN m.mag_Symbol = 'LS'  THEN s.st_Stan    END), 0) AS stan_ls,
      COALESCE(SUM(CASE WHEN m.mag_Symbol = 'LS'  THEN s.st_StanRez END), 0) AS rez_ls
    ${polaczenie}
    GROUP BY t.tw_Id, t.tw_Symbol, t.tw_Nazwa, t.tw_PodstKodKresk
    ${having}
    ORDER BY ${wyrazenieSort} ${kierunek}, t.tw_Id ASC
    OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
  `, parametry);

  const produkty = lista.map((row) => {
    const stany_gt = stanyGtZWiersza(row);
    return {
      artykul_gt_id: String(row.tw_Id),
      symbol: row.tw_Symbol,
      nazwa: row.tw_Nazwa,
      ean: row.tw_PodstKodKresk || null,
      stany_gt,
      razem: Object.values(stany_gt).reduce((suma, w) => suma + w.ilosc, 0),
    };
  });

  return { produkty, total };
}

// Zbior artykulow relevantnych dla Zgodnosci K4/K4G: te, ktore maja stan > 0
// w K4 lub K4G w GT (aktywne, chyba ze pokazZablokowane), w unii z tymi, ktore
// WMS juz ma w SQLite (stany_lokalizacji) - np. towar bez aktualnego stanu w
// GT, ale z historia lokalizacji w WMS. Zwraca tablice id (string), ~2300-2400
// pozycji w praktyce - uzywane jako baza dla pobierzProduktyZUniwersum.
async function pobierzZbiorWmsIds({ pokazZablokowane = false } = {}) {
  let where = `((m.mag_Symbol = 'K4' AND s.st_Stan > 0) OR (m.mag_Symbol = 'K4G' AND s.st_Stan > 0))`;
  if (!pokazZablokowane) where = `t.tw_Zablokowany = 0 AND (${where})`;

  const { recordset } = await query(`
    SELECT DISTINCT t.tw_Id
    FROM tw__Towar t
    JOIN tw_Stan s ON s.st_TowId = t.tw_Id
    JOIN sl_Magazyn m ON m.mag_Id = s.st_MagId
    WHERE ${where}
  `);
  const zGt = recordset.map((r) => String(r.tw_Id));

  const zWms = db.prepare('SELECT DISTINCT artykul_gt_id FROM stany_lokalizacji')
    .all().map((r) => r.artykul_gt_id);

  return [...new Set([...zGt, ...zWms])];
}

// Podstawowe dane (symbol/nazwa/ean/tw_Zablokowany) dla listy id z GT,
// chunkowane po 1000 (zob. naCzesci) - zbior WMS moze przekroczyc limit
// parametrow SQL Server. Zwraca Map<tw_Id jako string, wiersz tw__Towar>.
async function pobierzPodstawoweInfo(ids) {
  const idyNum = [...new Set(ids.map(Number).filter(Number.isInteger))];
  const wynik = new Map();
  await Promise.all(naCzesci(idyNum, 1000).map(async (paczka) => {
    const parametry = {};
    const warunki = paczka.map((id, i) => {
      parametry[`id${i}`] = id;
      return `@id${i}`;
    }).join(', ');
    const { recordset } = await query(
      `SELECT tw_Id, tw_Symbol, tw_Nazwa, tw_PodstKodKresk, tw_Zablokowany FROM tw__Towar WHERE tw_Id IN (${warunki})`,
      parametry
    );
    for (const r of recordset) wynik.set(String(r.tw_Id), r);
  }));
  return wynik;
}

// Tryb "zbior WMS" - uzywany gdy filtr Zgodnosc jest aktywny. Zamiast
// paginowac caly katalog GT, ogranicza sie do "zbioru WMS" (zob.
// pobierzZbiorWmsIds), liczy Zgodnosc dla kazdego artykulu, filtruje,
// sortuje i paginuje w Node. q dziala jako substring (case-insensitive) na
// symbol/nazwa/ean - zbior jest maly, w przeciwienstwie do listujProdukty
// (prefiksowe LIKE na calym katalogu).
//
// Filtr magazyny: produkt zostaje, jesli ma stan > 0 w ktoryms z wybranych
// magazynow (K4/K4G/MAG/LS). Filtr zgodnosc dziala na polu k4/k4g/ogolna -
// ktore pole zalezy od wyboru K4/K4G w magazynach (K4 bez K4G -> k4, K4G bez
// K4 -> k4g, inaczej -> ogolna). Kombinacje dajace zero wynikow (np.
// magazyny=['LS'] + zgodnosc=['NZ']) zwracaja po prostu pusta liste - bez
// specjalnej obslugi, tak jak ustalono (brak automatycznych blokad UI).
async function pobierzProduktyZUniwersum({ q, limit, offset, sort, dir, magazyny, zgodnosc, zRezerwacja, pokazZablokowane }) {
  const ids = await pobierzZbiorWmsIds({ pokazZablokowane });
  if (ids.length === 0) return { produkty: [], total: 0 };

  const [podstawoweMap, stanyMap, przegladMap] = await Promise.all([
    pobierzPodstawoweInfo(ids),
    pobierzStanyGt(ids),
    pobierzPrzegladLokalizacji(ids),
  ]);

  let produkty = ids
    .filter((id) => {
      const info = podstawoweMap.get(id);
      return info && (pokazZablokowane || !info.tw_Zablokowany);
    })
    .map((id) => {
      const info = podstawoweMap.get(id);
      const stany_gt = stanyMap.get(id);
      const zg = przegladMap.get(id);
      return {
        artykul_gt_id: id,
        symbol: info.tw_Symbol,
        nazwa: info.tw_Nazwa,
        ean: info.tw_PodstKodKresk || null,
        stany_gt,
        razem: Object.values(stany_gt).reduce((suma, w) => suma + w.ilosc, 0),
        zgodnosc: { k4: zg.k4.stan, k4g: zg.k4g.stan, ogolna: zg.ogolna },
        lokalizacja_k4_gt: zg.k4.gt_tekst,
        lokalizacja_k4g_gt: zg.k4g.gt_tekst,
      };
    });

  if (q) {
    const fraza = q.trim().toLowerCase();
    produkty = produkty.filter((p) =>
      p.symbol.toLowerCase().includes(fraza)
      || p.nazwa.toLowerCase().includes(fraza)
      || (p.ean && p.ean.toLowerCase().includes(fraza))
    );
  }

  if (magazyny.length > 0) {
    produkty = produkty.filter((p) => magazyny.some((m) => p.stany_gt[m].ilosc > 0));
  }

  if (zRezerwacja) {
    const kody = magazyny.length > 0 ? magazyny : MAGAZYNY.map((m) => m.kod);
    produkty = produkty.filter((p) => kody.some((m) => p.stany_gt[m].rezerwacja > 0));
  }

  if (zgodnosc.length > 0) {
    const maK4 = magazyny.includes('K4');
    const maK4G = magazyny.includes('K4G');
    const pole = maK4 && !maK4G ? 'k4' : (maK4G && !maK4 ? 'k4g' : 'ogolna');
    produkty = produkty.filter((p) => zgodnosc.includes(p.zgodnosc[pole]));
  }

  const kier = dir === 'desc' ? -1 : 1;
  produkty.sort((a, b) => {
    const va = wartoscSortowania(a, sort);
    const vb = wartoscSortowania(b, sort);
    const cmp = typeof va === 'string' ? va.localeCompare(vb, 'pl') : va - vb;
    return cmp !== 0 ? cmp * kier : a.symbol.localeCompare(b.symbol, 'pl');
  });

  const total = produkty.length;
  return { produkty: produkty.slice(offset, offset + limit), total };
}

module.exports = {
  pobierzProdukt,
  szukajProdukty,
  listujProdukty,
  pobierzProduktyZUniwersum,
  pobierzStanyGt,
  LIMIT_WYSZUKIWANIA,
  SORT_KLUCZE,
};
