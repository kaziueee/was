'use strict';

// Wspolna logika "doslania" ruchu do GT - wywolywana zarowno przy tworzeniu ruchu
// (POST /mm, /lok), jak i przy ponawianiu ruchow 'pending' (POST /:id/retry,
// services/ruchy-retry.js). Patrz CLAUDE.md "Kolejka": ruch WMS jest juz zapisany,
// tu tylko probujemy dogonic strone GT (dokument MM + pola lokalizacyjne).

const db = require('../db/database');
const gtBridge = require('./gt-bridge');
const gtFields = require('./gt-fields');

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
    const magazynDocelowy = cel ? cel.magazyn : ruch.mag_cel_zewnetrzny;
    const odpowiedz = await gtBridge.wystawMM({
      artykul_gt_id: ruch.artykul_gt_id,
      magazyn_zrodlowy: zrodlo.magazyn,
      magazyn_docelowy: magazynDocelowy,
      ilosc: ruch.ilosc,
      operator: ruch.operator,
    });

    if (odpowiedz.ok && odpowiedz.dane?.sukces) {
      db.prepare('UPDATE ruchy SET dok_gt_numer = ? WHERE id = ?').run(odpowiedz.dane.numer_dokumentu ?? null, ruchId);
    } else {
      dokOk = false;
      bladDok = odpowiedz.blad ?? odpowiedz.dane?.blad ?? `Most GT zwrocil status ${odpowiedz.status}`;
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
