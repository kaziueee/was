const el = (id) => document.getElementById(id);

const stan = {
  artykul: null,   // {artykul_gt_id, artykul_symbol, artykul_nazwa}
  zrodlo: null,    // {lokalizacja_id, kod, magazyn, ilosc} albo null - produkt bez lokalizacji w WMS
  cel: null,       // {typ:'wms', id, kod, magazyn} albo {typ:'zew', magazyn, nazwa}
  iloscSugestia: null, // podpowiedz ilosci przy braku zrodla (np. deficyt K4gora)
  celMagazynNowejLokalizacji: null, // magazyn wymagany dla nowej lokalizacji przy braku zrodla
                                     // (np. 'K4G' z opcji "+ Nowa lokalizacja K4G") - gdy null,
                                     // magazyn jest zgadywany na podstawie stanow GT
};

// krok 3 - kod lokalizacji oczekujacy na potwierdzenie utworzenia (gdy skan nie pasuje do zadnej istniejacej)
let kodDoUtworzenia = null;

// krok 2 - co aktualnie wybieramy z listy
let opcjeWyboru = []; // [{klucz, artykul, zrodlo, etykieta, ilosc}]
// krok 2, tryb 'szukaj' - ostatnia lista artykulow z wyszukiwania po nazwie (do ponownego
// renderowania po zmianie checkboxa "Ukryj produkty bez stanu")
let ostatniaListaArtykulow = null;
// tryb obslugi skanu/wyboru w kroku 2:
// 'wybor' - dopasuj zeskanowany kod do opcjeWyboru po kluczu (lokalizacja/SKU)
// 'szukaj' - kazdy skan/wpis przechodzi ponownie przez wykonajSkan (lista artykulow z wyszukiwania po nazwie)
let trybWyboru = 'wybor';

// lista magazynow (z /api/magazyny), do wyboru "Do" w kroku 3
let magazynyLista = [];
const magazynyMapa = {}; // kod -> {kod, nazwa, typ}

async function initMagazyny() {
  const res = await fetch('/api/magazyny');
  magazynyLista = await res.json();
  magazynyLista.forEach((m) => { magazynyMapa[m.kod] = m; });
}

// --- operator (zapamietany w localStorage) ---
const inputOperator = el('input-operator');
inputOperator.value = localStorage.getItem('wms_operator') || '';
inputOperator.addEventListener('change', () => {
  localStorage.setItem('wms_operator', inputOperator.value.trim());
});

// --- komunikaty ---
const komunikat = el('komunikat');
function pokazKomunikat(tekst, typ) {
  komunikat.textContent = tekst;
  komunikat.className = `komunikat ${typ}`;
}
function ukryjKomunikat() {
  komunikat.className = 'komunikat hidden';
}

// --- pomocnik: obsluga skanu/Enter na polu tekstowym ---
function onScan(input, callback) {
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const wartosc = input.value.trim().toUpperCase();
    input.value = '';
    if (!wartosc) return;
    callback(wartosc);
  });
}

// --- kroki ---
const kroki = {
  start: el('krok-start'),
  wybor: el('krok-wybor'),
  cel: el('krok-cel'),
};
const btnReset = el('btn-reset');

function pokazKrok(nazwa) {
  for (const [klucz, sekcja] of Object.entries(kroki)) {
    sekcja.classList.toggle('hidden', klucz !== nazwa);
  }
  btnReset.classList.toggle('hidden', nazwa === 'start');
}

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
  el('lista-wyboru').innerHTML = '';
  el('checkbox-ukryj-zero-wrap').classList.add('hidden');
  el('checkbox-ukryj-zero').checked = false;

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
    const ilosc = opcja.ilosc !== undefined ? `<span class="ilosc">${opcja.ilosc} szt.</span>` : '';
    const podetykieta = opcja.podetykieta ? `<span class="stany-magazynowe">${opcja.podetykieta}</span>` : '';
    const podetykieta2 = opcja.podetykieta2 ? `<span class="stany-magazynowe">${opcja.podetykieta2}</span>` : '';
    btn.innerHTML = `<span class="etykieta-glowna"><span>${opcja.etykieta}</span>${podetykieta}${podetykieta2}</span>${ilosc}`;
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

// --- krok 3: ilosc + magazyn i lokalizacja docelowa ---
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
    // produkt nie ma jeszcze lokalizacji w WMS (lub w K4gora wciaz brakuje czesci
    // ilosci) - przypisujemy (kolejna) lokalizacje, bez przesuniecia/MM
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
    pokazKrok('cel');
    el('input-cel').focus();
    return;
  }

  el('cel-magazyn-pole').classList.remove('hidden');
  inputIlosc.max = stan.zrodlo.ilosc;
  inputIlosc.value = stan.zrodlo.ilosc;

  const opcjeCel = magazynyLista.filter((m) => m.kod !== stan.zrodlo.magazyn);
  const select = el('select-cel-magazyn');
  select.innerHTML = opcjeCel.map((m) => `<option value="${m.kod}">${m.nazwa}</option>`).join('');

  const zapamietany = localStorage.getItem('wms_cel_magazyn');
  select.value = opcjeCel.some((m) => m.kod === zapamietany) ? zapamietany : opcjeCel[0].kod;

  pokazKrok('cel');
  aktualizujKrokCel();
}

// po wybraniu focus albo na ilosci (lokalizacja juz znana), albo na skanie lokalizacji
function skupSieNaIlosciLubLokalizacji() {
  if (stan.cel) {
    el('input-ilosc').focus();
    el('input-ilosc').select();
  } else {
    el('input-cel').focus();
  }
}

// odpowiada na wybor magazynu docelowego: dla K4 podpowiada stale miejsce SKU (jesli istnieje)
async function aktualizujKrokCel() {
  ukryjKomunikat();
  ukryjPotwierdzenie();
  const wybrany = magazynyMapa[el('select-cel-magazyn').value];
  localStorage.setItem('wms_cel_magazyn', wybrany.kod);

  if (wybrany.typ === 'zewnetrzny') {
    el('cel-lokalizacja-pole').classList.add('hidden');
    el('input-cel').value = '';
    el('cel-lokalizacja-hint').textContent = '';
    stan.cel = { typ: 'zew', magazyn: wybrany.kod, nazwa: wybrany.nazwa };
    skupSieNaIlosciLubLokalizacji();
    return;
  }

  el('cel-lokalizacja-pole').classList.remove('hidden');
  el('input-cel').value = '';
  el('input-cel').placeholder = `Skanuj lokalizację docelową (${wybrany.nazwa})`;
  el('cel-lokalizacja-hint').textContent = '';
  stan.cel = null;

  if (wybrany.kod === 'K4') {
    try {
      const res = await fetch(`/api/lokalizacje/k4-dom/${encodeURIComponent(stan.artykul.artykul_gt_id)}`);
      const dane = await res.json();
      // jesli uzytkownik zmienil wybor magazynu w trakcie zapytania - pomin wynik
      if (el('select-cel-magazyn').value !== 'K4') return;
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

el('select-cel-magazyn').addEventListener('change', () => {
  aktualizujKrokCel();
});

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
      const docelowyMagazyn = el('select-cel-magazyn').value;
      if (dane.magazyn !== docelowyMagazyn) {
        const oczekiwany = magazynyMapa[docelowyMagazyn]?.nazwa || docelowyMagazyn;
        const rzeczywisty = magazynyMapa[dane.magazyn]?.nazwa || dane.magazyn;
        pokazKomunikat(`Kod "${dane.kod}" jest juz uzyty w magazynie ${rzeczywisty} (kody lokalizacji sa unikalne globalnie). Wybierz inny kod dla magazynu ${oczekiwany}.`, 'blad');
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
    return true;
  } catch (err) {
    pokazKomunikat('Blad polaczenia z serwerem', 'blad');
    return false;
  }
}

onScan(el('input-cel'), async (kod) => {
  const ok = await przetworzLokalizacjeCelu(kod);
  if (ok) {
    el('input-ilosc').focus();
    el('input-ilosc').select();
  }
});

// --- potwierdzenie utworzenia nieznanej lokalizacji docelowej ---
function pokazPotwierdzenieUtworzenia(kod) {
  kodDoUtworzenia = kod;
  const magazynKod = stan.zrodlo
    ? el('select-cel-magazyn').value
    : (stan.celMagazynNowejLokalizacji ?? magazynDlaNowejLokalizacji(stan.artykul.stany_gt));
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
  const magazyn = stan.zrodlo
    ? el('select-cel-magazyn').value
    : (stan.celMagazynNowejLokalizacji ?? magazynDlaNowejLokalizacji(stan.artykul.stany_gt));
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
    el('input-ilosc').focus();
    el('input-ilosc').select();
  } catch (err) {
    pokazKomunikat('Blad polaczenia z serwerem', 'blad');
  }
});

el('btn-cel-utworz-nie').addEventListener('click', () => {
  ukryjPotwierdzenie();
  el('input-cel').value = '';
  el('input-cel').focus();
});

// --- zatwierdzenie ruchu ---
async function zatwierdzMM() {
  if (!stan.cel) {
    const wpisany = el('input-cel').value.trim().toUpperCase();
    if (!wpisany) {
      pokazKomunikat('Zeskanuj lokalizację docelową', 'blad');
      el('input-cel').focus();
      return;
    }
    // wpisano kod, ale nie potwierdzono Enterem - przetworz go tak, jakby zostal zeskanowany
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

  let url, body, komunikatSukces;
  if (stan.zrodlo) {
    if (ilo > stan.zrodlo.ilosc) {
      pokazKomunikat(`Ilosc przekracza dostepna (${stan.zrodlo.ilosc})`, 'blad');
      return;
    }
    url = '/api/ruchy/mm';
    body = {
      artykul_gt_id: stan.artykul.artykul_gt_id,
      lok_zrodlo_id: stan.zrodlo.lokalizacja_id,
      ilosc: ilo,
      operator: inputOperator.value.trim() || null,
    };
    if (stan.cel.typ === 'wms') body.lok_cel_id = stan.cel.id;
    else body.mag_cel_zewnetrzny = stan.cel.magazyn;
    komunikatSukces = (dane) => `MM #${dane.id} zapisane (status: ${dane.status})`;
  } else {
    // produkt nie mial jeszcze lokalizacji w WMS - przypisanie pierwszej, bez przesuniecia/MM
    url = '/api/ruchy/lok';
    body = {
      artykul_gt_id: stan.artykul.artykul_gt_id,
      lok_zrodlo_id: null,
      lok_cel_id: stan.cel.id,
      artykul_symbol: stan.artykul.artykul_symbol,
      artykul_nazwa: stan.artykul.artykul_nazwa,
      ilosc: ilo,
      operator: inputOperator.value.trim() || null,
    };
    komunikatSukces = () => `Zapisano lokalizację: ${stan.cel.kod}`;
  }

  ukryjKomunikat();
  const { ok, dane } = await wyslijRuch(url, body);
  if (!ok) {
    pokazKomunikat(dane.blad || 'Blad zapisu ruchu', 'blad');
    return;
  }
  pokazKomunikat(komunikatSukces(dane), 'ok');
  setTimeout(reset, 1500);
}

el('btn-zatwierdz').addEventListener('click', zatwierdzMM);
el('input-ilosc').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    zatwierdzMM();
  }
});

(async () => {
  await initMagazyny();
  reset();
})();
