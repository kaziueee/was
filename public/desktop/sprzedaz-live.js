'use strict';

// Sprzedaż → „Live” (desktop, tylko admin): ostatnie zamówienia po kolei — to samo co „Live” na telefonie (/sprzedaz/),
// ale tabelą: wiersz = pozycja, dane zamówienia (godzina, kanał, numer, marża i zysk) stoją przy jego pierwszej pozycji.
// GET /api/analiza/live (kursor „dzień|zk|fs”); co minutę nowe zamówienia na górę, starsze doczytywane na dole.
// Klik w pozycję = karta produktu z Trendów (window.sprzedazOtworzProdukt, sprzedaz-trendy.js; decyzja usera
// 2026-10-26), ← → po towarach z tej listy. Plik ładuje się PRZED app.js; app.js woła odswiezSprzedazLive() przy
// pierwszym wejściu — dalej panel odświeża się sam, ale tylko gdy jest na ekranie.

(function () {
  const $ = (id) => document.getElementById('sl-' + id);
  const CO_MS = 60_000;
  const WALUTY = { PLN: 'zł', EUR: '€', RON: 'RON', HUF: 'Ft' };
  const KOLUMN = 10;
  let zamowienia = [], kursor = null, timer = null, laduje = false, coMin = 5;
  const pokazane = new Set();
  let swieze = new Set();                   // id zamówień dołożonych przy ostatnim odświeżeniu — podświetlone przez chwilę

  const widoczny = () => !document.getElementById('panel-sprzedaz-live').classList.contains('hidden') && !document.hidden;
  const cena = (x, w) => (x == null ? '—' : `${Number(x).toLocaleString('pl-PL', { minimumFractionDigits: w === 'HUF' ? 0 : 2, maximumFractionDigits: w === 'HUF' ? 0 : 2 })} ${WALUTY[w] || w || 'zł'}`);

  function wierszeZamowienia(z) {
    const W = window.SprzedazW;
    const godz = z.godz ? (z.godz_zrodlo === 'uuid' ? z.godz : '≈' + z.godz) : '—';
    const godzTytul = z.godz_zrodlo === 'uuid' ? 'godzina złożenia (Allegro)' : z.godz ? `kiedy WMS pierwszy raz zobaczył zamówienie (do ${coMin} min po wpłynięciu)` : 'godzina nieznana';
    // marża i zysk zamówienia (przychód netto z wysyłką klienta — jak w całym module); „≈” = marża handlowa
    const przybl = z.zysk_handlowy ? '≈' : '';
    const wynik = z.zysk == null ? '<span class="sw-brak">—</span>'
      : `<span class="${z.zysk < 0 ? 'sw-minus' : ''}">${przybl}${W.pct(W.marza(z))}<br>${przybl}${W.zl(z.zysk)}</span>`
        + (z.doplata ? `<div class="sw-brak" title="Allegro Ceny / AlleObniżka: dopłata Allegro do ceny oferty, poza fakturą (netto) — w przychodzie i zysku">z dopłatą Allegro ${W.zl(z.doplata)}</div>` : '');
    const poz = z.pozycje.length ? z.pozycje : [null];
    const rs = poz.length > 1 ? ` rowspan="${poz.length}"` : '';
    const zam = [
      `<td class="sl-zcel"${rs} title="${godzTytul}">${godz}</td>`,
      `<td class="sl-zcel"${rs}>${W.esc(z.kanal_nazwa)}</td>`,
      `<td class="sl-zcel"${rs}><span class="sl-nr">${W.esc(z.numer || '')}</span>${z.status === 'zamowione' ? '<span class="sw-tag">bez faktury</span>' : ''}`
        + `${z.dzien !== z.wplyw ? `<div class="sw-brak">zamówione ${W.dzienTxt(z.dzien, false)}</div>` : ''}</td>`,
    ];
    const kon = `<td class="sl-zcel num"${rs}>${wynik}</td>`;
    const klasa = (i) => `${i === 0 ? 'sl-pierwsza' : ''}${swieze.has(z.id) ? ' sl-nowe' : ''}`;
    return poz.map((p, i) => {
      if (!p) return `<tr class="${klasa(0)}">${zam.join('')}<td colspan="6" class="sw-brak">bez pozycji towarowych</td>${kon}</tr>`;
      return `<tr class="sl-klik ${klasa(i)}" data-id="${p.tw_id}">${i === 0 ? zam.join('') : ''}`
        + `<td><img class="sd-min" src="/api/produkty/${p.tw_id}/zdjecie?rozmiar=mini" alt="" loading="lazy" onerror="this.remove()"></td>`
        + `<td><b>${W.esc(p.symbol || p.tw_id)}</b>${p.zestaw ? '<span class="sw-tag">zestaw</span>' : ''} <span class="sd-nz" title="${W.esc(p.nazwa)}">${W.esc(p.nazwa || '')}</span></td>`
        + `<td class="num">${W.szt(p.szt)} × ${cena(p.cena_wal, z.waluta)}</td>`
        + `<td class="num">${p.dostepne == null ? '—' : W.szt(p.dostepne)}</td><td class="num">${p.dni_zapasu == null ? '—' : '~' + W.szt(p.dni_zapasu) + ' dni'}</td>`
        + `<td>${W.flagi(p.flagi)}</td>${i === 0 ? kon : ''}</tr>`;
    }).join('');
  }

  function rysuj() {
    const W = window.SprzedazW;
    let html = '<thead><tr><th>Godz.</th><th>Kanał</th><th>Zamówienie</th><th></th><th>SKU / nazwa</th><th class="num">Szt. × cena</th>'
      + '<th class="num">Dostępne</th><th class="num">Zapas</th><th>Uwagi</th><th class="num">Marża · zysk</th></tr></thead><tbody>';
    let dzien = null;
    for (const z of zamowienia) {
      // separator przed pierwszym zamówieniem z innego dnia wpływu
      if (z.wplyw !== dzien) { dzien = z.wplyw; html += `<tr class="sl-dzien"><td colspan="${KOLUMN}">${W.dzienTxt(dzien, false)}</td></tr>`; }
      html += wierszeZamowienia(z);
    }
    if (!zamowienia.length) html += `<tr><td colspan="${KOLUMN}" class="sw-brak">Brak zamówień.</td></tr>`;
    $('tabela').innerHTML = html + '</tbody>';
    $('wiecej').classList.toggle('hidden', !kursor);
  }

  function stopka(d) {
    if (d.co_min) coMin = d.co_min;
    $('stopka').textContent = `dane z ${window.SprzedazW.godzina(d.dane_z) || '—'} · WMS wczytuje zamówienia co ${coMin} min`;
  }
  function blad(e) { $('blad').textContent = e ? e.message : ''; $('blad').classList.toggle('hidden', !e); }

  async function odswiezSprzedazLive() {
    try {
      const d = await api('/api/analiza/live?limit=40');
      zamowienia = d.zamowienia; kursor = d.kursor; swieze = new Set();
      pokazane.clear(); zamowienia.forEach((z) => pokazane.add(z.id));
      stopka(d); blad(null); rysuj();
    } catch (e) { blad(e); }
    clearInterval(timer);
    timer = setInterval(dociagnijNowe, CO_MS);
  }

  // Nowe zamówienia na górę, podświetlone. Gdy ktoś przewinął w dół, strona przesuwa się o dołożone wiersze, żeby
  // oglądane zamówienie nie uciekło spod oczu.
  async function dociagnijNowe() {
    if (!widoczny()) return;
    try {
      const d = await api('/api/analiza/live?limit=40');
      stopka(d);
      const nowe = d.zamowienia.filter((z) => !pokazane.has(z.id));
      if (!nowe.length) return;
      if (nowe.length === d.zamowienia.length) { odswiezSprzedazLive(); return; }   // przerwa dłuższa niż 40 zamówień
      nowe.forEach((z) => pokazane.add(z.id));
      const t = $('tabela'), przed = t.offsetHeight, ponizej = t.getBoundingClientRect().top < 0;
      zamowienia = [...nowe, ...zamowienia]; swieze = new Set(nowe.map((z) => z.id));
      rysuj();
      if (ponizej) window.scrollBy(0, t.offsetHeight - przed);
      setTimeout(() => { swieze = new Set(); document.querySelectorAll('#sl-tabela .sl-nowe').forEach((x) => x.classList.remove('sl-nowe')); }, 8000);
    } catch { /* następna próba za minutę */ }
  }

  async function starsze() {
    if (!kursor || laduje) return;
    laduje = true;
    try {
      const d = await api(`/api/analiza/live?limit=40&przed=${encodeURIComponent(kursor)}`);
      const lista = d.zamowienia.filter((z) => !pokazane.has(z.id));
      lista.forEach((z) => pokazane.add(z.id));
      zamowienia = [...zamowienia, ...lista]; kursor = d.kursor;
      rysuj();
    } catch (e) { blad(e); } finally { laduje = false; }
  }

  function podepnij() {
    $('wiecej').onclick = starsze;
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((e) => { if (e[0].isIntersecting && widoczny()) starsze(); }, { rootMargin: '600px' }).observe($('wiecej'));
    }
    $('tabela').addEventListener('click', (e) => {
      if (e.target.closest('td.sl-zcel, a')) return;            // komórki zamówienia (rowspan) — to nie jest konkretny towar
      const tr = e.target.closest('tr.sl-klik'); if (!tr) return;
      const lista = zamowienia.flatMap((z) => z.pozycje.map((p) => ({ id: p.tw_id, sym: p.symbol, nazwa: p.nazwa })));
      window.sprzedazOtworzProdukt(+tr.dataset.id, lista, 'Live');
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) dociagnijNowe(); });
    // app.js woła odswiezSprzedazLive() tylko przy pierwszym wejściu — powrót na zakładkę dociąga od razu, nie po minucie
    window.addEventListener('hashchange', () => setTimeout(() => { if (zamowienia.length || kursor) dociagnijNowe(); }, 0));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', podepnij);
  else podepnij();
  window.odswiezSprzedazLive = odswiezSprzedazLive;
})();
