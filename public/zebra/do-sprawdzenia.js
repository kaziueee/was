// "Do sprawdzenia" na Zebrze: towar, ktory GT widzi na K4, a WMS nie wie, gdzie on lezy.
// Wszedl poza naszym obiegiem - przychod z inwentury, uzupelnienie zrobione w Subiekcie,
// powrot z Reklamacji. Zadanie: pojsc, znalezc i przypisac miejsce.
//
// CZYM SIE ROZNI OD POZOSTALYCH EKRANOW: to BACKLOG, nie zadanie na dzis. Na starcie ~2000
// pozycji (GT ma ~2800 SKU ze stanem na K4, a K4 ma 855 lokalizacji, wiec WMS moze znac
// najwyzej tyle) i bedzie sie drenowal miesiacami - jak "Ostatnie sztuki". Dlatego:
//   - sort po LOKALIZACJI (kolejnosc obchodu), a nie po ilosci: magazynier idzie alejka
//     i zalatwia po drodze, zamiast biegac po hali za najwiekszymi liczbami;
//   - bierzemy PORCJE (LIMIT), a nie cala liste: 2000 wierszy w DOM-ie na TC52 to zwis,
//     a i tak nikt nie przewinie dalej niz kilkadziesiat.
//
// Rozkladanie otwiera zakladka Ruch (ruchOtworzArtykul z powrotem) - ten sam ekran, co przy
// dostawach, przywozkach i karcie produktu. Zaden ekran listowy nie robi ruchow sam.
(() => {
  // Ile pozycji na raz. Obchod i tak idzie po kolei, a Zebra nie uniesie calego backlogu.
  const PORCJA = 50;

  // Rodzaje rozjazdu wiedzy (patrz routes/do-sprawdzenia.js). PRZYJECIA WEWNETRZNE (PW) maja
  // od 2026-07-18 wlasny ekran-szuflade (kafelek "Przyjecia wewn"), wiec TU zostaja dwa:
  //   do_zlokalizowania - WMS nie zna SKU w ogole. Backlog migracyjny (~2000 poz.).
  //   nieznany_przychod - nadwyzka BEZ dokumentu (rzadka - w Subiekcie nie ma zmiany bez dok).
  // Domyslnie DO ZLOKALIZOWANIA: to glowna zawartosc tego ekranu; PW obsluguje szuflada.
  // Wiersz kontekstu rozni sie per zakladka: przy stanie K4 liczy sie "co WMS juz wie",
  // przy NZ - KTORY magazyn sie nie zgadza i o ile.
  const KONTEKST_STAN = (p) => (p.polka_wms > 0
    ? `WMS zna ${p.polka_wms} szt. · stan GT ${p.stan_k4}`
    : `WMS nie zna tego towaru · stan GT ${p.stan_k4}`);

  // NZ NIE zawsze znaczy roznice ilosci: na K4 pola porownywane sa TEKSTEM, wiec "C2 w WMS
  // vs D3 w GT" tez jest NZ przy zgodnych stanach. Wtedy oba `brak` sa zerowe i mowimy wprost,
  // ze rozjechal sie sam zapis - inaczej wiersz bylby pusty i wygladal na blad.
  const KONTEKST_NZ = (p) => {
    const czesci = [];
    if (p.k4?.brak > 0) czesci.push(`K4: GT ${p.k4.gt} · WMS ${p.k4.wms} → brakuje ${p.k4.brak}`);
    if (p.k4g?.brak > 0) czesci.push(`K4G: GT ${p.k4g.gt} · WMS ${p.k4g.wms} → brakuje ${p.k4g.brak}`);
    return czesci.join(' · ') || `zapis lokalizacji rozjechany z GT (K4 ${p.zgodnosc?.k4} / K4G ${p.zgodnosc?.k4g})`;
  };

  const RODZAJE = [
    { klucz: 'do_zlokalizowania', etykieta: 'Do zlokalizowania', kontekst: KONTEKST_STAN },
    { klucz: 'nieznany_przychod', etykieta: 'Bez dokumentu', kontekst: KONTEKST_STAN },
    // NZ = status z kolumny "Zgodnosc" na desktopie. JEDYNE miejsce na Zebrze, gdzie widac
    // nadwyzke GT na K4G: rozjazdy lapia tylko GT < WMS, a pozostale zakladki tego ekranu
    // licza wylacznie stan K4. Wlasny endpoint - liczy sie inaczej niz reszta (porownanie pol,
    // nie rozbicie stanu), wiec nie da sie go wcisnac jako kolejny `rodzaj`.
    { klucz: 'nz', etykieta: 'NZ (pola GT)', endpoint: '/api/do-sprawdzenia/nz', kontekst: KONTEKST_NZ },
  ];

  let rodzaj = 'do_zlokalizowania';
  let lista = [];
  let razem = 0;
  let liczniki = null;
  // Licznik NZ znamy dopiero po wejsciu w zakladke: jego policzenie to osobne, kosztowne
  // zapytanie (porownanie pol GT dla calego zbioru WMS), a nie chcemy go doplacac do KAZDEGO
  // otwarcia ekranu. Puste = "nie wiem", nie "zero" - zob. "brak cichych porazek".
  let licznikNz = null;

  // Odpowiedz bledu bywa HTML-em (404 z Expressa, ekran proxy), a nie JSON-em. Gdy res.json()
  // idzie PRZED sprawdzeniem statusu, magazynier dostaje "Unexpected token '<'" zamiast bledu.
  // Status czytamy pierwszy, tresc best-effort (tak samo w public/zebra/sciezki.js).
  async function odczytaj(res) {
    const tekst = await res.text();
    let dane = null;
    try { dane = tekst ? JSON.parse(tekst) : null; } catch { /* nie-JSON: zostaje sam status */ }
    if (!res.ok) throw new Error(dane?.blad || `Błąd ${res.status}`);
    return dane ?? {};
  }

  function komunikat(t, typ) {
    const box = el('dosp-komunikat');
    if (!t) { box.classList.add('hidden'); return; }
    box.textContent = t;
    box.className = `komunikat ${typ || ''}`;
    box.classList.remove('hidden');
  }

  async function otworz() {
    komunikat('');
    const box = el('dosp-lista');
    box.innerHTML = '<p class="hint">Ładuję…</p>';
    el('dosp-pusto').classList.add('hidden');
    try {
      // sort=lokalizacja = kolejnosc obchodu (patrz komentarz na gorze). NZ ma wlasny
      // endpoint - juz sortuje po lokalizacji i nie zna parametru `rodzaj`.
      const def = RODZAJE.find((r) => r.klucz === rodzaj);
      const res = await fetch(def.endpoint
        ? `${def.endpoint}?limit=${PORCJA}`
        : `/api/do-sprawdzenia?sort=lokalizacja&rodzaj=${rodzaj}&limit=${PORCJA}`);
      const dane = await odczytaj(res);
      lista = dane.pozycje || [];
      razem = dane.razem || 0;
      if (dane.liczniki) liczniki = dane.liczniki;   // NZ ich nie zwraca - nie kasuj tych, ktore mamy
      if (def.endpoint) licznikNz = razem;
      render();
    } catch (err) {
      // Bez tego przelacznik i naglowek zostaja z POPRZEDNIEJ zakladki - wyglada, jakby
      // klikniecie nic nie zrobilo, a blad dotyczyl czegos zupelnie innego.
      lista = []; razem = 0;
      box.innerHTML = '';
      el('dosp-postep').textContent = '';
      renderPrzelacznik();
      komunikat(err.message, 'blad');
    }
  }
  window.doSprawdzeniaOtworz = otworz;

  function renderPrzelacznik() {
    const box = el('dosp-rodzaje');
    box.innerHTML = '';
    for (const r of RODZAJE) {
      const ile = r.endpoint ? licznikNz : liczniki?.[r.klucz]?.razem;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn-rodzaj${r.klucz === rodzaj ? ' aktywny' : ''}`;
      b.innerHTML = `${r.etykieta}<span>${ile == null ? '' : ile}</span>`;
      b.addEventListener('click', () => { rodzaj = r.klucz; otworz(); });
      box.appendChild(b);
    }
  }

  function render() {
    renderPrzelacznik();
    const box = el('dosp-lista');
    box.innerHTML = '';
    el('dosp-pusto').classList.toggle('hidden', razem > 0);

    // Uczciwie mowimy, ze to wycinek - inaczej magazynier zobaczy 50 pozycji i pomysli,
    // ze to cala robota. "Brak cichych porazek" dotyczy tez licznikow.
    el('dosp-postep').textContent = razem > lista.length
      ? `${lista.length} z ${razem} — najbliższe wg obchodu`
      : (razem ? `${razem} ${razem === 1 ? 'pozycja' : 'pozycji'}` : '');

    for (const p of lista) {
      const div = document.createElement('button');
      div.type = 'button';
      div.className = 'lista-poz';
      // Miejsce z GT to PODPOWIEDZ, nie prawda - tw_Pole1 bywa smieciem ("RB/M2-B37 - sciana /").
      // Oznaczamy zrodlo, zeby magazynier wiedzial, czemu ma je zweryfikowac okiem.
      const miejsce = p.lokalizacja_kod
        ? `📍 ${p.lokalizacja_kod}${p.lok_zrodlo === 'GT' ? ' (z GT — sprawdź)' : ''}`
        : '📍 brak miejsca — zeskanuj nowe';
      // Kontekst per zakladka (zob. KONTEKST_STAN / KONTEKST_NZ na gorze): przy stanie K4
      // liczy sie "dokladam do znanego miejsca czy szukam nowego", przy NZ - ktory magazyn
      // sie rozjechal. To zupelnie inna robota, wiec wiersz musi mowic co innego.
      const kontekst = (RODZAJE.find((r) => r.klucz === rodzaj)?.kontekst ?? KONTEKST_STAN)(p);
      div.innerHTML =
        `<span class="poz-glowna">`
        + `<span class="poz-kod">${p.symbol || p.artykul_gt_id}</span>`
        + `<span class="poz-nazwa">${p.nazwa || ''}</span>`
        + `<span class="poz-podpis">${miejsce}</span>`
        + `<span class="hist-meta">${kontekst}</span>`
        + `</span>`
        + `<span class="poz-prawa"><span class="poz-ilosc">${p.ilosc}</span><span class="poz-rez">szt.</span></span>`;
      div.addEventListener('click', () => {
        if (!window.ruchOtworzArtykul) { komunikat('Ekran Ruch niedostępny.', 'blad'); return; }
        // powrot = history.back() zdejmuje wpis Ruchu i wraca na te liste, przeladowana -
        // przypisana pozycja znika sama (lista liczy sie na zywo z GT + kopii WMS)
        window.ruchOtworzArtykul(p.symbol || p.artykul_gt_id, { powrot: () => history.back() });
      });
      box.appendChild(div);
    }
  }

  el('btn-go-dosp').addEventListener('click', () => {
    pokazWidok('dosp');
    history.pushState({ v: 'dosp' }, '');
  });
  el('dosp-wstecz').addEventListener('click', () => history.back());
})();
