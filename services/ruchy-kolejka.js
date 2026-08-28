'use strict';

// Decyzje kolejki ruchow - czyste funkcje, BEZ SQLite i GT (testowalne: test/ruchy-kolejka.test.js).
// Odpowiadaja na dwa pytania, ktore wczesniej nie mialy zadnej odpowiedzi:
//   1. "czy ten ruch ma sens ponawiac dalej?"  -> klasyfikujOdpowiedzMostu + czyWstrzymac
//   2. "czy magazynier nie zrobil tego samego przesuniecia jeszcze raz, recznie?" -> dopasujPowtorzenie
//
// Skad to sie wzielo (incydent 2026-08-28, NERG0319): MM #5498 (K4 -> BRK, 15 szt.) odbil sie
// od Sfery bledem 0x80040F1E. Magazynier nie czekal na automatyczne ponowienie, tylko powtorzyl
// operacje recznie - powstal ruch #5500, ktory przeszedl (MM 1242/2026) i zabral towar z K4.
// Od tej chwili #5498 nie mial juz szans: job ponawial go co 5 minut, Sfera za kazdym razem
// odpowiadala "Brak towaru na magazynie zrodlowym", a kazda taka odmowa zapalala w calym WMS
// czerwony pasek "Sfera zglosila blad". 17 prob, alarm bez konca, most i Sfera calkiem zdrowe.

// Po tylu odmowach Sfery przestajemy ponawiac automatycznie (status 'wstrzymany').
// 3 = ~10 minut przy jobie co 5 min. Odmowa Sfery nie naprawia sie sama: "brak towaru"
// znaczy, ze stan magazynu zrodlowego juz nie pokrywa ruchu, a to zmienia dopiero czlowiek.
const LIMIT_ODMOW_SFERY = 3;

// Jak dlugo po ruchu szukamy jego recznego powtorzenia. Powtorzenie to reakcja czlowieka
// na komunikat bledu - dzieje sie w sekundach/minutach (w incydencie: 20 s). Okno jest
// szerokie z zapasem, ale skonczone: MM na ten sam towar, kierunek i ilosc nazajutrz to
// normalna praca magazynu, nie duplikat.
const OKNO_POWTORZENIA_MIN = 120;

// Rodzaje odpowiedzi mostu na probe wystawienia MM. Rozroznienie jest sednem limitu prob:
// tylko odpowiedz OD SFERY liczy sie do limitu - jesli mostu po prostu nie ma (padl, restart,
// pecet sie restartuje), ruch ma czekac dowolnie dlugo i dogonic sie sam, gdy most wroci.
const BRAK_MOSTU = 'brak-mostu';        // nie dolaczylismy sie do procesu mostu
const ODMOWA_BIZNESOWA = 'biznesowa';   // Sfera odpowiedziala merytorycznie: brak towaru itp.
const ODMOWA_TECHNICZNA = 'techniczna'; // Sfera/COM sie wywrocilo (blad zapisu, licencja, HRESULT)

// Klasyfikuje odpowiedz services/gt-bridge.js (`{ok, status, dane, blad}`).
// `dane.rodzaj` przysyla NOWY most (biznesowy/techniczny); stary most tego pola nie ma -
// wtedy kazda merytoryczna odpowiedz z bledem liczy sie jak odmowa techniczna. Dzieki temu
// limit dziala tez zanim most zostanie zaktualizowany (Node wdraza sie osobno od mostu).
function klasyfikujOdpowiedzMostu(odpowiedz) {
  const o = odpowiedz ?? {};
  const dane = o.dane ?? null;
  // status 0 = fetch nie doszedl (proces nie odpowiada). Brak jakiegokolwiek body przy
  // nie-OK tez znaczy "cos po drodze", nie "Sfera powiedziala nie".
  if (o.status === 0 || (!o.ok && !dane)) {
    return { rodzaj: BRAK_MOSTU, odSfery: false, opis: o.blad ?? `Most GT zwrocil status ${o.status}` };
  }
  const opis = o.blad ?? dane?.blad ?? `Most GT zwrocil status ${o.status}`;
  const rodzaj = dane?.rodzaj === 'biznesowy' ? ODMOWA_BIZNESOWA : ODMOWA_TECHNICZNA;
  return { rodzaj, odSfery: true, opis };
}

// Czy przestac ponawiac automatycznie. Liczymy WYLACZNIE odmowy Sfery (patrz wyzej).
function czyWstrzymac(odmowySfery, limit = LIMIT_ODMOW_SFERY) {
  return Number(odmowySfery ?? 0) >= limit;
}

// Roznica w minutach miedzy znacznikami z SQLite (UTC, "2026-08-28 11:35:56").
// Zwraca null, gdy ktorykolwiek jest nieczytelny - wtedy dopasowanie odpada (nie zgadujemy).
function minutyMiedzy(odCzasu, doCzasu) {
  const parsuj = (s) => {
    if (!s) return null;
    const t = new Date(String(s).replace(' ', 'T') + 'Z').getTime();
    return Number.isNaN(t) ? null : t;
  };
  const a = parsuj(odCzasu);
  const b = parsuj(doCzasu);
  if (a === null || b === null) return null;
  return (b - a) / 60000;
}

// Czy kandydat to REczne powtorzenie naszego ruchu. Kandydat = dokument MM znaleziony w GT,
// ktorego Uwagi wskazuja na INNY ruch WMS (klucz "WMS-RUCH:<id>"), zestawiony z wierszem tego
// ruchu z SQLite. Wymagamy kompletu: ten sam towar, ta sama ilosc, ten sam kierunek, ruch
// zakonczony sukcesem i wykonany PO naszym, w oknie czasowym.
//
// Celowo NIE wystarcza "dokument na ten towar w tym kierunku": magazynier moze legalnie
// przesunac ten sam towar dwa razy tego samego dnia. Duplikatem czyni go dopiero to, ze
// drugi ruch jest kopia pierwszego (ilosc co do sztuki) zrobiona zaraz po nieudanej probie.
function czyPowtorzenie(nasz, kandydat, oknoMin = OKNO_POWTORZENIA_MIN) {
  if (!nasz || !kandydat) return false;
  if (Number(kandydat.ruchId) === Number(nasz.id)) return false;      // nasz wlasny dokument
  if (kandydat.status !== 'ok') return false;                          // niedokonczony nie zastepuje
  if (String(kandydat.artykul_gt_id) !== String(nasz.artykul_gt_id)) return false;
  if (Number(kandydat.ilosc) !== Number(nasz.ilosc)) return false;
  if (kandydat.mag_zrodlo !== nasz.mag_zrodlo) return false;
  if (kandydat.mag_cel !== nasz.mag_cel) return false;

  const minuty = minutyMiedzy(nasz.data_ruchu, kandydat.data_ruchu);
  if (minuty === null) return false;
  return minuty >= 0 && minuty <= oknoMin;                             // powtorzenie idzie PO oryginale
}

// Co zrobic z ruchem, dla ktorego znalezlismy reczne powtorzenie: zamknac go od razu
// ('duplikat') czy tylko zatrzymac ponawianie i oddac sprawe czlowiekowi ('wstrzymany')?
//
// Rozstrzyga to, czy stany WMS sa juz uporzadkowane BEZ naszego udzialu:
//   * ruch ze zrodlem w lokalizacji WMS (zwykle MM z polki) - TAK. Nasz ruch zdjal ilosc z
//     polki od razu przy zapisie, wiec powtorka musiala zaczac od ponownego przypisania towaru
//     (WMS nie przeniesie czegos, czego na lokalizacji nie ma). Obie strony zeszly raz - stany
//     sie zgadzaja, zamykamy jako 'duplikat' i nie ruszamy niczego.
//   * ruch bez zrodla w WMS (rozlozenie z nieprzypisanej puli, przyjecie z MAG/LS) - NIE.
//     Zrodlem jest pula albo magazyn zewnetrzny, wiec powtorka mogla przejsc BEZ zadnej
//     kompensacji i dolozyc te sama ilosc na lokalizacje drugi raz. Cofniecie stanow bywa tu
//     wlasciwe, ale rownie dobrze moze nie byc - a to juz decyzja o stanach, wiec nalezy do
//     czlowieka ("Usun" cofa, "Ponow" probuje jeszcze raz). Zatrzymujemy samo ponawianie.
function czyPowtorzenieZamykaRuch(ruch) {
  return !!(ruch && ruch.lok_zrodlo_id);
}

// Pierwszy kandydat spelniajacy czyPowtorzenie (albo null). Kolejnosc listy = kolejnosc
// wywolujacego; przy kilku pasujacych bierzemy pierwszy - kazdy z nich wyklucza nasz ruch
// tak samo, a numer dokumentu trafia tylko do opisu dla czlowieka.
function dopasujPowtorzenie(nasz, kandydaci, oknoMin = OKNO_POWTORZENIA_MIN) {
  for (const k of kandydaci ?? []) {
    if (czyPowtorzenie(nasz, k, oknoMin)) return k;
  }
  return null;
}

module.exports = {
  klasyfikujOdpowiedzMostu, czyWstrzymac, czyPowtorzenie, dopasujPowtorzenie,
  czyPowtorzenieZamykaRuch, minutyMiedzy,
  LIMIT_ODMOW_SFERY, OKNO_POWTORZENIA_MIN,
  BRAK_MOSTU, ODMOWA_BIZNESOWA, ODMOWA_TECHNICZNA,
};
