'use strict';

// Wspolna logika "doslania" ruchu do GT - wywolywana zarowno przy tworzeniu ruchu
// (POST /mm, /lok), jak i przy ponawianiu ruchow 'pending' (POST /:id/retry,
// services/ruchy-retry.js). Patrz CLAUDE.md "Kolejka": ruch WMS jest juz zapisany,
// tu tylko probujemy dogonic strone GT (dokument MM + pola lokalizacyjne).

const db = require('../db/database');
const gtBridge = require('./gt-bridge');
const gtFields = require('./gt-fields');
const gtDokumenty = require('./gt-dokumenty');
const awarie = require('./awarie');
const { MAGAZYN_GT_ID } = require('../config/magazyny');

// Probuje dokonczyc ruch po stronie GT: dla MM bez dok_gt_numer wystawia dokument MM,
// nastepnie (zawsze) synchronizuje pola lokalizacyjne K4/K4gora. Idempotentne -
// jesli dok_gt_numer juz istnieje, MM nie jest wystawiane ponownie (bez duplikatow).
// Ustawia status 'ok' (i czysci blad_opis) tylko gdy obie operacje sie powiodly,
// w przeciwnym razie ruch zostaje 'pending' z aktualnym opisem bledu.
async function wykonajRuchGT(ruchId) {
  const ruch = db.prepare('SELECT * FROM ruchy WHERE id = ?').get(ruchId);
  if (!ruch) throw new Error(`Ruch ${ruchId} nie istnieje`);

  const zrodlo = ruch.lok_zrodlo_id ? db.prepare('SELECT * FROM lokalizacje WHERE id = ?').get(ruch.lok_zrodlo_id) : null;
  const cel = ruch.lok_cel_id ? db.prepare('SELECT * FROM lokalizacje WHERE id = ?').get(ruch.lok_cel_id) : null;

  let dokOk = true;
  let bladDok = null;

  if (ruch.typ === 'MM' && !ruch.dok_gt_numer) {
    const magazynZrodlowy = zrodlo ? zrodlo.magazyn : ruch.mag_zrodlo_zewnetrzny;
    const magazynDocelowy = cel ? cel.magazyn : ruch.mag_cel_zewnetrzny;
    const magZrodloId = MAGAZYN_GT_ID[magazynZrodlowy];
    const magCelId = MAGAZYN_GT_ID[magazynDocelowy];

    if (!magZrodloId || !magCelId) {
      dokOk = false;
      bladDok = `Nieznany magazyn dla MM (zrodlo: ${magazynZrodlowy}, cel: ${magazynDocelowy}) - brak mapowania na mag_Id GT`;
    } else {
      const odpowiedz = await gtBridge.wystawMM({
        artykul_gt_id: ruch.artykul_gt_id,
        magazyn_zrodlowy: magazynZrodlowy,
        magazyn_docelowy: magazynDocelowy,
        magazyn_zrodlowy_id: magZrodloId,
        magazyn_docelowy_id: magCelId,
        ilosc: ruch.ilosc,
        operator: ruch.operator,
      });

      if (odpowiedz.ok && odpowiedz.dane?.sukces) {
        const numer = odpowiedz.dane.numer_dokumentu;
        if (!numer) {
          // Sfera potwierdzila sukces, ale nie zwrocila numeru - NIE oznaczamy 'ok'
          // (gwarancja: numer WMS == numer GT). Dokument moze istniec w GT bez numeru po
          // stronie WMS -> ruch zostaje pending z alarmem, do recznego wyjasnienia.
          dokOk = false;
          bladDok = 'Sfera zwrocila sukces bez numeru dokumentu MM - ruch wstrzymany (mozliwy dokument w GT bez numeru w WMS; sprawdz recznie zanim ponowisz)';
          awarie.blad('most-gt', bladDok, { ruchId, artykul: ruch.artykul_gt_id });
        } else {
          // Ustal dok_Id (PK GT) - dok_NrPelny nie jest unikalny. Brak GT SQL nie blokuje
          // ruchu (numer wystarcza), tylko logujemy, ze nie domknelismy dok_Id.
          let dokGtId = null;
          const znal = await gtDokumenty.znajdzMM(numer, ruch.artykul_gt_id);
          if (znal && znal.dok_Id) dokGtId = znal.dok_Id;
          else awarie.blad('most-gt', `Nie ustalono dok_Id dla ${numer} (tw ${ruch.artykul_gt_id})`, { ruchId, powod: (znal && znal.blad) ? znal.blad : 'brak dokumentu w GT' });
          db.prepare('UPDATE ruchy SET dok_gt_numer = ?, dok_gt_id = ? WHERE id = ?').run(numer, dokGtId, ruchId);
        }
      } else {
        dokOk = false;
        bladDok = odpowiedz.blad ?? odpowiedz.dane?.blad ?? `Most GT zwrocil status ${odpowiedz.status}`;
      }
    }
  }

  const magazyny = new Set();
  if (zrodlo) magazyny.add(zrodlo.magazyn);
  if (cel) magazyny.add(cel.magazyn);

  let lokOk = true;
  let bladLok = null;
  const wynikLok = await gtFields.synchronizujLokalizacje(ruch.artykul_gt_id, magazyny);
  if (wynikLok && !(wynikLok.ok && wynikLok.dane?.sukces)) {
    lokOk = false;
    bladLok = wynikLok.blad ?? wynikLok.dane?.blad ?? `Most GT zwrocil status ${wynikLok.status}`;
  }

  if (dokOk && lokOk) {
    db.prepare("UPDATE ruchy SET status = 'ok', blad_opis = NULL WHERE id = ?").run(ruchId);
  } else {
    const opisy = [bladDok, bladLok ? `Sync lokalizacji GT: ${bladLok}` : null].filter(Boolean);
    db.prepare("UPDATE ruchy SET status = 'pending', blad_opis = ? WHERE id = ?").run(opisy.join(' | '), ruchId);
  }

  return db.prepare('SELECT * FROM ruchy WHERE id = ?').get(ruchId);
}

module.exports = { wykonajRuchGT };
