'use strict';

// Audyt BIZNESOWY "kto/co/gdzie/kiedy" - patrz PROGRESS.md "Specyfikacja: logi + backup" (A).
// Jeden strumien wszystkich zmian stanu/lokalizacji: ruchy (MM/LOK/przyjecie) + zmiany
// lokalizacji/planu/zapasu + akcje admina. Tabela `audyt` w wms.db (przeszukiwalna,
// wchodzi do backupu), append-only.
//
// OSOBNY od logu AWARII (services/awarie.js - techniczny, pliki). Tu: rozliczalnosc.
//
// "kto": dzis operator z requestu (pole `operator`); po dodaniu logowania (Faza A#4)
// bedzie z sesji zalogowanego uzytkownika.

const db = require('../db/database');
const awarie = require('./awarie');

const STMT = db.prepare(`
  INSERT INTO audyt (uzytkownik, akcja, artykul_gt_id, artykul_symbol, magazyn, lokalizacja,
                     przed, po, ilosc, wynik, ruch_id, dok_gt_numer, szczegoly)
  VALUES (@uzytkownik, @akcja, @artykul_gt_id, @artykul_symbol, @magazyn, @lokalizacja,
          @przed, @po, @ilosc, @wynik, @ruch_id, @dok_gt_numer, @szczegoly)
`);

function tekst(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

// Zapisuje wpis audytu. NIGDY nie rzuca - awaria audytu nie moze przerwac operacji
// biznesowej (idzie do logu awarii). akcja jest wymagana.
function zapisz(wpis = {}) {
  try {
    STMT.run({
      uzytkownik: wpis.uzytkownik ?? null,
      akcja: wpis.akcja ?? 'NIEZNANA',
      artykul_gt_id: wpis.artykul_gt_id != null ? String(wpis.artykul_gt_id) : null,
      artykul_symbol: wpis.artykul_symbol ?? null,
      magazyn: wpis.magazyn ?? null,
      lokalizacja: wpis.lokalizacja ?? null,
      przed: tekst(wpis.przed),
      po: tekst(wpis.po),
      ilosc: wpis.ilosc ?? null,
      wynik: wpis.wynik ?? null,
      ruch_id: wpis.ruch_id ?? null,
      dok_gt_numer: wpis.dok_gt_numer ?? null,
      szczegoly: tekst(wpis.szczegoly),
    });
  } catch (e) {
    awarie.blad('audyt', `nie zapisano wpisu audytu (${wpis.akcja}): ${e.message}`, { wpis: tekst(wpis) });
  }
}

module.exports = { zapisz };
