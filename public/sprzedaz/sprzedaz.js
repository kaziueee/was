'use strict';
// Analiza sprzedaży na telefon — /sprzedaz/ (docs/analiza-sprzedazy.md). Dane: GET /api/analiza/* (czyta tylko
// db/sprzedaz.db, więc odpowiada w milisekundach). Wybór zakresu, podstawy daty i sortowania pamięta urządzenie
// (localStorage) — wygoda, nie stan systemu.
(function () {
  const W = window.SprzedazW;
  const $ = (id) => document.getElementById(id);
  const pamiec = (k, d) => { try { return localStorage.getItem('wms-sprzedaz-' + k) || d; } catch { return d; } };
  const zapamietaj = (k, v) => { try { localStorage.setItem('wms-sprzedaz-' + k, v); } catch { /* bez pamięci */ } };

  const OPCJE = {
    zakres: [['dzien', 'Dzień'], ['t7', '7 dni'], ['mtd', 'Miesiąc'], ['ytd', 'Rok']],
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
    setInterval(() => { if (st.dzien === st.dzis && !document.hidden) laduj(); }, 5 * 60_000);
  })();
})();
