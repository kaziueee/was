// Ekran Zebry "Uzupelnienia K4" - lista zbiorcza (K4G->K4 wg rezerwacji) z rozbiciem
// na kanaly wysylki, wejscie w produkt -> zaznacz kanaly (buduja ilosc) -> wybor/skan
// zrodla K4G -> Przesun (MM K4G->K4 przez /api/ruchy/mm). Korzysta z globalnych helperow
// z kreator.js/ruch.js: el, onScan, polaSkanuBezKlawiatury, operator, beep, pokazWidok.

(function () {
  'use strict';

  // Kolejnosc kanalow spojna z serwerem (services/kanaly.js) i desktopem.
  const KANALY = [
    'DHL Connect', 'InPost', 'DPD', 'DHL', 'UPS', 'One',
    'Orlen Paczka', 'Poczta Polska', 'Packeta', 'Emag', 'nieklasyfikowane',
  ];

  let pozycje = [];     // ostatnio pobrana lista
  let wybrany = null;   // produkt otwarty w karcie
  let zrodlo = null;    // wybrane zrodlo: WMS { lokalizacja_id, kod, ilosc } albo GT { tryb:'gt', kod, ilosc }
  let gtMode = false;   // true gdy towar t_GT (brak lokalizacji WMS) -> czyste GT (/api/ruchy/uzupelnienie)

  function komunikat(tekst, typ) {
    const k = el('uzup-komunikat');
    if (!tekst) { k.className = 'komunikat hidden'; return; }
    k.textContent = tekst;
    k.className = `komunikat ${typ || 'info'}`;
  }

  // --- wejscie do widoku (wolane z pokazWidok) ---
  async function otworz() {
    pokazPodekran('lista');
    komunikat('');
    wypelnijFiltr();
    try {
      const res = await fetch('/api/uzupelnienia');
      const dane = await res.json();
      if (!res.ok) throw new Error(dane?.blad || `Błąd ${res.status}`);
      pozycje = dane.pozycje || [];
      renderujListe();
    } catch (err) {
      komunikat(err.message, 'blad');
    }
  }
  window.uzupOtworz = otworz;

  function pokazPodekran(nazwa) {
    el('uzup-lista-sekcja').classList.toggle('hidden', nazwa !== 'lista');
    el('uzup-karta-sekcja').classList.toggle('hidden', nazwa !== 'karta');
    el('uzup-przesun').classList.toggle('hidden', nazwa !== 'karta');
  }

  function wypelnijFiltr() {
    const sel = el('uzup-filtr-kanal');
    if (sel.options.length > 0) return;
    const wszystkie = document.createElement('option');
    wszystkie.value = ''; wszystkie.textContent = 'Wszystkie kanały';
    sel.appendChild(wszystkie);
    for (const k of KANALY) {
      const o = document.createElement('option');
      o.value = k; o.textContent = k;
      sel.appendChild(o);
    }
  }

  // --- lista ---
  function renderujListe() {
    const kanal = el('uzup-filtr-kanal').value;
    let lista = pozycje;
    if (kanal) {
      lista = pozycje.filter((p) => (p.kanaly[kanal] || 0) > 0)
        .sort((a, b) => (b.kanaly[kanal] || 0) - (a.kanaly[kanal] || 0));
    }

    const kont = el('uzup-lista');
    kont.innerHTML = '';
    el('uzup-pusto').classList.toggle('hidden', lista.length > 0);

    for (const p of lista) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lista-poz st-warn';
      const liczba = kanal ? (p.kanaly[kanal] || 0) : p.rezerwacje;
      btn.innerHTML = `<span class="poz-glowna">`
        + `<span class="poz-kod">${p.symbol}</span>`
        + `<span class="poz-nazwa">${p.nazwa || ''}</span>`
        + `<span class="poz-podpis">${chipyKanalow(p.kanaly, kanal)}</span>`
        + `</span>`
        + `<span class="poz-prawa"><span class="poz-ilosc">${liczba}</span><span class="poz-rez">${kanal || 'rez.'}</span></span>`
        + `<span class="poz-strzalka">›</span>`;
      btn.addEventListener('click', () => otworzKarte(p));
      kont.appendChild(btn);
    }
  }

  // chipy "kanal: ilosc" posortowane malejaco (tekstowo, do podpisu pozycji)
  function chipyKanalow(kanaly, wybranyKanal) {
    return Object.entries(kanaly).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => {
        const akt = wybranyKanal && k === wybranyKanal ? ' akt' : '';
        return `<span class="uzup-chip${akt}">${k}: ${v}</span>`;
      }).join(' ');
  }

  // --- karta produktu ---
  async function otworzKarte(p) {
    // TWARDA BLOKADA edycji: uzupelnienie to tez edycja produktu. Zajmij lock; gdy edytuje
    // kto inny -> tylko komunikat, zostajemy na liscie (nie otwieramy karty).
    if (window.BlokadaEdycji) {
      const b = await BlokadaEdycji.zajmij(p.artykul_gt_id);
      if (!b.ok) { komunikat(b.przez ? `Produkt edytuje ${b.przez} — spróbuj później` : (b.blad || 'Nie można otworzyć produktu'), 'blad'); return; }
    }
    wybrany = p;
    zrodlo = null;
    // gtMode = brak WMS zrodla K4G -> chowamy wybor/skan zrodla (zrodlo wg GT).
    // Cel K4: jesli istnieje w WMS, i tak go zaktualizujemy (patrz przesun -> lok_cel_id).
    gtMode = !(p.wms_k4g && p.wms_k4g.length > 0);
    komunikat('');
    pokazPodekran('karta');

    el('uzup-karta-info').innerHTML = `<strong>${p.symbol}</strong> ${p.nazwa || ''}`;

    renderujStany(p);

    if (gtMode) {
      // t_GT: brak lokalizacji WMS - zrodlo wg GT (info w bloku stanow), bez wyboru/skanu.
      // Cap ilosci = stan gory; backend dodatkowo egzekwuje (gora - rezerwacja).
      el('uzup-zrodlo-pole').classList.add('hidden');
      zrodlo = { tryb: 'gt', kod: null, ilosc: p.stan_gora };
    } else {
      // lokalizacje w WMS: pokaz wybor/skan zrodla K4G
      el('uzup-zrodlo-pole').classList.remove('hidden');
      przygotujZrodlo(p);
    }

    przeliczIlosc();
    aktualizujPrzycisk();
  }

  // Blok info: stany i lokalizacje K4 / K4G (wg GT), rezerwacje na K4.
  function renderujStany(p) {
    el('uzup-stany').innerHTML = `
      <div class="uzup-stan-row">
        <span class="uzup-stan-mag">K4</span>
        <span class="uzup-stan-dane">stan <b>${p.stan_k4}</b> · rez <b>${p.rezerwacje}</b></span>
        <span class="uzup-stan-lok">${p.lokalizacja_k4 || '—'}</span>
      </div>
      <div class="uzup-stan-row">
        <span class="uzup-stan-mag">K4G</span>
        <span class="uzup-stan-dane">stan <b>${p.stan_gora}</b></span>
        <span class="uzup-stan-lok">${p.lokalizacja_gora || '—'}</span>
      </div>`;
  }

  // zrodlo K4G (tylko tryb WMS): 1 lok -> auto; >1 -> skan/wybor z listy
  function przygotujZrodlo(p) {
    const auto = el('uzup-zrodlo-auto');
    const skan = el('uzup-zrodlo-skan-pole');
    const lista = el('uzup-zrodlo-lista');
    auto.classList.add('hidden'); skan.classList.add('hidden'); lista.innerHTML = '';

    if (p.wms_k4g.length === 1) {
      wybierzZrodlo(p.wms_k4g[0]);
      auto.textContent = `Źródło: ${zrodlo.kod} (${zrodlo.ilosc} szt.)`;
      auto.classList.remove('hidden');
      return;
    }
    // wiele lokalizacji K4G: skan potwierdza, lub dotkniecie pozycji
    skan.classList.remove('hidden');
    for (const l of p.wms_k4g) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lista-poz';
      btn.dataset.kod = l.kod.toUpperCase();
      btn.innerHTML = `<span class="poz-mag">K4G</span>`
        + `<span class="poz-glowna"><span class="poz-kod">${l.kod}</span></span>`
        + `<span class="poz-prawa"><span class="poz-ilosc">${l.ilosc} szt.</span></span>`;
      btn.addEventListener('click', () => { wybierzZrodlo(l); zaznaczZrodloWLiscie(l.kod); });
      lista.appendChild(btn);
    }
  }

  function zaznaczZrodloWLiscie(kod) {
    el('uzup-zrodlo-lista').querySelectorAll('.lista-poz').forEach((b) => {
      b.classList.toggle('wybrana', b.dataset.kod === kod.toUpperCase());
    });
  }

  function wybierzZrodlo(lok) {
    zrodlo = lok;
    przeliczIlosc();
    aktualizujPrzycisk();
  }

  // ilosc domyslna = BRAKUJE na K4 = rezerwacje - stan K4 (nie cala rezerwacja!).
  // Gdy K4 juz pokrywa rezerwacje (brakuje 0) - domyslnie 0, magazynier bierze sam zapas.
  // Ograniczona stanem zrodla; stepperem mozna podbic o zapas do max.
  function przeliczIlosc() {
    const brakuje = Math.max(0, wybrany.rezerwacje - wybrany.stan_k4);
    const maxZrodlo = zrodlo ? zrodlo.ilosc : Infinity;
    const ile = Math.max(0, Math.min(brakuje, maxZrodlo));
    el('uzup-ilosc').value = ile > 0 ? ile : '';

    const hint = el('uzup-ilosc-hint');
    if (zrodlo && brakuje > zrodlo.ilosc) {
      hint.textContent = `Brakuje ${brakuje} — źródło ma ${zrodlo.ilosc}; resztę z innej lokalizacji.`;
    } else if (brakuje > 0) {
      hint.textContent = `Brakuje na K4: ${brakuje}. Weź co najmniej tyle + zapas${zrodlo ? ` (max ${zrodlo.ilosc})` : ''}.`;
    } else {
      hint.textContent = `K4 pokrywa rezerwacje — weź zapas${zrodlo ? ` (max ${zrodlo.ilosc})` : ''}.`;
    }
    aktualizujPrzycisk();
  }

  function aktualizujIlosc(delta) {
    const obecna = Number(el('uzup-ilosc').value) || 0;
    let nowa = obecna + delta;
    const max = zrodlo ? zrodlo.ilosc : obecna;
    if (nowa < 1) nowa = 1;
    if (nowa > max) nowa = max;
    el('uzup-ilosc').value = nowa;
    aktualizujPrzycisk();
  }

  function aktualizujPrzycisk() {
    const ile = Number(el('uzup-ilosc').value) || 0;
    const zrodloOk = zrodlo && ile >= 1 && ile <= zrodlo.ilosc;
    const celOk = gtMode || !!(wybrany && wybrany.wms_k4);  // GT: cel wg GT; WMS: wymaga lok K4
    el('uzup-przesun').disabled = !(zrodloOk && celOk);
  }

  // --- ruch MM K4G -> K4 (reuzywa /api/ruchy/mm, ktory egzekwuje reguly) ---
  async function przesun() {
    if (el('uzup-przesun').disabled) return;
    const ile = Number(el('uzup-ilosc').value);
    if (!Number.isFinite(ile) || ile <= 0) { komunikat('Podaj ilość > 0', 'blad'); return; }
    if (!zrodlo) { komunikat('Wybierz/zeskanuj lokalizację K4G', 'blad'); return; }
    if (ile > zrodlo.ilosc) { komunikat(`Ilość przekracza dostępne (${zrodlo.ilosc})`, 'blad'); return; }

    let url, body, zrodloKod, celKod;
    if (gtMode) {
      // zrodlo K4G wg GT (brak lokalizacji WMS). Jesli cel K4 ISTNIEJE w WMS -
      // przekazujemy lok_cel_id, by backend zaktualizowal stan K4 (bez rozjazdu).
      url = '/api/ruchy/uzupelnienie';
      body = {
        artykul_gt_id: wybrany.artykul_gt_id, ilosc: ile, operator: operator(),
        artykul_symbol: wybrany.symbol, lok_zrodlo_kod: zrodlo.kod, lok_cel_kod: wybrany.lokalizacja_k4,
      };
      if (wybrany.wms_k4) body.lok_cel_id = wybrany.wms_k4.lokalizacja_id;
      zrodloKod = zrodlo.kod || 'K4G';
      celKod = wybrany.wms_k4 ? wybrany.wms_k4.kod : (wybrany.lokalizacja_k4 || 'K4');
    } else {
      if (!wybrany.wms_k4) { komunikat('Brak lokalizacji K4 w WMS', 'blad'); return; }
      url = '/api/ruchy/mm';
      body = {
        artykul_gt_id: wybrany.artykul_gt_id, lok_zrodlo_id: zrodlo.lokalizacja_id,
        lok_cel_id: wybrany.wms_k4.lokalizacja_id, ilosc: ile, operator: operator(),
      };
      zrodloKod = zrodlo.kod;
      celKod = wybrany.wms_k4.kod;
    }

    const btn = el('uzup-przesun');
    btn.disabled = true;
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const dane = await res.json();
      if (!res.ok) { komunikat(dane?.blad || `Błąd ${res.status}`, 'blad'); btn.disabled = false; return; }
      const dok = dane.dok_gt_numer ? ` (${dane.dok_gt_numer})` : '';
      const ogon = dane.status === 'ok' ? dok : ` — zapisano, oczekuje GT`;
      pokazSukces(`Przeniesiono ${ile} szt. ${wybrany.symbol}: ${zrodloKod} → ${celKod}${ogon}`);
    } catch (err) {
      komunikat('Błąd połączenia z serwerem', 'blad');
      btn.disabled = false;
    }
  }

  function pokazSukces(tekst) {
    el('uzup-sukces-tekst').textContent = tekst;
    el('uzup-sukces').classList.remove('hidden');
    if (window.beep) window.beep();
  }

  // --- nawigacja / zdarzenia ---
  function wstecz() {
    if (window.BlokadaEdycji) BlokadaEdycji.zwolnij(); // zwolnij lock edycji produktu
    if (!el('uzup-karta-sekcja').classList.contains('hidden')) {
      pokazPodekran('lista');
      wybrany = null; zrodlo = null;
      komunikat('');
    } else {
      pokazWidok('menu');
    }
  }

  el('uzup-filtr-kanal').addEventListener('change', renderujListe);
  el('uzup-wstecz').addEventListener('click', wstecz);
  el('uzup-przesun').addEventListener('click', przesun);
  el('uzup-ilosc-minus').addEventListener('click', () => aktualizujIlosc(-1));
  el('uzup-ilosc-plus').addEventListener('click', () => aktualizujIlosc(1));
  el('uzup-ilosc').addEventListener('input', aktualizujPrzycisk);
  el('btn-go-uzup').addEventListener('click', () => {
    pokazWidok('uzupelnienia');
    history.pushState({ v: 'uzupelnienia' }, '');
  });

  // sukces znika po dotknieciu -> wroc na liste i odswiez (pozycja schodzi po MM)
  el('uzup-sukces').addEventListener('click', () => {
    if (window.BlokadaEdycji) BlokadaEdycji.zwolnij(); // koniec edycji -> zwolnij lock
    el('uzup-sukces').classList.add('hidden');
    otworz();
  });

  // skan lokalizacji zrodlowej K4G (gdy wiele): dopasuj po kodzie do listy K4G towaru
  polaSkanuBezKlawiatury(el('uzup-zrodlo-skan'));
  onScan(el('uzup-zrodlo-skan'), (kod) => {
    // skan dziala tylko w trybie WMS (dla t_GT pole zrodla jest ukryte)
    const trafiona = (wybrany?.wms_k4g || []).find((l) => l.kod.toUpperCase() === kod);
    if (!trafiona) { komunikat(`To nie jest lokalizacja K4G tego towaru: ${kod}`, 'blad'); return; }
    komunikat('');
    wybierzZrodlo(trafiona);
    zaznaczZrodloWLiscie(trafiona.kod);
  });
})();
