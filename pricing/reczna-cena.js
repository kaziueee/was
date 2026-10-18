'use strict';

// Ręczna zmiana ceny jednej oferty z ekranu Ceny (POST /api/ceny/cena) — rejestr platform. Wysyła WMS
// od razu (człowiek czeka na odpowiedź platformy), a potwierdza worker po czasie propagacji
// (pricing/worker.js, potwierdzKorekty — szuka decyzji `korekta` w bazie cen).
//
// Wpis rejestru:
//   wyslij(oferta, cena) → { ok, cena, blad } — oferta = wiersz `oferty`, cena brutto w walucie rynku;
//                          odmowa platformy to wynik, nie wyjątek
//   propagacja           — dla ekranu: kiedy nowa cena będzie widoczna na platformie
// Nowa platforma = nowy wpis tutaj (Allegro, Empik i Kaufland dochodzą w osobnych gałęziach). Trasa i
// ekran pytają `obslugiwana()`, więc kanał bez wpisu po prostu nie dostaje pola ręcznej ceny.

const amazon = require('./amazon');
const emag = require('./emag');
const kaufland = require('./kaufland');
const allegro = require('./allegro');

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
    // Test 18.10 (HASG1435): PATCH 200 po 0,2 s, nowa cena w API po ~3 s; CZ/SK/HU idą za nią same (reguły kursowe).
    propagacja: 'Allegro zmienia cenę od razu (kilka sekund); ceny CZ/SK/HU przeliczają się same',
  },
};

const obslugiwana = (platforma) => !!PLATFORMY[platforma];
const propagacja = (platforma) => PLATFORMY[platforma]?.propagacja || null;

async function wyslij(o, cena) {
  const p = PLATFORMY[o.platforma];
  if (!p) return { ok: false, blad: `ręczna zmiana ceny na ${o.platforma} jeszcze nieobsługiwana z ekranu` };
  try { return await p.wyslij(o, cena); } catch (e) { return { ok: false, blad: e.message }; }
}

module.exports = { PLATFORMY, obslugiwana, propagacja, wyslij };
