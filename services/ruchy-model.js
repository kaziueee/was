'use strict';

// Czysta logika ruchow - osobny plik, zeby dalo sie ja testowac bez SQLite i GT
// (test/ruchy-model.test.js).

// Magazyny WMS dotkniete ruchem = te, dla ktorych trzeba przeliczyc pola lokalizacyjne
// w GT (tw_Pole1 / tw_Pole8). Poza lokalizacja zrodlowa i docelowa liczy sie TEZ
// `mag_zrodlo_pula`: rozlozenie (POST /ruchy/rozloz) nie ma lokalizacji zrodlowej, bo
// zrodlem jest NIEPRZYPISANA pula magazynu ("towar wg GT lezy na K4, ale WMS nie wie gdzie").
//
// Bez puli w tym zbiorze rozlozenie jednego towaru na K4 i K4G "w jednym podejsciu"
// zostawialo tw_Pole1 puste na zawsze (zgloszenie MATJFG56-JCR38, 2026-08-13):
//   1. LOK 40 szt. z puli K4 na polke K4 - w GT lezy jeszcze 48, wiec deficyt K4 = 8
//      i synchronizujLokalizacje SWIADOMIE pomija tw_Pole1 (niepelne rozlozenie),
//   2. MM 8 szt. z tej samej puli K4 na K4G - deficyt K4 spada do 0, ale magazyny = {K4G},
//      bo zrodlem byla pula, nie lokalizacja => tw_Pole1 nie jest juz przeliczane.
// Efekt: WMS ma dom M2-J14, GT ma puste pole => status NZ mimo poprawnie rozlozonego towaru.
// Kolejnosc odwrotna (najpierw K4G, potem K4) dziala od zawsze - stad "czasem sie zdarza".
//
// `wmsZnaPule` = czy WMS ma w tym magazynie JAKIKOLWIEK wiersz dla artykulu. Gdy nie ma,
// puli NIE dokladamy: wyliczone pole byloby puste, a pusty string kasuje pole w GT - skasowalby
// adres, ktory istnieje WYLACZNIE w GT (recznie wpisany, np. "RB/A18 /"). Ten ruch nic z tego
// magazynu w WMS nie zabral, wiec nie ma prawa czyscic cudzego wpisu.
function magazynyRuchu({ magZrodlo, magCel, magPula, wmsZnaPule = false } = {}) {
  const magazyny = new Set();
  if (magZrodlo) magazyny.add(magZrodlo);
  if (magCel) magazyny.add(magCel);
  if (magPula && wmsZnaPule) magazyny.add(String(magPula).trim().toUpperCase());
  return magazyny;
}

module.exports = { magazynyRuchu };
