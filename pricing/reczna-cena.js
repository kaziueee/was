'use strict';

// Ręczna zmiana ceny jednej oferty z ekranu Ceny (POST /api/ceny/cena) — rejestr platform. Wysyła WMS
// od razu (człowiek czeka na odpowiedź platformy), a potwierdza worker po czasie propagacji
// (pricing/worker.js, potwierdzKorekty — szuka decyzji `korekta` w bazie cen).
//
// Wpis rejestru:
//   wyslij(oferta, cena) → { ok, cena, blad } — oferta = wiersz `oferty`, cena brutto w walucie rynku;
//                          odmowa platformy to wynik, nie wyjątek
//   propagacja           — dla ekranu: kiedy nowa cena będzie widoczna na platformie
//   tylkoAktywne         — cenę zmienimy wyłącznie na ofercie aktywnej (`oferty.aktywna = 1`)
// Nowa platforma = nowy wpis tutaj. Trasa i ekran pytają `obslugiwana()`, więc kanał bez wpisu po prostu
// nie dostaje pola ręcznej ceny.
//
// Oferty nieaktywne (stan 0 — eMAG, Empik i Kaufland wyłączają wtedy ofertę; karta produktu w Trendach): Amazon, eMAG,
// Kaufland i Empik dostają WYŁĄCZNIE cenę (purchasable_offer / id + sale_price / listing_price / linia PRI01), więc
// zmiana nie wznawia oferty ani nie rusza stanu. Allegro trzyma w bazie tylko oferty aktywne, a zakończonej nie
// pobierzemy (`ofertaPoId` szuka wśród aktywnych) — stąd tylkoAktywne.

const amazon = require('./amazon');
const emag = require('./emag');
const kaufland = require('./kaufland');
const allegro = require('./allegro');
const empik = require('./empik');
const { stan } = require('./db');

const PLATFORMY = {
  amazon: {
    // Listings API, patch `replace` purchasable_offer (pricing/zapis-model.js) — odmawia oferty w regule
    // Automate Pricing i ceny spoza zakresu min/max ustawionego w Seller Central.
    wyslij: (o, cena) => amazon.ustawCene(o.rynek, o.sku, cena),
    propagacja: 'Amazon pokazuje nową cenę po 3–10 min',
  },
  emag: {
    // Light API offer/save na ofercie świeżo pobranej z API (id, VAT, zakres min/max z panelu eMAG —
    // emag.zmianaCeny odmawia ceny spoza niego).
    wyslij: async (o, cena) => {
      const lista = await emag.ofertaPoSku(o.sku, o.rynek);
      if (lista.length !== 1) return { ok: false, blad: `eMAG ${o.rynek}: ${lista.length} ofert z SKU ${o.sku} — oczekiwano jednej` };
      return emag.ustawCene(lista[0], cena);
    },
    propagacja: 'eMAG pokazuje nową cenę po 4–10 min, RO bywa do ~50 min — nie ponawiaj od razu',
  },
  kaufland: {
    // PATCH listing_price (+ minimum_price, gdy równe cenie) na unicie świeżo pobranym po SKU —
    // kaufland.zmianaCeny odmawia, gdy na ofercie działa Smart Pricing Kauflandu.
    wyslij: async (o, cena) => {
      const lista = await kaufland.unitPoSku(o.sku, o.rynek);
      if (lista.length !== 1) return { ok: false, blad: `Kaufland ${o.rynek}: ${lista.length} ofert z SKU ${o.sku} — oczekiwano jednej` };
      return kaufland.ustawCene(lista[0], cena);
    },
    propagacja: 'Kaufland pokazuje nową cenę po 1–2 min',
  },
  allegro: {
    // PATCH /sale/product-offers/{id} na ofercie świeżo pobranej po numerze (`asin`) z konta (`rynek`) —
    // allegro.zmianaCeny odmawia oferty pod regułą cenową Allegro i formatu innego niż Kup Teraz.
    wyslij: async (o, cena) => {
      const s = await allegro.ofertaPoId(o.rynek, o.asin);
      if (!s) return { ok: false, blad: `Allegro ${o.rynek}: oferty ${o.asin} nie ma wśród aktywnych` };
      return allegro.ustawCene(s, cena);
    },
    tylkoAktywne: true,
    // Test 18.10 (HASG1435): PATCH 200 po 0,2 s, nowa cena w API po ~3 s; CZ/SK/HU idą za nią same (reguły kursowe).
    propagacja: 'Allegro zmienia cenę od razu (kilka sekund); ceny CZ/SK/HU przeliczają się same',
  },
  empik: {
    // Import cen PRI01 (pricing/empik.js) jedną linią, na ofercie świeżo pobranej po SKU (OF21) —
    // empik.zmianaCeny odmawia oferty z promocją albo kilkoma cenami (import „usuń i zastąp” by je skasował).
    // Empik przyjmuje plik od razu; czy cena weszła, worker sprawdza po PRICING_POTWIERDZENIE_EMPIK_MIN
    // (status importu PRI02 + cena z P11) — stąd numer importu w `stan`. Import wolno raz na minutę: gdy
    // worker właśnie wysłał swój, Empik odpowie 429 — wtedy za minutę jeszcze raz.
    wyslij: async (o, cena) => {
      const lista = await empik.ofertaPoSku(o.sku);
      if (lista.length !== 1) return { ok: false, blad: `Empik: ${lista.length} ofert z SKU ${o.sku} — oczekiwano jednej` };
      const w = await empik.ustawCeny([{ surowa: lista[0], cena }]);
      const r = w.wyniki[0] || {};
      if (!r.ok) return { ok: false, blad: r.blad || 'Empik nie przyjął pliku z ceną' };
      if (w.importId) stan.set('empik_import', JSON.stringify({ id: w.importId, ofert: 1 }));
      return { ok: true, cena: r.cena };
    },
    // Pierwsze ręczne zmiany zmierzą czas — do tego czasu ostrożnie.
    propagacja: 'Empik przyjął import cen; czas do widoczności na stronie jeszcze niezmierzony — status importu i cenę sprawdzimy po ~10 min',
  },
};

// aktywna = false — oferta nieaktywna (zakończona, stan 0); brak = jak dotąd (ekrany pokazujące tylko aktywne)
const obslugiwana = (platforma, aktywna = true) => !!PLATFORMY[platforma] && (aktywna || !PLATFORMY[platforma].tylkoAktywne);
const propagacja = (platforma) => PLATFORMY[platforma]?.propagacja || null;

async function wyslij(o, cena) {
  const p = PLATFORMY[o.platforma];
  if (!p) return { ok: false, blad: `ręczna zmiana ceny na ${o.platforma} jeszcze nieobsługiwana z ekranu` };
  try { return await p.wyslij(o, cena); } catch (e) { return { ok: false, blad: e.message }; }
}

module.exports = { PLATFORMY, obslugiwana, propagacja, wyslij };
