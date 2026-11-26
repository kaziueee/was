'use strict';

// Wystawianie na Erli — kopia oferty Allegro ekajtek (umiejętność agenta `erli-wystawianie`,
// .claude/skills/erli-wystawianie/SKILL.md). Uruchamiać NA SRV z C:\was — tam są klucz Erli (.env.dpapi), tokeny Allegro
// (pricing.db) i GT. Logika i zasady: pricing/erli-model.js.
//
//   node scripts/erli-wystaw.js --lista [--limit 30] [--min-stan 1] [--csv plik.csv]
//       kandydaci: aktywne oferty Allegro ekajtek, których kopii nie ma na Erli; wstępna ocena z GT i feedu
//       sklepu (bez pobierania pełnych ofert Allegro). Tylko odczyt.
//   node scripts/erli-wystaw.js --oferty 17715639226,18000000000   (albo --symbole HASF2377,NERF1234)
//       PODGLĄD: pełna oferta Allegro → produkt Erli + wszystkie blokady. Tylko odczyt.
//   ... --zapisz
//       zakłada na Erli produkty bez blokad (POST /products/{nr oferty Allegro}), sprawdza je po zapisie i zapisuje
//       próbę w pricing.db (`wystawienia`, platforma 'erli' — widać ją w historii „Do wystawienia”) + `zmiany`.
//   --json   wypisuje pełną treść produktu (podgląd).
//
// Stanem po założeniu zajmuje się BaseLinker — user wiąże tam ofertę (decyzja 2026-11-26).

require('../config/env');
const fs = require('fs');
const { db } = require('../pricing/db');
const allegro = require('../pricing/allegro');
const erli = require('../pricing/erli');
const em = require('../pricing/erli-model');
const wm = require('../pricing/wystawianie-model');
const { query } = require('../services/gt-sql');
const { pobierzAtrybuty } = require('../services/gt-atrybuty');
const { parsujFeed, kluczSymbolu } = require('../services/sciezka-wystawienia-model');

const KONTO = 'EKAJTEK';
const MAX_ZAPIS = 50;
const FEED_URL = process.env.SKLEP_FEED_URL || 'https://poszukiwaczefrajdy.pl/feed/googlemerchant';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const flaga = (n) => process.argv.includes(n);
const lista = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const zl = (gr) => (gr == null ? '—' : (gr / 100).toFixed(2).replace('.', ','));

// --- dane wspólne -------------------------------------------------------------------------------

async function feedSklepu() {
  try {
    const r = await fetch(FEED_URL, { signal: AbortSignal.timeout(90_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const mapa = parsujFeed(await r.text());
    if (mapa.size < 100) throw new Error(`feed podejrzanie krótki (${mapa.size})`);
    return mapa;
  } catch (e) { console.error(`! feed sklepu: ${e.message} — blokada „nie wiadomo, czy jest karta na Fenomie”`); return null; }
}

// GT: flaga sklepu, cena Specjalna, EAN, nazwa, symbol + waga i wymiary (pw_Dane).
async function daneGt(twIds) {
  const ids = [...new Set(twIds.map(Number).filter(Number.isInteger))];
  const wynik = new Map();
  if (!ids.length) return wynik;
  for (let i = 0; i < ids.length; i += 900) {
    const cz = ids.slice(i, i + 900);
    const r = await query(`SELECT t.tw_Id, t.tw_Symbol, t.tw_Nazwa, t.tw_PodstKodKresk AS ean, t.tw_SklepInternet AS sklep, c.tc_CenaBrutto3 AS cena3
        FROM tw__Towar t LEFT JOIN tw_Cena c ON c.tc_IdTowar = t.tw_Id WHERE t.tw_Id IN (${cz.join(',')})`);
    for (const w of r.recordset ?? r) {
      wynik.set(w.tw_Id, { symbol: String(w.tw_Symbol || '').trim(), nazwa: w.tw_Nazwa, ean: String(w.ean || '').trim() || null,
        sklep: !!w.sklep, cena3: w.cena3 == null ? null : Number(w.cena3) });
    }
  }
  const atr = await pobierzAtrybuty(ids);
  for (const [id, g] of wynik) {
    const a = atr.get(String(id)) || {};
    const w = wm.wagaGramy(a.waga), m = wm.wymiaryMm(a.rozbite);
    Object.assign(g, { waga: a.waga ?? null, gramy: w.g ?? null, wagaBlad: w.blad || null, wymiary: a.wymiary ?? null, wymiaryBlad: m.blad || null });
  }
  return wynik;
}

// Erli: co już jest (po externalId i po SKU) + próby w toku z pricing.db (zapis Erli jest asynchroniczny).
async function stanErli() {
  const produkty = await erli.wszystkieProdukty(['externalId', 'sku', 'status', 'archived']);
  const poId = new Map(produkty.map((p) => [String(p.externalId), p]));
  const poSku = new Map();
  for (const p of produkty) {
    if (p.archived || !p.sku) continue;
    const k = kluczSymbolu(p.sku);
    poSku.set(k, [...(poSku.get(k) || []), p]);
  }
  const wToku = new Set(db.prepare(`SELECT id_platformy FROM wystawienia WHERE platforma = 'erli'
      AND (status = 'wyslane' OR (status = 'blad' AND czas >= datetime('now', '-1 day')))`).all().map((r) => String(r.id_platformy)));
  return { produkty, poId, poSku, wToku };
}

// Aktywne oferty Allegro ekajtek z bazy repricera (sync co przebieg workera): numer oferty w `asin`.
const ofertyEkajtek = () => db.prepare(`SELECT asin AS oferta, sku, tw_id, nazwa, cena, ilosc FROM oferty
    WHERE platforma = 'allegro' AND rynek = ? AND aktywna = 1 AND asin IS NOT NULL`).all(KONTO);

// --- lista --------------------------------------------------------------------------------------

async function trybLista() {
  const limit = Number(arg('--limit') || 30), minStan = Number(arg('--min-stan') || 1);
  const [e, feed] = await Promise.all([stanErli(), feedSklepu()]);
  // Ten sam SKU bywa w kilku ofertach ekajtek (duplikaty na koncie) — na Erli jedna kopia: najstarsza oferta (najniższy numer).
  const bezKopii = ofertyEkajtek().filter((o) => !e.poId.has(String(o.oferta)) && !e.wToku.has(String(o.oferta)) && Number(o.ilosc) >= minStan)
    .sort((a, b) => (String(a.oferta).length - String(b.oferta).length) || String(a.oferta).localeCompare(String(b.oferta)));
  const bylySku = new Set();
  const oferty = bezKopii.filter((o) => { const k = kluczSymbolu(String(o.sku).split('/')[0]); if (bylySku.has(k)) return false; bylySku.add(k); return true; });
  const gt = await daneGt(oferty.map((o) => o.tw_id).filter(Boolean));
  const wiersze = oferty.map((o) => {
    const g = o.tw_id ? gt.get(o.tw_id) : null;
    const sku = kluczSymbolu(String(o.sku).split('/')[0]);
    const blokady = [];
    if (e.poSku.has(sku)) blokady.push(`na Erli jest SKU (${e.poSku.get(sku).map((p) => p.externalId).join(', ')})`);
    if (!g) blokady.push('brak dopasowania do GT');
    else {
      if (!g.sklep) blokady.push('bez flagi sklepu');
      if (!(g.cena3 > 0)) blokady.push('Specjalna = 0');
      if (!g.ean) blokady.push('brak EAN');
      if (g.wagaBlad) blokady.push('waga');
      if (g.wymiaryBlad) blokady.push('wymiary');
    }
    if (feed && g && !feed.has(kluczSymbolu(g.symbol))) blokady.push('brak karty Fenom');
    if (!feed) blokady.push('feed?');
    if (/\b(tefal|rowenta)\b/i.test(`${o.nazwa} ${g?.nazwa || ''}`)) blokady.push('Tefal/Rowenta');
    return { oferta: o.oferta, sku: g?.symbol || o.sku, nazwa: o.nazwa, cena_allegro: o.cena, cena_erli: zl(em.cenaErliGrosze(o.cena)), stan: o.ilosc, blokady };
  });
  const gotowe = wiersze.filter((w) => !w.blokady.length).sort((a, b) => b.stan - a.stan);
  const powody = {};
  for (const w of wiersze) for (const b of w.blokady) powody[b.replace(/ \(.*\)$/, '')] = (powody[b.replace(/ \(.*\)$/, '')] || 0) + 1;
  console.log(`Erli: ${e.produkty.length} produktów (${e.produkty.filter((p) => !p.archived).length} niezarchiwizowanych). Oferty ekajtek bez kopii na Erli (stan ≥ ${minStan}): ${wiersze.length}, wstępnie gotowych: ${gotowe.length}.`);
  console.log('Blokady (liczba ofert):', JSON.stringify(powody));
  console.log(`\nGotowe wstępnie (pełna ocena dopiero w podglądzie --oferty), top ${limit} wg stanu:`);
  for (const w of gotowe.slice(0, limit)) console.log(`  ${w.oferta}  ${w.sku.padEnd(16)} ${String(w.stan).padStart(3)} szt.  Allegro ${w.cena_allegro} → Erli ${w.cena_erli}  ${String(w.nazwa).slice(0, 60)}`);
  const csv = arg('--csv');
  if (csv) {
    const pola = ['oferta', 'sku', 'nazwa', 'cena_allegro', 'cena_erli', 'stan', 'blokady'];
    const q = (v) => `"${String(Array.isArray(v) ? v.join('; ') : v ?? '').replace(/"/g, '""')}"`;
    fs.writeFileSync(csv, '\uFEFF' + [pola.join(';'), ...wiersze.map((w) => pola.map((p) => q(w[p])).join(';'))].join('\r\n'));
    console.log(`\nCSV: ${csv} (${wiersze.length} wierszy)`);
  }
}

// --- podgląd / zapis ----------------------------------------------------------------------------

const sciezkiKategorii = new Map();
async function sciezkaKategorii(produktId) {
  if (!produktId) return [];
  if (sciezkiKategorii.has(produktId)) return sciezkiKategorii.get(produktId);
  const p = await allegro.api(KONTO, `/sale/products/${encodeURIComponent(produktId)}`, { query: { language: 'pl-PL' } });
  const s = (p?.category?.path || []).map((x) => x.name);
  sciezkiKategorii.set(produktId, s);
  return s;
}

async function trybOferty() {
  const zapisz = flaga('--zapisz');
  let numery = lista(arg('--oferty'));
  const symbole = lista(arg('--symbole')).map(kluczSymbolu);
  const wszystkie = ofertyEkajtek();
  if (symbole.length) {
    for (const s of symbole) {
      const tu = wszystkie.filter((o) => kluczSymbolu(String(o.sku).split('/')[0]) === s);
      if (!tu.length) console.log(`! ${s}: brak aktywnej oferty Allegro ekajtek w bazie repricera`);
      numery.push(...tu.map((o) => String(o.oferta)));
    }
  }
  numery = [...new Set(numery)];
  if (!numery.length) throw new Error('podaj --oferty albo --symbole');
  if (zapisz && numery.length > MAX_ZAPIS) throw new Error(`najwyżej ${MAX_ZAPIS} naraz`);
  const poNumerze = new Map(wszystkie.map((o) => [String(o.oferta), o]));

  const [e, feed, cennikiErli, producenci, osoby, stawkiAllegro] = await Promise.all([
    stanErli(), feedSklepu(), erli.cenniki(), erli.slownikGpsr('Producers'), erli.slownikGpsr('Persons'),
    allegro.api(KONTO, '/sale/shipping-rates').then((j) => new Map((j?.shippingRates || []).map((r) => [r.id, r.name]))),
  ]);
  const nazwyCennikowErli = new Set(cennikiErli.map((c) => c.name));
  const gt = await daneGt(numery.map((n) => poNumerze.get(n)?.tw_id).filter(Boolean));

  const wyniki = [];
  const skuTegoPrzebiegu = new Map();     // SKU → numer oferty: drugi produkt z tym samym SKU w jednym przebiegu = blokada
  for (const nr of numery) {
    let oferta;
    try { oferta = await allegro.api(KONTO, `/sale/product-offers/${encodeURIComponent(nr)}`); } catch (x) {
      console.log(`\n✖ ${nr}: nie udało się pobrać oferty Allegro: ${x.message}`); wyniki.push({ nr, status: 'blad' }); continue;
    }
    const wpis = poNumerze.get(nr);
    const g = wpis?.tw_id ? gt.get(wpis.tw_id) : null;
    const sku = kluczSymbolu(oferta?.external?.id);
    const sciezka = await sciezkaKategorii(oferta?.productSet?.[0]?.product?.id).catch(() => []);
    const nazwaCennika = stawkiAllegro.get(oferta?.delivery?.shippingRates?.id) || null;
    const cennikErli = nazwaCennika && nazwyCennikowErli.has(nazwaCennika) ? nazwaCennika : null;
    const ocena = em.ocenKandydata({
      oferta, sciezka, gt: g, wFeedzie: feed ? feed.has(kluczSymbolu(g?.symbol || sku)) : null,
      naErli: { poId: e.poId.get(nr) || (e.wToku.has(nr) ? { status: 'wysłany wcześniej, Erli jeszcze przetwarza' } : null), poSku: e.poSku.get(sku) || [] },
      cennikErli, wagaBlad: g?.wagaBlad, wymiaryBlad: g?.wymiaryBlad,
    });
    // GPSR: producent / osoba z Allegro musi być w słowniku Erli, inaczej Erli pomija odwołanie (test BARBBDS6).
    const gpsr = [];
    for (const [rodzaj, slownik, sciezkaAl, mapuj, pole] of [
      ['Producers', producenci, 'responsible-producers', em.producentErli, 'responsibleProducer'],
      ['Persons', osoby, 'responsible-persons', em.osobaErli, 'responsiblePerson']]) {
      const id = oferta?.productSet?.[0]?.[pole]?.id;
      if (!id || slownik.has(String(id))) continue;
      const a = await allegro.api(KONTO, `/sale/${sciezkaAl}/${encodeURIComponent(id)}`).catch((x) => ({ _blad: x.message }));
      const w = a?._blad ? { blad: `nie udało się pobrać z Allegro: ${a._blad}` } : mapuj(a);
      if (w.blad) ocena.blokady.push(`GPSR (${pole}): ${w.blad}`);
      else gpsr.push({ rodzaj, slownik, wpis: w.wpis });
    }
    if (sku && skuTegoPrzebiegu.has(sku)) ocena.blokady.push(`ten sam SKU co oferta ${skuTegoPrzebiegu.get(sku)} w tym przebiegu — na Erli jedna kopia`);
    else if (sku) skuTegoPrzebiegu.set(sku, nr);
    const body = em.produktZAllegro(oferta, { gramy: g?.gramy, cennikErli });
    console.log(`\n${ocena.blokady.length ? '✖' : '✔'} ${nr}  ${body.sku}  „${body.name}”`);
    console.log(`   cena Allegro ${oferta?.sellingMode?.price?.amount} → Erli ${zl(body.price)} · stan ${body.stock} · waga ${body.weight ?? '—'} g · VAT ${body.taxRate}`);
    console.log(`   kategoria ${sciezka.join(' > ') || oferta?.category?.id} · cennik „${nazwaCennika || '?'}”${cennikErli ? '' : ' (brak na Erli)'} · ${body.images.length} zdjęć · ${body.description?.sections?.length || 0} sekcji opisu · ${body.externalAttributes?.length || 0} parametrów · GPSR ${body.externalResponsibleProducer ? 'tak' : 'brak'}${gpsr.length ? ` (nowy w słowniku Erli: ${gpsr.map((g) => `${g.wpis.properName} / ${g.wpis.name}`).join(', ')})` : ''}`);
    for (const b of ocena.blokady) console.log(`   – ${b}`);
    if (flaga('--json')) console.log(JSON.stringify(body, null, 1));

    if (!zapisz) { wyniki.push({ nr, status: ocena.blokady.length ? 'zablokowana' : 'gotowa' }); continue; }
    if (ocena.blokady.length) { wyniki.push({ nr, status: 'pominieta' }); continue; }
    try {
      for (const x of gpsr) { await erli.dodajDoSlownika(x.rodzaj, x.wpis); x.slownik.set(x.wpis.idempotenceKey, x.wpis); }
    } catch (x) {
      console.log(`   → pominięta: nie udało się dodać producenta GPSR do słownika Erli: ${x.message}`);
      wyniki.push({ nr, status: 'pominieta' });
      continue;
    }
    const r = await zapiszNaErli(nr, body, g, wpis);
    console.log(`   → ${r.status}: ${r.opis}`);
    wyniki.push({ nr, ...r });
    await sleep(500);
  }
  const ile = {};
  for (const w of wyniki) ile[w.status] = (ile[w.status] || 0) + 1;
  console.log(`\nRazem: ${JSON.stringify(ile)}${zapisz ? '' : ' — PODGLĄD, nic nie zapisano (dodaj --zapisz)'}`);
  if (zapisz && (ile.wyslane || ile.widoczna)) console.log('Następny krok: powiąż nowe produkty w BaseLinkerze (stan). Erli publikuje zmiany do ~20 min.');
}

const zapiszProbe = db.prepare(`INSERT INTO wystawienia (kto, tw_id, platforma, rynek, sku, ean, produkt_id, id_platformy, cena, ilosc, status, opis, auto_po)
  VALUES (?, ?, 'erli', 'PL', ?, ?, ?, ?, ?, ?, ?, ?, 0)`);
const zapiszZmiane = db.prepare('INSERT INTO zmiany (kto, oferta_id, akcja, opis) VALUES (?, NULL, ?, ?)');

async function zapiszNaErli(nr, body, g, wpis) {
  let r;
  try {
    await erli.zalozProdukt(nr, body);
    // Zapis asynchroniczny (202) — sprawdzamy, czy produkt już jest (do ~30 s); brak = przetwarza, nie błąd.
    let p = null;
    for (let i = 0; i < 6 && !p; i++) { await sleep(5000); p = await erli.produkt(nr).catch(() => null); }
    r = p ? { status: 'wyslane', opis: `produkt ${nr} na Erli (${p.status}), ${zl(body.price)} zł × ${body.stock}` }
      : { status: 'wyslane', opis: `przyjęty (202), Erli jeszcze przetwarza — sprawdź w panelu za kilka minut` };
  } catch (x) {
    if (x.status === 409) r = { status: 'odrzucone', opis: `Erli: produkt ${nr} już istnieje` };
    else if (x.status >= 400 && x.status < 500) r = { status: 'odrzucone', opis: x.message };
    else r = { status: 'blad', opis: `nie wiadomo, czy produkt powstał — sprawdź w panelu Erli (${nr}): ${x.message}` };
  }
  const kto = process.env.ERLI_KTO || 'agent:erli-wystaw';
  zapiszProbe.run(kto, g ? wpis.tw_id : (wpis?.tw_id || 0), body.sku || '', body.ean, nr, nr, body.price / 100, body.stock, r.status, r.opis);
  zapiszZmiane.run(kto, r.status === 'wyslane' ? 'wystawienie' : 'wystawienie_odrzucone', `erli PL ${body.sku}: ${zl(body.price)} × ${body.stock} — ${r.opis}`);
  return r;
}

(async () => {
  if (!erli.skonfigurowany()) throw new Error('brak ERLI_API_KEY — uruchom na SRV z C:\\was');
  if (flaga('--lista')) await trybLista();
  else await trybOferty();
  process.exit(0);
})().catch((x) => { console.error(`BŁĄD: ${x.message}`); process.exit(1); });
