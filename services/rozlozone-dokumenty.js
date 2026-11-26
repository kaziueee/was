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

// Dzien (lokalny, 'YYYY-MM-DD') PIERWSZEGO rozlozenia z dokumentu albo null, gdy nic jeszcze
// nie rozlozono. Ten sam klucz co iloscRozlozona (id, a numer tylko dla ruchow bez id).
// Granica dla wydan do sklepu (rozbicie-stanu: wydaneZPalety): MM z K4 do MAG/LS do tego dnia
// wlacznie wyszedl z palety, pozniejszy - z polki. data_ruchu jest w UTC (CURRENT_TIMESTAMP),
// a dok_DataWyst w GT to dzien lokalny, wiec przeliczamy na kalendarz magazynu.
function dzienLokalny(utc) {
  const d = new Date(String(utc).replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
}

function pierwszeRozlozenie(db, artykulGtId, magazyn, dokNr, dokId = null) {
  const id = dokId == null || dokId === '' ? null : Number(dokId);
  if (!dokNr && id == null) return null;

  const r = id != null
    ? db.prepare(`
        SELECT MIN(data_ruchu) AS pierwszy FROM ruchy
        WHERE artykul_gt_id = ? AND mag_zrodlo_pula = ? AND status != 'blad'
          AND (zrodlo_dok_id = ? OR (zrodlo_dok_id IS NULL AND zrodlo_dok = ?))
      `).get(String(artykulGtId), magazyn, id, dokNr == null ? null : String(dokNr))
    : db.prepare(`
        SELECT MIN(data_ruchu) AS pierwszy FROM ruchy
        WHERE artykul_gt_id = ? AND mag_zrodlo_pula = ? AND status != 'blad' AND zrodlo_dok = ?
      `).get(String(artykulGtId), magazyn, String(dokNr));
  return r?.pierwszy ? dzienLokalny(r.pierwszy) : null;
}

module.exports = { iloscRozlozona, pierwszeRozlozenie, dzienLokalny };
