'use strict';

// Hurt_PLN w Sellasist = cena Hurt (EUR) przeliczona kursem NBP. Czysta logika - bez sieci,
// testy w test/sellasist-hurt-pln-model.test.js.
//
// SKAD EUR: w Subiekcie „Hurt” to poziom ceny 5 w walucie EUR (tw_Parametr: twp_WalutaCeny5 = EUR),
// a do Sellasist przechodzi sama liczba - Sellasist traktuje ja jak PLN (FPK0428: Hurt 42,66 =
// tc_CenaBrutto5 w EUR, a Sellasist pokazuje „EUR 9,71”). Dlatego czytamy `value` pola Hurt
// wprost jako kwote w EUR i NIE korzystamy z przeliczen `prices` Sellasist.

const POLE_HURT = 'Hurt';
const POLE_HURT_PLN = 'Hurt_PLN';
// Job nie przepisuje Hurt_PLN przy kazdej dziennej zmianie kursu (13,5 tys. produktow) - tylko
// gdy wartosc odjechala od wyliczonej o wiecej niz tyle (zmiana ceny Hurt albo kursu o > 1%).
const TOLERANCJA = 0.01;
// Strażnik złej waluty: w części kartotek GT w polu Hurt (EUR) siedzi cena detaliczna w PLN
// (SIK1015: detal 20,99 zł, Hurt „20,99 EUR”). Przeliczona dałaby hurt 4,4× wyższy od detalu -
// zgłaszamy je w raporcie. Uczciwy hurt wychodzi mediana 0,9× ceny w Sellasist. Na razie (decyzja
// usera 2026-10-26) i tak je zapisujemy - większość to warianty (U/P/ZE/części zestawów) z Hurtem
// pełnego produktu, a Siku (Hurt = detal co do grosza) poprawi się w Subiekcie.
const MAX_WZGLEDEM_DETALU = 2;

const grosze = (x) => Math.round(x * 100) / 100;

function wartoscPola(produkt, nazwa) {
  const pole = (produkt.pricesfieldsvalues || []).find((p) => p.name === nazwa);
  if (!pole || pole.value == null || pole.value === '') return null;
  const v = Number(pole.value);
  return Number.isFinite(v) ? v : null;
}

// Hurt_PLN dla produktu albo null (brak / zerowa cena Hurt - nie ma czego przeliczac).
function wyliczHurtPln(hurtEur, kurs) {
  if (!(hurtEur > 0) || !(kurs > 0)) return null;
  return grosze(hurtEur * kurs);
}

function wymagaZapisu(obecna, nowa, tolerancja = TOLERANCJA) {
  if (nowa == null) return false;
  if (obecna == null || !(obecna > 0)) return true;
  return Math.abs(obecna - nowa) / nowa > tolerancja;
}

// produkty z /products_bulk → { zmiany: [{product_id, symbol, hurt_eur, obecna, nowa}], podejrzane, bezHurtu }
// tolerancja = 0 przepisuje kazda roznice co do grosza (przebieg jednorazowy).
// podejrzane: Hurt_PLN > MAX_WZGLEDEM_DETALU × cena produktu - zapisywane, ale wypisane do sprawdzenia.
function zmianyHurtPln(produkty, kurs, { tolerancja = TOLERANCJA } = {}) {
  const zmiany = [];
  const podejrzane = [];
  let bezHurtu = 0;
  for (const p of produkty) {
    const hurt = wartoscPola(p, POLE_HURT);
    const nowa = wyliczHurtPln(hurt, kurs);
    if (nowa == null) { bezHurtu++; continue; }
    const cena = Number(p.price);
    if (cena > 0 && nowa > MAX_WZGLEDEM_DETALU * cena) {
      podejrzane.push({ product_id: Number(p.product_id), symbol: p.symbol, hurt_eur: hurt, cena, nowa });
    }
    const obecna = wartoscPola(p, POLE_HURT_PLN);
    if (!wymagaZapisu(obecna, nowa, tolerancja) || obecna === nowa) continue;
    zmiany.push({ product_id: Number(p.product_id), symbol: p.symbol, hurt_eur: hurt, obecna, nowa });
  }
  return { zmiany, podejrzane, bezHurtu };
}

module.exports = { zmianyHurtPln, wyliczHurtPln, wymagaZapisu, wartoscPola, TOLERANCJA, MAX_WZGLEDEM_DETALU, POLE_HURT, POLE_HURT_PLN };
