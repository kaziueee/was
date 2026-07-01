'use strict';
// Blokada edycji produktu na Zebrze (Faza A#4). Parytet z desktopem: gdy magazynier
// otwiera produkt (krok "Dokad i ile?" / rozklad zrodel), zajmujemy lock; jesli edytuje
// go kto inny -> {ok:false, przez}. Heartbeat co 30s; zwolnienie przy powrocie (reset).
// fetch jest patchowany przez /shared/auth.js (dokleja token) - blokady wymagaja sesji.
(function () {
  let aktualny = null; // artykul_gt_id aktualnie zablokowany przez nas
  let hb = null;

  function stopHb() { if (hb) { clearInterval(hb); hb = null; } }

  async function zwolnij() {
    stopHb();
    const id = aktualny; aktualny = null;
    if (id) { try { await fetch(`/api/blokady/${encodeURIComponent(id)}/zwolnij`, { method: 'POST' }); } catch { /* ignore */ } }
  }

  // Proba zajecia. Zwraca {ok:true} (wolne/nasze) albo {ok:false, przez} / {ok:false, blad}.
  async function zajmij(artykulGtId) {
    if (!artykulGtId) return { ok: true };
    const id = String(artykulGtId);
    if (aktualny === id) return { ok: true }; // juz nasze
    if (aktualny) await zwolnij();             // przechodzimy na inny produkt
    try {
      const r = await fetch(`/api/blokady/${encodeURIComponent(id)}/zajmij`, { method: 'POST' });
      if (r.status === 409) { const d = await r.json().catch(() => ({})); return { ok: false, przez: d.przez }; }
      if (!r.ok) return { ok: false, blad: 'Blokada niedostepna' };
      aktualny = id;
      stopHb();
      hb = setInterval(() => { fetch(`/api/blokady/${encodeURIComponent(id)}/heartbeat`, { method: 'POST' }).catch(() => {}); }, 30000);
      return { ok: true };
    } catch { return { ok: false, blad: 'Brak polaczenia' }; }
  }

  // Uwaga: przy zamknieciu karty bez reset() lock zostaje - wygasa sam po 2 min
  // (services/blokady TIMEOUT_MS). Beacon by nie przeszedl (brak tokenu -> 401).

  window.BlokadaEdycji = { zajmij, zwolnij };
})();
