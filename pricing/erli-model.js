'use strict';

// Erli: kopia oferty Allegro → produkt Erli (czysta logika, bez API, SQLite i GT — testy w test/erli-model.test.js).
// Wysyłka i odczyty: pricing/erli.js, narzędzie agenta: scripts/erli-wystaw.js (umiejętność `erli-wystawianie`).
//
// Zakres (decyzje usera 2026-11-26): WMS TYLKO zakłada produkt na Erli — kopia oferty Allegro ekajtek, cena = Allegro
// + 2%. Bez zamówień, bez repricera, bez synchronizacji ceny. Stanem po założeniu zajmuje się BaseLinker (user
// wiąże ofertę tam, jak przy Allegro); przy założeniu podajemy stan z oferty Allegro (to już stan BL, ucięty do 50).
//
// Kształt produktu = kształt 10 170 kopii, które na Erli już są (pomiar 2026-11-26, HASF2377 / 17715639226):
// externalId = numer oferty Allegro, sku = symbol GT, kategoria i parametry z identyfikatorami Allegro
// (`source: "allegro"` — Erli mapuje je sam), producent GPSR z Allegro, opis w sekcjach, cennik dostawy o tej samej
// nazwie co cennik oferty Allegro, wysyłka 24 h, VAT 23%. Nagłówki opisu wysyłamy BEZ ZMIANY poziomu — Erli sam
// obniża je o jeden (h1 → h2; test BARBBDS6 2026-11-26: wysłane h2 wyświetliło się jako h3).
//
// Producent GPSR: Erli łączy `externalResponsibleProducer` ze SWOIM słownikiem (/dictionaries/responsibleProducers,
// klucz `idempotenceKey` = id producenta w Allegro). Producenta spoza słownika Erli po cichu pomija (test BARBBDS6),
// więc brakującego najpierw dodajemy do słownika (producentErli) — tak samo osobę odpowiedzialną.

// Cena: Allegro ekajtek × 1,05, w górę do ,99 (109,99 → 115,49 → 115,99). W groszach, jak chce API Erli.
// Zasada usera 2026-11-26: cena na Erli = Allegro ekajtek + 5% — najpierw jako podłoga („nie może być niższa”), tego
// samego dnia także w dół („resztę też obniż” — stare kopie miały ceny ~30–50% nad Allegro). Pilnuje
// pricing/erli-ceny.js. Pierwsze 6 ofert z 26.11 poszło jeszcze z narzutem 2%.
const NARZUT = 1.05;
function cenaErliGrosze(cenaAllegro) {
  const c = Number(cenaAllegro);
  if (!(c > 0)) return null;
  const cel = Math.round(c * NARZUT * 100);
  let g = Math.floor(cel / 100) * 100 + 99;
  if (g < cel) g += 100;
  return g;
}
// Najniższa dozwolona cena na Erli (grosze) — bez zaokrąglenia do ,99.
const podlogaGrosze = (cenaAllegro) => (Number(cenaAllegro) > 0 ? Math.round(Number(cenaAllegro) * NARZUT * 100) : null);
// Pilnowanie: cena Erli ≠ Allegro + 5% (do ,99) → nowa cena (grosze), inaczej null. W obie strony; zmienia się tylko
// wtedy, gdy zmieni się cena Allegro, bo cel wynika wyłącznie z niej.
function korektaCeny(cenaErliGr, cenaAllegro) {
  const cel = cenaErliGrosze(cenaAllegro);
  if (cel == null || !(Number(cenaErliGr) >= 0)) return null;
  return Number(cenaErliGr) !== cel ? cel : null;
}

const DISPATCH = { unit: 'hour', period: 24 };     // jak wszystkie obecne kopie
const MAX_NAZWA = 150;

// Erli przyjmuje w opisie TYLKO: h1 h2 h3 p b br/ ol ul li — małymi literami, bez atrybutów, nagłówki z samym tekstem,
// bez tekstu na poziomie root. Opisy Allegro mają ten sam ubogi zestaw (h1 h2 p b ul ol li), więc wystarczy:
// zdjąć atrybuty i obce znaczniki (tekst zostaje), <br> → <br/>, h4–h6 → h3, z nagłówków zdjąć zagnieżdżone
// znaczniki, tekst luzem owinąć w <p>.
const DOZWOLONE = new Set(['h1', 'h2', 'h3', 'p', 'b', 'ol', 'ul', 'li']);
const NAGLOWEK = { h4: 'h3', h5: 'h3', h6: 'h3' };
function htmlDlaErli(html) {
  let s = String(html ?? '').replace(/\r/g, '');
  s = s.replace(/<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)\s*>/g, (_, zam, tag) => {
    let t = tag.toLowerCase();
    if (t === 'strong') t = 'b';
    if (t === 'br') return '<br/>';
    if (NAGLOWEK[t]) t = NAGLOWEK[t];
    return DOZWOLONE.has(t) ? `<${zam}${t}>` : '';
  });
  // Nagłówki: tylko tekst.
  s = s.replace(/<(h[123])>([\s\S]*?)<\/\1>/g, (_, h, w) => `<${h}>${w.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}</${h}>`);
  s = s.replace(/<(h[123])>\s*<\/\1>/g, '');
  // Tekst luzem (między blokami) → <p>; luźne <li> poza listą zdejmujemy (<b> wolno w <p>).
  const luzem = (x) => {
    const t = x.replace(/<\/?li>/g, '').replace(/^(\s|<br\/>)+|(\s|<br\/>)+$/g, '');
    return t ? `<p>${t}</p>` : '';
  };
  let wynik = '', ost = 0, m;
  const re = /<(h[123]|p|ul|ol)>[\s\S]*?<\/\1>/g;
  while ((m = re.exec(s)) !== null) {
    wynik += luzem(s.slice(ost, m.index)) + m[0];
    ost = re.lastIndex;
  }
  wynik += luzem(s.slice(ost));
  // Odstępy przy znacznikach blokowych (`<ul> <li>`) to tekst poza dozwolonym miejscem — zdejmujemy.
  return wynik.replace(/\n+/g, ' ').replace(/\s*(<\/?(?:h[123]|p|ul|ol|li)>)\s*/g, '$1').replace(/<p><\/p>/g, '').trim();
}

// Erli pobiera każdy adres zdjęcia RAZ — błąd pobrania (np. serwer zdjęć Allegro odmówił przy wielu pobraniach naraz)
// porzuca ten adres na zawsze, także dla przyszłych produktów (dokumentacja „Obrazki”; test 26.11: SKDBAT dostał 1 z 3
// zdjęć, ponowne wysłanie z dopiskiem `#…` — 3 z 3). Dopisek jest unikalny dla produktu i próby, adres zdjęcia ten sam.
const zDopiskiem = (url, dopisek) => (dopisek ? `${String(url).split('#')[0]}#${dopisek}` : String(url));

// description.sections Allegro → Erli. Sekcja ma 1–2 elementy po obu stronach; pusty tekst odpada.
function opisDlaErli(opisAllegro, dopisek = null) {
  const sekcje = [];
  for (const s of opisAllegro?.sections || []) {
    const items = [];
    for (const it of s?.items || []) {
      if (it?.type === 'IMAGE' && it.url) items.push({ type: 'IMAGE', url: zDopiskiem(it.url, dopisek) });
      else if (it?.type === 'TEXT') {
        const content = htmlDlaErli(it.content);
        if (content.length >= 2) items.push({ type: 'TEXT', content });
      }
    }
    if (items.length) sekcje.push({ items: items.slice(0, 2) });
  }
  return sekcje.length ? { sections: sekcje } : null;
}

// Parametry Allegro (produkt z productSet + parametry oferty, np. „Stan”) → externalAttributes ze `source: "allegro"`.
// Słownikowe po valuesIds, zakresy jako range, reszta jako tekst (obecne kopie trzymają liczby jako tekst „38.5”).
function atrybutyZAllegro(...listy) {
  const wynik = [];
  const byly = new Set();
  for (const p of listy.flat()) {
    const id = p?.id != null ? String(p.id) : null;
    if (!id || byly.has(id)) continue;
    let a = null;
    if (Array.isArray(p.valuesIds) && p.valuesIds.length) {
      a = { type: 'dictionary', id, source: 'allegro', values: p.valuesIds.map((v) => ({ id: String(v) })) };
    } else if (p.rangeValue && p.rangeValue.from != null && p.rangeValue.to != null) {
      const from = Number(p.rangeValue.from), to = Number(p.rangeValue.to);
      if (Number.isFinite(from) && Number.isFinite(to)) a = { type: 'range', id, source: 'allegro', values: { from, to } };
    } else if (Array.isArray(p.values) && p.values.some((v) => v != null && String(v).trim() !== '')) {
      a = { type: 'string', id, source: 'allegro', values: p.values.filter((v) => v != null && String(v).trim() !== '').map((v) => String(v).slice(0, 2000)) };
    }
    if (!a) continue;
    byly.add(id);
    wynik.push({ ...a, index: wynik.length });
  }
  return wynik;
}

// VAT oferty Allegro (PL) → enum Erli.
function stawkaVat(taxSettings) {
  const r = (taxSettings?.rates || []).find((x) => x?.countryCode === 'PL');
  const n = Math.round(Number(r?.rate));
  return Number.isFinite(n) && [23, 8, 5, 0].includes(n) ? `TAX_${n}` : 'TAX_23';
}

// Parametr produktu Allegro po nazwie (np. „Marka”) → pierwsza wartość tekstem.
function parametr(parametry, nazwa) {
  const p = (parametry || []).find((x) => String(x?.name || '').toLowerCase() === nazwa.toLowerCase());
  if (!p) return null;
  return (p.valuesLabels || p.values || [])[0] ?? null;
}

// Oferta Allegro (GET /sale/product-offers/{id}) + cennik Erli → treść POST /products/{externalId}.
//   gramy        = waga z GT (wystawianie-model.wagaGramy), null = nie wysyłamy;
//   cennikErli   = nazwa cennika dostawy na Erli (ta sama co cennik oferty Allegro);
//   stan         = ile sztuk podać przy założeniu;
//   dopisek      = znacznik do adresów zdjęć (domyślnie `erli-<nr oferty>`), patrz zDopiskiem.
function produktZAllegro(oferta, { gramy = null, cennikErli = null, stan = null, dopisek = `erli-${oferta?.id}` } = {}) {
  const ps = oferta?.productSet?.[0] || {};
  const atrybuty = atrybutyZAllegro(ps.product?.parameters || [], oferta?.parameters || []);
  const ean = String(parametr(ps.product?.parameters, 'EAN (GTIN)') || '').trim() || null;
  const body = {
    name: String(oferta?.name || '').trim().slice(0, MAX_NAZWA),
    description: opisDlaErli(oferta?.description, dopisek),
    ean,
    sku: String(oferta?.external?.id || '').trim() || null,
    baseMarket: 'pl',
    externalReferences: [{ kind: 'allegro', id: String(oferta.id), source: 'api' }],
    externalCategories: oferta?.category?.id ? [{ source: 'allegro', breadcrumb: [{ id: String(oferta.category.id) }], index: 0 }] : null,
    externalAttributes: atrybuty.length ? atrybuty : null,
    images: (oferta?.images || []).filter(Boolean).map((url) => ({ url: zDopiskiem(url, dopisek) })),
    price: cenaErliGrosze(oferta?.sellingMode?.price?.amount),
    stock: Math.max(0, Math.floor(Number(stan ?? oferta?.stock?.available) || 0)),
    status: 'active',
    dispatchTime: DISPATCH,
    taxRate: stawkaVat(oferta?.taxSettings),
    invoiceType: 'vatInvoice',
  };
  if (cennikErli) body.deliveryPriceList = cennikErli;
  if (gramy > 0) body.weight = Math.round(gramy);
  if (ps.responsibleProducer?.id) body.externalResponsibleProducer = [{ externalId: String(ps.responsibleProducer.id), source: 'allegro' }];
  if (ps.responsiblePerson?.id) body.externalResponsiblePerson = [{ externalId: String(ps.responsiblePerson.id), source: 'allegro' }];
  return body;
}

// Czy produkt da się wystawić. Wejście zbiera skrypt (GT, feed sklepu, Allegro, Erli):
//   oferta    = oferta Allegro (pełna), sciezka = nazwy kategorii Allegro od korzenia,
//   gt        = { sklep, cena3, ean, waga, wymiary (rozbite), nazwa },
//   wFeedzie  = towar ma kartę na Fenomie (feed sklepu; null = feed się nie wczytał),
//   naErli    = { poId: produkt z tym externalId (także zarchiwizowany), poSku: niezarchiwizowane produkty z tym SKU },
//   cennikErli = nazwa cennika na Erli (null = nie ma odpowiednika cennika Allegro).
// → { blokady: [tekst] } — pusta lista = można wystawić. Zasady usera dla KAŻDEJ nowej oferty (pamięć projektu):
// flaga sklepu + cena Specjalna > 0, EAN + wymiary + waga, karta na Fenomie, bez Tefal/Rowenta, nigdy „Pozostałe”.
const MARKI_POMIJANE = /\b(tefal|rowenta)\b/i;
// Zasady usera 2026-11-26: bez wariantów uszkodzonych / poprezentacyjnych (symbol bazowy + U/P, rozpoznanie jak
// oznaczWariantyPU w gt-produkty) i bez towarów, których jest mniej niż 3 szt. (stan oferty Allegro = stan z BaseLinkera).
const MIN_STAN = 3;
const NAZWA_PU = /uszkodz|poprezent|powystaw/i;
function ocenKandydata({ oferta, sciezka = [], gt = null, wFeedzie = null, naErli = {}, cennikErli = null, wagaBlad = null, wymiaryBlad = null, wariantPU = false }) {
  const blokady = [];
  if (!oferta) return { blokady: ['brak oferty Allegro'] };
  if (oferta.publication?.status !== 'ACTIVE') blokady.push(`oferta Allegro nieaktywna (${oferta.publication?.status || '?'})`);
  if (naErli.poId) blokady.push(`na Erli już jest produkt ${oferta.id}${naErli.poId.archived ? ' (zarchiwizowany — przywróć w panelu Erli)' : ` (${naErli.poId.status})`}`);
  if (naErli.poSku?.length) blokady.push(`na Erli już jest ten SKU: ${naErli.poSku.map((p) => `${p.externalId} ${p.status}`).join(', ')}`);
  if (!gt) blokady.push('SKU oferty nie pasuje do towaru w Subiekcie');
  else {
    if (gt.sklep !== true) blokady.push('brak oznaczenia „sklep internetowy” w Subiekcie');
    if (!(Number(gt.cena3) > 0)) blokady.push('cena Specjalna (poziom 3) w Subiekcie = 0');
    if (!gt.ean) blokady.push('brak EAN-u w Subiekcie');
    if (wagaBlad) blokady.push(wagaBlad);
    if (wymiaryBlad) blokady.push(wymiaryBlad);
  }
  if (wFeedzie === false) blokady.push('brak karty na Fenomie (feed sklepu)');
  if (wFeedzie == null) blokady.push('feed sklepu się nie wczytał — nie wiadomo, czy jest karta na Fenomie');
  const marka = parametr(oferta.productSet?.[0]?.product?.parameters, 'Marka');
  if (MARKI_POMIJANE.test(`${marka || ''} ${oferta.name || ''} ${gt?.nazwa || ''}`)) blokady.push('Tefal / Rowenta — na razie pomijamy');
  if (sciezka.some((n) => /pozosta/i.test(String(n)))) blokady.push(`kategoria „Pozostałe” (${sciezka.join(' > ')}) — popraw kategorię na Allegro`);
  if (!oferta.category?.id) blokady.push('oferta bez kategorii Allegro');
  if (!(oferta.images || []).length) blokady.push('oferta bez zdjęć');
  if (cenaErliGrosze(oferta.sellingMode?.price?.amount) == null) blokady.push('oferta bez ceny w PLN');
  if (!(Number(oferta.stock?.available) > 0)) blokady.push('oferta Allegro bez stanu');
  else if (Number(oferta.stock.available) < MIN_STAN) blokady.push(`stan ${oferta.stock.available} szt. — wystawiamy od ${MIN_STAN}`);
  if (wariantPU === true || NAZWA_PU.test(`${oferta.name || ''} ${gt?.nazwa || ''}`)) blokady.push('wariant uszkodzony / poprezentacyjny — nie wystawiamy');
  if (wariantPU == null) blokady.push('nie udało się sprawdzić, czy to wariant uszkodzony / poprezentacyjny');
  if (!cennikErli) blokady.push('na Erli nie ma cennika dostawy o nazwie cennika oferty Allegro');
  return { blokady };
}

// Producent / osoba odpowiedzialna z Allegro (GET /sale/responsible-producers/{id}, /sale/responsible-persons/{id})
// → wpis słownika Erli (CreateResponsibleSchema). Kształt jak 139 wpisów, które Erli już ma ze `source: "allegro"`:
// name = nazwa podmiotu (tradeName), properName = nazwa z Allegro, idempotenceKey = id z Allegro.
function podmiotErli(a, dane) {
  if (!a?.id || !dane) return { blad: 'brak danych z Allegro' };
  const adr = dane.address || {};
  const kontakt = dane.contact || {};
  const wpis = {
    name: String(dane.tradeName || dane.name || a.name || '').trim().slice(0, 200),
    idempotenceKey: String(a.id),
    properName: String(a.name || dane.tradeName || '').trim().slice(0, 200),
    country: String(adr.countryCode || '').trim().toLowerCase(),
    address: String(adr.street || '').trim().slice(0, 200),
    postalCode: String(adr.postalCode || '').trim().slice(0, 20),
    city: String(adr.city || '').trim().slice(0, 100),
    email: String(kontakt.email || '').trim(),
    source: 'allegro',
  };
  if (kontakt.phoneNumber) wpis.phone = String(kontakt.phoneNumber).trim().slice(0, 30);
  const braki = ['name', 'properName', 'country', 'address', 'postalCode', 'city', 'email'].filter((k) => !wpis[k]);
  if (!/^[a-z]{2}$/.test(wpis.country)) braki.push('kraj');
  if (wpis.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(wpis.email)) braki.push('e-mail');
  return braki.length ? { blad: `dane producenta w Allegro niepełne: ${[...new Set(braki)].join(', ')}` } : { wpis };
}
const producentErli = (a) => podmiotErli(a, a?.producerData);
const osobaErli = (a) => podmiotErli(a, a?.personalData);

module.exports = { MIN_STAN, NARZUT, podlogaGrosze, korektaCeny, zDopiskiem, producentErli, osobaErli, DISPATCH, cenaErliGrosze, htmlDlaErli, opisDlaErli, atrybutyZAllegro, stawkaVat, parametr, produktZAllegro, ocenKandydata };
