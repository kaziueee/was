'use strict';

// Snapshot metryk pulpitu drogich do policzenia na zywo (Faza 5). Dzis: rozklad
// statusow zgodnosci GT<->WMS (rozkladZgodnosci krzyzuje ~2300 SKU z GT, kilka
// sekund + wymaga zywego mostu). Zamiast liczyc przy kazdym otwarciu pulpitu -
// godzinny job zapisuje wynik do tabeli pulpit_snapshot. Pulpit czyta gotowe
// liczby: laduje sie natychmiast i pokazuje statusy nawet gdy most chwilowo padnie
// (z adnotacja "stan na HH:MM").
//
// NIE rzuca - awaria snapshotu (np. most GT niedostepny) nie moze wywrocic procesu
// ani zablokowac reszty pulpitu; idzie do logu awarii, a pulpit pokazuje ostatni
// udany snapshot (albo "brak danych", jesli jeszcze zadnego nie bylo).

const db = require('../db/database');
const { rozkladZgodnosci, listujProdukty } = require('./gt-produkty');
const gtDokumenty = require('./gt-dokumenty');
const doRozlozenia = require('./do-rozlozenia');
// Sam rachunek "do sprawdzenia" mieszka w route, bo tam jest jego jedyny inny konsument.
// Bierzemy stamtad `zbierz`, zeby nie miec drugiej implementacji - kafel i lista MUSZA
// pokazywac te sama liczbe.
const doSprawdzenia = require('../routes/do-sprawdzenia');
const awarie = require('./awarie');

const DOMYSLNY_INTERWAL_MS = 60 * 60 * 1000; // 1 godzina (jak job rozjazdow)
const OPOZNIENIE_STARTU_MS = 30 * 1000;      // pierwszy przebieg 30 s po starcie (nie blokuje bootu)

const STMT_ZAPIS = db.prepare(`
  INSERT INTO pulpit_snapshot (klucz, wartosc, obliczono)
  VALUES (@klucz, @wartosc, CURRENT_TIMESTAMP)
  ON CONFLICT(klucz) DO UPDATE SET wartosc = @wartosc, obliczono = CURRENT_TIMESTAMP
`);

// Odczyt snapshotu (dla routes/pulpit). Zwraca { wartosc, obliczono } lub null.
function odczytaj(klucz) {
  const w = db.prepare('SELECT wartosc, obliczono FROM pulpit_snapshot WHERE klucz = ?').get(klucz);
  if (!w) return null;
  try {
    return { wartosc: JSON.parse(w.wartosc), obliczono: w.obliczono };
  } catch {
    return null;
  }
}

// Liczniki kafli "do zrobienia" - kazdy to pytanie do GT, wiec nie moga isc na zywo:
// /api/pulpit jest synchroniczny i ma sie ladowac natychmiast oraz dzialac przy padnietym
// Subiekcie. Tu licza sie raz na godzine, a kafel klika sie na ZYWA liste - dokladnie jak
// istniejacy kafel "Do zlokalizowania (t_GT)".
//
// Kazdy licznik ma wlasny try/catch: jedno padniete zapytanie (np. dlugi timeout GT) nie moze
// zabrac pozostalych trzech. Brak wyniku = null -> front pokazuje kafel z "—", nie zero
// (zero znaczy "sprawdzone, nie ma nic" i to zupelnie inna informacja).
async function policzKafle() {
  const wynik = {};
  const licz = async (klucz, fn) => {
    try { wynik[klucz] = await fn(); } catch (e) {
      wynik[klucz] = null;
      awarie.blad('pulpit-snapshot', `kafel ${klucz}: ${e.message}`);
    }
  };

  await Promise.all([
    licz('nadsprzedaz', async () => (await listujProdukty({ zestawienie: 'nadsprzedaz', limit: 1 })).total),
    licz('leszno', async () => (await listujProdukty({ zestawienie: 'leszno', limit: 1 })).total),
    licz('przywozka', async () => {
      const k = await gtDokumenty.pobierzTowaryZPrzywozkamiK4();
      return (await doRozlozenia.zbierz(k, 'przywozki')).length;
    }),
    licz('zwroty', async () => {
      const k = await gtDokumenty.pobierzTowaryZeZwrotamiK4();
      return (await doRozlozenia.zbierz(k, 'zwroty')).length;
    }),
    licz('dostawy', async () => {
      const k = await gtDokumenty.pobierzTowaryZDostawamiK4();
      return (await doRozlozenia.zbierz(k, 'dostawy')).length;
    }),
    // Kafel liczy TYLKO "nieznany przychod" (WMS zna miejsce, a stan GT urosl poza naszym
    // obiegiem), a NIE cale "do sprawdzenia". Powod: druga polowa tej listy to backlog
    // migracyjny (~2300 SKU, ktorych WMS nigdy nie poznal) - on zjedzie do zera dopiero po
    // miesiacach lokalizowania i stalby na Pulpicie jako wielka liczba, ktora nic nie mowi
    // o DZISIAJ. Nieznany przychod to sygnal operacyjny: w zdrowym stanie zero, a kazda
    // niezerowa wartosc znaczy "wczoraj ktos dolozyl towar poza WMS-em".
    // Backlog widac osobno jako kafel "Do zlokalizowania (t_GT)" - dzieki temu dwa kafle
    // wreszcie mierza dwie ROZNE rzeczy.
    //
    // Predykat bierzemy z routes/do-sprawdzenia (RODZAJE), zeby kafel i zakladka "Nieznany
    // przychod" nie mogly sie rozjechac.
    //
    // Liczy sie tu, a nie na zadanie, bo zbierz() to ~800 ms i przemiata WSZYSTKIE SKU ze
    // stanem na K4 (~2800). Klikniecie kafla otwiera ZYWA liste, wiec licznik jest wskazowka
    // "czy jest co robic", nie zrodlem prawdy.
    licz('do_sprawdzenia', async () =>
      (await doSprawdzenia.zbierz()).filter(doSprawdzenia.RODZAJE.przyjecie_wewn).length),
  ]);
  return wynik;
}

// Przelicza i zapisuje snapshoty. Zwraca liczniki zgodnosci albo null przy bledzie.
// Sekcje sa niezalezne - blad jednej nie przerywa drugiej.
async function odswiez() {
  let statusy = null;
  try {
    const { licznik, razem } = await rozkladZgodnosci();
    STMT_ZAPIS.run({ klucz: 'statusy_zgodnosci', wartosc: JSON.stringify({ licznik, razem }) });
    statusy = { licznik, razem };
  } catch (e) {
    awarie.blad('pulpit-snapshot', `nie policzono rozkladu zgodnosci: ${e.message}`);
  }

  try {
    STMT_ZAPIS.run({ klucz: 'kafle_do_zrobienia', wartosc: JSON.stringify(await policzKafle()) });
  } catch (e) {
    awarie.blad('pulpit-snapshot', `nie policzono kafli: ${e.message}`);
  }

  return statusy;
}

// Godzinny job + pierwszy przebieg krotko po starcie. Timery unref() - nie blokuja
// zamkniecia procesu.
function start(interwalMs = DOMYSLNY_INTERWAL_MS) {
  const pierwszy = setTimeout(() => { odswiez(); }, OPOZNIENIE_STARTU_MS);
  pierwszy.unref?.();
  const timer = setInterval(() => { odswiez(); }, interwalMs);
  timer.unref?.();
  return timer;
}

module.exports = { odswiez, odczytaj, start };
