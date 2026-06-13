const el = (id) => document.getElementById(id);

const stan = {
  inwentaryzacjaId: null,
  magazyn: null,
  lokalizacja: null,    // {id, kod, magazyn} - aktualnie skanowana lokalizacja
  pozycje: [],          // pozycje_inwentaryzacji dla aktualnej lokalizacji
  pozycjaAktywna: null, // pozycja w trakcie wprowadzania ilosci (krok 4)
};

// ostatni raport roznic (do potwierdzenia zamkniecia spisu)
let ostatniRaport = null;

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
  magazyn: el('krok-magazyn'),
  lokalizacja: el('krok-lokalizacja'),
  pozycje: el('krok-pozycje'),
  ilosc: el('krok-ilosc'),
  raport: el('krok-raport'),
};
const btnRaport = el('btn-raport');
const btnReset = el('btn-reset');

function pokazKrok(nazwa) {
  for (const [klucz, sekcja] of Object.entries(kroki)) {
    sekcja.classList.toggle('hidden', klucz !== nazwa);
  }
  btnRaport.classList.toggle('hidden', nazwa !== 'lokalizacja' && nazwa !== 'pozycje');
  btnReset.classList.toggle('hidden', nazwa === 'magazyn');
}

// --- krok 1: wybor magazynu (K4 / K4gora) ---
async function pokazWyborMagazynu() {
  ukryjKomunikat();
  stan.inwentaryzacjaId = null;
  stan.magazyn = null;
  stan.lokalizacja = null;
  stan.pozycje = [];
  stan.pozycjaAktywna = null;
  ostatniRaport = null;

  const lista = el('magazyny-lista');
  lista.innerHTML = '<p class="hint">Wczytywanie...</p>';
  pokazKrok('magazyn');

  try {
    const res = await fetch('/api/magazyny?typ=wms');
    const magazyny = await res.json();

    const zOtwartymi = await Promise.all(magazyny.map(async (m) => {
      const r = await fetch(`/api/inwentaryzacja/otwarta/${m.kod}`);
      const otwarta = await r.json();
      return { ...m, otwarta };
    }));

    lista.innerHTML = '';
    zOtwartymi.forEach((m) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      const podetykieta = m.otwarta
        ? `<span class="stany-magazynowe">Wznów spis #${m.otwarta.id} (otwarty)</span>`
        : '';
      btn.innerHTML = `<span class="etykieta-glowna"><span>${m.nazwa}</span>${podetykieta}</span>`;
      btn.addEventListener('click', () => rozpocznijSpis(m.kod, m.otwarta));
      lista.appendChild(btn);
    });
  } catch (err) {
    lista.innerHTML = '';
    pokazKomunikat('Blad polaczenia z serwerem', 'blad');
  }
}

async function rozpocznijSpis(magazyn, otwarta) {
  ukryjKomunikat();
  try {
    let inwentaryzacja = otwarta;
    if (!inwentaryzacja) {
      const res = await fetch('/api/inwentaryzacja', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ magazyn, operator: inputOperator.value.trim() || null }),
      });
      const dane = await res.json();
      if (!res.ok) {
        pokazKomunikat(dane.blad || 'Nie udalo sie otworzyc spisu', 'blad');
        return;
      }
      inwentaryzacja = dane;
    }
    stan.inwentaryzacjaId = inwentaryzacja.id;
    stan.magazyn = magazyn;
    pokazKrokLokalizacja();
  } catch (err) {
    pokazKomunikat('Blad polaczenia z serwerem', 'blad');
  }
}

// --- krok 2: skan lokalizacji ---
async function pokazKrokLokalizacja() {
  ukryjKomunikat();
  stan.lokalizacja = null;
  stan.pozycje = [];
  await odswiezSpisInfo();
  el('input-lokalizacja').value = '';
  pokazKrok('lokalizacja');
  el('input-lokalizacja').focus();
}

async function odswiezSpisInfo() {
  try {
    const res = await fetch(`/api/inwentaryzacja/${stan.inwentaryzacjaId}`);
    const dane = await res.json();
    if (!res.ok) return;
    const s = dane.statystyki;
    const roznice = s.z_roznica > 0 ? `, różnice: ${s.z_roznica}` : '';
    el('spis-info').innerHTML = `<strong>Spis ${stan.magazyn} #${dane.id}</strong><span>Zliczono ${s.zliczone} / ${s.pozycje_total}${roznice}</span>`;
  } catch (err) {
    // brak danych - nie blokuje skanowania
  }
}

async function wczytajLokalizacje(kod) {
  ukryjKomunikat();
  try {
    const res = await fetch(`/api/inwentaryzacja/${stan.inwentaryzacjaId}/lokalizacja/${encodeURIComponent(kod)}`);
    const dane = await res.json();
    if (!res.ok) {
      pokazKomunikat(dane.blad || 'Lokalizacja nie znaleziona', 'blad');
      return;
    }
    stan.lokalizacja = dane.lokalizacja;
    stan.pozycje = dane.pozycje;
    pokazKrokPozycje();
  } catch (err) {
    pokazKomunikat('Blad polaczenia z serwerem', 'blad');
  }
}

onScan(el('input-lokalizacja'), wczytajLokalizacje);

// --- krok 3: pozycje na lokalizacji + skan SKU ---
function pokazKrokPozycje() {
  ukryjKomunikat();
  el('pozycje-lokalizacja-kod').textContent = `${stan.lokalizacja.kod} (${stan.lokalizacja.magazyn})`;
  renderujPozycje();
  el('input-sku').value = '';
  pokazKrok('pozycje');
  el('input-sku').focus();
}

function renderujPozycje() {
  const lista = el('pozycje-lista');
  lista.innerHTML = '';

  if (stan.pozycje.length === 0) {
    lista.innerHTML = '<p class="hint">Brak pozycji wg spisu na tej lokalizacji — zeskanuj SKU znalezionego towaru.</p>';
    return;
  }

  stan.pozycje.forEach((p) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    const policzono = p.ilosc_liczona !== null
      ? `<span class="ilosc">${p.ilosc_liczona} szt.</span>`
      : '<span class="stany-magazynowe">do policzenia</span>';
    const roznicaTekst = p.ilosc_liczona !== null && Number(p.roznica) !== 0
      ? `<span class="stany-magazynowe">różnica: ${Number(p.roznica) > 0 ? '+' : ''}${p.roznica}</span>`
      : '';
    btn.innerHTML = `<span class="etykieta-glowna"><span>${p.artykul_symbol}</span>`
      + `<span class="stany-magazynowe">wg spisu: ${p.ilosc_gt} szt.</span>${roznicaTekst}</span>${policzono}`;
    btn.addEventListener('click', () => otworzIlosc(p));
    lista.appendChild(btn);
  });
}

el('btn-zmien-lokalizacje').addEventListener('click', pokazKrokLokalizacja);

// skan SKU/EAN/nazwy/lokalizacji w kroku 3 - reuzywa /api/lokalizacje/skan/:kod
async function wykonajSkanSpis(kod) {
  ukryjKomunikat();
  try {
    const res = await fetch(`/api/lokalizacje/skan/${encodeURIComponent(kod)}`);
    const dane = await res.json();
    if (!res.ok) {
      pokazKomunikat(dane.blad || 'Nie znaleziono', 'blad');
      return;
    }
    if (dane.typ === 'lokalizacja') {
      wczytajLokalizacje(dane.lokalizacja.kod);
      return;
    }
    if (dane.typ === 'lista_artykulow') {
      pokazListaArtykulowSpis(dane.artykuly, dane.obciete);
      return;
    }
    obsluzArtykulSpis(dane);
  } catch (err) {
    pokazKomunikat('Blad polaczenia z serwerem', 'blad');
  }
}

onScan(el('input-sku'), wykonajSkanSpis);

function pokazListaArtykulowSpis(artykuly, obciete) {
  renderujListeProduktow(el('pozycje-lista'), artykuly, null, (a) => wykonajSkanSpis(a.artykul_symbol));
  pokazKomunikat(
    obciete ? `Pokazano pierwsze ${artykuly.length} wyników — zawęź wyszukiwanie` : `Znaleziono ${liczbaArtykulow(artykuly.length)} — wybierz`,
    'info'
  );
}

// zeskanowano SKU/EAN/nazwe artykulu -> dopasuj do pozycji snapshotu tej
// lokalizacji albo otworz nowa pozycje (towar znaleziony tam, gdzie wg WMS
// nic nie powinno byc)
function obsluzArtykulSpis(dane) {
  const istniejaca = stan.pozycje.find((p) => String(p.artykul_gt_id) === String(dane.artykul_gt_id));
  if (istniejaca) {
    otworzIlosc(istniejaca, dane);
    return;
  }
  otworzIlosc({
    lokalizacja_id: stan.lokalizacja.id,
    artykul_gt_id: dane.artykul_gt_id,
    artykul_symbol: dane.artykul_symbol,
    ilosc_gt: 0,
    ilosc_liczona: null,
    roznica: null,
  }, dane);
}

// --- krok 4: ilosc ---
function otworzIlosc(pozycja, danePomocnicze) {
  ukryjKomunikat();
  stan.pozycjaAktywna = pozycja;

  const liczonaWczesniej = pozycja.ilosc_liczona !== null && pozycja.ilosc_liczona !== undefined;
  const nazwaLinia = danePomocnicze?.artykul_nazwa ? `<br>${danePomocnicze.artykul_nazwa}` : '';
  const stanyLinia = danePomocnicze?.stany_gt ? `<br>${formatStanyGt(danePomocnicze.stany_gt)}` : '';
  const wczesniejszaLinia = liczonaWczesniej ? `<br>Wcześniej wpisano: ${pozycja.ilosc_liczona} szt.` : '';
  el('ilosc-info').innerHTML = `<strong>${pozycja.artykul_symbol}</strong>`
    + `<span>Wg spisu: ${pozycja.ilosc_gt} szt.${wczesniejszaLinia}${nazwaLinia}${stanyLinia}</span>`;

  const input = el('input-ilosc-spis');
  input.value = liczonaWczesniej ? String(pozycja.ilosc_liczona) : String(pozycja.ilosc_gt);

  pokazKrok('ilosc');
  input.focus();
  input.select();
}

async function zapiszIlosc() {
  const ilo = Number(el('input-ilosc-spis').value);
  if (!Number.isFinite(ilo) || ilo < 0) {
    pokazKomunikat('Podaj poprawna ilosc >= 0', 'blad');
    return;
  }

  const p = stan.pozycjaAktywna;
  const body = {
    lokalizacja_id: stan.lokalizacja.id,
    artykul_gt_id: p.artykul_gt_id,
    ilosc: ilo,
    operator: inputOperator.value.trim() || null,
  };
  if (p.id === undefined) body.artykul_symbol = p.artykul_symbol;

  ukryjKomunikat();
  const btn = el('btn-zapisz-ilosc');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/inwentaryzacja/${stan.inwentaryzacjaId}/skan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const dane = await res.json();
    if (!res.ok) {
      pokazKomunikat(dane.blad || 'Blad zapisu', 'blad');
      return;
    }
    const idx = stan.pozycje.findIndex((x) => String(x.artykul_gt_id) === String(dane.artykul_gt_id));
    if (idx >= 0) stan.pozycje[idx] = dane;
    else stan.pozycje.push(dane);

    stan.pozycjaAktywna = null;
    pokazKrokPozycje();
  } catch (err) {
    pokazKomunikat('Blad polaczenia z serwerem', 'blad');
  } finally {
    btn.disabled = false;
  }
}

el('btn-zapisz-ilosc').addEventListener('click', zapiszIlosc);
el('input-ilosc-spis').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    zapiszIlosc();
  }
});
el('btn-anuluj-ilosc').addEventListener('click', () => {
  stan.pozycjaAktywna = null;
  pokazKrokPozycje();
});

// --- raport roznic + zamkniecie spisu ---
async function pokazRaport() {
  ukryjKomunikat();
  ukryjPotwierdzenieRaportu();
  try {
    const res = await fetch(`/api/inwentaryzacja/${stan.inwentaryzacjaId}/raport`);
    const dane = await res.json();
    if (!res.ok) {
      pokazKomunikat(dane.blad || 'Blad wczytywania raportu', 'blad');
      return;
    }
    renderujRaport(dane);
    pokazKrok('raport');
  } catch (err) {
    pokazKomunikat('Blad polaczenia z serwerem', 'blad');
  }
}

function renderujRaport(dane) {
  ostatniRaport = dane;
  const { nadwyzki, niedobory, nieskanowane } = dane;

  el('raport-podsumowanie').innerHTML = `<strong>Spis #${dane.inwentaryzacja.id} — ${dane.inwentaryzacja.magazyn}</strong>`
    + `<span>Nadwyżki: ${nadwyzki.length} · Niedobory: ${niedobory.length} · Nieskanowane: ${nieskanowane.liczba}</span>`;

  const lista = el('raport-lista');
  lista.innerHTML = '';

  const sekcja = (tytul, pozycje) => {
    if (pozycje.length === 0) return;
    const naglowek = document.createElement('h3');
    naglowek.textContent = tytul;
    lista.appendChild(naglowek);
    pozycje.forEach((p) => {
      const wiersz = document.createElement('div');
      wiersz.className = 'artykul-info';
      const znak = Number(p.roznica) > 0 ? '+' : '';
      wiersz.innerHTML = `<strong>${p.lokalizacja_kod} — ${p.artykul_symbol}</strong>`
        + `<span>wg spisu: ${p.ilosc_gt}, policzono: ${p.ilosc_liczona}, różnica: ${znak}${p.roznica}</span>`;
      lista.appendChild(wiersz);
    });
  };

  sekcja('Nadwyżki', nadwyzki);
  sekcja('Niedobory', niedobory);

  if (nadwyzki.length === 0 && niedobory.length === 0) {
    lista.innerHTML = '<p class="hint">Brak różnic.</p>';
  }

  if (nieskanowane.liczba > 0) {
    const info = document.createElement('p');
    info.className = 'hint';
    info.textContent = `${nieskanowane.liczba} pozycji nie zostało zliczonych (łącznie wg spisu: ${nieskanowane.suma_ilosc_gt} szt.) — przy zamknięciu zostaną potraktowane jako 0.`;
    lista.appendChild(info);
  }
}

btnRaport.addEventListener('click', pokazRaport);

el('btn-powrot-raport').addEventListener('click', () => {
  ukryjPotwierdzenieRaportu();
  if (stan.lokalizacja) pokazKrokPozycje();
  else pokazKrokLokalizacja();
});

function ukryjPotwierdzenieRaportu() {
  el('raport-potwierdzenie').classList.add('hidden');
}

el('btn-zamknij-spis').addEventListener('click', () => {
  if (!ostatniRaport) return;
  const tekst = ostatniRaport.nieskanowane.liczba > 0
    ? `${ostatniRaport.nieskanowane.liczba} pozycji nie zostalo zliczonych - zostana potraktowane jako 0 szt. Zamknąć spis i wystawić dokumenty PW/RW w GT?`
    : 'Zamknąć spis i wystawić dokumenty PW/RW w GT?';
  el('raport-potwierdzenie-tekst').textContent = tekst;
  el('raport-potwierdzenie').classList.remove('hidden');
});

el('btn-raport-zamknij-nie').addEventListener('click', ukryjPotwierdzenieRaportu);

el('btn-raport-zamknij-tak').addEventListener('click', async () => {
  if (!ostatniRaport) return;
  ukryjKomunikat();
  const btn = el('btn-raport-zamknij-tak');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/inwentaryzacja/${stan.inwentaryzacjaId}/zamknij`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operator: inputOperator.value.trim() || null,
        zeruj_niespisane: ostatniRaport.nieskanowane.liczba > 0,
      }),
    });
    const dane = await res.json();
    if (!res.ok) {
      pokazKomunikat(dane.blad || 'Blad zamykania spisu', 'blad');
      ukryjPotwierdzenieRaportu();
      return;
    }
    const dokumenty = [];
    if (dane.dokumenty?.pw) dokumenty.push(`PW ${dane.dokumenty.pw}`);
    if (dane.dokumenty?.rw) dokumenty.push(`RW ${dane.dokumenty.rw}`);
    const tekst = dokumenty.length > 0 ? `Spis zamknięty. Dokumenty: ${dokumenty.join(', ')}` : 'Spis zamknięty (bez różnic).';
    ukryjPotwierdzenieRaportu();
    ostatniRaport = null;
    pokazKomunikat(tekst, 'ok');
    setTimeout(pokazWyborMagazynu, 2000);
  } catch (err) {
    pokazKomunikat('Blad polaczenia z serwerem', 'blad');
  } finally {
    btn.disabled = false;
  }
});

btnReset.addEventListener('click', pokazWyborMagazynu);

pokazWyborMagazynu();
