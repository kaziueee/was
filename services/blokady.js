'use strict';

// Blokady edycji produktu (Faza A#4, twarda blokada). 1 wiersz = 1 produkt aktualnie
// edytowany. Klient odswieza heartbeat co ~30s; lock wygasa po TIMEOUT_MS bezczynnosci
// (np. gdy ktos zamknal karte bez zwolnienia). Zwalniany jawnie przy zamknieciu edycji.

const db = require('../db/database');

const TIMEOUT_MS = 2 * 60 * 1000; // lock nieodswiezany > 2 min = przeterminowany

function przeterminowana(b) {
  return Date.now() - new Date(b.heartbeat + 'Z').getTime() > TIMEOUT_MS;
}

function sprzatnij() {
  const prog = new Date(Date.now() - TIMEOUT_MS).toISOString().slice(0, 19).replace('T', ' ');
  db.prepare('DELETE FROM blokady_edycji WHERE heartbeat < ?').run(prog);
}

// Aktualny wlasciciel locka (jesli aktywny) albo null.
function status(artykulGtId) {
  const b = db.prepare('SELECT * FROM blokady_edycji WHERE artykul_gt_id=?').get(artykulGtId);
  if (!b || przeterminowana(b)) return null;
  return b;
}

// Proba przejecia locka. Zwraca { zajete:true, przez } gdy trzyma go KTO INNY (aktywnie),
// albo { zajete:false, moje:true } gdy przejeto (wolne / wlasne / przeterminowane).
//
// Porownujemy po UZYTKOWNIKU, nie po tokenie: token jest per urzadzenie/karta, wiec ten sam
// magazynier na Zebrze i na desktopie ma dwa rozne tokeny i blokowal SAM SIEBIE - z
// komunikatem "Produkt edytuje Mateusz" wyswietlanym Mateuszowi. Lock ma chronic przed
// KIMS INNYM ("A na przerwie, B edytuje, A wraca i zatwierdza na starych danych"); dwa
// urzadzenia tej samej osoby to nie ten przypadek - wtedy lock po prostu przechodzi na
// nowe urzadzenie (INSERT ... ON CONFLICT nizej nadpisuje token).
function zajmij(artykulGtId, sesja) {
  sprzatnij();
  const ist = db.prepare('SELECT * FROM blokady_edycji WHERE artykul_gt_id=?').get(artykulGtId);
  if (ist && ist.uzytkownik_id !== sesja.uzytkownik_id && !przeterminowana(ist)) {
    return { zajete: true, przez: ist.imie, od: ist.czas_start };
  }
  db.prepare(`INSERT INTO blokady_edycji (artykul_gt_id, uzytkownik_id, imie, token, czas_start, heartbeat)
              VALUES (?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
              ON CONFLICT(artykul_gt_id) DO UPDATE SET
                uzytkownik_id=excluded.uzytkownik_id, imie=excluded.imie, token=excluded.token,
                czas_start=CURRENT_TIMESTAMP, heartbeat=CURRENT_TIMESTAMP`)
    .run(String(artykulGtId), sesja.uzytkownik_id, sesja.imie, sesja.token);
  return { zajete: false, moje: true };
}

// Odswiezenie locka (tylko wlasciciel). Zwraca true gdy nadal nasze.
function heartbeat(artykulGtId, token) {
  const r = db.prepare("UPDATE blokady_edycji SET heartbeat=CURRENT_TIMESTAMP WHERE artykul_gt_id=? AND token=?")
    .run(String(artykulGtId), token);
  return r.changes > 0;
}

// Zwolnienie locka (tylko wlasciciel).
function zwolnij(artykulGtId, token) {
  db.prepare('DELETE FROM blokady_edycji WHERE artykul_gt_id=? AND token=?').run(String(artykulGtId), token);
}

// Middleware: przy ZAPISIE ruchu (POST/PUT z artykul_gt_id) odrzuca, gdy produkt jest
// aktualnie edytowany przez INNĄ sesję. Zamyka dziurę "A na przerwie, B edytuje, A wraca
// i zatwierdza na starych danych". NIE wymaga posiadania locka (nie psuje przeplywow bez
// edycji, np. uzupelnien) - blokuje tylko konflikt z aktywnym edytujacym. Wymaga, by
// wczesniej dzialal auth (req.uzytkownik). Uzywac po auth.wymagajSesjiNaZapisie.
function middlewareRuch(req, res, next) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return next();
  const id = req.body && req.body.artykul_gt_id;
  if (!id || !req.uzytkownik) return next();
  const b = status(String(id));
  // Jak w zajmij(): po UZYTKOWNIKU, nie po tokenie - inaczej wlasna sesja z drugiego
  // urzadzenia (Zebra vs desktop) odrzucalaby wlasny zapis.
  if (b && b.uzytkownik_id !== req.uzytkownik.uzytkownik_id) {
    return res.status(409).json({ blad: `Produkt edytuje ${b.imie} — odśwież i otwórz ponownie` });
  }
  next();
}

module.exports = { zajmij, heartbeat, zwolnij, status, sprzatnij, middlewareRuch, TIMEOUT_MS };
