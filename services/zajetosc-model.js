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

// Kolejnosc = kolejnosc zakladek na ekranie i kolumn w podsumowaniu. Idzie od "na pewno
// zajete" do "na pewno wolne", a tuz PRZED wolnymi stoi kubelek posredni: slot fizycznie
// pusty, ale z wlascicielem. Opisy sa tu, a nie we froncie, zeby nazwa statusu i jego
// znaczenie nie rozjechaly sie miedzy warstwami.
// `nazwa`/`opis` to ETYKIETY W UI (front bierze je z /slowniki), wiec z polskimi znakami.
//
// "Wolne do sprawdzenia" (kod `pusta_polka`) to dom SKU ze stanem 0: polka jest pusta, ale
// przypisana - adres siedzi w tw_Pole1 w Subiekcie i moze czekac na uzupelnienie z K4G.
// Nazwa mowi, co z tym zrobic (pojsc i sprawdzic, czy towar wroci - a jesli nie, zwolnic slot
// sciezka "Czysc zera"), a nie tylko jak to wyglada. Do liczby WOLNYCH nadal sie NIE liczy:
// nie dasz tego miejsca innemu towarowi, dopoki ktos nie potwierdzi, ze wlasciciel nie wraca.
const OPISY_STATUSOW = [
  { kod: STATUSY.ZAJETA, nazwa: 'Zajęte', opis: 'WMS wie, że leży tu towar' },
  { kod: STATUSY.TYLKO_GT, nazwa: 'Tylko GT', opis: 'WMS nic nie wie, ale pola GT opisują tu towar ze stanem' },
  { kod: STATUSY.PUSTA_POLKA, nazwa: 'Wolne do sprawdzenia', opis: 'Półka pusta, ale przypisana do SKU — może czekać na uzupełnienie; nie liczy się do wolnych' },
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

// --- RODZAJE WOLNEGO MIEJSCA ---
// "Ile mam wolnego" to za malo, zeby cokolwiek z tym zrobic: palety nie polozysz na polce
// regalowej, a drobnicy nie ma sensu wozic na gore. Stad trzy rozlaczne kubelki, ktore
// odpowiadaja trzem roznym pytaniom magazyniera:
//   K4G       - miejsce paletowe na gorze (zapas)
//   K4 polka  - polka regalowa na dole (drobnica, regaly E-J w hali 1)
//   K4        - reszta dolu: palety, trawersy i miejsca nazwane
// Pierwsze dopasowanie wygrywa, wiec K4 POLKA musi stac przed K4 (ten sam wzorzec, co
// grupaObchodu w services/kolejnosc-obchodu.js). Rozdzial idzie po `typ`, ktory i tak jest
// wyliczany z kodu - nie po nowej kolumnie.
const GRUPY_MIEJSC = [
  { kod: 'k4g', nazwa: 'K4 Góra', opis: 'Miejsca paletowe na górze', pasuje: (p) => p.magazyn === 'K4G' },
  { kod: 'k4_polka', nazwa: 'K4 półka', opis: 'Półki regałowe na K4 — drobnica', pasuje: (p) => p.magazyn === 'K4' && p.typ === 'polka' },
  { kod: 'k4', nazwa: 'K4', opis: 'Reszta K4: palety, trawersy, miejsca nazwane', pasuje: (p) => p.magazyn === 'K4' },
];

function grupaMiejsca(pozycja) {
  return GRUPY_MIEJSC.find((g) => g.pasuje(pozycja))?.kod ?? null;
}

// Wolne miejsce w rozbiciu na te trzy rodzaje. `wolnych` to suma 'wolna' + 'nietknieta' -
// oba znacza "tu da sie cos polozyc", roznia sie tylko PEWNOSCIA (czy WMS kiedykolwiek ten
// slot widzial). Dlatego naglowkowa liczba je laczy, a `nietknietych` stoi obok jako zastrzezenie
// - i jako ta sama liczba, ktora pokazuje zakladka "Nigdy nietkniete".
function podsumujWolne(pozycje) {
  const wynik = GRUPY_MIEJSC.map((g) => ({
    kod: g.kod, nazwa: g.nazwa, opis: g.opis,
    slotow: 0, wolnych: 0, nietknietych: 0, zajmowanych: 0, procent: 0,
  }));
  const wgKodu = new Map(wynik.map((w) => [w.kod, w]));

  for (const p of pozycje) {
    if (!liczyDoWolnych(p.przeznaczenie)) continue;     // kartony / strefa przyjec
    const w = wgKodu.get(grupaMiejsca(p));
    if (!w) continue;
    w.slotow += 1;
    if (STATUSY_WOLNE.has(p.status)) w.wolnych += 1;
    if (p.status === STATUSY.NIETKNIETA) w.nietknietych += 1;
  }

  for (const w of wynik) {
    w.zajmowanych = w.slotow - w.wolnych;
    w.procent = w.slotow > 0 ? Math.round((w.zajmowanych / w.slotow) * 100) : 0;
  }
  return wynik;
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

module.exports = {
  STATUSY, STATUSY_WOLNE, OPISY_STATUSOW, GRUPY_MIEJSC,
  statusLokalizacji, grupaMiejsca, podsumuj, podsumujWolne,
};
