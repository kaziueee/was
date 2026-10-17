'use strict';

// Ekran Ceny → „Pulpit”: jak idzie automat cen. Dane z GET /api/ceny/pulpit (liczby: pricing/pulpit-model.js).
// Plik ładuje się PRZED app.js i nie ma kodu na poziomie pliku poza deklaracjami — funkcji app.js (el, api, cenyEsc,
// cenyLiczba, cenyGodzina, cenyPokazWidok, odswiezCeny…) używa dopiero w chwili wywołania. app.js woła
// odswiezCenyPulpit() z odswiezCeny(), gdy wybrany jest widok „pulpit”.

// Okno trendu i miara — wygoda stanowiska (localStorage), nie stan systemu.
const cpPamiec = (k, dom) => { try { return localStorage.getItem(k) || dom; } catch { return dom; } };
const cpZapamietaj = (k, v) => { try { localStorage.setItem(k, v); } catch { /* bez pamięci — trudno */ } };
let cpDni = Number(cpPamiec('wms-ceny-pulpit-dni', '14')) || 14;
let cpMiara = cpPamiec('wms-ceny-pulpit-miara', 'bb_auto');
let cpWiersz = 'razem';          // który wiersz tabeli trendu jest na wykresie
let cpDane = null, cpNr = 0, cpTimer = null, cpResizeTimer = null;
const CP_ODSWIEZ_MS = 5 * 60_000;

// Miary trendu. stan = stan na koniec dnia (linia, „zmiana” w ostatniej kolumnie); fs = przepływ z faktur (słupki, „suma”).
const CP_MIARY = [
  { klucz: 'bb_auto', nazwa: 'Buy Box z automatem', stan: true, braki: 'bb_auto',
    opis: 'Ile ofert z automatem (dzisiejsza lista) miało nasz Buy Box na koniec dnia — te same oferty przed włączeniem automatu i po.' },
  { klucz: 'bb', nazwa: 'Buy Box — wszystkie oferty', stan: true, braki: 'bb',
    opis: 'Ile wszystkich obserwowanych ofert ze stanem miało nasz Buy Box na koniec dnia.' },
  { klucz: 'zysk_auto', nazwa: 'Σ zysk/szt. na BB z automatem', stan: true, braki: 'bb_auto', zl: true,
    opis: 'Suma zysku na sztuce (zł, kalkulator WMS) ofert z automatem, które na koniec dnia miały Buy Box — ile zarabiamy na jednej sprzedaży każdej z nich. Oferty bez Buy Boxa się nie liczą: cena-zapora bez sprzedaży zawyżyłaby sumę.' },
  { klucz: 'zamowien', nazwa: 'Zamówienia (FS)', fs: true,
    opis: 'Faktury FS z magazynu K4 wg pola „Źródło zamówienia” w Subiekcie, liczone dniem wystawienia (w weekend FS nie powstają).' },
  { klucz: 'szt', nazwa: 'Sztuki (FS)', fs: true, opis: 'Sztuki towarów i kompletów z tych FS (bez usługi TRANSPORT).' },
  { klucz: 'szt_auto', nazwa: 'Sztuki z automatem (FS)', fs: true,
    opis: 'Sztuki z FS towarów, które mają włączony automat na tym kanale (dzisiejsza lista).' },
];
// Sytuacje na kaflu kanału (nazwy i opisy przychodzą z backendu: pricing/filtry-cen.js).
const CP_SYTUACJE = ['ponizej', 'wojna', 'zablokowane', 'brak_danych', 'szansa', 'podwyzka'];
const CP_NAZWY_ZRODEL = { razem: 'Wszystkie kanały', _marketplace: 'Amazon / Kaufland — „marketplace” (przed 14.10)', _inne: 'Inne źródła (sklep, Erli, Tergo…)' };
const CP_STANY = { ok: 'ok', opoznienie: 'warn', blad: 'blad', stoi: 'blad', brak: 'brak' };

async function odswiezCenyPulpit() {
  const nr = ++cpNr;
  const box = el('ceny-pulpit');
  box.classList.add('cp-laduje');       // poprzedni obraz zostaje (przygaszony), bez migania pustką
  try {
    const d = await api(`/api/ceny/pulpit?dni=${cpDni}`);
    if (nr !== cpNr) return;
    cpDane = d;
    cpRenderuj(d);
  } catch (err) {
    if (nr !== cpNr) return;
    // Plik ekranu jest już nowy, a WMS jeszcze bez trasy (przed restartem) — od razu macierz, bez czerwonego błędu.
    if (err.status === 404) {
      el('cp-zdrowie').innerHTML = '<p class="hint">Pulpit będzie dostępny po restarcie WMS (nowa trasa /api/ceny/pulpit). Do tego czasu — Macierz.</p>';
      cenyPokazWidok('macierz');
      return odswiezCeny();
    }
    pokazKomunikat(err.message, 'blad');
  } finally {
    if (nr === cpNr) box.classList.remove('cp-laduje');
  }
  cpPlanujOdswiezenie();
}

// Na bieżąco: co 5 min, ale tylko gdy pulpit jest na ekranie (inna zakładka / schowana karta = bez zapytań).
function cpPlanujOdswiezenie() {
  clearTimeout(cpTimer);
  cpTimer = setTimeout(() => {
    const widac = cenyWidok === 'pulpit' && !el('panel-ceny').classList.contains('hidden') && document.visibilityState === 'visible';
    if (widac) odswiezCenyPulpit(); else cpPlanujOdswiezenie();
  }, CP_ODSWIEZ_MS);
}

// Kafel/chip prowadzi do macierzy z ustawionym kanałem, zakresem i sytuacją (filtry już istnieją w macierzy).
function cpDoMacierzy(kanal, zakres, sytuacja) {
  cenyKanalWybor = kanal || '';
  cpZapamietaj('wms-ceny-kanal', cenyKanalWybor);
  cenyZakres = zakres || 'wszystkie';
  cenySytuacja = sytuacja || 'wszystkie';
  el('ceny-szukaj').value = '';
  cenyPokazWidok('macierz');
  odswiezCeny();
}

const cpTemu = (min) => (min == null ? '' : min < 1 ? 'przed chwilą' : min < 90 ? `${min} min temu`
  : min < 48 * 60 ? `${Math.round(min / 60)} h temu` : `${Math.round(min / 1440)} dni temu`);
const cpTrwanie = (s) => (s == null ? null : s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`);
const cpMin = (m) => (m == null ? '—' : m < 90 ? `${cenyLiczba(m, m < 10 ? 1 : 0)} min` : `${cenyLiczba(m / 60, 1)} h`);
const cpN = (v) => (v == null ? '—' : Number(v).toLocaleString('pl-PL'));
const cpData = (s) => { const d = dataZBazy(s); return d ? d.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit' }) : ''; };
const cpAttr = (kanal, zakres, sytuacja) => `data-cp-kanal="${cenyEsc(kanal)}" data-cp-zakres="${zakres}" data-cp-sytuacja="${sytuacja}"`;

function cpRenderuj(d) {
  el('ceny-hamulec').classList.toggle('hidden', d.zdrowie.zapis !== false);
  el('cp-zdrowie').innerHTML = cpZdrowieHtml(d.zdrowie);
  el('cp-kpi').innerHTML = cpKpiHtml(d);
  const podlaczone = d.kanaly.filter((k) => k.ofert || k.aktywnosc);
  const brak = d.kanaly.filter((k) => !k.ofert && !k.aktywnosc);
  el('cp-kanaly').innerHTML = podlaczone.map((k) => cpKanalHtml(k, d)).join('');
  el('cp-niepodlaczone').textContent = brak.length ? `Niepodłączone (brak ofert ze stanem): ${brak.map((k) => k.nazwa).join(', ')}.` : '';
  el('ceny-pulpit').querySelectorAll('[data-cp-kanal]').forEach((b) => b.addEventListener('click', () => {
    cpDoMacierzy(b.dataset.cpKanal, b.dataset.cpZakres, b.dataset.cpSytuacja);
  }));
  el('ceny-pulpit').querySelectorAll('[data-cp-log]').forEach((b) => b.addEventListener('click', () => { cenyPokazWidok('log'); odswiezCeny(); }));
  el('cp-stan').textContent = `Stan na ${cenyGodzina(d.teraz)} · odświeża się co 5 min`;
  cpRenderujTrend(d);
}

// --- Zdrowie: worker, wysyłanie, synchronizacje platform ------------------------------------------------------
function cpZdrowieHtml(z) {
  const w = z.worker;
  const wTekst = w.stan === 'brak' ? 'Worker jeszcze nie ruszył'
    : `Worker · przebieg ${cenyGodzina(w.przebieg_czas)} (${cpTemu(w.minut_temu)})${cpTrwanie(w.sekundy) ? ` · trwał ${cpTrwanie(w.sekundy)}` : ''}`
      + `${w.ofert != null ? ` · ${cpN(w.ofert)} ofert` : ''}${w.wysylka ? ` · wysłane ${w.wysylka.wyslane}${w.wysylka.odrzucone ? `, odrzucone ${w.wysylka.odrzucone}` : ''}` : ''}`
      + (w.stan === 'stoi' ? ` · STOI — przebieg co ${w.interwal_min} min` : '');
  const wTytul = `Pełna obserwacja katalogu (oferty bez automatu): ${w.pelna_obserwacja ? cenyGodzina(w.pelna_obserwacja) : '—'}`;
  const pills = [
    `<span class="cp-pill ${CP_STANY[w.stan]}" title="${cenyEsc(wTytul)}"><i></i>${cenyEsc(wTekst)}</span>`,
    `<span class="cp-pill ${z.zapis ? 'ok' : 'blad'}" title="PRICING_ZAPIS w .env na serwerze"><i></i>Wysyłanie cen: ${z.zapis ? 'włączone' : 'WSTRZYMANE'}</span>`,
  ];
  const bledy = [];
  if (w.blad) bledy.push(`Worker (${cenyGodzina(w.blad.czas)}): ${w.blad.tekst}`);
  for (const p of z.platformy) {
    if (p.stan === 'brak') { pills.push(`<span class="cp-pill brak" title="Brak ofert i synchronizacji — kanał jeszcze niepodłączony"><i></i>${cenyEsc(p.nazwa)} · niepodłączony</span>`); continue; }
    const lista = p.sync_czas ? `lista ${cenyGodzina(p.sync_czas)}` : 'lista —';
    const obs = p.obserwacja_czas ? ` · obserwacja ${cenyGodzina(p.obserwacja_czas)}` : '';
    const tytul = `${p.rytm === 'doba' ? 'Lista ofert raz na dobę' : 'Lista ofert co przebieg'}${p.sync_czas ? ` · ostatnia ${cpTemu(p.sync_minut_temu)}` : ''}`
      + `${p.obserwacja_czas ? ` · ostatnia obserwacja ${cpTemu(p.obserwacja_minut_temu)}` : ''}${p.blad ? ` · błąd: ${p.blad.tekst}` : ''}`;
    pills.push(`<span class="cp-pill ${CP_STANY[p.stan]}" title="${cenyEsc(tytul)}"><i></i>${cenyEsc(p.nazwa)} · ${lista}${obs}${p.stan === 'opoznienie' ? ' · opóźnione' : ''}</span>`);
    if (p.blad) bledy.push(`${p.nazwa} (${cenyGodzina(p.blad.czas)}): ${p.blad.tekst}`);
  }
  return `<div class="cp-pills">${pills.join('')}</div>${bledy.map((b) => `<div class="ceny-blad cp-blad">${cenyEsc(b)}</div>`).join('')}`;
}

// --- Liczby zbiorcze -------------------------------------------------------------------------------------------
function cpZmianaHtml(b, etykieta, od) {
  if (!b) return '';
  if (b.zmiana == null) return `<span class="cp-sz" title="Wtedy jeszcze nie obserwowaliśmy tego kanału — nie ma z czym porównać">${etykieta}: brak danych${od ? ` (obserwacja od ${cpData(od)})` : ''}</span>`;
  const z = b.zmiana > 0 ? `<b class="ceny-gora">+${b.zmiana}</b>` : b.zmiana < 0 ? `<b class="ceny-dol">−${-b.zmiana}</b>` : '<b>±0</b>';
  return `<span>${etykieta} ${z} <span class="cp-sz" title="Wśród ofert widzianych w obu chwilach: ile Buy Boxów zdobyliśmy i ile straciliśmy. Reszta różnicy to oferty, które doszły albo wypadły (np. skończył się stan).">(+${b.zyskane} / −${b.stracone})</span>${b.czesciowo ? ' <span class="cp-sz" title="Część kanałów nie miała wtedy obserwacji — ich Buy Boxy nie wchodzą do porównania">*</span>' : ''}</span>`;
}

function cpKafel({ etykieta, wartosc, podpis, wariant, atrybuty = '', tytul = '' }) {
  return `<div class="kafel${wariant ? ` kafel-${wariant}` : ''}${atrybuty ? ' kafel-klik' : ''}" ${atrybuty}${tytul ? ` title="${cenyEsc(tytul)}"` : ''}>
    <div class="kafel-wartosc">${wartosc}</div><div class="kafel-etykieta">${etykieta}</div>${podpis ? `<div class="kafel-podpis">${podpis}</div>` : ''}</div>`;
}

function cpKpiHtml(d) {
  const r = d.razem, a = r.aktywnosc || { h24: {}, d7: {}, potwierdzenie: {} };
  const bb = (g, nazwa, zakres) => cpKafel({
    etykieta: nazwa, wartosc: `${cpN(g.h24.teraz)}<small> / ${cpN(g.h24.ofert)}</small>`,
    podpis: `${cpZmianaHtml(g.h24, '24 h')}<br>${cpZmianaHtml(g.d7, '7 dni')}`, wariant: 'blue', atrybuty: cpAttr('', zakres, 'bb'),
  });
  const wys24 = (a.h24.gora || 0) + (a.h24.dol || 0), wys7 = (a.d7.gora || 0) + (a.d7.dol || 0);
  const p = a.potwierdzenie || {};
  return [
    bb(r.bb.automat, 'Buy Box — oferty z automatem', 'automat'),
    bb(r.bb.wszystkie, 'Buy Box — wszystkie oferty', 'wszystkie'),
    cpKafel({ etykieta: 'Zmiany cen wysłane przez automat (24 h)', wartosc: `${cpN(wys24)}`, atrybuty: 'data-cp-log="1"',
      podpis: `↑ ${cpN(a.h24.gora)} w górę · ↓ ${cpN(a.h24.dol)} w dół<br>7 dni: ${cpN(wys7)} (↑ ${cpN(a.d7.gora)} · ↓ ${cpN(a.d7.dol)})${a.d7.reczne ? ` · ręcznie ${cpN(a.d7.reczne)}` : ''}` }),
    cpKafel({ etykieta: 'Odrzucone przez platformę (24 h)', wartosc: cpN(a.h24.odrzucone), wariant: a.h24.odrzucone ? 'red' : '',
      podpis: `7 dni: ${cpN(a.d7.odrzucone)}${a.ostatni_blad ? `<br>ostatnio ${cenyGodzina(a.ostatni_blad.czas)} · ${cenyEsc(a.ostatni_blad.sku)}` : ''}`,
      tytul: a.ostatni_blad ? `${a.ostatni_blad.sku}: ${a.ostatni_blad.tekst}` : '' }),
    cpKafel({ etykieta: 'W drodze — czeka na potwierdzenie', wartosc: cpN(r.czeka.n), wariant: a.niepotwierdzone ? 'amber' : '',
      podpis: `${r.czeka.n ? `najdłużej ${cpMin(r.czeka.najdluzej_min)} · ` : ''}niepotwierdzone (7 dni): ${cpN(a.niepotwierdzone)}`,
      tytul: `Wysłane, a platforma jeszcze nie pokazała nowej ceny. Niepotwierdzone = ostatnia wysyłka oferty sprzed ponad ${d.czeka_min} min, której ceny nie zobaczyliśmy.` }),
    cpKafel({ etykieta: 'Nowa cena widoczna po (mediana, 7 dni)', wartosc: cpMin(p.mediana),
      podpis: p.n ? `90% w ${cpMin(p.p90)} · najdłużej ${cpMin(p.max)} · ${cpN(p.n)} zmian` : 'brak wysłanych zmian',
      tytul: 'Od wysłania do pierwszej obserwacji z nową ceną. Ograniczone rytmem obserwacji: Amazon sprawdzamy 5 min po wysłaniu, potem co przebieg (30 min).' }),
  ].join('');
}

// --- Kafel kanału ---------------------------------------------------------------------------------------------
function cpSparkline(wartosci, dni) {
  const pkt = wartosci.map((v, i) => ({ v, i })).filter((p) => p.v != null);
  if (pkt.length < 2) return '';
  const W = 132, H = 34, lo = Math.min(...pkt.map((p) => p.v)), hi = Math.max(...pkt.map((p) => p.v));
  const x = (i) => 3 + (i / Math.max(1, wartosci.length - 1)) * (W - 6);
  const y = (v) => H - 4 - ((v - lo) / (hi - lo || 1)) * (H - 8);
  const ost = pkt[pkt.length - 1];
  const opis = pkt.map((p) => `${dni[p.i].slice(8, 10)}.${dni[p.i].slice(5, 7)}: ${p.v}`).join('\n');
  return `<svg class="cp-spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Buy Box dzień po dniu">
    <title>${cenyEsc(opis)}</title>
    <polyline points="${pkt.map((p) => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')}"/>
    <circle cx="${x(ost.i).toFixed(1)}" cy="${y(ost.v).toFixed(1)}" r="3"/></svg>`;
}

function cpKanalHtml(k, d) {
  const trend = d.trend.kanaly[k.klucz] || [];
  const a = k.aktywnosc;
  const auto = k.automat > 0;
  const g = auto ? k.bb.automat : k.bb.wszystkie;
  const meta = auto ? `automat na ${cpN(k.automat)} z ${cpN(k.ofert)} ofert` : `${cpN(k.ofert)} ofert ze stanem · ${k.tylko_odczyt ? 'tylko odczyt' : 'bez automatu'}`;
  const bb = k.bez_konkurencji
    ? '<div class="cp-sz">Platforma nie podaje cen konkurencji — Buy Boxa nie liczymy.</div>'
    : `<div class="cp-k-bb">
        <div class="cp-k-bb-l">
          <span class="ceny-et">${auto ? 'Buy Box — oferty z automatem' : 'Buy Box'}</span>
          <button type="button" class="cp-duza" ${cpAttr(k.klucz, auto ? 'automat' : 'wszystkie', 'bb')} title="Buy Box na ${cpN(g.h24?.teraz)} z ${cpN(g.h24?.ofert)} obserwowanych ofert — pokaż w macierzy">${cpN(g.h24?.teraz)}<small> / ${cpN(g.h24?.ofert)}</small></button>
          <div class="cp-k-zm">${cpZmianaHtml(g.h24, '24 h')}</div>
          <div class="cp-k-zm">${cpZmianaHtml(g.d7, '7 dni', k.obserwacja_od)}</div>
        </div>
        ${cpSparkline(trend.map((p) => p[auto ? 'bb_auto' : 'bb']), d.trend.dni)}
      </div>
      ${auto ? `<button type="button" class="cp-k-linia" ${cpAttr(k.klucz, 'wszystkie', 'bb')}>Wszystkie oferty: <b>${cpN(k.bb.wszystkie.h24?.teraz)}</b> / ${cpN(k.bb.wszystkie.h24?.ofert)} · ${cpZmianaHtml(k.bb.wszystkie.h24, '24 h')}</button>` : ''}`;
  let akt = '';
  if (a && (auto || a.d7.reczne || a.d7.odrzucone)) {
    const p = a.potwierdzenie || {};
    akt = `<div class="cp-k-akt">
      <div>Wysłane 24 h <b>↑ ${a.h24.gora} · ↓ ${a.h24.dol}</b> <span class="cp-sz">· 7 dni ↑ ${a.d7.gora} · ↓ ${a.d7.dol}${a.d7.reczne ? ` · ręcznie ${a.d7.reczne}` : ''}</span></div>
      <div${a.ostatni_blad ? ` title="${cenyEsc(`${a.ostatni_blad.sku} (${cenyGodzina(a.ostatni_blad.czas)}): ${a.ostatni_blad.tekst}`)}"` : ''}>Odrzucone 24 h <b class="${a.h24.odrzucone ? 'ceny-dol' : ''}">${a.h24.odrzucone}</b> <span class="cp-sz">· 7 dni ${a.d7.odrzucone}</span></div>
      <div>W drodze <b>${k.czeka.n}</b>${k.czeka.n ? ` <span class="cp-sz">(najdłużej ${cpMin(k.czeka.najdluzej_min)})</span>` : ''} · niepotwierdzone <b class="${a.niepotwierdzone ? 'cp-uwaga' : ''}">${a.niepotwierdzone}</b></div>
      ${p.n ? `<div>Nowa cena widoczna po <b>${cpMin(p.mediana)}</b> <span class="cp-sz">· 90% w ${cpMin(p.p90)}</span></div>` : ''}
    </div>`;
  }
  const opis = Object.fromEntries((d.sytuacje || []).map((s) => [s.klucz, s]));
  const syt = k.sytuacje ? `<div class="cp-k-syt">${CP_SYTUACJE.map((s) => {
    const n = k.sytuacje[s] || 0;
    return `<button type="button" class="ceny-chip cp-chip${n ? '' : ' zero'}" ${cpAttr(k.klucz, 'wszystkie', s)} title="${cenyEsc(opis[s]?.opis || '')}">${cenyEsc(opis[s]?.nazwa || s)} <b>${n}</b></button>`;
  }).join('')}</div>` : '';
  return `<div class="cp-kanal">
    <div class="cp-k-gora"><button type="button" class="cp-k-nazwa" ${cpAttr(k.klucz, 'wszystkie', 'wszystkie')} title="Macierz tego kanału">${cenyEsc(k.nazwa)}</button><span class="cp-sz">${meta}</span></div>
    ${bb}${akt}${syt}</div>`;
}

// --- Trend dzień po dniu --------------------------------------------------------------------------------------
function cpRenderujTrend(d) {
  const miara = CP_MIARY.find((x) => x.klucz === cpMiara) || CP_MIARY[0];
  cpMiara = miara.klucz;
  const box = el('cp-trend');
  let t = d.trend;
  if (miara.stan) {
    const od = t.kanaly.razem.findIndex((p) => p[miara.klucz] != null);
    if (od > 0) t = cpPrzytnij(t, od);
  }
  const fsBrak = miara.fs && !t.gt_ok;
  // Wiersze: wszystkie kanały, potem kanały z jakąkolwiek wartością tej miary (zero też się liczy przy FS).
  const kanaly = [{ klucz: 'razem', nazwa: CP_NAZWY_ZRODEL.razem },
    ...d.kanaly.map((k) => ({ klucz: k.klucz, nazwa: k.nazwa })),
    ...(miara.fs ? [{ klucz: '_marketplace', nazwa: CP_NAZWY_ZRODEL._marketplace }, { klucz: '_inne', nazwa: CP_NAZWY_ZRODEL._inne }] : [])]
    .filter((k) => k.klucz === 'razem' || (t.kanaly[k.klucz] || []).some((p) => (miara.fs ? p[miara.klucz] > 0 : p[miara.klucz] != null)));
  if (!kanaly.some((k) => k.klucz === cpWiersz)) cpWiersz = 'razem';
  const dzis = t.dni[t.dni.length - 1];
  const naglowekDnia = (dz) => {
    const dt = new Date(`${dz}T12:00:00`);
    const tydz = dt.toLocaleDateString('pl-PL', { weekday: 'short' });
    return `<th class="cp-dz${dt.getDay() % 6 === 0 ? ' weekend' : ''}">${dz === dzis ? 'dziś' : cenyEsc(tydz)}<br>${dz.slice(8, 10)}.${dz.slice(5, 7)}</th>`;
  };
  const fmt = (v) => (v == null ? '—' : miara.zl ? cenyLiczba(v, 0) : cpN(v));
  const braki = miara.braki ? t.braki[miara.braki] : null;
  const nazwy = Object.fromEntries(d.kanaly.map((k) => [k.klucz, k.nazwa]));
  const komorka = (k, p, i) => {
    const v = p ? p[miara.klucz] : null;
    const czesc = k === 'razem' && braki && v != null && braki[i].length;
    const tytul = czesc ? `Bez kanałów, których wtedy jeszcze nie obserwowaliśmy: ${braki[i].map((x) => nazwy[x] || x).join(', ')}`
      : miara.zl && v != null && p.zysk_auto_n ? `średnio ${cenyLiczba(v / p.zysk_auto_n)} zł/szt. na ${p.zysk_auto_n} ofertach z Buy Boxem` : '';
    return `<td class="num${t.dni[i] === dzis ? ' cp-dzis' : ''}"${tytul ? ` title="${cenyEsc(tytul)}"` : ''}>${fmt(v)}${czesc ? '<sup>*</sup>' : ''}</td>`;
  };
  const podsumowanie = (seria, klucz) => {
    const v = seria.map((p, i) => (klucz === 'razem' && braki?.[i]?.length ? null : p?.[miara.klucz])).filter((x) => x != null);
    if (!v.length) return '—';
    if (miara.fs) return fmt(v.reduce((a, b) => a + b, 0));
    const z = Math.round((v[v.length - 1] - v[0]) * 100) / 100;
    return z > 0 ? `<span class="ceny-gora">+${fmt(z)}</span>` : z < 0 ? `<span class="ceny-dol">−${fmt(-z)}</span>` : '±0';
  };
  const wiersze = kanaly.map((k) => {
    const seria = t.kanaly[k.klucz] || [];
    return `<tr class="cp-tr${k.klucz === cpWiersz ? ' wybrany' : ''}${k.klucz === 'razem' ? ' razem' : ''}" data-cp-wiersz="${cenyEsc(k.klucz)}">
      <td class="cp-tr-nazwa">${cenyEsc(k.nazwa)}</td>${t.dni.map((_, i) => komorka(k.klucz, seria[i], i)).join('')}<td class="num cp-suma">${podsumowanie(seria, k.klucz)}</td></tr>`;
  }).join('');

  box.innerHTML = `
    <div class="cp-trend-pasek">
      <div class="ceny-rzad">${CP_MIARY.map((x) => `<button type="button" class="ceny-chip${x.klucz === miara.klucz ? ' aktywny' : ''}" data-cp-miara="${x.klucz}" title="${cenyEsc(x.opis)}">${cenyEsc(x.nazwa)}</button>`).join('')}</div>
      <div class="ceny-rzad"><span class="cp-sz">Okno:</span>${(d.okna || [7, 14, 30]).map((n) => `<button type="button" class="ceny-chip${n === d.okno ? ' aktywny' : ''}" data-cp-dni="${n}">${n} dni</button>`).join('')}</div>
    </div>
    <p class="hint cp-miara-opis">${cenyEsc(miara.opis)}${miara.stan ? ` Stan na koniec dnia (dziś — teraz); oferta liczy się, gdy była obserwowana w ciągu ${d.tolerancja_h} h.` : ''}</p>
    ${fsBrak ? '<p class="ceny-blad">Subiekt nie odpowiada — bez faktur. Buy Boxy i zysk liczą się dalej.</p>' : `
    <div class="cp-wykres-box" id="cp-wykres"></div>
    <div class="tabela-wrapper cp-tabela-wrap"><table class="tabela cp-tabela">
      <thead><tr><th>Kanał <span class="cp-sz">(kliknij — na wykres)</span></th>${t.dni.map(naglowekDnia).join('')}<th>${miara.fs ? 'Suma' : 'Zmiana'}</th></tr></thead>
      <tbody>${wiersze}</tbody></table></div>
    ${miara.fs ? '<p class="hint">Amazon DE/FR/IT i Kaufland mają w Subiekcie własne „Źródło” od 14.10 (12:22) — wcześniej integrator wpisywał każdy z nich jako „marketplace”, więc tamte FS stoją w osobnym wierszu. Amazon PL przychodzi jako „amazon”.</p>' : ''}
    ${braki && braki.some((b) => b.length) ? '<p class="hint"><sup>*</sup> Suma bez kanałów, których tego dnia jeszcze nie obserwowaliśmy — wzrost sumy to wtedy nowy kanał, nie zdobyte Buy Boxy (na wykresie pusty punkt). „Zmiana” sumy liczy się od pierwszego pełnego dnia.</p>' : ''}
    ${t.dni.length < d.trend.dni.length ? `<p class="hint">Obserwacje od ${t.dni[0].slice(8, 10)}.${t.dni[0].slice(5, 7)} — wcześniejszych dni nie ma z czego policzyć.</p>` : ''}`}`;
  box.querySelectorAll('[data-cp-miara]').forEach((b) => b.addEventListener('click', () => {
    cpMiara = b.dataset.cpMiara; cpZapamietaj('wms-ceny-pulpit-miara', cpMiara); cpRenderujTrend(cpDane);
  }));
  box.querySelectorAll('[data-cp-dni]').forEach((b) => b.addEventListener('click', () => {
    cpDni = Number(b.dataset.cpDni); cpZapamietaj('wms-ceny-pulpit-dni', String(cpDni)); odswiezCenyPulpit();
  }));
  box.querySelectorAll('[data-cp-wiersz]').forEach((tr) => tr.addEventListener('click', () => { cpWiersz = tr.dataset.cpWiersz; cpRenderujTrend(cpDane); }));
  if (!fsBrak) cpWykres(el('cp-wykres'), miara, t, cpWiersz, kanaly.find((k) => k.klucz === cpWiersz)?.nazwa || '', braki, nazwy);
}

// Trend od dnia `od` (indeks) — te same tablice, przycięte z przodu.
function cpPrzytnij(t, od) {
  return { ...t, dni: t.dni.slice(od), kanaly: Object.fromEntries(Object.entries(t.kanaly).map(([k, v]) => [k, v.slice(od)])),
    braki: Object.fromEntries(Object.entries(t.braki || {}).map(([k, v]) => [k, v.slice(od)])) };
}

// Wykres jednej serii (wybrany wiersz tabeli): linia dla stanu, słupki dla faktur. Jedna oś, bez biblioteki;
// najechanie = pionowa linia na najbliższym dniu i dymek z wartością (te same liczby są w tabeli pod spodem).
function cpWykres(box, miara, t, klucz, nazwa, braki, nazwy) {
  const seria = (t.kanaly[klucz] || []).map((p) => p?.[miara.klucz] ?? null);
  const pkt = seria.map((v, i) => ({ v, i })).filter((p) => p.v != null);
  if (!pkt.length) { box.innerHTML = '<p class="hint">Brak danych w tym oknie.</p>'; return; }
  const W = Math.max(320, box.clientWidth || 800), H = 210, L = 52, R = 14, G = 14, D = 30;
  const n = seria.length;
  const krok = (W - L - R) / n;
  const x = (i) => L + krok * (i + 0.5);
  const vals = pkt.map((p) => p.v);
  let lo = miara.fs ? 0 : Math.min(...vals), hi = Math.max(...vals, miara.fs ? 1 : -Infinity);
  if (lo === hi) { lo = Math.max(0, lo - 1); hi += 1; }
  const zakres = hi - lo, pot = 10 ** Math.floor(Math.log10(zakres / 4)), kroki = [1, 2, 2.5, 5, 10].map((k) => k * pot);
  const kTick = kroki.find((k) => zakres / k <= 5) || kroki[kroki.length - 1];
  const y0 = Math.floor(lo / kTick) * kTick, y1 = Math.ceil(hi / kTick) * kTick;
  const y = (v) => G + (H - G - D) * (1 - (v - y0) / (y1 - y0 || 1));
  const ticki = [];
  for (let v = y0; v <= y1 + kTick / 2; v += kTick) ticki.push(Math.round(v * 100) / 100);
  const fmt = (v) => (miara.zl ? `${cenyLiczba(v, 0)} zł` : cpN(v));
  const fmtOs = (v) => (Math.abs(v) >= 10000 ? `${cenyLiczba(v / 1000, 0)} tys.` : cpN(v));
  const dzien = (i) => `${t.dni[i].slice(8, 10)}.${t.dni[i].slice(5, 7)}`;
  const czesc = (i) => klucz === 'razem' && braki && braki[i]?.length;
  let marki = '';
  if (miara.fs) {
    const sz = Math.min(24, krok * 0.6);
    marki = pkt.map((p) => {
      const top = y(p.v), dol = y(0), h = Math.max(0, dol - top), r = Math.min(4, h / 2, sz / 2);
      return h ? `<path class="cp-slup" d="M${x(p.i) - sz / 2},${dol} V${top + r} Q${x(p.i) - sz / 2},${top} ${x(p.i) - sz / 2 + r},${top} H${x(p.i) + sz / 2 - r} Q${x(p.i) + sz / 2},${top} ${x(p.i) + sz / 2},${top + r} V${dol} Z"/>` : '';
    }).join('');
  } else {
    // linia przerywa się na dniach bez danych
    const odcinki = [];
    let biezacy = [];
    seria.forEach((v, i) => { if (v == null) { if (biezacy.length) odcinki.push(biezacy); biezacy = []; } else biezacy.push([x(i), y(v)]); });
    if (biezacy.length) odcinki.push(biezacy);
    marki = odcinki.map((o) => `<polyline class="cp-linia" points="${o.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(' ')}"/>`).join('')
      + pkt.map((p) => `<circle class="cp-pkt${czesc(p.i) ? ' czesc' : ''}" cx="${x(p.i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="4"/>`).join('');
  }
  // Podpis jednej wartości: przy stanie — ostatni punkt (gdzie jesteśmy), przy fakturach — najwyższy słupek.
  const ost = miara.fs ? pkt.reduce((a, b) => (b.v > a.v ? b : a)) : pkt[pkt.length - 1];
  box.innerHTML = `<div class="cp-wykres-tyt">${cenyEsc(miara.nazwa)} — ${cenyEsc(nazwa)}</div>
    <svg class="cp-wykres" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${cenyEsc(`${miara.nazwa} — ${nazwa}, dzień po dniu`)}">
      ${ticki.map((v) => `<line class="cp-siatka" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="cp-os" x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${fmtOs(v)}</text>`).join('')}
      ${seria.map((_, i) => (n <= 16 || i % 2 === (n - 1) % 2 ? `<text class="cp-os" x="${x(i).toFixed(1)}" y="${H - 10}" text-anchor="middle">${dzien(i)}</text>` : '')).join('')}
      ${marki}
      <text class="cp-etyk" x="${Math.min(x(ost.i), W - R - 4).toFixed(1)}" y="${(y(ost.v) - 9).toFixed(1)}" text-anchor="${x(ost.i) > W - 80 ? 'end' : 'middle'}">${fmt(ost.v)}</text>
      <line class="cp-krzyz hidden" y1="${G}" y2="${H - D}"/>
      <rect class="cp-hit" x="${L}" y="0" width="${W - L - R}" height="${H}"/>
    </svg><div class="cp-dymek hidden"></div>`;
  const svg = box.querySelector('svg'), krzyz = box.querySelector('.cp-krzyz'), dymek = box.querySelector('.cp-dymek');
  const pokaz = (ev) => {
    const r = svg.getBoundingClientRect();
    const i = Math.max(0, Math.min(n - 1, Math.floor((ev.clientX - r.left - L) / krok)));
    krzyz.setAttribute('x1', x(i)); krzyz.setAttribute('x2', x(i));
    krzyz.classList.remove('hidden');
    const v = seria[i], p = (t.kanaly[klucz] || [])[i];
    dymek.textContent = '';
    const b = document.createElement('b'); b.textContent = v == null ? '—' : fmt(v);
    const s = document.createElement('span'); s.textContent = ` ${dzien(i)}`;
    dymek.append(b, s);
    const dop = miara.zl && v != null && p?.zysk_auto_n ? `śr. ${cenyLiczba(v / p.zysk_auto_n)} zł/szt. · ${p.zysk_auto_n} ofert z BB`
      : czesc(i) ? `bez: ${braki[i].map((k) => nazwy[k] || k).join(', ')}` : '';
    if (dop) { const e = document.createElement('div'); e.className = 'cp-sz'; e.textContent = dop; dymek.append(e); }
    dymek.classList.remove('hidden');
    dymek.style.left = `${Math.min(x(i) + 10, W - 190)}px`;
    dymek.style.top = `${v == null ? G : Math.max(0, y(v) - 40)}px`;
  };
  svg.querySelector('.cp-hit').addEventListener('pointermove', pokaz);
  svg.querySelector('.cp-hit').addEventListener('pointerleave', () => { krzyz.classList.add('hidden'); dymek.classList.add('hidden'); });
}

// Pierwsze wejście na #ceny potrafi wyprzedzić logowanie (401) — po zalogowaniu rysujemy jeszcze raz, jak pulpit WMS.
window.addEventListener('wms-zalogowano', () => {
  if (cenyWidok === 'pulpit' && !el('panel-ceny').classList.contains('hidden')) odswiezCenyPulpit();
});

// Szerokość wykresu idzie za oknem (rysujemy w pikselach, żeby tekst osi się nie skalował).
window.addEventListener('resize', () => {
  clearTimeout(cpResizeTimer);
  cpResizeTimer = setTimeout(() => { if (cpDane && cenyWidok === 'pulpit' && !el('panel-ceny').classList.contains('hidden')) cpRenderujTrend(cpDane); }, 200);
});
