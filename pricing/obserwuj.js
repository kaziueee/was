'use strict';

// Obserwacja ofert Amazon: nasza cena, Buy Box i najtańsza inna oferta (landed = z wysyłką).
// Tylko odczyt (getListingOffers w paczkach po 20 przez batch API). Wynik trafia do `obserwacje`.
//
// Obserwujemy wyłącznie oferty ZE STANEM (decyzja usera 2026-10-12): oferta bez stanu nie
// sprzedaje się niezależnie od ceny, a każda paczka to ~2,5 s limitu API.

const amazon = require('./amazon');
const { db } = require('./db');

const SELLER_ID = process.env.SPAPI_SELLER_ID || 'A297N0KEJID15J';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const landed = (o) => (o ? +(o.ListingPrice.Amount + (o.Shipping?.Amount || 0)).toFixed(2) : null);

// Odpowiedź getListingOffers → obserwacja w kształcie, który przyjmuje pricing/model.js
function zOdpowiedzi(payload) {
  const oferty = payload?.Offers || [];
  const moja = oferty.find((o) => o.MyOffer || o.SellerId === SELLER_ID);
  const bb = oferty.find((o) => o.IsBuyBoxWinner);
  const inne = oferty.filter((o) => !(o.MyOffer || o.SellerId === SELLER_ID)).map(landed).filter((x) => x != null);
  const bbCena = payload?.Summary?.BuyBoxPrices?.find((b) => String(b.condition).toLowerCase() === 'new');
  return {
    cena: moja ? moja.ListingPrice.Amount : null,
    wysylka: moja ? (moja.Shipping?.Amount || 0) : null,
    bbNasz: bb ? !!(bb.MyOffer || bb.SellerId === SELLER_ID) : (bbCena ? false : null),
    bbCena: bb ? landed(bb) : (bbCena ? +(bbCena.LandedPrice?.Amount ?? bbCena.ListingPrice.Amount).toFixed(2) : null),
    bbFba: bb ? !!bb.IsFulfilledByAmazon : null,
    najtanszaInna: inne.length ? Math.min(...inne) : null,
    ofert: payload?.Summary?.TotalOfferCount ?? null,
  };
}

// oferty: [{ id, rynek, sku }]
async function obserwuj(oferty, { naPostep } = {}) {
  const zapisz = db.prepare(`INSERT INTO obserwacje (oferta_id, cena, wysylka, bb_nasz, bb_cena, bb_fba, najtansza_inna, ofert)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const wynik = new Map();
  let bledy = 0;
  for (let i = 0; i < oferty.length; i += 20) {
    const paczka = oferty.slice(i, i + 20);
    let j;
    try {
      j = await amazon.api('POST', '/batches/products/pricing/v0/listingOffers', {
        requests: paczka.map((o) => ({
          uri: `/products/pricing/v0/listings/${encodeURIComponent(o.sku)}/offers`, method: 'GET',
          MarketplaceId: amazon.RYNKI_AMAZON[o.rynek].id, ItemCondition: 'New', CustomerType: 'Consumer',
        })),
      });
    } catch (e) {
      // Jedna nieudana paczka (po ponowieniach) nie przekreśla całego przebiegu — te oferty
      // dostaną obserwację w następnym.
      bledy++;
      console.error(`[pricing] paczka ${i / 20 + 1} pominięta: ${e.message}`);
      continue;
    }
    (j.responses || []).forEach((odp, k) => {
      const o = paczka[k];
      const obs = odp.body?.payload ? zOdpowiedzi(odp.body.payload) : null;
      if (!obs) return;
      wynik.set(o.id, obs);
      const b = (v) => (v == null ? null : v ? 1 : 0);
      zapisz.run(o.id, obs.cena, obs.wysylka, b(obs.bbNasz), obs.bbCena, b(obs.bbFba), obs.najtanszaInna, obs.ofert);
    });
    if (naPostep) naPostep(Math.min(i + 20, oferty.length), oferty.length);
    await sleep(2500);
  }
  if (bledy) wynik.bledyPaczek = bledy;
  return wynik;
}

module.exports = { obserwuj, zOdpowiedzi };
