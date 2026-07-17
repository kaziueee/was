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

  // Dwie rozne prace na jednej liscie (patrz routes/do-sprawdzenia.js):
  //   nieznany_przychod - WMS zna miejsce, ale stan urosl poza naszym obiegiem. Sygnal
  //     operacyjny, splywa codziennie. NIE WIDZI GO NIC INNEGO w systemie.
  //   do_zlokalizowania - WMS nie zna SKU w ogole. Backlog migracyjny (~2000 poz.).
  // Domyslnie NIEZNANY PRZYCHOD: backlog migracyjny to robota na miesiace, a to jest to,
  // co wydarzylo sie wczoraj i o co user pytal wprost. Przelacznik obok, gdyby ktos chcial
  // pochodzic po backlogu.
  const RODZAJE = [
    { klucz: 'nieznany_przychod', etykieta: 'Nieznany przychód' },
    { klucz: 'do_zlokalizowania', etykieta: 'Do zlokalizowania' },
  ];

  let rodzaj = 'nieznany_przychod';
  let lista = [];
  let razem = 0;
  let liczniki = null;

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
      // sort=lokalizacja = kolejnosc obchodu (patrz komentarz na gorze)
      const res = await fetch(`/api/do-sprawdzenia?sort=lokalizacja&rodzaj=${rodzaj}&limit=${PORCJA}`);
      const dane = await res.json();
      if (!res.ok) throw new Error(dane?.blad || `Błąd ${res.status}`);
      lista = dane.pozycje || [];
      razem = dane.razem || 0;
      liczniki = dane.liczniki || null;
      render();
    } catch (err) {
      box.innerHTML = '';
      komunikat(err.message, 'blad');
    }
  }
  window.doSprawdzeniaOtworz = otworz;

  function renderPrzelacznik() {
    const box = el('dosp-rodzaje');
    box.innerHTML = '';
    for (const r of RODZAJE) {
      const ile = liczniki?.[r.klucz]?.razem;
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
      // Gdy WMS juz cos wie o tym SKU na K4, to jest dokladanie do istniejacego miejsca,
      // a nie szukanie nowego - zupelnie inna robota, wiec mowimy to wprost.
      const kontekst = p.polka_wms > 0
        ? `WMS zna ${p.polka_wms} szt. · stan GT ${p.stan_k4}`
        : `WMS nie zna tego towaru · stan GT ${p.stan_k4}`;
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
