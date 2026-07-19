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
  pulpit: { sekcja: 'panel-pulpit', zaladowano: false, odswiez: odswiezPulpit },
  produkty: { sekcja: 'panel-produkty', zaladowano: false, odswiez: odswiezProdukty },
  rozjazdy: { sekcja: 'panel-rozjazdy', zaladowano: false, odswiez: odswiezRozjazdy },
  lokalizacje: { sekcja: 'panel-lokalizacje', zaladowano: false, odswiez: odswiezLokalizacje },
  mm: { sekcja: 'panel-mm', zaladowano: false, odswiez: () => {} },
  uzupelnienia: { sekcja: 'panel-uzupelnienia', zaladowano: false, odswiez: odswiezUzupelnienia },
  zwroty: { sekcja: 'panel-zwroty', zaladowano: false, odswiez: odswiezZwroty },
  dostawy: { sekcja: 'panel-dostawy', zaladowano: false, odswiez: odswiezDostawy },
  'do-sprawdzenia': { sekcja: 'panel-do-sprawdzenia', zaladowano: false, odswiez: odswiezDoSprawdzenia },
  zestawienia: { sekcja: 'panel-zestawienia', zaladowano: false, odswiez: odswiezZestawienia },
  sciezki: { sekcja: 'panel-sciezki', zaladowano: false, odswiez: odswiezRaporty },
  log: { sekcja: 'panel-log', zaladowano: false, odswiez: odswiezLog },
  uzytkownicy: { sekcja: 'panel-uzytkownicy', zaladowano: false, odswiez: odswiezUzytkownicy },
};

// Grupa "Ruchy" - jedna pozycja w nawigacji, cztery osobne panele pod spodem. Trzymamy je
// jako oddzielne sekcje (a nie jeden panel z przelaczana trescia), bo istnialy wczesniej i
// kazdy ma swoj stan; grupa dokłada tylko warstwe nawigacji.
// Kolejnosc = kolejnosc podzakladek w index.html, od najczestszej pracy do najrzadszej;
// pierwszy jest domyslny (wejscie na sam #ruchy).
const GRUPY = { ruchy: { domyslny: 'uzupelnienia', panele: ['uzupelnienia', 'dostawy', 'do-sprawdzenia', 'rozjazdy', 'mm'] } };

// panel -> grupa, do zaznaczania wlasciwej zakladki glownej i pokazania paska podzakladek
const GRUPA_PANELU = Object.fromEntries(
  Object.entries(GRUPY).flatMap(([g, def]) => def.panele.map((p) => [p, g]))
);

function pokazPanel(nazwa, pod) {
  if (!panele[nazwa]) nazwa = 'pulpit';
  // wejscie na sama grupe (#ruchy) - pokaz jej domyslny panel
  if (GRUPY[nazwa]) nazwa = GRUPY[nazwa].domyslny;

  for (const [klucz, p] of Object.entries(panele)) {
    el(p.sekcja).classList.toggle('hidden', klucz !== nazwa);
  }

  // Zakladka glowna: dla panelu w grupie podswietlamy GRUPE, nie panel (panel nie ma
  // wlasnej pozycji w nawigacji).
  const glowna = GRUPA_PANELU[nazwa] ?? nazwa;
  document.querySelectorAll('.tab-link').forEach((btn) => {
    btn.classList.toggle('aktywny', btn.dataset.panel === glowna);
  });

  // Pasek podzakladek Ruchow - widoczny tylko wewnatrz grupy
  const pasek = el('podzakladki-ruchy');
  pasek.classList.toggle('hidden', GRUPA_PANELU[nazwa] !== 'ruchy');
  pasek.querySelectorAll('.podzakladka').forEach((a) => {
    a.classList.toggle('aktywna', a.dataset.pod === nazwa);
  });

  // Zestawienia to jedna strona - adres #zestawienia/<raport> nie przelacza tresci, tylko
  // wskazuje sekcje do przewiniecia. Zapamietujemy ja tu, bo przewijac mozna dopiero PO
  // zaladowaniu danych (puste tabele maja inne pozycje niz wypelnione).
  if (nazwa === 'zestawienia') zestKotwica = pod ?? null;

  const panel = panele[nazwa];
  if (!panel.zaladowano) {
    panel.zaladowano = true;
    panel.odswiez();                                  // async - przewija samo odswiezZestawienia
  } else if (nazwa === 'zestawienia') {
    przewinDoZestawienia();                           // dane juz sa, przewijamy od razu
  }
}

// Routing po hashu. Format: #panel albo #panel/podzakladka (np. #ruchy/mm, #zestawienia/leszno).
// Zakladki i podzakladki to <a href="#...">, wiec prawy/srodkowy/Cmd-klik otwiera je w nowej
// karcie - a dzieki podzakladce w adresie karta otwiera sie DOKLADNIE tam, gdzie klikales.
function zHasha() {
  const h = decodeURIComponent(location.hash.replace(/^#/, ''));
  const [glowna, pod] = h.split('/');
  // panel w grupie adresujemy przez grupe (#ruchy/mm), ale bezposredni #mm tez ma dzialac -
  // stare linki i zakladki przegladarki nie moga sie psuc
  if (GRUPY[glowna]) {
    const cel = GRUPY[glowna].panele.includes(pod) ? pod : GRUPY[glowna].domyslny;
    return { nazwa: cel, pod: null };
  }
  return { nazwa: panele[glowna] ? glowna : 'pulpit', pod: pod || null };
}

function przejdzZHasha() {
  const { nazwa, pod } = zHasha();
  pokazPanel(nazwa, pod);
}

window.addEventListener('hashchange', przejdzZHasha);

// === PULPIT (Faza 5) ===

// Buduje kafel. wariant -> klasa koloru (red/amber/blue/neutral/ok).
// onKlik opcjonalny: kafel klikalny (kursor + skok do panelu/filtra).
function pulpitKafel({ etykieta, wartosc, podpis, wariant, onKlik }) {
  const div = document.createElement('div');
  div.className = 'kafel' + (wariant ? ' kafel-' + wariant : '') + (onKlik ? ' kafel-klik' : '');
  div.innerHTML = `<div class="kafel-wartosc">${wartosc}</div>`
    + `<div class="kafel-etykieta">${etykieta}</div>`
    + (podpis ? `<div class="kafel-podpis">${podpis}</div>` : '');
  if (onKlik) div.addEventListener('click', onKlik);
  return div;
}

function pulpitWiek(dni) {
  if (dni == null) return '';
  return dni === 0 ? 'najstarszy: dziś' : `najstarszy: ${dni} dni`;
}

// przejscie do Produktow z ustawionym filtrem zgodnosci (BD/t_GT/NZ) i odswiezeniem
function pulpitSkokZgodnosc(kod) {
  document.querySelectorAll('.prod-zgodnosc').forEach((c) => { c.checked = c.value === kod; });
  prodOffset = 0;
  panele.produkty.zaladowano = true; // nie dubluj odswiezenia z pokazPanel
  location.hash = '#produkty';
  odswiezProdukty();
}

function pulpitSkokLog() {
  panele.log.zaladowano = true;
  location.hash = '#log';
  odswiezLog();
}

function renderujPulpitKolejke(d) {
  const cont = el('pulpit-kolejka');
  cont.innerHTML = '';
  const z = d.zaleglosci;
  const kafle = [];

  kafle.push(pulpitKafel({
    etykieta: 'Rozjazdy do wyjaśnienia', wartosc: z.rozjazdy_nowe,
    podpis: z.rozjazdy_nowe ? pulpitWiek(z.rozjazdy_wiek_dni) : 'brak',
    wariant: z.rozjazdy_nowe ? 'amber' : 'ok', onKlik: () => { location.hash = '#rozjazdy'; },
  }));

  // statusy zgodnosci ze snapshotu (moga byc null, gdy job jeszcze nie policzyl / brak GT)
  const s = d.statusy;
  if (s && s.licznik) {
    const L = s.licznik;
    kafle.push(pulpitKafel({ etykieta: 'Do zlokalizowania (t_GT)', wartosc: L.t_GT,
      wariant: L.t_GT ? 'blue' : 'ok', onKlik: () => pulpitSkokZgodnosc('t_GT') }));
    kafle.push(pulpitKafel({ etykieta: 'Niezgodne (NZ)', wartosc: L.NZ,
      wariant: L.NZ ? 'red' : 'ok', onKlik: () => pulpitSkokZgodnosc('NZ') }));
    kafle.push(pulpitKafel({ etykieta: 'Brak danych (BD)', wartosc: L.BD,
      wariant: 'neutral', onKlik: () => pulpitSkokZgodnosc('BD') }));
  } else {
    kafle.push(pulpitKafel({ etykieta: 'Statusy zgodności', wartosc: '…',
      podpis: 'jeszcze nie policzone', wariant: 'neutral' }));
  }

  // Kafle "do zrobienia" ze snapshotu (jak statusy - licza sie z GT raz na godzine).
  // Kazdy klika sie na ZYWA liste, wiec licznik jest wskazowka "czy jest co robic",
  // a nie zrodlem prawdy - ta jest na liscie.
  //
  // null = snapshot nie policzyl (brak GT / job jeszcze nie chodzil) -> "—", NIE zero.
  // Zero znaczy "sprawdzone, nic nie ma" i to zupelnie inna informacja niz "nie wiem".
  const k = d.kafle;
  const kafelZadania = (etykieta, wartosc, hash, wariantGdyJest) => pulpitKafel({
    etykieta,
    wartosc: wartosc == null ? '—' : wartosc,
    podpis: wartosc == null ? 'brak danych' : (wartosc ? 'SKU' : 'nic do zrobienia'),
    wariant: wartosc == null ? 'neutral' : (wartosc ? wariantGdyJest : 'ok'),
    onKlik: () => { location.hash = hash; },
  });
  if (k) {
    kafle.push(kafelZadania('Nadsprzedaż', k.nadsprzedaz, '#zestawienia/nadsprzedaz', 'red'));
    kafle.push(kafelZadania('Dostawy do rozłożenia', k.dostawy, '#ruchy/dostawy', 'amber'));
    kafle.push(kafelZadania('Przywózka do rozłożenia', k.przywozka, '#zestawienia/przywozka', 'amber'));
    kafle.push(kafelZadania('Zwroty do rozłożenia', k.zwroty, '#zwroty', 'amber'));
    // Tylko "nieznany przychod", nie cale "do sprawdzenia" (patrz pulpit-snapshot.js): backlog
    // migracyjny to osobny kafel "Do zlokalizowania (t_GT)" wyzej. Ekran otwiera sie domyslnie
    // na tej samej zakladce, wiec liczba z kafla zgadza sie z tym, co user zobaczy po kliknieciu.
    kafle.push(kafelZadania('Nieznane PW do rozwiązania', k.do_sprawdzenia, '#ruchy/do-sprawdzenia', 'amber'));
    kafle.push(kafelZadania('Do przywiezienia z Leszna', k.leszno, '#zestawienia/leszno', 'blue'));
  }

  kafle.push(pulpitKafel({ etykieta: 'Uzupełnienia K4', wartosc: '→',
    wariant: 'neutral', onKlik: () => { location.hash = '#uzupelnienia'; } }));

  // Stan kolejki technicznej na KONIEC: to diagnostyka ("czy cos sie zacielo"), a nie praca
  // do zrobienia. W normalny dzien oba sa zerem, wiec na poczatku zajmowaly najlepsze miejsce
  // i spychaly w dol kafle, ktore realnie mowia, co robic.
  kafle.push(pulpitKafel({
    etykieta: 'Ruchy z błędem', wartosc: z.ruchy_error,
    podpis: z.ruchy_error ? pulpitWiek(z.ruchy_error_wiek_dni) : 'brak',
    wariant: z.ruchy_error ? 'red' : 'ok', onKlik: pulpitSkokLog,
  }));
  kafle.push(pulpitKafel({
    etykieta: 'Ruchy oczekujące', wartosc: z.ruchy_pending,
    podpis: z.ruchy_pending ? pulpitWiek(z.ruchy_pending_wiek_dni) : 'brak',
    wariant: z.ruchy_pending ? 'amber' : 'ok', onKlik: pulpitSkokLog,
  }));

  kafle.forEach((x) => cont.appendChild(x));
}

function renderujPulpitStan(zajetosc) {
  const cont = el('pulpit-stan');
  cont.innerHTML = '';
  const NAZWY = { K4: 'K4 Hala', K4G: 'K4 Góra' };
  for (const m of zajetosc || []) {
    const pasek = `<div class="kafel-pasek"><span style="width:${m.procent}%"></span></div>`;
    const kafel = pulpitKafel({
      etykieta: `${NAZWY[m.magazyn] || m.magazyn} — zajętość`,
      wartosc: `${m.procent}%`,
      podpis: `${m.zajetych}/${m.aktywnych} · wolnych ${m.wolnych}`,
      wariant: m.procent >= 90 ? 'red' : (m.procent >= 75 ? 'amber' : 'ok'),
    });
    kafel.insertAdjacentHTML('beforeend', pasek);
    cont.appendChild(kafel);
  }
}

function renderujPulpitTrendy(t) {
  const cont = el('pulpit-trendy');
  cont.innerHTML = '';
  if (!t) return;
  cont.appendChild(pulpitKafel({ etykieta: 'Przesunięcia MM', wartosc: t.d7.mm,
    podpis: `dziś ${t.d1.mm} · 30d ${t.d30.mm}`, wariant: 'neutral' }));
  cont.appendChild(pulpitKafel({ etykieta: 'Lokalizowania', wartosc: t.d7.lok,
    podpis: `dziś ${t.d1.lok} · 30d ${t.d30.lok}`, wariant: 'neutral' }));
  cont.appendChild(pulpitKafel({ etykieta: 'Nowe SKU na K4 (7d)', wartosc: t.d7.nowe_sku_k4,
    podpis: `30d ${t.d30.nowe_sku_k4}`, wariant: 'blue' }));
  cont.appendChild(pulpitKafel({ etykieta: 'Napływ do BRK (7d)', wartosc: `${t.d7.brk.szt} szt.`,
    podpis: `30d ${t.d30.brk.szt} szt.`, wariant: t.d7.brk.szt > 0 ? 'amber' : 'ok' }));
}

function renderujPulpitLudzie(ludzie) {
  const tbody = el('pulpit-ludzie-tbody');
  tbody.innerHTML = '';
  el('pulpit-ludzie-brak').classList.toggle('hidden', (ludzie || []).length > 0);
  for (const u of ludzie || []) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><strong>${u.uzytkownik}</strong></td><td>${u.dzis}</td><td>${u.d7}</td>`
      + `<td>${u.mm7}</td><td>${u.lok7}</td><td>${formatDatetime(u.ostatnia)}</td>`;
    tbody.appendChild(tr);
  }
}

// kafel "Twoja aktywnosc" dla zalogowanego uzytkownika (z listy ludzie)
function renderujPulpitMoje(ludzie) {
  const cont = el('pulpit-moje');
  cont.innerHTML = '';
  const imie = (window.WMS && WMS.user() && WMS.user().imie) || null;
  if (!imie) return;
  const moj = (ludzie || []).find((u) => u.uzytkownik === imie);
  cont.appendChild(pulpitKafel({
    etykieta: `Twoja aktywność — ${imie}`,
    wartosc: moj ? moj.dzis : 0,
    podpis: moj ? `operacji dziś · ${moj.d7} w 7 dni` : 'brak operacji dziś',
    wariant: 'blue',
  }));
}

async function odswiezPulpit() {
  const admin = !(window.WMS) || WMS.jestAdmin();
  document.querySelectorAll('.pulpit-admin').forEach((e) => e.classList.toggle('hidden', !admin));

  let d;
  try {
    d = await api('/api/pulpit');
  } catch (err) {
    pokazKomunikat(err.message, 'blad');
    return;
  }

  const czas = el('pulpit-czas');
  const podpisy = [];
  if (d.teraz) podpisy.push('odświeżono ' + new Date(d.teraz).toLocaleTimeString('pl'));
  if (d.statusy && d.statusy.obliczono) {
    podpisy.push('statusy: stan na ' + new Date(d.statusy.obliczono.replace(' ', 'T') + 'Z').toLocaleTimeString('pl'));
  }
  czas.textContent = podpisy.join(' · ');

  renderujPulpitMoje(d.ludzie);
  renderujPulpitKolejke(d);
  renderujPulpitStan(d.zajetosc);
  renderujPulpitTrendy(d.trendy);
  renderujPulpitLudzie(d.ludzie);
}

el('btn-pulpit-odswiez').addEventListener('click', odswiezPulpit);
// przeliczaj role/pulpit po zalogowaniu (badge admina moze przyjsc po pierwszym renderze)
window.addEventListener('wms-zalogowano', () => { if (panele.pulpit.zaladowano) odswiezPulpit(); });

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

  const strefy = zaznaczoneWartosci('.prod-strefa');
  if (strefy.length > 0) params.set('strefa', strefy.join(','));

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

// Komorka "Strefa": co z K4 lezy POZA polka pickowa. Skroty jak na Zebrze/w decyzji usera:
// P=przywozka, D=dostawa, Z=zwrot, NP=nieznany przychod (WMS zna miejsce, stan urosl poza
// naszym obiegiem). Zerowe skladowe pomijamy; pusta strefa = "–". NP dostaje klase, bo to
// jedyna skladowa, ktorej nie widac NIGDZIE indziej (zgodnosc K4 swieci jej OK).
function komorkaStrefa(strefa) {
  if (!strefa) return '–';
  const czesci = [];
  if (strefa.P) czesci.push(`P:${strefa.P}`);
  if (strefa.D) czesci.push(`D:${strefa.D}`);
  if (strefa.Z) czesci.push(`Z:${strefa.Z}`);
  // PW = przyjecie wewnetrzne (przychod Z dokumentem PW). Wyroznione jak dawne NP, bo tez
  // niewidoczne nigdzie indziej - zgodnosc K4 swieci mu OK.
  if (strefa.PW) czesci.push(`<span class="strefa-np">PW:${strefa.PW}</span>`);
  // NP zostaje tylko dla reszty BEZ dokumentu (zwykle 0 - w Subiekcie nie ma zmiany bez dok).
  if (strefa.NP) czesci.push(`<span class="strefa-np" title="reszta bez dokumentu - sprawdz">NP:${strefa.NP}</span>`);
  return czesci.length ? czesci.join(' ') : '–';
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
      <td>${komorkaStan(p.stany_gt, 'BRK')}</td>
      <td>${komorkaStan(p.stany_gt, 'K4R')}</td>
      <td>${p.razem}</td>
      <td>${p.w_zestawach > 0 ? p.w_zestawach : '–'}</td>
      <td class="kol-lok">${wmsK4}</td>
      <td class="kol-strefa">${komorkaStrefa(p.strefa_k4)}</td>
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
document.querySelectorAll('.prod-magazyn, .prod-zgodnosc, .prod-strefa').forEach((cb) => {
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
  MM: 'MM', LOK: 'Zmiana lok.', przypisanie: 'Przypisanie', przyjecie: 'Przyjęcie', rozlozenie: 'Rozłożenie',
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

// historia pojedynczego SKU (zakladka "Historia" w modalu produktu). Lazy-load
// przy pierwszym wejsciu na zakladke (zob. modalPokazTab).
async function renderModalHistoria() {
  const tbody = el('modal-hist-tbody');
  tbody.innerHTML = '';
  try {
    const { wiersze } = await api(`/api/audyt?artykul_gt_id=${encodeURIComponent(modalProdukt.artykul_gt_id)}&limit=500`);
    el('modal-hist-brak').classList.toggle('hidden', wiersze.length > 0);
    for (const r of wiersze) tbody.appendChild(wierszLog(r, { zKolumnamiSku: false }));
  } catch (err) {
    pokazKomunikat(err.message, 'blad');
  }
}

// === SPRAWY (otwarte niezgodnosci ze sciezek - triaz + reczne "Zalatwione") ===
// Zrodlo: raporty obu sciezek (services/routes/sciezki.js). Panel laczy oba w jedna
// liste, sortuje po lokalizacji (kolejnosc obchodu), pozwala domknac sprawe recznie
// ("Zalatwione" - wpis audytu, backend usuwa pare z raportu). NIE robi ruchu WMS.

// Zrodla otwartych spraw. Nie tylko sciezki: zwroty maja ten sam wzorzec zgloszenia i
// domkniecia (/raport + /niezgodnosc/zamknij), wiec siedza w tej samej tabeli zamiast we
// wlasnym, osobnym ekranie do recznego pilnowania.
const SCIEZKI_RAPORTOW = [
  { klucz: 'ostatnie-sztuki', nazwa: 'Ostatnie sztuki', baza: '/api/sciezki/ostatnie-sztuki' },
  { klucz: 'k4-rezerwacja', nazwa: 'K4 pełna rezerwacja', baza: '/api/sciezki/k4-rezerwacja' },
  { klucz: 'zwroty', nazwa: 'Nie znaleziono na wózku', baza: '/api/zwroty' },
];

let raportyDane = [];

function dniTemu(czas) {
  if (!czas) return '';
  const dt = new Date(String(czas).replace(' ', 'T') + 'Z');
  if (isNaN(dt.getTime())) return '';
  const dni = Math.floor((Date.now() - dt.getTime()) / 86400000);
  if (dni <= 0) return 'dziś';
  if (dni === 1) return 'wczoraj';
  return `${dni} dni temu`;
}

async function odswiezRaporty() {
  el('raporty-tbody').innerHTML = '';
  // kazde zrodlo osobno: padniete (np. GT chwilowo niedostepny) nie moze wygasic calej tabeli
  // i zabrac widoku spraw, ktore odpowiedzialy
  const bledy = [];
  const wyniki = await Promise.all(SCIEZKI_RAPORTOW.map(async (s) => {
    try {
      const { pozycje } = await api(`${s.baza}/raport`);
      return (pozycje || []).map((p) => ({ ...p, sciezka: s.klucz, sciezka_nazwa: s.nazwa, sciezka_baza: s.baza }));
    } catch (err) {
      bledy.push(`${s.nazwa}: ${err.message}`);
      return [];
    }
  }));
  raportyDane = wyniki.flat();
  renderujRaporty();
  if (bledy.length) pokazKomunikat(bledy.join(' · '), 'blad');
}

function renderujRaporty() {
  const filtr = el('raporty-sciezka').value;
  const lista = (filtr ? raportyDane.filter((s) => s.sciezka === filtr) : raportyDane)
    .slice()
    .sort((a, b) => (a.lokalizacja_kod || '').localeCompare(b.lokalizacja_kod || '')
      || (a.artykul_symbol || '').localeCompare(b.artykul_symbol || ''));
  const tbody = el('raporty-tbody');
  tbody.innerHTML = '';
  el('raporty-brak').classList.toggle('hidden', lista.length > 0);
  el('raporty-licznik').textContent = lista.length ? `${lista.length} otwartych` : '';
  for (const w of lista) {
    const roznica = (w.policzone != null && w.stan != null) ? (w.policzone - w.stan) : null;
    const roznicaTxt = roznica != null ? `${roznica > 0 ? '+' : ''}${roznica}` : '—';
    const tr = document.createElement('tr');
    // dokument dopisany pod symbolem: przy zwrotach to on identyfikuje sprawe (jeden SKU moze
    // miec kilka korekt), a osobna kolumna byla by pusta dla wszystkich pozostalych zrodel
    const dokTxt = w.zrodlo_dok ? `<br><span class="hint-inline">${w.zrodlo_dok}</span>` : '';
    tr.innerHTML =
        `<td><strong>${w.artykul_symbol || w.artykul_gt_id || '—'}</strong>${dokTxt}</td>`
      + `<td>${w.lokalizacja_kod || '—'}</td>`
      + `<td>${w.sciezka_nazwa}</td>`
      + `<td>${w.stan ?? '—'}</td>`
      + `<td>${w.policzone ?? '—'}</td>`
      + `<td class="${roznica ? 'sprawy-roznica' : ''}">${roznicaTxt}</td>`
      // rezerwacja z GT na zywo: mowi, czy braku pilnuje jakies otwarte ZK. null = GT nie
      // odpowiedzial (raport dziala dalej), 0 = nikt nie czeka - to dwie rozne rzeczy
      + `<td class="${w.rezerwacja ? 'sprawy-rez' : ''}">${w.rezerwacja == null ? '—' : w.rezerwacja}</td>`
      + `<td>${w.uzytkownik || '—'}</td>`
      + `<td>${dniTemu(w.czas)}</td>`
      + `<td class="td-akcja"></td>`;
    const tdAkcja = tr.querySelector('.td-akcja');
    const bZal = document.createElement('button');
    bZal.className = 'btn btn-small btn-sprawy-zalatw';
    bZal.textContent = '✓ Załatwione';
    bZal.addEventListener('click', () => zalatwSprawe(w, tr));
    const bOtw = document.createElement('button');
    bOtw.className = 'btn btn-small';
    bOtw.textContent = 'Edytuj';
    bOtw.addEventListener('click', () => otworzProduktPoSymbolu(w));
    tdAkcja.append(bZal, bOtw);
    tbody.appendChild(tr);
  }
}

async function zalatwSprawe(w, tr) {
  if (!confirm(`Oznaczyć jako załatwione?\n${w.artykul_symbol || w.artykul_gt_id} @ ${w.lokalizacja_kod}`)) return;
  try {
    await api(`${w.sciezka_baza}/niezgodnosc/zamknij`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        artykul_gt_id: w.artykul_gt_id,
        artykul_symbol: w.artykul_symbol,
        lokalizacja_kod: w.lokalizacja_kod,
        // klucz sprawy zalezy od zrodla: sciezki domykaja pare (artykul+lokalizacja), zwroty
        // (artykul+dokument). Wysylamy oba - kazdy endpoint czyta swoje, nadmiar ignoruje.
        zrodlo_dok: w.zrodlo_dok,
        wozek_id: w.wozek_id,
      }),
    });
    raportyDane = raportyDane.filter((s) => s !== w);
    tr.remove();
    renderujRaporty();
    pokazKomunikat('Sprawa oznaczona jako załatwiona.', 'ok');
  } catch (err) {
    pokazKomunikat(err.message, 'blad');
  }
}

// Otwiera kartę produktu dla wiersza z DOWOLNEJ listy (Raporty / Zwroty / Zestawienia).
// Dociaga pelny obiekt z /api/produkty, bo modal potrzebuje danych WMS (lokalizacje, zgodnosc),
// ktorych listy nie niosa - one maja tylko stany GT.
async function otworzProduktPoSymbolu(w) {
  try {
    const { produkty } = await api(`/api/produkty?q=${encodeURIComponent(w.artykul_symbol || w.artykul_gt_id)}&limit=10`);
    const p = produkty.find((x) => String(x.artykul_gt_id) === String(w.artykul_gt_id)) || produkty[0];
    if (p) otworzModalProdukt(p);
    else pokazKomunikat('Nie znaleziono produktu w GT.', 'blad');
  } catch (err) {
    pokazKomunikat(err.message, 'blad');
  }
}

el('btn-raporty-odswiez').addEventListener('click', odswiezRaporty);
el('raporty-sciezka').addEventListener('change', renderujRaporty);

// === ZWROTY (PZ <- KFS na K4) + wozki ===
//
// Lista jest liczona na zywo w backendzie (kubelek "zwrot" z rozbijStanK4). Front NIE liczy
// nic sam - zaznacza tylko, ktore pozycje ida na wozek. Backend i tak przelicza wybor u siebie
// (zasada 5: front to UX, nie autorytet).

let zwrotyDane = [];
let zwrotyWozki = [];            // wozki w obiegu - pasek filtrow (z backendu, nie zgadywane)
let zwrotyAktywny = null;        // wozek, na ktory ida kolejne pozycje (null = trzeba zalozyc)
let zwrotyNastepnyNumer = 1;
let zwrotyFiltr = 'wszystkie';   // 'wszystkie' | 'wolne' | id wozka
const zaznaczone = new Set();
const kluczZwrotu = (z) => `${z.artykul_gt_id}|${z.zrodlo_dok}`;
const wolnaPozycja = (z) => !z.wozek;
// dopelniacz do zdan "dodaj do ...", "zdjete z ..." - lowercase samej etykiety dawal
// "dodaj do wozek 5"
const doWozka = (w) => `wózka ${w.numer ?? w.id}`;

async function odswiezZwroty() {
  try {
    const dane = await api('/api/zwroty');
    zwrotyDane = dane.pozycje || [];
    zwrotyWozki = dane.wozki || [];
    zwrotyAktywny = dane.aktywny_wozek || null;
    zwrotyNastepnyNumer = dane.nastepny_numer || 1;
    // zaznaczenia pozycji, ktorych juz nie ma (ktos rozlozyl albo dolozyl na wozek w
    // miedzyczasie), musza zniknac - inaczej "Dodaj do wozka" wyslalby duchy i dostal 409
    for (const k of [...zaznaczone]) {
      if (!zwrotyDane.some((z) => kluczZwrotu(z) === k && wolnaPozycja(z))) zaznaczone.delete(k);
    }
    // filtr wskazujacy wozek, ktory wypadl z obiegu (rozlozony) - pokazalby pusta tabele bez
    // wyjasnienia
    if (typeof zwrotyFiltr === 'number' && !zwrotyWozki.some((w) => w.id === zwrotyFiltr)) {
      zwrotyFiltr = 'wszystkie';
    }
    renderujZwroty();
  } catch (err) {
    pokazKomunikat(err.message, 'blad');
  }
}

function pozycjeWidoczne() {
  if (zwrotyFiltr === 'wolne') return zwrotyDane.filter(wolnaPozycja);
  if (zwrotyFiltr === 'braki') return zwrotyDane.filter((z) => z.brak);
  if (typeof zwrotyFiltr === 'number') return zwrotyDane.filter((z) => z.wozek?.id === zwrotyFiltr);
  return zwrotyDane;
}

function renderujZwroty() {
  renderujPasekWozkow();
  const widoczne = pozycjeWidoczne();
  const tbody = el('zwroty-tbody');
  tbody.innerHTML = '';
  el('zwroty-brak').classList.toggle('hidden', widoczne.length > 0);
  // pusta tabela znaczy co innego przy kazdym filtrze - "brak zwrotow" przy filtrze wozka
  // bylby nieprawda
  el('zwroty-brak').textContent = !zwrotyDane.length ? 'Brak zwrotów do rozłożenia. 🎉'
    : zwrotyFiltr === 'wolne' ? 'Wszystko leży już na wózkach.'
    : typeof zwrotyFiltr === 'number' ? 'Ten wózek nie ma już nic do rozłożenia.'
    : 'Brak zwrotów do rozłożenia. 🎉';

  const naWozkach = zwrotyDane.length - zwrotyDane.filter(wolnaPozycja).length;
  el('zwroty-licznik').textContent = zwrotyDane.length
    ? `${zwrotyDane.length} do rozłożenia${naWozkach ? ` · ${naWozkach} na wózkach` : ''}`
    : '';

  for (const z of widoczne) {
    const tr = document.createElement('tr');
    tr.classList.toggle('na-wozku', !wolnaPozycja(z));
    // lokalizacja z GT (tw_Pole1) to tylko podpowiedz - WMS jej nie potwierdza, wiec oznaczamy
    const lokTxt = z.lokalizacja_kod
      ? `${z.lokalizacja_kod}${z.lok_zrodlo === 'GT' ? ' <span class="hint-inline">(z GT)</span>' : ''}`
      : '<span class="hint-inline">nieznana</span>';
    // czesciowo rozlozona pozycja wozka: pokazujemy, ile ZOSTALO, ze snapshotem w tle
    const zostalo = z.zostalo ?? z.ilosc;
    const iloscTxt = zostalo !== z.ilosc ? `${zostalo} <span class="hint-inline">z ${z.ilosc}</span>` : `${zostalo}`;
    // "nie znaleziono na wozku" - zgloszone z Zebry, pozycja spadla z wozka i czeka na
    // wyjasnienie. Bez tej chorągiewki wygladalaby jak zwykly zwrot do rozlozenia.
    const brakTxt = z.brak
      ? ` <span class="znacznik-brak" title="Zgłoszone z Zebry: nie znaleziono na wózku${
          z.brak.wozek_numer ? ` ${z.brak.wozek_numer}` : ''}${z.brak.uzytkownik ? ` · ${z.brak.uzytkownik}` : ''}">nie znaleziono</span>`
      : '';
    tr.innerHTML =
        `<td class="kol-zazn"></td>`
      + `<td><strong>${z.symbol || z.artykul_gt_id}</strong>${brakTxt}<br><span class="hint-inline">${z.nazwa || ''}</span></td>`
      + `<td>${z.dok_zrodlowy || '—'}</td>`
      + `<td>${z.data || '—'}</td>`
      + `<td>${iloscTxt}</td>`
      + `<td>${lokTxt}</td>`
      + `<td>${z.stan_k4 ?? '—'}</td>`
      + `<td>${z.wozek ? z.wozek.etykieta : '<span class="hint-inline">—</span>'}</td>`
      + `<td class="td-akcja"></td>`;

    // zaznaczyc mozna tylko WOLNA pozycje - lezacej juz na wozku nie ma gdzie dokladac
    if (wolnaPozycja(z)) {
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = zaznaczone.has(kluczZwrotu(z));
      chk.addEventListener('change', () => {
        if (chk.checked) zaznaczone.add(kluczZwrotu(z)); else zaznaczone.delete(kluczZwrotu(z));
        odswiezPrzyciskWozka();
      });
      tr.querySelector('.kol-zazn').appendChild(chk);
    }

    const tdAkcja = tr.querySelector('.td-akcja');
    if (wolnaPozycja(z)) {
      const bUsun = document.createElement('button');
      bUsun.className = 'btn btn-small';
      bUsun.textContent = 'Usuń ze zwrotów';
      bUsun.title = 'Odkłada na lokalizację podstawową - pozycja znika z listy zwrotów';
      bUsun.addEventListener('click', () => usunZeZwrotow(z, bUsun));
      tdAkcja.appendChild(bUsun);
    } else {
      const bZdejmij = document.createElement('button');
      bZdejmij.className = 'btn btn-small';
      bZdejmij.textContent = 'Zdejmij z wózka';
      bZdejmij.title = 'To nie miało tu trafić - pozycja wraca na listę wolnych zwrotów';
      bZdejmij.addEventListener('click', () => zdejmijZWozka(z, bZdejmij));
      tdAkcja.appendChild(bZdejmij);
    }
    // Zgloszony brak domyka sie sam, gdy ktos pozycje rozlozy. "Załatwione" jest dla drugiego
    // przypadku: towaru naprawde nie ma (zniszczony, poszedl na K4R/BRK z karty) i nikt go juz
    // nie rozlozy - bez tego chorągiewka wisialaby w nieskonczonosc.
    if (z.brak) {
      const bZalatw = document.createElement('button');
      bZalatw.className = 'btn btn-small btn-sprawy-zalatw';
      bZalatw.textContent = 'Załatwione';
      bZalatw.title = 'Zamyka zgłoszenie "nie znaleziono" - znacznik znika';
      bZalatw.addEventListener('click', () => zalatwBrakZwrotu(z, bZalatw));
      tdAkcja.appendChild(bZalatw);
    }
    const bProd = document.createElement('button');
    bProd.className = 'btn btn-small';
    bProd.textContent = 'Edytuj';
    bProd.title = 'Otwiera kartę - stąd zrobisz normalną operację, np. przeniesienie na K4R/BRK';
    bProd.addEventListener('click', () => otworzProduktPoSymbolu({ artykul_gt_id: z.artykul_gt_id, artykul_symbol: z.symbol }));
    tdAkcja.appendChild(bProd);
    tbody.appendChild(tr);
  }
  odswiezPrzyciskWozka();
  const wolneWidoczne = widoczne.filter(wolnaPozycja);
  el('zwroty-zazn-wszystkie').checked = wolneWidoczne.length > 0
    && wolneWidoczne.every((z) => zaznaczone.has(kluczZwrotu(z)));
}

// Pasek wozkow = filtr ("pokaz, co lezy na Wozku 2") + akcje wozka. Zastapil osobna tabele:
// wozek nie jest bytem do przegladania, tylko przegroda na tej samej liscie zwrotow.
function renderujPasekWozkow() {
  const pasek = el('zwroty-wozki-pasek');
  pasek.innerHTML = '';
  // otwarty najpierw - to na niego ida kolejne zwroty
  const wozki = [...zwrotyWozki].sort((a, b) =>
    (a.status === 'otwarty' ? 0 : 1) - (b.status === 'otwarty' ? 0 : 1)
    || (a.numer ?? a.id) - (b.numer ?? b.id));
  const wolnych = zwrotyDane.filter(wolnaPozycja).length;

  const chip = (klucz, tekst, licznik, klasa) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `wozek-chip${klasa ? ` ${klasa}` : ''}${zwrotyFiltr === klucz ? ' aktywny' : ''}`;
    b.innerHTML = `${tekst} <span class="wozek-chip__licznik">${licznik}</span>`;
    b.addEventListener('click', () => { zwrotyFiltr = klucz; renderujZwroty(); });
    return b;
  };

  pasek.append(chip('wszystkie', 'Wszystkie', zwrotyDane.length));
  pasek.append(chip('wolne', 'Wolne', wolnych));
  // chip pokazuje sie tylko, gdy jest co pokazac - pusty "Nie znaleziono 0" bylby szumem
  const braki = zwrotyDane.filter((z) => z.brak).length;
  if (braki) pasek.append(chip('braki', 'Nie znaleziono', braki, 'brak'));
  for (const w of wozki) {
    const grupa = document.createElement('span');
    grupa.className = 'wozek-grupa';
    grupa.appendChild(chip(w.id, w.etykieta, w.pozycji, w.status === 'otwarty' ? 'otwarty' : ''));
    if (w.status === 'otwarty') {
      const bZamknij = document.createElement('button');
      bZamknij.type = 'button';
      bZamknij.className = 'btn wozek-zamknij';
      bZamknij.textContent = 'Zamknij';
      bZamknij.title = 'Odwożę ten wózek - kolejne zwroty pójdą na następny';
      bZamknij.addEventListener('click', () => zamknijWozek(w));
      grupa.appendChild(bZamknij);
    }
    pasek.appendChild(grupa);
  }
}

// Przycisk mowi WPROST, dokad pojdzie towar - inaczej "z automatu na otwarty wozek" jest
// niewidoczne i wyglada jak zgubione zaznaczenie.
function odswiezPrzyciskWozka() {
  const b = el('btn-zwroty-wozek');
  b.disabled = zaznaczone.size === 0;
  const cel = zwrotyAktywny ? `do ${doWozka(zwrotyAktywny)}` : `na nowy wózek ${zwrotyNastepnyNumer}`;
  b.textContent = zaznaczone.size ? `Dodaj ${cel} (${zaznaczone.size})` : `Dodaj ${cel}`;
}

async function zamknijWozek(w) {
  if (!confirm(`Zamknąć ${w.etykieta}?\n\nKolejne zwroty pójdą na następny wózek.`)) return;
  try {
    await api(`/api/zwroty/wozki/${w.id}/zamknij`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    odswiezZwroty();
  } catch (err) {
    pokazKomunikat(err.message, 'blad');
  }
}

async function zalatwBrakZwrotu(z, btn) {
  if (!confirm(`Zamknąć zgłoszenie „nie znaleziono"?\n${z.symbol} · ${z.zrodlo_dok}`)) return;
  btn.disabled = true;
  try {
    await api('/api/zwroty/niezgodnosc/zamknij', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        artykul_gt_id: z.artykul_gt_id,
        artykul_symbol: z.symbol,
        zrodlo_dok: z.zrodlo_dok,
        wozek_id: z.brak?.wozek_id ?? null,
      }),
    });
    pokazKomunikat(`${z.symbol}: zgłoszenie zamknięte.`, 'ok');
    odswiezZwroty();
  } catch (err) {
    pokazKomunikat(err.message, 'blad');
    btn.disabled = false;
  }
}

async function zdejmijZWozka(z, btn) {
  btn.disabled = true;
  try {
    await api(`/api/zwroty/wozki/${z.wozek.id}/zdejmij`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ artykul_gt_id: z.artykul_gt_id, zrodlo_dok: z.zrodlo_dok }),
    });
    pokazKomunikat(`${z.symbol}: zdjęte z ${doWozka(z.wozek)}.`, 'ok');
    odswiezZwroty();
  } catch (err) {
    pokazKomunikat(err.message, 'blad');
    btn.disabled = false;
  }
}

// "Usun ze zwrotow" = POST /ruchy/rozloz z celem = lokalizacja podstawowa. NIE jest to osobny
// endpoint ani wlasny stan: to normalne rozlozenie, tyle ze z pominieciem wozka. Dzieki temu
// licznik dokumentu (ruchy.zrodlo_dok) zdejmuje pozycje tak samo, jak rozlozenie z wozka.
//
// Lokalizacje podpowiadamy (WMS -> tw_Pole1 -> puste), ale operator moze nadpisac - bywa, ze
// WMS nie zna miejsca tego SKU, a on wie, gdzie towar odklada.
async function usunZeZwrotow(z, btn) {
  const kod = prompt(
    `Usuń ze zwrotów: ${z.symbol} (${z.ilosc} szt.)\n\n`
    + `Na jaką lokalizację odkładasz?`,
    z.lokalizacja_kod || ''
  );
  if (kod === null) return;
  const kodTrim = String(kod).trim();
  if (!kodTrim) { pokazKomunikat('Podaj lokalizację.', 'blad'); return; }

  btn.disabled = true;
  try {
    const lok = await api(`/api/lokalizacje/kod/${encodeURIComponent(kodTrim)}`);
    await api('/api/ruchy/rozloz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        artykul_gt_id: z.artykul_gt_id,
        mag_zrodlo_pula: 'K4',
        zrodlo_dok: z.zrodlo_dok,
        lok_cel_id: lok.id,
        ilosc: z.ilosc,
        artykul_symbol: z.symbol,
        artykul_nazwa: z.nazwa,
        artykul_ean: z.ean,
      }),
    });
    pokazKomunikat(`${z.symbol}: ${z.ilosc} szt. odłożone na ${lok.kod}.`, 'ok');
    odswiezZwroty();
  } catch (err) {
    pokazKomunikat(err.message, 'blad');
    btn.disabled = false;
  }
}

// Bez pytania o nazwe: wozek nazywa sie numerem fizycznego wozka, a backend sam wybiera cel
// (aktywny wozek albo nowy). Zaznaczam -> klikam -> towar lezy na wozku.
async function dodajDoWozka() {
  const wybor = zwrotyDane.filter((z) => wolnaPozycja(z) && zaznaczone.has(kluczZwrotu(z)));
  if (!wybor.length) return;
  try {
    const r = await api('/api/zwroty/wozki', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wozek_id: zwrotyAktywny?.id ?? null,
        pozycje: wybor.map((z) => ({ artykul_gt_id: z.artykul_gt_id, zrodlo_dok: z.zrodlo_dok })),
      }),
    });
    zaznaczone.clear();
    const odrzucone = (r.odrzucone || []).length;
    pokazKomunikat(
      `${r.etykieta}: ${r.utworzony ? 'założony, ' : ''}+${r.dodane} SKU (razem ${r.pozycji}).`
      + (odrzucone ? ` ${odrzucone} pominięto (rozłożone w międzyczasie).` : ''),
      'ok'
    );
    odswiezZwroty();
  } catch (err) {
    pokazKomunikat(err.message, 'blad');
  }
}

// === DOSTAWY (PZ <- FZ) - faktury -> towary ===

let dostawyFaktura = null;   // otwarta faktura albo null = poziom listy faktur

async function odswiezDostawy() {
  if (dostawyFaktura) return wczytajTowaryFaktury(dostawyFaktura.zrodlo_dok);
  el('dostawy-faktury-widok').classList.remove('hidden');
  el('dostawy-towary-widok').classList.add('hidden');
  el('btn-dostawy-wstecz').classList.add('hidden');
  el('dostawy-naglowek').textContent = 'Dostawy do rozłożenia';
  try {
    const { faktury, razem } = await api('/api/dostawy');
    const tbody = el('dostawy-faktury-tbody');
    tbody.innerHTML = '';
    el('dostawy-faktury-brak').classList.toggle('hidden', faktury.length > 0);
    el('dostawy-licznik').textContent = razem ? `${razem} do rozłożenia` : '';
    for (const f of faktury) {
      const tr = document.createElement('tr');
      tr.innerHTML =
          `<td><strong>${f.dok_zrodlowy || '—'}</strong></td>`
        + `<td>${f.kontrahent || '—'}</td>`
        + `<td>${f.zrodlo_dok}</td>`
        + `<td>${f.data || '—'}</td>`
        + `<td>${f.sku}</td>`
        + `<td>${f.sztuk}</td>`
        + `<td class="td-akcja"><button class="btn btn-small" type="button">Towary</button></td>`;
      tr.querySelector('button').addEventListener('click', () => {
        dostawyFaktura = f;
        wczytajTowaryFaktury(f.zrodlo_dok);
      });
      tbody.appendChild(tr);
    }
  } catch (err) {
    pokazKomunikat(err.message, 'blad');
  }
}

async function wczytajTowaryFaktury(dok) {
  el('dostawy-faktury-widok').classList.add('hidden');
  el('dostawy-towary-widok').classList.remove('hidden');
  el('btn-dostawy-wstecz').classList.remove('hidden');
  try {
    const dane = await api(`/api/dostawy/${encodeURIComponent(dok)}`);
    // numer FZ i kontrahent backend czyta z POZYCJI, wiec po rozlozeniu ostatniego SKU sa null -
    // trzymamy podpis z listy faktur, zeby naglowek nie zdegradowal sie w chwili sukcesu
    const podpis = [dane.dok_zrodlowy ?? dostawyFaktura?.dok_zrodlowy, dane.kontrahent ?? dostawyFaktura?.kontrahent]
      .filter(Boolean).join(' · ');
    el('dostawy-naglowek').textContent = podpis ? `${podpis} (${dok})` : dok;
    el('dostawy-licznik').textContent = dane.razem ? `${dane.razem} SKU do rozłożenia` : '';
    const tbody = el('dostawy-towary-tbody');
    tbody.innerHTML = '';
    el('dostawy-towary-brak').classList.toggle('hidden', dane.pozycje.length > 0);
    for (const p of dane.pozycje) {
      const tr = document.createElement('tr');
      tr.innerHTML =
          `<td><strong>${p.symbol || p.artykul_gt_id}</strong></td>`
        + `<td>${p.nazwa || ''}</td>`
        + `<td>${p.ilosc}</td>`
        + `<td>${p.lokalizacja_kod || '<span class="hint-inline">nieznana</span>'}`
        + `${p.lok_zrodlo === 'GT' ? ' <span class="hint-inline">(z GT)</span>' : ''}</td>`
        + `<td>${p.stan_k4 ?? '—'}</td>`
        + `<td class="${p.rezerwacja ? 'sprawy-rez' : ''}">${p.rezerwacja ?? 0}</td>`
        + `<td class="td-akcja"><button class="btn btn-small" type="button">Edytuj</button></td>`;
      tr.querySelector('button').addEventListener('click', () =>
        otworzProduktPoSymbolu({ artykul_gt_id: p.artykul_gt_id, artykul_symbol: p.symbol }));
      tbody.appendChild(tr);
    }
  } catch (err) {
    pokazKomunikat(err.message, 'blad');
  }
}

el('btn-dostawy-odswiez').addEventListener('click', odswiezDostawy);
el('btn-dostawy-wstecz').addEventListener('click', () => { dostawyFaktura = null; odswiezDostawy(); });

// === ZESTAWIENIA (jedna strona: MAG / nadsprzedaz / Leszno / strefa przyjec) ===

// Sekcja z adresu #zestawienia/<raport>, do przewiniecia po zaladowaniu danych.
let zestKotwica = null;

// Wiersz "katalogowy" - ten sam zestaw kolumn co tabela Produktow (stan + rezerwacja w jednej
// komorce przez komorkaStan), zeby czytalo sie tak samo w calym panelu.
function wierszKatalogowy(p, dodatkowe = '') {
  const tr = document.createElement('tr');
  tr.innerHTML =
      `<td><strong>${p.symbol}</strong></td>`
    + `<td>${p.nazwa || ''}</td>`
    + `<td>${p.ean ?? '—'}</td>`
    + `<td>${komorkaStan(p.stany_gt, 'K4')}</td>`
    + `<td>${komorkaStan(p.stany_gt, 'K4G')}</td>`
    + `<td>${komorkaStan(p.stany_gt, 'MAG')}</td>`
    + `<td>${komorkaStan(p.stany_gt, 'LS')}</td>`
    + `<td>${p.razem}</td>`
    + dodatkowe
    + `<td class="td-akcja"><button class="btn btn-small" type="button">Edytuj</button></td>`;
  tr.querySelector('button').addEventListener('click', () =>
    otworzProduktPoSymbolu({ artykul_gt_id: p.artykul_gt_id, artykul_symbol: p.symbol }));
  return tr;
}

function wypelnijKatalog(tbodyId, brakId, produkty, dodatkowe) {
  const tbody = el(tbodyId);
  tbody.innerHTML = '';
  el(brakId).classList.toggle('hidden', produkty.length > 0);
  for (const p of produkty) tbody.appendChild(wierszKatalogowy(p, dodatkowe ? dodatkowe(p) : ''));
}

// === DO SPRAWDZENIA (podzakladka Ruchow) ===
//
// Towar, ktory GT widzi na K4, a WMS nie wie gdzie. Lista jest BACKLOGIEM (~2000 wierszy na
// starcie), wiec paginujemy i domyslnie sortujemy po ilosci - najpierw to, co najbardziej
// zaklamuje stan. Backend liczy `reszta` tym samym rozbiciem, co karta produktu.
const DOSP_LIMIT = 50;
let dospOffset = 0;
// Domyslnie NIEZNANY PRZYCHOD (decyzja usera): "do zlokalizowania" to backlog migracyjny na
// miesiace, a to jest to, co wydarzylo sie wczoraj - i JEDYNE miejsce w systemie, gdzie w ogole
// widac taki towar (zgodnosc K4 porownuje tylko tekst lokalizacji, wiec swieci mu OK).
// '' = wszystko.
let dospRodzaj = 'przyjecie_wewn';

// Opis pod przelacznikiem. Kazdy rodzaj to inna praca i inne "czemu to tu jest" - bez tego
// magazynier widzi liczby i nie wie, ktora go dotyczy.
const DOSP_OPISY = {
  '': 'GT widzi ten towar na K4, ale WMS nie wie, gdzie leży cały jego stan. '
    + 'Nie dopisujemy go do półki automatycznie: automat nie odróżniłby go od niewidzianej palety, '
    + 'a wpisanie palety na półkę zrównuje GT z WMS i job rozjazdów już nigdy tego nie wykryje.',
  przyjecie_wewn: 'Przyjęcia wewnętrzne (PW) — ktoś dołożył towar poza naszym obiegiem, ale '
    + 'z dokumentem: korekta stanu, inwentura, ręczne przyjęcie. WMS zna miejsce SKU, więc to '
    + 'domknięcie: odłóż na regał. Tych pozycji NIE widać nigdzie indziej — zgodność K4 porównuje '
    + 'tylko tekst lokalizacji, więc taki towar świeci OK mimo nadwyżki.',
  nieznany_przychod: 'Nadwyżka BEZ dokumentu — stan GT większy, niż WMS i wszystkie dokumenty '
    + 'tłumaczą. W Subiekcie nie ma zmiany stanu bez dokumentu, więc to rzadkość: coś sprzed okna '
    + 'czasowego albo starzejąca się kopia WMS. Warte sprawdzenia ręcznie.',
  do_zlokalizowania: 'WMS nie zna tego towaru na K4 w ogóle — nigdy nie dostał miejsca. '
    + 'To backlog migracyjny: zjedzie do zera, gdy go zlokalizujesz. Widać go też w Produktach '
    + 'jako status t_GT (albo BD, gdy GT też nie ma wpisanej lokalizacji).',
};

// Komunikat pustki per filtr - musi mówić prawdę o TYM podzbiorze, a nie o całej liście.
const DOSP_PUSTO = {
  '': 'Nic do sprawdzenia — WMS wie o całym stanie K4. 🎉',
  przyjecie_wewn: 'Brak przyjęć wewnętrznych do odłożenia. 🎉',
  nieznany_przychod: 'Każda nadwyżka ma dokument. 🎉',
  do_zlokalizowania: 'Każdy towar ze stanem na K4 ma miejsce w WMS. 🎉',
};

async function odswiezDoSprawdzenia() {
  const params = new URLSearchParams({
    sort: el('dosp-sort').value,
    limit: String(DOSP_LIMIT),
    offset: String(dospOffset),
  });
  if (dospRodzaj) params.set('rodzaj', dospRodzaj);
  try {
    renderujDoSprawdzenia(await api(`/api/do-sprawdzenia?${params}`));
  } catch (err) {
    pokazKomunikat(err.message, 'blad');
  }
}

function renderujDoSprawdzenia(dane) {
  const { pozycje, razem, sztuk, offset, limit, liczniki } = dane;
  const tbody = el('dosp-tbody');
  tbody.innerHTML = '';
  el('dosp-brak').classList.toggle('hidden', razem > 0);
  // Komunikat pustki MUSI zalezec od filtru. Przy aktywnym "Nieznany przychód" zdanie
  // "WMS wie o calym stanie K4" bylo klamstwem - obok stalo 2325 pozycji do zlokalizowania.
  el('dosp-brak').textContent = DOSP_PUSTO[dospRodzaj] ?? DOSP_PUSTO[''];
  el('dosp-licznik').textContent = razem > 0
    ? `${razem} SKU · ${sztuk} szt. do przypisania`
    : '';
  el('dosp-opis').textContent = DOSP_OPISY[dospRodzaj] ?? '';

  // Liczniki w etykietach przelacznika - ida z PELNEGO zbioru, wiec sa widoczne takze przy
  // aktywnym filtrze (patrz routes/do-sprawdzenia.js).
  if (liczniki) {
    const etykiety = {
      '': `Wszystko (${liczniki.przyjecie_wewn.razem + liczniki.nieznany_przychod.razem + liczniki.do_zlokalizowania.razem})`,
      przyjecie_wewn: `Przyjęcia wewn (PW) (${liczniki.przyjecie_wewn.razem})`,
      nieznany_przychod: `Bez dokumentu (${liczniki.nieznany_przychod.razem})`,
      do_zlokalizowania: `Do zlokalizowania (${liczniki.do_zlokalizowania.razem})`,
    };
    el('dosp-rodzaje').querySelectorAll('.podzakladka').forEach((a) => {
      a.textContent = etykiety[a.dataset.rodzaj] ?? a.textContent;
      a.classList.toggle('aktywna', a.dataset.rodzaj === dospRodzaj);
    });
  }

  for (const p of pozycje) {
    const tr = document.createElement('tr');
    // "Zna WMS" pokazuje, czy dokladamy do istniejacego miejsca, czy szukamy nowego -
    // to zupelnie inna robota dla magazyniera.
    const znaWms = p.polka_wms > 0 ? `${p.polka_wms} szt.` : '<span class="opis">nie zna</span>';
    // Miejsce z GT to tylko PODPOWIEDZ - tw_Pole1 bywa smieciem ("RB/M2-B37 - sciana /"),
    // wiec oznaczamy zrodlo, zeby magazynier wiedzial, czemu ma nie ufac.
    const miejsce = p.lokalizacja_kod
      ? `${p.lokalizacja_kod}${p.lok_zrodlo === 'GT' ? ' <span class="opis">(z GT)</span>' : ''}`
      : '<span class="opis">brak — zeskanuj</span>';
    tr.innerHTML = `<td><strong>${p.symbol ?? p.artykul_gt_id}</strong></td>`
      + `<td>${p.nazwa ?? ''}</td>`
      + `<td><strong>${p.ilosc}</strong></td>`
      + `<td>${p.stan_k4}</td>`
      + `<td>${znaWms}</td>`
      + `<td>${p.w_strefach > 0 ? p.w_strefach : '–'}</td>`
      + `<td class="kol-lok">${miejsce}</td>`
      + `<td class="td-akcja"><button class="btn btn-small" type="button">Otwórz</button></td>`;
    tr.querySelector('button').addEventListener('click', () =>
      otworzProduktPoSymbolu({ artykul_gt_id: p.artykul_gt_id, artykul_symbol: p.symbol }));
    tbody.appendChild(tr);
  }

  const od = razem === 0 ? 0 : offset + 1;
  const doPoz = Math.min(offset + limit, razem);
  el('dosp-zakres').textContent = razem === 0 ? '–' : `${od}–${doPoz} z ${razem}`;
  el('btn-dosp-prev').disabled = offset === 0;
  el('btn-dosp-next').disabled = doPoz >= razem;
}

el('btn-dosp-odswiez').addEventListener('click', () => { dospOffset = 0; odswiezDoSprawdzenia(); });
el('dosp-sort').addEventListener('change', () => { dospOffset = 0; odswiezDoSprawdzenia(); });
// Przelacznik rodzaju: to filtr WEWNATRZ panelu, nie osobny adres - dlatego preventDefault
// (href jest tylko po to, zeby wygladalo i zachowywalo sie jak podzakladki obok).
el('dosp-rodzaje').addEventListener('click', (e) => {
  const a = e.target.closest('.podzakladka');
  if (!a) return;
  e.preventDefault();
  dospRodzaj = a.dataset.rodzaj;
  dospOffset = 0;
  odswiezDoSprawdzenia();
});
el('btn-dosp-prev').addEventListener('click', () => {
  dospOffset = Math.max(0, dospOffset - DOSP_LIMIT);
  odswiezDoSprawdzenia();
});
el('btn-dosp-next').addEventListener('click', () => {
  dospOffset += DOSP_LIMIT;
  odswiezDoSprawdzenia();
});

// Licznik przy naglowku sekcji. Pusto zamiast "0", bo pod spodem stoi juz komunikat "Nic do
// przywiezienia 🎉" - dwa razy to samo w dwoch miejscach tylko szumi.
function licznikSekcji(id, n) {
  el(id).textContent = n ? `(${n})` : '';
}

function wypelnijStrefe(pozycje) {
  const tbody = el('zest-strefa-tbody');
  tbody.innerHTML = '';
  el('zest-strefa-brak').classList.toggle('hidden', pozycje.length > 0);
  for (const p of pozycje) {
    const tr = document.createElement('tr');
    tr.innerHTML =
        `<td><strong>${p.symbol || p.artykul_gt_id}</strong></td>`
      + `<td>${p.nazwa || ''}</td>`
      + `<td>${p.zrodlo_mag || '—'}</td>`
      + `<td>${p.ilosc}</td>`
      + `<td>${p.lokalizacja_kod || '<span class="hint-inline">nieznana</span>'}</td>`
      + `<td>${p.stan_k4 ?? '—'}</td>`
      + `<td class="${p.rezerwacja ? 'sprawy-rez' : ''}">${p.rezerwacja ?? 0}</td>`
      + `<td class="td-akcja"><button class="btn btn-small" type="button">Edytuj</button></td>`;
    tr.querySelector('button').addEventListener('click', () =>
      otworzProduktPoSymbolu({ artykul_gt_id: p.artykul_gt_id, artykul_symbol: p.symbol }));
    tbody.appendChild(tr);
  }
}

// Wszystkie raporty naraz - strona pokazuje je jednoczesnie, wiec i pobieramy jednoczesnie.
// allSettled, a NIE all: raporty sa niezalezne, wiec jeden padniety endpoint ma zabrac swoja
// sekcje, a nie wygasic cala strone.
async function odswiezZestawienia() {
  const [przywozka, nadsprzedaz, leszno] = await Promise.allSettled([
    api('/api/zestawienia/przywozka'),
    api('/api/zestawienia/nadsprzedaz'),
    api('/api/zestawienia/leszno'),
  ]);

  if (przywozka.status === 'fulfilled') {
    const d = przywozka.value;
    wypelnijStrefe(d.strefa);
    licznikSekcji('zest-licznik-strefa', d.razem_strefa);
    wypelnijKatalog('zest-doprzywiezienia-tbody', 'zest-doprzywiezienia-brak', d.do_przywiezienia);
    licznikSekcji('zest-licznik-mag', d.razem_do_przywiezienia);
  }
  if (nadsprzedaz.status === 'fulfilled') {
    const d = nadsprzedaz.value;
    // Backend liczy rezerwacje ze SWIEZYCH ZK (okno WMS_NADSPRZEDAZ_DNI) - i te sama liczbe
    // pokazujemy. NIE sumujemy st_StanRez ze stany_gt: tamto liczy takze zombie ZK sprzed
    // roku, wiec kolumna klocilaby sie z warunkiem, ktory wiersz tu wpuscil.
    wypelnijKatalog('zest-nadsprzedaz-tbody', 'zest-nadsprzedaz-brak', d.produkty,
      (p) => `<td class="sprawy-rez">${p.rezerwacja_swieza ?? '—'}</td>`
           + `<td class="sprawy-roznica">${(p.rezerwacja_swieza ?? 0) - p.razem}</td>`);
    licznikSekcji('zest-licznik-nadsprzedaz', d.razem);
  }
  if (leszno.status === 'fulfilled') {
    const d = leszno.value;
    wypelnijKatalog('zest-leszno-tbody', 'zest-leszno-brak', d.produkty);
    licznikSekcji('zest-licznik-leszno', d.razem);
  }

  const bledy = [przywozka, nadsprzedaz, leszno].filter((r) => r.status === 'rejected');
  if (bledy.length) pokazKomunikat(bledy[0].reason.message, 'blad');

  przewinDoZestawienia();
}

// Adres #zestawienia/<raport> nie przelacza juz tresci - przewija do sekcji. Dzieki temu kafle
// Pulpitu ("Nadsprzedaż 5" -> #zestawienia/nadsprzedaz) dalej laduja na konkretnym raporcie,
// a zakladki zapisane w przegladarce nie prowadza donikad.
const ZEST_KOTWICE = {
  przywozka: 'zest-sekcja-strefa',        // stara nazwa podzakladki = strefa przyjec
  strefa: 'zest-sekcja-strefa',
  mag: 'zest-sekcja-mag',
  nadsprzedaz: 'zest-sekcja-nadsprzedaz',
  leszno: 'zest-sekcja-leszno',
};

function przewinDoZestawienia() {
  const id = ZEST_KOTWICE[zestKotwica];
  zestKotwica = null;                                 // jednorazowe - nie przewijaj przy Odswiez
  // Skok, a NIE `behavior:'smooth'`: to wejscie z ZEWNATRZ (kafel Pulpitu, zakladka w
  // przegladarce), wiec ma dzialac jak zwykla kotwica - raport od razu pod reka, bez animacji
  // przez pol strony. Animacje da sie tez zgubic, gdy cos przewinie strone w tym samym takcie.
  if (id) el(id).scrollIntoView({ block: 'start' });
}
el('btn-zest-odswiez').addEventListener('click', odswiezZestawienia);

el('btn-zwroty-odswiez').addEventListener('click', odswiezZwroty);
el('btn-zwroty-wozek').addEventListener('click', dodajDoWozka);
// "zaznacz wszystkie" dotyczy tego, co WIDAC i da sie dolozyc - inaczej przy filtrze wozka
// zaznaczaloby pozycje spoza ekranu
el('zwroty-zazn-wszystkie').addEventListener('change', (e) => {
  zaznaczone.clear();
  if (e.target.checked) {
    for (const z of pozycjeWidoczne()) if (wolnaPozycja(z)) zaznaczone.add(kluczZwrotu(z));
  }
  renderujZwroty();
});

// === UZYTKOWNICY (zakladka tylko dla admina) ===

function pokazZakladkeAdmina() {
  const tab = el('tab-uzytkownicy');
  if (tab) tab.style.display = (window.WMS && WMS.jestAdmin()) ? '' : 'none';
}
if (window.WMS) WMS.gotowe.then(pokazZakladkeAdmina);
window.addEventListener('wms-zalogowano', pokazZakladkeAdmina);

// Rola „uczen" pracuje na Zebrze - panel desktopowy nie jest dla niej.
// To ZASLONA, nie zamek: desktop leci przez express.static, a token siedzi w localStorage
// i doklejamy go tylko do /api/, wiec samo wejscie na strone nie niesie tozsamosci i serwer
// nie ma czego sprawdzic. Realna ochrona zostaje w backendzie (auth.blokujUcznia -> 403 na
// kazdym zapisie); tutaj tylko zdejmujemy panel z oczu, zeby nikt nie klikal w cos, co i tak
// odbije bledem. Odwracalna (zdejmujemy przy innej roli) i wpieta w OBA sygnaly - gotowe to
// Promise rozwiazywany RAZ, a wylogowanie nie przeladowuje strony, wiec po zmianie profilu
// zaslona inaczej zostalaby na ekranie magazyniera.
function zaslonPanelUczniowi() {
  const uczen = (window.WMS?.user() || {}).rola === 'uczen';
  const istniejaca = el('wms-uczen-zaslona');
  if (!uczen) { istniejaca?.remove(); return; }
  if (istniejaca) return;
  const ov = document.createElement('div');
  ov.id = 'wms-uczen-zaslona';
  ov.innerHTML = `<div>
    <h2>Panel dla magazynierów</h2>
    <p>Twoja rola pracuje na kolektorze — otwórz <a href="/zebra/ruch.html">ekran Zebry</a>.</p>
    <button type="button" id="wms-uczen-wyloguj">Zaloguj się jako kto inny</button>
  </div>`;
  document.body.appendChild(ov);
  el('wms-uczen-wyloguj').addEventListener('click', () => window.WMS?.wyloguj());
}
if (window.WMS) WMS.gotowe.then(zaslonPanelUczniowi);
window.addEventListener('wms-zalogowano', zaslonPanelUczniowi);

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
    const selRola = document.createElement('select');
    selRola.className = 'btn-small';
    for (const [val, txt] of [['magazynier', 'Magazynier'], ['admin', 'Admin'], ['uczen', 'Uczeń']]) {
      const o = document.createElement('option'); o.value = val; o.textContent = txt; if (u.rola === val) o.selected = true; selRola.appendChild(o);
    }
    selRola.addEventListener('change', () => zapiszUser(u.id, { rola: selRola.value }));
    akc.appendChild(selRola);
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

function ustawDatalist(inputEl, opcje, czyscWartosc = true) {
  // opcje: [{id, kod, hint?, stan?}]. czyscWartosc=false przy typeahead (nie kasujemy
  // tego, co user wpisuje) - tylko odswiezamy podpowiedzi i mape kod->id.
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
  if (czyscWartosc) inputEl.value = '';
}

// Cache lokalizacji per magazyn (do podpowiedzi bez fetcha na kazdy znak). Rozgrzewany przy
// aktywacji pola (mmZaladujLokCache w mmZaladujLokCel) - dzieki temu filtr ponizej jest
// SYNCHRONICZNY, a natywny <datalist> od razu pokazuje dopasowania. Async doladowanie opcji
// (poprzednia wersja: fetch po 250ms) NIE odswieza juz otwartej listy w Chrome -> "nie proponuje".
const lokMagData = {}; // mag -> [{id, kod}] gotowe do filtrowania; null = fetch w toku
function mmZaladujLokCache(mag) {
  if (!mag || lokMagData[mag] !== undefined) return; // juz jest albo w toku
  lokMagData[mag] = null;
  api(`/api/lokalizacje?magazyn=${encodeURIComponent(mag)}&aktywna=1`)
    .then((lista) => { lokMagData[mag] = Array.isArray(lista) ? lista.map((l) => ({ id: l.id, kod: l.kod })) : []; })
    .catch(() => { lokMagData[mag] = []; });
}

// Podpowiedzi lokalizacji po 3 znakach - filtr LOKALNY z cache (synchroniczny). Skan/wpis
// dokladnego kodu dziala niezaleznie (lokComboIdRozwiaz dopyta bazy, gdy kodu nie ma w cache).
function podlaczTypeaheadLok(inputEl) {
  inputEl.addEventListener('input', () => {
    const mag = inputEl.dataset.mag;
    const val = inputEl.value.trim().toUpperCase();
    if (!mag || val.length < 3) { ustawDatalist(inputEl, [], false); return; }
    const lista = lokMagData[mag];
    if (!lista) { mmZaladujLokCache(mag); return; } // jeszcze sie laduje - pokaze przy nastepnym znaku
    const dopasowane = lista.filter((l) => l.kod.toUpperCase().includes(val)).slice(0, 50);
    ustawDatalist(inputEl, dopasowane, false);
  });
  blokujAutofillHasel(inputEl); // patrz nizej - zeby menedzer hasel Chrome nie zaslanial <datalist>
}

// Chrome pokazuje "Zarzadzaj haslami" (zapisane haslo dla domeny z logowania PIN-em) na polach
// tekstowych i ZASLANIA nim natywny <datalist> - autocomplete="off" jest ignorowane. Pole
// readonly Chrome pomija przy autofillu; zdejmujemy readonly na fokus (klik) -> pole edytowalne
// i mozna pisac/skanowac, a popup hasel sie nie pojawia. Przywracamy na blur (re-arm).
function blokujAutofillHasel(inputEl) {
  if (inputEl.dataset.antiautofill) return; // idempotentne (pola statyczne + dynamiczne)
  inputEl.dataset.antiautofill = '1';
  inputEl.readOnly = true;
  inputEl.addEventListener('focus', () => { inputEl.readOnly = false; });
  inputEl.addEventListener('blur', () => { inputEl.readOnly = true; });
}

// Rozwiazuje kod lokalizacji -> id: najpierw z lokalnej mapy podpowiedzi, a gdy nie ma
// (typeahead trzyma tylko ostatnie dopasowania) - zapytaniem do bazy po dokladnym kodzie.
async function lokComboIdRozwiaz(inputEl, mag) {
  const id = lokComboId(inputEl);
  if (id) return id;
  const kod = inputEl.value.trim();
  if (!kod) return null;
  try {
    const lok = await api(`/api/lokalizacje/kod/${encodeURIComponent(kod)}`);
    if (lok && lok.magazyn === mag && lok.aktywna === 1) return lok.id;
  } catch { /* 404 - kod nie istnieje */ }
  return null;
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

async function mmZaladujLokZrodlo(inputEl, brakEl, mag, produkt) {
  if (!mmCzyWms(mag)) {
    inputEl.classList.add('hidden');
    if (brakEl) brakEl.classList.remove('hidden');
    ustawDatalist(inputEl, []);
    return;
  }
  inputEl.classList.remove('hidden');
  if (brakEl) brakEl.classList.add('hidden');
  try {
    const dane = await api(`/api/lokalizacje/artykul/${encodeURIComponent(produkt.symbol)}`);
    if (mag === 'K4') {
      // K4 = 1 SKU = 1 lokalizacja; stan zrodla ZAWSZE z GT (Subiekt = master), nie z kopii
      // WMS (ta bywa nieaktualna). Dostepne do MM = stan GT - rezerwacja.
      const dost = Math.max((produkt.stany_gt?.K4?.ilosc ?? 0) - (produkt.stany_gt?.K4?.rezerwacja ?? 0), 0);
      const k4 = dane.lokalizacje.filter((l) => l.magazyn === 'K4');
      ustawDatalist(inputEl, k4.map((l) => ({ id: l.lokalizacja_id, kod: l.kod, hint: `${dost} szt. wg GT`, stan: dost })));
      if (k4.length === 1) inputEl.value = k4[0].kod;
    } else {
      // K4G: stan per-lokalizacja jest tylko w WMS (GT nie zna rozbicia na polki)
      const loki = dane.lokalizacje.filter((l) => l.magazyn === mag && l.ilosc > 0);
      ustawDatalist(inputEl, loki.map((l) => ({ id: l.lokalizacja_id, kod: l.kod, hint: `${l.ilosc} szt.`, stan: l.ilosc })));
      if (loki.length === 1) inputEl.value = loki[0].kod;
    }
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
    inputEl.dataset.mag = '';
    ustawDatalist(inputEl, []);
    return;
  }
  inputEl.classList.remove('hidden');
  if (brakEl) brakEl.classList.add('hidden');
  // Zapamietujemy magazyn + rozgrzewamy cache lokalizacji, zeby typeahead po 3 znakach
  // filtrowal lokalnie i synchronicznie (natywny datalist od razu pokazuje dopasowania).
  inputEl.dataset.mag = mag;
  mmZaladujLokCache(mag);
  ustawDatalist(inputEl, []);
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
    mmZaladujLokZrodlo(el('mm-f-zrodlo'), el('mm-f-zrodlo-brak'), zrodlo, mmWybranyProdukt),
    mmZaladujLokCel(el('mm-f-cel'), el('mm-f-cel-brak'), cel),
  ]);
  await mmUstawCelK4(el('mm-f-cel'), 'mm-f-cel-info', cel, mmWybranyProdukt);
  aktualizujPozostanie('mm-f-zrodlo', 'mm-f-ilosc', 'mm-f-pozostanie');
}

el('mm-kierunek').addEventListener('change', mmOdswiezLokFormularz);
el('mm-f-zrodlo').addEventListener('input', () => aktualizujPozostanie('mm-f-zrodlo', 'mm-f-ilosc', 'mm-f-pozostanie'));
el('mm-f-ilosc').addEventListener('input', () => aktualizujPozostanie('mm-f-zrodlo', 'mm-f-ilosc', 'mm-f-pozostanie'));
podlaczTypeaheadLok(el('mm-f-cel')); // podpowiedzi lokalizacji celu po 3 znakach
blokujAutofillHasel(el('mm-f-zrodlo')); // zrodlo nie ma typeahead, ale tez blokujemy popup hasel

el('btn-mm-anuluj').addEventListener('click', () => {
  el('mm-formularz').classList.add('hidden');
  mmWybranyProdukt = null;
});

el('btn-mm-dodaj').addEventListener('click', async () => {
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
    const id = await lokComboIdRozwiaz(el('mm-f-cel'), cel);
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

const MAG_LABEL = { K4: 'K4 Hala', K4G: 'K4 Góra', MAG: 'Kajtek (MAG)', LS: 'Leszno (LS)', BRK: 'Braki (BRK)', K4R: 'Reklamacje (K4R)' };

let modalProdukt = null;
let modalAkcjaCtx = null;

let modalHeartbeat = null;
// Zakladki modalu ladowane leniwie - flagi resetowane przy kazdym otwarciu produktu.
let modalZkZaladowane = false;
let modalHistZaladowane = false;

// Przelacza zakladke w modalu produktu i doczytuje jej tresc przy pierwszym wejsciu.
// Historia = szeroka tabela (8 kolumn) -> poszerzamy modal na czas tej zakladki.
function modalPokazTab(nazwa) {
  document.querySelectorAll('#modal-produkt .modal-tab').forEach((b) => b.classList.toggle('aktywny', b.dataset.mtab === nazwa));
  document.querySelectorAll('#modal-produkt .modal-tab-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.mpanel !== nazwa));
  el('modal-produkt').querySelector('.modal-box').classList.toggle('modal-szeroki', nazwa === 'historia');
  if (nazwa === 'zamowienia' && !modalZkZaladowane) { modalZkZaladowane = true; renderModalZk(); }
  if (nazwa === 'historia' && !modalHistZaladowane) { modalHistZaladowane = true; renderModalHistoria(); }
}

function fmtDataZk(iso) {
  if (!iso) return '—';
  const [r, m, d] = String(iso).split('-');
  return d && m && r ? `${d}.${m}.${r}` : iso;
}

// Zakladka "Zamowienia": otwarte ZK rezerwujace towar na K4 - odpowiedz na "z czego
// wynika rezerwacja". Ten sam endpoint co Zebra (GET /api/produkty/:id/rezerwacje),
// tylko gdy jest rezerwacja na K4 (st_StanRez z GT, master). Stopka domyka sume ZK
// z rezerwacja GT - rozbieznosc = zolta (rozjazd do wyjasnienia).
async function renderModalZk() {
  const cont = el('modal-prod-zk');
  const rezK4 = modalProdukt.stany_gt?.K4?.rezerwacja ?? 0;
  if (rezK4 <= 0) { cont.innerHTML = '<div class="modal-zk__stan">Brak rezerwacji na K4.</div>'; return; }
  cont.innerHTML = '<div class="modal-zk__stan">Ładowanie…</div>';
  try {
    const { zk, suma } = await api(`/api/produkty/${encodeURIComponent(modalProdukt.artykul_gt_id)}/rezerwacje`);
    if (!zk.length) { cont.innerHTML = '<div class="modal-zk__stan">Brak otwartych ZK na K4.</div>'; return; }
    const wiersze = zk.map((z) => `<tr>`
      + `<td><strong>${z.nr_pelny || '—'}</strong></td>`
      + `<td>${z.oryg || '—'}</td>`
      + `<td>${fmtDataZk(z.data)}</td>`
      + `<td class="zk-ilosc">${z.ilosc}</td></tr>`).join('');
    const zgodne = suma === rezK4;
    const foot = zgodne ? `Σ ${suma} szt = rezerwacja K4` : `Σ ${suma} szt · rezerwacja K4: ${rezK4}`;
    cont.innerHTML = `<div class="tabela-wrapper"><table class="tabela">`
      + `<thead><tr><th>Nr ZK</th><th>Oryginał</th><th>Data</th><th>Ilość</th></tr></thead>`
      + `<tbody>${wiersze}</tbody></table></div>`
      + `<div class="modal-zk__foot${zgodne ? '' : ' modal-zk__foot--rozjazd'}">${foot}</div>`;
  } catch (err) {
    cont.innerHTML = '<div class="modal-zk__stan">GT niedostępny — nie można odczytać rezerwacji ZK.</div>';
  }
}

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
  // zakladki: start na "Edycja", tresc pozostalych doczytywana leniwie przy wejsciu
  modalZkZaladowane = false;
  modalHistZaladowane = false;
  modalPokazTab('edycja');
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
document.querySelectorAll('#modal-produkt .modal-tab').forEach((b) => {
  b.addEventListener('click', () => modalPokazTab(b.dataset.mtab));
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
  // BRK i K4R to towar niepelnowartosciowy - maja wlasny wiersz i MM w obie strony,
  // wypadaja tylko z sumy "Razem" (config/magazyny.js: liczDoRazem: false).
  for (const mag of ['MAG', 'LS', 'BRK', 'K4R']) dodajMagZewn(tbody, mag);

  // podsumowania na dole. Lista = MAGAZYNY_RAZEM z config/magazyny.js (bez BRK i K4R) -
  // gdyby doszedl kolejny magazyn liczony do "Razem", trzeba ja tu dopisac.
  const rezRazem = ['K4', 'K4G', 'MAG', 'LS'].reduce((s, m) => s + (modalProdukt.stany_gt?.[m]?.rezerwacja ?? 0), 0);
  tbody.appendChild(wierszPodsumowania('Razem', modalProdukt.razem ?? '', 'rozklad-total'));
  if (rezRazem > 0) tbody.appendChild(wierszPodsumowania('Rezerwacje', rezRazem, 'rozklad-total'));
  // "W zestawach" = sztuki tego SKU zamrozone w zestawach zmontowanych na K4 (fizycznie na
  // polce, zaksiegowane pod SKU zestawu). Zob. services/gt-zestawy.js. Tylko gdy > 0.
  const wZest = modalProdukt.w_zestawach ?? 0;
  if (wZest > 0) tbody.appendChild(wierszPodsumowania('W zestawach', wZest, 'rozklad-total'));

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

// Podpisy pozycji do rozlozenia (parytet z Zebra). Dostawa czeka na palecie i idzie zwykle
// na gore; zwrot i przywozka leza w swoich strefach i wracaja na regal.
const RODZAJE_DOK = {
  dostawa:        { etykieta: 'Dostawa',        strefa: null,                akcja: 'Rozłóż',  zadanie: 'do rozłożenia',            domyslnyCel: 'K4G' },
  zwrot:          { etykieta: 'Zwrot',          strefa: 'Strefa zwrotów',    akcja: 'Odnieś',  zadanie: 'do odniesienia na regał',  domyslnyCel: 'K4' },
  przywozka:      { etykieta: 'Przywózka',      strefa: 'Strefa przywózki',  akcja: 'Odnieś',  zadanie: 'do odniesienia na regał',  domyslnyCel: 'K4' },
  przyjecie_wewn: { etykieta: 'Przyjęcie (PW)', strefa: null,                akcja: 'Odnieś',  zadanie: 'do odłożenia na regał',    domyslnyCel: 'K4' },
};

function dodajMagWms(tbody, mag, loki, k4Zapas, planTekst) {
  const gt = modalProdukt.stany_gt?.[mag] ?? { ilosc: 0, rezerwacja: 0 };
  const wmsLoki = loki.filter((l) => l.magazyn === mag).sort((a, b) => porownajKodLok(a.kod, b.kod));
  const wmsSum = wmsLoki.reduce((s, l) => s + l.ilosc, 0);
  const niezlok = Math.max(gt.ilosc - wmsSum, 0);
  let rezPokazana = false;

  // Dostawy (PZ<-FZ) i zwroty (PZ<-KFS) - NAD lokalizacjami, bo to jedyne wiersze z realnym
  // zadaniem (paleta stoi, zwrot lezy w strefie); reszta to tylko stan. Akcja idzie w
  // /ruchy/rozloz: cel dowolny (dol/gora) i w dowolnych porcjach, bez pompowania polki
  // pickowej po drodze - zob. routes/ruchy.js POST /rozloz.
  const doRozlozenia = mag === 'K4'
    ? [...(modalProdukt.dostawy_k4 || []), ...(modalProdukt.zwroty_k4 || []),
       ...(modalProdukt.przywozki_k4 || []), ...(modalProdukt.przyjecia_k4 || [])]
    : [];
  for (const d of doRozlozenia) {
    const r = RODZAJE_DOK[d.rodzaj] || RODZAJE_DOK.dostawa;
    const tr = document.createElement('tr');
    tr.className = 'rozklad-dostawa';
    tr.appendChild(komorka(mag));
    tr.appendChild(komorka(d.ilosc));
    const tdLok = document.createElement('td');
    tdLok.textContent = `${r.etykieta} ${d.fz_nr || d.pz_nr || ''}`.trim();
    const p = document.createElement('div');
    p.className = 'rozklad-plan';
    // przy zwrocie kontrahentem jest klient detaliczny - backend go nie oddaje (dane osobowe)
    const zrodloMag = d.zrodlo_mag ? (MAG_LABEL[d.zrodlo_mag] ?? d.zrodlo_mag) : null;
    p.textContent = [r.strefa, zrodloMag, d.kontrahent, d.data].filter(Boolean).join(' · ');
    p.title = `Przyjęte ${d.pz_nr || ''} — ${r.zadanie}`;
    tdLok.appendChild(p);
    tr.appendChild(tdLok);
    tr.appendChild(komorka());
    const tdA = document.createElement('td');
    tdA.appendChild(przyciskAkcji(r.akcja, () => otworzAkcje({
      typ: 'pula', zrodloMag: mag, zrodloLokId: null, zrodloKod: null, dostepne: d.ilosc, dostawa: d,
    }), true));
    tr.appendChild(tdA);
    tr.appendChild(komorka());
    tbody.appendChild(tr);
  }

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
    // K4 = 1 SKU = 1 lokalizacja: ile mozna przeniesc bierzemy z GT (stan - rez), nie z kopii
    // WMS. K4G: per-lokalizacja jest tylko w WMS (GT nie zna rozbicia).
    const dostepne = mag === 'K4' ? Math.max(gt.ilosc - gt.rezerwacja, 0) : l.ilosc;
    const btn = przyciskAkcji('Przenieś', () => otworzAkcje({ typ: 'wms', zrodloMag: mag, zrodloLokId: l.lokalizacja_id, zrodloKod: l.kod, dostepne }));
    btn.disabled = l.ilosc <= 0;
    tdA.appendChild(btn);
    tr.appendChild(tdA);

    tr.appendChild(komorka(dataEdycji(l.ostatnia_zmiana)));
    tbody.appendChild(tr);
  }

  // Reszta deficytu (stary stan) - stara zasada 1 SKU = 1 lokalizacja, calosc na miejsce.
  // Backend ustawia nieprzypisane_k4 ZAWSZE, gdy rozbicie sie udalo (dostawa/zwrot/przywozka
  // maja swoje wiersze wyzej), wiec sama obecnosc pola wystarczy. Gdy GT padl - caly deficyt.
  const nieprzypisane = (mag === 'K4' && modalProdukt.nieprzypisane_k4 != null)
    ? modalProdukt.nieprzypisane_k4
    : niezlok;
  if (nieprzypisane > 0) {
    const tr = document.createElement('tr');
    tr.className = 'rozklad-nieprzypisano';
    tr.appendChild(komorka(mag));
    tr.appendChild(komorka(nieprzypisane));
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
    tdA.appendChild(przyciskAkcji('Przypisz', () => otworzAkcje({ typ: 'gt', zrodloMag: mag, zrodloLokId: null, zrodloKod: null, dostepne: nieprzypisane }), true));
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
  podlaczTypeaheadLok(inp); // podpowiedzi po 3 znakach (jak w MM / modalu akcji)

  mmZaladujLokCel(inp, null, mag).then(() => { inp.value = l.kod; inp.focus(); });

  let zakonczone = false;
  const zakoncz = async (zatwierdz) => {
    if (zakonczone) return;
    if (zatwierdz) {
      const wpisane = inp.value.trim();
      const nowyId = await lokComboIdRozwiaz(inp, mag);
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
  const rodzajCtx = ctx.typ === 'pula' ? (RODZAJE_DOK[ctx.dostawa?.rodzaj] || RODZAJE_DOK.dostawa) : null;
  el('modal-akcja-typ').textContent = ctx.typ === 'gt' ? 'Przypisz'
    : ctx.typ === 'pula' ? (rodzajCtx.strefa ? `${rodzajCtx.akcja} — ${rodzajCtx.etykieta.toLowerCase()}` : 'Rozłóż')
    : 'Przenieś';
  let zrodloTxt;
  if (ctx.typ === 'gt') zrodloTxt = `z puli „nieprzypisano" (${MAG_LABEL[ctx.zrodloMag]})`;
  else if (ctx.typ === 'pula') {
    const d = ctx.dostawa || {};
    zrodloTxt = rodzajCtx.strefa
      ? `${rodzajCtx.etykieta.toLowerCase()} ${d.fz_nr || d.pz_nr || ''} — ${rodzajCtx.strefa.toLowerCase()}`
      : `dostawa ${d.fz_nr || d.pz_nr || ''}${d.kontrahent ? ' · ' + d.kontrahent : ''} (${MAG_LABEL[ctx.zrodloMag]})`;
  }
  else if (ctx.typ === 'ext') zrodloTxt = `z ${MAG_LABEL[ctx.zrodloMag]}`;
  else zrodloTxt = `z ${ctx.zrodloKod} (${MAG_LABEL[ctx.zrodloMag]})`;
  el('modal-akcja-tytul').innerHTML = `<strong>${modalProdukt.symbol}</strong> ${modalProdukt.nazwa} <span class="modal-akcja-zrodlo">${zrodloTxt}</span>`;

  el('modal-akcja-ile').value = ctx.dostepne || 1;

  const magSel = el('modal-akcja-magazyn');

  // Rozlozenie dostawy dotyczy wylacznie magazynow WMS (K4/K4G) - zewnetrzne nie maja
  // lokalizacji, a backend i tak by je odrzucil. Chowamy je, zeby select nie prowadzil
  // w slepy zaulek. Dla pozostalych akcji pelna lista wraca.
  for (const opt of magSel.options) {
    opt.hidden = ctx.typ === 'pula' && !mmCzyWms(opt.value);
    opt.disabled = opt.hidden;
  }

  if (ctx.typ === 'gt') {
    // przypisanie tylko w obrębie tego samego magazynu WMS
    magSel.value = ctx.zrodloMag;
    magSel.disabled = true;
  } else if (ctx.typ === 'pula') {
    // Rozkladanie dostawy/zwrotu/przywozki: cel DOWOLNY i w dowolnych porcjach - czesc moze
    // zostac na dole (K4, wtedy samo przypisanie), reszta jedzie na gore (K4G, wtedy MM).
    // Backend rozpoznaje operacje po magazynie celu. Domysl bez blokady: dostawa najczesciej
    // idzie na gore, drobnica ze stref wraca na regal.
    magSel.disabled = false;
    magSel.value = rodzajCtx.domyslnyCel;
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
podlaczTypeaheadLok(el('modal-akcja-lok')); // podpowiedzi lokalizacji celu po 3 znakach
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
    lokCelId = await lokComboIdRozwiaz(el('modal-akcja-lok'), celMag);
    if (!lokCelId) { pokazKomunikatEl('modal-akcja-komunikat', 'Wybierz prawidłową lokalizację docelową z listy.', 'blad'); return; }
  }
  if (ctx.typ === 'wms' && celMag === ctx.zrodloMag && lokCelId === ctx.zrodloLokId) {
    pokazKomunikatEl('modal-akcja-komunikat', 'Lokalizacja docelowa jest taka sama jak źródłowa.', 'blad'); return;
  }

  // dobór operacji: w obrębie magazynu WMS / przypisanie z GT -> LOK; między magazynami -> MM
  let url, body;
  if (ctx.typ === 'pula') {
    // MM prosto z nieprzypisanej puli - polka pickowa nie jest po drodze pompowana.
    // zrodlo_dok = ktory dokument rozkladamy; backend go weryfikuje i po nim rozlicza kubelek.
    url = '/api/ruchy/rozloz';
    body = { artykul_gt_id: modalProdukt.artykul_gt_id, mag_zrodlo_pula: ctx.zrodloMag,
             zrodlo_dok: ctx.dostawa?.pz_nr ?? null, lok_cel_id: lokCelId, ilosc: ile,
             operator: operator(), artykul_symbol: modalProdukt.symbol, artykul_nazwa: modalProdukt.nazwa, artykul_ean: modalProdukt.ean ?? null };
  } else if (ctx.typ === 'gt') {
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

przejdzZHasha();
