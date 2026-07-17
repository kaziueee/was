// Zwroty na Zebrze: rozkladanie wozka zbudowanego na desktopie.
//
// Wozek to fizyczny przedmiot - lista pozycji to towar, ktory ktos na niego realnie polozyl
// przy wystawianiu korekty. Dlatego tu nie ma "czy to na pewno zwrot": jest, skoro lezy.
// Zadanie sprowadza sie do odniesienia kazdej sztuki na jej miejsce.
//
// Ilosc i "ile zostalo" NIE sa liczone tutaj - backend podaje `zostalo` per pozycja, liczone
// z ruchow (iloscRozlozonaZDokumentu). Dzieki temu pozycja rozlozona z karty produktu znika
// z wozka bez zadnej synchronizacji.
//
// Korzysta z globalnych el/pokazWidok/onScan (wzorzec jak sciezki.js).
(() => {
  const PODEKRANY = ['zwroty-wozki', 'zwroty-poz'];
  let wozek = null;      // { id, nazwa, status }
  let lista = [];        // pozycje z zostalo > 0
  let idx = 0;
  let potwierdzony = false;
  let lokCel = null;     // { id, kod } - ustalana skanem albo podpowiedzia

  function komunikat(t, typ) {
    const box = el('zwroty-komunikat');
    if (!t) { box.classList.add('hidden'); return; }
    box.textContent = t;
    box.className = `komunikat ${typ || ''}`;
    box.classList.remove('hidden');
  }

  function pokazPod(nazwa) {
    for (const p of PODEKRANY) el(p).classList.toggle('hidden', p !== nazwa);
  }

  function operator() {
    return (window.WMS?.user() || {}).imie || null;
  }

  // ten sam dzwiek co na sciezkach - "brak cichych porazek"
  function beep(ok) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = ok ? 880 : 220;
      gain.gain.value = 0.1;
      osc.start();
      setTimeout(() => { osc.stop(); ctx.close(); }, ok ? 90 : 260);
    } catch { /* brak audio - nie blokuje */ }
  }

  async function otworz() {
    komunikat('');
    wozek = null;
    el('zwroty-tytul').textContent = 'Zwroty';
    pokazPod('zwroty-wozki');
    el('zwroty-zatwierdz').classList.add('hidden');
    const box = el('zwroty-wozki-lista');
    box.innerHTML = '<p class="hint">Ładuję…</p>';
    el('zwroty-wozki-pusto').classList.add('hidden');
    try {
      const res = await fetch('/api/zwroty/wozki');
      const dane = await res.json();
      if (!res.ok) throw new Error(dane?.blad || `Błąd ${res.status}`);
      renderWozki((dane.wozki || []).filter((w) => w.do_rozlozenia > 0));
    } catch (err) {
      box.innerHTML = '';
      komunikat(err.message, 'blad');
    }
  }
  window.zwrotyOtworz = otworz;

  function renderWozki(wozki) {
    const box = el('zwroty-wozki-lista');
    box.innerHTML = '';
    el('zwroty-wozki-pusto').classList.toggle('hidden', wozki.length > 0);
    for (const w of wozki) {
      const div = document.createElement('button');
      div.type = 'button';
      div.className = 'lista-poz';
      div.innerHTML =
        `<span class="poz-glowna">`
        + `<span class="poz-kod">${w.nazwa || `Wózek ${w.id}`}</span>`
        + `<span class="poz-podpis">${w.do_rozlozenia} z ${w.pozycji} SKU · ${w.status}</span>`
        + `</span>`
        + `<span class="poz-prawa"><span class="poz-rez">rozłóż ›</span></span>`;
      div.addEventListener('click', () => otworzWozek(w));
      box.appendChild(div);
    }
  }

  async function otworzWozek(w) {
    komunikat('');
    try {
      const res = await fetch(`/api/zwroty/wozki/${w.id}`);
      const dane = await res.json();
      if (!res.ok) throw new Error(dane?.blad || `Błąd ${res.status}`);
      wozek = dane.wozek;
      lista = (dane.pozycje || []).filter((p) => p.zostalo > 0);
      idx = 0;
      el('zwroty-tytul').textContent = wozek.nazwa || `Wózek ${wozek.id}`;
      pokazPod('zwroty-poz');
      history.pushState({ v: 'zwroty' }, ''); // Back z rozkladania -> lista wozkow
      renderPozycja();
    } catch (err) {
      komunikat(err.message, 'blad');
    }
  }

  function renderPozycja() {
    komunikat('');
    potwierdzony = false;
    lokCel = null;
    el('zwroty-zatwierdz').classList.add('hidden');
    el('zwroty-blok-lok').classList.add('hidden');
    el('zwroty-blok-ilosc').classList.add('hidden');

    if (idx >= lista.length) {
      el('zwroty-postep').textContent = '';
      el('zwroty-karta').innerHTML = '';
      el('zwroty-skan').closest('.pole-blok').classList.add('hidden');
      el('zwroty-wyjscia').classList.add('hidden');
      el('zwroty-sukces-ikona').textContent = '🎉';
      el('zwroty-sukces-tekst').innerHTML = '<strong>Wózek rozłożony</strong>';
      el('zwroty-sukces').classList.remove('hidden');
      el('zwroty-sukces').dataset.koniec = '1';
      return;
    }

    const p = lista[idx];
    el('zwroty-postep').textContent = `Pozycja ${idx + 1} z ${lista.length}`;
    el('zwroty-skan').closest('.pole-blok').classList.remove('hidden');
    el('zwroty-wyjscia').classList.remove('hidden');
    rysujKarte(p, false);
    el('zwroty-skan-hint').textContent = 'Zeskanuj towar, aby potwierdzić właściwą pozycję.';
    el('zwroty-skan').value = '';
    el('zwroty-lok').value = '';
    el('zwroty-ilosc').value = p.zostalo;
    el('zwroty-skan').focus();
  }

  // Karta ma dwa stany, bo Zebra ma 536 px wysokosci w najgorszym razie i krok decyzyjny
  // (lokalizacja + ilosc + Odloz) MUSI zmiescic sie bez scrolla:
  //   przed skanem  - pelna: nazwa i miejsce pomagaja znalezc towar na wozku,
  //   po potwierdzeniu - zwiniana: tozsamosc jest juz potwierdzona skanem, wiec nazwa to szum,
  //     a miejsce dubluje pole "Lokalizacja" ponizej. Zostaje symbol + ile i z czego.
  function rysujKarte(p, potwierdzona) {
    el('zwroty-karta').innerHTML = potwierdzona
      ? `<strong>✓ ${p.artykul_symbol || p.artykul_gt_id}</strong>`
        + `<span class="hist-meta">${p.zostalo} szt. · ${p.zrodlo_dok}</span>`
      : `<strong>${p.artykul_symbol || p.artykul_gt_id}</strong>`
        + `<span>${p.artykul_nazwa || ''}</span>`
        + `<span>📍 ${p.lok_podpowiedz || '— brak miejsca w WMS, zeskanuj —'}</span>`
        + `<span class="hist-meta">${p.zostalo} szt. · ${p.zrodlo_dok}</span>`;
  }

  // skan towaru potwierdza tozsamosc (symbol albo EAN) - dopiero potem lokalizacja
  function obsluzSkanTowar(kod) {
    const p = lista[idx];
    if (!p) return;
    const cel = String(kod).trim().toUpperCase();
    const symbol = String(p.artykul_symbol || '').toUpperCase();
    const ean = String(p.artykul_ean || '').toUpperCase();
    if (cel !== symbol && !(ean && cel === ean)) {
      beep(false);
      komunikat(`Zeskanowano „${cel}", a oczekiwano ${symbol}. To inna pozycja.`, 'blad');
      return;
    }
    potwierdzony = true;
    komunikat('');
    // skan zrobil swoje - zwijamy pole i karte, zeby lokalizacja i ilosc zmiescily sie
    // na ekranie bez scrolla. Kolejny skan (lokalizacji) laduje juz w polu ponizej.
    el('zwroty-skan').closest('.pole-blok').classList.add('hidden');
    rysujKarte(p, true);
    el('zwroty-blok-lok').classList.remove('hidden');
    // Podpowiedz z WMS/GT wpisujemy od razu: w 99% przypadkow towar wraca na swoje miejsce,
    // wiec skan lokalizacji jest potwierdzeniem, nie praca. Pusta = trzeba zeskanowac.
    if (p.lok_podpowiedz) {
      el('zwroty-lok').value = p.lok_podpowiedz;
      el('zwroty-lok-hint').textContent = 'Podpowiedź — zeskanuj, żeby potwierdzić lub zmienić.';
      ustalLokalizacje(p.lok_podpowiedz, true);
    } else {
      el('zwroty-lok-hint').textContent = 'WMS nie zna miejsca tego SKU — zeskanuj lokalizację.';
    }
    el('zwroty-lok').focus();
  }

  // Kod lokalizacji -> id. Backend jest autorytetem (istnienie, magazyn, aktywnosc) - front
  // tylko pyta i pokazuje. `cicho` = podpowiedz przy wejsciu, bledu nie krzyczymy.
  async function ustalLokalizacje(kod, cicho) {
    try {
      const res = await fetch(`/api/lokalizacje/kod/${encodeURIComponent(String(kod).trim())}`);
      const dane = await res.json();
      if (!res.ok) throw new Error(dane?.blad || `Nie znam lokalizacji „${kod}"`);
      lokCel = { id: dane.id, kod: dane.kod };
      el('zwroty-lok').value = dane.kod;
      el('zwroty-lok-hint').textContent = `✓ ${dane.kod} (${dane.magazyn})`;
      el('zwroty-blok-ilosc').classList.remove('hidden');
      el('zwroty-zatwierdz').classList.remove('hidden');
      if (!cicho) beep(true);
    } catch (err) {
      lokCel = null;
      el('zwroty-blok-ilosc').classList.add('hidden');
      el('zwroty-zatwierdz').classList.add('hidden');
      if (!cicho) { beep(false); komunikat(err.message, 'blad'); }
      else el('zwroty-lok-hint').textContent = `Podpowiedź „${kod}" nie jest lokalizacją WMS — zeskanuj właściwą.`;
    }
  }

  function obsluzSkanLok(kod) {
    if (!potwierdzony) { beep(false); komunikat('Najpierw zeskanuj towar.', 'blad'); return; }
    ustalLokalizacje(kod, false);
  }

  async function zatwierdz() {
    const p = lista[idx];
    if (!p || !potwierdzony || !lokCel) return;
    const ilosc = Number(el('zwroty-ilosc').value);
    if (!Number.isFinite(ilosc) || ilosc <= 0) { komunikat('Podaj ilość (liczba > 0).', 'blad'); return; }
    if (ilosc > p.zostalo) { komunikat(`Na wózku jest ${p.zostalo} szt. — nie możesz odłożyć więcej.`, 'blad'); return; }

    el('zwroty-zatwierdz').disabled = true;
    try {
      // ta sama droga co "Usun ze zwrotow" na desktopie i rozkladanie z karty produktu -
      // jedno wejscie, jeden komplet inwariantow (deficyt, rezerwacja, 1 SKU = 1 lokalizacja)
      const res = await fetch('/api/ruchy/rozloz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artykul_gt_id: p.artykul_gt_id,
          mag_zrodlo_pula: 'K4',
          zrodlo_dok: p.zrodlo_dok,
          lok_cel_id: lokCel.id,
          ilosc,
          artykul_symbol: p.artykul_symbol,
          artykul_nazwa: p.artykul_nazwa,
          artykul_ean: p.artykul_ean,
          operator: operator(),
        }),
      });
      const dane = await res.json();
      if (!res.ok) throw new Error(dane?.blad || `Błąd ${res.status}`);
      beep(true);
      p.zostalo -= ilosc;
      if (p.zostalo > 0) {
        komunikat(`Odłożono ${ilosc} szt. Zostało ${p.zostalo}.`, 'ok');
        renderPozycja();
      } else {
        idx += 1;
        komunikat('Odłożone ✓', 'ok');
        setTimeout(renderPozycja, 500);
      }
    } catch (err) {
      beep(false);
      komunikat(err.message, 'blad');
    } finally {
      el('zwroty-zatwierdz').disabled = false;
    }
  }

  // "Pomin" - nie teraz. Wozek jest skonczona lista, do ktorej i tak wracamy, wiec wystarczy
  // przejsc dalej; nie ma czego zapisywac (inaczej niz na obchodzie, gdzie lista jest liczona
  // od nowa i pominieta pozycja witalaby jutro na tym samym miejscu).
  function pomin() {
    idx += 1;
    renderPozycja();
  }

  // "Brak na wozku" - lista obiecuje towar, ktorego na wozku nie ma. To NIE jest stan zero
  // (GT o wozkach nic nie wie), wiec wlasna akcja i zaden ruch WMS. Pozycja zostaje na wozku.
  async function brak() {
    const p = lista[idx];
    if (!p || !wozek) return;
    el('zwroty-brak').disabled = true;
    try {
      const res = await fetch(`/api/zwroty/wozki/${wozek.id}/brak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artykul_gt_id: p.artykul_gt_id, zrodlo_dok: p.zrodlo_dok, operator: operator() }),
      });
      const dane = await res.json();
      if (!res.ok) throw new Error(dane?.blad || `Błąd ${res.status}`);
      beep(false);
      el('zwroty-sukces-ikona').textContent = '≠';
      el('zwroty-sukces').classList.add('ostrzezenie');
      el('zwroty-sukces-tekst').innerHTML =
        `<strong>${p.artykul_symbol}</strong> — zgłoszone.<br>Nie znaleziono na wózku (${p.zostalo} szt.).`;
      el('zwroty-sukces').classList.remove('hidden');
    } catch (err) {
      komunikat(err.message, 'blad');
    } finally {
      el('zwroty-brak').disabled = false;
    }
  }

  function zamknijSukces() {
    const box = el('zwroty-sukces');
    box.classList.add('hidden');
    box.classList.remove('ostrzezenie');
    el('zwroty-sukces-ikona').textContent = '✓';
    if (box.dataset.koniec === '1') {   // "Wozek rozlozony" -> wracamy do listy wozkow
      delete box.dataset.koniec;
      history.back();
      return;
    }
    idx += 1;
    renderPozycja();
  }

  // =========================== WIRING ===========================
  el('btn-go-zwroty').addEventListener('click', () => {
    pokazWidok('zwroty');
    history.pushState({ v: 'zwroty' }, '');
  });
  el('zwroty-zatwierdz').addEventListener('click', zatwierdz);
  el('zwroty-sukces').addEventListener('click', zamknijSukces);
  el('zwroty-pomin').addEventListener('click', pomin);
  el('zwroty-brak').addEventListener('click', brak);
  el('zwroty-wstecz').addEventListener('click', () => history.back());

  el('zwroty-ilosc-minus').addEventListener('click', () => {
    const v = Number(el('zwroty-ilosc').value) || 0;
    el('zwroty-ilosc').value = Math.max(1, v - 1);
  });
  el('zwroty-ilosc-plus').addEventListener('click', () => {
    const v = Number(el('zwroty-ilosc').value) || 0;
    const max = lista[idx]?.zostalo ?? v + 1;
    el('zwroty-ilosc').value = Math.min(max, v + 1);
  });

  onScan(el('zwroty-skan'), obsluzSkanTowar);
  onScan(el('zwroty-lok'), obsluzSkanLok);
  polaSkanuBezKlawiatury(el('zwroty-skan'));
  polaSkanuBezKlawiatury(el('zwroty-lok'));
})();
