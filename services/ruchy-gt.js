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
const { magazynyRuchu } = require('./ruchy-model');
const { MAGAZYN_GT_ID } = require('../config/magazyny');
const { klasyfikujOdpowiedzMostu, czyWstrzymac, dopasujPowtorzenie, czyPowtorzenieZamykaRuch } = require('./ruchy-kolejka');

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

// Opis ruchu w postaci, ktora rozumie services/ruchy-kolejka.js (magazyny sprowadzone do
// symboli, niezaleznie od tego, czy stoja w lokalizacji WMS, w polu "zewnetrzny" czy w puli).
const RUCH_Z_MAGAZYNAMI = `
  SELECT r.id, r.artykul_gt_id, r.ilosc, r.status, r.data_ruchu,
         COALESCE(lz.magazyn, r.mag_zrodlo_zewnetrzny, r.mag_zrodlo_pula) AS mag_zrodlo,
         COALESCE(lc.magazyn, r.mag_cel_zewnetrzny) AS mag_cel
  FROM ruchy r
  LEFT JOIN lokalizacje lz ON lz.id = r.lok_zrodlo_id
  LEFT JOIN lokalizacje lc ON lc.id = r.lok_cel_id
  WHERE r.id = ?`;

// Czy magazynier zrobil to samo przesuniecie jeszcze raz, recznie? Zwraca { ruchId, dokNr,
// data_ruchu } albo null. Pytanie ma sens dopiero przy PONOWIENIU: swiezy ruch nie moze byc
// duplikatem samego siebie.
//
// Dlaczego to w ogole istnieje (incydent NERG0319, 2026-08-28): gdy MM odbije sie od Sfery,
// magazynier widzi blad i powtarza operacje od nowa - nie czeka na job. Powstaje drugi ruch,
// ktory zabiera towar, a pierwszy zostaje w kolejce bez szans: kazde ponowienie dostaje juz
// "Brak towaru na magazynie zrodlowym" i zapala alarm Sfery w calym WMS.
//
// GT SQL niedostepny -> null (nie zgadujemy; ruch po prostu zostaje w kolejce jak dotad).
async function znajdzRecznePowtorzenie(ruch, magZrodlo, magCel, magZrodloId) {
  const kandydaci = await gtDokumenty.znajdzPowtorzeniaMM({
    ruchId: ruch.id,
    artykulGtId: ruch.artykul_gt_id,
    magZrodloId,
    ilosc: ruch.ilosc,
    dataRuchu: ruch.data_ruchu,
  });
  if (!Array.isArray(kandydaci) || !kandydaci.length) return null;

  // Dokument mowi tylko "to byl ruch #N". Reszte dowodu (kierunek, status, okno czasowe)
  // czytamy z WMS i oceniamy czysta regula - patrz services/ruchy-kolejka.js.
  const zDanymi = kandydaci
    .map((k) => {
      const w = db.prepare(RUCH_Z_MAGAZYNAMI).get(k.ruchId);
      return w ? { ...w, ruchId: k.ruchId, dokNr: k.dok_NrPelny } : null;
    })
    .filter(Boolean);

  return dopasujPowtorzenie(
    { id: ruch.id, artykul_gt_id: ruch.artykul_gt_id, ilosc: ruch.ilosc, data_ruchu: ruch.data_ruchu, mag_zrodlo: magZrodlo, mag_cel: magCel },
    zDanymi
  );
}

async function wykonajRuchGTWewn(ruchId) {
  const ruch = db.prepare('SELECT * FROM ruchy WHERE id = ?').get(ruchId);
  if (!ruch) throw new Error(`Ruch ${ruchId} nie istnieje`);

  const zrodlo = ruch.lok_zrodlo_id ? db.prepare('SELECT * FROM lokalizacje WHERE id = ?').get(ruch.lok_zrodlo_id) : null;
  const cel = ruch.lok_cel_id ? db.prepare('SELECT * FROM lokalizacje WHERE id = ?').get(ruch.lok_cel_id) : null;

  let dokOk = true;
  let bladDok = null;
  // Ile razy Sfera odmowila temu ruchowi (licznik z bazy; brak polaczenia z mostem go nie rusza).
  let odmowySfery = ruch.mm_odmowy ?? 0;

  if (ruch.typ === 'MM' && !ruch.dok_gt_numer) {
    // Zrodlo bez lokalizacji WMS: magazyn zewnetrzny (przyjecie z MAG/LS) albo nieprzypisana
    // pula magazynu WMS (dostawa lezy wg GT na K4, nie ma jeszcze miejsca w WMS).
    const magazynZrodlowy = zrodlo ? zrodlo.magazyn : (ruch.mag_zrodlo_zewnetrzny || ruch.mag_zrodlo_pula);
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
        } else {
          // Naszego dokumentu nie ma. Zanim wystawimy kolejny MM: czy magazynier nie powtorzyl
          // tego przesuniecia recznie (nowy ruch, ten sam towar/kierunek/ilosc)? Jesli tak, ten
          // ruch jest juz nieaktualny - towar zabral tamten dokument. Wystawienie MM teraz albo
          // odbije sie od Sfery ("brak towaru") i bedzie zapalac alarm w kolko, albo - gdyby stan
          // wrocil - przesunelo by towar DRUGI RAZ. Zamykamy jako 'duplikat'.
          const powtorzenie = await znajdzRecznePowtorzenie(ruch, magazynZrodlowy, magazynDocelowy, magZrodloId);
          if (powtorzenie) {
            // Stanow WMS nie ruszamy w zadnym wariancie - tu decydujemy tylko, czy sprawa jest
            // zamknieta, czy trafia do czlowieka (czyPowtorzenieZamykaRuch wyjasnia dlaczego).
            const zamkniety = czyPowtorzenieZamykaRuch(ruch);
            const skad = `to samo przesuniecie wykonal ruch #${powtorzenie.ruchId}`
              + `${powtorzenie.dokNr ? ` (${powtorzenie.dokNr})` : ''}`;
            const opis = zamkniety
              ? `Zamkniety jako duplikat: ${skad}. Stany WMS bez zmian, MM nie zostal wystawiony.`
              : `Wyglada na powtorzenie: ${skad}. MM nie zostal wystawiony, ponawianie zatrzymane`
                + ' - sprawdz stany i albo usun ten ruch (cofnie zmiane w WMS), albo kliknij "Ponow".';
            db.prepare('UPDATE ruchy SET status = ?, blad_opis = ? WHERE id = ?')
              .run(zamkniety ? 'duplikat' : 'wstrzymany', opis, ruchId);
            awarie.blad('most-gt', `Ruch #${ruchId} ${zamkniety ? 'zamkniety jako duplikat' : 'wstrzymany jako mozliwe powtorzenie'} ruchu #${powtorzenie.ruchId}`, {
              ruchId, artykul: ruch.artykul_gt_id, symbol: ruch.artykul_symbol, ilosc: ruch.ilosc,
              z: magazynZrodlowy, do: magazynDocelowy, dokument: powtorzenie.dokNr,
            });
            return db.prepare('SELECT * FROM ruchy WHERE id = ?').get(ruchId);
          }
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
          // Odmowa Sfery liczy sie do limitu ponawiania, brak polaczenia z mostem NIE. Most bywa
          // wylaczony (restart peceta, aktualizacja) i wtedy ruch ma spokojnie poczekac - to caly
          // sens kolejki. Sfera, ktora odpowiedziala "nie", sama zdania nie zmieni.
          const klasyfikacja = klasyfikujOdpowiedzMostu(odpowiedz);
          bladDok = klasyfikacja.opis;
          if (klasyfikacja.odSfery) {
            db.prepare('UPDATE ruchy SET mm_odmowy = mm_odmowy + 1 WHERE id = ?').run(ruchId);
            odmowySfery = (db.prepare('SELECT mm_odmowy FROM ruchy WHERE id = ?').get(ruchId)?.mm_odmowy) ?? 0;
          }
          // Do LOGU, nie tylko do blad_opis. Tresc bledu Sfery jest kasowana z wiersza `ruchy`
          // przy pierwszym udanym ponowieniu (status 'ok', blad_opis = NULL), wiec bez tego wpisu
          // po awarii nie zostaje zaden slad - dokladnie tak stracilismy przyczyne 2026-08-05.
          awarie.blad('most-gt', `MM nieudane: ${bladDok}`, {
            ruchId, artykul: ruch.artykul_gt_id, symbol: ruch.artykul_symbol, ilosc: ruch.ilosc,
            z: magazynZrodlowy, do: magazynDocelowy, proba: (ruch.mm_proby ?? 0) + 1, http: odpowiedz.status,
          });
        }
      }
    }
  }

  // Magazyny do przeliczenia pol GT - z lokalizacji ruchu ORAZ z puli (rozlozenie nie ma
  // lokalizacji zrodlowej). Dlaczego pula musi tu byc: services/ruchy-model.js.
  const magazyny = magazynyRuchu({
    magZrodlo: zrodlo?.magazyn,
    magCel: cel?.magazyn,
    magPula: ruch.mag_zrodlo_pula,
    wmsZnaPule: !!ruch.mag_zrodlo_pula && !!db.prepare(
      `SELECT 1 FROM stany_lokalizacji s JOIN lokalizacje l ON l.id = s.lokalizacja_id
       WHERE s.artykul_gt_id = ? AND l.magazyn = ? LIMIT 1`
    ).get(ruch.artykul_gt_id, ruch.mag_zrodlo_pula),
  });

  let lokOk = true;
  let bladLok = null;
  const wynikLok = await gtFields.synchronizujLokalizacje(ruch.artykul_gt_id, magazyny);
  if (wynikLok && !(wynikLok.ok && wynikLok.dane?.sukces)) {
    lokOk = false;
    bladLok = wynikLok.blad ?? wynikLok.dane?.blad ?? `Most GT zwrocil status ${wynikLok.status}`;
    awarie.blad('most-gt', `Sync lokalizacji GT nieudany: ${bladLok}`,
      { ruchId, artykul: ruch.artykul_gt_id, symbol: ruch.artykul_symbol, magazyny: [...magazyny] });
  }

  if (dokOk && lokOk) {
    // Udalo sie - licznik odmow zerujemy, zeby ewentualna przyszla awaria zaczynala od zera.
    db.prepare("UPDATE ruchy SET status = 'ok', blad_opis = NULL, mm_odmowy = 0 WHERE id = ?").run(ruchId);
  } else {
    const opisy = [bladDok, bladLok ? `Sync lokalizacji GT: ${bladLok}` : null].filter(Boolean);
    // Po LIMIT_ODMOW_SFERY odmowach dokumentu przestajemy ponawiac automatycznie. Ruch NIE ginie
    // (stan 'wstrzymany', przyciski "Ponow"/"Usun" w Logu) - przestaje tylko wracac co 5 minut po
    // te sama odpowiedz i zapalac alarm Sfery w calym WMS. Wstrzymuje wylacznie odmowa DOKUMENTU:
    // zalegly sync pol lokalizacyjnych nie dotyka Sfery i nic nie kosztuje przy ponowieniu.
    const wstrzymany = !dokOk && czyWstrzymac(odmowySfery);
    if (wstrzymany) {
      opisy.push(`Wstrzymano automatyczne ponawianie po ${odmowySfery} odmowach Sfery`
        + ' - usun przyczyne i kliknij "Ponow", albo usun ruch z kolejki.');
    }
    db.prepare('UPDATE ruchy SET status = ?, blad_opis = ? WHERE id = ?')
      .run(wstrzymany ? 'wstrzymany' : 'pending', opisy.join(' | '), ruchId);
  }

  return db.prepare('SELECT * FROM ruchy WHERE id = ?').get(ruchId);
}

module.exports = { wykonajRuchGT };
