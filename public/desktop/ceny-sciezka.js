'use strict';

// Ekran Ceny → „Ścieżka”: każdy towar ze stanem na K4/K4G w jednym wierszu z krokami wystawienia
// (1 Subiekt → 2 Sklep → 3 Allegro → 4 Rynki) i tym, czego brakuje. Dane liczy wątek services/sciezka-wystawienia.js
// (logika: services/sciezka-wystawienia-model.js), API podaje gotowy JSON: GET /api/ceny/sciezka.
// Ekran tylko pokazuje i prowadzi do miejsc, gdzie się coś robi (panel sklepu, Allegro, „Do wystawienia”); jedyny
// zapis to odhaczenie „karta w sklepie założona” (POST /api/ceny/sciezka/karta) — informacja, od której nic nie zależy.
// Plik ładuje się PRZED app.js i używa jego funkcji (el, api, cenyEsc, cenyLiczba, operator, formatDatetime,
// pokazKomunikat, cenyPokazWidok) dopiero w chwili wywołania; app.js woła odswiezCenySciezka() z odswiezCeny().

let scDane = null, scNr = 0, scEdytowana = null, scEtap = 'wszystkie', scPod = '', scSzukaj = '', scGrupa = '', scMinStan = 1, scLimit = 200;
const scKarty = new Map();   // tw_id → odhaczenie (na żywo z serwera + świeże kliknięcia)

const SC_SKLEP = 'https://poszukiwaczefrajdy.pl';
const SC_NAZWY_RYNKOW = { emag: 'eMAG', empik: 'Empik', kaufland: 'Kaufland', amazon: 'Amazon' };
const SC_KONTA = { EKAJTEK: 'ekajtek', NATROPIE: 'NaTropie' };
// Stan rynku → wygląd. Brak wpisu = nie sprawdzono (wątek pomija takie komórki).
const SC_RYNEK = {
  oferta: { znak: '✓', klasa: 'sc-ok', opis: 'mamy ofertę' },
  w_toku: { znak: '⏳', klasa: 'sc-czeka', opis: 'wysłana, czeka na synchronizację' },
  nieaktywna: { znak: '○', klasa: 'sc-szary', opis: 'oferta była, dziś nieaktywna (np. stan 0)' },
  mozna: { znak: '→', klasa: 'sc-mozna', opis: 'można wystawić — kliknij, żeby przejść do „Do wystawienia”' },
  czeka_na_dane: { znak: '·', klasa: 'sc-szary', opis: 'karta na rynku jest, ale brakuje danych w Subiekcie' },
  brak_karty: { znak: '—', klasa: 'sc-szary', opis: 'brak karty produktu na rynku' },
  zablokowane: { znak: '⛔', klasa: 'sc-zle', opis: 'platforma nie pozwala' },
  odrzucone: { znak: '✗', klasa: 'sc-zle', opis: 'ostatnia próba odrzucona' },
  nie_sprawdzono: { znak: '?', klasa: 'sc-szary', opis: 'katalog jeszcze nie sprawdził tego towaru' },
};
const SC_BRAKI = { flaga: 'flaga sklepu', cena: 'cena Specjalna', ean: 'EAN', waga: 'waga', wymiary: 'wymiary' };
const SC_SKLEP_STATUS = { brak: 'brak karty', czeka_na_base: 'czeka na Base', nieznany: 'nie wiadomo' };

async function odswiezCenySciezka({ przelicz = false } = {}) {
  const nr = ++scNr;
  if (!scDane) el('sc-lista').innerHTML = '<p class="hint">Wczytuję ścieżkę…</p>';
  try {
    if (przelicz) {
      await api('/api/ceny/sciezka/odswiez', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      pokazKomunikat('Przeliczam ścieżkę (Subiekt + feed sklepu) — odświeżę widok za ~30 s', 'info');
      setTimeout(() => { if (cenyWidok === 'sciezka') odswiezCenySciezka(); }, 30 * 1000);
    }
    const d = await api('/api/ceny/sciezka');
    if (nr !== scNr) return;
    if (d.brak) { el('sc-lista').innerHTML = '<p class="hint">Ścieżka liczy się po raz pierwszy (ok. 2 min po starcie WMS). Odśwież za chwilę.</p>'; el('sc-pasek').innerHTML = ''; return; }
    scDane = d.snapshot;
    scKarty.clear();
    for (const k of d.karty || []) scKarty.set(k.tw_id, k);
    scRenderuj();
  } catch (err) {
    if (nr !== scNr) return;
    if (err.status === 404) { el('sc-lista').innerHTML = '<p class="hint">Ścieżka będzie dostępna po restarcie WMS (nowa trasa /api/ceny/sciezka).</p>'; return; }
    el('sc-lista').innerHTML = `<p class="hint">${cenyEsc(err.message)}</p>`;
  }
}

// Krok „Sklep” z uwzględnieniem odhaczeń zrobionych po przeliczeniu (wątek przelicza je w ≤ 15 s, ale ekran ma
// pokazać kliknięcie od razu). Karta w feedzie (Base powiązał) zawsze wygrywa z odhaczeniem.
function scSklep(t) {
  const s = t.kroki.sklep;
  if (s.status === 'jest' || (s.status === 'czeka_na_base' && s.powod)) return s;
  const k = scKarty.get(t.tw_id);
  if (k) return { status: 'czeka_na_base', karta_id: k.karta_id, odhaczono: k.czas, kto: k.kto };
  return s.status === 'czeka_na_base' ? { status: 'brak' } : s;   // odhaczenie cofnięte po przeliczeniu
}
function scEtapTowaru(t) {
  if (!t.kroki.gt.ok) return 'gt';
  if (scSklep(t).status !== 'jest') return 'sklep';
  if (!t.kroki.allegro.ok) return 'allegro';
  if (!t.kroki.rynki.ok) return 'rynki';
  return 'gotowe';
}

function scWidoczne() {
  const q = scSzukaj.trim().toUpperCase();
  return scDane.towary.filter((t) => {
    if (t.stan < scMinStan) return false;
    if (scGrupa && t.grupa !== scGrupa) return false;
    if (q && ![t.symbol, t.ean, t.nazwa, t.grupa].some((v) => String(v || '').toUpperCase().includes(q))) return false;
    const etap = scEtapTowaru(t);
    if (scEtap !== 'wszystkie' && etap !== scEtap) return false;
    if (scPod && scEtap === 'gt' && !t.kroki.gt.braki.some((b) => b.pole === scPod)) return false;
    if (scPod && scEtap === 'sklep' && scSklep(t).status !== scPod) return false;
    return true;
  }).sort((a, b) => (b.stan - a.stan) || String(a.symbol).localeCompare(String(b.symbol)));
}

function scRenderuj() {
  const d = scDane;
  const etapy = { wszystkie: 0, gt: 0, sklep: 0, allegro: 0, rynki: 0, gotowe: 0 };
  const grupy = new Set();
  for (const t of d.towary) {
    if (t.grupa) grupy.add(t.grupa);
    if (t.stan < scMinStan) continue;
    etapy.wszystkie++;
    etapy[scEtapTowaru(t)]++;
  }
  const nazwyEtapow = { wszystkie: 'Wszystkie', ...Object.fromEntries(d.kroki.map((k, i) => [k.klucz, `${i + 1}. ${k.nazwa}`])), gotowe: '✓ Gotowe' };
  const opisy = Object.fromEntries(d.kroki.map((k) => [k.klucz, `Utknęło na kroku: ${k.opis}`]));
  const feed = d.feed.kart != null
    ? `feed sklepu: ${d.feed.kart} kart${d.feed.ok ? '' : ` <b class="cw-blokada">— nie wczytał się (${cenyEsc(d.feed.blad)}), dane z ${cenyEsc(formatDatetime(d.feed.czas))}</b>`}`
    : `<b class="cw-blokada">feed sklepu niedostępny (${cenyEsc(d.feed.blad)}) — krok „Sklep” nieznany</b>`;
  el('sc-pasek').innerHTML = `
    <div class="ceny-rzad">${Object.entries(nazwyEtapow).map(([k, n]) => `<button type="button" class="ceny-chip ${k === scEtap ? 'aktywny' : ''}" data-sc-etap="${k}"
      title="${cenyEsc(opisy[k] || '')}">${cenyEsc(n)} <b>${etapy[k]}</b></button>`).join('')}</div>
    ${scPodfiltry()}
    <div class="ceny-rzad">
      <input type="search" id="sc-szukaj" placeholder="Szukaj SKU, EAN, nazwy, grupy…" value="${cenyEsc(scSzukaj)}" autocomplete="off">
      <select id="sc-grupa"><option value="">wszystkie grupy</option>${[...grupy].sort((a, b) => a.localeCompare(b, 'pl'))
        .map((g) => `<option ${g === scGrupa ? 'selected' : ''}>${cenyEsc(g)}</option>`).join('')}</select>
      <label class="cw-auto-inline" title="Stan dostępny na K4+K4G (stan − rezerwacje)">stan ≥ <input type="number" id="sc-min" min="1" step="1" value="${scMinStan}" style="width:4em"> szt.</label>
      <button type="button" class="btn btn-small" id="sc-odswiez" title="Policz od nowa: Subiekt, feed sklepu, oferty">↻ Przelicz</button>
    </div>
    <p class="hint">Policzone ${cenyEsc(formatDatetime(d.obliczono))} (${(d.ms / 1000).toFixed(1)} s) · ${feed} · oferty i katalogi z repricera (Allegro i rynki).</p>`;
  el('sc-pasek').querySelectorAll('[data-sc-etap]').forEach((b) => b.addEventListener('click', () => { scEtap = b.dataset.scEtap; scPod = ''; scLimit = 200; scRenderuj(); }));
  el('sc-pasek').querySelectorAll('[data-sc-pod]').forEach((b) => b.addEventListener('click', () => { scPod = scPod === b.dataset.scPod ? '' : b.dataset.scPod; scRenderuj(); }));
  el('sc-szukaj').addEventListener('input', (e) => { scSzukaj = e.target.value; scLimit = 200; scRenderujListe(); });
  el('sc-grupa').addEventListener('change', (e) => { scGrupa = e.target.value; scLimit = 200; scRenderuj(); });
  el('sc-min').addEventListener('change', (e) => { scMinStan = Math.max(1, Math.floor(Number(e.target.value)) || 1); scRenderuj(); });
  el('sc-odswiez').addEventListener('click', () => odswiezCenySciezka({ przelicz: true }));
  scRenderujListe();
}

// Drugi rząd filtrów dla kroków, w których „czego brakuje” ma kilka odmian.
function scPodfiltry() {
  const w = scDane.towary.filter((t) => t.stan >= scMinStan && scEtapTowaru(t) === scEtap);
  let opcje = [];
  if (scEtap === 'gt') opcje = Object.entries(SC_BRAKI).map(([k, n]) => [k, `brak: ${n}`, w.filter((t) => t.kroki.gt.braki.some((b) => b.pole === k)).length]);
  if (scEtap === 'sklep') opcje = Object.entries(SC_SKLEP_STATUS).map(([k, n]) => [k, n, w.filter((t) => scSklep(t).status === k).length]);
  opcje = opcje.filter((o) => o[2]);
  if (!opcje.length) return '';
  return `<div class="ceny-rzad"><span class="hint">Pokaż tylko:</span>${opcje.map(([k, n, ile]) =>
    `<button type="button" class="ceny-chip ${k === scPod ? 'aktywny' : ''}" data-sc-pod="${k}">${cenyEsc(n)} <b>${ile}</b></button>`).join('')}</div>`;
}

function scRenderujListe() {
  const lista = scWidoczne();
  if (!lista.length) { el('sc-lista').innerHTML = '<p class="hint">Nic na tym etapie.</p>'; return; }
  const pokazane = lista.slice(0, scLimit);
  const wiersz = (t) => {
    const etap = scEtapTowaru(t);
    const kl = (k) => `sc-krok ${k === etap ? 'sc-tu' : ''}`;
    return `<tr>
      <td><b>${cenyEsc(t.symbol)}</b>${t.zestaw ? ' <span class="cs-sz" title="Zestaw (rodzaj 8)">zestaw</span>' : ''}<div class="cs-sz">${cenyEsc(t.ean || 'bez EAN')}</div></td>
      <td>${cenyEsc(t.nazwa)}<div class="cs-sz">${cenyEsc(t.grupa)}</div></td>
      <td class="num">${t.stan}</td>
      <td class="${kl('gt')}">${scKomorkaGt(t)}</td>
      <td class="${kl('sklep')}">${scKomorkaSklep(t)}</td>
      <td class="${kl('allegro')}">${scKomorkaAllegro(t)}</td>
      <td class="${kl('rynki')}">${scKomorkaRynki(t)}</td>
    </tr>`;
  };
  el('sc-lista').innerHTML = `<div class="tabela-wrapper"><table class="tabela cs-tabela sc-tabela">
    <thead><tr><th>SKU / EAN</th><th>Nazwa / grupa</th><th title="Dostępne na K4+K4G">Stan</th>
      <th>1. Subiekt</th><th>2. Sklep</th><th>3. Allegro</th><th>4. Rynki</th></tr></thead>
    <tbody>${pokazane.map(wiersz).join('')}</tbody></table></div>
    ${lista.length > pokazane.length ? `<p><button type="button" class="btn btn-small" id="sc-wiecej">Pokaż więcej (${pokazane.length} z ${lista.length})</button></p>` : `<p class="hint">${lista.length} towarów</p>`}`;
  el('sc-wiecej')?.addEventListener('click', () => { scLimit += 300; scRenderujListe(); });
  el('sc-lista').querySelectorAll('[data-sc-odhacz]').forEach((b) => b.addEventListener('click', () => { scEdytowana = Number(b.dataset.scOdhacz); scRenderujListe(); el('sc-nr-karty')?.focus(); }));
  el('sc-lista').querySelectorAll('[data-sc-anuluj]').forEach((b) => b.addEventListener('click', () => { scEdytowana = null; scRenderujListe(); }));
  el('sc-lista').querySelectorAll('[data-sc-zapisz]').forEach((b) => b.addEventListener('click', () => scOdhacz(Number(b.dataset.scZapisz), true, el('sc-nr-karty')?.value)));
  el('sc-nr-karty')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') scOdhacz(scEdytowana, true, e.target.value);
    if (e.key === 'Escape') { scEdytowana = null; scRenderujListe(); }
  });
  el('sc-lista').querySelectorAll('[data-sc-cofnij]').forEach((b) => b.addEventListener('click', () => scOdhacz(Number(b.dataset.scCofnij), false)));
  el('sc-lista').querySelectorAll('[data-sc-rynek]').forEach((b) => b.addEventListener('click', () => scDoWystawienia(b.dataset.scRynek, b.dataset.scSymbol)));
}

function scKomorkaGt(t) {
  const g = t.kroki.gt;
  if (g.ok) return '<span class="sc-ok">✓</span>';
  return g.braki.map((b) => `<div class="cw-uzupelnij" title="${cenyEsc(b.tekst)}">✗ ${cenyEsc(SC_BRAKI[b.pole] || b.pole)}</div>`).join('');
}

function scKomorkaSklep(t) {
  const s = scSklep(t);
  const link = s.link ? `<a href="${cenyEsc(s.link)}" target="_blank" rel="noopener" title="Karta w sklepie">↗</a>` : '';
  const panel = s.karta_id ? `<a href="${SC_SKLEP}/admin/Product/update/${s.karta_id}" target="_blank" rel="noopener" title="Edycja w panelu sklepu">#${s.karta_id}</a>` : '';
  if (s.status === 'jest') {
    return `<span class="sc-ok">✓</span> ${panel} ${link}<div class="cs-sz">${cenyLiczba(s.cena)} zł${s.duplikaty > 1 ? ` · <b class="cw-blokada" title="Ten sam kod na kilku kartach psuje synchronizację">${s.duplikaty} karty z tym kodem</b>` : ''}</div>`;
  }
  if (s.status === 'czeka_na_base') {
    const kto = s.odhaczono ? `odhaczone ${formatDatetime(s.odhaczono)}${s.kto ? ` · ${s.kto}` : ''}` : (s.powod || '');
    return `<span class="sc-czeka" title="Karta założona; cenę i stan da jej BaseLinker po powiązaniu">⏳ czeka na Base</span> ${panel}
      <div class="cs-sz">${cenyEsc(kto)}${s.odhaczono ? ` <button type="button" class="sc-link" data-sc-cofnij="${t.tw_id}" title="Cofnij odhaczenie">cofnij</button>` : ''}</div>`;
  }
  if (s.status === 'nieznany') return `<span class="sc-szary" title="${cenyEsc(s.powod)}">?</span>`;
  const blok = t.kroki.gt.braki.some((b) => b.pole === 'flaga' || b.pole === 'cena');
  return `<span class="sc-szary">brak</span>
    ${blok ? '<div class="cs-sz" title="Najpierw flaga i cena Specjalna w Subiekcie — bez nich karta nie dostanie stanu">po kroku 1</div>'
      : scEdytowana === t.tw_id
        ? `<div class="sc-odhacz"><input type="text" inputmode="numeric" id="sc-nr-karty" placeholder="nr karty" title="Numer karty w panelu sklepu (np. 38249) — można zostawić puste">
           <button type="button" class="btn btn-small" data-sc-zapisz="${t.tw_id}">OK</button><button type="button" class="sc-link" data-sc-anuluj>anuluj</button></div>`
        : `<div><a href="${SC_SKLEP}/admin/Product/Add" target="_blank" rel="noopener" class="sc-link">dodaj ↗</a>
         <button type="button" class="sc-link" data-sc-odhacz="${t.tw_id}" title="Kartę już założono — czeka na powiązanie w BaseLinkerze">założona ✓</button></div>`}`;
}

function scKomorkaAllegro(t) {
  return Object.entries(t.kroki.allegro.konta).map(([konto, k]) => {
    const n = SC_KONTA[konto] || konto;
    const oferta = k.oferta ? `<a href="https://allegro.pl/oferta/${encodeURIComponent(k.oferta)}" target="_blank" rel="noopener">↗</a>` : '';
    if (k.status === 'aktywna') return `<div><span class="sc-ok">✓</span> ${n} ${oferta}${k.cena ? ` <span class="cs-sz">${cenyLiczba(k.cena)}</span>` : ''}</div>`;
    if (k.status === 'nieaktywna') return `<div class="sc-szary" title="Oferta była — dziś nie ma jej wśród aktywnych">○ ${n} zakończona ${oferta}</div>`;
    return `<div class="sc-szary">— ${n}</div>`;
  }).join('');
}

// Rynki: Amazon (6 krajów) zbity w jedną pozycję z liczbą ofert, reszta osobno.
function scKomorkaRynki(t) {
  const r = t.kroki.rynki.rynki;
  const stan = (k) => r[k] || { status: 'nie_sprawdzono' };
  const pojedyncze = scDane.rynki.filter((x) => x.platforma !== 'amazon').map((x) => {
    const s = stan(x.klucz), w = SC_RYNEK[s.status] || SC_RYNEK.nie_sprawdzono;
    const tytul = `${SC_NAZWY_RYNKOW[x.platforma]} ${x.rynek}: ${w.opis}${s.powod ? ` — ${s.powod}` : ''}`;
    const tekst = `${w.znak} ${SC_NAZWY_RYNKOW[x.platforma]}${x.platforma === 'empik' ? '' : ` ${x.rynek}`}`;
    return s.status === 'mozna'
      ? `<button type="button" class="sc-rynek ${w.klasa}" data-sc-rynek="${x.klucz}" data-sc-symbol="${cenyEsc(t.symbol)}" title="${cenyEsc(tytul)}">${tekst}</button>`
      : `<span class="sc-rynek ${w.klasa}" title="${cenyEsc(tytul)}">${tekst}</span>`;
  });
  const amazon = scDane.rynki.filter((x) => x.platforma === 'amazon');
  const ileA = (st) => amazon.filter((x) => stan(x.klucz).status === st);
  const ofertyA = ileA('oferta').length, moznaA = ileA('mozna');
  const tytulA = amazon.map((x) => { const s = stan(x.klucz); return `${x.rynek}: ${(SC_RYNEK[s.status] || SC_RYNEK.nie_sprawdzono).opis}${s.powod ? ` — ${s.powod}` : ''}`; }).join('\n');
  const klasaA = moznaA.length ? 'sc-mozna' : ofertyA ? 'sc-ok' : 'sc-szary';
  const tekstA = `Amazon ${ofertyA ? `✓${ofertyA}` : ''}${moznaA.length ? ` →${moznaA.length}` : ''}${!ofertyA && !moznaA.length ? '—' : ''}`;
  const amazonHtml = moznaA.length
    ? `<button type="button" class="sc-rynek ${klasaA}" data-sc-rynek="${moznaA[0].klucz}" data-sc-symbol="${cenyEsc(t.symbol)}" title="${cenyEsc(tytulA)}">${tekstA}</button>`
    : `<span class="sc-rynek ${klasaA}" title="${cenyEsc(tytulA)}">${tekstA}</span>`;
  return `<div class="sc-rynki">${[...pojedyncze, amazonHtml].join('')}</div>`;
}

// Skrót do „Do wystawienia”: ten rynek, wyszukany towar, bez progu stanu (towar ze ścieżki może mieć 1–3 szt.).
function scDoWystawienia(rynek, symbol) {
  cwRynek = rynek;
  cwSzukaj = symbol;
  cwMinStan = 1;
  cwTylkoGotowe = false;
  cenyPokazWidok('wystawianie');
  odswiezCenyWystawianie();
}

// Odhaczenie „karta w sklepie założona” (numer karty opcjonalny) albo jego cofnięcie.
async function scOdhacz(twId, odhaczone, karta = null) {
  const t = scDane.towary.find((x) => x.tw_id === twId);
  try {
    const r = await api('/api/ceny/sciezka/karta', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tw_id: twId, symbol: t?.symbol, karta_id: karta, odhaczone, operator: operator() }) });
    if (odhaczone) scKarty.set(twId, { tw_id: twId, karta_id: r.karta_id, kto: operator(), czas: new Date().toISOString().replace('T', ' ').slice(0, 19) });
    else scKarty.delete(twId);
    scEdytowana = null;
    scRenderuj();
  } catch (err) { pokazKomunikat(err.message, 'blad'); }
}
