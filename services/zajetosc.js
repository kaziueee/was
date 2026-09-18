'use strict';

// Przeglad zajetosci lokalizacji: dla KAZDEGO aktywnego slotu odpowiada, czy cos na nim
// lezy - i skad to wiemy. Zrodla sa trzy i kazde odpowiada na inne pytanie:
//   stany_lokalizacji  -> co WMS wie, ze tam lezy (master lokalizacji, zasada #2)
//   pola wlasne GT     -> co GT twierdzi, ze tam lezy (backlog nierozlozonego towaru)
//   ruchy + audyt      -> czy ktokolwiek kiedykolwiek tego slotu dotknal
//
// Czyste reguly klasyfikacji siedza w services/zajetosc-model.js - tutaj jest tylko
// zbieranie danych. GT jest tu WYMAGANE (route zwraca 503, gdy padnie): bez niego "wolne"
// jest po prostu nieprawda - na produkcji 68 z 231 pustych w WMS slotow mialo towar wg GT,
// a ekran, ktory kaze polozyc palete na zajetym miejscu, jest gorszy niz brak ekranu.

const db = require('../db/database');
const { pobierzLokalizacjeZPolGt } = require('./gt-produkty');
const { golyKod, poziomZKodu } = require('./lokalizacje-model');
const { statusLokalizacji, podsumuj } = require('./zajetosc-model');

// Sloty, ktorych WMS kiedykolwiek dotknal. Dwa zrodla, bo zadne samo nie wystarcza:
//   ruchy  - FK na lokalizacje, wiec przezywa zmiane kodu, ale tylko ruchy towaru,
//   audyt  - tekstowy kod, za to lapie tez zdarzenia bez ruchu (sprawdzenia, zwolnienia
//            slotu ze sciezki "Czysc zera"), czyli "ktos tam byl i popatrzyl".
// Wynik: Set kodow w formie GOLEJ (audyt trzyma kod tak, jak go wtedy zapisano - takze
// niekanonicznie, "L3P3" sprzed migracji 2026-08-04).
function slotyZHistoria() {
  const zRuchow = db.prepare(`
    SELECT kod FROM lokalizacje WHERE id IN (SELECT lok_zrodlo_id FROM ruchy WHERE lok_zrodlo_id IS NOT NULL)
    UNION
    SELECT kod FROM lokalizacje WHERE id IN (SELECT lok_cel_id FROM ruchy WHERE lok_cel_id IS NOT NULL)
  `).all();
  // Z audytu bierzemy tylko zdarzenia dotyczace TOWARU na slocie (artykul_gt_id niepuste) -
  // ruch, sprawdzenie ze sciezki, zwolnienie slotu. Edycja samej lokalizacji (magazyn, typ,
  // przeznaczenie) tez ma kod w audycie, ale nie mowi nic o tym, co na polce lezy: gdyby
  // liczyla sie jako historia, oznaczenie strefy kartonow zmienialoby "nigdy nietkniete" na
  // "wolne" - czyli sam fakt otagowania udawalby, ze ktos tam zajrzal.
  // Rozroznienie STRUKTURALNE (jest artykul czy nie), a nie lista akcji do utrzymywania.
  const zAudytu = db.prepare(
    `SELECT DISTINCT lokalizacja AS kod FROM audyt
     WHERE lokalizacja IS NOT NULL AND lokalizacja <> '' AND artykul_gt_id IS NOT NULL`
  ).all();
  return new Set([...zRuchow, ...zAudytu].map((w) => golyKod(w.kod)));
}

// Stan WMS per lokalizacja. Wiersz ze stanem 0 liczy sie do `pozycji`, ale nie do `sztuk` -
// na tym polega rozroznienie "pusta polka (dom SKU)" od "wolna".
function stanyWms() {
  const wiersze = db.prepare(`
    SELECT lokalizacja_id AS id, COUNT(*) AS pozycji, COALESCE(SUM(ilosc), 0) AS sztuk,
           SUM(CASE WHEN ilosc > 0 THEN 1 ELSE 0 END) AS pozycji_ze_stanem
    FROM stany_lokalizacji GROUP BY lokalizacja_id
  `).all();
  return new Map(wiersze.map((w) => [w.id, w]));
}

// Towary, ktore WMS zna na danej lokalizacji (do kolumny "co tu lezy").
function towaryWms(lokalizacjaIds) {
  const mapa = new Map();
  if (lokalizacjaIds.length === 0) return mapa;
  const paczki = [];
  for (let i = 0; i < lokalizacjaIds.length; i += 500) paczki.push(lokalizacjaIds.slice(i, i + 500));
  for (const paczka of paczki) {
    const wiersze = db.prepare(`
      SELECT lokalizacja_id, artykul_gt_id, artykul_symbol, artykul_nazwa, ilosc
      FROM stany_lokalizacji WHERE lokalizacja_id IN (${paczka.map(() => '?').join(', ')})
      ORDER BY ilosc DESC
    `).all(...paczka);
    for (const w of wiersze) {
      if (!mapa.has(w.lokalizacja_id)) mapa.set(w.lokalizacja_id, []);
      mapa.get(w.lokalizacja_id).push(w);
    }
  }
  return mapa;
}

// Ile sztuk artykulu WMS ma juz rozlozone w danym magazynie - do policzenia, ile z tego,
// co GT widzi na slocie, jest jeszcze NIEPRZYPISANE (to samo, co robi dolaczDaneGt dla
// karty produktu). Bez tego przycisk "przypisz" nie wiedzialby, jaka ilosc podpowiedziec.
function sumyWmsDlaArtykulow(artykulIds) {
  const mapa = new Map();
  if (artykulIds.length === 0) return mapa;
  const paczki = [];
  for (let i = 0; i < artykulIds.length; i += 500) paczki.push(artykulIds.slice(i, i + 500));
  for (const paczka of paczki) {
    const wiersze = db.prepare(`
      SELECT s.artykul_gt_id AS id, l.magazyn, COALESCE(SUM(s.ilosc), 0) AS suma
      FROM stany_lokalizacji s JOIN lokalizacje l ON l.id = s.lokalizacja_id
      WHERE s.artykul_gt_id IN (${paczka.map(() => '?').join(', ')})
      GROUP BY s.artykul_gt_id, l.magazyn
    `).all(...paczka);
    for (const w of wiersze) mapa.set(`${w.id}:${w.magazyn}`, Number(w.suma));
  }
  return mapa;
}

// Pelny przeglad. Zwraca { pozycje, podsumowanie } - bez filtrowania; filtry sa we froncie,
// bo caly zbior to ~2 tys. wierszy, a przelaczanie zakladek ma byc natychmiastowe.
async function przegladZajetosci() {
  const lokalizacje = db.prepare(`
    SELECT id, kod, magazyn, typ, przeznaczenie, hala, regal, alejka, strona, kolumna
    FROM lokalizacje WHERE aktywna = 1
    ORDER BY magazyn, (hala IS NULL), hala, regal, kolumna, kod
  `).all();

  const gtMapa = await pobierzLokalizacjeZPolGt();   // rzuca, gdy GT niedostepny - swiadomie
  const stany = stanyWms();
  const historia = slotyZHistoria();
  const towary = towaryWms(lokalizacje.map((l) => l.id));

  // Artykuly widziane przez GT na slotach, ktorych WMS nie zna - tylko dla nich liczymy
  // "ile zostalo do przypisania" (kilkaset, nie cala kartoteka).
  const doDeficytu = new Set();
  for (const l of lokalizacje) {
    if (stany.has(l.id)) continue;
    for (const t of gtMapa.get(golyKod(l.kod)) ?? []) doDeficytu.add(t.artykul_gt_id);
  }
  const sumyWms = sumyWmsDlaArtykulow([...doDeficytu]);

  const pozycje = lokalizacje.map((l) => {
    const stan = stany.get(l.id) ?? { pozycji: 0, sztuk: 0 };
    // GT bierzemy pod uwage tylko dla slotow, o ktorych WMS nic nie wie. Gdy WMS ma wiersz,
    // to on jest prawda (zasada #2), a pole GT bywa po prostu nieodswiezone.
    const wpisyGt = stan.pozycji > 0 ? [] : (gtMapa.get(golyKod(l.kod)) ?? []).map((t) => ({
      ...t,
      // ile z tego, co GT widzi na tym magazynie, nie ma jeszcze lokalizacji w WMS
      nieprzypisane: Math.max(0, t.stan - (sumyWms.get(`${t.artykul_gt_id}:${t.magazyn}`) ?? 0)),
      // Kod lokalizacji jest w WMS unikalny GLOBALNIE, wiec magazyn wynika z samego kodu.
      // Gdy GT opisuje ten kod w polu drugiego magazynu (K4-owy kod w "Lokalizacji Gornej"),
      // to blad danych w GT - ale slot i tak POKAZUJEMY jako "tylko GT" i oznaczamy rozjazd.
      // Ciche odsianie takiego wpisu bylo by najgorsza opcja: ekran nazwalby wolnym slot,
      // na ktorym cos stoi, a to jedyny blad, ktorego ten ekran nie moze popelnic.
      zgodny_magazyn: t.magazyn === l.magazyn,
    }));

    return {
      ...l,
      poziom: poziomZKodu(l.kod),
      sztuk: Number(stan.sztuk),
      pozycji: stan.pozycji,
      towary: towary.get(l.id) ?? [],
      gt: wpisyGt,
      status: statusLokalizacji({
        sztuk: Number(stan.sztuk),
        pozycji: stan.pozycji,
        wGt: wpisyGt.length > 0,
        historia: historia.has(golyKod(l.kod)),
      }),
    };
  });

  return { pozycje, podsumowanie: podsumuj(pozycje) };
}

module.exports = { przegladZajetosci };
