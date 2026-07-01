// Ekran Zebry "Historia ruchów" - ostatnie operacje (MM/LOK/uzupełnienia/przyjęcia)
// z logu audytu: kiedy · SKU · kierunek (lokalizacja) · ilość. Bezpiecznik, gdy
// magazynier zapomni, gdzie zanieść towar. Korzysta z globalnych el/pokazWidok.

(function () {
  'use strict';

  function komunikat(t, typ) {
    const k = el('hist-komunikat');
    if (!t) { k.className = 'komunikat hidden'; return; }
    k.textContent = t;
    k.className = `komunikat ${typ || 'info'}`;
  }

  // "2026-07-01 00:02:59" -> "01.07 00:02"
  function czasSkrot(s) {
    const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    return m ? `${m[3]}.${m[2]} ${m[4]}:${m[5]}` : (s || '');
  }

  // akcje bedace fizycznym ruchem towaru (maja kierunek + ilosc)
  const AKCJE_RUCH = new Set(['MM', 'MM-zewn', 'Uzupelnienie', 'LOK', 'przypisanie', 'przyjecie']);

  async function otworz() {
    komunikat('');
    const lista = el('hist-lista');
    lista.innerHTML = '<p class="hint">Ładuję…</p>';
    el('hist-pusto').classList.add('hidden');
    try {
      const res = await fetch('/api/audyt?limit=60');
      const dane = await res.json();
      if (!res.ok) throw new Error(dane?.blad || `Błąd ${res.status}`);
      const ruchy = (dane.wiersze || []).filter((w) => AKCJE_RUCH.has(w.akcja) && w.ilosc != null);
      renderuj(ruchy);
    } catch (err) {
      lista.innerHTML = '';
      komunikat(err.message, 'blad');
    }
  }
  window.historiaOtworz = otworz;

  function renderuj(ruchy) {
    const lista = el('hist-lista');
    lista.innerHTML = '';
    el('hist-pusto').classList.toggle('hidden', ruchy.length > 0);
    for (const w of ruchy) {
      const div = document.createElement('div');
      div.className = 'lista-poz' + (w.wynik && w.wynik !== 'ok' ? ' st-warn' : '');
      const meta = czasSkrot(w.czas) + (w.uzytkownik ? ` · ${w.uzytkownik}` : '');
      div.innerHTML = `<span class="poz-glowna">`
        + `<span class="poz-kod">${w.artykul_symbol || w.artykul_gt_id || '—'}</span>`
        + `<span class="poz-podpis">${w.akcja} · ${w.lokalizacja || ''}</span>`
        + `<span class="hist-meta">${meta}</span>`
        + `</span>`
        + `<span class="poz-prawa"><span class="poz-ilosc">${w.ilosc ?? ''}</span><span class="poz-rez">szt.</span></span>`;
      lista.appendChild(div);
    }
  }

  el('btn-go-historia').addEventListener('click', () => {
    pokazWidok('historia');
    history.pushState({ v: 'historia' }, '');
  });
  el('hist-wstecz').addEventListener('click', () => pokazWidok('menu'));
  el('hist-odswiez').addEventListener('click', otworz);
})();
