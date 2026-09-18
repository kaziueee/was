'use strict';

// Odswieza KOPIE kartoteki GT w WMS (symbol, nazwa, EAN w stany_lokalizacji).
//   node scripts/odswiez-kartoteke.js            -> podglad, NIC nie zapisuje
//   node scripts/odswiez-kartoteke.js --zapisz   -> zapisuje do wms.db
//
// PO CO: kopia symbolu zapisywana jest przy wstawieniu wiersza i do 2026-09-18 nic jej nie
// odswiezalo. Gdy w Subiekcie zmieni sie symbol (albo - jak przy plusakach z Ulicy Sezamkowej -
// zamieni miejscami symbole dwoch kart), kopia zostaje na starym: towar znika ze skanu pod
// nowym symbolem, a pod starym potrafi sie SKLEIC z innym towarem. Od 2026-09-18 skan
// rozwiazuje kod przez GT i pyta WMS po tw_Id, wiec sam obraz jest juz poprawny - ale kopia
// zostaje etykieta na listach, w wyszukiwaniu po nazwie i w rozjazdach. Ten skrypt sciaga
// zaleglosci od razu, zamiast czekac na nocny przebieg joba (services/kartoteka.js).
//
// CO ROBI, A CZEGO NIE:
//   - poprawia wylacznie kopie w WMS. Kartoteki GT nie dotyka W OGOLE - to master (zasada #2),
//   - pustego pola w GT nie kopiuje (pusto = "nikt nie wpisal", nie "ma byc puste"),
//   - EAN uzupelnia tam, gdzie w WMS go nie ma, a GT zna podstawowy kod kreskowy,
//   - nie rusza `ruchy` ani `audyt` - tam symbol jest zapisem historycznym.
//
// Zapis idzie przez services/kartoteka.js, czyli TA SAMA sciezka, co job - wlasny UPDATE
// rozjechalby sie z nia przy pierwszej zmianie reguly.

const kartoteka = require('../services/kartoteka');

const ZAPISZ = process.argv.includes('--zapisz');

(async () => {
  let raport;
  try {
    raport = await kartoteka.odswiez({ probne: !ZAPISZ, uzytkownik: 'system:kartoteka-skrypt' });
  } catch (err) {
    console.error(`BLAD: nie mozna odczytac kartoteki z GT - ${err.message}`);
    process.exit(1);
  }

  console.log(`Sprawdzono wierszy kopii: ${raport.sprawdzone}`);
  console.log(`Rozjechana tozsamosc (symbol/nazwa): ${raport.tozsamosc} wierszy, ${raport.artykuly.length} artykulow`);
  console.log(`Do uzupelnienia sam EAN: ${raport.ean} wierszy`);

  for (const a of raport.artykuly) {
    const symbol = a.symbol.z === a.symbol.na ? a.symbol.na : `${a.symbol.z} -> ${a.symbol.na}`;
    console.log(`  tw_Id ${a.artykul_gt_id}: ${symbol}`);
    if (a.nazwa.z !== a.nazwa.na) console.log(`      nazwa: "${a.nazwa.z}" -> "${a.nazwa.na}"`);
  }

  if (raport.tozsamosc === 0 && raport.ean === 0) {
    console.log('\nKopia kartoteki jest aktualna - nie ma czego poprawiac.');
    process.exit(0);
  }

  console.log(ZAPISZ
    ? `\nZapisano ${raport.zapisane} wierszy. Zmiany tozsamosci sa w Logu zmian (akcja "kartoteka_sync", filtr U+A).`
    : '\nTo byl PODGLAD - nic nie zapisano. Uruchom z --zapisz, zeby poprawic kopie.');
  process.exit(0);
})();
