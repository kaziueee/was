'use strict';

// Ile zestawów (komplet, tw_Rodzaj = 8) da się złożyć ze składników — czysta funkcja, testy w
// test/zestawy-model.test.js (bez GT). Zapytania do GT: services/gt-zestawy.js (doZlozeniaMapa).
//
// Zestaw ma w GT stan tylko po zmontowaniu (zwykle 0), a sprzedaje się go ze składników: Sellasist
// wystawia na platformy liczbę kompletów możliwych do złożenia. Stan „Razem” samego zestawu pokazywał
// więc 0 przy ofercie z tysiącami sztuk (SPIN20148990Z1: GT 0, eMAG 2187).
//
// Wzór sprawdzony na produkcji 2026-10-15 na 141 ofertach eMAG zestawów — zgodny co do sztuki
// w 117 (reszta to różnica czasu synchronizacji stanów): dla każdego składnika suma (stan − rezerwacja)
// na magazynach „Razem” (MAGAZYNY_RAZEM: K4+K4G+MAG+LS, bez BRK), podzielona przez ilość na zestaw,
// w dół; wynik = minimum po składnikach. Stanu zmontowanych zestawów Sellasist NIE dolicza
// (z doliczeniem zgodnych było mniej: 113).

// sklad: [{ skladnik: tw_Id, liczba }] — wiersze tw_Komplet jednego zestawu
// dostepne: Map(tw_Id składnika → stan − rezerwacja na magazynach Razem)
// → liczba kompletów, albo null gdy składu nie da się policzyć (brak wierszy w tw_Komplet, liczba ≤ 0)
function ileDoZlozenia(sklad, dostepne) {
  if (!sklad || !sklad.length) return null;   // skład nieokreślony w GT — nie zgadujemy
  // Ten sam składnik w dwóch wierszach (ręczny dubel) = jedna pula sztuk, liczby się sumują.
  const naZestaw = new Map();
  for (const { skladnik, liczba } of sklad) naZestaw.set(skladnik, (naZestaw.get(skladnik) || 0) + (Number(liczba) || 0));
  let wynik = Infinity;
  for (const [skladnik, liczba] of naZestaw) {
    if (!(liczba > 0)) return null;
    const d = Math.max(0, Number(dostepne.get(skladnik)) || 0);
    wynik = Math.min(wynik, Math.floor(d / liczba + 1e-9));   // kpl_Liczba to money (2.0000)
  }
  return wynik;
}

// Koszt zakupu zestawu do kalkulatora (Cennik + minimum repricera) — decyzja usera 2026-10-15:
// suma cen zakupu składników × ilość na zestaw, a nie cena zakupu z kartoteki zestawu. Kartoteka
// zestawu bywa nieaktualna w obie strony (106 ze 143 zestawów w repricerze różniło się o >5%:
// NERCHI10 8,41 zł vs składniki 2,32; NERCHIHOL50 2,70 vs 4,50 — tam automat mógłby zejść pod koszt).
// Z kartoteki bierzemy tylko wtedy, gdy składników nie da się wycenić w całości (brak składu albo
// składnik bez ceny zakupu) — połowiczna suma byłaby gorsza niż stara cena.
// Zestaw w zestawie: składnik-zestaw wchodzi swoją ceną z kartoteki (jeden poziom, jak w gt-zestawy).
// w: { rodzaj, koszt (kartoteka), kosztSkladnikow, skladnikow, skladnikowBezCeny }
function kosztZakupu(w) {
  const kartoteka = Number(w.koszt) || 0;
  if (Number(w.rodzaj) !== 8) return { koszt: kartoteka, zrodlo: 'kartoteka' };
  const n = Number(w.skladnikow) || 0, suma = Number(w.kosztSkladnikow) || 0;
  if (n > 0 && !(Number(w.skladnikowBezCeny) > 0) && suma > 0) return { koszt: +suma.toFixed(4), zrodlo: 'skladniki', kartoteka };
  return { koszt: kartoteka, zrodlo: 'kartoteka', kartoteka, uwaga: n ? 'składnik bez ceny zakupu' : 'zestaw bez składu w GT' };
}

module.exports = { ileDoZlozenia, kosztZakupu };
