// Stala lista magazynow GT obslugiwanych przez WMS
const MAGAZYNY = [
  { kod: 'K4', nazwa: 'K4 Hala', typ: 'wms' },
  { kod: 'K4G', nazwa: 'K4 Góra', typ: 'wms' },
  { kod: 'MAG', nazwa: 'Kajtek', typ: 'zewnetrzny' },
  { kod: 'LS', nazwa: 'Leszno', typ: 'zewnetrzny' },
];

const MAGAZYNY_WMS = MAGAZYNY.filter((m) => m.typ === 'wms').map((m) => m.kod);
const MAGAZYNY_ZEWNETRZNE = MAGAZYNY.filter((m) => m.typ === 'zewnetrzny').map((m) => m.kod);

module.exports = { MAGAZYNY, MAGAZYNY_WMS, MAGAZYNY_ZEWNETRZNE };
