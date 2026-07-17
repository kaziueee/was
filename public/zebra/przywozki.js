// Przywozki na Zebrze: plaska lista towaru, ktory przyjechal MM-em z MAG/Leszna na K4 i lezy
// w strefie przyjec nierozlozony.
//
// Bez poziomu dokumentu (inaczej niz Dostawy): przywozka to 141 dokumentow na kwartal po 1-2
// szt., wiec grupowanie po MM dodaloby klikniec i nic nie wyjasnilo. Magazynier chodzi po
// strefie i odklada sztuki, nie "realizuje dokument".
//
// Rozkladanie otwiera zakladka Ruch (ruchOtworzArtykul z powrotem) - ten sam ekran, co przy
// dostawach i karcie produktu.
(() => {
  let lista = [];

  function komunikat(t, typ) {
    const box = el('przywozki-komunikat');
    if (!t) { box.classList.add('hidden'); return; }
    box.textContent = t;
    box.className = `komunikat ${typ || ''}`;
    box.classList.remove('hidden');
  }

  async function otworz() {
    komunikat('');
    const box = el('przywozki-lista');
    box.innerHTML = '<p class="hint">Ładuję…</p>';
    el('przywozki-pusto').classList.add('hidden');
    try {
      const res = await fetch('/api/zestawienia/przywozka/strefa');
      const dane = await res.json();
      if (!res.ok) throw new Error(dane?.blad || `Błąd ${res.status}`);
      lista = dane.pozycje || [];
      render();
    } catch (err) {
      box.innerHTML = '';
      komunikat(err.message, 'blad');
    }
  }
  window.przywozkiOtworz = otworz;

  function render() {
    const box = el('przywozki-lista');
    box.innerHTML = '';
    el('przywozki-pusto').classList.toggle('hidden', lista.length > 0);
    for (const p of lista) {
      const div = document.createElement('button');
      div.type = 'button';
      div.className = 'lista-poz';
      const miejsce = p.lokalizacja_kod
        ? `📍 ${p.lokalizacja_kod}${p.lok_zrodlo === 'GT' ? ' (z GT)' : ''}`
        : '📍 brak miejsca w WMS';
      div.innerHTML =
        `<span class="poz-glowna">`
        + `<span class="poz-kod">${p.symbol || p.artykul_gt_id}</span>`
        + `<span class="poz-nazwa">${p.nazwa || ''}</span>`
        + `<span class="poz-podpis">${miejsce}</span>`
        // skad przyjechalo - dla magazyniera "z Leszna" i "z MAG" to dwie rozne rzeczy
        + `<span class="hist-meta">z ${p.zrodlo_mag || '—'} · ${p.zrodlo_dok}</span>`
        + `</span>`
        + `<span class="poz-prawa"><span class="poz-ilosc">${p.ilosc}</span><span class="poz-rez">szt.</span></span>`;
      div.addEventListener('click', () => {
        if (!window.ruchOtworzArtykul) { komunikat('Ekran Ruch niedostępny.', 'blad'); return; }
        // powrot = history.back() zdejmuje wpis Ruchu i wraca na te liste, przeladowana -
        // rozlozona pozycja znika sama (licznik liczy sie z ruchow)
        window.ruchOtworzArtykul(p.symbol || p.artykul_gt_id, { powrot: () => history.back() });
      });
      box.appendChild(div);
    }
  }

  el('btn-go-przywozki').addEventListener('click', () => {
    pokazWidok('przywozki');
    history.pushState({ v: 'przywozki' }, '');
  });
  el('przywozki-wstecz').addEventListener('click', () => history.back());
})();
