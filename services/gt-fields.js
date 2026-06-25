'use strict';

// Kompresja lokalizacji WMS do pol wlasnych GT (kartoteka towaru) - patrz CLAUDE.md
// "Pola wlasne GT". Format wpisu: kod(ilosc), wpisy rozdzielone "; ".
// Limit pola: ~50 znakow ("Lokalizacja Górna"), overflow do "Lokalizacja Zapas"
// (rowniez ~50 znakow, ~100 lacznie). Jesli nadal sie nie miesci - obciecie + "...".
//
// Mapowanie na kolumny w bazie GT (potwierdzone na danych Z_KAJTEK_IdeaERP):
//   miejsce_na_magazynie -> tw__Towar.tw_Pole1   (standardowe pole dodatkowe, varchar(50))
//   lokalizacja_gorna    -> tw__Towar.tw_Pole8   (standardowe pole dodatkowe, varchar(50))
//   lokalizacja_zapas    -> vwPolaWlasne_Towar.pwd_Tekst09 (dynamiczne pole wlasne, wolne)

const db = require('../db/database');
const { query, naCzesci } = require('./gt-sql');

const LIMIT_POLA = 50;

function formatWpis(kod, ilosc) {
  return `${kod}(${Number(ilosc)})`;
}

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
  const k4 = db.prepare(`
    SELECT l.kod, s.zapas_kod FROM stany_lokalizacji s
    JOIN lokalizacje l ON l.id = s.lokalizacja_id
    WHERE s.artykul_gt_id = ? AND l.magazyn = 'K4' AND s.ilosc > 0
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
// znajduje sie w tym zbiorze. "Lokalizacja Zapas" (pwd_Tekst09, overflow K4G)
// jest pomijana - zostaje tylko w WMS, zob. PROGRESS.md "Otwarte".
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
    ustawienia.push('tw_Pole1 = @pole1');
    parametry.pole1 = pola.miejsce_na_magazynie;
  }
  if (dotyczyK4G) {
    ustawienia.push('tw_Pole8 = @pole8');
    parametry.pole8 = pola.lokalizacja_gorna;
  }

  try {
    await query(`UPDATE tw__Towar SET ${ustawienia.join(', ')} WHERE tw_Id = @id`, parametry);
    return { ok: true, dane: { sukces: true } };
  } catch (err) {
    return { ok: false, blad: `Zapis lokalizacji (SQL): ${err.message}` };
  }
}

// Pobiera aktualne wartosci pol lokalizacyjnych z GT (vwPolaWlasne_Towar) dla
// podanych tw_Id. Zwraca Map<tw_Id jako string, {tw_Pole1, tw_Pole8, pwd_Tekst09}>
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
      `SELECT tw_Id, tw_Pole1, tw_Pole8, pwd_Tekst09 FROM vwPolaWlasne_Towar WHERE tw_Id IN (${warunki})`,
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
  const gorna = (polaGt?.tw_Pole8 || '').trim();
  const zapas = (polaGt?.pwd_Tekst09 || '').trim();
  const k4g = [gorna, zapas].filter(Boolean).join('; ');

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
  // pwd_Tekst09 (zapas K4G) pomijamy - WMS go nie zapisuje (wymaga Sfery)
  return (polaGt?.tw_Pole1 || '').trim() === oczekiwane.miejsce_na_magazynie
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

    const gtK4 = (polaGt?.tw_Pole1 || '').trim();
    const gtK4gTekst = [(polaGt?.tw_Pole8 || '').trim(), (polaGt?.pwd_Tekst09 || '').trim()].filter(Boolean).join('; ');

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
    const ogolna = PRIORYTET_ZGODNOSCI.find((s) => s === k4.stan || s === k4g.stan);
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
  ZGODNOSC,
};
