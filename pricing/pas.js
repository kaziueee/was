'use strict';

// Pas cenowy [min, max] dla oferty — z kalkulatora WMS (services/cennik.js → config/rynki.js),
// tej samej matematyki co zakładka Cennik. min = cena przy docelowej marży (domyślnie 20%),
// max = min × MNOZNIK_MAX. Wycena hurtem po tw_Id (jedno zapytanie GT na 500 towarów).
//
// Klucze wyniku = klucze kolumn (pricing/kolumny.js): DE, FR, …, EMAG_RO. Kanał bez rynku w
// kalkulatorze → brak pasa → repricer nie decyduje (brak_pasa); Amazon PL ma rynek od 2026-10-22.
//
// eMAG: profil Genius / bez Genius rozstrzyga oferta z API (genius_computed), a gdy jej nie ma —
// wymiary z GT (services/cennik.js). Towar z Genius ma inny koszt (opłata Genius, tańsza wysyłka),
// więc i inne minimum.

const { wycenaHurtem } = require('../services/cennik');
const rynki = require('../config/rynki');
const { KOLUMNY, kluczKolumny } = require('./kolumny');
const { MNOZNIK_MAX, zGranicami } = require('./granice');
const { referencjaRynku, nadpisaniaKalkulatora } = require('./strategie');

// Platformy, na których stawka prowizji przychodzi z oferty (oferty.prowizja), a nie z config/rynki.js:
// eMAG (commission/estimate), Empik (kategoria), Allegro (podgląd opłat). Jedna lista dla workera, karty i ręcznej ceny.
const PROWIZJA_Z_OFERTY = new Set(['emag', 'empik', 'allegro']);

// wycena (z wycenaHurtem) → { DE: {min, max, koszt, waga, ocen(cena) → {zysk, marza}}, …, EMAG_RO }
// `ocen` liczy zysk (zł) i marżę (%) przy DOWOLNEJ cenie tą samą matematyką co Cennik
// (rynki.wycenaPrzyCenie) — repricer zapisuje je przy każdej decyzji, ekran tylko czyta.
// opcje.genius — Genius oferty eMAG z API (true/false); brak = z wymiarów GT.
// opcje.prowizja — stawka prowizji oferty z platformy (eMAG commission/estimate); brak = z config/rynki.
// Obie mogą być liczbą/flagą dla wszystkich kolumn eMAG albo obiektem { EMAG_RO: 16, EMAG_HU: 18 } —
// ten sam towar ma na każdym rynku inną stawkę i może mieć Genius tylko na części z nich.
// opcje.strategia — strategia towaru (pricing/strategie.js; z pricing/strategie-dane.js): { id, nazwa, typ,
// parametry, sprzedaz? }. Zmienia tylko pas: min = cena z kalkulatora przy parametrach strategii (najwyższa
// z jej podłóg), max = min × mnożnik. Bez strategii — dzisiejszy pas (marża 20%, × 1,5). Wynik ze strategią
// ma `zrodlo: 'strategia'`, `strategia` (id, nazwa, typ), `bazowy` (pas bez strategii) i `referencja`
// („za rynkiem”: kanał, zysk, mediana, szt.).
function pasyZWyceny(w, { genius, prowizja, strategia = null } = {}) {
  if (!w) return {};
  const dlaKolumny = (v, klucz) => (v != null && typeof v === 'object' ? v[klucz] : v);
  // Docinanie kartonu ZAWSZE uwzględnione (decyzja usera 2026-10-14): towar oznaczony „Docinanie
  // kartonu: tak” jedzie w przyciętym kartonie, czyli w niższym progu DHL. Bez tego minimum było
  // wyższe niż w teście Automate Pricing z 06.10 (np. NERF7376 FR 47,99 zamiast 33,99 €).
  const g = { ...rynki.DOMYSLNE, waga: w.waga, paczka: w.paczka, docinanie: w.docinalny, docinanieOn: true,
    genius: typeof genius === 'boolean' ? genius : w.genius };      // obiekt per kolumna — niżej, w pętli
  const out = {};
  for (const k of KOLUMNY) {
    // Minimum liczone TUTAJ z `g` (z docinaniem), nie brane z w.rynki — tamta wycena (services/cennik)
    // idzie z checkboxem docinania wyłączonym. Wcześniej docinanie działało tylko w `ocen`, a minimum
    // zostało bez niego: 2026-10-14 automat podniósł przez to FR NERF7376 33,99 → 47,99 €.
    let def = k.kalkulator && rynki.RYNKI.find((x) => x.nazwa === k.kalkulator);
    if (!def) continue;
    if (k.rynekNadpisz) def = { ...def, ...k.rynekNadpisz };     // np. Allegro NaTropie bez Ads
    let gk = g;
    if (PROWIZJA_Z_OFERTY.has(k.platforma)) {
      const p = dlaKolumny(prowizja, k.klucz), gen = dlaKolumny(genius, k.klucz);
      if (p > 0) def = { ...def, prowizja: p };
      if (typeof gen === 'boolean') gk = { ...g, genius: gen };
    }
    const r = rynki.policzRynek(+w.koszt || 0, def, gk);
    if (r && r.cena > 0 && !r.blad) {
      out[k.klucz] = {
        min: r.cena, max: +(r.cena * MNOZNIK_MAX).toFixed(2), koszt: w.koszt, waga: w.waga,
        ocen: (cena) => {
          const x = rynki.wycenaPrzyCenie(w.koszt, def, gk, cena);
          return x.blad ? null : { zysk: +x.zysk.toFixed(2), marza: +x.marza.toFixed(1) };
        },
        // podłoga przy innych ustawieniach kalkulatora (strategia) — te same koszty, prowizja i Genius
        policz: (nadpisz) => {
          const x = rynki.policzRynek(+w.koszt || 0, def, { ...gk, ...nadpisz });
          return x && x.cena > 0 && !x.blad ? x.cena : null;
        },
      };
    }
  }
  return strategia ? zeStrategia(out, strategia) : out;
}

// Pas strategii z pasów kalkulatora (te same koszty per kanał). „Za rynkiem” najpierw wybiera rynek referencyjny
// z zysku przy medianie cen sprzedaży — liczonego kalkulatorem TEGO kanału, więc porównanie między walutami
// idzie tymi samymi kursami, co cała reszta. Kanał, na którym strategii nie da się policzyć, zostaje na pasie
// bez strategii (lepiej dzisiejsze granice niż żadne).
function zeStrategia(pasy, strategia) {
  const referencja = strategia.typ === 'za_rynkiem'
    ? referencjaRynku(strategia.sprzedaz || {}, (k, cena) => pasy[k]?.ocen(cena) || null, { minSzt: strategia.parametry.minSzt })
    : null;
  const nadpisania = nadpisaniaKalkulatora(strategia, referencja);
  const out = {};
  for (const [k, pas] of Object.entries(pasy)) {
    const podlogi = nadpisania.map((n) => pas.policz(n)).filter((x) => x > 0);
    if (!podlogi.length) { out[k] = pas; continue; }
    const min = +Math.max(...podlogi).toFixed(2);   // do99 w kalkulatorze bywa 31,990000000000002
    out[k] = { ...pas, min, max: +(min * strategia.parametry.mnoznik).toFixed(2), zrodlo: 'strategia',
      strategia: { id: strategia.id, nazwa: strategia.nazwa, typ: strategia.typ }, bazowy: { min: pas.min, max: pas.max }, referencja };
  }
  return out;
}

// twIds → Map(tw_Id → pasy wszystkich kanałów). geniusPoTw / prowizjaPoTw: Map(tw_Id → { kolumna: wartość })
// z ofert eMAG (Genius z API, stawka z commission/estimate) — patrz pasyZWyceny.
// strategiePoTw: Map(tw_Id → strategia) — tylko AKTYWNE przypisania (pricing/strategie-dane.js); brak = dziś.
async function pasyHurtem(twIds, geniusPoTw = new Map(), prowizjaPoTw = new Map(), strategiePoTw = new Map()) {
  const wyceny = await wycenaHurtem(twIds);
  return new Map([...wyceny].map(([id, w]) => [id, pasyZWyceny(w, { genius: geniusPoTw.get(id), prowizja: prowizjaPoTw.get(id), strategia: strategiePoTw.get(id) })]));
}

// Pas JEDNEJ oferty (karta SKU, ręczna cena, granice): ta sama wycena co w workerze — Genius i stawka
// prowizji z wiersza oferty eMAG — plus ręczne granice oferty (pricing/granice.js). w = wycena towaru
// z wycenaHurtem (null = Subiekt nie odpowiada). Zwraca { pas, kalk }: pas po granicach (null = brak
// pasa) i pas z samego kalkulatora (null = rynek bez kalkulatora / brak wyceny).
// Genius i stawka prowizji per kanał ze WSZYSTKICH ofert towaru — tak, jak buduje je worker. Strategia „za
// rynkiem” porównuje zysk między kanałami, więc karta i podgląd muszą znać koszty każdego kanału, nie tylko oferty.
function opcjeZOfert(oferty = []) {
  const genius = {}, prowizja = {};
  for (const o of oferty) {
    const k = kluczKolumny(o.platforma, o.rynek);
    if (o.platforma === 'emag' && o.genius != null) genius[k] = !!o.genius;
    if (PROWIZJA_Z_OFERTY.has(o.platforma) && o.prowizja > 0) prowizja[k] = o.prowizja;
  }
  return { genius, prowizja };
}

// strategia — strategia towaru, gdy aktywna (karta SKU, ręczna cena) albo podglądana; null = dziś. `kalk` to
// wtedy pas strategii (ręczne granice oferty i tak go nadpisują — odstępstwo od strategii). oferty — wszystkie
// oferty towaru (opcjeZOfert); bez nich Genius i prowizja tylko z tej oferty.
function pasOferty(w, o, { strategia = null, oferty = null } = {}) {
  const klucz = kluczKolumny(o.platforma, o.rynek);
  const opcje = oferty ? { ...opcjeZOfert(oferty), strategia } : {
    genius: o.platforma === 'emag' && o.genius != null ? { [klucz]: !!o.genius } : undefined,
    prowizja: PROWIZJA_Z_OFERTY.has(o.platforma) && o.prowizja > 0 ? { [klucz]: o.prowizja } : undefined,
    strategia,
  };
  const kalk = (w && pasyZWyceny(w, opcje)[klucz]) || null;
  return { pas: zGranicami(kalk, o), kalk };
}

module.exports = { pasyHurtem, pasyZWyceny, pasOferty, opcjeZOfert, MNOZNIK_MAX, PROWIZJA_Z_OFERTY };
