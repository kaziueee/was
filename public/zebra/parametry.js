// Ekran "Parametry" - wymiary i waga produktu, zapisywane do pol wlasnych GT.
// Waga gabarytowa jest TYLKO do odczytu: liczy ja backend (PUT /api/produkty/:id/atrybuty
// ignoruje wartosc przyslana przez klienta). Podglad na ekranie liczymy tym samym wzorem
// wylacznie po to, zeby magazynier widzial skutek wpisu zanim zapisze.
(function () {
  'use strict';

  const DZIELNIK_DHL = 4000;
  const WAGA_GAB_MIN = 0.01;

  let biezacy = null;      // {artykul_gt_id, symbol, nazwa}
  let powrot = null;       // funkcja wolana po zapisie/wstecz zamiast wyjscia do menu

  // Wlasny box komunikatow - globalny pokazKomunikat() z kreator.js pisze do #komunikat,
  // ktory lezy w widoku Ruch i na tym ekranie jest niewidoczny (jak w sciezki.js).
  function komunikat(t, typ) {
    const k = el('par-komunikat');
    if (!t) { k.className = 'komunikat hidden'; return; }
    k.textContent = t;
    k.className = `komunikat ${typ || 'info'}`;
  }

  function liczba(wartosc) {
    if (wartosc === null || wartosc === undefined) return null;
    const tekst = String(wartosc).trim().replace(',', '.');
    if (tekst === '') return null;
    const n = Number(tekst);
    return Number.isFinite(n) ? n : null;
  }

  function przecinek(n, miejsca) {
    return Number(n).toFixed(miejsca).replace('.', ',');
  }

  // Podglad wagi gabarytowej - ten sam wzor co w services/gt-atrybuty.js.
  function odswiezWageGab() {
    const d = liczba(el('par-dlugosc').value);
    const s = liczba(el('par-szerokosc').value);
    const w = liczba(el('par-wysokosc').value);
    const komplet = [d, s, w].every((n) => n !== null && n > 0);
    el('par-waga-gab').textContent = komplet
      ? `${przecinek(Math.max((d * s * w) / DZIELNIK_DHL, WAGA_GAB_MIN), 2)} kg`
      : '—';
  }

  async function otworz(artykulGtId, opcje = {}) {
    biezacy = { artykul_gt_id: String(artykulGtId), symbol: opcje.symbol ?? '', nazwa: opcje.nazwa ?? '' };
    powrot = typeof opcje.powrot === 'function' ? opcje.powrot : null;

    el('par-symbol').textContent = biezacy.symbol || 'Parametry';
    el('par-nazwa').textContent = biezacy.nazwa || '';
    for (const id of ['par-dlugosc', 'par-szerokosc', 'par-wysokosc', 'par-waga']) el(id).value = '';
    el('par-waga-gab').textContent = '—';
    komunikat('');

    try {
      const res = await fetch(`/api/produkty/${encodeURIComponent(biezacy.artykul_gt_id)}/atrybuty`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).blad || 'Nie udało się pobrać parametrów');
      const d = await res.json();
      if (d.dlugosc !== null) el('par-dlugosc').value = d.dlugosc;
      if (d.szerokosc !== null) el('par-szerokosc').value = d.szerokosc;
      if (d.wysokosc !== null) el('par-wysokosc').value = d.wysokosc;
      if (d.waga !== null) el('par-waga').value = String(d.waga).replace(',', '.');
      odswiezWageGab();
    } catch (err) {
      komunikat(err.message, 'blad');
    }

    // Skok do wagi, gdy wymiary sa juz komplet (kazdy > 0): ta sciezka najczesciej DOKLADA
    // sama wage, a wymiary juz sa - wtedy pole dlugosci to zbedny przystanek. Gdy wymiarow
    // brak (albo fetch padl i pola zostaly puste), zaczynamy normalnie od dlugosci.
    const wymiaryKomplet = ['par-dlugosc', 'par-szerokosc', 'par-wysokosc']
      .every((id) => { const n = liczba(el(id).value); return n !== null && n > 0; });
    if (wymiaryKomplet) {
      el('par-waga').focus();
      el('par-waga').select();
    } else {
      el('par-dlugosc').focus();
    }
  }

  async function zapisz() {
    if (!biezacy) return;
    const d = liczba(el('par-dlugosc').value);
    const s = liczba(el('par-szerokosc').value);
    const w = liczba(el('par-wysokosc').value);
    const waga = liczba(el('par-waga').value);

    const cialo = { artykul_symbol: biezacy.symbol };
    const podanoWymiar = [d, s, w].some((n) => n !== null);
    if (podanoWymiar) {
      // Walidacja tu jest tylko dla UX - autorytatywna jest ta w routes/produkty.js.
      if ([d, s, w].some((n) => n === null || n <= 0)) {
        return komunikat('Podaj wszystkie trzy wymiary, każdy większy od zera.', 'blad');
      }
      cialo.wymiary = { dlugosc: d, szerokosc: s, wysokosc: w };
    }
    if (waga !== null) cialo.waga = waga;
    if (!('wymiary' in cialo) && !('waga' in cialo)) {
      return komunikat('Wpisz wymiary lub wagę.', 'blad');
    }

    el('par-zapisz').disabled = true;
    try {
      const res = await fetch(`/api/produkty/${encodeURIComponent(biezacy.artykul_gt_id)}/atrybuty`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cialo),
      });
      const dane = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(dane.blad || 'Nie udało się zapisać');

      if (dane.waga_gabarytowa) el('par-waga-gab').textContent = `${dane.waga_gabarytowa} kg`;
      const ostrz = (dane.ostrzezenia || []).join(' ');
      komunikat(ostrz ? `Zapisano ✓ — ${ostrz}` : 'Zapisano ✓', ostrz ? 'ostrzezenie' : 'sukces');
      if (powrot) setTimeout(() => powrot(true), 700);
    } catch (err) {
      komunikat(err.message, 'blad');
    } finally {
      el('par-zapisz').disabled = false;
    }
  }

  window.parametryOtworz = (artykulGtId, opcje) => {
    pokazWidok('parametry');
    history.pushState({ v: 'parametry' }, '');
    otworz(artykulGtId, opcje);
  };

  el('par-zapisz').addEventListener('click', zapisz);
  el('par-wstecz').addEventListener('click', () => (powrot ? powrot(false) : history.back()));
  for (const id of ['par-dlugosc', 'par-szerokosc', 'par-wysokosc']) {
    el(id).addEventListener('input', odswiezWageGab);
  }
})();
