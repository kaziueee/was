'use strict';

// Kanały tylko do odczytu (dziś eMAG RO) obserwujemy w KAŻDYM przebiegu — lista ofert i tak
// przychodzi z synchronizacji, więc obserwacja nic nie kosztuje w API. Kosztuje za to w bazie:
// ~1100 ofert × 48 przebiegów = ponad 50 tys. wierszy obserwacji i drugie tyle decyzji na dobę,
// w większości identycznych. Dlatego dla tych kanałów:
//   - obserwacja bez zmian → nie dopisujemy wiersza, tylko podbijamy `widziana` w ostatnim
//     (wiersz = odcinek czasu, w którym stan był taki sam: od `czas` do `widziana`),
//   - decyzja bez zmian → nie zapisujemy jej drugi raz (od 2026-10-15 na każdej platformie, o ile nie
//     poszła na platformę ani nie skończyła się błędem — takie zapisujemy zawsze).
// Czyste funkcje — testy w test/pricing-bez-zmian.test.js.

const POLA_OBSERWACJI = ['cena', 'wysylka', 'bb_nasz', 'bb_cena', 'bb_fba', 'najtansza_inna', 'ofert', 'bb_nasza_inna'];
const POLA_DECYZJI = ['kod', 'cena_przed', 'cena_nowa', 'cena_cel', 'min', 'max', 'zysk', 'zysk_nowa', 'zysk_cel'];

// Liczby porównujemy do grosza (REAL z SQLite vs wynik z JS), NULL = NULL, boolean = 1/0.
const norm = (v) => {
  const n = typeof v === 'boolean' ? Number(v) : v;
  return n == null ? null : typeof n === 'number' ? Math.round(n * 100) : n;
};
const takieSame = (pola) => (a, b) => !!a && !!b && pola.every((k) => norm(a[k]) === norm(b[k]));

const takaSamaObserwacja = takieSame(POLA_OBSERWACJI);
const takaSamaDecyzja = takieSame(POLA_DECYZJI);

module.exports = { takaSamaObserwacja, takaSamaDecyzja, POLA_OBSERWACJI, POLA_DECYZJI };
