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
const PW_TYP = 12;   // Przyjecie Wewnetrzne - przychod bez dokumentu zrodlowego (korekta, inwentura)
// Automatyczna kompletacja zestawow tez wystawia PW, ale WYLACZNIE na zestawach (rodzaj 8) -
// zmierzone 2026-07-18: 4570 dok automatu, wszystkie rodzaj 8; rodzaj 1 rusza tylko czlowiek.
// Filtr tw_Rodzaj=1 sam ja wycina, ale odrzucamy tez po koncie - obrona przed dniem, w ktorym
// automat zacznie skladac cos rodzaju 1.
const KONTO_KOMPLETACJI = 'Automatyczna Kompletacja';

// ROZMONTOWANIE ZESTAWU (zweryfikowane na RW/PW 2284/2026, baza Kajtek Idea):
//   RW (typ 13) na zestaw rodzaj 8  +  PW (typ 12) na skladniki rodzaj 1, oba na K4,
//   wzajemnie zlinkowane przez dok_DoDokId. Pozycje OBU przez ob_DokMagId (nie HanId!).
// UWAGA: RW to typ 13, NIE 11 - typ 11 to WZ (zmierzone na calej bazie).
const RW_TYP = 13;
const TW_RODZAJ_ZESTAW = 8;

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
// Okno, w ktorym szukamy KFS na ROZMONTOWANYM zestawie - decyduje, czy skladniki leza na
// WOZKU ZWROTOW (zadanie do rozwiezienia) czy zostaly w obrebie K4. To samo okno co zwroty.
const OKNO_ROZMONTOWANIE_KFS_DNI = OKNO_ZWROTY_PRZYWOZKI_DNI;

// DATA ODCIECIA - dokumenty starsze NIE licza sie do stref. Ustaw na dzien wdrozenia
// (WMS_DOKUMENTY_OD w .env).
//
// Po co: przed wdrozeniem palety byly rozkladane POZA nowym obiegiem - albo MM-em w Subiekcie,
// albo DWUKROKIEM (/ruchy/lok przypisuje cala dostawe na lokalizacje -> /ruchy/mm wywozi ja na
// gore). Zaden z tych ruchow nie ma podpisu dokumentem (ruchy.zrodlo_dok), wiec dla naszego
// rachunku takie dostawy wygladaja na NIEROZLOZONE - a po zmianie na cap stanem zjadalyby caly
// stan K4 i wypychaly polke do zera. Pomiar na zywej OKITRADE (17.07.2026): 189 z 231 pozycji
// dostaw (82%) pokazaloby sie jako widmo - wiersz "Rozloz 94 000 szt." przy 2 825 na magazynie.
//
// Dlaczego zwykla data, a nie sprytniejszy mechanizm: te dostawy sa NIEROZSTRZYGALNE - nie mamy
// po nich sladu i miec nie bedziemy. A po wdrozeniu zrodlo widm zamyka sie STRUKTURALNIE:
// /ruchy/rozloz podpisuje ruch dokumentem, a regula "cala ilosc bez wDrodze" w /ruchy/lok
// blokuje dwukrok. To brak drogi, nie kwestia dyscypliny. (Rozwazany wariant "licz wywozke
// zrobiona Subiektem" upadl: widma robi nasz wlasny WMS, a liczenie wszystkich MM z GT
// podwojnie liczyloby rozlozenia przez /rozloz - maja i dokument w GT, i zrodlo_dok.)
//
// KOSZT, przyjety swiadomie: ~8 palet przyjetych tuz przed wdrozeniem jest naprawde otwartych
// i straci wiersz "Rozloz" - wpadna do "do sprawdzenia" i magazynier obsluzy je przez "Dalej".
//
// STALA WYGASA: okno dostaw to 90 dni, wiec ~90 dni po wdrozeniu nie ma juz dokumentow
// starszych od odciecia i te linie mozna usunac razem z warunkiem w zapytaniach.
//
// DOMYSLNIE BRAK ODCIECIA - i to jest swiadomy wybor miedzy dwoma zlymi domyslnymi:
//   brak odciecia   -> pokaza sie widma (paleta 94 000 szt., ktorej nie ma). ZLE, ale GLOSNE:
//                      widac je na pierwszym ekranie i od razu wiadomo, ze trzeba ustawic date.
//   odciecie "na oko"-> gdy trafi w przyszlosc, KAZDY dokument jest od niego starszy i
//                      WSZYSTKIE listy sa puste. To jest cicha porazka: system wyglada na
//                      dzialajacy, tylko "nic nie przychodzi" - i nikt nie wie dlaczego.
// Pierwsza wersja miala tu na sztywno '2026-07-18' (jutro wzgledem dnia pisania) i dokladnie
// to zrobila: user dodal FZ, MM i KFS, a w WMS nie pojawilo sie nic.
const DOKUMENTY_OD = process.env.WMS_DOKUMENTY_OD ? new Date(process.env.WMS_DOKUMENTY_OD) : null;

// Zla konfiguracja tej stalej wygasza cala funkcje, wiec musi krzyczec przy starcie - inaczej
// objawem jest "puste listy" bez zadnej wskazowki, co je opustoszylo.
(function ostrzezOKonfiguracji() {
  const kiedy = new Date().toISOString().slice(0, 19).replace('T', ' ');
  if (!DOKUMENTY_OD) {
    console.log(`${kiedy} [gt-dokumenty] INFO: WMS_DOKUMENTY_OD nie ustawione - brak odciecia. `
      + 'Dostawy rozlozone przed wdrozeniem (MM w Subiekcie / dwukrok /lok+/mm) pokaza sie jako '
      + 'widma. Ustaw na dzien wdrozenia w .env, gdy bedziesz wdrazal.');
    return;
  }
  if (Number.isNaN(DOKUMENTY_OD.getTime())) {
    console.error(`${kiedy} [gt-dokumenty] BLAD: WMS_DOKUMENTY_OD="${process.env.WMS_DOKUMENTY_OD}" `
      + 'to nie jest data. Oczekiwany format: RRRR-MM-DD.');
    return;
  }
  if (DOKUMENTY_OD > new Date()) {
    console.error(`${kiedy} [gt-dokumenty] BLAD: WMS_DOKUMENTY_OD=${DOKUMENTY_OD.toISOString().slice(0, 10)} `
      + 'jest W PRZYSZLOSCI - kazdy dokument jest od niego starszy, wiec dostawy, zwroty '
      + 'i przywozki BEDA PUSTE. Ustaw date wdrozenia (przeszla).');
  }
})();

// Poczatek okna = pozniejsza z dwoch dat: okno rodzaju albo data odciecia (gdy ustawiona).
function odKiedy(dni) {
  const zOkna = new Date(Date.now() - dni * 24 * 60 * 60 * 1000);
  if (!DOKUMENTY_OD || Number.isNaN(DOKUMENTY_OD.getTime())) return zOkna;
  return zOkna > DOKUMENTY_OD ? zOkna : DOKUMENTY_OD;
}

// Zapytanie ODWROTNE do pobierzDostawyK4: tam pytamy "co przyszlo na TE towary", tu "ktore
// towary maja w ogole zwrot na K4". Potrzebne do listy zwrotow, ktora nie zna z gory zbioru
// SKU (karta produktu zna - stad tamten kierunek).
//
// Zwraca sam ZBIOR KANDYDATOW (tw_Id + dane towaru do wyswietlenia), a NIE ilosci do rozlozenia.
// Ile realnie zostalo, liczy dopiero rozbijStanK4 na stanie GT - jedno zrodlo prawdy dla
// karty produktu i listy. Druga implementacja licznika rozjechalaby oba ekrany.
//
// tw_Rodzaj = 1: tylko towary (wycina zestawy/komplety rodzaju 8 i uslugi) - ten sam filtr,
// co w sciezce "Ostatnie sztuki", z tego samego powodu: zestaw nie ma fizycznego stanu na polce.
const TW_RODZAJ_TOWAR = 1;

// zrodloTyp: KFS_TYP = zwroty (okno krotkie), FZ_TYP = dostawy (okno dlugie). Okno idzie w parze
// z typem, bo to dwa rozne zjawiska - patrz komentarz przy OKNO_* wyzej.
async function pobierzTowaryZeZrodlemK4(zrodloTyp) {
  const od = odKiedy(zrodloTyp === FZ_TYP ? OKNO_DOSTAWY_DNI : OKNO_ZWROTY_PRZYWOZKI_DNI);
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

const pobierzTowaryZDostawamiK4 = () => pobierzTowaryZeZrodlemK4(FZ_TYP);

// Fragment SQL rozpoznajacy ROZMONTOWANIE: PW --dok_DoDokId--> RW(13) z pozycja rodzaju 8.
// Uzywany w dwoch miejscach (klasyfikacja + kandydaci), wiec jeden tekst - inaczej rozjadą sie
// warunki i kandydat nie mialby dokumentu w rozbiciu (albo odwrotnie).
const ROZMONTOWANIE_JOIN = `
  JOIN dok__Dokument rw ON rw.dok_Id = pw.dok_DoDokId AND rw.dok_Typ = @rwTyp
  CROSS APPLY (
    SELECT TOP 1 zt.tw_Id AS zestaw_id, zt.tw_Symbol AS zestaw_symbol
    FROM dok_Pozycja rwp
    JOIN tw__Towar zt ON zt.tw_Id = rwp.ob_TowId AND zt.tw_Rodzaj = @rodzajZestaw
    WHERE rwp.ob_DokMagId = rw.dok_Id
  ) zest`;

// Czy rozmontowany zestaw wrocil na KFS tuz przed rozmontowaniem = skladniki sa na WOZKU
// ZWROTOW. KFS to dokument HANDLOWY -> pozycje przez ob_DokHanId (nie MagId!).
const ROZMONTOWANIE_Z_ZWROTU = `
  EXISTS (
    SELECT 1 FROM dok__Dokument kfs
    JOIN dok_Pozycja kp ON kp.ob_DokHanId = kfs.dok_Id
    WHERE kfs.dok_Typ = @kfsTyp AND kp.ob_TowId = zest.zestaw_id
      AND kfs.dok_DataWyst >= DATEADD(day, -@oknoKfs, pw.dok_DataWyst)
      AND kfs.dok_DataWyst <= pw.dok_DataWyst
  )`;

// PRZYDZIAL ILOSCIOWY zwrotow do rozmontowan (zamiast flagi "czy istnieje jakikolwiek KFS").
//
// Po co: sam EXISTS odpowiadal wspolnie dla CALEGO SKU w oknie, wiec jeden zwrocony egzemplarz
// "uzyczal" flagi kazdemu kolejnemu rozmontowaniu tego zestawu - takze wzietemu ze stanu.
// Zmierzone na bazie: 34 ze 137 zestawow mialo wiecej rozmontowan oznaczonych "z zwrotu", niz
// kiedykolwiek wrocilo (NERCHIELIT100: 152 szt. oznaczone vs 65 zwroconych).
//
// Model: kazda zwrocona sztuka jest wazna przez OKNO_ROZMONTOWANIE_KFS_DNI od daty KFS i moze
// byc zuzyta RAZ. Rozmontowania ida chronologicznie i konsumuja najstarsze wazne sztuki.
// Rozmontowanie, ktore skonsumowalo cokolwiek = "z zwrotu".
//
// Czesciowe pokrycie (rozmontowano 6, wrocila 1) tez liczymy jako "z zwrotu" - bledy nie sa
// symetryczne: falszywe "z zwrotu" to tylko zbedne zadanie (magazynier i tak odlozy towar na
// polke i stan wyjdzie dobrze), a falszywe "ze stanu" kaze auto-dopisowi WPISAC nieprawde
// o lokalizacji. W watpliwosci wybieramy zadanie.
function przydzielZwroty(rozmontowania, zwroty) {
  const oknoMs = OKNO_ROZMONTOWANIE_KFS_DNI * 24 * 3600 * 1000;
  const pulaPoZestawie = new Map();
  for (const z of zwroty) {
    if (!pulaPoZestawie.has(z.zestaw_id)) pulaPoZestawie.set(z.zestaw_id, []);
    pulaPoZestawie.get(z.zestaw_id).push({ czas: z.data.getTime(), pozostalo: z.ilosc });
  }
  for (const lista of pulaPoZestawie.values()) lista.sort((a, b) => a.czas - b.czas);

  // chronologicznie - inaczej pozniejsze rozmontowanie zjadloby sztuke nalezna wczesniejszemu
  const wszystkie = [...rozmontowania].sort((a, b) => a.data.getTime() - b.data.getTime());
  for (const r of wszystkie) {
    const pula = pulaPoZestawie.get(r.zestaw_id) || [];
    const czas = r.data.getTime();
    let potrzeba = r.zestawow;
    let zuzyto = 0;
    for (const sztuki of pula) {
      if (potrzeba <= 0) break;
      // wazne: zwrot musi byc PRZED rozmontowaniem i nie starszy niz okno
      if (sztuki.pozostalo <= 0 || sztuki.czas > czas || sztuki.czas < czas - oknoMs) continue;
      const bierz = Math.min(sztuki.pozostalo, potrzeba);
      sztuki.pozostalo -= bierz;
      potrzeba -= bierz;
      zuzyto += bierz;
    }
    r.z_zwrotu = zuzyto > 0;
  }
  return wszystkie;
}

// Wczytuje WSZYSTKIE rozmontowania podanych zestawow + ich zwroty i robi przydzial.
// Zwraca Map<pw_nr, { zestaw_id, zestaw_symbol, data, zestawow, z_zwrotu }>.
//
// Czemu wszystkie, a nie tylko te "widoczne": przydzial musi dac ten sam wynik niezaleznie od
// tego, czyj ekran o niego pyta. Liczac tylko po widocznych, ten sam PW raz bylby zwrotem,
// a raz nie. Stad tez margines czasowy - rozmontowanie sprzed `od` tez zuzylo swoja sztuke.
async function przydzielDlaZestawow(zestawIds, od) {
  const wynik = new Map();
  if (!zestawIds.length) return wynik;

  const oknoMs = OKNO_ROZMONTOWANIE_KFS_DNI * 24 * 3600 * 1000;
  const odRozm = new Date(od.getTime() - oknoMs);       // rozmontowania, ktore juz zjadly pule
  const odZwrot = new Date(od.getTime() - 2 * oknoMs);  // zwroty widziane przez tamte

  const parametry = { pwTyp: PW_TYP, rwTyp: RW_TYP, kfsTyp: KFS_TYP, mag: MAG_K4,
    rodzajZestaw: TW_RODZAJ_ZESTAW, odRozm, odZwrot };
  const inZest = zestawIds.map((id, i) => { parametry[`z${i}`] = Number(id); return `@z${i}`; }).join(', ');

  const [rozm, zwr] = await Promise.all([
    query(`
      SELECT pw.dok_NrPelny AS pw_nr, pw.dok_DataWyst AS data,
             zest.zestaw_id, zest.zestaw_symbol, SUM(rwp2.ob_Ilosc) AS zestawow
      FROM dok__Dokument pw
      ${ROZMONTOWANIE_JOIN}
      JOIN dok_Pozycja rwp2 ON rwp2.ob_DokMagId = rw.dok_Id AND rwp2.ob_TowId = zest.zestaw_id
      WHERE pw.dok_Typ = @pwTyp AND pw.dok_DataWyst >= @odRozm
        AND zest.zestaw_id IN (${inZest})
      GROUP BY pw.dok_NrPelny, pw.dok_DataWyst, zest.zestaw_id, zest.zestaw_symbol
    `, parametry),
    query(`
      SELECT kp.ob_TowId AS zestaw_id, kfs.dok_DataWyst AS data, SUM(kp.ob_Ilosc) AS ilosc
      FROM dok__Dokument kfs
      JOIN dok_Pozycja kp ON kp.ob_DokHanId = kfs.dok_Id
      WHERE kfs.dok_Typ = @kfsTyp AND kfs.dok_DataWyst >= @odZwrot
        AND kp.ob_TowId IN (${inZest})
      GROUP BY kp.ob_TowId, kfs.dok_DataWyst
    `, parametry),
  ]);

  const przydzielone = przydzielZwroty(
    rozm.recordset.map((r) => ({
      pw_nr: String(r.pw_nr).trim(), data: r.data, zestaw_id: r.zestaw_id,
      zestaw_symbol: r.zestaw_symbol ? String(r.zestaw_symbol).trim() : null,
      zestawow: Number(r.zestawow) || 0,
    })),
    zwr.recordset.map((z) => ({ zestaw_id: z.zestaw_id, data: z.data, ilosc: Number(z.ilosc) || 0 })),
  );
  for (const r of przydzielone) wynik.set(r.pw_nr, r);
  return wynik;
}

// Klasyfikuje PW-ki rozmontowaniowe dla podanych towarow. Zwraca
// Map<`${twId}|${pwNr}`, { zestaw_symbol, z_zwrotu }>. Bez wpisu = PW to NIE rozmontowanie.
async function pobierzRozmontowaniaK4(twIds, od) {
  const wynik = new Map();
  if (!twIds || twIds.length === 0) return wynik;

  // 1) ktore PW dotykaja tych towarow i jakich zestawow dotycza
  const pary = [];
  const zestawIds = new Set();
  await Promise.all(naCzesci([...new Set(twIds.map(String))], 1000).map(async (paczka) => {
    const parametry = { pwTyp: PW_TYP, rwTyp: RW_TYP, mag: MAG_K4, rodzajZestaw: TW_RODZAJ_ZESTAW, od };
    const placeholders = paczka.map((id, i) => { parametry[`t${i}`] = Number(id); return `@t${i}`; }).join(', ');
    const { recordset } = await query(`
      SELECT DISTINCT o.ob_TowId AS tw_id, pw.dok_NrPelny AS pw_nr, zest.zestaw_id
      FROM dok__Dokument pw
      ${ROZMONTOWANIE_JOIN}
      JOIN dok_Pozycja o ON o.ob_DokMagId = pw.dok_Id
      WHERE pw.dok_Typ = @pwTyp AND o.ob_MagId = @mag
        AND pw.dok_DataWyst >= @od AND o.ob_TowId IN (${placeholders})
    `, parametry);
    for (const r of recordset) {
      pary.push({ tw_id: r.tw_id, pw_nr: String(r.pw_nr).trim() });
      zestawIds.add(r.zestaw_id);
    }
  }));
  if (!pary.length) return wynik;

  // 2) przydzial liczony po CALYM obrazie tych zestawow
  const przydzial = await przydzielDlaZestawow([...zestawIds], od);
  for (const p of pary) {
    const r = przydzial.get(p.pw_nr);
    if (r) wynik.set(`${p.tw_id}|${p.pw_nr}`, { zestaw_symbol: r.zestaw_symbol, z_zwrotu: r.z_zwrotu });
  }
  return wynik;
}

// Skladniki z rozmontowan "ZE STANU" (zestaw NIE wrocil na KFS) od podanej daty - wejscie dla
// auto-dopisu do polki. Nie znamy z gory zbioru towarow, wiec to zapytanie odwrotne.
// UWAGA: wywolujacy MUSI podac date odciecia (dzien wdrozenia) - rozmontowania sa w GT od 2019 r.
// i bez odciecia auto-dopis wrzucilby na polki ponad 150 tys. sztuk historycznych.
async function pobierzRozmontowaniaZeStanuOd(od) {
  if (!od) throw new Error('pobierzRozmontowaniaZeStanuOd wymaga daty odciecia');

  // Wszystkie skladniki rozmontowan od odciecia - bez klasyfikacji, ta idzie z przydzialu nizej
  // (ten sam rachunek, co widzi ekran; osobny warunek SQL rozjechalby job z lista).
  const { recordset } = await query(`
    SELECT o.ob_TowId AS tw_id, t.tw_Symbol AS symbol, t.tw_Nazwa AS nazwa,
           t.tw_PodstKodKresk AS ean, pw.dok_NrPelny AS pw_nr, pw.dok_DataWyst AS data,
           zest.zestaw_id, zest.zestaw_symbol, SUM(o.ob_Ilosc) AS ilosc
    FROM dok__Dokument pw
    ${ROZMONTOWANIE_JOIN}
    JOIN dok_Pozycja o ON o.ob_DokMagId = pw.dok_Id
    JOIN tw__Towar t ON t.tw_Id = o.ob_TowId AND t.tw_Rodzaj = @rodzaj
    WHERE pw.dok_Typ = @pwTyp AND o.ob_MagId = @mag AND pw.dok_DataWyst >= @od
    GROUP BY o.ob_TowId, t.tw_Symbol, t.tw_Nazwa, t.tw_PodstKodKresk,
             pw.dok_NrPelny, pw.dok_DataWyst, zest.zestaw_id, zest.zestaw_symbol
    ORDER BY pw.dok_DataWyst
  `, { pwTyp: PW_TYP, rwTyp: RW_TYP, mag: MAG_K4, od,
       rodzaj: TW_RODZAJ_TOWAR, rodzajZestaw: TW_RODZAJ_ZESTAW });
  if (recordset.length === 0) return [];

  const przydzial = await przydzielDlaZestawow([...new Set(recordset.map((r) => r.zestaw_id))], od);

  return recordset
    .filter((r) => przydzial.get(String(r.pw_nr).trim())?.z_zwrotu === false)
    .map((r) => ({
      artykul_gt_id: String(r.tw_id),
      symbol: r.symbol ? String(r.symbol).trim() : null,
      nazwa: r.nazwa ? String(r.nazwa).trim() : null,
      ean: r.ean ? String(r.ean).trim() : null,
      pw_nr: String(r.pw_nr).trim(),
      zestaw_symbol: r.zestaw_symbol ? String(r.zestaw_symbol).trim() : null,
      data: r.data instanceof Date ? r.data.toISOString().slice(0, 10) : null,
      ilosc: Number(r.ilosc) || 0,
    }));
}

// Kandydaci ZWROTOW = zwykle zwroty (PZ<-KFS) + skladniki z rozmontowania zwroconego zestawu.
// Te drugie maja PW, nie PZ, wiec same by tu nie trafily - a fizycznie leza na wozku zwrotow
// i wymagaja rozwiezienia dokladnie tak samo jak kazdy inny zwrot.
//
// UWAGA: tu zostaje permisywny EXISTS (czy zestaw ma jakikolwiek KFS w oknie), a nie przydzial
// ilosciowy z przydzielZwroty. To CELOWE i bezpieczne: kandydaci to tylko wstepne sito, a
// o zawartosci kubelka decyduje pobierzDostawyK4 (juz z przydzialem). EXISTS jest szerszy, wiec
// kandydaci sa NADZBIOREM - SKU bez wpisu w kubelku po prostu nie wygeneruje wiersza. Zwezenie
// tego warunku do przydzialu wymagaloby liczenia go dwa razy, a pomylka w druga strone (sito
// wezsze niz kubelek) UKRYLABY zwroty. Nie "naprawiac" bez przeczytania tego akapitu.
async function pobierzTowaryZeZwrotamiK4() {
  const od = odKiedy(OKNO_ZWROTY_PRZYWOZKI_DNI);
  const [zwykle, zRozmontowan] = await Promise.all([
    pobierzTowaryZeZrodlemK4(KFS_TYP),
    (async () => {
      const { recordset } = await query(`
        SELECT DISTINCT o.ob_TowId AS tw_id, t.tw_Symbol AS symbol, t.tw_Nazwa AS nazwa,
               t.tw_PodstKodKresk AS ean, t.tw_Pole1 AS lok_gt
        FROM dok__Dokument pw
        ${ROZMONTOWANIE_JOIN}
        JOIN dok_Pozycja o ON o.ob_DokMagId = pw.dok_Id
        JOIN tw__Towar t ON t.tw_Id = o.ob_TowId AND t.tw_Rodzaj = @rodzaj
        WHERE pw.dok_Typ = @pwTyp AND o.ob_MagId = @mag AND pw.dok_DataWyst >= @od
          AND ${ROZMONTOWANIE_Z_ZWROTU}
      `, { pwTyp: PW_TYP, rwTyp: RW_TYP, kfsTyp: KFS_TYP, mag: MAG_K4, od,
           rodzaj: TW_RODZAJ_TOWAR, rodzajZestaw: TW_RODZAJ_ZESTAW, oknoKfs: OKNO_ROZMONTOWANIE_KFS_DNI });
      return recordset.map((r) => ({
        artykul_gt_id: String(r.tw_id),
        symbol: r.symbol ? String(r.symbol).trim() : null,
        nazwa: r.nazwa ? String(r.nazwa).trim() : null,
        ean: r.ean ? String(r.ean).trim() : null,
        lok_gt: r.lok_gt ? String(r.lok_gt).trim() : null,
      }));
    })(),
  ]);

  // dedup po artykule - SKU moze miec i zwykly zwrot, i rozmontowanie
  const poId = new Map();
  for (const k of [...zwykle, ...zRozmontowan]) if (!poId.has(k.artykul_gt_id)) poId.set(k.artykul_gt_id, k);
  return [...poId.values()];
}

// JEDNA mapa rodzajow stref: rodzaj -> kubelek z rozbijStanK4 + zapytanie odwrotne
// ("ktore SKU maja w ogole taki dokument", gdy nie znamy zbioru z gory).
//
// Po co mapa zamiast trzech wywolan w kazdym konsumencie: nowy rodzaj wypadal juz CZTERY razy
// po cichu (raz z /ruchy/rozloz, raz z reguly "cala ilosc" w /lok, raz z audytu, raz z Historii
// ruchow) - za kazdym razem dlatego, ze ktos skladal liste rodzajow recznie. Dopisujac czwarty
// rodzaj dopisz go TUTAJ, a konsumenci (filtr stref w /produkty, listy) zobacza go sami.
const RODZAJE_STREF = {
  dostawa:        { kubelek: 'dostawy',    kandydaci: pobierzTowaryZDostawamiK4 },
  zwrot:          { kubelek: 'zwroty',     kandydaci: pobierzTowaryZeZwrotamiK4 },
  przywozka:      { kubelek: 'przywozki',  kandydaci: pobierzTowaryZPrzywozkamiK4 },
  przyjecie_wewn: { kubelek: 'przyjecia',  kandydaci: () => pobierzTowaryZPrzyjeciamiWewnK4() },
};

// Kandydaci z PRZYJECIA WEWNETRZNEGO: PW (typ 12) na K4, rodzaj 1, NIE z automatu kompletacji.
// To przychod BEZ dokumentu zrodlowego - korekta stanu, inwentura, reczne dolozenie. Sam PW
// jest dokumentem (jak przywozka). Do 2026-07-18 nie lapany, przez co "nieznany przychod" na
// karcie byl anonimowy; teraz ma nazwe i numer PW. Okno drobne (14 dni) - to drobne, czeste
// przyjecia, jak zwroty/przywozki.
async function pobierzTowaryZPrzyjeciamiWewnK4() {
  const od = odKiedy(OKNO_ZWROTY_PRZYWOZKI_DNI);
  const { recordset } = await query(`
    SELECT DISTINCT o.ob_TowId AS tw_id, t.tw_Symbol AS symbol, t.tw_Nazwa AS nazwa,
           t.tw_PodstKodKresk AS ean, t.tw_Pole1 AS lok_gt
    FROM dok__Dokument dok
    JOIN dok_Pozycja o ON o.ob_DokMagId = dok.dok_Id
    JOIN tw__Towar t ON t.tw_Id = o.ob_TowId AND t.tw_Rodzaj = @rodzaj
    WHERE dok.dok_Typ = @pwTyp AND o.ob_MagId = @mag
      AND ISNULL(dok.dok_Wystawil, '') <> @automat
      AND dok.dok_DataWyst >= @od
  `, { pwTyp: PW_TYP, mag: MAG_K4, od, rodzaj: TW_RODZAJ_TOWAR, automat: KONTO_KOMPLETACJI });

  return recordset.map((r) => ({
    artykul_gt_id: String(r.tw_id),
    symbol: r.symbol ? String(r.symbol).trim() : null,
    nazwa: r.nazwa ? String(r.nazwa).trim() : null,
    ean: r.ean ? String(r.ean).trim() : null,
    lok_gt: r.lok_gt ? String(r.lok_gt).trim() : null,
  }));
}

// Kandydaci z PRZYWOZKA: MM z magazynu zewnetrznego na K4, wystawione POZA WMS. Osobne
// zapytanie, bo przywozka nie ma dokumentu zrodlowego (dok_DoDokId) - sama jest dokumentem,
// a kierunek czytamy z dok_MagId (zrodlo) + dok_OdbiorcaId (cel). Warunki takie same jak w
// galezi UNION w pobierzDostawyK4 - musza zostac spojne, inaczej lista pokaze kandydata,
// dla ktorego rozbicie nie znajdzie dokumentu (i odwrotnie).
async function pobierzTowaryZPrzywozkamiK4() {
  const od = odKiedy(OKNO_ZWROTY_PRZYWOZKI_DNI);
  const zewnGtIds = MAGAZYNY_ZEWNETRZNE.map((k) => MAGAZYN_GT_ID[k]).filter(Boolean);
  if (!zewnGtIds.length) return [];

  const parametry = { mmTyp: MM_TYP, mag: MAG_K4, od, rodzaj: TW_RODZAJ_TOWAR };
  const zewnPlaceholders = zewnGtIds.map((id, i) => {
    parametry[`z${i}`] = id;
    return `@z${i}`;
  }).join(', ');

  const { recordset } = await query(`
    SELECT DISTINCT o.ob_TowId AS tw_id, t.tw_Symbol AS symbol, t.tw_Nazwa AS nazwa,
           t.tw_PodstKodKresk AS ean, t.tw_Pole1 AS lok_gt
    FROM dok__Dokument dok
    JOIN dok_Pozycja o ON o.ob_DokMagId = dok.dok_Id
    JOIN tw__Towar t ON t.tw_Id = o.ob_TowId AND t.tw_Rodzaj = @rodzaj
    WHERE dok.dok_Typ = @mmTyp AND dok.dok_OdbiorcaId = @mag
      AND dok.dok_MagId IN (${zewnPlaceholders})
      AND ISNULL(dok.dok_Uwagi, '') NOT LIKE 'WMS-RUCH:%'
      AND dok.dok_DataWyst >= @od
  `, parametry);

  return recordset.map((r) => ({
    artykul_gt_id: String(r.tw_id),
    symbol: r.symbol ? String(r.symbol).trim() : null,
    nazwa: r.nazwa ? String(r.nazwa).trim() : null,
    ean: r.ean ? String(r.ean).trim() : null,
    lok_gt: r.lok_gt ? String(r.lok_gt).trim() : null,
  }));
}

async function pobierzDostawyK4(twIds) {
  const wynik = new Map();
  if (!twIds || twIds.length === 0) return wynik;

  // Te same okna i ta sama data odciecia, co w zapytaniach odwrotnych (pobierzTowaryZ*) -
  // rozjazd dalby kandydata, dla ktorego rozbicie nie znajdzie dokumentu, i odwrotnie.
  const od = odKiedy(OKNO_DOSTAWY_DNI);
  const odDrobne = odKiedy(OKNO_ZWROTY_PRZYWOZKI_DNI);

  // magazyny zewnetrzne (MAG/LS/BRK) jako mag_Id GT - zrodla przywozek
  const zewnGtIds = MAGAZYNY_ZEWNETRZNE.map((k) => MAGAZYN_GT_ID[k]).filter(Boolean);

  // Ktore z tych PW to rozmontowanie zestawu ZE ZWROTU - takie skladniki leza na wozku
  // zwrotow, wiec ida do kubelka "zwrot", a nie "przyjecie_wewn". To samo okno co PW nizej.
  const rozmontowania = await pobierzRozmontowaniaK4(twIds, odDrobne);

  await Promise.all(naCzesci([...new Set(twIds.map(String))], 1000).map(async (paczka) => {
    const parametry = { pzTyp: PZ_TYP, fzTyp: FZ_TYP, kfsTyp: KFS_TYP, mmTyp: MM_TYP,
      pwTyp: PW_TYP, rodzajTow: TW_RODZAJ_TOWAR, automat: KONTO_KOMPLETACJI, mag: MAG_K4, od, odDrobne };
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

      UNION ALL

      -- PRZYJECIA WEWNETRZNE: PW na K4, rodzaj 1, poza automatem kompletacji. Przychod bez
      -- dokumentu zrodlowego - sam PW jest dokumentem (jak przywozka). Zrodlo_typ=PW rozpoznaje
      -- rodzaj nizej.
      SELECT o.ob_TowId, dok.dok_NrPelny AS dok_nr,
             @pwTyp AS zrodlo_typ, dok.dok_NrPelny AS zrodlo_nr, NULL AS kontrahent,
             NULL AS zrodlo_mag, dok.dok_DataWyst AS data, SUM(o.ob_Ilosc) AS ilosc, dok.dok_Id AS dok_id
      FROM dok__Dokument dok
      JOIN dok_Pozycja o ON o.ob_DokMagId = dok.dok_Id
      JOIN tw__Towar t ON t.tw_Id = o.ob_TowId AND t.tw_Rodzaj = @rodzajTow
      WHERE dok.dok_Typ = @pwTyp AND o.ob_MagId = @mag
        AND ISNULL(dok.dok_Wystawil, '') <> @automat
        AND dok.dok_DataWyst >= @odDrobne
        AND o.ob_TowId IN (${placeholders})
      GROUP BY o.ob_TowId, dok.dok_Id, dok.dok_NrPelny, dok.dok_DataWyst

      ORDER BY data DESC, dok_id DESC
    `, parametry);

    for (const r of recordset) {
      const klucz = String(r.ob_TowId);
      if (!wynik.has(klucz)) wynik.set(klucz, []);
      const pwNr = r.dok_nr ? String(r.dok_nr).trim() : '';
      const rozm = r.zrodlo_typ === PW_TYP ? rozmontowania.get(`${r.ob_TowId}|${pwNr}`) : null;

      // Rozmontowanie ZE STANU nie jest zadaniem dla nikogo: skladniki zostaly tam, gdzie stal
      // zestaw. Albo dopisze je job (services/rozmontowania.js, gdy SKU ma jedna lokalizacje K4),
      // albo - gdy WMS nie zna miejsca - maja spasc do "do zlokalizowania" razem z reszta stanu
      // bez dokumentu. Zostawienie ich w kubelku PW robilo z 1 szt. rozmontowania zadanie
      // ciagnace CALY nieprzypisany stan SKU (3212 szt. przy NEROPA200) - czysty szum.
      if (rozm && !rozm.z_zwrotu) continue;

      const rodzaj = r.zrodlo_mag ? 'przywozka'
        : r.zrodlo_typ === FZ_TYP ? 'dostawa'
        // PW z rozmontowania zwroconego zestawu = skladniki na wozku zwrotow -> kubelek zwrotu
        : r.zrodlo_typ === PW_TYP ? (rozm?.z_zwrotu ? 'zwrot' : 'przyjecie_wewn')
        : 'zwrot';
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

// Kolejnosc ZJADANIA stanu K4 - co schodzi, gdy stan GT spada (sprzedaz, RW, rozchod
// zewnetrzny, MM zrobione w Subiekcie, MM na Reklamacje). Decyzja usera 2026-07-17:
//
//   do sprawdzenia -> POLKA -> dostawa -> zwrot -> przywozka
//
// Sedno: konsumentow NIE rozpoznajemy. Kazdy z nich robi dokladnie jedno - zbija st_Stan na K4.
// Skoro polka jest RESZTA z odejmowania, kazdy zjada ja sam z siebie i nie ma listy typow
// dokumentow do utrzymania (regula przeszla test na magazynie K4R, o ktorym nikt nie wiedzial).
//
// Dlaczego taka kolejnosc miedzy strefami (gdy polka = 0, a strefy sa dwie):
//   dostawa 1. - duza, prosta paleta; przy pustej polce towar jest tam, gdzie ona stoi.
//                Pomylka jest GLOSNA: zasada 6 sprawdzi stan i rzuci bledem przy rozkladaniu.
//   zwrot   2. - "zawsze niepewny", wiec chroniony w srodku. Zjedzony po cichu kasuje zadanie
//                "odnies na regal" i sztuki zostaja w strefie, o ktorych nikt sie nie dowie.
//   przywozka 3. - nie sprowadza sie towaru z MAG/LS, gdy stan jest na K4, wiec remis z paleta
//                  praktycznie nie zachodzi. Ostatnie miejsce jest dla niej bezpieczne.
// W obrebie rodzaju: FIFO - najstarszy dokument zjadany pierwszy (najdluzej wisi = najwieksza
// szansa, ze to widmo).
//
// !!! W PETLI PRZYDZIELAMY BUDZET, wiec kolejnosc jest ODWROTNA do kolejnosci zjadania:
// kto schodzi PIERWSZY, dostaje resztowke, czyli musi byc w petli OSTATNI. Latwo napisac na
// odwrot i dostac wynik, ktory wyglada sensownie. Test to pilnuje.
// przyjecie_wewn (PW) wciete miedzy zwrot a przywozke: to tez drobnica lezaca w szufladzie
// (nie na polce pickowej), wiec chroniona przed zjedzeniem jak zwrot. Wzgledna kolejnosc
// dostawa > zwrot > przywozka zachowana (test tego pilnuje).
const PRIORYTET_PRZYDZIALU = { przywozka: 0, przyjecie_wewn: 1, zwrot: 2, dostawa: 3 };

// Nieznany rodzaj ladowal dotad na kubelku `dostawa` (`kubelki[d.rodzaj] || kubelki.dostawa`),
// czyli po zmianie wskoczylby od razu na PIERWSZE miejsce zjadania i jego zadanie znikaloby
// najszybciej. Dajemy mu priorytet -1 = przydzial pierwszy = zjadany ostatni: widoczny wiersz
// jest mniejszym zlem niz cicho skasowane zadanie. Prawdziwym zabezpieczeniem jest test
// sprawdzajacy, ze RODZAJE_STREF i PRIORYTET_PRZYDZIALU maja te same klucze.
const priorytet = (rodzaj) => PRIORYTET_PRZYDZIALU[rodzaj] ?? -1;

// Rozbija stan K4 na rozlaczne czesci, ktore NIE nachodza na siebie:
//   dostawy    - PZ<-FZ, paleta od dostawcy (rozkladana dowolnie, dol/gora, w czesciach)
//   zwroty     - PZ<-KFS, sztuki lezace w strefie zwrotow (wracaja na regal)
//   przywozki  - MM z MAG/LS, towar w strefie przywozki (wraca na regal)
//   polka      - ile MOZE lezec na polce pickowej wg GT (kopia WMS bywa starsza - patrz nizej)
//   reszta     - "do sprawdzenia": stan, o ktorym WMS nic nie wie (wszedl poza naszym obiegiem)
//
// Kubelek dokumentu = ilosc z PZ MINUS to, co z TEGO dokumentu juz rozlozylismy.
//
// CAP STANEM, NIE DEFICYTEM (zmiana 2026-07-17). Wczesniej strefy byly capowane deficytem
// (stan GT - polka), przez co sprzedaz kurczyla WIERSZ DOSTAWY zamiast polki: paleta 4080 po
// dwoch dniach pokazywala 4075 i backend ucinal rozlozenie, zostawiajac w GT 5 szt. "na K4",
// ktore fizycznie pojechaly na gore. Teraz strefy ogranicza tylko sam stan (strefa nie moze
// trzymac wiecej sztuk, niz w ogole lezy na K4), a polka bierze to, co zostanie - czyli to ona
// absorbuje sprzedaz. To jest regula #3 usera: "zejscie ze stanu jest zawsze z lokalizacji
// zapisanej, chyba ze lokalizacji nie ma lub jest zero".
//
// GRANICA, swiadomie zostawiona: `reszta` schodzi PRZED polka, bo jest definiowana jako
// reszta - nie ma niezaleznej liczby, ktora dalaby sie zbic pozniej. Gdy reszta = 0 (stan
// docelowy), regula #3 dziala dokladnie. Naprawa wymagalaby snapshotow stanu GT.
//
// stanGt  - st_Stan z GT (master ilosci)
// sumaWms - suma stany_lokalizacji dla tego magazynu (kopia WMS; moze byc STARSZA od GT,
//           bo sprzedaz w Subiekcie zbija stan bez wiedzy WMS)
function rozbijStanK4(stanGt, sumaWms, dokumenty, { artykul_gt_id, magazyn = MAG_KOD_K4 } = {}) {
  let zostalo = Math.max(Number(stanGt) || 0, 0);
  const polkaKopia = Math.max(Number(sumaWms) || 0, 0);
  const kubelki = { dostawa: [], zwrot: [], przywozka: [], przyjecie_wewn: [] };

  // stabilny sort: priorytet przydzialu, a w obrebie rodzaju najnowszy pierwszy (= najstarszy
  // dostaje resztowke = jest zjadany pierwszy). `data` to 'YYYY-MM-DD' albo null.
  const wgPrzydzialu = [...(dokumenty || [])].sort((a, b) =>
    priorytet(a.rodzaj) - priorytet(b.rodzaj)
    || String(b.data ?? '').localeCompare(String(a.data ?? '')));

  for (const d of wgPrzydzialu) {
    if (zostalo <= 0) break;
    const juz = artykul_gt_id ? iloscRozlozonaZDokumentu(artykul_gt_id, magazyn, d.pz_nr) : 0;
    const pozostalo = d.ilosc - juz;
    if (pozostalo <= 0) continue;             // ten dokument juz rozlozony w calosci
    const ilosc = Math.min(pozostalo, zostalo);
    (kubelki[d.rodzaj] || kubelki.dostawa).push({ ...d, ilosc });
    zostalo -= ilosc;
  }

  // Polka bierze, ile zostanie po strefach. Gdy kopia WMS jest wyzsza - roznica to sprzedaz,
  // ktorej WMS nie zauwazyl; auto-korekta w jobie rozjazdow sciagnie kopie do stanu GT.
  const polka = Math.min(polkaKopia, zostalo);
  zostalo -= polka;

  // `wszystkie` = te same pozycje w jednej liscie. Konsumenci, ktorych interesuje "ile lezy
  // w drodze", "co jest do rozlozenia" albo ktorzy skladaja liste pozycji na ekran, MAJA
  // uzywac tego pola (payload oddaje je jako `wszystkie_k4`) - recznie skladane
  // [...dostawy, ...zwroty] cichnie sie psuje przy kazdym nowym rodzaju (tak zniknely
  // przywozki z /ruchy/rozloz i z reguly "cala ilosc" w /lok, a potem PW z karty i modalu).
  //
  // Object.values(kubelki) -> kolejnosc wstawienia kluczy do `kubelki` (dostawa, zwrot,
  // przywozka, przyjecie_wewn): dostawa pierwsza (najwieksza robota), potem drobnica ze stref.
  // Nowy rodzaj dodany do inicjalizacji `kubelki` wpada tu SAM - o to chodzi, zeby konsument
  // wszystkie_k4 nie wymagal dotkniecia.
  const wszystkie = Object.values(kubelki).flat();
  return {
    dostawy: kubelki.dostawa,
    zwroty: kubelki.zwrot,
    przywozki: kubelki.przywozka,
    przyjecia: kubelki.przyjecie_wewn,      // PW - przychod wewnetrzny z dokumentem
    wszystkie,
    wDrodze: wszystkie.reduce((s, d) => s + d.ilosc, 0),
    polka,                                  // ile faktycznie moze lezec na polce
    polka_kopia: polkaKopia,                // co o tym mysli WMS
    polka_klamie: polkaKopia - polka,       // ile sprzedazy zeszlo z polki bez wiedzy WMS
    reszta: zostalo,                        // "do sprawdzenia" - przychod BEZ dokumentu
  };
}

module.exports = {
  znajdzMM, znajdzMMpoKluczu, kluczRuchu, budujUwagiMM, pobierzZkRezerwujaceK4,
  pobierzDostawyK4, pobierzTowaryZeZwrotamiK4, pobierzTowaryZDostawamiK4,
  pobierzTowaryZPrzywozkamiK4, pobierzTowaryZPrzyjeciamiWewnK4, rozbijStanK4, iloscRozlozonaZDokumentu,
  pobierzRozmontowaniaK4, pobierzRozmontowaniaZeStanuOd, przydzielDlaZestawow, przydzielZwroty,
  RODZAJE_STREF, PRIORYTET_PRZYDZIALU, DOKUMENTY_OD,
};
