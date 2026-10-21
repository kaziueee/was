'use strict';
// Analiza sprzedaży na telefon — /sprzedaz/ (docs/analiza-sprzedazy.md). Dane: GET /api/analiza/* (czyta tylko
// db/sprzedaz.db, więc odpowiada w milisekundach). Wybór zakresu, podstawy daty i sortowania pamięta urządzenie
// (localStorage) — wygoda, nie stan systemu.
// „Zmiany” (piąty przycisk zakresu): co rośnie, co spada, co zgasło — gotowy wynik Trendów (GET /api/analiza/trendy,
// skompresowany), te same filtry co na desktopie (public/shared/trendy-model.js), bez limitu pozycji.
(function () {
  const W = window.SprzedazW;
  const $ = (id) => document.getElementById(id);
  const pamiec = (k, d) => { try { return localStorage.getItem('wms-sprzedaz-' + k) || d; } catch { return d; } };
  const zapamietaj = (k, v) => { try { localStorage.setItem('wms-sprzedaz-' + k, v); } catch { /* bez pamięci */ } };

  const OPCJE = {
    zakres: [['dzien', 'Dzień'], ['t7', '7 dni'], ['mtd', 'Miesiąc'], ['ytd', 'Rok'], ['zmiany', 'Zmiany']],
    baza: [['zam', 'wg zamówienia'], ['fs', 'wg faktury']],
    sort: [['zysk', 'zysk'], ['szt', 'szt.'], ['netto', 'przychód']],
  };
  const st = { dzien: null, dzis: null, zakres: pamiec('zakres', 'dzien'), baza: pamiec('baza', 'zam'), sort: pamiec('sort', 'zysk') };
  for (const k of ['zakres', 'baza', 'sort']) if (!OPCJE[k].some(([v]) => v === st[k])) st[k] = OPCJE[k][0][0];
  let nr = 0;   // numer żądania — spóźniona odpowiedź nie nadpisze nowszego widoku

  async function get(url) {
    const r = await fetch(url);
    if (r.status === 401) { WMS.pokazWybor(); throw new Error('Zaloguj się'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.blad || `Błąd ${r.status}`);
    return j;
  }

  function przelaczniki() {
    for (const co of ['zakres', 'baza', 'sort']) {
      const el = $('seg-' + co);
      el.innerHTML = OPCJE[co].map(([v, t]) => `<button data-v="${v}" class="${st[co] === v ? 'wl' : ''}">${t}</button>`).join('');
      el.querySelectorAll('button').forEach((b) => { b.onclick = () => { st[co] = b.dataset.v; zapamietaj(co, st[co]); laduj(); }; });
    }
    const zmiany = st.zakres === 'zmiany';
    $('przeglad').classList.toggle('hidden', zmiany);
    $('zmiany').classList.toggle('hidden', !zmiany);
    document.querySelector('.t-gora .dzien:not(#z-data)').classList.toggle('hidden', zmiany);
    $('z-data').classList.toggle('hidden', !zmiany);
    $('d-dalej').disabled = !st.dzis || st.dzien >= st.dzis;
  }

  function rysujPodsumowanie(d) {
    const sc = W.sumy(d.cur.kanaly), sp = W.sumy(d.prev.kanaly);
    const o = d.okresy;
    $('d-data').textContent = st.zakres === 'dzien' ? W.dzienTxt(st.dzien, false) : W.zakresTxt(o.cur);
    const wTrakcie = o.cur[1] === st.dzis;
    $('hero').innerHTML = `<div class="et">Przychód netto internetu · ${st.baza === 'zam' ? 'wg zamówienia' : 'wg faktury'}${wTrakcie ? ' · dzień w trakcie' : ''}</div>
      <div class="w">${W.zl(sc.netto)}</div>
      <div class="r">${W.zmiana(sc.netto, sp.netto)} <span>vs ${W.zakresTxt(o.prev)}: ${W.zl(sp.netto)}</span></div>
      <div class="r"><span>Marża <b>${W.pct(W.marza(sc))}</b></span><span><b>${W.naSzt(sc.zysk, sc.szt)}</b></span><span>Zysk <b>${W.zl(sc.zysk)}</b></span></div>
      <div class="r"><span><b>${W.szt(sc.szt)}</b> szt.</span><span><b>${W.szt(sc.zam)}</b> ${st.baza === 'zam' ? 'zam.' : 'FS'}</span>
        ${sc.zamowione ? `<span>${W.szt(sc.zamowione)} jeszcze bez faktury</span>` : ''}<span>zwroty ${W.zl(d.cur.zwroty.netto)}</span></div>`;
    const ost = W.ostrzezenia(d);
    if (wTrakcie) ost.unshift('Dzisiejsze liczby rosną w ciągu dnia, a rok temu to pełny dzień.');
    $('ostrz').innerHTML = ost.map((x) => `<div>${W.esc(x)}</div>`).join('');
    $('ostrz').classList.toggle('hidden', !ost.length);
    const { lista, osobno } = W.wierszeKanalow(d.cur.kanaly, d.prev.kanaly, d.nazwy);
    const wiersz = (w) => `<span class="n">${W.esc(w.nazwa)}</span><span>${W.zl(w.cur.netto)}</span>`
      + `<span class="z">${W.zyskTxt(w.cur)} · ${W.zmiana(w.cur.netto, w.prev.netto)}</span>`
      + w.dzieci.map((c) => `<span class="n dz">${W.esc(c.nazwa)}</span><span class="dz">${W.zl(c.cur.netto)}</span><span class="z">${W.zmiana(c.cur.netto, c.prev.netto)}</span>`).join('');
    $('kanaly').innerHTML = (lista.map(wiersz).join('') || '<span class="sw-brak" style="grid-column:1/-1">Brak sprzedaży internetowej w tym zakresie.</span>')
      + (osobno.length ? '<span class="sw-brak t-poza">Poza sumą</span>' + osobno.map(wiersz).join('') : '');
    const wcz = d.wczytanie || {};
    $('stopka').textContent = `Dane z ${W.godzina(wcz.biezacy || wcz.historia_wczytana) || '—'}` + (wcz.historia_od ? ` · historia od ${wcz.historia_od}` : ' · historia niewczytana');
  }

  function rysujProdukty(d) {
    const zakresu = st.zakres === 'dzien' ? W.dzienTxt(st.dzien, false) : W.zakresTxt(W_okres.cur);
    $('prod-tyt').textContent = `Produkty ${zakresu} (${W.szt(d.razem)})`;
    const k = $('karty');
    k.innerHTML = d.produkty.length ? d.produkty.map((p) => W.karta(p, d.nazwy)).join('') : '<div class="pusto">Brak sprzedanych produktów.</div>';
    k.scrollLeft = 0;
    k.querySelectorAll('.sw-foto').forEach((f) => { f.onclick = () => {
      if (f.classList.contains('sw-bez-foto')) return;
      $('podglad').querySelector('img').src = `/api/produkty/${f.dataset.tw}/zdjecie?rozmiar=duze`;
      $('podglad').classList.remove('hidden');
    }; });
    licznik();
  }
  let W_okres = { cur: [null, null] };

  async function laduj() {
    przelaczniki();
    if (st.zakres === 'zmiany') return ladujZmiany();
    const moje = ++nr;
    const q = `dzien=${st.dzien}&zakres=${st.zakres}&baza=${st.baza}`;
    $('komunikat').classList.add('hidden');
    try {
      const [pod, prod] = await Promise.all([get(`/api/analiza/podsumowanie?${q}`), get(`/api/analiza/produkty?${q}&sort=${st.sort}&limit=500`)]);
      if (moje !== nr) return;
      W_okres = pod.okresy;
      rysujPodsumowanie(pod);
      rysujProdukty(prod);
    } catch (e) {
      if (moje !== nr) return;
      $('komunikat').textContent = e.message;
      $('komunikat').classList.remove('hidden');
    }
  }

  function licznik() {
    const k = $('karty'), n = k.querySelectorAll('.sw-karta').length;
    const i = n ? Math.round(k.scrollLeft / (k.firstElementChild.offsetWidth + 10)) : 0;
    $('k-licznik').textContent = n ? `${Math.min(i + 1, n)} / ${n}` : '';
  }
  const krok = (d) => { const k = $('karty'); k.scrollBy({ left: d * ((k.firstElementChild?.offsetWidth || 300) + 10), behavior: 'smooth' }); };
  $('karty').addEventListener('scroll', () => requestAnimationFrame(licznik), { passive: true });
  $('k-wstecz').onclick = () => krok(-1);
  $('k-dalej').onclick = () => krok(1);
  $('podglad').onclick = () => $('podglad').classList.add('hidden');

  // ---------- „Zmiany” ----------
  const M = window.TrendyModel;
  const ZOPCJE = { okno: [['7', '7 dni'], ['30', '30 dni']], por: [['prev', 'vs poprzedni'], ['rok', 'vs rok temu']] };
  const KOLEJNOSC = ['trend', 'spadek', 'zgasl', 'strata', 'hity', 'nowe', 'wszystkie'];   // na telefonie zmiany najpierw
  const PROGI = { prog: 30, baza: 5 };
  const PARTIA = 40;
  const zs = { okno: pamiec('z-okno', '7'), por: pamiec('z-por', 'prev'), filtr: pamiec('z-filtr', 'trend') };
  let X = null, xCzas = 0, zLista = [], zIle = 0;
  const oferty = new Map();
  const dd = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;

  async function ladujZmiany() {
    $('komunikat').classList.add('hidden');
    if (!X || Date.now() - xCzas > 30 * 60_000) {
      $('z-opis').textContent = 'Wczytuję…';
      try { X = await get('/api/analiza/trendy'); xCzas = Date.now(); } catch (e) {
        $('komunikat').textContent = e.message; $('komunikat').classList.remove('hidden'); $('z-opis').textContent = ''; return;
      }
    }
    rysujZmiany();
  }

  function zSeg(co) {
    const el = $('z-' + co);
    el.innerHTML = ZOPCJE[co].map(([v, t]) => `<button data-v="${v}" class="${zs[co] === v ? 'wl' : ''}">${t}</button>`).join('');
    el.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; zs[co] = b.dataset.v; zapamietaj('z-' + co, zs[co]); rysujZmiany(); };
  }

  function rysujZmiany() {
    zSeg('okno'); zSeg('por');
    const okno = +zs.okno, P = X.produkty[okno];
    $('z-data').textContent = `do ${W.dzienTxt(X.koniec, false)}`;
    const baza = M.wiersze(X, okno, zs.por);
    $('z-chipy').innerHTML = KOLEJNOSC.map((k) => {
      const d = M.FILTRY.find((f) => f[0] === k);
      return `<button class="z-chip ${k === zs.filtr ? 'wl' : ''}" data-f="${k}">${d[1]}<span class="ile">${W.szt(M.filtruj(baza, k, PROGI).length)}</span></button>`;
    }).join('');
    $('z-chipy').onclick = (e) => { const c = e.target.closest('.z-chip'); if (!c) return; zs.filtr = c.dataset.f; zapamietaj('z-filtr', zs.filtr); rysujZmiany(); };
    const porTxt = zs.por === 'prev' ? `poprzednie ${okno} dni (${dd(P.prevOd)}–${dd(P.prevDo)})` : `te same dni rok temu (${dd(P.rokOd)}–${dd(P.rokDo)})`;
    $('z-opis').textContent = `${okno} zamkniętych dni ${dd(P.od)}–${dd(P.do)} vs ${porTxt}. Trend: zmiana przychodu ≥ ${PROGI.prog}% przy ≥ ${PROGI.baza} szt.`;
    zLista = M.filtruj(baza, zs.filtr, PROGI);
    M.sortuj(zLista, zs.filtr);
    const sa = zLista.reduce((a, w) => a + w.a.n, 0), sb = zLista.reduce((a, w) => a + w.b.n, 0);
    $('z-suma').innerHTML = `<b>${W.szt(zLista.length)}</b> poz. · teraz <b>${W.zl(sa)}</b> · przed ${W.zl(sb)} · ${W.zmiana(sa, sb)}`;
    $('z-stopka').textContent = `Policzone ${W.godzina(X.wygenerowano) || '—'} · dni zamknięte do ${dd(X.koniec)}`;
    const k = $('z-karty');
    k.innerHTML = zLista.length ? '' : '<div class="pusto">Nic w tym filtrze.</div>';
    zIle = 0; dorysuj(); k.scrollLeft = 0; zLicznik();
  }

  function dorysuj() {
    if (zIle >= zLista.length) return;
    const k = $('z-karty'), nowe = zLista.slice(zIle, zIle + PARTIA);
    k.insertAdjacentHTML('beforeend', nowe.map(kartaZmiany).join(''));
    zIle += nowe.length;
    k.querySelectorAll('.sw-foto:not([data-p])').forEach((f) => { f.dataset.p = '1'; f.onclick = () => {
      if (f.classList.contains('sw-bez-foto')) return;
      $('podglad').querySelector('img').src = `/api/produkty/${f.dataset.tw}/zdjecie?rozmiar=duze`;
      $('podglad').classList.remove('hidden');
    }; });
  }

  // 13 pełnych tygodni sztuk (słupki) i te same tygodnie rok temu (szara linia) — bez osi, tylko kształt
  function wykresTyg(id) {
    const t = X.tygProd[id]; if (!t) return '';
    const cur = t.slice(0, 13), rok = t.slice(13), max = Math.max(1, ...cur, ...rok), W_ = 260, H = 46, band = W_ / 13, bw = band * 0.6;
    const y = (v) => H - 2 - v / max * (H - 6);
    const slupki = cur.map((v, j) => (v > 0 ? `<rect x="${j * band + (band - bw) / 2}" y="${y(v)}" width="${bw}" height="${H - 2 - y(v)}" rx="2" fill="#2a78d6"/>` : '')).join('');
    const linia = rok.map((v, j) => `${j ? 'L' : 'M'}${j * band + band / 2},${y(v)}`).join(' ');
    return `<div class="z-tyg"><div class="sw-t">Sztuki tygodniowo · 13 tyg. <span style="color:#a8a69f">— rok temu</span></div>`
      + `<svg viewBox="0 0 ${W_} ${H}" preserveAspectRatio="none" height="${H}">${slupki}<path d="${linia}" fill="none" stroke="#a8a69f" stroke-width="2"/></svg></div>`;
  }

  function kartaZmiany(w) {
    const off = zs.por === 'prev' ? 3 : 6, przed = zs.por === 'prev' ? 'przed' : 'rok temu';
    const kan = ((X.kanaly[zs.okno] || {})[w.id] || []).map((k) => ({ nazwa: k[0], s: k[1], n: k[2], bs: k[1 + off], bn: k[2 + off], klucz: k[10] }))
      .filter((k) => k.s || k.bs).sort((a, b) => b.n - a.n || b.bn - a.bn).slice(0, 8);
    const znaki = [w.dost === 0 ? '<span class="z-znak zly">stan 0</span>' : '', w.dost > 0 && w.dni != null && w.dni < 14 ? `<span class="z-znak uwaga">zapas ${w.dni} dni</span>` : '',
      w.nowosc ? '<span class="z-znak dobry">nowość</span>' : '', w.a.s > 0 && w.a.z < 0 ? '<span class="z-znak zly">strata</span>' : ''].join('');
    const zm = (a, b) => (b > 0 ? W.zmiana(a, b) : a > 0 ? '<span class="sw-plus">nowy</span>' : '—');
    return `<div class="sw-karta" data-tw="${w.id}">
      <div class="sw-foto" data-tw="${w.id}"><img src="/api/produkty/${w.id}/zdjecie?rozmiar=mini" alt="" loading="lazy" onerror="this.parentNode.classList.add('sw-bez-foto');this.remove()"></div>
      <div class="sw-sku">${W.esc(w.sym)}${w.zestaw ? '<span class="sw-tag">zestaw</span>' : ''}<span class="sw-tag">${W.esc(w.grupa)}</span>${znaki}</div>
      <div class="sw-naz">${W.esc(w.nazwa)}</div>
      <div class="z-por"><span class="t">Sztuki</span><span><b>${W.szt(w.a.s)}</b> <span class="sw-brak">${przed} ${W.szt(w.b.s)}</span></span><span class="p">${zm(w.a.s, w.b.s)}</span>
        <span class="t">Przychód</span><span><b>${W.zl(w.a.n)}</b> <span class="sw-brak">${przed} ${W.zl(w.b.n)}</span></span><span class="p">${zm(w.a.n, w.b.n)}</span>
        <span class="t">Zysk</span><span><b>${W.zl(w.a.z)}</b> <span class="sw-brak">marża ${W.pct(w.a.n ? w.a.z / w.a.n * 100 : null)}</span></span><span class="p">${zm(w.a.z, w.b.z)}</span></div>
      ${wykresTyg(w.id)}
      <table class="sw-ktab">${kan.map((k, j) => `<tr><td data-kk="${j}">${W.esc(k.nazwa)}</td><td class="sw-l">${W.szt(k.s)} szt.</td><td class="sw-l sw-brak">${W.szt(k.bs)}</td><td class="sw-l">${zm(k.n, k.bn)}</td></tr>`).join('')
        || '<tr><td class="sw-brak">brak sprzedaży w kanałach</td></tr>'}</table>
      <div class="sw-pole"><div class="sw-t">Stan</div>Dostępne <b>${w.dost == null ? '—' : W.szt(w.dost)}</b> <span class="sw-brak">${w.zestaw ? 'kompletów ze składników' : 'Razem − rezerwacje'}</span>
        ${w.dni == null ? '' : `· zapas ~${W.szt(w.dni)} dni`}</div>
    </div>`;
  }

  // linki do ofert dla oglądanej karty (nazwa kanału → oferta na platformie), raz na towar
  async function linkiKarty(i) {
    const karta = $('z-karty').children[i];
    const id = karta && Number(karta.dataset.tw);
    if (!id || karta.dataset.linki) return;
    karta.dataset.linki = '1';
    try {
      const of = oferty.get(id) || await get(`/api/analiza/oferty/${id}`);
      oferty.set(id, of);
      const kan = ((X.kanaly[zs.okno] || {})[id] || []).map((k) => ({ klucz: k[10], s: k[1], n: k[2], bs: k[1 + (zs.por === 'prev' ? 3 : 6)], bn: k[2 + (zs.por === 'prev' ? 3 : 6)], nazwa: k[0] }))
        .filter((k) => k.s || k.bs).sort((a, b) => b.n - a.n || b.bn - a.bn).slice(0, 8);
      kan.forEach((k, j) => {
        const o = (of[k.klucz] || [])[0], td = karta.querySelector(`td[data-kk="${j}"]`);
        if (o && td) td.innerHTML = `<a href="${W.esc(o.produkt)}" target="_blank" rel="noopener">${W.esc(k.nazwa)} ↗</a>`;
      });
    } catch { /* bez linków */ }
  }

  function zLicznik() {
    const k = $('z-karty'), karta = k.querySelector('.sw-karta');
    const i = karta ? Math.round(k.scrollLeft / (karta.offsetWidth + 10)) : 0;
    $('z-licznik').textContent = zLista.length ? `${Math.min(i + 1, zLista.length)} / ${W.szt(zLista.length)}` : '';
    if (i > zIle - 6) dorysuj();
    if (karta) linkiKarty(i);
  }
  const zKrok = (d) => { const k = $('z-karty'); k.scrollBy({ left: d * ((k.querySelector('.sw-karta')?.offsetWidth || 300) + 10), behavior: 'smooth' }); };
  $('z-karty').addEventListener('scroll', () => requestAnimationFrame(zLicznik), { passive: true });
  $('z-wstecz').onclick = () => zKrok(-1);
  $('z-dalej').onclick = () => zKrok(1);
  $('d-wstecz').onclick = () => { st.dzien = W.dodajDni(st.dzien, -1); laduj(); };
  $('d-dalej').onclick = () => { if (st.dzien < st.dzis) { st.dzien = W.dodajDni(st.dzien, 1); laduj(); } };

  (async () => {
    await WMS.gotowe;
    try {
      const s = await get('/api/analiza/stan');
      st.dzis = s.dzis; st.dzien = s.dzis;
    } catch (e) {
      $('hero').innerHTML = `<div class="sw-minus">${W.esc(e.message)}</div>`;
      return;
    }
    laduj();
    // dziś odświeżamy co 5 minut (job dosypuje zamówienia co kwadrans)
    setInterval(() => { if (st.zakres !== 'zmiany' && st.dzien === st.dzis && !document.hidden) laduj(); }, 5 * 60_000);
  })();
})();
