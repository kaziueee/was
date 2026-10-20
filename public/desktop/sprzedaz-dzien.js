'use strict';

// Sprzedaż → „Dzień” (desktop): podsumowanie dnia albo zakresu vs ten sam dzień tygodnia rok temu, kanały, produkty.
// Dane z GET /api/analiza/* (moduł analiz sprzedaży, docs/analiza-sprzedazy.md); formatowanie i grupowanie kanałów
// wspólne z telefonem (/shared/sprzedaz-wspolne.js). Plik ładuje się PRZED app.js i nie ma kodu na poziomie pliku
// poza deklaracjami — funkcji app.js (el, api) używa dopiero w chwili wywołania. app.js woła odswiezSprzedazDzien().

const sdPamiec = (k, d) => { try { return localStorage.getItem('wms-sprzedaz-' + k) || d; } catch { return d; } };
const sdZapamietaj = (k, v) => { try { localStorage.setItem('wms-sprzedaz-' + k, v); } catch { /* bez pamięci */ } };
const SD_OPCJE = {
  zakres: [['dzien', 'Dzień'], ['t7', '7 dni'], ['mtd', 'Miesiąc do dziś'], ['ytd', 'Rok do dziś']],
  baza: [['zam', 'wg zamówienia'], ['fs', 'wg faktury']],
  sort: [['zysk', 'zysk'], ['szt', 'sztuki'], ['netto', 'przychód']],
};
const sdStan = { dzien: null, dzis: null, zakres: sdPamiec('zakres', 'dzien'), baza: sdPamiec('baza', 'zam'), sort: sdPamiec('sort', 'zysk') };
const sdOtwarte = new Set();
let sdNr = 0, sdPodsumowanie = null;

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
    const [pod, prod] = await Promise.all([api(`/api/analiza/podsumowanie?${q}`), api(`/api/analiza/produkty?${q}&sort=${sdStan.sort}&limit=50`)]);
    if (moje !== sdNr) return;
    sdPodsumowanie = pod;
    sdRysujPodsumowanie(pod);
    sdRysujProdukty(prod, pod);
  } catch (e) {
    if (moje !== sdNr) return;
    el('sd-blad').textContent = e.message;
    el('sd-blad').classList.remove('hidden');
  }
}

function sdPrzelaczniki() {
  for (const co of ['zakres', 'baza', 'sort']) {
    const p = el('sd-seg-' + co);
    p.innerHTML = SD_OPCJE[co].map(([v, t]) => `<button type="button" data-v="${v}" class="${sdStan[co] === v ? 'wl' : ''}">${t}</button>`).join('');
    p.querySelectorAll('button').forEach((b) => { b.onclick = () => { sdStan[co] = b.dataset.v; sdZapamietaj(co, sdStan[co]); odswiezSprzedazDzien(); }; });
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
    ['Przychód netto', W.zl(sc.netto), W.zl(sp.netto), W.zmiana(sc.netto, sp.netto)],
    ['Marża', W.pct(mc), W.pct(mp), mc == null || mp == null ? '' : `<span class="${mc >= mp ? 'sw-plus' : 'sw-minus'}">${mc >= mp ? '+' : ''}${W.nf1.format(mc - mp)} pp</span>`],
    ['Zysk na sztuce', W.naSzt(sc.zysk, sc.szt), W.naSzt(sp.zysk, sp.szt), W.zmiana(sc.szt ? sc.zysk / sc.szt : null, sp.szt ? sp.zysk / sp.szt : null)],
    ['Zysk po kosztach kanału', W.zl(sc.zysk), W.zl(sp.zysk), W.zmiana(sc.zysk, sp.zysk)],
    ['Sztuki', W.szt(sc.szt), W.szt(sp.szt), W.zmiana(sc.szt, sp.szt)],
    [d.baza === 'zam' ? 'Zamówienia' : 'Faktury i paragony', W.szt(sc.zam), W.szt(sp.zam), W.zmiana(sc.zam, sp.zam)],
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
  const wiersz = (w, klasa = '', id = '') => `<tr class="${klasa}"${id ? ` data-id="${id}"` : ''}><td>${W.esc(w.nazwa)}`
    + `${w.k === 'SKLEP' ? '<span class="sw-tag">paragony, poza tierem</span>' : ''}${w.k === '_INNE' ? `<span class="sw-tag">${w.dzieci.length}</span>` : ''}</td>`
    + `<td class="num">${klasa.includes('sd-dziecko') && w.k.length === 2 ? '' : W.szt(w.cur.zam)}</td><td class="num">${W.szt(w.cur.szt)}</td>`
    + `<td class="num">${W.zl(w.cur.netto)}</td><td class="num">${W.zmiana(w.cur.netto, w.prev.netto)}</td>`
    + `<td class="num">${W.pct(W.marza(w.cur))}</td><td class="num">${W.naSzt(w.cur.zysk, w.cur.szt)}</td><td class="num">${W.zyskTxt(w.cur)}</td>`
    + `<td class="num">${W.pct(sc.netto ? w.cur.netto / sc.netto * 100 : null)}</td></tr>`;
  let html = `<thead><tr><th>Kanał</th><th class="num">${d.baza === 'zam' ? 'Zamówienia' : 'Faktury'}</th><th class="num">Szt.</th>`
    + '<th class="num">Przychód netto</th><th class="num">r/r</th><th class="num">Marża</th><th class="num">Zysk na szt.</th><th class="num">Zysk</th><th class="num">Udział</th></tr></thead><tbody>';
  for (const w of W.wierszeKanalow(d.cur.kanaly, d.prev.kanaly, d.nazwy)) {
    const ma = w.dzieci.length > 0;
    html += wiersz(w, ma ? 'sd-grupa' + (sdOtwarte.has(w.k) ? ' otw' : '') : '', ma ? w.k : '');
    if (ma && sdOtwarte.has(w.k)) for (const c of w.dzieci) html += wiersz(c, 'sd-dziecko');
  }
  html += `<tr class="sd-suma"><td>Razem</td><td class="num">${W.szt(sc.zam)}</td><td class="num">${W.szt(sc.szt)}</td><td class="num">${W.zl(sc.netto)}</td>`
    + `<td class="num">${W.zmiana(sc.netto, sp.netto)}</td><td class="num">${W.pct(W.marza(sc))}</td><td class="num">${W.naSzt(sc.zysk, sc.szt)}</td>`
    + `<td class="num">${W.zl(sc.zysk)}</td><td></td></tr></tbody>`;
  const t = el('sd-kanaly');
  t.innerHTML = html;
  t.querySelectorAll('tr.sd-grupa').forEach((tr) => { tr.onclick = () => {
    const id = tr.dataset.id; sdOtwarte.has(id) ? sdOtwarte.delete(id) : sdOtwarte.add(id); sdRysujKanaly(sdPodsumowanie);
  }; });
}

function sdRysujProdukty(d, pod) {
  const W = window.SprzedazW;
  el('sd-prod-tyt').textContent = `Produkty: ${W.zakresTxt(pod.okresy.cur)} — ${W.szt(d.razem)} towarów, pierwsze ${Math.min(50, d.razem)} wg: ${SD_OPCJE.sort.find((o) => o[0] === sdStan.sort)[1]}`;
  el('sd-prod').innerHTML = '<thead><tr><th></th><th>SKU / nazwa</th><th class="num">Szt.</th><th class="num">Przychód</th><th class="num">Marża</th>'
    + '<th class="num">Zysk na szt.</th><th class="num">Zysk</th><th>Kanały</th><th class="num">K4 + K4G</th><th class="num">Zapas</th><th></th></tr></thead><tbody>'
    + d.produkty.map((p) => `<tr><td><img class="sd-min" src="/api/produkty/${p.tw_id}/zdjecie?rozmiar=mini" alt="" loading="lazy" onerror="this.remove()"></td>`
      + `<td><b>${W.esc(p.symbol || p.tw_id)}</b> <span class="sd-nz" title="${W.esc(p.nazwa)}">${W.esc(p.nazwa || '')}</span></td>`
      + `<td class="num">${W.szt(p.szt)}</td><td class="num">${W.zl(p.netto)}</td><td class="num">${W.pct(p.netto ? p.zysk / p.netto * 100 : null)}</td>`
      + `<td class="num">${W.naSzt(p.zysk, p.szt)}</td><td class="num">${W.zl(p.zysk)}</td>`
      + `<td class="sd-kan">${p.kanaly.map((c) => W.esc(d.nazwy[c.k] || c.k) + ' ' + W.szt(c.szt)).join(', ')}</td>`
      + `<td class="num">${p.stan ? W.szt(p.stan.k4 + p.stan.k4g) : '—'}</td><td class="num">${p.dni_zapasu == null ? '—' : W.szt(p.dni_zapasu) + ' dni'}</td>`
      + `<td>${W.flagi(p.flagi)}</td></tr>`).join('') + '</tbody>';
}

function sdPrzesunDzien(n) {
  const W = window.SprzedazW;
  const nowy = W.dodajDni(sdStan.dzien, n);
  if (nowy > sdStan.dzis) return;
  sdStan.dzien = nowy;
  odswiezSprzedazDzien();
}
