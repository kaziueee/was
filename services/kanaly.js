'use strict';

// Mapowanie zamowienia klienta (ZK, dok__Dokument dok_Typ=16) z Subiekt GT na
// "kanal wysylki" - grupe kuriersko/platformowa, wg ktorej rozbijamy rezerwacje
// na liscie Uzupelnien K4. Rezerwacja na K4 (st_StanRez) ~ suma pozycji otwartych
// ZK (dok_Status=7); kazda taka pozycja dostaje kanal wg tego modulu.
//
// Sygnaly na ZK:
//   - pwd_Tekst01 (zrodlo)  : platforma+konto, np. "Amazon.de", "Emag Rumunia",
//                             "Allegro - ekajtek_pl", "Kaufland.de", "Empik"
//   - pwd_Tekst03 (dostawa) : metoda dostawy/kurier, np. "Allegro Paczkomaty24/7 InPost"
//   - dok_NrPelnyOryg (oryg): nr zewn. zamowienia; dla natywnych IDEA (puste pola
//                             wlasne) jedyny sygnal: "Am302-..._IDEA", "Kaufland_..._IDEA"
//   - dok_Uwagi (uwagi)     : nr zamowienia / tag platformy "[amazon]/[kaufland]/[emag*]"
//
// Reguly maja kolejnosc: PLATFORMA (DHL Connect / Emag) wygrywa z kurierem.
// Wyjatek: Amazon PL ("std-ez-pl") NIE jest DHL Connect - DHL Connect to tylko
// Amazon DE/FR (+Kaufland). Zweryfikowane na zywej bazie Z_KAJTEK_IdeaERP.

const KANALY = [
  'DHL Connect', 'InPost', 'DPD', 'DHL', 'UPS', 'One',
  'Orlen Paczka', 'Poczta Polska', 'Packeta', 'Emag', 'nieklasyfikowane',
];

// Slownik metoda dostawy (pwd_Tekst03, dokladne dopasowanie po normalizacji) -> kanal.
// Uzywany dopiero PO regulach platformowych (DHL Connect / Emag).
const DOSTAWA_KANAL = new Map(Object.entries({
  // InPost
  'allegro paczkomaty24/7 inpost': 'InPost',
  'paczkomaty inpost': 'InPost',                 // m.in. Empik - paczkomat zostaje InPost
  'paczkomat inpost': 'InPost',
  'inpost kurier': 'InPost',
  'allegro international kurier inpost': 'InPost',
  'erli inpost paczkomaty 24/7 - 25 kg': 'InPost',
  'std-ez-pl': 'InPost',                         // Amazon PL przez InPost
  // DPD (w tym kurierskie/salonowe warianty Empik)
  'allegro pickup dpd': 'DPD',
  'allegro one kurier dpd': 'DPD',
  'kurier dpd': 'DPD',
  'dpd pickup': 'DPD',
  'dpd_pickup': 'DPD',
  'erli dpd kurier - 10 kg': 'DPD',
  'dostawa do salonu empik': 'DPD',
  'kurier': 'DPD',                                // Empik (KURIER)
  'kurier - płatność za pobraniem': 'DPD',        // Empik pobranie
  // DHL
  'kurier dhl': 'DHL',
  'allegro kurier dhl': 'DHL',
  'allegro one kurier dhl': 'DHL',
  'kurier dhl pobranie': 'DHL',
  'dhl': 'DHL',
  'erli dhl kurier - 20 kg': 'DHL',
  // UPS
  'allegro one kurier ups': 'UPS',
  // One (Allegro One - bez wskazanego kuriera)
  'allegro one punkt, box': 'One',
  'allegro one kurier': 'One',
  'allegro international automat one': 'One',
  'allegro international punkt one': 'One',
  // Orlen Paczka
  'orlen paczka': 'Orlen Paczka',
  'allegro packeta orlen': 'Orlen Paczka',
  // Poczta Polska
  'pocztex kurier 48': 'Poczta Polska',
  'kurier pocztex 48': 'Poczta Polska',
  'poczta polska allegro odbiór w punkcie': 'Poczta Polska',
  'allegro packeta poczta': 'Poczta Polska',
  'allegro poczta': 'Poczta Polska',
  'erli pocztex kurier - (punkt - drzwi) - m': 'Poczta Polska',
  'erli pocztex punkty (żabka, orlen, ruch) - m': 'Poczta Polska',
  // Packeta (miedzynarodowe CZ/SK/HU)
  'allegro punkt packeta cz/sk/hu': 'Packeta',
  'allegro automat packeta cz/sk/hu': 'Packeta',
  'allegro punkt packeta cz/sk': 'Packeta',
  'allegro automat packeta cz/sk': 'Packeta',
  'allegro international automat czechy': 'Packeta',
  'allegro international kurier czechy': 'Packeta',
  'allegro international punkt czechy': 'Packeta',
  // Emag (gdyby reguly platformowej zabraklo - generyczne stringi)
  'parcel locker': 'Emag',
  'parcel locker cod': 'Emag',
  'courier': 'Emag',
  'courier cod': 'Emag',
}));

function norm(s) {
  return (s == null ? '' : String(s)).trim().toLowerCase();
}

// Czy zamowienie to Kaufland (kazda sciezka integracji).
function jestKaufland(zr, oryg, uw) {
  return zr.startsWith('kaufland') || oryg.startsWith('kaufland') || uw.includes('[kaufland');
}

// Czy szablon dostawy to Amazon DE/FR (a NIE Amazon PL "std-ez-pl").
function szablonDeFr(d) {
  return d.startsWith('std de') || d.startsWith('exp de') || d.startsWith('std fr')
    || d.startsWith('exp fr') || d === 'std' || d === 'de second' || d.includes('dhlde');
}

// Czy Amazon DE/FR -> DHL Connect. Natywne IDEA ("Am###...._IDEA", puste pola)
// rozpoznajemy po oryg; sciezka BaseLinker po zrodle+szablonie DE/FR.
function jestAmazonDeFr(zr, d, oryg, uw) {
  if (/^am\d/.test(oryg)) return true;                       // natywne IDEA
  const amazon = zr.startsWith('amazon') || uw.includes('[amazon');
  return amazon && szablonDeFr(d);                           // BaseLinker DE/FR (nie PL)
}

function jestEmag(zr, uw) {
  return zr.startsWith('emag') || uw.includes('[emag');
}

// Zwraca kanal wysylki dla ZK. Wejscie: pola pwd_Tekst01/03, dok_NrPelnyOryg, dok_Uwagi.
function kanalZK({ zrodlo, dostawa, oryg, uwagi } = {}) {
  const zr = norm(zrodlo);
  const d = norm(dostawa);
  const o = norm(oryg);
  const uw = norm(uwagi);

  // 1) Platforma ma priorytet
  if (jestKaufland(zr, o, uw)) return 'DHL Connect';
  if (jestAmazonDeFr(zr, d, o, uw)) return 'DHL Connect';
  if (jestEmag(zr, uw)) return 'Emag';

  // 2) Kurier wg metody dostawy
  const wg = DOSTAWA_KANAL.get(d);
  if (wg) return wg;

  // 3) brak rozpoznania (NULL/puste/Pigu/Baltyk/itp.)
  return 'nieklasyfikowane';
}

module.exports = { KANALY, kanalZK };
