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
// bez myslnika - dzieki temu skan/wpis czyta obie formy do czasu wymiany naklejek.
// Kody spoza wzorca lokalizacji (RB, BIURO, SKU, EAN) zwracane bez zmian (uppercase/trim).
const WZORZEC_LUZNY = /^(M2)?([A-L])(\d{1,2})(?:P([1-6]))?$/;
function normalizujKodLokalizacji(kodSurowy) {
  const kod = String(kodSurowy ?? '').trim().toUpperCase();
  const bez = kod.replace(/[\s-]/g, '');
  const m = bez.match(WZORZEC_LUZNY);
  if (!m) return kod; // nie wyglada na kod lokalizacji - nie ruszamy (SKU/EAN/nazwane)
  const hala = m[1] ? 'M2-' : '';
  const poziom = m[4] ? `-P${m[4]}` : '';
  return `${hala}${m[2]}${m[3]}${poziom}`;
}

const TYPY = ['paleta', 'trawers', 'polka', 'inny'];

module.exports = { rozbierzKod, normalizujKodLokalizacji, TYPY };
