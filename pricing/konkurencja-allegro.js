'use strict';

// Ceny konkurencji na Allegro z Niezbędnika (pricing/niezbednik.js) — tylko dla ofert Z AUTOMATEM (decyzja usera
// 2026-10-19: cały katalog to ~5000 ofert, pakiet sprawdzeń by tego nie uniósł; szanse na resztę katalogu daje
// raport „Czynniki Top oferty”, pricing/allegro-top.js). Ustalenia z panelu Niezbędnika (user, 19.10.2026):
//   - przy ofercie: jak często sprawdzamy (co 1/2/3/4 h, domyślnie 4 h) i o ile przebijamy (remis, 1 gr, kwota;
//     domyślnie 1 gr) — kolumny oferty `konk_co_h`, `konk_przebicie`
//   - sprawdzamy tylko w oknie dnia (PRICING_NSP_OKNO, domyślnie 7–23 czasu polskiego) — w nocy bez sensu
//   - z kim konkurujemy: tylko oferty Smart i nowe (filtr wyszukiwania w Niezbędniku), bez naszych kont, bez
//     stanu < 3, bez sprzedaży (popularność 0) i bez kont prywatnych; wysyłka z PL — nie sprawdzamy
//   - konkurent pod naszym minimum: przebijamy najtańszego, którego DA SIĘ przebić nad minimum (wariant C);
//     gdy pod minimum są wszyscy — stoimy na minimum (model, reguła 7)
// Jedno sprawdzenie na EAN obsługuje obie nasze oferty (ekajtek i NaTropie mają często ten sam towar).
// Czyste funkcje na górze (testy w test/pricing-konkurencja-allegro.test.js), baza i API niżej.

const FILTRY = { has_smart: true, condition: 'new' };
const CO_H = [1, 2, 3, 4];
const DOMYSLNE = { co_h: 4, przebicie: 0.01, minStan: 3 };
const TOLERANCJA_MIN = 20;   // przebieg co 30 min — bez zapasu „co 1 h” wypadałoby co 1,5 h
const PRZEBICIE_MAX = 100;   // zł — więcej to raczej literówka niż strategia

const okno = () => {
  const m = String(process.env.PRICING_NSP_OKNO || '7-23').match(/^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/);
  return m && Number(m[1]) < Number(m[2]) && Number(m[2]) <= 24 ? [Number(m[1]), Number(m[2])] : [7, 23];
};
const limitDzienny = () => (Number(process.env.PRICING_NSP_DZIENNIE) > 0 ? Number(process.env.PRICING_NSP_DZIENNIE) : 500);
// Jak długo wynik sprawdzenia jest dla repricera prawdziwy — dłużej niż noc bez sprawdzeń, krócej niż doba.
const waznoscH = () => (Number(process.env.PRICING_NSP_WAZNOSC_H) > 0 ? Number(process.env.PRICING_NSP_WAZNOSC_H) : 12);

const dobryEan = (e) => /^(\d{8}|\d{12,14})$/.test(String(e || '').trim());
const coH = (v) => (CO_H.includes(Number(v)) ? Number(v) : DOMYSLNE.co_h);
const przebicie = (v) => (v != null && Number(v) >= 0 && Number(v) <= PRZEBICIE_MAX ? Number(v) : DOMYSLNE.przebicie);
const zBazy = (s) => (s ? Date.parse(String(s).replace(' ', 'T') + 'Z') : NaN);
const doBazy = (t) => new Date(t).toISOString().slice(0, 19).replace('T', ' ');
const godzinaPL = (t) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Warsaw', hour: '2-digit', hourCycle: 'h23' }).format(new Date(t)));
const dzienPL = (t) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw' }).format(new Date(t));
const wOknie = (t, [od, doH] = okno()) => { const h = godzinaPL(t); return h >= od && h < doH; };
const kwota = (m) => { if (m?.amount == null || m.amount === '') return null; const n = Number(m.amount); return Number.isFinite(n) ? n : null; };

// Oferta z wyniku Niezbędnika → to, czego używamy (i co trzymamy w bazie).
const zWyniku = (x) => ({ oferta: x.offer_id, sprzedawca: x.seller_id, login: x.seller_login, cena: kwota(x.price),
  dostawa: kwota(x.delivery_price), stan: x.stock ?? null, popularnosc: x.popularity ?? null, firma: x.is_company ?? null,
  ss: x.is_superseller ?? null, nazwa: x.name || null });

// Konkurenci po filtrach, rosnąco po cenie towaru. `nasze` — konta z pricing/allegro.js KONTA (numer i login).
function konkurenci(oferty, nasze, { minStan = DOMYSLNE.minStan } = {}) {
  const pomin = { nasze: 0, stan: 0, sprzedaz: 0, prywatne: 0 };
  const lista = [], naszeOferty = [];
  for (const c of oferty || []) {
    if (!(c.cena > 0)) continue;
    if (nasze.has(String(c.sprzedawca)) || nasze.has(String(c.login || '').toLowerCase())) { pomin.nasze++; naszeOferty.push(c); continue; }
    if (c.stan != null && c.stan < minStan) { pomin.stan++; continue; }
    if (c.popularnosc === 0) { pomin.sprzedaz++; continue; }
    if (c.firma === false) { pomin.prywatne++; continue; }
    lista.push(c);
  }
  lista.sort((a, b) => a.cena - b.cena);
  return { lista, pomin, nasze: naszeOferty };
}

// Obserwacja z wyniku Niezbędnika — w kształcie pricing/model.js. Ceny TOWARU (bez dostawy): filtr Smart
// zostawia oferty z darmową dostawą dla klienta Smart, a raport Top ofert Allegro też porównuje cenę towaru.
// `konkurenci` (ceny rosnąco) zostają w obserwacji — cel pod minimum wybiera doModelu(), gdy znamy pas.
function zNiezbednika(wpis, cena, nasze, teraz = Date.now(), wazH = waznoscH()) {
  if (!wpis || wpis.blad || !(cena > 0) || !(teraz - zBazy(wpis.czas) <= wazH * 3_600_000)) return null;
  let oferty;
  try { oferty = JSON.parse(wpis.oferty || '[]'); } catch { return null; }
  const k = konkurenci(oferty, nasze);
  const ceny = k.lista.map((c) => c.cena);
  const naj = ceny.length ? ceny[0] : null;
  const nasz = naj == null || cena <= naj + 0.005;
  return { cena, wysylka: 0, bbNasz: nasz, bbInnaNasza: false, bbCena: nasz ? cena : naj, bbFba: false, najtanszaInna: naj,
    konkurencjaNiedostepna: false, ofert: ceny.length, konkurenci: ceny, zrodlo: 'niezbednik', czas: wpis.czas };
}

// Obserwacja dla modelu przy znanym minimum i przebiciu (wariant C): celem jest najtańszy konkurent, którego da się
// przebić nad minimum; tańszych od niego (pod naszym minimum) nie gonimy. Bez listy konkurentów — bez zmian.
function doModelu(ob, min, krok) {
  if (!ob || !Array.isArray(ob.konkurenci)) return ob;
  const k = ob.konkurenci;
  if (!k.length) return { ...ob, bbNasz: true, bbCena: ob.cena, najtanszaInna: null, podMin: 0 };
  const i = min > 0 ? k.findIndex((c) => c - krok >= min - 0.005) : 0;
  if (i < 0) return { ...ob, bbNasz: false, bbCena: k[0], najtanszaInna: k[0], podMin: k.length };
  const cel = k[i];
  const nasz = ob.cena <= cel - krok + 0.005;
  return { ...ob, bbNasz: nasz, bbCena: nasz ? ob.cena : cel, najtanszaInna: cel, podMin: i };
}

// Które EAN-y sprawdzić teraz: oferty z automatem [{ ean, co_h }], ostatnie: Map(ean → { czas, zlecono }).
// Najdawniej sprawdzane pierwsze; poza oknem dnia — nic.
function doSprawdzenia(oferty, ostatnie, teraz = Date.now(), { limit = Infinity, oknoH = okno() } = {}) {
  if (!wOknie(teraz, oknoH) || !(limit > 0)) return [];
  const poEan = new Map();
  for (const o of oferty) {
    const ean = String(o.ean || '').trim();
    if (dobryEan(ean)) poEan.set(ean, Math.min(poEan.get(ean) ?? Infinity, coH(o.co_h)));
  }
  const due = [];
  for (const [ean, h] of poEan) {
    const w = ostatnie.get(ean);
    const ost = Math.max(zBazy(w?.czas) || 0, zBazy(w?.zlecono) || 0);
    if (!ost || teraz - ost >= h * 3_600_000 - TOLERANCJA_MIN * 60_000) due.push({ ean, ost });
  }
  return due.sort((a, b) => a.ost - b.ost).slice(0, limit).map((d) => d.ean);
}

// Pod kartę i komórkę: najtańsi konkurenci, pominięci, nasze oferty w wynikach.
function podsumowanie(wpis, nasze, teraz = Date.now()) {
  if (!wpis) return null;
  let oferty = [];
  try { oferty = JSON.parse(wpis.oferty || '[]'); } catch { /* uszkodzony wiersz — jak brak wyniku */ }
  const k = konkurenci(oferty, nasze);
  return { czas: wpis.czas, zlecono: wpis.zlecono || null, blad: wpis.blad || null, aktualny: teraz - zBazy(wpis.czas) <= waznoscH() * 3_600_000,
    wszystkich: wpis.wszystkich ?? oferty.length, lista: k.lista.slice(0, 8), konkurentow: k.lista.length, pomin: k.pomin,
    nasze: k.nasze.map((c) => ({ oferta: c.oferta, login: c.login, cena: c.cena })) };
}

// --- baza i API -------------------------------------------------------------------------------------

const naszeKonta = () => {
  const { KONTA } = require('./allegro');
  return new Set(Object.values(KONTA).flatMap((k) => [String(k.id), String(k.login).toLowerCase()]));
};

function wyniki() {
  const { db } = require('./db');
  return new Map(db.prepare('SELECT * FROM allegro_konkurencja').all().map((r) => [r.ean, r]));
}

// EAN-y towarów z automatem na Allegro — z GT (tw_PodstKodKresk), do kolumny oferty.ean.
async function odswiezEan(oferty) {
  const { db } = require('./db');
  const { query } = require('../services/gt-sql');
  const tw = [...new Set(oferty.map((o) => o.tw_id).filter(Boolean))];
  const ean = new Map();
  for (let i = 0; i < tw.length; i += 500) {
    const r = await query(`SELECT tw_Id, tw_PodstKodKresk FROM tw__Towar WHERE tw_Id IN (${tw.slice(i, i + 500).map(Number).join(',')})`);
    for (const x of r.recordset) ean.set(x.tw_Id, String(x.tw_PodstKodKresk || '').trim() || null);
  }
  const zapisz = db.prepare('UPDATE oferty SET ean = ? WHERE id = ?');
  for (const o of oferty) {
    if (!ean.has(o.tw_id)) continue;
    const e = ean.get(o.tw_id);
    if (e !== o.ean) { zapisz.run(e, o.id); o.ean = e; }
  }
  return oferty;
}

// Odbiór zleconego raportu (stan `nsp_raport`). czekajMs > 0 — czekamy na koniec, ile się da.
async function odbierz({ czekajMs = 0 } = {}) {
  const { db, stan } = require('./db');
  const nsp = require('./niezbednik');
  const s = stan.get('nsp_raport');
  if (!s?.wartosc) return null;
  const zlec = JSON.parse(s.wartosc);
  const koniec = Date.now() + czekajMs;
  let r = await nsp.raport(zlec.id);
  while (!r.gotowy && Date.now() < koniec) {
    await new Promise((ok) => setTimeout(ok, 10_000));
    r = await nsp.raport(zlec.id);
  }
  if (!r.gotowy) {
    // Raport, który nie skończył się w 2 h, porzucamy — EAN-y wrócą do kolejki przy następnym przebiegu.
    if (Date.now() - zBazy(s.czas) > 2 * 3_600_000) { stan.set('nsp_raport', ''); stan.set('blad_niezbednik', `raport ${zlec.id} nie skończył się w 2 h — porzucony`); }
    return { id: zlec.id, status: r.status, gotowy: false };
  }
  const zapisz = db.prepare(`INSERT INTO allegro_konkurencja (ean, czas, oferty, wszystkich, blad, raport, zlecono)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (ean) DO UPDATE SET czas = excluded.czas, oferty = excluded.oferty, wszystkich = excluded.wszystkich,
      blad = excluded.blad, raport = excluded.raport`);
  const bladTylko = db.prepare('UPDATE allegro_konkurencja SET blad = ?, raport = ? WHERE ean = ?');
  let ok = 0, bledy = 0;
  db.exec('BEGIN');
  try {
    for (const it of r.items) {
      if (it.status === 'completed' && it.result) {
        const czas = it.result.checked_at || it.checked_at;
        zapisz.run(it.ean, czas ? doBazy(Date.parse(czas)) : doBazy(Date.now()), JSON.stringify((it.result.offers || []).map(zWyniku)),
          it.result.total ?? null, null, zlec.id, doBazy(zBazy(s.czas) || Date.now()));
        ok++;
      } else {
        // Nieudana pozycja: poprzedni wynik zostaje (stary, ale prawdziwy), dopisujemy tylko błąd.
        bladTylko.run(it.error?.message || it.status, zlec.id, it.ean);
        bledy++;
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  stan.set('nsp_raport', '');
  stan.set('nsp_ostatni', JSON.stringify({ id: zlec.id, eanow: zlec.eans.length, ok, bledy, koszt: r.cost?.charged ?? null }));
  return { id: zlec.id, status: r.status, gotowy: true, ok, bledy, koszt: r.cost?.charged ?? null };
}

// Zlecenie raportu dla EAN-ów, którym minął czas (oferty z automatem, okno dnia, limit dzienny).
async function zlec(oferty, teraz = Date.now()) {
  const { db, stan } = require('./db');
  const nsp = require('./niezbednik');
  if (stan.get('nsp_raport')?.wartosc) return { pominiete: 'poprzedni raport jeszcze trwa' };
  const dzien = dzienPL(teraz);
  const zuzycie = JSON.parse(stan.get('nsp_dzis')?.wartosc || '{}');
  const dzis = zuzycie.dzien === dzien ? zuzycie.n : 0;
  const ostatnie = wyniki();
  const eans = doSprawdzenia(oferty.map((o) => ({ ean: o.ean, co_h: o.konk_co_h })), ostatnie, teraz, { limit: limitDzienny() - dzis });
  if (!eans.length) return { eanow: 0, dzis };
  const z = await nsp.zlecRaport(eans, FILTRY);
  stan.set('nsp_raport', JSON.stringify({ id: z.id, eans }));
  stan.set('nsp_dzis', JSON.stringify({ dzien, n: dzis + eans.length }));
  // `zlecono` od razu — także dla EAN-ów bez wcześniejszego wyniku; raport, który padnie, nie zleci się w kółko.
  const ozn = db.prepare(`INSERT INTO allegro_konkurencja (ean, zlecono) VALUES (?, ?) ON CONFLICT (ean) DO UPDATE SET zlecono = excluded.zlecono`);
  db.exec('BEGIN');
  try { for (const e of eans) ozn.run(e, doBazy(teraz)); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  try { stan.set('nsp_pakiet', JSON.stringify(await nsp.pakiet())); } catch { /* stan pakietu to tylko informacja na ekran */ }
  return { id: z.id, eanow: eans.length, dzis: dzis + eans.length };
}

module.exports = { FILTRY, CO_H, DOMYSLNE, PRZEBICIE_MAX, okno, waznoscH, dobryEan, coH, przebicie, godzinaPL, wOknie, zWyniku,
  konkurenci, zNiezbednika, doModelu, doSprawdzenia, podsumowanie, naszeKonta, wyniki, odswiezEan, odbierz, zlec };
