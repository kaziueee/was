// Stala lista magazynow GT obslugiwanych przez WMS.
// gtId = sl_Magazyn.mag_Id w bazie GT - uzywane przez Sfere przy wystawianiu MM
// (SuDokument.MagazynNadawczyId/MagazynOdbiorczyId). Zweryfikowane na Z_KAJTEK_IdeaERP.
const MAGAZYNY = [
  { kod: 'K4', nazwa: 'K4 Hala', typ: 'wms', gtId: 4 },
  { kod: 'K4G', nazwa: 'K4 Góra', typ: 'wms', gtId: 8 },
  // zapasDlaK4: false - stan w Kajtku NIE jest powodem, zeby trzymac slot na K4 (decyzja
  // usera 2026-07-19, sciezka "Czysc zera"). Do sumy "Razem" nadal sie liczy - to dwa rozne
  // pytania: "ile mam" (liczy sie) vs "czy ten towar wroci na regal zbioru" (nie wroci).
  { kod: 'MAG', nazwa: 'Kajtek', typ: 'zewnetrzny', gtId: 1, zapasDlaK4: false },
  { kod: 'LS', nazwa: 'Leszno', typ: 'zewnetrzny', gtId: 6 },
  { kod: 'BRK', nazwa: 'Braki', typ: 'zewnetrzny', gtId: 10, liczDoRazem: false },
  // Reklamacje: jak BRK - towar niepelnowartosciowy, wlasna kolumna i MM w obie strony,
  // ale wypada z sumy "Razem" (decyzja usera 2026-07-17). W GT mag_Id 9 = K4R.
  //
  // naZebrze: false - reklamacje to proces BIURKOWY, nie robota na hali (decyzja usera).
  // Kolektor ich nie pokazuje i nie pozwala nimi ruszac; obsluga zostaje na desktopie.
  // Magazyn nadal istnieje w rachunkach (stany, "do sprawdzenia", zgodnosc) - chowamy
  // go tylko przed magazynierem, a nie przed systemem.
  { kod: 'K4R', nazwa: 'Reklamacje', typ: 'zewnetrzny', gtId: 9, liczDoRazem: false, naZebrze: false },
];

// Magazyny GT, ktorych WMS swiadomie NIE obsluguje - trzymane tu, zeby nastepna osoba nie
// musiala zgadywac, czy ich brak to decyzja, czy przeoczenie (sl_Magazyn ma 9 pozycji):
//   3 SR  Srem, 5 ZW Zestawy Wirtualne, 7 KAK Magazyn Kartonow

// Mapa symbol -> mag_Id GT, do rozwiazywania magazynu przy wystawianiu MM.
const MAGAZYN_GT_ID = Object.fromEntries(MAGAZYNY.map((m) => [m.kod, m.gtId]));

const MAGAZYNY_WMS = MAGAZYNY.filter((m) => m.typ === 'wms').map((m) => m.kod);
const MAGAZYNY_ZEWNETRZNE = MAGAZYNY.filter((m) => m.typ === 'zewnetrzny').map((m) => m.kod);
// Magazyny wliczane do stanu "Razem" (K4+K4G+MAG+LS). BRK (braki) wykluczone -
// towar niepelnowartosciowy nie zawyza sumy "ile mam".
const MAGAZYNY_RAZEM = MAGAZYNY.filter((m) => m.liczDoRazem !== false).map((m) => m.kod);
// Magazyny, ktorych stan uzasadnia TRZYMANIE slotu na K4 (sciezka "Czysc zera") = K4+K4G+LS.
// Wezsze niz MAGAZYNY_RAZEM o MAG. Skladane z liczDoRazem, wiec BRK i K4R (towar
// niepelnowartosciowy) wypadaja same - nie trzeba ich powtarzac przy kazdej nowej fladze.
const MAGAZYNY_ZAPAS_K4 = MAGAZYNY
  .filter((m) => m.liczDoRazem !== false && m.zapasDlaK4 !== false)
  .map((m) => m.kod);

module.exports = { MAGAZYNY, MAGAZYNY_WMS, MAGAZYNY_ZEWNETRZNE, MAGAZYNY_RAZEM, MAGAZYNY_ZAPAS_K4, MAGAZYN_GT_ID };
