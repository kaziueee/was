'use strict';

// Czysci pola lokalizacyjne GT (tw_Pole1 / tw_Pole8) na ZESTAWACH (tw_Rodzaj = 8).
//   node scripts/wyczysc-pola-zestawow.js              -> podglad, NIC nie zapisuje
//   node scripts/wyczysc-pola-zestawow.js --wszystkie  -> podglad takze zestawow bez stanu
//   node scripts/wyczysc-pola-zestawow.js --zapisz     -> zapisuje (robi kopie do pliku)
//
// PO CO: zestaw nie ma wlasnej polki (CLAUDE.md, "Zestaw nie ma lokalizacji"), wiec adres
// w jego kartotece wysyla czlowieka szukajacego towaru w Subiekcie pod polke, na ktorej
// tego zestawu nie ma. Status ZEST uprzatnal ekrany WMS; to jest druga strona - kartoteka GT.
//
// CZEGO NIE ROBI: nie rusza towarow rodzaju 1 (tam adres jest prawdziwy) ani stanow.
// Nie zgaduje tez, co w polu bylo - kazda kasowana wartosc ladu je w pliku kopii, z ktorego
// da sie ja odtworzyc jednym UPDATE.
//
// UWAGA na tresc pol: czesc zestawow ma tam RECZNA notatke czlowieka, zwykle adres
// SKLADNIKOW (cala rodzina NERCHIELIT* ma "RB", NERCHACU* ma "M2-B36-P1"). To nie jest
// przypadkowy smiec - dlatego skrypt pokazuje wartosci przed kasowaniem i wymaga --zapisz.

const { query } = require('../services/gt-sql');
const db = require('../db/database');
const { RODZAJ_ZESTAW } = require('../services/gt-fields');

const ZAPISZ = process.argv.includes('--zapisz');
const WSZYSTKIE = process.argv.includes('--wszystkie');

function tekst(v) { return String(v ?? '').trim(); }

(async () => {
  // Zestawy z niepustym polem lokalizacyjnym. Domyslnie tylko te ze stanem na K4/K4G -
  // czyli te, ktore realnie mieszaja w obrazie magazynu; --wszystkie obejmuje takze
  // kartoteki bez stanu (stary adres po towarze, ktorego dawno nie ma).
  const { recordset } = await query(`
    SELECT t.tw_Id, t.tw_Symbol, t.tw_Nazwa, t.tw_Pole1, t.tw_Pole8,
           ISNULL((SELECT SUM(s.st_Stan) FROM tw_Stan s JOIN sl_Magazyn m ON m.mag_Id = s.st_MagId
                   WHERE s.st_TowId = t.tw_Id AND m.mag_Symbol IN ('K4','K4G')), 0) AS stan
    FROM tw__Towar t
    WHERE t.tw_Rodzaj = @rodzaj
      AND (LTRIM(RTRIM(ISNULL(t.tw_Pole1,''))) <> '' OR LTRIM(RTRIM(ISNULL(t.tw_Pole8,''))) <> '')
    ORDER BY t.tw_Symbol
  `, { rodzaj: RODZAJ_ZESTAW });

  const wszystkie = recordset.map((r) => ({
    id: r.tw_Id,
    symbol: tekst(r.tw_Symbol),
    nazwa: tekst(r.tw_Nazwa),
    pole1: tekst(r.tw_Pole1),
    pole8: tekst(r.tw_Pole8),
    stan: Number(r.stan) || 0,
  }));
  const doRoboty = WSZYSTKIE ? wszystkie : wszystkie.filter((z) => z.stan > 0);

  if (!doRoboty.length) {
    console.log('Brak zestawow z wpisanym adresem - nic do roboty.');
    process.exit(0);
  }

  // Czy WMS ma dla tego zestawu wiersz - wtedy adres w GT wpisalismy MY, a nie czlowiek
  // w Subiekcie. Wymaga produkcyjnej wms.db; przy pustej bazie (uruchomienie z maszyny
  // deweloperskiej przeciw produkcyjnemu GT) kolumna nie ma pokrycia - mowimy to wprost,
  // zamiast nazywac wszystko "recznym wpisem".
  const zWms = new Set(db.prepare(
    'SELECT DISTINCT artykul_gt_id AS id FROM stany_lokalizacji'
  ).all().map((r) => String(r.id)));
  const znamyZrodlo = zWms.size > 0;

  console.log(`Zestawy z adresem w GT: ${wszystkie.length} (ze stanem na K4/K4G: ${wszystkie.filter((z) => z.stan > 0).length})`);
  console.log(`Do wyczyszczenia w tym przebiegu: ${doRoboty.length}${WSZYSTKIE ? ' (--wszystkie)' : ' (tylko ze stanem; --wszystkie obejmuje reszte)'}\n`);

  if (!znamyZrodlo) {
    console.log('UWAGA: lokalna wms.db jest pusta - nie wiadomo, ktory adres wpisal WMS,');
    console.log('       a ktory czlowiek w Subiekcie. Uruchom na produkcji, zeby to rozroznic.\n');
  }
  for (const z of doRoboty) {
    const zrodlo = !znamyZrodlo ? '' : (zWms.has(String(z.id)) ? ' | wpis WMS' : ' | reczny wpis w Subiekcie');
    console.log(`  ${z.symbol.padEnd(18)} stan ${String(z.stan).padStart(4)} | Pole1="${z.pole1}" Pole8="${z.pole8}"${zrodlo}`);
  }

  if (!ZAPISZ) {
    console.log('\nPODGLAD - nic nie zapisano. Uruchom z --zapisz, zeby wyczyscic te pola w GT.');
    process.exit(0);
  }

  // Kopia PRZED zapisem - kasujemy cudze notatki, wiec musi istniec droga powrotna.
  const plik = `kopia-pol-zestawow-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  require('fs').writeFileSync(plik, JSON.stringify(doRoboty, null, 1));
  console.log(`\nKopia starych wartosci: ${plik}`);

  let ok = 0;
  let bledy = 0;
  for (const z of doRoboty) {
    // Czyscimy tylko te pola, ktore faktycznie cos mialy - zeby UPDATE nie dotykal
    // kartoteki bez powodu (kazdy zapis podbija licznik zmian towaru w GT).
    const ustawienia = [];
    if (z.pole1) ustawienia.push("tw_Pole1 = ''");
    if (z.pole8) ustawienia.push("tw_Pole8 = ''");
    try {
      await query(`UPDATE tw__Towar SET ${ustawienia.join(', ')} WHERE tw_Id = @id`, { id: z.id });
      ok++;
    } catch (err) {
      bledy++;
      console.error(`  BLAD ${z.symbol}: ${err.message}`);
    }
  }
  console.log(`\nWyczyszczono: ${ok}, bledow: ${bledy}.`);
  process.exit(bledy ? 1 : 0);
})().catch((err) => {
  console.error('BLAD:', err.message);
  process.exit(1);
});
