'use strict';

// Dane pulpitu repricera z pricing.db — same zapytania; liczby składa pricing/pulpit-model.js (czyste, z testami).
// Czyta WMS (trasa GET /api/ceny/pulpit), nic tu nie pisze do bazy.
//
// Stan w chwili T to jedno zapytanie po indeksach (ostatni odcinek obserwacji i ostatnia decyzja ≤ T każdej
// oferty, ~10–50 ms na 18 tys. ofert), więc trend liczymy z historii, bez osobnego snapshotu. Dzień zamknięty się
// nie zmienia — trzymamy go w pamięci procesu (klucz: dzień + lista ofert z automatem, bo od niej zależą liczby
// „z automatem”); po restarcie WMS liczy się od nowa.

const crypto = require('crypto');
const { db } = require('./db');
const { kluczKolumny } = require('./kolumny');
const m = require('./pulpit-model');

const SQL_NA_CHWILE = `
  SELECT o.id, o.tw_id, o.platforma, o.rynek, o.ilosc, o.auto, o.aktywna, b.bb_nasz, COALESCE(b.widziana, b.czas) AS w,
         CASE WHEN o.auto = 1 THEN (SELECT CASE WHEN d.wyslano = 1 THEN d.zysk_nowa ELSE d.zysk END FROM decyzje d
                WHERE d.oferta_id = o.id AND d.czas <= ? ORDER BY d.czas DESC, d.id DESC LIMIT 1) END AS zysk
    FROM oferty o
    JOIN obserwacje b ON b.id = (SELECT id FROM obserwacje WHERE oferta_id = o.id AND czas <= ? ORDER BY czas DESC, id DESC LIMIT 1)
   WHERE o.tw_id IS NOT NULL`;

// Wiersze stanu w chwili T. `auto` z listy ofert z automatem DZIŚ (kohorta) — nie z tabeli, żeby wszystkie chwile
// liczyły się dla tej samej listy co „teraz”.
function wierszeNaChwile(T, kohorta) {
  const t = m.doBazy(T);
  return db.prepare(SQL_NA_CHWILE).all(t, t).map((o) => ({ ...o, kolumna: kluczKolumny(o.platforma, o.rynek), auto: kohorta.has(o.id) ? 1 : 0 }));
}

// „Teraz” liczymy na ofertach z macierzy (pokazane: aktywne, ze stanem, jedna na towar i kanał) — kafel pokazuje
// wtedy tyle samo Buy Boxów, co macierz po kliknięciu.
function stanTeraz(teraz, pokazane, kohorta) {
  const ids = new Set(pokazane.map((o) => o.id));
  const wiersze = wierszeNaChwile(teraz, kohorta);
  return { stan: m.stanNaChwile(wiersze.filter((o) => ids.has(o.id)), teraz, { bezSwiezosci: true }), wiersze };
}

const pamiecDni = new Map();
const PAMIEC_MAX = 200;
function stanyDni(dni, teraz, kohorta, stanDzis) {
  const podpis = crypto.createHash('md5').update([...kohorta].sort((a, b) => a - b).join(',')).digest('hex');
  const wynik = new Map();
  for (const d of dni) {
    if (!d.zamkniety) { wynik.set(d.dzien, m.liczbyStanu(stanDzis)); continue; }
    const klucz = `${d.dzien}|${podpis}`;
    let s = pamiecDni.get(klucz);
    if (!s) {
      s = m.liczbyStanu(m.stanNaChwile(wierszeNaChwile(d.koniec, kohorta), d.koniec));
      pamiecDni.set(klucz, s);
      if (pamiecDni.size > PAMIEC_MAX) pamiecDni.delete(pamiecDni.keys().next().value);
    }
    wynik.set(d.dzien, s);
  }
  return wynik;
}

// Wysłane i odrzucone decyzje z ostatnich 7 dni + czas pierwszej obserwacji z wysłaną ceną (po indeksie
// (oferta_id, czas), pierwsza pasująca — LIMIT 1, bez przeglądania całej historii oferty).
const SQL_WYSYLKI = `
  SELECT d.oferta_id, o.platforma, o.rynek, o.sku, d.czas, d.cena_przed, d.cena_nowa, d.kod, d.wyslano, d.blad,
         CASE WHEN d.wyslano = 1 THEN (SELECT b.czas FROM obserwacje b WHERE b.oferta_id = d.oferta_id AND b.czas > d.czas
              AND ${m.sqlCenaPotwierdzona('b.cena', 'd.cena_nowa', 'd.cena_przed')} ORDER BY b.czas LIMIT 1) END AS potw
    FROM decyzje d JOIN oferty o ON o.id = d.oferta_id
   WHERE d.czas >= ? AND (d.wyslano = 1 OR d.blad IS NOT NULL)`;
function wysylki(teraz) {
  return db.prepare(SQL_WYSYLKI).all(m.doBazy(new Date(teraz).getTime() - 7 * 24 * 3600e3))
    .map((w) => ({ ...w, kolumna: kluczKolumny(w.platforma, w.rynek) }));
}

// Oferty z automatem DZIŚ — wszystkie, także bez stanu (w przeszłości mogły go mieć i liczyć się do trendu).
function kohortaAutomatu() {
  const ids = new Set(), twPoKanale = new Map();
  for (const o of db.prepare('SELECT id, tw_id, platforma, rynek FROM oferty WHERE auto = 1 AND tw_id IS NOT NULL').all()) {
    ids.add(o.id);
    const k = kluczKolumny(o.platforma, o.rynek);
    (twPoKanale.get(k) || twPoKanale.set(k, new Set()).get(k)).add(o.tw_id);
  }
  return { ids, twPoKanale };
}

// Od kiedy kanał jest obserwowany (pierwsza obserwacja którejkolwiek oferty) — pulpit mówi wtedy „7 dni temu:
// brak danych, obserwacja od 13.10” zamiast samego „—”. Po indeksie: najstarszy wiersz każdej oferty. Zmienia się
// tylko, gdy dochodzi nowy kanał, więc wystarczy raz na godzinę.
let poczatki = null;
function poczatkiObserwacji() {
  if (poczatki && Date.now() - poczatki.czas < 3600e3) return poczatki.m;
  const m = new Map();
  for (const o of db.prepare(`SELECT o.platforma, o.rynek, (SELECT MIN(czas) FROM obserwacje WHERE oferta_id = o.id) AS od FROM oferty o`).all()) {
    if (!o.od) continue;
    const k = kluczKolumny(o.platforma, o.rynek);
    if (!(m.get(k) <= o.od)) m.set(k, o.od);
  }
  poczatki = { m, czas: Date.now() };
  return m;
}

const stanWorkera = () => Object.fromEntries(db.prepare('SELECT klucz, wartosc, czas FROM stan').all().map((s) => [s.klucz, { wartosc: s.wartosc, czas: s.czas }]));

module.exports = { wierszeNaChwile, stanTeraz, stanyDni, wysylki, kohortaAutomatu, poczatkiObserwacji, stanWorkera };
