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
  let zgloszoneBraki = 0; // "Brak na wozku" w tym przejsciu - do podsumowania na koncu
  // Kontekst do ochrony domu WMS przy zmianie lokalizacji (dociagany per pozycja, best-effort):
  //   domWms - kod domu K4 w WMS (case A) albo null (WMS nie zna - case B),
  //   stanK4 / zapas - stany GT (zapas = K4+K4G+LS, ta sama suma co "Czysc zera").
  let kontekst = null;
  let przeniesDom = false; // czlowiek POTWIERDZIL przeniesienie martwego domu (zapas=0) na skan
  const golyKod = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  function komunikat(t, typ) {
    const box = el('zwroty-komunikat');
    if (!t) { box.classList.add('hidden'); return; }
    box.textContent = t;
    box.className = `komunikat ${typ || ''}`;
    box.classList.remove('hidden');
  }

  function pokazPod(nazwa) {
    for (const p of PODEKRANY) el(p).classList.toggle('hidden', p !== nazwa);
    // Naglowek "Wózek ..." zabiera ~50px u gory - przy rozkladaniu zbedny (jestes juz w wozku,
    // jego numer siedzi w linii postepu). Chowamy na ekranie pozycji, zostaje na liscie wozkow.
    el('zwroty-naglowek').classList.toggle('hidden', nazwa === 'zwroty-poz');
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
        + `<span class="poz-kod">${w.etykieta}</span>`
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
      zgloszoneBraki = 0;
      el('zwroty-tytul').textContent = wozek.etykieta;
      pokazPod('zwroty-poz');
      history.pushState({ v: 'zwroty' }, ''); // Back z rozkladania -> lista wozkow
      renderPozycja();
    } catch (err) {
      komunikat(err.message, 'blad');
    }
  }

  // Rezerwacje i zestawy dla biezacej pozycji - te same rozwijane sekcje co na ekranie Ruch
  // (przygotujRezerwacjeZk / przygotujZestawy z ruch.js, globalne). Kontekst best-effort: gdy GT
  // nie odpowie, po prostu ich nie ma - nie blokuje rozkladania. Jeden fetch /skan/:symbol daje
  // stany_gt (rezerwacja K4) i w_zestawach.
  async function pokazKontekstProduktu(p) {
    const boxRez = el('zwroty-rez-zk');
    const boxZest = el('zwroty-zestawy');
    boxRez.classList.add('hidden'); boxRez.innerHTML = '';
    boxZest.classList.add('hidden'); boxZest.innerHTML = '';
    try {
      // Jeden przebieg: /skan (stany_gt -> rezerwacje/zestawy + stanK4/zapas) i /k4-dom (dom WMS).
      const [resSkan, resDom] = await Promise.all([
        fetch(`/api/lokalizacje/skan/${encodeURIComponent(p.artykul_symbol)}`),
        fetch(`/api/lokalizacje/k4-dom/${encodeURIComponent(p.artykul_gt_id)}`),
      ]);
      if (lista[idx] !== p) return;   // pozycja zmieniona w miedzyczasie (szybkie taps)
      const dane = resSkan.ok ? await resSkan.json() : null;
      const dom = resDom.ok ? await resDom.json() : null;
      const il = (m) => dane?.stany_gt?.[m]?.ilosc ?? 0;
      kontekst = { domWms: dom?.kod ?? null, stanK4: il('K4'), zapas: il('K4') + il('K4G') + il('LS') };
      if (dane) {
        const artykul = {
          artykul_gt_id: p.artykul_gt_id,
          artykul_symbol: p.artykul_symbol,
          stany_gt: dane.stany_gt,
          w_zestawach: dane.w_zestawach,
        };
        if (typeof przygotujRezerwacjeZk === 'function') przygotujRezerwacjeZk(artykul, boxRez);
        if (typeof przygotujZestawy === 'function') przygotujZestawy(artykul, boxZest);
      }
    } catch { /* kontekst best-effort - nie blokuje odkladania */ }
  }

  // Odwrocony przeplyw (2026-07-22): NAJPIERW lokalizacja, potem towar. Powod - obchod z
  // magazynierami: przy starym "skan towaru -> marsz -> skan lokalizacji" tozsamosc gubila sie
  // po marszu ("biore z wozka, nie wiem juz ktory"). Teraz ekran prowadzi (duza lokalizacja +
  // nazwa "wez to"), skan lokalizacji = "jestem na miejscu", skan towaru = "to ten". Nic sie
  // nie zwija - lokalizacja i nazwa widoczne caly czas. Obecnosc lokCel decyduje o ekranie 1/2.
  function renderPozycja() {
    komunikat('');
    potwierdzony = false;
    lokCel = null;
    kontekst = null;
    przeniesDom = false;
    el('zwroty-zatwierdz').classList.add('hidden');
    el('zwroty-blok-skan').classList.add('hidden');
    el('zwroty-blok-ilosc').classList.add('hidden');
    el('zwroty-rez-zk').classList.add('hidden');
    el('zwroty-zestawy').classList.add('hidden');

    if (idx >= lista.length) {
      el('zwroty-postep').textContent = '';
      el('zwroty-karta').innerHTML = '';
      el('zwroty-blok-lok').classList.add('hidden');
      el('zwroty-wyjscia').classList.add('hidden');
      pokazKoniecWozka();
      return;
    }

    const p = lista[idx];
    el('zwroty-postep').textContent =
      `${wozek?.etykieta ? wozek.etykieta + ' · ' : ''}Pozycja ${idx + 1} z ${lista.length}`;
    el('zwroty-blok-lok').classList.remove('hidden');
    el('zwroty-wyjscia').classList.remove('hidden');
    rysujKarte(p);
    el('zwroty-lok-hint').textContent = p.lok_podpowiedz
      ? 'Zeskanuj lokalizację, gdy dojdziesz.'
      : 'Zanieś tam, gdzie kładziesz, i zeskanuj lokalizację.';
    el('zwroty-lok').value = '';
    el('zwroty-skan').value = '';
    el('zwroty-ilosc').value = p.zostalo;
    el('zwroty-lok').focus();
    pokazKontekstProduktu(p);   // rezerwacje + zestawy (nieblokujaco)
  }

  // Karta trzyma tozsamosc na wierzchu w OBU krokach (koniec "nie wiem juz ktory towar"):
  //   ekran 1 (bez lokCel) - prowadzi: DUZA lokalizacja docelowa + "wez z wozka" (SKU podpis
  //     nad DUZA nazwa) + wyeksponowana ilosc; nazwa jest tym, po czym poznaje sie sztuke.
  //   ekran 2 (po skanie lokalizacji) - lokalizacja potwierdzona u gory, ten sam blok towaru.
  // SKU maly (podpis, "na tle"), nazwa duza - decyzja magazyniera z hali 2026-07-22. Stan
  // (lokCel / potwierdzony) czytany z domkniecia, wiec render to funkcja jednego argumentu.
  function rysujKarte(p) {
    const sku = p.artykul_symbol || p.artykul_gt_id;
    // Ilosc jako duza liczba tylko na ekranie 1 ("ile wziac z wozka"). Na ekranie 2 trzyma ja
    // stepper ponizej - podwojna ilosc na karcie tylko rozpychalaby ciasny ekran odkladania.
    const iloscBlok = lokCel ? ''
      : `<div class="zwroty-ilosc-duza"><span class="zwroty-ilosc-liczba">${p.zostalo}</span><span class="zwroty-ilosc-jedn">szt.</span></div>`;
    const towar =
      `<div class="zwroty-towar">`
      + `<div class="zwroty-towar-tekst">`
      +   `<span class="zwroty-sku">${sku}${potwierdzony ? ' ✓' : ''} · ${lokCel ? 'potwierdź towar' : 'weź z wózka'}</span>`
      +   `<strong class="zwroty-nazwa">${p.artykul_nazwa || sku}</strong>`
      + `</div>`
      + iloscBlok
      + `</div>`;
    if (!lokCel) {
      // ekran 1 - prowadzacy. Pusta podpowiedz nie udaje kodu - mowi, co zrobic zamiast tego.
      const miejsce = p.lok_podpowiedz
        ? `<span class="karta-lok">${p.lok_podpowiedz}</span>`
        : `<span class="karta-lok karta-lok--brak">Brak miejsca w WMS — zeskanuj, gdzie kładziesz</span>`;
      el('zwroty-karta').innerHTML = `<span class="zwroty-prowadzi">Idź do</span>` + miejsce + towar;
    } else {
      // ekran 2 - przy polce
      el('zwroty-karta').innerHTML =
        `<span class="zwroty-lok-ok">✓ ${lokCel.kod} — jesteś na miejscu</span>` + towar;
    }
  }

  // Koniec listy pozycji to NIE to samo co "wozek rozlozony": pominiecia zostawiaja towar na
  // wozku, a wozek na liscie do rozlozenia. Falszywe 🎉 kazalo szukac bledu w liczniku, ktory
  // liczyl dobrze - klamal ekran.
  //
  // Zgloszony brak to trzeci przypadek: backend zdejmuje taka pozycje z wozka (wraca oznaczona
  // na liste zwrotow), wiec NIE liczy sie do "zostalo" - inaczej ekran obiecywalby towar,
  // ktorego na wozku juz nie ma.
  function pokazKoniecWozka() {
    const naWozku = lista.filter((p) => p.zostalo > 0 && !p.zdjeteJakoBrak).length;
    const odlozono = lista.filter((p) => p.zostalo <= 0).length;
    const box = el('zwroty-sukces');
    if (!naWozku && !zgloszoneBraki) {
      el('zwroty-sukces-ikona').textContent = '🎉';
      el('zwroty-sukces-tekst').innerHTML = '<strong>Wózek rozłożony</strong>';
    } else {
      el('zwroty-sukces-ikona').textContent = '⚠';
      box.classList.add('ostrzezenie');
      el('zwroty-sukces-tekst').innerHTML =
        `<strong>Koniec wózka</strong><br>`
        + `Odłożono ${odlozono} z ${lista.length}`
        + (zgloszoneBraki ? ` · ${zgloszoneBraki} zgłoszone jako brak (zdjęte z wózka)` : '')
        + (naWozku ? ` · zostało ${naWozku}` : '')
        + `.<br>`
        + (naWozku ? 'Wózek czeka dalej na liście.' : 'Wózek zjechał z listy.');
    }
    box.classList.remove('hidden');
    box.dataset.koniec = '1';
  }

  // Skan towaru = KROK 2 (po lokalizacji): potwierdza, ze biore wlasciwa sztuke z wozka.
  function obsluzSkanTowar(kod) {
    const p = lista[idx];
    if (!p) return;
    if (!lokCel) { beep(false); komunikat('Najpierw zeskanuj lokalizację.', 'blad'); return; }
    const cel = String(kod).trim().toUpperCase();
    const symbol = String(p.artykul_symbol || '').toUpperCase();
    const ean = String(p.artykul_ean || '').toUpperCase();
    if (cel !== symbol && !(ean && cel === ean)) {
      beep(false);
      komunikat(`Zeskanowano „${cel}", a oczekiwano ${symbol}. To inna pozycja.`, 'blad');
      return;
    }
    potwierdzTowar(false);
  }

  // Ekran 2: lokalizacja potwierdzona -> pokaz krok potwierdzenia towaru + ilosc + Odloz.
  // Pole lokalizacji chowamy (zrobilo swoje), towar i ilosc zostaja widoczne bez scrolla.
  function przejdzDoProdukt() {
    const p = lista[idx];
    if (!p) return;
    el('zwroty-blok-lok').classList.add('hidden');
    // Rezerwacje/zestawy byly kontekstem DECYZJI na ekranie 1; przy polce (ekran 2) zabieraja
    // tylko wysokosc potrzebna akcji (skan towaru + ilosc + Odloz) na ciasnym 536 px.
    el('zwroty-rez-zk').classList.add('hidden');
    el('zwroty-zestawy').classList.add('hidden');
    el('zwroty-blok-skan').classList.remove('hidden');
    el('zwroty-blok-ilosc').classList.remove('hidden');
    el('zwroty-zatwierdz').classList.remove('hidden');
    rysujKarte(p);
    el('zwroty-skan-hint').textContent = 'Zeskanuj towar, żeby potwierdzić.';
    el('zwroty-skan').value = '';
    el('zwroty-skan').focus();
    // Komunikat o zmianie lokalizacji (blok/info/przeniesienie) ustawia decyzjaLokalizacji -
    // przejdzDoProdukt go NIE czysci, zeby przetrwal na ekranie 2 (patrz ustalLokalizacje).
  }

  // Potwierdzenie towaru (krok 2) - skanem albo recznie ("Nie skanuje sie", gdy EAN sie nie
  // czyta, a klepanie symbolu na Zebrze to droga przez meke). Dopiero potwierdzony towar wolno
  // odlozyc (zatwierdz sprawdza `potwierdzony`).
  function potwierdzTowar(bezSkanu) {
    const p = lista[idx];
    if (!p) return;
    potwierdzony = true;
    beep(true);
    komunikat(bezSkanu ? 'Potwierdzone bez skanu.' : '', bezSkanu ? 'info' : undefined);
    rysujKarte(p);            // dopisze ✓ przy SKU
    el('zwroty-ilosc').focus();
    el('zwroty-ilosc').select();
  }

  // Ile "wiecej info" pokazac, gdy skanowana lokalizacja != dom WMS. WMS jest masterem
  // lokalizacji, wiec zmiana ma inne skutki zaleznie od tego, czy dom istnieje i czy gdzies jest
  // jeszcze towar (zapas = K4+K4G+LS, ta sama suma co "Czysc zera"):
  //   brak domu WMS (case B) -> ustalasz miejsce 1. raz, wolno (info gdy inne niz podpowiedz GT),
  //   dom + zapas > 0        -> dom zywy, BLOK (odbij na dom; K4 = 1 SKU = 1 miejsce),
  //   dom + zapas = 0        -> dom martwy wszedzie, CONFIRM przeniesienia (bezpieczne).
  // Kontekst niezaladowany (szybki skan przed fetchem) -> 'ok': nie blokujemy na braku danych.
  function decyzjaLokalizacji(scannedKod) {
    const k = kontekst;
    const p = lista[idx];
    if (!k || !k.domWms) {
      if (k && !k.domWms && p?.lok_podpowiedz && golyKod(scannedKod) !== golyKod(p.lok_podpowiedz)) {
        komunikat(`WMS nie znał miejsca tego SKU (GT: ${p.lok_podpowiedz}). ${scannedKod} zapisze się jako dom.`, 'info');
      }
      return 'ok';
    }
    if (golyKod(scannedKod) === golyKod(k.domWms)) return 'ok';   // skan domu - bez zmiany
    if (k.zapas > 0) {
      komunikat(k.stanK4 > 0
        ? `Dom tego SKU to ${k.domWms} — leży tam towar. K4 = 1 SKU = 1 miejsce: odłóż na ${k.domWms}.`
        : `Dom to ${k.domWms}. Towar wróci tam z K4G/LS (${k.zapas} szt.) — odłóż na ${k.domWms}.`, 'blad');
      return 'blok';
    }
    return 'confirm';   // dom + zapas 0 = martwy wszedzie -> bezpieczne przeniesienie
  }

  // Skan lokalizacji (KROK 1) -> ustala cel i przechodzi do potwierdzenia towaru. Backend jest
  // autorytetem (istnienie, magazyn, aktywnosc) - front tylko pyta i pokazuje.
  async function ustalLokalizacje(kod) {
    try {
      const res = await fetch(`/api/lokalizacje/kod/${encodeURIComponent(String(kod).trim())}`);
      const dane = await res.json();
      if (!res.ok) throw new Error(dane?.blad || `Nie znam lokalizacji „${kod}"`);
      const scanned = { id: dane.id, kod: dane.kod };
      komunikat('');   // czyscimy ewentualny stary blad; decyzja ustawi swoj (blok/info) i przetrwa
      const decyzja = decyzjaLokalizacji(scanned.kod);
      if (decyzja === 'blok') { beep(false); return; }   // komunikat ustawiony w decyzji, zostajemy na skanie
      if (decyzja === 'confirm') {
        beep(false);
        if (!window.confirm(`Jesteś na złej lokalizacji — dom to ${kontekst.domWms} (stan 0). Zmienić lokalizację na ${scanned.kod}?`)) {
          komunikat(`Anulowano — zeskanuj ${kontekst.domWms} albo inną lokalizację.`, 'info');
          return;
        }
        przeniesDom = true;   // backend zwolni stary pusty dom przy zapisie
        komunikat(`Dom przeniesiony na ${scanned.kod}.`, 'info');
      }
      lokCel = scanned;
      beep(true);
      przejdzDoProdukt();
    } catch (err) {
      lokCel = null;
      beep(false);
      komunikat(err.message, 'blad');
    }
  }

  function obsluzSkanLok(kod) {
    if (!lista[idx]) return;
    ustalLokalizacje(kod);
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
          przenies_dom: przeniesDom,
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
  // (GT o wozkach nic nie wie), wiec wlasna akcja i zaden ruch WMS. Backend zdejmuje pozycje
  // z wozka i zwraca ja na liste zwrotow oznaczona jako "nie znaleziono" (routes/zwroty.js).
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
      zgloszoneBraki += 1;
      p.zdjeteJakoBrak = true;   // backend zdjal ja z wozka - patrz pokazKoniecWozka
      beep(false);
      el('zwroty-sukces-ikona').textContent = '≠';
      el('zwroty-sukces').classList.add('ostrzezenie');
      el('zwroty-sukces-tekst').innerHTML =
        `<strong>${p.artykul_symbol}</strong> — zgłoszone (${p.zostalo} szt.).<br>`
        + `Zdjęte z wózka, wróciło na listę zwrotów.`;
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
  el('zwroty-bez-skanu').addEventListener('click', () => {
    if (!lokCel) { beep(false); komunikat('Najpierw zeskanuj lokalizację.', 'blad'); return; }
    potwierdzTowar(true);
  });
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
