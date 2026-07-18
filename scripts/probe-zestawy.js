'use strict';

// Jednorazowa SONDA (tylko odczyt) - sklad zestawow (rodzaj 8) MAJACYCH STAN NA K4.
// ZW poza zakresem: liczy sie wylacznie zmontowany zestaw lezacy fizycznie na K4,
// bo tylko on zaburza liczenie polki magazynierowi. Nic nie zapisuje.
//
// URUCHOM:  GT_SQL_HOST=... GT_SQL_PORT=... GT_SQL_DATABASE=... node scripts/probe-zestawy.js

const { query, getPool } = require('../services/gt-sql');

async function sekcja(opis, fn) {
  console.log(`\n===== ${opis} =====`);
  try { return await fn(); } catch (err) { console.log('  BLAD:', err.message); return null; }
}

(async () => {
  try {
    // A. Wszystkie kolumny tabeli skladu - potrzebna nazwa kolumny ILOSCI
    await sekcja('A. tw_Komplet - kolumny', async () => {
      const r = await query(`
        SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = 'tw_Komplet'
        ORDER BY ORDINAL_POSITION`);
      console.table(r.recordset);
    });

    // B. Zestawy (rodzaj 8) ze stanem na K4 - to jedyne, ktore nas interesuja
    const k4Zestawy = await sekcja('B. Zestawy rodzaj 8 ze stanem na K4', async () => {
      const r = await query(`
        SELECT t.tw_Id, t.tw_Symbol, t.tw_Nazwa, s.st_Stan, s.st_StanRez
        FROM tw__Towar t
        JOIN tw_Stan s ON s.st_TowId = t.tw_Id
        JOIN sl_Magazyn m ON m.mag_Id = s.st_MagId
        WHERE t.tw_Rodzaj = 8 AND m.mag_Symbol = 'K4' AND s.st_Stan > 0
        ORDER BY s.st_Stan DESC`);
      console.table(r.recordset);
      return r.recordset;
    });

    const ids = (k4Zestawy || []).map((z) => z.tw_Id);
    if (!ids.length) {
      console.log('\n(Brak zestawow ze stanem na K4 w tej bazie - dalsze kroki pominiete.)');
    } else {
      const lista = ids.join(',');

      // C. Surowe wiersze skladu dla tych zestawow (widac WSZYSTKIE kolumny, w tym ilosc)
      await sekcja('C. tw_Komplet - surowe wiersze dla zestawow z K4', async () => {
        const r = await query(`SELECT * FROM tw_Komplet WHERE kpl_IdKomplet IN (${lista}) ORDER BY kpl_IdKomplet`);
        console.table(r.recordset);
      });

      // D. Sklad czytelnie: zestaw -> skladnik (symbol/nazwa/rodzaj) + stan skladnika na K4
      await sekcja('D. Sklad zestawow K4 + stan skladnika na K4', async () => {
        const r = await query(`
          SELECT k.kpl_IdKomplet AS zestaw_id, zt.tw_Symbol AS zestaw_symbol,
                 k.kpl_IdSkladnik AS skladnik_id, st.tw_Symbol AS skladnik_symbol,
                 st.tw_Nazwa AS skladnik_nazwa, st.tw_Rodzaj AS skladnik_rodzaj,
                 k.*,
                 (SELECT s.st_Stan FROM tw_Stan s JOIN sl_Magazyn m ON m.mag_Id = s.st_MagId
                  WHERE s.st_TowId = k.kpl_IdSkladnik AND m.mag_Symbol = 'K4') AS skladnik_stan_k4
          FROM tw_Komplet k
          JOIN tw__Towar zt ON zt.tw_Id = k.kpl_IdKomplet
          JOIN tw__Towar st ON st.tw_Id = k.kpl_IdSkladnik
          WHERE k.kpl_IdKomplet IN (${lista})
          ORDER BY k.kpl_IdKomplet`);
        console.table(r.recordset);
      });
    }

    // E. Kontrola odwrotna: czy skladniki tez sa rodzaj 8 (zestaw w zestawie)?
    await sekcja('E. Rozklad rodzajow skladnikow (czy zdarza sie zestaw w zestawie)', async () => {
      const r = await query(`
        SELECT st.tw_Rodzaj AS skladnik_rodzaj, COUNT(*) AS ile_wierszy
        FROM tw_Komplet k JOIN tw__Towar st ON st.tw_Id = k.kpl_IdSkladnik
        GROUP BY st.tw_Rodzaj ORDER BY ile_wierszy DESC`);
      console.table(r.recordset);
    });

    // F. Czy ten sam skladnik wystepuje w DWOCH wierszach tego samego kompletu? (wariant b)
    await sekcja('F. Komplety z powtorzonym skladnikiem (ten sam kpl_IdSkladnik >1 wiersz)', async () => {
      const r = await query(`
        SELECT k.kpl_IdKomplet, k.kpl_IdSkladnik, COUNT(*) AS ile_wierszy, SUM(k.kpl_Liczba) AS suma_liczba
        FROM tw_Komplet k
        GROUP BY k.kpl_IdKomplet, k.kpl_IdSkladnik
        HAVING COUNT(*) > 1
        ORDER BY ile_wierszy DESC`);
      if (!r.recordset.length) console.log('  BRAK - kazdy skladnik to jeden wiersz, wielokrotnosc siedzi w kpl_Liczba (wariant a)');
      else console.table(r.recordset);
    });

    // G. Rozklad wartosci kpl_Liczba - czy sa 2-paki (2x ten sam) itp.
    await sekcja('G. Rozklad kpl_Liczba (ile skladnika na zestaw)', async () => {
      const r = await query(`
        SELECT k.kpl_Liczba, COUNT(*) AS ile_wierszy
        FROM tw_Komplet k GROUP BY k.kpl_Liczba ORDER BY k.kpl_Liczba`);
      console.table(r.recordset);
    });

    // H. ZAMROZONE NA K4: ile sztuk komponentu wisi w zestawach ZMONTOWANYCH lezacych na K4.
    //    UWAGA: liczymy stan zestawu z K4 (realne, niewyslane), NIE z ZW (ZW = wirtualny
    //    potencjal montazu, ignorujemy). Zestaw fizycznie na K4 zamraza swoje skladniki.
    await sekcja('H. Komponenty zamrozone w zestawach NA K4 (stan zestawu z K4)', async () => {
      const r = await query(`
        SELECT sk.tw_Symbol AS komponent, sk.tw_Nazwa AS nazwa,
          MAX(k4s.st_Stan) AS stan_k4_gt,
          SUM(k4z.st_Stan * k.kpl_Liczba) AS zamrozone_k4
        FROM tw_Komplet k
        JOIN tw__Towar zt ON zt.tw_Id = k.kpl_IdKomplet AND zt.tw_Rodzaj = 8
        JOIN sl_Magazyn mk4 ON mk4.mag_Symbol = 'K4'
        JOIN tw_Stan k4z ON k4z.st_TowId = k.kpl_IdKomplet AND k4z.st_MagId = mk4.mag_Id AND k4z.st_Stan > 0
        JOIN tw__Towar sk ON sk.tw_Id = k.kpl_IdSkladnik AND sk.tw_Rodzaj = 1
        LEFT JOIN tw_Stan k4s ON k4s.st_TowId = k.kpl_IdSkladnik AND k4s.st_MagId = mk4.mag_Id
        GROUP BY sk.tw_Symbol, sk.tw_Nazwa
        ORDER BY zamrozone_k4 DESC`);
      console.table(r.recordset);
      console.log('  (zamrozone_k4 = SUM stan_zestawu_na_K4 * kpl_Liczba; to co realnie zaburza liczenie polki)');
    });
  } finally {
    try { const pool = await getPool(); await pool.close(); } catch (_) {}
  }
})();
