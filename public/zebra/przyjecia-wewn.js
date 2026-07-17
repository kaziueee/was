// Przyjecia wewnetrzne (PW) na Zebrze: plaska lista towaru przyjetego dokumentem PW na K4
// (korekta stanu, inwentura, reczne dolozenie) i lezacego w szufladzie przyjec nierozlozony.
//
// Analog przywozki.js - ta sama mechanika, inny dokument. PW to przychod BEZ dokumentu
// zrodlowego (sam PW jest dokumentem), rozpoznany od 2026-07-18. Wczesniej byl anonimowym
// "nieznanym przychodem", niewidocznym nigdzie - teraz ma nazwe, numer i szuflade.
//
// Rozkladanie otwiera zakladka Ruch (ruchOtworzArtykul z powrotem) - ten sam ekran, co przy
// dostawach i przywozkach. Towar wraca na regal (LOK, cel K4).
(() => {
  let lista = [];

  function komunikat(t, typ) {
    const box = el('pw-komunikat');
    if (!t) { box.classList.add('hidden'); return; }
    box.textContent = t;
    box.className = `komunikat ${typ || ''}`;
    box.classList.remove('hidden');
  }

  async function otworz() {
    komunikat('');
    const box = el('pw-lista');
    box.innerHTML = '<p class="hint">Ładuję…</p>';
    el('pw-pusto').classList.add('hidden');
    try {
      const res = await fetch('/api/zestawienia/przyjecia-wewn/strefa');
      const dane = await res.json();
      if (!res.ok) throw new Error(dane?.blad || `Błąd ${res.status}`);
      lista = dane.pozycje || [];
      render();
    } catch (err) {
      box.innerHTML = '';
      komunikat(err.message, 'blad');
    }
  }
  window.przyjeciaWewnOtworz = otworz;

  function render() {
    const box = el('pw-lista');
    box.innerHTML = '';
    el('pw-pusto').classList.toggle('hidden', lista.length > 0);
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
        // numer PW - do czego przypisac ruch (zrodlo_dok)
        + `<span class="hist-meta">${p.zrodlo_dok || 'PW'}</span>`
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

  el('btn-go-pw').addEventListener('click', () => {
    pokazWidok('pw');
    history.pushState({ v: 'pw' }, '');
  });
  el('pw-wstecz').addEventListener('click', () => history.back());
})();
