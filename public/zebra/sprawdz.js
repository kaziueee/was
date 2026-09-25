// Sprawdzarka (Zebra): jeden ekran do PODGLADU - "co tu lezy" (skan lokalizacji) i "gdzie to
// lezy" (skan SKU/EAN, wpisana nazwa). Zadnej operacji, zadnego pola ilosci, zadnego zapisu.
//
// PO CO OSOBNY EKRAN, skoro Ruch pokazuje to samo: zeby pytanie "gdzie jest ten towar" dalo
// sie zadac bez wchodzenia na ekran, ktory potrafi wystawic MM. Dotad jedyna droga do
// odpowiedzi prowadzila przez Ruch, wiec (a) uczen nie mial jak sprawdzic polki, mimo ze to
// czynnosc bez ryzyka, (b) kazdy inny "tylko zobaczyc" konczyl sie w kreatorze z polem ilosci
// i zajetym lockiem edycji produktu (BlokadaEdycji) - czyli towar wygladal na zajety przez
// kogos, kto tylko patrzyl.
//
// CZEGO TU NIE MA I DLACZEGO: ani jednego wejscia w Ruch (ruchOtworzArtykul), ani jednego
// zapisu. Tap w pozycje otwiera KOLEJNY PODGLAD, nie operacje - ekran nie ma wiec sciezki,
// ktora konczy sie zmiana stanu. Granica nie stoi jednak na tym, czego front nie narysowal:
// backend przepuszcza uczniowi WYLACZNIE odczyty /skan i /skan-id (app.js, blokujUcznia),
// wiec dolozenie tu kiedys przycisku nie otworzyloby mu zapisu (CLAUDE.md zasada 5).
//
// Wzorzec pliku jak historia.js / przywozki.js: IIFE na globalnych el / pokazWidok / onScan
// i na helperach karty produktu (karta-produktu.js, ruch.js).
(() => {
  'use strict';

  // Lokalizacja, z ktorej weszlismy w produkt - Wstecz wraca na jej zawartosc. Trzymamy sam
  // KOD, nie kopie listy: powrot idzie przez ponowne zapytanie, wiec zawartosc jest zawsze
  // swieza (kopia w pamieci klamie, gdy ktos w tym czasie cos z tej polki zdjal).
  //
  // Ustawia go WYLACZNIE tap w pozycje; kazdy SKAN zeruje go, bo skan to nowy punkt startu.
  let zLokalizacji = null;

  function komunikat(t, typ) {
    const box = el('spr-komunikat');
    if (!t) { box.className = 'komunikat hidden'; return; }
    box.textContent = t;
    box.className = `komunikat ${typ || 'info'}`;
  }

  function czyscWynik() {
    for (const id of ['spr-karta', 'spr-podsumowanie', 'spr-fakty']) {
      const box = el(id);
      box.innerHTML = '';
      box.classList.add('hidden');
    }
    const lista = el('spr-lista');
    lista.innerHTML = '';
    lista.classList.remove('spr-rozklad');   // klase wlacza tylko rozklad produktu
  }

  function ustaw(id, html) {
    const box = el(id);
    box.innerHTML = html || '';
    box.classList.toggle('hidden', !html);
  }

  // wiersz faktu: etykieta + wartosc (wartosc moze byc wielolinijkowa - <br> miedzy liniami)
  function fakt(etykieta, wartosc) {
    if (!wartosc) return '';
    return `<div class="spr-fakt"><span class="spr-fakt-etykieta">${etykieta}</span>`
      + `<span class="spr-fakt-wartosc">${wartosc}</span></div>`;
  }

  // Czy stany w tej odpowiedzi pochodza z GT (routes/lokalizacje.js, dolaczDaneGt). Przy
  // padnietym GT payload przychodzi bez stanow - ale "brak stanu" i "nie wiem" to na ekranie
  // do SPRAWDZANIA dwie zupelnie rozne odpowiedzi, a tylko pierwsza jest liczba. Nie zgadujemy
  // wiec po pustym polu: albo backend potwierdzil, ze pytal GT, albo mowimy wprost, ze nie wie.
  const zGt = (dane) => dane.gt_ok !== false;

  // Etykieta przycisku Wstecz mowi, DOKAD wraca - inaczej przy wejsciu w produkt z polki
  // wyglada jak wyjscie z ekranu (a wychodzi sie stad dopiero drugim tapem).
  function odswiezWstecz() {
    el('spr-wstecz').textContent = zLokalizacji ? `← ${zLokalizacji}` : '← Wstecz';
  }

  // --- wejscia ---

  // Skan / wpisany tekst: kod rozwiazuje BACKEND (lokalizacja / SKU / EAN / nazwa), tak samo
  // jak na ekranie Ruch. Tozsamosc towaru rozstrzyga przy tym GT, nie kopia symbolu w WMS.
  async function pokazKod(kod) {
    komunikat('');
    zLokalizacji = null;   // skan = nowy punkt startu, nie zaglebienie sie w polke
    let dane;
    try {
      const res = await fetch(`/api/lokalizacje/skan/${encodeURIComponent(kod)}`);
      dane = await res.json().catch(() => ({}));
      if (!res.ok) {
        // zostaw slad czego szukano: kod wraca do pola (zaznaczony, by kolejny skan go zastapil)
        const pole = el('spr-skan');
        pole.value = kod;
        try { pole.select(); } catch { /* pole moze nie wspierac select() */ }
        komunikat(res.status === 404 ? `Nie znaleziono: „${kod}”` : (dane?.blad || `Błąd ${res.status}`), 'blad');
        return;
      }
    } catch {
      komunikat('Błąd połączenia z serwerem', 'blad');
      return;
    }
    if (dane.typ === 'lokalizacja') renderujLokalizacje(dane);
    else if (dane.typ === 'lista_artykulow') renderujListe(dane.artykuly, dane.obciete, dane.kolizja_symbolu, zGt(dane));
    else renderujProdukt(dane);
  }

  // Wejscie w produkt z listy idzie po tw_Id, nie po symbolu: napis w wierszu to KOPIA
  // kartoteki GT, a ta w Subiekcie zmienia sie w kazdej chwili (CLAUDE.md, "Tozsamosc towaru").
  async function pokazProdukt(artykulGtId, zPolki = null) {
    komunikat('');
    try {
      const res = await fetch(`/api/lokalizacje/skan-id/${encodeURIComponent(artykulGtId)}`);
      const dane = await res.json().catch(() => ({}));
      if (!res.ok || dane.typ !== 'artykul') {
        komunikat(dane?.blad || `Nie znaleziono artykułu (tw_Id ${artykulGtId})`, 'blad');
        return;
      }
      zLokalizacji = zPolki;
      renderujProdukt(dane);
    } catch {
      komunikat('Błąd połączenia z serwerem', 'blad');
    }
  }

  // --- wynik: lokalizacja ("co tu lezy") ---

  function renderujLokalizacje(dane) {
    const { lokalizacja, zawartosc } = dane;
    czyscWynik();
    odswiezWstecz();
    if (!zGt(dane)) komunikat('GT nie odpowiada — widać tylko to, co wie WMS.', 'info');

    // Cechy slotu z samej bazy (typ jest wyliczany z kodu, przeznaczenie nadaje czlowiek) -
    // bez zapytania o /slowniki: uczen go nie dostaje, a same wartosci sa czytelne po polsku.
    // "towar" pomijamy - to domysl, wiec wpisywanie go w kazda karte byloby szumem.
    const cechy = [lokalizacja.typ, lokalizacja.przeznaczenie !== 'towar' ? lokalizacja.przeznaczenie : '']
      .filter(Boolean).join(' · ');
    const suma = zawartosc.reduce((s, p) => s + (p.ilosc || 0), 0);
    // Kod polki duzy (klasa karta-lok, ta sama co na karcie przystanku w Sciezkach) - przy
    // skanie lokalizacji to on jest glowna informacja: "gdzie jestem".
    ustaw('spr-karta',
      `<strong class="karta-lok">${esc(lokalizacja.kod)} <span class="chip chip-magazyn">${esc(lokalizacja.magazyn)}</span></strong>`
      + (cechy ? `<span>${esc(cechy)}</span>` : '')
      + `<span>${zawartosc.length ? `${liczbaArtykulow(zawartosc.length)} · ${suma} szt.` : 'pusto'}</span>`);

    if (zawartosc.length === 0) {
      // Pusta polka to prawdziwa odpowiedz, nie blad - stad hint, a nie czerwony komunikat.
      el('spr-lista').innerHTML = '<p class="hint">Nic tu nie leży — ani wg WMS, ani wg pól lokalizacyjnych GT.</p>';
      return;
    }

    const lista = el('spr-lista');
    for (const p of zawartosc) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lista-poz ' + statusBarKlasa(p.zgodnosc);
      // t_GT: tego wiersza nie ma w WMS na tej polce - stoi tu wg pol wlasnych GT, a ilosc
      // jest stanem CALEGO magazynu, nie tej polki. Mowimy to wprost, zeby liczba nie udawala
      // zawartosci polki.
      const prawa = `<span class="poz-ilosc">${p.ilosc} szt.</span>`
        + (p.tylko_gt ? `<span class="poz-rez">cały ${esc(lokalizacja.magazyn)}</span>` : '');
      btn.innerHTML = `<span class="poz-glowna">`
        + `<span class="poz-kod">${esc(p.artykul_symbol)} ${statusZgodnosciBadge(p)}</span>`
        + `<span class="poz-nazwa">${esc(p.artykul_nazwa)}</span>`
        + `<span class="poz-podpis">${p.tylko_gt
          ? 'tylko wg pól GT — WMS nie ma tu tego towaru'
          : (zGt(dane) ? esc(stanSkrotKarty(p.stany_gt)) : 'stan wg GT nieznany')}</span>`
        + `</span>`
        + `<span class="poz-prawa">${prawa}</span>`
        + `<span class="poz-strzalka">›</span>`;
      btn.addEventListener('click', () => pokazProdukt(p.artykul_gt_id, lokalizacja.kod));
      lista.appendChild(btn);
    }
  }

  // --- wynik: produkt ("gdzie to lezy") ---

  // Kolejnosc rozkladu: K4 (polka zbioru - to jest pytanie numer jeden), potem K4G, potem
  // magazyny zewnetrzne, na koncu to, co lezy POZA polka (strefy). Ta sama kolejnosc i ten sam
  // komponent wiersza, co rozklad zrodel na ekranie Ruch - magazynier czyta jeden uklad, nie dwa.
  const KOLEJNOSC_MAG = { K4: 0, K4G: 1 };

  // Kod lokalizacji z pol wlasnych GT dla magazynu ("K4: L13 / | K4G: L18P2 /" -> "L13 /").
  // Ta sama funkcja, ktorej uzywa Ruch (ruch.js) - podajemy tylko wlasny artykul zamiast stanu
  // kreatora, zeby regula parsowania zostala JEDNA.
  const lokZPolaGt = (dane, mag) => gtLokDlaMagazynu(mag, dane);

  // Pola GT sa pisane RECZNIE, wiec ta sama polka siedzi tam w roznych ortografiach: z myslnikiem
  // i bez (M2-F28 / M2F28), z dopiskiem ilosci "M2-J24-P2(440)" i z czlonem "/zapas". Porownujemy
  // wiec "po gole" - ta sama zasada, co tokenyLokalizacjiZPola po stronie backendu.
  const goloKod = (k) => String(k || '').toUpperCase().split('/')[0]
    .replace(/\(.*?\)/g, '').replace(/[\s-]/g, '');
  const tokenyPolaGt = (tekst) => String(tekst || '').split(';').map((t) => t.trim()).filter(Boolean);

  // Wiersze rozkladu: co, gdzie i ile. Kazdy niesie magazyn (plakietka + kolor), kod (duzy),
  // ilosc i ewentualna rezerwacje. Rodzaj mowi, SKAD wiemy: wms / gt (tylko pole GT) /
  // brak (nie wie nikt) / zew (magazyn bez lokalizacji) / strefa (poza polka).
  function wierszeRozkladu(dane) {
    const wiersze = [];
    const stany = dane.stany_gt || {};
    const lok = [...(dane.lokalizacje || [])].sort((a, b) =>
      (KOLEJNOSC_MAG[a.magazyn] ?? 9) - (KOLEJNOSC_MAG[b.magazyn] ?? 9) || (a.ilosc - b.ilosc));

    // Rezerwacja jest na poziomie MAGAZYNU, wiec pokazujemy ja raz - przy pierwszym jego wierszu
    // (jak w rozkladzie Ruchu). Inaczej ta sama liczba powtarzalaby sie przy kazdej polce K4G.
    const rezPokazana = {};
    const rezDla = (mag) => {
      const r = !rezPokazana[mag] ? (stany[mag]?.rezerwacja ?? 0) : 0;
      rezPokazana[mag] = true;
      return r;
    };

    // K4 = 1 SKU = 1 lokalizacja: pokazujemy PRAWDZIWA polke (polka_k4 z backendu = min(kopia
    // WMS, stan GT - strefy)). Surowa kopia WMS klamie w gore, dopoki job rozjazdow nie sciagnie
    // jej do stanu GT - a sprawdzarka istnieje wlasnie po to, zeby nie klamac o polce.
    const liczbaK4 = lok.filter((l) => l.magazyn === 'K4').length;
    for (const l of lok) {
      wiersze.push({
        rodzaj: 'wms',
        mag: l.magazyn,
        kod: l.kod,
        podpis: l.zapas_kod ? `zapas: ${l.zapas_kod}` : '',
        ilosc: l.magazyn === 'K4' && liczbaK4 === 1 && dane.polka_k4 != null ? dane.polka_k4 : l.ilosc,
        rez: rezDla(l.magazyn),
      });
    }

    // Czego WMS nie zna, a GT ma na stanie. Najlepsza dostepna odpowiedz na "gdzie to lezy" jest
    // wtedy w polu wlasnym GT - wiec to ONA idzie w duzy kod, a podpis mowi, skad pochodzi.
    // Dopiero gdy i tam pusto, wiersz robi sie czerwony: nie wie nikt.
    for (const mag of ['K4', 'K4G']) {
      const stanMag = stany[mag]?.ilosc ?? 0;
      const wms = lok.filter((l) => l.magazyn === mag).reduce((s, l) => s + l.ilosc, 0);
      // K4: bierzemy tylko czesc NIEwyjasniona dokumentem - dostawa/zwrot/przywozka/PW maja
      // wlasne wiersze nizej (backend rozbija to w nieprzypisane_k4).
      const brak = mag === 'K4' && dane.nieprzypisane_k4 != null
        ? dane.nieprzypisane_k4
        : Math.max(stanMag - wms, 0);
      if (brak <= 0) continue;
      const tokeny = tokenyPolaGt(lokZPolaGt(dane, mag));
      const wTymMag = wiersze.filter((w) => w.rodzaj === 'wms' && w.mag === mag);
      const nieznane = tokeny.filter((t) => !wTymMag.some((w) => goloKod(w.kod) === goloKod(t)));

      // GT wskazuje DOKLADNIE te polki, ktore WMS juz zna - osobny wiersz powtarzalby ten sam
      // kod dwa razy z dwiema roznymi liczbami ("ta sama polka, dwie historie"). Sztuki bez
      // przypisania doliczamy wiec do wiersza polki (fizycznie leza wlasnie tam wg GT), a w
      // podpisie zostaje, ile z tego WMS ma faktycznie rozpisane.
      if (tokeny.length > 0 && nieznane.length === 0 && wTymMag.length > 0) {
        const w = wTymMag[0];
        w.plan = `w WMS rozpisane: ${w.ilosc} szt. — reszta bez przypisania`;
        w.ilosc += brak;
        continue;
      }

      wiersze.push({
        rodzaj: nieznane.length ? 'gt' : 'brak',
        mag,
        kod: nieznane.join(' · ') || 'BRAK MIEJSCA',
        podpis: nieznane.length ? 'wg pól GT — WMS nie zna tego miejsca' : 'nie wie ani WMS, ani GT',
        ilosc: brak,
        rez: rezDla(mag),
      });
    }

    for (const m of magazynyLista.filter((mg) => mg.typ === 'zewnetrzny')) {
      const w = stany[m.kod];
      if (!w || w.ilosc <= 0) continue;
      wiersze.push({ rodzaj: 'zew', mag: m.kod, kod: m.nazwa, podpis: 'magazyn zewnętrzny', ilosc: w.ilosc, rez: w.rezerwacja || 0 });
    }

    // Poza polka: paleta z dostawy, zwrot/przywozka/PW w strefie. Jedna lista z backendu
    // (wszystkie_k4), wiec nowy rodzaj dokumentu wpada tu sam (CLAUDE.md: fan-out bez listy).
    for (const d of dane.wszystkie_k4 || []) {
      wiersze.push({
        rodzaj: 'strefa',
        mag: 'K4',
        kod: rodzajDok(d).naglowek,
        podpis: rodzajDok(d).opis + (d.fz_nr ? ` · ${krotkiNrDok(d.fz_nr)}` : ''),
        ilosc: d.ilosc,
        rez: 0,
      });
    }

    return wiersze;
  }

  function wierszRozkladu(w) {
    const div = document.createElement('div');
    // Kolor magazynu na plakietce i lewym pasku - jak w rozkladzie Ruchu. Strefy zostaja
    // niebieskie (.brak.dostawa), "nie wie nikt" czerwone (.brak): oba niosa wlasny sygnal,
    // wiec nie kolorujemy ich magazynem.
    const magKlasa = (w.rodzaj === 'strefa' || w.rodzaj === 'brak') ? '' : ' mag-' + String(w.mag).toLowerCase();
    const wariant = w.rodzaj === 'strefa' ? ' brak dostawa' : (w.rodzaj === 'brak' ? ' brak' : '');
    div.className = 'lista-poz' + magKlasa + wariant;
    div.innerHTML = `<span class="poz-mag">${esc(w.mag)}</span>`
      + `<span class="poz-glowna"><span class="poz-kod">${esc(w.kod)}</span>`
      + (w.podpis ? `<span class="poz-podpis">${esc(w.podpis)}</span>` : '')
      + (w.plan ? `<span class="poz-plan">${esc(w.plan)}</span>` : '')
      + `</span>`
      + `<span class="poz-prawa"><span class="poz-ilosc">${w.ilosc} szt.</span>`
      + (w.rez > 0 ? `<span class="poz-rez">(${w.rez} rez.)</span>` : '')
      + `</span>`;
    return div;
  }

  // Marker `zLokalizacji` ustawia WOLAJACY (pokazKod zeruje, pokazProdukt podaje polke) -
  // render tylko go czyta, zeby podpisac przycisk Wstecz.
  function renderujProdukt(dane) {
    czyscWynik();
    odswiezWstecz();

    if (!zGt(dane)) komunikat('GT nie odpowiada — widać tylko to, co wie WMS.', 'info');

    ustaw('spr-karta', `<strong>${esc(dane.artykul_symbol)} ${statusZgodnosciBadge(dane)}</strong>`
      + `<span>${esc(dane.artykul_nazwa)}</span>`);

    // "Laczny stan" = Razem (bez BRK i K4R) - odpowiedz na "ile mam do sprzedania"; stan na
    // Brakach widac nizej, w rozkladzie per magazyn. Dopisek: sztuki zamrozone w zestawach.
    const wZest = dane.w_zestawach || 0;
    ustaw('spr-podsumowanie', zGt(dane)
      ? `<span>Łączny stan: <b>${sumaRazemGt(dane.stany_gt)} szt.</b>`
        + (wZest > 0 ? ` <span class="podsumowanie-zest">(+${wZest} w zestawach)</span>` : '') + `</span>`
        + `<span class="podsumowanie-sep"></span>`
        + `<span>Rezerwacje: <b>${sumaRezerwacji(dane.stany_gt)}</b></span>`
      : `<span>Łączny stan: <b>—</b> (stan trzyma GT, a GT nie odpowiada)</span>`);

    // ROZKLAD - glowna tresc ekranu: gdzie lezy i ile. Wieksze kody i ilosci niz na liscie
    // zawartosci polki (klasa spr-rozklad), bo to jest odpowiedz, po ktora sie tu przyszlo.
    const lista = el('spr-lista');
    lista.classList.add('spr-rozklad');
    const wiersze = wierszeRozkladu(dane);
    if (wiersze.length === 0) {
      lista.innerHTML = zGt(dane)
        ? '<p class="hint">Brak stanu — nie ma tego towaru w żadnym magazynie.</p>'
        : '<p class="hint">WMS nie zna miejsca tego towaru, a GT nie odpowiada.</p>';
    } else {
      for (const w of wiersze) lista.appendChild(wierszRozkladu(w));
    }

    // Drobiazgi pod rozkladem - tekst pola GT (widac tez czlon /zapas i znacznik zgodnosci)
    // oraz ostrzezenie, gdy kopia polki WMS jest wyzsza niz stan GT. Fakty z GT pokazujemy
    // TYLKO gdy GT odpowiedzial: "pole puste" byloby inaczej twierdzeniem o czyms, czego nikt
    // nie sprawdzil.
    ustaw('spr-fakty',
      (zGt(dane) ? fakt('Pola lokalizacyjne GT', esc(formatLokalizacjaGt(dane.lokalizacja_gt)) || 'puste') : '')
      + (dane.polka_k4_klamie
        ? fakt('Uwaga', `kopia WMS dla K4 jest wyższa niż stan GT — na półce może leżeć ${dane.polka_k4} szt.`)
        : ''));
  }

  // --- wynik: lista artykulow (szukanie po nazwie, kolizja symbolu) ---

  function renderujListe(artykuly, obciete, kolizjaSymbolu, gtOk = true) {
    czyscWynik();
    odswiezWstecz();
    ustaw('spr-karta', `<strong>${kolizjaSymbolu
      ? `„${esc(kolizjaSymbolu)}” to ${liczbaArtykulow(artykuly.length)}`
      : `Znaleziono ${liczbaArtykulow(artykuly.length)}`}</strong><span>Dotknij, żeby zobaczyć szczegóły.</span>`);

    const lista = el('spr-lista');
    for (const p of artykuly) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lista-poz ' + statusBarKlasa(p.zgodnosc);
      const lok = p.lokalizacja_gt?.tekst ? p.lokalizacja_gt.tekst.replace(/ \| /g, ' · ') : '';
      btn.innerHTML = `<span class="poz-glowna">`
        + `<span class="poz-kod">${esc(p.artykul_symbol)} ${statusZgodnosciBadge(p)}</span>`
        + `<span class="poz-nazwa">${esc(p.artykul_nazwa)}</span>`
        + `<span class="poz-podpis">${gtOk ? esc(stanSkrotKarty(p.stany_gt)) : 'stan wg GT nieznany'}</span>`
        + (lok ? `<span class="poz-podpis poz-lok">${esc(lok)}</span>` : '')
        + `</span>`
        + `<span class="poz-strzalka">›</span>`;
      btn.addEventListener('click', () => pokazProdukt(p.artykul_gt_id));
      lista.appendChild(btn);
    }

    if (kolizjaSymbolu) {
      komunikat(`Ten sam kod nosi ${artykuly.length} różnych towarów — symbol zmieniony w Subiekcie.`, 'blad');
    } else if (obciete) {
      komunikat(`Pokazano pierwsze ${artykuly.length} wyników — zawęź wyszukiwanie.`, 'info');
    } else if (!gtOk) {
      // Przy padnietym GT ta lista pochodzi wylacznie z historii WMS, wiec jest niepelna -
      // katalog GT nie odpowiada. Powiedzmy to, zamiast udawac komplet wynikow.
      komunikat('GT nie odpowiada — widać tylko to, co wie WMS.', 'info');
    }
  }

  // --- wejscie/wyjscie z widoku ---

  function otworz() {
    komunikat('');
    zLokalizacji = null;
    czyscWynik();
    odswiezWstecz();
    el('spr-skan').value = '';
    fokusBezKlawiatury(el('spr-skan'));
  }
  window.sprawdzOtworz = otworz;

  onScan(el('spr-skan'), pokazKod);
  polaSkanuBezKlawiatury(el('spr-skan'));

  el('btn-go-sprawdz').addEventListener('click', () => {
    pokazWidok('sprawdz');
    history.pushState({ v: 'sprawdz' }, '');
  });

  // Wstecz: najpierw wraca na polke, z ktorej weszlismy w produkt, a dopiero potem wychodzi
  // z ekranu. Sprzetowy Back wychodzi od razu do menu i to jest zamierzone - podglad jest
  // bezstanowy, wiec "Back = wyjdz" jest tu przewidywalne, a kolejne skany nie zasmiecaja
  // historii przegladarki (inaczej wyjscie po dziesieciu skanach = dziesiec tapow Back).
  el('spr-wstecz').addEventListener('click', () => {
    if (zLokalizacji) { pokazKod(zLokalizacji); return; }
    history.back();
  });
})();
