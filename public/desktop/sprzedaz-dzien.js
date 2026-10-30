'use strict';

// Sprzedaż → „Dzień” (desktop): podsumowanie dnia albo zakresu vs ten sam dzień tygodnia rok temu, kanały, produkty.
// Dane z GET /api/analiza/* (moduł analiz sprzedaży, docs/analiza-sprzedazy.md); formatowanie i grupowanie kanałów
// wspólne z telefonem (/shared/sprzedaz-wspolne.js). Plik ładuje się PRZED app.js i nie ma kodu na poziomie pliku
// poza deklaracjami — funkcji app.js (el, api) używa dopiero w chwili wywołania. app.js woła odswiezSprzedazDzien().

const sdPamiec = (k, d) => { try { return localStorage.getItem('wms-sprzedaz-' + k) || d; } catch { return d; } };
const sdZapamietaj = (k, v) => { try { localStorage.setItem('wms-sprzedaz-' + k, v); } catch { /* bez pamięci */ } };
const SD_OPCJE = {
  zakres: [['dzien', 'Dzień'], ['t7', '7 dni'], ['mtd', 'Miesiąc'], ['ytd', 'Rok']],   // poza „Dzień” — dni zamknięte
  baza: [['zam', 'wg zamówienia'], ['fs', 'wg faktury']],
  sort: [['zysk', 'zysk'], ['szt', 'sztuki'], ['netto', 'przychód']],
  grsort: [['netto', 'wg przychodu'], ['spadek', 'największe spadki'], ['wzrost', 'największe wzrosty']],
};
// kanal — porównanie po kanałach (decyzja usera 2026-10-30): '' | 'k:DE' | 'k:ALLEGRO_EKAJTEK|CZ' | 'p:Amazon'; grupy i produkty
// liczą się wtedy wyłącznie z niego. grupa — zawężenie listy produktów po kliknięciu grupy (po stronie przeglądarki).
const sdStan = { dzien: null, dzis: null, zakres: sdPamiec('zakres', 'dzien'), baza: sdPamiec('baza', 'zam'), sort: sdPamiec('sort', 'zysk'),
  kanal: sdPamiec('kanal', ''), grsort: sdPamiec('grsort', 'netto'), grupa: '' };
const sdOtwarte = new Set();
let sdNr = 0, sdPodsumowanie = null, sdProd = null, sdGrupy = null, sdGrWszystkie = false;
// sortowanie tabeli produktów po kolumnie (klik w nagłówek); null = kolejność z przełącznika zysk / sztuki / przychód
const sdKol = { k: null, kier: -1 };

async function odswiezSprzedazDzien() {
  const W = window.SprzedazW;
  if (!sdStan.dzis) {
    try { const s = await api('/api/analiza/stan'); sdStan.dzis = s.dzis; sdStan.dzien = s.dzis; }
    catch (e) { el('sd-tresc').innerHTML = `<p class="hint">${W.esc(e.message)}</p>`; return; }
  }
  sdPrzelaczniki();
  const moje = ++sdNr;
  const q = `dzien=${sdStan.dzien}&zakres=${sdStan.zakres}&baza=${sdStan.baza}`;
  el('sd-blad').classList.add('hidden');
  try {
    const qk = `${q}&kanal=${encodeURIComponent(sdStan.kanal)}`;
    const [pod, prod, gr] = await Promise.all([api(`/api/analiza/podsumowanie?${q}`), api(`/api/analiza/produkty?${qk}&sort=${sdStan.sort}&limit=2000`),
      api(`/api/analiza/grupy?${qk}`)]);
    if (moje !== sdNr) return;
    sdPodsumowanie = pod;
    sdRysujPodsumowanie(pod);
    sdGrupy = gr;
    sdRysujGrupy();
    sdProd = prod;
    sdRysujProdukty(prod, pod);
  } catch (e) {
    if (moje !== sdNr) return;
    el('sd-blad').textContent = e.message;
    el('sd-blad').classList.remove('hidden');
  }
}

function sdPrzelaczniki() {
  for (const co of ['zakres', 'baza', 'sort', 'grsort']) {
    const p = el('sd-seg-' + co);
    p.innerHTML = SD_OPCJE[co].map(([v, t]) => `<button type="button" data-v="${v}" class="${sdStan[co] === v ? 'wl' : ''}">${t}</button>`).join('');
    p.querySelectorAll('button').forEach((b) => { b.onclick = () => {
      sdStan[co] = b.dataset.v; sdZapamietaj(co, sdStan[co]);
      if (co === 'grsort') { sdPrzelaczniki(); sdRysujGrupy(); return; }                 // sortowanie grup — bez pytania serwera
      if (co === 'sort') sdKol.k = null;
      odswiezSprzedazDzien();
    }; });
  }
  el('sd-data').value = sdStan.dzien || '';
  el('sd-data').max = sdStan.dzis || '';
  el('sd-dalej').disabled = !sdStan.dzis || sdStan.dzien >= sdStan.dzis;
}

function sdRysujPodsumowanie(d) {
  const W = window.SprzedazW;
  const sc = W.sumy(d.cur.kanaly), sp = W.sumy(d.prev.kanaly), o = d.okresy;
  el('sd-vs').textContent = `${W.zakresTxt(o.cur)} vs ${W.zakresTxt(o.prev)} (−364 dni)`;
  const mc = W.marza(sc), mp = W.marza(sp);
  const kafle = [
    ['Przychód netto (internet)', W.zl(sc.netto), W.zl(sp.netto), W.zmiana(sc.netto, sp.netto)
      + (sc.doplata ? ` · <span title="Allegro Ceny / AlleObniżka: klient zapłacił mniej, Allegro dopłaciło do ceny oferty — faktura tego nie zna">w tym dopłata Allegro ${W.zl(sc.doplata)}</span>` : '')],
    ['Marża', W.pct(mc), W.pct(mp), mc == null || mp == null ? '' : `<span class="${mc >= mp ? 'sw-plus' : 'sw-minus'}">${mc >= mp ? '+' : ''}${W.nf1.format(mc - mp)} pp</span>`],
    ['Zysk na sztuce', W.naSzt(sc.zysk, sc.szt), W.naSzt(sp.zysk, sp.szt), W.zmiana(sc.szt ? sc.zysk / sc.szt : null, sp.szt ? sp.zysk / sp.szt : null)],
    ['Zysk po kosztach kanału', W.zl(sc.zysk), W.zl(sp.zysk), W.zmiana(sc.zysk, sp.zysk)],
    ['Sztuki', W.szt(sc.szt), W.szt(sp.szt), W.zmiana(sc.szt, sp.szt)],
    [d.baza === 'zam' ? 'Zamówienia' : 'Faktury', W.szt(sc.zam), W.szt(sp.zam), W.zmiana(sc.zam, sp.zam)],
    ['Zwroty (KFS)', W.zl(d.cur.zwroty.netto), W.zl(d.prev.zwroty.netto), `${W.szt(d.cur.zwroty.szt)} szt.`],
  ];
  el('sd-kafle').innerHTML = kafle.map(([e, w, p, zm]) => `<div class="sd-kafel"><div class="sd-et">${e}</div><div class="sd-w">${w}</div>`
    + `<div class="sd-p">${zm} · rok temu ${p}</div></div>`).join('');
  const ost = W.ostrzezenia(d);
  if (o.cur[1] === sdStan.dzis) ost.unshift('Dzień w trakcie — dzisiejsze liczby rosną, a rok temu to pełny dzień.');
  if (sc.zamowione) ost.push(`${W.szt(sc.zamowione)} zamówień nie ma jeszcze faktury — liczby z ZK, potwierdzą się po wystawieniu FS.`);
  el('sd-ostrz').innerHTML = ost.map((x) => `<div>${W.esc(x)}</div>`).join('');
  el('sd-ostrz').classList.toggle('hidden', !ost.length);
  const wcz = d.wczytanie || {};
  el('sd-wczytanie').textContent = `dane z ${W.godzina(wcz.biezacy || wcz.historia_wczytana) || '—'}` + (wcz.historia_od ? ` · historia od ${wcz.historia_od}` : ' · historia niewczytana (scripts/analiza-wczytaj.js)');
  sdRysujKanaly(d);
}

function sdRysujKanaly(d) {
  const W = window.SprzedazW;
  const sc = W.sumy(d.cur.kanaly), sp = W.sumy(d.prev.kanaly);
  // wybor — wartość porównania po kanałach dla wiersza bez dzieci (klik w nazwę = grupy i produkty tego kanału)
  const wiersz = (w, klasa = '', id = '', wybor = '') => `<tr class="${klasa}${wybor ? ' sd-kanal-wybor' : ''}${wybor && wybor === sdStan.kanal ? ' sd-wybrany' : ''}"${id ? ` data-id="${id}"` : ''}${wybor ? ` data-kanal="${W.esc(wybor)}" title="pokaż grupy i produkty tylko z tego kanału"` : ''}><td>${W.esc(w.nazwa)}`
    + `${w.k === 'SKLEP' ? '<span class="sw-tag">paragony z MAG, poza sumą</span>' : ''}${w.k === '_INNE' ? `<span class="sw-tag">${w.dzieci.length}</span>` : ''}</td>`
    + `<td class="num">${klasa.includes('sd-dziecko') && w.k.length === 2 ? '' : W.szt(w.cur.zam)}</td><td class="num">${W.szt(w.cur.szt)}</td>`
    + `<td class="num">${W.zl(w.cur.netto)}${w.cur.doplata >= 0.5 ? `<div class="sw-brak" title="dopłata Allegro do ceny (Allegro Ceny / AlleObniżka) — poza fakturą">w tym dopłata ${W.zl(w.cur.doplata)}</div>` : ''}</td><td class="num">${W.zmiana(w.cur.netto, w.prev.netto)}</td>`
    + `<td class="num">${W.pct(W.marza(w.cur))}</td><td class="num">${W.naSzt(w.cur.zysk, w.cur.szt)}</td><td class="num">${W.zyskTxt(w.cur)}</td>`
    + `<td class="num">${W.pct(sc.netto ? w.cur.netto / sc.netto * 100 : null)}</td></tr>`;
  let html = `<thead><tr><th>Kanał</th><th class="num">${d.baza === 'zam' ? 'Zamówienia' : 'Faktury'}</th><th class="num">Szt.</th>`
    + '<th class="num">Przychód netto</th><th class="num">r/r</th><th class="num">Marża</th><th class="num">Zysk na szt.</th><th class="num">Zysk</th><th class="num">Udział</th></tr></thead><tbody>';
  const { lista, osobno } = W.wierszeKanalow(d.cur.kanaly, d.prev.kanaly, d.nazwy);
  for (const w of lista) {
    const ma = w.dzieci.length > 0;
    html += wiersz(w, ma ? 'sd-grupa' + (sdOtwarte.has(w.k) ? ' otw' : '') : '', ma ? w.k : '', ma ? '' : 'k:' + w.k);
    if (ma && sdOtwarte.has(w.k)) for (const c of w.dzieci) html += wiersz(c, 'sd-dziecko', '', w.k === '_INNE' ? 'k:' + c.k : `k:${w.k}|${c.k}`);
  }
  html += `<tr class="sd-suma"><td>Razem internet</td><td class="num">${W.szt(sc.zam)}</td><td class="num">${W.szt(sc.szt)}</td><td class="num">${W.zl(sc.netto)}</td>`
    + `<td class="num">${W.zmiana(sc.netto, sp.netto)}</td><td class="num">${W.pct(W.marza(sc))}</td><td class="num">${W.naSzt(sc.zysk, sc.szt)}</td>`
    + `<td class="num">${W.zl(sc.zysk)}</td><td></td></tr>`
    + osobno.map((w) => wiersz(w, 'sd-poza').replace(/<td class="num">[^<]*<\/td><\/tr>$/, '<td class="num">poza sumą</td></tr>')).join('') + '</tbody>';
  const t = el('sd-kanaly');
  t.innerHTML = html;
  t.querySelectorAll('tr.sd-grupa').forEach((tr) => { tr.onclick = () => {
    const id = tr.dataset.id; sdOtwarte.has(id) ? sdOtwarte.delete(id) : sdOtwarte.add(id); sdRysujKanaly(sdPodsumowanie);
  }; });
  t.querySelectorAll('tr.sd-kanal-wybor').forEach((tr) => { tr.onclick = () => sdWybierzKanal(tr.dataset.kanal === sdStan.kanal ? '' : tr.dataset.kanal, true); });
  sdRysujWyborKanalu(d);
}

// ---------- porównanie po kanałach: wybór + grupy towarów ----------
function sdNazwaKanalu(k, d = sdPodsumowanie) {
  if (!k) return 'wszystkie kanały';
  if (k.startsWith('p:')) return `${k.slice(2)} — wszystkie rynki`;
  const [kl, r] = k.slice(2).split('|');
  return (d?.nazwy?.[kl] || kl) + (r ? ` · ${r}` : '');
}
function sdRysujWyborKanalu(d) {
  const W = window.SprzedazW;
  const { lista } = W.wierszeKanalow(d.cur.kanaly, d.prev.kanaly, d.nazwy);
  const plat = d.platformy || {}, opcje = [], ilePlat = {};
  const liscie = [];
  for (const w of lista) {
    if (w.k === '_INNE') { for (const c of w.dzieci) liscie.push(['k:' + c.k, c.nazwa, c.k]); continue; }
    liscie.push(['k:' + w.k, w.nazwa, w.k]);
    if (w.k.startsWith('ALLEGRO')) for (const c of w.dzieci) liscie.push([`k:${w.k}|${c.k}`, `${w.nazwa} · ${c.nazwa}`, w.k]);
  }
  for (const [, , k] of liscie) if (!k.includes('|')) ilePlat[plat[k] || 'Inne'] = (ilePlat[plat[k] || 'Inne'] || 0) + 1;
  const opt = (v, t) => `<option value="${W.esc(v)}" ${v === sdStan.kanal ? 'selected' : ''}>${W.esc(t)}</option>`;
  opcje.push(opt('', 'Wszystkie kanały'));
  for (const p of ['Amazon', 'Allegro', 'eMAG', 'Empik', 'Kaufland', 'Inne']) {
    const tu = liscie.filter(([, , k]) => (plat[k] || 'Inne') === p);
    if (!tu.length) continue;
    opcje.push(`<optgroup label="${p}">` + (ilePlat[p] > 1 || sdStan.kanal === 'p:' + p ? opt('p:' + p, `${p} — wszystkie rynki`) : '')
      + tu.map(([v, t]) => opt(v, t)).join('') + '</optgroup>');
  }
  // wybrany kanał bez sprzedaży w tym zakresie — zostaje na liście, żeby było widać, co jest wybrane
  if (sdStan.kanal && !opcje.join('').includes(`value="${W.esc(sdStan.kanal)}"`)) opcje.push(opt(sdStan.kanal, sdNazwaKanalu(sdStan.kanal, d)));
  const s = el('sd-kanal');
  s.innerHTML = opcje.join('');
  s.onchange = () => sdWybierzKanal(s.value);
}
function sdWybierzKanal(k, przewin = false) {
  sdStan.kanal = k; sdStan.grupa = ''; sdZapamietaj('kanal', k);
  odswiezSprzedazDzien();
  if (przewin) el('sd-gr-tyt').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function sdRysujGrupy() {
  const W = window.SprzedazW, d = sdGrupy;
  if (!d) return;
  const lista = d.grupy.filter((g) => g.cur.netto || g.prev.netto);
  const zm = (g) => g.cur.netto - g.prev.netto;
  if (sdStan.grsort === 'spadek') lista.sort((a, b) => zm(a) - zm(b));
  else if (sdStan.grsort === 'wzrost') lista.sort((a, b) => zm(b) - zm(a));
  const suma = (o, p) => lista.reduce((a, g) => a + (g[o][p] || 0), 0);
  const sc = { netto: suma('cur', 'netto'), zysk: suma('cur', 'zysk'), szt: suma('cur', 'szt') }, sp = { netto: suma('prev', 'netto'), zysk: suma('prev', 'zysk'), szt: suma('prev', 'szt') };
  const spadki = lista.filter((g) => zm(g) < 0).length;
  el('sd-gr-tyt').textContent = sdStan.kanal ? `Grupy towarów — ${sdNazwaKanalu(sdStan.kanal)}` : 'Grupy towarów';
  el('sd-gr-opis').textContent = `${W.zakresTxt(d.okresy.cur)} vs ${W.zakresTxt(d.okresy.prev)} · ${lista.length} grup, w tym ${spadki} ze spadkiem · klik w grupę = jej produkty niżej`;
  const pokaz = sdGrWszystkie ? lista : lista.slice(0, 30);
  const zmZl = (x) => (Math.abs(x) < 0.5 ? '<span class="sw-brak">0 zł</span>' : `<span class="${x >= 0 ? 'sw-plus' : 'sw-minus'}">${x >= 0 ? '+' : '−'}${W.zl(Math.abs(x))}</span>`);
  const wiersz = (g) => `<tr class="sd-klik-gr${g.grupa === sdStan.grupa ? ' sd-wybrany' : ''}" data-g="${W.esc(g.grupa)}"><td><b>${W.esc(g.grupa)}</b></td>`
    + `<td class="num">${W.zl(g.cur.netto)}</td><td class="num">${W.zl(g.prev.netto)}</td><td class="num">${zmZl(zm(g))}</td><td class="num">${W.zmiana(g.cur.netto, g.prev.netto)}</td>`
    + `<td class="num">${W.zl(g.cur.zysk)}</td><td class="num">${zmZl(g.cur.zysk - g.prev.zysk)}</td><td class="num">${W.pct(W.marza(g.cur))}</td>`
    + `<td class="num">${W.szt(g.cur.szt)}</td><td class="num">${W.zmiana(g.cur.szt, g.prev.szt)}</td><td class="num">${W.szt(g.cur.sku)}</td></tr>`;
  el('sd-grupy').innerHTML = '<thead><tr><th>Grupa</th><th class="num">Przychód</th><th class="num">rok temu</th><th class="num">Zmiana zł</th><th class="num">r/r</th>'
    + '<th class="num">Zysk</th><th class="num">Zmiana zysku</th><th class="num">Marża</th><th class="num">Szt.</th><th class="num">szt. r/r</th><th class="num">SKU</th></tr></thead><tbody>'
    + (lista.length ? pokaz.map(wiersz).join('') : '<tr><td colspan="11" class="sw-brak">Brak sprzedaży w tym zakresie.</td></tr>')
    + (lista.length > pokaz.length ? `<tr><td colspan="11"><span class="sd-chip" id="sd-gr-wiecej">pokaż wszystkie (${lista.length})</span></td></tr>` : '')
    + `<tr class="sd-suma"><td>Razem${sdStan.kanal ? ' — ' + W.esc(sdNazwaKanalu(sdStan.kanal)) : ''}</td><td class="num">${W.zl(sc.netto)}</td><td class="num">${W.zl(sp.netto)}</td>`
    + `<td class="num">${zmZl(sc.netto - sp.netto)}</td><td class="num">${W.zmiana(sc.netto, sp.netto)}</td><td class="num">${W.zl(sc.zysk)}</td><td class="num">${zmZl(sc.zysk - sp.zysk)}</td>`
    + `<td class="num">${W.pct(W.marza(sc))}</td><td class="num">${W.szt(sc.szt)}</td><td class="num">${W.zmiana(sc.szt, sp.szt)}</td><td></td></tr></tbody>`;
  el('sd-grupy').querySelector('tbody').onclick = (e) => {
    if (e.target.id === 'sd-gr-wiecej') { sdGrWszystkie = true; sdRysujGrupy(); return; }
    const tr = e.target.closest('tr.sd-klik-gr'); if (!tr) return;
    sdStan.grupa = tr.dataset.g === sdStan.grupa ? '' : tr.dataset.g;
    sdRysujGrupy(); if (sdProd) sdRysujProdukty(sdProd, sdPodsumowanie);
    if (sdStan.grupa) el('sd-prod-tyt').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
}

const SD_KOLUMNY = [
  ['', null], ['SKU / nazwa', 'sym'], ['Szt.', 'szt', 1], ['Przychód', 'netto', 1], ['Marża', 'marza', 1], ['Zysk na szt.', 'zsz', 1],
  ['Zysk', 'zysk', 1], ['Kanały', null], ['Dostępne', 'dost', 1], ['Zapas', 'dni', 1], ['', null],
];
const sdKlucz = (p, k) => ({ sym: p.symbol || String(p.tw_id), szt: p.szt, netto: p.netto, zysk: p.zysk, marza: p.netto ? p.zysk / p.netto : null,
  zsz: p.szt ? p.zysk / p.szt : null, dost: p.stan ? p.stan.dostepne : null, dni: p.dni_zapasu }[k]);

function sdRysujProdukty(d, pod) {
  const W = window.SprzedazW;
  const lista = sdStan.grupa ? d.produkty.filter((p) => (p.grupa || '(bez grupy)') === sdStan.grupa) : d.produkty.slice();
  if (sdKol.k) lista.sort((p, q) => {
    const a = sdKlucz(p, sdKol.k), b = sdKlucz(q, sdKol.k);
    if (a == null) return 1; if (b == null) return -1;
    return (typeof a === 'string' ? a.localeCompare(b) : a - b) * sdKol.kier;
  });
  const wg = sdKol.k ? SD_KOLUMNY.find((c) => c[1] === sdKol.k)[0].toLowerCase() : SD_OPCJE.sort.find((o) => o[0] === sdStan.sort)[1];
  const zaw = [sdStan.kanal ? sdNazwaKanalu(sdStan.kanal, pod) : '', sdStan.grupa ? `grupa ${sdStan.grupa}` : ''].filter(Boolean).join(', ');
  el('sd-prod-tyt').innerHTML = W.esc(`Produkty${zaw ? ` (${zaw})` : ''}: ${W.zakresTxt(pod.okresy.cur)} — ${W.szt(sdStan.grupa ? lista.length : d.razem)} towarów${!sdStan.grupa && d.razem > lista.length ? `, pokazane ${W.szt(lista.length)}` : ''}, wg: ${wg} · klik w produkt = karta produktu`)
    + (sdStan.grupa ? '<span class="sd-chip" id="sd-prod-grx">× wszystkie grupy</span>' : '');
  if (sdStan.grupa) el('sd-prod-grx').onclick = () => { sdStan.grupa = ''; sdRysujGrupy(); sdRysujProdukty(sdProd, sdPodsumowanie); };
  el('sd-prod').innerHTML = '<thead><tr>' + SD_KOLUMNY.map(([t, k, num]) => `<th class="${num ? 'num ' : ''}${k ? 'sd-sort' : ''}" data-k="${k || ''}"${k ? ' title="sortuj"' : ''}>${t}${k && k === sdKol.k ? (sdKol.kier > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('') + '</tr></thead><tbody>'
    + lista.map((p) => `<tr class="sd-klik" data-id="${p.tw_id}"><td><img class="sd-min" src="/api/produkty/${p.tw_id}/zdjecie?rozmiar=mini" alt="" loading="lazy" onerror="this.remove()"></td>`
      + `<td><b>${W.esc(p.symbol || p.tw_id)}</b> <span class="sd-nz" title="${W.esc(p.nazwa)}">${W.esc(p.nazwa || '')}</span></td>`
      + `<td class="num">${W.szt(p.szt)}</td><td class="num">${W.zl(p.netto)}</td><td class="num">${W.pct(p.netto ? p.zysk / p.netto * 100 : null)}</td>`
      + `<td class="num">${W.naSzt(p.zysk, p.szt)}</td><td class="num">${W.zl(p.zysk)}</td>`
      + `<td class="sd-kan">${p.kanaly.map((c) => W.esc(d.nazwy[c.k] || c.k) + ' ' + W.szt(c.szt)).join(', ')}</td>`
      + `<td class="num">${p.stan ? W.szt(p.stan.dostepne) : '—'}</td><td class="num">${p.dni_zapasu == null ? '—' : W.szt(p.dni_zapasu) + ' dni'}</td>`
      + `<td>${W.flagi(p.flagi)}</td></tr>`).join('') + '</tbody>';
  // klik w produkt = karta z Trendów (ceny ofert, kanały, strategia — decyzja usera 2026-10-26), ← → po tej liście
  el('sd-prod').querySelector('tbody').onclick = (e) => {
    const tr = e.target.closest('tr.sd-klik'); if (!tr) return;
    window.sprzedazOtworzProdukt(+tr.dataset.id, lista.map((p) => ({ id: p.tw_id, sym: p.symbol, nazwa: p.nazwa })), `Dzień ${W.zakresTxt(pod.okresy.cur)}`);
  };
  el('sd-prod').querySelector('thead').onclick = (e) => {
    const th = e.target.closest('th.sd-sort'); if (!th) return;
    const k = th.dataset.k;
    if (sdKol.k === k) sdKol.kier = -sdKol.kier; else { sdKol.k = k; sdKol.kier = k === 'sym' ? 1 : -1; }
    sdRysujProdukty(sdProd, sdPodsumowanie);
  };
}

function sdPrzesunDzien(n) {
  const W = window.SprzedazW;
  const nowy = W.dodajDni(sdStan.dzien, n);
  if (nowy > sdStan.dzis) return;
  sdStan.dzien = nowy;
  odswiezSprzedazDzien();
}
