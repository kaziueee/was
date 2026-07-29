'use strict';

// Kolejnosc przystankow na obchodzie "Ostatnie sztuki". Czyste funkcje - test bez SQLite/GT
// (jak adnotacja-stref.js / rozbij-stan-k4). Domyslnie obchod idzie po kodzie lokalizacji
// (kolejnosc zbierania), ale kilka rodzajow pozycji spychamy na KONIEC, bo kazdy wymaga innej
// uwagi niz zwykle liczenie pelnej polki:
//   1. egzemplarz poprezentacyjny / uszkodzony (symbol na 'p'/'u' + istnieje baza w GT),
//   2. czesc stanu czeka w strefie (nierozlozona dostawa/zwrot - liczenie samej polki mniej pewne),
//   3. caly stan K4 zarezerwowany (nic z polki nie ruszysz - najnizszy priorytet weryfikacji),
//   4. SKU policzone niedawno na obchodzie, ktore WROCILO na liste po przypisaniu lokalizacji.
// Grupy rosnaco = coraz dalej na koniec: zwykle < p/u < strefa < pelna rez < policzone-niedawno.
// Kolejnosc p/u/strefa/rez wg zyczenia usera (2026-07-24): p/u PRZED strefami i pelna rezerwacja.
//
// Grupa "policzone niedawno" (zmiana 2026-07-30) rozwiazuje konkretny przypadek: na obchodzie
// czesto PO sprawdzeniu przypisujemy SKU lokalizacje (przypisanie = zmiana lokalizacji). Para
// (artykul+STARA lokalizacja) jest w audycie jako sprawdzona, ale item ma juz NOWA lokalizacje,
// wiec wyklucznie-po-parze (DNI_POMIN_SPRAWDZONE) go nie lapie i wraca na liste - w dodatku
// sortem po nowej lokalizacji WYPRZEDZAJAC pozycje, ktore w ogole nie byly jeszcze liczone.
// Rozpoznajemy go PER SKU (a nie per para, bo lokalizacja sie zmienila) i dajemy na sam koniec:
// nigdy nie moze stac przed czyms, czego nikt jeszcze nie policzyl.

// Litery wariantu: 'u' = uszkodzony, 'p' = poprezentacyjny (ex-display). Sam suffix NIE
// wystarcza za rozpoznanie - "870BLU" (niebieski), "1696HU" (wegierski), "F2713P" (zwykly
// Star Wars) tez koncza sie na u/p. Wariant potwierdza dopiero istnienie BAZOWEGO symbolu
// (patrz oznaczWariantyPU w gt-produkty.js) - tu tylko WYLICZAMY kandydatow na baze.
const SEP_WARIANTU = /[-_/ ]$/;

// Mozliwe symbole bazowe dla symbolu-wariantu: obetnij ostatnia litere (p/u); gdy po tym
// zostal na koncu separator (np. "ANGAB-15-U" -> "ANGAB-15-") - obetnij tez separator.
// Zwracamy OBIE formy, bo obie konwencje wystepuja w GT: "ANE0858U" (bez separatora) i
// "ANGAB-15-U" (z separatorem). Pusta lista, gdy symbol nie konczy sie na p/u.
function bazySymboluWariantu(symbol) {
  const s = String(symbol || '').trim();
  if (!/[pu]$/i.test(s)) return [];
  const bazy = [s.slice(0, -1)];
  if (SEP_WARIANTU.test(bazy[0])) bazy.push(bazy[0].replace(SEP_WARIANTU, ''));
  return bazy.filter(Boolean);
}

// Numery grup (0 = najpierw, 4 = na sam koniec).
const GRUPA_ZWYKLA = 0;
const GRUPA_WARIANT_PU = 1;
const GRUPA_STREFA = 2;
const GRUPA_PELNA_REZ = 3;
const GRUPA_POLICZONE_NIEDAWNO = 4;

// Grupa pozycji w kolejnosci obchodu. Flagi przychodza z zewnatrz (wymagaja zrodel, ktorych
// czysta funkcja nie zna):
//   - `sprawdzoneNiedawno`: SKU ma swieze sprawdzenie w audycie (per SKU, zob. naglowek pliku),
//   - `jestWariantemPU`: rozpoznanie p/u wymaga zapytania do GT o symbol bazowy.
// Reszte czytamy wprost z pozycji. Kolejnosc IF wymusza priorytet "najdalszej" cechy:
//   - policzone niedawno bije WSZYSTKO (idzie na sam koniec - nie moze wyprzedzic nieliczonych),
//   - pelna rezerwacja: caly stan K4 zablokowany (rez >= stan, stan > 0),
//   - strefa: chocby 1 szt. czeka poza polka (w_strefach > 0),
//   - p/u: egzemplarz poprezentacyjny/uszkodzony.
// Pozycja i zarezerwowana, i w strefie ladzie w rezerwacji; i w strefie, i p/u - w strefie.
// Stan 0 NIE jest "pelna rezerwacja" (0 >= 0), co chroni przed zaklasyfikowaniem pustej pozycji
// jako zablokowanej.
function grupaObchodu(p, { jestWariantemPU = false, sprawdzoneNiedawno = false } = {}) {
  if (sprawdzoneNiedawno) return GRUPA_POLICZONE_NIEDAWNO;
  const stan = Number(p.stan) || 0;
  const rez = Number(p.rezerwacja) || 0;
  if (stan > 0 && rez >= stan) return GRUPA_PELNA_REZ;
  if (Number(p.w_strefach) > 0) return GRUPA_STREFA;
  if (jestWariantemPU) return GRUPA_WARIANT_PU;
  return GRUPA_ZWYKLA;
}

// Komparator obchodu: najpierw grupa, w obrebie grupy po kodzie lokalizacji (kolejnosc
// zbierania), a przy rownym kodzie po symbolu. Kontekst zbierany raz przed sortem:
//   - wariantyPU: Set symboli uznanych za poprezentacyjne/uszkodzone,
//   - sprawdzoneSku: Set artykul_gt_id policzonych niedawno na obchodzie (per SKU).
function porownajObchod(a, b, { wariantyPU, sprawdzoneSku }) {
  const flagi = (p) => ({
    jestWariantemPU: wariantyPU.has(p.symbol),
    sprawdzoneNiedawno: sprawdzoneSku.has(p.artykul_gt_id),
  });
  const ga = grupaObchodu(a, flagi(a));
  const gb = grupaObchodu(b, flagi(b));
  return (ga - gb)
    || (a.lokalizacja_kod || '').localeCompare(b.lokalizacja_kod || '')
    || (a.symbol || '').localeCompare(b.symbol || '');
}

module.exports = {
  bazySymboluWariantu,
  grupaObchodu,
  porownajObchod,
  GRUPA_ZWYKLA,
  GRUPA_WARIANT_PU,
  GRUPA_STREFA,
  GRUPA_PELNA_REZ,
  GRUPA_POLICZONE_NIEDAWNO,
};
