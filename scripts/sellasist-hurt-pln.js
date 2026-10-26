'use strict';

// Uzupelnia cene Hurt_PLN w Sellasist = Hurt (EUR) × kurs NBP.
//   node scripts/sellasist-hurt-pln.js                    -> podglad, NIC nie zapisuje
//   node scripts/sellasist-hurt-pln.js --zapisz           -> zapisuje do Sellasist
//   --kurs 4.4026        kurs podany recznie (domyslnie: ostatni sredni NBP, tabela A)
//   --wszystko           przepisz kazda roznice co do grosza (domyslnie tylko odjechane o > 1%)
//   --tylko SYM1,SYM2    tylko podane symbole (test zapisu)
//   --lista              wypisz wszystkie podejrzane (Hurt_PLN > 2× cena)
// Zapis ta sama sciezka, co nocny job (services/sellasist-hurt-pln.js).

require('../config/env');
const { przelicz } = require('../services/sellasist-hurt-pln');

const arg = (nazwa) => { const i = process.argv.indexOf(nazwa); return i > 0 ? process.argv[i + 1] : null; };
const ZAPISZ = process.argv.includes('--zapisz');

(async () => {
  const r = await przelicz({
    probne: !ZAPISZ,
    kurs: arg('--kurs') ? Number(arg('--kurs').replace(',', '.')) : null,
    tolerancja: process.argv.includes('--wszystko') ? 0 : undefined,
    tylko: arg('--tylko') ? new Set(arg('--tylko').split(',')) : null,
  });
  console.log(`Kurs EUR: ${r.kurs.kurs} (${r.kurs.tabela}${r.kurs.data ? `, ${r.kurs.data}` : ''})`);
  console.log(`Produktow: ${r.produktow}, bez ceny Hurt: ${r.bezHurtu}, z wariantami: ${r.zWariantami}`);
  console.log(`Do zapisu Hurt_PLN: ${r.zmiany.length}`);
  for (const z of r.zmiany.slice(0, 10)) {
    console.log(`  ${z.symbol}: Hurt ${z.hurt_eur} EUR -> ${z.nowa} PLN${z.obecna != null ? ` (bylo ${z.obecna})` : ''}`);
  }
  if (r.zmiany.length > 10) console.log(`  … i ${r.zmiany.length - 10} kolejnych`);
  if (r.podejrzane.length) {
    console.log(`\nDO SPRAWDZENIA - Hurt_PLN > 2× cena w Sellasist (zapisane mimo to): ${r.podejrzane.length}`);
    for (const z of (process.argv.includes('--lista') ? r.podejrzane : r.podejrzane.slice(0, 15))) {
      console.log(`  ${z.symbol}: Hurt ${z.hurt_eur} EUR, cena ${z.cena} zl -> wyszloby ${z.nowa} zl`);
    }
    if (!process.argv.includes('--lista') && r.podejrzane.length > 15) console.log('  … (cala lista: --lista)');
  }
  if (r.bledy.length) console.log(`Bledy/ostrzezenia: ${JSON.stringify(r.bledy.slice(0, 10))}`);
  console.log(ZAPISZ ? `\nZapisano ${r.zapisane}.` : '\nTo byl PODGLAD - nic nie zapisano. Uruchom z --zapisz.');
  process.exit(0);
})().catch((err) => { console.error(`BLAD: ${err.message}`); process.exit(1); });
