'use strict';

// Wymusza kopie awaryjna do chmury TERAZ i CZEKA na wynik.
// Uzycie:
//   - pierwsze uruchomienie po konfiguracji B2 (sprawdza, ze rclone + klucz dzialaja),
//   - kwartalny test: odpal, potem sciagnij plik z chmury i otworz (backup, ktorego nie odtworzyles, to nie backup).
//
// Wymaga w .env: WMS_RCLONE_REMOTE (+ rclone w PATH lub WMS_RCLONE_BIN, opcjonalnie WMS_RCLONE_CONFIG).
// Uruchom z katalogu projektu:  node scripts/backup-chmura-teraz.js

require('dotenv').config();
const backup = require('../services/backup');

const r = backup.wyslijTeraz();

if (r.ok) {
  console.log(`OK: paczka ${r.data} wyslana do chmury.`);
  console.log(`     SKU ${r.pliki.liczbaSku}, stany ${r.pliki.liczbaStanow}, ruchy ${r.pliki.liczbaRuchow}.`);
  console.log(`     Pliki: wms_${r.data}.db + lokalizacje_zbiorczo/lokalizacje/historia_${r.data}.csv`);
  if (r.wyjscie && r.wyjscie.trim()) console.log(`     rclone: ${r.wyjscie.trim()}`);
  process.exit(0);
}

console.error(`BLAD: ${r.powod}`);
if (r.stderr) console.error(r.stderr.trim());
console.error('\nSprawdz: czy WMS_RCLONE_REMOTE ustawione, czy "rclone" jest w PATH, czy klucz B2 ma dostep do kubelka.');
process.exit(1);
