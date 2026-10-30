'use strict';

// Sprzedaż → Stan (desktop, tylko admin): analiza stanu towaru — leżaki, nadmiar, wolna rotacja, OK, kończy się, brak.
// Kubełki i progi: services/stan-towaru-model.js (decyzje usera 2026-10-30). Tu tylko dane z db/sprzedaz.db:
//   stan  — ostatnie zdjęcie stanów (nocne bierze wszystkie towary ze stanem, bieżące co 5 min — sprzedawane), z wartością
//           w cenie zakupu (stany.wartosc, średnia dostaw na magazynach Razem),
//   sprzedaż — FS z K4 + paragony Sklepu + zużycie składników w sprzedanych zestawach (z półki schodzą składniki).
// Zestawy pomijamy: nie mają własnego stanu, leżą składniki — i to one są w analizie.
// Liczy wątek analiz (zasada 7 — ~13 tys. towarów i agregat po całej historii sprzedaży), wynik w tabeli `gotowe`,
// API tylko go podaje. Odświeżane raz na godzinę i przy zmianie dnia.

const zlib = require('zlib');
const { db, meta } = require('../db/sprzedaz');
const am = require('./analiza-model');
const sm = require('./stan-towaru-model');
const { dzisLokalnie } = require('./sprzedaz-model');

const KLUCZ = 'stan-towaru';
const ODSWIEZ_CO_MS = 60 * 60 * 1000;
const R1 = (x) => Math.round((x || 0) * 10) / 10;

function policz(dzis = dzisLokalnie()) {
  const D = (n) => am.dodajDni(dzis, -n);
  // Ostatnie zdjęcie każdego towaru — ale nie starsze niż ostatnie nocne: nocne zdejmuje WSZYSTKIE towary ze stanem, więc
  // towar, którego w nim nie ma, stanu już nie ma (wiersz sprzed tygodnia ze stanem 5 by kłamał).
  const nocny = meta.get('nocny')?.wartosc || db.prepare('SELECT MAX(dzien) d FROM stany').get().d || dzis;
  const stany = new Map();
  for (const s of db.prepare(`SELECT s.* FROM stany s WHERE s.dzien >= ? AND s.dzien = (SELECT MAX(dzien) FROM stany x WHERE x.tw_id = s.tw_id)`).all(nocny)) {
    stany.set(s.tw_id, s);
  }
  // Sprzedaż per towar: wszystkie statusy zamówień to sprzedaż (ZK bez FS > 14 dni job już usuwa); data = zamówienia.
  const sprzedaz = new Map();
  for (const x of db.prepare(`SELECT tw_id,
      SUM(CASE WHEN d > @d30 THEN szt ELSE 0 END) s30, SUM(CASE WHEN d > @d90 THEN szt ELSE 0 END) s90,
      SUM(CASE WHEN d > @d365 THEN szt ELSE 0 END) s365, SUM(CASE WHEN d > @d365 AND sklep THEN szt ELSE 0 END) sklep365,
      MAX(d) ost
    FROM (SELECT x.tw_id, x.szt, z.data_zam d, z.status = 'paragon' sklep
            FROM (SELECT tw_id, zam_id, szt FROM pozycje UNION ALL SELECT tw_id, zam_id, szt FROM skladniki) x
            JOIN zamowienia z ON z.id = x.zam_id WHERE z.data_zam <= @dzis)
    GROUP BY tw_id`).all({ d30: D(30), d90: D(90), d365: D(365), dzis })) sprzedaz.set(x.tw_id, x);

  const kartoteka = new Map(db.prepare('SELECT tw_id, symbol, nazwa, grupa, rodzaj, pierwsze_przyjecie pp FROM towary').all().map((k) => [k.tw_id, k]));
  const ids = new Set([...stany.keys(), ...[...sprzedaz.values()].filter((x) => x.s30 > 0).map((x) => x.tw_id)]);
  const wiersze = [];
  for (const id of ids) {
    const k = kartoteka.get(id) || {};
    if (k.rodzaj === 8) continue;
    const s = stany.get(id) || {}, x = sprzedaz.get(id) || {};
    const razem = s.razem || 0, dostepne = s.dostepne ?? Math.max(0, razem - (s.rez || 0));
    const o = sm.ocenTowar({ dostepne, razem, szt30: x.s30 || 0, szt90: x.s90 || 0, szt365: x.s365 || 0, ostatnia: x.ost || null, pierwszePrzyjecie: k.pp, dzis });
    if (!o) continue;
    wiersze.push({
      id, sym: k.symbol || String(id), nazwa: k.nazwa || '', grupa: k.grupa || '', pp: k.pp || null,
      k4: s.k4 || 0, k4g: s.k4g || 0, mag: s.mag || 0, ls: s.ls || 0, razem, rez: s.rez || 0, dost: dostepne,
      wart: Math.round(s.wartosc || 0), s30: x.s30 || 0, s90: x.s90 || 0, s365: x.s365 || 0, sklep365: x.sklep365 || 0,
      ost: x.ost || null, t30: R1(o.tempo * 30), dni: o.dni, kub: o.kub, sila: o.sila,
    });
  }
  wiersze.sort((a, b) => b.wart - a.wart);
  const historiaOd = db.prepare('SELECT MIN(data_zam) d FROM zamowienia').get().d;
  return { dzis, stanyZ: nocny, historiaOd, progi: sm.PROGI, kubelki: sm.KUBELKI, sily: sm.SILY, sumy: sm.podsumuj(wiersze), wiersze };
}

// --- gotowy wynik (wątek analiz liczy, API podaje) — jak Trendy -------------------------------------------------
const gotowe = ({ gz = false } = {}) => db.prepare(`SELECT ${gz ? 'gz' : 'json'} dane, dzien, czas FROM gotowe WHERE klucz = ?`).get(KLUCZ) || null;

function odswiez(dzis = dzisLokalnie()) {
  const t0 = Date.now();
  const json = JSON.stringify(policz(dzis)), gz = zlib.gzipSync(json, { level: 6 });
  db.prepare(`INSERT INTO gotowe (klucz, json, gz, dzien, czas) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(klucz) DO UPDATE SET json = excluded.json, gz = excluded.gz, dzien = excluded.dzien, czas = excluded.czas`).run(KLUCZ, json, gz, dzis);
  return { ms: Date.now() - t0, kb: Math.round(json.length / 1024), gzKb: Math.round(gz.length / 1024) };
}

// wymus — po nocnym zdjęciu stanów (nowe wartości, towary, które zeszły do zera)
function odswiezJesliTrzeba(teraz = new Date(), { wymus = false } = {}) {
  const dzis = dzisLokalnie(teraz), g = db.prepare('SELECT dzien, czas FROM gotowe WHERE klucz = ?').get(KLUCZ);
  const wiek = g ? teraz.getTime() - new Date(g.czas.replace(' ', 'T') + 'Z').getTime() : Infinity;
  if (!wymus && g && g.dzien === dzis && wiek < ODSWIEZ_CO_MS) return null;
  return odswiez(dzis);
}

module.exports = { policz, odswiez, odswiezJesliTrzeba, gotowe };
