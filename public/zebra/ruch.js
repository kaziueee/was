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

// lista magazynow (z /api/magazyny), do wyboru celu w kroku 3
let magazynyLista = [];
const magazynyMapa = {}; // kod -> {kod, nazwa, typ}

async function initMagazyny() {
  const res = await fetch('/api/magazyny');
  magazynyLista = await res.json();
  magazynyLista.forEach((m) => { magazynyMapa[m.kod] = m; });
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
  if (!stan.zrodlo) {
    kontekst = '<span class="chip chip-uwaga">Brak lokalizacji w WMS</span>';
  } else {
    // rezerwacja jest per-magazyn (GT) - pokazujemy ja jako chip ostrzegawczy, tylko gdy > 0
    const rez = a.stany_gt?.[stan.zrodlo.magazyn]?.rezerwacja ?? 0;
    kontekst = `<span class="chip chip-magazyn">${stan.zrodlo.magazyn}</span>`
      + `<span class="chip">Z: <b>${zrodloEtykieta()}</b></span>`
      + (rez > 0 ? `<span class="chip chip-rez">rez ${rez}</span>` : '');
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
    // z kroku "cel": wroc do listy wyboru jesli byla, inaczej do czystego skanu
    if (opcjeWyboru.length > 0 || ostatniaListaArtykulow) {
      pokazKrok('wybor');
      el('input-wybor-skan').focus();
    } else {
      reset(); // brak listy -> czysty skan (czysci stan i naglowek)
    }
  } else if (!kroki.wybor.classList.contains('hidden')) {
    // z rozkladu produktu otwartego z wynikow wyszukiwania -> wroc do wynikow;
    // z samej listy wynikow / zawartosci lokalizacji / rozkladu po skanie -> czysty skan
    if (powrotDoWyszukiwania && ostatniaListaArtykulow) {
      obsluzListaArtykulow(ostatniaListaArtykulow, false);
    } else {
      reset();
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

function reset() {
  if (window.BlokadaEdycji) BlokadaEdycji.zwolnij(); // zwolnij lock edycji produktu
  stan.artykul = null;
  stan.zrodlo = null;
  stan.cel = null;
  stan.iloscSugestia = null;
  stan.celMagazynNowejLokalizacji = null;
  opcjeWyboru = [];
  ostatniaListaArtykulow = null;
  ostatnieZapytanieNazwa = '';
  prefillWyszukiwaniaStale = false;
  trybWyboru = 'wybor';
  powrotDoWyszukiwania = false;

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
  el('input-start').focus();
  renderujZrobione(); // pokaz liste zrobionych (jesli sa w tej sesji)
}

// --- krok 1: skan SKU, EAN, lokalizacji albo (czesci) nazwy artykulu ---
async function wykonajSkan(kod) {
  ukryjKomunikat();
  try {
    const res = await fetch(`/api/lokalizacje/skan/${encodeURIComponent(kod)}`);
    const dane = await res.json();
    if (!res.ok) {
      pokazKomunikat(dane.blad || 'Nie znaleziono', 'blad');
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
  if (zawartosc.length === 0) {
    pokazKomunikat(`Lokalizacja ${lokalizacja.kod} jest pusta`, 'blad');
    return;
  }
  if (zawartosc.length === 1) {
    const poz = zawartosc[0];
    stan.artykul = { artykul_gt_id: poz.artykul_gt_id, artykul_symbol: poz.artykul_symbol, artykul_nazwa: poz.artykul_nazwa, stany_gt: poz.stany_gt, lokalizacja_gt: poz.lokalizacja_gt };
    stan.zrodlo = { lokalizacja_id: lokalizacja.id, kod: lokalizacja.kod, magazyn: lokalizacja.magazyn, ilosc: poz.ilosc };
    przejdzDoCelu();
    return;
  }

  opcjeWyboru = zawartosc.map((poz) => ({
    klucz: poz.artykul_symbol,
    artykul: { artykul_gt_id: poz.artykul_gt_id, artykul_symbol: poz.artykul_symbol, artykul_nazwa: poz.artykul_nazwa, stany_gt: poz.stany_gt, lokalizacja_gt: poz.lokalizacja_gt },
    zrodlo: { lokalizacja_id: lokalizacja.id, kod: lokalizacja.kod, magazyn: lokalizacja.magazyn, ilosc: poz.ilosc },
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
  el('input-wybor-skan').focus();
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
  el('input-wybor-skan').value = ''; // czyste pole; tryb 'szukaj' wypelni je z powrotem zapytaniem
  prefillWyszukiwaniaStale = false;
}

function obsluzArtykul(dane) {
  const artykul = { artykul_gt_id: dane.artykul_gt_id, artykul_symbol: dane.artykul_symbol, artykul_nazwa: dane.artykul_nazwa, stany_gt: dane.stany_gt, lokalizacja_gt: dane.lokalizacja_gt, zgodnosc: dane.zgodnosc };

  // czy towar ma stan w magazynie zewnetrznym (MAG/LS) - wtedy ZAWSZE pokazujemy
  // rozklad (zeby zewnetrzny byl osiagalny jako zrodlo przyjecia), nawet gdy 0/1 lok WMS.
  const maStanZewn = magazynyLista.some((m) => m.typ === 'zewnetrzny' && (dane.stany_gt?.[m.kod]?.ilosc ?? 0) > 0);

  if (dane.lokalizacje.length === 0 && !maStanZewn) {
    // produkt ma stan w GT, ale nie ma jeszcze zadnej lokalizacji w WMS - przypisz pierwsza
    stan.artykul = artykul;
    stan.zrodlo = null;
    stan.iloscSugestia = dane.deficyt_k4g > 0 ? dane.deficyt_k4g : null;
    stan.celMagazynNowejLokalizacji = null;
    przejdzDoCelu();
    return;
  }

  if (dane.lokalizacje.length === 1 && !(dane.deficyt_k4g > 0) && !maStanZewn) {
    stan.artykul = artykul;
    stan.zrodlo = dane.lokalizacje[0];
    stan.iloscSugestia = null;
    stan.celMagazynNowejLokalizacji = null;
    przejdzDoCelu();
    return;
  }

  // 2+ lokalizacje, albo 1 lokalizacja, ale w K4gora wciaz brakuje czesci ilosci
  // w WMS (deficyt_k4g) - pokaz rozklad zrodel (mobilny blizniak desktopowego
  // okna rozkladu): wiersz per lokalizacja + wiersz "BRAK LOKALIZACJI" gdy deficyt.
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

  // rezerwacja jest na poziomie magazynu - pokazujemy ja raz, przy pierwszym
  // wierszu danego magazynu (jak w rozkladzie desktopu).
  const rezPokazana = {};
  opcjeWyboru = dane.lokalizacje.map((lok) => {
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

  // Nieprzypisany stan WMS per magazyn (GT - suma lokalizacji WMS) -> wiersz "BRAK
  // LOKALIZACJI" do przypisania. K4G: zawsze gdy deficyt (1 SKU = N lokalizacji - mozna
  // dolozyc kolejna). K4: tylko gdy NIE ma jeszcze zadnej lokalizacji K4 (1 SKU = 1
  // lokalizacja; gdy juz jest, deficyt to rozjazd - nie tworzymy stad drugiej lokalizacji K4).
  for (const mag of magazynyLista.filter((m) => m.typ === 'wms').map((m) => m.kod)) {
    const gtStan = artykul.stany_gt?.[mag]?.ilosc ?? 0;
    const wmsLok = dane.lokalizacje.filter((l) => l.magazyn === mag);
    const niezlok = Math.max(gtStan - wmsLok.reduce((s, l) => s + l.ilosc, 0), 0);
    if (niezlok <= 0) continue;
    if (mag === 'K4' && wmsLok.length > 0) continue;
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

  const lacznyStan = sumaStanowGt(artykul.stany_gt);
  const rezRazem = sumaRezerwacji(artykul.stany_gt);
  el('wybor-podsumowanie').innerHTML = `<span>Łączny stan: <b>${lacznyStan} szt.</b></span>`
    + `<span class="podsumowanie-sep"></span>`
    + `<span>Rezerwacje: <b>${rezRazem}</b></span>`;
  el('wybor-podsumowanie').classList.remove('hidden');

  el('input-wybor-skan').placeholder = 'Skanuj kod lokalizacji';
  el('wybor-hint').textContent = ''; // bez etykiety/hintu - pole skanu mówi samo za siebie

  trybWyboru = 'wybor';
  renderujRozklad(opcjeWyboru, wybierzOpcje);
  pokazKrok('wybor');
  // preventScroll: skupiamy pole na skan, ale NIE przewijamy tresci - tytul i
  // podsumowanie maja zostac widoczne na gorze (lista i tak jest przewijalna).
  el('input-wybor-skan').focus({ preventScroll: true });
}

// renderuje liste pozycji rozkladu jako karty .lista-poz (mag-badge, kod, ilosc,
// rez, strzalka); wiersz z flaga `brak` dostaje wariant .brak + podpis "(nieprzypisano)"
// i opcjonalny plan "wg GT: ...".
function renderujRozklad(opcje, onWybierz) {
  const lista = el('lista-wyboru');
  lista.innerHTML = '';
  opcje.forEach((o) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lista-poz' + (o.brak ? ' brak' : '');
    const rez = o.rez > 0 ? `<span class="poz-rez">(${o.rez} rez.)</span>` : '';
    const glowna = o.brak
      ? `<span class="poz-kod">BRAK LOKALIZACJI</span><span class="poz-podpis">(nieprzypisano)</span>`
        + (o.plan ? `<span class="poz-plan">wg GT: ${o.plan}</span>` : '')
      : `<span class="poz-kod">${o.kod}</span>`
        + (o.podpis ? `<span class="poz-podpis">${o.podpis}</span>` : '');
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

// skrot stanow GT do podpisu karty: "Razem 58 · K4 28 · K4G 30" (magazyny z 0 pomijane)
function stanSkrotKarty(stanyGt) {
  const razem = sumaStanowGt(stanyGt);
  if (!razem) return 'brak stanu w GT';
  const perMag = Object.entries(stanyGt || {})
    .filter(([, w]) => w.ilosc)
    .map(([m, w]) => `${m} ${w.ilosc}${w.rezerwacja ? ` (rez ${w.rezerwacja})` : ''}`)
    .join(' · ');
  return `Razem ${razem} · ${perMag}`;
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
  stan.artykul = opcja.artykul;
  stan.zrodlo = opcja.zrodlo;
  stan.iloscSugestia = opcja.iloscSugestia ?? null;
  stan.celMagazynNowejLokalizacji = opcja.celMagazyn ?? null;
  przejdzDoCelu();
}

onScan(el('input-wybor-skan'), (kod) => {
  if (trybWyboru === 'szukaj') {
    wykonajSkan(kod);
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
    let opcjeMag = stan.celMagazynNowejLokalizacji
      ? [stan.celMagazynNowejLokalizacji]
      : wmsKody.filter((m) => (stany[m]?.ilosc ?? 0) > 0);
    if (opcjeMag.length === 0) opcjeMag = wmsKody; // brak stanu GT - pozwol wskazac recznie

    const select = el('select-cel-magazyn');
    select.innerHTML = opcjeMag.map((m) => {
      const ile = stany[m]?.ilosc ?? 0;
      const nazwa = magazynyMapa[m]?.nazwa ?? m;
      return `<option value="${m}">${nazwa}${ile ? ` — ${ile} szt.` : ''}</option>`;
    }).join('');

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
    el('input-cel').focus();
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
  el('input-zapas').focus();
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

  const ile = (mag === 'K4G' && stan.iloscSugestia != null)
    ? stan.iloscSugestia
    : (stan.artykul.stany_gt?.[mag]?.ilosc ?? 0);
  const inputIlosc = el('input-ilosc');
  inputIlosc.removeAttribute('max'); // backend kapuje do deficytu magazynu
  // K4 = 1 SKU = 1 lokalizacja -> cala ilosc, bez edycji (jak przy zmianie lokalizacji K4)
  inputIlosc.readOnly = (mag === 'K4');
  inputIlosc.value = ile > 0 ? String(ile) : '';

  el('input-cel').value = '';
  el('input-cel').placeholder = `Skanuj lokalizację (${magazynyMapa[mag]?.nazwa ?? mag})`;
  // podpowiedz "wg GT" - gdzie GT trzyma lokalizacje tego magazynu (tw_Pole1/tw_Pole8) + regula K4
  const gtLok = gtLokDlaMagazynu(mag);
  const regulaK4 = mag === 'K4' ? 'K4: 1 SKU = 1 lokalizacja — cała ilość' : '';
  el('cel-lokalizacja-hint').textContent = [gtLok && `wg GT: ${gtLok}`, regulaK4].filter(Boolean).join(' · ');
  // Zapas K4 dostepny tez przy przypisaniu do K4 (po LOK lokalizacja K4 istnieje, k4-zapas zadziala)
  ustawZapasUI(mag === 'K4');
  aktualizujPozostanie();   // brak zrodla -> ukryje sie
  aktualizujAkcjeLabel();
  el('input-cel').focus();
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
    span.classList.add('hidden');
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
    // Przypisanie (brak zrodla): podpowiedz pelna nieprzypisana ilosc W MAGAZYNIE
    // SKANOWANEJ lokalizacji - NIE mieszac magazynow. K4G: deficyt (iloscSugestia dotyczy
    // K4gora); K4: caly stan GT (WMS=0, bo 1 SKU = 1 lokalizacja). K4 -> ilosc zablokowana.
    if (!stan.zrodlo) {
      const mag = dane.magazyn;
      const pelny = (mag === 'K4G' && stan.iloscSugestia != null)
        ? stan.iloscSugestia
        : (stan.artykul.stany_gt?.[mag]?.ilosc ?? null);
      el('input-ilosc').readOnly = (mag === 'K4');
      if (pelny != null && pelny > 0) {
        el('input-ilosc').value = String(pelny);
        aktualizujPozostanie();
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
  el('input-cel').focus();
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
      el('input-cel').focus();
      return;
    }
    el('input-cel').value = '';
    const ok = await przetworzLokalizacjeCelu(wpisany);
    if (!ok) {
      if (!kodDoUtworzenia) el('input-cel').focus();
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
  if (!stan.zrodlo) {
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
  let tekst = podsumowanie();
  if (dane && dane.status && dane.status !== 'ok') tekst += ' · GT: oczekuje';

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

  zrobione.unshift(tekst); // #5: dopisz do listy zrobionych (widoczna po powrocie na start)
  pokazSukces(tekst);
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

function pokazSukces(tekst) {
  el('sukces-tekst').textContent = tekst;
  el('sukces-overlay').classList.remove('hidden');
  beep();
}

// ekran sukcesu znika po dotknieciu i resetuje kreator do nowego ruchu
el('sukces-overlay').addEventListener('click', () => {
  el('sukces-overlay').classList.add('hidden');
  reset();
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
function pokazWidok(nazwa) {
  el('widok-menu').classList.toggle('hidden', nazwa !== 'menu');
  el('widok-ruch').classList.toggle('hidden', nazwa !== 'ruch');
  const uzup = el('widok-uzupelnienia');
  if (uzup) uzup.classList.toggle('hidden', nazwa !== 'uzupelnienia');
  const hist = el('widok-historia');
  if (hist) hist.classList.toggle('hidden', nazwa !== 'historia');
  if (nazwa === 'ruch') { zrobione = []; reset(); } // #5: swieze wejscie czysci liste zrobionych
  if (nazwa === 'uzupelnienia' && window.uzupOtworz) window.uzupOtworz();
  if (nazwa === 'historia' && window.historiaOtworz) window.historiaOtworz();
}
window.pokazWidok = pokazWidok;
el('btn-go-ruch').addEventListener('click', () => {
  pokazWidok('ruch');
  history.pushState({ v: 'ruch' }, '');
});
el('btn-pelny-ekran').addEventListener('click', () => {
  if (window.przelaczPelnyEkran) window.przelaczPelnyEkran();
});
// systemowy/przegladarkowy Back -> wroc do menu (nie wychodz z apki)
window.addEventListener('popstate', () => pokazWidok('menu'));

(async () => { await initMagazyny(); })();
pokazWidok('menu');
