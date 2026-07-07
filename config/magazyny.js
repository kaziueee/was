// Stala lista magazynow GT obslugiwanych przez WMS.
// gtId = sl_Magazyn.mag_Id w bazie GT - uzywane przez Sfere przy wystawianiu MM
// (SuDokument.MagazynNadawczyId/MagazynOdbiorczyId). Zweryfikowane na Z_KAJTEK_IdeaERP.
const MAGAZYNY = [
  { kod: 'K4', nazwa: 'K4 Hala', typ: 'wms', gtId: 4 },
  { kod: 'K4G', nazwa: 'K4 Góra', typ: 'wms', gtId: 8 },
  { kod: 'MAG', nazwa: 'Kajtek', typ: 'zewnetrzny', gtId: 1 },
  { kod: 'LS', nazwa: 'Leszno', typ: 'zewnetrzny', gtId: 6 },
  { kod: 'BRK', nazwa: 'Braki', typ: 'zewnetrzny', gtId: 10, liczDoRazem: false },
];

// Mapa symbol -> mag_Id GT, do rozwiazywania magazynu przy wystawianiu MM.
const MAGAZYN_GT_ID = Object.fromEntries(MAGAZYNY.map((m) => [m.kod, m.gtId]));

const MAGAZYNY_WMS = MAGAZYNY.filter((m) => m.typ === 'wms').map((m) => m.kod);
const MAGAZYNY_ZEWNETRZNE = MAGAZYNY.filter((m) => m.typ === 'zewnetrzny').map((m) => m.kod);
// Magazyny wliczane do stanu "Razem" (K4+K4G+MAG+LS). BRK (braki) wykluczone -
// towar niepelnowartosciowy nie zawyza sumy "ile mam".
const MAGAZYNY_RAZEM = MAGAZYNY.filter((m) => m.liczDoRazem !== false).map((m) => m.kod);

module.exports = { MAGAZYNY, MAGAZYNY_WMS, MAGAZYNY_ZEWNETRZNE, MAGAZYNY_RAZEM, MAGAZYN_GT_ID };
