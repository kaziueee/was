const express = require('express');
const db = require('../db/database');
const { MAGAZYNY_WMS } = require('../config/magazyny');
const { podzielNaSlowa, LIMIT_WYSZUKIWANIA } = require('../services/wyszukiwanie');
const { pobierzProdukt, szukajProdukty, pobierzStanyGt } = require('../services/gt-produkty');
const { pobierzStatusLokalizacjiGt, synchronizujLokalizacje, pobierzPrzegladLokalizacji } = require('../services/gt-fields');
const audyt = require('../services/audyt');

const router = express.Router();

const SQLITE_CONSTRAINT_UNIQUE = 2067;

// GET /api/lokalizacje - lista lokalizacji (filtry: ?magazyn=, ?aktywna=, ?q=)
router.get('/', (req, res) => {
  const { magazyn, aktywna, q } = req.query;
  let sql = 'SELECT * FROM lokalizacje WHERE 1=1';
  const params = [];

  if (magazyn) {
    sql += ' AND magazyn = ?';
    params.push(magazyn);
  }
  if (aktywna !== undefined) {
    sql += ' AND aktywna = ?';
    params.push(aktywna === '1' || aktywna === 'true' ? 1 : 0);
  }
  if (q) {
    sql += ' AND kod LIKE ?';
    params.push(`%${q}%`);
  }
  sql += ' ORDER BY kod';

  res.json(db.prepare(sql).all(...params));
});

// lokalizacje WMS z zapasem dla danego SKU (lub null gdy brak)
function lokalizacjeDlaArtykulu(symbol) {
  const wiersze = db.prepare(
    `SELECT s.lokalizacja_id, l.kod, l.magazyn, s.artykul_gt_id, s.artykul_symbol, s.artykul_nazwa, s.ilosc, s.zapas_kod, s.ostatnia_zmiana
     FROM stany_lokalizacji s
     JOIN lokalizacje l ON l.id = s.lokalizacja_id
     WHERE s.artykul_symbol = ? AND s.ilosc > 0
     ORDER BY l.kod`
  ).all(symbol);

  if (wiersze.length === 0) return null;

  return {
    artykul_gt_id: wiersze[0].artykul_gt_id,
    artykul_symbol: wiersze[0].artykul_symbol,
    artykul_nazwa: wiersze[0].artykul_nazwa,
    lokalizacje: wiersze.map(({ lokalizacja_id, kod, magazyn, ilosc, zapas_kod, ostatnia_zmiana }) => ({ lokalizacja_id, kod, magazyn, ilosc, zapas_kod, ostatnia_zmiana }))
  };
}

// lokalizacje WMS z zapasem dla SKU znalezionego po EAN (lub null gdy brak)
function lokalizacjeDlaArtykuluPoEan(ean) {
  const wiersz = db.prepare(
    'SELECT artykul_symbol FROM stany_lokalizacji WHERE artykul_ean = ? AND ilosc > 0 LIMIT 1'
  ).get(ean);
  if (!wiersz) return null;
  return lokalizacjeDlaArtykulu(wiersz.artykul_symbol);
}

// szukanie artykulow po (czesci) nazwy wsrod wszystkich artykulow, ktore
// kiedykolwiek mialy lokalizacje w WMS (niezaleznie od biezacego stanu -
// filtrowanie po stanie to rola checkboxa "Ukryj produkty bez stanu" na
// froncie). Kazde slowo z frazy musi pasowac do poczatku nazwy albo poczatku
// jakiegos wyrazu w nazwie (w dowolnej kolejnosci), zob. services/wyszukiwanie.js.
// Kazdy wynik ma dolaczona liste stanow per magazyn (do podgladu na liscie
// wyboru), wyniki posortowane wg trafnosci, a nastepnie wg lacznego stanu malejaco.
function szukajArtykulowPoNazwie(fraza) {
  const slowa = podzielNaSlowa(fraza);
  if (slowa.length === 0) return [];

  const params = [];
  const warunkiSlow = slowa.map((slowo) => {
    params.push(`${slowo}%`, `% ${slowo}%`);
    return `(artykul_nazwa LIKE ? ESCAPE '\\' OR artykul_nazwa LIKE ? ESCAPE '\\')`;
  }).join(' AND ');

  const artykuly = db.prepare(
    `SELECT DISTINCT artykul_gt_id, artykul_symbol, artykul_nazwa
     FROM stany_lokalizacji
     WHERE ${warunkiSlow}
     ORDER BY
       CASE WHEN artykul_nazwa LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,
       artykul_nazwa
     LIMIT ?`
  ).all(...params, `${slowa[0]}%`, LIMIT_WYSZUKIWANIA);

  const stanyStmt = db.prepare(
    `SELECT l.magazyn, SUM(s.ilosc) AS ilosc
     FROM stany_lokalizacji s
     JOIN lokalizacje l ON l.id = s.lokalizacja_id
     WHERE s.artykul_gt_id = ? AND s.ilosc > 0
     GROUP BY l.magazyn
     ORDER BY l.magazyn`
  );

  const wyniki = artykuly.map((a) => ({ ...a, stany: stanyStmt.all(a.artykul_gt_id) }));

  // produkty z najwiekszym lacznym stanem na gorze, reszta zachowuje
  // kolejnosc trafnosci/alfabetyczna z zapytania (sort jest stabilny)
  wyniki.sort((a, b) => sumaStanowLokalnych(b.stany) - sumaStanowLokalnych(a.stany));

  return wyniki;
}

function sumaStanowLokalnych(stany) {
  return stany.reduce((suma, s) => suma + s.ilosc, 0);
}

// GET /api/lokalizacje/artykul/:symbol - lokalizacje WMS z zapasem dla danego SKU
router.get('/artykul/:symbol', (req, res) => {
  const wynik = lokalizacjeDlaArtykulu(req.params.symbol);
  if (!wynik) {
    return res.status(404).json({ blad: 'Brak lokalizacji WMS z zapasem dla tego SKU' });
  }
  res.json(wynik);
});

// produkt znaleziony w katalogu GT, ale bez zapasu na lokalizacji WMS
// (jeszcze nie zlokalizowany) - lokalizacje puste, frontend pokazuje
// odpowiedni komunikat zamiast pustej listy do wyboru
function artykulZGt(produktGt) {
  return {
    artykul_gt_id: produktGt.artykul_gt_id,
    artykul_symbol: produktGt.symbol,
    artykul_nazwa: produktGt.nazwa,
    lokalizacje: [],
  };
}

// Dolacza do odpowiedzi /skan dane z GT wspolne dla "karty produktu" na
// wszystkich ekranach (zob. public/zebra/karta-produktu.js):
//   stany_gt        - stan GT per magazyn (K4/K4G/MAG/LS), zob. gt-produkty.js
//   lokalizacja_gt  - {tekst, zgodna} wg pol wlasnych GT, zob. gt-fields.js;
//                      zgodna=false oznacza rozjazd miedzy GT a biezacym
//                      stanem WMS (frontend pokazuje wtedy ikone ❌)
// W razie bledu polaczenia z GT zwraca payload bez zmian - niedostepnosc GT
// nie blokuje podstawowych funkcji WMS.
async function dolaczDaneGt(payload) {
  try {
    let idy;
    if (payload.typ === 'lokalizacja') {
      idy = payload.zawartosc.map((p) => p.artykul_gt_id);
    } else if (payload.typ === 'artykul') {
      idy = [payload.artykul_gt_id];
    } else if (payload.typ === 'lista_artykulow') {
      idy = payload.artykuly.map((a) => a.artykul_gt_id);
    } else {
      return payload;
    }

    const [stanyMap, statusMap, przegladMap] = await Promise.all([
      pobierzStanyGt(idy),
      pobierzStatusLokalizacjiGt(idy),
      pobierzPrzegladLokalizacji(idy),
    ]);

    // {k4, k4g, ogolna} z enumem OK/t_GT/NZ/BD/OF (jak w tabeli desktopu) - do badge'a statusu na froncie
    const zgodnoscZPrzegladu = (id) => {
      const p = przegladMap.get(String(id));
      return p ? { k4: p.k4?.stan, k4g: p.k4g?.stan, ogolna: p.ogolna } : null;
    };

    const wzbogac = (item) => ({
      ...item,
      stany_gt: stanyMap.get(String(item.artykul_gt_id)),
      lokalizacja_gt: statusMap.get(String(item.artykul_gt_id)),
      zgodnosc: zgodnoscZPrzegladu(item.artykul_gt_id),
    });

    if (payload.typ === 'lokalizacja') {
      payload.zawartosc = payload.zawartosc.map(wzbogac);
    } else if (payload.typ === 'artykul') {
      payload.stany_gt = stanyMap.get(String(payload.artykul_gt_id));
      payload.lokalizacja_gt = statusMap.get(String(payload.artykul_gt_id));
      payload.zgodnosc = zgodnoscZPrzegladu(payload.artykul_gt_id);

      // K4gora to "1 SKU = N lokalizacji" - nawet gdy artykul ma juz jakas
      // lokalizacje w K4G, w GT moze byc wiecej sztuk niz zsumowano w WMS
      // (np. po PZ). deficyt_k4g > 0 pozwala frontowi zaproponowac dodanie
      // kolejnej lokalizacji K4G obok przesuniecia z istniejacej.
      const stanK4G = payload.stany_gt?.K4G?.ilosc ?? 0;
      const sumaK4G = payload.lokalizacje
        .filter((l) => l.magazyn === 'K4G')
        .reduce((suma, l) => suma + l.ilosc, 0);
      const deficytK4G = stanK4G - sumaK4G;
      if (deficytK4G > 0) payload.deficyt_k4g = deficytK4G;
    } else if (payload.typ === 'lista_artykulow') {
      payload.artykuly = payload.artykuly.map(wzbogac);
    }

    return payload;
  } catch (err) {
    return payload;
  }
}

// GET /api/lokalizacje/skan/:kod - punkt wejscia dla skanu na ekranie MM:
// jesli kod pasuje do lokalizacji - zwroc co na niej lezy (wybor produktu),
// jesli pasuje do SKU lub EAN (lokalnie w WMS albo w katalogu GT) - 1:1, zwroc
// lokalizacje z zapasem (wybor lokalizacji zrodlowej, albo "brak lokalizacji"
// dla produktu jeszcze nie zlokalizowanego w WMS),
// jesli pasuje do (czesci) nazwy artykulu - zwroc liste pasujacych artykulow do
// wyboru, laczac wyniki z historii WMS (stany_lokalizacji, niezaleznie od
// biezacego stanu) i z pelnego katalogu GT (przydatne dla produktow, ktore
// nigdy nie mialy lokalizacji WMS) - filtrowanie po stanie robi checkbox
// "Ukryj produkty bez stanu" na froncie.
router.get('/skan/:kod', async (req, res, next) => {
  try {
    const kod = req.params.kod;

    const lokalizacja = db.prepare('SELECT * FROM lokalizacje WHERE kod = ?').get(kod);
    if (lokalizacja) {
      const zawartosc = db.prepare(
        `SELECT artykul_gt_id, artykul_symbol, artykul_nazwa, ilosc
         FROM stany_lokalizacji WHERE lokalizacja_id = ? AND ilosc > 0
         ORDER BY artykul_symbol`
      ).all(lokalizacja.id);
      return res.json(await dolaczDaneGt({ typ: 'lokalizacja', lokalizacja, zawartosc }));
    }

    const wynikSymbol = lokalizacjeDlaArtykulu(kod);
    if (wynikSymbol) {
      return res.json(await dolaczDaneGt({ typ: 'artykul', ...wynikSymbol }));
    }

    const wynikEan = lokalizacjeDlaArtykuluPoEan(kod);
    if (wynikEan) {
      return res.json(await dolaczDaneGt({ typ: 'artykul', ...wynikEan }));
    }

    const produktGt = await pobierzProdukt(kod);
    if (produktGt) {
      // Produkt z katalogu GT (najczesciej skan EAN). Wiersze stany_lokalizacji czesto
      // nie maja zapisanego artykul_ean, wiec lookup po EAN (wyzej) ich nie znajduje -
      // sprobuj jeszcze dolaczyc istniejace lokalizacje WMS po symbolu z GT, zeby skan
      // EAN zlokalizowanego towaru dawal to samo co skan/wpis SKU (zrodlo, nie "brak").
      const wynikPoSymbolu = lokalizacjeDlaArtykulu(produktGt.symbol);
      const payload = wynikPoSymbolu ?? artykulZGt(produktGt);
      return res.json(await dolaczDaneGt({ typ: 'artykul', ...payload }));
    }

    if (kod.length >= 2) {
      const artykulyLokalne = szukajArtykulowPoNazwie(kod);

      let artykulyGt = [];
      try {
        artykulyGt = await szukajProdukty(kod);
      } catch (err) {
        artykulyGt = []; // niedostepnosc GT nie blokuje wynikow lokalnych
      }

      const widziane = new Set(artykulyLokalne.map((a) => String(a.artykul_gt_id)));
      const artykuly = [
        ...artykulyLokalne,
        ...artykulyGt
          .filter((p) => !widziane.has(String(p.artykul_gt_id)))
          .map((p) => ({ artykul_gt_id: p.artykul_gt_id, artykul_symbol: p.symbol, artykul_nazwa: p.nazwa })),
      ];

      if (artykuly.length > 0) {
        const obciete = artykulyLokalne.length >= LIMIT_WYSZUKIWANIA || artykulyGt.length >= LIMIT_WYSZUKIWANIA;
        return res.json(await dolaczDaneGt({ typ: 'lista_artykulow', artykuly, obciete }));
      }
    }

    res.status(404).json({ blad: 'Nie znaleziono SKU, EAN, lokalizacji ani nazwy artykulu w WMS ani w GT' });
  } catch (err) {
    next(err);
  }
});

// GET /api/lokalizacje/kod/:kod - lookup po kodzie (np. po skanie etykiety)
router.get('/kod/:kod', (req, res) => {
  const lokalizacja = db.prepare('SELECT * FROM lokalizacje WHERE kod = ?').get(req.params.kod);
  if (!lokalizacja) return res.status(404).json({ blad: 'Lokalizacja nie znaleziona' });
  res.json(lokalizacja);
});

// GET /api/lokalizacje/k4-dom/:artykul_gt_id - stale miejsce (dom) artykulu w K4,
// niezaleznie od ilosci - do auto-podpowiedzi lokalizacji docelowej przy uzupelnieniu K4
router.get('/k4-dom/:artykul_gt_id', (req, res) => {
  const wiersz = db.prepare(
    `SELECT s.lokalizacja_id, l.kod, s.ilosc, s.zapas_kod, s.ostatnia_zmiana
     FROM stany_lokalizacji s
     JOIN lokalizacje l ON l.id = s.lokalizacja_id
     WHERE s.artykul_gt_id = ? AND l.magazyn = 'K4' AND l.aktywna = 1`
  ).get(req.params.artykul_gt_id);
  res.json(wiersz ?? null);
});

// PUT /api/lokalizacje/k4-zapas/:artykul_gt_id - ustaw/wyczysc adnotacje "zapas" K4
// (decyzja A: towar w 2 miejscach, np. zbior A1 + nadmiar P5 -> GT tw_Pole1 "A1/P5").
// Nie zmienia stanu - tylko adnotacja + resync pola lokalizacyjnego GT.
router.put('/k4-zapas/:artykul_gt_id', async (req, res, next) => {
  const artykulGtId = req.params.artykul_gt_id;
  const zapas = (req.body?.zapas_kod ?? '').trim().toUpperCase() || null;

  const k4 = db.prepare(
    `SELECT s.id FROM stany_lokalizacji s
     JOIN lokalizacje l ON l.id = s.lokalizacja_id
     WHERE s.artykul_gt_id = ? AND l.magazyn = 'K4' AND s.ilosc > 0`
  ).get(artykulGtId);
  if (!k4) return res.status(404).json({ blad: 'Brak lokalizacji K4 z zapasem dla tego SKU - najpierw przypisz lokalizacje zbioru' });

  db.prepare('UPDATE stany_lokalizacji SET zapas_kod = ? WHERE id = ?').run(zapas, k4.id);

  try {
    const wynik = await synchronizujLokalizacje(artykulGtId, new Set(['K4']));
    const ok = wynik && wynik.ok;
    audyt.zapisz({
      uzytkownik: req.body?.operator ?? null, akcja: 'zapas_k4', artykul_gt_id: artykulGtId,
      magazyn: 'K4', po: { zapas_kod: zapas }, wynik: ok ? 'ok' : 'sync_blad',
    });
    res.json({ zapas_kod: zapas, sync_ok: !!ok, blad: ok ? null : (wynik?.blad ?? null) });
  } catch (err) {
    next(err);
  }
});

// GET /api/lokalizacje/plan/:artykul_gt_id?magazyn= - zachowany plan lokalizacji z GT
router.get('/plan/:artykul_gt_id', (req, res) => {
  const mag = (req.query.magazyn ?? 'K4G').toUpperCase();
  const w = db.prepare('SELECT tekst FROM plan_lokalizacji WHERE artykul_gt_id = ? AND magazyn = ?').get(req.params.artykul_gt_id, mag);
  res.json(w ?? null);
});

// PUT /api/lokalizacje/plan/:artykul_gt_id - zapisz/wyczysc plan (pusty tekst = usun)
router.put('/plan/:artykul_gt_id', (req, res) => {
  const id = req.params.artykul_gt_id;
  const mag = (req.body?.magazyn ?? 'K4G').toUpperCase();
  const tekst = (req.body?.tekst ?? '').trim();
  // UWAGA: NIE audytujemy planu - to automatyczna sciaga z GT (cache planowanych
  // lokalizacji), zapisywana przy kazdym otwarciu produktu, a nie akcja magazyniera.
  // Audyt biznesowy zasmiecaloby to setkami wpisow "Plan lok." bez wartosci.
  if (!tekst) {
    db.prepare('DELETE FROM plan_lokalizacji WHERE artykul_gt_id = ? AND magazyn = ?').run(id, mag);
    return res.json({ tekst: null });
  }
  db.prepare(`INSERT INTO plan_lokalizacji (artykul_gt_id, magazyn, tekst) VALUES (?, ?, ?)
              ON CONFLICT(artykul_gt_id, magazyn) DO UPDATE SET tekst = excluded.tekst`).run(id, mag, tekst);
  res.json({ tekst });
});

// GET /api/lokalizacje/:id - szczegoly lokalizacji + jej zawartosc
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ blad: 'Nieprawidlowe id' });

  const lokalizacja = db.prepare('SELECT * FROM lokalizacje WHERE id = ?').get(id);
  if (!lokalizacja) return res.status(404).json({ blad: 'Lokalizacja nie znaleziona' });

  const zawartosc = db.prepare(
    `SELECT artykul_gt_id, artykul_symbol, artykul_nazwa, ilosc, ostatnia_zmiana, operator
     FROM stany_lokalizacji
     WHERE lokalizacja_id = ? AND ilosc > 0
     ORDER BY artykul_symbol`
  ).all(id);

  res.json({ ...lokalizacja, zawartosc });
});

// POST /api/lokalizacje - nowa lokalizacja
router.post('/', (req, res) => {
  const { kod, magazyn } = req.body ?? {};

  if (typeof kod !== 'string' || !kod.trim()) {
    return res.status(400).json({ blad: 'Pole "kod" jest wymagane' });
  }
  if (!MAGAZYNY_WMS.includes(magazyn)) {
    return res.status(400).json({ blad: `Pole "magazyn" musi byc jednym z: ${MAGAZYNY_WMS.join(', ')}` });
  }

  try {
    const result = db.prepare('INSERT INTO lokalizacje (kod, magazyn) VALUES (?, ?)').run(kod.trim(), magazyn);
    audyt.zapisz({ uzytkownik: req.body?.operator ?? null, akcja: 'lokalizacja_nowa', magazyn, lokalizacja: kod.trim(), po: { kod: kod.trim(), magazyn }, wynik: 'ok' });
    res.status(201).json(db.prepare('SELECT * FROM lokalizacje WHERE id = ?').get(result.lastInsertRowid));
  } catch (err) {
    if (err.errcode === SQLITE_CONSTRAINT_UNIQUE) {
      return res.status(409).json({ blad: `Lokalizacja o kodzie "${kod.trim()}" juz istnieje` });
    }
    throw err;
  }
});

// PUT /api/lokalizacje/:id - edycja (kod, magazyn, aktywna)
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ blad: 'Nieprawidlowe id' });

  const lokalizacja = db.prepare('SELECT * FROM lokalizacje WHERE id = ?').get(id);
  if (!lokalizacja) return res.status(404).json({ blad: 'Lokalizacja nie znaleziona' });

  const { kod, magazyn, aktywna } = req.body ?? {};

  const nowyKod = kod !== undefined ? String(kod).trim() : lokalizacja.kod;
  const nowyMagazyn = magazyn !== undefined ? magazyn : lokalizacja.magazyn;
  const nowaAktywna = aktywna !== undefined ? (aktywna ? 1 : 0) : lokalizacja.aktywna;

  if (!nowyKod) return res.status(400).json({ blad: 'Pole "kod" nie moze byc puste' });
  if (!MAGAZYNY_WMS.includes(nowyMagazyn)) {
    return res.status(400).json({ blad: `Pole "magazyn" musi byc jednym z: ${MAGAZYNY_WMS.join(', ')}` });
  }

  try {
    db.prepare('UPDATE lokalizacje SET kod = ?, magazyn = ?, aktywna = ? WHERE id = ?')
      .run(nowyKod, nowyMagazyn, nowaAktywna, id);
  } catch (err) {
    if (err.errcode === SQLITE_CONSTRAINT_UNIQUE) {
      return res.status(409).json({ blad: `Lokalizacja o kodzie "${nowyKod}" juz istnieje` });
    }
    throw err;
  }

  audyt.zapisz({
    uzytkownik: req.body?.operator ?? null, akcja: 'lokalizacja_edycja', magazyn: nowyMagazyn, lokalizacja: nowyKod,
    przed: { kod: lokalizacja.kod, magazyn: lokalizacja.magazyn, aktywna: lokalizacja.aktywna },
    po: { kod: nowyKod, magazyn: nowyMagazyn, aktywna: nowaAktywna }, wynik: 'ok',
  });
  res.json(db.prepare('SELECT * FROM lokalizacje WHERE id = ?').get(id));
});

// DELETE /api/lokalizacje/:id - usuniecie (tylko gdy brak powiazanej historii stanow)
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ blad: 'Nieprawidlowe id' });

  const lokalizacja = db.prepare('SELECT * FROM lokalizacje WHERE id = ?').get(id);
  if (!lokalizacja) return res.status(404).json({ blad: 'Lokalizacja nie znaleziona' });

  const { liczba } = db.prepare('SELECT COUNT(*) AS liczba FROM stany_lokalizacji WHERE lokalizacja_id = ?').get(id);
  if (liczba > 0) {
    return res.status(409).json({ blad: 'Nie mozna usunac - lokalizacja ma zapisana historie stanow. Oznacz ja jako nieaktywna (aktywna=0).' });
  }

  db.prepare('DELETE FROM lokalizacje WHERE id = ?').run(id);
  audyt.zapisz({
    uzytkownik: req.body?.operator ?? null, akcja: 'lokalizacja_usuniecie', magazyn: lokalizacja.magazyn, lokalizacja: lokalizacja.kod,
    przed: { kod: lokalizacja.kod, magazyn: lokalizacja.magazyn }, wynik: 'ok',
  });
  res.status(204).send();
});

module.exports = router;
