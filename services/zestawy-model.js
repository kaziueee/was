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

module.exports = { ileDoZlozenia };
