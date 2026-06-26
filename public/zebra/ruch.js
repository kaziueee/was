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

// --- kroki ---
const kroki = {
  start: el('krok-start'),
  wybor: el('krok-wybor'),
  cel: el('krok-cel'),
};
const btnReset = el('btn-reset');
const btnWstecz = el('btn-wstecz');

function pokazKrok(nazwa) {
  for (const [klucz, sekcja] of Object.entries(kroki)) {
    sekcja.classList.toggle('hidden', klucz !== nazwa);
  }
  btnReset.classList.toggle('hidden', nazwa === 'start');
  btnWstecz.classList.toggle('hidden', nazwa === 'start');
}

// krok o jeden wstecz w kreatorze (cel -> wybor/start, wybor -> start)
function wstecz() {
  ukryjKomunikat();
  ukryjPotwierdzenie();
  if (!kroki.cel.classList.contains('hidden')) {
    // z kroku "cel": wroc do listy wyboru jesli byla, inaczej do startu
    if (opcjeWyboru.length > 0 || ostatniaListaArtykulow) {
      pokazKrok('wybor');
      el('input-wybor-skan').focus();
    } else {
      pokazKrok('start');
      el('input-start').focus();
    }
  } else if (!kroki.wybor.classList.contains('hidden')) {
    el('input-start').value = '';
    pokazKrok('start');
    el('input-start').focus();
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

btnReset.addEventListener('click', reset);

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
    ...etykietyKartyProduktu(poz),
    statusBadge: statusZgodnosciBadge(poz),
    rez: sumaRezerwacji(poz.stany_gt),
    ilosc: poz.ilosc,
  }));

  el('wybor-naglowek').innerHTML = `<strong>${lokalizacja.kod}</strong><span>${lokalizacja.magazyn} — wybierz produkt do przeniesienia</span>`;
  el('wybor-hint').textContent = '...lub zeskanuj kod towaru';
  el('input-wybor-skan').placeholder = 'Skanuj SKU';
  el('checkbox-ukryj-zero-wrap').classList.add('hidden');

  trybWyboru = 'wybor';
  renderujWybor(opcjeWyboru, wybierzOpcje);
  pokazKrok('wybor');
  el('input-wybor-skan').focus();
}

// zeskanowano SKU lub EAN -> wybierz lokalizacje zrodlowa
function obsluzArtykul(dane) {
  const artykul = { artykul_gt_id: dane.artykul_gt_id, artykul_symbol: dane.artykul_symbol, artykul_nazwa: dane.artykul_nazwa, stany_gt: dane.stany_gt, lokalizacja_gt: dane.lokalizacja_gt };

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

  // 2+ lokalizacje, albo 1 lokalizacja, ale w K4gora wciaz brakuje czesci
  // ilosci w WMS (deficyt_k4g) - dodaj opcje "nowa lokalizacja K4gora" obok
  // istniejacych lokalizacji do przesuniecia
  opcjeWyboru = dane.lokalizacje.map((lok) => ({
    klucz: lok.kod,
    artykul,
    zrodlo: lok,
    iloscSugestia: null,
    etykieta: `${lok.kod} <span class="magazyn">${lok.magazyn}</span>`,
    ilosc: lok.ilosc,
  }));

  if (dane.deficyt_k4g > 0) {
    opcjeWyboru.push({
      klucz: '__NOWA_LOKALIZACJA__',
      artykul,
      zrodlo: null,
      iloscSugestia: dane.deficyt_k4g,
      celMagazyn: 'K4G',
      etykieta: '+ Nowa lokalizacja <span class="magazyn">K4G</span>',
      podetykieta: `${dane.deficyt_k4g} szt. bez przypisanej lokalizacji w K4gora`,
      ilosc: dane.deficyt_k4g,
    });
  }

  const { podetykieta, podetykieta2 } = etykietyKartyProduktu(dane);
  const naglowekAkcja = dane.deficyt_k4g > 0
    ? 'wybierz lokalizację źródłową lub dodaj nową (K4gora)'
    : 'wybierz lokalizację źródłową';
  el('wybor-naglowek').innerHTML = `<strong>${dane.artykul_symbol}</strong><span>${dane.artykul_nazwa} — ${naglowekAkcja}</span><span>${podetykieta}</span>${podetykieta2 ? `<span>${podetykieta2}</span>` : ''}`;
  el('wybor-hint').textContent = '...lub zeskanuj etykietę lokalizacji';
  el('input-wybor-skan').placeholder = 'Skanuj lokalizację';
  el('checkbox-ukryj-zero-wrap').classList.add('hidden');

  trybWyboru = 'wybor';
  renderujWybor(opcjeWyboru, wybierzOpcje);
  pokazKrok('wybor');
  el('input-wybor-skan').focus();
}

// znaleziono kilka artykulow po (czesci) nazwy -> wybierz konkretny artykul
function obsluzListaArtykulow(artykuly, obciete) {
  ostatniaListaArtykulow = artykuly;

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

  const stanyLinia = `<br>${formatStanyGt(stan.artykul.stany_gt)}`;
  const gtPodetykieta = formatLokalizacjaGt(stan.artykul.lokalizacja_gt);
  const gtLinia = gtPodetykieta ? `<br>${gtPodetykieta}` : '';
  const zrodloLinia = stan.zrodlo
    ? `<br>Z: ${stan.zrodlo.kod} (${stan.zrodlo.magazyn}, dostępne: ${stan.zrodlo.ilosc} szt.)`
    : stan.celMagazynNowejLokalizacji
      ? `<br>Brak w WMS — wskaż nową lokalizację w ${stan.celMagazynNowejLokalizacji}`
      : '<br>Brak lokalizacji w WMS — wskaż lokalizację (K4 lub K4gora)';
  el('cel-podsumowanie').innerHTML =
    `<strong>${stan.artykul.artykul_symbol}</strong><span>${stan.artykul.artykul_nazwa}${zrodloLinia}${stanyLinia}${gtLinia}</span>`;

  const inputIlosc = el('input-ilosc');

  if (!stan.zrodlo) {
    // przypisanie pierwszej/kolejnej lokalizacji w WMS (bez przesuniecia/MM) - brak wyboru magazynu
    inputIlosc.removeAttribute('max');
    inputIlosc.value = stan.iloscSugestia != null ? String(stan.iloscSugestia) : '';
    inputIlosc.readOnly = false;
    el('cel-magazyn-pole').classList.add('hidden');
    el('cel-lokalizacja-pole').classList.remove('hidden');
    el('input-cel').value = '';
    el('input-cel').placeholder = stan.celMagazynNowejLokalizacji
      ? `Skanuj lokalizację (${stan.celMagazynNowejLokalizacji})`
      : 'Skanuj lokalizację (K4 lub K4gora)';
    el('cel-lokalizacja-hint').textContent = '';
    aktualizujPozostanie();
    pokazKrok('cel');
    el('input-cel').focus();
    return;
  }

  // jest zrodlo - select celu: "Ta sama (zmiana lokalizacji)" + inne magazyny (MM)
  el('cel-magazyn-pole').classList.remove('hidden');
  const select = el('select-cel-magazyn');
  const inne = magazynyLista.filter((m) => m.kod !== stan.zrodlo.magazyn);
  const optSame = `<option value="${SAME}">Ta sama — zmiana lokalizacji (${stan.zrodlo.magazyn})</option>`;
  select.innerHTML = optSame + inne.map((m) => `<option value="${m.kod}">${m.nazwa}</option>`).join('');

  const zapamietany = localStorage.getItem('wms_cel');
  select.value = (zapamietany === SAME || inne.some((m) => m.kod === zapamietany)) ? zapamietany : SAME;

  pokazKrok('cel');
  aktualizujKrokCel();
}

// po wybraniu focus albo na ilosci (lokalizacja juz znana i edytowalna), albo na skanie lokalizacji
function skupSieNaIlosciLubLokalizacji() {
  if (stan.cel && !el('input-ilosc').readOnly) {
    el('input-ilosc').focus();
    el('input-ilosc').select();
  } else if (el('cel-lokalizacja-pole').classList.contains('hidden')) {
    el('input-ilosc').focus();
    el('input-ilosc').select();
  } else {
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

  localStorage.setItem('wms_cel', el('select-cel-magazyn').value);

  const inputIlosc = el('input-ilosc');
  const zmiana = czyZmiana();
  inputIlosc.max = stan.zrodlo.ilosc;
  // K4 + zmiana lokalizacji: 1 SKU = 1 lokalizacja -> zawsze cala ilosc
  const calaIlosc = zmiana && stan.zrodlo.magazyn === 'K4';
  inputIlosc.readOnly = calaIlosc;
  inputIlosc.value = stan.zrodlo.ilosc;
  aktualizujPozostanie();

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

el('select-cel-magazyn').addEventListener('change', aktualizujKrokCel);

// "pozostanie na lokalizacji" = stan zrodla - wpisana ilosc (czerwone gdy < 0); ukryte gdy brak zrodla
function aktualizujPozostanie() {
  const span = el('pozostanie');
  if (!stan.zrodlo) {
    span.classList.add('hidden');
    return;
  }
  const ile = Number(el('input-ilosc').value);
  const poz = stan.zrodlo.ilosc - (Number.isFinite(ile) ? ile : 0);
  span.textContent = `Na źródle: ${stan.zrodlo.ilosc} → pozostanie: ${poz}`;
  span.classList.toggle('pozostanie-blad', poz < 0);
  span.classList.remove('hidden');
}

el('input-ilosc').addEventListener('input', aktualizujPozostanie);

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
  if (ok && !el('input-ilosc').readOnly) {
    el('input-ilosc').focus();
    el('input-ilosc').select();
  }
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
    if (!el('input-ilosc').readOnly) {
      el('input-ilosc').focus();
      el('input-ilosc').select();
    }
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

(async () => {
  await initMagazyny();
  reset();
})();
