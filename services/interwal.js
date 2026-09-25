'use strict';

// Interwał joba z `.env`: minuty → milisekundy, z GÓRNYM ogranicznikiem.
//
// POWÓD: `setTimeout`/`setInterval` trzymają opóźnienie w 32 bitach ze znakiem. Wartość powyżej
// 2 147 483 647 ms (~24,8 dnia) NIE znaczy „bardzo rzadko" — Node ostrzega i zwija ją do **1 ms**,
// czyli job zaczyna lecieć w pętli tysiące razy na sekundę. Dla jobów, które piszą do GT
// (`strefy-w-gt` → `tw_Pole1`, `waga-gabarytowa` → `pw_Dane`, `rozjazdy` → auto-korekta K4),
// jedna literówka w `.env` zamienia więc „wyłącz na chwilę" w młotek na Subiekta: pula połączeń
// zapycha się w kilka sekund, a każdy przebieg to realne UPDATE-y. Złapane 2026-09-25 przy
// próbie zaparkowania jobów na czas podglądu (`ROZJAZDY_INTERWAL_MIN=100000` → setki
// „operation timed out" na sekundę).
//
// Clamp jest CICHYM ratunkiem tylko w skutkach — głośno mówi w logu, co zrobił, bo „job chodzi
// raz na dobę zamiast raz na 70 dni" to nie to, o co prosił człowiek w `.env`.
//
// Czysta funkcja (bez SQLite i GT) — testy w `test/interwal.test.js`.

const MAX_MS = 2 ** 31 - 1;          // limit setInterval (~24,8 dnia)
const MINUTA_MS = 60 * 1000;

// surowe    - wartość z .env (string/undefined/cokolwiek)
// domyslneMin - ile minut, gdy nie podano albo podano bzdurę
// nazwa     - nazwa zmiennej do komunikatu w logu
function interwalMsZMinut(surowe, domyslneMin, nazwa = 'interwał') {
  const min = Number(surowe);
  const uzyte = Number.isFinite(min) && min > 0 ? min : domyslneMin;
  const ms = uzyte * MINUTA_MS;
  if (ms <= MAX_MS) return ms;
  console.warn(`[${nazwa}] ${uzyte} min to ponad limit setInterval (~24,8 dnia) — `
    + `ścinam do ${Math.floor(MAX_MS / MINUTA_MS)} min. Bez tego Node zwinąłby to do 1 ms `
    + 'i job leciałby w pętli.');
  return MAX_MS;
}

module.exports = { interwalMsZMinut, MAX_MS, MINUTA_MS };
