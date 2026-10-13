'use strict';

// SKU oferty na marketplace → symbol towaru w GT. Czysta funkcja (testy w test/pricing-mapowanie.test.js).
//
// Na Amazonie ten sam towar bywa wystawiony pod SKU z dopiskiem: `-1`/`-2` (druga oferta tego
// samego towaru) albo kodem kraju (`HASF8401-DE`). Pomiar 2026-10-12 na OKITRADE: z 2860 SKU
// 2736 pasuje wprost, 107 po zdjęciu `-<cyfry>`, 3 po zdjęciu kodu kraju, 14 nie pasuje wcale
// (do ręcznego przypisania). Kolejność kandydatów = od najbardziej do najmniej pewnego; pierwszy
// istniejący w kartotece wygrywa.

function kandydaciSymbolu(sku) {
  const u = String(sku || '').trim().toUpperCase();
  if (!u) return [];
  const lista = [
    u,
    u.replace(/-\d+$/, ''),
    u.replace(/-?(DE|FR|IT|ES|NL|PL)$/, ''),
  ];
  return [...new Set(lista.filter(Boolean))];
}

// mapa: Map(SYMBOL_WIELKIMI → { tw_Id, tw_Symbol })
function dopasujSymbol(sku, mapa) {
  for (const k of kandydaciSymbolu(sku)) {
    const t = mapa.get(k);
    if (t) return { ...t, wprost: k === kandydaciSymbolu(sku)[0] };
  }
  return null;
}

module.exports = { kandydaciSymbolu, dopasujSymbol };
