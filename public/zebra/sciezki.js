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
  // Aktualna sciezka - parametryzuje endpointy (lista / sprawdzenie / raport). Ustawiana z menu.
  let sciezkaBaza = '/api/sciezki/ostatnie-sztuki';
  let sciezkaNazwa = 'Ostatnie sztuki';

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
    el('sciezki-tytul').textContent = sciezkaNazwa;
    pokazPod('sciezki-obchod');
    history.pushState({ v: 'sciezki' }, ''); // Back z obchodu -> menu scizek (nie glowne)
    el('sciezki-karta').innerHTML = '<p class="hint">Ładuję…</p>';
    el('sciezki-pusto').classList.add('hidden');
    try {
      const res = await fetch(sciezkaBaza);
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
      el('sciezki-rez-zk').classList.add('hidden');
      el('sciezki-skan').closest('.pole-blok').classList.add('hidden');
      el('sciezki-ilosc').closest('.pole-blok').classList.add('hidden');
      el('sciezki-wyjscia').classList.add('hidden');
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
    // Ile sztuk NIE lezy na regale, tylko w strefie (nierozlozona dostawa / zwrot / przywozka).
    // Bez tego magazynier szukalby ich na polce i zglaszal niezgodnosc, ktorej nie ma - backend
    // odejmuje strefy od oczekiwanej ilosci (routes/sciezki.js), wiec ekran musi to powiedziec.
    // Liczby oczekiwanej NIE pokazujemy - liczenie ma byc w ciemno.
    const wStrefach = p.w_strefach > 0
      ? `<span class="sciezki-strefa">⚠ ${p.w_strefach} szt. leży w strefie — nie szukaj ich na regale</span>`
      : '';
    el('sciezki-karta').innerHTML =
      `<strong>${p.symbol || p.artykul_gt_id}</strong>`
      + `<span>${p.nazwa || ''}</span>`
      + `<span>📍 ${p.lokalizacja_kod}</span>`
      + wStrefach;
    // Rezerwacje na K4 (rozwijana, lazy-load) - ta sama sekcja co ekran Ruch. Pokazuje
    // sie tylko gdy rezerwacja > 0; nie zdradza liczonego stanu fizycznego (rez != stan).
    przygotujRezerwacjeZk(
      { artykul_gt_id: p.artykul_gt_id, stany_gt: { K4: { rezerwacja: p.rezerwacja ?? 0 } } },
      el('sciezki-rez-zk')
    );
    el('sciezki-wyjscia').classList.remove('hidden');
    el('sciezki-skan-hint').textContent = 'Zeskanuj towar, aby potwierdzić że jesteś przy właściwej pozycji.';
    el('sciezki-skan').value = '';
    el('sciezki-ilosc').value = '';
    el('sciezki-skan').focus();
  }

  // "Pomin" - nie teraz (zastawiona lokalizacja, brak czasu). Zapisujemy, zeby pozycja nie
  // wracala jutro na to samo miejsce listy (sort po lokalizacji), ale krotko - to nie jest
  // sprawdzenie. Bez skanu: magazynier wlasnie mowi, ze do towaru nie dotarl.
  async function pominPrzystanek() {
    const p = lista[idx];
    if (!p) return;
    el('sciezki-pomin').disabled = true;
    try {
      const res = await fetch(sciezkaBaza + '/pomin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artykul_gt_id: p.artykul_gt_id,
          artykul_symbol: p.artykul_symbol || p.symbol,
          lokalizacja_kod: p.lokalizacja_kod,
          operator: operator(),
        }),
      });
      const dane = await res.json();
      if (!res.ok) throw new Error(dane?.blad || `Błąd ${res.status}`);
      idx += 1;
      renderPrzystanek();
    } catch (err) {
      komunikat(err.message, 'blad');
    } finally {
      el('sciezki-pomin').disabled = false;
    }
  }

  // "Brak" - zgloszenie zera. To zwykle sprawdzenie z policzona iloscia 0, tylko bez skanu:
  // pustej polki nie ma jak zeskanowac. Backend porowna 0 ze stanem GT i (przy stanie > 0)
  // zapisze niezgodnosc do raportu - czyli ta sama sciezka co reczne wpisanie zera.
  async function zglosBrak() {
    const p = lista[idx];
    if (!p) return;
    el('sciezki-brak').disabled = true;
    try {
      const res = await fetch(sciezkaBaza + '/sprawdzenie', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artykul_gt_id: p.artykul_gt_id,
          artykul_symbol: p.artykul_symbol || p.symbol,
          lokalizacja_kod: p.lokalizacja_kod,
          ilosc_policzona: 0,
          operator: operator(),
        }),
      });
      const dane = await res.json();
      if (!res.ok) throw new Error(dane?.blad || `Błąd ${res.status}`);
      // Zgodne = GT tez ma 0 (pusta polka potwierdzona). Niezgodne = GT ma stan, ktorego
      // na polce nie ma - to najwazniejszy sygnal tej sciezki, wiec zatrzymanie z komunikatem.
      if (dane.zgodne) {
        beep(true);
        komunikat('Pusto — zgadza się ✓', 'ok');
        idx += 1;
        setTimeout(renderPrzystanek, 650);
      } else {
        beep(false);
        sukcesNiezgodne(p, dane);
      }
    } catch (err) {
      komunikat(err.message, 'blad');
    } finally {
      el('sciezki-brak').disabled = false;
    }
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
      const res = await fetch(sciezkaBaza + '/sprawdzenie', {
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
    el('sciezki-tytul').textContent = `Raport: ${sciezkaNazwa}`;
    pokazPod('sciezki-raport');
    history.pushState({ v: 'sciezki' }, ''); // Back z raportu -> menu scizek (nie glowne)
    const box = el('sciezki-raport-lista');
    box.innerHTML = '<p class="hint">Ładuję…</p>';
    el('sciezki-raport-pusto').classList.add('hidden');
    try {
      const res = await fetch(sciezkaBaza + '/raport');
      const dane = await res.json();
      if (!res.ok) throw new Error(dane?.blad || `Błąd ${res.status}`);
      renderRaport(dane.pozycje || []);
    } catch (err) {
      box.innerHTML = '';
      komunikat(err.message, 'blad');
    }
  }

  // Odmiana "sprawa/sprawy/spraw" wg liczby (do licznika w naglowku raportu).
  function odmianaSprawa(n) {
    if (n === 1) return 'sprawa';
    const o = n % 10, d = n % 100;
    return (o >= 2 && o <= 4 && (d < 12 || d > 14)) ? 'sprawy' : 'spraw';
  }

  // "dziś / wczoraj / N dni temu" z czasu audytu (UTC bez znacznika strefy).
  function dniTemuTekst(czas) {
    if (!czas) return '';
    const dt = new Date(String(czas).replace(' ', 'T') + 'Z');
    if (isNaN(dt.getTime())) return '';
    const dni = Math.floor((Date.now() - dt.getTime()) / 86400000);
    if (dni <= 0) return 'dziś';
    if (dni === 1) return 'wczoraj';
    return `${dni} dni temu`;
  }

  function aktualizujLicznikRaportu() {
    const box = el('sciezki-raport-lista');
    const pozostalo = box.querySelectorAll('.lista-poz').length;
    const nag = box.querySelector('.sciezki-raport-liczba');
    if (nag) nag.textContent = `${pozostalo} ${odmianaSprawa(pozostalo)} do wyjaśnienia`;
    if (pozostalo === 0) {
      if (nag) nag.remove();
      el('sciezki-raport-pusto').classList.remove('hidden');
    }
  }

  // Reczne "Załatwione" - domyka pare (artykul+lokalizacja) w backendzie (wpis audytu),
  // po czym znika z listy. Endpoint zalezy od aktywnej sciezki (sciezkaBaza).
  async function zalatwSprawe(w, div) {
    const etykieta = `${w.artykul_symbol || w.artykul_gt_id} @ ${w.lokalizacja_kod}`;
    if (!window.confirm(`Oznaczyć jako załatwione?\n${etykieta}`)) return;
    try {
      const res = await fetch(sciezkaBaza + '/niezgodnosc/zamknij', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artykul_gt_id: w.artykul_gt_id, artykul_symbol: w.artykul_symbol,
          lokalizacja_kod: w.lokalizacja_kod, operator: operator(),
        }),
      });
      const dane = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(dane?.blad || `Błąd ${res.status}`);
      beep(true);
      div.remove();
      aktualizujLicznikRaportu();
    } catch (err) {
      beep(false);
      komunikat(err.message, 'blad');
    }
  }

  function renderRaport(pozycje) {
    const box = el('sciezki-raport-lista');
    box.innerHTML = '';
    el('sciezki-raport-pusto').classList.toggle('hidden', pozycje.length > 0);
    if (pozycje.length) {
      const nag = document.createElement('p');
      nag.className = 'sciezki-raport-liczba';
      nag.textContent = `${pozycje.length} ${odmianaSprawa(pozycje.length)} do wyjaśnienia`;
      box.appendChild(nag);
    }
    for (const w of pozycje) {
      const roznica = (w.policzone != null && w.stan != null) ? (w.policzone - w.stan) : null;
      const wiek = dniTemuTekst(w.czas);
      const podpisKto = [w.uzytkownik, wiek].filter(Boolean).join(' · ');
      const div = document.createElement('div');
      div.className = 'lista-poz st-warn';
      div.innerHTML = `<span class="poz-glowna">`
        + `<span class="poz-kod">${w.artykul_symbol || w.artykul_gt_id || '—'}</span>`
        + `<span class="poz-podpis">📍 ${w.lokalizacja_kod || ''}</span>`
        + `<span class="hist-meta">${w.zrodlo || 'stan'} ${w.stan ?? '—'} · policzono ${w.policzone ?? '—'}${roznica != null ? ` (${roznica > 0 ? '+' : ''}${roznica})` : ''}</span>`
        + (podpisKto ? `<span class="hist-meta">${podpisKto}</span>` : '')
        + `</span>`
        + `<span class="poz-prawa">`
        + `<button type="button" class="sciezki-zalatw">✓ Załatwione</button>`
        + `<span class="poz-rez">otwórz ›</span>`
        + `</span>`;
      div.addEventListener('click', () => {
        if (window.ruchOtworzArtykul) window.ruchOtworzArtykul(w.artykul_symbol || w.artykul_gt_id);
      });
      div.querySelector('.sciezki-zalatw').addEventListener('click', (e) => {
        e.stopPropagation();
        zalatwSprawe(w, div);
      });
      box.appendChild(div);
    }
  }

  // =========================== WIRING ===========================
  el('btn-go-sciezki').addEventListener('click', () => {
    pokazWidok('sciezki');
    history.pushState({ v: 'sciezki' }, '');
  });
  function ustawSciezke(baza, nazwa) { sciezkaBaza = baza; sciezkaNazwa = nazwa; }
  el('btn-sciezka-ostatnie').addEventListener('click', () => { ustawSciezke('/api/sciezki/ostatnie-sztuki', 'Ostatnie sztuki'); startObchod(); });
  el('btn-sciezka-raport').addEventListener('click', () => { ustawSciezke('/api/sciezki/ostatnie-sztuki', 'Ostatnie sztuki'); otworzRaport(); });
  el('btn-sciezka-rez').addEventListener('click', () => { ustawSciezke('/api/sciezki/k4-rezerwacja', 'K4 pełna rezerwacja'); startObchod(); });
  el('btn-sciezka-rez-raport').addEventListener('click', () => { ustawSciezke('/api/sciezki/k4-rezerwacja', 'K4 pełna rezerwacja'); otworzRaport(); });
  el('sciezki-zatwierdz').addEventListener('click', zatwierdzPrzystanek);
  el('sciezki-sukces').addEventListener('click', zamknijSukces);
  el('sciezki-pomin').addEventListener('click', pominPrzystanek);
  el('sciezki-brak').addEventListener('click', zglosBrak);

  // Wstecz: z podekranu obchodu/raportu -> menu scizek; z menu scizek -> menu glowne.
  // history.back() cofa dokladnie o jeden wpis (patrz pushState w startObchod/otworzRaport
  // i handler popstate w ruch.js), wiec ekranowy i sprzetowy Back sa spojne.
  el('sciezki-wstecz').addEventListener('click', () => history.back());

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
