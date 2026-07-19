'use strict';

// Backfill tw_Pole1 (lokalizacja K4) w GT dla SKU, ktorym pole zostalo WYCZYSZCZONE.
//   node scripts/backfill-tw-pole1.js            -> podglad, NIC nie zapisuje
//   node scripts/backfill-tw-pole1.js --zapisz   -> zapisuje do GT
//
// PO CO: do 2026-07-19 `obliczPolaLokalizacji` mialo `AND s.ilosc > 0`, wiec MM oprozniajace
// polke K4 wpisywalo do GT pusty string, a pusty string znaczy tam "wyczysc pole". WMS trzymal
// dom (wiersz z ilosc = 0 - patrz inwariant "Lokalizacja K4 przezywa stan 0" w CLAUDE.md),
// GT go tracil. Czlowiek szukajacy towaru po tw_Pole1 zostawal bez adresu, a SKU wypadalo
// z wyszukiwania po kodzie polki. Fix zalatwia przyszlosc - pola juz wyczyszczone odbudowalyby
// sie dopiero przy najblizszym ruchu na danym SKU. Ten skrypt robi to od razu.
//
// CO ROBI, A CZEGO NIE:
//   - uzupelnia WYLACZNIE pola PUSTE w GT, gdy WMS zna dom na K4,
//   - pola o INNEJ tresci ZOSTAWIA nietkniete i tylko wypisuje. To osobna decyzja: moze byc
//     reczna edycja w Subiekcie albo rozjazd do sprawdzenia. Backfill ma przywrocic to, co
//     sami skasowalismy, a nie rozstrzygac spory o tresc pola,
//   - nie dotyka tw_Pole8 (K4G) - tam bug nie wystepowal, a zapis ma wlasny bezpiecznik
//     (nie nadpisuj, dopoki caly stan K4G nie jest rozlozony - zob. services/gt-fields.js).
//
// Zapis idzie przez `synchronizujLokalizacje`, czyli DOKLADNIE ta sama sciezka, co przy
// zwyklym ruchu. Wlasny UPDATE rozjechalby sie z nia przy pierwszej zmianie formatu pola.

const db = require('../db/database');
const gtFields = require('../services/gt-fields');

const ZAPISZ = process.argv.includes('--zapisz');

(async () => {
  // Dom na K4 NIEZALEZNIE od ilosci - o to w tym wszystkim chodzi.
  const sku = db.prepare(
    `SELECT s.artykul_gt_id AS id, MAX(s.artykul_symbol) AS symbol, SUM(s.ilosc) AS ilosc
     FROM stany_lokalizacji s JOIN lokalizacje l ON l.id = s.lokalizacja_id
     WHERE l.magazyn = 'K4' GROUP BY s.artykul_gt_id`
  ).all();

  if (!sku.length) {
    console.log('WMS nie zna zadnego domu na K4 - nie ma czego uzupelniac.');
    process.exit(0);
  }

  let polaGt;
  try {
    polaGt = await gtFields.pobierzAktualnePolaLokalizacji(sku.map((s) => s.id));
  } catch (err) {
    console.error(`BLAD: nie mozna odczytac pol z GT - ${err.message}`);
    process.exit(1);
  }

  const doZapisu = [];
  const rozjechane = [];
  let zgodne = 0;

  for (const s of sku) {
    const oczekiwane = gtFields.obliczPolaLokalizacji(s.id).miejsce_na_magazynie;
    if (!oczekiwane) continue;                  // WMS tez nic nie wie - nie ma co wpisac
    const wGt = (polaGt.get(String(s.id))?.tw_Pole1 || '').trim();
    if (wGt === oczekiwane) { zgodne++; continue; }
    (wGt === '' ? doZapisu : rozjechane).push({ ...s, oczekiwane, wGt });
  }

  console.log(`SKU z domem na K4 w WMS: ${sku.length}`);
  console.log(`  juz zgodne z GT:        ${zgodne}`);
  console.log(`  do uzupelnienia:        ${doZapisu.length}`);
  console.log(`  rozjechane (pomijam):   ${rozjechane.length}`);

  if (rozjechane.length) {
    console.log('\nROZJECHANE - pole w GT ma INNA tresc, NIE ruszam (sprawdz recznie):');
    for (const r of rozjechane) {
      console.log(`  ${(r.symbol || '').padEnd(18)} WMS: "${r.oczekiwane}"   GT: "${r.wGt}"`);
    }
  }

  if (!doZapisu.length) {
    console.log('\nNic do uzupelnienia.');
    process.exit(0);
  }

  console.log(`\n${ZAPISZ ? 'ZAPISUJE' : 'PODGLAD (bez zapisu)'}:`);
  for (const d of doZapisu) {
    console.log(`  ${(d.symbol || '').padEnd(18)} tw_Pole1 = "${d.oczekiwane}"   (stan WMS: ${d.ilosc})`);
  }

  if (!ZAPISZ) {
    console.log(`\nNic nie zapisano. Aby wykonac: node scripts/backfill-tw-pole1.js --zapisz`);
    process.exit(0);
  }

  let ok = 0;
  const bledy = [];
  for (const d of doZapisu) {
    try {
      // magazyny = {K4}: przeliczamy i zapisujemy WYLACZNIE tw_Pole1, tw_Pole8 zostaje nietkniete
      const wynik = await gtFields.synchronizujLokalizacje(d.id, new Set(['K4']));
      if (wynik && wynik.ok && wynik.dane?.sukces) ok++;
      else bledy.push({ ...d, powod: wynik?.blad || 'nieznany blad zapisu' });
    } catch (err) {
      bledy.push({ ...d, powod: err.message });
    }
  }

  console.log(`\nzapisano: ${ok} z ${doZapisu.length}`);
  if (bledy.length) {
    console.log('BLEDY:');
    for (const b of bledy) console.log(`  ${(b.symbol || '').padEnd(18)} ${b.powod}`);
  }
  process.exit(bledy.length ? 1 : 0);
})();
