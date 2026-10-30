'use strict';

// Ekran Ceny → „Do wystawienia”: towary ze stanem, które na rynku mają kartę produktu, a nie mają naszej oferty.
// Backend: routes/ceny-wystawianie.js (pozycje liczone od nowa na serwerze, blokady i potwierdzenia), logika:
// pricing/wystawianie-model.js. Wystawiona oferta jest poza Sellasist — historia niżej pokazuje, co czeka na podpięcie.
// Plik ładuje się PRZED app.js i używa jego funkcji (el, api, cenyEsc, cenyLiczba, cenyOknoPotwierdzenia, operator,
// formatDatetime, pokazKomunikat) dopiero w chwili wywołania; app.js woła odswiezCenyWystawianie() z odswiezCeny().

let cwDane = null, cwHistoria = [], cwNr = 0, cwRynek = 'emag:RO', cwSzukaj = '', cwSort = 'stan', cwTylkoGotowe = false;
const cwZaznaczone = new Set();          // klucze pozycji (tw_id|platforma|rynek)
const cwCeny = new Map();                // klucz → cena wpisana ręcznie
const CW_SORT = {
  stan: { nazwa: 'Stan', f: (a, b) => (b.stan || 0) - (a.stan || 0) },
  zysk: { nazwa: 'Zysk/szt.', f: (a, b) => (b.zysk ?? -1e9) - (a.zysk ?? -1e9) },
  marza: { nazwa: 'Marża', f: (a, b) => (b.marza ?? -1e9) - (a.marza ?? -1e9) },
  nazwa: { nazwa: 'Nazwa', f: (a, b) => String(a.nazwa).localeCompare(String(b.nazwa), 'pl') },
};
const CW_STATUS = {
  wyslane: { nazwa: 'Wysłane — czeka na sync', klasa: 'podglad' }, widoczna: { nazwa: 'Na platformie', klasa: 'aktywna' },
  odrzucone: { nazwa: 'Odrzucone', klasa: 'blad' }, blad: { nazwa: 'Sprawdź w panelu', klasa: 'blad' },
};
const cwLinkProduktu = (x) => (x.platforma === 'emag' && x.produkt_id
  ? `https://www.emag.${x.rynek.toLowerCase()}/-/pd/${encodeURIComponent(x.produkt_id)}/`
  : x.platforma === 'amazon' && x.produkt_id ? `https://www.amazon.${{ DE: 'de', FR: 'fr', IT: 'it', ES: 'es', NL: 'nl', PL: 'pl' }[x.rynek] || 'de'}/dp/${encodeURIComponent(x.produkt_id)}`
    : x.platforma === 'kaufland' && x.produkt_id ? `https://www.kaufland.de/product/${encodeURIComponent(x.produkt_id)}/`
    : x.platforma === 'empik' && /^\d+$/.test(x.produkt_id || '') ? `https://www.empik.com/-,p${x.produkt_id},zabawki-p` : null);

async function odswiezCenyWystawianie({ odswiez = false } = {}) {
  const nr = ++cwNr;
  el('cw-lista').innerHTML = cwDane ? el('cw-lista').innerHTML : '<p class="hint">Liczę ceny i stany z Subiekta…</p>';
  try {
    const [d, h] = await Promise.all([
      api(`/api/ceny/wystawianie${odswiez ? '?odswiez=1' : ''}`),
      api('/api/ceny/wystawianie/historia'),
    ]);
    if (nr !== cwNr) return;
    cwDane = d;
    cwHistoria = h.wystawienia || [];
    const gotowe = new Set(d.rynki.filter((r) => r.gotowe).map((r) => r.klucz));
    el('ceny-l-wystawianie').textContent = d.pozycje.filter((x) => gotowe.has(`${x.platforma}:${x.rynek}`)).length || '';
    cwRenderuj();
  } catch (err) {
    if (nr !== cwNr) return;
    if (err.status === 404) { el('cw-lista').innerHTML = '<p class="hint">Wystawianie będzie dostępne po restarcie WMS (nowa trasa /api/ceny/wystawianie).</p>'; return; }
    el('cw-lista').innerHTML = `<p class="hint">${cenyEsc(err.message)}</p>`;
  }
}

// POST z potwierdzeniem: 409 z `potwierdzenie` → okno z ostrzeżeniami → ten sam POST z potwierdz: true.
async function cwWyslij(url, body, { tytul, przycisk, tresc = '' }) {
  const wyslij = (potwierdz) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, operator: operator(), ...(potwierdz ? { potwierdz: true } : {}) }) });
  try {
    return await wyslij(false);
  } catch (err) {
    if (err.status !== 409 || !err.dane?.potwierdzenie) throw err;
    const ok = await cenyOknoPotwierdzenia({ tytul, tresc, ostrzezenia: err.dane.ostrzezenia || [], przycisk, szeroki: true });
    return ok ? wyslij(true) : null;
  }
}

function cwWidoczne() {
  const q = cwSzukaj.trim().toUpperCase();
  return cwDane.pozycje
    .filter((x) => `${x.platforma}:${x.rynek}` === cwRynek)
    .filter((x) => !cwTylkoGotowe || !x.zablokowana)
    .filter((x) => !q || [x.sku, x.ean, x.nazwa, x.marka].some((v) => String(v || '').toUpperCase().includes(q)))
    .sort(CW_SORT[cwSort].f);
}

function cwRenderuj() {
  const d = cwDane;
  const rynek = d.rynki.find((r) => r.klucz === cwRynek) || d.rynki[0];
  const skan = d.skan ? `katalogi sprawdzone ${formatDatetime(d.skan.czas)} (${d.skan.towary} towarów)` : 'katalogi jeszcze nie skanowane — pierwszy skan w nocy';
  el('cw-pasek').innerHTML = `
    <div class="ceny-rzad">${d.rynki.map((r) => `<button type="button" class="ceny-chip ${r.klucz === cwRynek ? 'aktywny' : ''}" data-cw-rynek="${r.klucz}"
        title="${cenyEsc(r.gotowe ? 'Wystawianie włączone' : r.powod)} — ${r.gotowych} gotowych do wystawienia z ${r.n} kandydatów">${cenyEsc(r.nazwa)} <b>${r.gotowych}</b>${r.n > r.gotowych ? `<span class="cs-sz">/${r.n}</span>` : ''}${r.gotowe ? '' : ' 🔒'}</button>`).join('')}</div>
    <div class="ceny-rzad">
      <input type="search" id="cw-szukaj" placeholder="Szukaj SKU, EAN, nazwy, marki…" value="${cenyEsc(cwSzukaj)}" autocomplete="off">
      <span class="hint">Sortuj:</span>${Object.entries(CW_SORT).map(([k, s]) => `<button type="button" class="ceny-chip ${k === cwSort ? 'aktywny' : ''}" data-cw-sort="${k}">${s.nazwa}</button>`).join('')}
      <label class="cw-auto-inline" title="Ukryj pozycje z danymi do uzupełnienia albo blokadą"><input type="checkbox" id="cw-tylko-gotowe" ${cwTylkoGotowe ? 'checked' : ''}> tylko gotowe</label>
      <button type="button" class="btn btn-small" id="cw-odswiez" title="Policz od nowa ceny i stany (Subiekt)">↻ Odśwież</button>
      <button type="button" class="btn btn-small btn-primary" id="cw-wystaw" ${rynek?.gotowe ? '' : 'disabled'}>Wystaw zaznaczone (${cwZaznaczone.size})</button>
    </div>
    <p class="hint">${cenyEsc(skan)}${rynek && !rynek.gotowe ? ` · <b>${cenyEsc(rynek.powod)}</b> — lista do wglądu, wystawianie zablokowane` : ''}
      · do podpięcia w Sellasist: <b>${d.do_sellasist}</b></p>`;
  el('cw-pasek').querySelectorAll('[data-cw-rynek]').forEach((b) => b.addEventListener('click', () => { cwRynek = b.dataset.cwRynek; cwRenderuj(); }));
  el('cw-pasek').querySelectorAll('[data-cw-sort]').forEach((b) => b.addEventListener('click', () => { cwSort = b.dataset.cwSort; cwRenderuj(); }));
  el('cw-szukaj').addEventListener('input', (e) => { cwSzukaj = e.target.value; cwRenderujListe(); });
  el('cw-odswiez').addEventListener('click', () => odswiezCenyWystawianie({ odswiez: true }));
  el('cw-tylko-gotowe').addEventListener('change', (e) => { cwTylkoGotowe = e.target.checked; cwRenderujListe(); });
  el('cw-wystaw').addEventListener('click', cwWystaw);
  cwRenderujListe();
  cwRenderujHistorie();
}

function cwRenderujListe() {
  const lista = cwWidoczne();
  const rynek = cwDane.rynki.find((r) => r.klucz === cwRynek);
  if (!lista.length) { el('cw-lista').innerHTML = `<p class="hint">${cwTylkoGotowe ? 'Nic gotowego do wystawienia — odznacz „tylko gotowe”, żeby zobaczyć, czego brakuje.' : 'Brak kandydatów na tym rynku.'}</p>`; return; }
  const wiersz = (x) => {
    const zablok = x.zablokowana || !rynek?.gotowe;
    const link = cwLinkProduktu(x);
    const uwagi = [cwBrakuje(x), ...x.blokady.map((t) => `<div class="cw-blokada">⛔ ${cenyEsc(t)}</div>`), ...x.ostrzezenia.map((o) => `<div class="cw-ostrz">⚠ ${cenyEsc(o.tekst)}</div>`)].join('');
    return `<tr class="${zablok ? 'cw-zablok' : ''}">
      <td><input type="checkbox" data-cw-zazn="${x.klucz}" ${cwZaznaczone.has(x.klucz) ? 'checked' : ''} ${zablok ? 'disabled' : ''}></td>
      <td><b>${cenyEsc(x.sku)}</b><div class="cs-sz">${cenyEsc(x.ean)}</div></td>
      <td>${cenyEsc(x.nazwa)}${x.nazwa_platformy ? `<div class="cs-sz">${link ? `<a href="${link}" target="_blank" rel="noopener">↗</a> ` : ''}${cenyEsc(x.nazwa_platformy)}</div>` : ''}</td>
      <td>${cenyEsc(x.marka || '')}<div class="cs-sz">${cenyEsc(x.kategoria || '')}${x.hotness ? ` · ${cenyEsc(x.hotness)}` : ''}</div></td>
      <td class="num">${x.stan ?? '—'}</td>
      <td class="num"><input type="number" step="0.01" min="0" class="cw-cena" data-cw-cena="${x.klucz}" value="${cwCeny.get(x.klucz) ?? x.cena ?? ''}" ${zablok ? 'disabled' : ''}> ${cenyEsc(x.waluta)}
        <div class="cs-sz">min ${cenyLiczba(x.min)}${x.strategia ? ` · ${cenyEsc(x.strategia)}` : ''}</div></td>
      <td class="num">${x.marza == null ? '—' : `${cenyLiczba(x.marza, 1)}%`}<div class="cs-sz">${x.zysk == null ? '' : `${cenyLiczba(x.zysk)} zł`}</div></td>
      <td>${uwagi}</td>
      <td><button type="button" class="btn btn-small" data-cw-skan="${x.tw_id}" title="Sprawdź katalogi tego towaru od nowa">↻</button></td>
    </tr>`;
  };
  el('cw-lista').innerHTML = `<div class="tabela-wrapper"><table class="tabela cs-tabela cw-tabela">
    <thead><tr><th><input type="checkbox" id="cw-wszystkie" title="Zaznacz widoczne, które da się wystawić"></th><th>SKU / EAN</th><th>Nazwa (u nas / na platformie)</th><th>Marka</th>
      <th>Stan</th><th>Cena brutto</th><th>Marża / zysk</th><th>Uwagi</th><th></th></tr></thead>
    <tbody>${lista.map(wiersz).join('')}</tbody></table></div>`;
  const licz = () => { el('cw-wystaw').textContent = `Wystaw zaznaczone (${cwZaznaczone.size})`; };
  el('cw-lista').querySelectorAll('[data-cw-zazn]').forEach((c) => c.addEventListener('change', () => {
    if (c.checked) cwZaznaczone.add(c.dataset.cwZazn); else cwZaznaczone.delete(c.dataset.cwZazn);
    licz();
  }));
  el('cw-wszystkie').addEventListener('change', (e) => {
    el('cw-lista').querySelectorAll('[data-cw-zazn]:not(:disabled)').forEach((c) => {
      c.checked = e.target.checked;
      if (c.checked) cwZaznaczone.add(c.dataset.cwZazn); else cwZaznaczone.delete(c.dataset.cwZazn);
    });
    licz();
  });
  el('cw-lista').querySelectorAll('[data-cw-cena]').forEach((i) => i.addEventListener('change', () => cwZmienCene(i.dataset.cwCena, i.value)));
  el('cw-lista').querySelectorAll('[data-cw-skan]').forEach((b) => b.addEventListener('click', () => cwSkan(Number(b.dataset.cwSkan), b)));
}

// Braki danych towaru (EAN, waga, wymiary) jednym komunikatem — szczegóły w podpowiedzi. Uzupełnia się je w GT
// (desktop / Zebra → Parametry); pozycja zostaje na liście (decyzja usera 2026-10-30), tylko wystawić się jej nie da.
const cwBrakuje = (x) => (x.brakuje?.length ? `<div class="cw-uzupelnij" title="${cenyEsc(x.brakuje.map((b) => b.tekst).join('\n'))}">📝 Dane do uzupełnienia: ${cenyEsc(x.brakuje.map((b) => b.pole).join(', '))}</div>` : '');

const cwZKlucza = (klucz) => { const [tw, platforma, rynek] = klucz.split('|'); return { tw_id: Number(tw), platforma, rynek }; };

// Nowa cena w wierszu → marża i zysk z backendu (ten sam kalkulator co przy wystawieniu).
async function cwZmienCene(klucz, wartosc) {
  const cena = Number(String(wartosc).replace(',', '.'));
  if (!(cena > 0)) { cwCeny.delete(klucz); return; }
  cwCeny.set(klucz, cena);
  try {
    const r = await api('/api/ceny/wystawianie/podglad', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pozycje: [{ ...cwZKlucza(klucz), cena }] }) });
    const nowa = r.pozycje[0];
    if (!nowa) return;
    const i = cwDane.pozycje.findIndex((x) => x.klucz === klucz);
    if (i >= 0) cwDane.pozycje[i] = nowa;
    cwRenderujListe();
  } catch (err) { pokazKomunikat(err.message, 'blad'); }
}

async function cwSkan(twId, przycisk) {
  przycisk.disabled = true;
  przycisk.textContent = '…';
  try {
    const r = await api('/api/ceny/wystawianie/skan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tw_id: twId }) });
    const bledy = Object.entries(r.bledy || {});
    pokazKomunikat(`Katalogi sprawdzone (${r.sekund} s)${bledy.length ? ` — błędy: ${bledy.map(([k, v]) => `${k}: ${v}`).join('; ')}` : ''}`, bledy.length ? 'blad' : 'info');
    await odswiezCenyWystawianie({ odswiez: true });
  } catch (err) { pokazKomunikat(err.message, 'blad'); przycisk.disabled = false; przycisk.textContent = '↻'; }
}

async function cwWystaw() {
  const klucze = [...cwZaznaczone].filter((k) => cwDane.pozycje.some((x) => x.klucz === k));
  if (!klucze.length) return pokazKomunikat('Zaznacz pozycje do wystawienia', 'blad');
  if (klucze.length > cwDane.max_na_raz) return pokazKomunikat(`Najwyżej ${cwDane.max_na_raz} pozycji naraz`, 'blad');
  const pozycje = klucze.map((k) => ({ ...cwZKlucza(k), ...(cwCeny.has(k) ? { cena: cwCeny.get(k) } : {}) }));
  let podglad;
  try {
    podglad = await api('/api/ceny/wystawianie/podglad', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pozycje }) });
  } catch (err) { return pokazKomunikat(err.message, 'blad'); }
  const ok = podglad.pozycje.filter((x) => !x.zablokowana);
  const tabela = `<table class="tabela cs-tabela"><thead><tr><th>SKU</th><th>Kanał</th><th>Cena</th><th>Marża</th><th>Zysk</th><th>Stan</th><th>Uwagi</th></tr></thead><tbody>
    ${podglad.pozycje.map((x) => `<tr class="${x.zablokowana ? 'cw-zablok' : ''}"><td>${cenyEsc(x.sku)}</td><td>${cenyEsc(x.kanal_nazwa)}</td>
      <td class="num">${cenyLiczba(x.cena)} ${cenyEsc(x.waluta)}</td><td class="num">${x.marza == null ? '—' : `${cenyLiczba(x.marza, 1)}%`}</td>
      <td class="num">${x.zysk == null ? '—' : `${cenyLiczba(x.zysk)} zł`}</td><td class="num">${x.stan}</td>
      <td>${[cwBrakuje(x), ...x.blokady.map((t) => `⛔ ${cenyEsc(t)}`), ...x.ostrzezenia.map((o) => `⚠ ${cenyEsc(o.tekst)}`)].filter(Boolean).join('<br>')}</td></tr>`).join('')}
    ${(podglad.pominiete || []).map((x) => `<tr class="cw-zablok"><td colspan="7">pominięte: ${cenyEsc(x.powod)}</td></tr>`).join('')}
    </tbody></table>
    <label class="cw-auto"><input type="checkbox" id="cw-auto" checked> Włącz automat repricera, gdy oferta pojawi się w synchronizacji (eMAG ~30 min)</label>`;
  if (!ok.length) return cenyOknoPotwierdzenia({ tytul: 'Nic do wystawienia', tresc: tabela, przycisk: 'Zamknij', szeroki: true });
  const tak = await cenyOknoPotwierdzenia({ tytul: `Wystawić ${ok.length} ofert?`, tresc: tabela, przycisk: `Wystaw ${ok.length}`, szeroki: true,
    uwaga: 'Ilość = stan dostępny teraz. Oferta będzie poza Sellasist — podepnij ją tam, inaczej stan nie będzie się aktualizował.' });
  if (!tak) return;
  const auto = el('cw-auto')?.checked !== false;
  const przycisk = el('cw-wystaw');
  przycisk.disabled = true;
  przycisk.textContent = 'Wystawiam…';
  try {
    const r = await cwWyslij('/api/ceny/wystawianie', { pozycje: ok.map((x) => ({ tw_id: x.tw_id, platforma: x.platforma, rynek: x.rynek, cena: x.cena })), auto },
      { tytul: 'Potwierdź wystawienie', przycisk: 'Wystaw mimo to' });
    if (!r) return;
    const wyslane = r.wyniki.filter((w) => w.status === 'wyslane').length;
    const inne = r.wyniki.filter((w) => w.status !== 'wyslane');
    pokazKomunikat(`Wystawione: ${wyslane}${inne.length ? ` · nie przeszło: ${inne.length} — ${inne.map((w) => `${w.sku}: ${w.opis}`).join('; ')}` : ''}`, inne.length ? 'blad' : 'info');
    for (const k of klucze) { cwZaznaczone.delete(k); cwCeny.delete(k); }
    await odswiezCenyWystawianie({ odswiez: true });
  } catch (err) { pokazKomunikat(err.message, 'blad'); } finally { przycisk.disabled = false; }
}

function cwRenderujHistorie() {
  el('cw-l-historia').textContent = cwHistoria.length || '';
  if (!cwHistoria.length) { el('cw-historia').innerHTML = '<p class="hint">Nic jeszcze nie wystawiono z WMS.</p>'; return; }
  const wiersz = (w) => {
    const s = CW_STATUS[w.status] || { nazwa: w.status, klasa: '' };
    const naPlatformie = w.status === 'wyslane' || w.status === 'widoczna';
    const oferta = w.oferta_id ? [w.of_auto ? 'automat wł.' : 'automat wył.', w.of_blokada ? `⚠ ${w.of_blokada}` : null].filter(Boolean).join(' · ') : '';
    return `<tr>
      <td>${cenyEsc(formatDatetime(w.czas))}<div class="cs-sz">${cenyEsc(w.kto || '')}</div></td>
      <td>${cenyEsc(w.kanal_nazwa)}</td><td><b>${cenyEsc(w.sku)}</b></td>
      <td class="num">${cenyLiczba(w.cena)} ${cenyEsc(w.waluta)}<div class="cs-sz">${w.ilosc} szt.</div></td>
      <td><span class="cs-status ${s.klasa}">${cenyEsc(s.nazwa)}</span><div class="cs-sz">${cenyEsc(oferta)}</div></td>
      <td class="cw-opis">${cenyEsc(w.opis || '')}</td>
      <td>${naPlatformie ? `<label class="cw-sellasist"><input type="checkbox" data-cw-sellasist="${w.id}" ${w.sellasist ? 'checked' : ''}> podpięte</label>` : ''}</td>
    </tr>`;
  };
  el('cw-historia').innerHTML = `<div class="tabela-wrapper"><table class="tabela cs-tabela"><thead><tr><th>Kiedy</th><th>Kanał</th><th>SKU</th><th>Cena / ilość</th>
    <th>Status</th><th>Szczegóły</th><th>Sellasist</th></tr></thead><tbody>${cwHistoria.map(wiersz).join('')}</tbody></table></div>`;
  el('cw-historia').querySelectorAll('[data-cw-sellasist]').forEach((c) => c.addEventListener('change', async () => {
    try {
      await api('/api/ceny/wystawianie/sellasist', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [Number(c.dataset.cwSellasist)], podpiete: c.checked, operator: operator() }) });
      await odswiezCenyWystawianie();
    } catch (err) { c.checked = !c.checked; pokazKomunikat(err.message, 'blad'); }
  }));
}
