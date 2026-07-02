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

// Ruchy aktualnie obslugiwane (in-flight) - blokada per ruchId w obrebie procesu Node.
// Chroni przed jednoczesnym wystawieniem dwoch dokumentow MM dla tego samego ruchu, gdy
// POST /mm i job ponawiania (co 5 min) zbiegna sie na wciaz 'pending' ruchu (obaj czytaliby
// mm_proby=0 i wystawili dokument). Jeden proces Node => Set w pamieci wystarcza.
const wTokuRuchy = new Set();

// Probuje dokonczyc ruch po stronie GT: dla MM bez dok_gt_numer wystawia dokument MM,
// nastepnie (zawsze) synchronizuje pola lokalizacyjne K4/K4gora. Idempotentne -
// jesli dok_gt_numer juz istnieje, MM nie jest wystawiane ponownie (bez duplikatow).
// Ustawia status 'ok' (i czysci blad_opis) tylko gdy obie operacje sie powiodly,
// w przeciwnym razie ruch zostaje 'pending' z aktualnym opisem bledu.
async function wykonajRuchGT(ruchId) {
  const klucz = Number(ruchId); // POST daje lastInsertRowid (moze byc BigInt), job daje Number
  if (wTokuRuchy.has(klucz)) {
    // ten sam ruch jest juz obslugiwany rownolegle - nie dublujemy pracy (zwlaszcza MM).
    // Zwracamy aktualny stan; drugi (rownolegly) wywolujacy dokonczy i tak.
    return db.prepare('SELECT * FROM ruchy WHERE id = ?').get(ruchId);
  }
  wTokuRuchy.add(klucz);
  try {
    return await wykonajRuchGTWewn(ruchId);
  } finally {
    wTokuRuchy.delete(klucz);
  }
}

async function wykonajRuchGTWewn(ruchId) {
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
      // Prewencja duplikatu (Faza A#3): jesli to PONOWNA proba (mm_proby > 0), poprzednie
      // wywolanie mostu moglo wystawic dokument, ale odpowiedz HTTP zaginela (timeout/restart)
      // i ruch zostal 'pending'. Zanim wystawimy kolejny MM, szukamy w GT dokumentu z naszym
      // kluczem (WMS-RUCH:<id>). Pierwsza proba (mm_proby=0) pomija skan GT - dokument nie moze
      // jeszcze istniec, a nie chcemy skanowac dok__Dokument na happy-path.
      let wystawiac = true;
      if (ruch.mm_proby > 0) {
        const istn = await gtDokumenty.znajdzMMpoKluczu(ruchId);
        if (istn && istn.blad) {
          // GT SQL niedostepny - nie moge zweryfikowac czy dokument juz istnieje. NIE wystawiam
          // (bezpieczniej wstrzymac niz zdublowac MM; Sfera i tak zwykle pada razem z SQL).
          wystawiac = false;
          dokOk = false;
          bladDok = `GT SQL niedostepny - prewencja duplikatu MM wstrzymana (nie sprawdze czy dokument juz istnieje): ${istn.blad}`;
          awarie.blad('most-gt', bladDok, { ruchId, artykul: ruch.artykul_gt_id });
        } else if (istn) {
          // Dokument juz istnieje - poprzednia proba przeszla mimo zgubionej odpowiedzi. Adoptuj
          // (numer + dok_Id), zamiast wystawiac drugi. To domyka gwarancje "numer WMS == numer GT".
          wystawiac = false;
          db.prepare('UPDATE ruchy SET dok_gt_numer = ?, dok_gt_id = ? WHERE id = ?').run(istn.dok_NrPelny, istn.dok_Id, ruchId);
          awarie.blad('most-gt', `Adoptowano istniejacy dokument MM ${istn.dok_NrPelny} dla ruchu #${ruchId} (prewencja duplikatu - zgubiona odpowiedz HTTP przy poprzedniej probie)`, { ruchId });
        }
      }

      if (!wystawiac) {
        // nic wiecej: albo adoptowalismy dokument (dok_gt_numer ustawiony, dokOk zostaje true),
        // albo wstrzymalismy z powodu braku GT SQL (dokOk juz false).
      } else {
        db.prepare('UPDATE ruchy SET mm_proby = mm_proby + 1 WHERE id = ?').run(ruchId);
        const odpowiedz = await gtBridge.wystawMM({
          artykul_gt_id: ruch.artykul_gt_id,
          magazyn_zrodlowy: magazynZrodlowy,
          magazyn_docelowy: magazynDocelowy,
          magazyn_zrodlowy_id: magZrodloId,
          magazyn_docelowy_id: magCelId,
          ilosc: ruch.ilosc,
          operator: ruch.operator,
          // klucz idempotencji + kto/kiedy -> dok_Uwagi (data_ruchu = realny czas przesuniecia)
          uwagi: gtDokumenty.budujUwagiMM(ruchId, ruch.operator, ruch.data_ruchu),
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
