'use strict';

// Ręczne granice oferty i ręczna cena — czysta logika (bez SQLite, GT i API), testy w
// test/pricing-granice.test.js. Korzystają z niej worker (pas do decyzji), trasa /api/ceny
// (walidacja zapisu i podgląd przed wysłaniem) i — przez odpowiedź trasy — ekran Ceny.
//
// Granice (decyzja usera 2026-10-16): per OFERTA, kwotą w walucie rynku, tylko w WMS — zakres
// min/max zapisany w panelu eMAG / Seller Central zostaje nietknięty. Puste pole = kalkulator.
//   min = ręczne min, inaczej kalkulator (cena przy marży 20%)
//   max = ręczne max, inaczej max kalkulatora — ale nie niżej niż ręczne min × MNOZNIK_MAX: ręczne
//         min nad dawnym max nie może zostawić pasa „do góry nogami”, a ręczne min PONIŻEJ
//         kalkulatora nie ścina miejsca na podwyżki.
// Ręczne min działa też tam, gdzie kalkulator nie zna rynku: jest wtedy jedynym
// źródłem pasa, a zysku i marży nie znamy (ocen → null).
//
// Ręczna cena (ta sama data): bez blokad, ale cena pod minimum, ze stratą, nad maksimum, z dużym
// skokiem albo bez wyceny wymaga potwierdzenia — backend bez `potwierdz` odmawia (zasada 5).

const MNOZNIK_MAX = 1.5;     // max = min × tyle (pas z kalkulatora i z ręcznego minimum)
const PROG_SKOKU = 0.3;      // zmiana o więcej niż 30% obecnej ceny = ostrzeżenie (literówka 1999 zamiast 19,99)

const zaokr = (x) => Math.round(x * 100) / 100;
// Kwota w komunikacie dla człowieka: przecinek, 2 miejsca (ekran jest po polsku; 10104,99 Ft, 31,99 €).
const pl = (x, d = 2) => Number(x).toFixed(d).replace('.', ',');

// Liczba z pola formularza: '' / null / undefined = brak (kalkulator), przecinek dziesiętny przyjmowany.
// Śmieci = NaN, żeby walidacja mogła powiedzieć, co jest nie tak, zamiast po cichu wyczyścić pole.
function liczba(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(String(v).trim().replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}

// Cena wpisana przez człowieka → { cena } (2 miejsca) albo { blad }.
function walidujCene(v) {
  const c = liczba(v);
  if (c == null || Number.isNaN(c)) return { blad: `niepoprawna cena: ${v ?? ''}` };
  if (!(zaokr(c) > 0)) return { blad: 'cena musi być większa od zera' };
  return { cena: zaokr(c) };
}

// Zapis granic. kalk = { min, max } z kalkulatora albo null (rynek bez kalkulatora / Subiekt nie
// odpowiada). → { min, max } (null = z kalkulatora) albo { blad }.
function walidujGranice(minWe, maxWe, kalk = null) {
  const min = liczba(minWe), max = liczba(maxWe);
  if (Number.isNaN(min)) return { blad: `niepoprawne minimum: ${minWe}` };
  if (Number.isNaN(max)) return { blad: `niepoprawne maksimum: ${maxWe}` };
  const mn = min == null ? null : zaokr(min), mx = max == null ? null : zaokr(max);
  if (mn != null && !(mn > 0)) return { blad: 'minimum musi być większe od zera' };
  if (mx != null && !(mx > 0)) return { blad: 'maksimum musi być większe od zera' };
  if (mn != null && mx != null && mx < mn) return { blad: `maksimum ${pl(mx)} poniżej minimum ${pl(mn)}` };
  if (mn == null && mx != null) {
    if (!(kalk?.min > 0)) return { blad: 'nie znamy minimum z kalkulatora (rynek bez kalkulatora albo Subiekt nie odpowiada) — podaj też minimum' };
    if (mx < kalk.min) return { blad: `maksimum ${pl(mx)} poniżej minimum z kalkulatora (${pl(kalk.min)}) — podaj też ręczne minimum` };
  }
  return { min: mn, max: mx };
}

// Pas oferty po ręcznych granicach. pas = { min, max, ocen, … } z kalkulatora (pricing/pas.js) albo null;
// reczne = wiersz oferty z min_reczne / max_reczne. Wynik: pas z polami zrodlo_min ('reczne' | 'kalkulator'),
// zrodlo_max ('reczne' | 'z_min' | 'kalkulator'), kalk_min, kalk_max — albo null (brak pasa). Sprzeczne
// granice (ręczne max poniżej minimum z kalkulatora po zmianie kosztu) dostają `blad`; model zwróci wtedy
// brak_pasa, czyli automat stoi, zamiast zgadywać, która granica jest ważniejsza.
function zGranicami(pas, reczne = {}) {
  const rMin = reczne?.min_reczne > 0 ? reczne.min_reczne : null;
  const rMax = reczne?.max_reczne > 0 ? reczne.max_reczne : null;
  const kalk = pas && pas.min > 0 ? pas : null;
  const min = rMin ?? kalk?.min ?? null;
  if (!(min > 0)) return null;
  const maxZMin = rMin != null ? Math.max(kalk?.max ?? 0, zaokr(rMin * MNOZNIK_MAX)) : null;
  const max = rMax ?? maxZMin ?? kalk.max;
  // Pas wejściowy bywa pasem strategii towaru (pricing/pas.js) — wtedy źródło to „strategia”, a ręczne granice
  // oferty są odstępstwem od niej (decyzja usera 2026-10-19: najbardziej szczegółowe wygrywa).
  const zr = kalk?.zrodlo || 'kalkulator';
  const wynik = {
    ...(kalk || {}), min, max, ocen: kalk?.ocen || (() => null),
    zrodlo_min: rMin != null ? 'reczne' : zr,
    zrodlo_max: rMax != null ? 'reczne' : rMin != null && max !== kalk?.max ? 'z_min' : zr,
    kalk_min: kalk?.min ?? null, kalk_max: kalk?.max ?? null,
  };
  if (max < min) wynik.blad = `ręczne maksimum ${pl(max)} poniżej minimum ${pl(min)}${rMin == null ? ' z kalkulatora' : ''} — popraw granice`;
  return wynik;
}

// Ocena ręcznej ceny przed wysłaniem: zysk i marża przy tej cenie + ostrzeżenia do potwierdzenia.
// teraz — obecna cena oferty (null = nie znamy); pas — z zGranicami (null = brak pasa);
// gtOk — false, gdy Subiekt nie odpowiedział (bez kosztu nie ma wyceny); niepewneDopasowanie — oferta
// dopasowana do towaru GT bez potwierdzenia (zysk może dotyczyć innego towaru).
function ocenCene(cena, { teraz = null, pas = null, gtOk = true, niepewneDopasowanie = false } = {}) {
  const oc = pas?.ocen ? pas.ocen(cena) : null;
  const ostrzezenia = [];
  const dodaj = (kod, tekst) => ostrzezenia.push({ kod, tekst });
  if (niepewneDopasowanie) dodaj('dopasowanie', 'dopasowanie oferty do towaru GT niepotwierdzone — zysk i minimum mogą dotyczyć innego towaru');
  if (!gtOk) dodaj('brak_gt', 'Subiekt nie odpowiada — bez kosztu zakupu nie policzymy zysku ani minimum');
  else if (!pas) dodaj('brak_pasa', 'brak minimum dla tego rynku — nie wiadomo, czy ta cena się opłaca');
  else if (!oc) dodaj('brak_wyceny', 'kalkulator nie policzył zysku przy tej cenie (rynek bez kalkulatora albo brak kosztu)');
  const skad = pas?.zrodlo_min === 'reczne' ? 'ręczne' : pas?.zrodlo_min === 'strategia' ? `strategia „${pas.strategia?.nazwa}”` : 'kalkulator, marża 20%';
  if (pas && cena < pas.min - 0.005) dodaj('pod_min', `poniżej minimum ${pl(pas.min)} (${skad})`);
  if (oc && oc.zysk < 0) dodaj('strata', `sprzedaż ze stratą ${pl(-oc.zysk)} zł na sztuce`);
  if (pas && cena > pas.max + 0.005) dodaj('nad_max', `powyżej maksimum ${pl(pas.max)}`);
  if (teraz > 0 && Math.abs(cena - teraz) / teraz > PROG_SKOKU) {
    dodaj('skok', `zmiana o ${Math.round(((cena - teraz) / teraz) * 100)}% względem obecnej ceny ${pl(teraz)}`);
  }
  return { cena, zysk: oc?.zysk ?? null, marza: oc?.marza ?? null, ostrzezenia };
}

// Ostrzeżenia przy zapisie granic. pasKalk — pas z samego kalkulatora (bez ręcznych granic) albo null.
// Ręczne min poniżej kalkulatora = marża niższa niż docelowe 20%; poniżej kosztu = automat może
// sprzedawać ze stratą. Też do potwierdzenia, nie blokada.
function ocenGranice({ min }, pasKalk, { gtOk = true } = {}) {
  const ostrzezenia = [];
  if (min == null) return ostrzezenia;
  const oc = pasKalk?.ocen ? pasKalk.ocen(min) : null;
  if (!gtOk) ostrzezenia.push({ kod: 'brak_gt', tekst: 'Subiekt nie odpowiada — nie wiadomo, jaki zysk daje to minimum' });
  else if (!oc) ostrzezenia.push({ kod: 'brak_wyceny', tekst: 'kalkulator nie zna tego rynku — nie wiadomo, jaki zysk daje to minimum' });
  else if (oc.zysk < 0) ostrzezenia.push({ kod: 'strata', tekst: `przy minimum ${pl(min)} strata ${pl(-oc.zysk)} zł na sztuce — automat może sprzedawać pod kosztem` });
  else if (pasKalk && min < pasKalk.min - 0.005) {
    ostrzezenia.push({ kod: 'marza', tekst: `marża przy minimum ${pl(oc.marza, 1)}% (zysk ${pl(oc.zysk)} zł) — poniżej progu kalkulatora (20%, minimum ${pl(pasKalk.min)})` });
  }
  return ostrzezenia;
}

module.exports = { MNOZNIK_MAX, PROG_SKOKU, pl, liczba, walidujCene, walidujGranice, zGranicami, ocenCene, ocenGranice };
