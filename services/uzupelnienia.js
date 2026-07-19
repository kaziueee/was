'use strict';

// Lista "Uzupelnienia K4" - towary, ktore maja stan na K4 Gora (mag 8), a na
// K4 (mag 4) skonczyla sie dostepnosc (stan - rezerwacja <= 0). Replika
// zestawienia Subiekta, plus rozbicie rezerwacji na kanaly wysylki (zob.
// services/kanaly.js), liczone z otwartych zamowien klienta (ZK, dok_Typ=16,
// dok_Status=7) na K4.
//
// Uwaga - magazyny: K4 = mag 4 (mag 5/ZW swiadomie pomijamy, decyzja uzytkownika);
// K4 Gora = mag 8. Wszystko z bazy, ktora WMS juz czyta (services/gt-sql.js).

const { query, naCzesci } = require('./gt-sql');
const db = require('../db/database');
const { kanalZK } = require('./kanaly');
const { bezAdnotacjiStref } = require('./gt-fields');

const MAG_K4 = 4;
const MAG_GORA = 8;
const STATUS_ZK_OTWARTE = 7; // 8 = zrealizowane/zamkniete; 7 = otwarte (tworzy rezerwacje)

// Rozbicie rezerwacji na kanaly dla listy towarow. Zwraca Map<tw_Id, {kanal: ilosc}>
// (tylko niezerowe). Pozycje otwartych ZK na K4 grupowane po kanale wyliczonym
// w Node (kanalZK) - dlatego nie da sie tego zrobic czystym SQL.
async function rozbicieKanalow(towIds) {
  const wynik = new Map();
  await Promise.all(naCzesci(towIds, 1000).map(async (paczka) => {
    const parametry = { k4: MAG_K4, typ: 16, status: STATUS_ZK_OTWARTE };
    const placeholders = paczka.map((id, i) => {
      parametry[`t${i}`] = id;
      return `@t${i}`;
    }).join(', ');

    const { recordset } = await query(`
      SELECT o.ob_TowId, o.ob_Ilosc,
        z.dok_NrPelnyOryg AS oryg, z.dok_Uwagi AS uwagi,
        p.pwd_Tekst01 AS zrodlo, p.pwd_Tekst03 AS dostawa
      FROM dok_Pozycja o
      JOIN dok__Dokument z ON z.dok_Id = o.ob_DokHanId
      LEFT JOIN vwPolaWlasne_Dokument p ON p.dok_Id = z.dok_Id
      WHERE z.dok_Typ = @typ AND z.dok_Status = @status
        AND o.ob_MagId = @k4 AND o.ob_TowId IN (${placeholders})
    `, parametry);

    for (const r of recordset) {
      const kanal = kanalZK(r);
      if (!wynik.has(r.ob_TowId)) wynik.set(r.ob_TowId, {});
      const m = wynik.get(r.ob_TowId);
      m[kanal] = (m[kanal] || 0) + r.ob_Ilosc;
    }
  }));
  return wynik;
}

// Pelna lista uzupelnien z rozbiciem na kanaly. Rzuca, gdy baza GT niedostepna.
async function pobierzUzupelnienia() {
  // Lista: towar ma stan na gorze (mag 8) <> 0 ORAZ brak dostepnosci na K4
  // (stan - rezerwacja <= 0). Sort wg rezerwacji malejaco (jak w zestawieniu).
  const { recordset: lista } = await query(`
    SELECT t.tw_Id, t.tw_Symbol, t.tw_Nazwa, t.tw_Pole1, t.tw_Pole8,
      COALESCE(k4.stan, 0) AS stan_k4,
      COALESCE(k4.rez, 0)  AS rez_k4,
      gora.stan AS stan_gora
    FROM tw__Towar t
    JOIN (
      SELECT st_TowId, SUM(st_Stan) AS stan
      FROM tw_Stan WHERE st_MagId = @gora
      GROUP BY st_TowId HAVING SUM(st_Stan) <> 0
    ) gora ON gora.st_TowId = t.tw_Id
    LEFT JOIN (
      SELECT st_TowId, SUM(st_Stan) AS stan, SUM(st_StanRez) AS rez
      FROM tw_Stan WHERE st_MagId = @k4
      GROUP BY st_TowId
    ) k4 ON k4.st_TowId = t.tw_Id
    WHERE COALESCE(k4.stan, 0) - COALESCE(k4.rez, 0) <= 0
    ORDER BY COALESCE(k4.rez, 0) DESC, t.tw_Symbol
  `, { gora: MAG_GORA, k4: MAG_K4 });

  if (lista.length === 0) return [];

  const ids = lista.map((r) => String(r.tw_Id));
  const [kanaly, wms] = await Promise.all([
    rozbicieKanalow(lista.map((r) => r.tw_Id)),
    Promise.resolve(pobierzLokalizacjeWms(ids)),
  ]);

  return lista.map((r) => {
    const rozbicie = kanaly.get(r.tw_Id) || {};
    const lok = wms.get(String(r.tw_Id)) || { k4: null, k4g: [] };
    return {
      artykul_gt_id: String(r.tw_Id),
      symbol: r.tw_Symbol,
      nazwa: r.tw_Nazwa,
      // BEZ dopisku stref: Zebra podaje to dalej jako `lok_cel_kod` MM (public/zebra/
      // uzupelnienia.js), wiec musi byc samym kodem - "M2-J14-P2 +Z3" nie rozwiaze sie
      // na zadna lokalizacje.
      lokalizacja_k4: bezAdnotacjiStref(r.tw_Pole1) || null,   // tekst z GT (Miejsce na magazynie)
      lokalizacja_gora: r.tw_Pole8 || null,  // tekst z GT (Lokalizacja Gorna)
      stan_k4: r.stan_k4,
      stan_gora: r.stan_gora,
      rezerwacje: r.rez_k4,
      dostepnosc: r.stan_k4 - r.rez_k4,
      kanaly: rozbicie,                                          // { kanal: ilosc } niezerowe
      rozbicie_suma: Object.values(rozbicie).reduce((s, v) => s + v, 0),
      wms_k4: lok.k4,        // cel MM: { lokalizacja_id, kod, ilosc } albo null
      wms_k4g: lok.k4g,      // zrodla MM: [{ lokalizacja_id, kod, ilosc }] malejaco wg stanu
    };
  });
}

// Lokalizacje WMS (SQLite) dla listy artykulow: cel K4 (1 SKU = 1 lok) i zrodla
// K4G (1 SKU = N lok, ze stanem > 0). Daje id lokalizacji potrzebne do MM
// (/api/ruchy/mm: lok_zrodlo_id + lok_cel_id). Zwraca Map<artykul_gt_id, {k4, k4g}>.
function pobierzLokalizacjeWms(ids) {
  const wynik = new Map(ids.map((id) => [id, { k4: null, k4g: [] }]));
  if (ids.length === 0) return wynik;

  const placeholders = ids.map(() => '?').join(', ');
  // K4 = cel MM: bierzemy NIEZALEZNIE od stanu (cel jest pusty - po to uzupelniamy).
  // K4G = zrodlo MM: tylko ze stanem > 0 (jest co zdjac).
  const wiersze = db.prepare(`
    SELECT s.artykul_gt_id, s.lokalizacja_id, l.kod, l.magazyn, s.ilosc
    FROM stany_lokalizacji s
    JOIN lokalizacje l ON l.id = s.lokalizacja_id
    WHERE s.artykul_gt_id IN (${placeholders})
      AND (l.magazyn = 'K4' OR (l.magazyn = 'K4G' AND s.ilosc > 0))
  `).all(...ids);

  for (const w of wiersze) {
    const wpis = wynik.get(w.artykul_gt_id);
    if (!wpis) continue;
    const lok = { lokalizacja_id: w.lokalizacja_id, kod: w.kod, ilosc: w.ilosc };
    if (w.magazyn === 'K4') {
      // K4 = 1 SKU = 1 lokalizacja; gdyby bylo wiecej, bierzemy o najwiekszym stanie
      if (!wpis.k4 || lok.ilosc > wpis.k4.ilosc) wpis.k4 = lok;
    } else if (w.magazyn === 'K4G') {
      wpis.k4g.push(lok);
    }
  }
  for (const wpis of wynik.values()) {
    wpis.k4g.sort((a, b) => b.ilosc - a.ilosc);
  }
  return wynik;
}

module.exports = { pobierzUzupelnienia };
