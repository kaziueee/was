'use strict';

// Filtry macierzy cen (ekran Ceny) — czyste funkcje, testy w test/pricing-filtry.test.js.
// Dwa niezależne wymiary, łączone ze sobą i z filtrem kanału (routes/ceny.js):
//   zakres   — które oferty w ogóle: z automatem / ręczne / wszystkie ze stanem
//   sytuacja — co się z ofertą dzieje, z ostatniej decyzji repricera (pricing/model.js) i obserwacji
// Towar (wiersz) przechodzi, gdy JEDNA jego oferta spełnia oba warunki naraz — „z automatem” +
// „Buy Box poniżej minimum” to oferta z automatem, której BB jest pod podłogą, a nie towar, który
// ma gdzieś automat i gdzie indziej BB pod podłogą. Decyzja z 2026-10-15 (układ zaakceptowany przez usera).

const zKodem = (...kody) => (o) => kody.includes(o.kod);

// Cena poniżej minimum z kalkulatora — bez oferty, na którą podniesienie do minimum już poszło
// (wysłane, platforma jeszcze nie pokazała nowej ceny).
const ponizejMin = (o) => o.min > 0 && o.cena > 0 && o.cena < o.min - 0.005
  && !(o.wyslano && o.cena_nowa >= o.min - 0.005 && (!o.obs_czas || o.dec_czas > o.obs_czas));

const ZAKRESY = [
  { klucz: 'automat', nazwa: 'Z automatem', oferta: (o) => !!o.auto },
  { klucz: 'reczne', nazwa: 'Ręczne', oferta: (o) => !o.auto && !o.tylko_odczyt },
  { klucz: 'wszystkie', nazwa: 'Wszystkie ze stanem', oferta: () => true },
];

// `wartosc` — kolejność wierszy (malejąco) w sytuacjach, gdzie jest naturalny ranking; reszta po SKU.
const SYTUACJE = [
  { klucz: 'wszystkie', nazwa: 'Wszystkie sytuacje', oferta: () => true },
  { klucz: 'bb', nazwa: 'Mamy Buy Box', opis: 'Buy Box jest nasz (ostatnia obserwacja)', oferta: (o) => o.bb_nasz === 1 },
  { klucz: 'podwyzka', nazwa: 'Do podwyżki', opis: 'Mamy Buy Box, następny konkurent wyraźnie wyżej — automat podniesie cenę; na eMAG także szukanie ceny konkurenta (+3%)',
    oferta: zKodem('podwyzka', 'podwyzka_limit', 'sonda', 'sonda_limit'), wartosc: (o) => (o.zysk_cel ?? o.zysk_nowa ?? 0) - (o.zysk ?? 0) },
  { klucz: 'jedyna', nazwa: 'Jedyna oferta', opis: 'Nikt inny nie sprzedaje tego produktu na tym rynku', oferta: zKodem('top_bez_konkurencji') },
  { klucz: 'szansa', nazwa: 'Szansa na Buy Box', opis: 'Nie mamy Buy Boxa, a zwycięzca stoi nad naszym minimum — automat zejdzie pod niego',
    oferta: zKodem('obnizka', 'obnizka_limit'), wartosc: (o) => o.zysk_cel ?? o.zysk_nowa ?? -Infinity },
  { klucz: 'bb_pod_min', nazwa: 'Buy Box poniżej minimum', opis: 'Zwycięzca sprzedaje taniej niż nasze minimum — schodzimy na minimum albo już na nim stoimy',
    oferta: zKodem('na_min', 'na_min_limit', 'pod_podloga') },
  { klucz: 'remis', nazwa: 'Remis / tańsi bez BB', opis: 'Ta sama cena co zwycięzca FBA albo jesteśmy tańsi i dalej bez Buy Boxa — przegrywamy nie ceną',
    oferta: zKodem('remis_fba', 'przegrana_nie_cena') },
  { klucz: 'wojna', nazwa: 'Wojna o grosze', opis: 'Konkurent odpowiada na każdą obniżkę — obniżki wstrzymane na dobę', oferta: zKodem('wojna_cenowa') },
  { klucz: 'ponizej', nazwa: 'Poniżej minimum', opis: 'Nasza cena poniżej minimum z kalkulatora (marża < 20%) — od najniższego zysku',
    oferta: ponizejMin, wartosc: (o) => -(o.zysk ?? 0) },
  { klucz: 'zablokowane', nazwa: 'Zablokowane', opis: 'Platforma wstrzymała ofertę przez cenę (eMAG „Invalid price”)', oferta: (o) => !!o.blokada },
  { klucz: 'brak_danych', nazwa: 'Brak danych', opis: 'Brak danych o Buy Boxie, brak naszej ceny w odpowiedzi platformy albo brak minimum/maksimum (np. Amazon PL)',
    oferta: zKodem('brak_danych', 'brak_ceny', 'brak_pasa') },
];

const zakres = (k) => ZAKRESY.find((z) => z.klucz === k) || ZAKRESY[0];
const sytuacja = (k) => SYTUACJE.find((s) => s.klucz === k) || SYTUACJE[0];

// Stary parametr `filtr` (sprzed 2026-10-15) → zakres + sytuacja, żeby stare zakładki/linki działały.
const ZE_STAREGO = {
  automat: ['automat', 'wszystkie'], wszystkie: ['wszystkie', 'wszystkie'], szansa: ['wszystkie', 'szansa'],
  podwyzka: ['wszystkie', 'podwyzka'], ponizej: ['wszystkie', 'ponizej'], decyzja: ['wszystkie', 'wszystkie'],
};
function parametry({ zakres: z, sytuacja: s, filtr } = {}) {
  if (!z && !s && ZE_STAREGO[filtr]) [z, s] = ZE_STAREGO[filtr];
  return { zakres: zakres(z).klucz, sytuacja: sytuacja(s).klucz };
}

// Oferta spełnia oba wymiary naraz.
const ofertaPasuje = (o, z, s) => zakres(z).oferta(o) && sytuacja(s).oferta(o);
const towarPasuje = (t, z, s) => Object.values(t.rynki).some((o) => ofertaPasuje(o, z, s));

// Porządek wierszy: ranking sytuacji (najlepsza pasująca oferta towaru), inaczej po SKU.
function porownaj(z, s) {
  const syt = sytuacja(s);
  if (!syt.wartosc) return (a, b) => String(a.symbol).localeCompare(String(b.symbol));
  const w = (t) => Math.max(...Object.values(t.rynki).filter((o) => ofertaPasuje(o, z, s)).map(syt.wartosc));
  return (a, b) => w(b) - w(a);
}

// Sortowanie po stanie „Razem” (decyzja usera 2026-10-16): malejąco, towar bez stanu z GT na końcu.
// Remis zostawia dotychczasową kolejność — Array.sort jest stabilny, więc wołamy to PO porownaj().
const SORTY = [
  { klucz: '', nazwa: 'Domyślnie', opis: 'Ranking wybranej sytuacji (np. największy zysk z podwyżki), inaczej po SKU' },
  { klucz: 'stan', nazwa: 'Stan ↓', opis: 'Największy stan Razem (K4+K4G+MAG+LS; zestaw — ile da się złożyć) na górze' },
];
const sortuj = (k) => (SORTY.some((x) => x.klucz === k) ? k : '');
const poStanie = (razem) => (a, b) => (razem(b) ?? -1) - (razem(a) ?? -1);

// Chipy z licznikami: zakres liczony przy bieżącej sytuacji, sytuacja przy bieżącym zakresie.
function chipy(towary, z, s) {
  return {
    zakresy: ZAKRESY.map((x) => ({ klucz: x.klucz, nazwa: x.nazwa, n: towary.filter((t) => towarPasuje(t, x.klucz, s)).length })),
    sytuacje: SYTUACJE.map((x) => ({ klucz: x.klucz, nazwa: x.nazwa, opis: x.opis || '', n: towary.filter((t) => towarPasuje(t, z, x.klucz)).length })),
  };
}

module.exports = { ZAKRESY, SYTUACJE, SORTY, sortuj, poStanie, parametry, ofertaPasuje, towarPasuje, porownaj, chipy, ponizejMin };
