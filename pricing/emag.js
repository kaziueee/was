'use strict';

// Adapter eMAG Marketplace (RO) — NA RAZIE TYLKO ODCZYT: lista ofert, Genius, Buy Box. Repricer
// nie wysyła cen na eMAG (routes/ceny.js nie pozwala włączyć automatu, worker wysyła tylko na Amazona).
//
// API: https://marketplace-api.emag.ro/api-3/<zasób>/<akcja>, POST + Basic auth (EMAG_RO_USER /
// EMAG_RO_PASS w .env). eMAG wpuszcza tylko z adresów IP dopisanych w panelu przy użytkowniku API —
// z innego IP odpowiada 403 „You are not allowed to use this API." (nieznany login = 401).
//
// Pola product_offer/read, z których korzystamy (pomiar na 1108 aktywnych ofertach, 2026-10-14):
//   part_number            — nasz symbol (SKU), part_number_key — PNK, czyli identyfikator produktu w eMAG
//   sale_price             — cena NETTO, 4 miejsca po przecinku; brutto = × (1 + VAT) (vat_id 9 = 21%)
//   buy_button_rank        — 1 = mamy Buy Box („buy button"); >1 = przegrywamy; null = oferta nie walczy
//   best_offer_sale_price  — cena netto zwycięzcy. Gdy mamy Buy Box, to NASZA cena — ceny następnego
//                            konkurenta API nie podaje, więc podwyżki „pod konkurenta" na eMAG nie liczymy
//   number_of_offers       — ile ofert na produkcie (z naszą)
//   genius_computed        — >0 = Genius aktywny (1/2/2 = automat; 1/3/0 = kwalifikuje się tylko do
//                            Genius z dostawą do domu, nieaktywny; 0/0/0 = bez Genius)
//   commission             — zawsze null; prowizję bierzemy z faktur (config/rynki.js)

const URL_API = 'https://marketplace-api.emag.ro/api-3';
const VAT_RO = { 9: 0.21, 10: 0.11, 5: 0 };   // z vat/read 2026-10-14; nieznany vat_id = brak ceny brutto
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const zaokr = (x) => Math.round(x * 100) / 100;

const skonfigurowany = () => !!(process.env.EMAG_RO_USER && process.env.EMAG_RO_PASS);

async function api(zasob, akcja, dane = {}, proby = 3) {
  if (!skonfigurowany()) throw new Error('eMAG: brak EMAG_RO_USER / EMAG_RO_PASS w .env');
  const auth = 'Basic ' + Buffer.from(`${process.env.EMAG_RO_USER}:${process.env.EMAG_RO_PASS}`).toString('base64');
  for (let i = 1; ; i++) {
    let r, j;
    try {
      r = await fetch(`${URL_API}/${zasob}/${akcja}`, {
        method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(dane),
      });
      j = await r.json();
    } catch (e) {
      if (i >= proby) throw new Error(`eMAG ${zasob}/${akcja}: ${e.message}`);
      await sleep(2000 * i);
      continue;
    }
    if (r.status === 401 || r.status === 403) throw new Error(`eMAG ${zasob}/${akcja}: HTTP ${r.status} ${(j.messages || []).join(' ')} — sprawdź login i czy IP tej maszyny jest na liście w panelu eMAG`);
    if (r.status === 429 || r.status >= 500) {
      if (i >= proby) throw new Error(`eMAG ${zasob}/${akcja}: HTTP ${r.status}`);
      await sleep(3000 * i);
      continue;
    }
    if (j.isError) throw new Error(`eMAG ${zasob}/${akcja}: ${(j.messages || []).join(' ') || 'błąd'}`);
    return j.results;
  }
}

// Wszystkie oferty konta (aktywne i nie), strona po 100. ~3200 ofert = 32 zapytania.
async function wszystkieOferty() {
  const wynik = [];
  for (let strona = 1; ; strona++) {
    const paczka = await api('product_offer', 'read', { currentPage: strona, itemsPerPage: 100 });
    wynik.push(...paczka);
    if (paczka.length < 100) return wynik;
    await sleep(300);
  }
}

const brutto = (netto, vatId) => {
  const v = VAT_RO[vatId];
  return netto > 0 && v != null ? zaokr(netto * (1 + v)) : null;
};

// Surowa oferta z API → wiersz `oferty` (cena BRUTTO, jak w kalkulatorze i na stronie eMAG).
function doOferty(o) {
  const stan = Number(o.general_stock ?? o.stock?.[0]?.value ?? 0) || 0;
  return {
    sku: String(o.part_number || '').trim(),
    pnk: o.part_number_key || null,
    nazwa: o.name || null,
    cena: brutto(Number(o.sale_price), o.vat_id),
    ilosc: stan,
    aktywna: Number(o.status) === 1,
    genius: Number(o.genius_computed) > 0 ? 1 : 0,
  };
}

// Surowa oferta z API → obserwacja w kształcie pricing/model.js. Porównujemy ceny TOWARU (bez
// dostawy): koszt dostawy konkurenta nie jest w API, a przy automacie i tak płaci go klient eMAG-owi.
function zOferty(o) {
  const rank = o.buy_button_rank == null ? null : Number(o.buy_button_rank);
  const cena = brutto(Number(o.sale_price), o.vat_id);
  const best = brutto(Number(o.best_offer_sale_price), o.vat_id);
  const ofert = o.number_of_offers == null ? null : Number(o.number_of_offers);
  const bbNasz = rank === 1 ? true : rank > 1 ? false : null;
  // Mamy Buy Box: „najlepsza oferta" to zwykle my; tańsza od nas = konkurent bez Buy Boxa (inne
  // kryteria eMAG niż cena) — to jedyna cena konkurencji, jaką wtedy znamy.
  const tanszaInna = bbNasz && best != null && cena != null && best < cena - 0.005 ? best : null;
  return {
    cena,
    wysylka: 0,
    bbNasz,
    bbInnaNasza: false,
    bbCena: bbNasz === false ? best : bbNasz ? cena : null,
    bbFba: false,
    najtanszaInna: bbNasz === false ? best : tanszaInna,
    // Mamy Buy Box, na produkcie są inne oferty, ale ich cen API nie podaje.
    konkurencjaNieznana: !!(bbNasz && tanszaInna == null && ofert > 1),
    ofert,
  };
}

// Strona produktu w eMAG po PNK (segment przed /pd/ to dowolny opis — eMAG przekierowuje).
const linkiOferty = (pnk) => (pnk ? { produkt: `https://www.emag.ro/-/pd/${encodeURIComponent(pnk)}/` } : null);

module.exports = { api, wszystkieOferty, doOferty, zOferty, linkiOferty, skonfigurowany, VAT_RO };
