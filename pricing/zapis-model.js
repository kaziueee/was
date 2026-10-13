'use strict';

// Budowa zmiany ceny dla Listings Items API — czysta funkcja (testy w test/pricing-zapis.test.js).
//
// Cena siedzi w atrybucie `purchasable_offer` (tablica: po jednym wpisie na rynek × odbiorcę —
// ALL = klient detaliczny, B2B osobno). Patch `replace` podmienia CAŁY atrybut, więc wysyłamy
// wszystkie istniejące wpisy tego rynku, a zmieniamy wyłącznie `our_price` wpisu ALL. Inaczej
// przy okazji skasowalibyśmy np. ofertę B2B albo min/max ustawione w Seller Central.
//
// Oferta podpięta pod regułę Automate Pricing Amazona (`automated_pricing_merchandising_rule_plan`)
// jest ODRZUCANA: dwa automaty na jednej cenie by się przeciągały (decyzja usera 2026-10-12 —
// ceną steruje tylko nasz repricer, ofertę trzeba najpierw wyjąć z reguły w Seller Central).

function budujZmianeCeny(purchasableOffer, marketplaceId, cena) {
  const wpisy = (purchasableOffer || []).filter((p) => p.marketplace_id === marketplaceId);
  const detal = wpisy.find((p) => (p.audience || 'ALL') === 'ALL');
  if (!detal) return { blad: 'oferta nie ma ceny detalicznej (purchasable_offer ALL) na tym rynku' };
  if (detal.automated_pricing_merchandising_rule_plan?.length) {
    return { blad: 'oferta jest w regule Automate Pricing Amazona — najpierw wyjmij ją z reguły w Seller Central' };
  }
  const c = Math.round(Number(cena) * 100) / 100;
  if (!(c > 0)) return { blad: `niepoprawna cena: ${cena}` };

  const nowe = wpisy.map((p) => (p === detal
    ? { ...p, our_price: [{ schedule: [{ value_with_tax: c }] }] }
    : p));
  return { patches: [{ op: 'replace', path: '/attributes/purchasable_offer', value: nowe }], cena: c };
}

module.exports = { budujZmianeCeny };
