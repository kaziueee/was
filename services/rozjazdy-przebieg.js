'use strict';

// Czesc ZAPISUJACA joba rozjazdow (services/rozjazdy.js): na gotowych sumach WMS i stanach GT
// robi auto-korekty K4 i prowadzi rozjazdy K4G - WSZYSTKO W JEDNEJ TRANSAKCJI.
//
// Dlaczego jedna transakcja (2026-10-27): kazda korekta K4 to trzy zapisy (UPDATE polki, INSERT
// rozjazdu, wpis audytu), a kazdy osobny zapis to osobny commit z flushem WAL na dysk. Na SRV
// (C: na kontrolerze RAID bez cache zapisu) commit kosztuje ~20-30 ms, wiec korekta ~70 ms
// glownego watku - przy 41 korektach w przebiegu Zebry staly 2,9 s co 10 minut (logs/petla-*.log,
// sekunda 2 cyklu). Ten sam przebieg na kopii bazy w jednej transakcji: kilkadziesiat ms.
// Przy okazji polka, rozjazd i wpis audytu zapisuja sie razem albo wcale; blad w polowie
// wycofuje caly przebieg, a nastepny (za 10 min) liczy wszystko od nowa.
//
// Osobny plik, bo bierze `db` z parametru - da sie go testowac na bazie w pamieci, bez
// db/wms.db i bez GT (test/rozjazdy-przebieg.test.js).

// auto-korekta K4: 1 SKU = 1 lokalizacja - sprowadza ilosc na tej lokalizacji do stanu GT.
// Zwraca opis korekty albo null, jesli stan WMS w K4 jest niejednoznaczny (0 albo >1 lokalizacji
// z zapasem > 0) - taki przypadek narusza zasade "1 SKU = 1 lokalizacja" i wymaga recznej naprawy,
// wiec nie auto-korygujemy.
function autoKorektaK4(db, artykulGtId, iloscGt) {
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
function zapiszRozjazdK4G(db, { artykul_gt_id, artykul_symbol, ilosc_gt, ilosc_wms, roznica }) {
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
function wyjasnijRozjazdK4G(db, artykulGtId, iloscGt, iloscWms) {
  const wynik = db.prepare(`
    UPDATE rozjazdy SET status = 'wyjasniony', wyjasniony = CURRENT_TIMESTAMP,
      ilosc_gt = ?, ilosc_wms = ?, roznica = ?,
      opis = 'Auto: roznica ustapila przed reczna decyzja (stan GT >= suma WMS przy kolejnej detekcji)'
    WHERE artykul_gt_id = ? AND magazyn = 'K4G' AND status = 'nowy'
  `).run(iloscGt, iloscWms, iloscGt - iloscWms, artykulGtId);
  return wynik.changes > 0;
}

function zastosujBezTransakcji(db, { wiersze, osierocone, stanyMap, zapiszAudyt }) {
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
        const korekta = autoKorektaK4(db, wiersz.artykul_gt_id, iloscGt);
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
          zapiszAudyt({
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
      const nowy = zapiszRozjazdK4G(db, { ...wiersz, ilosc_gt: iloscGt, roznica });
      if (nowy) nowychK4G++; else zaktualizowanychK4G++;
    } else if (wyjasnijRozjazdK4G(db, wiersz.artykul_gt_id, iloscGt, wiersz.ilosc_wms)) {
      wyjasnionychK4G++;
    }
  }

  for (const { artykul_gt_id } of osierocone) {
    const stanyGt = stanyMap.get(String(artykul_gt_id));
    const iloscGt = stanyGt?.K4G?.ilosc ?? 0;
    if (wyjasnijRozjazdK4G(db, artykul_gt_id, iloscGt, 0)) wyjasnionychK4G++;
  }

  return {
    sprawdzone: wiersze.length,
    korekty_k4: korektyK4,
    rozjazdy_k4g_nowe: nowychK4G,
    rozjazdy_k4g_zaktualizowane: zaktualizowanychK4G,
    rozjazdy_k4g_wyjasnione: wyjasnionychK4G,
  };
}

// zapiszAudyt MUSI pisac tym samym polaczeniem co `db` (services/audyt.js pisze globalnym
// db/database - tym samym, ktore dostaje job), inaczej wpis audytu wyszedlby poza transakcje.
function zastosujPrzebieg(db, dane) {
  db.exec('BEGIN');
  try {
    const wynik = zastosujBezTransakcji(db, dane);
    db.exec('COMMIT');
    return wynik;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Jedna linia do logs/rozjazdy-*.log na przebieg: ile czekalismy na GT (async, Zebr nie blokuje),
// ile trwala synchroniczna czesc (to jest przestoj glownego watku) i co zrobiono.
function opisPrzebiegu(wynik, { sumy_ms, gt_ms, zapis_ms }) {
  return `sprawdzone ${wynik.sprawdzone}, korekty K4 ${wynik.korekty_k4}, K4G nowe ${wynik.rozjazdy_k4g_nowe}`
    + ` / zaktualizowane ${wynik.rozjazdy_k4g_zaktualizowane} / wyjasnione ${wynik.rozjazdy_k4g_wyjasnione}`
    + ` | sumy WMS ${Math.round(sumy_ms)} ms, GT ${Math.round(gt_ms)} ms, zapis ${Math.round(zapis_ms)} ms`;
}

module.exports = { zastosujPrzebieg, opisPrzebiegu };
