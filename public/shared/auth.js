'use strict';
// Wspolny modul logowania (Faza A#4) - dla Zebry i desktopu. Ladowany PRZED app.js/ruch.js.
// 1) monkey-patch fetch: dokleja naglowek x-wms-token do zapytan /api/ (poza login/profile),
//    dzieki czemu KAZDY istniejacy fetch niesie token bez zmian w kodzie aplikacji;
// 2) ekran wyboru profilu (+ PIN opcjonalny) gdy brak/wygasla sesja;
// 3) badge zalogowanego + wylogowanie. "Kto" i tak wymusza backend (token->operator).
(function () {
  const TKEY = 'wms_token';
  const UKEY = 'wms_user';
  const token = () => localStorage.getItem(TKEY);
  const user = () => { try { return JSON.parse(localStorage.getItem(UKEY)); } catch { return null; } };

  // --- fetch patch ---
  const origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    init = init || {};
    let url = typeof input === 'string' ? input : (input && input.url) || '';
    const czyApi = url.startsWith('/api/') || url.startsWith(location.origin + '/api/');
    const t = token();
    if (czyApi && t) {
      const h = new Headers(init.headers || (typeof input !== 'string' && input.headers) || {});
      h.set('x-wms-token', t);
      init.headers = h;
    }
    return origFetch(input, init);
  };

  // --- API pomocnicze (bez patcha tokenu tam gdzie niepotrzebny) ---
  // origFetch omija monkey-patch, wiec token dokladamy tu recznie - inaczej walidacja
  // sesji na starcie (/api/uzytkownicy/ja) leci bez tokenu -> 401 -> odswiezenie wylogowuje.
  async function jGet(url) {
    const h = token() ? { 'x-wms-token': token() } : {};
    const r = await origFetch(url, { headers: h });
    return r.ok ? r.json() : Promise.reject(r);
  }
  async function jPost(url, body, withToken) {
    const h = { 'Content-Type': 'application/json' };
    if (withToken && token()) h['x-wms-token'] = token();
    const r = await origFetch(url, { method: 'POST', headers: h, body: JSON.stringify(body || {}) });
    const dane = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(dane.blad || ('Blad ' + r.status)), { dane, status: r.status });
    return dane;
  }

  // --- UI: ekran wyboru profilu ---
  function styl() {
    if (document.getElementById('wms-auth-styl')) return;
    const s = document.createElement('style');
    s.id = 'wms-auth-styl';
    s.textContent = `
      #wms-auth-overlay{position:fixed;inset:0;z-index:100000;background:#0e1b33;display:flex;
        align-items:center;justify-content:center;padding:1.5rem;font-family:system-ui,sans-serif;}
      #wms-auth-box{background:#fff;border-radius:14px;padding:1.75rem 2rem;max-width:520px;width:100%;
        box-shadow:0 12px 48px rgba(0,0,0,.4);max-height:90vh;overflow:auto;}
      #wms-auth-box h2{margin:0 0 1rem;color:#0e1b33;font-size:1.4rem;}
      .wms-select{width:100%;padding:.8rem;font-size:1.1rem;border:2px solid #d6dce6;border-radius:10px;
        background:#fff;color:#0e1b33;}
      .wms-pin-box{margin-top:1rem;}
      .wms-pin-box input{font-size:1.6rem;letter-spacing:.4rem;text-align:center;width:100%;padding:.6rem;
        border:2px solid #d6dce6;border-radius:10px;}
      .wms-btn{margin-top:1rem;width:100%;padding:.8rem;font-size:1.05rem;font-weight:700;border:none;
        border-radius:10px;background:#2b6cb0;color:#fff;cursor:pointer;}
      .wms-btn.sek{background:#e2e8f0;color:#0e1b33;margin-top:.5rem;}
      .wms-auth-blad{color:#c53030;margin-top:.75rem;font-weight:600;min-height:1.2em;}
      .wms-status{margin:0 0 1rem;padding:.5rem .7rem;border-radius:8px;background:#f1f5f9;
        font-size:.82rem;color:#334155;line-height:1.5;}
      .wms-status b{font-weight:700;color:#0e1b33;}
      .wms-status .ok{color:#15803d;font-weight:700;} .wms-status .bad{color:#c53030;font-weight:700;}
      #wms-user-badge{position:fixed;top:8px;right:10px;z-index:9000;display:flex;gap:.5rem;align-items:center;
        background:rgba(255,255,255,.92);border:1px solid #d6dce6;border-radius:20px;padding:3px 6px 3px 12px;
        font-family:system-ui,sans-serif;font-size:.85rem;color:#0e1b33;box-shadow:0 2px 8px rgba(0,0,0,.12);}
      #wms-user-badge b{font-weight:700;}
      #wms-user-badge button{border:none;background:#e2e8f0;border-radius:14px;padding:4px 10px;cursor:pointer;font-size:.8rem;}
      /* badge w slocie nawigacji (desktop/Zebra menu) - bez pływania, dziedziczy kolor hosta */
      #wms-user-badge.wms-slot{position:static;top:auto;right:auto;background:transparent;border:none;
        box-shadow:none;padding:0;color:inherit;font-size:.9rem;}
      #wms-user-badge.wms-slot button{background:rgba(255,255,255,.9);color:#1d3557;}
      /* Zebra: naglowek menu w rzedzie (WMS z lewej, user z prawej); badge pionowo
         (imie nad Wyloguj) na wysokosc tytulu WMS. Scope #widok-menu = nie rusza reszty. */
      #widok-menu .ekran-naglowek{display:flex;align-items:flex-start;justify-content:space-between;}
      #widok-menu #wms-badge-slot{margin-left:auto;}
      #widok-menu #wms-user-badge{flex-direction:column;align-items:flex-end;gap:0;line-height:1.15;}
      #widok-menu #wms-user-badge b{font-size:1.05rem;}
      #widok-menu #wms-user-badge button{background:none;border:none;color:#64748b;padding:0;
        font-size:.85rem;text-decoration:underline;cursor:pointer;}
      /* Pasek srodowiska TESTOWEGO (Mac/dev) - szary, na samej gorze, nad wszystkim. Zeby
         nie pomylic srodowisk. Produkcja go nie pokazuje (brak flagi WMS_TESTOWY). */
      #wms-testowy-banner{position:fixed;top:0;left:0;right:0;z-index:100001;height:28px;
        display:flex;align-items:center;justify-content:center;background:#64748b;color:#fff;
        font-family:system-ui,sans-serif;font-weight:800;font-size:.82rem;letter-spacing:.08em;
        box-shadow:0 2px 6px rgba(0,0,0,.3);pointer-events:none;}
      body.wms-testowy{padding-top:28px;}                          /* desktop: przesun tresc w dol */
      body.wms-testowy .ekran{height:calc(100dvh - 28px);}         /* Zebra: kiosk 100dvh */
    `;
    document.head.appendChild(s);
  }

  let resolveGotowe;
  const gotowe = new Promise((res) => { resolveGotowe = res; });

  async function pokazWybor() {
    styl();
    let ov = document.getElementById('wms-auth-overlay');
    if (!ov) { ov = document.createElement('div'); ov.id = 'wms-auth-overlay'; document.body.appendChild(ov); }
    ov.innerHTML = `<div id="wms-auth-box"><h2>Wybierz profil</h2>
      <div class="wms-status" id="wms-auth-status">Sprawdzam środowisko…</div>
      <select id="wms-prof-select" class="wms-select"><option value="">Ladowanie…</option></select>
      <div class="wms-pin-box" id="wms-pin-box" style="display:none">
        <input id="wms-pin" type="password" inputmode="numeric" maxlength="4" placeholder="PIN (4 cyfry)" autocomplete="off">
      </div>
      <button class="wms-btn" id="wms-zaloguj">Zaloguj</button>
      <div class="wms-auth-blad" id="wms-auth-blad"></div></div>`;

    const sel = ov.querySelector('#wms-prof-select');
    const pinBox = ov.querySelector('#wms-pin-box');
    const pinIn = ov.querySelector('#wms-pin');
    const bladEl = ov.querySelector('#wms-auth-blad');
    const maPin = {};

    // pasek statusu srodowiska (baza / GT / most) - nieblokujacy, aktualizuje sie po fetchu
    (async () => {
      const st = ov.querySelector('#wms-auth-status');
      try {
        const s = await jGet('/api/status');
        st.innerHTML =
          `Baza: <b>${s.baza || '—'}</b>`
          + ` &nbsp;·&nbsp; GT: <span class="${s.gt ? 'ok' : 'bad'}">${s.gt ? '✓ połączono' : '✗ brak'}</span>`
          + ` &nbsp;·&nbsp; Most: <span class="${s.most ? 'ok' : 'bad'}">${s.most ? '✓ działa' : '✗ nie działa'}</span>`;
      } catch {
        st.innerHTML = '<span class="bad">Status środowiska niedostępny</span>';
      }
    })();

    async function zaloguj(id, pin) {
      bladEl.textContent = '';
      try {
        const { token: tk, uzytkownik } = await jPost('/api/uzytkownicy/login', { id, pin });
        localStorage.setItem(TKEY, tk);
        localStorage.setItem(UKEY, JSON.stringify(uzytkownik));
        ov.remove();
        pokazBadge();
        window.dispatchEvent(new CustomEvent('wms-zalogowano', { detail: uzytkownik }));
        resolveGotowe(uzytkownik);
      } catch (e) {
        bladEl.textContent = e.dane?.blad || e.message;
        // zly PIN -> wyczysc pole i ustaw fokus, zeby od razu wpisac ponownie
        if (pinBox.style.display !== 'none') { pinIn.value = ''; pinIn.focus(); }
      }
    }

    function odswiezPin() {
      const trzeba = sel.value && maPin[sel.value];
      pinBox.style.display = trzeba ? 'block' : 'none';
      if (trzeba) { pinIn.value = ''; pinIn.focus(); }
    }
    function submit() {
      if (!sel.value) { bladEl.textContent = 'Wybierz profil z listy'; return; }
      zaloguj(Number(sel.value), maPin[sel.value] ? pinIn.value.trim() : null);
    }

    try {
      const profile = await jGet('/api/uzytkownicy/profile');
      sel.innerHTML = '<option value="">— wybierz —</option>';
      for (const p of profile) {
        maPin[p.id] = p.maPin;
        const o = document.createElement('option');
        o.value = p.id; o.textContent = p.imie;
        sel.appendChild(o);
      }
      if (!profile.length) sel.innerHTML = '<option value="">Brak profili — skontaktuj sie z administratorem</option>';
    } catch { sel.innerHTML = '<option value="">Nie mozna pobrac listy profili</option>'; }

    sel.addEventListener('change', odswiezPin);
    ov.querySelector('#wms-zaloguj').addEventListener('click', submit);
    // auto-enter: po wpisaniu 4 cyfr loguj automatycznie (bez klikania Zaloguj)
    pinIn.addEventListener('input', () => {
      pinIn.value = pinIn.value.replace(/\D/g, ''); // tylko cyfry
      if (pinIn.value.length === 4) submit();
    });
    pinIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  }

  function pokazBadge() {
    const u = user(); if (!u) return;
    styl();
    // jesli host udostepnia slot (#wms-badge-slot) - renderuj tam (desktop: nawigacja,
    // Zebra: tylko ekran menu). Inaczej fallback: pływajacy badge w rogu.
    const slot = document.getElementById('wms-badge-slot');
    let el = document.getElementById('wms-user-badge');
    if (!el) { el = document.createElement('div'); el.id = 'wms-user-badge'; }
    (slot || document.body).appendChild(el);
    el.classList.toggle('wms-slot', !!slot);
    // BEZ roli (rola tylko w panelu admina)
    el.innerHTML = `<span><b>${u.imie}</b></span><button id="wms-wyloguj">Wyloguj</button>`;
    el.querySelector('#wms-wyloguj').addEventListener('click', wyloguj);
  }

  async function wyloguj() {
    try { await jPost('/api/uzytkownicy/logout', {}, true); } catch { /* ignore */ }
    localStorage.removeItem(TKEY); localStorage.removeItem(UKEY);
    document.getElementById('wms-user-badge')?.remove();
    pokazWybor();
  }

  // Pasek "TESTOWY" - na Macu/dev (flaga WMS_TESTOWY=1 w .env). Nieblokujacy; pokazuje sie
  // niezaleznie od logowania (tez na ekranie wyboru profilu). Produkcja: brak flagi = brak paska.
  async function pokazBannerTestowy() {
    try {
      const s = await jGet('/api/status');
      if (!s || !s.testowy || document.getElementById('wms-testowy-banner')) return;
      styl();
      const b = document.createElement('div');
      b.id = 'wms-testowy-banner';
      b.textContent = 'ŚRODOWISKO TESTOWE — NIE PRODUKCJA';
      document.body.appendChild(b);
      document.body.classList.add('wms-testowy');
    } catch { /* status niedostepny - bez paska */ }
  }

  async function init() {
    styl();
    pokazBannerTestowy();
    if (token()) {
      // zweryfikuj sesje (mogla wygasnac po stronie serwera)
      try { const ja = await jGet('/api/uzytkownicy/ja' + '?_t=' + Date.now()); localStorage.setItem(UKEY, JSON.stringify(ja)); pokazBadge(); window.dispatchEvent(new CustomEvent('wms-zalogowano', { detail: ja })); resolveGotowe(ja); return; }
      catch { localStorage.removeItem(TKEY); localStorage.removeItem(UKEY); }
    }
    pokazWybor();
  }

  window.WMS = { token, user, wyloguj, gotowe, pokazWybor, jestAdmin: () => (user() || {}).rola === 'admin' };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
