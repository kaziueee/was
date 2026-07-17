// Dostawy na Zebrze: faktury -> towary z faktury -> produkt.
//
// Samo rozkladanie NIE jest tu powtorzone: produkt otwiera zakladka Ruch przez
// window.ruchOtworzArtykul(symbol, {powrot}). Ruch juz umie rozbicie zrodel, podpowiedz
// lokalizacji, czesciowe rozkladanie i "Zostan w produkcie" - druga kopia tego ekranu
// rozjechalaby sie z oryginalem przy pierwszej zmianie regul.
//
// `powrot` sprawia, ze ekran sukcesu oddaje magazyniera na LISTE TOWARÓW tej faktury, zamiast
// resetowac kreator do pustego skanu (wejscie z kafla "Ruch" dziala jak dotad).
//
// Korzysta z globalnych el/pokazWidok.
(() => {
  const PODEKRANY = ['dostawy-faktury', 'dostawy-towary'];
  let biezacaFaktura = null;   // { zrodlo_dok, dok_zrodlowy, kontrahent }

  function komunikat(t, typ) {
    const box = el('dostawy-komunikat');
    if (!t) { box.classList.add('hidden'); return; }
    box.textContent = t;
    box.className = `komunikat ${typ || ''}`;
    box.classList.remove('hidden');
  }

  function pokazPod(nazwa) {
    for (const p of PODEKRANY) el(p).classList.toggle('hidden', p !== nazwa);
  }

  // stan - wpis historii. {v:'dostawy', dok} = Back wrocil na liste towarow konkretnej
  // faktury; bez `dok` = poziom listy faktur. Dzieki temu Back cofa o JEDEN krok, a nie
  // wyrzuca z produktu od razu na sam poczatek.
  async function otworz(stan) {
    komunikat('');
    if (stan?.dok) { wczytajTowary(stan.dok); return; }
    biezacaFaktura = null;
    el('dostawy-tytul').textContent = 'Dostawy';
    pokazPod('dostawy-faktury');
    const box = el('dostawy-faktury-lista');
    box.innerHTML = '<p class="hint">Ładuję…</p>';
    el('dostawy-faktury-pusto').classList.add('hidden');
    try {
      const res = await fetch('/api/dostawy');
      const dane = await res.json();
      if (!res.ok) throw new Error(dane?.blad || `Błąd ${res.status}`);
      renderFaktury(dane.faktury || []);
    } catch (err) {
      box.innerHTML = '';
      komunikat(err.message, 'blad');
    }
  }
  window.dostawyOtworz = otworz;

  function renderFaktury(faktury) {
    const box = el('dostawy-faktury-lista');
    box.innerHTML = '';
    el('dostawy-faktury-pusto').classList.toggle('hidden', faktury.length > 0);
    for (const f of faktury) {
      const div = document.createElement('button');
      div.type = 'button';
      div.className = 'lista-poz';
      // kontrahent bywa numerem (kh_Symbol nie zawsze jest nazwa) - pokazujemy co jest
      const podpis = [f.dok_zrodlowy, f.kontrahent].filter(Boolean).join(' · ');
      div.innerHTML =
        `<span class="poz-glowna">`
        + `<span class="poz-kod">${podpis || f.zrodlo_dok}</span>`
        + `<span class="poz-podpis">${f.sku} SKU · ${f.sztuk} szt. · ${f.data || ''}</span>`
        + `</span>`
        + `<span class="poz-prawa"><span class="poz-rez">rozłóż ›</span></span>`;
      div.addEventListener('click', () => {
        history.pushState({ v: 'dostawy', dok: f.zrodlo_dok }, '');
        wczytajTowary(f.zrodlo_dok);
      });
      box.appendChild(div);
    }
  }

  async function wczytajTowary(dok) {
    komunikat('');
    pokazPod('dostawy-towary');
    const box = el('dostawy-towary-lista');
    box.innerHTML = '<p class="hint">Ładuję…</p>';
    el('dostawy-towary-pusto').classList.add('hidden');
    try {
      const res = await fetch(`/api/dostawy/${encodeURIComponent(dok)}`);
      const dane = await res.json();
      if (!res.ok) throw new Error(dane?.blad || `Błąd ${res.status}`);
      // Numer FZ i kontrahent backend czyta z POZYCJI, wiec po rozlozeniu ostatniego SKU lista
      // jest pusta i oba sa null. Nie pozwalamy naglowkowi zdegradowac sie wtedy do samego PZ -
      // to gubienie kontekstu dokladnie w chwili sukcesu. Trzymamy poprzedni podpis tej faktury.
      const stary = biezacaFaktura?.zrodlo_dok === dane.zrodlo_dok ? biezacaFaktura : null;
      biezacaFaktura = {
        zrodlo_dok: dane.zrodlo_dok,
        dok_zrodlowy: dane.dok_zrodlowy ?? stary?.dok_zrodlowy ?? null,
        kontrahent: dane.kontrahent ?? stary?.kontrahent ?? null,
      };
      el('dostawy-tytul').textContent = biezacaFaktura.dok_zrodlowy || biezacaFaktura.zrodlo_dok;
      el('dostawy-podpis').textContent = [biezacaFaktura.kontrahent, biezacaFaktura.zrodlo_dok].filter(Boolean).join(' · ');
      renderTowary(dane.pozycje || []);
    } catch (err) {
      box.innerHTML = '';
      komunikat(err.message, 'blad');
    }
  }

  function renderTowary(pozycje) {
    const box = el('dostawy-towary-lista');
    box.innerHTML = '';
    // pusto = wszystko rozlozone; backend oddaje 200 z pusta lista, wiec to sukces, nie blad
    el('dostawy-towary-pusto').classList.toggle('hidden', pozycje.length > 0);
    for (const p of pozycje) {
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
        + `</span>`
        + `<span class="poz-prawa"><span class="poz-ilosc">${p.ilosc}</span><span class="poz-rez">szt.</span></span>`;
      div.addEventListener('click', () => otworzProdukt(p));
      box.appendChild(div);
    }
  }

  // Produkt rozklada zakladka Ruch. Po sukcesie wracamy na te sama liste towarow -
  // przeladowana, wiec rozlozona pozycja z niej znika (licznik liczy sie z ruchow).
  function otworzProdukt(p) {
    const dok = biezacaFaktura?.zrodlo_dok;
    if (!window.ruchOtworzArtykul) { komunikat('Ekran Ruch niedostępny.', 'blad'); return; }
    window.ruchOtworzArtykul(p.symbol || p.artykul_gt_id, {
      powrot: () => {
        // wracamy do WPISU historii tej faktury, zeby Back z listy towarow szedl na liste
        // faktur (a nie z powrotem w produkt, ktory wlasnie rozlozylismy)
        history.back();
      },
    });
  }

  el('btn-go-dostawy').addEventListener('click', () => {
    pokazWidok('dostawy');
    history.pushState({ v: 'dostawy' }, '');
  });
  el('dostawy-wstecz').addEventListener('click', () => history.back());
})();
