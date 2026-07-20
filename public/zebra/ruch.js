// Ekran "Ruch towaru" - zlaczony MM + zmiana lokalizacji (zob. desktopowe "okno akcji").
// Operacja wynika z wyboru celu w kroku 3:
//   - "Ta sama (zmiana lokalizacji)" lub przypisanie pierwszej lokalizacji -> LOK
//   - inny magazyn WMS / zewnetrzny -> MM
// Wspolne helpery (el, komunikaty, onScan, operator) pochodza z kreator.js,
// formatowanie kart i wyslijRuch z karta-produktu.js.

// wartownik wartosci selecta "cel" oznaczajacy LOK w obrebie magazynu zrodlowego
const SAME = '__SAME__';

const stan = {
  artykul: null,   // {artykul_gt_id, artykul_symbol, artykul_nazwa, stany_gt, lokalizacja_gt}
  zrodlo: null,    // {lokalizacja_id, kod, magazyn, ilosc} albo null - produkt bez lokalizacji w WMS
  cel: null,       // {typ:'wms', id, kod, magazyn} albo {typ:'zew', magazyn, nazwa}
  iloscSugestia: null, // podpowiedz ilosci przy braku zrodla (np. deficyt K4gora)
  zrodloPula: null,  // 'K4' = zrodlem jest NIEPRZYPISANA pula magazynu (dostawa PZ<-FZ albo
                     // zwrot PZ<-KFS, jeszcze bez miejsca w WMS) -> zapis idzie w /ruchy/rozloz
  zrodloDok: null,   // numer PZ rozkladanego dokumentu - backend rozlicza po nim kubelek
  dostawa: null,     // {rodzaj, pz_nr, fz_nr, kontrahent, zrodlo_mag, data, ilosc} - rozkladana
                     // pozycja: dostawa / zwrot / przywozka (rodzaj steruje podpisem i celem)
  celMagazynNowejLokalizacji: null, // magazyn wymagany dla nowej lokalizacji przy braku zrodla
                                     // (np. 'K4G' z opcji "+ Nowa lokalizacja K4G") - gdy null,
                                     // magazyn jest zgadywany na podstawie stanow GT
  zapasK4Pierwotny: '', // obecny zapas K4 (zapas_kod) - do wykrycia zmiany pola w kroku celu
};

// krok 3 - kod lokalizacji oczekujacy na potwierdzenie utworzenia (gdy skan nie pasuje do istniejacej)
let kodDoUtworzenia = null;

// krok 2 - co aktualnie wybieramy z listy
let opcjeWyboru = []; // [{klucz, artykul, zrodlo, etykieta, ilosc}]
// krok 2, tryb 'szukaj' - ostatnia lista artykulow z wyszukiwania po nazwie (do ponownego
// renderowania po zmianie checkboxa "Ukryj produkty bez stanu")
let ostatniaListaArtykulow = null;
// ostatni wpisany tekst wyszukiwania po nazwie - zostaje w polu w wynikach, zeby mozna
// go bylo doprecyzowac/poprawic bez przepisywania od nowa (tryb 'szukaj').
let ostatnieZapytanieNazwa = '';
// czy w polu wyszukiwania jest "stary" tekst zapytania (prefill) - skan (bez dotkniecia
// pola) wtedy kasuje go przy pierwszym znaku; dotkniecie pola wylacza flage (edycja reczna).
let prefillWyszukiwaniaStale = false;
// tryb obslugi skanu/wyboru w kroku 2:
// 'wybor' - dopasuj zeskanowany kod do opcjeWyboru po kluczu (lokalizacja/SKU)
// 'szukaj' - kazdy skan/wpis przechodzi ponownie przez wykonajSkan (lista z wyszukiwania po nazwie)
let trybWyboru = 'wybor';

// czy biezacy rozklad produktu zostal otwarty z listy wynikow wyszukiwania -
// jesli tak, Wstecz z rozkladu/celu wraca do wynikow, a nie do czystego skanu.
let powrotDoWyszukiwania = false;
// zawartosc ostatnio zeskanowanej lokalizacji + flaga powrotu do niej. Gdy z zawartosci
// lokalizacji wchodzimy w produkt t_GT (przez wykonajSkan -> rozklad), Wstecz ma wrocic do
// tej listy, a nie do czystego skanu. { lokalizacja, zawartosc } albo null.
let ostatniaZawartoscLok = null;
let powrotDoLokalizacji = false;

// Magazyny OBSLUGIWANE NA ZEBRZE - z nich ida wybory celu/zrodla i wiersze rozkladu.
// Bez tych z naZebrze:false (K4R/Reklamacje - proces biurkowy, nie robota na hali).
let magazynyLista = [];
// Mapa PELNA - takze magazyny ukryte przed magazynierem. MUSI taka zostac: to z niej
// liczyDoRazem() czyta flage liczDoRazem, a jego fallback dla nieznanego kodu brzmi "licz".
// Odfiltrowanie K4R takze tutaj wpuscilo by go z powrotem do sumy "Razem" tylnymi drzwiami.
const magazynyMapa = {}; // kod -> {kod, nazwa, typ, liczDoRazem?, naZebrze?}

async function initMagazyny() {
  const res = await fetch('/api/magazyny');
  const wszystkie = await res.json();
  wszystkie.forEach((m) => { magazynyMapa[m.kod] = m; });
  magazynyLista = wszystkie.filter((m) => m.naZebrze !== false);
}

// realny kod magazynu docelowego (SAME -> magazyn zrodla)
function celMagazynKod() {
  const v = el('select-cel-magazyn').value;
  return v === SAME ? (stan.zrodlo ? stan.zrodlo.magazyn : null) : v;
}

// czy biezacy cel to zmiana lokalizacji w obrebie magazynu (LOK) a nie przesuniecie (MM)
function czyZmiana() {
  return el('select-cel-magazyn').value === SAME;
}

// czy zrodlo to magazyn zewnetrzny (MAG/LS) bez lokalizacji WMS - wtedy ruch to
// przyjecie (cel WMS) albo MM miedzy zewnetrznymi (cel zewnetrzny), nie LOK/MM z lokalizacji.
function czyZrodloZewn() {
  return !!(stan.zrodlo && stan.zrodlo.typ === 'zew');
}

// czytelna etykieta zrodla: kod lokalizacji (WMS) albo nazwa magazynu (zewnetrzny)
function zrodloEtykieta() {
  if (!stan.zrodlo) return '';
  return stan.zrodlo.kod || stan.zrodlo.nazwa || stan.zrodlo.magazyn;
}

// fragment "wg GT" dla danego magazynu z lokalizacja_gt.tekst
// (np. "K4: A2 | K4G: M5-A01-P2(215)" -> dla K4 "K4: A2"); '' gdy brak
function gtLokDlaMagazynu(mag) {
  const t = stan.artykul?.lokalizacja_gt?.tekst || '';
  if (!t) return '';
  const czesc = t.split(' | ').find((p) => p.startsWith(mag + ':'));
  return czesc ? czesc.replace(new RegExp('^' + mag + ':\\s*'), '').trim() : '';
}

// --- kroki ---
const kroki = {
  start: el('krok-start'),
  wybor: el('krok-wybor'),
  cel: el('krok-cel'),
};
const btnWstecz = el('btn-wstecz');

// Naglowek: na starcie tytul; po wyborze artykulu SKU + nazwa + box "Stan w <lok>"
// + chipy kontekstu zrodla. Dlugi podpis z danymi GT (stany/lokalizacja) celowo
// usuniety - kontekst do decyzji wystarczy.
function naglowekHtml() {
  const a = stan.artykul;
  if (!a) return ''; // start: bez duzego naglowka - tytul "Skanuj..." jest w tresci

  let kontekst;
  if (stan.dostawa) {
    // Rozkladanie dostawy/zwrotu: pokaz CO sie rozklada (dokument + kontrahent przy dostawie).
    // "Brak lokalizacji w WMS" byloby tu klamstwem i falszywym alarmem - produkt ma swoje
    // miejsca, to dostawa jeszcze nie ma. Chip informacyjny, nie ostrzegawczy: normalna robota.
    const r = rodzajDok(stan.dostawa);
    const strefa = { zwrot: 'Strefa zwrotów', przywozka: 'Strefa przywózki' }[stan.dostawa.rodzaj];
    kontekst = `<span class="chip chip-dostawa">${r.naglowek.charAt(0) + r.naglowek.slice(1).toLowerCase()} ${esc(krotkiNrDok(stan.dostawa.fz_nr))}</span>`
      + (strefa ? `<span class="chip">${strefa}</span>` : '')
      + (stan.dostawa.kontrahent ? `<span class="chip">${esc(stan.dostawa.kontrahent)}</span>` : '');
  } else if (!stan.zrodlo) {
    kontekst = '<span class="chip chip-uwaga">Brak lokalizacji w WMS</span>';
  } else {
    // rezerwacja jest per-magazyn (GT) - pokazujemy ja jako chip ostrzegawczy, tylko gdy > 0
    const rez = a.stany_gt?.[stan.zrodlo.magazyn]?.rezerwacja ?? 0;
    const wZest = a.w_zestawach || 0;
    kontekst = `<span class="chip chip-magazyn">${stan.zrodlo.magazyn}</span>`
      + `<span class="chip">Z: <b>${zrodloEtykieta()}</b></span>`
      + (rez > 0 ? `<span class="chip chip-rez">rez ${rez}</span>` : '')
      + (wZest > 0 ? `<span class="chip chip-zestaw">w zestawach ${wZest}</span>` : '');
  }

  return `<div class="naglowek-glowna"><h1>${a.artykul_symbol}</h1><p class="ekran-nazwa">${a.artykul_nazwa}</p></div>`
    + `<div class="rzad naglowek-kontekst">${kontekst}</div>`;
}

// Naglowek gornego paska zalezy od kroku:
//  - "cel": SKU + nazwa + chipy zrodla (naglowekHtml),
//  - "wybor": kontekst ustawiony przez obsluz* (np. lokalizacja+magazyn dla zawartosci lokalizacji),
//  - "start": pusty/ukryty.
// Pusty naglowek jest chowany (Wstecz od razu go usuwa).
let naglowekWyborHtml = '';
function ustawNaglowek(nazwa) {
  let html = '';
  if (nazwa === 'cel') html = naglowekHtml();
  else if (nazwa === 'wybor') html = naglowekWyborHtml;
  el('ekran-naglowek').innerHTML = html;
  el('ekran-naglowek').classList.toggle('hidden', html === '');
}

function pokazKrok(nazwa) {
  for (const [klucz, sekcja] of Object.entries(kroki)) {
    sekcja.classList.toggle('hidden', klucz !== nazwa);
  }
  // glowna akcja (Zatwierdz) widoczna tylko w kroku "cel"; Wstecz zawsze w stopce
  el('btn-zatwierdz').classList.toggle('hidden', nazwa !== 'cel');
  ustawNaglowek(nazwa);
}

// krok o jeden wstecz w kreatorze (cel -> wybor/start, wybor -> start)
function wstecz() {
  // Wstecz = wyjscie z edycji -> zwolnij lock (ponowne wejscie w "Dokad i ile?" zajmie go
  // od nowa). Bez tego heartbeat trzymalby lock po cofnieciu i blokowal innych.
  if (window.BlokadaEdycji) BlokadaEdycji.zwolnij();
  ukryjKomunikat();
  ukryjPotwierdzenie();
  if (!kroki.cel.classList.contains('hidden')) {
    // z kroku "cel": wroc do listy wyboru jesli byla, inaczej wyjdz z kreatora
    if (opcjeWyboru.length > 0 || ostatniaListaArtykulow) {
      pokazKrok('wybor');
      fokusBezKlawiatury(el('input-wybor-skan'));
    } else {
      wyjdzZKreatora(); // brak listy -> zrodlo albo czysty skan (czysci stan i naglowek)
    }
  } else if (!kroki.wybor.classList.contains('hidden')) {
    // z rozkladu produktu otwartego z zawartosci lokalizacji (t_GT) -> wroc do tej zawartosci;
    // z rozkladu otwartego z wynikow wyszukiwania -> wroc do wynikow;
    // z samej listy / rozkladu po skanie -> wyjscie z kreatora
    if (powrotDoLokalizacji && ostatniaZawartoscLok) {
      obsluzLokalizacje(ostatniaZawartoscLok);
    } else if (powrotDoWyszukiwania && ostatniaListaArtykulow) {
      obsluzListaArtykulow(ostatniaListaArtykulow, false);
    } else {
      wyjdzZKreatora();
    }
  } else {
    // na kroku startowym: Wstecz wraca do widoku menu (bez przeladowania -> pelny ekran trzyma)
    history.back();
  }
}

btnWstecz.addEventListener('click', wstecz);

// #5: ruchy zrobione w tej sesji - zostaja na kroku start po sukcesie (nie czyscimy
// do zera), czyszczone dopiero przy ponownym wejsciu w Ruch. Najnowszy na gorze.
let zrobione = [];
function renderujZrobione() {
  const blok = el('zrobione-blok');
  const lista = el('zrobione-lista');
  if (!blok || !lista) return;
  blok.classList.toggle('hidden', zrobione.length === 0);
  lista.innerHTML = '';
  for (const tekst of zrobione) {
    const div = document.createElement('div');
    div.className = 'zrobione-poz';
    div.textContent = tekst;
    lista.appendChild(div);
  }
}

// --- Historia ostatnich produktow/lokalizacji (localStorage, per urzadzenie) ---
// Szybki powrot do SKU/lokalizacji bez ponownego skanu. Przezywa restart apki.
const OSTATNIE_MAX = 10;
function ostatnieWczytaj(klucz) {
  try { const v = JSON.parse(localStorage.getItem(klucz)); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
function ostatnieDopisz(klucz, wpis, kluczId) {
  const lista = ostatnieWczytaj(klucz).filter((w) => w[kluczId] !== wpis[kluczId]);
  lista.unshift(wpis);
  try { localStorage.setItem(klucz, JSON.stringify(lista.slice(0, OSTATNIE_MAX))); } catch { /* storage pelny */ }
}
function zapamietajProdukt(a) {
  if (!a || !a.artykul_symbol) return;
  ostatnieDopisz('wms.ostatnieProdukty', { symbol: a.artykul_symbol, nazwa: a.artykul_nazwa || '', gt_id: a.artykul_gt_id }, 'symbol');
}
function zapamietajLokalizacje(kod, magazyn) {
  if (!kod) return;
  ostatnieDopisz('wms.ostatnieLokalizacje', { kod, magazyn: magazyn || '' }, 'kod');
}
function renderujOstatnie() {
  const blok = el('ostatnie-blok');
  if (!blok) return;
  const prod = ostatnieWczytaj('wms.ostatnieProdukty');
  const lok = ostatnieWczytaj('wms.ostatnieLokalizacje');
  const wrapP = el('ostatnie-produkty-wrap');
  const wrapL = el('ostatnie-lokalizacje-wrap');
  const listaP = el('ostatnie-produkty');
  const listaL = el('ostatnie-lokalizacje');
  listaP.innerHTML = '';
  listaL.innerHTML = '';
  for (const p of prod) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ostatnie-chip';
    b.textContent = p.symbol;
    b.title = p.nazwa || p.symbol;
    b.addEventListener('click', () => wykonajSkan(p.symbol));
    listaP.appendChild(b);
  }
  for (const l of lok) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ostatnie-chip';
    b.textContent = l.kod;
    b.addEventListener('click', () => wykonajSkan(l.kod));
    listaL.appendChild(b);
  }
  wrapP.classList.toggle('hidden', prod.length === 0);
  wrapL.classList.toggle('hidden', lok.length === 0);
  blok.classList.toggle('hidden', prod.length === 0 && lok.length === 0);
}

// Path 1: gdy po zapisie zostalo cos nieprzypisane (K4/K4G), ekran sukcesu daje "Dalej"
// zamiast zamykac - zostajemy w tym samym produkcie. Ten flag wylacza tap-tlo = reset.
let sukcesDalejAktywny = false;
// Swieze dane produktu po zapisie (z /skan/:symbol) - "Dalej" otwiera je ta sama logika co skan.
let swiezeDaneProduktu = null;
// Deficyt przy przypisaniu K4G (ile jeszcze do rozlozenia) - podpowiedz ma zostac widoczna
// takze podczas pisania ilosci (aktualizujPozostanie ja odtwarza).
let deficytPrzypisania = null;

function reset() {
  if (window.BlokadaEdycji) BlokadaEdycji.zwolnij(); // zwolnij lock edycji produktu
  swiezeDaneProduktu = null;
  deficytPrzypisania = null;
  stan.artykul = null;
  stan.zrodlo = null;
  stan.cel = null;
  stan.iloscSugestia = null;
  stan.zrodloPula = null;
  stan.zrodloDok = null;
  stan.dostawa = null;
  stan.celMagazynNowejLokalizacji = null;
  opcjeWyboru = [];
  ostatniaListaArtykulow = null;
  ostatnieZapytanieNazwa = '';
  prefillWyszukiwaniaStale = false;
  trybWyboru = 'wybor';
  powrotDoWyszukiwania = false;
  ostatniaZawartoscLok = null;
  powrotDoLokalizacji = false;

  el('input-start').value = '';
  el('input-wybor-skan').value = '';
  el('input-cel').value = '';
  el('input-ilosc').value = '';
  el('input-ilosc').readOnly = false;
  el('input-zapas').value = '';
  el('cel-zapas-pole').classList.add('hidden');
  el('btn-zapas-toggle').classList.add('hidden');
  stan.zapasK4Pierwotny = '';
  el('lista-wyboru').innerHTML = '';
  el('checkbox-ukryj-zero-wrap').classList.add('hidden');
  el('checkbox-ukryj-zero').checked = false;
  el('pozostanie').classList.add('hidden');

  ukryjKomunikat();
  ukryjPotwierdzenie();
  pokazKrok('start');
  fokusBezKlawiatury(el('input-start'));
  renderujZrobione(); // pokaz liste zrobionych (jesli sa w tej sesji)
  renderujOstatnie(); // pokaz ostatnie produkty/lokalizacje (localStorage)
}

// --- krok 1: skan SKU, EAN, lokalizacji albo (czesci) nazwy artykulu ---
async function wykonajSkan(kod, zrodloInput = el('input-start')) {
  ukryjKomunikat();
  try {
    const res = await fetch(`/api/lokalizacje/skan/${encodeURIComponent(kod)}`);
    const dane = await res.json();
    if (!res.ok) {
      // zostaw slad czego szukano: zeskanowany/wpisany kod wraca do pola (zaznaczony,
      // by kolejny skan go zastapil) + widoczny w komunikacie
      if (zrodloInput) {
        zrodloInput.value = kod;
        try { zrodloInput.select(); } catch { /* pole moze nie wspierac select() */ }
      }
      pokazKomunikat(`Nie znaleziono: „${kod}”`, 'blad');
      return;
    }
    if (dane.typ === 'lokalizacja') {
      obsluzLokalizacje(dane);
    } else if (dane.typ === 'lista_artykulow') {
      ostatnieZapytanieNazwa = kod; // zapamietaj wpisany tekst - zostanie w polu wynikow
      obsluzListaArtykulow(dane.artykuly, dane.obciete);
    } else {
      obsluzArtykul(dane);
    }
  } catch (err) {
    pokazKomunikat('Blad polaczenia z serwerem', 'blad');
  }
}

onScan(el('input-start'), wykonajSkan);

// zeskanowano kod lokalizacji -> wybierz produkt do przeniesienia
function obsluzLokalizacje({ lokalizacja, zawartosc }) {
  powrotDoWyszukiwania = false; // zawartosc lokalizacji to nie rozklad z wyszukiwania
  ostatniaZawartoscLok = { lokalizacja, zawartosc }; // do powrotu Wstecz z produktu t_GT
  powrotDoLokalizacji = false;  // jestesmy NA liscie zawartosci, nie wracamy do niej
  if (zawartosc.length === 0) {
    pokazKomunikat(`Lokalizacja ${lokalizacja.kod} jest pusta`, 'blad');
    return;
  }

  // Jeden produkt na lokalizacji NIE skraca drogi - lista pokazuje sie tak samo jak przy
  // kilku. Skrot "od razu Dokad i ile?" zabieral ilosc, rezerwacje i status zgodnosci
  // akurat wtedy, gdy nie bylo ich skad doczytac. Nie jest to dodatkowy tap: pole skanu
  // na liscie przyjmuje SKU/EAN (onScan nizej), a ten kod magazynier ma w rece.
  opcjeWyboru = zawartosc.map((poz) => ({
    klucz: poz.artykul_symbol,
    artykul: { artykul_gt_id: poz.artykul_gt_id, artykul_symbol: poz.artykul_symbol, artykul_nazwa: poz.artykul_nazwa, stany_gt: poz.stany_gt, lokalizacja_gt: poz.lokalizacja_gt },
    zrodlo: { lokalizacja_id: lokalizacja.id, kod: lokalizacja.kod, magazyn: lokalizacja.magazyn, ilosc: poz.ilosc },
    tylkoGt: poz.tylko_gt, // t_GT: przy wyborze idziemy w rozklad produktu, nie w MM z lokalizacji
    etykieta: `${poz.artykul_symbol} — ${poz.artykul_nazwa}`,
    statusBadge: statusZgodnosciBadge(poz), // tylko status; opisy GT (stany/lokalizacja) pomijamy
    rez: sumaRezerwacji(poz.stany_gt),
    ilosc: poz.ilosc,
  }));

  // kontekst lokalizacji w gornym pasku: kod (duzy) + magazyn (chip) w tej samej linii
  naglowekWyborHtml = `<div class="ekran-sku"><h1>${lokalizacja.kod}</h1>`
    + `<span class="chip">${lokalizacja.magazyn}</span></div>`;
  przygotujKrokWybor(); // kontekst jest w gornym naglowku - sekcje rozkladu chowamy
  el('wybor-hint').textContent = '';
  el('input-wybor-skan').placeholder = 'Skanuj produkt';

  trybWyboru = 'wybor';
  renderujWybor(opcjeWyboru, wybierzOpcje);
  pokazKrok('wybor');
  fokusBezKlawiatury(el('input-wybor-skan'));
}

// zeskanowano SKU lub EAN -> wybierz lokalizacje zrodlowa
// przywraca krok "wybor" do stanu bazowego - chowa wszystkie opcjonalne elementy
// (naglowek-karta, tytul rozkladu, podsumowanie, etykieta pola, checkbox), zeby
// kazdy tryb (szukaj / zawartosc lokalizacji / rozklad artykulu) wlaczyl tylko swoje.
function przygotujKrokWybor() {
  el('wybor-naglowek').innerHTML = '';
  el('wybor-naglowek').classList.add('hidden');
  el('wybor-tytul').classList.add('hidden');
  el('wybor-podsumowanie').classList.add('hidden');
  el('wybor-podsumowanie').innerHTML = '';
  el('wybor-skan-etykieta').classList.add('hidden');
  el('checkbox-ukryj-zero-wrap').classList.add('hidden');
  // Rezerwacje dotycza KONKRETNEGO produktu, wiec musza zniknac razem z reszta jego
  // kontekstu. Bez tego zostawaly po powrocie (Wstecz) na liscie wynikow wyszukiwania i
  // wisialy nad cudzymi artykulami. Karta produktu odbuduje je przez przygotujRezerwacjeZk.
  el('rezerwacje-zk').innerHTML = '';
  el('rezerwacje-zk').classList.add('hidden');
  el('rezerwacje-zk').classList.remove('otwarte');
  // "W zestawach" - tak samo per-produkt, znika razem z resztą kontekstu (jak rezerwacje).
  el('zestawy-panel').innerHTML = '';
  el('zestawy-panel').classList.add('hidden');
  el('zestawy-panel').classList.remove('otwarte');
  el('input-wybor-skan').value = ''; // czyste pole; tryb 'szukaj' wypelni je z powrotem zapytaniem
  prefillWyszukiwaniaStale = false;
}

// Wejscie w produkt ZAWSZE laduje na rozkladzie zrodel - tez przy jednej lokalizacji i przy
// zerowej. Rozklad to JEDYNE miejsce z panelem "Rezerwacje na K4" (ktore ZK trzymaja towar),
// lacznym stanem i sztukami zamrozonymi w zestawach; skrot prosto w "Dokad i ile?" zabieral te
// informacje akurat przy najprostszych przypadkach, gdzie decyzja zapada najszybciej.
//
// `skrotPrzypisania` = wejscie z "➕ Dalej" po zapisie (kontynuujTenSamProdukt), nie ze skanu:
// rozklad widzielismy sekunde wczesniej, a rozkladanie palety to petla - nie dokladamy do niej
// tapa na wiersz BRAK LOKALIZACJI (jedyny wiersz listy bez kodu, ktory da sie zeskanowac).
function obsluzArtykul(dane, { skrotPrzypisania = false } = {}) {
  const artykul = { artykul_gt_id: dane.artykul_gt_id, artykul_symbol: dane.artykul_symbol, artykul_nazwa: dane.artykul_nazwa, stany_gt: dane.stany_gt, lokalizacja_gt: dane.lokalizacja_gt, zgodnosc: dane.zgodnosc, w_zestawach: dane.w_zestawach };

  // Kontekst rozkladania dostawy dotyczy KONKRETNEGO produktu - zerujemy go na wejsciu,
  // zanim ktorakolwiek galez ustawi swoj stan. Sciezki skrotowe nizej nie przechodza przez
  // wybierzOpcje(), wiec bez tego zostawal po POPRZEDNIM produkcie: zapis szedl w
  // /ruchy/rozloz zamiast /ruchy/lok, a naglowek pokazywal cudza fakture.
  stan.zrodloPula = null;
  stan.dostawa = null;

  // czy towar ma stan w magazynie zewnetrznym (MAG/LS) - wtedy ZAWSZE pokazujemy
  // rozklad (zeby zewnetrzny byl osiagalny jako zrodlo przyjecia), nawet gdy 0/1 lok WMS.
  const maStanZewn = magazynyLista.some((m) => m.typ === 'zewnetrzny' && (dane.stany_gt?.[m.kod]?.ilosc ?? 0) > 0);

  // Skrot "brak lokalizacji -> przypisz pierwsza" NIE moze objac produktu z DOKUMENTEM w puli
  // (dostawa/zwrot/przywozka/PW): tam stan ma dwa rozne zrodla (kubelek do rozlozenia + reszta
  // na stale miejsce), wiec magazynier musi zobaczyc rozklad i wybrac, co robi. Inaczej wpadal
  // od razu w goly ekran "Dokad i ile?" i wiersz kubelka byl nieosiagalny.
  const maKubelekWPuli = (dane.wszystkie_k4?.length || 0) > 0;
  if (skrotPrzypisania && dane.lokalizacje.length === 0 && !maStanZewn && !maKubelekWPuli) {
    // produkt ma stan w GT, ale nie ma jeszcze zadnej lokalizacji w WMS - przypisz pierwsza
    stan.artykul = artykul;
    stan.zrodlo = null;
    stan.iloscSugestia = dane.deficyt_k4g > 0 ? dane.deficyt_k4g : null;
    stan.celMagazynNowejLokalizacji = null;
    przejdzDoCelu();
    return;
  }

  // Rozklad zrodel (mobilny blizniak desktopowego okna rozkladu): wiersz per lokalizacja,
  // wiersz per dokument do rozlozenia, wiersz "BRAK LOKALIZACJI" gdy stan GT > suma WMS.
  pokazRozkladZrodel(dane, artykul);
}

// Rozklad zrodel po skanie SKU/EAN: naglowek SKU+nazwa+status, podsumowanie stanu,
// lista lokalizacji (.lista-poz) + wiersz "BRAK LOKALIZACJI / wg GT: ..." dla
// nieprzypisanej czesci K4gora. Tap w wiersz -> wybierzOpcje -> krok "Dokad i ile?".
function pokazRozkladZrodel(dane, artykul) {
  stan.artykul = artykul; // ustaw przed budowa opcji - gtLokDlaMagazynu czyta stan.artykul
  // Rozklad to tylko PODGLAD - lock zakladamy dopiero przy wejsciu w "Dokad i ile?"
  // (przejdzDoCelu). Dwoch ludzi moze ogladac ten sam rozklad; edytowac - tylko jeden.

  // czy weszlismy w rozklad z listy wynikow wyszukiwania (trybWyboru jeszcze 'szukaj')
  // -> Wstecz z rozkladu/celu ma wrocic do wynikow, nie do czystego skanu
  powrotDoWyszukiwania = trybWyboru === 'szukaj' && !!ostatniaListaArtykulow;

  // Kolejnosc wg zyczenia magazynierow: najpierw K4, potem K4G (rosnaco po ilosci - od
  // najmniejszej do najwiekszej). Magazyny zewnetrzne (MAG/LS/BRK) dokladane osobno, na koniec.
  const kolejnoscMag = { K4: 0, K4G: 1 };
  const posortowaneLok = [...dane.lokalizacje].sort((a, b) =>
    (kolejnoscMag[a.magazyn] ?? 9) - (kolejnoscMag[b.magazyn] ?? 9) || (a.ilosc - b.ilosc));

  // Pozycje do rozlozenia (paleta stoi, zwrot/przywozka/PW lezy w strefie) - jedyne wiersze z
  // realnym zadaniem, reszta listy to tylko stan. Budujemy je z JEDNEJ listy (backend:
  // rozbicie.wszystkie, payload wszystkie_k4) - nie sklejamy recznie z pol per rodzaj: tak
  // gubil sie PW (i wczesniej przywozka). Nowy rodzaj wpada tu sam.
  //
  // Rozdzielamy je nizej na dwie grupy: DOSTAWA na sam szczyt listy (najwieksza robota,
  // paleta jedzie na gore, wpada w oczy bez scrollowania), a drobnica ze stref
  // (zwrot/przywozka/PW) pod blok lokalizacji K4G - lezy w strefie i wraca na regal, wiec
  // czyta sie razem ze stanem regalu, nie z paletowa robota. Mechanika obu ta sama:
  // /ruchy/rozloz z numerem dokumentu, cel dowolny, w dowolnych porcjach.
  const opcjeDokumentow = (dane.wszystkie_k4 || []).map((dok) => ({
    klucz: '__' + dok.rodzaj.toUpperCase() + '_' + (dok.pz_nr || dok.fz_nr) + '__',
    artykul,
    zrodlo: null,
    iloscSugestia: dok.ilosc,
    zrodloPula: 'K4',       // rozkladanie nieprzypisanej puli K4 (POST /api/ruchy/rozloz)
    zrodloDok: dok.pz_nr,   // ktory dokument rozkladamy - backend rozlicza kubelek po nim
    celMagazyn: null,       // cel DOWOLNY (K4 albo K4G) - magazynier decyduje; ponizej tylko domysl
    brak: true,
    dostawa: dok,
    mag: 'K4',
    ilosc: dok.ilosc,
    // dostawa jedzie zwykle na gore, drobnica ze stref wraca na regal - stad rozny plan "wg GT"
    plan: gtLokDlaMagazynu(dok.rodzaj === 'dostawa' ? 'K4G' : 'K4') || '',
  }));

  // rezerwacja jest na poziomie magazynu - pokazujemy ja raz, przy pierwszym
  // wierszu danego magazynu (jak w rozkladzie desktopu).
  const rezPokazana = {};
  opcjeWyboru = posortowaneLok.map((lok) => {
    const rezMag = artykul.stany_gt?.[lok.magazyn]?.rezerwacja ?? 0;
    const rez = !rezPokazana[lok.magazyn] && rezMag ? rezMag : 0;
    rezPokazana[lok.magazyn] = true;
    return {
      klucz: lok.kod,
      artykul,
      zrodlo: lok,
      iloscSugestia: null,
      mag: lok.magazyn,
      kod: lok.kod,
      ilosc: lok.ilosc,
      rez,
      podpis: lok.zapas_kod ? `zapas: ${lok.zapas_kod}` : '', // dodatkowe miejsce K4
    };
  });

  // Dostawa na gore, drobnica ze stref pod blok K4G (opcjeWyboru = lokalizacje K4 potem K4G).
  // Podzial po rodzaju (dostawa vs reszta), nie po liscie nazw - nowy rodzaj drobnicy zejdzie
  // na dol sam, tak jak sam wpadl do wszystkie_k4.
  const dokDostawy = opcjeDokumentow.filter((o) => o.dostawa.rodzaj === 'dostawa');
  const dokStrefyDrobnica = opcjeDokumentow.filter((o) => o.dostawa.rodzaj !== 'dostawa');
  opcjeWyboru = [...dokDostawy, ...opcjeWyboru, ...dokStrefyDrobnica];

  // Nieprzypisany stan WMS per magazyn (GT - suma lokalizacji WMS) -> wiersz do dzialania.
  //
  // Na K4 deficyt ma DWA rozne zrodla i kazde ma inna regule (backend rozbija go w
  // routes/lokalizacje.js na wszystkie_k4 / nieprzypisane_k4):
  //   - DOSTAWA (PZ<-FZ): paleta wg GT lezy na K4, ale fizycznie nie ma jeszcze miejsca.
  //     Cel dowolny (dol/gora), w dowolnych porcjach - ma swoj wiersz na gorze listy.
  //   - RESZTA (stary stan, zwroty): stara zasada 1 SKU = 1 lokalizacja, calosc na D3.
  // Produkt moze miec oba wiersze naraz - to fizycznie dwie rozne rzeczy.
  //
  // K4G: jeden wiersz jak dotad (1 SKU = N lokalizacji - mozna dolozyc kolejna).
  for (const mag of magazynyLista.filter((m) => m.typ === 'wms').map((m) => m.kod)) {
    const gtStan = artykul.stany_gt?.[mag]?.ilosc ?? 0;
    const wmsLok = dane.lokalizacje.filter((l) => l.magazyn === mag);
    const wyliczony = Math.max(gtStan - wmsLok.reduce((s, l) => s + l.ilosc, 0), 0);
    // K4: tylko czesc deficytu NIEwyjasniona dokumentem (dostawa/zwrot/przywozka maja swoje
    // wiersze wyzej). Backend jest zrodlem prawdy i ustawia nieprzypisane_k4 ZAWSZE, gdy
    // rozbicie sie udalo - wiec sama obecnosc pola wystarczy za sygnal. Gdy GT padl i rozbicia
    // nie ma, pokazujemy caly wyliczony deficyt.
    const niezlok = mag === 'K4' && dane.nieprzypisane_k4 != null
      ? dane.nieprzypisane_k4
      : wyliczony;
    if (niezlok <= 0) continue;
    opcjeWyboru.push({
      klucz: '__BRAK_' + mag + '__',
      artykul,
      zrodlo: null,
      iloscSugestia: niezlok,
      celMagazyn: mag,
      brak: true,
      mag,
      ilosc: niezlok,
      plan: gtLokDlaMagazynu(mag) || '', // sciaga "wg GT" gdzie dolozyc
    });
  }

  // magazyny zewnetrzne (MAG/LS) ze stanem GT - jako zrodlo bez konkretnej lokalizacji.
  // Tap -> przyjecie (cel WMS) albo MM miedzy zewnetrznymi (cel zewnetrzny).
  for (const m of magazynyLista.filter((mg) => mg.typ === 'zewnetrzny')) {
    const w = artykul.stany_gt?.[m.kod];
    if (!w || w.ilosc <= 0) continue;
    opcjeWyboru.push({
      klucz: '__ZEW_' + m.kod + '__',
      artykul,
      zrodlo: { typ: 'zew', magazyn: m.kod, nazwa: m.nazwa, ilosc: w.ilosc },
      iloscSugestia: null,
      mag: m.kod,
      kod: m.nazwa,
      podpis: 'magazyn zewnętrzny',
      ilosc: w.ilosc,
      rez: w.rezerwacja || 0,
    });
  }

  // gorny pasek: SKU (duzy) + status zgodnosci, nazwa pod spodem
  naglowekWyborHtml = `<div class="ekran-sku"><h1>${artykul.artykul_symbol}</h1>${statusZgodnosciBadge(artykul)}</div>`
    + `<p class="ekran-nazwa">${artykul.artykul_nazwa}</p>`;

  przygotujKrokWybor();

  // "Laczny stan" = Razem (bez BRK i K4R) - to odpowiedz na "ile mam do sprzedania".
  // Stan na Brakach/Reklamacjach widac nizej, w rozkladzie per magazyn.
  const lacznyStan = sumaRazemGt(artykul.stany_gt);
  const rezRazem = sumaRezerwacji(artykul.stany_gt);
  // Dopisek "w nawiasie krok wczesniej": ile sztuk tego SKU siedzi w zestawach na K4 -
  // fizycznie na polce jest o tyle wiecej niz mowi stan GT (zob. gt-zestawy.js).
  const wZest = artykul.w_zestawach || 0;
  el('wybor-podsumowanie').innerHTML = `<span>Łączny stan: <b>${lacznyStan} szt.</b>`
    + (wZest > 0 ? ` <span class="podsumowanie-zest">(+${wZest} w zestawach)</span>` : '') + `</span>`
    + `<span class="podsumowanie-sep"></span>`
    + `<span>Rezerwacje: <b>${rezRazem}</b></span>`;
  el('wybor-podsumowanie').classList.remove('hidden');
  przygotujRezerwacjeZk(artykul);
  przygotujZestawy(artykul);

  el('input-wybor-skan').placeholder = 'Skanuj kod lokalizacji';
  if (opcjeWyboru.length === 0) {
    // brak jakiegokolwiek zrodla (stan GT = 0 we wszystkich magazynach) - jasny komunikat
    // zamiast pustej listy; pokazujemy miejsce wg GT (gdzie SKU stoi, gdy bedzie stan).
    const lokGt = gtLokDlaMagazynu('K4') || gtLokDlaMagazynu('K4G');
    el('wybor-hint').textContent = 'Brak stanu — nie ma czego przenosić (0 szt.).'
      + (lokGt ? ` Miejsce wg GT: ${lokGt}.` : '');
  } else {
    el('wybor-hint').textContent = ''; // pole skanu mówi samo za siebie
  }

  trybWyboru = 'wybor';
  renderujRozklad(opcjeWyboru, wybierzOpcje);
  pokazKrok('wybor');
  // preventScroll: skupiamy pole na skan, ale NIE przewijamy tresci - tytul i
  // podsumowanie maja zostac widoczne na gorze (lista i tak jest przewijalna).
  el('input-wybor-skan').focus({ preventScroll: true });
}

// Rozwijana sekcja "Rezerwacje na K4" na kroku wyboru: pokazuje otwarte ZK
// (zamowienia klienta), ktore rezerwuja towar na K4 - odpowiedz na "z czego wynika
// rezerwacja". Widoczna tylko gdy jest rezerwacja na K4 (st_StanRez z GT, master).
// Lazy-load: zapytanie o ZK leci dopiero po dotknieciu naglowka (nie dla kazdej
// pozycji). Zob. routes/produkty.js (/:id/rezerwacje), services/gt-dokumenty.js.
function przygotujRezerwacjeZk(artykul, box = el('rezerwacje-zk')) {
  const rezK4 = artykul?.stany_gt?.K4?.rezerwacja ?? 0;
  box.innerHTML = '';
  box.classList.remove('otwarte');
  if (rezK4 <= 0 || !artykul?.artykul_gt_id) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');

  let otwarte = false;
  let stanLadowania = 'idle'; // idle | ladowanie | ok | blad
  let dane = null;            // { zk: [...], suma }

  function fmtData(iso) {
    if (!iso) return '';
    const [r, m, d] = String(iso).split('-');
    return d && m && r ? `${d}.${m}.${r}` : iso;
  }

  function bodyHtml() {
    if (stanLadowania === 'ladowanie') return `<div class="rez-zk__body"><div class="rez-zk__stan">Ładowanie…</div></div>`;
    if (stanLadowania === 'blad') return `<div class="rez-zk__body"><div class="rez-zk__stan">GT niedostępny — dotknij, aby spróbować ponownie.</div></div>`;
    if (stanLadowania === 'ok') {
      if (!dane.zk.length) return `<div class="rez-zk__body"><div class="rez-zk__stan">Brak otwartych ZK na K4.</div></div>`;
      const wiersze = dane.zk.map((z) => {
        const sub = [z.oryg, fmtData(z.data)].filter(Boolean).join(' · ');
        return `<div class="rez-zk__row">`
          + `<div><div class="rez-zk__nr">${z.nr_pelny || '—'}</div>`
          + (sub ? `<div class="rez-zk__sub">${sub}</div>` : '')
          + `</div><span class="rez-zk__ilosc">${z.ilosc} szt</span></div>`;
      }).join('');
      const zgodne = dane.suma === rezK4;
      const foot = zgodne
        ? `Σ ${dane.suma} szt = rezerwacja K4`
        : `Σ ${dane.suma} szt · rezerwacja K4: ${rezK4}`;
      return `<div class="rez-zk__body"><div class="rez-zk__lista">${wiersze}</div>`
        + `<div class="rez-zk__foot${zgodne ? '' : ' rez-zk__foot--rozjazd'}">${foot}</div></div>`;
    }
    return '';
  }

  function render() {
    box.classList.toggle('otwarte', otwarte);
    box.innerHTML = `<button type="button" class="rez-zk__header">`
      + `<span class="rez-zk__tytul">🔒 Rezerwacje na K4</span>`
      + `<span class="rez-zk__meta">${rezK4} szt <span class="rez-zk__chev">${otwarte ? '▾' : '▸'}</span></span>`
      + `</button>${otwarte ? bodyHtml() : ''}`;
    box.querySelector('.rez-zk__header').addEventListener('click', onTap);
  }

  async function zaladuj() {
    stanLadowania = 'ladowanie';
    render();
    try {
      const res = await fetch(`/api/produkty/${encodeURIComponent(artykul.artykul_gt_id)}/rezerwacje`);
      if (!res.ok) throw new Error('http ' + res.status);
      dane = await res.json();
      stanLadowania = 'ok';
    } catch (e) {
      stanLadowania = 'blad';
    }
    if (otwarte) render();
  }

  function onTap() {
    otwarte = !otwarte;
    render();
    // ladujemy przy pierwszym rozwinieciu oraz przy ponowieniu po bledzie
    if (otwarte && (stanLadowania === 'idle' || stanLadowania === 'blad')) zaladuj();
  }

  render();
}

// Rozwijana sekcja "W zestawach" - bliznik przygotujRezerwacjeZk. Pokazuje, ile sztuk tego SKU
// jest zamrozone w zestawach ZMONTOWANYCH na K4 (fizycznie na polce, ale zaksiegowane pod SKU
// zestawu). Widoczna gdy artykul.w_zestawach > 0. Lazy-load /api/produkty/:id/zestawy.
// Zob. services/gt-zestawy.js. ZW (wirtualny potencjal montazu) pomijane w calosci.
function przygotujZestawy(artykul, box = el('zestawy-panel')) {
  const wZest = artykul?.w_zestawach ?? 0;
  box.innerHTML = '';
  box.classList.remove('otwarte');
  if (wZest <= 0 || !artykul?.artykul_gt_id) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');

  let otwarte = false;
  let stanLadowania = 'idle'; // idle | ladowanie | ok | blad
  let dane = null;            // { jako_skladnik:[...], w_zestawach, jako_zestaw }

  function bodyHtml() {
    if (stanLadowania === 'ladowanie') return `<div class="rez-zk__body"><div class="rez-zk__stan">Ładowanie…</div></div>`;
    if (stanLadowania === 'blad') return `<div class="rez-zk__body"><div class="rez-zk__stan">GT niedostępny — dotknij, aby spróbować ponownie.</div></div>`;
    if (stanLadowania !== 'ok') return '';
    const lista = (dane.jako_skladnik || []);
    if (!lista.length) return `<div class="rez-zk__body"><div class="rez-zk__stan">Brak zestawów na K4 z tym składnikiem.</div></div>`;
    const wiersze = lista.map((z) => {
      const sub = `${z.stan_zestawu} zest. × ${z.liczba} szt`;
      return `<div class="rez-zk__row">`
        + `<div><div class="rez-zk__nr">${esc(z.symbol)}</div>`
        + `<div class="rez-zk__sub">${sub}</div></div>`
        + `<span class="rez-zk__ilosc">${z.zamraza} szt</span></div>`;
    }).join('');
    const foot = `Σ ${dane.w_zestawach} szt na półce zapisane w zestawach`;
    return `<div class="rez-zk__body"><div class="rez-zk__lista">${wiersze}</div>`
      + `<div class="rez-zk__foot">${foot}</div></div>`;
  }

  function render() {
    box.classList.toggle('otwarte', otwarte);
    box.innerHTML = `<button type="button" class="rez-zk__header">`
      + `<span class="rez-zk__tytul">📦 W zestawach na K4</span>`
      + `<span class="rez-zk__meta">${wZest} szt <span class="rez-zk__chev">${otwarte ? '▾' : '▸'}</span></span>`
      + `</button>${otwarte ? bodyHtml() : ''}`;
    box.querySelector('.rez-zk__header').addEventListener('click', onTap);
  }

  async function zaladuj() {
    stanLadowania = 'ladowanie';
    render();
    try {
      const res = await fetch(`/api/produkty/${encodeURIComponent(artykul.artykul_gt_id)}/zestawy`);
      if (!res.ok) throw new Error('http ' + res.status);
      dane = await res.json();
      stanLadowania = 'ok';
    } catch (e) {
      stanLadowania = 'blad';
    }
    if (otwarte) render();
  }

  function onTap() {
    otwarte = !otwarte;
    render();
    if (otwarte && (stanLadowania === 'idle' || stanLadowania === 'blad')) zaladuj();
  }

  render();
}

// "FZ 49/K4/2026" -> "FZ 49". Ekran Zebry ma 360 px - magazynierowi wystarcza numer
// faktury do rozpoznania dostawy, magazyn i rok tylko zjadaja szerokosc.
function krotkiNrDok(nr) {
  return String(nr ?? '').split('/')[0].trim();
}

// Podpisy pozycji do rozlozenia. Dostawa czeka na palecie i idzie zwykle na gore; zwrot i
// przywozka leza w swoich strefach i wracaja na regal (stad domyslny cel K4).
// Opis krotki: ekran ma 360 px i kazda linia wiecej to ryzyko, ze wiersz sie zawinie i
// zepchnie kolejne pozycje pod krawedz. Sama nazwa strefy mowi, gdzie towar lezy - co z nim
// zrobic, wynika z tapniecia (i tak pisze to naglowek kroku "Dokad i ile?").
const RODZAJE_DOK = {
  dostawa:        { naglowek: 'DOSTAWA',       opis: 'do rozłożenia',     domyslnyCel: 'K4G' },
  zwrot:          { naglowek: 'ZWROT',         opis: 'Strefa zwrotów',    domyslnyCel: 'K4' },
  przywozka:      { naglowek: 'PRZYWÓZKA',     opis: 'Strefa przywózki',  domyslnyCel: 'K4' },
  przyjecie_wewn: { naglowek: 'PRZYJĘCIE (PW)', opis: 'do odłożenia', domyslnyCel: 'K4' },
};
const rodzajDok = (dok) => RODZAJE_DOK[dok?.rodzaj] || RODZAJE_DOK.dostawa;

// Zwrot i przywozka = drobnica lezaca w strefie: magazynier ma ja w rece i zna cel, wiec
// podpowiadamy ilosc. Dostawa to paleta - tam ilosci NIE podpowiadamy (bledne "wpisz 2000"),
// bo magazynier sam decyduje, ile klika na ktora palete.
const czyDrobnicaZeStrefy = () => stan.dostawa?.rodzaj === 'zwrot' || stan.dostawa?.rodzaj === 'przywozka';

// Tekst z GT (symbol kontrahenta, numer dokumentu) trafia do innerHTML - escapujemy,
// bo to dane z zewnatrz, nie nasze stale.
function esc(t) {
  const d = document.createElement('div');
  d.textContent = String(t ?? '');
  return d.innerHTML;
}

// renderuje liste pozycji rozkladu jako karty .lista-poz (mag-badge, kod, ilosc,
// rez, strzalka); wiersz z flaga `brak` dostaje wariant .brak + podpis "(nieprzypisano)"
// i opcjonalny plan "wg GT: ...". Wiersz dostawy (o.dostawa) podpisuje sie numerem
// faktury i kontrahentem - magazynier ma wiedziec, CO rozklada, nie tylko ile.
function renderujRozklad(opcje, onWybierz) {
  const lista = el('lista-wyboru');
  lista.innerHTML = '';
  opcje.forEach((o) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    // Akcent koloru magazynu (plakietka + lewy pasek) TYLKO na wierszach stanu - strefy
    // (o.dostawa) zostaja niebieskie, "brak lokalizacji" (o.brak bez dostawy) czerwony;
    // oba maja wlasny sygnal, wiec ich nie kolorujemy magazynem (patrz mag-* w app.css).
    const magKlasa = !o.brak && o.mag ? ' mag-' + o.mag.toLowerCase() : '';
    btn.className = 'lista-poz' + (o.brak ? ' brak' : '') + (o.dostawa ? ' dostawa' : '') + magKlasa;
    const rez = o.rez > 0 ? `<span class="poz-rez">(${o.rez} rez.)</span>` : '';
    const glowna = o.dostawa
      ? `<span class="poz-kod">${rodzajDok(o.dostawa).naglowek}</span>`
        + `<span class="poz-podpis">${esc(krotkiNrDok(o.dostawa.fz_nr))}`
          + `${o.dostawa.kontrahent ? ' · ' + esc(o.dostawa.kontrahent) : ''}`
          + `${o.dostawa.zrodlo_mag ? ' · ' + esc(magazynyMapa[o.dostawa.zrodlo_mag]?.nazwa ?? o.dostawa.zrodlo_mag) : ''}</span>`
        + `<span class="poz-plan">${rodzajDok(o.dostawa).opis}</span>`
      : o.brak
      ? `<span class="poz-kod">BRAK LOKALIZACJI</span><span class="poz-podpis">(nieprzypisano)</span>`
        + (o.plan ? `<span class="poz-plan">wg GT: ${esc(o.plan)}</span>` : '')
      : `<span class="poz-kod">${esc(o.kod)}</span>`
        + (o.podpis ? `<span class="poz-podpis">${esc(o.podpis)}</span>` : '');
    btn.innerHTML = `<span class="poz-mag">${o.mag}</span>`
      + `<span class="poz-glowna">${glowna}</span>`
      + `<span class="poz-prawa"><span class="poz-ilosc">${o.ilosc} szt.</span>${rez}</span>`
      + `<span class="poz-strzalka">›</span>`;
    btn.addEventListener('click', () => onWybierz(o));
    lista.appendChild(btn);
  });
}

// znaleziono kilka artykulow po (czesci) nazwy -> wybierz konkretny artykul
function obsluzListaArtykulow(artykuly, obciete) {
  ostatniaListaArtykulow = artykuly;
  powrotDoWyszukiwania = false; // jestesmy NA liscie wynikow - Wstecz stad = czysty skan

  naglowekWyborHtml = ''; // brak SKU w gornym pasku - towar jeszcze nie wybrany
  przygotujKrokWybor();
  el('wybor-tytul').textContent = `Znaleziono ${liczbaArtykulow(artykuly.length)} — wybierz`;
  el('wybor-tytul').classList.remove('hidden');
  el('wybor-hint').textContent = '';
  el('input-wybor-skan').placeholder = 'Skanuj SKU lub EAN';
  el('input-wybor-skan').value = ostatnieZapytanieNazwa; // zostaw wpisany tekst do poprawienia/zawężenia
  prefillWyszukiwaniaStale = !!ostatnieZapytanieNazwa; // skan skasuje go przy pierwszym znaku
  el('checkbox-ukryj-zero-wrap').classList.remove('hidden');

  trybWyboru = 'szukaj';
  renderujListaArtykulow();
  pokazKrok('wybor');
  el('input-wybor-skan').focus({ preventScroll: true });

  if (obciete) {
    pokazKomunikat(`Pokazano pierwsze ${artykuly.length} wyników — zawęź wyszukiwanie`, 'info');
  }
}

// lewy pasek statusu zgodnosci karty (te same stany co badge: OK/OF, t_GT, NZ, BD)
const ZGODNOSC_BAR = { OK: 'st-ok', OF: 'st-ok', t_GT: 'st-info', NZ: 'st-err', BD: 'st-neutral' };
function statusBarKlasa(zgodnosc) {
  return (zgodnosc && zgodnosc.ogolna && ZGODNOSC_BAR[zgodnosc.ogolna]) || 'st-neutral';
}

// skrot stanow GT do podpisu karty: "Razem 58 · K4 28 · K4G 30".
// Pomijamy magazyny z zerem i ukryte na Zebrze (K4R). "Razem" liczy bez BRK i K4R
// (sumaRazemGt), ale BRK pokazuje sie dalej w rozkladzie - tak samo jak w tabeli desktopu,
// gdzie ma wlasna kolumne obok kolumny Razem.
function stanSkrotKarty(stanyGt) {
  const perMag = Object.entries(stanyGt || {})
    .filter(([kod, w]) => w.ilosc && widocznyNaZebrze(kod))
    .map(([m, w]) => `${m} ${w.ilosc}${w.rezerwacja ? ` (rez ${w.rezerwacja})` : ''}`)
    .join(' · ');
  // Pustke rozstrzygamy ROZKLADEM, nie suma: "Razem 0" przy stanie wylacznie na BRK to NIE
  // brak stanu (towar jest, tylko niepelnowartosciowy), a przy stanie tylko na ukrytym K4R
  // sklejalibysmy bezsensowne "Razem 0 · " z pustym rozkladem.
  if (!perMag) return 'brak stanu w GT';
  return `Razem ${sumaRazemGt(stanyGt)} · ${perMag}`;
}

// karta artykulu na liscie wyszukiwania (.lista-poz): SKU+badge / nazwa / stany / lokalizacje.
// Status zgodnosci = lewy pasek koloru + badge (zamiast emoji). Lokalizacje z pola GT
// (kopia WMS) - kandydat do usuniecia, bo rozklad i tak pokaze zywe lokalizacje.
function renderujListaArtykulow() {
  const kont = el('lista-wyboru');
  kont.innerHTML = '';
  const ukryj = el('checkbox-ukryj-zero');
  const widoczne = (ukryj && ukryj.checked)
    ? ostatniaListaArtykulow.filter((p) => sumaStanowGt(p.stany_gt) > 0)
    : ostatniaListaArtykulow;

  if (!widoczne || widoczne.length === 0) {
    kont.innerHTML = '<p class="hint">Brak produktów ze stanem w GT.</p>';
    return;
  }

  widoczne.forEach((p) => {
    const symbol = p.artykul_symbol ?? p.symbol;
    const nazwa = p.artykul_nazwa ?? p.nazwa;
    const lok = p.lokalizacja_gt && p.lokalizacja_gt.tekst ? p.lokalizacja_gt.tekst.replace(/ \| /g, ' · ') : '';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lista-poz ' + statusBarKlasa(p.zgodnosc);
    btn.innerHTML = `<span class="poz-glowna">`
      + `<span class="poz-kod">${symbol} ${statusZgodnosciBadge(p)}</span>`
      + `<span class="poz-nazwa">${nazwa}</span>`
      + `<span class="poz-podpis">${stanSkrotKarty(p.stany_gt)}</span>`
      + (lok ? `<span class="poz-podpis poz-lok">${lok}</span>` : '')
      + `</span>`
      + `<span class="poz-strzalka">›</span>`;
    btn.addEventListener('click', () => wykonajSkan(symbol));
    kont.appendChild(btn);
  });
}

el('checkbox-ukryj-zero').addEventListener('change', () => {
  if (trybWyboru === 'szukaj' && ostatniaListaArtykulow) renderujListaArtykulow();
});

// --- krok 2: wybor z listy ---
function renderujWybor(opcje, onWybierz) {
  const lista = el('lista-wyboru');
  lista.innerHTML = '';
  opcje.forEach((opcja) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    const rezTekst = opcja.rez > 0 ? ` <span class="rez">(rez ${opcja.rez})</span>` : '';
    const ilosc = opcja.ilosc !== undefined ? `<span class="ilosc">${opcja.ilosc} szt.${rezTekst}</span>` : '';
    const badge = opcja.statusBadge ? ` ${opcja.statusBadge}` : '';
    const podetykieta = opcja.podetykieta ? `<span class="stany-magazynowe">${opcja.podetykieta}</span>` : '';
    const podetykieta2 = opcja.podetykieta2 ? `<span class="stany-magazynowe">${opcja.podetykieta2}</span>` : '';
    btn.innerHTML = `<span class="etykieta-glowna"><span>${opcja.etykieta}${badge}</span>${podetykieta}${podetykieta2}</span>${ilosc}`;
    btn.addEventListener('click', () => onWybierz(opcja));
    lista.appendChild(btn);
  });
}

function wybierzOpcje(opcja) {
  // t_GT z listy zawartosci lokalizacji: nie ma stanu WMS tutaj -> idz przez rozklad produktu.
  // Zapamietaj, ze Wstecz ma wrocic do zawartosci lokalizacji (a nie do czystego skanu).
  if (opcja.tylkoGt) { powrotDoLokalizacji = true; wykonajSkan(opcja.artykul.artykul_symbol); return; }
  stan.artykul = opcja.artykul;
  stan.zrodlo = opcja.zrodlo;
  stan.iloscSugestia = opcja.iloscSugestia ?? null;
  stan.zrodloPula = opcja.zrodloPula ?? null;
  stan.zrodloDok = opcja.zrodloDok ?? null;
  stan.dostawa = opcja.dostawa ?? null;
  stan.celMagazynNowejLokalizacji = opcja.celMagazyn ?? null;
  przejdzDoCelu();
}

onScan(el('input-wybor-skan'), (kod) => {
  if (trybWyboru === 'szukaj') {
    wykonajSkan(kod, el('input-wybor-skan'));
    return;
  }
  const opcja = opcjeWyboru.find((o) => o.klucz.toUpperCase() === kod.toUpperCase());
  if (!opcja) {
    pokazKomunikat(`"${kod}" nie pasuje do zadnej z pozycji na liscie`, 'blad');
    return;
  }
  wybierzOpcje(opcja);
});

// --- krok 3: cel (magazyn + lokalizacja) i ilosc ---
async function przejdzDoCelu() {
  // TWARDA BLOKADA edycji: zajmij lock produktu; gdy edytuje kto inny -> wroc do skanu
  if (window.BlokadaEdycji && stan.artykul) {
    const b = await BlokadaEdycji.zajmij(stan.artykul.artykul_gt_id);
    if (!b.ok) {
      // tylko komunikat - zostajemy na biezacym ekranie (rozklad/lista), NIE czyscimy danych
      pokazKomunikat(b.przez ? `Produkt edytuje ${b.przez} — spróbuj później` : (b.blad || 'Nie można otworzyć — spróbuj później'), 'blad');
      return;
    }
  }
  ukryjKomunikat();
  ukryjPotwierdzenie();
  stan.cel = null;

  // kontekst produktu/zrodla jest teraz w naglowku (SKU+nazwa+stan+chipy), nie w tresci
  const inputIlosc = el('input-ilosc');

  if (!stan.zrodlo) {
    // PRZYPISANIE (brak zrodla w WMS): wybierz magazyn WMS (K4/K4G ze stanem GT),
    // ilosc pobierana z tego magazynu. Gdy magazyn narzucony (opcja "+ Nowa lok. K4G")
    // - tylko ten jeden. Stany K4 i K4G NIE sa pokazywane razem - jeden magazyn naraz.
    const stany = stan.artykul.stany_gt || {};
    const wmsKody = magazynyLista.filter((m) => m.typ === 'wms').map((m) => m.kod);
    // ROZKLADANIE DOSTAWY (zrodloPula): cel dowolny - czesc zostaje na dole, reszta jedzie
    // na gore, w dowolnych ratach. Dlatego pokazujemy OBA magazyny WMS, niezaleznie od stanow.
    let opcjeMag = stan.zrodloPula
      ? wmsKody
      : (stan.celMagazynNowejLokalizacji
        ? [stan.celMagazynNowejLokalizacji]
        : wmsKody.filter((m) => (stany[m]?.ilosc ?? 0) > 0));
    if (opcjeMag.length === 0) opcjeMag = wmsKody; // brak stanu GT - pozwol wskazac recznie

    const select = el('select-cel-magazyn');
    select.innerHTML = opcjeMag.map((m) => {
      // Gdy przyszlismy z wiersza "BRAK" (celMagazynNowejLokalizacji) albo rozkladamy dostawe:
      // pokaz ile ZOSTALO do rozlozenia, nie caly stan GT magazynu - inaczej mylace.
      const ile = ((stan.zrodloPula || m === stan.celMagazynNowejLokalizacji) && stan.iloscSugestia != null)
        ? stan.iloscSugestia
        : (stany[m]?.ilosc ?? 0);
      const nazwa = magazynyMapa[m]?.nazwa ?? m;
      return `<option value="${m}">${nazwa}${ile ? ` — ${ile} szt.` : ''}</option>`;
    }).join('');
    // Dostawa najczesciej jedzie na gore, zwrot wraca na regal - stad rozne domysly.
    // Oba bez blokady: magazynier moze zdecydowac inaczej.
    if (stan.zrodloPula) {
      const domyslny = rodzajDok(stan.dostawa).domyslnyCel;
      if (opcjeMag.includes(domyslny)) select.value = domyslny;
    }

    el('cel-magazyn-pole').classList.remove('hidden');
    el('cel-lokalizacja-pole').classList.remove('hidden');
    inputIlosc.readOnly = false;
    pokazKrok('cel');
    aktualizujKrokCelPrzypisanie();
    return;
  }

  // ZRODLO ZEWNETRZNE (MAG/LS): cel = dowolny INNY magazyn (brak opcji "ta sama" -
  // zewnetrzny nie ma lokalizacji). Cel WMS -> przyjecie; cel zewnetrzny -> MM zewn.
  // Domyslnie K4G (jak desktop). Nie zapamietujemy - zawsze proponujemy WMS.
  if (czyZrodloZewn()) {
    el('cel-magazyn-pole').classList.remove('hidden');
    const select = el('select-cel-magazyn');
    const inne = magazynyLista.filter((m) => m.kod !== stan.zrodlo.magazyn);
    select.innerHTML = inne.map((m) => `<option value="${m.kod}">${m.nazwa}</option>`).join('');
    select.value = inne.some((m) => m.kod === 'K4G') ? 'K4G' : inne[0].kod;
    pokazKrok('cel');
    aktualizujKrokCel();
    return;
  }

  // jest zrodlo - select celu: "Ta sama (zmiana lokalizacji)" + inne magazyny (MM)
  el('cel-magazyn-pole').classList.remove('hidden');
  const select = el('select-cel-magazyn');
  const inne = magazynyLista.filter((m) => m.kod !== stan.zrodlo.magazyn);
  const optSame = `<option value="${SAME}">${stan.zrodlo.magazyn} — bez MM</option>`;
  select.innerHTML = optSame + inne.map((m) => `<option value="${m.kod}">${m.nazwa}</option>`).join('');

  // domyslny cel = przeciwny magazyn WMS (zrodlo K4 -> cel K4G i odwrotnie); to
  // najczestszy ruch miedzy pick-floor a bulk. Gdy brak drugiego WMS - "ta sama".
  const przeciwnyWms = inne.find((m) => m.typ === 'wms');
  select.value = przeciwnyWms ? przeciwnyWms.kod : SAME;

  pokazKrok('cel');
  aktualizujKrokCel();
}

// Po wyborze celu NIE fokusujemy pola ilosci (type=number -> wyskakuje numeryczna klawiatura,
// a ilosc i tak jest podpowiedziana + jest stepper). Fokus idzie na pole skanu lokalizacji
// (inputmode=none -> bez klawiatury, gotowe na skan). Edycja ilosci = dotkniecie liczby.
function skupSieNaIlosciLubLokalizacji() {
  if (!el('cel-lokalizacja-pole').classList.contains('hidden')) {
    fokusBezKlawiatury(el('input-cel'));
  }
}

// odpowiada na wybor celu: ustawia ilosc (K4 zmiana = cala), pokazuje/ukrywa lokalizacje,
// dla K4 jako celu MM podpowiada stale miejsce SKU (jesli istnieje)
async function aktualizujKrokCel() {
  ukryjKomunikat();
  ukryjPotwierdzenie();
  stan.cel = null;
  if (!stan.zrodlo) return;

  const inputIlosc = el('input-ilosc');
  const zmiana = czyZmiana();
  inputIlosc.max = stan.zrodlo.ilosc;
  // K4 + zmiana lokalizacji: 1 SKU = 1 lokalizacja -> zawsze cala ilosc
  const calaIlosc = zmiana && stan.zrodlo.magazyn === 'K4';
  inputIlosc.readOnly = calaIlosc;
  inputIlosc.value = stan.zrodlo.ilosc;
  aktualizujPozostanie();
  aktualizujAkcjeLabel();

  const docelowy = celMagazynKod();
  const magInfo = magazynyMapa[docelowy];

  // Zapas K4 (dodatkowe miejsce) - przycisk tylko gdy cel = K4
  ustawZapasUI(docelowy === 'K4');

  // magazyn zewnetrzny -> bez lokalizacji
  if (magInfo && magInfo.typ === 'zewnetrzny') {
    el('cel-lokalizacja-pole').classList.add('hidden');
    el('input-cel').value = '';
    el('cel-lokalizacja-hint').textContent = '';
    stan.cel = { typ: 'zew', magazyn: docelowy, nazwa: magInfo.nazwa };
    skupSieNaIlosciLubLokalizacji();
    return;
  }

  // magazyn WMS -> lokalizacja
  el('cel-lokalizacja-pole').classList.remove('hidden');
  el('input-cel').value = '';
  el('input-cel').placeholder = zmiana
    ? `Skanuj nową lokalizację (${stan.zrodlo.magazyn})`
    : `Skanuj lokalizację docelową (${magInfo ? magInfo.nazwa : docelowy})`;
  if (calaIlosc) {
    el('cel-lokalizacja-hint').textContent = 'K4: 1 SKU = 1 lokalizacja — przenoszona jest cała ilość';
  } else if (docelowy === 'K4') {
    el('cel-lokalizacja-hint').textContent = ''; // hint dla K4 ustawi blok nizej (dom/GT)
  } else {
    // K4G / inny magazyn WMS: podpowiedz z GT gdzie sa lokalizacje (K4G: 1 SKU = N lokalizacji)
    const gtLok = gtLokDlaMagazynu(docelowy);
    el('cel-lokalizacja-hint').textContent = gtLok ? `wg GT: ${gtLok}` : '';
  }

  // K4 jako cel -> pobierz stale miejsce (podpowiedz lokalizacji przy MM) + obecny zapas K4
  if (docelowy === 'K4') {
    try {
      const res = await fetch(`/api/lokalizacje/k4-dom/${encodeURIComponent(stan.artykul.artykul_gt_id)}`);
      const dom = await res.json();
      if (celMagazynKod() !== 'K4') return; // uzytkownik zmienil wybor w trakcie zapytania
      stan.zapasK4Pierwotny = dom?.zapas_kod ?? '';
      el('input-zapas').value = stan.zapasK4Pierwotny;
      aktualizujPrzyciskZapasu(); // pokaz obecny zapas na przycisku
      // podpowiedz stalego miejsca tylko przy MM do K4 (przy zmianie K4->K4 cel skanuje magazynier)
      if (!zmiana) {
        if (dom) {
          el('input-cel').value = dom.kod;
          el('cel-lokalizacja-hint').textContent = `Stałe miejsce w K4 (obecnie: ${dom.ilosc} szt.) — zeskanuj inną, by zmienić`;
          stan.cel = { typ: 'wms', id: dom.lokalizacja_id, kod: dom.kod, magazyn: 'K4' };
        } else {
          // brak lokalizacji K4 w WMS, ale GT moze znac miejsce (tw_Pole1) - pokaz podpowiedz
          const gtLok = gtLokDlaMagazynu('K4');
          el('cel-lokalizacja-hint').textContent = gtLok
            ? `wg GT: ${gtLok} · K4: 1 SKU = 1 lokalizacja — cała ilość`
            : 'Nowe miejsce w K4 — zeskanuj lokalizację';
        }
      }
    } catch (err) {
      // brak podpowiedzi - magazynier skanuje recznie
    }
  }

  skupSieNaIlosciLubLokalizacji();
}

// Zapas K4: gdy cel=K4 pokazujemy maly PRZYCISK (pole rozwija sie po tapnieciu), inaczej
// chowamy wszystko i czyscimy. Etykieta przycisku odzwierciedla obecny zapas.
function ustawZapasUI(pokaz) {
  el('cel-zapas-pole').classList.add('hidden'); // pole zawsze schowane na starcie kroku
  if (!pokaz) {
    el('btn-zapas-toggle').classList.add('hidden');
    el('input-zapas').value = '';
    stan.zapasK4Pierwotny = '';
    return;
  }
  el('btn-zapas-toggle').classList.remove('hidden');
  aktualizujPrzyciskZapasu();
}

function aktualizujPrzyciskZapasu() {
  const v = (el('input-zapas').value || '').trim();
  el('btn-zapas-toggle').textContent = v ? `Zapas K4: ${v} — zmień` : '+ Dodaj zapas K4';
}

// tap w przycisk -> rozwin pole zapasu i ustaw na nim fokus (skan/wpis)
el('btn-zapas-toggle').addEventListener('click', () => {
  el('btn-zapas-toggle').classList.add('hidden');
  el('cel-zapas-pole').classList.remove('hidden');
  fokusBezKlawiatury(el('input-zapas'));
});

// Krok cel dla PRZYPISANIA (brak zrodla): wybrany magazyn WMS narzuca ilosc (stan GT
// tego magazynu; dla K4G z czesciowym deficytem - deficyt) i magazyn lokalizacji docelowej.
// Backend i tak kapuje do deficytu. Brak "pozostanie" (nie ma zrodla).
function aktualizujKrokCelPrzypisanie() {
  ukryjKomunikat();
  ukryjPotwierdzenie();
  stan.cel = null;
  const mag = el('select-cel-magazyn').value;
  stan.celMagazynNowejLokalizacji = mag;

  // iloscSugestia = ilosc Z KLIKNIETEGO WIERSZA (deficyt tego kubelka), wiec ma pierwszenstwo
  // przed calym stanem GT magazynu. Inaczej wiersz "nieprzypisane 10" podstawialby 30 (caly
  // stan K4), czyli razem z nierozlozona dostawa - a tej na polce nie ma.
  const ile = stan.iloscSugestia != null
    ? stan.iloscSugestia
    : (stan.artykul.stany_gt?.[mag]?.ilosc ?? 0);
  const inputIlosc = el('input-ilosc');
  inputIlosc.removeAttribute('max'); // backend kapuje do deficytu magazynu
  // ROZKLADANIE DOSTAWY: zawsze edytowalne i puste, tez dla K4 - dostawe wolno rozbic na
  // dowolne porcje (czesc na dol, reszta na gore), wiec narzucanie calej ilosci bylo bledem.
  // Zwykle PRZYPISANIE na K4 = 1 SKU = 1 lokalizacja -> cala ilosc, bez edycji.
  // K4G = N lokalizacji (palety): NIE podpowiadamy calego deficytu w polu (bledne "wpisz 2000"),
  // pole zostaje PUSTE - magazynier wpisuje ile realnie kladzie tu; deficyt to podpowiedz nizej.
  // ZWROT: podpowiadamy ilosc (to zwykle 1-3 szt., ktore magazynier ma w rece), ale zostawiamy
  // edytowalne - przy zwrocie wielosztukowym moze odniesc czesc.
  const calaIloscK4 = mag === 'K4' && !stan.zrodloPula;
  inputIlosc.readOnly = calaIloscK4;
  inputIlosc.value = ((calaIloscK4 || czyDrobnicaZeStrefy()) && ile > 0) ? String(ile) : '';

  el('input-cel').value = '';
  el('input-cel').placeholder = `Skanuj lokalizację (${magazynyMapa[mag]?.nazwa ?? mag})`;
  // podpowiedz "wg GT" - gdzie GT trzyma lokalizacje tego magazynu (tw_Pole1/tw_Pole8) + regula K4.
  // Przy rozkladaniu dostawy regula "cala ilosc" NIE obowiazuje (wolno zostawic czesc na dole),
  // wiec nie wypisujemy jej - bylaby instrukcja sprzeczna z tym, co pole dopuszcza.
  const gtLok = gtLokDlaMagazynu(mag);
  const regulaK4 = calaIloscK4 ? 'K4: 1 SKU = 1 lokalizacja — cała ilość' : '';
  el('cel-lokalizacja-hint').textContent = [gtLok && `wg GT: ${gtLok}`, regulaK4].filter(Boolean).join(' · ');
  // Zapas K4 dostepny tez przy przypisaniu do K4 (po LOK lokalizacja K4 istnieje, k4-zapas zadziala)
  ustawZapasUI(mag === 'K4');
  // Ile jeszcze do rozlozenia (gdy pole ilosci puste): K4G, a przy dostawie rowniez K4.
  // Podpowiedz odtwarza aktualizujPozostanie, dzieki czemu ZOSTAJE widoczna takze podczas
  // pisania (wczesniej znikala przy pierwszym znaku).
  deficytPrzypisania = (!calaIloscK4 && ile > 0) ? ile : null;
  aktualizujPozostanie();
  aktualizujAkcjeLabel();
  if (mag === 'K4') podpowiedzLokalizacjeK4();
  fokusBezKlawiatury(el('input-cel'));
}

// K4 = 1 SKU = 1 stale miejsce, wiec przy celu na dole cel jest z gory znany - nie ma po co
// kazac go szukac (zwrot: masz sztuke w rece i wiesz, gdzie wraca). Kaskada zrodel:
//   1. lokalizacja K4 z WMS (k4-dom) - najpewniejsza, znamy ja i jej stan
//   2. tw_Pole1 z GT - gdy WMS jeszcze nie zna miejsca (stan "tylko GT"); podstawiamy TYLKO
//      gdy kod da sie rozwiazac na realna lokalizacje K4, bo tw_Pole1 bywa smieciem
//      ("RB/M2-B37 - sciana /") i podstawienie go zablokowaloby zapis
//   3. nic - i to jest UCZCIWE: zwrot przy stanie zero czesto nie ma juz swojego miejsca
//      (slot na regale mogl przejac inny towar), wiec magazynier musi zdecydowac sam
async function podpowiedzLokalizacjeK4() {
  const artykulId = stan.artykul?.artykul_gt_id;
  if (!artykulId) return;
  const nadal = () => el('select-cel-magazyn').value === 'K4' && stan.artykul?.artykul_gt_id === artykulId;

  try {
    const res = await fetch(`/api/lokalizacje/k4-dom/${encodeURIComponent(artykulId)}`);
    const dom = res.ok ? await res.json() : null;
    if (!nadal() || el('input-cel').value) return; // magazynier zdazyl zmienic wybor / wpisac sam
    if (dom?.kod) {
      el('input-cel').value = dom.kod;
      stan.cel = { typ: 'wms', id: dom.lokalizacja_id, kod: dom.kod, magazyn: 'K4' };
      el('cel-lokalizacja-hint').textContent = `Stałe miejsce w K4 (obecnie: ${dom.ilosc} szt.) — zeskanuj inną, by zmienić`;
      return;
    }
  } catch { /* brak podpowiedzi - magazynier zeskanuje */ }

  // WMS nie zna miejsca - sprobuj tego, co GT trzyma w tw_Pole1
  const zGt = gtLokDlaMagazynu('K4');
  if (!zGt) {
    if (nadal()) el('cel-lokalizacja-hint').textContent = 'Nowe miejsce w K4 — zeskanuj lokalizację';
    return;
  }
  try {
    const res = await fetch(`/api/lokalizacje/kod/${encodeURIComponent(zGt)}`);
    if (!res.ok) return;                       // smieciowy tw_Pole1 - zostaje sama podpowiedz tekstowa
    const lok = await res.json();
    if (!nadal() || el('input-cel').value) return;
    if (lok?.magazyn === 'K4') {
      el('input-cel').value = lok.kod;
      stan.cel = { typ: 'wms', id: lok.id, kod: lok.kod, magazyn: 'K4' };
      el('cel-lokalizacja-hint').textContent = `Miejsce wg GT (${lok.kod}) — zeskanuj inną, by zmienić`;
    }
  } catch { /* brak podpowiedzi - magazynier zeskanuje */ }
}

el('select-cel-magazyn').addEventListener('change', () => {
  if (stan.zrodlo) aktualizujKrokCel();
  else aktualizujKrokCelPrzypisanie();
});

// "Pozostanie w <lok>: N szt." = stan zrodla - wpisana ilosc. 0 jest NEUTRALNE
// (wyzerowanie lokalizacji to nie blad) - czerwone tylko gdy przekroczono (< 0).
function aktualizujPozostanie() {
  const span = el('pozostanie');
  if (!stan.zrodlo) {
    // Przypisanie: brak "pozostanie na zrodle", ale przy K4G pokazujemy staly deficyt
    // ("Zostało do rozłożenia: X") - nie chowamy go przy pisaniu ilosci.
    if (deficytPrzypisania != null) {
      span.textContent = `Zostało do rozłożenia: ${deficytPrzypisania} szt.`;
      span.classList.remove('blad');
      span.classList.remove('hidden');
    } else {
      span.classList.add('hidden');
    }
    return;
  }
  const ile = Number(el('input-ilosc').value);
  const poz = stan.zrodlo.ilosc - (Number.isFinite(ile) ? ile : 0);
  span.textContent = `Pozostanie w ${zrodloEtykieta()}: ${poz} szt.`;
  span.classList.toggle('blad', poz < 0);
  span.classList.remove('hidden');
}

// czy pole zapasu K4 jest aktywne (cel=K4) i jego wartosc rozni sie od zapisanej
function zapasK4Zmieniony() {
  if (el('btn-zapas-toggle').classList.contains('hidden') && el('cel-zapas-pole').classList.contains('hidden')) return false;
  const v = el('input-zapas').value.replace(/[\r\n]+/g, '').trim().toUpperCase();
  return v !== (stan.zapasK4Pierwotny || '').toUpperCase();
}

// czy biezacy "Zatwierdz" to TYLKO zapis zapasu K4 (zmiana K4->K4 bez nowej lokalizacji,
// ale zmieniony zapas) - wtedy nie robimy ruchu, tylko k4-zapas
function tylkoZapasK4() {
  return czyZmiana() && stan.zrodlo?.magazyn === 'K4'
    && !stan.cel && !el('input-cel').value.trim() && zapasK4Zmieniony();
}

// etykieta glownej akcji opisuje skutek: PRZENIES / ZMIEN LOKALIZACJE / ZAPISZ / ZAPISZ ZAPAS
function aktualizujAkcjeLabel() {
  const btn = el('btn-zatwierdz');
  const ilo = Number(el('input-ilosc').value) || 0;
  if (!stan.zrodlo) {
    btn.textContent = `ZAPISZ ${ilo} SZT.`;
  } else if (tylkoZapasK4()) {
    btn.textContent = 'ZAPISZ ZAPAS K4';
  } else if (czyZmiana()) {
    btn.textContent = 'ZMIEŃ LOKALIZACJĘ';
  } else {
    btn.textContent = `PRZENIEŚ ${ilo} SZT.`;
  }
}

el('input-ilosc').addEventListener('input', () => { aktualizujPozostanie(); aktualizujAkcjeLabel(); });

// stepper ilosci (-/+ 64x64); dotkniecie liczby = wpisanie reczne (natywny number input)
function zmienIlosc(delta) {
  const inp = el('input-ilosc');
  if (inp.readOnly) return; // K4 zmiana lokalizacji = cala ilosc
  const n = Math.max(0, (Number(inp.value) || 0) + delta);
  inp.value = String(n);
  aktualizujPozostanie();
  aktualizujAkcjeLabel();
}
el('btn-ilosc-minus').addEventListener('click', () => zmienIlosc(-1));
el('btn-ilosc-plus').addEventListener('click', () => zmienIlosc(1));


// select-all przy wejsciu w pole, zeby skan lokalizacji nadpisal podpowiedz
el('input-cel').addEventListener('focus', () => el('input-cel').select());
// wpisanie/skan nowej lokalizacji -> etykieta wraca do "ZMIEN LOKALIZACJE" (juz nie tylko-zapas)
el('input-cel').addEventListener('input', aktualizujAkcjeLabel);

// Podpowiedzi lokalizacji przy RECZNYM wpisywaniu (typeahead, jak na desktopie): po >=3 znakach
// doladowuje dopasowania z danego magazynu do <datalist>. Skan dziala jak dotad - onScan/zatwierdz
// i tak rozwiazuja kod dokladnym zapytaniem do bazy, wiec datalist jest czysto UX (mniej literowek),
// nie zrodlem prawdy. magFn() zwraca magazyn na zywo (moze sie zmienic z wyborem celu) albo null.
function podlaczTypeaheadLok(inputEl, datalistEl, magFn) {
  let timer = null;
  inputEl.addEventListener('input', () => {
    const val = inputEl.value.trim();
    clearTimeout(timer);
    const mag = magFn();
    // podpowiadamy tylko dla magazynow WMS (zewnetrzne nie maja lokalizacji) i od 3 znakow
    if (!mag || magazynyMapa[mag]?.typ !== 'wms' || val.length < 3) {
      datalistEl.innerHTML = '';
      return;
    }
    timer = setTimeout(async () => {
      if (inputEl.value.trim() !== val) return; // wartosc zmieniona/wyczyszczona w miedzyczasie (np. skan)
      try {
        const res = await fetch(`/api/lokalizacje?magazyn=${encodeURIComponent(mag)}&aktywna=1&q=${encodeURIComponent(val)}&limit=30`);
        if (!res.ok) return;
        const lista = await res.json();
        datalistEl.innerHTML = lista.map((l) => `<option value="${l.kod}"></option>`).join('');
      } catch { /* podpowiedzi opcjonalne - brak sieci nie blokuje skanu/wpisu */ }
    }, 250);
  });
}

// Lokalizacja docelowa: magazyn celu na zywo (celMagazynKod - zalezy od selecta / zrodla).
podlaczTypeaheadLok(el('input-cel'), el('input-cel-list'), celMagazynKod);
// Zapas K4 (dodatkowe miejsce K4 dla SKU) to zawsze adres w K4 - magazyn na sztywno.
podlaczTypeaheadLok(el('input-zapas'), el('input-zapas-list'), () => 'K4');

// Pole wyszukiwania: zapamietany tekst zostaje do edycji (kursor normalnie, bez zaznaczenia,
// zeby latwo dopisac/poprawic). Reczne pisanie wymaga DOTKNIECIA pola (klawiatura schowana) -
// dotkniecie = edycja, tekst zostaje. Skan wpada BEZ dotkniecia - wtedy pierwszy znak kasuje
// stary tekst, by skan nie sklejal sie z zapytaniem.
el('input-wybor-skan').addEventListener('click', () => { prefillWyszukiwaniaStale = false; });
el('input-wybor-skan').addEventListener('keydown', (e) => {
  if (prefillWyszukiwaniaStale && e.key && e.key.length === 1) {
    el('input-wybor-skan').value = '';
    prefillWyszukiwaniaStale = false;
  }
});

// sprawdza kod lokalizacji docelowej i ustawia stan.cel jesli pasuje;
// zwraca true gdy stan.cel zostal ustawiony, false gdy pokazano blad/dialog tworzenia
async function przetworzLokalizacjeCelu(kod) {
  ukryjKomunikat();
  ukryjPotwierdzenie();
  if (stan.zrodlo && stan.zrodlo.kod && kod.toUpperCase() === stan.zrodlo.kod.toUpperCase()) {
    pokazKomunikat('Lokalizacja docelowa jest taka sama jak zrodlowa', 'blad');
    return false;
  }
  try {
    const res = await fetch(`/api/lokalizacje/kod/${encodeURIComponent(kod)}`);
    if (res.status === 404) {
      pokazPotwierdzenieUtworzenia(kod);
      return false;
    }
    const dane = await res.json();
    if (!res.ok) {
      pokazKomunikat(dane.blad || 'Lokalizacja nie znaleziona', 'blad');
      return false;
    }
    if (dane.aktywna !== 1) {
      pokazKomunikat('Lokalizacja docelowa jest nieaktywna', 'blad');
      return false;
    }
    if (stan.zrodlo) {
      const docelowy = celMagazynKod();
      if (dane.magazyn !== docelowy) {
        if (czyZmiana()) {
          pokazKomunikat(`Kod "${dane.kod}" jest w magazynie ${dane.magazyn} — zmiana lokalizacji dziala tylko w ${stan.zrodlo.magazyn}. Aby przeniesc miedzy magazynami, wybierz magazyn docelowy powyzej.`, 'blad');
        } else {
          const oczekiwany = magazynyMapa[docelowy]?.nazwa || docelowy;
          const rzeczywisty = magazynyMapa[dane.magazyn]?.nazwa || dane.magazyn;
          pokazKomunikat(`Kod "${dane.kod}" jest juz uzyty w magazynie ${rzeczywisty} (kody lokalizacji sa unikalne globalnie). Wybierz inny kod dla magazynu ${oczekiwany}.`, 'blad');
        }
        return false;
      }
    } else if (stan.celMagazynNowejLokalizacji) {
      if (dane.magazyn !== stan.celMagazynNowejLokalizacji) {
        pokazKomunikat(`Kod "${dane.kod}" jest w magazynie ${dane.magazyn} - dla brakującej ilości w K4gora lokalizacja musi być w ${stan.celMagazynNowejLokalizacji}.`, 'blad');
        return false;
      }
    } else if (dane.magazyn !== 'K4' && dane.magazyn !== 'K4G') {
      pokazKomunikat(`Kod "${dane.kod}" jest w magazynie ${dane.magazyn} - lokalizacje WMS sa tylko w K4 i K4gora.`, 'blad');
      return false;
    }
    el('cel-lokalizacja-hint').textContent = (!stan.zrodlo && dane.magazyn === 'K4')
      ? 'K4: 1 SKU = 1 lokalizacja — wpisz całą ilość z tej lokalizacji'
      : '';
    stan.cel = { typ: 'wms', id: dane.id, kod: dane.kod, magazyn: dane.magazyn };
    el('input-cel').value = dane.kod;
    // Przypisanie (brak zrodla) wg magazynu SKANOWANEJ lokalizacji:
    //  - K4 (1 SKU = 1 lokalizacja): narzuc CALA ilosc, pole zablokowane;
    //  - K4G (N lokalizacji / palety): NIE nadpisujemy tego, co magazynier wpisal (np. 200) -
    //    inaczej klik "Zatwierdz" podmienialby wpisana ilosc na caly deficyt. Pole zostaje.
    //  - ROZKLADANIE DOSTAWY: pole zostaje edytowalne takze dla K4 - dostawe wolno rozbic
    //    na czesci, wiec narzucanie calosci bylo by bledem.
    //
    // "Cala ilosc" = iloscSugestia (deficyt KLIKNIETEGO wiersza), a NIE caly stan GT magazynu:
    // ten drugi zawiera jeszcze nierozlozona dostawe, ktorej na polce fizycznie nie ma, wiec
    // backend i tak by ja odrzucil ("przypisz cala ilosc (301) bez 20 z dostawy").
    if (!stan.zrodlo) {
      const mag = dane.magazyn;
      const calaIloscK4 = mag === 'K4' && !stan.zrodloPula;
      el('input-ilosc').readOnly = calaIloscK4;
      if (calaIloscK4) {
        const pelny = stan.iloscSugestia != null
          ? stan.iloscSugestia
          : (stan.artykul.stany_gt?.K4?.ilosc ?? null);
        if (pelny != null && pelny > 0) {
          el('input-ilosc').value = String(pelny);
          aktualizujPozostanie();
          aktualizujAkcjeLabel(); // .value ustawione z kodu nie odpala 'input' - etykieta przycisku
                                  // zostalaby na starej liczbie (stad "pole 321 / ZAPISZ 301 szt.")
        }
      }
    }
    return true;
  } catch (err) {
    pokazKomunikat('Blad polaczenia z serwerem', 'blad');
    return false;
  }
}

onScan(el('input-cel'), async (kod) => {
  const ok = await przetworzLokalizacjeCelu(kod);
  // po poprawnym celu chowamy klawiature (B); ilosci NIE fokusujemy (A) - stepper/tap-to-edit
  if (ok) el('input-cel').blur();
});

// --- potwierdzenie utworzenia nieznanej lokalizacji docelowej ---
function magazynDlaNowejCel() {
  return stan.zrodlo
    ? celMagazynKod()
    : (stan.celMagazynNowejLokalizacji ?? magazynDlaNowejLokalizacji(stan.artykul.stany_gt));
}

function pokazPotwierdzenieUtworzenia(kod) {
  kodDoUtworzenia = kod;
  const magazynKod = magazynDlaNowejCel();
  const nazwaMagazynu = magazynyMapa[magazynKod]?.nazwa ?? magazynKod;
  el('cel-potwierdzenie-tekst').textContent = `Lokalizacja "${kod}" nie istnieje w magazynie ${nazwaMagazynu}. Utworzyć?`;
  el('cel-potwierdzenie').classList.remove('hidden');
}

function ukryjPotwierdzenie() {
  kodDoUtworzenia = null;
  el('cel-potwierdzenie').classList.add('hidden');
}

el('btn-cel-utworz-tak').addEventListener('click', async () => {
  if (!kodDoUtworzenia) return;
  const magazyn = magazynDlaNowejCel();
  try {
    const res = await fetch('/api/lokalizacje', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kod: kodDoUtworzenia, magazyn }),
    });
    const dane = await res.json();
    if (!res.ok) {
      pokazKomunikat(dane.blad || 'Nie udalo sie utworzyc lokalizacji', 'blad');
      return;
    }
    el('cel-lokalizacja-hint').textContent = '';
    stan.cel = { typ: 'wms', id: dane.id, kod: dane.kod, magazyn: dane.magazyn };
    el('input-cel').value = dane.kod;
    ukryjPotwierdzenie();
    // lokalizacja utworzona - nie fokusujemy ilosci (bez numerycznej klawiatury)
  } catch (err) {
    pokazKomunikat('Blad polaczenia z serwerem', 'blad');
  }
});

el('btn-cel-utworz-nie').addEventListener('click', () => {
  ukryjPotwierdzenie();
  el('input-cel').value = '';
  fokusBezKlawiatury(el('input-cel'));
});

// Zapis SAMEGO zapasu K4 (bez ruchu) - gdy w K4->K4 nie zmieniamy lokalizacji podstawowej,
// a tylko dokladamy/zmieniamy/czyscimy zapas. Wymaga istniejacej lokalizacji K4 (zrodlo K4).
async function zapiszTylkoZapas() {
  const zapasNowy = el('input-zapas').value.replace(/[\r\n]+/g, '').trim().toUpperCase();
  const btn = el('btn-zatwierdz');
  btn.disabled = true;
  try {
    const r = await fetch(`/api/lokalizacje/k4-zapas/${encodeURIComponent(stan.artykul.artykul_gt_id)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ zapas_kod: zapasNowy }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      pokazKomunikat(e.blad || 'Nie zapisano zapasu K4', 'blad');
      return;
    }
    const sym = stan.artykul.artykul_symbol;
    pokazSukces(zapasNowy ? `Zapas K4 ${sym}: ${zapasNowy}` : `Zapas K4 ${sym} wyczyszczony`);
  } catch {
    pokazKomunikat('Blad polaczenia z serwerem', 'blad');
  } finally {
    btn.disabled = false;
  }
}

// --- zatwierdzenie ruchu (LOK albo MM, zaleznie od celu) ---
async function zatwierdz() {
  // TYLKO ZAPAS: zmiana w K4 bez nowej lokalizacji, ale zmieniony zapas -> sam zapis zapasu
  if (tylkoZapasK4()) {
    return zapiszTylkoZapas();
  }

  // upewnij sie, ze cel WMS jest ustawiony (gdy wpisano kod bez Enter); cel zewnetrzny ma stan.cel z aktualizujKrokCel
  if (!stan.cel) {
    const wpisany = el('input-cel').value.trim().toUpperCase();
    if (!wpisany) {
      pokazKomunikat('Zeskanuj lokalizację docelową', 'blad');
      fokusBezKlawiatury(el('input-cel'));
      return;
    }
    el('input-cel').value = '';
    const ok = await przetworzLokalizacjeCelu(wpisany);
    if (!ok) {
      if (!kodDoUtworzenia) fokusBezKlawiatury(el('input-cel'));
      return;
    }
  }

  const ilo = Number(el('input-ilosc').value);
  if (!Number.isFinite(ilo) || ilo <= 0) {
    pokazKomunikat('Podaj poprawna ilosc > 0', 'blad');
    return;
  }
  if (stan.zrodlo) {
    if (ilo > stan.zrodlo.ilosc) {
      pokazKomunikat(`Ilosc przekracza dostepna (${stan.zrodlo.ilosc})`, 'blad');
      return;
    }
    if (czyZmiana() && stan.zrodlo.magazyn === 'K4' && ilo !== stan.zrodlo.ilosc) {
      pokazKomunikat('W magazynie K4 mozna zmienic lokalizacje tylko dla calej ilosci', 'blad');
      return;
    }
  }

  const symbol = stan.artykul.artykul_symbol;
  let url, body, podsumowanie;
  if (!stan.zrodlo && stan.zrodloPula) {
    // ROZLOZENIE DOSTAWY: zrodlem jest nieprzypisana pula K4 (paleta lezy wg GT na dole,
    // ale jedzie na gore). MM prosto z puli - polka pickowa NIE jest po drodze pompowana.
    url = '/api/ruchy/rozloz';
    body = {
      artykul_gt_id: stan.artykul.artykul_gt_id,
      mag_zrodlo_pula: stan.zrodloPula,
      zrodlo_dok: stan.zrodloDok,
      lok_cel_id: stan.cel.id,
      artykul_symbol: stan.artykul.artykul_symbol,
      artykul_nazwa: stan.artykul.artykul_nazwa,
      ilosc: ilo,
      operator: operator(),
    };
    podsumowanie = () => czyDrobnicaZeStrefy()
      ? `Odniesiono ${stan.dostawa.rodzaj === 'zwrot' ? 'zwrot' : 'przywózkę'} ${symbol} (${ilo} szt.): ${stan.cel.kod}`
      : `Rozłożono ${symbol} (${ilo} szt.): ${stan.zrodloPula} → ${stan.cel.kod}`;
  } else if (!stan.zrodlo) {
    // przypisanie pierwszej/kolejnej lokalizacji w WMS (LOK)
    url = '/api/ruchy/lok';
    body = {
      artykul_gt_id: stan.artykul.artykul_gt_id,
      lok_zrodlo_id: null,
      lok_cel_id: stan.cel.id,
      artykul_symbol: stan.artykul.artykul_symbol,
      artykul_nazwa: stan.artykul.artykul_nazwa,
      ilosc: ilo,
      operator: operator(),
    };
    podsumowanie = () => `Zapisano lokalizację ${symbol} (${ilo} szt.): ${stan.cel.kod}`;
  } else if (czyZrodloZewn()) {
    // zrodlo zewnetrzne (MAG/LS): cel WMS -> przyjecie; cel zewnetrzny -> MM zewn.
    if (stan.cel.typ === 'wms') {
      url = '/api/ruchy/przyjecie';
      body = {
        artykul_gt_id: stan.artykul.artykul_gt_id,
        mag_zrodlo_zewnetrzny: stan.zrodlo.magazyn,
        lok_cel_id: stan.cel.id,
        artykul_symbol: stan.artykul.artykul_symbol,
        artykul_nazwa: stan.artykul.artykul_nazwa,
        ilosc: ilo,
        operator: operator(),
      };
      podsumowanie = () => `Przyjęto ${ilo} szt. ${symbol}: ${stan.zrodlo.nazwa} → ${stan.cel.kod}`;
    } else {
      url = '/api/ruchy/mm-zewnetrzny';
      body = {
        artykul_gt_id: stan.artykul.artykul_gt_id,
        mag_zrodlo: stan.zrodlo.magazyn,
        mag_cel: stan.cel.magazyn,
        artykul_symbol: stan.artykul.artykul_symbol,
        ilosc: ilo,
        operator: operator(),
      };
      podsumowanie = () => `Przeniesiono ${ilo} szt. ${symbol}: ${stan.zrodlo.nazwa} → ${stan.cel.nazwa || stan.cel.magazyn}`;
    }
  } else if (czyZmiana()) {
    // zmiana lokalizacji w obrebie magazynu (LOK)
    url = '/api/ruchy/lok';
    body = {
      artykul_gt_id: stan.artykul.artykul_gt_id,
      lok_zrodlo_id: stan.zrodlo.lokalizacja_id,
      lok_cel_id: stan.cel.id,
      ilosc: ilo,
      operator: operator(),
    };
    podsumowanie = () => `Zmieniono lokalizację ${symbol} (${ilo} szt.): ${stan.zrodlo.kod} → ${stan.cel.kod}`;
  } else {
    // przesuniecie miedzy magazynami (MM)
    url = '/api/ruchy/mm';
    body = {
      artykul_gt_id: stan.artykul.artykul_gt_id,
      lok_zrodlo_id: stan.zrodlo.lokalizacja_id,
      ilosc: ilo,
      operator: operator(),
    };
    if (stan.cel.typ === 'wms') body.lok_cel_id = stan.cel.id;
    else body.mag_cel_zewnetrzny = stan.cel.magazyn;
    podsumowanie = () => {
      const celMagTekst = stan.cel.typ === 'wms' ? stan.cel.magazyn : (stan.cel.nazwa || stan.cel.magazyn);
      const celLok = stan.cel.typ === 'wms' ? ` lok ${stan.cel.kod}` : '';
      const pozostalo = stan.zrodlo.ilosc - ilo;
      // K4G: gdy nic nie zostaje, lokalizacja jest zwalniana; K4 zostaje jako stale miejsce SKU
      const zwolniona = pozostalo <= 0 && stan.zrodlo.magazyn !== 'K4';
      const ogon = zwolniona ? ' — lokalizacja zwolniona' : ` (pozostało ${pozostalo})`;
      return `Przeniesiono ${ilo} szt. ${symbol}: ${stan.zrodlo.magazyn} → ${celMagTekst}${celLok}${ogon}`;
    };
  }

  ukryjKomunikat();
  const { ok, dane } = await wyslijRuch(url, body);
  if (!ok) {
    pokazKomunikat(dane.blad || 'Blad zapisu ruchu', 'blad');
    return;
  }
  // MM (przesuniecie miedzy magazynami) wymaga dokumentu w GT - dopiero to faktycznie
  // przesuwa stan. LOK (zmiana lokalizacji w obrebie magazynu / przypisanie) NIE tworzy
  // dokumentu; jego 'pending' oznacza tylko zalegajacy sync pol lokalizacyjnych GT, a sama
  // zmiana w WMS jest juz zapisana i autorytatywna.
  const wymagaDokumentuGt = url === '/api/ruchy/mm' || url === '/api/ruchy/przyjecie'
    || url === '/api/ruchy/mm-zewnetrzny' || url === '/api/ruchy/rozloz';
  const gtOczekuje = dane && dane.status && dane.status !== 'ok';
  const niepotwierdzoneMM = wymagaDokumentuGt && gtOczekuje;
  let tekst = podsumowanie();
  if (gtOczekuje && !wymagaDokumentuGt) tekst += ' · GT: oczekuje';

  // Zapas K4: po udanym ruchu DO K4 (lokalizacja K4 juz istnieje) zapisz/wyczysc adnotacje,
  // jesli pole sie zmienilo. To osobny ruch (k4-zapas) - blad nie cofa zapisanego ruchu.
  if (stan.cel && stan.cel.typ === 'wms' && stan.cel.magazyn === 'K4') {
    const zapasNowy = el('input-zapas').value.replace(/[\r\n]+/g, '').trim().toUpperCase();
    if (zapasNowy !== (stan.zapasK4Pierwotny || '').toUpperCase()) {
      try {
        const r = await fetch(`/api/lokalizacje/k4-zapas/${encodeURIComponent(stan.artykul.artykul_gt_id)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ zapas_kod: zapasNowy }),
        });
        if (r.ok) tekst += zapasNowy ? ` · zapas K4: ${zapasNowy}` : ' · zapas K4 wyczyszczony';
        else { const e = await r.json().catch(() => ({})); tekst += ` · zapas K4 NIE zapisany (${e.blad || 'błąd'})`; }
      } catch { tekst += ' · zapas K4 NIE zapisany (błąd połączenia)'; }
    }
  }

  // "brak cichych porazek" (Faza A#3): gdy MM nie potwierdzil sie w GT (most/Sfera
  // niedostepne), NIE pokazujemy zielonego sukcesu - inaczej magazynier uzna, ze stan
  // sie przesunal. Ruch zostaje 'pending' w WMS i job ponawiania go dogoni.
  // Path 2: zapamietaj produkt i lokalizacje (localStorage) - do szybkiego powrotu bez skanu
  zapamietajProdukt(stan.artykul);
  if (stan.cel && stan.cel.typ === 'wms') zapamietajLokalizacje(stan.cel.kod, stan.cel.magazyn);

  if (niepotwierdzoneMM) {
    zrobione.unshift(`⏳ niepotwierdzone w GT: ${tekst}`); // #5: uczciwy slad w liscie sesji
    pokazSukces(`${tekst}\n\n⏳ NIE potwierdzone w GT — oczekuje. Zapisane w WMS, zostanie ponowione. Sprawdź połączenie z GT.`, 'ostrzezenie');
    return;
  }
  zrobione.unshift(tekst); // #5: dopisz do listy zrobionych (widoczna po powrocie na start)
  // Path 1: odswiez dane produktu; jesli cos jeszcze nieprzypisane (K4/K4G) -> ekran sukcesu da "Dalej"
  swiezeDaneProduktu = await odswiezDaneProduktu();
  // K4: `nieprzypisane_k4` ("do sprawdzenia"), a NIE `deficyt_k4` (stan GT - suma WMS).
  // Deficyt zawiera takze strefy - nierozlozona dostawe i zwrot czekajacy w strefie - wiec
  // "Dalej" proponowalby przypisanie na polke sztuk, ktore fizycznie leza na palecie. Backend
  // i tak by to odrzucil (regula "cala ilosc bez wDrodze" w /ruchy/lok), wiec magazynier
  // dostawalby zaproszenie do operacji, ktora nie moze sie udac.
  // Backend ustawia nieprzypisane_k4 ZAWSZE gdy rozbicie sie udalo - `?? deficyt_k4` lapie
  // tylko przypadek "GT niedostepne, rozbicia nie ma".
  // K4G nie ma stref (dostawy wchodza PZ-em na K4), wiec tam deficyt jest wlasciwa liczba.
  const pozostalo = swiezeDaneProduktu
    ? {
      K4: swiezeDaneProduktu.nieprzypisane_k4 ?? swiezeDaneProduktu.deficyt_k4 ?? 0,
      K4G: swiezeDaneProduktu.deficyt_k4g || 0,
    }
    : null;
  pokazSukces(tekst, null, pozostalo);
}

// Path 1: po zapisie pobierz swieze dane produktu (/skan/:symbol) - do decyzji "Dalej"
// oraz do ponownego otwarcia produktu DOKLADNIE ta sama logika co po skanie (rozklad K4/K4G
// + wiersze "BRAK LOKALIZACJI" dla niezlokalizowanego stanu). null gdy blad / nie artykul.
async function odswiezDaneProduktu() {
  const a = stan.artykul;
  if (!a) return null;
  try {
    const res = await fetch(`/api/lokalizacje/skan/${encodeURIComponent(a.artykul_symbol)}`);
    if (!res.ok) return null;
    const dane = await res.json();
    return dane.typ === 'artykul' ? dane : null;
  } catch { return null; }
}

// --- ekran sukcesu (overlay + sygnal dzwiekowy; znika dopiero po dotknieciu) ---
let audioCtx = null;

// Odblokowanie audio na pierwszy gest (Android/Chrome blokuje dzwiek bez interakcji).
// Trzymamy kontekst aktywny, zeby beep po skanie faktycznie zagral.
function odblokujAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) { /* audio opcjonalne */ }
}
document.addEventListener('pointerdown', odblokujAudio);
document.addEventListener('keydown', odblokujAudio);

function beep() {
  try {
    odblokujAudio();
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime;
    // dwa wznoszace tony, fala prostokatna = wyrazniejszy/glosniejszy sygnal "OK"
    for (const [freq, dt] of [[988, 0], [1319, 0.15]]) {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.connect(g);
      g.connect(audioCtx.destination);
      o.type = 'square';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0 + dt);
      g.gain.exponentialRampToValueAtTime(0.5, t0 + dt + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.16);
      o.start(t0 + dt);
      o.stop(t0 + dt + 0.17);
    }
  } catch (e) {
    // dzwiek opcjonalny - brak Web Audio nie blokuje potwierdzenia
  }
}

// dwa opadajace, niskie tony = wyrazny sygnal "UWAGA" (inny niz wznoszacy beep sukcesu)
function beepOstrzezenie() {
  try {
    odblokujAudio();
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime;
    for (const [freq, dt] of [[440, 0], [311, 0.2]]) {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.connect(g);
      g.connect(audioCtx.destination);
      o.type = 'square';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0 + dt);
      g.gain.exponentialRampToValueAtTime(0.5, t0 + dt + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.22);
      o.start(t0 + dt);
      o.stop(t0 + dt + 0.23);
    }
  } catch (e) { /* dzwiek opcjonalny */ }
}

// wariant 'ostrzezenie' = operacja NIE potwierdzona w GT (MM oczekuje) - inny kolor/ikona/
// dzwiek, zeby magazynier nie odczytal ekranu jako zielony sukces ("brak cichych porazek").
function pokazSukces(tekst, wariant, pozostalo) {
  const ostrzezenie = wariant === 'ostrzezenie';
  el('sukces-tekst').textContent = tekst;
  el('sukces-ikona').textContent = ostrzezenie ? '⏳' : '✓';
  el('sukces-overlay').classList.toggle('ostrzezenie', ostrzezenie);

  // Path 1: cos zostalo nieprzypisane -> tryb "Dalej" (zostajemy w produkcie), tlo nie zamyka
  const zostalo = pozostalo ? (pozostalo.K4 || 0) + (pozostalo.K4G || 0) : 0;
  sukcesDalejAktywny = zostalo > 0 && !ostrzezenie && !!stan.artykul;
  el('sukces-akcje').classList.toggle('hidden', !sukcesDalejAktywny);
  el('sukces-hint').classList.toggle('hidden', sukcesDalejAktywny);
  if (sukcesDalejAktywny) {
    const czesci = [];
    if (pozostalo.K4 > 0) czesci.push(`K4 ${pozostalo.K4}`);
    if (pozostalo.K4G > 0) czesci.push(`K4G ${pozostalo.K4G}`);
    el('sukces-pozostalo').textContent = `Zostało do rozłożenia: ${czesci.join(' · ')} szt.`;
  }

  el('sukces-overlay').classList.remove('hidden');
  if (ostrzezenie) beepOstrzezenie(); else beep();
}

// Path 1: zostan w tym samym produkcie i rozloz reszte (bez re-skanu SKU). Otwiera swieze
// dane -> rozklad (co na K4, co na K4G, co niezlokalizowane).
function kontynuujTenSamProdukt() {
  const dane = swiezeDaneProduktu;
  if (!dane) { reset(); return; }
  ukryjKomunikat();
  // skrotPrzypisania: to kontynuacja, nie nowe wejscie w produkt - gdy do rozlozenia zostala
  // sama nieprzypisana pula (zero lokalizacji WMS), wchodzimy prosto w "Dokad i ile?".
  // Petla rozkladania palety ma zostac bez dodatkowego tapa.
  obsluzArtykul(dane, { skrotPrzypisania: true });
}

// Dokad wyjsc z kreatora. Domyslnie: reset (wejscie z kafla "Ruch" = nowy ruch od zera).
// Ekran, ktory wchodzi tu ze SWOJEJ listy (Dostawy, Przywozka, PW, Do sprawdzenia), podaje
// wlasny powrot przez ruchOtworzArtykul(kod, {powrot}) - wtedy oddajemy go na te liste,
// zamiast wyrzucac do pustego skanu.
//
// Callback jest zerowany przy KAZDYM wyjsciu z widoku Ruch (pokazWidok) i tuz przed
// wywolaniem - inaczej wyciekalby na kolejny, niezwiazany produkt. Tak juz raz powstal blad
// z kontekstem dostawy, wiec kasujemy go w jednym miejscu i bezwarunkowo.
let powrotDoZrodla = null;

// Wyjscie z kreatora, gdy nie ma juz kroku wstecz W OBREBIE Ruchu. Dotyczy tak samo sukcesu,
// jak i Wstecz: przy wejsciu z cudzej listy krok wyboru jest PIERWSZYM ekranem, wiec zejscie
// na "czysty skan" nie bylo krokiem wstecz, tylko zgubieniem kontekstu - trzeba bylo cofac
// dwa razy, zeby wrocic na liste, z ktorej sie przyszlo.
function wyjdzZKreatora() {
  const powrot = powrotDoZrodla;
  powrotDoZrodla = null;
  if (powrot) powrot(); else reset();
}

function wyjdzZSukcesu() {
  el('sukces-overlay').classList.add('hidden');
  wyjdzZKreatora();
}

// ekran sukcesu znika po dotknieciu i resetuje kreator do nowego ruchu
// (w trybie "Dalej" tlo NIE zamyka - trzeba wybrac przycisk Dalej/Gotowe)
el('sukces-overlay').addEventListener('click', () => {
  if (sukcesDalejAktywny) return;
  wyjdzZSukcesu();
});
el('btn-sukces-dalej').addEventListener('click', (e) => {
  e.stopPropagation();
  sukcesDalejAktywny = false;
  el('sukces-overlay').classList.add('hidden');
  kontynuujTenSamProdukt();   // zostajemy w produkcie - powrot czeka na "Gotowe"
});
el('btn-sukces-gotowe').addEventListener('click', (e) => {
  e.stopPropagation();
  sukcesDalejAktywny = false;
  wyjdzZSukcesu();
});

el('btn-zatwierdz').addEventListener('click', zatwierdz);
el('input-ilosc').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    zatwierdz();
  }
});

// pola skanu bez automatycznej klawiatury ekranowej (dotkniecie = reczne wpisanie)
polaSkanuBezKlawiatury(el('input-start'), el('input-wybor-skan'), el('input-cel'), el('input-zapas'));
// skan kodu zapasu zaznacza tekst przy fokusie (nadpisuje obecny); Enter chowa klawiature
el('input-zapas').addEventListener('focus', () => el('input-zapas').select());
el('input-zapas').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el('input-zapas').blur(); } });
// zmiana zapasu -> odswiez etykiete akcji (np. "ZAPISZ ZAPAS K4" gdy bez nowej lokalizacji)
el('input-zapas').addEventListener('input', aktualizujAkcjeLabel);

// --- router widokow (SPA: menu <-> ruch bez przeladowania, pelny ekran sie trzyma) ---
// stan - opcjonalny wpis historii ({v, ...}), przekazywany widokom-SPA, zeby Back wracal do
// KONKRETNEGO podekranu, a nie na poczatek widoku (Dostawy maja trzy poziomy: faktury ->
// towary -> produkt, wiec sam 'dostawy' nie wystarczy do odtworzenia miejsca).
function pokazWidok(nazwa, stan) {
  el('widok-menu').classList.toggle('hidden', nazwa !== 'menu');
  el('widok-ruch').classList.toggle('hidden', nazwa !== 'ruch');
  const uzup = el('widok-uzupelnienia');
  if (uzup) uzup.classList.toggle('hidden', nazwa !== 'uzupelnienia');
  const hist = el('widok-historia');
  if (hist) hist.classList.toggle('hidden', nazwa !== 'historia');
  const sciezki = el('widok-sciezki');
  if (sciezki) sciezki.classList.toggle('hidden', nazwa !== 'sciezki');
  const zwroty = el('widok-zwroty');
  if (zwroty) zwroty.classList.toggle('hidden', nazwa !== 'zwroty');
  const dostawy = el('widok-dostawy');
  if (dostawy) dostawy.classList.toggle('hidden', nazwa !== 'dostawy');
  const przyjecia = el('widok-przyjecia');
  if (przyjecia) przyjecia.classList.toggle('hidden', nazwa !== 'przyjecia');
  const przywozki = el('widok-przywozki');
  if (przywozki) przywozki.classList.toggle('hidden', nazwa !== 'przywozki');
  const pw = el('widok-pw');
  if (pw) pw.classList.toggle('hidden', nazwa !== 'pw');
  const dosp = el('widok-dosp');
  if (dosp) dosp.classList.toggle('hidden', nazwa !== 'dosp');
  const parametry = el('widok-parametry');
  if (parametry) parametry.classList.toggle('hidden', nazwa !== 'parametry');
  // Wyjscie z Ruchu unieważnia powrot poprzedniego wywolujacego - inaczej sukces w zupelnie
  // innym kontekscie odeslalby na liste, ktorej juz nie ma na ekranie.
  if (nazwa !== 'ruch') powrotDoZrodla = null;
  if (nazwa === 'ruch') { zrobione = []; reset(); } // #5: swieze wejscie czysci liste zrobionych
  if (nazwa === 'uzupelnienia' && window.uzupOtworz) window.uzupOtworz();
  if (nazwa === 'historia' && window.historiaOtworz) window.historiaOtworz();
  if (nazwa === 'sciezki' && window.sciezkiOtworz) window.sciezkiOtworz();
  if (nazwa === 'zwroty' && window.zwrotyOtworz) window.zwrotyOtworz();
  if (nazwa === 'dostawy' && window.dostawyOtworz) window.dostawyOtworz(stan);
  if (nazwa === 'przywozki' && window.przywozkiOtworz) window.przywozkiOtworz();
  if (nazwa === 'pw' && window.przyjeciaWewnOtworz) window.przyjeciaWewnOtworz();
  if (nazwa === 'dosp' && window.doSprawdzeniaOtworz) window.doSprawdzeniaOtworz();
}
window.pokazWidok = pokazWidok;

// Otworz widok Ruch od razu dla danego SKU/lokalizacji (uzywane np. z raportu Sciezek).
// opcje.powrot - funkcja wolana po zamknieciu ekranu sukcesu zamiast resetu kreatora.
// Ustawiamy PO pokazWidok, bo pokazWidok('ruch') czysci kontekst poprzedniego wejscia.
window.ruchOtworzArtykul = (kod, opcje) => {
  pokazWidok('ruch');
  powrotDoZrodla = opcje?.powrot ?? null;
  history.pushState({ v: 'ruch' }, '');
  if (kod) wykonajSkan(String(kod));
};
el('btn-go-ruch').addEventListener('click', () => {
  pokazWidok('ruch');
  history.pushState({ v: 'ruch' }, '');
});
el('btn-pelny-ekran').addEventListener('click', () => {
  if (window.przelaczPelnyEkran) window.przelaczPelnyEkran();
});
// systemowy/przegladarkowy/sprzetowy Back -> wroc o jeden poziom (nie wychodz z apki).
// Stan {v:'sciezki'} na stosie (dokladany przy wejsciu w menu scizek ORAZ w podekrany
// obchodu/raportu) sprawia, ze Back z raportu/obchodu wraca do MENU SCIZEK, a dopiero
// stamtad do menu glownego - zamiast przeskakiwac od razu do menu glownego.
// Widoki-SPA pushuja {v:<nazwa>} na wejsciu i przy podekranie, wiec Back cofa o jeden krok:
// podekran -> menu widoku -> menu glowne. Nieznany/pusty stan = menu glowne.
const WIDOKI_Z_HISTORIA = ['sciezki', 'zwroty', 'dostawy', 'przyjecia', 'przywozki', 'pw', 'dosp', 'parametry'];
window.addEventListener('popstate', (e) => {
  const v = WIDOKI_Z_HISTORIA.includes(e.state?.v) ? e.state.v : 'menu';
  pokazWidok(v, e.state);   // caly wpis, bo niesie tez podekran (np. {v:'dostawy', dok})
});

(async () => { await initMagazyny(); })();
pokazWidok('menu');

// Rola „uczen" = tylko Sciezki. ALLOW-lista, nie deny-lista: chowamy KAZDY kafel menu poza
// wymienionymi ponizej. Dzieki temu nowy kafel jest domyslnie niewidoczny dla ucznia i nikt
// nie musi pamietac o dopisaniu id (deny-lista zostala kiedys przy Dostawach i Przyjeciach).
const MENU_DLA_UCZNIA = ['btn-go-sciezki', 'btn-pelny-ekran'];   // pelny ekran = nie funkcja magazynowa

// Uwaga: selektor celuje w POTOMKOW #widok-menu, wiec (a) nie rusza klasy .hidden samego
// kontenera - pokazWidok przelacza nia caly widok, (b) nie dotyka kafli w podmenu innych
// widokow (btn-go-zwroty w #widok-sciezki, btn-go-pw/dosp/przywozki w #widok-przyjecia).
// Link „Test wyszukiwania" ma dzis klase btn-menu, ale wymieniamy go tez z nazwy na wypadek
// gdyby ja stracil - querySelectorAll przy selektorze z przecinkiem zwraca kazdy element raz.
function zastosujRoleWMenu() {
  const uczen = (window.WMS?.user() || {}).rola === 'uczen';
  for (const kafel of document.querySelectorAll('#widok-menu .btn-menu, #widok-menu a[href="produkty.html"]')) {
    kafel.classList.toggle('hidden', uczen && !MENU_DLA_UCZNIA.includes(kafel.id));
  }
  // Punktowe wyjatki w PODmenu (dzis: raporty w Sciezkach). Tu allow-lista byla by zla:
  // w menu glownym „nowy kafel = ukryty" jest bezpiecznym domyslnym, ale w Sciezkach nowa
  // sciezka MA byc dla ucznia widoczna - ukrywamy tylko to, co jawnie oznaczone.
  for (const kafel of document.querySelectorAll('[data-bez-ucznia]')) {
    kafel.classList.toggle('hidden', uczen);
  }
}

// Podpinamy OBA sygnaly, bo WMS.gotowe to Promise - rozwiazuje sie RAZ na zaladowanie strony,
// a wyloguj() nie przeladowuje Zebry (SPA: pelny ekran ma sie trzymac). Samo gotowe znaczylo,
// ze po zmianie profilu menu zostawalo z rola POPRZEDNIEGO uzytkownika: uczen po magazynierze
// widzial wszystko, a magazynier po uczniu tylko Sciezki. Do tego toggle zamiast add, zeby
// stan sie cofal - jednokierunkowe add zostawialo klasy nastepnemu zalogowanemu.
// Ten sam wzorzec co pokazZakladkeAdmina na desktopie (public/desktop/app.js).
if (window.WMS?.gotowe) window.WMS.gotowe.then(zastosujRoleWMenu);
window.addEventListener('wms-zalogowano', zastosujRoleWMenu);
