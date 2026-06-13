'use strict';

// Test wydajnosci wyszukiwania towaru w tw__Towar (po symbolu i EAN) -
// sprawdza indeksy oraz mierzy czas typowych zapytan, w tym na "rozgrzanym"
// polaczeniu (kolejne zapytania bez ponownego laczenia).

const { query, getPool } = require('../services/gt-sql');

async function zmierz(nazwa, sql, parametry) {
  const start = Date.now();
  const wynik = await query(sql, parametry);
  const ms = Date.now() - start;
  console.log(`${nazwa}: ${ms} ms, wierszy: ${wynik.recordset.length}`);
  if (wynik.recordset.length > 0 && wynik.recordset.length <= 3) console.log(wynik.recordset);
  return wynik;
}

(async () => {
  try {
    const indeksy = await query(`
      SELECT i.name AS indeks, c.name AS kolumna, i.is_unique
      FROM sys.indexes i
      JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
      JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
      WHERE i.object_id = OBJECT_ID('tw__Towar')
        AND c.name IN ('tw_Symbol', 'tw_PodstKodKresk', 'tw_Id', 'tw_Nazwa')
      ORDER BY i.name, ic.key_ordinal
    `);
    console.log('Indeksy na tw_Symbol / tw_PodstKodKresk / tw_Id / tw_Nazwa:');
    console.table(indeksy.recordset);

    const probka = await query(`SELECT TOP 1 tw_Id, tw_Symbol, tw_PodstKodKresk FROM tw__Towar WHERE tw_PodstKodKresk IS NOT NULL AND tw_PodstKodKresk <> ''`);
    const { tw_Symbol, tw_PodstKodKresk } = probka.recordset[0];
    console.log(`\nPrzykladowy towar do testow: symbol=${tw_Symbol}, ean=${tw_PodstKodKresk}`);

    console.log('\n--- pierwsze zapytania (zimne polaczenie) ---');
    await zmierz('Po symbolu (=)', `SELECT tw_Id, tw_Symbol, tw_Nazwa FROM tw__Towar WHERE tw_Symbol = @symbol`, { symbol: tw_Symbol });
    await zmierz('Po EAN (=)', `SELECT tw_Id, tw_Symbol, tw_Nazwa, tw_PodstKodKresk FROM tw__Towar WHERE tw_PodstKodKresk = @ean`, { ean: tw_PodstKodKresk });

    console.log('\n--- 10x po symbolu na rozgrzanym polaczeniu ---');
    for (let i = 0; i < 10; i++) {
      await zmierz(`  #${i + 1}`, `SELECT tw_Id, tw_Symbol, tw_Nazwa FROM tw__Towar WHERE tw_Symbol = @symbol`, { symbol: tw_Symbol });
    }

    console.log('\n--- 10x po EAN na rozgrzanym polaczeniu ---');
    for (let i = 0; i < 10; i++) {
      await zmierz(`  #${i + 1}`, `SELECT tw_Id, tw_Symbol, tw_Nazwa FROM tw__Towar WHERE tw_PodstKodKresk = @ean`, { ean: tw_PodstKodKresk });
    }
  } catch (err) {
    console.error('Blad:', err.message);
  } finally {
    const pool = await getPool();
    await pool.close();
  }
})();
