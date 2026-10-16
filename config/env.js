'use strict';

// Jedno wejście konfiguracji dla KAŻDEGO procesu (WMS-Node, repricer, skrypty): `.env` przez
// dotenv, a na Windows dodatkowo sekrety z `.env.dpapi` (patrz `config/sekrety.js`).
// Zastępuje rozsiane `require('dotenv').config()` — wystarczy `require('../config/env')`, moduł
// wykonuje się raz na proces. Bezpośredni `dotenv` poza tym plikiem pilnuje test
// (`test/sekrety.test.js`): skrypt, który ominie ten loader, na produkcji nie zobaczy kluczy.
//
// Kolejność: zmienna już ustawiona w środowisku > `.env` > `.env.dpapi`. Jawny `.env` wygrywa
// celowo — nowy klucz (np. po rotacji) wpisuje się jak dotąd do `.env` i działa od razu, a potem
// `node scripts/sekrety.js zaszyfruj` przenosi go do pliku zaszyfrowanego.
//
// Błąd odszyfrowania NIE wywraca procesu: WMS bez kluczy API dalej obsługuje magazyn (GT, most),
// a moduły, którym brakuje klucza, same mówią „brak kluczy w .env". Za to krzyczymy w logu.

const fs = require('fs');
const dotenv = require('dotenv');
const sekrety = require('./sekrety');

dotenv.config({ quiet: true });

const plik = sekrety.sciezkaPliku();
let wczytane = [];
if (fs.existsSync(plik)) {
  try {
    wczytane = sekrety.uzupelnijEnv(process.env, sekrety.odszyfruj(plik));
  } catch (e) {
    console.error(`[sekrety] nie udało się odszyfrować ${plik}: ${e.message} — klucze API z tego pliku są niedostępne`);
  }
}

// Na produkcji przypominamy o jawnych sekretach, dopóki ktoś ich nie zaszyfruje. Na Macu
// (dev) DPAPI nie ma, więc `.env` z chmod 600 jest jedyną opcją — tam milczymy.
if (process.platform === 'win32') {
  try {
    const jawne = sekrety.jawneSekrety(fs.readFileSync('.env', 'utf8'));
    if (jawne.length) {
      console.error(`[sekrety] jawnym tekstem w .env: ${jawne.join(', ')} — zaszyfruj: node scripts/sekrety.js zaszyfruj`);
    }
  } catch { /* brak .env = nic do ostrzegania */ }
}

module.exports = { plik, wczytane };
