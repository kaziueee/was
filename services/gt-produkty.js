'use strict';

// Odczyt danych o towarach bezposrednio z bazy GT (SQL Server) - wyszukiwanie
// po symbolu/EAN, np. do uzupelnienia kartoteki WMS przy lokalizowaniu/MM, oraz
// paginowana lista do tabeli kontrolnej "Produkty" (desktop).
// Polaczenie tylko do odczytu, patrz services/gt-sql.js.

const { query, naCzesci } = require('./gt-sql');
const db = require('../db/database');
const { MAGAZYNY, MAGAZYNY_RAZEM } = require('../config/magazyny');
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

// Czy kod jest PELNYM czlonem lokalizacji w polu GT - pola sa skompresowane, np.
// "M2-B3-P3 / M2-B4-P3", "C14P1 /L19P3 /", a czlony rozdziela '/', spacja, ',' lub ';'.
// Dzieki temu skan "C16" NIE lapie "M2-C16-P2" (podciag), tylko lokalizacje faktycznie "C16".
function kodJestTokenemLokalizacji(pole, kodUp) {
  if (!pole) return false;
  return String(pole).toUpperCase().split(/[\s/,;]+/).some((token) => token === kodUp);
}

// Szuka towarow po KODZIE LOKALIZACJI w polach wlasnych GT (tw_Pole1 = miejsce K4,
// tw_Pole8 = lokalizacja K4G). Uzywane, gdy skanujemy/wpisujemy kod lokalizacji towaru,
// ktory jest tylko w GT (t_GT) i nie ma wiersza w WMS `lokalizacje`. Dopasowanie
// TOKENOWE (kod = pelny czlon lokalizacji, nie dowolny podciag). Ograniczone do towarow
// ze stanem K4/K4G > 0 - inaczej zlapaloby inne kategorie (tw_Pole1/8 = autor/pomieszczenie).
async function szukajPoLokalizacjiGt(fraza, limit = LIMIT_WYSZUKIWANIA) {
  const kod = String(fraza || '').trim();
  if (kod.length < 2) return [];
  const kodUp = kod.toUpperCase();

  // Prefiltr SQL podciagiem (LIKE), potem doklandny filtr tokenowy w Node (LIKE nie
  // odroznia czlonu od podciagu). Over-fetch, bo czesc trafien podciagu odpadnie.
  const parametry = { cap: 500, lok: `%${escapeLike(kod)}%` };
  const towary = await query(`
    SELECT TOP (@cap) t.tw_Id, t.tw_Symbol, t.tw_Nazwa, t.tw_PodstKodKresk, t.tw_Pole1, t.tw_Pole8
    FROM tw__Towar t
    WHERE (t.tw_Pole1 LIKE @lok ESCAPE '\\' OR t.tw_Pole8 LIKE @lok ESCAPE '\\')
      AND EXISTS (
        SELECT 1 FROM tw_Stan s JOIN sl_Magazyn m ON m.mag_Id = s.st_MagId
        WHERE s.st_TowId = t.tw_Id AND m.mag_Symbol IN ('K4', 'K4G') AND s.st_Stan > 0
      )
    ORDER BY t.tw_Symbol
  `, parametry);

  const lista = towary.recordset
    .filter((t) => kodJestTokenemLokalizacji(t.tw_Pole1, kodUp) || kodJestTokenemLokalizacji(t.tw_Pole8, kodUp))
    .slice(0, limit);
  if (lista.length === 0) return [];

  const stanyMap = await pobierzStanyGt(lista.map((t) => t.tw_Id));
  return lista.map((t) => ({
    artykul_gt_id: String(t.tw_Id),
    symbol: t.tw_Symbol,
    nazwa: t.tw_Nazwa,
    ean: t.tw_PodstKodKresk || null,
    stany_gt: stanyMap.get(String(t.tw_Id)),
  }));
}

function sumaStanow(stanyGt) {
  return Object.values(stanyGt).reduce((suma, w) => suma + w.ilosc, 0);
}

// Ile sztuk artykulu mozna wyprowadzic z magazynu wg GT: stan minus rezerwacje
// (st_StanRez). Rezerwacje blokuja MM - patrz CLAUDE.md zasada 6. Zwraca
// { stan, rezerwacja, dostepne }. Rzuca, gdy baza GT jest niedostepna.
async function dostepneWGt(artykul_gt_id, magazyn) {
  const stany = await pobierzStanyGt([artykul_gt_id]);
  const w = stany.get(String(artykul_gt_id))?.[magazyn] ?? { ilosc: 0, rezerwacja: 0 };
  return { stan: w.ilosc, rezerwacja: w.rezerwacja, dostepne: w.ilosc - w.rezerwacja };
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
// Klucze per magazyn generujemy z configu, a NIE wypisujemy recznie. Powod jest twardy:
// routes/produkty.js waliduje ?magazyn= przeciw KODY_MAGAZYNOW (te same MAGAZYNY), wiec kod
// wpisany tylko w configu przechodzi walidacje, a potem MAGAZYNY_WYRAZENIA[kod] daje undefined
// i do SQL leci literalne "(undefined > 0)" -> blad skladni, 500. Reczna lista rozjezdza sie
// z kontraktem API w momencie dopisania linii do configu, zanim ktokolwiek dotknie frontu.
const SORT_WYRAZENIA = {
  sku: 't.tw_Symbol',
  nazwa: 't.tw_Nazwa',
  ean: 't.tw_PodstKodKresk',
  razem: `(${MAGAZYNY_RAZEM.map((kod) => wyrazenieStanu(kod)).join(' + ')})`,
  ...Object.fromEntries(MAGAZYNY.map((m) => [m.kod.toLowerCase(), wyrazenieStanu(m.kod)])),
};
const SORT_KLUCZE = Object.keys(SORT_WYRAZENIA);
const MAGAZYNY_WYRAZENIA = Object.fromEntries(MAGAZYNY.map((m) => [m.kod, wyrazenieStanu(m.kod)]));
const REZ_WYRAZENIA = Object.fromEntries(MAGAZYNY.map((m) => [m.kod, wyrazenieRez(m.kod)]));

// Kolumny stan_<kod>/rez_<kod> dla listujProdukty - ten sam powod co wyzej: stanyGtZWiersza
// czyta row[`stan_${kod}`] dla KAZDEGO magazynu z configu, wiec brak kolumny nie wybucha,
// tylko cicho daje {ilosc: undefined} w stany_gt.
const KOLUMNY_STANOW = MAGAZYNY.map((m) => {
  const k = m.kod.toLowerCase();
  return `${wyrazenieStanu(m.kod)} AS stan_${k}, ${wyrazenieRez(m.kod)} AS rez_${k}`;
}).join(',\n      ');

// --- Zestawienia (desktop) - gotowe pytania "co przywiezc / czego brakuje" ---
//
// Kazde to WARUNEK HAVING na tych samych agregatach, co listujProdukty. Skladamy je z
// SORT_WYRAZENIA/REZ_WYRAZENIA zamiast pisac czwarty wariant SQL-a - dzieki temu definicja
// "Razem" (K4+K4G+MAG+LS, bez BRK) jest jedna dla calego systemu.
//
// Prog Leszna w .env, bo to liczba biznesowa, nie stala techniczna. Na dzis daje 0 wierszy:
// LS ma tylko 4 SKU, a kazde ma na K4+K4G 137-1184 szt. To lista OBSERWACYJNA - zapali sie,
// gdy hala zejdzie nisko, i o to chodzi.
const PROG_LESZNO = Number(process.env.WMS_PROG_LESZNO) || 50;

// Rezerwacje sumujemy po tych samych magazynach co "Razem" - bez BRK (towar niepelnowartosciowy)
// i bez K4R (reklamacje; 385 szt. rezerwacji, ale to inny proces, nie sprzedaz z polki).
// Inaczej nadsprzedaz mieszalaby dwa nieporownywalne swiaty.
const REZ_RAZEM = `(${MAGAZYNY_RAZEM.map((kod) => REZ_WYRAZENIA[kod]).join(' + ')})`;

// NADSPRZEDAZ liczy rezerwacje z POZYCJI otwartych ZK, a NIE z tw_Stan.st_StanRez - bo
// st_StanRez to licznik zbiorczy BEZ DATY, a nadsprzedaz ma dotyczyc swiezych zamowien.
// Na zywej bazie (OKITRADE) otwarte ZK to w wiekszosci zombie: 2408 szt. z dokumentow
// starszych niz ROK, przy 377 szt. z ostatnich 30 dni. Bez okna zestawienie pokazywalo 15
// pozycji, z ktorych zadna nie byla realnym, aktualnym problemem.
//
// Rownowaznosc "suma pozycji otwartych ZK = st_StanRez" jest potwierdzona na zywej bazie
// (zob. pobierzZkRezerwujaceK4 w gt-dokumenty.js), wiec bez okna oba rachunki daja to samo.
const ZK_TYP = 16;
const ZK_STATUS_OTWARTE = 7;
const NADSPRZEDAZ_DNI = Number(process.env.WMS_NADSPRZEDAZ_DNI) || 30;

// ob_TowId = t.tw_Id koreluje po zgrupowanej kolumnie, wiec dziala i w SELECT, i w HAVING.
const REZ_ZK_SWIEZE = `ISNULL((
  SELECT SUM(o.ob_Ilosc)
  FROM dok_Pozycja o
  JOIN dok__Dokument d ON d.dok_Id = o.ob_DokHanId
  JOIN sl_Magazyn g ON g.mag_Id = o.ob_MagId
  WHERE d.dok_Typ = ${ZK_TYP} AND d.dok_Status = ${ZK_STATUS_OTWARTE}
    AND o.ob_TowId = t.tw_Id
    AND g.mag_Symbol IN (${MAGAZYNY_RAZEM.map((k) => `'${k}'`).join(', ')})
    AND d.dok_DataWyst >= DATEADD(day, -${NADSPRZEDAZ_DNI}, GETDATE())
), 0)`;

const WARUNKI_ZESTAWIEN = {
  // Do przywiezienia z MAG: sprzedane wiecej, niz mamy w hali, a zapas lezy na MAG.
  przywozka: `${REZ_WYRAZENIA.K4} > 0`
    + ` AND ${REZ_WYRAZENIA.K4} > ${SORT_WYRAZENIA.k4} + ${SORT_WYRAZENIA.k4g}`
    + ` AND ${SORT_WYRAZENIA.mag} > 0`,
  // Do przywiezienia z Leszna: hala schodzi ponizej progu, a w LS jest zapas.
  leszno: `${SORT_WYRAZENIA.k4} + ${SORT_WYRAZENIA.k4g} < ${PROG_LESZNO} AND ${SORT_WYRAZENIA.ls} > 0`,
  // Nadsprzedaz: obiecane wiecej, niz mamy gdziekolwiek - ale tylko na SWIEZYCH zamowieniach.
  nadsprzedaz: `${REZ_ZK_SWIEZE} > ${SORT_WYRAZENIA.razem}`,
};

// Wartosc danego "klucza sortowania" dla produktu zlozonego w JS - uzywane w
// trybie "zbior WMS" (pobierzProduktyZUniwersum), gdzie sortowanie/filtrowanie
// dzieje sie w Node, a nie w SQL.
// Klucze niemagazynowe wypisane, magazynowe rozwiazywane z configu - inaczej sort po nowym
// magazynie cicho degraduje do `default` (sortowanie po symbolu) zamiast zadzialac.
const SORTY_NIEMAGAZYNOWE = {
  sku: (p) => p.symbol,
  nazwa: (p) => p.nazwa,
  ean: (p) => p.ean || '',
  razem: (p) => p.razem,
};
function wartoscSortowania(p, klucz) {
  const staly = SORTY_NIEMAGAZYNOWE[klucz];
  if (staly) return staly(p);
  const mag = MAGAZYNY.find((m) => m.kod.toLowerCase() === klucz);
  if (mag) return p.stany_gt[mag.kod]?.ilosc ?? 0;
  return p.symbol;
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

// Suma "Razem" = K4+K4G+MAG+LS (bez BRK, zob. MAGAZYNY_RAZEM). Musi byc spojna
// z wyrazeniem SQL SORT_WYRAZENIA.razem uzywanym w trybie katalogowym.
function sumaRazem(stany_gt) {
  return MAGAZYNY_RAZEM.reduce((suma, kod) => suma + (stany_gt[kod]?.ilosc ?? 0), 0);
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
// zestawienie - klucz z WARUNKI_ZESTAWIEN ('przywozka'|'leszno'|'nadsprzedaz'). Doklada gotowy
// warunek HAVING i zawezenie do tw_Rodzaj=1 (tylko towary - zestawy/komplety rodzaju 8 nie maja
// fizycznego stanu na polce, wiec w zestawieniach "co przywiezc" byly by szumem).
// tylkoIdy - opcjonalna lista tw_Id do zawezenia wynikow (filtr stref w routes/produkty.js:
// strefa nie jest kolumna w GT, wiec zbior liczy Node i podaje gotowe id). Pusta TABLICA
// znaczy "nic nie pasuje" i musi dac 0 wynikow - dlatego rozrozniamy ja od null ("bez filtru").
async function listujProdukty({ q, limit = 50, offset = 0, sort = 'sku', dir = 'asc', magazyny = [], zRezerwacja = false, pokazZablokowane = false, zestawienie = null, tylkoIdy = null } = {}) {
  const parametry = { limit, offset };
  let where = '1=1';
  if (zestawienie && !WARUNKI_ZESTAWIEN[zestawienie]) {
    throw new Error(`Nieznane zestawienie: ${zestawienie}`);
  }

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
    parametry.lokFraza = `%${escapeLike(fraza)}%`; // kod lokalizacji w polach GT (tw_Pole1/Pole8)
    // Match po lokalizacji GT tylko dla towarow ze stanem K4/K4G - inaczej zlapaloby inne
    // kategorie, gdzie tw_Pole1/8 = autor/pomieszczenie.
    const lokWarunek = `((t.tw_Pole1 LIKE @lokFraza ESCAPE '\\' OR t.tw_Pole8 LIKE @lokFraza ESCAPE '\\')`
      + ` AND EXISTS (SELECT 1 FROM tw_Stan sl JOIN sl_Magazyn ml ON ml.mag_Id = sl.st_MagId`
      + `   WHERE sl.st_TowId = t.tw_Id AND ml.mag_Symbol IN ('K4', 'K4G') AND sl.st_Stan > 0))`;
    where = `(t.tw_Symbol LIKE @symbolFraza ESCAPE '\\' OR t.tw_PodstKodKresk LIKE @eanFraza ESCAPE '\\' OR ${lokWarunek} OR (${warunkiSlow}))`;
  }

  if (!pokazZablokowane) {
    where += ' AND t.tw_Zablokowany = 0';
  }
  // MUSI byc po bloku `fraza` - tamten NADPISUJE `where`, a nie doklada, wiec warunek
  // postawiony wyzej wyparowalby przy niepustym q.
  if (zestawienie) where += ' AND t.tw_Rodzaj = 1';

  // Filtr stref: zbior tw_Id policzony w Node (patrz tylkoIdy wyzej). Pusta tablica =
  // "zaden produkt nie ma wybranej strefy" -> 0 wynikow, a nie "pokaz wszystko".
  if (Array.isArray(tylkoIdy)) {
    if (tylkoIdy.length === 0) {
      where += ' AND 1=0';
    } else {
      const idPlaceholders = tylkoIdy.map((id, i) => {
        parametry[`id${i}`] = Number(id);
        return `@id${i}`;
      }).join(', ');
      where += ` AND t.tw_Id IN (${idPlaceholders})`;
    }
  }

  // Filtr magazynowy (stan > 0) i "z rezerwacja" (st_StanRez > 0) lacza sie przez
  // AND; oba w obrebie wybranych magazynow (lub wszystkich, gdy filtr magazynu pusty).
  const warunkiHaving = [];
  if (zestawienie) warunkiHaving.push(`(${WARUNKI_ZESTAWIEN[zestawienie]})`);
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
      ${KOLUMNY_STANOW}
      ${zestawienie === 'nadsprzedaz' ? `, ${REZ_ZK_SWIEZE} AS rez_zk_swieze` : ''}
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
      razem: sumaRazem(stany_gt),
      // rezerwacja ze SWIEZYCH ZK - tylko dla nadsprzedazy. Musi jechac na front, bo to ona
      // wpuscila wiersz na liste; pokazanie zamiast niej st_StanRez (ktore liczy takze zombie
      // ZK sprzed roku) kazaloby patrzec na inna liczbe niz ta, ktora decyduje.
      ...(row.rez_zk_swieze !== undefined ? { rezerwacja_swieza: Number(row.rez_zk_swieze) } : {}),
    };
  });

  return { produkty, total };
}

// Sciezka "Ostatnie sztuki" (Faza 6): towary z niskim stanem GT w K4 (min..max szt.),
// ktore MAJA lokalizacje K4 (tw_Pole1 niepuste - obchod idzie po lokalizacjach) I ktorych
// LACZNY stan (Razem = K4+K4G+MAG+LS, bez BRK) <= maxRazem. Warunek Razem odsiewa towary
// z niskim K4, ale z zapasem na innych magazynach (np. setki na K4G - to kandydat do
// uzupelnienia, nie do liczenia "ostatnich sztuk"). GT = master stanow, wiec prog liczymy
// po st_Stan, nie po WMS stany_lokalizacji. Tylko tw_Rodzaj=1 (towary) - wycina zestawy/komplety
// (rodzaj 8: bundle bez wlasnego fizycznego stanu na polce, np. "Nerf ... + celownik + strzalki")
// i uslugi. Filtr po RODZAJU, nie po nazwie - tysiace zwyklych towarow ma "zestaw" w nazwie
// ("Zestaw klockow") i te zostaja. Sort po tw_Pole1 = kolejnosc zbierania.
// Zwraca [{artykul_gt_id, symbol, nazwa, ean, lokalizacja_kod, stan_k4, rez_k4, razem}].
async function pobierzK4NiskieStany({ min = 1, max = 5, maxRazem = 5 } = {}) {
  const k4 = wyrazenieStanu('K4');
  const rezK4 = wyrazenieRez('K4');
  const razem = MAGAZYNY_RAZEM.map((kod) => wyrazenieStanu(kod)).join(' + ');

  const { recordset } = await query(`
    SELECT t.tw_Id, t.tw_Symbol, t.tw_Nazwa, t.tw_PodstKodKresk,
           LTRIM(RTRIM(t.tw_Pole1)) AS lokalizacja,
           ${k4} AS stan_k4, ${rezK4} AS rez_k4, ${razem} AS razem
    FROM tw__Towar t
    JOIN tw_Stan s ON s.st_TowId = t.tw_Id
    JOIN sl_Magazyn m ON m.mag_Id = s.st_MagId
    WHERE t.tw_Zablokowany = 0 AND LTRIM(RTRIM(t.tw_Pole1)) <> ''
      AND t.tw_Rodzaj = 1
    GROUP BY t.tw_Id, t.tw_Symbol, t.tw_Nazwa, t.tw_PodstKodKresk, LTRIM(RTRIM(t.tw_Pole1))
    HAVING ${k4} >= @min AND ${k4} <= @max AND ${razem} <= @maxRazem
    ORDER BY LTRIM(RTRIM(t.tw_Pole1)), t.tw_Symbol
  `, { min, max, maxRazem });

  return recordset.map((r) => ({
    artykul_gt_id: String(r.tw_Id),
    symbol: r.tw_Symbol,
    nazwa: r.tw_Nazwa,
    ean: r.tw_PodstKodKresk || null,
    lokalizacja_kod: r.lokalizacja,
    stan_k4: r.stan_k4,
    rez_k4: r.rez_k4,
    razem: r.razem,
  }));
}

// Sciezka "K4 z pelna rezerwacja": towary, ktore FIZYCZNIE lezą tylko w K4 (nic na
// K4G/MAG/LS) i caly ich stan K4 jest zarezerwowany (rez_k4 >= stan_k4, stan_k4 > 0).
// Czyli towar utknal - jest na miejscu, ale w calosci zablokowany rezerwacjami, a nie
// ma go skad uzupelnic. tw_Rodzaj=1 (tylko towary, nie zestawy/uslugi), tw_Pole1 niepusta.
async function pobierzK4PelnaRezerwacja() {
  const k4 = wyrazenieStanu('K4');
  const rezK4 = wyrazenieRez('K4');
  const inne = ['K4G', 'MAG', 'LS'].map((kod) => wyrazenieStanu(kod)).join(' + ');

  const { recordset } = await query(`
    SELECT t.tw_Id, t.tw_Symbol, t.tw_Nazwa, t.tw_PodstKodKresk,
           LTRIM(RTRIM(t.tw_Pole1)) AS lokalizacja,
           ${k4} AS stan_k4, ${rezK4} AS rez_k4
    FROM tw__Towar t
    JOIN tw_Stan s ON s.st_TowId = t.tw_Id
    JOIN sl_Magazyn m ON m.mag_Id = s.st_MagId
    WHERE t.tw_Zablokowany = 0 AND LTRIM(RTRIM(t.tw_Pole1)) <> ''
      AND t.tw_Rodzaj = 1
    GROUP BY t.tw_Id, t.tw_Symbol, t.tw_Nazwa, t.tw_PodstKodKresk, LTRIM(RTRIM(t.tw_Pole1))
    HAVING ${k4} > 0 AND ${rezK4} >= ${k4} AND (${inne}) = 0
    ORDER BY LTRIM(RTRIM(t.tw_Pole1)), t.tw_Symbol
  `);

  return recordset.map((r) => ({
    artykul_gt_id: String(r.tw_Id),
    symbol: r.tw_Symbol,
    nazwa: r.tw_Nazwa,
    ean: r.tw_PodstKodKresk || null,
    lokalizacja_kod: r.lokalizacja,
    stan_k4: r.stan_k4,
    rez_k4: r.rez_k4,
  }));
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
async function pobierzProduktyZUniwersum({ q, limit, offset, sort, dir, magazyny, zgodnosc, zRezerwacja, pokazZablokowane, tylkoIdy = null }) {
  let ids = await pobierzZbiorWmsIds({ pokazZablokowane });
  // Filtr stref (zob. tylkoIdy w listujProdukty). Zawezamy PRZED pobraniem stanow/przegladu -
  // te zapytania sa najdrozsze w tym trybie, a strefy zwykle tna zbior do kilkuset pozycji.
  if (Array.isArray(tylkoIdy)) {
    const dozwolone = new Set(tylkoIdy.map(String));
    ids = ids.filter((id) => dozwolone.has(String(id)));
  }
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
        razem: sumaRazem(stany_gt),
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
    // filtr po zgodnosci ogolnej - spojnie z badge na liscie i statusem w modalu
    produkty = produkty.filter((p) => zgodnosc.includes(p.zgodnosc.ogolna));
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

// Rozklad statusow zgodnosci GT<->WMS dla calego "zbioru WMS" (~2300-2400 SKU).
// Zwraca liczniki 5 stanow ZGODNOSC po zgodnosci OGOLNEJ (najgorszy z K4/K4G) -
// to samo pole, co badge na liscie Produkty i filtr Zgodnosc. Uzywane przez
// job pulpit-snapshot (Faza 5) - drogie (krzyzuje caly zbior z GT), wiec liczone
// godzinnym jobem, nie na zywo przy otwarciu pulpitu.
async function rozkladZgodnosci() {
  const ids = await pobierzZbiorWmsIds({});
  const licznik = { OK: 0, NZ: 0, t_GT: 0, BD: 0, OF: 0 };
  if (ids.length === 0) return { licznik, razem: 0 };

  const [podstawoweMap, przegladMap] = await Promise.all([
    pobierzPodstawoweInfo(ids),
    pobierzPrzegladLokalizacji(ids),
  ]);

  let razem = 0;
  for (const id of ids) {
    const info = podstawoweMap.get(id);
    if (info && info.tw_Zablokowany) continue; // zablokowane pomijamy (jak lista Produkty)
    const zg = przegladMap.get(id);
    if (!zg) continue;
    if (licznik[zg.ogolna] === undefined) continue;
    licznik[zg.ogolna]++;
    razem++;
  }
  return { licznik, razem };
}

module.exports = {
  pobierzProdukt,
  szukajProdukty,
  szukajPoLokalizacjiGt,
  listujProdukty,
  pobierzProduktyZUniwersum,
  pobierzK4NiskieStany,
  pobierzK4PelnaRezerwacja,
  pobierzStanyGt,
  rozkladZgodnosci,
  dostepneWGt,
  LIMIT_WYSZUKIWANIA,
  SORT_KLUCZE,
};
