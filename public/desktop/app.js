'use strict';

function el(id) {
  return document.getElementById(id);
}

// --- komunikaty ---

let komunikatTimeout = null;

function pokazKomunikat(tekst, typ = 'info') {
  const k = el('komunikat');
  k.textContent = tekst;
  k.className = `komunikat ${typ}`;
  if (komunikatTimeout) clearTimeout(komunikatTimeout);
  if (typ !== 'blad') {
    komunikatTimeout = setTimeout(() => { k.className = 'komunikat hidden'; }, 4000);
  }
}

// --- operator (localStorage, jak na ekranach Zebry) ---

const inputOperator = el('input-operator');
inputOperator.value = localStorage.getItem('wms_operator') ?? '';
inputOperator.addEventListener('change', () => {
  localStorage.setItem('wms_operator', inputOperator.value.trim());
});

function operator() {
  return inputOperator.value.trim() || null;
}

// --- fetch helper ---

async function api(url, opts) {
  const r = await fetch(url, opts);
  let dane = null;
  try {
    dane = await r.json();
  } catch {
    // brak body (np. 204 No Content)
  }
  if (!r.ok) {
    throw new Error(dane?.blad ?? `Błąd ${r.status}`);
  }
  return dane;
}

function formatDatetime(s) {
  return s ? s.slice(0, 16) : '–';
}

const BADGE_KLASY = {
  nowy: 'badge-warn',
  otwarta: 'badge-warn',
  pending: 'badge-warn',
  wyjasniony: 'badge-ok',
  zamknieta: 'badge-neutral',
  ok: 'badge-ok',
};

function badge(status) {
  return `<span class="badge ${BADGE_KLASY[status] ?? 'badge-neutral'}">${status}</span>`;
}

// --- zakladki ---

const panele = {
  produkty: { sekcja: 'panel-produkty', zaladowano: false, odswiez: odswiezProdukty },
  rozjazdy: { sekcja: 'panel-rozjazdy', zaladowano: false, odswiez: odswiezRozjazdy },
  ruchy: { sekcja: 'panel-ruchy', zaladowano: false, odswiez: odswiezRuchy },
  lokalizacje: { sekcja: 'panel-lokalizacje', zaladowano: false, odswiez: odswiezLokalizacje },
  inwentaryzacje: { sekcja: 'panel-inwentaryzacje', zaladowano: false, odswiez: odswiezInwentaryzacje },
};

function pokazPanel(nazwa) {
  for (const [klucz, p] of Object.entries(panele)) {
    el(p.sekcja).classList.toggle('hidden', klucz !== nazwa);
  }
  document.querySelectorAll('.tab-link').forEach((btn) => {
    btn.classList.toggle('aktywny', btn.dataset.panel === nazwa);
  });
  const panel = panele[nazwa];
  if (!panel.zaladowano) {
    panel.zaladowano = true;
    panel.odswiez();
  }
}

document.querySelectorAll('.tab-link').forEach((btn) => {
  btn.addEventListener('click', () => pokazPanel(btn.dataset.panel));
});

// === PRODUKTY ===

const ZGODNOSC_BADGE = {
  OK: 'badge-ok',
  t_GT: 'badge-info',
  NZ: 'badge-err',
  BD: 'badge-neutral',
};

const PROD_LIMIT = 50;
let prodOffset = 0;

function zaznaczoneWartosci(selector) {
  return Array.from(document.querySelectorAll(selector))
    .filter((el) => el.checked)
    .map((el) => el.value);
}

async function odswiezProdukty() {
  const q = el('prod-q').value.trim();
  const params = new URLSearchParams({
    limit: PROD_LIMIT,
    offset: prodOffset,
    sort: el('prod-sort').value,
    dir: el('prod-dir').value,
  });
  if (q) params.set('q', q);

  const magazyny = zaznaczoneWartosci('.prod-magazyn');
  if (magazyny.length > 0) params.set('magazyn', magazyny.join(','));

  const zgodnosc = zaznaczoneWartosci('.prod-zgodnosc');
  if (zgodnosc.length > 0) params.set('zgodnosc', zgodnosc.join(','));

  if (el('prod-rezerwacja').checked) params.set('z_rezerwacja', '1');
  if (el('prod-zablokowane').checked) params.set('pokaz_zablokowane', '1');

  try {
    renderujProdukty(await api(`/api/produkty?${params}`));
  } catch (err) {
    pokazKomunikat(err.message, 'blad');
  }
}

function ilg(stanyGt, magazyn) {
  return stanyGt?.[magazyn]?.ilosc ?? 0;
}

// Komorka stanu magazynu: stan, a gdy jest rezerwacja (st_StanRez) - druga
// linijka "rez N". Druga linijka pojawia sie tylko gdy rezerwacja != 0,
// zeby nie zasmiecac kolumn (rezerwacje w praktyce ma garstka towarow).
function komorkaStan(stanyGt, magazyn) {
  const stan = stanyGt?.[magazyn]?.ilosc ?? 0;
  const rez = stanyGt?.[magazyn]?.rezerwacja ?? 0;
  if (!rez) return String(stan);
  return `${stan}<br><span class="rez">rez ${rez}</span>`;
}

function renderujProdukty({ produkty, total, limit, offset, tryb }) {
  const tbody = el('prod-tbody');
  tbody.innerHTML = '';
  el('prod-brak').classList.toggle('hidden', produkty.length > 0);

  for (const p of produkty) {
    const wmsK4 = p.wms_k4 ? `${p.wms_k4.kod} (${p.wms_k4.ilosc})` : '–';
    const wmsK4g = p.wms_k4g.length > 0
      ? p.wms_k4g.map((l) => `${l.kod}: ${l.ilosc}`).join(', ')
      : '–';
    const z = p.zgodnosc;
    const klasa = ZGODNOSC_BADGE[z.ogolna] ?? 'badge-neutral';
    const tytul = `K4: ${z.k4} | K4G: ${z.k4g}`;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${p.symbol}</strong></td>
      <td>${p.nazwa}</td>
      <td>${p.ean ?? '–'}</td>
      <td>${komorkaStan(p.stany_gt, 'K4')}</td>
      <td>${komorkaStan(p.stany_gt, 'K4G')}</td>
      <td>${komorkaStan(p.stany_gt, 'MAG')}</td>
      <td>${komorkaStan(p.stany_gt, 'LS')}</td>
      <td>${p.razem}</td>
      <td>${wmsK4}</td>
      <td>${wmsK4g}</td>
      <td>${p.k4g_razem}</td>
      <td><span class="badge ${klasa}" title="${tytul}">${z.ogolna}</span></td>
      <td>${p.lokalizacja_k4_gt || '–'}</td>
      <td>${p.lokalizacja_k4g_gt || '–'}</td>
    `;
    tbody.appendChild(tr);
  }

  const od = total === 0 ? 0 : offset + 1;
  const doIdx = Math.min(offset + limit, total);
  const sufiks = tryb === 'zbior_wms' ? ' (zbiór WMS)' : '';
  el('prod-zakres').textContent = `${od}–${doIdx} z ${total}${sufiks}`;
  el('btn-prod-prev').disabled = offset <= 0;
  el('btn-prod-next').disabled = offset + limit >= total;
}

el('btn-prod-szukaj').addEventListener('click', () => {
  prodOffset = 0;
  odswiezProdukty();
});
el('prod-q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    prodOffset = 0;
    odswiezProdukty();
  }
});
el('btn-prod-odswiez').addEventListener('click', odswiezProdukty);
el('btn-prod-prev').addEventListener('click', () => {
  prodOffset = Math.max(prodOffset - PROD_LIMIT, 0);
  odswiezProdukty();
});
el('btn-prod-next').addEventListener('click', () => {
  prodOffset += PROD_LIMIT;
  odswiezProdukty();
});

el('prod-zablokowane').addEventListener('change', () => {
  prodOffset = 0;
  odswiezProdukty();
});
el('prod-rezerwacja').addEventListener('change', () => {
  prodOffset = 0;
  odswiezProdukty();
});
document.querySelectorAll('.prod-magazyn, .prod-zgodnosc').forEach((cb) => {
  cb.addEventListener('change', () => {
    prodOffset = 0;
    odswiezProdukty();
  });
});
el('prod-sort').addEventListener('change', () => {
  prodOffset = 0;
  odswiezProdukty();
});
el('prod-dir').addEventListener('change', () => {
  prodOffset = 0;
  odswiezProdukty();
});

// === ROZJAZDY ===

async function odswiezRozjazdy() {
  const status = el('rozjazdy-status').value;
  const magazyn = el('rozjazdy-magazyn').value;
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (magazyn) params.set('magazyn', magazyn);

  try {
    renderujRozjazdy(await api(`/api/rozjazdy?${params}`));
  } catch (err) {
    pokazKomunikat(err.message, 'blad');
  }
}

function renderujRozjazdy(lista) {
  const tbody = el('rozjazdy-tbody');
  tbody.innerHTML = '';
  el('rozjazdy-brak').classList.toggle('hidden', lista.length > 0);

  for (const r of lista) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${r.artykul_symbol}</strong></td>
      <td>${r.magazyn}</td>
      <td>${r.ilosc_gt}</td>
      <td>${r.ilosc_wms}</td>
      <td>${r.roznica > 0 ? '+' : ''}${r.roznica}</td>
      <td>${badge(r.status)}</td>
      <td>${formatDatetime(r.wykryty)}</td>
      <td class="opis">${r.opis ?? ''}</td>
      <td></td>
    `;
    if (r.status === 'nowy' && r.magazyn === 'K4G') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-small';
      btn.textContent = 'Rozwiąż';
      btn.addEventListener('click', () => otworzRozwiazanie(r, tr));
      tr.lastElementChild.appendChild(btn);
    }
    tbody.appendChild(tr);
  }
}

// Formularz korekt K4G: dla kazdej lokalizacji K4G z zapasem artykulu pokazuje
// "ilosc po korekcie" (domyslnie = obecna ilosc, czyli brak zmiany). Suma odjec
// (obecna - po) musi rownac sie wymaganej redukcji (ilosc_wms - ilosc_gt), zgodnie
// z walidacja w POST /api/rozjazdy/:id/resolve.
async function otworzRozwiazanie(rozjazd, tr) {
  const istniejacy = tr.nextElementSibling;
  if (istniejacy?.classList.contains('wiersz-rozwiazanie')) {
    istniejacy.remove();
    return;
  }
  document.querySelectorAll('.wiersz-rozwiazanie').forEach((w) => w.remove());

  let dane;
  try {
    dane = await api(`/api/lokalizacje/artykul/${encodeURIComponent(rozjazd.artykul_symbol)}`);
  } catch (err) {
    pokazKomunikat(`Rozjazd może być już nieaktualny (${err.message}) - użyj "Wykryj teraz".`, 'info');
    return;
  }

  const lokK4G = dane.lokalizacje.filter((l) => l.magazyn === 'K4G');
  const wymaganaRedukcja = rozjazd.ilosc_wms - rozjazd.ilosc_gt;

  if (lokK4G.length === 0 || wymaganaRedukcja <= 0) {
    pokazKomunikat('Brak aktualnego zapasu K4G dla tego artykułu - rozjazd może być już nieaktualny. Użyj "Wykryj teraz".', 'info');
    return;
  }

  const wiersz = document.createElement('tr');
  wiersz.className = 'wiersz-rozwiazanie';
  const td = document.createElement('td');
  td.colSpan = 9;

  const naglowek = document.createElement('p');
  naglowek.className = 'hint';
  naglowek.textContent = `Do odjęcia razem: ${wymaganaRedukcja} szt. Wpisz ilość PO korekcie dla każdej lokalizacji.`;
  td.appendChild(naglowek);

  const lista = document.createElement('div');
  lista.className = 'korekty-lista';
  for (const l of lokK4G) {
    const wierszKorekty = document.createElement('div');
    wierszKorekty.className = 'korekta';
    wierszKorekty.innerHTML = `
      <span class="kod">${l.kod}</span>
      <span class="obecna">obecnie: ${l.ilosc}</span>
      <label>po korekcie:
        <input type="number" min="0" max="${l.ilosc}" step="any" value="${l.ilosc}" data-lokalizacja-id="${l.lokalizacja_id}" data-obecna="${l.ilosc}">
      </label>
    `;
    lista.appendChild(wierszKorekty);
  }
  td.appendChild(lista);

  const podsumowanie = document.createElement('p');
  podsumowanie.className = 'hint korekty-suma';
  td.appendChild(podsumowanie);

  const btnZapisz = document.createElement('button');
  btnZapisz.type = 'button';
  btnZapisz.className = 'btn btn-primary';
  btnZapisz.textContent = 'Zapisz korekty';

  function przelicz() {
    let suma = 0;
    let poprawne = true;
    for (const input of lista.querySelectorAll('input')) {
      const obecna = Number(input.dataset.obecna);
      const po = Number(input.value);
      if (!Number.isFinite(po) || po < 0 || po > obecna) poprawne = false;
      else suma += obecna - po;
    }
    podsumowanie.textContent = `Suma korekt: ${suma} / ${wymaganaRedukcja} wymagane`;
    btnZapisz.disabled = !poprawne || suma !== wymaganaRedukcja;
    return poprawne;
  }
  lista.addEventListener('input', przelicz);
  przelicz();

  btnZapisz.addEventListener('click', async () => {
    if (!przelicz()) return;
    const korekty = [...lista.querySelectorAll('input')].map((input) => ({
      lokalizacja_id: Number(input.dataset.lokalizacjaId),
      ilosc_po: Number(input.value),
    }));
    btnZapisz.disabled = true;
    try {
      const wynik = await api(`/api/rozjazdy/${rozjazd.id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ korekty, operator: operator() }),
      });
      pokazKomunikat(
        wynik.wynik === 'juz_rozwiazany' ? 'Rozjazd ustąpił w międzyczasie.' : 'Rozjazd rozwiązany.',
        'ok'
      );
      odswiezRozjazdy();
    } catch (err) {
      pokazKomunikat(err.message, 'blad');
      btnZapisz.disabled = false;
    }
  });

  const btnAnuluj = document.createElement('button');
  btnAnuluj.type = 'button';
  btnAnuluj.className = 'btn';
  btnAnuluj.textContent = 'Anuluj';
  btnAnuluj.addEventListener('click', () => wiersz.remove());

  const akcje = document.createElement('div');
  akcje.className = 'korekty-akcje';
  akcje.appendChild(btnZapisz);
  akcje.appendChild(btnAnuluj);
  td.appendChild(akcje);

  wiersz.appendChild(td);
  tr.after(wiersz);
}

el('btn-rozjazdy-odswiez').addEventListener('click', odswiezRozjazdy);
el('rozjazdy-status').addEventListener('change', odswiezRozjazdy);
el('rozjazdy-magazyn').addEventListener('change', odswiezRozjazdy);

el('btn-rozjazdy-detekcja').addEventListener('click', async () => {
  try {
    const w = await api('/api/rozjazdy/detekcja', { method: 'POST' });
    pokazKomunikat(
      `Detekcja: sprawdzono ${w.sprawdzone}, korekty K4: ${w.korekty_k4}, `
      + `nowe K4G: ${w.rozjazdy_k4g_nowe}, zaktualizowane K4G: ${w.rozjazdy_k4g_zaktualizowane}, `
      + `wyjaśnione K4G: ${w.rozjazdy_k4g_wyjasnione}`,
      'ok'
    );
    odswiezRozjazdy();
  } catch (err) {
    pokazKomunikat(err.message, 'blad');
  }
});

// === RUCHY ===

let lokalizacjeMap = new Map();

async function odswiezRuchy() {
  const status = el('ruchy-status').value;
  try {
    const [lista] = await Promise.all([
      api(status ? `/api/ruchy?status=${status}` : '/api/ruchy'),
      lokalizacjeMap.size === 0 ? pobierzMapeLokalizacji() : Promise.resolve(),
    ]);
    renderujRuchy(lista);
  } catch (err) {
    pokazKomunikat(err.message, 'blad');
  }
}

async function pobierzMapeLokalizacji() {
  const lista = await api('/api/lokalizacje');
  lokalizacjeMap = new Map(lista.map((l) => [l.id, l.kod]));
}

function kodLokalizacji(id) {
  if (id === null || id === undefined) return null;
  return lokalizacjeMap.get(id) ?? `#${id}`;
}

function renderujRuchy(lista) {
  const tbody = el('ruchy-tbody');
  tbody.innerHTML = '';
  el('ruchy-brak').classList.toggle('hidden', lista.length > 0);

  for (const r of lista) {
    const zrodlo = kodLokalizacji(r.lok_zrodlo_id) ?? '–';
    const cel = r.lok_cel_id ? kodLokalizacji(r.lok_cel_id) : (r.mag_cel_zewnetrzny ?? '–');

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${formatDatetime(r.data_ruchu)}</td>
      <td>${r.typ}</td>
      <td><strong>${r.artykul_symbol}</strong></td>
      <td>${r.ilosc}</td>
      <td>${zrodlo}</td>
      <td>${cel}</td>
      <td>${badge(r.status)}</td>
      <td>${r.dok_gt_numer ?? '–'}</td>
      <td class="opis">${r.blad_opis ?? ''}</td>
      <td>${r.operator ?? '–'}</td>
      <td></td>
    `;
    if (r.status === 'pending') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-small';
      btn.textContent = 'Ponów';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const wynik = await api(`/api/ruchy/${r.id}/retry`, { method: 'POST' });
          pokazKomunikat(
            wynik.status === 'ok' ? `Ruch #${r.id} zrealizowany.` : `Ruch #${r.id}: ${wynik.blad_opis ?? 'wciąż oczekuje'}`,
            wynik.status === 'ok' ? 'ok' : 'info'
          );
          odswiezRuchy();
        } catch (err) {
          pokazKomunikat(err.message, 'blad');
          btn.disabled = false;
        }
      });
      tr.lastElementChild.appendChild(btn);
    }
    tbody.appendChild(tr);
  }
}

el('btn-ruchy-odswiez').addEventListener('click', odswiezRuchy);
el('ruchy-status').addEventListener('change', odswiezRuchy);

// === LOKALIZACJE ===

async function odswiezLokalizacje() {
  const magazyn = el('lok-magazyn').value;
  const q = el('lok-q').value.trim();
  const params = new URLSearchParams();
  if (magazyn) params.set('magazyn', magazyn);
  if (q) params.set('q', q);

  try {
    renderujLokalizacje(await api(`/api/lokalizacje?${params}`));
  } catch (err) {
    pokazKomunikat(err.message, 'blad');
  }
}

function renderujLokalizacje(lista) {
  const tbody = el('lok-tbody');
  tbody.innerHTML = '';
  el('lok-brak').classList.toggle('hidden', lista.length > 0);

  for (const l of lista) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${l.kod}</strong></td>
      <td>${l.magazyn}</td>
      <td>${l.aktywna ? 'tak' : 'nie'}</td>
      <td>${formatDatetime(l.utworzona)}</td>
      <td></td>
    `;
    const akcje = tr.lastElementChild;

    const btnZawartosc = document.createElement('button');
    btnZawartosc.type = 'button';
    btnZawartosc.className = 'btn btn-small';
    btnZawartosc.textContent = 'Zawartość';
    btnZawartosc.addEventListener('click', () => przelaczZawartosc(l, tr));
    akcje.appendChild(btnZawartosc);

    const btnAktywnosc = document.createElement('button');
    btnAktywnosc.type = 'button';
    btnAktywnosc.className = 'btn btn-small';
    btnAktywnosc.textContent = l.aktywna ? 'Dezaktywuj' : 'Aktywuj';
    btnAktywnosc.addEventListener('click', async () => {
      btnAktywnosc.disabled = true;
      try {
        await api(`/api/lokalizacje/${l.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ aktywna: l.aktywna ? 0 : 1 }),
        });
        odswiezLokalizacje();
      } catch (err) {
        pokazKomunikat(err.message, 'blad');
        btnAktywnosc.disabled = false;
      }
    });
    akcje.appendChild(btnAktywnosc);

    const btnUsun = document.createElement('button');
    btnUsun.type = 'button';
    btnUsun.className = 'btn btn-small';
    btnUsun.textContent = 'Usuń';
    btnUsun.addEventListener('click', async () => {
      if (!confirm(`Usunąć lokalizację ${l.kod}?`)) return;
      try {
        await api(`/api/lokalizacje/${l.id}`, { method: 'DELETE' });
        pokazKomunikat(`Lokalizacja ${l.kod} usunięta.`, 'ok');
        odswiezLokalizacje();
      } catch (err) {
        pokazKomunikat(err.message, 'blad');
      }
    });
    akcje.appendChild(btnUsun);

    tbody.appendChild(tr);
  }
}

async function przelaczZawartosc(lokalizacja, tr) {
  const istniejacy = tr.nextElementSibling;
  if (istniejacy?.classList.contains('wiersz-zawartosc')) {
    istniejacy.remove();
    return;
  }
  document.querySelectorAll('.wiersz-zawartosc').forEach((w) => w.remove());

  let dane;
  try {
    dane = await api(`/api/lokalizacje/${lokalizacja.id}`);
  } catch (err) {
    pokazKomunikat(err.message, 'blad');
    return;
  }

  const wiersz = document.createElement('tr');
  wiersz.className = 'wiersz-zawartosc';
  const td = document.createElement('td');
  td.colSpan = 5;

  if (dane.zawartosc.length === 0) {
    td.innerHTML = '<p class="hint">Lokalizacja jest pusta.</p>';
  } else {
    td.innerHTML = `<table class="tabela tabela-zagniezdzona">
      <thead><tr><th>Symbol</th><th>Nazwa</th><th>Ilość</th></tr></thead>
      <tbody>${dane.zawartosc.map((z) => `
        <tr><td>${z.artykul_symbol}</td><td>${z.artykul_nazwa}</td><td>${z.ilosc}</td></tr>
      `).join('')}</tbody>
    </table>`;
  }

  wiersz.appendChild(td);
  tr.after(wiersz);
}

el('btn-lok-odswiez').addEventListener('click', odswiezLokalizacje);
el('lok-magazyn').addEventListener('change', odswiezLokalizacje);
el('lok-q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') odswiezLokalizacje();
});

el('form-nowa-lokalizacja').addEventListener('submit', async (e) => {
  e.preventDefault();
  const kod = el('nowa-lok-kod').value.trim();
  const magazyn = el('nowa-lok-magazyn').value;
  if (!kod) return;
  try {
    await api('/api/lokalizacje', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kod, magazyn }),
    });
    el('nowa-lok-kod').value = '';
    pokazKomunikat(`Lokalizacja ${kod} dodana.`, 'ok');
    odswiezLokalizacje();
  } catch (err) {
    pokazKomunikat(err.message, 'blad');
  }
});

// === INWENTARYZACJE ===

async function odswiezInwentaryzacje() {
  try {
    renderujInwentaryzacje(await api('/api/inwentaryzacja'));
  } catch (err) {
    pokazKomunikat(err.message, 'blad');
  }
}

function renderujInwentaryzacje(lista) {
  const tbody = el('inw-tbody');
  tbody.innerHTML = '';
  el('inw-brak').classList.toggle('hidden', lista.length > 0);

  for (const i of lista) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>#${i.id}</td>
      <td>${i.magazyn}</td>
      <td>${badge(i.status)}</td>
      <td>${formatDatetime(i.data_otwarcia)}</td>
      <td>${formatDatetime(i.data_zamkniecia)}</td>
      <td>${i.operator ?? '–'}</td>
      <td></td>
    `;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-small';
    btn.textContent = 'Szczegóły';
    btn.addEventListener('click', () => przelaczSzczegolyInwentaryzacji(i, tr));
    tr.lastElementChild.appendChild(btn);
    tbody.appendChild(tr);
  }
}

async function przelaczSzczegolyInwentaryzacji(inw, tr) {
  const istniejacy = tr.nextElementSibling;
  if (istniejacy?.classList.contains('wiersz-szczegoly')) {
    istniejacy.remove();
    return;
  }
  document.querySelectorAll('.wiersz-szczegoly').forEach((w) => w.remove());

  const wiersz = document.createElement('tr');
  wiersz.className = 'wiersz-szczegoly';
  const td = document.createElement('td');
  td.colSpan = 7;

  try {
    if (inw.status === 'otwarta') {
      const dane = await api(`/api/inwentaryzacja/${inw.id}`);
      const s = dane.statystyki;
      td.innerHTML = `<p class="hint">Pozycji: ${s.pozycje_total}, zliczonych: ${s.zliczone}, z różnicą: ${s.z_roznica}</p>`;
    } else {
      const raport = await api(`/api/inwentaryzacja/${inw.id}/raport`);
      const czesci = [];
      if (raport.nadwyzki.length > 0) czesci.push('<h3>Nadwyżki</h3>' + tabelaRoznic(raport.nadwyzki));
      if (raport.niedobory.length > 0) czesci.push('<h3>Niedobory</h3>' + tabelaRoznic(raport.niedobory));
      if (czesci.length === 0) czesci.push('<p class="hint">Spis zamknięty bez różnic.</p>');
      td.innerHTML = czesci.join('');
    }
  } catch (err) {
    td.innerHTML = `<p class="hint">Błąd: ${err.message}</p>`;
  }

  wiersz.appendChild(td);
  tr.after(wiersz);
}

function tabelaRoznic(pozycje) {
  return `<table class="tabela tabela-zagniezdzona">
    <thead><tr><th>Lokalizacja</th><th>Artykuł</th><th>Stan GT</th><th>Policzono</th><th>Różnica</th></tr></thead>
    <tbody>${pozycje.map((p) => `
      <tr><td>${p.lokalizacja_kod}</td><td>${p.artykul_symbol}</td><td>${p.ilosc_gt}</td><td>${p.ilosc_liczona}</td><td>${p.roznica > 0 ? '+' : ''}${p.roznica}</td></tr>
    `).join('')}</tbody>
  </table>`;
}

el('btn-inw-odswiez').addEventListener('click', odswiezInwentaryzacje);

// --- init ---

pokazPanel('produkty');
