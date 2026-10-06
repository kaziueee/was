'use strict';

// Zadanie sprzedazowe: z dziennych sum sztuk z FS liczy trzy liczby do tabeli.
// Czyste funkcje (bez SQLite i GT) - testy w test/sprzedaz-model.test.js.
// Daty to napisy 'YYYY-MM-DD' (dzien kalendarzowy), wiec porownanie napisow = porownanie dat.

const DNI_PRZED = 28;   // punkt odniesienia: srednia tygodniowa z 4 tygodni przed startem

function dodajDni(data, dni) {
  const d = new Date(data + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + dni);
  return d.toISOString().slice(0, 10);
}

// Dzisiejsza data wg zegara serwera (pecet stoi w Polsce) - nie toISOString, bo to UTC
// i miedzy polnoca a 2:00 dawaloby wczoraj.
function dzisLokalnie(teraz = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${teraz.getFullYear()}-${p(teraz.getMonth() + 1)}-${p(teraz.getDate())}`;
}

// Od kiedy trzeba pobrac FS, zeby policzyc wszystkie kolumny dla zadania od `od`.
function zakresOd(od, dzis) {
  const przed = dodajDni(od, -DNI_PRZED);
  const tydzien = dodajDni(dzis, -6);
  return przed < tydzien ? przed : tydzien;
}

// dni: [{ dzien: 'YYYY-MM-DD', szt }] dla jednego towaru.
function podsumujSprzedaz(dni, od, dzis) {
  const przedOd = dodajDni(od, -DNI_PRZED);
  const tydzienOd = dodajDni(dzis, -6);    // 7 dni razem z dzisiejszym
  let odStartu = 0, ostatnie7 = 0, przed = 0;
  for (const { dzien, szt } of dni) {
    const n = Number(szt) || 0;
    if (dzien >= od && dzien <= dzis) odStartu += n;
    if (dzien >= tydzienOd && dzien <= dzis) ostatnie7 += n;
    if (dzien >= przedOd && dzien < od) przed += n;
  }
  return {
    od_startu: odStartu,
    ostatnie_7_dni: ostatnie7,
    przed_tygodniowo: Math.round((przed / (DNI_PRZED / 7)) * 10) / 10,
  };
}

module.exports = { DNI_PRZED, dodajDni, dzisLokalnie, zakresOd, podsumujSprzedaz };
