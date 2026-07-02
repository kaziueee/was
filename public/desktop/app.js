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

// --- operator: teraz z zalogowanego profilu (Faza A#4). Stare wolne pole ukryte;
// backend i tak wymusza operatora z tokenu, wiec ta wartosc jest tylko pomocnicza (UI). ---

const inputOperator = el('input-operator');
if (inputOperator) inputOperator.style.display = 'none';

function operator() {
  return (window.WMS && WMS.user() && WMS.user().imie) || null;
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
    throw Object.assign(new Error(dane?.blad ?? `Błąd ${r.status}`), { status: r.status, dane });
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
  lokalizacje: { sekcja: 'panel-lokalizacje', zaladowano: false, odswiez: odswiezLokalizacje },
  mm: { sekcja: 'panel-mm', zaladowano: false, odswiez: () => {} },
  uzupelnienia: { sekcja: 'panel-uzupelnienia', zaladowano: false, odswiez: odswiezUzupelnienia },
  log: { sekcja: 'panel-log', zaladowano: false, odswiez: odswiezLog },
  uzytkownicy: { sekcja: 'panel-uzytkownicy', zaladowano: false, odswiez: odswiezUzytkownicy },
};

function pokazPanel(nazwa) {
  if (!panele[nazwa]) nazwa = 'produkty';
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

// Routing po hashu (#mm itd.) - zakladki to <a href="#...">, wiec prawy/srodkowy/
// Cmd-klik otwiera panel w nowej karcie; klik zmienia hash -> hashchange.
function panelZHasha() {
  const h = decodeURIComponent(location.hash.replace(/^#/, ''));
  return panele[h] ? h : 'produkty';
}

window.addEventListener('hashchange', () => pokazPanel(panelZHasha()));

// === PRODUKTY ===

const ZGODNOSC_BADGE = {
  OK: 'badge-ok',
  OF: 'badge-ok',
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

// Pola lokalizacyjne GT to wpisy sklejone "; " (np. "A(1); B(2)"). Renderujemy
// kazdy wpis w osobnej linii (nie zawijamy w srodku wpisu) - oszczedza szerokosc.
function komorkaLok(tekst) {
  if (!tekst) return '–';
  return tekst.split('; ').map((w) => `<span class="lok-wpis">${w}</span>`).join('');
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
      ? p.wms_k4g.map((l) => `<span class="lok-wpis">${l.kod}: ${l.ilosc}</span>`).join('')
      : '–';
    const z = p.zgodnosc;
    // Badge zawsze = ogolna (najgorszy przypadek K4/K4G) - spojnie z modalem i filtrem.
    const stanZg = z.ogolna;
    const klasa = ZGODNOSC_BADGE[stanZg] ?? 'badge-neutral';
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
      <td class="kol-lok">${wmsK4}</td>
      <td class="kol-lok">${wmsK4g}</td>
      <td>${p.k4g_razem}</td>
      <td><span class="badge ${klasa}" title="${tytul}">${stanZg}</span></td>
      <td class="kol-lok">${komorkaLok(p.lokalizacja_k4_gt)}</td>
      <td class="kol-lok">${komorkaLok(p.lokalizacja_k4g_gt)}</td>
      <td class="td-akcja"><button class="btn btn-small btn-prod-edytuj" type="button">Edytuj</button></td>
    `;
    tr.querySelector('.btn-prod-edytuj').addEventListener('click', () => otworzModalProdukt(p));
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

// === LOG biznesowy (audyt: kto/co/gdzie/kiedy) ===

const AKCJA_ETYKIETA = {
  MM: 'MM', LOK: 'Zmiana lok.', przypisanie: 'Przypisanie', przyjecie: 'Przyjęcie',
  'MM-zewn': 'MM zewn.', Uzupelnienie: 'Uzupełnienie', usuniecie_ruchu: 'Usunięcie ruchu',
  lokalizacja_nowa: 'Nowa lok.', lokalizacja_edycja: 'Edycja lok.', lokalizacja_usuniecie: 'Usunięcie lok.',
  zapas_k4: 'Zapas K4', plan_lok: 'Plan lok.', import_lokalizacji: 'Import lok.',
};

// "przed"/"po" sa JSON-em (lub null) - kompaktowy zapis "k:v, k:v"
function jsonKomp(s) {
  if (!s) return null;
  try { return Object.entries(JSON.parse(s)).map(([k, v]) => `${k}:${v}`).join(', '); }
  catch { return s; }
}
function zmianaTekst(przed, po) {
  const p = jsonKomp(przed), q = jsonKomp(po);
  if (p && q) return `${p} → ${q}`;
  return q || p || '–';
}

// Przycisk "Ponów" dla ruchu pending (przeniesione z dawnej zakladki Ruchy).
function przyciskPonowRuch(ruchId) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-small';
  btn.textContent = 'Ponów';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const wynik = await api(`/api/ruchy/${ruchId}/retry`, { method: 'POST' });
      pokazKomunikat(
        wynik.status === 'ok' ? `Ruch #${ruchId} zrealizowany.` : `Ruch #${ruchId}: ${wynik.blad_opis ?? 'wciąż oczekuje'}`,
        wynik.status === 'ok' ? 'ok' : 'info'
      );
      odswiezLog();
    } catch (err) {
      pokazKomunikat(err.message, 'blad');
      btn.disabled = false;
    }
  });
  return btn;
}

// Przycisk "Usuń" dla ruchu pending (cofa zmiane stanu WMS; tylko bez dokumentu GT).
function przyciskUsunRuch(ruchId) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-small btn-danger';
  btn.style.marginLeft = '4px';
  btn.textContent = 'Usuń';
  btn.title = 'Usuń ruch z kolejki i cofnij zmianę stanu WMS (tylko gdy GT nie wystawił dokumentu)';
  btn.addEventListener('click', async () => {
    if (!confirm(`Usunąć ruch #${ruchId}? Stan WMS zostanie cofnięty do stanu sprzed ruchu.`)) return;
    btn.disabled = true;
    try {
      await api(`/api/ruchy/${ruchId}`, { method: 'DELETE' });
      pokazKomunikat(`Ruch #${ruchId} usunięty, stan WMS cofnięty.`, 'ok');
      odswiezLog();
    } catch (err) {
      pokazKomunikat(err.message, 'blad');
      btn.disabled = false;
    }
  });
  return btn;
}

function wierszLog(r, { zKolumnamiSku }) {
  const tr = document.createElement('tr');
  const sku = zKolumnamiSku ? `<td>${r.artykul_symbol ? `<strong>${r.artykul_symbol}</strong>` : '–'}</td>` : '';
  const dok = zKolumnamiSku ? `<td>${r.dok_gt_numer ?? '–'}</td>` : '';
  // Status: dla wpisow RUCHOWYCH (ruch_id ustawione) bierzemy ZYWY status z tabeli ruchy;
  // gdy ruch znikl z kolejki (usuniety) join daje null -> "anulowany" zamiast mylacego,
  // zamrozonego "pending" z chwili utworzenia. Dla akcji nie-ruchowych - zapisany wynik.
  const wynik = r.ruch_id != null ? (r.ruch_status ?? 'anulowany') : r.wynik;
  tr.innerHTML = `
    <td>${formatDatetime(r.czas)}</td>
    <td>${AKCJA_ETYKIETA[r.akcja] ?? r.akcja}</td>
    ${sku}
    <td>${r.magazyn ?? '–'}</td>
    <td>${r.lokalizacja ?? '–'}</td>
    <td>${r.ilosc ?? ''}</td>
    <td class="opis">${zmianaTekst(r.przed, r.po)}</td>
    <td>${wynik ? badge(wynik) : '–'}</td>
    ${dok}
    <td>${r.uzytkownik ?? '–'}</td>`;
  // kolumna Akcje tylko w glownym Logu (nie w modalu historii); przyciski gdy ruch wciaz pending
  if (zKolumnamiSku) {
    const tdAkcje = document.createElement('td');
    if (r.ruch_id && r.ruch_status === 'pending') {
      tdAkcje.appendChild(przyciskPonowRuch(r.ruch_id));
      tdAkcje.appendChild(przyciskUsunRuch(r.ruch_id));
    }
    tr.appendChild(tdAkcje);
  }
  return tr;
}

async function odswiezLog() {
  const params = new URLSearchParams();
  const q = el('log-q').value.trim();
  const akcja = el('log-akcja').value;
  if (q) params.set('q', q);
  if (akcja) params.set('akcja', akcja);
  try {
    const { wiersze, total } = await api(`/api/audyt?${params.toString()}`);
    const tbody = el('log-tbody');
    tbody.innerHTML = '';
    el('log-brak').classList.toggle('hidden', wiersze.length > 0);
    el('log-licznik').textContent = total != null ? `${wiersze.length} z ${total}` : '';
    for (const r of wiersze) tbody.appendChild(wierszLog(r, { zKolumnamiSku: true }));
  } catch (err) {
    pokazKomunikat(err.message, 'blad');
  }
}

el('btn-log-odswiez').addEventListener('click', odswiezLog);
el('log-akcja').addEventListener('change', odswiezLog);
el('log-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') odswiezLog(); });

// historia pojedynczego SKU (ikona "H" w modalu produktu)
async function otworzHistorie(artykulGtId, symbol) {
  el('modal-hist-sku').textContent = symbol ?? '';
  el('modal-historia').classList.remove('hidden');
  const tbody = el('modal-hist-tbody');
  tbody.innerHTML = '';
  try {
    const { wiersze } = await api(`/api/audyt?artykul_gt_id=${encodeURIComponent(artykulGtId)}&limit=500`);
    el('modal-hist-brak').classList.toggle('hidden', wiersze.length > 0);
    for (const r of wiersze) tbody.appendChild(wierszLog(r, { zKolumnamiSku: false }));
  } catch (err) {
    pokazKomunikat(err.message, 'blad');
  }
}
function zamknijHistorie() { el('modal-historia').classList.add('hidden'); }

el('btn-modal-hist-zamknij').addEventListener('click', zamknijHistorie);
el('modal-historia').addEventListener('click', (e) => { if (e.target === el('modal-historia')) zamknijHistorie(); });

// === UZYTKOWNICY (zakladka tylko dla admina) ===

function pokazZakladkeAdmina() {
  const tab = el('tab-uzytkownicy');
  if (tab) tab.style.display = (window.WMS && WMS.jestAdmin()) ? '' : 'none';
}
if (window.WMS) WMS.gotowe.then(pokazZakladkeAdmina);
window.addEventListener('wms-zalogowano', pokazZakladkeAdmina);

async function odswiezUzytkownicy() {
  try { renderujUzytkownicy(await api('/api/uzytkownicy')); }
  catch (err) { pokazKomunikat(err.message, 'blad'); }
}

function przyciskUser(tekst, kl, fn) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'btn ' + kl; b.style.marginLeft = '4px'; b.textContent = tekst;
  b.addEventListener('click', fn);
  return b;
}

async function zapiszUser(id, patch) {
  try {
    await api(`/api/uzytkownicy/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    odswiezUzytkownicy();
  } catch (err) { pokazKomunikat(err.message, 'blad'); }
}

function renderujUzytkownicy(lista) {
  const tbody = el('user-tbody'); tbody.innerHTML = '';
  el('user-brak').classList.toggle('hidden', lista.length > 0);
  for (const u of lista) {
    const tr = document.createElement('tr');
    if (!u.aktywny) tr.style.opacity = '0.5';
    tr.innerHTML = `<td><strong>${u.imie}</strong></td><td>${u.rola}</td><td>${u.maPin ? 'tak' : '–'}</td><td>${u.aktywny ? 'aktywny' : 'nieaktywny'}</td><td></td>`;
    const akc = tr.lastElementChild;
    akc.appendChild(przyciskUser('Ustaw PIN', 'btn-small', async () => {
      const pin = prompt(`Nowy PIN dla ${u.imie} (4-8 cyfr):`);
      if (pin) await zapiszUser(u.id, { pin });
    }));
    if (u.maPin) akc.appendChild(przyciskUser('Bez PIN', 'btn-small', () => zapiszUser(u.id, { usunPin: true })));
    akc.appendChild(przyciskUser(u.rola === 'admin' ? '→ Magazynier' : '→ Admin', 'btn-small', () => zapiszUser(u.id, { rola: u.rola === 'admin' ? 'magazynier' : 'admin' })));
    akc.appendChild(przyciskUser(u.aktywny ? 'Dezaktywuj' : 'Aktywuj', u.aktywny ? 'btn-small btn-danger' : 'btn-small', () => {
      if (u.aktywny && !confirm(`Dezaktywować ${u.imie}?`)) return;
      zapiszUser(u.id, { aktywny: u.aktywny ? 0 : 1 });
    }));
    tbody.appendChild(tr);
  }
}

el('form-nowy-user').addEventListener('submit', async (e) => {
  e.preventDefault();
  const imie = el('nowy-user-imie').value.trim();
  const pin = el('nowy-user-pin').value.trim();
  if (!imie) return;
  try {
    await api('/api/uzytkownicy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imie, pin: pin || undefined, rola: el('nowy-user-rola').value }) });
    el('nowy-user-imie').value = ''; el('nowy-user-pin').value = '';
    pokazKomunikat(`Dodano ${imie}`, 'ok');
    odswiezUzytkownicy();
  } catch (err) { pokazKomunikat(err.message, 'blad'); }
});

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

const TYPY_LOK = ['paleta', 'trawers', 'polka', 'inny'];

// Staly, widoczny dropdown typu w kolumnie Typ - zmiana = PUT {typ} (reczne nadpisanie
// reguly). Kolor selecta odzwierciedla wybrany typ. Zapis w miejscu (bez przeladowania
// calej listy), z revertem przy bledzie.
function budujSelectTypu(l) {
  const sel = document.createElement('select');
  const koloruj = () => { sel.className = `lok-typ-select${sel.value ? ` lok-typ-${sel.value}` : ''}`; };
  for (const t of TYPY_LOK) {
    const o = document.createElement('option');
    o.value = t; o.textContent = t;
    if (t === l.typ) o.selected = true;
    sel.appendChild(o);
  }
  koloruj();
  sel.title = 'Zmień typ lokalizacji';

  let obecny = l.typ;
  sel.addEventListener('change', async () => {
    if (sel.value === obecny) return;
    sel.disabled = true;
    try {
      await api(`/api/lokalizacje/${l.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ typ: sel.value }),
      });
      obecny = sel.value; l.typ = sel.value;
      koloruj();
      pokazKomunikat(`Typ ${l.kod} zmieniony na „${sel.value}".`, 'ok');
    } catch (err) {
      sel.value = obecny; koloruj();
      pokazKomunikat(err.message, 'blad');
    } finally {
      sel.disabled = false;
    }
  });
  return sel;
}

function renderujLokalizacje(lista) {
  const tbody = el('lok-tbody');
  tbody.innerHTML = '';
  el('lok-brak').classList.toggle('hidden', lista.length > 0);

  for (const l of lista) {
    const tr = document.createElement('tr');
    const alejkaStr = l.alejka ? `${l.alejka}${l.strona ?? ''}` : '–';
    tr.innerHTML = `
      <td><strong>${l.kod}</strong></td>
      <td>${l.magazyn}</td>
      <td></td>
      <td>${l.hala ?? '–'}</td>
      <td>${alejkaStr}</td>
      <td>${l.aktywna ? 'tak' : 'nie'}</td>
      <td></td>
    `;
    const akcje = tr.lastElementChild;

    // Typ = staly, widoczny dropdown (edycja typu, ktory czasem sie zmienia)
    tr.children[2].appendChild(budujSelectTypu(l));

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

// --- import zbiorczy lokalizacji (wklejona kolumna kodow) ---

// Buduje payload {lokalizacje:[{kod,magazyn}]} z tekstu (jedna linia = jeden kod)
function importBudujPayload() {
  const magazyn = el('import-magazyn').value;
  const kody = el('import-tekst').value
    .split('\n')
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
  return { lokalizacje: kody.map((kod) => ({ kod, magazyn })) };
}

// Importuj aktywne dopiero po udanym podgladzie; kazda zmiana tekstu/magazynu
// wymusza ponowny podglad (zeby nie zapisac czegos innego niz zobaczyl user)
function importResetuj() {
  el('btn-import-wykonaj').disabled = true;
  el('import-wynik').classList.add('hidden');
}
el('import-tekst').addEventListener('input', importResetuj);
el('import-magazyn').addEventListener('change', importResetuj);

el('btn-import-podglad').addEventListener('click', async () => {
  const payload = importBudujPayload();
  if (payload.lokalizacje.length === 0) {
    pokazKomunikatEl('import-wynik', 'Wklej najpierw kody lokalizacji.', 'blad');
    el('import-wynik').classList.remove('hidden');
    return;
  }
  try {
    const w = await api('/api/lokalizacje/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, podglad: true }),
    });
    const czesci = [`Do dodania: ${w.do_dodania}`, `pominięte (już są): ${w.pominiete}`];
    if (w.bledy.length) czesci.push(`błędne: ${w.bledy.length}`);
    let tekst = czesci.join(' · ');
    if (w.typy && Object.keys(w.typy).length) {
      tekst += '\ntypy: ' + Object.entries(w.typy).map(([t, n]) => `${t} ${n}`).join(', ');
    }
    if (w.bledy.length) {
      tekst += '\n' + w.bledy.slice(0, 8).map((b) => `• ${b.kod || '(pusty)'} — ${b.powod}`).join('\n');
    }
    pokazKomunikatEl('import-wynik', tekst, w.do_dodania > 0 ? 'ok' : 'info');
    el('import-wynik').style.whiteSpace = 'pre-line';
    el('import-wynik').classList.remove('hidden');
    el('btn-import-wykonaj').disabled = w.do_dodania === 0;
  } catch (err) {
    pokazKomunikatEl('import-wynik', err.message, 'blad');
    el('import-wynik').classList.remove('hidden');
  }
});

el('btn-import-wykonaj').addEventListener('click', async () => {
  const payload = importBudujPayload();
  el('btn-import-wykonaj').disabled = true;
  try {
    const w = await api('/api/lokalizacje/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    pokazKomunikat(`Import: dodano ${w.dodane}, pominięto ${w.pominiete}${w.bledy.length ? `, błędnych ${w.bledy.length}` : ''}.`, 'ok');
    el('import-tekst').value = '';
    el('import-wynik').classList.add('hidden');
    odswiezLokalizacje();
  } catch (err) {
    pokazKomunikat(err.message, 'blad');
    el('btn-import-wykonaj').disabled = false;
  }
});

// === MM PANEL ===

function mmCzyWms(mag) {
  return mag === 'K4' || mag === 'K4G';
}

function mmParsujKierunek(val) {
  const [zrodlo, cel] = val.split(':');
  return { zrodlo, cel };
}

// Pola lokalizacji to combo (input + datalist) - przy dziesiatkach lokalizacji
// pozwala wpisywac i zawezac liste. Mapa kod->id per pole (do odczytu wybranego id).
const lokMapy = {};
// Mapa kod->stan (ilosc na lokalizacji zrodlowej) per pole - do "pozostanie na lokalizacji"
const lokStany = {};

function ustawDatalist(inputEl, opcje) {
  // opcje: [{id, kod, hint?, stan?}]
  const dl = el(`${inputEl.id}-list`);
  dl.innerHTML = '';
  const mapa = new Map();
  const stany = new Map();
  for (const o of opcje) {
    mapa.set(o.kod, o.id);
    if (o.stan !== undefined) stany.set(o.kod, o.stan);
    const opt = document.createElement('option');
    opt.value = o.kod;
    if (o.hint) opt.label = `${o.kod} — ${o.hint}`;
    dl.appendChild(opt);
  }
  lokMapy[inputEl.id] = mapa;
  lokStany[inputEl.id] = stany;
  inputEl.value = '';
}

// Pokazuje "pozostanie na lokalizacji" = stan zrodla - wpisana ilosc. Dynamicznie
// przy zmianie zrodla lub ilosci. Ukryte gdy zrodlo bez znanego stanu (MAG/LS / puste).
function aktualizujPozostanie(srcId, qtyId, spanId) {
  const span = el(spanId);
  const src = el(srcId);
  const kod = src.value.trim();
  const stan = lokStany[srcId]?.get(kod);
  if (stan === undefined || src.classList.contains('hidden')) {
    span.classList.add('hidden');
    return;
  }
  const qty = Number(el(qtyId).value);
  const pozostanie = stan - (Number.isFinite(qty) ? qty : 0);
  span.textContent = `Na lokalizacji: ${stan} → pozostanie: ${pozostanie}`;
  span.classList.toggle('pozostanie-blad', pozostanie < 0);
  span.classList.remove('hidden');
}

// Zwraca id lokalizacji dla aktualnie wpisanego kodu, lub null gdy nie pasuje do listy
function lokComboId(inputEl) {
  const mapa = lokMapy[inputEl.id];
  if (!mapa) return null;
  return mapa.get(inputEl.value.trim()) ?? null;
}

async function mmZaladujLokZrodlo(inputEl, brakEl, mag, symbol) {
  if (!mmCzyWms(mag)) {
    inputEl.classList.add('hidden');
    if (brakEl) brakEl.classList.remove('hidden');
    ustawDatalist(inputEl, []);
    return;
  }
  inputEl.classList.remove('hidden');
  if (brakEl) brakEl.classList.add('hidden');
  try {
    const dane = await api(`/api/lokalizacje/artykul/${encodeURIComponent(symbol)}`);
    const loki = dane.lokalizacje.filter((l) => l.magazyn === mag && l.ilosc > 0);
    ustawDatalist(inputEl, loki.map((l) => ({ id: l.lokalizacja_id, kod: l.kod, hint: `${l.ilosc} szt.`, stan: l.ilosc })));
    if (loki.length === 1) inputEl.value = loki[0].kod;
  } catch { ustawDatalist(inputEl, []); }
}

// Gdy cel = K4 (1 SKU = 1 lokalizacja): podpowiedz stale miejsce K4 artykulu
// (tez puste, ilosc 0) z mozliwoscia zmiany + info o stanie i rezerwacji GT.
async function mmUstawCelK4(celInputEl, infoSpanId, mag, produkt) {
  const span = infoSpanId ? el(infoSpanId) : null;
  if (mag !== 'K4') { if (span) span.classList.add('hidden'); return; }
  if (span) {
    const il = produkt.stany_gt?.K4?.ilosc ?? 0;
    const rez = produkt.stany_gt?.K4?.rezerwacja ?? 0;
    span.textContent = `Na K4: ${il}${rez ? ` (rez ${rez})` : ''}`;
    span.classList.remove('hidden');
  }
  try {
    const dom = await api(`/api/lokalizacje/k4-dom/${produkt.artykul_gt_id}`);
    if (dom && dom.kod) celInputEl.value = dom.kod;
  } catch { /* brak stalego miejsca - uzytkownik wybierze */ }
}

async function mmZaladujLokCel(inputEl, brakEl, mag) {
  if (!mmCzyWms(mag)) {
    inputEl.classList.add('hidden');
    if (brakEl) brakEl.classList.remove('hidden');
    ustawDatalist(inputEl, []);
    return;
  }
  inputEl.classList.remove('hidden');
  if (brakEl) brakEl.classList.add('hidden');
  try {
    const lista = await api(`/api/lokalizacje?magazyn=${mag}&aktywna=1`);
    ustawDatalist(inputEl, lista.map((l) => ({ id: l.id, kod: l.kod })));
  } catch { ustawDatalist(inputEl, []); }
}

function mmBudujPayload({ artykul_gt_id, symbol, nazwa, ean, zrodloMag, celMag, lokZrodloId, lokCelId, ilosc }) {
  const wmsZ = mmCzyWms(zrodloMag);
  const wmsC = mmCzyWms(celMag);
  if (wmsZ && wmsC) {
    return { url: '/api/ruchy/mm', body: { artykul_gt_id, lok_zrodlo_id: lokZrodloId, lok_cel_id: lokCelId, ilosc, operator: operator() } };
  } else if (wmsZ && !wmsC) {
    return { url: '/api/ruchy/mm', body: { artykul_gt_id, lok_zrodlo_id: lokZrodloId, mag_cel_zewnetrzny: celMag, ilosc, operator: operator() } };
  } else if (!wmsZ && wmsC) {
    return { url: '/api/ruchy/przyjecie', body: { artykul_gt_id, mag_zrodlo_zewnetrzny: zrodloMag, lok_cel_id: lokCelId, ilosc, artykul_symbol: symbol, artykul_nazwa: nazwa, artykul_ean: ean, operator: operator() } };
  } else {
    return { url: '/api/ruchy/mm-zewnetrzny', body: { artykul_gt_id, mag_zrodlo: zrodloMag, mag_cel: celMag, ilosc, artykul_symbol: symbol, operator: operator() } };
  }
}

function pokazKomunikatEl(elId, tekst, typ) {
  const k = el(elId);
  k.textContent = tekst;
  k.className = `komunikat ${typ}`;
}

// --- lista staging ---

let mmLista = [];
let mmWybranyProdukt = null;

function mmRenderujTabele() {
  const tbody = el('mm-tbody');
  tbody.innerHTML = '';
  el('mm-brak').classList.toggle('hidden', mmLista.length > 0);
  el('mm-footer').classList.toggle('hidden', mmLista.length === 0);
  el('mm-liczba').textContent = mmLista.length;

  for (let i = 0; i < mmLista.length; i++) {
    const p = mmLista[i];
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${p.symbol}</strong></td>
      <td>${p.nazwa}</td>
      <td>${p.lokZrodloKod ?? p.zrodloMag}</td>
      <td>${p.ilosc}</td>
      <td>${p.lokCelKod ?? p.celMag}</td>
      <td><button type="button" class="btn btn-small btn-danger" data-idx="${i}">✕</button></td>
    `;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('[data-idx]').forEach((btn) => {
    btn.addEventListener('click', () => {
      mmLista.splice(Number(btn.dataset.idx), 1);
      mmRenderujTabele();
    });
  });
}

// --- wyszukiwanie ---

el('btn-mm-szukaj').addEventListener('click', mmSzukaj);
el('mm-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') mmSzukaj(); });

async function mmSzukaj() {
  const q = el('mm-q').value.trim();
  const wyniki = el('mm-szukaj-wyniki');
  if (!q) return;
  wyniki.innerHTML = '<p class="hint">Szukam…</p>';
  wyniki.classList.remove('hidden');
  try {
    const { produkty } = await api(`/api/produkty?q=${encodeURIComponent(q)}&limit=20`);
    wyniki.innerHTML = '';
    if (produkty.length === 0) { wyniki.innerHTML = '<p class="hint">Brak wyników.</p>'; return; }
    for (const p of produkty) {
      const stany = Object.entries(p.stany_gt ?? {}).map(([m, s]) => `${m}:${s.ilosc}`).join(' ');
      const wiersz = document.createElement('div');
      wiersz.className = 'mm-szukaj-wiersz';
      wiersz.innerHTML = `
        <span class="mm-sku">${p.symbol}</span>
        <span class="mm-nazwa">${p.nazwa}</span>
        <span class="mm-stany">${stany}</span>
      `;
      wiersz.addEventListener('click', () => mmWybierzProdukt(p));
      wyniki.appendChild(wiersz);
    }
  } catch (err) {
    wyniki.innerHTML = `<p class="hint">Błąd: ${err.message}</p>`;
  }
}

async function mmWybierzProdukt(p) {
  mmWybranyProdukt = p;
  el('mm-szukaj-wyniki').classList.add('hidden');
  el('mm-q').value = '';
  el('mm-f-sku').textContent = p.symbol;
  el('mm-f-nazwa').textContent = p.nazwa;
  el('mm-f-stany').textContent = Object.entries(p.stany_gt ?? {}).map(([m, s]) => `${m}:${s.ilosc}`).join(' | ');
  el('mm-f-ilosc').value = 1;
  el('mm-formularz').classList.remove('hidden');
  await mmOdswiezLokFormularz();
}

async function mmOdswiezLokFormularz() {
  if (!mmWybranyProdukt) return;
  const { zrodlo, cel } = mmParsujKierunek(el('mm-kierunek').value);
  await Promise.all([
    mmZaladujLokZrodlo(el('mm-f-zrodlo'), el('mm-f-zrodlo-brak'), zrodlo, mmWybranyProdukt.symbol),
    mmZaladujLokCel(el('mm-f-cel'), el('mm-f-cel-brak'), cel),
  ]);
  await mmUstawCelK4(el('mm-f-cel'), 'mm-f-cel-info', cel, mmWybranyProdukt);
  aktualizujPozostanie('mm-f-zrodlo', 'mm-f-ilosc', 'mm-f-pozostanie');
}

el('mm-kierunek').addEventListener('change', mmOdswiezLokFormularz);
el('mm-f-zrodlo').addEventListener('input', () => aktualizujPozostanie('mm-f-zrodlo', 'mm-f-ilosc', 'mm-f-pozostanie'));
el('mm-f-ilosc').addEventListener('input', () => aktualizujPozostanie('mm-f-zrodlo', 'mm-f-ilosc', 'mm-f-pozostanie'));

el('btn-mm-anuluj').addEventListener('click', () => {
  el('mm-formularz').classList.add('hidden');
  mmWybranyProdukt = null;
});

el('btn-mm-dodaj').addEventListener('click', () => {
  if (!mmWybranyProdukt) return;
  const { zrodlo, cel } = mmParsujKierunek(el('mm-kierunek').value);
  const ilosc = Number(el('mm-f-ilosc').value);
  if (!ilosc || ilosc <= 0) return;

  let lokZrodloId = null, lokZrodloKod = null;
  let lokCelId = null, lokCelKod = null;

  if (mmCzyWms(zrodlo)) {
    const id = lokComboId(el('mm-f-zrodlo'));
    if (!id) { alert('Wybierz prawidłową lokalizację źródłową z listy.'); return; }
    lokZrodloId = id;
    lokZrodloKod = el('mm-f-zrodlo').value.trim();
  }
  if (mmCzyWms(cel)) {
    const id = lokComboId(el('mm-f-cel'));
    if (!id) { alert('Wybierz prawidłową lokalizację docelową z listy.'); return; }
    lokCelId = id;
    lokCelKod = el('mm-f-cel').value.trim();
  }

  mmLista.push({
    artykul_gt_id: mmWybranyProdukt.artykul_gt_id,
    symbol: mmWybranyProdukt.symbol,
    nazwa: mmWybranyProdukt.nazwa,
    ean: mmWybranyProdukt.ean ?? null,
    zrodloMag: zrodlo,
    celMag: cel,
    lokZrodloId,
    lokZrodloKod,
    lokCelId,
    lokCelKod,
    ilosc,
  });
  mmRenderujTabele();
  el('mm-formularz').classList.add('hidden');
  mmWybranyProdukt = null;
});

el('btn-mm-wyczysc').addEventListener('click', () => {
  mmLista = [];
  mmRenderujTabele();
  el('mm-wyniki-wysylki').innerHTML = '';
});

el('btn-mm-wyslij').addEventListener('click', async () => {
  if (mmLista.length === 0) return;
  const btnWyslij = el('btn-mm-wyslij');
  btnWyslij.disabled = true;

  const listaDiv = el('mm-wyniki-wysylki');
  listaDiv.innerHTML = '<div class="mm-wyniki-lista"></div>';
  const listaEl = listaDiv.firstChild;

  const kopia = [...mmLista];
  const wynikWiersze = kopia.map((p, i) => {
    const div = document.createElement('div');
    div.className = 'mm-wynik-wiersz pending';
    div.textContent = `[${i + 1}] ${p.symbol} × ${p.ilosc} (${p.zrodloMag} → ${p.celMag}) – oczekuje…`;
    listaEl.appendChild(div);
    return div;
  });

  let bledy = 0;
  for (let i = 0; i < kopia.length; i++) {
    const p = kopia[i];
    const { url, body } = mmBudujPayload({
      artykul_gt_id: p.artykul_gt_id, symbol: p.symbol, nazwa: p.nazwa, ean: p.ean,
      zrodloMag: p.zrodloMag, celMag: p.celMag, lokZrodloId: p.lokZrodloId, lokCelId: p.lokCelId, ilosc: p.ilosc,
    });
    try {
      const wynik = await api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const stan = wynik.status === 'ok' ? 'ok' : 'pending';
      wynikWiersze[i].className = `mm-wynik-wiersz ${stan}`;
      wynikWiersze[i].textContent = `[${i + 1}] ${p.symbol} × ${p.ilosc} – ${stan === 'ok' ? `OK (${wynik.dok_gt_numer ?? 'brak nr dok.'})` : `oczekuje: ${wynik.blad_opis ?? ''}` }`;
      if (stan !== 'ok') bledy++;
    } catch (err) {
      wynikWiersze[i].className = 'mm-wynik-wiersz blad';
      wynikWiersze[i].textContent = `[${i + 1}] ${p.symbol} × ${p.ilosc} – BŁĄD: ${err.message}`;
      bledy++;
    }
  }

  mmLista = [];
  mmRenderujTabele();
  btnWyslij.disabled = false;
  if (bledy === 0) pokazKomunikat('Wszystkie ruchy wysłane pomyślnie.', 'ok');
  else pokazKomunikat(`${bledy} z ${kopia.length} ruchów wymaga uwagi (pending/błąd).`, 'info');
});

// === MODAL PRODUKTU (edytowalny rozklad po magazynach) ===

const MAG_LABEL = { K4: 'K4 Hala', K4G: 'K4 Góra', MAG: 'Kajtek (MAG)', LS: 'Leszno (LS)' };
const MAG_EXT = ['MAG', 'LS'];

let modalProdukt = null;
let modalAkcjaCtx = null;

let modalHeartbeat = null;

async function otworzModalProdukt(p) {
  // TWARDA BLOKADA: zajmij lock edycji produktu. 409 = edytuje kto inny -> nie otwieramy.
  try {
    await api(`/api/blokady/${encodeURIComponent(p.artykul_gt_id)}/zajmij`, { method: 'POST' });
  } catch (err) {
    if (err.status === 409) {
      pokazKomunikat(`Produkt ${p.symbol} edytuje ${err.dane?.przez ?? 'ktoś inny'} — spróbuj później.`, 'blad');
      return;
    }
    // inny blad (np. sesja wygasla) - pokaz i nie otwieraj
    pokazKomunikat(err.message, 'blad');
    return;
  }
  modalProdukt = p;
  el('modal-produkt').classList.remove('hidden');
  el('modal-prod-sku').textContent = p.symbol;
  el('modal-prod-nazwa').textContent = p.nazwa;
  zamknijAkcje();
  el('modal-komunikat').className = 'komunikat hidden';
  renderModalRozklad();
  // odswiezaj lock co 30s, dopoki modal otwarty
  modalHeartbeat = setInterval(() => {
    api(`/api/blokady/${encodeURIComponent(p.artykul_gt_id)}/heartbeat`, { method: 'POST' }).catch(() => {});
  }, 30000);
}

function zamknijModal() {
  if (modalHeartbeat) { clearInterval(modalHeartbeat); modalHeartbeat = null; }
  if (modalProdukt) {
    api(`/api/blokady/${encodeURIComponent(modalProdukt.artykul_gt_id)}/zwolnij`, { method: 'POST' }).catch(() => {});
  }
  el('modal-produkt').classList.add('hidden');
  modalProdukt = null;
}

el('btn-modal-zamknij').addEventListener('click', zamknijModal);
el('btn-modal-historia').addEventListener('click', () => {
  if (modalProdukt) otworzHistorie(modalProdukt.artykul_gt_id, modalProdukt.symbol);
});
el('modal-produkt').addEventListener('click', (e) => {
  if (e.target === el('modal-produkt')) zamknijModal();
});

function modalAktualizujStany() {
  const st = modalProdukt.zgodnosc?.ogolna ?? '–';
  el('modal-prod-stany').innerHTML = `Status: <span class="badge ${ZGODNOSC_BADGE[st] ?? 'badge-neutral'}">${st}</span>`;
}

// Odswiezenie danych produktu z API (stany GT moga sie zmienic po MM)
async function odswiezModalProdukt() {
  try {
    const { produkty } = await api(`/api/produkty?q=${encodeURIComponent(modalProdukt.symbol)}&limit=10`);
    const p = produkty.find((x) => String(x.artykul_gt_id) === String(modalProdukt.artykul_gt_id));
    if (p) modalProdukt = p;
  } catch { /* zostaw stare dane */ }
}

async function renderModalRozklad() {
  if (!modalProdukt) return;
  const cont = el('modal-rozklad');
  cont.innerHTML = '<p class="hint">Ładuję…</p>';

  await odswiezModalProdukt();
  modalAktualizujStany();

  // lokalizacje WMS z zapasem + stale miejsce K4 (tez puste, ilosc 0) + zapas_kod
  let loki = [];
  try {
    const dane = await api(`/api/lokalizacje/artykul/${encodeURIComponent(modalProdukt.symbol)}`);
    loki = dane.lokalizacje;
  } catch { loki = []; }
  let k4Zapas = null;
  try {
    const dom = await api(`/api/lokalizacje/k4-dom/${modalProdukt.artykul_gt_id}`);
    if (dom && dom.kod) {
      k4Zapas = dom.zapas_kod ?? null;
      if (!loki.some((l) => l.magazyn === 'K4' && l.kod === dom.kod)) {
        loki.push({ lokalizacja_id: dom.lokalizacja_id, kod: dom.kod, magazyn: 'K4', ilosc: dom.ilosc, ostatnia_zmiana: dom.ostatnia_zmiana });
      }
    }
  } catch { /* brak stalego miejsca */ }

  // lista lokalizacji K4 do podpowiedzi w polu "zapas" (mozna tez wpisac wlasna)
  try {
    const k4all = await api('/api/lokalizacje?magazyn=K4&aktywna=1');
    const dl = el('zapas-lok-list');
    dl.innerHTML = '';
    for (const lk of k4all) {
      const o = document.createElement('option');
      o.value = lk.kod;
      dl.appendChild(o);
    }
  } catch { /* podpowiedzi opcjonalne */ }

  // Plan lokalizacji z GT (K4 i K4G) - zachowany do pelnego przypisania (zeby przy
  // rozkladaniu np. 3 lokalizacji nie zgubic pozostalych po nadpisaniu pola GT).
  const planK4 = await pobierzPlan('K4', loki);
  const planK4g = await pobierzPlan('K4G', loki);

  const tabela = document.createElement('table');
  tabela.className = 'tabela tabela-zagniezdzona rozklad-tabela';
  tabela.innerHTML = '<thead><tr><th>Magazyn</th><th>Stan</th><th>Lokalizacja</th><th>Zapas</th><th></th><th>Ost. edycja</th></tr></thead>';
  const tbody = document.createElement('tbody');

  dodajMagWms(tbody, 'K4', loki, k4Zapas, planK4);
  dodajMagWms(tbody, 'K4G', loki, k4Zapas, planK4g);
  for (const mag of ['MAG', 'LS']) dodajMagZewn(tbody, mag);

  // podsumowania na dole
  const rezRazem = ['K4', 'K4G', 'MAG', 'LS'].reduce((s, m) => s + (modalProdukt.stany_gt?.[m]?.rezerwacja ?? 0), 0);
  tbody.appendChild(wierszPodsumowania('Razem', modalProdukt.razem ?? '', 'rozklad-total'));
  if (rezRazem > 0) tbody.appendChild(wierszPodsumowania('Rezerwacje', rezRazem, 'rozklad-total'));

  tabela.appendChild(tbody);
  cont.innerHTML = '';
  cont.appendChild(tabela);
}

function przyciskAkcji(label, onClick, primary) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn btn-small' + (primary ? ' btn-primary' : '');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

// Plan lokalizacji z GT (K4/K4G): gdy cos jest nieprzypisane - przy pierwszym
// otwarciu (zanim WMS nadpisze pole GT) zapamietujemy oryginalny tekst lokalizacji
// GT i pokazujemy go jako sciage. Gdy wszystko zlokalizowane - czyscimy plan.
async function pobierzPlan(mag, loki) {
  const id = modalProdukt.artykul_gt_id;
  const gtStan = modalProdukt.stany_gt?.[mag]?.ilosc ?? 0;
  const wmsSum = loki.filter((l) => l.magazyn === mag).reduce((s, l) => s + l.ilosc, 0);
  const niezlok = Math.max(gtStan - wmsSum, 0);
  const tekstGt = mag === 'K4' ? modalProdukt.lokalizacja_k4_gt : modalProdukt.lokalizacja_k4g_gt;
  try {
    if (niezlok <= 0) {
      await api(`/api/lokalizacje/plan/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ magazyn: mag, tekst: '' }) });
      return null;
    }
    const plan = await api(`/api/lokalizacje/plan/${id}?magazyn=${mag}`);
    if (plan && plan.tekst) return plan.tekst;
    if (tekstGt) {
      await api(`/api/lokalizacje/plan/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ magazyn: mag, tekst: tekstGt }) });
      return tekstGt;
    }
  } catch { /* plan opcjonalny */ }
  return null;
}

function komorka(tekst, cls) {
  const td = document.createElement('td');
  if (tekst !== undefined && tekst !== null && tekst !== '') td.textContent = tekst;
  if (cls) td.className = cls;
  return td;
}

function wierszPodsumowania(etykieta, wartosc, cls) {
  const tr = document.createElement('tr');
  tr.className = cls;
  tr.appendChild(komorka(etykieta));
  tr.appendChild(komorka(wartosc));
  const reszta = document.createElement('td');
  reszta.colSpan = 4;
  tr.appendChild(reszta);
  return tr;
}

function dataEdycji(s) {
  return s ? s.slice(0, 10) : '';
}

// Klucz naturalnej kolejnosci kodu lokalizacji (jak w pliku mapy): hala (1 przed M2),
// regal A..L, kolumna NUMERYCZNIE, poziom. Kody spoza wzorca (RB, BIURO) na koniec.
function kluczKoduLok(kod) {
  const m = String(kod ?? '').toUpperCase().match(/^(M2-)?([A-L])(\d{1,2})(?:-P([1-6]))?$/);
  if (!m) return [2, '', 0, 0, String(kod ?? '')]; // "inny" (RB, BIURO) na koniec
  return [m[1] ? 1 : 0, m[2], Number(m[3]), m[4] ? Number(m[4]) : 0, ''];
}
function porownajKodLok(a, b) {
  const ka = kluczKoduLok(a), kb = kluczKoduLok(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
}

function dodajMagWms(tbody, mag, loki, k4Zapas, planTekst) {
  const gt = modalProdukt.stany_gt?.[mag] ?? { ilosc: 0, rezerwacja: 0 };
  const wmsLoki = loki.filter((l) => l.magazyn === mag).sort((a, b) => porownajKodLok(a.kod, b.kod));
  const wmsSum = wmsLoki.reduce((s, l) => s + l.ilosc, 0);
  const niezlok = Math.max(gt.ilosc - wmsSum, 0);
  let rezPokazana = false;

  for (const l of wmsLoki) {
    const tr = document.createElement('tr');
    tr.appendChild(komorka(mag));

    // stan z rezerwacja (na poziomie magazynu) - pokazana raz, przy pierwszym wierszu
    const stanTxt = (!rezPokazana && gt.rezerwacja) ? `${l.ilosc}(${gt.rezerwacja})` : String(l.ilosc);
    rezPokazana = true;
    tr.appendChild(komorka(stanTxt));

    // Lokalizacja - klik = inline zmiana lokalizacji (LOK, cala ilosc, ten sam magazyn)
    const tdLok = komorka(l.kod);
    if (l.ilosc > 0) {
      tdLok.classList.add('rozklad-lok-edyt');
      tdLok.title = 'Kliknij, aby zmienić lokalizację (przenosi całą ilość)';
      tdLok.addEventListener('click', () => edytujLokalizacjeInline(tdLok, l, mag));
    }
    tr.appendChild(tdLok);

    // kolumna Zapas - edytowalna tylko dla K4 (decyzja A); inaczej pusto
    const tdZapas = document.createElement('td');
    if (mag === 'K4') {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'rozklad-zapas-input';
      inp.setAttribute('list', 'zapas-lok-list');
      inp.autocomplete = 'off';
      inp.value = k4Zapas ?? '';
      inp.placeholder = '—';
      inp.title = 'Nadmiar w innym miejscu na K4 (w GT zapis jako zbiór/zapas)';
      inp.addEventListener('change', () => zapiszZapas(inp.value));
      tdZapas.appendChild(inp);
    }
    tr.appendChild(tdZapas);

    const tdA = document.createElement('td');
    const btn = przyciskAkcji('Przenieś', () => otworzAkcje({ typ: 'wms', zrodloMag: mag, zrodloLokId: l.lokalizacja_id, zrodloKod: l.kod, dostepne: l.ilosc }));
    btn.disabled = l.ilosc <= 0;
    tdA.appendChild(btn);
    tr.appendChild(tdA);

    tr.appendChild(komorka(dataEdycji(l.ostatnia_zmiana)));
    tbody.appendChild(tr);
  }

  if (niezlok > 0) {
    const tr = document.createElement('tr');
    tr.className = 'rozklad-nieprzypisano';
    tr.appendChild(komorka(mag));
    tr.appendChild(komorka(niezlok));
    // Lokalizacja: "(nieprzypisano)" + plan z GT (sciaga gdzie rozlozyc), gdy jest
    const tdLok = document.createElement('td');
    tdLok.textContent = '(nieprzypisano)';
    if (planTekst) {
      const p = document.createElement('div');
      p.className = 'rozklad-plan';
      p.textContent = `wg GT: ${planTekst}`;
      p.title = 'Plan lokalizacji z GT - zachowany do pełnego przypisania';
      tdLok.appendChild(p);
    }
    tr.appendChild(tdLok);
    tr.appendChild(komorka());
    const tdA = document.createElement('td');
    tdA.appendChild(przyciskAkcji('Przypisz', () => otworzAkcje({ typ: 'gt', zrodloMag: mag, zrodloLokId: null, zrodloKod: null, dostepne: niezlok }), true));
    tr.appendChild(tdA);
    tr.appendChild(komorka());
    tbody.appendChild(tr);
  }

  if (wmsLoki.length === 0 && niezlok === 0) {
    const tr = document.createElement('tr');
    tr.appendChild(komorka(mag));
    tr.appendChild(komorka(0));
    const reszta = document.createElement('td');
    reszta.colSpan = 4;
    reszta.className = 'rozklad-puste';
    reszta.textContent = 'brak stanu';
    tr.appendChild(reszta);
    tbody.appendChild(tr);
  }

  // podsumowanie magazynu (gdy >1 lokalizacja albo jest niezlokalizowany zapas)
  if (wmsLoki.length > 1 || niezlok > 0) {
    const tr = document.createElement('tr');
    tr.className = 'rozklad-subtotal';
    tr.appendChild(komorka(`${mag} razem`));
    const tdSum = komorka(wmsSum);
    if (wmsSum !== gt.ilosc) { tdSum.classList.add('rozklad-niezg'); tdSum.textContent = `${wmsSum}/${gt.ilosc}`; }
    tr.appendChild(tdSum);
    const reszta = document.createElement('td');
    reszta.colSpan = 4;
    tr.appendChild(reszta);
    tbody.appendChild(tr);
  }
}

function dodajMagZewn(tbody, mag) {
  const gt = modalProdukt.stany_gt?.[mag] ?? { ilosc: 0, rezerwacja: 0 };
  const tr = document.createElement('tr');
  tr.appendChild(komorka(mag));
  tr.appendChild(komorka(gt.rezerwacja ? `${gt.ilosc}(${gt.rezerwacja})` : String(gt.ilosc)));
  const tdInfo = komorka('magazyn zewnętrzny', 'rozklad-puste');
  tdInfo.colSpan = 2;
  tr.appendChild(tdInfo);
  const tdA = document.createElement('td');
  if (gt.ilosc > 0) tdA.appendChild(przyciskAkcji('Przenieś', () => otworzAkcje({ typ: 'ext', zrodloMag: mag, zrodloLokId: null, zrodloKod: null, dostepne: gt.ilosc })));
  tr.appendChild(tdA);
  tr.appendChild(komorka());
  tbody.appendChild(tr);
}

// Inline zmiana lokalizacji w tabeli rozkladu: klik w komorke -> combo z lokalizacjami
// tego samego magazynu -> wybor -> LOK (cala ilosc wiersza ze starej na nowa lokalizacje).
function edytujLokalizacjeInline(td, l, mag) {
  td.classList.remove('rozklad-lok-edyt');
  td.textContent = '';
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.id = 'inline-lok';
  inp.className = 'lok-combo rozklad-lok-input';
  inp.setAttribute('list', 'inline-lok-list');
  inp.autocomplete = 'off';
  td.appendChild(inp);

  mmZaladujLokCel(inp, null, mag).then(() => { inp.value = l.kod; inp.focus(); });

  let zakonczone = false;
  const zakoncz = async (zatwierdz) => {
    if (zakonczone) return;
    if (zatwierdz) {
      const wpisane = inp.value.trim();
      const nowyId = lokComboId(inp);
      if (nowyId && nowyId !== l.lokalizacja_id) {
        zakonczone = true;
        await wykonajZmianeLok(l, nowyId);
        return;
      }
      // wpisano kod, ktorego nie ma na liscie lokalizacji (i to nie jest obecna)
      if (wpisane && wpisane !== l.kod && !nowyId) {
        zakonczone = true;
        pokazKomunikatEl('modal-komunikat', `Lokalizacja „${wpisane}" nie istnieje w systemie — dodaj ją w panelu Lokalizacje.`, 'blad');
        await renderModalRozklad();
        return;
      }
    }
    renderModalRozklad(); // brak zmiany / anulowanie -> przywroc widok
  };
  inp.addEventListener('change', () => zakoncz(true));
  inp.addEventListener('blur', () => setTimeout(() => zakoncz(true), 150));
  inp.addEventListener('keydown', (e) => { if (e.key === 'Escape') zakoncz(false); });
}

async function wykonajZmianeLok(l, lokCelId) {
  try {
    const wynik = await api('/api/ruchy/lok', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        artykul_gt_id: modalProdukt.artykul_gt_id, lok_zrodlo_id: l.lokalizacja_id, lok_cel_id: lokCelId,
        ilosc: l.ilosc, operator: operator(), artykul_symbol: modalProdukt.symbol, artykul_nazwa: modalProdukt.nazwa,
      }),
    });
    const ok = wynik.status === 'ok';
    pokazKomunikatEl('modal-komunikat', ok ? 'Lokalizacja zmieniona.' : `Zapisano, oczekuje: ${wynik.blad_opis ?? ''}`, ok ? 'ok' : 'info');
  } catch (err) {
    pokazKomunikatEl('modal-komunikat', err.message, 'blad');
  }
  await renderModalRozklad();
  odswiezProdukty();
}

// Zapis adnotacji "zapas" K4 (decyzja A) - PUT, potem odswiezenie
async function zapiszZapas(val) {
  if (!modalProdukt) return;
  try {
    await api(`/api/lokalizacje/k4-zapas/${modalProdukt.artykul_gt_id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ zapas_kod: val }),
    });
    pokazKomunikatEl('modal-komunikat', 'Zapisano zapas K4.', 'ok');
    await renderModalRozklad();
    odswiezProdukty();
  } catch (err) {
    pokazKomunikatEl('modal-komunikat', err.message, 'blad');
  }
}

// --- panel akcji (przenies / zmien lok / przypisz) ---

function otworzAkcje(ctx) {
  modalAkcjaCtx = ctx;
  el('modal-akcja-komunikat').className = 'komunikat hidden';
  el('modal-akcja-overlay').classList.remove('hidden');

  // naglowek: typ akcji + (SKU nazwa — z zrodlo)
  el('modal-akcja-typ').textContent = ctx.typ === 'gt' ? 'Przypisz' : 'Przenieś';
  let zrodloTxt;
  if (ctx.typ === 'gt') zrodloTxt = `z puli „nieprzypisano" (${MAG_LABEL[ctx.zrodloMag]})`;
  else if (ctx.typ === 'ext') zrodloTxt = `z ${MAG_LABEL[ctx.zrodloMag]}`;
  else zrodloTxt = `z ${ctx.zrodloKod} (${MAG_LABEL[ctx.zrodloMag]})`;
  el('modal-akcja-tytul').innerHTML = `<strong>${modalProdukt.symbol}</strong> ${modalProdukt.nazwa} <span class="modal-akcja-zrodlo">${zrodloTxt}</span>`;

  el('modal-akcja-ile').value = ctx.dostepne || 1;

  const magSel = el('modal-akcja-magazyn');
  if (ctx.typ === 'gt') {
    // przypisanie tylko w obrębie tego samego magazynu WMS
    magSel.value = ctx.zrodloMag;
    magSel.disabled = true;
  } else {
    magSel.disabled = false;
    // domyslny cel: przesuniecie miedzy K4 a K4G (uzupelnianie/odkladanie).
    // z K4 -> K4G, z K4G -> K4, z zewnetrznego -> K4G.
    if (ctx.typ === 'ext') magSel.value = 'K4G';
    else magSel.value = ctx.zrodloMag === 'K4' ? 'K4G' : 'K4';
  }

  akcjaOdswiezCel();
}

function zamknijAkcje() {
  modalAkcjaCtx = null;
  el('modal-akcja-overlay').classList.add('hidden');
}

el('btn-modal-akcja-x').addEventListener('click', zamknijAkcje);
el('modal-akcja-overlay').addEventListener('click', (e) => {
  if (e.target === el('modal-akcja-overlay')) zamknijAkcje();
});

async function akcjaOdswiezCel() {
  if (!modalAkcjaCtx) return;
  const celMag = el('modal-akcja-magazyn').value;
  await mmZaladujLokCel(el('modal-akcja-lok'), el('modal-akcja-lok-brak'), celMag);
  if (mmCzyWms(celMag)) await mmUstawCelK4(el('modal-akcja-lok'), null, celMag, modalProdukt);
  akcjaPozostanie();
}

function akcjaPozostanie() {
  const span = el('modal-akcja-pozostanie');
  const stan = modalAkcjaCtx?.dostepne ?? 0;
  const ile = Number(el('modal-akcja-ile').value);
  const pozostanie = stan - (Number.isFinite(ile) ? ile : 0);
  span.textContent = `Na źródle: ${stan} → pozostanie: ${pozostanie}`;
  span.classList.toggle('pozostanie-blad', pozostanie < 0);
  span.classList.remove('hidden');
}

el('modal-akcja-magazyn').addEventListener('change', akcjaOdswiezCel);
el('modal-akcja-ile').addEventListener('input', akcjaPozostanie);
el('btn-modal-akcja-anuluj').addEventListener('click', zamknijAkcje);

el('btn-modal-akcja-wykonaj').addEventListener('click', async () => {
  if (!modalAkcjaCtx || !modalProdukt) return;
  const ctx = modalAkcjaCtx;
  const celMag = el('modal-akcja-magazyn').value;
  const ile = Number(el('modal-akcja-ile').value);
  if (!ile || ile <= 0) return;
  if (ile > ctx.dostepne) { pokazKomunikatEl('modal-akcja-komunikat', `Najwyżej ${ctx.dostepne} szt. dostępne na źródle.`, 'blad'); return; }
  if (ctx.typ === 'ext' && celMag === ctx.zrodloMag) { pokazKomunikatEl('modal-akcja-komunikat', 'Wybierz inny magazyn docelowy.', 'blad'); return; }

  // lokalizacja docelowa (gdy cel jest magazynem WMS)
  let lokCelId = null;
  if (mmCzyWms(celMag)) {
    lokCelId = lokComboId(el('modal-akcja-lok'));
    if (!lokCelId) { pokazKomunikatEl('modal-akcja-komunikat', 'Wybierz prawidłową lokalizację docelową z listy.', 'blad'); return; }
  }
  if (ctx.typ === 'wms' && celMag === ctx.zrodloMag && lokCelId === ctx.zrodloLokId) {
    pokazKomunikatEl('modal-akcja-komunikat', 'Lokalizacja docelowa jest taka sama jak źródłowa.', 'blad'); return;
  }

  // dobór operacji: w obrębie magazynu WMS / przypisanie z GT -> LOK; między magazynami -> MM
  let url, body;
  if (ctx.typ === 'gt') {
    url = '/api/ruchy/lok';
    body = { artykul_gt_id: modalProdukt.artykul_gt_id, lok_zrodlo_id: null, lok_cel_id: lokCelId, ilosc: ile,
             operator: operator(), artykul_symbol: modalProdukt.symbol, artykul_nazwa: modalProdukt.nazwa };
  } else if (ctx.typ === 'wms' && celMag === ctx.zrodloMag) {
    url = '/api/ruchy/lok';
    body = { artykul_gt_id: modalProdukt.artykul_gt_id, lok_zrodlo_id: ctx.zrodloLokId, lok_cel_id: lokCelId, ilosc: ile,
             operator: operator(), artykul_symbol: modalProdukt.symbol, artykul_nazwa: modalProdukt.nazwa };
  } else {
    ({ url, body } = mmBudujPayload({
      artykul_gt_id: modalProdukt.artykul_gt_id, symbol: modalProdukt.symbol, nazwa: modalProdukt.nazwa, ean: modalProdukt.ean ?? null,
      zrodloMag: ctx.zrodloMag, celMag, lokZrodloId: ctx.zrodloLokId, lokCelId, ilosc: ile,
    }));
  }

  const btn = el('btn-modal-akcja-wykonaj');
  btn.disabled = true;
  try {
    const wynik = await api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const ok = wynik.status === 'ok';
    pokazKomunikatEl('modal-komunikat', ok ? `Wykonano${wynik.dok_gt_numer ? ` (${wynik.dok_gt_numer})` : ''}.` : `Zapisano, oczekuje GT: ${wynik.blad_opis ?? ''}`, ok ? 'ok' : 'info');
    zamknijAkcje();
    await renderModalRozklad();
    odswiezProdukty();
  } catch (err) {
    pokazKomunikatEl('modal-akcja-komunikat', err.message, 'blad');
  } finally {
    btn.disabled = false;
  }
});

// === UZUPELNIENIA K4 ===

// Kolejnosc kanalow spojna z serwerem (services/kanaly.js).
const UZUP_KANALY = [
  'DHL Connect', 'InPost', 'DPD', 'DHL', 'UPS', 'One',
  'Orlen Paczka', 'Poczta Polska', 'Packeta', 'Emag', 'nieklasyfikowane',
];

let uzupDane = []; // ostatnio pobrana lista (filtr kanalu dziala bez ponownego fetcha)

// Wypelnia select kanalu raz (opcje poza domyslnym "Wszystkie").
function uzupWypelnijKanaly() {
  const sel = el('uzup-kanal');
  if (sel.options.length > 1) return;
  for (const k of UZUP_KANALY) {
    const opt = document.createElement('option');
    opt.value = k;
    opt.textContent = k;
    sel.appendChild(opt);
  }
}

async function odswiezUzupelnienia() {
  uzupWypelnijKanaly();
  try {
    const { pozycje } = await api('/api/uzupelnienia');
    uzupDane = pozycje;
    renderujUzupelnienia();
  } catch (err) {
    pokazKomunikat(err.message, 'blad');
  }
}

// Renderuje liste z biezacym filtrem kanalu (klient-side na uzupDane).
function renderujUzupelnienia() {
  const kanal = el('uzup-kanal').value;
  let lista = uzupDane;
  if (kanal) {
    // tylko towary z rezerwacja w wybranym kanale; najpilniejsze (najwiecej w kanale) na gorze
    lista = uzupDane.filter((p) => (p.kanaly[kanal] || 0) > 0)
      .sort((a, b) => (b.kanaly[kanal] || 0) - (a.kanaly[kanal] || 0));
  }

  const tbody = el('uzup-tbody');
  tbody.innerHTML = '';
  el('uzup-brak').classList.toggle('hidden', lista.length > 0);
  el('uzup-licznik').textContent = kanal
    ? `${lista.length} towarów w kanale „${kanal}"`
    : `${lista.length} towarów do uzupełnienia`;

  for (const p of lista) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${p.symbol}</strong></td>
      <td class="opis">${p.nazwa ?? ''}</td>
      <td>${p.lokalizacja_gora ?? '–'}</td>
      <td>${p.lokalizacja_k4 ?? '–'}</td>
      <td>${p.stan_gora}</td>
      <td>${p.stan_k4}</td>
      <td><strong>${p.rezerwacje}</strong></td>
      <td>${p.dostepnosc}</td>
      <td>${uzupChipsKanalow(p.kanaly, kanal)}</td>
      <td class="td-akcja"><button class="btn btn-small uzup-edytuj" type="button">Edytuj</button></td>
    `;
    // ten sam modal co w Produktach (rozklad lokalizacji + akcje); modal sam dociaga
    // pelny produkt (stany_gt/zgodnosc) przez odswiezModalProdukt po artykul_gt_id
    tr.querySelector('.uzup-edytuj').addEventListener('click', () => otworzModalProdukt(p));
    tbody.appendChild(tr);
  }
}

// Chipy "kanal: ilosc" posortowane malejaco; wybrany kanal wyrozniony, reszta przygaszona.
function uzupChipsKanalow(kanaly, wybrany) {
  const wpisy = Object.entries(kanaly).sort((a, b) => b[1] - a[1]);
  if (wpisy.length === 0) return '<span class="opis">–</span>';
  return wpisy.map(([k, ilosc]) => {
    let klasa = k === 'nieklasyfikowane' ? 'badge-neutral' : 'badge-info';
    if (wybrany && k === wybrany) klasa = 'badge-ok';
    return `<span class="badge ${klasa}" style="margin:0 .2rem .2rem 0">${k}: ${ilosc}</span>`;
  }).join('');
}

el('btn-uzup-odswiez').addEventListener('click', odswiezUzupelnienia);
el('uzup-kanal').addEventListener('change', renderujUzupelnienia);

// --- init ---

pokazPanel(panelZHasha());
