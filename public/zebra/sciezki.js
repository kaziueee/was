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
  // Licznik przystankow zamknietych liczeniem vs pominietych - podsumowanie na koncu obchodu
  // musi je rozroznic, inaczej "pomin wszystko" konczy sie falszywym "Sprawdzono N pozycji".
  let sprawdzone = 0;
  let pominiete = 0;
  // Sciezki opisane w JEDNYM miejscu: endpoint, akcja zatwierdzenia, sposob czytania
  // odpowiedzi i teksty ekranu. Nowa sciezka = wpis tutaj, a NIE ify rozsiane po pliku
  // (CLAUDE.md / [[fanout-wariant-bez-recznej-listy]]: nowy wariant nie moze wymagac
  // recznej rewizji konsumentow - tak gina cale funkcje).
  //
  // Obchod "licz i porownaj" - wspolny dla scizek weryfikacyjnych.
  const OBCHOD_LICZENIE = {
    akcja: '/sprawdzenie',
    udane: (d) => d.zgodne,
    tekstUdane: 'Zgadza się ✓',
    tekstUdaneBrak: 'Pusto — zgadza się ✓',
    etykietaZatwierdz: 'Zgadza się ✓',
    etykietaBrak: 'Brak (0 szt.)',
    etykietaSkan: 'Zeskanuj towar z półki',
    placeholderSkan: 'Skanuj SKU / EAN',
    tekstPusto: 'Brak produktów do sprawdzenia. 🎉',
    hintSkan: 'Potwierdź, że to właściwa pozycja.',
    opisNiezgodne: (d) =>
      `${d.zrodlo || 'Stan'}: ${d.stan} szt. · policzono: ${d.policzone} szt. (${d.roznica > 0 ? '+' : ''}${d.roznica})`,
  };

  const SCIEZKI = {
    'ostatnie-sztuki': { ...OBCHOD_LICZENIE, nazwa: 'Ostatnie sztuki', baza: '/api/sciezki/ostatnie-sztuki' },
    'k4-rezerwacja': { ...OBCHOD_LICZENIE, nazwa: 'K4 pełna rezerwacja', baza: '/api/sciezki/k4-rezerwacja' },
    // Obchod "zwolnij slot" - inny cel, wiec inne teksty i inna akcja. Tozsamosc potwierdza
    // kod LOKALIZACJI, nie towaru: polka ma byc pusta, wiec nie ma czego z niej zeskanowac.
    'czysc-zera': {
      nazwa: 'Czyść zera',
      baza: '/api/sciezki/czysc-zera',
      akcja: '/zwolnienie',
      udane: (d) => d.zwolnione,
      tekstUdane: 'Slot zwolniony ✓',
      tekstUdaneBrak: 'Slot zwolniony ✓',
      etykietaZatwierdz: 'Zwolnij slot ✓',
      etykietaBrak: 'Pusto — zwolnij slot',
      etykietaSkan: 'Zeskanuj kod lokalizacji',
      placeholderSkan: 'Skanuj lokalizację',
      tekstPusto: 'Brak slotów do zwolnienia. 🎉',
      hintSkan: 'Potwierdź, że stoisz przy właściwym slocie.',
      potwierdzaLokalizacja: true,
      iloscDomyslna: '0',
      // Slot ZOSTAJE - albo cos na nim lezy, albo GT zdazyl pokazac stan (lista byla nieaktualna).
      // Zapas = K4+K4G+LS (bez MAG) - ten sam rachunek, ktory wpuscil pozycje na liste.
      opisNiezgodne: (d) => (d.policzone > 0
        ? `Na slocie leży ${d.policzone} szt. — slot zostaje, sprawa do raportu.`
        : `GT pokazuje ${d.stan} szt. na K4, zapas ${d.zapas} — slot zostaje.`),
    },
    // Inny GATUNEK sciezki: tu sie nie LICZY, tylko UZUPELNIA dane. Po potwierdzeniu
    // tozsamosci zamiast steppera ilosci otwiera sie ekran Parametry, a zapis idzie przez
    // PUT /api/produkty/:id/atrybuty (jedno miejsce walidacji). Stad brak akcja/udane/
    // opisNiezgodne - nie ma czego porownywac, wiec nie ma "niezgodnosci" ani raportu.
    'brak-parametrow': {
      nazwa: 'Brak parametrów',
      baza: '/api/sciezki/brak-parametrow',
      tryb: 'parametry',
      etykietaSkan: 'Zeskanuj towar',
      placeholderSkan: 'Skanuj SKU / EAN',
      tekstPusto: 'Wszystkie towary mają parametry. 🎉',
      hintSkan: 'Potwierdź, że mierzysz właściwy towar.',
    },
  };

  let sciezka = SCIEZKI['ostatnie-sztuki'];
  // Podniesione na czas pobytu na ekranie Parametry - zob. otworz(): decyduje, czy powrot
  // do widoku Sciezek ma wznowic obchod, czy pokazac menu.
  let wracamyZParametrow = false;

  function komunikat(t, typ) {
    const k = el('sciezki-komunikat');
    if (!t) { k.className = 'komunikat hidden'; return; }
    k.textContent = t;
    k.className = `komunikat ${typ || 'info'}`;
  }

  // Odpowiedz bledu bywa HTML-em (404 z Expressa, ekran proxy), a nie JSON-em. Gdy res.json()
  // idzie PRZED sprawdzeniem statusu, magazynier dostaje "Unexpected token '<'" zamiast bledu -
  // porazka glosna, ale nie do odczytania. Status czytamy pierwszy, tresc best-effort.
  async function odczytaj(res) {
    const tekst = await res.text();
    let dane = null;
    try { dane = tekst ? JSON.parse(tekst) : null; } catch { /* nie-JSON: zostaje sam status */ }
    if (!res.ok) throw new Error(dane?.blad || `Błąd ${res.status}`);
    return dane ?? {};
  }

  function pokazPod(nazwa) {
    for (const p of PODEKRANY) el(p).classList.toggle('hidden', p !== nazwa);
    el('sciezki-zatwierdz').classList.add('hidden');
  }

  // operator() = globalny helper z kreator.js (zalogowany profil). Wlasnej kopii tu nie
  // trzymamy - poprzednia czytala martwy klucz localStorage 'wms_operator' i dawala null.

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

  // --- wejscie do widoku: menu scizek, ALE nie gdy wracamy z ekranu Parametry ---
  // Sprzetowy Back z Parametrow odpala popstate -> pokazWidok('sciezki') -> ten handler.
  // Bez wyjatku ponizej resetowalby obchod do menu i lista (500 pozycji) przepadala,
  // wiec magazynier musialby zaczac od nowa. Wracamy na te sama pozycje - Back to
  // "nie tym razem", a nie "zrobione", wiec idx celowo NIE idzie do przodu.
  function otworz() {
    if (wracamyZParametrow) {
      wracamyZParametrow = false;
      pokazPod('sciezki-obchod');
      renderPrzystanek();
      return;
    }
    komunikat('');
    el('sciezki-tytul').textContent = 'Ścieżki';
    pokazPod('sciezki-menu');
  }
  window.sciezkiOtworz = otworz;

  // =========================== SCIEZKA: OSTATNIE SZTUKI ===========================
  async function startObchod() {
    komunikat('');
    el('sciezki-tytul').textContent = sciezka.nazwa;
    // Teksty z konfiguracji: "Zgadza się" i "Zwolnij slot" to dwie rozne obietnice, a ten
    // sam przycisk obsluguje obie sciezki - etykieta musi mowic, co naprawde zrobi.
    // Tryb "parametry" nie ma kroku liczenia, wiec nie ma tez "Zgadza sie" ani "Brak (0 szt.)".
    // Bez tego zwijania w przyciskach wyladowaloby doslowne "undefined".
    const bezLiczenia = sciezka.tryb === 'parametry';
    el('sciezki-zatwierdz').textContent = sciezka.etykietaZatwierdz ?? '';
    el('sciezki-brak').textContent = sciezka.etykietaBrak ?? '';
    el('sciezki-brak').classList.toggle('hidden', bezLiczenia);
    document.querySelector('label[for="sciezki-skan"]').textContent = sciezka.etykietaSkan;
    el('sciezki-skan').placeholder = sciezka.placeholderSkan;
    pokazPod('sciezki-obchod');
    history.pushState({ v: 'sciezki' }, ''); // Back z obchodu -> menu scizek (nie glowne)
    el('sciezki-karta').innerHTML = '<p class="hint">Ładuję…</p>';
    el('sciezki-pusto').classList.add('hidden');
    try {
      const res = await fetch(sciezka.baza);
      const dane = await odczytaj(res);
      lista = dane.pozycje || [];
      idx = 0;
      sprawdzone = 0;
      pominiete = 0;
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
      // Uczciwe podsumowanie: pominiecie to nie sprawdzenie. Przy samych pominieciach
      // ekran ma mowic, ze robota czeka - nie gratulowac obchodu, ktorego nie bylo.
      el('sciezki-pusto').textContent = !lista.length
        ? sciezka.tekstPusto
        : (pominiete === 0
          ? `Sprawdzono ${sprawdzone} ${odmianaPozycji(sprawdzone)}. 🎉`
          : `Koniec listy — sprawdzono ${sprawdzone} z ${lista.length}, pominięto ${pominiete}. Pominięte wrócą na listę za tydzień.`);
      el('sciezki-pusto').classList.remove('hidden');
      return;
    }

    const p = lista[idx];
    el('sciezki-postep').textContent = `Pozycja ${idx + 1} z ${lista.length}`;
    el('sciezki-skan').closest('.pole-blok').classList.remove('hidden');
    el('sciezki-ilosc').closest('.pole-blok').classList.add('hidden'); // ilosc dopiero po skanie
    el('sciezki-pusto').classList.add('hidden');
    rysujKarte(p, null);
    // Rezerwacje na K4 (rozwijana, lazy-load) - ta sama sekcja co ekran Ruch. Pokazuje
    // sie tylko gdy rezerwacja > 0; nie zdradza liczonego stanu fizycznego (rez != stan).
    przygotujRezerwacjeZk(
      { artykul_gt_id: p.artykul_gt_id, stany_gt: { K4: { rezerwacja: p.rezerwacja ?? 0 } } },
      el('sciezki-rez-zk')
    );
    el('sciezki-wyjscia').classList.remove('hidden');
    // krotko i w jednej linii - etykieta pola mowi juz "Zeskanuj towar z polki", a kazda
    // zawinieta linia zjada wysokosc potrzebna wyjsciom (Pomin / Brak) przy 536 px
    el('sciezki-skan-hint').textContent = sciezka.hintSkan;
    el('sciezki-skan').value = '';
    // Sciezki weryfikacyjne licza W CIEMNO (puste pole). "Czysc zera" podpowiada 0: oczekiwana
    // wartosc nie jest tu sekretem (cala lista to sloty, ktore maja byc puste), a zwolnienie
    // slotu schodzi do jednego tapu po skanie.
    el('sciezki-ilosc').value = sciezka.iloscDomyslna ?? '';
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
      const res = await fetch(sciezka.baza + '/pomin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artykul_gt_id: p.artykul_gt_id,
          artykul_symbol: p.artykul_symbol || p.symbol,
          lokalizacja_kod: p.lokalizacja_kod,
          operator: operator(),
        }),
      });
      const dane = await odczytaj(res);
      pominiete += 1;
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
      const res = await fetch(sciezka.baza + sciezka.akcja, {
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
      const dane = await odczytaj(res);
      sprawdzone += 1;   // zero to tez wynik liczenia, nie pominiecie
      // Zgodne = GT tez ma 0 (pusta polka potwierdzona). Niezgodne = GT ma stan, ktorego
      // na polce nie ma - to najwazniejszy sygnal tej sciezki, wiec zatrzymanie z komunikatem.
      if (sciezka.udane(dane)) {
        beep(true);
        komunikat(sciezka.tekstUdaneBrak, 'ok');
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

  // Karta przystanku. Lokalizacja NAJPIERW i duza: na obchodzie pierwsza decyzja to "dokad
  // ide", a symbol czyta sie dopiero przy towarze. Ostrzezenie o strefie zostaje w kazdym
  // stanie - jest potrzebne wlasnie przy liczeniu.
  //   stan null       - przed potwierdzeniem: pelna karta (nazwa pomaga znalezc towar),
  //   stan 'skan'     - tozsamosc potwierdzona skanem: nazwa to juz szum,
  //   stan 'bez-skanu' - potwierdzil czlowiek: nazwa ZOSTAJE, bo jest jedyna weryfikacja.
  function rysujKarte(p, stan) {
    // Ile sztuk NIE lezy na regale, tylko w strefie (nierozlozona dostawa / zwrot / przywozka).
    // Bez tego magazynier szukalby ich na polce i zglaszal niezgodnosc, ktorej nie ma - backend
    // odejmuje strefy od oczekiwanej ilosci (routes/sciezki.js), wiec ekran musi to powiedziec.
    // Liczby oczekiwanej NIE pokazujemy - liczenie ma byc w ciemno.
    const wStrefach = p.w_strefach > 0
      ? `<span class="sciezki-strefa">⚠ ${p.w_strefach} szt. leży w strefie — nie szukaj ich na regale</span>`
      : '';
    const znacznik = stan === 'skan' ? '✓ ' : (stan === 'bez-skanu' ? '⚠ ' : '');
    el('sciezki-karta').innerHTML =
      `<span class="karta-lok">${p.lokalizacja_kod}</span>`
      + `<strong>${znacznik}${p.symbol || p.artykul_gt_id}${stan === 'bez-skanu' ? ' — bez skanu' : ''}</strong>`
      + (stan === 'skan' ? '' : `<span>${p.nazwa || ''}</span>`)
      + wStrefach;
  }

  // Odblokowanie kroku liczenia. Tozsamosc potwierdza skan albo - gdy EAN sie nie czyta -
  // sam magazynier ("Nie skanuje sie"). Pole skanu zwijamy razem z przyciskiem: zrobilo swoje,
  // a krok liczenia (ilosc + Zgadza sie + wyjscia) musi zmiescic sie bez scrolla na 536 px.
  function odblokujLiczenie(bezSkanu) {
    const p = lista[idx];
    if (!p) return;

    // Tryb "parametry": tozsamosc potwierdzona, ale nie ma czego liczyc - oddajemy ekran
    // Parametry, a po zapisie (albo Wstecz) wracamy tutaj i przechodzimy do nastepnej
    // pozycji. Lista zostaje w pamieci, wiec obchod sie nie gubi.
    if (sciezka.tryb === 'parametry') {
      // Bez tego brak parametry.js (blad ladowania, cache) konczy sie cichym TypeError
      // i obchod zamiera. Ten sam guard co do-sprawdzenia.js przy ruchOtworzArtykul.
      if (!window.parametryOtworz) {
        komunikat('Ekran Parametry niedostępny — odśwież aplikację.', 'blad');
        return;
      }
      komunikat('');
      wracamyZParametrow = true;
      window.parametryOtworz(p.artykul_gt_id, {
        symbol: p.symbol,
        nazwa: p.nazwa,
        // zapisano=false przy "Wstecz" - wtedy pozycja NIE liczy sie jako zrobiona,
        // inaczej podsumowanie chwaliloby sie obchodem, ktorego nie bylo.
        powrot: (zapisano) => {
          wracamyZParametrow = false;   // jawne wyjscie - nie chcemy sciezki przez otworz()
          pokazWidok('sciezki');
          pokazPod('sciezki-obchod');
          if (zapisano) sprawdzone += 1;
          idx += 1;
          renderPrzystanek();
        },
      });
      return;
    }

    potwierdzony = true;
    komunikat('');
    el('sciezki-skan').closest('.pole-blok').classList.add('hidden');
    rysujKarte(p, bezSkanu ? 'bez-skanu' : 'skan');
    el('sciezki-ilosc').closest('.pole-blok').classList.remove('hidden');
    el('sciezki-zatwierdz').classList.remove('hidden');
    el('sciezki-ilosc').focus();
    el('sciezki-ilosc').select();
  }

  // skan potwierdza tozsamosc towaru (symbol lub EAN); dopiero wtedy pole ilosci
  // Kod lokalizacji bez myslnikow - stare naklejki maja "A8P2" zamiast "A8-P2"
  // (to samo obejscie co normalizujKodLokalizacji w backendzie).
  const golyKod = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  function obsluzSkanObchod(kod) {
    const p = lista[idx];
    if (!p) return;
    const cel = String(kod).trim().toUpperCase();
    const symbol = String(p.symbol || '').toUpperCase();
    const ean = String(p.ean || '').toUpperCase();
    // "Czysc zera" potwierdza sie kodem LOKALIZACJI - polka ma byc pusta, wiec nie ma z niej
    // czego zeskanowac. Symbol/EAN przyjmujemy tez: naklejka bywa jeszcze na regale.
    const lokOk = sciezka.potwierdzaLokalizacja && golyKod(cel) === golyKod(p.lokalizacja_kod);
    if (lokOk || cel === symbol || (ean && cel === ean)) {
      odblokujLiczenie(false);
    } else {
      beep(false);
      komunikat(sciezka.potwierdzaLokalizacja
        ? `Zeskanowano „${cel}", a oczekiwano lokalizacji ${p.lokalizacja_kod}.`
        : `Zeskanowano „${cel}", a oczekiwano ${symbol}. To inna pozycja.`, 'blad');
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
      const res = await fetch(sciezka.baza + sciezka.akcja, {
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
      const dane = await odczytaj(res);
      sprawdzone += 1;
      if (sciezka.udane(dane)) {
        beep(true);
        komunikat(sciezka.tekstUdane, 'ok');
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
      `<strong>${p.symbol}</strong> — do raportu.<br>${sciezka.opisNiezgodne(dane)}`;
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
    el('sciezki-tytul').textContent = `Raport: ${sciezka.nazwa}`;
    pokazPod('sciezki-raport');
    history.pushState({ v: 'sciezki' }, ''); // Back z raportu -> menu scizek (nie glowne)
    const box = el('sciezki-raport-lista');
    box.innerHTML = '<p class="hint">Ładuję…</p>';
    el('sciezki-raport-pusto').classList.add('hidden');
    try {
      const res = await fetch(sciezka.baza + '/raport');
      const dane = await odczytaj(res);
      renderRaport(dane.pozycje || []);
    } catch (err) {
      box.innerHTML = '';
      komunikat(err.message, 'blad');
    }
  }

  // Odmiana "pozycje/pozycji" wg liczby (do podsumowania obchodu; 1 obsluzone osobno).
  function odmianaPozycji(n) {
    if (n === 1) return 'pozycję';
    const o = n % 10, d = n % 100;
    return (o >= 2 && o <= 4 && (d < 12 || d > 14)) ? 'pozycje' : 'pozycji';
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
  // po czym znika z listy. Endpoint zalezy od aktywnej sciezki (sciezka.baza).
  async function zalatwSprawe(w, div) {
    const etykieta = `${w.artykul_symbol || w.artykul_gt_id} @ ${w.lokalizacja_kod}`;
    if (!window.confirm(`Oznaczyć jako załatwione?\n${etykieta}`)) return;
    try {
      const res = await fetch(sciezka.baza + '/niezgodnosc/zamknij', {
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
  function ustawSciezke(klucz) { sciezka = SCIEZKI[klucz]; }
  el('btn-sciezka-ostatnie').addEventListener('click', () => { ustawSciezke('ostatnie-sztuki'); startObchod(); });
  el('btn-sciezka-raport').addEventListener('click', () => { ustawSciezke('ostatnie-sztuki'); otworzRaport(); });
  el('btn-sciezka-rez').addEventListener('click', () => { ustawSciezke('k4-rezerwacja'); startObchod(); });
  el('btn-sciezka-rez-raport').addEventListener('click', () => { ustawSciezke('k4-rezerwacja'); otworzRaport(); });
  el('btn-sciezka-zera').addEventListener('click', () => { ustawSciezke('czysc-zera'); startObchod(); });
  el('btn-sciezka-zera-raport').addEventListener('click', () => { ustawSciezke('czysc-zera'); otworzRaport(); });
  el('btn-sciezka-parametry').addEventListener('click', () => { ustawSciezke('brak-parametrow'); startObchod(); });
  el('sciezki-zatwierdz').addEventListener('click', zatwierdzPrzystanek);
  el('sciezki-sukces').addEventListener('click', zamknijSukces);
  el('sciezki-pomin').addEventListener('click', pominPrzystanek);
  el('sciezki-brak').addEventListener('click', zglosBrak);
  el('sciezki-bez-skanu').addEventListener('click', () => { if (lista[idx]) odblokujLiczenie(true); });

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
