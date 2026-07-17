'use strict';

// Jednorazowa SONDA (tylko odczyt) - rozpoznaje jak GT trzyma zestawy/komplety (rodzaj 8),
// zeby WMS mogl pokazac "ile sztuk skladnika jest zamrozone w zestawach". Nic nie zapisuje.
//
// URUCHOM NA PECECIE (ma GT_SQL_PASSWORD):   node scripts/probe-zestawy.js
// Wynik wklej z powrotem. Dziala na bazie z .env (testowa Z_KAJTEK_IdeaERP).

const { query, getPool } = require('../services/gt-sql');

async function bezpiecznie(opis, fn) {
  try {
    const r = await fn();
    console.log(`\n===== ${opis} =====`);
    return r;
  } catch (err) {
    console.log(`\n===== ${opis} =====`);
    console.log('  BLAD:', err.message);
    return null;
  }
}

(async () => {
  try {
    // 1. Ktore tabele wygladaja na sklad kompletu?
    await bezpiecznie('1. Tabele-kandydaci na sklad kompletu (nazwa)', async () => {
      const r = await query(`
        SELECT TABLE_SCHEMA, TABLE_NAME
        FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_TYPE = 'BASE TABLE'
          AND (TABLE_NAME LIKE '%omplet%' OR TABLE_NAME LIKE '%kladnik%'
               OR TABLE_NAME LIKE 'tw__K%' OR TABLE_NAME LIKE '%Zestaw%')
        ORDER BY TABLE_NAME`);
      console.table(r.recordset);
    });

    // 2. Kolumny-kandydaci (moze tabela ma inna nazwe, ale kolumny zdradzaja fk)
    await bezpiecznie('2. Kolumny-kandydaci (skladnik / komplet / ilosc)', async () => {
      const r = await query(`
        SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE COLUMN_NAME LIKE '%kladnik%' OR COLUMN_NAME LIKE '%omplet%'
           OR COLUMN_NAME LIKE 'tk[_]%' OR COLUMN_NAME LIKE 'kmp[_]%'
        ORDER BY TABLE_NAME, ORDINAL_POSITION`);
      console.table(r.recordset);
    });

    // 3. Ile jest towarow rodzaj 8 i ile z nich MA stan - na jakich magazynach lezy ten stan?
    await bezpiecznie('3. Stan zestawow (rodzaj 8) wg magazynu - GDZIE GT trzyma zmontowane', async () => {
      const r = await query(`
        SELECT m.mag_Symbol, COUNT(*) AS ile_zestawow_ze_stanem, SUM(s.st_Stan) AS suma_stanu
        FROM tw__Towar t
        JOIN tw_Stan s ON s.st_TowId = t.tw_Id AND s.st_Stan > 0
        JOIN sl_Magazyn m ON m.mag_Id = s.st_MagId
        WHERE t.tw_Rodzaj = 8
        GROUP BY m.mag_Symbol
        ORDER BY suma_stanu DESC`);
      console.table(r.recordset);
    });

    // 4. Przyklad: jeden zestaw rodzaj 8 ze stanem na K4 (lub gdziekolwiek) + jego symbol/nazwa
    const przyklad = await bezpiecznie('4. Przykladowy zestaw rodzaj 8 ze stanem', async () => {
      const r = await query(`
        SELECT TOP 5 t.tw_Id, t.tw_Symbol, t.tw_Nazwa, m.mag_Symbol, s.st_Stan, s.st_StanRez
        FROM tw__Towar t
        JOIN tw_Stan s ON s.st_TowId = t.tw_Id AND s.st_Stan > 0
        JOIN sl_Magazyn m ON m.mag_Id = s.st_MagId
        WHERE t.tw_Rodzaj = 8
        ORDER BY s.st_Stan DESC`);
      console.table(r.recordset);
      return r.recordset[0];
    });

    // 5. Jesli znamy nazwe tabeli skladu z kroku 1/2 - sprobuj typowej InsERT: tw__Komplet.
    //    Wyswietl WSZYSTKIE kolumny + kilka wierszy dla przykladowego zestawu, jesli sie da.
    await bezpiecznie('5. tw__Komplet - kolumny', async () => {
      const r = await query(`
        SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = 'tw__Komplet'
        ORDER BY ORDINAL_POSITION`);
      if (!r.recordset.length) { console.log('  (brak tabeli tw__Komplet - zobacz krok 1/2)'); return; }
      console.table(r.recordset);
    });

    await bezpiecznie('6. tw__Komplet - przykladowe wiersze', async () => {
      const r = await query(`SELECT TOP 10 * FROM tw__Komplet`);
      console.table(r.recordset);
    });

    if (przyklad) {
      console.log(`\n>>> Przykladowy zestaw do recznego sprawdzenia skladu: tw_Id=${przyklad.tw_Id}  ${przyklad.tw_Symbol}  (${przyklad.mag_Symbol} stan ${przyklad.st_Stan})`);
    }
  } finally {
    try { const pool = await getPool(); await pool.close(); } catch (_) {}
  }
})();
