'use strict';

// Wspolne reguly wyszukiwania "po czesci nazwy" - uzywane zarowno przy
// wyszukiwaniu w GT (services/gt-produkty.js, SQL Server) jak i w lokalnej
// bazie WMS (routes/lokalizacje.js, SQLite). Oba dialekty SQL wspieraja
// LIKE ... ESCAPE '\', wiec dzielenie frazy na slowa i escapowanie jest
// wspolne - budowa zapytania (parametry nazwane vs pozycyjne) zostaje po
// stronie kazdego z modulow.
//
// Kazde slowo z frazy musi pasowac do poczatku nazwy albo poczatku
// jakiegos wyrazu w nazwie (w dowolnej kolejnosci), wiec np. "Nerf Echo"
// znajdzie tez "Nerf N-Strike Elite Echo", a samo "Echo" nie znajdzie
// "grzechotki".

const LIMIT_WYSZUKIWANIA = 100;
const MAX_SLOW_W_FRAZIE = 8;

// Escapuje znaki specjalne LIKE (% _ [ \), zeby byly traktowane dosownie.
function escapeLike(tekst) {
  return tekst.replace(/[\\%_[]/g, (znak) => `\\${znak}`);
}

// Dzieli fraze na pojedyncze slowa (max MAX_SLOW_W_FRAZIE), kazde juz
// escapowane pod LIKE. Pusta/whitespace fraza -> [].
function podzielNaSlowa(fraza) {
  return fraza.trim().split(/\s+/).filter(Boolean).slice(0, MAX_SLOW_W_FRAZIE).map(escapeLike);
}

module.exports = { escapeLike, podzielNaSlowa, LIMIT_WYSZUKIWANIA, MAX_SLOW_W_FRAZIE };
