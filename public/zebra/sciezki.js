// Ekran Zebry "Ścieżki" (Faza 6) - zadania obchodu magazynu z checklistą.
// Ścieżka 1 "Ostatnie sztuki": lista lokalizacji K4 ze stanem ≤5, obchód w kolejności
// zbierania. Skan towaru + policzona ilość -> backend porównuje ze stanem WMS:
//   zgodne   -> zdarzenie 'sprawdzenie_stanu', szybkie przejście dalej,
//   niezgodne -> zdarzenie 'sprawdzenie_niezgodne' (raport), zatrzymanie z komunikatem.
// Nie robi ruchów WMS - z raportu można wejść w normalny ekran Ruch (window.ruchOtworzArtykul).
// Korzysta z globalnych el/pokazWidok/onScan.

(function () {
  'use strict';

  const PODEKRANY = ['sciezki-menu', 'sciezki-obchod', 'sciezki-raport'];
  let lista = [];   // przystanki obchodu
  let idx = 0;      // biezacy przystanek
  let potwierdzony = false; // czy zeskanowano wlasciwy towar na tym przystanku

  function komunikat(t, typ) {
    const k = el('sciezki-komunikat');
    if (!t) { k.className = 'komunikat hidden'; return; }
    k.textContent = t;
    k.className = `komunikat ${typ || 'info'}`;
  }

  function pokazPod(nazwa) {
    for (const p of PODEKRANY) el(p).classList.toggle('hidden', p !== nazwa);
    el('sciezki-zatwierdz').classList.add('hidden');
  }

  function operator() {
    return localStorage.getItem('wms_operator') || null;
  }

  // krotki sygnal: ok = wyzszy ton, blad = nizszy (rozne, by nie pomylic - "brak cichych porazek")
  let audioCtx = null;
  function beep(ok) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = ok ? 880 : 300;
      o.connect(g); g.connect(audioCtx.destination);
      g.gain.setValueAtTime(0.15, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + (ok ? 0.15 : 0.4));
      o.start(); o.stop(audioCtx.currentTime + (ok ? 0.15 : 0.4));
    } catch { /* dzwiek best-effort */ }
  }

  // --- wejscie do widoku: zawsze menu scizek ---
  function otworz() {
    komunikat('');
    el('sciezki-tytul').textContent = 'Ścieżki';
    pokazPod('sciezki-menu');
  }
  window.sciezkiOtworz = otworz;

  // =========================== SCIEZKA: OSTATNIE SZTUKI ===========================
  async function startObchod() {
    komunikat('');
    el('sciezki-tytul').textContent = 'Ostatnie sztuki';
    pokazPod('sciezki-obchod');
    el('sciezki-karta').innerHTML = '<p class="hint">Ładuję…</p>';
    el('sciezki-pusto').classList.add('hidden');
    try {
      const res = await fetch('/api/sciezki/ostatnie-sztuki');
      const dane = await res.json();
      if (!res.ok) throw new Error(dane?.blad || `Błąd ${res.status}`);
      lista = dane.pozycje || [];
      idx = 0;
      renderPrzystanek();
    } catch (err) {
      el('sciezki-karta').innerHTML = '';
      komunikat(err.message, 'blad');
    }
  }

  function renderPrzystanek() {
    komunikat('');
    potwierdzony = false;
    el('sciezki-zatwierdz').classList.add('hidden');

    if (idx >= lista.length) {
      // koniec obchodu
      el('sciezki-postep').textContent = '';
      el('sciezki-karta').innerHTML = '';
      el('sciezki-skan').closest('.pole-blok').classList.add('hidden');
      el('sciezki-ilosc').closest('.pole-blok').classList.add('hidden');
      el('sciezki-pusto').textContent = lista.length
        ? `Sprawdzono ${lista.length} ${lista.length === 1 ? 'pozycję' : 'pozycji'}. 🎉`
        : 'Brak produktów do sprawdzenia. 🎉';
      el('sciezki-pusto').classList.remove('hidden');
      return;
    }

    const p = lista[idx];
    el('sciezki-postep').textContent = `Pozycja ${idx + 1} z ${lista.length}`;
    el('sciezki-skan').closest('.pole-blok').classList.remove('hidden');
    el('sciezki-ilosc').closest('.pole-blok').classList.add('hidden'); // ilosc dopiero po skanie
    el('sciezki-pusto').classList.add('hidden');
    el('sciezki-karta').innerHTML =
      `<strong>${p.symbol || p.artykul_gt_id}</strong>`
      + `<span>${p.nazwa || ''}</span>`
      + `<span>📍 ${p.lokalizacja_kod}</span>`;
    el('sciezki-skan-hint').textContent = 'Zeskanuj towar, aby potwierdzić że jesteś przy właściwej pozycji.';
    el('sciezki-skan').value = '';
    el('sciezki-ilosc').value = '';
    el('sciezki-skan').focus();
  }

  // skan potwierdza tozsamosc towaru (symbol lub EAN); dopiero wtedy pole ilosci
  function obsluzSkanObchod(kod) {
    const p = lista[idx];
    if (!p) return;
    const cel = String(kod).trim().toUpperCase();
    const symbol = String(p.symbol || '').toUpperCase();
    const ean = String(p.ean || '').toUpperCase();
    if (cel === symbol || (ean && cel === ean)) {
      potwierdzony = true;
      komunikat('');
      el('sciezki-skan-hint').textContent = '✓ Zgodny towar — wpisz policzoną ilość.';
      el('sciezki-ilosc').closest('.pole-blok').classList.remove('hidden');
      el('sciezki-zatwierdz').classList.remove('hidden');
      el('sciezki-ilosc').focus();
      el('sciezki-ilosc').select();
    } else {
      beep(false);
      komunikat(`Zeskanowano „${cel}", a oczekiwano ${symbol}. To inna pozycja.`, 'blad');
    }
  }

  async function zatwierdzPrzystanek() {
    const p = lista[idx];
    if (!p || !potwierdzony) return;
    const policzone = Number(el('sciezki-ilosc').value);
    if (!Number.isFinite(policzone) || policzone < 0) {
      komunikat('Podaj policzoną ilość (liczba ≥ 0).', 'blad');
      return;
    }
    el('sciezki-zatwierdz').disabled = true;
    try {
      const res = await fetch('/api/sciezki/ostatnie-sztuki/sprawdzenie', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artykul_gt_id: p.artykul_gt_id,
          artykul_symbol: p.artykul_symbol || p.symbol,
          lokalizacja_kod: p.lokalizacja_kod,
          ilosc_policzona: policzone,
          operator: operator(),
        }),
      });
      const dane = await res.json();
      if (!res.ok) throw new Error(dane?.blad || `Błąd ${res.status}`);
      if (dane.zgodne) {
        beep(true);
        komunikat('Zgadza się ✓', 'ok');
        idx += 1;
        setTimeout(renderPrzystanek, 650); // szybkie przejscie dalej przy zgodzie
      } else {
        beep(false);
        sukcesNiezgodne(p, dane);
      }
    } catch (err) {
      komunikat(err.message, 'blad');
    } finally {
      el('sciezki-zatwierdz').disabled = false;
    }
  }

  // niezgodnosc: zatrzymanie z komunikatem (magazynier ma to zauwazyc), tap -> nastepny
  function sukcesNiezgodne(p, dane) {
    el('sciezki-sukces-ikona').textContent = '≠';
    el('sciezki-sukces').classList.add('ostrzezenie');
    el('sciezki-sukces-tekst').innerHTML =
      `<strong>${p.symbol}</strong> — do raportu.<br>`
      + `${dane.zrodlo || 'Stan'}: ${dane.stan} szt. · policzono: ${dane.policzone} szt. (${dane.roznica > 0 ? '+' : ''}${dane.roznica})`;
    el('sciezki-sukces').classList.remove('hidden');
  }

  function zamknijSukces() {
    el('sciezki-sukces').classList.add('hidden');
    el('sciezki-sukces').classList.remove('ostrzezenie');
    el('sciezki-sukces-ikona').textContent = '✓';
    idx += 1;
    renderPrzystanek();
  }

  // =========================== RAPORT NIEZGODNOSCI ===========================
  async function otworzRaport() {
    komunikat('');
    el('sciezki-tytul').textContent = 'Raport niezgodności';
    pokazPod('sciezki-raport');
    const box = el('sciezki-raport-lista');
    box.innerHTML = '<p class="hint">Ładuję…</p>';
    el('sciezki-raport-pusto').classList.add('hidden');
    try {
      const res = await fetch('/api/sciezki/ostatnie-sztuki/raport');
      const dane = await res.json();
      if (!res.ok) throw new Error(dane?.blad || `Błąd ${res.status}`);
      renderRaport(dane.pozycje || []);
    } catch (err) {
      box.innerHTML = '';
      komunikat(err.message, 'blad');
    }
  }

  function renderRaport(pozycje) {
    const box = el('sciezki-raport-lista');
    box.innerHTML = '';
    el('sciezki-raport-pusto').classList.toggle('hidden', pozycje.length > 0);
    for (const w of pozycje) {
      const roznica = (w.policzone != null && w.stan != null) ? (w.policzone - w.stan) : null;
      const div = document.createElement('div');
      div.className = 'lista-poz st-warn';
      div.innerHTML = `<span class="poz-glowna">`
        + `<span class="poz-kod">${w.artykul_symbol || w.artykul_gt_id || '—'}</span>`
        + `<span class="poz-podpis">📍 ${w.lokalizacja_kod || ''}</span>`
        + `<span class="hist-meta">${w.zrodlo || 'stan'} ${w.stan ?? '—'} · policzono ${w.policzone ?? '—'}${roznica != null ? ` (${roznica > 0 ? '+' : ''}${roznica})` : ''}</span>`
        + `</span>`
        + `<span class="poz-prawa"><span class="poz-rez">otwórz ›</span></span>`;
      div.addEventListener('click', () => {
        if (window.ruchOtworzArtykul) window.ruchOtworzArtykul(w.artykul_symbol || w.artykul_gt_id);
      });
      box.appendChild(div);
    }
  }

  // =========================== WIRING ===========================
  el('btn-go-sciezki').addEventListener('click', () => {
    pokazWidok('sciezki');
    history.pushState({ v: 'sciezki' }, '');
  });
  el('btn-sciezka-ostatnie').addEventListener('click', startObchod);
  el('btn-sciezka-raport').addEventListener('click', otworzRaport);
  el('sciezki-zatwierdz').addEventListener('click', zatwierdzPrzystanek);
  el('sciezki-sukces').addEventListener('click', zamknijSukces);

  // Wstecz: z podekranu obchodu/raportu -> menu scizek; z menu scizek -> menu glowne
  el('sciezki-wstecz').addEventListener('click', () => {
    if (el('sciezki-menu').classList.contains('hidden')) otworz();
    else pokazWidok('menu');
  });

  // stepper ilosci
  el('sciezki-ilosc-minus').addEventListener('click', () => {
    const v = Number(el('sciezki-ilosc').value) || 0;
    el('sciezki-ilosc').value = Math.max(0, v - 1);
  });
  el('sciezki-ilosc-plus').addEventListener('click', () => {
    const v = Number(el('sciezki-ilosc').value) || 0;
    el('sciezki-ilosc').value = v + 1;
  });

  onScan(el('sciezki-skan'), obsluzSkanObchod);
  polaSkanuBezKlawiatury(el('sciezki-skan'));
})();
