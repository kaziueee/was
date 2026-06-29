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
};

// krok 3 - kod lokalizacji oczekujacy na potwierdzenie utworzenia (gdy skan nie pasuje do istniejacej)
let kodDoUtworzenia = null;

// krok 2 - co aktualnie wybieramy z listy
let opcjeWyboru = []; // [{klucz, artykul, zrodlo, etykieta, ilosc}]
// krok 2, tryb 'szukaj' - ostatnia lista artykulow z wyszukiwania po nazwie (do ponownego
// renderowania po zmianie checkboxa "Ukryj produkty bez stanu")
let ostatniaListaArtykulow = null;
// tryb obslugi skanu/wyboru w kroku 2:
// 'wybor' - dopasuj zeskanowany kod do opcjeWyboru po kluczu (lokalizacja/SKU)
// 'szukaj' - kazdy skan/wpis przechodzi ponownie przez wykonajSkan (lista z wyszukiwania po nazwie)
let trybWyboru = 'wybor';

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

  const kontekst = stan.zrodlo
    ? `<span class="chip chip-magazyn">${stan.zrodlo.magazyn}</span><span class="chip">Z: <b>${stan.zrodlo.kod}</b></span>`
    : '<span class="chip chip-uwaga">Brak lokalizacji w WMS</span>';

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
    reset(); // z listy wyboru -> czysty skan
  } else {
    // na kroku startowym: Wstecz wraca do widoku menu (bez przeladowania -> pelny ekran trzyma)
    history.back();
  }
}

btnWstecz.addEventListener('click', wstecz);

function reset() {
  stan.artykul = null;
  stan.zrodlo = null;
  stan.cel = null;
  stan.iloscSugestia = null;
  stan.celMagazynNowejLokalizacji = null;
  opcjeWyboru = [];
  ostatniaListaArtykulow = null;
  trybWyboru = 'wybor';

  el('input-start').value = '';
  el('input-wybor-skan').value = '';
  el('input-cel').value = '';
  el('input-ilosc').value = '';
  el('input-ilosc').readOnly = false;
  el('lista-wyboru').innerHTML = '';
  el('checkbox-ukryj-zero-wrap').classList.add('hidden');
  el('checkbox-ukryj-zero').checked = false;
  el('pozostanie').classList.add('hidden');

  ukryjKomunikat();
  ukryjPotwierdzenie();
  pokazKrok('start');
  el('input-start').focus();
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
}

function obsluzArtykul(dane) {
  const artykul = { artykul_gt_id: dane.artykul_gt_id, artykul_symbol: dane.artykul_symbol, artykul_nazwa: dane.artykul_nazwa, stany_gt: dane.stany_gt, lokalizacja_gt: dane.lokalizacja_gt, zgodnosc: dane.zgodnosc };

  if (dane.lokalizacje.length === 0) {
    // produkt ma stan w GT, ale nie ma jeszcze zadnej lokalizacji w WMS - przypisz pierwsza
    stan.artykul = artykul;
    stan.zrodlo = null;
    stan.iloscSugestia = dane.deficyt_k4g > 0 ? dane.deficyt_k4g : null;
    stan.celMagazynNowejLokalizacji = null;
    przejdzDoCelu();
    return;
  }

  if (dane.lokalizacje.length === 1 && !(dane.deficyt_k4g > 0)) {
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
    };
  });

  if (dane.deficyt_k4g > 0) {
    opcjeWyboru.push({
      klucz: '__NOWA_LOKALIZACJA__',
      artykul,
      zrodlo: null,
      iloscSugestia: dane.deficyt_k4g,
      celMagazyn: 'K4G',
      brak: true,
      mag: 'K4G',
      ilosc: dane.deficyt_k4g,
      plan: gtLokDlaMagazynu('K4G') || '', // sciaga "wg GT" gdzie dolozyc reszte
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
      : `<span class="poz-kod">${o.kod}</span>`;
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

  naglowekWyborHtml = '';
  przygotujKrokWybor();
  el('wybor-naglowek').classList.remove('hidden');
  el('wybor-naglowek').innerHTML = `<span>Znaleziono ${liczbaArtykulow(artykuly.length)} — wybierz</span>`;
  el('wybor-hint').textContent = '...lub zeskanuj SKU / EAN towaru';
  el('input-wybor-skan').placeholder = 'Skanuj SKU lub EAN';
  el('checkbox-ukryj-zero-wrap').classList.remove('hidden');

  trybWyboru = 'szukaj';
  renderujListaArtykulow();
  pokazKrok('wybor');
  el('input-wybor-skan').focus();

  if (obciete) {
    pokazKomunikat(`Pokazano pierwsze ${artykuly.length} wyników — zawęź wyszukiwanie`, 'info');
  }
}

function renderujListaArtykulow() {
  renderujListeProduktow(el('lista-wyboru'), ostatniaListaArtykulow, el('checkbox-ukryj-zero'), (a) => wykonajSkan(a.artykul_symbol));
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
function przejdzDoCelu() {
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
  el('cel-lokalizacja-hint').textContent = calaIlosc
    ? 'K4: 1 SKU = 1 lokalizacja — przenoszona jest cała ilość'
    : '';

  // K4 jako cel przesuniecia -> podpowiedz stalego miejsca SKU
  if (!zmiana && docelowy === 'K4') {
    try {
      const res = await fetch(`/api/lokalizacje/k4-dom/${encodeURIComponent(stan.artykul.artykul_gt_id)}`);
      const dane = await res.json();
      if (celMagazynKod() !== 'K4') return; // uzytkownik zmienil wybor w trakcie zapytania
      if (dane) {
        el('input-cel').value = dane.kod;
        el('cel-lokalizacja-hint').textContent = `Stałe miejsce w K4 (obecnie: ${dane.ilosc} szt.) — zeskanuj inną, by zmienić`;
        stan.cel = { typ: 'wms', id: dane.lokalizacja_id, kod: dane.kod, magazyn: 'K4' };
      } else {
        el('cel-lokalizacja-hint').textContent = 'Nowe miejsce w K4 — zeskanuj lokalizację';
      }
    } catch (err) {
      // brak podpowiedzi - magazynier skanuje recznie
    }
  }

  skupSieNaIlosciLubLokalizacji();
}

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
  inputIlosc.value = ile > 0 ? String(ile) : '';

  el('input-cel').value = '';
  el('input-cel').placeholder = `Skanuj lokalizację (${magazynyMapa[mag]?.nazwa ?? mag})`;
  // podpowiedz "wg GT" - gdzie GT trzyma lokalizacje tego magazynu (tw_Pole1/tw_Pole8) + regula K4
  const gtLok = gtLokDlaMagazynu(mag);
  const regulaK4 = mag === 'K4' ? 'K4: 1 SKU = 1 lokalizacja — cała ilość' : '';
  el('cel-lokalizacja-hint').textContent = [gtLok && `wg GT: ${gtLok}`, regulaK4].filter(Boolean).join(' · ');
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
  span.textContent = `Pozostanie w ${stan.zrodlo.kod}: ${poz} szt.`;
  span.classList.toggle('blad', poz < 0);
  span.classList.remove('hidden');
}

// etykieta glownej akcji opisuje skutek: PRZENIES / ZMIEN LOKALIZACJE / ZAPISZ
function aktualizujAkcjeLabel() {
  const btn = el('btn-zatwierdz');
  const ilo = Number(el('input-ilosc').value) || 0;
  if (!stan.zrodlo) {
    btn.textContent = `ZAPISZ ${ilo} SZT.`;
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

// sprawdza kod lokalizacji docelowej i ustawia stan.cel jesli pasuje;
// zwraca true gdy stan.cel zostal ustawiony, false gdy pokazano blad/dialog tworzenia
async function przetworzLokalizacjeCelu(kod) {
  ukryjKomunikat();
  ukryjPotwierdzenie();
  if (stan.zrodlo && kod.toUpperCase() === stan.zrodlo.kod.toUpperCase()) {
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
    // Przypisanie (brak zrodla): podpowiedz CALY stan do rozlozenia w tym magazynie.
    // K4G z deficytem -> deficyt_k4g; czyste przypisanie -> pelny stan GT magazynu (WMS=0).
    if (!stan.zrodlo) {
      const pelny = stan.celMagazynNowejLokalizacji != null
        ? stan.iloscSugestia
        : (stan.artykul.stany_gt?.[dane.magazyn]?.ilosc ?? null);
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

// --- zatwierdzenie ruchu (LOK albo MM, zaleznie od celu) ---
async function zatwierdz() {
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
polaSkanuBezKlawiatury(el('input-start'), el('input-wybor-skan'), el('input-cel'));

// --- router widokow (SPA: menu <-> ruch bez przeladowania, pelny ekran sie trzyma) ---
function pokazWidok(nazwa) {
  el('widok-menu').classList.toggle('hidden', nazwa !== 'menu');
  el('widok-ruch').classList.toggle('hidden', nazwa !== 'ruch');
  if (nazwa === 'ruch') reset();
}
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
