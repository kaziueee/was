'use strict';

// Naprawa NIEKANONICZNYCH kodow lokalizacji w wms.db (np. "L3P3" zamiast "L3-P3").
//   node scripts/napraw-kody-lokalizacji.js            -> DRY-RUN, tylko wypisuje
//   node scripts/napraw-kody-lokalizacji.js --zapisz   -> poprawia kody + cechy strukturalne
//
// POWOD: do 2026-08-04 zapis lokalizacji (POST/import/PUT) bral kod DOSLOWNIE, a kazdy lookup
// (skan, /kod/:kod, /skan/:kod) normalizuje wejscie do postaci z myslnikiem. Wiersz zapisany
// jako "L3P3" byl wiec nieosiagalny: skan "L3P3" pytal o "L3-P3", a takiego wiersza nie bylo.
// Na produkcji objawialo sie to jako "czesc lokalizacji w regale L sie nie czyta" - mimo ze
// wiersz istnial i lezal na nim towar. Zapis juz kanonizuje kod, a lookup ma fallback po formie
// golej; ten skrypt sprzata to, co zostalo w bazie.
//
// Kolizja (istnieje juz wiersz w postaci kanonicznej) NIE jest rozwiazywana automatycznie -
// scalenie dwoch lokalizacji znaczy przeniesienie stanow i jest decyzja czlowieka. Takie
// przypadki tylko raportujemy.
//
// Kody spoza siatki regalow (RB, BIURO, "PIRAMIDA I-J", sklejone "B11B11") zostaja nietkniete:
// nie ma dla nich postaci kanonicznej, wiec nie ma czego poprawiac.

const db = require('../db/database');
const audyt = require('../services/audyt');
const { rozbierzKod, normalizujKodLokalizacji } = require('../services/lokalizacje-model');

const ZAPISZ = process.argv.includes('--zapisz');

const wiersze = db.prepare('SELECT id, kod, magazyn, typ FROM lokalizacje').all();
const kody = new Map(wiersze.map((w) => [w.kod, w]));

const doPoprawy = [];
const kolizje = [];
for (const w of wiersze) {
  const kanon = normalizujKodLokalizacji(w.kod);
  if (kanon === w.kod) continue;
  const stany = db.prepare(
    'SELECT COUNT(*) AS pozycji, COALESCE(SUM(ilosc), 0) AS sztuk FROM stany_lokalizacji WHERE lokalizacja_id = ?'
  ).get(w.id);
  (kody.has(kanon) ? kolizje : doPoprawy).push({ ...w, kanon, ...stany });
}

console.log(`Lokalizacji w bazie: ${wiersze.length}`);
console.log(`Do poprawy: ${doPoprawy.length}${kolizje.length ? `, kolizji do reki: ${kolizje.length}` : ''}`);

for (const w of doPoprawy) {
  console.log(`  ${w.kod} -> ${w.kanon}  [${w.magazyn}] pozycji: ${w.pozycji}, sztuk: ${w.sztuk}`);
}
for (const w of kolizje) {
  console.log(`  ⚠ ${w.kod} -> ${w.kanon} JUZ ISTNIEJE - scalenie do reki `
    + `(na "${w.kod}" pozycji: ${w.pozycji}, sztuk: ${w.sztuk})`);
}

if (!doPoprawy.length) {
  console.log('Nic do zrobienia.');
  process.exit(0);
}

if (!ZAPISZ) {
  console.log('\nDRY-RUN - nic nie zapisano. Dodaj --zapisz, zeby poprawic.');
  process.exit(0);
}

// Kod poprawiamy razem z cechami strukturalnymi: dotad "L3P3" nie pasowal do wzorca, wiec
// wiersz mial typ 'inny' i puste hala/regal/kolumna (wypadal z filtrow i raportow).
const aktualizuj = db.prepare(
  `UPDATE lokalizacje SET kod = ?, hala = ?, regal = ?, alejka = ?, strona = ?, kolumna = ?, typ = ?
   WHERE id = ?`
);

let poprawione = 0;
db.exec('BEGIN');
try {
  for (const w of doPoprawy) {
    const c = rozbierzKod(w.kanon, w.magazyn);
    aktualizuj.run(w.kanon, c.hala, c.regal, c.alejka, c.strona, c.kolumna, c.typ, w.id);
    poprawione += 1;
  }
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}

for (const w of doPoprawy) {
  audyt.zapisz({
    uzytkownik: 'system:napraw-kody',
    akcja: 'lokalizacja_edycja',
    magazyn: w.magazyn,
    lokalizacja: w.kanon,
    przed: { kod: w.kod, typ: w.typ },
    po: { kod: w.kanon, typ: rozbierzKod(w.kanon, w.magazyn).typ, powod: 'kanonizacja kodu' },
    wynik: 'ok',
  });
}

console.log(`\nPoprawiono ${poprawione} ${poprawione === 1 ? 'kod' : 'kodow'}.`);
