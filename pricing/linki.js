'use strict';

// Linki do oferty na stronie platformy — każda platforma po swojemu (Amazon po ASIN, eMAG po PNK, Empik po numerze
// produktu, Allegro po numerze oferty, Kaufland po id_product — wszystkie trzymane w `oferty.asin`). Jedno miejsce
// dla ekranu Ceny (routes/ceny.js) i karty produktu w Sprzedaż → Trendy (services/analiza-trendy.js).
// o: wiersz `oferty` z pricing.db ({ platforma, rynek, asin }) → { produkt, oferty? } albo null.

const amazon = require('./amazon');
const emag = require('./emag');
const empik = require('./empik');
const allegro = require('./allegro');
const kaufland = require('./kaufland');

const linkiOferty = (o) => (o.platforma === 'emag' ? emag.linkiOferty(o.asin, o.rynek)
  : o.platforma === 'empik' ? empik.linkiOferty(o.asin) : o.platforma === 'allegro' ? allegro.linkiOferty(o.asin)
  : o.platforma === 'kaufland' ? kaufland.linkiOferty(o.asin, o.rynek)
  : amazon.linkiOferty(o.rynek, o.asin));

module.exports = { linkiOferty };
