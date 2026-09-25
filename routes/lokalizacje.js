const express = require('express');
const db = require('../db/database');
const { MAGAZYNY_WMS } = require('../config/magazyny');
const { podzielNaSlowa, LIMIT_WYSZUKIWANIA } = require('../services/wyszukiwanie');
const { znajdzTowarPoKodzie, pobierzPodstawoweInfo, szukajProdukty, szukajPoLokalizacjiGt, pobierzStanyGt } = require('../services/gt-produkty');
const kartoteka = require('../services/kartoteka');
const { unikalneIdy } = require('../services/kartoteka-model');
const { pobierzStatusLokalizacjiGt, synchronizujLokalizacje, pobierzPrzegladLokalizacji } = require('../services/gt-fields');
const gtDokumenty = require('../services/gt-dokumenty');
const gtZestawy = require('../services/gt-zestawy');
const audyt = require('../services/audyt');
const { rozbierzKod, normalizujKodLokalizacji, kanonicznyKodSiatki, golyKod, TYPY,
  PRZEZNACZENIA, PRZEZNACZENIA_KODY } = require('../services/lokalizacje-model');
const { OPISY_STATUSOW } = require('../services/zajetosc-model');
const { przegladZajetosci } = require('../services/zajetosc');

const router = express.Router();

const SQLITE_CONSTRAINT_UNIQUE = 2067;

// Lookup lokalizacji po zeskanowanym/wpisanym kodzie. Dwa podejscia, w tej kolejnosci:
//  1. postac KANONICZNA (A8P2 -> A8-P2) - tak zapisujemy kody od 2026-08-04,
//  2. fallback po formie GOLEJ (bez myslnikow) - dla starych wierszy zapisanych niekanonicznie.
// Fallback jest potrzebny, bo do 2026-08-04 zapis (POST/import/PUT) bral kod DOSLOWNIE, wiec
// w bazie wyladowaly wiersze typu "L3P3" czy "C17P3" - niewidoczne dla lookupu, ktory pytal
// juz o "L3-P3". Na produkcji objawialo sie to jako "czesc lokalizacji w regale L sie nie czyta".
// Fallback odpalamy TYLKO dla kodow z siatki regalow (kanonicznyKodSiatki != null), zeby skan
// SKU/EAN nie trafial przypadkiem w lokalizacje o podobnym zapisie.
function znajdzLokalizacjePoKodzie(kodSurowy) {
  const trafienie = db.prepare('SELECT * FROM lokalizacje WHERE kod = ?')
    .get(normalizujKodLokalizacji(kodSurowy));
  if (trafienie) return trafienie;
  const kanonSiatki = kanonicznyKodSiatki(kodSurowy);
  if (!kanonSiatki) return null;
  return db.prepare(
    "SELECT * FROM lokalizacje WHERE REPLACE(REPLACE(kod, '-', ''), ' ', '') = ?"
  ).get(golyKod(kanonSiatki)) ?? null;
}

// GET /api/lokalizacje - lista lokalizacji (filtry: ?magazyn=, ?aktywna=, ?q=)
router.get('/', (req, res) => {
  const { magazyn, aktywna, q } = req.query;
  let sql = 'SELECT * FROM lokalizacje WHERE 1=1';
  const params = [];

  if (magazyn) {
    sql += ' AND magazyn = ?';
    params.push(magazyn);
  }
  if (aktywna !== undefined) {
    sql += ' AND aktywna = ?';
    params.push(aktywna === '1' || aktywna === 'true' ? 1 : 0);
  }
  if (q) {
    sql += ' AND kod LIKE ?';
    params.push(`%${q}%`);
  }
  // Kolejnosc jak w pliku mapy: magazyn, hala (1 przed M2), regal (A..L), kolumna
  // NUMERYCZNIE (A1, A2, ... A10, A11 - nie tekstowo), na koncu kod (tiebreak poziomu:
  // A1, A1-P2, A1-P3). Lokalizacje "inny" (bez struktury) na koniec danego magazynu.
  sql += ' ORDER BY magazyn, (hala IS NULL), hala, regal, kolumna, kod';

  // limit (do podpowiedzi typeahead - nie zwracamy setek lokalizacji na raz)
  const limit = Math.min(Number(req.query.limit) || 0, 100);
  if (limit > 0) { sql += ' LIMIT ?'; params.push(limit); }

  res.json(db.prepare(sql).all(...params));
});

// --- tozsamosc artykulu: kluczem jest tw_Id, nie symbol ---
//
// `stany_lokalizacji.artykul_symbol` to KOPIA z GT zapisana przy wstawieniu wiersza (odswieza ja
// services/kartoteka.js). Symbol w Subiekcie wolno zmienic, tw_Id nie - wiec kopia moze wskazywac
// na towar, ktory dzis nazywa sie inaczej, albo (gdy stary symbol zostal przejety przez inna
// karte) na DWA rozne towary naraz. Tak powstal incydent "Ulica Sezamkowa" z 2026-09-16: lookup
// po symbolu sklejal Berta i Erniego w jedna karte, a skan poprawnego, nowego symbolu mowil
// "brak lokalizacji WMS" mimo 39 szt. na polkach. Dlatego kod ze skanu rozwiazuje na tw_Id GT
// (master kartoteki), a WMS pytamy juz TYLKO po tw_Id.

const KOLUMNY_LOKALIZACJI = `s.lokalizacja_id, l.kod, l.magazyn, s.artykul_gt_id, s.artykul_symbol,
  s.artykul_nazwa, s.ilosc, s.zapas_kod, s.ostatnia_zmiana`;

function kartaZWierszy(wiersze) {
  if (wiersze.length === 0) return null;
  return {
    artykul_gt_id: wiersze[0].artykul_gt_id,
    artykul_symbol: wiersze[0].artykul_symbol,
    artykul_nazwa: wiersze[0].artykul_nazwa,
    lokalizacje: wiersze.map(({ lokalizacja_id, kod, magazyn, ilosc, zapas_kod, ostatnia_zmiana }) => ({ lokalizacja_id, kod, magazyn, ilosc, zapas_kod, ostatnia_zmiana }))
  };
}

// lokalizacje WMS z zapasem dla tw_Id (lub null gdy brak) - jedyny pewny klucz
function lokalizacjeDlaArtykuluPoId(artykulGtId) {
  return kartaZWierszy(db.prepare(
    `SELECT ${KOLUMNY_LOKALIZACJI}
     FROM stany_lokalizacji s
     JOIN lokalizacje l ON l.id = s.lokalizacja_id
     WHERE s.artykul_gt_id = ? AND s.ilosc > 0
     ORDER BY l.kod`
  ).all(String(artykulGtId)));
}

// tw_Id, ktore w kopii WMS nosza dany symbol / EAN. Wiecej niz jedno = KOLIZJA: dwa rozne
// towary pod jednym kodem. Nie rozstrzygamy jej zgadywaniem (dawne `wiersze[0]` pokazywalo
// pierwszy alfabetycznie i doklejalo mu cudze polki) - wybor nalezy do czlowieka.
function idyPoSymbolu(symbol) {
  return unikalneIdy(db.prepare(
    'SELECT DISTINCT artykul_gt_id FROM stany_lokalizacji WHERE artykul_symbol = ? AND ilosc > 0'
  ).all(symbol).map((w) => w.artykul_gt_id));
}

function idyPoEan(ean) {
  return unikalneIdy(db.prepare(
    'SELECT DISTINCT artykul_gt_id FROM stany_lokalizacji WHERE artykul_ean = ? AND ilosc > 0'
  ).all(ean).map((w) => w.artykul_gt_id));
}

// Tozsamosc do wyboru przy kolizji - etykiety z kopii WMS (GT wlasnie nie odpowiada, inaczej
// nie bylibysmy na tej sciezce). Bierzemy dowolny wiersz artykulu, takze z iloscia 0.
function artykulyPoIdach(idy) {
  const stmt = db.prepare(
    'SELECT artykul_gt_id, artykul_symbol, artykul_nazwa FROM stany_lokalizacji WHERE artykul_gt_id = ? LIMIT 1'
  );
  return idy.map((id) => stmt.get(String(id))).filter(Boolean);
}

// AWARYJNY lookup po kopii symbolu/EAN - dla kodow, ktorych GT nie zna (lokalne dane testowe)
// oraz na czas, gdy GT nie odpowiada. Zwraca {karta}, {kolizja: [tw_Id, ...]} albo null.
function kartaLokalnaPoKodzie(kod) {
  for (const idy of [idyPoSymbolu(kod), idyPoEan(kod)]) {
    if (idy.length === 0) continue;
    if (idy.length > 1) return { kolizja: idy };
    return { karta: lokalizacjeDlaArtykuluPoId(idy[0]) };
  }
  return null;
}

// szukanie artykulow po (czesci) nazwy wsrod wszystkich artykulow, ktore
// kiedykolwiek mialy lokalizacje w WMS (niezaleznie od biezacego stanu -
// filtrowanie po stanie to rola checkboxa "Ukryj produkty bez stanu" na
// froncie). Kazde slowo z frazy musi pasowac do poczatku nazwy albo poczatku
// jakiegos wyrazu w nazwie (w dowolnej kolejnosci), zob. services/wyszukiwanie.js.
// Kazdy wynik ma dolaczona liste stanow per magazyn (do podgladu na liscie
// wyboru), wyniki posortowane wg trafnosci, a nastepnie wg lacznego stanu malejaco.
function szukajArtykulowPoNazwie(fraza) {
  const slowa = podzielNaSlowa(fraza);
  if (slowa.length === 0) return [];

  const params = [];
  const warunkiSlow = slowa.map((slowo) => {
    params.push(`${slowo}%`, `% ${slowo}%`);
    return `(artykul_nazwa LIKE ? ESCAPE '\\' OR artykul_nazwa LIKE ? ESCAPE '\\')`;
  }).join(' AND ');

  const artykuly = db.prepare(
    `SELECT DISTINCT artykul_gt_id, artykul_symbol, artykul_nazwa
     FROM stany_lokalizacji
     WHERE ${warunkiSlow}
     ORDER BY
       CASE WHEN artykul_nazwa LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,
       artykul_nazwa
     LIMIT ?`
  ).all(...params, `${slowa[0]}%`, LIMIT_WYSZUKIWANIA);

  const stanyStmt = db.prepare(
    `SELECT l.magazyn, SUM(s.ilosc) AS ilosc
     FROM stany_lokalizacji s
     JOIN lokalizacje l ON l.id = s.lokalizacja_id
     WHERE s.artykul_gt_id = ? AND s.ilosc > 0
     GROUP BY l.magazyn
     ORDER BY l.magazyn`
  );

  const wyniki = artykuly.map((a) => ({ ...a, stany: stanyStmt.all(a.artykul_gt_id) }));

  // produkty z najwiekszym lacznym stanem na gorze, reszta zachowuje
  // kolejnosc trafnosci/alfabetyczna z zapytania (sort jest stabilny)
  wyniki.sort((a, b) => sumaStanowLokalnych(b.stany) - sumaStanowLokalnych(a.stany));

  return wyniki;
}

function sumaStanowLokalnych(stany) {
  return stany.reduce((suma, s) => suma + s.ilosc, 0);
}

// GET /api/lokalizacje/artykul-id/:artykul_gt_id - lokalizacje WMS z zapasem dla tw_Id.
// Wariant do uzytku wewnetrznego: kto ma tw_Id (desktop ma je przy kazdym produkcie), pyta tedy
// i nie zalezy od tego, czy kopia symbolu jest aktualna.
router.get('/artykul-id/:artykul_gt_id', (req, res) => {
  const wynik = lokalizacjeDlaArtykuluPoId(req.params.artykul_gt_id);
  if (!wynik) {
    return res.status(404).json({ blad: 'Brak lokalizacji WMS z zapasem dla tego artykulu' });
  }
  res.json(wynik);
});

// GET /api/lokalizacje/artykul/:symbol - lokalizacje WMS z zapasem dla danego SKU.
// Szuka po KOPII symbolu, wiec moze trafic na kolizje (jeden symbol, dwa tw_Id) - wtedy 409
// zamiast cichego wyboru pierwszego z brzegu.
router.get('/artykul/:symbol', (req, res) => {
  const idy = idyPoSymbolu(req.params.symbol);
  if (idy.length > 1) {
    return res.status(409).json({
      blad: `Symbol ${req.params.symbol} nosza w WMS ${idy.length} rozne artykuly (tw_Id ${idy.join(', ')}) - kopia symbolu jest nieaktualna. Otworz towar z listy produktow.`,
      artykuly: artykulyPoIdach(idy),
    });
  }
  const wynik = idy.length === 1 ? lokalizacjeDlaArtykuluPoId(idy[0]) : null;
  if (!wynik) {
    return res.status(404).json({ blad: 'Brak lokalizacji WMS z zapasem dla tego SKU' });
  }
  res.json(wynik);
});

// produkt znaleziony w katalogu GT, ale bez zapasu na lokalizacji WMS
// (jeszcze nie zlokalizowany) - lokalizacje puste, frontend pokazuje
// odpowiedni komunikat zamiast pustej listy do wyboru
function artykulZGt(produktGt) {
  return {
    artykul_gt_id: produktGt.artykul_gt_id,
    artykul_symbol: produktGt.symbol,
    artykul_nazwa: produktGt.nazwa,
    lokalizacje: [],
  };
}

// Dolacza do odpowiedzi /skan dane z GT wspolne dla "karty produktu" na
// wszystkich ekranach (zob. public/zebra/karta-produktu.js):
//   stany_gt        - stan GT per magazyn (K4/K4G/MAG/LS), zob. gt-produkty.js
//   lokalizacja_gt  - {tekst, zgodna} wg pol wlasnych GT, zob. gt-fields.js;
//                      zgodna=false oznacza rozjazd miedzy GT a biezacym
//                      stanem WMS (frontend pokazuje wtedy ikone ❌)
// W razie bledu polaczenia z GT zwraca payload bez zmian - niedostepnosc GT
// nie blokuje podstawowych funkcji WMS.
async function dolaczDaneGt(payload) {
  try {
    let idy;
    if (payload.typ === 'lokalizacja') {
      idy = payload.zawartosc.map((p) => p.artykul_gt_id);
    } else if (payload.typ === 'artykul') {
      idy = [payload.artykul_gt_id];
    } else if (payload.typ === 'lista_artykulow') {
      idy = payload.artykuly.map((a) => a.artykul_gt_id);
    } else {
      return payload;
    }

    const [stanyMap, statusMap, przegladMap, zestawyMap] = await Promise.all([
      pobierzStanyGt(idy),
      pobierzStatusLokalizacjiGt(idy),
      pobierzPrzegladLokalizacji(idy),
      gtZestawy.wZestawachMapa(idy),
    ]);

    // GT odpowiedzial - od tego miejsca brak stanu znaczy "zero", a nie "nie wiem". Bez tej
    // flagi obu przypadkow nie da sie odroznic na froncie (przy padnietym GT payload wraca
    // BEZ stany_gt, dokladnie tak samo jak dla towaru, ktorego GT nie zna), wiec ekran musial
    // zgadywac - a sprawdzarka na tym zgadywaniu pokazywala pewne "0 szt." dla towaru lezacego
    // na polce. Ustawiamy tu, a nie na koncu: po tej linii nic juz nie wola GT.
    payload.gt_ok = true;

    // {k4, k4g, ogolna} z enumem OK/t_GT/NZ/BD/OF (jak w tabeli desktopu) - do badge'a statusu na froncie
    const zgodnoscZPrzegladu = (id) => {
      const p = przegladMap.get(String(id));
      return p ? { k4: p.k4?.stan, k4g: p.k4g?.stan, ogolna: p.ogolna } : null;
    };

    const wzbogac = (item) => ({
      ...item,
      stany_gt: stanyMap.get(String(item.artykul_gt_id)),
      lokalizacja_gt: statusMap.get(String(item.artykul_gt_id)),
      zgodnosc: zgodnoscZPrzegladu(item.artykul_gt_id),
      // Ile sztuk tego SKU jest zamrozone w zestawach zmontowanych na K4 (zob. gt-zestawy.js).
      // Fizycznie na polce = stan GT K4 + w_zestawach - front pokazuje to jak rezerwacje.
      w_zestawach: zestawyMap.get(String(item.artykul_gt_id)) || 0,
    });

    if (payload.typ === 'lokalizacja') {
      payload.zawartosc = payload.zawartosc.map(wzbogac);
    } else if (payload.typ === 'artykul') {
      payload.stany_gt = stanyMap.get(String(payload.artykul_gt_id));
      payload.lokalizacja_gt = statusMap.get(String(payload.artykul_gt_id));
      payload.zgodnosc = zgodnoscZPrzegladu(payload.artykul_gt_id);
      payload.w_zestawach = zestawyMap.get(String(payload.artykul_gt_id)) || 0;

      // K4gora to "1 SKU = N lokalizacji" - nawet gdy artykul ma juz jakas
      // lokalizacje w K4G, w GT moze byc wiecej sztuk niz zsumowano w WMS
      // (np. po PZ). deficyt_k4g > 0 pozwala frontowi zaproponowac dodanie
      // kolejnej lokalizacji K4G obok przesuniecia z istniejacej.
      const stanK4G = payload.stany_gt?.K4G?.ilosc ?? 0;
      const sumaK4G = payload.lokalizacje
        .filter((l) => l.magazyn === 'K4G')
        .reduce((suma, l) => suma + l.ilosc, 0);
      const deficytK4G = stanK4G - sumaK4G;
      if (deficytK4G > 0) payload.deficyt_k4g = deficytK4G;

      // Analogicznie K4 (1 SKU = 1 lokalizacja): ile stanu GT jeszcze nieprzypisane w WMS.
      // Pozwala Zebrze zostac w produkcie i dolokalizowac reszte bez ponownego skanu SKU.
      const stanK4 = payload.stany_gt?.K4?.ilosc ?? 0;
      const sumaK4 = payload.lokalizacje
        .filter((l) => l.magazyn === 'K4')
        .reduce((suma, l) => suma + l.ilosc, 0);
      const deficytK4 = stanK4 - sumaK4;
      if (deficytK4 > 0) payload.deficyt_k4 = deficytK4;

      // Rozbicie stanu K4 na zrodla, bo kazde ma inna regule (zob. gt-dokumenty.js). Front
      // dostaje je JEDNA lista `wszystkie_k4` (kazda pozycja ma `rodzaj`) - dostawa (PZ<-FZ,
      // paleta -> wolno dzielic), zwrot (PZ<-KFS, strefa zwrotow), przywozka (MM z MAG/LS,
      // strefa przywozki), przyjecie_wewn (PW, przychod wewnetrzny). Osobne pola per rodzaj
      // (dostawy_k4/zwroty_k4/...) skasowane: to one gubily nowy rodzaj (front sklejal je
      // recznie i o PW zapomnial). Podpis/domyslny cel per rodzaj rozstrzyga front (RODZAJE_DOK).
      //   nieprzypisane_k4 - reszta ("do sprawdzenia") -> stara zasada 1 SKU = 1 lok K4
      // Produkt moze miec kilka pozycji naraz i to poprawne: to fizycznie rozne rzeczy - paleta
      // do wywiezienia, sztuki w strefach i polka do zaklepania.
      //
      // Warunek to STAN, nie deficyt (zmiana 2026-07-17 razem z capem stanem). Strefy zaleza
      // teraz od samego stanu GT, wiec przy nieaktualnej kopii polki (WMS >= GT, czyli deficyt
      // <= 0) stary warunek `deficytK4 > 0` wycinalby je z karty, mimo ze zwrot fizycznie lezy
      // w strefie. Stan 0 = nie ma czego rozbijac i nie ma po co pytac GT o dokumenty.
      if (stanK4 > 0) {
        const dokumenty = (await gtDokumenty.pobierzDostawyK4([payload.artykul_gt_id]))
          .get(String(payload.artykul_gt_id)) || [];
        const rozbicie = gtDokumenty.rozbijStanK4(stanK4, sumaK4, dokumenty, { artykul_gt_id: payload.artykul_gt_id });
        if (rozbicie.wszystkie.length > 0) payload.wszystkie_k4 = rozbicie.wszystkie;
        // nieprzypisane_k4 ustawiamy ZAWSZE (takze 0) - jego obecnosc jest dla frontu sygnalem
        // "rozbicie sie udalo, ufaj tej liczbie". Gdyby bylo pomijane przy zerze, front musialby
        // zgadywac po obecnosci pozostalych kubelkow i przy kazdym nowym rodzaju znowu bledy
        // (wiersz "brak lokalizacji" dublowal wtedy dokument).
        payload.nieprzypisane_k4 = rozbicie.reszta;
        // Ile MOZE lezec na polce wg GT + o ile klamie kopia WMS. Front pokazuje polke_k4
        // zamiast surowej kopii, dzieki czemu sprzedaz widac od razu, a nie dopiero po jobie.
        payload.polka_k4 = rozbicie.polka;
        payload.polka_k4_klamie = rozbicie.polka_klamie;
      }
    } else if (payload.typ === 'lista_artykulow') {
      payload.artykuly = payload.artykuly.map(wzbogac);
    }

    return payload;
  } catch (err) {
    payload.gt_ok = false;   // niedostepnosc GT nie blokuje WMS, ale ma byc WIDOCZNA
    return payload;
  }
}

// GET /api/lokalizacje/skan/:kod - punkt wejscia dla skanu na ekranie MM:
// jesli kod pasuje do lokalizacji - zwroc co na niej lezy (wybor produktu),
// jesli pasuje do SKU lub EAN (lokalnie w WMS albo w katalogu GT) - 1:1, zwroc
// lokalizacje z zapasem (wybor lokalizacji zrodlowej, albo "brak lokalizacji"
// dla produktu jeszcze nie zlokalizowanego w WMS),
// jesli pasuje do (czesci) nazwy artykulu - zwroc liste pasujacych artykulow do
// wyboru, laczac wyniki z historii WMS (stany_lokalizacji, niezaleznie od
// biezacego stanu) i z pelnego katalogu GT (przydatne dla produktow, ktore
// nigdy nie mialy lokalizacji WMS) - filtrowanie po stanie robi checkbox
// "Ukryj produkty bez stanu" na froncie.
router.get('/skan/:kod', async (req, res, next) => {
  try {
    const kod = req.params.kod;
    // Kody lokalizacji: dopasuj tez formy bez myslnika (A8P2 == A8-P2) - stare naklejki
    // ORAZ stare, niekanoniczne wiersze w bazie (zob. znajdzLokalizacjePoKodzie).
    // Dla SKU/EAN/nazwy lookup nie trafia, wiec dalsze sciezki dzialaja jak dotad.
    const lokalizacja = znajdzLokalizacjePoKodzie(kod);
    if (lokalizacja) {
      const zawartosc = db.prepare(
        `SELECT artykul_gt_id, artykul_symbol, artykul_nazwa, ilosc
         FROM stany_lokalizacji WHERE lokalizacja_id = ? AND ilosc > 0
         ORDER BY artykul_symbol`
      ).all(lokalizacja.id);
      // t_GT: dolacz towary, ktore wg pol GT (tw_Pole1/Pole8) stoja na tej lokalizacji, a
      // nie maja stanu WMS na niej - skan lokalizacji pokazuje tez towary "tylko GT".
      // Pomijamy juz obecne (po symbolu i po id) - importowany wiersz WMS moze byc pusty.
      try {
        const zGt = await szukajPoLokalizacjiGt(lokalizacja.kod); // kanoniczny kod (GT trzyma z myslnikiem)
        const widziane = new Set(zawartosc.map((z) => String(z.artykul_gt_id)));
        for (const p of zGt) {
          if (widziane.has(String(p.artykul_gt_id))) continue;
          zawartosc.push({
            artykul_gt_id: p.artykul_gt_id, artykul_symbol: p.symbol, artykul_nazwa: p.nazwa,
            ilosc: p.stany_gt?.[lokalizacja.magazyn]?.ilosc ?? 0, tylko_gt: true,
          });
        }
      } catch (err) { /* GT niedostepne - pokaz sam stan WMS */ }
      return res.json(await dolaczDaneGt({ typ: 'lokalizacja', lokalizacja, zawartosc }));
    }

    // SKU / EAN: tozsamosc rozstrzyga GT (master kartoteki), a WMS pytamy juz po tw_Id.
    // Kolejnosc jest odwrotna niz do 2026-09-18, kiedy lokalny lookup po kopii symbolu wygrywal
    // z GT - i przy zamienionych symbolach pokazywal cudze polki albo "brak lokalizacji" dla
    // towaru, ktory WMS mial rozlozony (patrz komentarz przy lokalizacjeDlaArtykuluPoId).
    // Dodatkowe zapytanie do GT nic nie kosztuje w praktyce: dolaczDaneGt i tak wola GT nizej.
    let towarGt = null;
    try {
      towarGt = await znajdzTowarPoKodzie(kod);
    } catch (err) { /* GT niedostepne - ponizej awaryjny lookup po kopii w WMS */ }

    if (towarGt) {
      kartoteka.odswiezZProduktu(towarGt);   // przy okazji naprawia zestarzala kopie symbolu/nazwy/EAN
      const payload = lokalizacjeDlaArtykuluPoId(towarGt.artykul_gt_id) ?? artykulZGt(towarGt);
      return res.json(await dolaczDaneGt({ typ: 'artykul', ...payload }));
    }

    // GT nie zna kodu (albo nie odpowiada) - probujemy po KOPII symbolu/EAN w WMS.
    const lokalne = kartaLokalnaPoKodzie(kod);
    if (lokalne?.kolizja) {
      // Jeden kod, dwa rozne tw_Id - nie zgadujemy, ktory. Front dostaje liste do wyboru.
      return res.json(await dolaczDaneGt({
        typ: 'lista_artykulow', artykuly: artykulyPoIdach(lokalne.kolizja), kolizja_symbolu: kod,
      }));
    }
    if (lokalne?.karta) {
      return res.json(await dolaczDaneGt({ typ: 'artykul', ...lokalne.karta }));
    }

    if (kod.length >= 2) {
      const artykulyLokalne = szukajArtykulowPoNazwie(kod);

      // GT: po nazwie/symbolu ORAZ po kodzie lokalizacji z pol wlasnych (tw_Pole1/Pole8) -
      // to drugie znajduje towary t_GT po zeskanowanym/wpisanym kodzie lokalizacji.
      let artykulyGt = [];
      try {
        const [poNazwie, poLok] = await Promise.all([
          szukajProdukty(kod).catch(() => []),
          // szukajPoLokalizacjiGt samo zrownuje zapis z myslnikiem i bez (golyKod), wiec
          // dostaje kod prosto ze skanu. Do 2026-09-18 stala tu nieistniejaca zmienna `kodLok`:
          // ReferenceError lecial w tym samym `try`, ktory lapie niedostepnosc GT, wiec CALE
          // szukanie po katalogu GT bylo po cichu martwe - wyniki po nazwie dawala wylacznie
          // historia WMS, a towary bez lokalizacji nie znajdowaly sie w ogole.
          szukajPoLokalizacjiGt(kod).catch(() => []),
        ]);
        const mapa = new Map();
        for (const p of [...poNazwie, ...poLok]) mapa.set(String(p.artykul_gt_id), p);
        artykulyGt = [...mapa.values()];
      } catch (err) {
        artykulyGt = []; // niedostepnosc GT nie blokuje wynikow lokalnych
      }

      const widziane = new Set(artykulyLokalne.map((a) => String(a.artykul_gt_id)));
      const artykuly = [
        ...artykulyLokalne,
        ...artykulyGt
          .filter((p) => !widziane.has(String(p.artykul_gt_id)))
          .map((p) => ({ artykul_gt_id: p.artykul_gt_id, artykul_symbol: p.symbol, artykul_nazwa: p.nazwa })),
      ];

      if (artykuly.length > 0) {
        const obciete = artykulyLokalne.length >= LIMIT_WYSZUKIWANIA || artykulyGt.length >= LIMIT_WYSZUKIWANIA;
        return res.json(await dolaczDaneGt({ typ: 'lista_artykulow', artykuly, obciete }));
      }
    }

    res.status(404).json({ blad: 'Nie znaleziono SKU, EAN, lokalizacji ani nazwy artykulu w WMS ani w GT' });
  } catch (err) {
    next(err);
  }
});

// GET /api/lokalizacje/skan-id/:artykul_gt_id - ta sama karta produktu co /skan dla SKU, ale gdy
// tw_Id jest juz znane i nie ma czego rozwiazywac: odswiezenie po zapisie ruchu na Zebrze,
// kontekst produktu na ekranie Zwroty. Wczesniej te miejsca wolaly /skan z KOPIA symbolu, czyli
// wracaly do systemu po nazwie, ktora mogla sie w GT juz zmienic.
router.get('/skan-id/:artykul_gt_id', async (req, res, next) => {
  try {
    const id = req.params.artykul_gt_id;
    let payload = lokalizacjeDlaArtykuluPoId(id);

    if (!payload) {
      // Brak zapasu w WMS - tozsamosc bierzemy z GT (jak artykulZGt przy skanie kodu),
      // a gdy GT nie odpowiada, z dowolnego wiersza kopii (takze z iloscia 0).
      let towar = null;
      try {
        const info = await pobierzPodstawoweInfo([id]);
        const t = info.get(String(id));
        if (t) towar = { artykul_gt_id: String(id), symbol: t.tw_Symbol, nazwa: t.tw_Nazwa, ean: t.tw_PodstKodKresk || null };
      } catch (err) { /* GT niedostepne */ }
      if (towar) {
        kartoteka.odswiezZProduktu(towar);
        payload = artykulZGt(towar);
      } else {
        const [kopia] = artykulyPoIdach([id]);
        if (!kopia) return res.status(404).json({ blad: 'Nie znaleziono artykulu o tym tw_Id' });
        payload = { ...kopia, lokalizacje: [] };
      }
    }

    res.json(await dolaczDaneGt({ typ: 'artykul', ...payload }));
  } catch (err) {
    next(err);
  }
});

// GET /api/lokalizacje/kod/:kod - lookup po kodzie (np. po skanie etykiety).
// Normalizuje myslniki (A8P2 == A8-P2) - obsluga starych naklejek bez myslnika.
router.get('/kod/:kod', (req, res) => {
  const lokalizacja = znajdzLokalizacjePoKodzie(req.params.kod);
  if (!lokalizacja) return res.status(404).json({ blad: 'Lokalizacja nie znaleziona' });
  res.json(lokalizacja);
});

// GET /api/lokalizacje/k4-dom/:artykul_gt_id - stale miejsce (dom) artykulu w K4,
// niezaleznie od ilosci - do auto-podpowiedzi lokalizacji docelowej przy uzupelnieniu K4
router.get('/k4-dom/:artykul_gt_id', (req, res) => {
  const wiersz = db.prepare(
    `SELECT s.lokalizacja_id, l.kod, s.ilosc, s.zapas_kod, s.ostatnia_zmiana
     FROM stany_lokalizacji s
     JOIN lokalizacje l ON l.id = s.lokalizacja_id
     WHERE s.artykul_gt_id = ? AND l.magazyn = 'K4' AND l.aktywna = 1`
  ).get(req.params.artykul_gt_id);
  res.json(wiersz ?? null);
});

// PUT /api/lokalizacje/k4-zapas/:artykul_gt_id - ustaw/wyczysc adnotacje "zapas" K4
// (decyzja A: towar w 2 miejscach, np. zbior A1 + nadmiar P5 -> GT tw_Pole1 "A1/P5").
// Nie zmienia stanu - tylko adnotacja + resync pola lokalizacyjnego GT.
router.put('/k4-zapas/:artykul_gt_id', async (req, res, next) => {
  const artykulGtId = req.params.artykul_gt_id;
  const zapas = (req.body?.zapas_kod ?? '').trim().toUpperCase() || null;

  const k4 = db.prepare(
    `SELECT s.id FROM stany_lokalizacji s
     JOIN lokalizacje l ON l.id = s.lokalizacja_id
     WHERE s.artykul_gt_id = ? AND l.magazyn = 'K4' AND s.ilosc > 0`
  ).get(artykulGtId);
  if (!k4) return res.status(404).json({ blad: 'Brak lokalizacji K4 z zapasem dla tego SKU - najpierw przypisz lokalizacje zbioru' });

  db.prepare('UPDATE stany_lokalizacji SET zapas_kod = ? WHERE id = ?').run(zapas, k4.id);

  try {
    const wynik = await synchronizujLokalizacje(artykulGtId, new Set(['K4']));
    const ok = wynik && wynik.ok;
    audyt.zapisz({
      uzytkownik: req.body?.operator ?? null, akcja: 'zapas_k4', artykul_gt_id: artykulGtId,
      magazyn: 'K4', po: { zapas_kod: zapas }, wynik: ok ? 'ok' : 'sync_blad',
    });
    res.json({ zapas_kod: zapas, sync_ok: !!ok, blad: ok ? null : (wynik?.blad ?? null) });
  } catch (err) {
    next(err);
  }
});

// GET /api/lokalizacje/plan/:artykul_gt_id?magazyn= - zachowany plan lokalizacji z GT
router.get('/plan/:artykul_gt_id', (req, res) => {
  const mag = (req.query.magazyn ?? 'K4G').toUpperCase();
  const w = db.prepare('SELECT tekst FROM plan_lokalizacji WHERE artykul_gt_id = ? AND magazyn = ?').get(req.params.artykul_gt_id, mag);
  res.json(w ?? null);
});

// PUT /api/lokalizacje/plan/:artykul_gt_id - zapisz/wyczysc plan (pusty tekst = usun)
router.put('/plan/:artykul_gt_id', (req, res) => {
  const id = req.params.artykul_gt_id;
  const mag = (req.body?.magazyn ?? 'K4G').toUpperCase();
  const tekst = (req.body?.tekst ?? '').trim();
  // UWAGA: NIE audytujemy planu - to automatyczna sciaga z GT (cache planowanych
  // lokalizacji), zapisywana przy kazdym otwarciu produktu, a nie akcja magazyniera.
  // Audyt biznesowy zasmiecaloby to setkami wpisow "Plan lok." bez wartosci.
  if (!tekst) {
    db.prepare('DELETE FROM plan_lokalizacji WHERE artykul_gt_id = ? AND magazyn = ?').run(id, mag);
    return res.json({ tekst: null });
  }
  db.prepare(`INSERT INTO plan_lokalizacji (artykul_gt_id, magazyn, tekst) VALUES (?, ?, ?)
              ON CONFLICT(artykul_gt_id, magazyn) DO UPDATE SET tekst = excluded.tekst`).run(id, mag, tekst);
  res.json({ tekst });
});

// GET /api/lokalizacje/slowniki - listy wartosci dla frontu (typy, przeznaczenia, statusy).
// Front ich NIE powtarza u siebie: kazda taka kopia zyje wlasnym zyciem do pierwszej zmiany
// w configu (a przeznaczenia beda rosly - "reklamacje", "sezonowe"...).
router.get('/slowniki', (req, res) => {
  res.json({ typy: TYPY, przeznaczenia: PRZEZNACZENIA, statusy: OPISY_STATUSOW });
});

// GET /api/lokalizacje/zajetosc - przeglad "co jest wolne, a co tylko wyglada na wolne".
// MUSI stac przed '/:id', inaczej Express potraktuje "zajetosc" jako id.
//
// GT niedostepny -> 503, a nie czesciowa odpowiedz. Bez pol wlasnych GT nie da sie odroznic
// slotu pustego od takiego, na ktorym towar lezy, tylko WMS o nim nie wie - a ekran mowiacy
// "wolne" o zajetym miejscu jest gorszy niz ekran, ktory sie nie otworzyl. Ta sama zasada,
// co w Sciezkach ("nie zgadujemy").
router.get('/zajetosc', async (req, res, next) => {
  try {
    res.json(await przegladZajetosci());
  } catch (err) {
    if (err?.code || /GT|SQL|ECONN|ETIMEOUT|ELOGIN/i.test(String(err?.message))) {
      return res.status(503).json({ blad: `Baza GT niedostepna - przeglad zajetosci wymaga pol lokalizacyjnych GT. ${err.message}` });
    }
    next(err);
  }
});

// PUT /api/lokalizacje/przeznaczenie - oznaczenie HURTEM (kartony, strefa przyjec).
// Tez przed '/:id'. Hurt jest tu istotny, a nie wygodny: strefy to zwykle cale rzedy albo
// poziomy (na produkcji wolne sloty siedza glownie na P5-P6 w regalach E-J), wiec klikanie
// ich po jednym gwarantowaloby, ze nikt tego nie otaguje do konca.
router.put('/przeznaczenie', (req, res) => {
  const { ids, przeznaczenie } = req.body ?? {};

  if (!PRZEZNACZENIA_KODY.includes(przeznaczenie)) {
    return res.status(400).json({ blad: `Pole "przeznaczenie" musi byc jednym z: ${PRZEZNACZENIA_KODY.join(', ')}` });
  }
  const idy = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger);
  if (idy.length === 0) return res.status(400).json({ blad: 'Pole "ids" musi byc niepusta lista id lokalizacji' });

  const wiersze = db.prepare(
    `SELECT id, kod, magazyn, przeznaczenie FROM lokalizacje WHERE id IN (${idy.map(() => '?').join(', ')})`
  ).all(...idy);

  const upd = db.prepare('UPDATE lokalizacje SET przeznaczenie = ? WHERE id = ?');
  let zmienionych = 0;
  db.exec('BEGIN');
  try {
    for (const w of wiersze) {
      if (w.przeznaczenie === przeznaczenie) continue;   // bez pustych UPDATE-ow i pustych wpisow w audycie
      upd.run(przeznaczenie, w.id);
      zmienionych += 1;
      audyt.zapisz({
        uzytkownik: req.uzytkownik?.imie ?? req.body?.operator ?? null, akcja: 'lokalizacja_przeznaczenie',
        magazyn: w.magazyn, lokalizacja: w.kod,
        przed: { przeznaczenie: w.przeznaczenie }, po: { przeznaczenie }, wynik: 'ok',
      });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  res.json({ zmienionych, znalezionych: wiersze.length, przeznaczenie });
});

// GET /api/lokalizacje/:id - szczegoly lokalizacji + jej zawartosc
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ blad: 'Nieprawidlowe id' });

  const lokalizacja = db.prepare('SELECT * FROM lokalizacje WHERE id = ?').get(id);
  if (!lokalizacja) return res.status(404).json({ blad: 'Lokalizacja nie znaleziona' });

  const zawartosc = db.prepare(
    `SELECT artykul_gt_id, artykul_symbol, artykul_nazwa, ilosc, ostatnia_zmiana, operator
     FROM stany_lokalizacji
     WHERE lokalizacja_id = ? AND ilosc > 0
     ORDER BY artykul_symbol`
  ).all(id);

  res.json({ ...lokalizacja, zawartosc });
});

// POST /api/lokalizacje - nowa lokalizacja
router.post('/', (req, res) => {
  const { kod, magazyn } = req.body ?? {};

  if (typeof kod !== 'string' || !kod.trim()) {
    return res.status(400).json({ blad: 'Pole "kod" jest wymagane' });
  }
  if (!MAGAZYNY_WMS.includes(magazyn)) {
    return res.status(400).json({ blad: `Pole "magazyn" musi byc jednym z: ${MAGAZYNY_WMS.join(', ')}` });
  }

  // Kod ZAWSZE zapisujemy w postaci kanonicznej (L3P3 -> L3-P3, a8p2 -> A8-P2). Doslowny
  // zapis tworzyl wiersze, ktorych zaden lookup potem nie znajdowal - zob. komentarz przy
  // znajdzLokalizacjePoKodzie i normalizujKodLokalizacji.
  const kodKanoniczny = normalizujKodLokalizacji(kod);

  try {
    const c = rozbierzKod(kodKanoniczny, magazyn);
    const result = db.prepare(
      `INSERT INTO lokalizacje (kod, magazyn, hala, regal, alejka, strona, kolumna, typ)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(kodKanoniczny, magazyn, c.hala, c.regal, c.alejka, c.strona, c.kolumna, c.typ);
    audyt.zapisz({ uzytkownik: req.body?.operator ?? null, akcja: 'lokalizacja_nowa', magazyn, lokalizacja: kodKanoniczny, po: { kod: kodKanoniczny, magazyn }, wynik: 'ok' });
    res.status(201).json(db.prepare('SELECT * FROM lokalizacje WHERE id = ?').get(result.lastInsertRowid));
  } catch (err) {
    if (err.errcode === SQLITE_CONSTRAINT_UNIQUE) {
      return res.status(409).json({ blad: `Lokalizacja o kodzie "${kodKanoniczny}" juz istnieje` });
    }
    throw err;
  }
});

// POST /api/lokalizacje/import - import zbiorczy (wklejona kolumna kodow per magazyn).
// body: { lokalizacje: [{kod, magazyn}], podglad?: bool, operator? }
// Idempotentny: kod juz istniejacy -> pominiety (bez nadpisywania). Walidacja magazyn,
// trim/uppercase, dedupe w obrebie paczki, puste linie ignorowane cicho.
// podglad=true -> tylko policz (nic nie zapisuje). Inaczej -> jedna transakcja + 1 wpis audytu.
router.post('/import', (req, res) => {
  const wejscie = Array.isArray(req.body?.lokalizacje) ? req.body.lokalizacje : null;
  const podglad = req.body?.podglad === true;
  if (!wejscie) {
    return res.status(400).json({ blad: 'Pole "lokalizacje" musi byc tablica {kod, magazyn}' });
  }

  const bledy = [];
  const kandydaci = [];
  const widziane = new Set();

  for (const wpis of wejscie) {
    // Kanonizacja PRZED dedupem: "L3P3" i "L3-P3" w jednej wklejce to ta sama lokalizacja,
    // a wiersz musi wyladowac w bazie w formie, ktora znajdzie pozniejszy skan.
    const kod = normalizujKodLokalizacji(wpis?.kod);
    const magazyn = wpis?.magazyn;
    if (!kod) continue; // puste linie ignorujemy cicho
    if (!MAGAZYNY_WMS.includes(magazyn)) {
      bledy.push({ kod, powod: `magazyn spoza {${MAGAZYNY_WMS.join(', ')}}` });
      continue;
    }
    if (widziane.has(kod)) {
      bledy.push({ kod, powod: 'duplikat w paczce' });
      continue;
    }
    widziane.add(kod);
    kandydaci.push({ kod, magazyn });
  }

  const czyIstnieje = db.prepare('SELECT 1 FROM lokalizacje WHERE kod = ?');
  const nowe = [];
  const pominiete = [];
  for (const l of kandydaci) {
    if (czyIstnieje.get(l.kod)) pominiete.push(l.kod);
    else nowe.push(l);
  }

  if (podglad) {
    // rozbicie nowych kodow wg wyliczonego typu - podglad "co realnie wjedzie"
    const typy = {};
    for (const l of nowe) {
      const t = rozbierzKod(l.kod, l.magazyn).typ ?? 'brak';
      typy[t] = (typy[t] ?? 0) + 1;
    }
    return res.json({
      podglad: true,
      do_dodania: nowe.length,
      pominiete: pominiete.length,
      bledy,
      typy,
      przyklady_nowych: nowe.slice(0, 8).map((l) => l.kod),
      przyklady_pominietych: pominiete.slice(0, 8),
    });
  }

  const wstaw = db.prepare(
    `INSERT INTO lokalizacje (kod, magazyn, hala, regal, alejka, strona, kolumna, typ)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.exec('BEGIN');
  try {
    for (const l of nowe) {
      const c = rozbierzKod(l.kod, l.magazyn);
      wstaw.run(l.kod, l.magazyn, c.hala, c.regal, c.alejka, c.strona, c.kolumna, c.typ);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  audyt.zapisz({
    uzytkownik: req.body?.operator ?? null, akcja: 'import_lokalizacji',
    po: { dodane: nowe.length, pominiete: pominiete.length, bledy: bledy.length },
    wynik: 'ok',
  });

  res.status(201).json({ dodane: nowe.length, pominiete: pominiete.length, bledy });
});

// PUT /api/lokalizacje/:id - edycja (kod, magazyn, aktywna)
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ blad: 'Nieprawidlowe id' });

  const lokalizacja = db.prepare('SELECT * FROM lokalizacje WHERE id = ?').get(id);
  if (!lokalizacja) return res.status(404).json({ blad: 'Lokalizacja nie znaleziona' });

  const { kod, magazyn, aktywna, typ, przeznaczenie } = req.body ?? {};

  // Jak w POST: do bazy idzie postac kanoniczna (edycja to tez droga, ktora "L3P3" mogloby
  // wrocic do bazy - i znow zniknac ze skanu).
  const nowyKod = kod !== undefined ? normalizujKodLokalizacji(kod) : lokalizacja.kod;
  const nowyMagazyn = magazyn !== undefined ? magazyn : lokalizacja.magazyn;
  const nowaAktywna = aktywna !== undefined ? (aktywna ? 1 : 0) : lokalizacja.aktywna;

  if (!nowyKod) return res.status(400).json({ blad: 'Pole "kod" nie moze byc puste' });
  if (!MAGAZYNY_WMS.includes(nowyMagazyn)) {
    return res.status(400).json({ blad: `Pole "magazyn" musi byc jednym z: ${MAGAZYNY_WMS.join(', ')}` });
  }
  if (typ !== undefined && !TYPY.includes(typ)) {
    return res.status(400).json({ blad: `Pole "typ" musi byc jednym z: ${TYPY.join(', ')}` });
  }
  if (przeznaczenie !== undefined && !PRZEZNACZENIA_KODY.includes(przeznaczenie)) {
    return res.status(400).json({ blad: `Pole "przeznaczenie" musi byc jednym z: ${PRZEZNACZENIA_KODY.join(', ')}` });
  }

  // Zmiana magazynu = poprawka pomylki przy zakladaniu (K4 zamiast K4G), NIE sposob na
  // przeniesienie towaru: przepiecie zajetej lokalizacji przerzuciloby jej stan miedzy
  // magazynami w WMS bez dokumentu w GT (lamie regule #1 i inwariant sumy). Wiersz ze
  // stanem 0 tez blokuje - na K4 to wciaz DOM artykulu, ktory po cichu zmienilby magazyn.
  if (nowyMagazyn !== lokalizacja.magazyn) {
    const { pozycje } = db.prepare('SELECT COUNT(*) AS pozycje FROM stany_lokalizacji WHERE lokalizacja_id = ?').get(id);
    if (pozycje > 0) {
      return res.status(409).json({
        blad: `Nie mozna zmienic magazynu - lokalizacja ma przypisany towar (${pozycje} poz.). Najpierw przenies towar (MM/LOK) albo zwolnij slot.`,
      });
    }
  }

  const c = rozbierzKod(nowyKod, nowyMagazyn);
  // typ: jesli podany jawnie -> nadpisanie reczne (wyjatek); inaczej wyliczony z reguly
  const nowyTyp = typ !== undefined ? typ : c.typ;
  // przeznaczenie: WYLACZNIE decyzja czlowieka - nie ma reguly, ktora wyliczylaby z kodu,
  // ze na "G8-P2" stoja kartony. Niepodane = bez zmiany.
  const nowePrzezn = przeznaczenie !== undefined ? przeznaczenie : lokalizacja.przeznaczenie;

  try {
    db.prepare(
      `UPDATE lokalizacje SET kod = ?, magazyn = ?, aktywna = ?,
         hala = ?, regal = ?, alejka = ?, strona = ?, kolumna = ?, typ = ?, przeznaczenie = ? WHERE id = ?`
    ).run(nowyKod, nowyMagazyn, nowaAktywna, c.hala, c.regal, c.alejka, c.strona, c.kolumna, nowyTyp, nowePrzezn, id);
  } catch (err) {
    if (err.errcode === SQLITE_CONSTRAINT_UNIQUE) {
      return res.status(409).json({ blad: `Lokalizacja o kodzie "${nowyKod}" juz istnieje` });
    }
    throw err;
  }

  audyt.zapisz({
    uzytkownik: req.body?.operator ?? null, akcja: 'lokalizacja_edycja', magazyn: nowyMagazyn, lokalizacja: nowyKod,
    przed: { kod: lokalizacja.kod, magazyn: lokalizacja.magazyn, aktywna: lokalizacja.aktywna, typ: lokalizacja.typ, przeznaczenie: lokalizacja.przeznaczenie },
    po: { kod: nowyKod, magazyn: nowyMagazyn, aktywna: nowaAktywna, typ: nowyTyp, przeznaczenie: nowePrzezn }, wynik: 'ok',
  });
  res.json(db.prepare('SELECT * FROM lokalizacje WHERE id = ?').get(id));
});

// DELETE /api/lokalizacje/:id - usuniecie (tylko gdy brak powiazanej historii stanow)
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ blad: 'Nieprawidlowe id' });

  const lokalizacja = db.prepare('SELECT * FROM lokalizacje WHERE id = ?').get(id);
  if (!lokalizacja) return res.status(404).json({ blad: 'Lokalizacja nie znaleziona' });

  const { liczba } = db.prepare('SELECT COUNT(*) AS liczba FROM stany_lokalizacji WHERE lokalizacja_id = ?').get(id);
  if (liczba > 0) {
    return res.status(409).json({ blad: 'Nie mozna usunac - lokalizacja ma zapisana historie stanow. Oznacz ja jako nieaktywna (aktywna=0).' });
  }

  // `ruchy` trzyma FK na lok_zrodlo_id/lok_cel_id, wiec pusta lokalizacja z historia ruchow
  // wywalala DELETE na FOREIGN KEY constraint (500 "blad serwera") zamiast czytelnego 409.
  const { ruchow } = db.prepare('SELECT COUNT(*) AS ruchow FROM ruchy WHERE lok_zrodlo_id = ? OR lok_cel_id = ?').get(id, id);
  if (ruchow > 0) {
    return res.status(409).json({ blad: `Nie mozna usunac - lokalizacja wystepuje w historii ruchow (${ruchow}). Oznacz ja jako nieaktywna (aktywna=0).` });
  }

  try {
    db.prepare('DELETE FROM lokalizacje WHERE id = ?').run(id);
  } catch (err) {
    // strazak na przyszle tabele z FK na lokalizacje - lepiej czytelne 409 niz 500 z loga awarii
    if (String(err?.message).includes('FOREIGN KEY')) {
      return res.status(409).json({ blad: 'Nie mozna usunac - lokalizacja jest powiazana z innymi danymi. Oznacz ja jako nieaktywna (aktywna=0).' });
    }
    throw err;
  }
  audyt.zapisz({
    uzytkownik: req.body?.operator ?? null, akcja: 'lokalizacja_usuniecie', magazyn: lokalizacja.magazyn, lokalizacja: lokalizacja.kod,
    przed: { kod: lokalizacja.kod, magazyn: lokalizacja.magazyn }, wynik: 'ok',
  });
  res.status(204).send();
});

module.exports = router;
