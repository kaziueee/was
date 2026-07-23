const express = require('express');
const db = require('../db/database');
const { MAGAZYNY_WMS, MAGAZYNY_ZEWNETRZNE } = require('../config/magazyny');
const { wykonajRuchGT } = require('../services/ruchy-gt');
const gtFields = require('../services/gt-fields');
const { pobierzStanyGt, dostepneWGt } = require('../services/gt-produkty');
const gtDokumenty = require('../services/gt-dokumenty');
const audyt = require('../services/audyt');

const router = express.Router();

// POST /api/ruchy/mm - zapisz przesuniecie MM i wystaw dokument MM w GT przez most C#
router.post('/mm', async (req, res, next) => {
  const { artykul_gt_id, lok_zrodlo_id, lok_cel_id, mag_cel_zewnetrzny, ilosc, operator } = req.body ?? {};

  if (!artykul_gt_id) {
    return res.status(400).json({ blad: 'Pole "artykul_gt_id" jest wymagane' });
  }
  if (!Number.isInteger(lok_zrodlo_id)) {
    return res.status(400).json({ blad: 'Pole "lok_zrodlo_id" jest wymagane' });
  }
  const ilo = Number(ilosc);
  if (!Number.isFinite(ilo) || ilo <= 0) {
    return res.status(400).json({ blad: 'Pole "ilosc" musi byc liczba > 0' });
  }
  const celWMS = lok_cel_id !== undefined && lok_cel_id !== null;
  const celZewnetrzny = !!mag_cel_zewnetrzny;
  if (celWMS === celZewnetrzny) {
    return res.status(400).json({ blad: 'Podaj dokladnie jedno z: lok_cel_id (lokalizacja WMS) lub mag_cel_zewnetrzny' });
  }
  if (celZewnetrzny && !MAGAZYNY_ZEWNETRZNE.includes(String(mag_cel_zewnetrzny).trim().toUpperCase())) {
    return res.status(400).json({ blad: `Pole "mag_cel_zewnetrzny" musi byc jednym z: ${MAGAZYNY_ZEWNETRZNE.join(', ')}` });
  }

  const zrodlo = db.prepare('SELECT * FROM lokalizacje WHERE id = ?').get(lok_zrodlo_id);
  if (!zrodlo) return res.status(404).json({ blad: 'Lokalizacja zrodlowa nie istnieje' });

  const stanZrodlo = db.prepare(
    'SELECT * FROM stany_lokalizacji WHERE lokalizacja_id = ? AND artykul_gt_id = ?'
  ).get(lok_zrodlo_id, artykul_gt_id);

  if (!stanZrodlo || stanZrodlo.ilosc < ilo) {
    return res.status(409).json({
      blad: `Niewystarczajaca ilosc na lokalizacji zrodlowej (dostepne: ${stanZrodlo ? stanZrodlo.ilosc : 0})`
    });
  }

  // Zasada 6 + "K4 stan zawsze z Subiekta": z magazynu zrodlowego mozna wyprowadzic
  // najwyzej (stan GT - rezerwacja) - GT jest masterem stanow, kopia WMS bywa nieaktualna
  // (na K4 sprzedaz w Subiekcie zbija stan bez wiedzy WMS, wiec WMS potrafi byc > GT).
  // Bez tego twardego progu GT Sfera odrzucalaby MM ("brak towaru na magazynie zrodlowym")
  // i ruch wisialby 'pending' bez szans na retry. Egzekwujemy zawsze (nie tylko przy
  // rezerwacji) - chroni jednakowo Zebre i desktop.
  let dostZrodlo;
  try {
    dostZrodlo = await dostepneWGt(artykul_gt_id, zrodlo.magazyn);
  } catch (err) {
    return res.status(503).json({ blad: 'Nie mozna zweryfikowac stanu GT (baza niedostepna) - MM wstrzymane. Sprobuj ponownie.' });
  }
  if (ilo > dostZrodlo.dostepne) {
    const powod = dostZrodlo.rezerwacja > 0
      ? `stan GT ${dostZrodlo.stan}, rezerwacja ${dostZrodlo.rezerwacja} blokuje MM`
      : `stan GT ${dostZrodlo.stan}`;
    return res.status(409).json({
      blad: `W ${zrodlo.magazyn} mozna przesunac najwyzej ${Math.max(dostZrodlo.dostepne, 0)} szt. wg Subiekta (${powod}).`
    });
  }

  let cel = null;
  if (celWMS) {
    cel = db.prepare('SELECT * FROM lokalizacje WHERE id = ?').get(lok_cel_id);
    if (!cel) return res.status(404).json({ blad: 'Lokalizacja docelowa nie istnieje' });
    if (cel.id === zrodlo.id) {
      return res.status(400).json({ blad: 'Lokalizacja docelowa jest taka sama jak zrodlowa' });
    }
    if (cel.aktywna !== 1) {
      return res.status(409).json({ blad: 'Lokalizacja docelowa jest nieaktywna' });
    }
    if (cel.magazyn === zrodlo.magazyn) {
      return res.status(400).json({ blad: 'Lokalizacja docelowa jest w tym samym magazynie co zrodlowa - MM wymaga przesuniecia miedzy roznymi magazynami' });
    }
  }

  // zasada: w K4 artykul moze miec tylko jedna lokalizacje
  if (cel && cel.magazyn === 'K4') {
    const obecneK4 = db.prepare(
      `SELECT s.lokalizacja_id, s.ilosc FROM stany_lokalizacji s
       JOIN lokalizacje l ON l.id = s.lokalizacja_id
       WHERE s.artykul_gt_id = ? AND l.magazyn = 'K4' AND s.ilosc > 0`
    ).all(artykul_gt_id);

    const poRuchu = new Map(obecneK4.map((r) => [r.lokalizacja_id, r.ilosc]));
    if (zrodlo.magazyn === 'K4') {
      const pozostanie = (poRuchu.get(zrodlo.id) ?? 0) - ilo;
      if (pozostanie > 0) poRuchu.set(zrodlo.id, pozostanie);
      else poRuchu.delete(zrodlo.id);
    }
    poRuchu.set(cel.id, (poRuchu.get(cel.id) ?? 0) + ilo);

    if (poRuchu.size > 1) {
      return res.status(409).json({ blad: 'W magazynie K4 artykul moze miec tylko jedna lokalizacje (1 SKU = 1 lokalizacja)' });
    }
  }

  let ruchId;
  let magazynDocelowy;

  db.exec('BEGIN');
  try {
    magazynDocelowy = cel ? cel.magazyn : String(mag_cel_zewnetrzny).trim().toUpperCase();

    const ruch = db.prepare(`
      INSERT INTO ruchy (typ, artykul_gt_id, artykul_symbol, lok_zrodlo_id, lok_cel_id, mag_cel_zewnetrzny, ilosc, status, operator)
      VALUES ('MM', ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      artykul_gt_id,
      stanZrodlo.artykul_symbol,
      lok_zrodlo_id,
      cel ? cel.id : null,
      cel ? null : magazynDocelowy,
      ilo,
      operator ?? null
    );
    ruchId = ruch.lastInsertRowid;

    const pozostanie = stanZrodlo.ilosc - ilo;
    if (pozostanie > 0) {
      db.prepare('UPDATE stany_lokalizacji SET ilosc = ?, ostatnia_zmiana = CURRENT_TIMESTAMP, operator = ? WHERE id = ?')
        .run(pozostanie, operator ?? null, stanZrodlo.id);
    } else if (zrodlo.magazyn === 'K4') {
      // K4 to magazyn szybkiego zbioru - lokalizacja zostaje jako stale miejsce SKU do uzupelnienia
      db.prepare('UPDATE stany_lokalizacji SET ilosc = 0, ostatnia_zmiana = CURRENT_TIMESTAMP, operator = ? WHERE id = ?')
        .run(operator ?? null, stanZrodlo.id);
    } else {
      db.prepare('DELETE FROM stany_lokalizacji WHERE id = ?').run(stanZrodlo.id);
    }

    if (cel) {
      const stanCel = db.prepare('SELECT * FROM stany_lokalizacji WHERE lokalizacja_id = ? AND artykul_gt_id = ?')
        .get(cel.id, artykul_gt_id);
      if (stanCel) {
        db.prepare('UPDATE stany_lokalizacji SET ilosc = ilosc + ?, ostatnia_zmiana = CURRENT_TIMESTAMP, operator = ? WHERE id = ?')
          .run(ilo, operator ?? null, stanCel.id);
      } else {
        db.prepare(`
          INSERT INTO stany_lokalizacji (lokalizacja_id, artykul_gt_id, artykul_symbol, artykul_nazwa, artykul_ean, ilosc, operator)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(cel.id, artykul_gt_id, stanZrodlo.artykul_symbol, stanZrodlo.artykul_nazwa, stanZrodlo.artykul_ean, ilo, operator ?? null);
      }

      if (cel.magazyn === 'K4') {
        // SKU ma teraz stale miejsce w cel.id - usun ewentualny stary, oprozniony wpis w innej lokalizacji K4
        db.prepare(`
          DELETE FROM stany_lokalizacji
          WHERE artykul_gt_id = ? AND ilosc = 0 AND lokalizacja_id != ?
            AND lokalizacja_id IN (SELECT id FROM lokalizacje WHERE magazyn = 'K4')
        `).run(artykul_gt_id, cel.id);
      }
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return next(err);
  }

  // ruch zapisany jako 'pending' - teraz probujemy dogonic strone GT (dokument MM
  // + pola lokalizacyjne). Blad Sfery nie cofa ruchu w WMS - ruch zostaje 'pending'
  // z opisem bledu (do retry przez POST /:id/retry lub job ponawiania).
  try {
    const wynikRuch = await wykonajRuchGT(ruchId);
    audyt.zapisz({
      uzytkownik: operator, akcja: 'MM', artykul_gt_id, artykul_symbol: stanZrodlo.artykul_symbol,
      magazyn: zrodlo.magazyn, lokalizacja: `${zrodlo.kod} → ${cel ? cel.kod : magazynDocelowy}`,
      ilosc: ilo, wynik: wynikRuch.status, ruch_id: ruchId, dok_gt_numer: wynikRuch.dok_gt_numer,
    });
    res.status(201).json(wynikRuch);
  } catch (err) {
    next(err);
  }
});

// POST /api/ruchy/lok - zmiana lokalizacji w ramach tego samego magazynu (bez dokumentu GT),
// albo - gdy lok_zrodlo_id = null - przypisanie pierwszej lokalizacji w WMS produktowi,
// ktory ma juz stan w GT, ale nie ma jeszcze zadnej lokalizacji w WMS (wymaga wtedy
// artykul_symbol/artykul_nazwa w body, bo nie ma skad ich wziac ze stanu zrodlowego)
router.post('/lok', async (req, res, next) => {
  const { artykul_gt_id, lok_zrodlo_id, lok_cel_id, ilosc, operator, artykul_symbol, artykul_nazwa, artykul_ean } = req.body ?? {};

  if (!artykul_gt_id) {
    return res.status(400).json({ blad: 'Pole "artykul_gt_id" jest wymagane' });
  }
  const maZrodlo = lok_zrodlo_id !== undefined && lok_zrodlo_id !== null;
  if (maZrodlo && !Number.isInteger(lok_zrodlo_id)) {
    return res.status(400).json({ blad: 'Pole "lok_zrodlo_id" musi byc liczba calkowita lub null' });
  }
  if (!Number.isInteger(lok_cel_id)) {
    return res.status(400).json({ blad: 'Pole "lok_cel_id" jest wymagane' });
  }
  const ilo = Number(ilosc);
  if (!Number.isFinite(ilo) || ilo <= 0) {
    return res.status(400).json({ blad: 'Pole "ilosc" musi byc liczba > 0' });
  }
  if (!maZrodlo && (!artykul_symbol || !artykul_nazwa)) {
    return res.status(400).json({ blad: 'Pola "artykul_symbol" i "artykul_nazwa" sa wymagane, gdy produkt nie ma jeszcze lokalizacji w WMS (lok_zrodlo_id = null)' });
  }

  let zrodlo = null;
  let stanZrodlo = null;
  if (maZrodlo) {
    zrodlo = db.prepare('SELECT * FROM lokalizacje WHERE id = ?').get(lok_zrodlo_id);
    if (!zrodlo) return res.status(404).json({ blad: 'Lokalizacja zrodlowa nie istnieje' });

    stanZrodlo = db.prepare(
      'SELECT * FROM stany_lokalizacji WHERE lokalizacja_id = ? AND artykul_gt_id = ?'
    ).get(lok_zrodlo_id, artykul_gt_id);

    // K4: stan WMS moze byc nieaktualny - sprzedaz/MM w Subiekcie zmienia stan GT
    // bez wiedzy WMS. Dla K4 ilosc pochodzi z GT, nie sprawdzamy dostepnosci w WMS.
    if (zrodlo.magazyn !== 'K4' && (!stanZrodlo || stanZrodlo.ilosc < ilo)) {
      return res.status(409).json({
        blad: `Niewystarczajaca ilosc na lokalizacji zrodlowej (dostepne: ${stanZrodlo ? stanZrodlo.ilosc : 0})`
      });
    }
  }

  const cel = db.prepare('SELECT * FROM lokalizacje WHERE id = ?').get(lok_cel_id);
  if (!cel) return res.status(404).json({ blad: 'Lokalizacja docelowa nie istnieje' });

  if (zrodlo && cel.id === zrodlo.id) {
    return res.status(400).json({ blad: 'Nowa lokalizacja jest taka sama jak obecna' });
  }
  if (cel.aktywna !== 1) {
    return res.status(409).json({ blad: 'Nowa lokalizacja jest nieaktywna' });
  }
  if (zrodlo && cel.magazyn !== zrodlo.magazyn) {
    return res.status(400).json({ blad: 'Nowa lokalizacja musi byc w tym samym magazynie - przesuniecie miedzy magazynami zrob przez MM' });
  }

  // K4 = 1 SKU = 1 lokalizacja: zmiana lokalizacji przenosi CALA ilosc. Czesciowy LOK na K4
  // skasowalby zrodlo i zostawil tylko czesc w celu -> WMS K4 < GT. Odrzucamy w backendzie.
  if (zrodlo && zrodlo.magazyn === 'K4' && stanZrodlo && ilo !== stanZrodlo.ilosc) {
    return res.status(400).json({ blad: `W magazynie K4 zmiana lokalizacji przenosi cala ilosc (${stanZrodlo.ilosc} szt.) - 1 SKU = 1 lokalizacja` });
  }

  if (!zrodlo && cel.magazyn === 'K4') {
    // 1 SKU = 1 lokalizacja: blokujemy tylko gdy SKU ma INNA lokalizacje K4 niz cel.
    // Dokladanie nieprzypisanego stanu do TEJ SAMEJ istniejacej lokalizacji K4 (cel)
    // jest OK - zostaje jedna lokalizacja (rekoncyliacja np. po uzupelnieniu GT).
    const inna = db.prepare(
      `SELECT l.kod FROM stany_lokalizacji s
       JOIN lokalizacje l ON l.id = s.lokalizacja_id
       WHERE s.artykul_gt_id = ? AND l.magazyn = 'K4' AND s.ilosc > 0 AND l.id != ?`
    ).get(artykul_gt_id, cel.id);
    if (inna) {
      return res.status(409).json({ blad: `Artykul ma juz lokalizacje w K4 (${inna.kod}) - 1 SKU = 1 lokalizacja` });
    }
  }

  // Stara lokalizacja GT (do historii ruchow) - przypisanie z "nieprzypisane" moze nadpisac
  // pole GT, gdy deficyt spadnie do 0; zapisujemy poprzednia wartosc, by byla odzyskiwalna.
  let staraLokGt = null;

  // Inwariant: suma WMS <= stan GT per magazyn. Przy przypisaniu (bez zrodla) nie wolno
  // zaklepac wiecej niz GT ma jeszcze nieprzypisane w docelowym magazynie - inaczej powstaje
  // fantomowy stan WMS > GT (rozjazd). Walidacja w backendzie chroni jednakowo Zebre i desktop.
  if (!zrodlo) {
    let gtStan;
    try {
      const stany = await pobierzStanyGt([artykul_gt_id]);
      gtStan = stany.get(String(artykul_gt_id))?.[cel.magazyn]?.ilosc ?? 0;
    } catch (err) {
      return res.status(503).json({ blad: 'Nie mozna zweryfikowac stanu GT (most niedostepny) - przypisanie wstrzymane. Sprobuj ponownie.' });
    }
    const sumaWMS = db.prepare(
      `SELECT COALESCE(SUM(s.ilosc), 0) AS suma FROM stany_lokalizacji s
       JOIN lokalizacje l ON l.id = s.lokalizacja_id
       WHERE s.artykul_gt_id = ? AND l.magazyn = ?`
    ).get(artykul_gt_id, cel.magazyn).suma;
    const deficyt = gtStan - sumaWMS;
    if (ilo > deficyt) {
      return res.status(409).json({
        blad: `Mozna przypisac najwyzej ${Math.max(deficyt, 0)} szt. w ${cel.magazyn} (GT: ${gtStan}, juz w WMS: ${sumaWMS}). Nie da sie zaklepac wiecej niz jest w GT.`,
      });
    }
    // K4 = 1 SKU = 1 lokalizacja = CALA ilosc. Czesciowe pierwsze przypisanie zostawiloby
    // K4 z niepelnym stanem, a kolejne przypisanie blokuje "juz ma lokalizacje K4" -> zakleszczenie.
    // Wymagamy calej dostepnej ilosci, tak jak przy zmianie lokalizacji K4 (1 SKU = 1 lokalizacja).
    //
    // "Cala ilosc" NIE obejmuje jednak nierozlozonej dostawy ani zwrotu czekajacego w strefie:
    // te sztuki wg GT sa na K4, ale fizycznie leza na palecie / w strefie zwrotow i NIE MOGA
    // byc na polce pickowej. Zadanie "przypisz wszystkie 30" przy dostawie 20 w drodze bylo
    // wiec zadaniem wpisania nieprawdy - i wiazalo niezalezne rzeczy w kolejnosc (stary stan
    // dopiero PO dostawie). Odejmujemy oba kubelki, dzieki czemu kazdy rozklada sie osobno
    // i w dowolnej kolejnosci (zob. POST /rozloz).
    if (cel.magazyn === 'K4') {
      let doPrzypisania = 0;
      let opisKubelkow = [];
      try {
        const dok = (await gtDokumenty.pobierzDostawyK4([artykul_gt_id])).get(String(artykul_gt_id)) || [];
        const r = gtDokumenty.rozbijStanK4(gtStan, sumaWMS, dok, { artykul_gt_id });
        // `reszta` to dokladnie to, co wolno przypisac na polke: stan GT minus strefy minus
        // to, co WMS juz zna. Wczesniej liczone recznie jako `deficyt - wDrodze` - ta sama
        // liczba, ale teraz definicja jest w jednym miejscu (i pokryta testami).
        doPrzypisania = r.reszta;
        const sumy = [
          [r.dostawy, 'z nierozlozonej dostawy'],
          [r.zwroty, 'ze zwrotu w strefie'],
          [r.przywozki, 'z przywozki w strefie'],
        ];
        opisKubelkow = sumy
          .map(([lista, opis]) => [lista.reduce((s, d) => s + d.ilosc, 0), opis])
          .filter(([ile]) => ile > 0)
          .map(([ile, opis]) => `${ile} szt. ${opis}`);
      } catch (err) {
        return res.status(503).json({ blad: 'Nie mozna sprawdzic dostaw w GT - przypisanie wstrzymane. Sprobuj ponownie.' });
      }
      if (doPrzypisania <= 0) {
        return res.status(409).json({
          blad: `Caly nieprzypisany stan K4 (${deficyt} szt.) to ${opisKubelkow.join(' i ')} - rozloz to z wlasciwego wiersza, nie przypisuj na polke.`,
        });
      }
      if (ilo !== doPrzypisania) {
        const bez = opisKubelkow.length > 0 ? ` (bez ${opisKubelkow.join(' i ')})` : '';
        return res.status(400).json({ blad: `W magazynie K4 przypisz cala ilosc (${doPrzypisania} szt.)${bez} - 1 SKU = 1 lokalizacja` });
      }
    }

    // Odczyt obecnej lokalizacji GT PRZED nadpisaniem (K4 -> tw_Pole1, K4G -> tw_Pole8).
    try {
      const pola = await gtFields.pobierzAktualnePolaLokalizacji([artykul_gt_id]);
      const p = pola.get(String(artykul_gt_id));
      // bez dopisku stref - do audytu idzie POPRZEDNIA LOKALIZACJA, a " +Z3" nia nie jest
      const stara = cel.magazyn === 'K4'
        ? gtFields.bezAdnotacjiStref(p?.tw_Pole1)
        : (p?.tw_Pole8 || '').trim();
      if (stara) staraLokGt = stara;
    } catch { /* GT niedostepne - bez zapisu starej lok, nie blokujemy ruchu */ }
  }

  const symbol = stanZrodlo ? stanZrodlo.artykul_symbol : artykul_symbol;
  const nazwa = stanZrodlo ? stanZrodlo.artykul_nazwa : artykul_nazwa;
  const ean = stanZrodlo ? stanZrodlo.artykul_ean : (artykul_ean ?? null);

  let ruchId;

  db.exec('BEGIN');
  try {
    const ruch = db.prepare(`
      INSERT INTO ruchy (typ, artykul_gt_id, artykul_symbol, lok_zrodlo_id, lok_cel_id, ilosc, status, operator)
      VALUES ('LOK', ?, ?, ?, ?, ?, 'pending', ?)
    `).run(artykul_gt_id, symbol, zrodlo ? lok_zrodlo_id : null, lok_cel_id, ilo, operator ?? null);
    ruchId = ruch.lastInsertRowid;

    if (stanZrodlo) {
      const pozostanie = stanZrodlo.ilosc - ilo;
      // K4: zawsze usuwamy stary wpis - SKU ma jedno stale miejsce, ilosc pochodzi z GT
      if (pozostanie > 0 && zrodlo?.magazyn !== 'K4') {
        db.prepare('UPDATE stany_lokalizacji SET ilosc = ?, ostatnia_zmiana = CURRENT_TIMESTAMP, operator = ? WHERE id = ?')
          .run(pozostanie, operator ?? null, stanZrodlo.id);
      } else {
        db.prepare('DELETE FROM stany_lokalizacji WHERE id = ?').run(stanZrodlo.id);
      }
    } else if (zrodlo?.magazyn === 'K4') {
      // Brak wpisu WMS w podanej lokalizacji K4 - wyczysc wszystkie stale miejsca K4 tego artykulu
      db.prepare(`
        DELETE FROM stany_lokalizacji
        WHERE artykul_gt_id = ? AND lokalizacja_id IN (SELECT id FROM lokalizacje WHERE magazyn = 'K4')
      `).run(artykul_gt_id);
    }

    // K4 ZE ZRODLEM (przenies): nadpisz ilo - SKU ma jedno stale miejsce = cala ilosc.
    // K4 BEZ zrodla (przypisanie z puli nieprzypisanych): DODAJ do istniejacego stanu
    // celu - inaczej dokladanie deficytu do lokalizacji, ktora juz cos ma, gubiloby
    // obecny stan (np. B11 2 + przypisane 22 = 24, nie 22). Dla K4G zawsze dodaj.
    const stanCel = db.prepare('SELECT * FROM stany_lokalizacji WHERE lokalizacja_id = ? AND artykul_gt_id = ?')
      .get(lok_cel_id, artykul_gt_id);
    if (stanCel) {
      const nowaIlosc = (cel.magazyn === 'K4' && zrodlo) ? ilo : stanCel.ilosc + ilo;
      db.prepare('UPDATE stany_lokalizacji SET ilosc = ?, ostatnia_zmiana = CURRENT_TIMESTAMP, operator = ? WHERE id = ?')
        .run(nowaIlosc, operator ?? null, stanCel.id);
    } else {
      db.prepare(`
        INSERT INTO stany_lokalizacji (lokalizacja_id, artykul_gt_id, artykul_symbol, artykul_nazwa, artykul_ean, ilosc, operator)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(lok_cel_id, artykul_gt_id, symbol, nazwa, ean, ilo, operator ?? null);
    }

    // Dla nowej pierwszej lokalizacji K4: wyczysc stare puste wpisy
    if (!zrodlo && cel.magazyn === 'K4') {
      db.prepare(`
        DELETE FROM stany_lokalizacji
        WHERE artykul_gt_id = ? AND ilosc = 0 AND lokalizacja_id != ?
          AND lokalizacja_id IN (SELECT id FROM lokalizacje WHERE magazyn = 'K4')
      `).run(artykul_gt_id, cel.id);
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return next(err);
  }

  // LOK nie generuje dokumentu GT - status 'ok'/'pending' zalezy wylacznie od synchronizacji pol lokalizacyjnych
  try {
    const wynikRuch = await wykonajRuchGT(ruchId);
    audyt.zapisz({
      uzytkownik: operator, akcja: zrodlo ? 'LOK' : 'przypisanie', artykul_gt_id, artykul_symbol: symbol,
      magazyn: cel.magazyn, lokalizacja: `${zrodlo ? zrodlo.kod : '(nieprzypisane)'} → ${cel.kod}`,
      ilosc: ilo, wynik: wynikRuch.status, ruch_id: ruchId,
      przed: staraLokGt ? { stara_lok_gt: staraLokGt } : null,
    });
    res.status(201).json(wynikRuch);
  } catch (err) {
    next(err);
  }
});

// POST /api/ruchy/przyjecie - przyjecie towaru z magazynu zewnetrznego (MAG/LS) do
// lokalizacji WMS (K4/K4G). Nie wymaga lok_zrodlo_id (zewnetrzny nie ma lokalizacji WMS).
// Tworzy MM w GT przez most i dodaje stan do lokalizacji docelowej.
router.post('/przyjecie', async (req, res, next) => {
  const { artykul_gt_id, mag_zrodlo_zewnetrzny, lok_cel_id, ilosc, operator,
          artykul_symbol, artykul_nazwa, artykul_ean } = req.body ?? {};

  if (!artykul_gt_id) return res.status(400).json({ blad: 'Pole "artykul_gt_id" jest wymagane' });
  if (!mag_zrodlo_zewnetrzny || !MAGAZYNY_ZEWNETRZNE.includes(String(mag_zrodlo_zewnetrzny).trim().toUpperCase())) {
    return res.status(400).json({ blad: `Pole "mag_zrodlo_zewnetrzny" musi byc jednym z: ${MAGAZYNY_ZEWNETRZNE.join(', ')}` });
  }
  if (!Number.isInteger(lok_cel_id)) return res.status(400).json({ blad: 'Pole "lok_cel_id" jest wymagane' });
  const ilo = Number(ilosc);
  if (!Number.isFinite(ilo) || ilo <= 0) return res.status(400).json({ blad: 'Pole "ilosc" musi byc liczba > 0' });

  const zrodloMag = String(mag_zrodlo_zewnetrzny).trim().toUpperCase();

  const cel = db.prepare('SELECT * FROM lokalizacje WHERE id = ?').get(lok_cel_id);
  if (!cel) return res.status(404).json({ blad: 'Lokalizacja docelowa nie istnieje' });
  if (cel.aktywna !== 1) return res.status(409).json({ blad: 'Lokalizacja docelowa jest nieaktywna' });
  if (!['K4', 'K4G'].includes(cel.magazyn)) {
    return res.status(400).json({ blad: 'Przyjecie moze trafic tylko do magazynu WMS (K4/K4G)' });
  }

  if (cel.magazyn === 'K4') {
    const obecneK4 = db.prepare(
      `SELECT s.lokalizacja_id FROM stany_lokalizacji s
       JOIN lokalizacje l ON l.id = s.lokalizacja_id
       WHERE s.artykul_gt_id = ? AND l.magazyn = 'K4' AND s.ilosc > 0 AND s.lokalizacja_id != ?`
    ).all(artykul_gt_id, lok_cel_id);
    if (obecneK4.length > 0) {
      return res.status(409).json({ blad: 'W magazynie K4 artykul moze miec tylko jedna lokalizacje - towar juz istnieje w innym miejscu K4' });
    }
  }

  // Inwariant WMS<=GT: nie wolno przyjac do WMS wiecej niz GT ma w magazynie zrodlowym (MAG/LS).
  // Inaczej WMS K4/K4G rosnie ponad stan GT (rozjazd). Walidacja w backendzie chroni oba klienty.
  // Inwariant uwzglednia tez zasade 6: rezerwacje GT blokuja MM, wiec przyjac mozna
  // najwyzej (stan - rezerwacja) z magazynu zrodlowego.
  let gtZrodla;
  try {
    gtZrodla = await dostepneWGt(artykul_gt_id, zrodloMag);
  } catch (err) {
    return res.status(503).json({ blad: 'Nie mozna zweryfikowac stanu GT (most niedostepny) - przyjecie wstrzymane. Sprobuj ponownie.' });
  }
  if (ilo > gtZrodla.dostepne) {
    const dodatek = gtZrodla.rezerwacja > 0 ? ` (stan ${gtZrodla.stan}, rezerwacja ${gtZrodla.rezerwacja} blokuje MM)` : '';
    return res.status(409).json({ blad: `W magazynie ${zrodloMag} mozna przyjac najwyzej ${Math.max(gtZrodla.dostepne, 0)} szt. wg GT${dodatek} - nie mozna przyjac ${ilo}.` });
  }

  // potrzebujemy symbolu/nazwy do wpisania w stany_lokalizacji
  const symbolDoWpisu = artykul_symbol
    ?? db.prepare("SELECT artykul_symbol FROM stany_lokalizacji WHERE artykul_gt_id = ? LIMIT 1").get(artykul_gt_id)?.artykul_symbol
    ?? String(artykul_gt_id);
  const nazwaDoWpisu = artykul_nazwa
    ?? db.prepare("SELECT artykul_nazwa FROM stany_lokalizacji WHERE artykul_gt_id = ? LIMIT 1").get(artykul_gt_id)?.artykul_nazwa
    ?? '';
  const eanDoWpisu = artykul_ean
    ?? db.prepare("SELECT artykul_ean FROM stany_lokalizacji WHERE artykul_gt_id = ? LIMIT 1").get(artykul_gt_id)?.artykul_ean
    ?? null;

  let ruchId;
  db.exec('BEGIN');
  try {
    const ruch = db.prepare(`
      INSERT INTO ruchy (typ, artykul_gt_id, artykul_symbol, lok_zrodlo_id, lok_cel_id, mag_zrodlo_zewnetrzny, ilosc, status, operator)
      VALUES ('MM', ?, ?, NULL, ?, ?, ?, 'pending', ?)
    `).run(artykul_gt_id, symbolDoWpisu, lok_cel_id, zrodloMag, ilo, operator ?? null);
    ruchId = ruch.lastInsertRowid;

    const stanCel = db.prepare('SELECT * FROM stany_lokalizacji WHERE lokalizacja_id = ? AND artykul_gt_id = ?')
      .get(lok_cel_id, artykul_gt_id);
    if (stanCel) {
      db.prepare('UPDATE stany_lokalizacji SET ilosc = ilosc + ?, ostatnia_zmiana = CURRENT_TIMESTAMP, operator = ? WHERE id = ?')
        .run(ilo, operator ?? null, stanCel.id);
    } else {
      db.prepare(`
        INSERT INTO stany_lokalizacji (lokalizacja_id, artykul_gt_id, artykul_symbol, artykul_nazwa, artykul_ean, ilosc, operator)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(lok_cel_id, artykul_gt_id, symbolDoWpisu, nazwaDoWpisu, eanDoWpisu, ilo, operator ?? null);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return next(err);
  }

  try {
    const wynikRuch = await wykonajRuchGT(ruchId);
    audyt.zapisz({
      uzytkownik: operator, akcja: 'przyjecie', artykul_gt_id, artykul_symbol: symbolDoWpisu,
      magazyn: cel.magazyn, lokalizacja: `${zrodloMag} → ${cel.kod}`,
      ilosc: ilo, wynik: wynikRuch.status, ruch_id: ruchId, dok_gt_numer: wynikRuch.dok_gt_numer,
    });
    res.status(201).json(wynikRuch);
  } catch (err) {
    next(err);
  }
});

// POST /api/ruchy/rozloz - rozklada NIEPRZYPISANA pule magazynu WMS (w praktyce: dostawe,
// ktora wg GT lezy na K4, ale fizycznie stoi na palecie i nie ma jeszcze miejsca w WMS).
// Cel dowolny i w dowolnych porcjach: czesc moze zostac na dole (K4), reszta jechac na gore
// (K4G), w tylu ratach, ile jest palet.
//
// Dwie operacje pod jednym adresem - o tym decyduje magazyn CELU, nie osobny endpoint:
//   cel w INNYM magazynie (K4 -> K4G) = MM, bo towar zmienia magazyn -> dokument w GT
//   cel w TYM SAMYM magazynie (pula K4 -> polka K4) = LOK, bo wg GT towar juz tam lezy;
//     zmienia sie tylko to, ze WMS wreszcie wie GDZIE. Zaden dokument nie jest potrzebny
//     (CLAUDE.md: LOK = "lokalizowanie po PZ/FZ, bez dokumentu GT").
//
// Po co osobna sciezka zamiast "przypisz, potem zrob MM":
// Dostawa fizycznie nie dotyka polki pickowej - PZ ksieguje ja na K4, ale paleta jedzie od
// razu na gore. Droga dwukrokowa (przypisz cala dostawe na D3 -> MM z D3 na K4G) przeprowadza
// WMS przez stan, w ktorym polka na 20 szt. rzekomo trzyma 4757. Gdy magazynier przerwie miedzy
// krokami, GT i WMS sa ZGODNE (bo przypisanie podbilo kopie), wiec job rozjazdow widzi roznice
// zero i zamraza to klamstwo na stale - nic go juz nie wykryje. Tutaj zrodlo nie ma lokalizacji,
// wiec kopia WMS polki nie jest ruszana i stanu posredniego po prostu nie ma.
//
// UWAGA - czym to sie rozni od POST /ruchy/lok: tam przypisanie na K4 musi objac CALA
// nieprzypisana ilosc ("1 SKU = 1 lokalizacja = caly stan K4"). Tutaj czesciowe jest
// DOZWOLONE i to jest sedno: w trakcie dostawy WMS K4 z zalozenia jest mniejsze od stanu GT,
// bo reszta stoi na palecie. Zasada "1 SKU = 1 lokalizacja" NIE jest tu naruszona - nadal
// wolno dolozyc wylacznie do tego jednego miejsca K4 (nizej: 409 przy innej lokalizacji).
//
// Inwarianty: (1) ilosc <= deficyt magazynu zrodlowego (stan GT - suma WMS) - inaczej po ruchu
// zrobiloby sie GT < WMS i auto-korekta scielaby polke, gubiac stan, ktorego nikt nie ruszal;
// (2) tylko dla MM: ilosc <= stan GT - rezerwacja (zasada 6) - inaczej Sfera odrzuca dokument
// i ruch wisi pending. Przy LOK nic z magazynu nie wychodzi, wiec rezerwacja nie ogranicza.
router.post('/rozloz', async (req, res, next) => {
  const { artykul_gt_id, mag_zrodlo_pula, zrodlo_dok, lok_cel_id, ilosc, operator,
          artykul_symbol, artykul_nazwa, artykul_ean, przenies_dom } = req.body ?? {};

  if (!artykul_gt_id) return res.status(400).json({ blad: 'Pole "artykul_gt_id" jest wymagane' });
  const zrodloMag = String(mag_zrodlo_pula ?? '').trim().toUpperCase();
  if (!MAGAZYNY_WMS.includes(zrodloMag)) {
    return res.status(400).json({ blad: `Pole "mag_zrodlo_pula" musi byc jednym z: ${MAGAZYNY_WMS.join(', ')}` });
  }
  if (!Number.isInteger(lok_cel_id)) return res.status(400).json({ blad: 'Pole "lok_cel_id" jest wymagane' });
  const ilo = Number(ilosc);
  if (!Number.isFinite(ilo) || ilo <= 0) return res.status(400).json({ blad: 'Pole "ilosc" musi byc liczba > 0' });

  const cel = db.prepare('SELECT * FROM lokalizacje WHERE id = ?').get(lok_cel_id);
  if (!cel) return res.status(404).json({ blad: 'Lokalizacja docelowa nie istnieje' });
  if (cel.aktywna !== 1) return res.status(409).json({ blad: 'Lokalizacja docelowa jest nieaktywna' });
  if (!MAGAZYNY_WMS.includes(cel.magazyn)) {
    return res.status(400).json({ blad: 'Rozlozenie moze trafic tylko do magazynu WMS (K4/K4G)' });
  }
  // Magazyn celu decyduje o operacji: inny = MM (dokument w GT), ten sam = LOK (samo
  // wskazanie miejsca, towar wg GT juz tam jest).
  const typRuchu = cel.magazyn === zrodloMag ? 'LOK' : 'MM';

  if (cel.magazyn === 'K4') {
    const inna = db.prepare(
      `SELECT l.kod FROM stany_lokalizacji s
       JOIN lokalizacje l ON l.id = s.lokalizacja_id
       WHERE s.artykul_gt_id = ? AND l.magazyn = 'K4' AND s.ilosc > 0 AND l.id != ?`
    ).get(artykul_gt_id, lok_cel_id);
    if (inna) {
      return res.status(409).json({ blad: `Artykul ma juz lokalizacje w K4 (${inna.kod}) - 1 SKU = 1 lokalizacja` });
    }
  }

  let gtZrodla;
  try {
    gtZrodla = await dostepneWGt(artykul_gt_id, zrodloMag);
  } catch (err) {
    return res.status(503).json({ blad: 'Nie mozna zweryfikowac stanu GT (most niedostepny) - rozlozenie wstrzymane. Sprobuj ponownie.' });
  }
  const sumaWms = db.prepare(
    `SELECT COALESCE(SUM(s.ilosc), 0) AS suma FROM stany_lokalizacji s
     JOIN lokalizacje l ON l.id = s.lokalizacja_id
     WHERE s.artykul_gt_id = ? AND l.magazyn = ?`
  ).get(artykul_gt_id, zrodloMag).suma;

  const deficyt = gtZrodla.stan - sumaWms;

  // USUNIETY inwariant `ilo <= deficyt` (2026-07-17). Bronil kopii polki: "inaczej po ruchu
  // zrobiloby sie GT < WMS i auto-korekta scielaby polke, gubiac stan, ktorego nikt nie ruszal".
  // Pod regula #3 usera to zdanie jest ODWROCONE - scielenie polki to nie strata, tylko
  // MECHANIZM: polka ma zejsc jako pierwsza. To wlasnie ten inwariant ucinal rozlozenie palety
  // (paleta 4080, po dwoch dniach sprzedazy deficyt 4075 -> backend przepuszczal 4075 i 5 szt.
  // zostawalo w GT "na K4", choc fizycznie pojechaly na gore).
  //
  // Co pilnuje granic zamiast niego:
  //   - ilosc <= ile zostalo z dokumentu (nizej, przy weryfikacji zrodlo_dok),
  //   - zasada 6: ilosc <= stan GT - rezerwacja (dla MM) - to ona lapie prob rozlozenia
  //     palety-widma i zwraca czytelny blad zamiast wiszacego pending,
  //   - dla LOK: ilosc <= stan GT (nizej) - nie da sie zaklepac wiecej, niz GT w ogole ma.
  if (gtZrodla.stan <= 0) {
    return res.status(409).json({ blad: `W ${zrodloMag} nie ma stanu (GT: 0) - nie ma czego rozkladac.` });
  }
  // Zasada 6 dotyczy tylko MM - rezerwacja blokuje WYPROWADZENIE towaru z magazynu.
  // Przy LOK (cel w tym samym magazynie) nic z niego nie wychodzi, wiec nie ogranicza.
  if (typRuchu === 'MM' && ilo > gtZrodla.dostepne) {
    return res.status(409).json({ blad: `W ${zrodloMag} mozna wyprowadzic najwyzej ${Math.max(gtZrodla.dostepne, 0)} szt. wg GT (stan ${gtZrodla.stan}, rezerwacja ${gtZrodla.rezerwacja} blokuje MM).` });
  }
  if (typRuchu === 'LOK' && ilo > gtZrodla.stan) {
    return res.status(409).json({ blad: `W ${zrodloMag} jest ${gtZrodla.stan} szt. wg GT - nie da sie zaklepac ${ilo}.` });
  }

  // KTORY dokument jest rozkladany. Front podaje numer PZ klikanego wiersza, ale backend go
  // WERYFIKUJE wlasnym rozbiciem (gt-dokumenty) - inaczej klient mogby podpisac ruch dowolna
  // dostawa i zafalszowac zarowno log, jak i rozliczenie kubelka (ruchy.zrodlo_dok steruje
  // tym, ile z danego dokumentu zostalo do rozlozenia).
  let zrodloOpis = '(nieprzypisane)';
  let zrodloDokumenty = null;
  let dokDoZapisu = null;
  let reszta = null;   // ile stanu NIE tlumaczy zaden dokument; null = GT nie odpowiedzial
  try {
    const dokumenty = (await gtDokumenty.pobierzDostawyK4([artykul_gt_id])).get(String(artykul_gt_id)) || [];
    const rozbicie = gtDokumenty.rozbijStanK4(gtZrodla.stan, sumaWms, dokumenty, { artykul_gt_id, magazyn: zrodloMag });
    const pula = rozbicie.wszystkie;
    reszta = rozbicie.reszta;

    if (zrodlo_dok) {
      const poz = pula.find((d) => d.pz_nr === String(zrodlo_dok));
      if (!poz) {
        return res.status(409).json({
          blad: `Dokument ${zrodlo_dok} nie ma juz nic do rozlozenia dla tego artykulu - odswiez karte produktu.`,
        });
      }
      if (ilo > poz.ilosc) {
        return res.status(409).json({
          blad: `Z dokumentu ${poz.fz_nr || poz.pz_nr} zostalo ${poz.ilosc} szt. - nie mozna rozlozyc ${ilo}.`,
        });
      }
      dokDoZapisu = poz.pz_nr;
      // rodzaj bierzemy WPROST z rozbicia (dostawa/zwrot/przywozka) - mapowanie recznym
      // ifem gubilo kazdy nowy rodzaj i przywozka logowala sie jako "dostawa"
      zrodloOpis = poz.rodzaj;
      zrodloDokumenty = { [zrodloOpis]: poz.fz_nr || poz.pz_nr };
      if (poz.kontrahent) zrodloDokumenty.kontrahent = poz.kontrahent;
    }
  } catch { /* GT niedostepne - log bez opisu dokumentu, ruch idzie dalej */ }

  // BEZ podpisu dokumentem wolno wziac najwyzej `reszta` - czyli stan, ktorego ZADEN dokument
  // nie tlumaczy. Kazda sztuka ponad to nalezy do konkretnej dostawy/zwrotu/przywozki, a wziecie
  // jej anonimowo zostawia kubelek tego dokumentu zawyzony: przy nastepnym rozkladaniu system
  // obieca sztuki, ktore dawno zjechaly. Tak powstal rozjazd na NERE8308 - 16-07 poszlo 25 szt.
  // z puli na K4G bez podpisu, wiec 19-07 kubelek wciaz pokazywal pelne 50 i magazynier zaklepal
  // 50 przy 25 realnie dostepnych (WMS 99 vs GT 74, posprzatane dopiero auto-korekta).
  //
  // To NIE jest przywrocenie usunietego `ilo <= deficyt` (2026-07-17). Tamten warunek blokowal
  // rozlozenie PELNEJ palety, gdy czesc zdazyla sie sprzedac (4080 przy deficycie 4075) - i
  // slusznie zniknal. Tu limit dziala WYLACZNIE na ruchy bez dokumentu; z podpisem obowiazuje
  // dalej "ilosc <= ile zostalo z dokumentu" (wyzej), wiec paleta przechodzi w calosci.
  //
  // reszta == null (GT z dokumentami nie odpowiedzial) -> nie blokujemy: przy padnietym zrodle
  // dokumentow nie umiemy odroznic anonimowego naduzycia od zwyklego rozkladania.
  if (!zrodlo_dok && reszta != null && ilo > reszta) {
    return res.status(409).json({
      blad: reszta > 0
        ? `Bez wskazania dokumentu mozna rozlozyc najwyzej ${reszta} szt. Reszta stanu nalezy do konkretnej dostawy/zwrotu - wybierz jej wiersz na karcie produktu.`
        : `Caly stan w ${zrodloMag} nalezy do dokumentow - wybierz wiersz dostawy/zwrotu na karcie produktu zamiast rozkladac z puli.`,
    });
  }

  // Uczen rozklada WYLACZNIE zwroty. /rozloz obsluguje tez dostawy, przywozki i PW, wiec mount
  // w app.js jedynie go przepuszcza - regula domyka sie tutaj, na rodzaju rozpoznanym WLASNYM
  // rozbiciem GT (klient podaje tylko numer dokumentu, wiec payloadem tego nie obejdzie).
  // Domyslnie ODMAWIAMY: gdy rodzaju nie udalo sie ustalic - brak zrodlo_dok albo catch wyzej
  // polknal blad GT - zrodloOpis zostaje '(nieprzypisane)' i uczen nie przechodzi.
  if (req.uzytkownik?.rola === 'uczen' && zrodloOpis !== 'zwrot') {
    return res.status(403).json({ blad: 'Rola „uczen" moze rozkladac tylko zwroty' });
  }

  const symbolDoWpisu = artykul_symbol
    ?? db.prepare("SELECT artykul_symbol FROM stany_lokalizacji WHERE artykul_gt_id = ? LIMIT 1").get(artykul_gt_id)?.artykul_symbol
    ?? String(artykul_gt_id);
  const nazwaDoWpisu = artykul_nazwa
    ?? db.prepare("SELECT artykul_nazwa FROM stany_lokalizacji WHERE artykul_gt_id = ? LIMIT 1").get(artykul_gt_id)?.artykul_nazwa
    ?? '';
  const eanDoWpisu = artykul_ean
    ?? db.prepare("SELECT artykul_ean FROM stany_lokalizacji WHERE artykul_gt_id = ? LIMIT 1").get(artykul_gt_id)?.artykul_ean
    ?? null;

  let ruchId;
  db.exec('BEGIN');
  try {
    const ruch = db.prepare(`
      INSERT INTO ruchy (typ, artykul_gt_id, artykul_symbol, lok_zrodlo_id, lok_cel_id, mag_zrodlo_pula, zrodlo_dok, ilosc, status, operator)
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'pending', ?)
    `).run(typRuchu, artykul_gt_id, symbolDoWpisu, lok_cel_id, zrodloMag, dokDoZapisu, ilo, operator ?? null);
    ruchId = ruch.lastInsertRowid;

    // Zrodlem jest pula bez lokalizacji, wiec po stronie zrodla NIE ma czego odejmowac -
    // kopia WMS polki zostaje nietknieta i nadal mowi prawde. Przy MM stan GT zrodla zbije
    // dopiero dokument (GT = master ilosci); przy LOK stan GT w ogole sie nie zmienia -
    // rosnie tylko wiedza WMS o tym, gdzie ten towar lezy.
    const stanCel = db.prepare('SELECT * FROM stany_lokalizacji WHERE lokalizacja_id = ? AND artykul_gt_id = ?')
      .get(lok_cel_id, artykul_gt_id);
    if (stanCel) {
      db.prepare('UPDATE stany_lokalizacji SET ilosc = ilosc + ?, ostatnia_zmiana = CURRENT_TIMESTAMP, operator = ? WHERE id = ?')
        .run(ilo, operator ?? null, stanCel.id);
    } else {
      db.prepare(`
        INSERT INTO stany_lokalizacji (lokalizacja_id, artykul_gt_id, artykul_symbol, artykul_nazwa, artykul_ean, ilosc, operator)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(lok_cel_id, artykul_gt_id, symbolDoWpisu, nazwaDoWpisu, eanDoWpisu, ilo, operator ?? null);
    }
    // Przeniesienie domu: SKU mial PUSTY dom K4 (stan 0) gdzie indziej, a czlowiek przy regale
    // POTWIERDZIL zmiane lokalizacji (zwroty.js oferuje to WYLACZNIE gdy zapas K4+K4G+LS = 0).
    // Zwalniamy stary pusty wpis, zeby zostal JEDEN dom (1 SKU = 1 lok) i tw_Pole1 wskazalo nowe
    // miejsce (przeliczy je wykonajRuchGT nizej). Kasujemy WYLACZNIE ilosc=0 - domu ze stanem ta
    // sciezka nie tyka (blok 1-SKU-1-lok wyzej odrzuca stan>0). To DRUGIE po "Czysc zera" miejsce
    // zwalniajace dom K4 - autoryzowane tak samo: czlowiekiem przy polce, nie automatem.
    if (przenies_dom && cel.magazyn === 'K4') {
      db.prepare(
        `DELETE FROM stany_lokalizacji
         WHERE artykul_gt_id = ? AND ilosc = 0 AND lokalizacja_id != ?
           AND lokalizacja_id IN (SELECT id FROM lokalizacje WHERE magazyn = 'K4')`
      ).run(artykul_gt_id, lok_cel_id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return next(err);
  }

  try {
    const wynikRuch = await wykonajRuchGT(ruchId);
    audyt.zapisz({
      uzytkownik: operator, akcja: 'rozlozenie', artykul_gt_id, artykul_symbol: symbolDoWpisu,
      magazyn: cel.magazyn,
      lokalizacja: `${zrodloMag} ${zrodloOpis} → ${cel.kod}${typRuchu === 'LOK' ? ' (bez MM)' : ''}`,
      przed: zrodloDokumenty,
      ilosc: ilo, wynik: wynikRuch.status, ruch_id: ruchId, dok_gt_numer: wynikRuch.dok_gt_numer,
    });
    res.status(201).json(wynikRuch);
  } catch (err) {
    next(err);
  }
});

// POST /api/ruchy/mm-zewnetrzny - MM miedzy dwoma magazynami zewnetrznymi (MAG/LS).
// Brak zmian stanow WMS (zadna strona nie ma lokalizacji WMS). Tylko rejestracja ruchu
// i dokument MM w GT przez most.
router.post('/mm-zewnetrzny', async (req, res, next) => {
  const { artykul_gt_id, mag_zrodlo, mag_cel, ilosc, operator, artykul_symbol } = req.body ?? {};

  if (!artykul_gt_id) return res.status(400).json({ blad: 'Pole "artykul_gt_id" jest wymagane' });
  if (!mag_zrodlo || !MAGAZYNY_ZEWNETRZNE.includes(String(mag_zrodlo).trim().toUpperCase())) {
    return res.status(400).json({ blad: `Pole "mag_zrodlo" musi byc jednym z: ${MAGAZYNY_ZEWNETRZNE.join(', ')}` });
  }
  if (!mag_cel || !MAGAZYNY_ZEWNETRZNE.includes(String(mag_cel).trim().toUpperCase())) {
    return res.status(400).json({ blad: `Pole "mag_cel" musi byc jednym z: ${MAGAZYNY_ZEWNETRZNE.join(', ')}` });
  }
  if (mag_zrodlo === mag_cel) return res.status(400).json({ blad: 'Magazyn zrodlowy i docelowy nie moga byc identyczne' });
  const ilo = Number(ilosc);
  if (!Number.isFinite(ilo) || ilo <= 0) return res.status(400).json({ blad: 'Pole "ilosc" musi byc liczba > 0' });

  const zrodloMag = String(mag_zrodlo).trim().toUpperCase();

  // Zasada 6: rezerwacje GT blokuja MM takze miedzy magazynami zewnetrznymi.
  let dostZrodlo;
  try {
    dostZrodlo = await dostepneWGt(artykul_gt_id, zrodloMag);
  } catch (err) {
    return res.status(503).json({ blad: 'Nie mozna zweryfikowac rezerwacji w GT (baza niedostepna) - MM wstrzymane. Sprobuj ponownie.' });
  }
  if (dostZrodlo.rezerwacja > 0 && ilo > dostZrodlo.dostepne) {
    return res.status(409).json({ blad: `Towar zarezerwowany w ${zrodloMag}: mozna przesunac najwyzej ${Math.max(dostZrodlo.dostepne, 0)} szt. (stan GT ${dostZrodlo.stan}, rezerwacja ${dostZrodlo.rezerwacja}). Rezerwacje blokuja MM.` });
  }

  const symbolDoWpisu = artykul_symbol
    ?? db.prepare("SELECT artykul_symbol FROM stany_lokalizacji WHERE artykul_gt_id = ? LIMIT 1").get(artykul_gt_id)?.artykul_symbol
    ?? String(artykul_gt_id);

  let ruchId;
  try {
    const ruch = db.prepare(`
      INSERT INTO ruchy (typ, artykul_gt_id, artykul_symbol, lok_zrodlo_id, lok_cel_id,
                         mag_zrodlo_zewnetrzny, mag_cel_zewnetrzny, ilosc, status, operator)
      VALUES ('MM', ?, ?, NULL, NULL, ?, ?, ?, 'pending', ?)
    `).run(artykul_gt_id, symbolDoWpisu, String(mag_zrodlo).toUpperCase(), String(mag_cel).toUpperCase(), ilo, operator ?? null);
    ruchId = ruch.lastInsertRowid;
  } catch (err) {
    return next(err);
  }

  try {
    const wynikRuch = await wykonajRuchGT(ruchId);
    audyt.zapisz({
      uzytkownik: operator, akcja: 'MM-zewn', artykul_gt_id, artykul_symbol: symbolDoWpisu,
      magazyn: zrodloMag, lokalizacja: `${String(mag_zrodlo).toUpperCase()} → ${String(mag_cel).toUpperCase()}`,
      ilosc: ilo, wynik: wynikRuch.status, ruch_id: ruchId, dok_gt_numer: wynikRuch.dok_gt_numer,
    });
    res.status(201).json(wynikRuch);
  } catch (err) {
    next(err);
  }
});

// POST /api/ruchy/uzupelnienie - uzupelnienie K4 z K4 Gora dla towaru ze zrodlem
// K4G tylko w GT (brak per-lokalizacyjnego stanu K4G w WMS). Wystawiamy MM K4G->K4
// (mag 8 -> 4) przez most i rejestrujemy ruch. Zrodlo K4G zostaje GT-managed (nie
// tworzymy stanu WMS - nie znamy rozbicia per-lokalizacja).
//
// CEL K4: jesli lokalizacja K4 JUZ ISTNIEJE w WMS (lok_cel_id), aktualizujemy jej
// stan (+ilosc), zeby nie powstal rozjazd (GT > WMS na K4). Gdy K4 nie ma w WMS -
// "czyste GT" (bez zmian WMS, towar zostaje t_GT). NIE tworzymy nowej lokalizacji K4
// z tekstu GT (kod bywa "brudny") - onboarding K4 to osobny krok (lokalizowanie).
//
// Zasada 6 (rezerwacje blokuja MM) egzekwowana przez GT na K4G. lok_*_kod - do audytu.
router.post('/uzupelnienie', async (req, res, next) => {
  const { artykul_gt_id, ilosc, operator, artykul_symbol, lok_cel_id, lok_zrodlo_kod, lok_cel_kod } = req.body ?? {};

  if (!artykul_gt_id) return res.status(400).json({ blad: 'Pole "artykul_gt_id" jest wymagane' });
  const ilo = Number(ilosc);
  if (!Number.isFinite(ilo) || ilo <= 0) return res.status(400).json({ blad: 'Pole "ilosc" musi byc liczba > 0' });

  // Opcjonalny cel WMS K4 (gdy lokalizacja K4 juz istnieje) - zaktualizujemy jego stan.
  let cel = null;
  if (lok_cel_id !== undefined && lok_cel_id !== null) {
    cel = db.prepare('SELECT * FROM lokalizacje WHERE id = ?').get(lok_cel_id);
    if (!cel) return res.status(404).json({ blad: 'Lokalizacja docelowa nie istnieje' });
    if (cel.magazyn !== 'K4') return res.status(400).json({ blad: 'Lokalizacja docelowa uzupelnienia musi byc w magazynie K4' });
  }

  // Zasada 6: rezerwacje GT blokuja MM. Zrodlo = K4G; mozna wyprowadzic najwyzej
  // (stan GT gora - rezerwacja).
  let dostZrodlo;
  try {
    dostZrodlo = await dostepneWGt(artykul_gt_id, 'K4G');
  } catch (err) {
    return res.status(503).json({ blad: 'Nie mozna zweryfikowac stanu/rezerwacji w GT (baza niedostepna) - uzupelnienie wstrzymane. Sprobuj ponownie.' });
  }
  if (ilo > dostZrodlo.dostepne) {
    return res.status(409).json({ blad: `Na K4 Gora dostepne najwyzej ${Math.max(dostZrodlo.dostepne, 0)} szt. (stan GT ${dostZrodlo.stan}, rezerwacja ${dostZrodlo.rezerwacja}).` });
  }

  const symbolDoWpisu = artykul_symbol
    ?? db.prepare('SELECT artykul_symbol FROM stany_lokalizacji WHERE artykul_gt_id = ? LIMIT 1').get(artykul_gt_id)?.artykul_symbol
    ?? String(artykul_gt_id);

  let ruchId;
  db.exec('BEGIN');
  try {
    // gdy cel WMS: lok_cel_id ustawione, magazyn docelowy z lokalizacji (mag_cel_zewnetrzny NULL);
    // gdy czyste GT: mag_cel_zewnetrzny = 'K4' (most i tak wystawi MM 8->4).
    const ruch = db.prepare(`
      INSERT INTO ruchy (typ, artykul_gt_id, artykul_symbol, lok_zrodlo_id, lok_cel_id,
                         mag_zrodlo_zewnetrzny, mag_cel_zewnetrzny, ilosc, status, operator)
      VALUES ('MM', ?, ?, NULL, ?, 'K4G', ?, ?, 'pending', ?)
    `).run(artykul_gt_id, symbolDoWpisu, cel ? cel.id : null, cel ? null : 'K4', ilo, operator ?? null);
    ruchId = ruch.lastInsertRowid;

    if (cel) {
      // aktualizuj istniejacy stan K4 (1 SKU = 1 lokalizacja - dokladamy do tej samej)
      const stanCel = db.prepare('SELECT * FROM stany_lokalizacji WHERE lokalizacja_id = ? AND artykul_gt_id = ?')
        .get(cel.id, artykul_gt_id);
      if (stanCel) {
        db.prepare('UPDATE stany_lokalizacji SET ilosc = ilosc + ?, ostatnia_zmiana = CURRENT_TIMESTAMP, operator = ? WHERE id = ?')
          .run(ilo, operator ?? null, stanCel.id);
      } else {
        db.prepare(`
          INSERT INTO stany_lokalizacji (lokalizacja_id, artykul_gt_id, artykul_symbol, artykul_nazwa, ilosc, operator)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(cel.id, artykul_gt_id, symbolDoWpisu, symbolDoWpisu, ilo, operator ?? null);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return next(err);
  }

  try {
    const wynikRuch = await wykonajRuchGT(ruchId);
    audyt.zapisz({
      uzytkownik: operator, akcja: 'Uzupelnienie', artykul_gt_id, artykul_symbol: symbolDoWpisu,
      magazyn: 'K4G', lokalizacja: `${lok_zrodlo_kod || 'K4G'} → ${cel ? cel.kod : (lok_cel_kod || 'K4')}`,
      ilosc: ilo, wynik: wynikRuch.status, ruch_id: ruchId, dok_gt_numer: wynikRuch.dok_gt_numer,
    });
    res.status(201).json(wynikRuch);
  } catch (err) {
    next(err);
  }
});

// GET /api/ruchy - lista ruchow, opcjonalnie filtrowana po statusie (np. ?status=pending
// do podgladu kolejki przed/po retry)
router.get('/', (req, res) => {
  const { status } = req.query ?? {};
  if (status) {
    return res.json(db.prepare('SELECT * FROM ruchy WHERE status = ? ORDER BY data_ruchu DESC').all(status));
  }
  res.json(db.prepare('SELECT * FROM ruchy ORDER BY data_ruchu DESC').all());
});

// POST /api/ruchy/:id/retry - ponawia probe doslania ruchu 'pending' do GT
// (dokument MM jesli brakuje numeru, oraz sync pol lokalizacyjnych)
router.post('/:id/retry', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ blad: 'Niepoprawne id ruchu' });
  }

  const ruch = db.prepare('SELECT * FROM ruchy WHERE id = ?').get(id);
  if (!ruch) return res.status(404).json({ blad: 'Ruch nie istnieje' });
  if (ruch.status !== 'pending') {
    return res.status(409).json({ blad: `Ruch ma status '${ruch.status}' - ponawianie dotyczy tylko 'pending'` });
  }

  try {
    res.json(await wykonajRuchGT(id));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/ruchy/:id - usuwa bledny ruch z kolejki i COFA zmiane stanow WMS.
// Dozwolone tylko dla 'pending' bez dok_gt_numer: dokument MM nie zostal wystawiony
// w GT, wiec WMS przesunal stan, a GT nie - usuniecie przywraca stan WMS sprzed ruchu
// (inwariant: suma WMS = stan GT). Ruch z dok_gt_numer jest juz zaksiegowany w GT -
// nie kasujemy go (trzeba odwrotnego MM), zwracamy 409. Alternatywa dla 'retry', gdy
// ruch nie ma szans przejsc (np. towar zarezerwowany - retry zawsze odbije sie od Sfery).
router.delete('/:id', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ blad: 'Niepoprawne id ruchu' });

  const ruch = db.prepare('SELECT * FROM ruchy WHERE id = ?').get(id);
  if (!ruch) return res.status(404).json({ blad: 'Ruch nie istnieje' });
  if (ruch.status !== 'pending') {
    return res.status(409).json({ blad: `Usunac mozna tylko ruch 'pending' (ten ma status '${ruch.status}')` });
  }
  if (ruch.dok_gt_numer) {
    return res.status(409).json({ blad: `Ruch ma dokument GT ${ruch.dok_gt_numer} - jest zaksiegowany w GT. Cofnij go odwrotnym MM, nie usuwaniem.` });
  }

  // Magazyny dotkniete ruchem - po cofnieciu stanow trzeba dla nich przeliczyc pola
  // lokalizacyjne GT (tw_Pole1/tw_Pole8). Tworzenie ruchu zsynchronizowalo je do stanu
  // PO ruchu (czesto pustego), wiec samo cofniecie ilosci zostawiloby GT z nieaktualna
  // lokalizacja => NZ. Resolwujemy magazyny zanim ruszymy stany.
  const magazyny = new Set();
  if (ruch.lok_zrodlo_id) {
    const z = db.prepare('SELECT magazyn FROM lokalizacje WHERE id = ?').get(ruch.lok_zrodlo_id);
    if (z) magazyny.add(z.magazyn);
  }
  let magCel = null;
  if (ruch.lok_cel_id) {
    const c = db.prepare('SELECT magazyn FROM lokalizacje WHERE id = ?').get(ruch.lok_cel_id);
    if (c) { magazyny.add(c.magazyn); magCel = c.magazyn; }
  }

  db.exec('BEGIN');
  try {
    // Cofamy dokladnie odwrotnie do tworzenia ruchu: zrodlo dostaje ilosc z powrotem,
    // cel ja oddaje. Dla magazynow zewnetrznych (brak lok_*_id) nie ma stanu WMS do cofania.
    if (ruch.lok_zrodlo_id) {
      const stanZ = db.prepare('SELECT * FROM stany_lokalizacji WHERE lokalizacja_id = ? AND artykul_gt_id = ?')
        .get(ruch.lok_zrodlo_id, ruch.artykul_gt_id);
      if (stanZ) {
        db.prepare('UPDATE stany_lokalizacji SET ilosc = ilosc + ?, ostatnia_zmiana = CURRENT_TIMESTAMP WHERE id = ?')
          .run(ruch.ilosc, stanZ.id);
      } else {
        const wzor = db.prepare('SELECT artykul_nazwa, artykul_ean FROM stany_lokalizacji WHERE artykul_gt_id = ? LIMIT 1').get(ruch.artykul_gt_id);
        db.prepare(`INSERT INTO stany_lokalizacji (lokalizacja_id, artykul_gt_id, artykul_symbol, artykul_nazwa, artykul_ean, ilosc)
                    VALUES (?, ?, ?, ?, ?, ?)`)
          .run(ruch.lok_zrodlo_id, ruch.artykul_gt_id, ruch.artykul_symbol, wzor?.artykul_nazwa ?? '', wzor?.artykul_ean ?? null, ruch.ilosc);
      }
    }
    if (ruch.lok_cel_id) {
      const stanC = db.prepare('SELECT * FROM stany_lokalizacji WHERE lokalizacja_id = ? AND artykul_gt_id = ?')
        .get(ruch.lok_cel_id, ruch.artykul_gt_id);
      if (stanC) {
        const poCofnieciu = stanC.ilosc - ruch.ilosc;
        if (poCofnieciu > 0) {
          db.prepare('UPDATE stany_lokalizacji SET ilosc = ?, ostatnia_zmiana = CURRENT_TIMESTAMP WHERE id = ?')
            .run(poCofnieciu, stanC.id);
        } else if (magCel === 'K4') {
          // Tak samo jak MM oprozniajace polke (wyzej): K4 to STALE miejsce SKU - wiersz
          // zostaje z zerem, nie kasujemy domu. Inaczej cofniecie nieudanego uzupelnienia
          // na pusta polke kasowalo lokalizacje i w WMS, i w GT (sync ponizej wpisalby "").
          db.prepare('UPDATE stany_lokalizacji SET ilosc = 0, ostatnia_zmiana = CURRENT_TIMESTAMP WHERE id = ?')
            .run(stanC.id);
        } else {
          db.prepare('DELETE FROM stany_lokalizacji WHERE id = ?').run(stanC.id);
        }
      }
    }
    db.prepare('DELETE FROM ruchy WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return next(err);
  }

  // Po cofnieciu stanow WMS dosylamy poprawne pola lokalizacyjne do GT (zapis prosto do
  // GT SQL, bez Sfery). Bez tego GT trzyma lokalizacje sprzed cofniecia => artykul widnieje
  // jako NZ mimo zgodnych ilosci. Blad GT-SQL nie cofa usuniecia - lokalizacja dosynchronizuje
  // sie przy kolejnym ruchu/jobie; sygnalizujemy to w odpowiedzi.
  let lokSync = true;
  try {
    const wynik = await gtFields.synchronizujLokalizacje(ruch.artykul_gt_id, magazyny);
    if (wynik && !(wynik.ok && wynik.dane?.sukces)) lokSync = false;
  } catch (err) {
    lokSync = false;
  }

  audyt.zapisz({
    uzytkownik: req.body?.operator ?? null, akcja: 'usuniecie_ruchu',
    artykul_gt_id: ruch.artykul_gt_id, artykul_symbol: ruch.artykul_symbol, ilosc: ruch.ilosc,
    przed: { typ: ruch.typ, lok_zrodlo_id: ruch.lok_zrodlo_id, lok_cel_id: ruch.lok_cel_id, status: ruch.status },
    wynik: 'ok', ruch_id: id, szczegoly: { lokalizacje_gt_zsync: lokSync },
  });
  res.json({ usuniety: id, lokalizacje_gt_zsync: lokSync });
});

module.exports = router;
