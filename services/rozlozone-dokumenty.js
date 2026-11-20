'use strict';

// Ile z KONKRETNEGO dokumentu GT (PZ dostawy/zwrotu, PW, MM przywozki) WMS juz rozlozyl -
// suma wlasnych ruchow z puli podpisanych tym dokumentem.
//
// Dokument rozpoznajemy po dok_Id (ruchy.zrodlo_dok_id), a numer (ruchy.zrodlo_dok) zostaje
// zapisem historycznym i kluczem zapasowym dla starych ruchow bez id.
//
// Dlaczego nie sam numer (incydent Intek, 2026-11-18): zmiana daty faktury zakupu w Subiekcie
// PRZENUMEROWALA jej PZ - dok_Id zostal, numer nie (PZ 3954/2026 -> PZ 4099/2026, PZ 3790/2026
// -> PZ 4108/2026). Rozlozenia podpisane starym numerem przestaly pasowac, wiec obie dostawy
// wrocily jako calkiem nierozlozone: fałszywe "+StD95" w tw_Pole1 na 21 towarach i wiersze
// "Rozloz" dla towaru, ktory od dwoch tygodni lezal na polkach.
//
// Ruch z id liczy sie WYLACZNIE po id. Numer bierzemy tylko dla ruchow bez id - inaczej
// zwolniony stary numer, gdyby GT nadal go innemu dokumentowi, podpinalby cudze rozlozenia.
//
// Osobny plik, bo bierze `db` z parametru - testowalne na bazie w pamieci (test/rozlozone-dokumenty.test.js).
function iloscRozlozona(db, artykulGtId, magazyn, dokNr, dokId = null) {
  const id = dokId == null || dokId === '' ? null : Number(dokId);
  if (!dokNr && id == null) return 0;

  const r = id != null
    ? db.prepare(`
        SELECT COALESCE(SUM(ilosc), 0) AS suma FROM ruchy
        WHERE artykul_gt_id = ? AND mag_zrodlo_pula = ? AND status != 'blad'
          AND (zrodlo_dok_id = ? OR (zrodlo_dok_id IS NULL AND zrodlo_dok = ?))
      `).get(String(artykulGtId), magazyn, id, dokNr == null ? null : String(dokNr))
    : db.prepare(`
        SELECT COALESCE(SUM(ilosc), 0) AS suma FROM ruchy
        WHERE artykul_gt_id = ? AND mag_zrodlo_pula = ? AND status != 'blad' AND zrodlo_dok = ?
      `).get(String(artykulGtId), magazyn, String(dokNr));
  return Number(r.suma) || 0;
}

module.exports = { iloscRozlozona };
