'use strict';

// Pulpit repricera (ekran Ceny → „Pulpit”): jak idzie automat cen na każdym kanale — Buy Box teraz i dobę/tydzień
// temu, co automat wysłał, czy platformy to przyjęły, czy worker żyje, trend dzień po dniu. Czyste funkcje (bez
// SQLite i GT) — testy w test/pricing-pulpit.test.js; dane z pricing.db zbiera pricing/pulpit.js, FS z GT
// services/gt-sprzedaz.js, składa trasa GET /api/ceny/pulpit.
//
// Dane są deduplikowane (pricing/bez-zmian.js), więc liczymy z ODCINKÓW, nie z liczby wierszy:
//  - wiersz `obserwacje` to odcinek [czas, widziana] — niezmieniony stan nie dostaje nowego wiersza, tylko podbija
//    `widziana` (eMAG, Empik, Allegro, Kaufland; Amazon dopisuje wiersz przy każdej obserwacji, widziana = NULL).
//    Stan oferty w chwili T = ostatni odcinek rozpoczęty ≤ T — o ile ktoś go potwierdził najdalej TOLERANCJA_H
//    przed T. Bez tego warunku oferta, która wypadła z obserwacji (skończył się stan), wisiałaby w liczbie Buy
//    Boxów na zawsze.
//  - niewysłana decyzja bez zmian nie dostaje wiersza — ostatnia decyzja ≤ T obowiązuje aż do następnej.

const filtry = require('./filtry-cen');

// Pełny przegląd ofert bez automatu (Amazon, Empik) idzie co 6 h (PRICING_PELNY_MIN) — plus zapas na długi przebieg.
const TOLERANCJA_H = 8;
const GODZ = 3600e3;
const OKNA_H = { h24: 24, d7: 7 * 24 };
// Wysłana zmiana, której po godzinie dalej nie widać na platformie (i nic jej nie zastąpiło), to już nie „w drodze”.
const CZEKA_MIN = 60;

// Czas w bazie: UTC w formacie CURRENT_TIMESTAMP ('2026-10-17 22:54:54') — napisy porównują się jak daty.
const doBazy = (d) => new Date(d).toISOString().replace('T', ' ').slice(0, 19);
const zBazy = (s) => (s ? new Date(String(s).replace(' ', 'T') + 'Z') : null);
const minutyMiedzy = (a, b) => (zBazy(b) - zBazy(a)) / 60000;
const dwie = (n) => String(n).padStart(2, '0');
const dzienLokalny = (d) => `${d.getFullYear()}-${dwie(d.getMonth() + 1)}-${dwie(d.getDate())}`;

// Ostatnie `ile` dni kalendarzowych czasu LOKALNEGO (serwer stoi w Polsce), od najstarszego. Koniec dnia = północ
// następnego dnia, dla dzisiejszego — `teraz`. Dzień zamknięty się już nie zmienia, więc wolno go zapamiętać.
function dniOkna(ile, teraz = new Date()) {
  const t = new Date(teraz);
  const wynik = [];
  for (let i = ile - 1; i >= 0; i--) {
    const pocz = new Date(t.getFullYear(), t.getMonth(), t.getDate() - i);
    const nast = new Date(t.getFullYear(), t.getMonth(), t.getDate() - i + 1);
    wynik.push({ dzien: dzienLokalny(pocz), koniec: nast > t ? t : nast, zamkniety: nast <= t });
  }
  return wynik;
}
const OKNA_TRENDU = [7, 14, 30];
const oknoTrendu = (v) => (OKNA_TRENDU.includes(Number(v)) ? Number(v) : 14);

// Jedna oferta na (towar, kanał) — jak w macierzy (routes/ceny.js): ten sam towar bywa wystawiony dwa razy na jednym
// rynku (SKU z dopiskiem -1); liczy się oferta z większym stanem, przy remisie wcześniejsza.
function jednaNaTowar(oferty) {
  const m = new Map();
  for (const o of oferty) {
    const k = `${o.tw_id}|${o.kolumna}`;
    const byla = m.get(k);
    if (!byla || (o.ilosc || 0) > (byla.ilosc || 0) || ((o.ilosc || 0) === (byla.ilosc || 0) && o.id < byla.id)) m.set(k, o);
  }
  return [...m.values()];
}

// Buy Box w chwili T, per kanał. wiersze — oferty z ostatnim odcinkiem obserwacji rozpoczętym ≤ T:
//   { id, tw_id, kolumna, ilosc, auto (dziś), bb_nasz, w (koniec odcinka), zysk (zł/szt. z ostatniej decyzji ≤ T) }
// Grupa `automat` = oferty z automatem DZIŚ (ta sama lista w każdej chwili — porównanie tych samych ofert przed i po).
// Zysk sumujemy tylko na ofertach z naszym Buy Boxem: tam sprzedajemy po tej cenie, a oferta z ceną-zaporą
// (HWHGHK15 FR: 6193 € i „zysk” 16 755 zł) bez BB zjadłaby całą sumę.
// bezSwiezosci — dla „teraz”: populację daje już macierz (aktywna, ze stanem), więc liczymy jak ona: ostatni znany stan.
function stanNaChwile(wiersze, T, { tolerancjaH = TOLERANCJA_H, bezSwiezosci = false } = {}) {
  const granica = doBazy(new Date(T).getTime() - tolerancjaH * GODZ);
  const swieze = bezSwiezosci ? wiersze : wiersze.filter((o) => (o.w || '') >= granica);
  const grupa = () => ({ ofert: 0, bb: 0, ids: new Set(), bbIds: new Set() });
  const m = new Map();
  for (const o of jednaNaTowar(swieze)) {
    let k = m.get(o.kolumna);
    if (!k) m.set(o.kolumna, k = { wszystkie: grupa(), automat: { ...grupa(), zysk: 0, zysk_n: 0 } });
    const dodaj = (g) => { g.ofert++; g.ids.add(o.id); if (o.bb_nasz === 1) { g.bb++; g.bbIds.add(o.id); } };
    dodaj(k.wszystkie);
    if (o.auto) {
      dodaj(k.automat);
      if (o.bb_nasz === 1 && o.zysk != null) { k.automat.zysk += o.zysk; k.automat.zysk_n++; }
    }
  }
  return m;
}

// Same liczby (bez zbiorów id) — do zapamiętania dnia zamkniętego.
const liczbyStanu = (m) => new Map([...m].map(([k, s]) => [k, {
  wszystkie: { ofert: s.wszystkie.ofert, bb: s.wszystkie.bb },
  automat: { ofert: s.automat.ofert, bb: s.automat.bb, zysk: Math.round(s.automat.zysk * 100) / 100, zysk_n: s.automat.zysk_n },
}]));

// Zmiana liczby Buy Boxów między dwiema chwilami (grupy ze stanNaChwile). `zyskane`/`stracone` tylko wśród ofert
// widzianych w OBU chwilach — oferta, która doszła (nowy rynek, wrócił stan) albo wypadła, zmienia liczbę, ale nie
// jest ani wygraną, ani przegraną. Kanał bez obserwacji w chwili `przed` (eMAG HU przed 15.10) → przed = null:
// porównanie z zerem udawałoby setki zdobytych Buy Boxów.
function bilansBb(teraz, przed) {
  if (!teraz) return null;
  if (!przed || !przed.ofert) return { teraz: teraz.bb, ofert: teraz.ofert, przed: null, zmiana: null, zyskane: null, stracone: null };
  let zyskane = 0, stracone = 0;
  for (const id of teraz.bbIds) if (przed.ids.has(id) && !przed.bbIds.has(id)) zyskane++;
  for (const id of przed.bbIds) if (teraz.ids.has(id) && !teraz.bbIds.has(id)) stracone++;
  return { teraz: teraz.bb, ofert: teraz.ofert, przed: przed.bb, zmiana: teraz.bb - przed.bb, zyskane, stracone };
}

// Suma bilansów kanałów (kafel „Razem”). Zmiana tylko z kanałów, które mają z czym porównać — `czesciowo` mówi,
// że któryś kanał z Buy Boxami teraz nie miał wtedy obserwacji (np. eMAG HU w pierwszym tygodniu).
function zsumujBilanse(bilanse) {
  const w = { teraz: 0, ofert: 0, przed: 0, zmiana: 0, zyskane: 0, stracone: 0, czesciowo: false, porownanie: false };
  for (const b of bilanse) {
    if (!b) continue;
    w.teraz += b.teraz; w.ofert += b.ofert;
    if (b.przed == null) { if (b.ofert) w.czesciowo = true; continue; }
    w.porownanie = true;
    w.przed += b.przed; w.zmiana += b.zmiana; w.zyskane += b.zyskane; w.stracone += b.stracone;
  }
  if (!w.porownanie) Object.assign(w, { przed: null, zmiana: null, zyskane: null, stracone: null });
  delete w.porownanie;
  return w;
}

// Czy obserwowana cena to ta, którą wysłaliśmy. eMAG przyjmuje cenę NETTO z 4 miejscami i sam liczy brutto, więc
// widzimy ją o grosz–kilka groszy inną (HU: wysłane 10 658,90 Ft, na stronie 10 658,87; BG 25,86 → 25,87 €).
// Dopuszczamy 0,1% ceny, ale nigdy więcej niż połowę zmiany — schodek 1 Ft nie może „potwierdzić się” starą ceną.
const POTW_ABS = 0.005, POTW_WZGL = 0.001;
const cenaPotwierdzona = (obs, nowa, przed) => obs != null && nowa != null
  && Math.abs(obs - nowa) <= Math.max(POTW_ABS, Math.min(Math.abs(nowa - (przed ?? nowa)) / 2, Math.abs(nowa) * POTW_WZGL));
// To samo w SQL — pricing/pulpit.js szuka nim pierwszej obserwacji z nową ceną; test pilnuje zgodności z JS.
const sqlCenaPotwierdzona = (obs, nowa, przed) => `(${obs} IS NOT NULL AND ABS(${obs} - ${nowa}) <= MAX(${POTW_ABS}, `
  + `MIN(ABS(${nowa} - COALESCE(${przed}, ${nowa})) / 2.0, ABS(${nowa}) * ${POTW_WZGL})))`;

function kwantyl(posortowane, p) {
  if (!posortowane.length) return null;
  const i = (posortowane.length - 1) * p;
  const d = Math.floor(i), g = Math.ceil(i);
  return Math.round((posortowane[d] + (posortowane[g] - posortowane[d]) * (i - d)) * 10) / 10;
}

// Co automat (i człowiek z ekranu) wysłał na platformy w ostatniej dobie i tygodniu. wiersze — decyzje z 7 dni,
// które poszły na platformę albo platforma je odrzuciła:
//   { oferta_id, kolumna, sku, czas, cena_przed, cena_nowa, kod, wyslano, blad, potw }
// potw = czas pierwszej obserwacji z wysłaną ceną (null = jeszcze jej nie widzieliśmy). Czas potwierdzenia jest
// ograniczony z dołu rytmem obserwacji (Amazon: potwierdzenie po 5 min, potem co przebieg) — to „po ilu minutach
// zobaczyliśmy nową cenę”, nie czas wdrożenia po stronie platformy.
// Niepotwierdzona = ostatnia wysyłka oferty (późniejsza ją zastępuje), sprzed ponad CZEKA_MIN, nigdy niewidziana.
function aktywnosc(wiersze, teraz = new Date(), { czekaMin = CZEKA_MIN } = {}) {
  const T = new Date(teraz).getTime();
  const od24 = doBazy(T - OKNA_H.h24 * GODZ), od7 = doBazy(T - OKNA_H.d7 * GODZ), terazB = doBazy(T);
  const ostatnia = new Map();
  for (const w of wiersze) if (w.wyslano && !(ostatnia.get(w.oferta_id) >= w.czas)) ostatnia.set(w.oferta_id, w.czas);
  const licznik = () => ({ gora: 0, dol: 0, reczne: 0, odrzucone: 0 });
  const m = new Map();
  const daj = (k) => m.get(k) || m.set(k, { h24: licznik(), d7: licznik(), czasy: [], niepotwierdzone: 0, ostatni_blad: null }).get(k);
  for (const w of wiersze) {
    if (w.czas < od7) continue;
    for (const g of [daj(w.kolumna), daj('razem')]) {
      const okna = w.czas >= od24 ? [g.h24, g.d7] : [g.d7];
      for (const l of okna) {
        if (!w.wyslano) { if (w.blad) l.odrzucone++; continue; }
        if (w.kod === 'korekta') l.reczne++;
        else if (w.cena_nowa > w.cena_przed) l.gora++;
        else l.dol++;
      }
      if (w.wyslano && w.potw) g.czasy.push(minutyMiedzy(w.czas, w.potw));
      if (w.wyslano && !w.potw && ostatnia.get(w.oferta_id) === w.czas && minutyMiedzy(w.czas, terazB) > czekaMin) g.niepotwierdzone++;
      if (!w.wyslano && w.blad && !(g.ostatni_blad?.czas > w.czas)) g.ostatni_blad = { czas: w.czas, sku: w.sku, tekst: w.blad };
    }
  }
  for (const g of m.values()) {
    const s = g.czasy.sort((a, b) => a - b);
    g.potwierdzenie = { n: s.length, mediana: kwantyl(s, 0.5), p90: kwantyl(s, 0.9), max: s.length ? Math.round(s[s.length - 1]) : null };
    delete g.czasy;
  }
  return m;
}

// Teraz „w drodze”: ostatnia decyzja oferty wysłana, a nowszej obserwacji jeszcze nie ma — ta sama reguła co „czeka
// na potwierdzenie” w macierzy (cenyPoWyslaniu w public/desktop/app.js). oferty — te, które pokazuje macierz.
function czekajace(oferty, teraz = new Date()) {
  const terazB = doBazy(teraz);
  const m = new Map();
  for (const o of oferty) {
    if (!o.wyslano || !o.dec_czas || (o.obs_czas && o.obs_czas > o.dec_czas)) continue;
    const min = Math.max(0, Math.round(minutyMiedzy(o.dec_czas, terazB)));
    for (const k of [o.kolumna, 'razem']) {
      const g = m.get(k) || m.set(k, { n: 0, najdluzej_min: 0 }).get(k);
      g.n++;
      g.najdluzej_min = Math.max(g.najdluzej_min, min);
    }
  }
  return m;
}

// Liczniki sytuacji macierzy per kanał — te same definicje (pricing/filtry-cen.js), więc kafel pokazuje dokładnie
// tyle, ile pokaże macierz po kliknięciu (kanał + sytuacja). oferty — pokazywane w macierzy (jedna na towar i kanał).
function sytuacjeKanalow(oferty) {
  const m = new Map();
  const zero = () => Object.fromEntries(filtry.SYTUACJE.map((s) => [s.klucz, 0]));
  for (const o of oferty) {
    const k = m.get(o.kolumna) || m.set(o.kolumna, { wszystkie: zero(), automat: zero() }).get(o.kolumna);
    for (const s of filtry.SYTUACJE) {
      if (filtry.ofertaPasuje(o, 'wszystkie', s.klucz)) k.wszystkie[s.klucz]++;
      if (filtry.ofertaPasuje(o, 'automat', s.klucz)) k.automat[s.klucz]++;
    }
  }
  return m;
}

// --- Zdrowie workera i synchronizacji -------------------------------------------------------------------------
// Listy ofert: eMAG, Allegro i Kaufland co przebieg (ta sama lista służy do obserwacji), Amazon i Empik raz na dobę
// (pricing/worker.js). Klucze `stan` jak w workerze.
const SYNCHRONIZACJE = [
  { platforma: 'amazon', nazwa: 'Amazon', sync: 'sync_oferty', blad: null, rytm: 'doba' },
  { platforma: 'emag', nazwa: 'eMAG', sync: 'sync_emag', blad: 'blad_emag', rytm: 'przebieg' },
  { platforma: 'empik', nazwa: 'Empik', sync: 'sync_empik', blad: 'blad_empik', rytm: 'doba' },
  { platforma: 'allegro', nazwa: 'Allegro', sync: 'sync_allegro', blad: 'blad_allegro', rytm: 'przebieg' },
  { platforma: 'kaufland', nazwa: 'Kaufland', sync: 'sync_kaufland', blad: 'blad_kaufland', rytm: 'przebieg' },
];
const parsuj = (s) => { try { return JSON.parse(s); } catch { return null; } };

// stan — wiersze tabeli `stan` jako { klucz: { wartosc, czas } }; obserwacje — Map platforma → koniec ostatniego
// odcinka obserwacji; platformy — Set platform, które mają oferty (reszta = „niepodłączona”, nie „błąd”).
function zdrowie({ stan = {}, teraz = new Date(), interwalMin = 30, zapis = false, obserwacje = new Map(), platformy = new Set() }) {
  const terazB = doBazy(teraz);
  const wiek = (czas) => (czas ? Math.round(minutyMiedzy(czas, terazB)) : null);
  const p = stan.przebieg;
  const w = p ? parsuj(p.wartosc) || {} : null;
  const blad = stan.blad && (!p || stan.blad.czas > p.czas) ? { czas: stan.blad.czas, tekst: stan.blad.wartosc } : null;
  const ostatni = [p?.czas, stan.blad?.czas].filter(Boolean).sort().pop() || null;
  // Przebieg co interwał; „stoi”, gdy od ostatniego (udanego albo nie) minęły dwa interwały z zapasem.
  const stoi = !ostatni || wiek(ostatni) > 2 * interwalMin + 15;
  const worker = {
    stan: !p && !stan.blad ? 'brak' : stoi ? 'stoi' : blad ? 'blad' : 'ok',
    przebieg_czas: p?.czas || null, minut_temu: wiek(p?.czas), sekundy: w?.sekundy ?? null,
    ofert: w?.ofert ?? null, pelny: w?.pelny ?? null, wysylka: w?.wysylka || null,
    blad, interwal_min: interwalMin, pelna_obserwacja: stan.obserwacja_pelna?.czas || null,
  };
  const limitMin = (rytm) => (rytm === 'doba' ? 26 * 60 : 3 * interwalMin);
  const plat = SYNCHRONIZACJE.map((s) => {
    const sync = stan[s.sync] || null;
    const b = s.blad && stan[s.blad] && (!sync || stan[s.blad].czas > sync.czas) ? { czas: stan[s.blad].czas, tekst: stan[s.blad].wartosc } : null;
    const obs = obserwacje.get(s.platforma) || null;
    const stanP = !sync && !b && !platformy.has(s.platforma) ? 'brak' : b ? 'blad' : !sync || wiek(sync.czas) > limitMin(s.rytm) ? 'opoznienie' : 'ok';
    return { platforma: s.platforma, nazwa: s.nazwa, rytm: s.rytm, stan: stanP, sync_czas: sync?.czas || null,
      sync_minut_temu: wiek(sync?.czas), blad: b, obserwacja_czas: obs, obserwacja_minut_temu: wiek(obs) };
  });
  return { worker, zapis: !!zapis, platformy: plat };
}

// --- Sprzedaż z FS wg „Źródła zamówienia” ----------------------------------------------------------------------
// Pole „Źródło” na FS (pw_Dane −2, Tekst04) wpisuje integrator. Sellasist od 2026-10-14 12:22 pisze Amazon_DE,
// Amazon_FR, Amazon_IT, Kaufland_DE — wcześniej każdy rynek jako „marketplace”. Rynek takiej FS siedzi wtedy w
// KATEGORII dokumentu (dok_KatId → sl_Kategoria): od 2026-08-26 każda FS Sellasist ma `Amazon_DE`, `Amazon_FR`
// albo `Kaufland`, a po 14.10 kategoria zgadza się ze „Źródłem” w 100% (OKITRADE, 2026-10-20). „marketplace” bez
// takiej kategorii (Amazon IT przed 14.10 ma „Sprzedaż”) zostaje w osobnym kubełku. BaseLinker: „amazon” (Amazon PL,
// w PLN), emagro/emaghu/emagbg, empik, „Allegro - <konto>” (sprawdzone na OKITRADE 2026-10-18). Reszta (personal,
// tergpl, erli…) to kanały spoza repricera.
const MARKETPLACE = '_marketplace', INNE = '_inne';
const ALLEGRO_KONTA_FS = { 'ekajtek_pl': 'ALLEGRO_EKAJTEK', 'natropiezabawek': 'ALLEGRO_NATROPIE' };
// Rynek z kategorii dokumentu — tylko dla FS „marketplace”. Kategoria `Kaufland` nie mówi, który kraj, więc
// Kaufland DE tylko przy EUR (dziś jedyny Kaufland w repricerze); inna waluta = nie wiemy.
function kolumnaKategorii(kategoria, waluta, klucze) {
  const k = String(kategoria || '').trim().toLowerCase();
  let r;
  if ((r = k.match(/^amazon_([a-z]{2})$/)) && klucze.has(r[1].toUpperCase())) return r[1].toUpperCase();
  if (k === 'kaufland' && String(waluta || '').toUpperCase() === 'EUR' && klucze.has('KAUFLAND_DE')) return 'KAUFLAND_DE';
  return MARKETPLACE;
}
function kolumnaZrodla(zrodlo, waluta, klucze, kategoria) {
  const z = String(zrodlo || '').trim().toLowerCase();
  const jest = (k) => (klucze.has(k) ? k : INNE);
  let r;
  if ((r = z.match(/^amazon_([a-z]{2})$/))) return jest(r[1].toUpperCase());
  if (z === 'amazon') return String(waluta || '').toUpperCase() === 'PLN' ? jest('PL') : INNE;
  if ((r = z.match(/^kaufland_([a-z]{2})$/))) return jest(`KAUFLAND_${r[1].toUpperCase()}`);
  if ((r = z.match(/^emag(ro|hu|bg)$/))) return jest(`EMAG_${r[1].toUpperCase()}`);
  if (z === 'empik') return jest('EMPIK_PL');
  if ((r = z.match(/^allegro\s*-\s*(.+)$/))) return ALLEGRO_KONTA_FS[r[1].trim()] ? jest(ALLEGRO_KONTA_FS[r[1].trim()]) : INNE;
  if (z === 'marketplace') return kolumnaKategorii(kategoria, waluta, klucze);
  return INNE;
}

// dokumenty: [{ dzien, zrodlo, kategoria, waluta, zamowien, szt }], pozycje: [{ dzien, zrodlo, kategoria, waluta, tw_id, szt }],
// kohorta: Map kanał → Set tw_id z automatem (dziś). Zwraca Map dzień → Map kanał → { zamowien, szt, szt_auto }
// (sumę „razem” liczy zlozTrend).
function sprzedazKanalami(dokumenty, pozycje, kohorta, klucze) {
  const m = new Map();
  const daj = (dzien, k) => {
    const d = m.get(dzien) || m.set(dzien, new Map()).get(dzien);
    return d.get(k) || d.set(k, { zamowien: 0, szt: 0, szt_auto: 0 }).get(k);
  };
  for (const x of dokumenty) {
    const g = daj(x.dzien, kolumnaZrodla(x.zrodlo, x.waluta, klucze, x.kategoria));
    g.zamowien += Number(x.zamowien) || 0;
    g.szt += Number(x.szt) || 0;
  }
  for (const x of pozycje) {
    const k = kolumnaZrodla(x.zrodlo, x.waluta, klucze, x.kategoria);
    if (kohorta.get(k)?.has(Number(x.tw_id))) daj(x.dzien, k).szt_auto += Number(x.szt) || 0;
  }
  return m;
}

// Trend dzień po dniu: stany — Map dzień → Map kanał → liczby ze stanNaChwile (koniec dnia); sprzedaz — wynik
// sprzedazKanalami albo null (GT nie odpowiada). Kanał bez obserwacji danego dnia → null (punkt pusty, nie zero).
const POLA_TRENDU = ['bb', 'bb_auto', 'zysk_auto', 'zysk_auto_n', 'zamowien', 'szt', 'szt_auto'];
function zlozTrend(dni, stany, sprzedaz, klucze) {
  const kanaly = [...klucze, MARKETPLACE, INNE, 'razem'];
  const wynik = Object.fromEntries(kanaly.map((k) => [k, []]));
  for (const { dzien } of dni) {
    const s = stany.get(dzien) || new Map();
    const f = sprzedaz?.get(dzien);
    const razem = Object.fromEntries(POLA_TRENDU.map((p) => [p, null]));
    for (const k of kanaly.slice(0, -1)) {
      const st = s.get(k);
      const sp = sprzedaz ? (f?.get(k) || { zamowien: 0, szt: 0, szt_auto: 0 }) : null;
      // Zysk nieznany, gdy Buy Boxy są, a żaden nie ma zysku z kalkulatora (Amazon PL: brak pasa) — wtedy „—”, nie 0.
      const zyskZnany = st?.automat.ofert && !(st.automat.bb > 0 && !st.automat.zysk_n);
      const pkt = {
        bb: st?.wszystkie.ofert ? st.wszystkie.bb : null,
        bb_auto: st?.automat.ofert ? st.automat.bb : null,
        zysk_auto: zyskZnany ? Math.round(st.automat.zysk * 100) / 100 : null,
        zysk_auto_n: zyskZnany ? st.automat.zysk_n : null,
        zamowien: sp ? sp.zamowien : null, szt: sp ? sp.szt : null, szt_auto: sp ? sp.szt_auto : null,
      };
      wynik[k].push(pkt);
      for (const p of POLA_TRENDU) if (pkt[p] != null) razem[p] = Math.round(((razem[p] || 0) + pkt[p]) * 100) / 100;
    }
    wynik.razem.push(razem);
  }
  // Suma „razem” z Buy Boxów rośnie, gdy dochodzi kanał (eMAG HU od 15.10) — to nie zdobyte Buy Boxy. Dla każdego
  // dnia: które kanały z danymi dziś wtedy jeszcze ich nie miały (ekran rysuje taki punkt jako niepełny).
  const braki = {};
  for (const p of ['bb', 'bb_auto']) {
    const ost = dni.length - 1;
    const dzis = [...klucze].filter((k) => wynik[k][ost]?.[p] != null);
    braki[p] = dni.map((_, i) => dzis.filter((k) => wynik[k][i][p] == null));
  }
  return { dni: dni.map((d) => d.dzien), kanaly: wynik, braki };
}

module.exports = {
  TOLERANCJA_H, CZEKA_MIN, OKNA_TRENDU, MARKETPLACE, INNE, SYNCHRONIZACJE, POLA_TRENDU,
  doBazy, zBazy, dzienLokalny, dniOkna, oknoTrendu, jednaNaTowar, stanNaChwile, liczbyStanu, bilansBb, zsumujBilanse,
  cenaPotwierdzona, sqlCenaPotwierdzona, aktywnosc, czekajace, sytuacjeKanalow, zdrowie, kolumnaZrodla,
  sprzedazKanalami, zlozTrend,
};
