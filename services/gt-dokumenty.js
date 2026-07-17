'use strict';

// Odczyt dokumentow MM z GT (SQL, tylko-do-odczytu) - do gwarancji numeru MM (Faza A#3).
//
// UWAGA: dok__Dokument.dok_NrPelny NIE jest unikalny - numeracja MM resetuje sie per
// magazyn/rok (np. "MM 181/2026" istnieje 2x, rozne towary/magazyny). Dlatego dokument
// namierzamy po numerze PELNYM + tw_Id pozycji, a jednoznaczny uchwyt to dok_Id (PK).
//
// Schemat GT: naglowki dok__Dokument (dok_Id, dok_NrPelny, dok_Typ=9=MM), pozycje
// dok_Pozycja (klucz ob_DokMagId = dok_Id, ob_TowId, ob_Ilosc).

const { query, naCzesci } = require('./gt-sql');
const db = require('../db/database');
const { MAGAZYNY_ZEWNETRZNE, MAGAZYN_GT_ID } = require('../config/magazyny');

// Kod magazynu WMS (ruchy.mag_zrodlo_pula) - NIE mylic z MAG_K4 nizej, ktore jest
// identyfikatorem magazynu w GT (sl_Magazyn.mag_Id = 4).
const MAG_KOD_K4 = 'K4';

// Uwagi dokumentu MM (Faza A#3): Node buduje tu cala tresc, ktora most C# wpisuje do
// dok_Uwagi wystawianego dokumentu. Sklada sie z klucza idempotencji + kto + kiedy:
//   "WMS-RUCH:<id> | <operator> | <czas ruchu, strefa PL>"
// Dzieki temu dokument jest samoopisowy: (a) przy ponowieniu ruchu (gdy poprzednia odpowiedz
// HTTP zaginela) odnajdujemy go po kluczu zamiast wystawiac drugi MM; (b) w Subiekcie widac
// kto i kiedy zrobil przesuniecie. Format zna TYLKO Node - most jedynie zapisuje gotowy tekst.
const KLUCZ_PREFIX = 'WMS-RUCH:';
function kluczRuchu(ruchId) { return `${KLUCZ_PREFIX}${ruchId}`; }

// Formatuje czas ruchu (data_ruchu z SQLite jest w UTC bez znacznika strefy) na czas
// scienny w Polsce, np. "02.07.2026 11:45". Niezalezne od strefy serwera Node.
function formatCzasPL(dbTimestamp) {
  if (!dbTimestamp) return '';
  const d = new Date(String(dbTimestamp).replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return String(dbTimestamp);
  return new Intl.DateTimeFormat('pl-PL', {
    timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).format(d).replace(',', '');
}

// Buduje tresc Uwag dokumentu MM (klucz + kto + kiedy). Czas bierzemy z data_ruchu (moment,
// w ktorym magazynier zatwierdzil ruch), a NIE z chwili wystawienia - dzieki temu przy MM
// ponowionym po godzinach dokument pokazuje realny czas przesuniecia, nie czas retry.
function budujUwagiMM(ruchId, operator, dataRuchu) {
  const kto = (operator && String(operator).trim()) || 'WMS';
  const kiedy = formatCzasPL(dataRuchu);
  return kiedy ? `${kluczRuchu(ruchId)} | ${kto} | ${kiedy}` : `${kluczRuchu(ruchId)} | ${kto}`;
}

// Szuka dokumentu MM wystawionego dla danego ruchu WMS (po kluczu w dok_Uwagi). Zwraca
// { dok_Id, dok_NrPelny, ilosc } (najnowszy, gdyby klucz sie powtorzyl), null (brak) albo
// { blad } gdy GT SQL niedostepny. NIGDY nie rzuca - wywolujacy decyduje (prewencja duplikatu).
// Dopasowanie po prefiksie "WMS-RUCH:<id> |" - separator " |" po numerze odcina falszywe
// trafienia (WMS-RUCH:12 nie zlapie WMS-RUCH:123). Id to liczba, wiec brak znakow LIKE.
async function znajdzMMpoKluczu(ruchId) {
  try {
    const { recordset } = await query(
      `SELECT TOP 1 d.dok_Id, d.dok_NrPelny,
              (SELECT SUM(p.ob_Ilosc) FROM dok_Pozycja p WHERE p.ob_DokMagId = d.dok_Id) AS ilosc
       FROM dok__Dokument d
       WHERE d.dok_Uwagi LIKE @wzorzec
       ORDER BY d.dok_Id DESC`,
      { wzorzec: `${kluczRuchu(ruchId)} |%` }
    );
    if (!recordset.length) return null;
    return { dok_Id: recordset[0].dok_Id, dok_NrPelny: recordset[0].dok_NrPelny, ilosc: Number(recordset[0].ilosc) };
  } catch (err) {
    return { blad: err.message };
  }
}

// Namierza dokument MM po numerze pelnym + tw_Id. Zwraca { dok_Id, ilosc } (najnowszy,
// gdy numer sie powtarza) albo null (brak), albo { blad } gdy GT SQL niedostepny.
// NIGDY nie rzuca - wywolujacy decyduje co zrobic (numer i tak juz mamy).
async function znajdzMM(nrPelny, twId) {
  try {
    const { recordset } = await query(
      `SELECT d.dok_Id, SUM(p.ob_Ilosc) AS ilosc
       FROM dok__Dokument d
       JOIN dok_Pozycja p ON p.ob_DokMagId = d.dok_Id
       WHERE d.dok_NrPelny = @nr AND p.ob_TowId = @tw
       GROUP BY d.dok_Id
       ORDER BY d.dok_Id DESC`,
      { nr: nrPelny, tw: Number(twId) }
    );
    if (!recordset.length) return null;
    return { dok_Id: recordset[0].dok_Id, ilosc: Number(recordset[0].ilosc) };
  } catch (err) {
    return { blad: err.message };
  }
}

// Otwarte ZK (zamowienia klienta) rezerwujace dany towar na K4. Rezerwacja GT
// (tw_Stan.st_StanRez) na K4 = suma pozycji otwartych ZK (dok_Typ=16,
// dok_Status=7) na tym magazynie - potwierdzone na zywej bazie: suma pozycji =
// st_StanRez. Ten sam wzorzec co uzupelnienia.js/kanaly.js, tylko per jeden
// towar i ze zwrotem numerow dokumentow (do podgladu "z czego wynika rezerwacja").
//
// ob_TowId = @tow odsiewa pozycje bez towaru (uslugi/notatki maja ob_TowId NULL).
// SUM(ob_Ilosc) per dokument - ten sam towar moze byc w kilku liniach jednego ZK.
// Sort: najnowsze na gorze (data wystawienia malejaco).
//
// dok_NrPelny (np. "ZK 15123/2026") to stabilny numer dokumentu; dok_NrPelnyOryg
// bywa smieciem (reczne ZK maja tam opis typu "NIEZGODNOSCI BRAKI") - dlatego
// oba pola oddajemy, front pokazuje NrPelny jako glowny identyfikator.
//
// Rzuca gdy GT SQL niedostepny - wywolujacy (endpoint) mapuje na 503.
const ZK_TYP = 16;
const ZK_STATUS_OTWARTE = 7;
const MAG_K4 = 4;

async function pobierzZkRezerwujaceK4(twId) {
  const { recordset } = await query(
    `SELECT d.dok_Id, d.dok_NrPelny, d.dok_NrPelnyOryg AS oryg,
            d.dok_DataWyst AS data, SUM(o.ob_Ilosc) AS ilosc
     FROM dok_Pozycja o
     JOIN dok__Dokument d ON d.dok_Id = o.ob_DokHanId
     WHERE d.dok_Typ = @typ AND d.dok_Status = @status
       AND o.ob_TowId = @tow AND o.ob_MagId = @mag
     GROUP BY d.dok_Id, d.dok_NrPelny, d.dok_NrPelnyOryg, d.dok_DataWyst
     ORDER BY d.dok_DataWyst DESC`,
    { typ: ZK_TYP, status: ZK_STATUS_OTWARTE, tow: Number(twId), mag: MAG_K4 }
  );
  return recordset.map((r) => ({
    dok_id: r.dok_Id,
    nr_pelny: r.dok_NrPelny ? String(r.dok_NrPelny).trim() : null,
    oryg: r.oryg ? String(r.oryg).trim() : null,
    data: r.data instanceof Date ? r.data.toISOString().slice(0, 10) : null,
    ilosc: Number(r.ilosc) || 0,
  }));
}

// Nierozlozony towar przyjety na K4 - trzy zrodla, kazde z innym dokumentem w GT:
//   PZ <- FZ  (dok_Typ=1)  = DOSTAWA    - paleta od dostawcy, jedzie w calosci na gore
//   PZ <- KFS (dok_Typ=6)  = ZWROT      - sztuka od klienta, lezy w strefie zwrotow
//   MM z magazynu zewn.    = PRZYWOZKA  - towar przywieziony z MAG/LS, lezy w strefie przywozki
//
// PZ nie oznacza dostawy - rozroznia je dokument ZRODLOWY (dok_DoDokId). Skala na zywej bazie
// (90 dni, mag 4): FZ = 24 dok./168 069 szt. (srednio 715); KFS = 947 dok./1 162 szt.
// (srednio 1,1). Czyli 97% PZ-tow to zwroty, ale 99,3% sztuk to dostawy - dlatego filtr po
// rodzaju dokumentu zrodlowego, a nie po samym PZ.
//
// MM: kierunek czytamy z dok_MagId (ZRODLO) + dok_OdbiorcaId (CEL). To NIE jest kontrahent,
// mimo nazwy - przy MM Subiekt trzyma tam mag_Id magazynu docelowego (potwierdzone na wlasnych
// dokumentach WMS, gdzie kierunek znamy z klucza WMS-RUCH w uwagach; join do kh__Kontrahent
// daje bzdury typu "SPOLEM" - to przypadkowa kolizja id).
//
// Wlasne MM (uwagi zaczynaja sie od WMS-RUCH:) POMIJAMY: przyjecie z MAG/LS przez WMS
// (/ruchy/przyjecie) od razu zapisuje lokalizacje, wiec nie ma czego rozkladac - a wliczone
// psulyby atrybucje kubelka (nie maja zrodlo_dok, wiec wygladalyby na nierozlozone).
//
// Okno liczymy po dacie dokumentu magazynowego (dok_DataWyst = dok_DataMag = data przyjecia),
// a NIE po dacie FZ: faktura bywa starsza od przyjecia (na zywej bazie do 35 dni), bo PZ
// powstaje dopiero przy wywolaniu dostawy. Dokument zrodlowy daje wylacznie podpis.
//
// Kontrahent TYLKO przy dostawie: tam to firma (kh_Symbol, np. "YIWUCHI"). Przy zwrocie
// kontrahentem jest KLIENT DETALICZNY - czyli dane osobowe osoby prywatnej, bezuzyteczne
// dla magazyniera. Zwrot podpisujemy samym numerem KFS, ktory wystarcza do presledzenia.
//
// Rzuca, gdy GT SQL niedostepny - wywolujacy decyduje (dolaczDaneGt tlumi i oddaje payload
// bez dostaw, bo brak GT nie moze blokowac podstawowych funkcji WMS).
const PZ_TYP = 10;
const FZ_TYP = 1;
const KFS_TYP = 6;
const MM_TYP = 9;

// Dwa rozne okna, bo to dwa rozne zjawiska:
//   DOSTAWA (24 dok./kwartal, srednio 715 szt.) - duza i rzadka, potrafi poczekac dzien-dwa
//     na rozlozenie, a data FZ bywa starsza od przyjecia nawet o 35 dni -> szerokie okno.
//   ZWROT / PRZYWOZKA (947 + 141 dok./kwartal, srednio 1-2 szt.) - drobne i codzienne,
//     odnoszone na regal tego samego dnia. Przy oknie 90 dni kazdy deficyt sciagalby na ekran
//     zwroty sprzed trzech miesiecy (dawno odlozone, bo pula jest WYLICZANA - dokument
//     rozlozony przed wdrozeniem tej funkcji nie ma ruchu, wiec wygladalby na nierozlozony).
//     Krotkie okno tnie ten falszywy alarm i zalew ekranu na starcie.
const OKNO_DOSTAWY_DNI = 90;
const OKNO_ZWROTY_PRZYWOZKI_DNI = Number(process.env.WMS_OKNO_DROBNICA_DNI) || 14;

// Zapytanie ODWROTNE do pobierzDostawyK4: tam pytamy "co przyszlo na TE towary", tu "ktore
// towary maja w ogole zwrot na K4". Potrzebne do listy zwrotow, ktora nie zna z gory zbioru
// SKU (karta produktu zna - stad tamten kierunek).
//
// Zwraca sam ZBIOR KANDYDATOW (tw_Id + dane towaru do wyswietlenia), a NIE ilosci do rozlozenia.
// Ile realnie zostalo, liczy dopiero rozbijDeficytK4 na deficycie - jedno zrodlo prawdy dla
// karty produktu i listy. Druga implementacja licznika rozjechalaby oba ekrany.
//
// tw_Rodzaj = 1: tylko towary (wycina zestawy/komplety rodzaju 8 i uslugi) - ten sam filtr,
// co w sciezce "Ostatnie sztuki", z tego samego powodu: zestaw nie ma fizycznego stanu na polce.
const TW_RODZAJ_TOWAR = 1;

// zrodloTyp: KFS_TYP = zwroty (okno krotkie), FZ_TYP = dostawy (okno dlugie). Okno idzie w parze
// z typem, bo to dwa rozne zjawiska - patrz komentarz przy OKNO_* wyzej.
async function pobierzTowaryZeZrodlemK4(zrodloTyp) {
  const dni = zrodloTyp === FZ_TYP ? OKNO_DOSTAWY_DNI : OKNO_ZWROTY_PRZYWOZKI_DNI;
  const od = new Date(Date.now() - dni * 24 * 60 * 60 * 1000);
  const { recordset } = await query(`
    SELECT DISTINCT o.ob_TowId AS tw_id, t.tw_Symbol AS symbol, t.tw_Nazwa AS nazwa,
           t.tw_PodstKodKresk AS ean, t.tw_Pole1 AS lok_gt
    FROM dok__Dokument pz
    JOIN dok_Pozycja o ON o.ob_DokMagId = pz.dok_Id
    JOIN dok__Dokument zr ON zr.dok_Id = pz.dok_DoDokId AND zr.dok_Typ = @zrodloTyp
    JOIN tw__Towar t ON t.tw_Id = o.ob_TowId AND t.tw_Rodzaj = @rodzaj
    WHERE pz.dok_Typ = @pzTyp AND o.ob_MagId = @mag AND pz.dok_DataWyst >= @od
  `, { pzTyp: PZ_TYP, zrodloTyp, mag: MAG_K4, od, rodzaj: TW_RODZAJ_TOWAR });

  return recordset.map((r) => ({
    artykul_gt_id: String(r.tw_id),
    symbol: r.symbol ? String(r.symbol).trim() : null,
    nazwa: r.nazwa ? String(r.nazwa).trim() : null,
    // EAN z GT, nie z kopii WMS: stany_lokalizacji.artykul_ean bywa puste (wypelnia sie
    // dopiero przy ruchu), a na Zebrze skanuje sie kod kreskowy, nie symbol
    ean: r.ean ? String(r.ean).trim() : null,
    // podpowiedz miejsca na polce, gdy WMS nie zna lokalizacji tego SKU
    lok_gt: r.lok_gt ? String(r.lok_gt).trim() : null,
  }));
}

const pobierzTowaryZeZwrotamiK4 = () => pobierzTowaryZeZrodlemK4(KFS_TYP);
const pobierzTowaryZDostawamiK4 = () => pobierzTowaryZeZrodlemK4(FZ_TYP);

async function pobierzDostawyK4(twIds) {
  const wynik = new Map();
  if (!twIds || twIds.length === 0) return wynik;

  const dni = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  const od = dni(OKNO_DOSTAWY_DNI);
  const odDrobne = dni(OKNO_ZWROTY_PRZYWOZKI_DNI);

  // magazyny zewnetrzne (MAG/LS/BRK) jako mag_Id GT - zrodla przywozek
  const zewnGtIds = MAGAZYNY_ZEWNETRZNE.map((k) => MAGAZYN_GT_ID[k]).filter(Boolean);

  await Promise.all(naCzesci([...new Set(twIds.map(String))], 1000).map(async (paczka) => {
    const parametry = { pzTyp: PZ_TYP, fzTyp: FZ_TYP, kfsTyp: KFS_TYP, mmTyp: MM_TYP, mag: MAG_K4, od, odDrobne };
    const placeholders = paczka.map((id, i) => {
      parametry[`t${i}`] = Number(id);
      return `@t${i}`;
    }).join(', ');
    const zewnPlaceholders = zewnGtIds.map((id, i) => {
      parametry[`z${i}`] = id;
      return `@z${i}`;
    }).join(', ');

    const { recordset } = await query(`
      SELECT o.ob_TowId, dok.dok_NrPelny AS dok_nr,
             zr.dok_Typ AS zrodlo_typ, zr.dok_NrPelny AS zrodlo_nr, kh.kh_Symbol AS kontrahent,
             NULL AS zrodlo_mag, dok.dok_DataWyst AS data, SUM(o.ob_Ilosc) AS ilosc, dok.dok_Id AS dok_id
      FROM dok__Dokument dok
      JOIN dok_Pozycja o ON o.ob_DokMagId = dok.dok_Id
      JOIN dok__Dokument zr ON zr.dok_Id = dok.dok_DoDokId AND zr.dok_Typ IN (@fzTyp, @kfsTyp)
      LEFT JOIN kh__Kontrahent kh ON kh.kh_Id = dok.dok_PlatnikId
      WHERE dok.dok_Typ = @pzTyp AND o.ob_MagId = @mag
        AND dok.dok_DataWyst >= CASE WHEN zr.dok_Typ = @fzTyp THEN @od ELSE @odDrobne END
        AND o.ob_TowId IN (${placeholders})
      GROUP BY o.ob_TowId, dok.dok_Id, dok.dok_NrPelny, zr.dok_Typ, zr.dok_NrPelny, kh.kh_Symbol, dok.dok_DataWyst

      UNION ALL

      -- PRZYWOZKI: MM z magazynu zewnetrznego na K4, wystawione POZA WMS.
      -- Kierunek: dok_MagId = zrodlo, dok_OdbiorcaId = cel (przy MM to mag_Id, nie kontrahent).
      SELECT o.ob_TowId, dok.dok_NrPelny AS dok_nr,
             NULL AS zrodlo_typ, NULL AS zrodlo_nr, NULL AS kontrahent,
             mz.mag_Symbol AS zrodlo_mag, dok.dok_DataWyst AS data, SUM(o.ob_Ilosc) AS ilosc, dok.dok_Id AS dok_id
      FROM dok__Dokument dok
      JOIN dok_Pozycja o ON o.ob_DokMagId = dok.dok_Id
      JOIN sl_Magazyn mz ON mz.mag_Id = dok.dok_MagId
      WHERE dok.dok_Typ = @mmTyp AND dok.dok_OdbiorcaId = @mag
        AND dok.dok_MagId IN (${zewnPlaceholders})
        AND ISNULL(dok.dok_Uwagi, '') NOT LIKE 'WMS-RUCH:%'
        AND dok.dok_DataWyst >= @odDrobne
        AND o.ob_TowId IN (${placeholders})
      GROUP BY o.ob_TowId, dok.dok_Id, dok.dok_NrPelny, mz.mag_Symbol, dok.dok_DataWyst

      ORDER BY data DESC, dok_id DESC
    `, parametry);

    for (const r of recordset) {
      const klucz = String(r.ob_TowId);
      if (!wynik.has(klucz)) wynik.set(klucz, []);
      const rodzaj = r.zrodlo_mag ? 'przywozka' : (r.zrodlo_typ === FZ_TYP ? 'dostawa' : 'zwrot');
      wynik.get(klucz).push({
        rodzaj,
        // dokument magazynowy - klucz atrybucji (ruchy.zrodlo_dok)
        pz_nr: r.dok_nr ? String(r.dok_nr).trim() : null,
        // podpis na ekranie: dostawa/zwrot maja dokument zrodlowy (FZ/KFS), przywozka jest
        // sama dla siebie dokumentem (MM), wiec podpisujemy ja wlasnym numerem
        fz_nr: (r.zrodlo_nr ? String(r.zrodlo_nr).trim() : null) ?? (r.dok_nr ? String(r.dok_nr).trim() : null),
        zrodlo_mag: r.zrodlo_mag ? String(r.zrodlo_mag).trim() : null,
        // przy zwrocie kontrahentem jest klient detaliczny (dane osobowe) - nie wynosimy go
        // na ekran magazynu; numer KFS wystarcza do presledzenia
        kontrahent: rodzaj === 'dostawa' && r.kontrahent ? String(r.kontrahent).trim() : null,
        data: r.data instanceof Date ? r.data.toISOString().slice(0, 10) : null,
        ilosc: Number(r.ilosc) || 0,
      });
    }
  }));

  // Od najnowszej: nierozlozona jest zwykle ta swieza, starsze zdazyly pojsc na gore.
  // Paczki wracaja rownolegle, wiec sortujemy po scaleniu, nie polegamy na ORDER BY.
  for (const lista of wynik.values()) {
    lista.sort((a, b) => String(b.data).localeCompare(String(a.data)));
  }
  return wynik;
}

// Ile z KONKRETNEGO dokumentu (PZ dostawy albo zwrotu) juz rozlozono - suma naszych
// wlasnych ruchow z puli, podpisanych numerem tego dokumentu (ruchy.zrodlo_dok).
//
// Po co per dokument, a nie sumarycznie: SKU moze miec naraz dostawe (paleta) i zwrot
// (sztuka w strefie). Gdybysmy liczyli lacznie, rozlozenie palety zjadaloby licznik zwrotu
// i wiersz "Zwrot" znikalby, mimo ze sztuka dalej lezy w strefie.
//
// Liczymy z ruchow, a nie z osobnej tabeli, bo /ruchy/rozloz to JEDYNA droga wyprowadzenia
// towaru z puli. Przypisanie starego stanu idzie przez /ruchy/lok (bez mag_zrodlo_pula),
// wiec go nie liczy - i slusznie, bo to inny kubelek.
function iloscRozlozonaZDokumentu(artykulGtId, magazyn, dokNr) {
  if (!dokNr) return 0;
  const r = db.prepare(`
    SELECT COALESCE(SUM(ilosc), 0) AS suma FROM ruchy
    WHERE artykul_gt_id = ? AND mag_zrodlo_pula = ? AND zrodlo_dok = ? AND status != 'blad'
  `).get(String(artykulGtId), magazyn, String(dokNr));
  return Number(r.suma) || 0;
}

// Rozbija deficyt K4 (stan GT - suma WMS) na kubelki, ktore NIE nachodza na siebie:
//   dostawy    - PZ<-FZ, paleta od dostawcy (rozkladana dowolnie, dol/gora, w czesciach)
//   zwroty     - PZ<-KFS, sztuki lezace w strefie zwrotow (wracaja na regal)
//   przywozki  - MM z MAG/LS, towar w strefie przywozki (wraca na regal)
//   reszta     - stary stan, ktorego WMS nigdy nie poznal (stara zasada 1 SKU = 1 lokalizacja)
//
// Kubelek dokumentu = ilosc z PZ MINUS to, co z TEGO dokumentu juz rozlozylismy. Na koniec
// wszystko jest capowane deficytem: gdy czesc zeszla sprzedaza (GT spada bez wiedzy WMS),
// PZ nadal mowi 200, a deficyt juz tylko 195 - bierzemy 195. Dzieki temu rozlozone pozycje
// znikaja same i nie wracaja jak zombie, niezaleznie od dlugosci okna.
//
// Kolejnosc capowania: najpierw dostawy i zwroty (mamy na nie dokument), na koncu reszta -
// bo to ona jest "niewyjasniona" i to ona ma absorbowac niedobor.
function rozbijDeficytK4(deficyt, dokumenty, { artykul_gt_id, magazyn = MAG_KOD_K4 } = {}) {
  let zostalo = Math.max(Number(deficyt) || 0, 0);
  const kubelki = { dostawa: [], zwrot: [], przywozka: [] };

  for (const d of dokumenty || []) {
    if (zostalo <= 0) break;
    const juz = artykul_gt_id ? iloscRozlozonaZDokumentu(artykul_gt_id, magazyn, d.pz_nr) : 0;
    const pozostalo = d.ilosc - juz;
    if (pozostalo <= 0) continue;             // ten dokument juz rozlozony w calosci
    const ilosc = Math.min(pozostalo, zostalo);
    (kubelki[d.rodzaj] || kubelki.dostawa).push({ ...d, ilosc });
    zostalo -= ilosc;
  }

  // `wszystkie` = te same pozycje w jednej liscie. Konsumenci, ktorych interesuje "ile lezy
  // w drodze" albo "czy ten dokument jest jeszcze do rozlozenia", MAJA uzywac tego pola -
  // recznie skladane [...dostawy, ...zwroty] cichnie sie psuje przy kazdym nowym rodzaju
  // (tak zniknely przywozki z weryfikacji w /ruchy/rozloz i z reguly "cala ilosc" w /lok).
  const wszystkie = [...kubelki.dostawa, ...kubelki.zwrot, ...kubelki.przywozka];
  return {
    dostawy: kubelki.dostawa,
    zwroty: kubelki.zwrot,
    przywozki: kubelki.przywozka,
    wszystkie,
    wDrodze: wszystkie.reduce((s, d) => s + d.ilosc, 0),
    reszta: zostalo,
  };
}

module.exports = {
  znajdzMM, znajdzMMpoKluczu, kluczRuchu, budujUwagiMM, pobierzZkRezerwujaceK4,
  pobierzDostawyK4, pobierzTowaryZeZwrotamiK4, pobierzTowaryZDostawamiK4,
  rozbijDeficytK4, iloscRozlozonaZDokumentu,
};
