'use strict';

// Sprzedaz z faktur (FS, dok_Typ=2) w GT - na potrzeby zakladki "Zadanie sprzedazowe".
// FS liczymy, bo ~99,7% z nich powstaje z ZK (Sellasist), czyli to sprzedaz internetowa;
// paragony (PA, stanowiska 1/2) i korekty (KFS) swiadomie pomijamy (decyzja usera 2026-10-06).
// Pozycje FS wisza pod ob_DokHanId (dokument handlowy), nie ob_DokMagId.
// dok_Status=1 = zatwierdzony (0 = bufor, kilka sztuk na 90 dni - nie liczymy).
// Tylko FS z magazynu K4 (dok_MagId, decyzja usera 2026-10-06) - to ~99,8% sztuk; reszta to
// pojedyncze FS z MAG. Magazyn FS = magazyn jej WZ (sprawdzone na 30 dniach OKITRADE).

const { query } = require('./gt-sql');
const { MAGAZYN_GT_ID } = require('../config/magazyny');

// Zwraca Map<tw_Id jako string, [{ dzien: 'YYYY-MM-DD', szt }]> od daty `od` wlacznie.
async function sprzedazDziennaFs(twIds, od) {
  const wynik = new Map();
  const idy = [...new Set(twIds.map(Number))].filter(Number.isInteger);
  if (!idy.length) return wynik;
  // idy to liczby calkowite (filtr wyzej), wiec wklejenie do IN jest bezpieczne
  const r = await query(`
    SELECT p.ob_TowId AS tw_Id, CONVERT(char(10), d.dok_DataWyst, 23) AS dzien, SUM(p.ob_Ilosc) AS szt
    FROM dok_Pozycja p
    JOIN dok__Dokument d ON d.dok_Id = p.ob_DokHanId
    WHERE d.dok_Typ = 2 AND d.dok_Status = 1 AND d.dok_MagId = @mag
      AND p.ob_TowId IN (${idy.join(',')})
      AND d.dok_DataWyst >= @od
    GROUP BY p.ob_TowId, CONVERT(char(10), d.dok_DataWyst, 23)
  `, { od, mag: MAGAZYN_GT_ID.K4 });
  for (const w of r.recordset) {
    const k = String(w.tw_Id);
    if (!wynik.has(k)) wynik.set(k, []);
    wynik.get(k).push({ dzien: w.dzien, szt: Number(w.szt) || 0 });
  }
  return wynik;
}

// Pulpit repricera: FS z K4 dzien po dniu wg pola "Zrodlo zamowienia" (pw_Dane, TypObiektu -2 = FS, pwd_Tekst04),
// ktore wpisuje integrator - kanal rozpoznaje pricing/pulpit-model.js (kolumnaZrodla). Z FS, nie z ZK: na ZK to pole
// siedzi gdzie indziej (-8, Tekst01) i w innej pisowni ("Empik", "Amazon.de", puste dla eMAG). Liczymy tylko towary
// i komplety (tw_Rodzaj 1 i 8) - FS niesie tez usluge TRANSPORT. Dwa zestawy: dokumenty (ile FS i sztuk na zrodlo)
// i pozycje per towar (sztuki towarow z automatem na danym kanale).
async function sprzedazWgZrodla(od) {
  const z = `FROM dok__Dokument d
      JOIN dok_Pozycja p ON p.ob_DokHanId = d.dok_Id
      JOIN tw__Towar t ON t.tw_Id = p.ob_TowId AND t.tw_Rodzaj IN (1, 8)
      LEFT JOIN pw_Dane z ON z.pwd_IdObiektu = d.dok_Id AND z.pwd_TypObiektu = -2
     WHERE d.dok_Typ = 2 AND d.dok_Status = 1 AND d.dok_MagId = @mag AND d.dok_DataWyst >= @od`;
  const pola = `CONVERT(char(10), d.dok_DataWyst, 23) AS dzien, LTRIM(RTRIM(ISNULL(z.pwd_Tekst04, ''))) AS zrodlo, d.dok_Waluta AS waluta`;
  const grupa = `CONVERT(char(10), d.dok_DataWyst, 23), LTRIM(RTRIM(ISNULL(z.pwd_Tekst04, ''))), d.dok_Waluta`;
  const par = { od, mag: MAGAZYN_GT_ID.K4 };
  const [dok, poz] = await Promise.all([
    query(`SELECT ${pola}, COUNT(DISTINCT d.dok_Id) AS zamowien, SUM(p.ob_Ilosc) AS szt ${z} GROUP BY ${grupa}`, par),
    query(`SELECT ${pola}, p.ob_TowId AS tw_id, SUM(p.ob_Ilosc) AS szt ${z} GROUP BY ${grupa}, p.ob_TowId`, par),
  ]);
  return { dokumenty: dok.recordset, pozycje: poz.recordset };
}

module.exports = { sprzedazDziennaFs, sprzedazWgZrodla };
