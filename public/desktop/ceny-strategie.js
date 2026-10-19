'use strict';

// Ekran Ceny → „Strategie”: biblioteka strategii cenowych per towar, przypisania i podgląd skutków.
// Backend: routes/ceny-strategie.js (walidacja, potwierdzenia), logika: pricing/strategie.js.
// Wdrożenie kontrolowane (decyzja usera 2026-10-19): nowa strategia jest PODGLĄDEM — liczy i pokazuje nowe granice,
// automat dalej używa dzisiejszych; ceny zmienia dopiero „Aktywuj”. Ręczne granice oferty wygrywają (odstępstwo).
// Plik ładuje się PRZED app.js i używa jego funkcji (el, api, cenyEsc, cenyLiczba, cenyOknoPotwierdzenia, operator…)
// dopiero w chwili wywołania; app.js woła odswiezCenyStrategie() z odswiezCeny().

let csDane = null, csWybrana = null, csEdycja = null, csNr = 0;
const CS_SKUTKI = {
  w_gore: { nazwa: 'Podniesie od razu', klasa: 'gora' }, w_dol: { nazwa: 'Może zejść niżej', klasa: 'dol' },
  miejsce: { nazwa: 'Więcej miejsca w górę', klasa: '' }, sufit: { nazwa: 'Ponad nowym max', klasa: '' },
  bez_zmian: { nazwa: 'Bez zmian od razu', klasa: '' }, brak_pasa: { nazwa: 'Brak pasa', klasa: '' },
  brak_ceny: { nazwa: 'Brak ceny', klasa: '' }, koniec: { nazwa: 'Zakończone', klasa: '' }, brak_gt: { nazwa: 'Bez GT', klasa: '' },
};

async function odswiezCenyStrategie() {
  const nr = ++csNr;
  try {
    const d = await api('/api/ceny/strategie');
    if (nr !== csNr) return;
    csDane = d;
    if (csWybrana && !d.strategie.some((x) => x.id === csWybrana)) csWybrana = null;
    csRenderuj();
    if (csWybrana) csPodglad(csWybrana);
  } catch (err) {
    if (nr !== csNr) return;
    if (err.status === 404) {     // WMS jeszcze bez trasy (przed restartem)
      el('cs-lista').innerHTML = '<p class="hint">Strategie będą dostępne po restarcie WMS (nowa trasa /api/ceny/strategie).</p>';
      return;
    }
    pokazKomunikat(err.message, 'blad');
  }
}

// POST z potwierdzeniem: 409 z `potwierdzenie` → okno z ostrzeżeniami → ten sam POST z potwierdz: true.
async function csWyslij(url, body, { tytul, przycisk, tresc = '' }) {
  const wyslij = (potwierdz) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, operator: operator(), ...(potwierdz ? { potwierdz: true } : {}) }) });
  try {
    return await wyslij(false);
  } catch (err) {
    if (err.status !== 409 || !err.dane?.potwierdzenie) throw err;
    const ok = await cenyOknoPotwierdzenia({ tytul, tresc, ostrzezenia: err.dane.ostrzezenia || [], przycisk });
    return ok ? wyslij(true) : null;
  }
}

function csRenderuj() {
  const d = csDane;
  const wiersz = (x) => `<tr class="${x.id === csWybrana ? 'wybrany' : ''}">
      <td><b>${cenyEsc(x.nazwa)}</b><div class="cs-sz">${cenyEsc(csTyp(x.typ)?.nazwa || x.typ)}</div></td>
      <td>${cenyEsc(x.opis)}</td>
      <td><span class="cs-status ${x.aktywna ? 'aktywna' : 'podglad'}">${x.aktywna ? 'Aktywna' : 'Podgląd'}</span></td>
      <td class="num">${x.towarow}</td>
      <td class="cs-akcje">
        <button type="button" class="btn btn-small" data-cs-pokaz="${x.id}">Towary i skutki</button>
        <button type="button" class="btn btn-small" data-cs-edytuj="${x.id}">Edytuj</button>
        <button type="button" class="btn btn-small ${x.aktywna ? '' : 'btn-primary'}" data-cs-status="${x.id}">${x.aktywna ? 'Wróć do podglądu' : 'Aktywuj…'}</button>
        ${x.towarow ? '' : `<button type="button" class="btn btn-small" data-cs-usun="${x.id}">Usuń</button>`}
      </td></tr>`;
  el('cs-lista').innerHTML = `<div class="tabela-wrapper"><table class="tabela cs-tabela">
      <thead><tr><th>Strategia</th><th>Zasady (min / max)</th><th>Status</th><th>Towarów</th><th></th></tr></thead>
      <tbody>
        <tr class="cs-domyslna"><td><b>${cenyEsc(d.domyslna.nazwa)}</b><div class="cs-sz">domyślna</div></td><td>${cenyEsc(d.domyslna.opis)} — każdy towar bez przypisanej strategii (dzisiejszy automat)</td>
          <td><span class="cs-status aktywna">Zawsze</span></td><td class="num cs-sz">reszta</td><td class="cs-sz">nie do edycji</td></tr>
        ${d.strategie.map(wiersz).join('')}
      </tbody></table></div>`;
  el('cs-lista').querySelectorAll('[data-cs-pokaz]').forEach((b) => b.addEventListener('click', () => { csWybrana = Number(b.dataset.csPokaz); csRenderuj(); csPodglad(csWybrana); }));
  el('cs-lista').querySelectorAll('[data-cs-edytuj]').forEach((b) => b.addEventListener('click', () => {
    csEdycja = d.strategie.find((x) => x.id === Number(b.dataset.csEdytuj));
    csFormularz();
    el('cs-formularz').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  el('cs-lista').querySelectorAll('[data-cs-status]').forEach((b) => b.addEventListener('click', () => csZmienStatus(d.strategie.find((x) => x.id === Number(b.dataset.csStatus)))));
  el('cs-lista').querySelectorAll('[data-cs-usun]').forEach((b) => b.addEventListener('click', () => csUsun(d.strategie.find((x) => x.id === Number(b.dataset.csUsun)))));
  csFormularz();
}

const csTyp = (klucz) => csDane?.typy.find((t) => t.klucz === klucz);

// Formularz nowej / edytowanej strategii — pola parametrów z backendu (pricing/strategie.js TYPY).
function csFormularz() {
  const box = el('cs-formularz');
  const e = csEdycja;
  const typ = csTyp(box.dataset.typ && !e ? box.dataset.typ : e?.typ || 'marza') || csDane.typy[0];
  box.dataset.typ = typ.klucz;
  const pole = (p) => `<label class="cs-pole" title="${cenyEsc(p.opis)}"><span>${cenyEsc(p.nazwa)}</span>
      <span class="cs-wartosc"><input type="text" inputmode="decimal" name="${p.klucz}" value="${e ? cenyDoPola(e.parametry[p.klucz]) : ''}" placeholder="${cenyDoPola(p.dom)}" autocomplete="off"> ${cenyEsc(p.jedn)}</span>
      <span class="cs-sz">${cenyEsc(p.opis)}</span></label>`;
  box.innerHTML = `<form id="cs-form" novalidate>
      <h3 class="ceny-h3">${e ? `Edycja: ${cenyEsc(e.nazwa)}${e.aktywna ? ' <span class="cs-status aktywna">Aktywna</span>' : ''}` : 'Nowa strategia'}</h3>
      <div class="cs-form-gora">
        <label class="cs-pole"><span>Typ</span><select name="typ" ${e ? 'disabled' : ''}>${csDane.typy.map((t) => `<option value="${t.klucz}"${t.klucz === typ.klucz ? ' selected' : ''}>${cenyEsc(t.nazwa)}</option>`).join('')}</select></label>
        <label class="cs-pole"><span>Nazwa</span><input type="text" name="nazwa" maxlength="60" value="${cenyEsc(e?.nazwa || '')}" placeholder="np. Marża 15 — zabawki letnie" autocomplete="off"></label>
      </div>
      <p class="cs-sz">${cenyEsc(typ.opis)}</p>
      <div class="cs-pola">${typ.parametry.map(pole).join('')}</div>
      <div class="cs-form-akcje">
        <button class="btn btn-primary">${e ? 'Zapisz zmiany' : 'Utwórz (jako podgląd)'}</button>
        ${e ? '<button type="button" class="btn" id="cs-anuluj">Anuluj edycję</button>' : ''}
        <span class="cs-sz">Puste pole = wartość domyślna. Nowa strategia nie zmienia cen, dopóki jej nie aktywujesz.</span>
      </div></form>`;
  const f = el('cs-form');
  f.querySelector('[name=typ]').addEventListener('change', (ev) => { box.dataset.typ = ev.target.value; csFormularz(); });
  el('cs-anuluj')?.addEventListener('click', () => { csEdycja = null; csFormularz(); });
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const parametry = Object.fromEntries(typ.parametry.map((p) => [p.klucz, f.querySelector(`[name=${p.klucz}]`).value.trim()]));
    try {
      const r = await csWyslij('/api/ceny/strategie', { id: e?.id ?? null, nazwa: f.querySelector('[name=nazwa]').value, typ: typ.klucz, parametry },
        { tytul: e ? `Zmiana strategii „${e.nazwa}”` : 'Nowa strategia', przycisk: 'Zapisz' });
      if (!r) return;
      pokazKomunikat(e ? `Zapisano „${r.strategia.nazwa}”.` : `Utworzono „${r.strategia.nazwa}” — w podglądzie. Przypisz towary i sprawdź skutki przed aktywacją.`, 'ok');
      csEdycja = null;
      csWybrana = r.strategia.id;
      odswiezCenyStrategie();
    } catch (err) { pokazKomunikat(err.message, 'blad'); }
  });
}

async function csZmienStatus(x) {
  try {
    if (x.aktywna) {
      await csWyslij('/api/ceny/strategie/status', { id: x.id, aktywna: false }, { tytul: '', przycisk: '' });
      pokazKomunikat(`„${x.nazwa}” wróciła do podglądu — od najbliższego przebiegu automat używa granic domyślnych.`, 'ok');
    } else {
      const p = await api(`/api/ceny/strategie/${x.id}/podglad`);
      const s = p.podsumowanie || {};
      const tresc = `<p>Od najbliższego przebiegu (do 30 min) automat użyje granic <b>${cenyEsc(x.nazwa)}</b> (${cenyEsc(x.opis)}) na ${x.towarow} towarach.</p>
        <p>Oferty z automatem: ${Object.entries(s).filter(([, n]) => n).map(([k, n]) => `${cenyEsc(CS_SKUTKI[k]?.nazwa || k)} <b>${n}</b>`).join(' · ') || 'brak'}.</p>`;
      const r = await csWyslij('/api/ceny/strategie/status', { id: x.id, aktywna: true }, { tytul: `Aktywacja „${x.nazwa}”`, tresc, przycisk: 'Aktywuj' });
      if (!r) return;
      pokazKomunikat(`„${x.nazwa}” aktywna — granice zmienią się przy najbliższym przebiegu.`, 'ok');
    }
    odswiezCenyStrategie();
  } catch (err) { pokazKomunikat(err.message, 'blad'); }
}

async function csUsun(x) {
  if (!window.confirm(`Usunąć strategię „${x.nazwa}”?`)) return;
  try {
    await api('/api/ceny/strategie/usun', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: x.id, operator: operator() }) });
    pokazKomunikat(`Usunięto „${x.nazwa}”.`, 'ok');
    odswiezCenyStrategie();
  } catch (err) { pokazKomunikat(err.message, 'blad'); }
}

// --- Towary strategii i podgląd skutków ----------------------------------------------------------------------
async function csPodglad(id) {
  const box = el('cs-podglad');
  const x = csDane.strategie.find((s) => s.id === id);
  if (!x) { box.innerHTML = ''; return; }
  box.innerHTML = `${csPrzypiszHtml(x)}<p class="hint">Liczę skutki…</p>`;
  csPodlaczPrzypisz(x);
  try {
    const p = await api(`/api/ceny/strategie/${id}/podglad`);
    if (csWybrana !== id) return;
    box.innerHTML = csPrzypiszHtml(x) + csPodgladHtml(x, p);
    csPodlaczPrzypisz(x);
    box.querySelectorAll('[data-cs-zdejmij]').forEach((b) => b.addEventListener('click', () => csZdejmij([Number(b.dataset.csZdejmij)], b.dataset.symbol)));
    box.querySelectorAll('[data-cs-karta]').forEach((b) => b.addEventListener('click', () => cenyOtworzKarte(Number(b.dataset.csKarta))));
  } catch (err) { box.innerHTML = csPrzypiszHtml(x) + `<p class="ceny-blad">${cenyEsc(err.message)}</p>`; csPodlaczPrzypisz(x); }
}

function csPrzypiszHtml(x) {
  const wyprz = csTyp(x.typ)?.wymagaKonca;
  return `<h3 class="ceny-h3">${cenyEsc(x.nazwa)} <span class="cs-status ${x.aktywna ? 'aktywna' : 'podglad'}">${x.aktywna ? 'Aktywna' : 'Podgląd'}</span></h3>
    <form id="cs-przypisz" class="cs-przypisz" novalidate>
      <label class="cs-pole cs-kody"><span>Przypisz towary</span><textarea name="kody" rows="2" placeholder="Symbole GT albo EAN-y — po spacji, przecinku albo w nowych liniach"></textarea></label>
      <label class="cs-pole"><span>Do dnia${wyprz ? ' (wymagane)' : ' (opcjonalnie)'}</span><input type="date" name="do" min="${csDane.dzis}"></label>
      <button class="btn btn-primary">Przypisz</button>
    </form>`;
}

function csPodlaczPrzypisz(x) {
  const f = el('cs-przypisz');
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const r = await csWyslij('/api/ceny/strategie/przypisz', { strategia_id: x.id, kody: f.querySelector('[name=kody]').value, do: f.querySelector('[name=do]').value },
        { tytul: `Przypisanie do „${x.nazwa}”`, przycisk: 'Przypisz' });
      if (!r) return;
      const nz = r.nieznalezione?.length ? ` Nie znaleziono: ${r.nieznalezione.map((n) => n.kod).join(', ')}.` : '';
      pokazKomunikat(`Przypisano ${r.przypisane} towarów do „${x.nazwa}”.${r.zmienione?.length ? ` Zmieniona strategia: ${r.zmienione.length}.` : ''}${nz}`, nz ? 'blad' : 'ok');
      odswiezCenyStrategie();
    } catch (err) { pokazKomunikat(err.message, 'blad'); }
  });
}

async function csZdejmij(twIds, symbol) {
  if (!window.confirm(`Zdjąć strategię z ${symbol}? Towar wróci na „${csDane.domyslna.nazwa}”.`)) return;
  try {
    await api('/api/ceny/strategie/zdejmij', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tw_ids: twIds, operator: operator() }) });
    odswiezCenyStrategie();
  } catch (err) { pokazKomunikat(err.message, 'blad'); }
}

function csPodgladHtml(x, p) {
  if (!p.towary.length) return '<p class="hint">Brak przypisanych towarów.</p>';
  const pas = (g, w) => (g ? `${cenyLiczba(g.min)} – ${cenyLiczba(g.max)} <small>${cenyEsc(w)}</small>${g.zrodlo_min === 'reczne' || g.zrodlo_max === 'reczne' ? ' <span class="cs-odst" title="Ręczne granice oferty wygrywają ze strategią">ręczne</span>' : ''}` : '—');
  const sumy = Object.entries(p.podsumowanie || {}).filter(([, n]) => n);
  const naglowek = `<p class="cs-sz">${x.aktywna ? 'Automat używa granic tej strategii.' : '<b>Podgląd</b> — automat używa jeszcze granic domyślnych. Kolumna „Ze strategią” pokazuje, co wejdzie po aktywacji.'}
      ${sumy.length ? ` Oferty z automatem: ${sumy.map(([k, n]) => `${cenyEsc(CS_SKUTKI[k]?.nazwa || k)} <b>${n}</b>`).join(' · ')}.` : ''}
      ${p.gt_ok ? '' : ' <span class="ceny-blad">Subiekt nie odpowiada — bez kosztu nie policzymy granic.</span>'}</p>`;
  const towar = (t) => {
    const ref = t.referencja ? ` · referencja: ${cenyEsc(t.referencja.kolumna)} — ${t.referencja.szt} szt., mediana ${cenyLiczba(t.referencja.mediana)}, zysk ${cenyLiczba(t.referencja.zysk)} zł/szt.`
      : x.typ === 'za_rynkiem' ? ' · brak rynku ze sprzedażą — podłoga bazowa' : '';
    const wiersze = t.oferty.map((o) => `<tr class="${o.auto ? '' : 'cs-reczna'}">
        <td>${cenyEsc(o.kanal)}</td><td>${o.auto ? 'automat' : '<span class="cs-sz">ręczny</span>'}</td>
        <td class="num">${o.cena != null ? cenyLiczba(o.cena) : '—'}${o.bb_nasz === 1 ? ' <span class="cs-bb" title="Mamy Buy Box">BB</span>' : ''}</td>
        <td class="num">${pas(o.bez, o.waluta)}</td><td class="num"><b>${pas(o.ze, o.waluta)}</b></td>
        <td class="num">${o.zysk_min_ze != null ? `${cenyLiczba(o.zysk_min_ze)} zł` : '—'}</td>
        <td class="cs-skutek ${CS_SKUTKI[o.skutek.kod]?.klasa || ''}">${cenyEsc(o.skutek.tekst)}</td></tr>`).join('');
    return `<tbody class="cs-towar">
      <tr class="cs-towar-gl"><td colspan="7"><button type="button" class="ceny-link-karta" data-cs-karta="${t.tw_id}" title="Karta SKU">${cenyEsc(t.symbol)}</button>
        <span class="cs-sz">${cenyEsc(t.nazwa || '')}${t.do ? ` · do ${cenyEsc(t.do)}` : ''}${t.stan != null ? ` · stan ${t.stan}` : ''}${ref}</span>
        ${t.koniec ? ` <span class="ceny-blad">${cenyEsc(t.koniec)} — worker zdejmie przy najbliższym przebiegu</span>` : ''}
        <button type="button" class="btn btn-small cs-zdejmij" data-cs-zdejmij="${t.tw_id}" data-symbol="${cenyEsc(t.symbol)}">Zdejmij</button></td></tr>
      ${wiersze || '<tr><td colspan="7" class="cs-sz">brak ofert ze stanem</td></tr>'}</tbody>`;
  };
  return `${naglowek}<div class="tabela-wrapper"><table class="tabela cs-podglad-tab">
    <thead><tr><th>Kanał</th><th></th><th>Cena</th><th>Bez strategii</th><th>Ze strategią</th><th>Zysk przy min</th><th>Co zrobi automat</th></tr></thead>
    ${p.towary.map(towar).join('')}</table></div>`;
}
