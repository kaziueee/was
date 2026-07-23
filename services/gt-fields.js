'use strict';

// Kompresja lokalizacji WMS do pol wlasnych GT (kartoteka towaru) - patrz CLAUDE.md
// "Pola wlasne GT". Format wpisu: kod(ilosc), wpisy rozdzielone "; ".
// Limit pola: ~50 znakow ("Lokalizacja Górna"), overflow do "Lokalizacja Zapas"
// (rowniez ~50 znakow, ~100 lacznie). Jesli nadal sie nie miesci - obciecie + "...".
//
// Mapowanie na kolumny w bazie GT (potwierdzone na danych Z_KAJTEK_IdeaERP):
//   miejsce_na_magazynie -> tw__Towar.tw_Pole1   (standardowe pole dodatkowe, varchar(50))
//   lokalizacja_gorna    -> tw__Towar.tw_Pole8   (standardowe pole dodatkowe, varchar(50))
//   lokalizacja_zapas    -> NIGDZIE w GT. Overflow ponad limit tw_Pole8 zostaje wylacznie
//     w WMS; sluzy juz tylko do oflagowania ZGODNOSC.OBCIETE ("pole GT za krotkie, zeby
//     pokazac wszystkie wpisy"). Nie mylic z pwd_Tekst09 - ta kolumna trzyma dzis
//     "Waga gabarytowa DHL" (zob. services/gt-atrybuty.js), wiec czytanie jej tutaj
//     doklejaloby wage do tekstu lokalizacji K4G.

const db = require('../db/database');
const { query, naCzesci } = require('./gt-sql');

const LIMIT_POLA = 50;

function formatWpis(kod, ilosc) {
  return `${kod}(${Number(ilosc)})`;
}

// Adnotacja stref w tw_Pole1 ("M2-J14-P2 +D20 +Z3") - czyste funkcje mieszkaja w osobnym
// module, zeby dalo sie je testowac bez SQLite i GT. Re-eksport nizej, bo wolajacy i tak
// przychodza po nie do gt-fields.
const { bezAdnotacjiStref, zbudujAdnotacjeStref, zlozPole, decyzjaAdnotacji, SKROTY_STREF } = require('./adnotacja-stref');

// pozycje: [{kod, ilosc}] - zwraca {gorna, zapas}, oba "" gdy brak lokalizacji
function kompresujLokalizacjeGorne(pozycje) {
  const wpisy = pozycje.map((p) => formatWpis(p.kod, p.ilosc));
  if (wpisy.length === 0) {
    return { gorna: '', zapas: '' };
  }

  const pelny = wpisy.join('; ');
  if (pelny.length <= LIMIT_POLA) {
    return { gorna: pelny, zapas: '' };
  }

  let gorna = '';
  let i = 0;
  for (; i < wpisy.length; i++) {
    const proba = gorna ? `${gorna}; ${wpisy[i]}` : wpisy[i];
    if (proba.length > LIMIT_POLA) break;
    gorna = proba;
  }
  if (!gorna) {
    // nawet pojedynczy wpis jest dluzszy niz limit - obetnij go
    gorna = wpisy[0].slice(0, LIMIT_POLA);
    i = 1;
  }

  const reszta = wpisy.slice(i).join('; ');
  if (reszta.length <= LIMIT_POLA) {
    return { gorna, zapas: reszta };
  }

  let zapas = '';
  for (; i < wpisy.length; i++) {
    const proba = zapas ? `${zapas}; ${wpisy[i]}` : wpisy[i];
    if (proba.length > LIMIT_POLA - 3) break;
    zapas = proba;
  }
  return { gorna, zapas: `${zapas}...` };
}

// Wyznacza biezace wartosci pol lokalizacyjnych GT dla artykulu na podstawie stanu WMS.
// Zwraca "" dla pol bez tresci (np. brak lokalizacji w danym magazynie) - pusty string
// w LokRequest oznacza "wyczysc pole" po stronie mostu.
function obliczPolaLokalizacji(artykulGtId) {
  // zapas_kod = opcjonalna adnotacja nadmiaru K4 (decyzja A) -> tw_Pole1 = "zbior/zapas".
  // K4 = STALE miejsce SKU (dom) - bierzemy je NIEZALEZNIE od ilosci. Pusta polka czeka na
  // uzupelnienie i nie przestaje byc adresem; WMS swiadomie trzyma wiersz z zerem (routes/
  // ruchy.js: "lokalizacja zostaje jako stale miejsce SKU"), a filtr "ilosc > 0" kasowal tu
  // tw_Pole1 w GT (pusty string = "wyczysc pole") - czlowiek szukajacy towaru tracil adres.
  // Wiersz ze stanem wygrywa z zerowym: przy przejsciowych dwoch wierszach K4 nie wpisujemy
  // do GT starego, oproznionego miejsca.
  const k4 = db.prepare(`
    SELECT l.kod, s.zapas_kod FROM stany_lokalizacji s
    JOIN lokalizacje l ON l.id = s.lokalizacja_id
    WHERE s.artykul_gt_id = ? AND l.magazyn = 'K4'
    ORDER BY (s.ilosc > 0) DESC, s.ostatnia_zmiana DESC
  `).get(artykulGtId);

  const k4g = db.prepare(`
    SELECT l.kod, s.ilosc FROM stany_lokalizacji s
    JOIN lokalizacje l ON l.id = s.lokalizacja_id
    WHERE s.artykul_gt_id = ? AND l.magazyn = 'K4G' AND s.ilosc > 0
    ORDER BY l.kod
  `).all(artykulGtId);

  const { gorna, zapas } = kompresujLokalizacjeGorne(k4g);

  const k4Kod = k4 ? (k4.zapas_kod ? `${k4.kod}/${k4.zapas_kod}` : k4.kod) : '';

  return {
    miejsce_na_magazynie: k4Kod,
    lokalizacja_gorna: gorna,
    lokalizacja_zapas: zapas,
  };
}

// Przelicza pola lokalizacyjne dla artykulu i zapisuje je bezposrednio w GT
// (UPDATE tw__Towar.tw_Pole1/tw_Pole8) - bez mostu/Sfery, lokalizacje nie sa
// stanami magazynowymi. magazyny: Set magazynow zaangazowanych w ruch - pola
// K4 / K4gora sa przeliczane i zapisywane tylko jesli odpowiedni magazyn
// znajduje sie w tym zbiorze. "Lokalizacja Zapas" (overflow K4G) nie jedzie nigdzie -
// zostaje tylko w WMS; pole o tej nazwie w GT jest nieuzywane.
// Zwraca null, jesli synchronizacja nie dotyczy zadnego z pol obslugiwanych
// przez WMS (K4 / K4gora), albo {ok, dane: {sukces}} / {ok: false, blad}.
async function synchronizujLokalizacje(artykulGtId, magazyny) {
  const dotyczyK4 = magazyny.has('K4');
  const dotyczyK4G = magazyny.has('K4G');

  if (!dotyczyK4 && !dotyczyK4G) {
    return null;
  }

  const pola = obliczPolaLokalizacji(artykulGtId);

  const ustawienia = [];
  const parametry = { id: Number(artykulGtId) };
  if (dotyczyK4) {
    // Symetrycznie do K4G nizej: nie nadpisuj tw_Pole1, dopoki caly stan GT K4 nie jest
    // rozlozony w WMS (deficyt > 0). Przy niepelnym rozlozeniu WMS ma czastkowy obraz, a
    // nadpisanie skasowaloby to, czego WMS nie zna - w tym ZAPAS trzymany TYLKO w GT
    // (tw_Pole1 "A1/P5", gdzie P5 nie ma odpowiednika w WMS zapas_kod). GT niedostepny ->
    // nie blokujemy (traktujemy jak pelne rozlozenie), jak przy K4G.
    let pomijajK4 = false;
    try {
      const { pobierzStanyGt } = require('./gt-produkty');
      const sumaK4 = db.prepare(
        `SELECT COALESCE(SUM(s.ilosc), 0) AS suma FROM stany_lokalizacji s
         JOIN lokalizacje l ON l.id = s.lokalizacja_id
         WHERE s.artykul_gt_id = ? AND l.magazyn = 'K4'`
      ).get(artykulGtId).suma;
      const stany = await pobierzStanyGt([artykulGtId]);
      const gtK4 = stany.get(String(artykulGtId))?.K4?.ilosc ?? sumaK4;
      if (gtK4 - sumaK4 > 0) pomijajK4 = true;
    } catch (err) {
      pomijajK4 = false;
    }
    if (!pomijajK4) {
      ustawienia.push('tw_Pole1 = @pole1');
      parametry.pole1 = pola.miejsce_na_magazynie;
    }
  }
  if (dotyczyK4G) {
    // Nie nadpisuj pola K4G (tw_Pole8) dopoki nie rozlozono calego stanu GT w WMS
    // (deficyt_k4g > 0) - inaczej GT dostaje niepelny obraz i ginie plan "gdzie dolozyc
    // reszte". Gdy stan GT niedostepny -> nie blokujemy (traktujemy jak pelne rozlozenie).
    // Lazy require pobierzStanyGt: gt-produkty wymaga gt-fields (cykl) - bezpieczne w czasie wywolania.
    let pomijajK4G = false;
    try {
      const { pobierzStanyGt } = require('./gt-produkty');
      const sumaK4G = db.prepare(
        `SELECT COALESCE(SUM(s.ilosc), 0) AS suma FROM stany_lokalizacji s
         JOIN lokalizacje l ON l.id = s.lokalizacja_id
         WHERE s.artykul_gt_id = ? AND l.magazyn = 'K4G'`
      ).get(artykulGtId).suma;
      const stany = await pobierzStanyGt([artykulGtId]);
      const gtK4G = stany.get(String(artykulGtId))?.K4G?.ilosc ?? sumaK4G;
      if (gtK4G - sumaK4G > 0) pomijajK4G = true;
    } catch (err) {
      pomijajK4G = false;
    }
    if (!pomijajK4G) {
      ustawienia.push('tw_Pole8 = @pole8');
      parametry.pole8 = pola.lokalizacja_gorna;
    }
  }

  if (ustawienia.length === 0) {
    // K4 i/lub K4G ma deficyt (stan GT nierozlozony w WMS) - nic nie zapisujemy, plan i zapas
    // w GT zostaja nietkniete do czasu pelnego rozlozenia.
    return { ok: true, dane: { sukces: true, pominieto: true } };
  }

  try {
    await query(`UPDATE tw__Towar SET ${ustawienia.join(', ')} WHERE tw_Id = @id`, parametry);
    return { ok: true, dane: { sukces: true } };
  } catch (err) {
    return { ok: false, blad: `Zapis lokalizacji (SQL): ${err.message}` };
  }
}

// Pobiera aktualne wartosci pol lokalizacyjnych z GT (vwPolaWlasne_Towar) dla
// podanych tw_Id. Zwraca Map<tw_Id jako string, {tw_Pole1, tw_Pole8}>
// - artykuly bez wlasnego wiersza w mapie traktujemy jako puste pola GT.
// Dzieli idy na paczki (naCzesci) - SQL Server ma limit ~2100 parametrow,
// a zbior WMS (zob. gt-produkty.js) moze przekroczyc 2000 artykulow.
async function pobierzAktualnePolaLokalizacji(artykulGtIds) {
  const idy = [...new Set(artykulGtIds.map(Number).filter(Number.isInteger))];
  if (idy.length === 0) return new Map();

  const wynik = new Map();
  await Promise.all(naCzesci(idy, 1000).map(async (paczka) => {
    const parametry = {};
    const warunki = paczka.map((id, i) => {
      parametry[`id${i}`] = id;
      return `@id${i}`;
    }).join(', ');

    const { recordset } = await query(
      `SELECT tw_Id, tw_Pole1, tw_Pole8 FROM vwPolaWlasne_Towar WHERE tw_Id IN (${warunki})`,
      parametry
    );
    for (const r of recordset) wynik.set(String(r.tw_Id), r);
  }));

  return wynik;
}

// Formatuje aktualne pola lokalizacyjne GT do podgladu, np.
// "K4: M2-J14-P2 | K4G: M2-J14-P2/3; M2-J15-P1", "brak lokalizacji w GT" gdy puste.
function formatujAktualnePola(polaGt) {
  const k4 = (polaGt?.tw_Pole1 || '').trim();
  const k4g = (polaGt?.tw_Pole8 || '').trim();

  const czesci = [];
  if (k4) czesci.push(`K4: ${k4}`);
  if (k4g) czesci.push(`K4G: ${k4g}`);
  return czesci.length ? czesci.join(' | ') : 'brak lokalizacji w GT';
}

// Czy aktualne pola GT odpowiadaja temu, co WMS wyliczylby na podstawie
// biezacego stanu lokalizacji - tzn. czy GT jest "swiezy" wzgledem WMS.
// Roznica oznacza zaleglosc w synchronizacji (zob. services/ruchy-retry.js)
// albo recznie zmienione pole w GT.
function zgodneZWms(artykulGtId, polaGt) {
  const oczekiwane = obliczPolaLokalizacji(artykulGtId);
  // Adnotacja stref (" +D20 +Z3") jest DOPISKIEM, nie lokalizacja - dopisuje ja osobny job
  // z danych GT, a nie WMS. Porownywanie jej tutaj wywalaloby na NZ kazde SKU z otwarta
  // dostawa, mimo ze adres zgadza sie co do znaku.
  return bezAdnotacjiStref(polaGt?.tw_Pole1) === oczekiwane.miejsce_na_magazynie
    && (polaGt?.tw_Pole8 || '').trim() === oczekiwane.lokalizacja_gorna;
}

// Dla listy artykulow zwraca Map<artykul_gt_id jako string, {tekst, zgodna}> -
// lokalizacja wedlug aktualnych pol GT + flaga zgodnosci z biezacym stanem WMS.
// Do wyswietlenia na ekranach mm/lokalizowanie jako "sanity check" przed ruchem.
async function pobierzStatusLokalizacjiGt(artykulGtIds) {
  const polaMap = await pobierzAktualnePolaLokalizacji(artykulGtIds);
  const wynik = new Map();
  for (const id of new Set(artykulGtIds)) {
    const polaGt = polaMap.get(String(id));
    wynik.set(String(id), {
      tekst: formatujAktualnePola(polaGt),
      zgodna: zgodneZWms(id, polaGt),
    });
  }
  return wynik;
}

// 4 stany zgodnosci pola lokalizacyjnego (K4 albo K4G) miedzy WMS i GT -
// kolumna "Zgodnosc" w tabeli kontrolnej Produkty (desktop). Krotkie kody
// (nie emoji), bo sluza tez jako wartosci filtra w UI.
const ZGODNOSC = { NIEZGODNE: 'NZ', TYLKO_GT: 't_GT', ZGODNE: 'OK', PUSTE: 'BD', OBCIETE: 'OF' };
// OF = pole GT za krotkie na wszystkie lokalizacje K4G, ale sumy WMS i GT sie zgadzaja - nie blad
const PRIORYTET_ZGODNOSCI = [ZGODNOSC.NIEZGODNE, ZGODNOSC.TYLKO_GT, ZGODNOSC.OBCIETE, ZGODNOSC.ZGODNE, ZGODNOSC.PUSTE];

function klasyfikujZgodnosc(wms, gt) {
  if (!wms && !gt) return ZGODNOSC.PUSTE;
  if (!wms && gt) return ZGODNOSC.TYLKO_GT;
  if (wms && !gt) return ZGODNOSC.NIEZGODNE;
  return wms === gt ? ZGODNOSC.ZGODNE : ZGODNOSC.NIEZGODNE;
}

// Status "ogolny" z dwoch magazynow (K4, K4G). Zwykle najgorszy wg PRIORYTET_ZGODNOSCI,
// ale z wyjatkiem: gdy CZESC jest zlokalizowana (OK/OF) a drugi magazyn ma stan w GT bez
// WMS (t_GT), to NIE jest "tylko GT" - to czesciowa/niespojna lokalizacja => NZ (spojnie
// z czesciowym K4G, ktore juz jest NZ). t_GT zostaje tylko gdy NIC nie jest zlokalizowane.
function obliczOgolna(k4stan, k4gstan) {
  const stany = [k4stan, k4gstan];
  if (stany.includes(ZGODNOSC.NIEZGODNE)) return ZGODNOSC.NIEZGODNE;
  const maZlokalizowane = stany.some((s) => s === ZGODNOSC.ZGODNE || s === ZGODNOSC.OBCIETE);
  const maTylkoGt = stany.includes(ZGODNOSC.TYLKO_GT);
  if (maZlokalizowane && maTylkoGt) return ZGODNOSC.NIEZGODNE; // czesciowo zlokalizowany
  return PRIORYTET_ZGODNOSCI.find((s) => s === k4stan || s === k4gstan);
}

// Dla listy artykulow porownuje oczekiwane przez WMS pola lokalizacyjne z
// aktualnymi polami GT, osobno dla K4 i K4G, i klasyfikuje kazdy do jednego
// z 4 stanow ZGODNOSC. Zwraca Map<artykul_gt_id jako string,
// {k4: {gt_tekst, stan}, k4g: {gt_tekst, stan}, ogolna}> - "ogolna" to
// najgorszy przypadek z k4/k4g wg PRIORYTET_ZGODNOSCI, do prostego
// filtrowania w tabeli kontrolnej Produkty.
async function pobierzPrzegladLokalizacji(artykulGtIds) {
  const idy = [...new Set(artykulGtIds.map(String))];
  const polaMap = await pobierzAktualnePolaLokalizacji(idy);
  const oczekiwaneMap = new Map(idy.map((id) => [id, obliczPolaLokalizacji(id)]));

  // K4G jest porownywane ILOSCIOWO (magazyn hurtowy: caly stan GT powinien byc
  // zlokalizowany w WMS). Pobieramy sumy WMS K4G i stany GT K4G dla wszystkich id.
  const sumaWmsK4g = new Map();
  const sumaGtK4g = new Map();

  // WMS (SQLite): artykul_gt_id to TEKST; paczkujemy (limit zmiennych SQLite)
  for (const paczka of naCzesci(idy, 500)) {
    const placeholders = paczka.map(() => '?').join(', ');
    const wmsWiersze = db.prepare(`
      SELECT s.artykul_gt_id AS id, COALESCE(SUM(s.ilosc), 0) AS suma
      FROM stany_lokalizacji s JOIN lokalizacje l ON l.id = s.lokalizacja_id
      WHERE s.artykul_gt_id IN (${placeholders}) AND l.magazyn = 'K4G'
      GROUP BY s.artykul_gt_id
    `).all(...paczka);
    for (const w of wmsWiersze) sumaWmsK4g.set(String(w.id), Number(w.suma));
  }

  // GT (SQL Server, mag K4G=8): st_TowId to liczba; paczkujemy (limit ~2100 parametrow)
  await Promise.all(naCzesci(idy.map(Number), 1000).map(async (paczka) => {
    const params = {};
    const warunki = paczka.map((id, i) => { params[`id${i}`] = id; return `@id${i}`; }).join(', ');
    const { recordset } = await query(
      `SELECT st_TowId AS id, COALESCE(SUM(st_Stan), 0) AS suma FROM tw_Stan WHERE st_TowId IN (${warunki}) AND st_MagId = 8 GROUP BY st_TowId`,
      params
    );
    for (const r of recordset) sumaGtK4g.set(String(r.id), Number(r.suma));
  }));

  const wynik = new Map();
  for (const id of idy) {
    const polaGt = polaMap.get(id);
    const oczekiwane = oczekiwaneMap.get(id);

    const gtK4 = bezAdnotacjiStref(polaGt?.tw_Pole1);   // dopisek stref nie jest adresem
    const gtK4gTekst = (polaGt?.tw_Pole8 || '').trim();

    // K4: porownanie TEKSTU lokalizacji. Ilosc w K4 zmienia sie przez sprzedaz w GT
    // (lokalizacja to stale miejsce SKU), wiec ilosci celowo NIE porownujemy.
    const k4 = { gt_tekst: gtK4, stan: klasyfikujZgodnosc(oczekiwane.miejsce_na_magazynie, gtK4) };

    // K4G: porownanie ILOSCI (Σ WMS vs stan GT). Roznica = czesc niezlokalizowana
    // lub nadmiar -> NZ. Dopiero gdy sumy rowne, sprawdzamy tekst pola (OK / OF / NZ).
    const wms = sumaWmsK4g.get(id) ?? 0;
    const gt = sumaGtK4g.get(id) ?? 0;
    let stanK4g;
    if (wms === 0 && gt === 0) {
      stanK4g = ZGODNOSC.PUSTE;
    } else if (wms === 0 && gt > 0) {
      stanK4g = ZGODNOSC.TYLKO_GT;
    } else if (wms !== gt) {
      stanK4g = ZGODNOSC.NIEZGODNE;
    } else if (oczekiwane.lokalizacja_zapas) {
      stanK4g = ZGODNOSC.OBCIETE; // sumy rowne, ale pole GT za krotkie na wszystkie wpisy
    } else {
      stanK4g = (polaGt?.tw_Pole8 || '').trim() === oczekiwane.lokalizacja_gorna ? ZGODNOSC.ZGODNE : ZGODNOSC.NIEZGODNE;
    }

    const k4g = { gt_tekst: gtK4gTekst, stan: stanK4g };
    const ogolna = obliczOgolna(k4.stan, k4g.stan);
    wynik.set(id, { k4, k4g, ogolna });
  }
  return wynik;
}

module.exports = {
  obliczPolaLokalizacji,
  synchronizujLokalizacje,
  kompresujLokalizacjeGorne,
  pobierzStatusLokalizacjiGt,
  pobierzAktualnePolaLokalizacji,
  pobierzPrzegladLokalizacji,
  bezAdnotacjiStref,
  zbudujAdnotacjeStref,
  zlozPole,
  decyzjaAdnotacji,
  SKROTY_STREF,
  ZGODNOSC,
};
