'use strict';

// Czysta logika wystawiania ofert (bez API, SQLite i GT — testy w test/wystawianie-model.test.js). Wysyłka:
// pricing/wystawianie.js, ekran: routes/ceny-wystawianie.js.
//
// Zasady (lekcje z ręcznych wystawień eMAG RO 28–29.10.2026):
//   - zawsze EAN + wymiary + waga (zasada usera 2026-10-30) — bez nich pozycja jest zablokowana, nie „wystawiona byle jak”;
//   - wagi z GT historycznie mają mieszane jednostki (całkowite = gramy, z przecinkiem = kg) — nie zgadujemy:
//     waga bez części ułamkowej blokuje pozycję do poprawy w Parametrach;
//   - cena startowa = minimum pasa wg strategii towaru; niżej tylko z potwierdzeniem.

// Na których rynkach wystawianie jest WŁĄCZONE. Każdy rynek najpierw przechodzi test jednej oferty (kształt zapytania
// potwierdzony empirycznie — zasada „nie zgaduj, sprawdzaj”), dopiero potem trafia tutaj. Pozostałe rynki ekran
// pokazuje (katalog się skanuje), ale przycisk wystawienia jest wyłączony z tym powodem.
const RYNKI_WYSTAWIANIA = {
  'emag:RO': { gotowe: true },
  'emag:HU': { gotowe: false, powod: 'eMAG HU — czeka na test pierwszej oferty' },
  'emag:BG': { gotowe: false, powod: 'eMAG BG — czeka na test pierwszej oferty' },
  'kaufland:DE': { gotowe: false, powod: 'Kaufland — czeka na test pierwszej oferty (POST /units)' },
  'empik:PL': { gotowe: false, powod: 'Empik — czeka na test importu OF01' },
};
const gotowyRynek = (platforma, rynek) => {
  const r = RYNKI_WYSTAWIANIA[`${platforma}:${rynek}`];
  if (r) return r;
  return platforma === 'amazon' ? { gotowe: false, powod: 'Amazon — czeka na test (Listings Items PUT, VALIDATION_PREVIEW)' } : { gotowe: false, powod: 'rynek nieobsługiwany' };
};

// eMAG: stawka VAT podstawowa na każdym rynku (pricing/emag.js KRAJE — vat/read).
const EMAG_VAT = { RO: { id: 9, stawka: 0.21 }, HU: { id: 1, stawka: 0.27 }, BG: { id: 6, stawka: 0.2 } };
// Pierwsze id oferty eMAG nadawane przez WMS (vendor_ext_id; ręczne testy 28.10 zajęły 9000001–9000007).
const EMAG_ID_START = 9000010;
// Stałe oferty eMAG (jak 4 oferty testowe i reszta konta): realizacja 1 dzień, dostawa od dostawcy 14 dni, bez gwarancji.
const EMAG_STALE = { handling_time: 1, supply_lead_time: 14, warranty: 0 };
// Zakres min/max zapisywany NA OFERCIE w eMAG (eMAG odrzuci każdą cenę spoza niego, także automatu). Szeroko, żeby
// nie blokował repricera: od 90% minimum pasa do 2,5× ceny startowej (nie mniej niż maksimum pasa).
const EMAG_ZAKRES = { minUlamek: 0.9, maxMnoznik: 2.5 };
// Ile pozycji naraz z ekranu (każda to 2 zapytania do eMAG + sprawdzenie id).
const MAX_NA_RAZ = 50;

const zaokr = (x) => Math.round(x * 100) / 100;
const n4 = (x) => Math.round(x * 10000) / 10000;
const kwota = (x) => Number(x).toFixed(2).replace('.', ',');

// Cena brutto → netto z 4 miejscami, która po × (1 + VAT) daje DOKŁADNIE tę cenę brutto (tak liczy strona eMAG;
// ta sama metoda co pricing/emag.js zmianaCeny). null = nie da się.
function nettoZBrutto(brutto, stawka) {
  const c = zaokr(Number(brutto));
  if (!(c > 0) || !(stawka >= 0)) return null;
  return [0, 0.0001, -0.0001].map((d) => n4(c / (1 + stawka) + d)).find((x) => zaokr(x * (1 + stawka)) === c) ?? null;
}

// Waga z GT (pwd_Tekst06) → gramy. Tylko zapis z częścią ułamkową jest jednoznacznie w kg („0,874”, „1.31”).
// Liczba całkowita to historycznie gramy ALBO kg — nie zgadujemy (CLAUDE.md „Parametry produktu”).
function wagaGramy(tekst) {
  const s = String(tekst ?? '').trim().replace(',', '.');
  if (!s) return { blad: 'brak wagi w GT — uzupełnij w Parametrach' };
  if (!/^\d+(\.\d+)?$/.test(s)) return { blad: `waga w GT nie jest liczbą („${tekst}”)` };
  if (!s.includes('.')) return { blad: `waga w GT „${tekst}” bez przecinka — nie wiadomo, czy gramy, czy kg; popraw w Parametrach (kg)` };
  const g = Math.round(Number(s) * 1000);
  if (g < 1) return { blad: `waga w GT ${tekst} kg to mniej niż 1 g — popraw w Parametrach` };
  if (g > 500000) return { blad: `waga w GT ${tekst} kg nierealna — popraw w Parametrach` };
  return { g };
}

// Wymiary z GT (services/gt-atrybuty.js rozbierzWymiary: cm) → mm dla eMAG measurements/save.
function wymiaryMm(r) {
  if (!r || ![r.dlugosc, r.szerokosc, r.wysokosc].every((x) => Number(x) > 0)) return { blad: 'brak wymiarów w GT — uzupełnij w Parametrach' };
  return { length: Math.round(r.dlugosc * 10), width: Math.round(r.szerokosc * 10), height: Math.round(r.wysokosc * 10) };
}

// Pozycja do wystawienia: { platforma, rynek, tw_id, sku, ean, cena (brutto), ilosc, katalog, waga, wymiary, pas }
// → { blokady: [tekst], brakuje: [{pole, tekst}], ostrzezenia: [{kod, tekst}] }.
//   brakuje  = dane towaru do uzupełnienia w GT (EAN, waga, wymiary) — pozycja ZOSTAJE na liście z komunikatem „dane do
//              uzupełnienia” (decyzja usera 2026-10-30: nie ukrywać), ale wystawić się jej nie da;
//   blokady  = pozostałe powody, dla których nie wyślemy wcale (rynek bez testu, brak produktu, marka, stan, cena);
//   ostrzezenia = wymaga potwierdzenia.
function ocenPozycje(p) {
  const blokady = [], brakuje = [], ostrzezenia = [];
  const r = gotowyRynek(p.platforma, p.rynek);
  if (!r.gotowe) blokady.push(r.powod);
  if (!p.ean) brakuje.push({ pole: 'EAN', tekst: 'brak poprawnego EAN-u w GT' });
  if (!p.katalog?.produkt_id) blokady.push('brak produktu na rynku');
  if (p.platforma === 'emag' && !(p.katalog?.nazwa && p.katalog?.marka && p.katalog?.kategoria_id)) blokady.push('katalog eMAG bez nazwy / marki / kategorii — odśwież skan');
  if (p.katalog?.ograniczenie) blokady.push(p.katalog.ograniczenie);
  const w = wagaGramy(p.waga); if (w.blad) brakuje.push({ pole: 'waga', tekst: w.blad });
  const m = wymiaryMm(p.wymiary); if (m.blad) brakuje.push({ pole: 'wymiary', tekst: m.blad });
  if (!(Number(p.ilosc) > 0)) blokady.push('brak stanu dostępnego');
  if (!(Number(p.cena) > 0)) blokady.push('brak ceny');
  else if (!p.pas?.min) ostrzezenia.push({ kod: 'bez_pasa', tekst: 'kalkulator nie policzył minimum — automat nie poprowadzi ceny, dopóki nie będzie pasa' });
  else if (p.cena < p.pas.min - 0.005) ostrzezenia.push({ kod: 'pod_minimum', tekst: `cena ${kwota(p.cena)} poniżej minimum ${kwota(p.pas.min)}` });
  return { blokady, brakuje, ostrzezenia };
}
// Wszystko, co zatrzymuje wysyłkę — braki danych i blokady razem (backend nie wyśle pozycji z czymkolwiek z tego).
const powodyBlokady = (o) => [...o.blokady, ...(o.brakuje || []).map((b) => b.tekst)];

// eMAG product_offer/save przy dopięciu do istniejącego PNK. Wymaga name/brand/category_id z katalogu (inaczej
// „Product name should not be empty”); `ean` ZAWSZE w treści — pełny save bez niego kasuje EAN oferty.
function ofertaEmag(p, id) {
  const vat = EMAG_VAT[p.rynek];
  if (!vat) return { blad: `eMAG ${p.rynek}: nieznana stawka VAT` };
  const netto = nettoZBrutto(p.cena, vat.stawka);
  if (netto == null) return { blad: `nie da się wyrazić ${p.cena} brutto ceną netto z 4 miejscami` };
  const minBrutto = zaokr(Math.min(p.cena, (p.pas?.min || p.cena)) * EMAG_ZAKRES.minUlamek);
  const maxBrutto = zaokr(Math.max(p.cena * EMAG_ZAKRES.maxMnoznik, p.pas?.max || 0));
  return {
    oferta: {
      id, part_number_key: p.katalog.produkt_id, part_number: p.sku,
      name: p.katalog.nazwa, brand: p.katalog.marka, category_id: Number(p.katalog.kategoria_id),
      status: 1, sale_price: netto, vat_id: vat.id,
      min_sale_price: n4(minBrutto / (1 + vat.stawka)), max_sale_price: n4(maxBrutto / (1 + vat.stawka)),
      stock: [{ warehouse_id: 1, value: Math.floor(Number(p.ilosc)) }],
      handling_time: [{ warehouse_id: 1, value: EMAG_STALE.handling_time }],
      supply_lead_time: EMAG_STALE.supply_lead_time, warranty: EMAG_STALE.warranty,
      ean: [p.ean],
    },
    netto,
  };
}

// eMAG measurements/save: mm i g (waga ≥ 1 g). Po zapisie panel potrafi pokazywać puste „Volumetrie” (Furby 29.10) —
// stąd pozycja w historii ma przypomnienie, żeby sprawdzić.
function wymiaryEmag(p, id) {
  const w = wagaGramy(p.waga), m = wymiaryMm(p.wymiary);
  if (w.blad || m.blad) return { blad: w.blad || m.blad };
  return { pomiar: { id, ...m, weight: w.g } };
}

// Stan do wystawienia = dostępny (Razem − rezerwacje na tych samych magazynach), jak na ekranach analizy sprzedaży.
// stany = wpis z services/gt-produkty.js pobierzStanyGt ({ K4: {ilosc, rezerwacja}, … }), magazyny = MAGAZYNY_RAZEM.
function stanDostepny(stany, magazyny) {
  if (!stany) return null;
  return magazyny.reduce((s, kod) => s + Math.max(0, (Number(stany[kod]?.ilosc) || 0) - (Number(stany[kod]?.rezerwacja) || 0)), 0);
}

module.exports = {
  RYNKI_WYSTAWIANIA, gotowyRynek, EMAG_VAT, EMAG_ID_START, EMAG_STALE, EMAG_ZAKRES, MAX_NA_RAZ,
  nettoZBrutto, wagaGramy, wymiaryMm, ocenPozycje, powodyBlokady, ofertaEmag, wymiaryEmag, stanDostepny,
};
