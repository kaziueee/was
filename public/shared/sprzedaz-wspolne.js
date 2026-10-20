'use strict';
// Analiza sprzedaży — wspólne dla telefonu (/sprzedaz/) i desktopu (Sprzedaż → Dzień): formatowanie, grupowanie
// kanałów, karta produktu. Dane i reguły liczy backend (routes/analiza.js); tu tylko wyświetlanie.
(function () {
  const nf0 = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nf2 = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const zl = (x) => (x == null || !isFinite(x) ? '—' : nf0.format(Math.round(x)) + ' zł');
  const szt = (x) => nf0.format(x || 0);
  const pct = (x) => (x == null || !isFinite(x) ? '—' : nf1.format(x) + '%');
  const naSzt = (zysk, n) => (zysk == null || !n ? '—'
    : (Math.abs(zysk / n) < 10 ? nf1.format(zysk / n) : nf0.format(Math.round(zysk / n))) + ' zł/szt.');
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const marza = (g) => (g.zysk == null || !g.netto ? null : g.zysk / g.netto * 100);

  const DNI = ['niedz.', 'pon.', 'wt.', 'śr.', 'czw.', 'pt.', 'sob.'];
  const dt = (s) => new Date(s + 'T12:00:00');
  const dzienTxt = (s, rok = true) => {
    const d = dt(s);
    return `${DNI[d.getDay()]} ${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}${rok ? '.' + d.getFullYear() : ''}`;
  };
  const zakresTxt = (o) => {
    if (o[0] === o[1]) return dzienTxt(o[0]);
    const a = dt(o[0]), b = dt(o[1]);
    return `${a.getDate()}.${String(a.getMonth() + 1).padStart(2, '0')}–${b.getDate()}.${String(b.getMonth() + 1).padStart(2, '0')}.${b.getFullYear()}`;
  };
  // znacznik z bazy modułu (ISO z Z albo SQLite UTC 'YYYY-MM-DD HH:MM:SS') → HH:MM lokalnie (zob. „Czas” w CLAUDE.md)
  const godzina = (s) => {
    if (!s) return null;
    const d = new Date(/Z$|T/.test(s) ? s : String(s).replace(' ', 'T') + 'Z');
    return isNaN(d) ? null : d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  };
  const dodajDni = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

  function zmiana(cur, prev) {
    if (prev == null || cur == null || !prev) return '<span class="sw-brak">—</span>';
    const p = (cur / prev - 1) * 100;
    return `<span class="${p >= 0 ? 'sw-plus' : 'sw-minus'}">${p >= 0 ? '+' : ''}${nf0.format(Math.round(p))}%</span>`;
  }

  // Kanały, które na ekranie idą do rozwijanego „Inne” (małe, bez reguł w kalkulatorze).
  const INNE = ['FENOM', 'MEDIA_EXPERT', 'INPOST_PAY', 'ERLI', 'PIGU', 'AMAZON_EU', 'INNE'];
  const RYNKI_ALLEGRO = { PL: 'Polska', CZ: 'Czechy', SK: 'Słowacja', HU: 'Węgry' };

  // Suma na górze ekranu = sprzedaż internetowa (FS z K4, jak ERP Dashboard). Sklep (paragony z MAG) jest
  // osobnym wierszem „poza sumą” — decyzja usera 2026-10-20: jego wahania nie mają mieszać trendu internetu.
  const POZA_SUMA = ['SKLEP'];
  function sumy(kanaly) {
    const s = { zam: 0, szt: 0, netto: 0, zysk: 0, handl: 0, zamowione: 0 };
    for (const [k, g] of Object.entries(kanaly || {})) { if (POZA_SUMA.includes(k)) continue; for (const p of Object.keys(s)) s[p] += g[p] || 0; }
    return s;
  }

  // Wiersze tabeli kanałów: kanał z dziećmi (Allegro → kraje) i grupa „Inne”, posortowane po przychodzie.
  function wierszeKanalow(cur, prev, nazwy) {
    const pusty = { zam: 0, szt: 0, netto: 0, zysk: 0, handl: 0, rynki: {} };
    const klucze = [...new Set([...Object.keys(cur || {}), ...Object.keys(prev || {})])];
    const inne = { k: '_INNE', nazwa: 'Inne kanały', cur: { ...pusty }, prev: { ...pusty }, dzieci: [] };
    const lista = [], osobno = [];
    for (const k of klucze) {
      const w = { k, nazwa: nazwy[k] || k, cur: (cur || {})[k] || pusty, prev: (prev || {})[k] || pusty, dzieci: [] };
      if (POZA_SUMA.includes(k)) { w.pozaSuma = true; osobno.push(w); continue; }
      if (INNE.includes(k)) {
        inne.dzieci.push(w);
        for (const o of ['cur', 'prev']) for (const p of ['zam', 'szt', 'netto', 'zysk', 'handl']) inne[o][p] += w[o][p] || 0;
        continue;
      }
      if (k.startsWith('ALLEGRO')) {
        const rynki = [...new Set([...Object.keys(w.cur.rynki || {}), ...Object.keys(w.prev.rynki || {})])];
        if (rynki.length > 1) w.dzieci = rynki.map((r) => ({ k: r, nazwa: `${RYNKI_ALLEGRO[r] || r}`, cur: (w.cur.rynki || {})[r] || pusty,
          prev: (w.prev.rynki || {})[r] || pusty, dzieci: [] })).sort((a, b) => b.cur.netto - a.cur.netto);
      }
      lista.push(w);
    }
    lista.sort((a, b) => b.cur.netto - a.cur.netto);
    inne.dzieci.sort((a, b) => b.cur.netto - a.cur.netto);
    if (inne.dzieci.length) lista.push(inne);
    return { lista, osobno };
  }

  // Zysk z oznaczeniem „≈”, gdy przeważa marża handlowa (kanał bez reguł w kalkulatorze).
  function zyskTxt(g) {
    if (g.zysk == null) return '<span class="sw-brak">—</span>';
    return g.handl && g.netto && g.handl / g.netto > 0.5
      ? `<span class="sw-przybl" title="marża handlowa: kanał bez reguł w kalkulatorze (bez prowizji i wysyłki)">≈ ${zl(g.zysk)}</span>` : zl(g.zysk);
  }

  const FLAGI = { konczy: 'Kończy się', nadmiar: 'Nadmiar', nowosc: 'Nowość', zalega: 'Zalega' };
  const flagi = (lista) => (lista || []).map((f) => `<span class="sw-flaga sw-flaga-${f}">${FLAGI[f] || f}</span>`).join('');

  // Karta produktu (swipe na telefonie). p — wiersz z GET /api/analiza/produkty.
  function karta(p, nazwy) {
    const kan = p.kanaly.map((c) => `<tr><td>${esc(nazwy[c.k] || c.k)}</td><td class="sw-l">${szt(c.szt)} szt.</td>`
      + `<td class="sw-l">${pct(c.netto ? c.zysk / c.netto * 100 : null)}</td><td class="sw-l">${naSzt(c.zysk, c.szt)}</td>`
      + `<td class="sw-l">${c.handl ? `<span class="sw-przybl" title="marża handlowa">≈ ${zl(c.zysk)}</span>` : zl(c.zysk)}</td></tr>`).join('');
    const s = p.stan;
    const stan = s ? `K4 <b>${szt(s.k4)}</b>${s.rez_k4 ? ` <span class="sw-brak">(rez. ${szt(s.rez_k4)})</span>` : ''} · K4G <b>${szt(s.k4g)}</b> · Razem <b>${szt(s.razem)}</b><br>`
      + (p.dni_zapasu == null ? 'brak sprzedaży w 30 dni' : `zapas ~${szt(p.dni_zapasu)} dni <span class="sw-brak">(tempo 30 dni: ${szt(p.szt30)} szt.)</span>`)
      + (p.flagi.length ? '<br>' + flagi(p.flagi) : '')
      : '<span class="sw-brak">brak zdjęcia stanów</span>';
    let rep = '<span class="sw-brak" style="grid-column:1/-1">stan repricera niedostępny</span>', strategia = '';
    if (p.repricer) {
      // kanały ze sprzedażą w tym dniu i te z automatem; resztę zwijamy w jedną linię
      const dzis = new Set(p.kanaly.map((c) => c.k));
      const waz = p.repricer.oferty.filter((r) => r.auto || dzis.has(r.k)), reszta = p.repricer.oferty.length - waz.length;
      const bb = (r) => (r.bb === 1 ? '<span class="sw-tak">BB ✓</span>' : r.bb === 0 ? '<span class="sw-nie">BB ✗</span>' : '<span></span>');
      rep = p.repricer.oferty.length ? waz.map((r) => `<span>${esc(nazwy[r.k] || r.k)}${r.n > 1 ? ` <span class="sw-brak">×${r.n}</span>` : ''}</span>`
        + `<span class="${r.auto ? 'sw-tak' : 'sw-brak'}">${r.auto ? 'automat' : 'ręcznie'}</span>${bb(r)}`
        + `<span class="sw-l">${r.cena == null ? '' : nf2.format(r.cena) + ' ' + esc(r.waluta)}</span>`).join('')
        + (reszta ? `<span class="sw-brak" style="grid-column:1/-1">+ ${reszta} ${reszta === 1 ? 'oferta' : reszta < 5 ? 'oferty' : 'ofert'} bez automatu i bez sprzedaży</span>` : '')
        : '<span class="sw-brak" style="grid-column:1/-1">brak ofert w repricerze</span>';
      const st = p.repricer.strategia;
      strategia = `<div style="margin-top:4px">Strategia: <b>${esc(st ? st.nazwa : 'All marża 20')}</b> <span class="sw-brak">${st ? (st.aktywna ? '' : '(podgląd)') + (st.do ? ` do ${esc(st.do)}` : '') : '(domyślna)'}</span></div>`;
    }
    return `<div class="sw-karta">
      <div class="sw-foto" data-tw="${p.tw_id}"><img src="/api/produkty/${p.tw_id}/zdjecie?rozmiar=mini" alt="" loading="lazy" onerror="this.parentNode.classList.add('sw-bez-foto');this.remove()"></div>
      <div class="sw-sku">${esc(p.symbol || p.tw_id)}${p.zestaw ? '<span class="sw-tag">zestaw</span>' : ''}${p.grupa ? `<span class="sw-tag">${esc(p.grupa)}</span>` : ''}</div>
      <div class="sw-naz">${esc(p.nazwa || '')}</div>
      <div class="sw-suma"><span><b>${szt(p.szt)}</b> szt.</span><span>marża <b>${pct(p.netto ? p.zysk / p.netto * 100 : null)}</b></span>`
      + `<span><b>${naSzt(p.zysk, p.szt)}</b></span><span>zysk <b>${zl(p.zysk)}</b></span><span class="sw-brak">${zl(p.netto)} netto</span></div>
      <table class="sw-ktab">${kan}</table>
      <div class="sw-pole"><div class="sw-t">Stan</div>${stan}</div>
      <div class="sw-pole"><div class="sw-t">Repricer</div><div class="sw-rep">${rep}</div>${strategia}</div>
    </div>`;
  }

  // Ostrzeżenia nad liczbami: dni nietypowe (przestój integracji) i brak historii rok temu.
  function ostrzezenia(d) {
    const w = [];
    if (!d.historia_pelna) w.push('Historia sprzed roku nie jest jeszcze wczytana w całości — porównanie r/r może być zaniżone.');
    if (d.nietypowe && d.nietypowe.length) {
      w.push('Dni nietypowe w porównaniu (liczba zamówień daleko od mediany z 4 tygodni — np. przestój integracji albo Black Friday): '
        + d.nietypowe.map((x) => `${dzienTxt(x.dzien)} — ${szt(x.zamowien)} zam. (zwykle ~${szt(x.mediana)})`).join(', ') + '.');
    }
    return w;
  }

  window.SprzedazW = { zl, szt, pct, naSzt, esc, marza, dzienTxt, zakresTxt, godzina, dodajDni, zmiana, sumy, wierszeKanalow, zyskTxt,
    flagi, karta, ostrzezenia, nf1 };
})();
