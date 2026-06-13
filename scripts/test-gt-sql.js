'use strict';

// Jednorazowy test polaczenia do bazy GT - sprawdza dostep i odnajduje tabele
// towarow (nazwy moga sie roznic w zaleznosci od wersji InsERT GT).

const { query, getPool } = require('../services/gt-sql');

(async () => {
  try {
    const tabele = await query(`
      SELECT TABLE_SCHEMA, TABLE_NAME
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_NAME LIKE '%Towar%' OR TABLE_NAME LIKE 'tw%'
      ORDER BY TABLE_NAME
    `);
    console.log('Tabele towarow:');
    console.table(tabele.recordset);

    const towary = await query(`SELECT TOP 10 * FROM tw__Towar ORDER BY tw_Id`);
    console.log('\nPrzykladowe towary (tw__Towar):');
    console.table(towary.recordset);
  } catch (err) {
    console.error('Blad polaczenia/zapytania:', err.message);
  } finally {
    const pool = await getPool();
    await pool.close();
  }
})();
