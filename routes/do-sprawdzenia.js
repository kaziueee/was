'use strict';

const express = require('express');
const db = require('../db/database');
const gtDokumenty = require('../services/gt-dokumenty');
const { pobierzK4StanyDoSprawdzenia } = require('../services/gt-produkty');

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
const RODZAJE = {
  nieznany_przychod: (p) => p.polka_wms > 0,
  do_zlokalizowania: (p) => p.polka_wms === 0,
};

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
    if (r.reszta <= 0) continue;   // WMS zna caly stan albo reszta siedzi w strefach

    const w = loki.get(k.artykul_gt_id);
    pozycje.push({
      artykul_gt_id: k.artykul_gt_id,
      symbol: k.symbol,
      nazwa: k.nazwa,
      ean: k.ean ?? w?.ean ?? null,
      ilosc: r.reszta,                     // ile do przypisania
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
  const rodzaj = RODZAJE[req.query.rodzaj] ? req.query.rodzaj : null;   // null = wszystkie
  const limit = Math.min(Math.max(Number(req.query.limit) || LIMIT_DOMYSLNY, 1), LIMIT_MAX);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  // Liczniki liczymy ZAWSZE z pelnego zbioru, takze przy aktywnym filtrze - inaczej po
  // zawezeniu ekran nie umialby powiedziec, ile jest w drugiej grupie, i przelacznik bylby
  // skokiem w ciemno.
  const liczniki = Object.fromEntries(
    Object.entries(RODZAJE).map(([k, pasuje]) => {
      const grupa = wszystkie.filter(pasuje);
      return [k, { razem: grupa.length, sztuk: grupa.reduce((s, p) => s + p.ilosc, 0) }];
    })
  );

  const pozycje = rodzaj ? wszystkie.filter(RODZAJE[rodzaj]) : wszystkie;
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

module.exports = router;
module.exports.zbierz = zbierz;
// RODZAJE eksportujemy, bo kafel Pulpitu liczy TEN SAM podzbior co zakladka "Nieznany przychod".
// Powtorzenie predykatu (`p.polka_wms > 0`) w pulpit-snapshot rozjechaloby kafel z lista przy
// pierwszej zmianie definicji - a kafel jest jedynym miejscem, gdzie ktos to zauwazy dopiero
// po tygodniu.
module.exports.RODZAJE = RODZAJE;
