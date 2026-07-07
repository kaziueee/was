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
const { rozkladZgodnosci } = require('./gt-produkty');
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

// Przelicza i zapisuje rozklad statusow. Zwraca liczniki albo null przy bledzie.
async function odswiez() {
  try {
    const { licznik, razem } = await rozkladZgodnosci();
    STMT_ZAPIS.run({ klucz: 'statusy_zgodnosci', wartosc: JSON.stringify({ licznik, razem }) });
    return { licznik, razem };
  } catch (e) {
    awarie.blad('pulpit-snapshot', `nie policzono rozkladu zgodnosci: ${e.message}`);
    return null;
  }
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
