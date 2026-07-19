'use strict';

const express = require('express');
const db = require('../db/database');
const gtDokumenty = require('../services/gt-dokumenty');
const { pobierzK4StanyDoSprawdzenia, pobierzStanyGt } = require('../services/gt-produkty');
const gtFields = require('../services/gt-fields');

const router = express.Router();

// "Do sprawdzenia" - towar, ktory GT widzi na K4, a WMS nie wie, gdzie on jest.
//
// To jest ekran obiecywany od dawna przez services/rozjazdy.js i CLAUDE.md ("GT > WMS ->
// ekran do zlokalizowania"), ktory nigdy nie powstal. Tabela `rozjazdy` go NIE pokazuje:
// lapie wylacznie GT < WMS (nadmiar w kopii), a przy deficycie robi `continue`. Filtr
// "Zgodnosc" w Produktach tez nie - K4 jest tam porownywane tylko TEKSTEM pola tw_Pole1,
// ilosci celowo nie (services/gt-fields.js), wiec GT 200 / WMS 50 swieci "OK".
//
// Skad sie bierze taki stan: kazde zwiekszenie stanu GT na K4, ktorego WMS nie zrobil -
// przychod wewnetrzny z inwentury, uzupelnienie K4G->K4 zrobione w Subiekcie, powrot
// z Reklamacji. Swiadomie NIE rozpoznajemy ich po dokumencie i NIE dopisujemy automatycznie
// do polki: automat nie odroznilby ich od niewidzianej palety, a wpisanie palety na polke
// pickowa zrownuje GT z WMS (roznica zero) i job rozjazdow juz nigdy tego nie wykryje -
// klamstwo zamraza sie na stale. Dlatego to jest ZADANIE DLA CZLOWIEKA.
//
// Rachunek: `reszta` z rozbijStanK4 (stan GT - strefy - kopia WMS). Ten sam kod, co karta
// produktu i listy zwrotow/dostaw - wlasny licznik rozjechalby ekran z karta.
//
// UWAGA KONSTRUKCYJNA: lista MUSI startowac od GT, nie od wierszy WMS. sumyWms w jobie
// rozjazdow ma `HAVING SUM(ilosc) > 0`, wiec SKU, o ktorym WMS nie wie NIC, w ogole nie
// wchodzi do petli - a to jest dokladnie ten towar, ktorego tu szukamy.

const MAG = 'K4';

// Ile pozycji oddajemy na raz. Lista jest BACKLOGIEM, nie checklista: na starcie moze miec
// ~2000 wierszy (GT ma ~2800 SKU ze stanem na K4, a K4 ma 855 lokalizacji, wiec WMS moze
// znac najwyzej tyle). Zebra dostaje kawalek "na obchod", desktop paginuje.
const LIMIT_DOMYSLNY = 50;
const LIMIT_MAX = 500;

// Sortowania: 'lokalizacja' = kolejnosc obchodu (Zebra), 'ilosc' = triage od najwiekszych
// (desktop - najpierw to, co najbardziej zaklamuje stan).
const SORTY = {
  lokalizacja: (a, b) => (a.lokalizacja_kod || '￿').localeCompare(b.lokalizacja_kod || '￿')
    || (a.symbol || '').localeCompare(b.symbol || ''),
  ilosc: (a, b) => b.ilosc - a.ilosc || (a.symbol || '').localeCompare(b.symbol || ''),
  sku: (a, b) => (a.symbol || '').localeCompare(b.symbol || ''),
};

// Na tej liscie sa DWIE ROZNE PRACE i trzeba je umiec rozdzielic:
//
//   nieznany_przychod - WMS ZNA miejsce tego SKU, ale stan GT urosl ponad to, co WMS wie.
//     Ktos dolozyl towar poza naszym obiegiem: przychod wewnetrzny z inwentury, uzupelnienie
//     K4G->K4 zrobione w Subiekcie, powrot z Reklamacji. To SYGNAL OPERACYJNY - splywa
//     codziennie i nie zejdzie do zera nigdy.
//
//     !!! TEGO RODZAJU NIE WIDZI NIC INNEGO W SYSTEMIE. Zgodnosc K4 porownuje wylacznie
//     TEKST lokalizacji (services/gt-fields.js: "ilosci celowo NIE porownujemy"), wiec SKU
//     z "C2" w WMS i "C2" w GT dostaje badge OK niezaleznie od tego, czy GT ma tam 50 czy
//     200 szt. Filtr NZ go nie zlapie, t_GT tym bardziej (t_GT wymaga BRAKU lokalizacji
//     w WMS), a panel Rozjazdy lapie tylko GT < WMS. Ten ekran jest jedynym miejscem.
//
//   do_zlokalizowania - WMS nie zna tego SKU na K4 w ogole. To BACKLOG MIGRACYJNY
//     (~2000 poz. na starcie), ktory zjedzie do zera, gdy ktos go zlokalizuje. Ten rodzaj
//     widac tez gdzie indziej - jako t_GT (albo BD, gdy GT tez nie ma tw_Pole1) w filtrze
//     Zgodnosci w Produktach.
//
// Nazwy sa WLASNE, a nie zapozyczone ze slownika zgodnosci (t_GT/NZ) - tamten opisuje
// zgodnosc TEKSTU pola i tutaj po prostu nie pasuje. Uzycie go bylo by klamstwem.
// Trzy rodzaje rozjazdu wiedzy na K4 (od 2026-07-18, po rozpoznaniu PW):
//   przyjecie_wewn  - przychod Z DOKUMENTEM PW (dawny "nieznany przychod" ma teraz nazwe).
//                     To ono zajmuje "buty NP" - glowny, spodziewany przypadek.
//   nieznany_przychod - reszta BEZ dokumentu, a WMS zna miejsce. W Subiekcie nie ma zmiany
//                     bez dokumentu, wiec ~0; gdy > 0 = cos spoza okna / starzejaca sie kopia.
//   do_zlokalizowania - WMS nie zna SKU w ogole (backlog migracyjny).
const RODZAJE = {
  przyjecie_wewn:    (p) => p.pw > 0,
  nieznany_przychod: (p) => p.reszta > 0 && p.polka_wms > 0,
  do_zlokalizowania: (p) => p.reszta > 0 && p.polka_wms === 0,
};

// UI-owe "Przyjecie wewn (PW)" = przychod na K4, ktorego NIE tlumaczy dostawa/zwrot/przywozka:
// z dokumentem PW ALBO bez zadnego (decyzja usera 2026-07-19). Dla magazyniera to jedna sprawa -
// "cos tu przyszlo poza obiegiem" - a to, czy ktos wystawil PW, jest szczegolem ksiegowym.
//
// do_zlokalizowania celowo NIE wchodzi: to backlog migracyjny (~2000 SKU, ktorych WMS nigdy nie
// poznal). Wrzucony tutaj zamienilby sygnal "dzis cos przyszlo" w wielka stala liczbe, ktora
// nic nie mowi o dzisiaj - dokladnie tego unikal podzial kafli na Pulpicie.
//
// Filtr stref (routes/produkty.js) i kafel Pulpitu (services/pulpit-snapshot.js) MUSZA uzywac
// TEGO SAMEGO predykatu - inaczej licznik na kaflu pokaze co innego niz lista po kliknieciu,
// a zauwazy to dopiero ktos po tygodniu.
const PRZYJECIE_LUB_BEZ_DOKUMENTU = (p) => RODZAJE.przyjecie_wewn(p) || RODZAJE.nieznany_przychod(p);

// Predykaty ZAKLADEK ekranu - to, co user faktycznie zobaczy po kliknieciu. Rozni sie od
// RODZAJE dokladnie w jednym miejscu: zakladka "PW" pokazuje tez bezdokumentowe. Liczniki
// zakladek MUSZA isc z tej mapy, nie z RODZAJE - inaczej zakladka pokazywalaby inna liczbe,
// niz ma wierszy, a kafel Pulpitu (ktory otwiera wlasnie te zakladke) klamalby o robocie.
// "nieznany_przychod" zostaje osobno jako wezszy widok - tylko to, czego nikt nie udokumentowal.
const PREDYKAT_ZAKLADKI = { ...RODZAJE, przyjecie_wewn: PRZYJECIE_LUB_BEZ_DOKUMENTU };

// Sumy kopii WMS dla K4 - jednym zapytaniem, nie N+1 w petli.
function sumyWmsK4() {
  const mapa = new Map();
  for (const r of db.prepare(
    `SELECT s.artykul_gt_id AS id, COALESCE(SUM(s.ilosc), 0) AS suma
     FROM stany_lokalizacji s JOIN lokalizacje l ON l.id = s.lokalizacja_id
     WHERE l.magazyn = ? GROUP BY s.artykul_gt_id`
  ).all(MAG)) mapa.set(String(r.id), Number(r.suma) || 0);
  return mapa;
}

// Lokalizacja K4 znana WMS-owi (master lokalizacji) - gdy SKU juz ma miejsce, a stan urosl.
function lokalizacjeWmsK4() {
  const mapa = new Map();
  for (const r of db.prepare(
    `SELECT s.artykul_gt_id AS id, l.kod, s.artykul_ean AS ean
     FROM stany_lokalizacji s JOIN lokalizacje l ON l.id = s.lokalizacja_id
     WHERE l.magazyn = ? ORDER BY s.ilosc DESC`
  ).all(MAG)) {
    if (!mapa.has(String(r.id))) mapa.set(String(r.id), r);
  }
  return mapa;
}

// Ktore SKU maja W OGOLE jakikolwiek dokument w strefach. Zapytania odwrotne z RODZAJE_STREF
// daja ten zbior DUZO taniej (165 ms) niz pytanie pobierzDostawyK4 o wszystkie ~2800 SKU
// ze stanem na K4 (1376 ms) - a wiekszosc z nich zadnego dokumentu nie ma.
//
// Wolno tak skrocic, bo oba kierunki maja te same okna i te sama date odciecia (odKiedy()
// w gt-dokumenty.js) - spojnosc jest tam wymuszona komentarzem i wspolnym helperem. Gdyby
// kiedys rozjechaly sie warunki, ten skrot po cichu zgubilby strefy - dlatego rodzaje bierzemy
// z RODZAJE_STREF, a nie wypisujemy ich tutaj po raz drugi.
async function idyZDokumentami() {
  const zbiory = await Promise.all(
    Object.values(gtDokumenty.RODZAJE_STREF).map(async ({ kandydaci }) => (await kandydaci()).map((k) => k.artykul_gt_id))
  );
  return new Set(zbiory.flat());
}

// Sklada pelna liste. Wolane przez GET / i przez kafel Pulpitu (tylko licznik).
async function zbierz() {
  const kandydaci = await pobierzK4StanyDoSprawdzenia();   // wszystkie SKU ze stanem GT na K4
  if (!kandydaci.length) return [];

  const zDokumentem = await idyZDokumentami();
  const dokMap = kandydaci.some((k) => zDokumentem.has(k.artykul_gt_id))
    ? await gtDokumenty.pobierzDostawyK4(kandydaci.filter((k) => zDokumentem.has(k.artykul_gt_id)).map((k) => k.artykul_gt_id))
    : new Map();
  const sumy = sumyWmsK4();
  const loki = lokalizacjeWmsK4();

  const pozycje = [];
  for (const k of kandydaci) {
    const wms = sumy.get(k.artykul_gt_id) ?? 0;
    const r = gtDokumenty.rozbijStanK4(k.stan_k4, wms, dokMap.get(k.artykul_gt_id) || [], {
      artykul_gt_id: k.artykul_gt_id, magazyn: MAG,
    });
    const pw = r.przyjecia.reduce((s, d) => s + d.ilosc, 0);
    if (r.reszta <= 0 && pw <= 0) continue;   // caly stan wyjasniony (WMS + strefy) - nie ma czego sprawdzac

    const w = loki.get(k.artykul_gt_id);
    pozycje.push({
      artykul_gt_id: k.artykul_gt_id,
      symbol: k.symbol,
      nazwa: k.nazwa,
      ean: k.ean ?? w?.ean ?? null,
      ilosc: pw + r.reszta,                // ile do przypisania (PW + reszta bez dokumentu)
      pw,                                  // przychod z dokumentem PW
      pw_dok: r.przyjecia[0]?.pz_nr ?? null, // numer PW (najnowszy) - do podpisu
      reszta: r.reszta,                    // reszta BEZ dokumentu
      stan_k4: k.stan_k4,
      rezerwacja: k.rez_k4 ?? 0,
      w_strefach: r.wDrodze,               // czesc stanu jest wyjasniona dokumentem - nie liczy sie
      polka_wms: r.polka_kopia,            // co WMS juz wie o tym SKU na K4
      // Miejsce: WMS (master lokalizacji) -> tw_Pole1 z GT (podpowiedz) -> brak.
      // Brak to NIE blad: magazynier zeskanuje nowe miejsce.
      lokalizacja_kod: w?.kod ?? k.lok_gt ?? null,
      lok_zrodlo: w?.kod ? 'WMS' : (k.lok_gt ? 'GT' : null),
    });
  }
  return pozycje;
}

// GET /api/do-sprawdzenia?sort=lokalizacja|ilosc|sku&rodzaj=nieznany_przychod|do_zlokalizowania&limit=&offset=
router.get('/', async (req, res) => {
  let wszystkie;
  try {
    wszystkie = await zbierz();
  } catch (err) {
    return res.status(503).json({ blad: 'Nie mozna pobrac stanow z GT (baza niedostepna). Sprobuj ponownie.' });
  }

  const sort = SORTY[req.query.sort] ? req.query.sort : 'lokalizacja';
  const rodzaj = PREDYKAT_ZAKLADKI[req.query.rodzaj] ? req.query.rodzaj : null;   // null = wszystkie
  const limit = Math.min(Math.max(Number(req.query.limit) || LIMIT_DOMYSLNY, 1), LIMIT_MAX);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  // Liczniki liczymy ZAWSZE z pelnego zbioru, takze przy aktywnym filtrze - inaczej po
  // zawezeniu ekran nie umialby powiedziec, ile jest w drugiej grupie, i przelacznik bylby
  // skokiem w ciemno.
  const liczniki = Object.fromEntries(
    Object.entries(PREDYKAT_ZAKLADKI).map(([k, pasuje]) => {
      const grupa = wszystkie.filter(pasuje);
      return [k, { razem: grupa.length, sztuk: grupa.reduce((s, p) => s + p.ilosc, 0) }];
    })
  );

  // "Wszystko" liczymy z PELNEGO zbioru, a nie jako sume zakladek: zakladka PW obejmuje teraz
  // bezdokumentowe, wiec zakladki sie NAKLADAJA i sumowanie liczyloby czesc pozycji dwa razy.
  liczniki[''] = { razem: wszystkie.length, sztuk: wszystkie.reduce((s, p) => s + p.ilosc, 0) };

  const pozycje = rodzaj ? wszystkie.filter(PREDYKAT_ZAKLADKI[rodzaj]) : wszystkie;
  pozycje.sort(SORTY[sort]);

  res.json({
    pozycje: pozycje.slice(offset, offset + limit),
    razem: pozycje.length,
    sztuk: pozycje.reduce((s, p) => s + p.ilosc, 0),
    liczniki,
    limit, offset, sort, rodzaj,
  });
});

// GET /api/do-sprawdzenia/licznik - sam licznik do kafla Pulpitu (bez listy).
// Osobny endpoint, bo Pulpit nie potrzebuje 2000 wierszy, zeby pokazac jedna liczbe.
router.get('/licznik', async (req, res) => {
  try {
    const pozycje = await zbierz();
    res.json({ razem: pozycje.length, sztuk: pozycje.reduce((s, p) => s + p.ilosc, 0) });
  } catch (err) {
    res.status(503).json({ blad: 'GT niedostepne' });
  }
});

// GET /api/do-sprawdzenia/nz - SKU z niezgodnym polem lokalizacyjnym (status NZ z kolumny
// "Zgodnosc" na desktopie), posortowane po lokalizacji = kolejnosc obchodu.
//
// OSOBNY endpoint, a nie kolejny `rodzaj` w GET / - bo NZ liczy sie zupelnie inaczej niz
// reszta tego ekranu: nie z rozbicia stanu K4 (zbierz), tylko z porownania pol lokalizacyjnych
// GT z kopia WMS. I co wazniejsze: obejmuje TAKZE K4G, ktorego `zbierz()` nie widzi w ogole
// (MAG = 'K4' na gorze tego pliku).
//
// DLACZEGO TO JEDYNE WEJSCIE DO NADWYZKI NA K4G:
//   - services/rozjazdy.js lapie wylacznie GT < WMS (nadmiar w kopii); przy GT > WMS robi continue,
//   - ekran "Do sprawdzenia" (GET /) jest K4-only,
//   - kafle Pulpitu licza kubelki stanu K4.
// Zostawala kolumna "Zgodnosc" w tabeli Produkty na desktopie - czyli trzeba bylo na to trafic.
//
// UWAGA na pulapke, w ktora sam wpadlem przy audycie: zbior liczymy per SKU i sumujemy WMS
// przez COALESCE(SUM(...), 0), a NIE grupujemy stany_lokalizacji po (SKU, magazyn). SKU bez
// ANI JEDNEGO wiersza dla danego magazynu nie tworzy grupy, wiec przy grupowaniu znika z
// wyniku - a to najwiekszy kawalek luki (na danych testowych: polowa).
// Pola GT to PODPOWIEDZI, nie adresy. tw_Pole8 (K4G) trzyma skompresowana LISTE
// ("M2-A2(20); M2-B27-P3(2010); M5-A01-P1(5)"), a tw_Pole1 bywa smieciem z ukosnikiem
// ("D10 /", "C2/C2P3" - kod/zapas). Na obchod bierzemy PIERWSZY kod: reszta nie zmiesci sie
// w wierszu na 360 px, a sortowanie po calym ciagu ustawialoby liste w kolejnosci losowej
// wzgledem hali. Front i tak oznacza takie miejsce jako "(z GT - sprawdz)".
function pierwszyKodZPola(tekst) {
  const kod = String(tekst || '').split(';')[0].replace(/\(.*$/, '').split('/')[0].trim();
  return kod || null;
}

router.get('/nz', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || LIMIT_DOMYSLNY, 1), LIMIT_MAX);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const sku = db.prepare(
    `SELECT s.artykul_gt_id AS id, MAX(s.artykul_symbol) AS symbol, MAX(s.artykul_nazwa) AS nazwa,
            MAX(s.artykul_ean) AS ean
     FROM stany_lokalizacji s GROUP BY s.artykul_gt_id`
  ).all();
  if (!sku.length) return res.json({ pozycje: [], razem: 0, sztuk: 0, limit, offset });

  // Sumy WMS per magazyn - brak wiersza ma dac 0, nie "pomin SKU" (zob. uwaga wyzej).
  const sumaWms = new Map();
  for (const w of db.prepare(
    `SELECT s.artykul_gt_id AS id, l.magazyn, SUM(s.ilosc) AS suma
     FROM stany_lokalizacji s JOIN lokalizacje l ON l.id = s.lokalizacja_id
     GROUP BY s.artykul_gt_id, l.magazyn`
  ).all()) sumaWms.set(`${w.id}|${w.magazyn}`, Number(w.suma) || 0);

  // Kod lokalizacji do obchodu: WMS jest masterem lokalizacji, GT tylko podpowiedzia.
  // Trzymamy OSOBNO per magazyn, bo obchod ma isc tam, gdzie brakuje towaru - patrz nizej.
  const lokWms = { K4: new Map(), K4G: new Map() };
  for (const w of db.prepare(
    `SELECT s.artykul_gt_id AS id, l.magazyn, l.kod FROM stany_lokalizacji s
     JOIN lokalizacje l ON l.id = s.lokalizacja_id ORDER BY l.kod`
  ).all()) if (lokWms[w.magazyn] && !lokWms[w.magazyn].has(w.id)) lokWms[w.magazyn].set(w.id, w.kod);

  let przeglad, stany;
  try {
    [przeglad, stany] = await Promise.all([
      gtFields.pobierzPrzegladLokalizacji(sku.map((s) => s.id)),
      pobierzStanyGt(sku.map((s) => s.id)),
    ]);
  } catch (err) {
    return res.status(503).json({ blad: 'Nie mozna pobrac danych z GT (baza niedostepna). Sprobuj ponownie.' });
  }

  const pozycje = [];
  for (const s of sku) {
    const z = przeglad.get(String(s.id));
    if (z?.ogolna !== gtFields.ZGODNOSC.NIEZGODNE) continue;

    const sg = stany.get(String(s.id)) || {};
    const mag = (kod) => {
      const gt = sg[kod]?.ilosc ?? 0;
      const wms = sumaWms.get(`${s.id}|${kod}`) ?? 0;
      return { gt, wms, brak: Math.max(0, gt - wms) };
    };
    const k4 = mag('K4');
    const k4g = mag('K4G');

    // Miejsce obchodu - kandydaci od najtrafniejszego. Przy luce wylacznie na K4G kod polki
    // pickowej wyslalby czlowieka w zle miejsce (towaru brakuje na gorze), wiec magazyn bez
    // luki jest OSTATNI, a nie pierwszy. `magazyn` opisuje ZAWSZE to, co realnie pokazujemy -
    // etykieta "K4G" przy kodzie polki K4 bylaby kłamstwem o tym, na co czlowiek patrzy.
    const gora = k4g.brak > 0 && k4.brak === 0;
    const magLuki = gora ? 'K4G' : 'K4';
    const drugi = gora ? 'K4' : 'K4G';
    const miejsce = [
      { mag: magLuki, kod: lokWms[magLuki].get(s.id), zrodlo: 'WMS' },
      { mag: magLuki, kod: pierwszyKodZPola(gora ? z.k4g.gt_tekst : z.k4.gt_tekst), zrodlo: 'GT' },
      { mag: drugi, kod: lokWms[drugi].get(s.id), zrodlo: 'WMS' },
    ].find((k) => k.kod) ?? { mag: magLuki, kod: null, zrodlo: null };

    pozycje.push({
      artykul_gt_id: s.id, symbol: s.symbol, nazwa: s.nazwa, ean: s.ean,
      zgodnosc: { k4: z.k4.stan, k4g: z.k4g.stan, ogolna: z.ogolna },
      k4, k4g,
      ilosc: k4.brak + k4g.brak,      // ile sztuk WMS nie umie umiejscowic (obu magazynow)
      stan_k4: k4.gt, polka_wms: k4.wms,   // zgodne z reszta ekranu (render wspoldzielony)
      magazyn: miejsce.mag,                // magazyn POKAZANEGO miejsca, nie magazyn luki
      lokalizacja_kod: miejsce.kod ?? null,
      lok_zrodlo: miejsce.zrodlo,
    });
  }

  pozycje.sort((a, b) => (a.lokalizacja_kod || '￿').localeCompare(b.lokalizacja_kod || '￿')
    || (a.symbol || '').localeCompare(b.symbol || ''));

  res.json({
    pozycje: pozycje.slice(offset, offset + limit),
    razem: pozycje.length,
    sztuk: pozycje.reduce((s, p) => s + p.ilosc, 0),
    limit, offset,
  });
});

module.exports = router;
module.exports.zbierz = zbierz;
// RODZAJE eksportujemy, bo kafel Pulpitu liczy TEN SAM podzbior co zakladka "Nieznany przychod".
// Powtorzenie predykatu (`p.polka_wms > 0`) w pulpit-snapshot rozjechaloby kafel z lista przy
// pierwszej zmianie definicji - a kafel jest jedynym miejscem, gdzie ktos to zauwazy dopiero
// po tygodniu.
module.exports.RODZAJE = RODZAJE;
module.exports.PRZYJECIE_LUB_BEZ_DOKUMENTU = PRZYJECIE_LUB_BEZ_DOKUMENTU;
