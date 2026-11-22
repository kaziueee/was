'use strict';

// Allegro CZ / SK / HU w repricerze — osobna cena na każdym rynku (decyzja usera 2026-11-21). Czysta logika (testy
// w test/pricing-allegro-zagranica.test.js); sync, obserwacja i zapis korzystają z niej w pricing/sync-allegro.js,
// pricing/obserwuj-allegro.js, pricing/worker.js i pricing/allegro.js.
//
// Dotąd cenę na rynkach zagranicznych liczyła reguła Allegro przypisana osobno do każdego rynku oferty: CZ i SK
// „Przelicznik cen” (kurs od ceny PL), HU „Cena Węgry” (kurs +11%). Repricer zmieniał tylko PLN. Badanie 20.11.2026
// (42 najlepiej sprzedające się oferty ekajtek): na CZ/SK/HU połowa nie ma żadnej konkurencji, ~10 jest najtańszych
// z zapasem > 2% do następnego — a zagranica to ~43% przychodu z Allegro.
//
// Zasady usera (2026-11-21):
//   • cena na rynku zagranicznym NIGDY niższa niż cena PL po kursie przelicznika Allegro; na Węgrzech niż PL + 11%;
//   • NaTropie na rynku zagranicznym nie taniej niż ekajtek na tym samym rynku (ten sam towar);
//   • bez konkurencji cena rośnie powoli, +3% raz na dobę, do maksimum pasa (pricing/model.js, reguły kolumny).
//
// Wiersz oferty zagranicznej w `oferty`: platforma 'allegro_zagr', rynek '<KONTO>_<KOD>' (EKAJTEK_CZ), asin = numer
// oferty (ten sam co na PL), sku = klucz oferty z PL. Osobna platforma celowo: każde miejsce, które zna tylko
// 'allegro', traktuje te wiersze jako nieznane (zapis odmówi), zamiast zmienić cenę PL.

const RYNKI_ZAGR = [
  { kod: 'CZ', allegro: 'allegro-cz', waluta: 'CZK', znak: 'Kč', kalkulator: 'Allegro CZ', narzutPct: 0, regulaKursu: '644bd75d07bd9c00ddaf5786', jednostka: 1 },
  { kod: 'SK', allegro: 'allegro-sk', waluta: 'EUR', znak: '€', kalkulator: 'Allegro SK', narzutPct: 0, regulaKursu: '644bd75d07bd9c00ddaf5786', jednostka: 0.01 },
  // „Cena Węgry” = przelicznik +11% (6863b926…, reguła konta); podłoga HU = PL po kursie + 11% (zasada usera).
  { kod: 'HU', allegro: 'allegro-hu', waluta: 'HUF', znak: 'Ft', kalkulator: 'Allegro HU', narzutPct: 11, regulaKursu: '6863b926d59f9b0553b533db', jednostka: 5 },
];
const PLATFORMA = 'allegro_zagr';
const KONTO_GLOWNE = 'EKAJTEK';           // NaTropie na zagranicy nie taniej niż ekajtek
const MIN_PROBEK_KURSU = 5;               // tyle ofert pod regułą przelicznika, żeby ufać medianie

const definicja = (kod) => RYNKI_ZAGR.find((r) => r.kod === kod) || null;
const rynekOferty = (konto, kod) => `${konto}_${kod}`;
function zRynkuOferty(rynek) {
  const m = /^([A-Z0-9]+)_(CZ|SK|HU)$/.exec(String(rynek || ''));
  return m ? { konto: m[1], kod: m[2], def: definicja(m[2]) } : null;
}

const liczba = (v) => (v == null || v === '' ? null : Number(v));

// Cena oferty Allegro na rynkach zagranicznych z listy /sale/offers (additionalMarketplaces). Brak rynku = oferty tam
// nie ma (np. cennik dostaw bez CZ). → { CZ: { cena, waluta, regula, typReguly } }
function cenyNaRynkach(surowa) {
  const out = {};
  const am = surowa?.additionalMarketplaces || {};
  for (const d of RYNKI_ZAGR) {
    const sm = am[d.allegro]?.sellingMode;
    const c = liczba(sm?.price?.amount);
    if (!(c > 0)) continue;
    out[d.kod] = { cena: c, waluta: sm.price.currency || null, regula: sm.priceAutomation?.rule?.id || null, typReguly: sm.priceAutomation?.rule?.type || null };
  }
  return out;
}

const cenaPl = (surowa) => (surowa?.sellingMode?.price?.currency === 'PLN' ? liczba(surowa.sellingMode.price.amount) : null);

// Kurs przelicznika Allegro (waluta rynku za 1 zł) — mediana cena_rynku ÷ (cena_PL × (1 + narzut)) z ofert, które
// wciąż stoją pod regułą przelicznika tego rynku. Allegro zaokrągla przeliczone ceny (CZK do 1, HUF do 5), stąd
// mediana, a nie pojedyncza oferta. → { CZ: { kurs, n } } (tylko rynki z ≥ MIN_PROBEK_KURSU próbkami).
function kursyPrzelicznika(surowe) {
  const probki = Object.fromEntries(RYNKI_ZAGR.map((d) => [d.kod, []]));
  for (const s of surowe || []) {
    const pl = cenaPl(s);
    if (!(pl > 0)) continue;
    const ceny = cenyNaRynkach(s);
    for (const d of RYNKI_ZAGR) {
      const c = ceny[d.kod];
      if (c && c.regula === d.regulaKursu && c.waluta === d.waluta) probki[d.kod].push(c.cena / (pl * (1 + d.narzutPct / 100)));
    }
  }
  const out = {};
  for (const [kod, p] of Object.entries(probki)) {
    if (p.length < MIN_PROBEK_KURSU) continue;
    p.sort((a, b) => a - b);
    const m = p.length % 2 ? p[(p.length - 1) / 2] : (p[p.length / 2 - 1] + p[p.length / 2]) / 2;
    out[kod] = { kurs: +m.toFixed(6), n: p.length };
  }
  return out;
}

// Cena do jednostki rynku (CZK 1, EUR 0,01, HUF 5): 'gora' — w górę (podłogi, minimum), inaczej do najbliższej.
function zaokraglij(cena, def, kierunek = 'najblizej') {
  const j = def?.jednostka || 0.01;
  const k = kierunek === 'gora' ? Math.ceil(cena / j - 1e-9) : kierunek === 'dol' ? Math.floor(cena / j + 1e-9) : Math.round(cena / j);
  return +(k * j).toFixed(j < 1 ? 2 : 0);
}

// Podłoga ceny na rynku zagranicznym: max(PL po kursie przelicznika × (1 + narzut), cena oferty konta głównego na tym
// rynku — dla NaTropie). null przy składniku = nie wiemy (brak kursu / ceny PL) — wtedy NIE ma podłogi z PL, a worker
// nie wysyła ceny (bezpieczniej stać niż zejść pod PL). → { podloga, zPl, zGlownego, brak }
function podloga({ cenaPl: pl, kurs, def, cenaGlownego = null }) {
  if (!def) return { podloga: null, brak: 'nieznany rynek' };
  if (!(pl > 0)) return { podloga: null, brak: 'brak ceny PL tej oferty' };
  if (!(kurs > 0)) return { podloga: null, brak: `brak kursu przelicznika Allegro ${def.waluta}` };
  const zPl = zaokraglij(pl * kurs * (1 + def.narzutPct / 100), def, 'gora');
  const zGlownego = cenaGlownego > 0 ? zaokraglij(cenaGlownego, def, 'gora') : null;
  return { podloga: Math.max(zPl, zGlownego || 0), zPl, zGlownego, brak: null };
}

// Pas oferty zagranicznej po podłodze: min = max(min kalkulatora, podłoga), a max liczony od TEGO minimum tym samym
// mnożnikiem co pas (domyślnie × 1,5) — inaczej przy podłodze ponad kalkulatorem max zostawał na podłodze i reguła
// „bez konkurencji +3%” nie miała dokąd rosnąć (symulacja 21.11: MEGB678600 CZ, HASF2377). pas = pas z pricing/pas.js
// (min, max, ocen…) albo null. Bez podłogi (brak kursu / ceny PL) → pas z blad — model nic nie zmieni (brak_pasa).
function zPodloga(pas, p) {
  if (!pas) return pas;
  if (p?.podloga == null) return { ...pas, min: null, blad: `podłoga PL nieznana: ${p?.brak || '?'}` };
  if (!(p.podloga > pas.min)) return { ...pas, podloga: p };
  const mnoznik = pas.min > 0 && pas.max >= pas.min ? pas.max / pas.min : 1;
  return { ...pas, min: p.podloga, max: Math.max(pas.max, +(p.podloga * mnoznik).toFixed(2)), zrodlo_min: 'podloga_pl', podloga: p };
}

// PATCH /sale/product-offers/{id}: cena na JEDNYM rynku zagranicznym. Reguła przelicznika na tym rynku nadpisałaby
// ją przy następnej zmianie ceny PL — najpierw trzeba ją zdjąć (polecenieUsunieciaReguly). → { body, cena, regula } | { blad }
function zmianaCeny(surowa, kod, cena) {
  const def = definicja(kod);
  if (!def) return { blad: `nieznany rynek ${kod}` };
  if (!surowa?.id) return { blad: 'brak numeru oferty Allegro' };
  if (surowa.sellingMode?.format && surowa.sellingMode.format !== 'BUY_NOW') return { blad: `format ${surowa.sellingMode.format} — zmieniamy tylko Kup Teraz` };
  const teraz = cenyNaRynkach(surowa)[kod];
  if (!teraz) return { blad: `oferty nie ma na rynku ${def.allegro}` };
  if (teraz.waluta && teraz.waluta !== def.waluta) return { blad: `waluta ${teraz.waluta} na ${def.allegro} — oczekiwano ${def.waluta}` };
  const c = zaokraglij(Number(cena), def);
  if (!(c > 0)) return { blad: `niepoprawna cena: ${cena}` };
  const amount = def.jednostka < 1 ? c.toFixed(2) : String(c);
  return { body: { additionalMarketplaces: { [def.allegro]: { sellingMode: { price: { amount, currency: def.waluta } } } } }, cena: c, regula: teraz.regula };
}

// POST /sale/offer-price-automation-commands — zdjęcie reguły cenowej z jednego rynku oferty (tym samym poleceniem
// przypisywaliśmy przelicznik przy wystawianiu: modification.set). `remove` potwierdzone 22.11 (BKR3261, oferta
// 15250184686): reguła zeszła tylko z CZ w ~3 s, cena CZ 274 → 275 Kč, PL / SK / HU bez zmian.
const polecenieUsunieciaReguly = (ofertaId, kod) => ({
  modification: { remove: [{ marketplace: { id: definicja(kod).allegro } }] },
  offerCriteria: [{ offers: [{ id: String(ofertaId) }], type: 'CONTAINS_OFFERS' }],
});

module.exports = { RYNKI_ZAGR, PLATFORMA, KONTO_GLOWNE, MIN_PROBEK_KURSU, definicja, rynekOferty, zRynkuOferty, cenyNaRynkach, cenaPl,
  kursyPrzelicznika, zaokraglij, podloga, zPodloga, zmianaCeny, polecenieUsunieciaReguly };
