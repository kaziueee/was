'use strict';

// Strategie cenowe — zapis i odczyt z pricing.db (tabele `strategie`, `strategie_towarow`) oraz dane, których
// strategie potrzebują z GT (sprzedaż z FS dla „za rynkiem”, stan dla końca wyprzedaży). Logika i walidacja:
// pricing/strategie.js. Korzystają: worker (pas do decyzji, koniec przypisań) i trasa /api/ceny/strategie.

const { db } = require('./db');
const { KOLUMNY } = require('./kolumny');
const s = require('./strategie');
const { kolumnaZrodla } = require('./pulpit-model');
const { sprzedazTowarowZCena } = require('../services/gt-sprzedaz');
const { pobierzStanyGt, sumaRazem } = require('../services/gt-produkty');
const { doZlozeniaMapa } = require('../services/gt-zestawy');
const { dzienLokalny } = require('./pulpit-model');

const zWiersza = (r) => (r ? { ...r, aktywna: !!r.aktywna, parametry: JSON.parse(r.parametry) } : null);
const loguj = db.prepare('INSERT INTO zmiany (kto, oferta_id, akcja, opis) VALUES (?, NULL, ?, ?)');

function lista() {
  return db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM strategie_towarow t WHERE t.strategia_id = s.id) AS towarow
                       FROM strategie s ORDER BY s.nazwa`).all().map(zWiersza)
    .map((x) => ({ ...x, opis: s.opisParametrow(x) }));
}
const pobierz = (id) => zWiersza(db.prepare('SELECT * FROM strategie WHERE id = ?').get(Number(id)));
const ileTowarow = (id) => db.prepare('SELECT COUNT(*) AS n FROM strategie_towarow WHERE strategia_id = ?').get(Number(id)).n;

// Nowa albo zmieniona (id). wej już po walidujStrategie. Zwraca zapisaną strategię.
function zapisz(id, wej, kto) {
  const juz = db.prepare('SELECT id FROM strategie WHERE nazwa = ? AND id IS NOT ?').get(wej.nazwa, id ?? null);
  if (juz) throw Object.assign(new Error(`strategia „${wej.nazwa}” już jest — wybierz inną nazwę`), { status: 400 });
  if (id == null) {
    const r = db.prepare('INSERT INTO strategie (nazwa, typ, parametry, aktywna, kto) VALUES (?, ?, ?, 0, ?)')
      .run(wej.nazwa, wej.typ, JSON.stringify(wej.parametry), kto || null);
    loguj.run(kto || null, 'strategia_nowa', `${wej.nazwa}: ${s.opisParametrow(wej)} (podgląd)`);
    return pobierz(r.lastInsertRowid);
  }
  const byla = pobierz(id);
  if (!byla) throw Object.assign(new Error('nie ma takiej strategii'), { status: 404 });
  db.prepare('UPDATE strategie SET nazwa = ?, typ = ?, parametry = ?, zmieniona = CURRENT_TIMESTAMP WHERE id = ?')
    .run(wej.nazwa, wej.typ, JSON.stringify(wej.parametry), Number(id));
  loguj.run(kto || null, 'strategia_zmiana', `${byla.nazwa}: ${s.opisParametrow(byla)} → ${wej.nazwa}: ${s.opisParametrow(wej)}`);
  return pobierz(id);
}

function ustawStatus(id, aktywna, kto) {
  const x = pobierz(id);
  if (!x) throw Object.assign(new Error('nie ma takiej strategii'), { status: 404 });
  if (x.aktywna === !!aktywna) return x;
  db.prepare('UPDATE strategie SET aktywna = ?, zmieniona = CURRENT_TIMESTAMP WHERE id = ?').run(aktywna ? 1 : 0, x.id);
  loguj.run(kto || null, aktywna ? 'strategia_aktywna' : 'strategia_podglad', `${x.nazwa} (${ileTowarow(x.id)} towarów)`);
  return pobierz(id);
}

function usun(id, kto) {
  const x = pobierz(id);
  if (!x) throw Object.assign(new Error('nie ma takiej strategii'), { status: 404 });
  const n = ileTowarow(id);
  if (n) throw Object.assign(new Error(`strategia ma ${n} przypisanych towarów — najpierw je zdejmij`), { status: 400 });
  db.prepare('DELETE FROM strategie WHERE id = ?').run(x.id);
  loguj.run(kto || null, 'strategia_usun', x.nazwa);
}

// Przypisanie hurtem: towary = [{ tw_id, symbol }]. Towar z inną strategią przechodzi na tę (jeden towar = jedna).
function przypisz(strategia, towary, doDnia, kto) {
  const byla = db.prepare('SELECT t.strategia_id, s.nazwa FROM strategie_towarow t JOIN strategie s ON s.id = t.strategia_id WHERE t.tw_id = ?');
  const zapis = db.prepare(`INSERT INTO strategie_towarow (tw_id, strategia_id, symbol_gt, do, kto) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (tw_id) DO UPDATE SET strategia_id = excluded.strategia_id, symbol_gt = excluded.symbol_gt, do = excluded.do,
      kto = excluded.kto, czas = CURRENT_TIMESTAMP`);
  const wynik = { przypisane: 0, zmienione: [] };
  db.exec('BEGIN');
  try {
    for (const t of towary) {
      const b = byla.get(t.tw_id);
      if (b && b.strategia_id !== strategia.id) wynik.zmienione.push({ symbol: t.symbol, z: b.nazwa });
      zapis.run(t.tw_id, strategia.id, t.symbol || null, doDnia || null, kto || null);
      loguj.run(kto || null, 'strategia_przypisz', `${t.symbol}: ${b ? `${b.nazwa} → ` : ''}${strategia.nazwa}${doDnia ? ` do ${doDnia}` : ''}`);
      wynik.przypisane++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return wynik;
}

// Zdjęcie przypisań — towar wraca na domyślną „All marża 20”. akcja: 'strategia_zdejmij' (człowiek) albo
// 'strategia_koniec' (worker: minęła data / wyprzedane).
function zdejmij(twIds, kto, { akcja = 'strategia_zdejmij', powod = null } = {}) {
  const wiersz = db.prepare('SELECT t.tw_id, t.symbol_gt, s.nazwa FROM strategie_towarow t JOIN strategie s ON s.id = t.strategia_id WHERE t.tw_id = ?');
  const usunWiersz = db.prepare('DELETE FROM strategie_towarow WHERE tw_id = ?');
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const id of twIds) {
      const w = wiersz.get(Number(id));
      if (!w) continue;
      usunWiersz.run(w.tw_id);
      loguj.run(kto || null, akcja, `${w.symbol_gt || w.tw_id}: ${w.nazwa} → ${s.DOMYSLNA.nazwa}${typeof powod === 'function' ? ` (${powod(w.tw_id)})` : powod ? ` (${powod})` : ''}`);
      n++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return n;
}

// Przypisania z ich strategiami: Map(tw_id → { tw_id, symbol_gt, do, kto, czas, strategia }).
function przypisania({ twIds = null, strategiaId = null } = {}) {
  const wiersze = db.prepare(`SELECT t.*, s.nazwa, s.typ, s.parametry, s.aktywna FROM strategie_towarow t JOIN strategie s ON s.id = t.strategia_id
                               ${strategiaId != null ? 'WHERE t.strategia_id = ?' : ''}`).all(...(strategiaId != null ? [Number(strategiaId)] : []));
  const filtr = twIds ? new Set(twIds.map(Number)) : null;
  const m = new Map();
  for (const w of wiersze) {
    if (filtr && !filtr.has(w.tw_id)) continue;
    m.set(w.tw_id, { tw_id: w.tw_id, symbol_gt: w.symbol_gt, do: w.do, kto: w.kto, czas: w.czas,
      strategia: { id: w.strategia_id, nazwa: w.nazwa, typ: w.typ, parametry: JSON.parse(w.parametry), aktywna: !!w.aktywna } });
  }
  return m;
}

// --- Dane z GT ---------------------------------------------------------------------------------------------
// Waluta FS → waluta kolumny (pricing/kolumny.js). Sprzedaż w innej walucie niż kanał (Allegro CZ/SK/HU: ceny
// przelicza Allegro z ceny PL) nie jest dowodem ceny tego kanału — pomijamy (docs/strategie-cenowe.md).
const WALUTY_FS = { EUR: '€', PLN: 'zł', RON: 'RON', HUF: 'Ft' };
const KLUCZE = new Set(KOLUMNY.map((k) => k.klucz));
const WALUTA_KOLUMNY = Object.fromEntries(KOLUMNY.map((k) => [k.klucz, k.waluta]));

// Sprzedaż per towar i kanał: Map(tw_id → { KOLUMNA: { pozycje: [{ cena, szt }] } }). Pamięć per towar
// (`maxWiekMs`), a gdy GT nie odpowiada — ostatnia znana (podłoga „za rynkiem” nie spada przez awarię GT).
const pamiecSprzedazy = new Map();   // `${tw}|${dni}` → { czas, dane }
async function sprzedazTowarow(twIds, dni, { maxWiekMs = 3 * 3600e3 } = {}) {
  const klucz = (tw) => `${tw}|${dni}`;
  const wynik = new Map();
  const doPobrania = [];
  for (const tw of twIds) {
    const p = pamiecSprzedazy.get(klucz(tw));
    if (p && Date.now() - p.czas < maxWiekMs) wynik.set(tw, p.dane);
    else doPobrania.push(tw);
  }
  if (!doPobrania.length) return wynik;
  const od = new Date(Date.now() - dni * 24 * 3600e3);
  try {
    const wiersze = await sprzedazTowarowZCena(doPobrania, dzienLokalny(od));
    const nowe = new Map(doPobrania.map((tw) => [tw, {}]));
    for (const w of wiersze) {
      const k = kolumnaZrodla(w.zrodlo, w.waluta, KLUCZE, w.kategoria);
      if (!KLUCZE.has(k) || WALUTY_FS[String(w.waluta).toUpperCase()] !== WALUTA_KOLUMNY[k]) continue;
      const d = nowe.get(w.tw_id);
      if (!d) continue;
      (d[k] ||= { pozycje: [] }).pozycje.push({ cena: w.cena, szt: w.szt });
    }
    for (const [tw, dane] of nowe) { pamiecSprzedazy.set(klucz(tw), { czas: Date.now(), dane }); wynik.set(tw, dane); }
  } catch (e) {
    console.error(new Date().toISOString(), '[strategie] sprzedaż z GT:', e.message);
    for (const tw of doPobrania) { const p = pamiecSprzedazy.get(klucz(tw)); if (p) wynik.set(tw, p.dane); }
  }
  return wynik;
}

// Stan Razem z GT (K4+K4G+MAG+LS, bez BRK); zestaw — ile da się złożyć ze składników (jak ekran Ceny, stanyGt
// w routes/ceny.js). GT nie odpowiada → pusta mapa (koniec wyprzedaży po stanie czeka do następnego razu).
async function stanyRazem(twIds) {
  if (!twIds.length) return new Map();
  try {
    const [m, zestawy] = await Promise.all([pobierzStanyGt(twIds), doZlozeniaMapa(twIds)]);
    const w = new Map();
    for (const id of twIds) {
      const st = m.get(String(id));
      const z = zestawy.get(Number(id));
      if (zestawy.has(Number(id)) && z != null) w.set(Number(id), z);
      else if (st) w.set(Number(id), sumaRazem(st));
    }
    return w;
  } catch (e) {
    console.error(new Date().toISOString(), '[strategie] stany z GT:', e.message);
    return new Map();
  }
}

// Strategie dla pasów (pricing/pas.js pasyHurtem): Map(tw_id → strategia z danymi sprzedaży). Bez przypisań, które
// się skończyły — te wracają w `zakonczone` ({ tw_id, powod }), żeby wywołujący je zdjął (worker) albo pokazał.
// tylkoAktywne — worker (automat używa tylko aktywnych); podgląd bierze też strategie w trybie podglądu.
// Koniec sprawdzamy dla WSZYSTKICH przypisań (także towarów, których w tym przebiegu nie ma — np. bez stanu),
// strategie do pasów tylko dla `twIds` (null = wszystkie).
async function strategieDlaPasow(twIds, { tylkoAktywne = true, teraz = new Date(), przyp = null } = {}) {
  const wszystkie = przyp || przypisania();
  const filtr = twIds ? new Set(twIds.map(Number)) : null;
  const dzis = dzienLokalny(new Date(teraz));
  const wyprzedaze = [...wszystkie.values()].filter((p) => p.strategia.typ === 'wyprzedaz').map((p) => p.tw_id);
  const stany = await stanyRazem(wyprzedaze);
  const zakonczone = [];
  const poTw = new Map();
  for (const p of wszystkie.values()) {
    const k = s.koniecPrzypisania(p, p.strategia, { dzis, stanRazem: stany.get(p.tw_id) ?? null });
    if (k.koniec) { zakonczone.push({ tw_id: p.tw_id, symbol: p.symbol_gt, powod: k.powod }); continue; }
    if ((tylkoAktywne && !p.strategia.aktywna) || (filtr && !filtr.has(p.tw_id))) continue;
    poTw.set(p.tw_id, { ...p.strategia, do: p.do });
  }
  // „Za rynkiem”: sprzedaż z FS, osobno dla każdego okna (różne strategie mogą mieć różne `dni`).
  const poDniach = new Map();
  for (const [tw, st] of poTw) if (st.typ === 'za_rynkiem') (poDniach.get(st.parametry.dni) || poDniach.set(st.parametry.dni, []).get(st.parametry.dni)).push(tw);
  for (const [dni, tws] of poDniach) {
    const sp = await sprzedazTowarow(tws, dni);
    for (const tw of tws) poTw.set(tw, { ...poTw.get(tw), sprzedaz: sp.get(tw) || {} });
  }
  return { poTw, zakonczone, stany };
}

// Strategia jednego towaru: { przypisanie, aktywna } — przypisanie do pokazania (także w podglądzie), aktywna =
// strategia z danymi do pasa (null, gdy brak, podgląd albo przypisanie już się skończyło).
async function strategiaTowaru(twId) {
  const p = przypisania({ twIds: [twId] });
  if (!p.size) return { przypisanie: null, aktywna: null };
  const { poTw } = await strategieDlaPasow([twId], { przyp: p });
  return { przypisanie: p.get(Number(twId)), aktywna: poTw.get(Number(twId)) || null };
}

module.exports = { strategiaTowaru, lista, pobierz, zapisz, ustawStatus, usun, przypisz, zdejmij, przypisania, sprzedazTowarow, stanyRazem, strategieDlaPasow, ileTowarow };
