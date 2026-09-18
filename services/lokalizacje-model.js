// Model lokalizacji: rozbior kodu na cechy strukturalne (hala, regal, alejka, strona,
// kolumna, poziom, typ). Deterministyczny - wyliczany z samego kodu wg regul mapy
// magazynu (zob. memory mapa-lokalizacji / arkusz lokalizacje-do-importu.xlsx).
// Ten sam parser sluzy importowi zbiorczemu i dodaniu pojedynczej lokalizacji.
//
// Format kodu (atomowy WMS): [M2-]<REGAL><KOLUMNA>[-P<POZIOM>]
//   A1        -> hala 1,  regal A, kolumna 1
//   E5-P3     -> hala 1,  regal E, kolumna 5   (poziom P3 zostaje w kodzie, nie w kolumnie)
//   M2-J14-P2 -> hala M2, regal J, kolumna 14
// Poziom (-P<n>) nie jest osobna cecha - wynika wprost z kodu. Regex go akceptuje
// (zeby kod z poziomem byl rozpoznany jako prawidlowy), ale nie zwracamy go osobno.
// Kody spoza wzorca (RB, BIURO, ...) -> typ 'inny', reszta cech null.

// regal (litera) -> alejka (para regalow) + strona; identyczne dla obu hal.
// A,B=alejka1 · C,D=2 · E,F=3 · G,H=4 · I,J=5 · K,L=6; nieparzysta litera='a', parzysta='b'.
function regalNaAlejkeStrone(regal) {
  const poz = regal.charCodeAt(0) - 64; // A=1 .. L=12
  if (poz < 1 || poz > 12) return { alejka: null, strona: null };
  return { alejka: Math.ceil(poz / 2), strona: poz % 2 === 1 ? 'a' : 'b' };
}

// typ = f(magazyn, hala, regal). Reguly wg usera (2026-07-02):
//   - K4G   -> zawsze 'paleta' (K4G to lokalizacje paletowe od poziomu P2 w gore)
//   - K4:
//       regal C,D,K              -> 'trawers' (paleta dzielona na pol wysokosci: podstawa + P1)
//       regal E-J, hala 1        -> 'polka'   (regaly polkowe P1-P6)
//       regal E-J, hala M2       -> 'trawers' (M2 nie ma polek - w miejsce polek trawersy)
//       regal A,B,L              -> 'paleta'
// Poziom (P1 vs P2...) nie wchodzi do reguly - typ zalezy od (magazyn, hala, regal).
const TRAWERS_ZAWSZE = new Set(['C', 'D', 'K']);
const POLKOWE = new Set(['E', 'F', 'G', 'H', 'I', 'J']);

function typLokalizacji(magazyn, hala, regal) {
  if (!regal) return 'inny';
  if (magazyn === 'K4G') return 'paleta';
  if (TRAWERS_ZAWSZE.has(regal)) return 'trawers';
  if (POLKOWE.has(regal)) return hala === 'M2' ? 'trawers' : 'polka';
  return 'paleta'; // A, B, L
}

const WZORZEC_KODU = /^(M2-)?([A-L])(\d{1,2})(?:-P([1-6]))?$/i;

// Zwraca cechy strukturalne dla kodu, lub obiekt typu 'inny' gdy kod nie pasuje do wzorca.
// magazyn (K4|K4G) wplywa TYLKO na typ (K4G=paleta); reszta cech jest z kodu.
function rozbierzKod(kodSurowy, magazyn) {
  const kod = String(kodSurowy ?? '').trim().toUpperCase();
  const m = kod.match(WZORZEC_KODU);
  if (!m) {
    // RB, BIURO, KARINA, sciany itp. - lokalizacja spoza siatki regalow (typ 'inny')
    return { hala: null, regal: null, alejka: null, strona: null, kolumna: null, typ: 'inny' };
  }
  const hala = m[1] ? 'M2' : '1';
  const regal = m[2].toUpperCase();
  const kolumna = Number(m[3]);
  const { alejka, strona } = regalNaAlejkeStrone(regal);
  return { hala, regal, alejka, strona, kolumna, typ: typLokalizacji(magazyn, hala, regal) };
}

// Kod bez myslnikow/spacji -> postac kanoniczna z myslnikami (A8P2 -> A8-P2,
// M2A8P2 -> M2-A8-P2, a8-p2 -> A8-P2). Czesc etykiet na magazynie ma stare kody
// bez myslnika (najwiecej w regale L) - dzieki temu skan/wpis czyta obie formy.
// Zwraca null, gdy kod NIE jest kodem siatki regalow (RB, BIURO, SKU, EAN) - dzieki
// temu wolajacy wie, czy w ogole ma do czynienia z lokalizacja z siatki.
const WZORZEC_LUZNY = /^(M2)?([A-L])(\d{1,2})(?:P([1-6]))?$/;
function kanonicznyKodSiatki(kodSurowy) {
  const bez = String(kodSurowy ?? '').trim().toUpperCase().replace(/[\s-]/g, '');
  const m = bez.match(WZORZEC_LUZNY);
  if (!m) return null;
  const hala = m[1] ? 'M2-' : '';
  const poziom = m[4] ? `-P${m[4]}` : '';
  return `${hala}${m[2]}${m[3]}${poziom}`;
}

// Postac kanoniczna kodu do ZAPISU i do lookupu. Kody spoza siatki (RB, BIURO, SKU, EAN)
// zwracane bez zmian (uppercase/trim) - tam nie mamy czego kanonizowac.
//
// UWAGA: jedyna postac, w jakiej kod lokalizacji wolno TRZYMAC w bazie. Zapis surowego kodu
// (jak przed 2026-08-04) tworzyl wiersze typu "L3P3", ktorych zaden lookup juz nie znajdowal:
// kazde szukanie normalizuje wejscie do "L3-P3", a takiego wiersza nie bylo. Skutek na
// produkcji: czesc lokalizacji w regale L (i C17P3) byla niewidoczna dla skanu mimo towaru.
function normalizujKodLokalizacji(kodSurowy) {
  return kanonicznyKodSiatki(kodSurowy) ?? String(kodSurowy ?? '').trim().toUpperCase();
}

// Kod bez myslnikow/spacji - do porownan "ta sama lokalizacja, inny zapis" (L3-P3 == L3P3).
// Uzywane przez fallback lookupu dla starych, niekanonicznych wierszy.
const golyKod = (kodSurowy) => String(kodSurowy ?? '').trim().toUpperCase().replace(/[\s-]/g, '');

// Poziom polki z kodu (-P<n>). Nie ma go w bazie jako kolumny - wynika wprost z kodu -
// ale przydaje sie do filtrow i do oznaczania hurtem ("wszystkie P5-P6 w regalach E-J to
// kartony"). Kod spoza siatki albo bez poziomu -> null.
function poziomZKodu(kod) {
  const m = String(kod ?? '').trim().toUpperCase().match(/P(\d+)$/);
  return m ? Number(m[1]) : null;
}

const TYPY = ['paleta', 'trawers', 'polka', 'inny'];

// PRZEZNACZENIE lokalizacji - po co ten slot w ogole jest. Osobne od `typ` (ksztalt polki,
// wyliczany z kodu): tu decyduje CZLOWIEK, bo z kodu "G8-P2" nie wynika, ze stoja tam kartony.
//
// To ETYKIETA DO ANALIZY, a nie blokada: na strefie przyjec czy w kartonach wolno polozyc
// towar (np. biezaca dostawa) i zaden endpoint tego nie odrzuca. Przeznaczenie mowi tylko,
// czy slot ma sie liczyc do pytania "ile mam wolnego miejsca na towar" - bo pusta strefa
// przyjec nie jest wolnym miejscem, tylko pusta strefa przyjec.
//
// `liczDoWolnych` jest FLAGA NA DEFINICJI, nie reczna lista gdzie indziej (lekcja z
// config/magazyny.js): nowe przeznaczenie dodaje sie tutaj i samo wypada z sum tam, gdzie
// trzeba - zamiast czekac, az ktos dopisze je do listy wykluczen w drugim pliku.
const PRZEZNACZENIA = [
  // `nazwa` jest ETYKIETA W UI (front bierze ja z /slowniki), wiec z polskimi znakami -
  // tak samo jak nazwy magazynow w config/magazyny.js.
  { kod: 'towar', nazwa: 'Towar', liczDoWolnych: true },
  { kod: 'kartony', nazwa: 'Kartony', liczDoWolnych: false },
  { kod: 'przyjecia', nazwa: 'Strefa przyjęć', liczDoWolnych: false },
  { kod: 'inne', nazwa: 'Inne (nie licz)', liczDoWolnych: false },
];
const PRZEZNACZENIA_KODY = PRZEZNACZENIA.map((p) => p.kod);
const PRZEZNACZENIE_DOMYSLNE = 'towar';
const PRZEZNACZENIA_MAGAZYNOWE = new Set(PRZEZNACZENIA.filter((p) => p.liczDoWolnych).map((p) => p.kod));

// Czy slot ma sie liczyc do analizy wolnego miejsca na TOWAR. Nieznane/puste przeznaczenie
// (wiersze sprzed migracji) traktujemy jak 'towar' - domyslnie kazdy slot jest magazynowy.
function liczyDoWolnych(przeznaczenie) {
  if (!przeznaczenie) return true;
  return PRZEZNACZENIA_MAGAZYNOWE.has(przeznaczenie);
}

// --- tokeny lokalizacji z pol wlasnych GT (tw_Pole1 / tw_Pole8) ---
//
// Pola GT to TEKST pisany recznie i skladany przez WMS, nie kod lokalizacji:
//   tw_Pole1: "M2-J14-P2"  |  "C14P1 /L19P3 /"  |  "M2-J14-P2 +StD20"  (dopisek stref)
//   tw_Pole8: "M2-C3-P3(126); M2-C4-P3(288)"                          (kod + ilosc)
// Rozbijamy to na kody w formie GOLEJ (bez myslnikow), bo ta sama polka siedzi w GT w obu
// ortografiach ("M2-B3-P3" obok "C14P1") - myslnik jest tu ortografia, nie znaczeniem.
//
// Nawias z iloscia MUSI zlecic: bez tego zaden kod z tw_Pole8 nie pasowal do niczego
// ("M2C6P2(3)" != "M2C6P2"), a taki ksztalt ma 1071 z 1511 niepustych pol na produkcji -
// czyli skan lokalizacji K4G nie pokazywal towarow "tylko GT" w ogole.
const ILOSC_W_NAWIASIE = /\(\s*\d+(?:[.,]\d+)?\s*\)$/;

function tokenyLokalizacjiZPola(pole) {
  if (!pole) return [];
  const { bezAdnotacjiStref } = require('./adnotacja-stref');   // czyste, bez SQLite/GT
  return bezAdnotacjiStref(pole)
    .toUpperCase()
    .split(/[\s/,;]+/)
    .map((token) => golyKod(token.replace(ILOSC_W_NAWIASIE, '')))
    .filter((token) => token.length >= 2);
}

// Czy `kod` wystepuje w polu GT jako PELNY CZLON (nie dowolny podciag - "C16" to nie
// "M2-C16-P2"). Czysta funkcja: uzywa jej i skan lokalizacji (gt-produkty), i przeglad
// zajetosci (services/zajetosc) - jedna definicja "ten kod jest opisany w GT".
function kodJestTokenemLokalizacji(pole, kod) {
  const cel = golyKod(kod);
  if (!cel) return false;
  return tokenyLokalizacjiZPola(pole).includes(cel);
}

module.exports = {
  rozbierzKod, normalizujKodLokalizacji, kanonicznyKodSiatki, golyKod, TYPY, poziomZKodu,
  tokenyLokalizacjiZPola, kodJestTokenemLokalizacji,
  PRZEZNACZENIA, PRZEZNACZENIA_KODY, PRZEZNACZENIE_DOMYSLNE, liczyDoWolnych,
};
