'use strict';

// Sprzedaż → „Trendy” (desktop, tylko admin): kafle okresów, trend tygodniowy z rokiem temu, miesiące r/r, udział
// kanałów, grupy top 30 z wejściem w grupę, produkty bez limitu z filtrami (hity, trendujące, spadek trendu, ze
// stratą, zgasły, nowości) i karta produktu: ceny ofert z edycją ceny ⇄ marży (repricer) i kanały sprzedaży. Dane: GET /api/analiza/trendy
// (services/analiza-trendy.js) — dni zamknięte do wczoraj. Wszystko poza pobraniem liczy się w przeglądarce, więc
// przełączniki nie pytają serwera. Plik ładuje się PRZED app.js; app.js woła odswiezSprzedazTrendy().

(function () {
  const ZDJ = (id) => `/api/produkty/${id}/zdjecie?rozmiar=mini`;
  const ZDJ_DUZE = (id) => `/api/produkty/${id}/zdjecie?rozmiar=duze`;
  const nf0 = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const zl = (x) => (x == null ? '—' : nf0.format(Math.round(x)) + ' zł');
  const szt = (x) => nf0.format(Math.round(x || 0));
  const kompakt = (x) => (Math.abs(x) >= 1e6 ? nf1.format(x / 1e6) + ' mln' : Math.abs(x) >= 1000 ? nf0.format(x / 1000) + ' tys.' : nf0.format(x));
  const pct = (x) => (x == null || !isFinite(x) ? '—' : nf1.format(x) + '%');
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const DNI = ['niedz.', 'pon.', 'wt.', 'śr.', 'czw.', 'pt.', 'sob.'];
  const dd = (s) => `${s.slice(8, 10)}.${s.slice(5, 7)}`;
  const dzienTxt = (s) => { const d = new Date(s + 'T12:00:00'); return `${DNI[d.getDay()]} ${dd(s)}.${s.slice(0, 4)}`; };
  const dodaj = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const $ = (id) => document.getElementById('tr-' + id);
  const kolor = (v) => getComputedStyle(document.getElementById('panel-sprzedaz-trendy')).getPropertyValue(v).trim();
  const SVG = (w, h, tresc) => `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img">${tresc}</svg>`;

  function zmiana(cur, prev, { pp = false } = {}) {
    if (pp) {
      if (cur == null || prev == null) return '<span class="tr-sz">—</span>';
      const d = cur - prev;
      return `<span class="${d >= 0 ? 'tr-up' : 'tr-down'}">${d >= 0 ? '+' : '−'}${nf1.format(Math.abs(d))} pp</span>`;
    }
    if (!prev) return '<span class="tr-sz">—</span>';
    const p = (cur / prev - 1) * 100;
    return `<span class="${p >= 0 ? 'tr-up' : 'tr-down'}">${p >= 0 ? '+' : '−'}${nf0.format(Math.abs(Math.round(p)))}%</span>`;
  }
  const zmianaZl = (d) => (Math.abs(d) < 0.5 ? '<span class="tr-sz">0 zł</span>'
    : `<span class="${d >= 0 ? 'tr-up' : 'tr-down'}">${d >= 0 ? '+' : '−'}${nf0.format(Math.abs(Math.round(d)))} zł</span>`);
  function seg(el, opcje, wart, gdy) {
    el.innerHTML = opcje.map(([v, t]) => `<button type="button" data-v="${v}" class="${String(v) === String(wart) ? 'wl' : ''}">${t}</button>`).join('');
    el.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; el.querySelectorAll('button').forEach((x) => x.classList.toggle('wl', x === b)); gdy(b.dataset.v); };
  }
  function ticki(max, n = 4) {
    const surowy = max / n, pot = Math.pow(10, Math.floor(Math.log10(surowy || 1)));
    const krok = [1, 2, 2.5, 5, 10].map((m) => m * pot).find((k) => k >= surowy) || pot * 10;
    const t = [];
    for (let v = 0; v <= max * 1.0001 + krok * 0.01; v += krok) t.push(v);
    if (t[t.length - 1] < max) t.push(t[t.length - 1] + krok);
    return t;
  }
  // słupek z zaokrąglonym końcem (4 px) i kwadratową podstawą
  const slupek = (x, y, w, h, k) => {
    if (h <= 0.5) return '';
    const r = Math.min(4, w / 2, h);
    return `<path d="M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z" fill="${k}"/>`;
  };
  function pokazTip(tip, host, html, px, py) {
    tip.innerHTML = html; tip.style.display = 'block';
    const W = host.clientWidth, tw = tip.offsetWidth;
    tip.style.left = Math.min(Math.max(0, px + 12), W - tw - 4) + 'px';
    tip.style.top = Math.max(0, py - 10) + 'px';
  }
  const os = (L, R, W, y, tk, H) => tk.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${kolor('--tr-grid')}"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="${kolor('--tr-muted')}">${kompakt(v)}</text>`).join('');

  let X = null;                    // dane z API
  let ladowanie = null;

  const SZKIELET = `
    <div class="tr-info" id="tr-info"></div>
    <section class="tr-karta"><div class="tr-nag"><div><h3>Podsumowanie okresów</h3><div class="tr-opis">Zamknięte dni do wczoraj vs te same dni rok temu (−364 dni, ten sam dzień tygodnia). Internet — bez paragonów Sklepu.</div></div></div>
      <div class="tr-kafle" id="tr-kafle"></div></section>
    <section class="tr-karta"><div class="tr-nag"><div><h3>Trend tygodniowy</h3><div class="tr-opis" id="tr-tyg-opis"></div></div>
      <div class="tr-ster"><span class="tr-seg" id="tr-tyg-miara"></span><span class="tr-seg" id="tr-tyg-zakres"></span></div></div>
      <div class="tr-legenda"><span><i style="background:var(--tr-s1)"></i>ten rok (pełne tygodnie pon–nd)</span><span><i class="tr-linia" style="background:var(--tr-rok)"></i>ten sam tydzień rok temu</span></div>
      <div class="tr-wykres" id="tr-tyg"></div></section>
    <div class="tr-dwie">
      <section class="tr-karta"><div class="tr-nag"><div><h3>Miesiące rok do roku</h3><div class="tr-opis" id="tr-mies-opis"></div></div><span class="tr-seg" id="tr-mies-miara"></span></div>
        <div class="tr-legenda" id="tr-mies-leg"></div><div class="tr-wykres" id="tr-mies"></div></section>
      <section class="tr-karta"><div class="tr-nag"><div><h3>Kanały — udział w przychodzie</h3><div class="tr-opis">Tygodniowo, 26 pełnych tygodni. Który kanał rośnie kosztem którego.</div></div></div>
        <div class="tr-legenda" id="tr-kan-leg"></div><div class="tr-wykres" id="tr-kan"></div><table class="tr-tab" id="tr-kan-tab" style="margin-top:8px"></table></section>
    </div>
    <section class="tr-karta" id="tr-sek-grupy"><div class="tr-nag"><div><h3>Grupy towarów — top 30</h3><div class="tr-opis" id="tr-gr-opis"></div></div>
      <div class="tr-ster"><span class="tr-seg" id="tr-gr-okno"></span><span class="tr-seg" id="tr-gr-por"></span><span class="tr-seg" id="tr-gr-ile"></span></div></div>
      <div class="tr-przewin" style="max-height:560px"><table class="tr-tab" id="tr-grupy"></table></div>
      <div class="tr-stopka">Klik w grupę = lista jej produktów niżej (te same filtry). Grupy z kartoteki GT.</div></section>
    <section class="tr-karta" id="tr-sek-prod"><div class="tr-nag"><div><h3>Produkty</h3><div class="tr-opis" id="tr-pr-opis"></div></div>
      <div class="tr-ster"><span class="tr-seg" id="tr-pr-okno"></span><span class="tr-seg" id="tr-pr-por"></span>
        <label class="tr-opis">próg zmiany <input class="tr-pole" id="tr-pr-prog" type="number" value="30" min="5" step="5" style="width:62px"> %</label>
        <label class="tr-opis">baza <input class="tr-pole" id="tr-pr-baza" type="number" value="5" min="1" style="width:56px"> szt.</label>
        <select class="tr-pole" id="tr-pr-grupa"></select><input class="tr-pole" id="tr-pr-szukaj" placeholder="szukaj SKU / nazwy" style="width:180px"></div></div>
      <div class="tr-grupaNag" id="tr-pr-grupa-nag"></div><div class="tr-chipy" id="tr-pr-filtry"></div>
      <div class="tr-przewin"><table class="tr-tab" id="tr-produkty"></table></div><div class="tr-stopka" id="tr-pr-def"></div></section>`;

  // ---------- kafle ----------
  function rysujKafle() {
    $('info').innerHTML = `Wszystko kończy się na <b>${dzienTxt(X.koniec)}</b> (ostatni zamknięty dzień); pełne tygodnie do ${dzienTxt(X.ostatniaNiedz)}. Dzisiejszy, otwarty dzień — w zakładce „Dzień”.`;
    $('kafle').innerHTML = X.kafle.map((k) => {
      const m = (o) => (o.netto ? o.zysk / o.netto * 100 : null);
      return `<div class="tr-kafel"><div class="tr-t">${k.nazwa}</div><div class="tr-z">${dd(k.od)}–${dd(k.do)}.${k.do.slice(0, 4)} · rok temu ${dd(k.prevOd)}–${dd(k.prevDo)}.${k.prevDo.slice(0, 4)}</div>
        <div class="tr-glowna">${zl(k.cur.netto)}</div><div style="font-size:12px">${zmiana(k.cur.netto, k.prev.netto)} r/r · rok temu ${zl(k.prev.netto)}</div>
        <table><tr><td>Zysk</td><td class="tr-l">${zl(k.cur.zysk)}</td><td class="tr-l">${zmiana(k.cur.zysk, k.prev.zysk)}</td></tr>
        <tr><td>Marża</td><td class="tr-l">${pct(m(k.cur))}</td><td class="tr-l">${zmiana(m(k.cur), m(k.prev), { pp: true })}</td></tr>
        <tr><td>Sztuki</td><td class="tr-l">${szt(k.cur.szt)}</td><td class="tr-l">${zmiana(k.cur.szt, k.prev.szt)}</td></tr>
        <tr><td>Zamówienia</td><td class="tr-l">${szt(k.cur.zam)}</td><td class="tr-l">${zmiana(k.cur.zam, k.prev.zam)}</td></tr></table></div>`;
    }).join('');
  }

  // ---------- trend tygodniowy ----------
  const MIARY = [['netto', 'Przychód'], ['zysk', 'Zysk'], ['szt', 'Sztuki'], ['zam', 'Zamówienia']];
  const fMiary = (m, v) => (m === 'netto' || m === 'zysk' ? zl(v) : szt(v));
  const stTyg = { miara: 'netto', ile: 26 };
  function rysujTyg() {
    const host = $('tyg'), W = host.clientWidth || 1000, H = 300, L = 64, Rm = 12, T = 14, B = 30;
    const tw = X.tygodnie, n = Math.min(stTyg.ile, tw.length), od = tw.length - n, m = stTyg.miara;
    if (!n) { host.innerHTML = '<p class="hint">Brak pełnych tygodni.</p>'; return; }
    const pkt = tw.slice(od).map((t, i) => { const j = od + i - 52; return { t, v: t[m], r: j >= 0 ? tw[j][m] : null }; });
    const tk = ticki(Math.max(1, ...pkt.map((p) => Math.max(p.v, p.r || 0)))), ymax = tk[tk.length - 1];
    const pw = W - L - Rm, ph = H - T - B, band = pw / n, bw = Math.min(24, band * 0.72);
    const y = (v) => T + ph - v / ymax * ph;
    let s = os(L, Rm, W, y, tk);
    pkt.forEach((p, i) => { s += slupek(L + i * band + (band - bw) / 2, y(p.v), bw, T + ph - y(p.v), kolor('--tr-s1')); });
    let d = '', start = true;
    pkt.forEach((p, i) => { if (p.r == null) { start = true; return; } d += `${start ? 'M' : 'L'}${L + i * band + band / 2},${y(p.r)} `; start = false; });
    s += `<path d="${d}" fill="none" stroke="${kolor('--tr-rok')}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    const co = Math.ceil(n / 13);
    pkt.forEach((p, i) => { if (i % co === 0 || i === n - 1) s += `<text x="${L + i * band + band / 2}" y="${H - 10}" text-anchor="middle" font-size="11" fill="${kolor('--tr-muted')}">${dd(p.t.pon)}${n > 52 || i === 0 ? '.' + p.t.pon.slice(2, 4) : ''}</text>`; });
    s += `<line x1="${L}" x2="${W - Rm}" y1="${T + ph}" y2="${T + ph}" stroke="${kolor('--tr-axis')}"/>`;
    s += `<line class="tr-krzyz" x1="0" x2="0" y1="${T}" y2="${T + ph}" stroke="${kolor('--tr-axis')}" visibility="hidden"/>`;
    pkt.forEach((p, i) => { s += `<rect data-i="${i}" x="${L + i * band}" y="${T}" width="${band}" height="${ph}" fill="transparent"/>`; });
    host.innerHTML = SVG(W, H, s) + '<div class="tr-tip"></div>';
    const tip = host.querySelector('.tr-tip'), krzyz = host.querySelector('.tr-krzyz'), svg = host.querySelector('svg');
    svg.onmousemove = (e) => {
      const r = e.target.closest('rect[data-i]');
      if (!r) { tip.style.display = 'none'; krzyz.setAttribute('visibility', 'hidden'); return; }
      const i = +r.dataset.i, p = pkt[i], cx = L + i * band + band / 2, b = host.getBoundingClientRect();
      krzyz.setAttribute('x1', cx); krzyz.setAttribute('x2', cx); krzyz.setAttribute('visibility', 'visible');
      pokazTip(tip, host, `<div class="tr-sz">${dd(p.t.pon)}–${dd(dodaj(p.t.pon, 6))}.${dodaj(p.t.pon, 6).slice(0, 4)}</div><b>${fMiary(m, p.v)}</b> ten rok<br>`
        + (p.r == null ? '<span class="tr-sz">rok temu — brak danych</span>' : `<b>${fMiary(m, p.r)}</b> rok temu · ${zmiana(p.v, p.r)}`), e.clientX - b.left, e.clientY - b.top);
    };
    svg.onmouseleave = () => { tip.style.display = 'none'; krzyz.setAttribute('visibility', 'hidden'); };
    const ost = pkt.slice(-4), s4 = ost.reduce((a, p) => a + p.v, 0), r4 = ost.reduce((a, p) => a + (p.r || 0), 0);
    $('tyg-opis').innerHTML = `Ostatnie 4 pełne tygodnie: <b>${fMiary(m, s4)}</b> (${zmiana(s4, r4)} r/r). Tydzień, nie dzień — piątek i sobota to połowa wtorku, dzienny wykres byłby piłą.`;
  }

  // ---------- miesiące ----------
  const stMies = { miara: 'netto' };
  const MIES = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];
  function rysujMies() {
    const host = $('mies'), W = host.clientWidth || 600, H = 270, L = 58, Rm = 8, T = 14, B = 50, m = stMies.miara;
    const mm = new Map(X.miesiace.map((x) => [x.m, x]));
    const rokB = X.koniec.slice(0, 4), rokP = String(+rokB - 1);
    $('mies-leg').innerHTML = `<span><i style="background:var(--tr-s1)"></i>${rokB}</span><span><i style="background:var(--tr-rok)"></i>${rokP}</span>`;
    $('mies-opis').textContent = `${MIES[+X.koniec.slice(5, 7) - 1]} ${rokB} do ${dd(X.koniec)} — r/r liczone do tego samego dnia ${rokP}.`;
    const pkt = MIES.map((nazwa, i) => {
      const k = String(i + 1).padStart(2, '0'), b = mm.get(`${rokB}-${k}`), p = mm.get(`${rokP}-${k}`), czesc = `${rokB}-${k}` === X.koniec.slice(0, 7);
      return { nazwa, b: b ? b[m] : null, p: p ? p[m] : null, porown: czesc ? X.miesiacRokTemu[m] : p ? p[m] : null, czesc };
    });
    const tk = ticki(Math.max(1, ...pkt.map((x) => Math.max(x.b || 0, x.p || 0)))), ymax = tk[tk.length - 1];
    const pw = W - L - Rm, ph = H - T - B, band = pw / 12, bw = Math.min(18, (band - 10) / 2);
    const y = (v) => T + ph - v / ymax * ph;
    let s = os(L, Rm, W, y, tk);
    pkt.forEach((x, i) => {
      const sx = L + i * band + (band - 2 * bw - 2) / 2;
      if (x.p != null) s += slupek(sx, y(x.p), bw, T + ph - y(x.p), kolor('--tr-rok'));
      if (x.b != null) s += slupek(sx + bw + 2, y(x.b), bw, T + ph - y(x.b), kolor('--tr-s1'));
      s += `<text x="${L + i * band + band / 2}" y="${T + ph + 15}" text-anchor="middle" font-size="11" fill="${kolor('--tr-muted')}">${x.nazwa}${x.czesc ? '*' : ''}</text>`;
      const rr = x.b != null && x.porown ? (x.b / x.porown - 1) * 100 : null;
      if (rr != null) s += `<text x="${L + i * band + band / 2}" y="${T + ph + 32}" text-anchor="middle" font-size="11" font-weight="600" fill="${rr >= 0 ? kolor('--tr-plus') : kolor('--tr-minus')}">${rr >= 0 ? '+' : '−'}${nf0.format(Math.abs(Math.round(rr)))}%</text>`;
      s += `<rect data-i="${i}" x="${L + i * band}" y="${T}" width="${band}" height="${ph + 36}" fill="transparent"/>`;
    });
    s += `<line x1="${L}" x2="${W - Rm}" y1="${T + ph}" y2="${T + ph}" stroke="${kolor('--tr-axis')}"/>`;
    host.innerHTML = SVG(W, H, s) + '<div class="tr-tip"></div>';
    const tip = host.querySelector('.tr-tip'), svg = host.querySelector('svg');
    svg.onmousemove = (e) => {
      const r = e.target.closest('rect[data-i]');
      if (!r) { tip.style.display = 'none'; return; }
      const x = pkt[+r.dataset.i], b = host.getBoundingClientRect();
      pokazTip(tip, host, `<b>${x.nazwa}</b><br>${rokB}: <b>${x.b == null ? '—' : fMiary(m, x.b)}</b>${x.czesc ? ' (do ' + dd(X.koniec) + ')' : ''}<br>${rokP}: <b>${x.p == null ? '—' : fMiary(m, x.p)}</b>`
        + (x.czesc ? `<br>${rokP} do ${dd(X.koniec)}: <b>${fMiary(m, x.porown)}</b>` : '') + (x.b != null && x.porown ? '<br>r/r ' + zmiana(x.b, x.porown) : ''), e.clientX - b.left, e.clientY - b.top);
    };
    svg.onmouseleave = () => { tip.style.display = 'none'; };
  }

  // ---------- kanały ----------
  const KAN = ['Allegro', 'Amazon', 'eMAG', 'Empik', 'Kaufland', 'Inne'];
  const KOL = ['--tr-s1', '--tr-s2', '--tr-s3', '--tr-s4', '--tr-s5', '--tr-s6'];
  function rysujKan() {
    $('kan-leg').innerHTML = KAN.map((k, i) => `<span><i style="background:var(${KOL[i]})"></i>${k}</span>`).join('');
    const host = $('kan'), W = host.clientWidth || 600, H = 230, L = 40, Rm = 8, T = 8, B = 24;
    const tw = X.tygodnie.slice(-26), n = tw.length, pw = W - L - Rm, ph = H - T - B, band = pw / Math.max(1, n), bw = Math.min(24, band - 2);
    let s = [0, 25, 50, 75, 100].map((v) => `<line x1="${L}" x2="${W - Rm}" y1="${T + ph - v / 100 * ph}" y2="${T + ph - v / 100 * ph}" stroke="${kolor('--tr-grid')}"/><text x="${L - 6}" y="${T + ph - v / 100 * ph + 4}" text-anchor="end" font-size="11" fill="${kolor('--tr-muted')}">${v}%</text>`).join('');
    tw.forEach((t, i) => {
      const suma = KAN.reduce((a, k) => a + (t.kan[k] || 0), 0) || 1, x = L + i * band + (band - bw) / 2;
      let yy = T + ph;
      const ostatni = KAN.reduce((o, k, j) => ((t.kan[k] || 0) > 0 ? j : o), -1);
      KAN.forEach((k, j) => {
        const h = (t.kan[k] || 0) / suma * ph;
        if (h < 0.5) return;
        const top = yy - h, gora = j === ostatni;
        s += `<rect x="${x}" y="${top + (gora ? 0 : 1)}" width="${bw}" height="${Math.max(0, h - (gora ? 0 : 2))}" fill="var(${KOL[j]})" ${gora ? 'rx="3"' : ''}/>`;
        yy = top;
      });
      if (i % 4 === 0 || i === n - 1) s += `<text x="${L + i * band + band / 2}" y="${H - 6}" text-anchor="middle" font-size="11" fill="${kolor('--tr-muted')}">${dd(t.pon)}</text>`;
      s += `<rect data-i="${i}" x="${L + i * band}" y="${T}" width="${band}" height="${ph}" fill="transparent"/>`;
    });
    host.innerHTML = SVG(W, H, s) + '<div class="tr-tip"></div>';
    const tip = host.querySelector('.tr-tip'), svg = host.querySelector('svg');
    svg.onmousemove = (e) => {
      const r = e.target.closest('rect[data-i]');
      if (!r) { tip.style.display = 'none'; return; }
      const t = tw[+r.dataset.i], suma = KAN.reduce((a, k) => a + (t.kan[k] || 0), 0) || 1, b = host.getBoundingClientRect();
      pokazTip(tip, host, `<div class="tr-sz">tydzień od ${dd(t.pon)}</div>` + KAN.map((k, j) => `<i class="tr-kw" style="background:var(${KOL[j]})"></i>${k}: <b>${nf1.format((t.kan[k] || 0) / suma * 100)}%</b> · ${zl(t.kan[k] || 0)}`).join('<br>'), e.clientX - b.left, e.clientY - b.top);
    };
    svg.onmouseleave = () => { tip.style.display = 'none'; };
    // tabela — liczby obok kolorów (trzy kolory mają kontrast < 3:1 na jasnym tle)
    const ost = X.tygodnie.slice(-4), rok = X.tygodnie.slice(-56, -52);
    const sum = (lista, k) => lista.reduce((a, t) => a + (t.kan[k] || 0), 0);
    const tot = (lista) => KAN.reduce((a, k) => a + sum(lista, k), 0) || 1;
    $('kan-tab').innerHTML = '<tr><th>Kanał (4 pełne tygodnie)</th><th class="n">Przychód</th><th class="n">Udział</th><th class="n">rok temu</th><th class="n">r/r</th></tr>'
      + KAN.map((k, j) => `<tr><td><i class="tr-kw" style="background:var(${KOL[j]})"></i>${k}</td><td class="n">${zl(sum(ost, k))}</td><td class="n">${pct(sum(ost, k) / tot(ost) * 100)}</td><td class="n">${pct(sum(rok, k) / tot(rok) * 100)}</td><td class="n">${zmiana(sum(ost, k), sum(rok, k))}</td></tr>`).join('');
  }

  // ---------- produkty: model ----------
  const st = { okno: 30, por: 'prev', filtr: 'wszystkie', grupa: '', szukaj: '', prog: 30, baza: 5, sort: null, kier: -1 };
  let ostatniaLista = [];
  // wiersze, filtry i sortowanie — wspólne z telefonem (public/shared/trendy-model.js)
  const M = window.TrendyModel;
  const wiersze = () => M.wiersze(X, st.okno, st.por);
  const FILTRY = M.FILTRY;
  const filtruj = (lista, f) => M.filtruj(lista, f, { prog: st.prog, baza: st.baza });
  const KOLUMNY = [['', null], ['SKU / nazwa', 'sym'], ['Szt.', 'as', 1], ['Szt. przed', 'bs', 1], ['Przychód', 'n', 1], ['Przychód przed', 'bn', 1],
    ['Zmiana zł', 'dn', 1], ['Zmiana %', 'dp', 1], ['Zysk', 'z', 1], ['Zmiana zysku', 'dz', 1], ['Marża', 'm', 1], ['Dostępne', 'dost', 1], ['Zapas', 'dni', 1], ['Uwagi', null]];
  const MAX_WIERSZY = 3000;
  function rysujProd() {
    const P = X.produkty[st.okno], przed = st.por === 'prev' ? 'przed' : 'rok temu';
    const porTxt = st.por === 'prev' ? `poprzednie ${st.okno} dni (${dd(P.prevOd)}–${dd(P.prevDo)})` : `te same dni rok temu (${dd(P.rokOd)}–${dd(P.rokDo)}.${P.rokDo.slice(0, 4)})`;
    $('pr-opis').innerHTML = `${st.okno} zamkniętych dni ${dd(P.od)}–${dd(P.do)} vs ${porTxt}. Bez limitu pozycji — zawężają filtry. Klik w produkt = kanały sprzedaży.`;
    let baza = wiersze();
    if (st.grupa) baza = baza.filter((w) => w.grupa === st.grupa);
    if (st.szukaj) { const q = st.szukaj.toLowerCase(); baza = baza.filter((w) => w.sym.toLowerCase().includes(q) || w.nazwa.toLowerCase().includes(q)); }
    $('pr-filtry').innerHTML = FILTRY.map(([k, t]) => `<span class="tr-chip ${k === st.filtr ? 'wl' : ''}" data-f="${k}">${t}<span class="tr-ile">${nf0.format(filtruj(baza, k).length)}</span></span>`).join('');
    const lista = filtruj(baza, st.filtr);
    const [sk, kier] = M.sortuj(lista, st.filtr, st.sort, st.kier);
    ostatniaLista = lista;
    const suma = (f) => lista.reduce((a, w) => a + f(w), 0), sN = suma((w) => w.a.n), sB = suma((w) => w.b.n), sZ = suma((w) => w.a.z);
    const th = KOLUMNY.map(([t, k, num]) => `<th class="${num ? 'n ' : ''}${k ? 'tr-sort' : ''}" data-k="${k || ''}">${t.replace('przed', przed)}${k && k === sk ? (kier > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('');
    const uwagi = (w) => [w.dost === 0 ? '<span class="tr-znak zly">stan 0</span>' : '', w.dost > 0 && w.dni != null && w.dni < 14 ? `<span class="tr-znak uwaga">zapas ${w.dni} dni</span>` : '',
      w.nowosc ? '<span class="tr-znak dobry">nowość</span>' : '', w.zestaw ? '<span class="tr-znak">zestaw</span>' : '', w.a.z < 0 && w.a.s > 0 ? '<span class="tr-znak zly">strata</span>' : ''].join('');
    $('produkty').innerHTML = `<thead><tr>${th}</tr><tr class="tr-razem"><td></td><td><b>Razem (${nf0.format(lista.length)} poz.)</b></td><td class="n">${szt(suma((w) => w.a.s))}</td><td class="n">${szt(suma((w) => w.b.s))}</td>`
      + `<td class="n"><b>${zl(sN)}</b></td><td class="n">${zl(sB)}</td><td class="n">${zmianaZl(sN - sB)}</td><td class="n">${zmiana(sN, sB)}</td><td class="n">${zl(sZ)}</td><td class="n">${zmianaZl(suma((w) => w.dz))}</td>`
      + `<td class="n">${pct(sN ? sZ / sN * 100 : null)}</td><td></td><td></td><td></td></tr></thead><tbody>`
      + lista.slice(0, MAX_WIERSZY).map((w) => `<tr class="tr-klik" data-id="${w.id}"><td><img class="tr-min" loading="lazy" src="${ZDJ(w.id)}" alt="" onerror="this.style.visibility='hidden'"></td>
        <td><span class="tr-sym">${esc(w.sym)}</span> <span class="tr-gr">${esc(w.grupa)}</span><span class="tr-nz" title="${esc(w.nazwa)}">${esc(w.nazwa)}</span></td>
        <td class="n">${szt(w.a.s)}</td><td class="n tr-sz">${szt(w.b.s)}</td><td class="n">${zl(w.a.n)}</td><td class="n tr-sz">${zl(w.b.n)}</td>
        <td class="n">${zmianaZl(w.dn)}</td><td class="n">${w.b.n > 0 ? zmiana(w.a.n, w.b.n) : w.a.n > 0 ? '<span class="tr-up">nowy</span>' : '—'}</td>
        <td class="n">${zl(w.a.z)}</td><td class="n">${zmianaZl(w.dz)}</td><td class="n">${pct(w.a.n ? w.a.z / w.a.n * 100 : null)}</td>
        <td class="n">${w.dost == null ? '—' : szt(w.dost)}</td><td class="n">${w.dni == null ? '—' : szt(w.dni) + ' dni'}</td><td>${uwagi(w)}</td></tr>`).join('')
      + (lista.length > MAX_WIERSZY ? `<tr><td colspan="14" class="tr-sz">… i ${nf0.format(lista.length - MAX_WIERSZY)} kolejnych — zawęź filtrem, grupą albo wyszukiwaniem</td></tr>` : '') + '</tbody>';
    $('pr-def').innerHTML = `<b>Hity</b> — produkty, które razem dają połowę przychodu okna. <b>Trendujące</b> — przychód ≥ +${st.prog}% vs porównanie (albo nowy w oknie), przy bazie ≥ ${st.baza} szt. w jednym z okresów; kolejność wg zmiany w zł. <b>Spadek trendu</b> — ≤ −${st.prog}%, ta sama baza. <b>Ze stratą</b> — zysk po kosztach kanału < 0 (koszt = rozchód dostaw z GT). <b>Zgasły</b> — ≥ ${st.baza} szt. w poprzednim oknie, 0 teraz. <b>Nowości</b> — pierwsze przyjęcie w ostatnich 30 dniach. Dostępne = Razem − rezerwacje (zestaw: ze składników), zapas wg tempa 30 dni. Nagłówek kolumny = sortowanie.`;
  }

  // ---------- grupy ----------
  const stGr = { ile: 30 };
  function grupyDane() {
    const g = new Map();
    for (const w of wiersze()) {
      const x = g.get(w.grupa) || g.set(w.grupa, { grupa: w.grupa, n: 0, bn: 0, z: 0, bz: 0, s: 0, sku: 0 }).get(w.grupa);
      x.n += w.a.n; x.bn += w.b.n; x.z += w.a.z; x.bz += w.b.z; x.s += w.a.s;
      if (w.a.s > 0) x.sku++;
    }
    return [...g.values()].filter((x) => x.n > 0 || x.bn > 0).sort((a, b) => b.n - a.n);
  }
  function iskra(g) {
    const t = X.grTyg[g] || {}, v = X.tygodnie13.map((p) => t[p] || 0), max = Math.max(...v, 1), W = 96, H = 26, n = v.length;
    const pts = v.map((x, i) => [2 + i * (W - 8) / (n - 1), H - 3 - x / max * (H - 8)]);
    const k = pts[n - 1];
    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><polyline points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="var(--tr-s1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${k[0]}" cy="${k[1]}" r="3.5" fill="var(--tr-s1)" stroke="#fff" stroke-width="2"/></svg>`;
  }
  function rysujGrupy() {
    const P = X.produkty[st.okno], g = grupyDane(), suma = g.reduce((a, x) => a + x.n, 0) || 1;
    const ile = stGr.ile === 0 ? g.length : stGr.ile, top = g.slice(0, ile), reszta = g.slice(ile);
    const porTxt = st.por === 'prev' ? `poprzednie ${st.okno} dni` : 'te same dni rok temu';
    const udzialTop = top.reduce((a, x) => a + x.n, 0) / suma * 100;
    $('gr-opis').innerHTML = `${st.okno} zamkniętych dni ${dd(P.od)}–${dd(P.do)} vs ${porTxt}. ${g.length} grup ze sprzedażą; top ${Math.min(ile, g.length)} = ${pct(udzialTop)} przychodu.`;
    const wiersz = (x, i, klik = true) => `<tr class="${klik ? 'tr-klik' : ''} ${x.grupa === st.grupa ? 'tr-wybrana' : ''}" data-g="${klik ? esc(x.grupa) : ''}"><td class="n tr-sz">${i ?? ''}</td>
      <td><b>${esc(x.grupa)}</b></td>
      <td class="n"><b>${zl(x.n)}</b></td><td class="n tr-sz">${pct(x.n / suma * 100)}</td><td class="n">${zmianaZl(x.n - x.bn)}</td><td class="n">${zmiana(x.n, x.bn)}</td>
      <td class="n">${zl(x.z)}</td><td class="n">${zmianaZl(x.z - x.bz)}</td><td class="n">${pct(x.n ? x.z / x.n * 100 : null)}</td><td class="n">${szt(x.s)}</td><td class="n">${szt(x.sku)}</td><td>${klik ? iskra(x.grupa) : ''}</td></tr>`;
    const rz = reszta.reduce((a, x) => ({ ...a, n: a.n + x.n, bn: a.bn + x.bn, z: a.z + x.z, bz: a.bz + x.bz, s: a.s + x.s, sku: a.sku + x.sku }),
      { grupa: `Pozostałe grupy (${reszta.length})`, n: 0, bn: 0, z: 0, bz: 0, s: 0, sku: 0 });
    $('grupy').innerHTML = '<tr><th></th><th>Grupa</th><th class="n">Przychód</th><th class="n">Udział</th><th class="n">Zmiana zł</th><th class="n">Zmiana %</th><th class="n">Zysk</th><th class="n">Zmiana zysku</th><th class="n">Marża</th><th class="n">Szt.</th><th class="n">SKU</th><th>13 tygodni</th></tr>'
      + top.map((x, i) => wiersz(x, i + 1)).join('') + (reszta.length ? wiersz(rz, null, false) : '');
    $('pr-grupa').innerHTML = '<option value="">wszystkie grupy</option>' + g.map((x) => `<option ${x.grupa === st.grupa ? 'selected' : ''}>${esc(x.grupa)}</option>`).join('');
  }
  function syncSeg() {
    for (const [id, v] of [['pr-okno', st.okno], ['gr-okno', st.okno], ['pr-por', st.por], ['gr-por', st.por]]) $(id).querySelectorAll('button').forEach((b) => b.classList.toggle('wl', b.dataset.v === String(v)));
  }
  function wybierzGrupe(g, przewin) {
    st.grupa = g; st.filtr = 'wszystkie'; st.sort = null;
    const nag = $('pr-grupa-nag');
    if (g) {
      const x = grupyDane().find((q) => q.grupa === g);
      nag.style.display = 'block';
      nag.innerHTML = `Grupa <b>${esc(g)}</b>: przychód ${zl(x?.n)} (${zmiana(x?.n, x?.bn)}), zysk ${zl(x?.z)}, ${szt(x?.sku)} SKU ze sprzedażą <button type="button" class="tr-chip" id="tr-pr-grupa-x">× wszystkie grupy</button>`;
      $('pr-grupa-x').onclick = () => wybierzGrupe('', false);
    } else nag.style.display = 'none';
    rysujGrupy(); rysujProd();
    if (przewin) $('sek-prod').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---------- widok produktu: ceny ofert + kanały sprzedaży ----------
  // Karta to miejsce zarządzania ceną (decyzja usera 2026-10-22): „widzę, że produkt dobrze się sprzedaje, ale się
  // kończy — wchodzę i podnoszę cenę albo zmieniam repricer”. Wiersz = oferta. Dane, wysyłka ceny, okna potwierdzeń i
  // przełącznik automatu są te same co na karcie SKU w Cenach (GET /api/ceny/towar, cenyWyslijRecznaCene,
  // cenyPrzelacznikOferty w app.js), więc reguły pilnuje jeden backend (routes/ceny.js). Oznaczenia — tylko
  // podpowiedzi (TrendyModel.oznaczenia); akcje grupowe i automatyczne przyjdą później.
  function okno() {
    let t = document.getElementById('tr-tlo');
    if (!t) {
      t = document.createElement('div'); t.id = 'tr-tlo'; t.className = 'tr-tlo'; t.innerHTML = '<div class="tr-okno" id="tr-okno"></div>';
      document.body.appendChild(t);
      t.onclick = (e) => { if (e.target === t) zamknijProdukt(); };
      document.addEventListener('keydown', (e) => {
        if (t.style.display !== 'flex') return;
        if (document.querySelector('.modal-overlay:not(.hidden)')) return;          // okno potwierdzenia ceny ma własne klawisze
        if (e.key === 'Escape') zamknijProdukt();
        if (e.target.closest?.('input, select, textarea')) return;                  // strzałki w polu ceny = kursor, nie następny produkt
        if (e.key === 'ArrowRight') document.getElementById('tr-ok-dalej')?.click();
        if (e.key === 'ArrowLeft') document.getElementById('tr-ok-wstecz')?.click();
      });
    }
    return t;
  }
  function zamknijProdukt() { clearTimeout(cenyTimer); const t = document.getElementById('tr-tlo'); if (t) t.style.display = 'none'; }
  const otwarty = (id) => document.getElementById('tr-tlo')?.style.display === 'flex' && document.getElementById('tr-okno').dataset.id === String(id);

  // Wykres tygodniowy — schowany, pokazywany na życzenie; wybór pamięta przeglądarka (wygoda, nie stan).
  const WYKRES_KLUCZ = 'wms-trendy-wykres-produktu';
  const wykresWlaczony = () => { try { return localStorage.getItem(WYKRES_KLUCZ) === '1'; } catch { return false; } };
  function rysujWykresProduktu(id) {
    const host = document.getElementById('tr-ok-tyg');
    if (!host) return;
    const tw = X.tygProd[id] || Array(26).fill(0);
    const Wd = host.clientWidth || 700, H = 150, L = 34, T = 10, B = 22, n = 13, pw = Wd - L - 8, ph = H - T - B, band = pw / n, bw = Math.min(24, band * 0.6);
    const cur = tw.slice(0, 13), rok = tw.slice(13), tk = ticki(Math.max(1, ...cur, ...rok), 3), ymax = tk[tk.length - 1], y = (v) => T + ph - v / ymax * ph;
    let sv = tk.map((v) => `<line x1="${L}" x2="${Wd - 8}" y1="${y(v)}" y2="${y(v)}" stroke="${kolor('--tr-grid')}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="10" fill="${kolor('--tr-muted')}">${kompakt(v)}</text>`).join('');
    cur.forEach((v, j) => {
      sv += slupek(L + j * band + (band - bw) / 2, y(v), bw, T + ph - y(v), kolor('--tr-s1'));
      if (j % 2 === 0 || j === n - 1) sv += `<text x="${L + j * band + band / 2}" y="${H - 6}" text-anchor="middle" font-size="10" fill="${kolor('--tr-muted')}">${dd(X.tygodnie13[j])}</text>`;
    });
    sv += `<path d="${rok.map((v, j) => `${j ? 'L' : 'M'}${L + j * band + band / 2},${y(v)}`).join(' ')}" fill="none" stroke="${kolor('--tr-rok')}" stroke-width="2" stroke-linejoin="round"/>`;
    sv += `<line x1="${L}" x2="${Wd - 8}" y1="${T + ph}" y2="${T + ph}" stroke="${kolor('--tr-axis')}"/>`;
    host.innerHTML = '<div class="tr-legenda" style="margin:0 0 2px"><span><i style="background:var(--tr-s1)"></i>sztuki tygodniowo (13 pełnych tygodni)</span><span><i class="tr-linia" style="background:var(--tr-rok)"></i>rok temu</span></div>' + SVG(Wd, H, sv);
  }
  function przelaczWykres(id) {
    const host = document.getElementById('tr-ok-tyg'), pokaz = host.hidden;
    try { localStorage.setItem(WYKRES_KLUCZ, pokaz ? '1' : '0'); } catch { /* bez pamięci wyboru */ }
    host.hidden = !pokaz;
    document.getElementById('tr-ok-wykres').textContent = pokaz ? '📈 schowaj wykres' : '📈 wykres tygodniowy';
    if (pokaz) rysujWykresProduktu(id);
  }

  // Komunikat na karcie — pasek komunikatów panelu leży pod nią i nie byłoby go widać.
  function komunikatKarty(tekst, typ = 'info') {
    const k = document.getElementById('tr-ok-msg');
    if (!k) return;
    k.className = `tr-ok-msg ${typ}`; k.textContent = tekst; k.hidden = false;
  }

  // Strategie: lista do wyboru (Ceny → Strategie) — pobierana raz na kilka minut, przypisanie zmienia się rzadko.
  let strategieCache = null;
  async function listaStrategii() {
    if (strategieCache && Date.now() - strategieCache.czas < 5 * 60_000) return strategieCache.d;
    const d = await api('/api/ceny/strategie');
    strategieCache = { d, czas: Date.now() };
    return d;
  }
  async function rysujStrategie(id, w, d) {
    const box = document.getElementById('tr-ok-strat');
    if (!box) return;
    const teraz = cenyStrategiaKartyHtml(d) || '';
    let s;
    try { s = await listaStrategii(); } catch { box.innerHTML = teraz; return; }
    if (!otwarty(id)) return;
    if (!s.strategie.length) {
      box.innerHTML = `${teraz} <span class="tr-sz">· własne strategie w przygotowaniu — gdy powstaną w Ceny → Strategie, wybierzesz je tutaj</span>`;
      return;
    }
    const obecna = d.strategia?.id;
    box.innerHTML = `${teraz} <form class="tr-strat" novalidate><select name="s" class="tr-pole" aria-label="Strategia towaru">
        <option value="">— zmień strategię —</option>${s.strategie.map((x) => `<option value="${x.id}" ${x.id === obecna ? 'disabled' : ''}>${esc(x.nazwa)}${x.aktywna ? '' : ' (podgląd)'} — ${esc(x.opis)}</option>`).join('')}</select>
      <input type="date" name="do" class="tr-pole" min="${s.dzis}" title="Do dnia — wymagane dla wyprzedaży" aria-label="Do dnia">
      <button class="btn btn-small">Przypisz</button>${obecna ? ' <button type="button" class="btn btn-small" data-zdejmij>Zdejmij</button>' : ''}</form>`;
    const f = box.querySelector('form');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const st = s.strategie.find((x) => String(x.id) === f.elements.s.value);
      if (!st) { komunikatKarty('Wybierz strategię z listy.', 'blad'); return; }
      try {
        const r = await csWyslij('/api/ceny/strategie/przypisz', { strategia_id: st.id, kody: [w.sym], do: f.elements.do.value },
          { tytul: `${w.sym} → „${st.nazwa}”`, przycisk: 'Przypisz' });
        if (!r) return;
        strategieCache = null;
        komunikatKarty(r.nieznalezione?.length ? `Nie znaleziono towaru ${w.sym} w GT.` : `${w.sym}: strategia „${st.nazwa}”${st.aktywna ? ' — granice automatu zmienią się w najbliższym przebiegu' : ' (podgląd — granic jeszcze nie zmienia)'}.`, r.nieznalezione?.length ? 'blad' : 'ok');
        wczytajCeny(id, w);
      } catch (err) { komunikatKarty(err.message, 'blad'); }
    });
    box.querySelector('[data-zdejmij]')?.addEventListener('click', async () => {
      try {
        await api('/api/ceny/strategie/zdejmij', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tw_ids: [id], operator: operator() }) });
        strategieCache = null;
        komunikatKarty(`${w.sym}: strategia zdjęta — wraca domyślna (${s.domyslna.nazwa}).`, 'ok');
        wczytajCeny(id, w);
      } catch (err) { komunikatKarty(err.message, 'blad'); }
    });
  }

  const zl2 = (x) => (x == null ? '—' : `${cenyLiczba(x)} zł`);
  function konkurencjaHtml(o, wal) {
    if (o.cena == null) return '<span class="tr-sz">jeszcze nie obserwowana</span>';
    if (o.bb_nasza_inna) return '<span class="tr-sz">ma nasza inna oferta</span>';
    // Allegro: Niezbędnik (ceny konkurentów per EAN) albo raport „Czynniki Top oferty” — jak na karcie SKU w Cenach
    if (o.platforma === 'allegro') {
      const kw = o.konkurencja?.wynik;
      if (kw?.aktualny && kw.lista?.length) {
        const k = kw.lista[0];
        return o.cena <= k.cena + 0.005 ? '<span class="tr-up">najtańsi</span> <span class="tr-sz">(Niezbędnik)</span>'
          : `najtańszy konkurent <b>${cenyLiczba(k.cena)} ${wal}</b>${k.login ? ` <span class="tr-sz">${esc(k.login)}</span>` : ''}`;
      }
      if (kw?.aktualny && kw.nasze?.length) return '<span class="tr-sz">bez konkurencji (Niezbędnik)</span>';
      if (o.top?.cena != null) return `Top <b>${cenyLiczba(o.top.cena)} ${wal}</b>${o.top.aktualny ? '' : ' <span class="tr-sz">(raport stary)</span>'}`;
      if (o.top) return `<span class="tr-sz">${/odpowiedni/i.test(o.top.ocena || '') ? 'cena OK (raport Top)' : esc(o.top.ocena || 'raport Top bez oceny')}</span>`;
      return '<span class="tr-sz">nie sprawdzana</span>';
    }
    if (o.bez_konkurencji) return '<span class="tr-sz" title="Kanał nie podaje przez API cen innych sprzedawców — automat pilnuje tylko minimum">brak danych z API</span>';
    const zWys = !['emag', 'empik'].includes(o.platforma) ? ' title="z wysyłką"' : '';
    if (o.bb_nasz) return `<span class="tr-up">✓ mamy Buy Box</span>${o.najtansza_inna != null ? `<div class="tr-sz"${zWys}>następna ${cenyLiczba(o.najtansza_inna)} ${wal}</div>` : ''}`;
    if (o.bb_cena != null) return `<span${zWys}>Buy Box <b>${cenyLiczba(o.bb_cena)} ${wal}</b></span>${o.bb_fba ? ' <span class="tr-sz">FBA</span>' : ''}`;
    return o.najtansza_inna != null ? `<span${zWys}>najtańsza inna ${cenyLiczba(o.najtansza_inna)} ${wal}</span>` : '<span class="tr-sz">brak Buy Boxa</span>';
  }
  function granicaHtml(o, wal) {
    const g = o.granice || {};
    if (g.min == null) return `<span class="tr-sz">${g.gt_ok === false ? 'GT nie odpowiada' : 'brak (kalkulator nie zna rynku)'}</span>`;
    const zr = (z) => (z && z !== 'kalkulator' ? ` <span class="tr-znak uwaga">${esc(cenyZrodlo(z))}</span>` : '');
    return `${cenyLiczba(g.min)}${zr(g.zrodlo_min)} – ${cenyLiczba(g.max)}${zr(g.zrodlo_max)} ${wal}`;
  }
  function edycjaHtml(o, wal) {
    if (!o.reczna_cena) return `<span class="tr-sz">${o.tylko_odczyt ? 'tylko odczyt' : `z ekranu jeszcze niedostępne (${esc(cenyKanal(o))})`}</span>`;
    return `<form class="tr-cena" data-of="${o.id}" novalidate>
      <input name="cena" class="tr-pole" inputmode="decimal" autocomplete="off" placeholder="${o.cena != null ? cenyLiczba(o.cena) : 'cena'}" aria-label="Nowa cena ${esc(cenyKanal(o))} ${esc(o.sku)}"> ${wal}
      <span class="tr-sz" aria-hidden="true">⇄</span>
      <input name="marza" class="tr-pole tr-pole-m" inputmode="decimal" autocomplete="off" placeholder="${o.marza != null ? cenyLiczba(o.marza, 1) : 'marża'}" aria-label="Marża % ${esc(cenyKanal(o))} ${esc(o.sku)}"> %
      <button class="btn btn-small btn-primary">Wyślij…</button>
      <div class="tr-podglad tr-sz">${o.auto ? 'zmiana ręczna wyłączy automat na tej ofercie' : ''}</div></form>`;
  }

  // Tabela ofert: grupy = kolumny repricera (klucz kanału ten sam co w analizie — kluczKolumny), od największej
  // sprzedaży w oknie; sprzedaż kolumny = suma wierszy kanału (Allegro bywa rozbite na kraje).
  function cenyHtml(d, kan, ozn) {
    const sprz = new Map();
    for (const k of kan) { const x = sprz.get(k.klucz) || { s: 0, bs: 0 }; x.s += k.s; x.bs += k.bs; sprz.set(k.klucz, x); }
    const grupy = new Map();
    for (const o of d.oferty) (grupy.get(o.kolumna) || grupy.set(o.kolumna, []).get(o.kolumna)).push(o);
    const sp = (k) => sprz.get(k) || { s: 0, bs: 0 };
    const kolejne = [...grupy.entries()].sort(([a, x], [b, y]) => sp(b).s - sp(a).s || cenyKanal(x[0]).localeCompare(cenyKanal(y[0])));
    const podsw = new Set(ozn.filter((x) => x.waga === 'uwaga' && !x.produkt).flatMap((x) => x.oferty));
    const wiersze = kolejne.map(([kol, lista]) => {
      lista.sort((a, b) => (b.ilosc > 0) - (a.ilosc > 0) || b.auto - a.auto || a.id - b.id);
      const s = sp(kol);
      return lista.map((o, j) => {
        const wal = cenyWaluta(o);
        const oferta = o.linki?.produkt ? `<a href="${esc(o.linki.produkt)}" target="_blank" rel="noopener" title="Oferta na platformie">${esc(o.sku)} ↗</a>` : esc(o.sku);
        const cena = o.cena == null ? '<span class="tr-sz">—</span>'
          : `<b>${cenyLiczba(o.cena)} ${wal}</b>${o.czeka ? `<div class="tr-sz">wysłano ${esc(cenyGodzina(o.dec_czas))} — czeka na potwierdzenie</div>` : ''}${o.wysylka ? `<div class="tr-sz">+ wysyłka ${cenyLiczba(o.wysylka)}</div>` : ''}`;
        const auto = o.tylko_odczyt ? '<span class="tr-sz">tylko odczyt</span>' : o.ilosc > 0 ? `<span data-auto="${o.id}"></span>${o.wysylka_wstrzymana ? ' <span title="Automat liczy, ale wysyłka cen na ten kanał jest wstrzymana">⏸</span>' : ''}` : '<span class="tr-sz">bez stanu</span>';
        return `<tr class="${o.ilosc > 0 ? '' : 'tr-of-bez'}${podsw.has(o.id) ? ' tr-of-uwaga' : ''}">
          ${j === 0 ? `<td class="tr-kan" rowspan="${lista.length}"><b>${esc(cenyKanal(o))}</b><div>${szt(s.s)} szt.${s.bs > 0 ? ` ${zmiana(s.s, s.bs)}` : s.s > 0 ? ' <span class="tr-up">nowy</span>' : ''}</div></td>` : ''}
          <td>${oferta}<div class="tr-sz">stan ${o.ilosc}${o.auto ? '' : ' · ręczna'}</div>${o.blokada ? `<div class="tr-down" title="${esc(o.blokada)}">⚠ wstrzymana przez platformę</div>` : ''}</td>
          <td class="n">${cena}</td>
          <td>${konkurencjaHtml(o, wal)}</td>
          <td class="n ${o.zysk != null && o.zysk < 0 ? 'tr-down' : ''}">${o.marza != null ? pct(o.marza) : '—'}<div class="tr-sz">${zl2(o.zysk)}</div></td>
          <td>${auto}</td>
          <td class="n">${granicaHtml(o, wal)}</td>
          <td>${edycjaHtml(o, wal)}</td></tr>`;
      }).join('');
    }).join('');
    return `<table class="tr-tab tr-ceny"><tr><th>Kanał · sprzedaż ${st.okno} dni</th><th>Oferta</th><th class="n">Cena teraz</th><th>Konkurencja</th><th class="n">Marża · zysk/szt.</th><th>Automat</th><th class="n">Granice automatu</th><th>Nowa cena ⇄ marża</th></tr>${wiersze}</table>`;
  }

  // Pole ceny ⇄ pole marży: wpisanie jednego liczy drugie w backendzie (podgląd / cena przy marży), więc obie
  // liczby pochodzą z tego samego kalkulatora co minimum automatu. Wysyłka przez cenyWyslijRecznaCene.
  function podepnijCene(f, o, id, w) {
    const pc = f.elements.cena, pm = f.elements.marza, podglad = f.querySelector('.tr-podglad'), btn = f.querySelector('button');
    const domyslny = podglad.textContent;
    let timer = null, nr = 0, ostatnie = null;
    const zapytaj = (zrodlo, v) => api(zrodlo === 'cena'
      ? `/api/ceny/cena/podglad?${new URLSearchParams({ oferta_id: o.id, cena: v })}`
      : `/api/ceny/cena/dla-marzy?${new URLSearchParams({ oferta_id: o.id, marza: v })}`);
    const pokaz = (p) => {
      const zm = p.teraz ? ` <span class="${p.cena >= p.teraz ? 'tr-up' : 'tr-down'}">${p.cena >= p.teraz ? '+' : '−'}${nf1.format(Math.abs((p.cena / p.teraz - 1) * 100))}%</span>` : '';
      podglad.className = `tr-podglad ${p.ostrzezenia.length ? 'tr-down' : 'tr-sz'}`;
      podglad.innerHTML = `${cenyLiczba(p.cena)} ${esc(p.waluta)}${zm} · marża <b>${pct(p.marza)}</b> · zysk <b>${zl2(p.zysk)}</b>${p.ostrzezenia.length ? `<br>⚠ ${esc(p.ostrzezenia.map((x) => x.tekst).join('; '))}` : ''}`;
    };
    const licz = (zrodlo) => {
      clearTimeout(timer); ostatnie = zrodlo; nr++;
      const v = (zrodlo === 'cena' ? pc : pm).value.trim();
      (zrodlo === 'cena' ? pm : pc).value = '';
      if (!v) { podglad.className = 'tr-podglad tr-sz'; podglad.textContent = domyslny; return; }
      timer = setTimeout(async () => {
        const moj = ++nr;
        try {
          const p = await zapytaj(zrodlo, v);
          if (moj !== nr) return;
          if (zrodlo === 'cena') pm.value = p.marza != null ? String(p.marza).replace('.', ',') : '';
          else pc.value = String(p.cena).replace('.', ',');
          pokaz(p);
        } catch (e) { if (moj === nr) { podglad.className = 'tr-podglad tr-down'; podglad.textContent = e.message; } }
      }, 350);
    };
    pc.addEventListener('input', () => licz('cena'));
    pm.addEventListener('input', () => licz('marza'));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearTimeout(timer); nr++;
      btn.disabled = true;
      try {
        let cena = pc.value.trim();
        // wpisana marża, a cena jeszcze niepoliczona (Enter tuż po wpisaniu) — policz teraz, zanim cokolwiek wyślemy
        if (ostatnie === 'marza' && pm.value.trim()) cena = String((await zapytaj('marza', pm.value.trim())).cena);
        if (!cena) { komunikatKarty('Wpisz nową cenę albo marżę.', 'blad'); return; }
        if (await cenyWyslijRecznaCene(o, cena, { komunikat: komunikatKarty })) wczytajCeny(id, w);
      } catch (err) { komunikatKarty(err.message, 'blad'); }
      finally { btn.disabled = false; }
    });
  }

  let cenyTimer = null, cenyNr = 0;
  // kan — kanały produktu z bieżącego okna (sprzedaż do tabeli ofert i linki w tabeli kanałów)
  async function wczytajCeny(id, w, kan = ostatnieKanaly) {
    const moj = ++cenyNr;
    const box = document.getElementById('tr-ok-ceny');
    const pokazOznaczenia = (ozn) => {
      document.getElementById('tr-ok-ozn').innerHTML = ozn.map((x) => `<div class="tr-ozn ${x.waga}">${x.waga === 'uwaga' ? '⚠' : '•'} ${esc(x.tekst)}</div>`).join('');
    };
    let d;
    try { d = await api(`/api/ceny/towar/${id}`); } catch (e) {
      if (moj !== cenyNr || !otwarty(id)) return;
      box.innerHTML = `<p class="tr-sz">${e.status === 404 ? 'Brak ofert tego towaru w repricerze — ceny zmienisz na platformie.' : `Repricer nie odpowiada: ${esc(e.message)}`}</p>`;
      pokazOznaczenia(TrendyModel.oznaczenia(w, []));       // „kończy się” dotyczy towaru, nie ofert
      if (e.status === 404) linkiKanalow(kan, {});
      return;
    }
    if (moj !== cenyNr || !otwarty(id)) return;
    d.oferty = d.oferty.map(cenyPoWyslaniu);
    const ozn = TrendyModel.oznaczenia(w, d.oferty);
    pokazOznaczenia(ozn);
    box.innerHTML = cenyHtml(d, kan, ozn) + `<p class="tr-sz" style="margin:6px 0 0">${d.gt_ok ? `Koszt zakupu ${zl2(d.gt.koszt)} (średnia z dostaw) — marża i zysk po kosztach kanału, ten sam kalkulator co minimum automatu.` : '<span class="tr-down">Subiekt nie odpowiada — bez kosztu nie policzymy marży ani minimum.</span>'} Ręczna cena idzie od razu na platformę i wyłącza automat na tej ofercie.</p>`;
    const opcje = { komunikat: komunikatKarty, poZmianie: () => wczytajCeny(id, w) };
    box.querySelectorAll('[data-auto]').forEach((slot) => {
      const o = d.oferty.find((x) => String(x.id) === slot.dataset.auto);
      slot.appendChild(cenyPrzelacznikOferty(o, cenyKanal(o), opcje));
    });
    box.querySelectorAll('form.tr-cena').forEach((f) => podepnijCene(f, d.oferty.find((x) => String(x.id) === f.dataset.of), id, w));
    const linki = {};
    for (const o of d.oferty) if (o.linki?.produkt) (linki[o.kolumna] ||= []).push({ produkt: o.linki.produkt, oferty: o.linki.oferty || null, sku: o.sku, auto: !!o.auto });
    linkiKanalow(kan, linki);
    rysujStrategie(id, w, d);
  }
  // nazwa kanału w tabeli kanałów = link do oferty na platformie; kilka ofert w kanale — kolejne numerami
  function kanalHtml(k, ofertyKanalu) {
    if (!ofertyKanalu) return esc(k.nazwa);
    const of = ofertyKanalu[k.klucz] || [];
    if (!of.length) return `${esc(k.nazwa)} <span class="tr-sz" title="brak aktywnej oferty w repricerze">—</span>`;
    const tytul = (o) => `${esc(o.sku)}${o.auto ? ' · automat' : ''}`;
    return `<a href="${esc(of[0].produkt)}" target="_blank" rel="noopener" title="Oferta na platformie: ${tytul(of[0])}">${esc(k.nazwa)} ↗</a>`
      + (of[0].oferty ? ` · <a href="${esc(of[0].oferty)}" target="_blank" rel="noopener" title="Wszystkie oferty — kto ma Buy Box">oferty</a>` : '')
      + of.slice(1, 4).map((o, j) => ` · <a href="${esc(o.produkt)}" target="_blank" rel="noopener" title="${tytul(o)}">${j + 2}</a>`).join('');
  }
  function linkiKanalow(kan, of) {
    kan.forEach((k, j) => { const td = document.querySelector(`#tr-okno td[data-kan="${j}"]`); if (td) td.innerHTML = kanalHtml(k, of); });
  }

  let ostatnieKanaly = [];
  function otworzProdukt(id) {
    const lista = ostatniaLista, i = lista.findIndex((w) => w.id === id), w = lista[i] || wiersze().find((q) => q.id === id);
    if (!w) return;
    const P = X.produkty[st.okno], porTxt = st.por === 'prev' ? `poprzednie ${st.okno} dni` : 'rok temu', off = st.por === 'prev' ? 3 : 6;
    const kan = ((X.kanaly[st.okno] || {})[id] || []).map((k) => ({ nazwa: k[0], s: k[1], n: k[2], z: k[3], bs: k[1 + off], bn: k[2 + off], klucz: k[10] }))
      .filter((k) => k.s || k.bs).sort((a, b) => b.n - a.n || b.bn - a.bn);
    ostatnieKanaly = kan;
    const marza = (z, n) => (n ? pct(z / n * 100) : '—'), przed = st.por === 'prev' ? 'przed' : 'rok temu';
    const kafelki = [['Sztuki', szt(w.a.s), zmiana(w.a.s, w.b.s)], ['Przychód', zl(w.a.n), zmiana(w.a.n, w.b.n)], ['Zysk', zl(w.a.z), zmiana(w.a.z, w.b.z)],
      ['Marża', marza(w.a.z, w.a.n), zmiana(w.a.n ? w.a.z / w.a.n * 100 : null, w.b.n ? w.b.z / w.b.n * 100 : null, { pp: true })],
      ['Dostępne', w.dost == null ? '—' : szt(w.dost), `<span class="tr-sz">${w.zestaw ? 'kompletów ze składników' : 'Razem − rez.'}</span>`],
      ['Zapas', w.dni == null ? '—' : szt(w.dni) + ' dni', '<span class="tr-sz">tempo 30 dni</span>']];
    const t = okno(), wyk = wykresWlaczony();
    document.getElementById('tr-okno').dataset.id = String(id);
    document.getElementById('tr-okno').innerHTML = `<div class="tr-nav"><span class="tr-opis" style="margin-right:auto">${i >= 0 ? `${i + 1} z ${nf0.format(lista.length)} na liście · ← → przewijanie` : ''}</span>
        <button type="button" class="btn btn-small" id="tr-ok-wykres">${wyk ? '📈 schowaj wykres' : '📈 wykres tygodniowy'}</button>
        <button type="button" class="btn btn-small" id="tr-ok-wstecz" ${i > 0 ? '' : 'disabled'}>‹ poprzedni</button><button type="button" class="btn btn-small" id="tr-ok-dalej" ${i >= 0 && i < lista.length - 1 ? '' : 'disabled'}>następny ›</button>
        <button type="button" class="btn btn-small" id="tr-ok-x">✕ zamknij</button></div>
      <div class="tr-gora2"><img class="tr-foto" src="${ZDJ_DUZE(id)}" onerror="this.onerror=null;this.src='${ZDJ(id)}'" alt="">
        <div><h3><span class="tr-sym" style="font-size:16px">${esc(w.sym)}</span></h3><div>${esc(w.nazwa)}</div><div class="tr-gr" style="margin-top:2px">${esc(w.grupa)}</div>
          <div class="tr-opis" style="margin-top:6px">${st.okno} zamkniętych dni ${dd(P.od)}–${dd(P.do)} vs ${porTxt}</div>
          <div class="tr-statki">${kafelki.map(([a, b, c]) => `<div>${a}<b>${b}</b>${c}</div>`).join('')}</div>
          <div id="tr-ok-ozn"></div></div></div>
      <div class="tr-wykres" id="tr-ok-tyg" ${wyk ? '' : 'hidden'}></div>
      <div class="tr-ceny-nag"><h3 style="font-size:15px;margin:0">Ceny ofert</h3><div id="tr-ok-strat" class="tr-opis"></div></div>
      <div class="tr-ok-msg" id="tr-ok-msg" hidden></div>
      <div id="tr-ok-ceny"><p class="tr-sz">Wczytuję oferty z repricera…</p></div>
      <h3 style="font-size:15px;margin:16px 0 6px">Kanały sprzedaży <span class="tr-opis" style="font-weight:400">— nazwa kanału otwiera ofertę na platformie</span></h3>
      <table class="tr-tab"><tr><th>Kanał</th><th class="n">Szt.</th><th class="n">Przychód</th><th class="n">Zysk</th><th class="n">Marża</th><th class="n">Zysk na szt.</th><th class="n">Szt. ${przed}</th><th class="n">Przychód ${przed}</th><th class="n">Zmiana</th></tr>
      ${kan.map((k, j) => `<tr><td data-kan="${j}">${kanalHtml(k, null)}</td><td class="n">${szt(k.s)}</td><td class="n">${zl(k.n)}</td><td class="n">${zl(k.z)}</td><td class="n">${marza(k.z, k.n)}</td><td class="n">${k.s ? zl(k.z / k.s) : '—'}</td><td class="n tr-sz">${szt(k.bs)}</td><td class="n tr-sz">${zl(k.bn)}</td><td class="n">${k.bn > 0 ? zmiana(k.n, k.bn) : k.n > 0 ? '<span class="tr-up">nowy kanał</span>' : '<span class="tr-down">zniknął</span>'}</td></tr>`).join('')
        || '<tr><td colspan="9" class="tr-sz">Brak sprzedaży w obu okresach.</td></tr>'}
      <tr class="tr-razem"><td><b>Razem</b></td><td class="n"><b>${szt(w.a.s)}</b></td><td class="n"><b>${zl(w.a.n)}</b></td><td class="n"><b>${zl(w.a.z)}</b></td><td class="n">${marza(w.a.z, w.a.n)}</td><td class="n">${w.a.s ? zl(w.a.z / w.a.s) : '—'}</td><td class="n tr-sz">${szt(w.b.s)}</td><td class="n tr-sz">${zl(w.b.n)}</td><td class="n">${zmiana(w.a.n, w.b.n)}</td></tr></table>`;
    t.style.display = 'flex';
    if (wyk) rysujWykresProduktu(id);
    document.getElementById('tr-ok-wykres').onclick = () => przelaczWykres(id);
    document.getElementById('tr-ok-x').onclick = zamknijProdukt;
    // Repricer pyta GT o koszt — przy szybkim przewijaniu strzałkami nie pytamy o każdy mijany produkt.
    cenyNr++;
    clearTimeout(cenyTimer);
    cenyTimer = setTimeout(() => wczytajCeny(id, w, kan), 250);
    if (i > 0) document.getElementById('tr-ok-wstecz').onclick = () => otworzProdukt(lista[i - 1].id);
    if (i >= 0 && i < lista.length - 1) document.getElementById('tr-ok-dalej').onclick = () => otworzProdukt(lista[i + 1].id);
  }

  // ---------- spięcie ----------
  function podepnij() {
    seg($('tyg-miara'), MIARY, stTyg.miara, (v) => { stTyg.miara = v; rysujTyg(); });
    seg($('tyg-zakres'), [[13, '13 tyg.'], [26, '26 tyg.'], [52, '52 tyg.'], [104, '2 lata']], stTyg.ile, (v) => { stTyg.ile = +v; rysujTyg(); });
    seg($('mies-miara'), [['netto', 'Przychód'], ['zysk', 'Zysk']], stMies.miara, (v) => { stMies.miara = v; rysujMies(); });
    const okna = [[7, '7 dni'], [30, '30 dni']], por = (krotko) => [['prev', krotko ? 'vs poprzedni' : 'vs poprzedni okres'], ['rok', 'vs rok temu']];
    seg($('gr-okno'), okna, st.okno, (v) => { st.okno = +v; rysujGrupy(); rysujProd(); syncSeg(); });
    seg($('gr-por'), por(true), st.por, (v) => { st.por = v; rysujGrupy(); rysujProd(); syncSeg(); });
    seg($('gr-ile'), [[30, 'top 30'], [0, 'wszystkie']], stGr.ile, (v) => { stGr.ile = +v; rysujGrupy(); });
    seg($('pr-okno'), okna, st.okno, (v) => { st.okno = +v; rysujProd(); rysujGrupy(); syncSeg(); });
    seg($('pr-por'), por(false), st.por, (v) => { st.por = v; rysujProd(); rysujGrupy(); syncSeg(); });
    $('pr-prog').oninput = (e) => { st.prog = +e.target.value || 30; rysujProd(); };
    $('pr-baza').oninput = (e) => { st.baza = +e.target.value || 1; rysujProd(); };
    $('pr-szukaj').oninput = (e) => { st.szukaj = e.target.value.trim(); rysujProd(); };
    $('pr-grupa').onchange = (e) => wybierzGrupe(e.target.value, false);
    $('pr-filtry').onclick = (e) => { const c = e.target.closest('.tr-chip'); if (!c) return; st.filtr = c.dataset.f; st.sort = null; rysujProd(); };
    $('produkty').onclick = (e) => {
      const tr = e.target.closest('tr.tr-klik'); if (tr) { otworzProdukt(+tr.dataset.id); return; }
      const t = e.target.closest('th.tr-sort'); if (!t) return;
      const k = t.dataset.k;
      if (st.sort === k) st.kier = -st.kier; else { st.sort = k; st.kier = k === 'sym' ? 1 : -1; }
      rysujProd();
    };
    $('grupy').onclick = (e) => { const tr = e.target.closest('tr.tr-klik'); if (tr?.dataset.g) wybierzGrupe(tr.dataset.g, true); };
    let tm;
    window.addEventListener('resize', () => { clearTimeout(tm); tm = setTimeout(() => { if (X && !document.getElementById('panel-sprzedaz-trendy').classList.contains('hidden')) { rysujTyg(); rysujMies(); rysujKan(); } }, 150); });
  }

  async function odswiezSprzedazTrendy() {
    const tresc = document.getElementById('tr-tresc');
    if (!tresc.dataset.gotowe) { tresc.innerHTML = SZKIELET; tresc.dataset.gotowe = '1'; podepnij(); }
    const blad = document.getElementById('tr-blad');
    blad.classList.add('hidden');
    if (ladowanie) return ladowanie;
    document.getElementById('tr-wczytanie').textContent = 'Liczę…';
    ladowanie = (async () => {
      try {
        X = await api('/api/analiza/trendy');
        rysujKafle(); rysujTyg(); rysujMies(); rysujKan(); rysujGrupy(); rysujProd();
        document.getElementById('tr-wczytanie').textContent = `policzone ${new Date(X.wygenerowano).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}`;
      } catch (e) {
        blad.textContent = e.message; blad.classList.remove('hidden');
        document.getElementById('tr-wczytanie').textContent = '';
      } finally { ladowanie = null; }
    })();
    return ladowanie;
  }
  window.odswiezSprzedazTrendy = odswiezSprzedazTrendy;
})();
