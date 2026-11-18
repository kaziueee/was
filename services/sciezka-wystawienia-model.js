'use strict';

// Ścieżka wystawienia towaru (Ceny → „Ścieżka”): każdy towar ze stanem na K4/K4G w jednym wierszu z kolejnymi
// krokami wystawienia i tym, czego brakuje. Kolejność kroków to kolejność pracy ustalona z userem (2026-11-17):
//   1. GT     — flaga „Sklep internetowy” (`tw_SklepInternet`), cena Specjalna (poziom 3) > 0, EAN, waga, wymiary.
//               Bez flagi BaseLinker/Sellasist nie dostają stanu, a oferta bez stanu jest od razu wyłączana.
//   2. Sklep  — karta w poszukiwaczefrajdy.pl. Feed Google Merchant pokazuje kartę dopiero, gdy BaseLinker dał jej
//               cenę i stan, więc „w feedzie” = założona I powiązana. Kartę założoną, która czeka na Base, widać tylko
//               z ręcznego odhaczenia w WMS (tabela `sklep_karty`).
//   3. Allegro — oferta na ekajtek albo NaTropie (galerie i opisy bierzemy z karty sklepu, więc po kroku 2).
//   4. Rynki  — eMAG / Empik / Kaufland / Amazon: czy zostało coś do wystawienia z „Do wystawienia”.
// Etap towaru = pierwszy krok, który nie jest zrobiony. Czysta logika: bez GT, SQLite i sieci (testy
// test/sciezka-wystawienia-model.test.js); dane zbiera services/sciezka-wystawienia.js w osobnym wątku (zasada 7).

const { wagaGramy, wymiaryMm, RYNKI_WYSTAWIANIA } = require('../pricing/wystawianie-model');
const { normalizujEan } = require('../pricing/katalogi-model');

const KROKI = [
  { klucz: 'gt', nazwa: 'Subiekt', opis: 'flaga sklepu, cena Specjalna, EAN, waga, wymiary' },
  { klucz: 'sklep', nazwa: 'Sklep', opis: 'karta w poszukiwaczefrajdy.pl powiązana z BaseLinkerem' },
  { klucz: 'allegro', nazwa: 'Allegro', opis: 'oferta na ekajtek albo NaTropie' },
  { klucz: 'rynki', nazwa: 'Rynki', opis: 'eMAG, Empik, Kaufland, Amazon — nic nie czeka na wystawienie' },
];
const ETAPY = [...KROKI.map((k) => k.klucz), 'gotowe'];

// Rynki, które ekran „Do wystawienia” umie dziś wystawić (flaga `gotowe` po teście pierwszej oferty). Rynek bez testu
// nie jest „do zrobienia” — nikt nie ma jak go wykonać, więc nie trzyma towaru na kroku 4.
const RYNKI = Object.entries(RYNKI_WYSTAWIANIA).filter(([, r]) => r.gotowe).map(([k]) => {
  const [platforma, rynek] = k.split(':');
  return { klucz: k, platforma, rynek };
});
const KONTA_ALLEGRO = ['EKAJTEK', 'NATROPIE'];
// Oferta „jest”, gdy sync widział ją w ostatnich 3 dniach — ta sama granica co lista „Do wystawienia”.
const OFERTA_SWIEZA_DNI = 3;

// ---------- krok 1: dane w Subiekcie ----------

// t: { sklep (bool), cena3, ean, waga (tekst z GT), wymiary_rozbite ({dlugosc, szerokosc, wysokosc} | null) }
// → [{ pole, tekst }] — puste = krok zrobiony. Te same reguły co blokady wystawiania (pricing/wystawianie-model.js),
// żeby „Subiekt OK” na ścieżce znaczyło „Do wystawienia nie zablokuje towaru za dane”.
function brakiGt(t) {
  const braki = [];
  if (t.sklep !== true) braki.push({ pole: 'flaga', tekst: 'brak oznaczenia „sklep internetowy” w Subiekcie' });
  if (!(Number(t.cena3) > 0)) braki.push({ pole: 'cena', tekst: 'cena Specjalna (poziom 3) = 0' });
  if (!normalizujEan(t.ean)) braki.push({ pole: 'ean', tekst: 'brak poprawnego EAN-u' });
  const w = wagaGramy(t.waga); if (w.blad) braki.push({ pole: 'waga', tekst: w.blad });
  const m = wymiaryMm(t.wymiary_rozbite); if (m.blad) braki.push({ pole: 'wymiary', tekst: m.blad });
  return braki;
}

// ---------- krok 2: sklep ----------

const kluczSymbolu = (s) => String(s ?? '').trim().toUpperCase();

// Feed Google Merchant sklepu (XML Atom, ~13 MB, ~4 tys. kart). Bez parsera XML: wpisy mają stały, płaski kształt
// (`<entry>` z polami `g:*`), a moduł ma działać bez zależności. Zwraca Map(SYMBOL → { id, cena, link, duplikaty }).
// `g:mpn` = kod magazynowy karty = symbol GT (łącznik i BaseLinker dopasowują po nim). Ten sam kod na kilku kartach
// (w sklepie zdarza się) psuje synchronizację — zapisujemy, ile ich jest, i bierzemy kartę o najwyższym id (najnowszą).
function parsujFeed(xml) {
  const mapa = new Map();
  const pole = (e, nazwa) => {
    const m = e.match(new RegExp(`<g:${nazwa}>(?:<!\\[CDATA\\[)?([^<\\]]*)`));
    return m ? m[1].trim() : null;
  };
  const re = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = re.exec(String(xml))) !== null) {
    const e = m[1];
    const symbol = kluczSymbolu(pole(e, 'mpn'));
    const id = Number(pole(e, 'id'));
    if (!symbol || !Number.isInteger(id)) continue;
    const cena = Number(String(pole(e, 'price') || '').replace(/[^\d.,]/g, '').replace(',', '.'));
    const wpis = { id, cena: Number.isFinite(cena) ? cena : null, link: pole(e, 'link'), duplikaty: 1 };
    const byl = mapa.get(symbol);
    if (byl) wpis.duplikaty = byl.duplikaty + 1;
    if (!byl || id > byl.id) mapa.set(symbol, wpis);
    else byl.duplikaty = wpis.duplikaty;
  }
  return mapa;
}

// feed: wpis z parsujFeed albo null; feedZnany: false = feed się nie wczytał (nie wiemy — NIE „brak karty”);
// odhaczenie: { karta_id, czas, kto } z sklep_karty albo null.
// status: jest (w feedzie z ceną) | czeka_na_base (założona, Base jeszcze nie powiązał) | brak | nieznany.
function krokSklep({ feed, feedZnany = true, odhaczenie = null }) {
  if (feed && feed.cena > 0) return { status: 'jest', karta_id: feed.id, cena: feed.cena, link: feed.link, duplikaty: feed.duplikaty };
  if (feed) return { status: 'czeka_na_base', karta_id: feed.id, link: feed.link, duplikaty: feed.duplikaty, powod: 'w feedzie z ceną 0' };
  if (odhaczenie) return { status: 'czeka_na_base', karta_id: odhaczenie.karta_id ?? null, odhaczono: odhaczenie.czas, kto: odhaczenie.kto };
  if (!feedZnany) return { status: 'nieznany', powod: 'feed sklepu się nie wczytał' };
  return { status: 'brak' };
}

// ---------- krok 3: Allegro ----------

// oferty: wiersze `oferty` (platforma 'allegro') tego towaru: { rynek (konto), asin (numer oferty), aktywna, cena,
// swieza (widziana w ostatnich OFERTA_SWIEZA_DNI) }. Sync Allegro czyta tylko aktywne oferty — zakończona zostaje
// wierszem z aktywna = 0, więc „nieaktywna” = była, dziś jej nie ma na liście aktywnych.
function krokAllegro(oferty = []) {
  const konta = {};
  for (const konto of KONTA_ALLEGRO) {
    const moje = oferty.filter((o) => o.rynek === konto);
    const akt = moje.find((o) => o.aktywna && o.swieza);
    if (akt) konta[konto] = { status: 'aktywna', oferta: akt.asin || null, cena: akt.cena ?? null };
    else if (moje.length) konta[konto] = { status: 'nieaktywna', oferta: moje[0].asin || null };
    else konta[konto] = { status: 'brak' };
  }
  return { ok: Object.values(konta).some((k) => k.status === 'aktywna'), konta };
}

// ---------- krok 4: pozostałe rynki ----------

// Stan jednego rynku dla towaru. Kolejność warunków = co jest najbardziej pewne:
//   oferta (sync ją widzi) → w_toku (wysłana, sync jeszcze nie dopiął) → nieaktywna (była, wyłączona: eMAG/Empik/
//   Kaufland wyłączają ofertę przy stanie 0) → katalog: nie_sprawdzono / brak_karty / zablokowane → odrzucone
//   (ostatnia próba odrzucona — decyzja człowieka) → mozna (Do wystawienia ją pokaże) | czeka_na_dane (krok 1).
function stanRynku({ oferty = [], katalog = null, wystawienie = null, gtOk = true }) {
  const akt = oferty.find((o) => o.aktywna && o.swieza);
  if (akt) return { status: 'oferta', cena: akt.cena ?? null };
  if (wystawienie?.status === 'wyslane') return { status: 'w_toku' };
  if (oferty.length) return { status: 'nieaktywna' };
  if (katalog?.mamy) return { status: 'oferta', powod: 'platforma zgłasza naszą ofertę' };
  if (!katalog) return { status: 'nie_sprawdzono' };
  if (!katalog.produkt_id) return { status: 'brak_karty' };
  if (katalog.dodac === 0) return { status: 'zablokowane', powod: 'platforma nie pozwala dodać oferty' };
  if (katalog.ograniczenie) return { status: 'zablokowane', powod: katalog.ograniczenie };
  if (wystawienie?.status === 'odrzucone') return { status: 'odrzucone', powod: wystawienie.opis || 'platforma odrzuciła' };
  return gtOk ? { status: 'mozna' } : { status: 'czeka_na_dane' };
}

// dane: Map(klucz rynku → { oferty, katalog, wystawienie }). Krok zrobiony, gdy żaden rynek nie czeka na wystawienie
// (mozna). czeka_na_dane nie trzyma towaru tutaj — trzyma go krok 1.
function krokRynki(dane = new Map(), gtOk = true) {
  const rynki = {};
  for (const r of RYNKI) rynki[r.klucz] = stanRynku({ ...(dane.get(r.klucz) || {}), gtOk });
  const vals = Object.values(rynki);
  const licz = (s) => vals.filter((x) => x.status === s).length;
  return { ok: licz('mozna') === 0, rynki, oferty: licz('oferta'), mozna: licz('mozna') };
}

// ---------- całość ----------

// t: towar z GT ({ tw_id, symbol, nazwa, grupa, rodzaj, stan, sklep, cena3, ean, waga, wymiary_rozbite, ... })
// kontekst: { feed, feedZnany, odhaczenie, allegro: [oferty], rynki: Map }
function ocenTowar(t, kontekst = {}) {
  const braki = brakiGt(t);
  const gt = { ok: braki.length === 0, braki };
  const sklep = krokSklep({ feed: kontekst.feed, feedZnany: kontekst.feedZnany !== false, odhaczenie: kontekst.odhaczenie });
  const allegro = krokAllegro(kontekst.allegro);
  const rynki = krokRynki(kontekst.rynki, gt.ok);
  const kroki = { gt, sklep: { ok: sklep.status === 'jest', ...sklep }, allegro, rynki };
  const etap = KROKI.find((k) => !kroki[k.klucz].ok)?.klucz ?? 'gotowe';
  return { etap, kroki };
}

function podsumuj(towary) {
  const etapy = Object.fromEntries(ETAPY.map((e) => [e, 0]));
  for (const t of towary) etapy[t.etap] = (etapy[t.etap] || 0) + 1;
  return { towarow: towary.length, etapy };
}

module.exports = {
  KROKI, ETAPY, RYNKI, KONTA_ALLEGRO, OFERTA_SWIEZA_DNI,
  brakiGt, kluczSymbolu, parsujFeed, krokSklep, krokAllegro, stanRynku, krokRynki, ocenTowar, podsumuj,
};
