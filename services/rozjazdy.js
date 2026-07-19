'use strict';

// Job detekcji rozjazdow GT vs WMS - zob. CLAUDE.md "Obsluga rozjazdow":
//   GT > WMS       -> ekran "do zlokalizowania" (live, routes/lokalizacje.js, deficyt_k4g)
//   GT < WMS w K4  -> auto-korekta (1 SKU = 1 lokalizacja - sprowadzamy ilosc do stanu GT)
//   GT < WMS w K4G -> wpis do tabeli rozjazdy (status='nowy') - magazynier decyduje
//                     z ktorej lokalizacji odjac, zob. routes/rozjazdy.js (POST /:id/resolve)
//
// Uruchamiane co godzine (start()) oraz na zadanie przez POST /api/rozjazdy/detekcja.

const db = require('../db/database');
const { pobierzStanyGt } = require('./gt-produkty');
const audyt = require('./audyt');

// K4 = pick floor z zywa sprzedaza (Sellasist zbija stan GT bez wiedzy WMS), wiec kopia WMS
// szybko sie starzeje. Job scala WMS do GT - im czesciej, tym mniejsze okno rozjazdu na K4.
// Domyslnie 10 min; nadpisywalne w .env przez ROZJAZDY_INTERWAL_MIN (minuty).
function interwalZKonfiguracji() {
  const min = Number(process.env.ROZJAZDY_INTERWAL_MIN);
  return Number.isFinite(min) && min > 0 ? min * 60 * 1000 : 10 * 60 * 1000;
}
const DOMYSLNY_INTERWAL_MS = interwalZKonfiguracji();

// suma ilosci WMS per (artykul, magazyn) dla K4/K4G - tylko artykuly z zapasem > 0
function sumyWms() {
  return db.prepare(`
    SELECT s.artykul_gt_id, s.artykul_symbol, l.magazyn, SUM(s.ilosc) AS ilosc_wms
    FROM stany_lokalizacji s
    JOIN lokalizacje l ON l.id = s.lokalizacja_id
    WHERE l.magazyn IN ('K4', 'K4G')
    GROUP BY s.artykul_gt_id, l.magazyn
    HAVING SUM(s.ilosc) > 0
  `).all();
}

// artykuly z otwartym ('nowy') rozjazdem K4G, ktorych nie obejmuje juz sumyWms()
// (np. cala ilosc w K4G zostala wyzerowana inna operacja od czasu detekcji) -
// traktujemy jak ilosc_wms = 0, wiec roznica = ilosc_gt - 0 >= 0 -> do wyjasnienia
function osieroconeRozjazdyK4G(pokryteArtykuly) {
  const wszystkie = db.prepare(
    "SELECT DISTINCT artykul_gt_id FROM rozjazdy WHERE magazyn = 'K4G' AND status = 'nowy'"
  ).all();
  return wszystkie.filter((w) => !pokryteArtykuly.has(w.artykul_gt_id));
}

// auto-korekta K4: 1 SKU = 1 lokalizacja - sprowadza ilosc na tej lokalizacji do stanu GT.
// Zwraca opis korekty albo null, jesli stan WMS w K4 jest niejednoznaczny (0 albo >1 lokalizacji
// z zapasem > 0) - taki przypadek narusza zasade "1 SKU = 1 lokalizacja" i wymaga recznej naprawy,
// wiec nie auto-korygujemy.
function autoKorektaK4(artykulGtId, iloscGt) {
  const wiersze = db.prepare(`
    SELECT s.id, s.ilosc, l.kod
    FROM stany_lokalizacji s
    JOIN lokalizacje l ON l.id = s.lokalizacja_id
    WHERE s.artykul_gt_id = ? AND l.magazyn = 'K4' AND s.ilosc > 0
  `).all(artykulGtId);

  if (wiersze.length !== 1) return null;

  const [wiersz] = wiersze;
  const nowaIlosc = Math.max(0, iloscGt);
  db.prepare('UPDATE stany_lokalizacji SET ilosc = ?, ostatnia_zmiana = CURRENT_TIMESTAMP, operator = ? WHERE id = ?')
    .run(nowaIlosc, 'system:rozjazdy', wiersz.id);

  // Zwracamy LICZBY, nie sam opis: wpis do logu ma pokazac "99 -> 74", a nie kazac
  // czytelnikowi parsowac zdanie.
  return {
    opis: `Auto-korekta K4 ${wiersz.kod}: ${wiersz.ilosc} -> ${nowaIlosc} szt. (wg stanu GT)`,
    kod: wiersz.kod,
    przed: wiersz.ilosc,
    po: nowaIlosc,
  };
}

// zapisuje nowy albo aktualizuje istniejacy otwarty ('nowy') rozjazd K4G dla artykulu.
// Zwraca true, jesli powstal nowy rekord.
function zapiszRozjazdK4G({ artykul_gt_id, artykul_symbol, ilosc_gt, ilosc_wms, roznica }) {
  const istniejacy = db.prepare(
    "SELECT id FROM rozjazdy WHERE artykul_gt_id = ? AND magazyn = 'K4G' AND status = 'nowy'"
  ).get(artykul_gt_id);

  if (istniejacy) {
    db.prepare(`
      UPDATE rozjazdy SET artykul_symbol = ?, ilosc_gt = ?, ilosc_wms = ?, roznica = ?, wykryty = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(artykul_symbol, ilosc_gt, ilosc_wms, roznica, istniejacy.id);
    return false;
  }

  db.prepare(`
    INSERT INTO rozjazdy (artykul_gt_id, artykul_symbol, magazyn, ilosc_gt, ilosc_wms, roznica, status)
    VALUES (?, ?, 'K4G', ?, ?, ?, 'nowy')
  `).run(artykul_gt_id, artykul_symbol, ilosc_gt, ilosc_wms, roznica);
  return true;
}

// oznacza otwarty ('nowy') rozjazd K4G jako wyjasniony, bo roznica przestala byc ujemna
// (np. kolejny ruch uzupelnil WMS albo GT). Zwraca true, jesli faktycznie cos zaktualizowano.
function wyjasnijRozjazdK4G(artykulGtId, iloscGt, iloscWms) {
  const wynik = db.prepare(`
    UPDATE rozjazdy SET status = 'wyjasniony', wyjasniony = CURRENT_TIMESTAMP,
      ilosc_gt = ?, ilosc_wms = ?, roznica = ?,
      opis = 'Auto: roznica ustapila przed reczna decyzja (stan GT >= suma WMS przy kolejnej detekcji)'
    WHERE artykul_gt_id = ? AND magazyn = 'K4G' AND status = 'nowy'
  `).run(iloscGt, iloscWms, iloscGt - iloscWms, artykulGtId);
  return wynik.changes > 0;
}

async function wykonajDetekcjeRozjazdow() {
  const wiersze = sumyWms();
  const pokryteArtykulyK4G = new Set(wiersze.filter((w) => w.magazyn === 'K4G').map((w) => w.artykul_gt_id));
  const osierocone = osieroconeRozjazdyK4G(pokryteArtykulyK4G);

  const idy = [...new Set([...wiersze.map((w) => w.artykul_gt_id), ...osierocone.map((w) => w.artykul_gt_id)])];
  const stanyMap = idy.length > 0 ? await pobierzStanyGt(idy) : new Map();

  let korektyK4 = 0;
  let nowychK4G = 0;
  let zaktualizowanychK4G = 0;
  let wyjasnionychK4G = 0;

  for (const wiersz of wiersze) {
    const stanyGt = stanyMap.get(String(wiersz.artykul_gt_id));
    const iloscGt = stanyGt?.[wiersz.magazyn]?.ilosc ?? 0;
    const roznica = iloscGt - wiersz.ilosc_wms;

    if (wiersz.magazyn === 'K4') {
      if (roznica < 0) {
        const korekta = autoKorektaK4(wiersz.artykul_gt_id, iloscGt);
        if (korekta) {
          korektyK4++;
          db.prepare(`
            INSERT INTO rozjazdy (artykul_gt_id, artykul_symbol, magazyn, ilosc_gt, ilosc_wms, roznica, status, opis, wyjasniony)
            VALUES (?, ?, 'K4', ?, ?, ?, 'wyjasniony', ?, CURRENT_TIMESTAMP)
          `).run(wiersz.artykul_gt_id, wiersz.artykul_symbol, iloscGt, wiersz.ilosc_wms, roznica, korekta.opis);

          // Wpis do LOGU ZMIAN (audyt). Rozjazd zostaje 'wyjasniony' - korekta jest normalnym
          // oddechem systemu (sprzedaz w Subiekcie zbija stan bez wiedzy WMS), wiec nie ma po
          // co otwierac zadania. Ale sama korekta ma byc DO OBEJRZENIA: to jedyne miejsce,
          // gdzie widac, ze kopia polki byla zawyzona i o ile. Wlasna akcja = wlasna pozycja
          // w filtrze logu, wiec da sie wyklikac same korekty automatu.
          audyt.zapisz({
            uzytkownik: 'system:rozjazdy',
            akcja: 'korekta_auto',
            artykul_gt_id: wiersz.artykul_gt_id,
            artykul_symbol: wiersz.artykul_symbol,
            magazyn: 'K4',
            lokalizacja: korekta.kod,
            ilosc: korekta.przed - korekta.po,     // o ile zawyzona byla kopia
            wynik: 'skorygowano',
            przed: { ilosc: korekta.przed },
            po: { ilosc: korekta.po },
          });
        }
      }
      continue;
    }

    // K4G
    if (roznica < 0) {
      const nowy = zapiszRozjazdK4G({ ...wiersz, ilosc_gt: iloscGt, roznica });
      if (nowy) nowychK4G++; else zaktualizowanychK4G++;
    } else if (wyjasnijRozjazdK4G(wiersz.artykul_gt_id, iloscGt, wiersz.ilosc_wms)) {
      wyjasnionychK4G++;
    }
  }

  for (const { artykul_gt_id } of osierocone) {
    const stanyGt = stanyMap.get(String(artykul_gt_id));
    const iloscGt = stanyGt?.K4G?.ilosc ?? 0;
    if (wyjasnijRozjazdK4G(artykul_gt_id, iloscGt, 0)) wyjasnionychK4G++;
  }

  return {
    sprawdzone: wiersze.length,
    korekty_k4: korektyK4,
    rozjazdy_k4g_nowe: nowychK4G,
    rozjazdy_k4g_zaktualizowane: zaktualizowanychK4G,
    rozjazdy_k4g_wyjasnione: wyjasnionychK4G,
  };
}

// Uruchamia job w tle co interwalMs. Timer.unref(), zeby nie blokowal zamkniecia procesu.
function start(interwalMs = DOMYSLNY_INTERWAL_MS) {
  const timer = setInterval(() => {
    wykonajDetekcjeRozjazdow().catch((err) => console.error('[rozjazdy]', err.message));
  }, interwalMs);
  timer.unref?.();
  return timer;
}

module.exports = { wykonajDetekcjeRozjazdow, start };
