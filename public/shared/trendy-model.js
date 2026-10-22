'use strict';

// Wspólna logika list produktów z Trendów — desktop (public/desktop/sprzedaz-trendy.js) i telefon (/sprzedaz/).
// Jedna definicja filtrów na oba ekrany, żeby „Trendujące” na telefonie znaczyło to samo co na desktopie.
// Dane: GET /api/analiza/trendy (services/analiza-trendy.js) — okna 7 i 30 dni, każdy wiersz
// [tw_id, szt, netto, zysk (teraz), szt, netto, zysk (poprzednie okno), szt, netto, zysk (rok temu)].
(function () {
  const BRAK_INFO = (id) => [String(id), '', '(bez grupy)', 0, null, null, 0];

  // por: 'prev' (poprzednie okno tej samej długości) | 'rok' (te same dni rok temu)
  function wiersze(X, okno, por) {
    const P = X.produkty[okno];
    return P.w.map((r) => {
      const [id, cs, cn, cz, ps, pn, pz, rs, rn, rz] = r, inf = X.info[id] || BRAK_INFO(id);
      const b = por === 'prev' ? { s: ps, n: pn, z: pz } : { s: rs, n: rn, z: rz };
      return { id, sym: inf[0], nazwa: inf[1], grupa: inf[2], nowosc: !!inf[3], dost: inf[4], dni: inf[5], zestaw: !!inf[6],
        a: { s: cs, n: cn, z: cz }, b, prev: { s: ps, n: pn }, dn: cn - b.n, dz: cz - b.z, dp: b.n > 0 ? (cn / b.n - 1) * 100 : null };
    });
  }

  // [klucz, nazwa, warunek(w, o) — o = { prog (%), baza (szt.) }, domyślne sortowanie ('+' = rosnąco)]
  const FILTRY = [
    ['wszystkie', 'Wszystkie ze sprzedażą', (w) => w.a.s > 0, 'n'],
    ['hity', 'Hity', null, 'n'],
    ['trend', 'Trendujące', (w, o) => Math.max(w.a.s, w.b.s) >= o.baza && (w.b.n <= 0 ? w.a.s >= o.baza : w.dp >= o.prog), 'dn'],
    ['spadek', 'Spadek trendu', (w, o) => Math.max(w.a.s, w.b.s) >= o.baza && w.b.n > 0 && w.dp <= -o.prog, 'dn+'],
    ['strata', 'Ze stratą', (w) => w.a.s > 0 && w.a.z < 0, 'z+'],
    ['zgasl', 'Zgasły', (w, o) => w.prev.s >= o.baza && w.a.s === 0, 'pn'],
    ['nowe', 'Nowości', (w) => w.nowosc && w.a.s > 0, 'n'],
  ];

  // hity = produkty, które razem dają połowę przychodu okna
  function hity(lista) {
    const z = lista.filter((w) => w.a.s > 0).sort((p, q) => q.a.n - p.a.n), suma = z.reduce((a, w) => a + w.a.n, 0), out = new Set();
    let c = 0;
    for (const w of z) { if (c >= suma * 0.5) break; out.add(w.id); c += w.a.n; }
    return out;
  }
  function filtruj(lista, f, o) {
    if (f === 'hity') { const h = hity(lista); return lista.filter((w) => h.has(w.id)); }
    const def = FILTRY.find((x) => x[0] === f) || FILTRY[0];
    return lista.filter((w) => def[2](w, o));
  }
  const klucz = (w, k) => ({ sym: w.sym, as: w.a.s, bs: w.b.s, n: w.a.n, bn: w.b.n, dn: w.dn, dp: w.dp, z: w.a.z, dz: w.dz,
    m: w.a.n ? w.a.z / w.a.n : null, dost: w.dost, dni: w.dni, pn: w.prev.n }[k]);
  // sortuje w miejscu; sort/kier = wybór użytkownika albo null (domyślne filtra). Zwraca [klucz, kierunek].
  function sortuj(lista, f, sort = null, kier = -1) {
    const def = FILTRY.find((x) => x[0] === f) || FILTRY[0];
    const [sk, k] = sort ? [sort, kier] : [def[3].replace('+', ''), def[3].endsWith('+') ? 1 : -1];
    lista.sort((p, q) => {
      const a = klucz(p, sk), b = klucz(q, sk);
      if (a == null) return 1;
      if (b == null) return -1;
      return (typeof a === 'string' ? a.localeCompare(b) : a - b) * k;
    });
    return [sk, k];
  }

  // Oznaczenia na karcie produktu (desktop: Trendy → produkt) — podpowiedzi, co zrobić z ceną. Na razie TYLKO
  // oznaczenia; akcje grupowe i automatyczne (np. „+5% na wszystkich kanałach”) przyjdą później (decyzja usera
  // 2026-10-22). w — wiersz z wiersze(); oferty — GET /api/ceny/towar/:tw_id `oferty` z ceną już po wysłaniu
  // (jak cenyPoWyslaniu w app.js): { id, kanal_nazwa, ilosc, auto, tylko_odczyt, bez_konkurencji, cena, zysk,
  // bb_nasz, bb_cena, bb_nasza_inna, blokada, granice: { min } }.
  // → [{ kod, waga: 'uwaga' | 'info', tekst, oferty: [id], produkt }] — `oferty` = których ofert dotyczy (podświetlenie
  // wiersza; później cel akcji grupowej). `produkt: true` = oznaczenie całego towaru (kończy się / zalega) — dotyczy
  // wszystkich ofert, więc ekran go nie podświetla w wierszach.
  const KONCZY_DNI = 14, ZALEGA_DNI = 120, ZALEGA_SPADEK = -30;
  function oznaczenia(w, oferty = []) {
    const out = [];
    const nazwy = (lista) => [...new Set(lista.map((o) => o.kanal_nazwa))].join(', ');
    const dodaj = (kod, waga, tekst, lista = [], produkt = false) => out.push({ kod, waga, tekst, oferty: lista.map((o) => o.id), produkt });
    const zeStanem = oferty.filter((o) => o.ilosc > 0);
    const zl = (x) => (Math.round(x * 100) / 100).toFixed(2).replace('.', ',');
    // „Dobrze się sprzedaje, ale się kończy” — po to ta karta powstała. Sprzedaż nie spada, a zapasu mniej niż na 2 tygodnie.
    if (w.dost > 0 && w.dni != null && w.dni < KONCZY_DNI && w.a.s > 0 && w.a.s >= w.b.s) {
      dodaj('konczy', 'uwaga', `Kończy się: dostępne ${w.dost} szt. na ~${w.dni} dni, sprzedaż ${w.b.s > 0 ? `${w.a.s} szt. vs ${w.b.s} przed` : `${w.a.s} szt., wcześniej 0`} — rozważ podniesienie cen`,
        zeStanem.filter((o) => !o.tylko_odczyt), true);
    }
    if (w.dni != null && w.dni > ZALEGA_DNI && w.dp != null && w.dp <= ZALEGA_SPADEK) {
      dodaj('zalega', 'info', `Zalega: zapas na ~${w.dni} dni, przychód ${Math.round(w.dp)}% — rozważ obniżkę albo strategię wyprzedaży`, zeStanem, true);
    }
    const pod = zeStanem.filter((o) => o.cena != null && o.granice?.min != null && o.cena < o.granice.min - 0.005);
    if (pod.length) dodaj('pod_min', 'uwaga', `Poniżej minimum automatu: ${nazwy(pod)}`, pod);
    const strata = zeStanem.filter((o) => o.zysk != null && o.zysk < 0);
    if (strata.length) dodaj('strata', 'uwaga', `Strata na sztuce: ${strata.map((o) => `${o.kanal_nazwa} ${zl(o.zysk)} zł`).join(', ')}`, strata);
    const blok = oferty.filter((o) => o.blokada);
    if (blok.length) dodaj('blokada', 'uwaga', `Platforma wstrzymała ofertę przez cenę: ${nazwy(blok)}`, blok);
    // Buy Box u obcego — nie liczymy naszej drugiej oferty ani kanałów, które nie mówią, kto ma najlepszą ofertę.
    const bb = zeStanem.filter((o) => o.cena != null && !o.bez_konkurencji && !o.bb_nasz && !o.bb_nasza_inna && o.bb_cena != null);
    if (bb.length) dodaj('bb_inny', 'info', `Buy Box ma ktoś inny: ${nazwy(bb)}`, bb);
    const reczne = zeStanem.filter((o) => !o.tylko_odczyt && !o.auto);
    if (reczne.length) dodaj('auto_wyl', 'info', `Automat wyłączony: ${nazwy(reczne)}`, reczne);
    return out;
  }

  const api = { wiersze, FILTRY, hity, filtruj, klucz, sortuj, oznaczenia, KONCZY_DNI };
  if (typeof module === 'object' && module.exports) module.exports = api;   // testy (node --test)
  else window.TrendyModel = api;
})();
