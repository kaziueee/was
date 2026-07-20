'use strict';

// Czysta arytmetyka pozycji wozka zwrotow - wydzielona (jak services/adnotacja-stref.js), zeby
// dala sie testowac bez SQLite i GT. Uzywana przez stanPozycjiWozka w routes/zwroty.js.

// Ile z pozycji wozka ZOSTALO do rozlozenia.
//   ilosc             - snapshot z chwili dolozenia na wozek (pozycje_wozka.ilosc)
//   rozlozonoDokument - iloscRozlozonaZDokumentu: SUMARYCZNIE, ile z calego dokumentu rozlozono
//                       (cala historia ruchow, niezaleznie od tego, kiedy pozycja trafila na wozek)
//   baza              - ile z dokumentu bylo juz rozlozone, GDY pozycja trafila na wozek
//                       (pozycje_wozka.rozlozono_baza)
//
// Odejmujemy baze, bo snapshot `ilosc` jest JUZ reszta po tym, co rozlozono PRZED dolozeniem na
// wozek. Bez tego rozlozenie sprzed dolozenia liczyloby sie DRUGI raz. Realny przypadek
// (BKR1904, 2026-07-20): z dokumentu PZ 2950 rozlozono 3 szt., a pozostala 1 szt. trafila potem
// na wozek jako snapshot=1. stanPozycjiWozka liczyl 1 - 3 = 0, pozycja wychodzila "rozlozona" i
// znikala z listy zwrotow (a klucz pozycji blokowal tez pokazanie zywego kubelka jako wolnego).
// Z baza=3: 1 - max(3 - 3, 0) = 1 - widoczna. Po rozlozeniu tej sztuki (rozlozonoDokument=4):
// 1 - max(4 - 3, 0) = 0 - zadanie domyka sie normalnie.
//
// Intencja "rozlozenie tego samego zwrotu z karty produktu zdejmuje pozycje takze z wozka"
// zostaje: dla pozycji dolozonej PRZED jakimkolwiek rozlozeniem baza=0 i wzor sprowadza sie do
// starego (ilosc - rozlozonoDokument).
function zostaloPozycji(ilosc, rozlozonoDokument, baza = 0) {
  const odDolozenia = Math.max((Number(rozlozonoDokument) || 0) - (Number(baza) || 0), 0);
  return Math.max((Number(ilosc) || 0) - odDolozenia, 0);
}

module.exports = { zostaloPozycji };
