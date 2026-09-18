'use strict';

// Przeglad zajetosci lokalizacji - CZYSTE reguly "czym jest ten slot".
// Osobny plik od services/zajetosc.js (ktore chodzi do SQLite i GT), zeby dalo sie je
// testowac bez bazy - test/zajetosc-model.test.js.
//
// Po co osobne statusy zamiast "wolna / zajeta": magazynier pyta "gdzie moge to polozyc",
// a na to pytanie sama tabela stanow WMS odpowiada ZLE w dwie strony:
//   - slot bez wiersza w WMS bywa pelny, bo towar opisany jest tylko w polach GT
//     (na produkcji 2026-09-18: 68 z 231 "wolnych" slotow mialo towar wg GT),
//   - slot z wierszem 0 sztuk na K4 jest pusty, ale NIE wolny - to dom SKU, ktory czeka
//     na uzupelnienie (patrz CLAUDE.md "Lokalizacja K4 przezywa stan 0").
// Rozdzielenie tych przypadkow jest cala trescia tego ekranu.

const { liczyDoWolnych } = require('./lokalizacje-model');

const STATUSY = {
  ZAJETA: 'zajeta',
  PUSTA_POLKA: 'pusta_polka',
  TYLKO_GT: 'tylko_gt',
  WOLNA: 'wolna',
  NIETKNIETA: 'nietknieta',
};

// Kolejnosc = kolejnosc kolumn w podsumowaniu i zakladek na ekranie (od "zajete" do
// "na pewno puste"). Opisy sa tu, a nie we froncie, zeby nazwa statusu i jego znaczenie
// nie rozjechaly sie miedzy warstwami.
// `nazwa`/`opis` to ETYKIETY W UI (front bierze je z /slowniki), wiec z polskimi znakami.
const OPISY_STATUSOW = [
  { kod: STATUSY.ZAJETA, nazwa: 'Zajęte', opis: 'WMS wie, że leży tu towar' },
  { kod: STATUSY.PUSTA_POLKA, nazwa: 'Puste półki', opis: 'Dom SKU ze stanem 0 — czeka na uzupełnienie, nie jest wolny' },
  { kod: STATUSY.TYLKO_GT, nazwa: 'Tylko GT', opis: 'WMS nic nie wie, ale pola GT opisują tu towar ze stanem' },
  { kod: STATUSY.WOLNA, nazwa: 'Wolne', opis: 'Puste w WMS i w GT; slot był już kiedyś używany' },
  { kod: STATUSY.NIETKNIETA, nazwa: 'Nigdy nietknięte', opis: 'Jak wyżej, ale WMS nigdy nie zapisał tu żadnego ruchu' },
];

// Statusy oznaczajace "tu da sie cos polozyc". Flaga na definicji, nie lista w drugim
// pliku - nowy status trzeba opisac TUTAJ i sam wejdzie do sum (lekcja z config/magazyny.js).
const STATUSY_WOLNE = new Set([STATUSY.WOLNA, STATUSY.NIETKNIETA]);

// sztuk    - suma ilosci w WMS na tej lokalizacji
// pozycji  - liczba wierszy stany_lokalizacji (wiersz z zerem TEZ sie liczy: to dom SKU)
// wGt      - czy pola wlasne GT opisuja tu towar ze stanem (patrz pobierzLokalizacjeZPolGt)
// historia - czy slot wystepuje w ruchach/audycie WMS
//
// Kolejnosc warunkow = "prawda WMS przed domyslem z GT": wiersz w stany_lokalizacji zawsze
// wygrywa, bo to nasz master lokalizacji (zasada #2). GT rozstrzyga tylko tam, gdzie WMS
// milczy - i wtedy jest jedynym zrodlem, jakie mamy.
function statusLokalizacji({ sztuk = 0, pozycji = 0, wGt = false, historia = false } = {}) {
  if (pozycji > 0 && sztuk > 0) return STATUSY.ZAJETA;
  if (pozycji > 0) return STATUSY.PUSTA_POLKA;
  if (wGt) return STATUSY.TYLKO_GT;
  return historia ? STATUSY.WOLNA : STATUSY.NIETKNIETA;
}

// Podsumowanie per magazyn. `poza_analiza` to sloty o przeznaczeniu innym niz magazynowe
// (kartony, strefa przyjec) - NIE sa wolnym miejscem na towar, wiec wypadaja ze wszystkich
// licznikow i maja wlasny. Przeznaczenie nie blokuje odkladania tam towaru; wypada tylko
// z rachunku "ile mam wolnego miejsca".
function podsumuj(pozycje) {
  const wynik = new Map();
  for (const p of pozycje) {
    if (!wynik.has(p.magazyn)) {
      wynik.set(p.magazyn, {
        magazyn: p.magazyn,
        aktywnych: 0,          // wszystkie aktywne sloty magazynu
        magazynowych: 0,       // z tego: przeznaczone na towar (baza wszystkich procentow)
        poza_analiza: 0,       // kartony / strefa przyjec / inne
        ...Object.fromEntries(OPISY_STATUSOW.map((s) => [s.kod, 0])),
        wolnych: 0,            // wolna + nietknieta
        zajmowanych: 0,        // magazynowych - wolnych ("miejsce, ktorego nie dostaniesz")
        procent: 0,
      });
    }
    const w = wynik.get(p.magazyn);
    w.aktywnych += 1;
    if (!liczyDoWolnych(p.przeznaczenie)) {
      w.poza_analiza += 1;
      continue;
    }
    w.magazynowych += 1;
    w[p.status] += 1;
    if (STATUSY_WOLNE.has(p.status)) w.wolnych += 1;
  }

  for (const w of wynik.values()) {
    w.zajmowanych = w.magazynowych - w.wolnych;
    w.procent = w.magazynowych > 0 ? Math.round((w.zajmowanych / w.magazynowych) * 100) : 0;
  }
  return [...wynik.values()];
}

module.exports = { STATUSY, STATUSY_WOLNE, OPISY_STATUSOW, statusLokalizacji, podsumuj };
