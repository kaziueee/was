'use strict';

// Sprzedaż → „Stan” (desktop, tylko admin): analiza stanu towaru — leżaki, nadmiar, wolna rotacja, OK, kończy się,
// brak, nowości. Dane: GET /api/analiza/stan-towaru (services/analiza-stan.js, liczy wątek analiz; kubełki i progi —
// services/stan-towaru-model.js, decyzje usera 2026-10-30). Zakres = wszystko razem: stan K4+K4G+MAG+LS, sprzedaż
// FS + paragony Sklepu. Filtry, sortowanie i sumy kafli liczą się w przeglądarce. Klik w towar = karta produktu
// z Trendów (window.sprzedazOtworzProdukt) — tam ceny ofert, czyli to, co zwykle robi się z leżakiem albo z towarem,
// który się kończy. Plik ładuje się PRZED app.js; app.js woła odswiezSprzedazStan() przy wejściu w zakładkę.

(function () {
  const ZDJ = (id) => `/api/produkty/${id}/zdjecie?rozmiar=mini`;
  const nf0 = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const zl = (x) => nf0.format(Math.round(x || 0)) + ' zł';
  const kompakt = (x) => (Math.abs(x) >= 1e6 ? nf1.format(x / 1e6) + ' mln zł' : Math.abs(x) >= 1000 ? nf0.format(x / 1000) + ' tys. zł' : zl(x));
  const szt = (x) => nf0.format(Math.round(x || 0));
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const dd = (s) => (s ? `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}` : '');
  const $ = (id) => document.getElementById('ss-' + id);
  const MAX_WIERSZY = 2000;

  // Magazyn: zawęża do towarów, które TAM coś mają (wartość i sztuki w kolumnach zostają całego stanu Razem)
  const MAGAZYNY = [['', 'Wszystkie'], ['hala', 'Hala (K4+K4G)'], ['ls', 'LS'], ['mag', 'Sklep (MAG)']];
  const SILY = [['', 'Każda sprzedaż'], ['mocna', 'Mocna ≥ 10'], ['srednia', 'Średnia 3–10'], ['slaba', 'Słaba < 3']];
  const naMagazynie = { '': () => true, hala: (w) => w.k4 + w.k4g > 0, ls: (w) => w.ls > 0, mag: (w) => w.mag > 0 };
  // Siła sprzedaży (druga oś, decyzja usera 2026-10-30): w Nadmiarze hity przykrywały maruderów
  const KLASA_SILY = { mocna: 'dobry', srednia: '', slaba: 'zly' };
  const KLASA = { brak: 'zly', konczy: 'uwaga', ok: 'dobry', wolna: '', nadmiar: 'uwaga', lezak: 'zly', nowosc: 'dobry' };
  // Domyślny porządek per kubełek: przy zamrożonym kapitale — od największej wartości, przy końcówkach — od najszybszego
  const SORT_DOMYSLNY = { brak: ['t30', -1], konczy: ['dni', 1], ok: ['wart', -1], wolna: ['wart', -1], nadmiar: ['wart', -1], lezak: ['wart', -1], nowosc: ['wart', -1], '': ['wart', -1] };
  const KOLUMNY = [['', null], ['SKU / nazwa', 'sym'], ['Ocena', 'kub'], ['Sprzedaż', 'na30', 1], ['K4', 'k4', 1], ['K4G', 'k4g', 1], ['LS', 'ls', 1], ['MAG', 'mag', 1], ['Rez.', 'rez', 1],
    ['Dostępne', 'dost', 1], ['Wartość', 'wart', 1], ['Szt. 30 dni', 's30', 1], ['Szt. 90 dni', 's90', 1], ['Szt. rok', 's365', 1], ['Tempo / 30 dni', 't30', 1],
    ['Zapas', 'dni', 1], ['Ostatnia sprzedaż', 'ost', 1]];

  let X = null, ladowanie = null;
  const st = { kub: 'lezak', mag: '', sila: '', grupa: '', szukaj: '', sort: null, kier: -1 };

  const nazwaSily = (k) => (X.sily.find((x) => x.k === k) || {}).nazwa || '—';
  const nazwaKub = (k) => (X.kubelki.find((x) => x.k === k) || {}).nazwa || k;
  function bazowe() {
    let l = X.wiersze.filter(naMagazynie[st.mag]);
    if (st.sila) l = l.filter((w) => w.sila === st.sila);
    if (st.grupa) l = l.filter((w) => w.grupa === st.grupa);
    if (st.szukaj) { const q = st.szukaj.toLowerCase(); l = l.filter((w) => w.sym.toLowerCase().includes(q) || w.nazwa.toLowerCase().includes(q)); }
    return l;
  }
  function posortowane(l) {
    const [k, kier] = st.sort ? [st.sort, st.kier] : SORT_DOMYSLNY[st.kub];
    const v = (w) => (k === 'dni' ? (w.dni ?? Infinity) : k === 'ost' ? (w.ost || '') : k === 'na30' ? w.s90 : w[k]);
    return [[...l].sort((a, b) => { const x = v(a), y = v(b); return (typeof x === 'string' ? x.localeCompare(y) : x - y) * kier || b.wart - a.wart; }), k, kier];
  }

  function rysujKafle(baza) {
    const s = Object.fromEntries(X.kubelki.map((x) => [x.k, { sku: 0, szt: 0, wart: 0, sily: { mocna: [0, 0], srednia: [0, 0], slaba: [0, 0] } }]));
    let wart = 0;
    for (const w of baza) { const x = s[w.kub]; x.sku++; x.szt += w.razem; x.wart += w.wart; wart += w.wart; const y = x.sily[w.sila]; if (y) { y[0]++; y[1] += w.wart; } }
    // rozbicie na siłę sprzedaży — tylko gdy przełącznik „Sprzedaż” stoi na wszystkich i kubełek ma z czego dzielić
    const rozbicie = (k) => (st.sila || !s[k].sku || k === 'brak' ? '' : `<span class="ss-sily">${X.sily.map((x) => `<i class="ss-s-${x.k}" title="${esc(x.nazwa)} sprzedaż (${esc(x.opis)}): ${szt(s[k].sily[x.k][0])} SKU">${esc(x.nazwa.toLowerCase())} ${kompakt(s[k].sily[x.k][1])}</i>`).join('')}</span>`);
    $('kafle').innerHTML = X.kubelki.map((k) => `<button type="button" class="ss-kafel ss-${k.k} ${st.kub === k.k ? 'wl' : ''}" data-k="${k.k}">
        <span class="ss-kn">${esc(k.nazwa)}</span><b>${kompakt(s[k.k].wart)}</b>
        <span>${szt(s[k.k].sku)} SKU · ${szt(s[k.k].szt)} szt.${wart ? ` · ${nf0.format(s[k.k].wart / wart * 100)}% wartości` : ''}</span>
        ${rozbicie(k.k)}<span class="ss-ko">${esc(k.opis)}</span></button>`).join('')
      + `<button type="button" class="ss-kafel ss-wszystko ${st.kub === '' ? 'wl' : ''}" data-k=""><span class="ss-kn">Wszystko</span><b>${kompakt(wart)}</b><span>${szt(baza.length)} SKU</span><span class="ss-ko">cały stan w cenie zakupu</span></button>`;
  }

  function rysujTabele(baza) {
    const lista = st.kub ? baza.filter((w) => w.kub === st.kub) : baza;
    const [l, sk, kier] = posortowane(lista);
    const th = KOLUMNY.map(([t, k, num]) => `<th class="${num ? 'n ' : ''}${k ? 'tr-sort' : ''}" data-k="${k || ''}">${t}${k && k === sk ? (kier > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('');
    const suma = (f) => l.reduce((a, w) => a + (w[f] || 0), 0);
    const ostatnia = (w) => (w.ost ? dd(w.ost) : `<span class="tr-sz">brak od ${dd(X.historiaOd)}</span>`);
    const zapas = (w) => (w.dni == null ? '—' : w.dni > 3650 ? '> 10 lat' : szt(w.dni) + ' dni');
    const odDostawy = (w) => (w.pp && w.kub === 'lezak' && !w.ost && w.pp > X.historiaOd ? `<div class="tr-sz">pierwsza dostawa ${dd(w.pp)}</div>` : '');
    $('tabela').innerHTML = `<thead><tr>${th}</tr><tr class="tr-razem"><td></td><td><b>Razem (${szt(l.length)} SKU)</b></td><td></td><td></td>`
      + ['k4', 'k4g', 'ls', 'mag', 'rez', 'dost'].map((f) => `<td class="n">${szt(suma(f))}</td>`).join('')
      + `<td class="n"><b>${zl(suma('wart'))}</b></td><td class="n">${szt(suma('s30'))}</td><td class="n">${szt(suma('s90'))}</td><td class="n">${szt(suma('s365'))}</td><td></td><td></td><td></td></tr></thead><tbody>`
      + l.slice(0, MAX_WIERSZY).map((w) => `<tr class="tr-klik" data-id="${w.id}"><td><img class="tr-min" loading="lazy" src="${ZDJ(w.id)}" alt="" onerror="this.style.visibility='hidden'"></td>
        <td><span class="tr-sym">${esc(w.sym)}</span> <span class="tr-gr">${esc(w.grupa)}</span><span class="tr-nz" title="${esc(w.nazwa)}">${esc(w.nazwa)}</span>${odDostawy(w)}</td>
        <td><span class="tr-znak ${KLASA[w.kub]}">${esc(nazwaKub(w.kub))}</span></td>
        <td class="n"><span class="tr-znak ${KLASA_SILY[w.sila] || ''}" title="średnio z 90 dni">${esc(nazwaSily(w.sila))}</span><div class="tr-sz">${nf1.format(w.s90 / 3)} / 30 dni</div></td>
        <td class="n">${w.k4 ? szt(w.k4) : ''}</td><td class="n">${w.k4g ? szt(w.k4g) : ''}</td><td class="n">${w.ls ? szt(w.ls) : ''}</td><td class="n">${w.mag ? szt(w.mag) : ''}</td>
        <td class="n tr-sz">${w.rez ? szt(w.rez) : ''}</td><td class="n"><b>${szt(w.dost)}</b></td><td class="n">${zl(w.wart)}</td>
        <td class="n">${szt(w.s30)}</td><td class="n">${szt(w.s90)}</td><td class="n">${szt(w.s365)}${w.sklep365 ? `<div class="tr-sz">w tym sklep ${szt(w.sklep365)}</div>` : ''}</td>
        <td class="n">${w.t30 ? nf1.format(w.t30) : '0'}</td><td class="n">${zapas(w)}</td><td class="n">${ostatnia(w)}</td></tr>`).join('')
      + (l.length > MAX_WIERSZY ? `<tr><td colspan="${KOLUMNY.length}" class="tr-sz">… i ${szt(l.length - MAX_WIERSZY)} kolejnych — zawęź magazynem, grupą albo wyszukiwaniem (CSV ma wszystkie)</td></tr>` : '')
      + (l.length ? '' : `<tr><td colspan="${KOLUMNY.length}" class="tr-sz">Brak towarów w tym widoku.</td></tr>`) + '</tbody>';
    return l;
  }

  let widoczne = [];
  function rysuj() {
    const baza = bazowe();
    rysujKafle(baza);
    widoczne = rysujTabele(baza);
    $('mag').querySelectorAll('button').forEach((b) => b.classList.toggle('wl', b.dataset.v === st.mag));
    $('sila').querySelectorAll('button').forEach((b) => b.classList.toggle('wl', b.dataset.v === st.sila));
  }

  function opis() {
    const P = X.progi;
    $('def').innerHTML = `Stan Razem = K4 + K4G + MAG + LS (bez BRK i reklamacji), sprzedaż = faktury z K4 + paragony Sklepu + składniki sprzedanych zestawów; zestawy pomijamy (leżą składniki). `
      + `<b>Zapas</b> = dostępne (Razem − rezerwacje) ÷ tempo, tempo = szybsze z 90 dni i roku, okno skrócone do wieku towaru od pierwszej dostawy. `
      + `<b>Leżak</b> — 0 szt. w ${P.lezakDni} dni (historia sprzedaży od ${dd(X.historiaOd)}). <b>Nowość</b> — pierwsza dostawa < ${P.nowoscDni} dni. `
      + `<b>Wartość</b> — cały stan Razem w cenie zakupu (średnia dostaw leżących na magazynach, jak Cennik). Filtr magazynu pokazuje towary, które tam coś mają. <b>Sprzedaż</b> — druga oś niezależna od zapasu: mocna ≥ 10 szt. / 30 dni, średnia 3–10, słaba < 3 (średnio z 90 dni). W Nadmiarze mocna = sprawa zakupów (sprzedaż wyczerpie stan), słaba = ceny albo promocji. Nagłówek kolumny = sortowanie, klik w towar = karta produktu z cenami ofert.`;
  }

  function csv() {
    const kol = ['symbol', 'nazwa', 'grupa', 'ocena', 'sprzedaz', 'szt_na_30_dni_z_90', 'K4', 'K4G', 'LS', 'MAG', 'rezerwacje', 'dostepne', 'wartosc_zl', 'szt_30', 'szt_90', 'szt_rok', 'w_tym_sklep_rok', 'tempo_30', 'zapas_dni', 'ostatnia_sprzedaz', 'pierwsza_dostawa'];
    const q = (v) => (v == null ? '' : /[;"\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const liczba = (v) => (v == null ? '' : String(v).replace('.', ','));
    const wiersze = (st.kub ? bazowe().filter((w) => w.kub === st.kub) : bazowe());
    const tekst = [kol.join(';'), ...posortowane(wiersze)[0].map((w) => [w.sym, w.nazwa, w.grupa, nazwaKub(w.kub), nazwaSily(w.sila), liczba(Math.round(w.s90 / 3 * 10) / 10), w.k4, w.k4g, w.ls, w.mag, w.rez, w.dost, w.wart,
      w.s30, w.s90, w.s365, w.sklep365, liczba(w.t30), w.dni, w.ost, w.pp].map(q).join(';'))].join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + tekst], { type: 'text/csv;charset=utf-8' }));
    a.download = `stan-towaru-${st.kub || 'wszystko'}-${X.dzis}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function podepnij() {
    $('mag').innerHTML = MAGAZYNY.map(([v, t]) => `<button type="button" data-v="${v}">${t}</button>`).join('');
    $('sila').innerHTML = SILY.map(([v, t]) => `<button type="button" data-v="${v}">${t}</button>`).join('');
    $('sila').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; st.sila = b.dataset.v; rysuj(); };
    $('mag').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; st.mag = b.dataset.v; rysuj(); };
    $('kafle').onclick = (e) => { const b = e.target.closest('.ss-kafel'); if (!b) return; st.kub = b.dataset.k; st.sort = null; rysuj(); };
    $('grupa').onchange = (e) => { st.grupa = e.target.value; rysuj(); };
    let t = null;
    $('szukaj').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { st.szukaj = e.target.value.trim(); rysuj(); }, 200); };
    $('csv').onclick = csv;
    $('tabela').addEventListener('click', (e) => {
      const h = e.target.closest('th.tr-sort');
      if (h) {
        const k = h.dataset.k, [obecny, kier] = st.sort ? [st.sort, st.kier] : SORT_DOMYSLNY[st.kub];
        st.sort = k; st.kier = obecny === k ? -kier : (['sym', 'kub', 'dni'].includes(k) ? 1 : -1);
        rysuj(); return;
      }
      const tr = e.target.closest('tr.tr-klik'); if (!tr) return;
      const lista = widoczne.slice(0, MAX_WIERSZY).map((w) => ({ id: w.id, sym: w.sym, nazwa: w.nazwa }));
      window.sprzedazOtworzProdukt(+tr.dataset.id, lista, `Stan — ${st.kub ? nazwaKub(st.kub) : 'wszystko'}`);
    });
  }

  async function odswiezSprzedazStan() {
    const blad = $('blad');
    blad.classList.add('hidden');
    if (ladowanie) return ladowanie;
    $('wczytanie').textContent = 'Wczytuję…';
    ladowanie = (async () => {
      try {
        X = await api('/api/analiza/stan-towaru');
        const grupy = [...new Set(X.wiersze.map((w) => w.grupa).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pl'));
        $('grupa').innerHTML = '<option value="">wszystkie grupy</option>' + grupy.map((g) => `<option ${g === st.grupa ? 'selected' : ''}>${esc(g)}</option>`).join('');
        opis(); rysuj();
        $('wczytanie').textContent = `stan z ${dd(X.stanyZ)} · policzone dla ${dd(X.dzis)}`;
      } catch (e) {
        blad.textContent = e.message; blad.classList.remove('hidden'); $('wczytanie').textContent = '';
      } finally { ladowanie = null; }
    })();
    return ladowanie;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', podepnij);
  else podepnij();
  window.odswiezSprzedazStan = odswiezSprzedazStan;
})();
