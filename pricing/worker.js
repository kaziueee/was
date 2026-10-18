'use strict';

// Worker repricera — OSOBNY proces obok WMS (nie w app.js): awaria albo wolne API platformy
// nie może zatrzymać magazynu. Na SRV chodzi jako zadanie harmonogramu `WMS-Pricing`.
//
// Co przebieg (PRICING_INTERWAL_MIN, domyślnie 30 min):
//   1. raz na dobę — synchronizacja listy ofert z Amazona (pricing/sync-oferty.js); eMAG RO, HU i BG
//      (PRICING_EMAG_KRAJE) co przebieg (pricing/sync-emag.js) — ta sama lista służy do obserwacji,
//      więc to jedno pobranie na rynek (~30 zapytań). Ceny wychodzą tylko na kanały bez `tylkoOdczyt`.
//      Bez EMAG_RO_USER w .env część eMAG jest pomijana; jej błąd (np. IP spoza listy w panelu
//      eMAG) nie zatrzymuje przebiegu Amazona. Empik (pricing/sync-empik.js, od 2026-10-16) — lista
//      ofert raz na dobę eksportem OF52 (~20 s); bez EMPIK_API_KEY pomijany. Allegro
//      (pricing/sync-allegro.js, od 2026-10-16) — lista aktywnych ofert każdego podpiętego konta co przebieg
//      (~4 zapytania na konto), jak eMAG; bez ALLEGRO_CLIENT_ID albo bez tokenu konta — pomijane.
//      Kaufland (PRICING_KAUFLAND_RYNKI, domyślnie DE) tak samo co przebieg (pricing/sync-kaufland.js +
//      ranking Buy Boxa per produkt, pricing/obserwuj-kaufland.js); bez KAUFLAND_CLIENT_KEY pomijany.
//   2. obserwacja ofert: z włączonym automatem ZAWSZE, pozostałe ze stanem raz na
//      PRICING_PELNY_MIN (domyślnie 360 min) — żeby przed włączeniem automatu było widać,
//      co by zrobił, bez odpytywania całego katalogu co pół godziny (Amazon i Empik; eMAG co przebieg)
//   3. pas [min, max] i zysk z kalkulatora WMS (pricing/pas.js); ręczne min/max oferty z ekranu Ceny
//      wygrywają z kalkulatorem (pricing/granice.js)
//   4. decyzja (pricing/model.js) → tabela `decyzje`
//
// Dwa tryby oferty (decyzja usera 2026-10-13 — tryb Próba zlikwidowany):
//   - automat (auto = 1): decyzje ze zmianą ceny idą od razu na Amazona,
//   - ręczny  (auto = 0): nic nie wysyłamy; decyzja zapisuje się jako podpowiedź (pełny przegląd co 6 h).
// PRICING_ZAPIS=1 w .env to nie tryb, tylko globalny hamulec: bez niego worker nie wyśle niczego
// (awaryjne zatrzymanie wszystkich cen jedną zmianą; ekran pokazuje wtedy ostrzeżenie).
//
//   node pricing/worker.js --raz [--pelny]   — jeden przebieg i koniec
//   node pricing/worker.js                   — w pętli

const { db, stan } = require('./db');
const { obserwuj } = require('./obserwuj');
const { pasyHurtem } = require('./pas');
const { zGranicami } = require('./granice');
const { decyzja, DOMYSLNE_REGULY } = require('./model');
const { synchronizuj } = require('./sync-oferty');
const { synchronizujEmag, odswiezProwizje } = require('./sync-emag');
const { obserwujEmag } = require('./obserwuj-emag');
const emag = require('./emag');
const { synchronizujEmpik } = require('./sync-empik');
const { obserwujEmpik } = require('./obserwuj-empik');
const { odswiezStawki } = require('./empik-prowizje');
const empik = require('./empik');
const { synchronizujAllegro, odswiezProwizje: odswiezProwizjeAllegro } = require('./sync-allegro');
const { obserwujAllegro } = require('./obserwuj-allegro');
const allegro = require('./allegro');
const { synchronizujKaufland } = require('./sync-kaufland');
const { obserwujKaufland } = require('./obserwuj-kaufland');
const kaufland = require('./kaufland');
const { kluczKolumny, kolumna } = require('./kolumny');
const { takaSamaDecyzja } = require('./bez-zmian');
const { ustawCene } = require('./amazon');
const { pewneDopasowanie } = require('./powiazania');
const { interwalMsZMinut } = require('../services/interwal');

const PELNY_MS = interwalMsZMinut(process.env.PRICING_PELNY_MIN, 360, 'PRICING_PELNY_MIN');
// Które platformy obsługuje ten proces (domyślnie wszystkie). Do testów na drugiej maszynie:
// PRICING_PLATFORMY=emag nie dotyka API Amazona, więc nie zjada limitów workera na SRV.
const PLATFORMY = new Set(String(process.env.PRICING_PLATFORMY || 'amazon,emag,empik,allegro,kaufland').split(',').map((x) => x.trim().toLowerCase()));
const SYNC_MS = 24 * 60 * 60 * 1000;
// Rynki eMAG obsługiwane przez ten proces (pricing/emag.js KRAJE); domyślnie wszystkie.
const EMAG_KRAJE = String(process.env.PRICING_EMAG_KRAJE || 'RO,HU,BG').split(',').map((x) => x.trim().toUpperCase()).filter((k) => emag.KRAJE[k]);
// Konta Allegro obsługiwane przez ten proces (pricing/allegro.js KONTA); domyślnie wszystkie podpięte.
const ALLEGRO_KONTA = String(process.env.PRICING_ALLEGRO_KONTA || Object.keys(allegro.KONTA).join(',')).split(',').map((x) => x.trim().toUpperCase()).filter((k) => allegro.KONTA[k]);
// Storefronty Kaufland (pricing/kaufland.js STOREFRONTY); domyślnie tylko DE — inne dopiero, gdy znamy ich koszty.
const KAUFLAND_RYNKI = String(process.env.PRICING_KAUFLAND_RYNKI || 'DE').split(',').map((x) => x.trim().toUpperCase()).filter((k) => kaufland.STOREFRONTY[k]);

const minelo = (klucz, ms) => {
  const s = stan.get(klucz);
  return !s || Date.now() - new Date(s.czas.replace(' ', 'T') + 'Z').getTime() >= ms;
};

async function przebieg({ pelny = false } = {}) {
  const t0 = Date.now();
  const wynik = {};
  if (PLATFORMY.has('amazon') && minelo('sync_oferty', SYNC_MS)) {
    const s = await synchronizuj();
    stan.set('sync_oferty', JSON.stringify(s.map((x) => [x.rynek, x.ofert])));
    wynik.sync = s.reduce((a, x) => a + x.ofert, 0);
  }

  // eMAG: lista ofert = synchronizacja + materiał do obserwacji, osobno na każdy rynek (RO, HU, BG —
  // to samo konto i dane logowania). Błąd jednego rynku tylko odnotowujemy, reszta idzie dalej.
  let emagSurowe = null;
  const emagKraje = new Set();
  if (PLATFORMY.has('emag') && emag.skonfigurowany()) {
    emagSurowe = [];
    const podsum = {};
    for (const kraj of EMAG_KRAJE) {
      try {
        const lista = await emag.wszystkieOferty(kraj);
        const s = await synchronizujEmag(lista, kraj);
        emagSurowe.push(...lista);
        emagKraje.add(kraj);
        podsum[kraj] = s;
        // Stawki prowizji per oferta — porcjami; błąd nie zatrzymuje przebiegu (kalkulator ma stawkę domyślną).
        try {
          const pr = await odswiezProwizje(lista, 120, kraj);
          if (pr.sprawdzone) (wynik.emag_prowizje ||= {})[kraj] = pr;
        } catch (e) { console.error(new Date().toISOString(), `[pricing] eMAG ${kraj} prowizje:`, e.message); }
      } catch (e) {
        stan.set('blad_emag', `${kraj}: ${e.message}`);
        console.error(new Date().toISOString(), `[pricing] eMAG ${kraj}:`, e.message);
      }
    }
    if (emagKraje.size) {
      stan.set('sync_emag', JSON.stringify(podsum));
      wynik.emag = Object.fromEntries(Object.entries(podsum).map(([k, s]) => [k, s.aktywne]));
    }
  }

  // Kaufland: lista ofert (units) = synchronizacja + nasze id_unit do obserwacji i zapisu, osobno na
  // storefront. Bez kluczy w .env pomijany; błąd nie zatrzymuje Amazona ani eMAG.
  const kauflandSurowe = [];
  const kauflandRynki = new Set();
  if (PLATFORMY.has('kaufland') && kaufland.skonfigurowany()) {
    const podsum = {};
    for (const rynek of KAUFLAND_RYNKI) {
      try {
        const lista = await kaufland.wszystkieUnits(rynek);
        podsum[rynek] = await synchronizujKaufland(lista, rynek);
        kauflandSurowe.push(...lista);
        kauflandRynki.add(rynek);
      } catch (e) {
        stan.set('blad_kaufland', `${rynek}: ${e.message}`);
        console.error(new Date().toISOString(), `[pricing] Kaufland ${rynek}:`, e.message);
      }
    }
    if (kauflandRynki.size) {
      stan.set('sync_kaufland', JSON.stringify(podsum));
      wynik.kaufland = Object.fromEntries(Object.entries(podsum).map(([k, s]) => [k, s.aktywne]));
    }
  }

  const pelnyTeraz = pelny || minelo('obserwacja_pelna', PELNY_MS);
  const zapisWlaczony = process.env.PRICING_ZAPIS === '1';

  // Empik: lista ofert raz na dobę (eksport OF52 — pełny wolno raz na dobę; OF21 strona po stronie Empik
  // dławi i przebieg stał przez to 17 min). Naszą cenę i Buy Box daje obserwacja (P11), więc między
  // synchronizacjami lista nie jest potrzebna. Błąd Empiku nie zatrzymuje reszty przebiegu.
  let empikSurowe = null, empikOk = false;
  if (PLATFORMY.has('empik') && empik.skonfigurowany()) {
    try {
      if (minelo('sync_empik', SYNC_MS)) {
        empikSurowe = await empik.wszystkieOferty();
        const s = await synchronizujEmpik(empikSurowe);
        stan.set('sync_empik', JSON.stringify(s));
        wynik.empik = s.aktywne;
        // Stawki prowizji per kategoria z zamówień (pricing/empik-prowizje.js) — razem z listą, raz na dobę.
        try { wynik.empik_stawki = await odswiezStawki(); } catch (e) { console.error(new Date().toISOString(), '[pricing] Empik stawki:', e.message); }
      }
      empikOk = true;
    } catch (e) {
      stan.set('blad_empik', e.message);
      console.error(new Date().toISOString(), '[pricing] Empik:', e.message);
    }
  }

  // Allegro: lista aktywnych ofert każdego podpiętego konta (jak eMAG — ta sama lista idzie do obserwacji).
  // Konto bez tokenu pomijamy po cichu (jeszcze niepodpięte); błąd jednego konta nie zatrzymuje reszty.
  const allegroSurowe = [];
  const allegroKonta = new Set();
  if (PLATFORMY.has('allegro') && allegro.skonfigurowany()) {
    const podsum = {};
    const podpiete = allegro.kontaAutoryzowane();
    for (const konto of ALLEGRO_KONTA.filter((k) => podpiete.includes(k))) {
      try {
        const lista = await allegro.wszystkieOferty(konto);
        podsum[konto] = await synchronizujAllegro(konto, lista);
        allegroSurowe.push(...lista);
        allegroKonta.add(konto);
        // Stawki prowizji per oferta (podgląd opłat Allegro) — porcjami; błąd nie zatrzymuje przebiegu.
        try {
          const pr = await odswiezProwizjeAllegro(konto, lista, 400);
          if (pr.sprawdzone) (wynik.allegro_prowizje ||= {})[konto] = pr;
        } catch (e) { console.error(new Date().toISOString(), `[pricing] Allegro ${konto} prowizje:`, e.message); }
      } catch (e) {
        stan.set('blad_allegro', `${konto}: ${e.message}`);
        console.error(new Date().toISOString(), `[pricing] Allegro ${konto}:`, e.message);
      }
    }
    if (allegroKonta.size) {
      stan.set('sync_allegro', JSON.stringify(podsum));
      wynik.allegro = Object.fromEntries(Object.entries(podsum).map(([k, x]) => [k, x.aktywne]));
    }
  }

  // Amazon i Empik: oferty z automatem co przebieg, cały katalog w pełnej obserwacji (limity API).
  // eMAG, Allegro i Kaufland: zawsze cały katalog — obserwacja czyta listę pobraną wyżej (Kaufland dokłada
  // ranking Buy Boxa per produkt).
  const oferty = db.prepare(`SELECT id, platforma, rynek, sku, asin, tw_id, auto, genius, dopasowanie, prowizja, min_reczne, max_reczne FROM oferty
     WHERE ((platforma = 'amazon' AND ? AND (auto = 1 OR ?)) OR (platforma = 'emag' AND ?) OR (platforma = 'empik' AND ? AND (auto = 1 OR ?))
            OR (platforma = 'allegro' AND ?) OR (platforma = 'kaufland' AND ?))
       AND aktywna = 1 AND ilosc > 0 AND tw_id IS NOT NULL`).all(PLATFORMY.has('amazon') ? 1 : 0, pelnyTeraz ? 1 : 0, emagKraje.size ? 1 : 0,
    empikOk ? 1 : 0, pelnyTeraz ? 1 : 0, allegroKonta.size ? 1 : 0, kauflandRynki.size ? 1 : 0)
    .filter((o) => o.platforma !== 'emag' || emagKraje.has(o.rynek))       // rynek eMAG z błędem pobrania — bez decyzji
    .filter((o) => o.platforma !== 'allegro' || allegroKonta.has(o.rynek))  // konto Allegro z błędem pobrania — też
    .filter((o) => o.platforma !== 'kaufland' || kauflandRynki.has(o.rynek));
  wynik.ofert = oferty.length;
  wynik.pelny = pelnyTeraz;
  if (!oferty.length) return wynik;

  const amazon = oferty.filter((o) => o.platforma === 'amazon');
  const emagOf = oferty.filter((o) => o.platforma === 'emag');
  const empikOf = oferty.filter((o) => o.platforma === 'empik');
  const allegroOf = oferty.filter((o) => o.platforma === 'allegro');
  const kauflandOf = oferty.filter((o) => o.platforma === 'kaufland');
  // Genius i stawka prowizji są per RYNEK (ten sam towar: RO 16%, HU 18%) — mapa tw_Id → { kolumna: wartość }.
  const poKolumnie = (lista, pole, ok, wartosc) => {
    const m = new Map();
    for (const o of lista) if (ok(o[pole])) (m.get(o.tw_id) || m.set(o.tw_id, {}).get(o.tw_id))[kluczKolumny(o.platforma, o.rynek)] = wartosc(o[pole]);
    return m;
  };
  const geniusPoTw = poKolumnie(emagOf, 'genius', (v) => v != null, (v) => !!v);
  // Stawka prowizji per oferta: eMAG z commission/estimate, Empik z kategorii (pricing/empik-prowizje.js),
  // Allegro z podglądu opłat (pricing/sync-allegro.js odswiezProwizje).
  const prowizjaPoTw = poKolumnie([...emagOf, ...empikOf, ...allegroOf], 'prowizja', (v) => v > 0, (v) => v);
  // Empik: błąd P11 (limit, awaria) = oferty bez obserwacji w tym przebiegu, reszta idzie dalej.
  const obsEmpik = empikOf.length ? obserwujEmpik(empikOf, { surowe: empikSurowe }).catch((e) => {
    stan.set('blad_empik', e.message);
    console.error(new Date().toISOString(), '[pricing] Empik obserwacja:', e.message);
    return new Map();
  }) : new Map();
  const [obsA, obsE, obsP, obsL, pasy, obsK] = await Promise.all([
    amazon.length ? obserwuj(amazon) : new Map(),
    emagOf.length ? obserwujEmag(emagOf, emagSurowe) : new Map(),
    obsEmpik,
    allegroOf.length ? obserwujAllegro(allegroOf, allegroSurowe) : new Map(),
    pasyHurtem(oferty.map((o) => o.tw_id), geniusPoTw, prowizjaPoTw),
    kauflandOf.length ? obserwujKaufland(kauflandOf, kauflandSurowe) : new Map(),
  ]);
  if (obsA.bledyPaczek) wynik.bledy_paczek = obsA.bledyPaczek;
  if (emagOf.length) wynik.emag_obs = { ofert: obsE.size, zmian: obsE.nowe || 0 };
  if (kauflandOf.length) wynik.kaufland_obs = { ofert: obsK.size, zmian: obsK.nowe || 0, ...(obsK.bledy ? { bledy: obsK.bledy } : {}) };
  if (empikOf.length) wynik.empik_obs = { ofert: obsP.size, zmian: obsP.nowe || 0 };
  if (allegroOf.length) wynik.allegro_obs = { ofert: obsL.size, zmian: obsL.nowe || 0 };
  const obs = { get: (id) => obsA.get(id) || obsE.get(id) || obsP.get(id) || obsL.get(id) || obsK.get(id) };
  const allegroPoId = new Map(allegroSurowe.map((x) => [`${x._konto}|${x.id}`, x]));
  const kluczEmag = (kraj, sku) => `${kraj}|${String(sku || '').trim().toUpperCase()}`;
  const emagPoSku = new Map((emagSurowe || []).map((x) => [kluczEmag(x._kraj, x.part_number), x]));
  const kauflandPoSku = new Map(kauflandSurowe.map((u) => [kluczEmag(u._rynek, u.id_offer), u]));

  const zapisz = db.prepare(`INSERT INTO decyzje (oferta_id, cena_przed, cena_nowa, min, max, kod, powod, wyslano, auto, zysk, marza, zysk_nowa, blad, marza_nowa, cena_cel, zysk_cel)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const kody = {};
  const wysylka = { wyslane: 0, odrzucone: 0 };
  const doPotwierdzenia = [];   // oferty z przyjętą zmianą — sprawdzimy je jeszcze raz po kilku minutach
  // Empik: import cen (PRI01) wolno wysłać najwyżej raz na minutę — decyzje zbieramy i po pętli idą
  // jednym plikiem. { o, ob, d, wiersz } — wiersz decyzji dostaje wynik wysyłki przed zapisem do bazy.
  const empikPaczka = [];
  // Decyzje liczymy w pamięci, a zapis do bazy robimy po wysłaniu — wywołania API nie mogą
  // trzymać otwartej transakcji SQLite (WMS czyta tę bazę w tym samym czasie).
  const wiersze = [];
  // Kontekst reguły „czułej na utratę BB" (pricing/model.js, reguła 6) — z historii decyzji tej oferty.
  const okno = `-${DOMYSLNE_REGULY.blokadaPodwyzekH} hours`;
  // Ręczna podwyżka z ekranu (`korekta`) to decyzja człowieka, nie podwyżka „po zysk” — reguła 6 jej nie cofa.
  const ostPodwyzka = db.prepare(`SELECT cena_przed, cena_nowa FROM decyzje WHERE oferta_id = ? AND wyslano = 1
      AND cena_nowa > cena_przed AND kod <> 'korekta' AND czas >= datetime('now', ?) ORDER BY id DESC LIMIT 1`);
  const cofniecie = db.prepare(`SELECT 1 FROM decyzje WHERE oferta_id = ? AND kod LIKE 'cofniecie%'
      AND czas >= datetime('now', ?) LIMIT 1`);
  // Reguła 8 (wojna o grosze): wysłane obniżki od ostatniej obserwacji z NASZYM Buy Boxem (najdalej
  // 3 doby wstecz) i godziny od ostatniej z nich. Liczymy RÓŻNE ceny, nie wysyłki: Amazon potrafi
  // pokazać nową cenę dopiero po >30 min i ta sama obniżka idzie 2–3 razy (HWHJDY16 DE 15.10:
  // 71,43 wysłane trzy razy, BB przyszedł po trzecim) — to jeden krok, nie trzy. Schodki −5%
  // (`obnizka_limit`, `na_min_limit`) się nie liczą: to zejście do dalekiego Buy Boxa, którego
  // jeszcze nie dogoniliśmy, a nie konkurent odpowiadający na nasz krok (na produkcji liczenie
  // schodków dawało 9 „wojen” zamiast 3).
  const obnizkiBezBb = db.prepare(`SELECT COUNT(DISTINCT cena_nowa) AS n, (julianday('now') - julianday(MAX(czas))) * 24 AS godzOd
      FROM decyzje WHERE oferta_id = ? AND wyslano = 1 AND kod IN ('obnizka', 'na_min')
       AND czas >= datetime('now', '-72 hours')
       AND czas > COALESCE((SELECT MAX(czas) FROM obserwacje WHERE oferta_id = ? AND bb_nasz = 1), '')`);
  // Decyzję liczymy co przebieg, ale niewysłaną zapisujemy tylko, gdy się zmieniła (niżej).
  const ostDecyzja = db.prepare('SELECT * FROM decyzje WHERE oferta_id = ? ORDER BY id DESC LIMIT 1');
  // Automat czytany jeszcze raz tuż przed wysłaniem: przebieg trwa minuty, a w tym czasie człowiek mógł go
  // wyłączyć albo zmienić cenę ręcznie (POST /api/ceny/cena wyłącza automat) — stara kopia by to nadpisała.
  const autoTeraz = db.prepare('SELECT auto FROM oferty WHERE id = ?');
  for (const o of oferty) {
    const ob = obs.get(o.id);
    if (!ob) { kody.brak_odpowiedzi = (kody.brak_odpowiedzi || 0) + 1; continue; }
    const pas = zGranicami((pasy.get(o.tw_id) || {})[kluczKolumny(o.platforma, o.rynek)] || null, o);
    const d = decyzja(ob, pas || {}, kolumna(o.platforma, o.rynek)?.reguly || {}, {
      ostatniaPodwyzka: ostPodwyzka.get(o.id, okno) || null,
      blokadaPodwyzek: !!cofniecie.get(o.id, okno),
      obnizkiBezBb: obnizkiBezBb.get(o.id, o.id) || null,
    });
    if (pas?.blad && d.kod === 'brak_pasa') d.powod = pas.blad;   // sprzeczne ręczne granice — powiedz które
    if (o.auto && d.zmiana && autoTeraz.get(o.id)?.auto !== 1) o.auto = 0;
    const teraz = pas && ob.cena ? pas.ocen(ob.cena) : null;
    const potem = pas && d.zmiana ? pas.ocen(d.cena) : teraz;
    const celOc = pas && d.zmiana && d.cel !== d.cena ? pas.ocen(d.cel) : potem;
    let wyslano = 0, blad = null, wPaczce = false;
    // Druga linia obrony obok POST /automat: bez pewnego dopasowania do GT nie wysyłamy, nawet gdy
    // auto = 1 (np. włączone przed wprowadzeniem zasady albo przez bezpośredni zapis w bazie). Kanał
    // `tylkoOdczyt` (pricing/kolumny.js) nie wysyła nigdy — także tu, nie tylko w routes/ceny.js.
    const kanalZapis = !kolumna(o.platforma, o.rynek)?.tylkoOdczyt;
    if (zapisWlaczony && o.auto && d.zmiana && pas && kanalZapis && pewneDopasowanie(o.dopasowanie) && o.platforma === 'empik') {
      empikPaczka.push({ o, ob, d });
      wPaczce = true;
    } else if (zapisWlaczony && o.auto && d.zmiana && pas && kanalZapis && pewneDopasowanie(o.dopasowanie)) {
      try {
        let w;
        if (o.platforma === 'amazon') w = await ustawCene(o.rynek, o.sku, d.cena);
        else if (o.platforma === 'emag') {
          // Oferta z listy pobranej na początku przebiegu: id eMAG, VAT i zakres min/max z panelu.
          const s = emagPoSku.get(kluczEmag(o.rynek, o.sku));
          w = s ? await emag.ustawCene(s, d.cena) : { ok: false, blad: 'oferty nie ma na liście eMAG z tego przebiegu' };
        } else if (o.platforma === 'allegro') {
          // Oferta z listy tego przebiegu (numer, format, reguła cenowa Allegro — zmianaCeny ją sprawdza).
          const s = allegroPoId.get(`${o.rynek}|${o.asin}`);
          w = s ? await allegro.ustawCene(s, d.cena) : { ok: false, blad: 'oferty nie ma na liście Allegro z tego przebiegu' };
        } else if (o.platforma === 'kaufland') {
          // Unit z listy pobranej na początku przebiegu: id_unit i minimum Smart Pricing.
          const u = kauflandPoSku.get(kluczEmag(o.rynek, o.sku));
          w = u ? await kaufland.ustawCene(u, d.cena) : { ok: false, blad: 'oferty nie ma na liście Kaufland z tego przebiegu' };
        } else w = { ok: false, blad: `zapis na ${o.platforma} nieobsługiwany` };
        if (w.ok) { wyslano = 1; wysylka.wyslane++; doPotwierdzenia.push(o); }
        else { blad = w.blad || `${o.platforma}: ${w.status}`; wysylka.odrzucone++; }
      } catch (e) { blad = e.message; wysylka.odrzucone++; }
      console.log(new Date().toISOString(), `[pricing] ${kluczKolumny(o.platforma, o.rynek)} ${o.sku}: ${ob.cena} → ${d.cena} ${wyslano ? 'WYSŁANO' : 'NIE WYSŁANO: ' + blad}`);
    }
    const wiersz = [o.id, ob.cena, d.cena, pas?.min ?? null, pas?.max ?? null, d.kod, d.powod, wyslano, o.auto,
      teraz?.zysk ?? null, teraz?.marza ?? null, potem?.zysk ?? null, blad, potem?.marza ?? null,
      d.cel ?? null, celOc?.zysk ?? null];
    if (wPaczce) empikPaczka[empikPaczka.length - 1].wiersz = wiersz;
    // Decyzja niewysłana, bez błędu i taka sama jak poprzednia nie dostaje nowego wiersza (eMAG to cały
    // katalog co przebieg). Wysłane i odrzucone zapisujemy zawsze — na nich stoją reguły 6 i 8 i log.
    if (wPaczce || wyslano || blad || !takaSamaDecyzja(ostDecyzja.get(o.id), { kod: d.kod, cena_przed: ob.cena, cena_nowa: d.cena,
      cena_cel: d.cel ?? null, min: pas?.min ?? null, max: pas?.max ?? null, zysk: teraz?.zysk ?? null,
      zysk_nowa: potem?.zysk ?? null, zysk_cel: celOc?.zysk ?? null })) wiersze.push(wiersz);
    if (o.auto) kody[d.kod] = (kody[d.kod] || 0) + 1;
  }
  if (empikPaczka.length) wynik.empik_import = await wyslijEmpik(empikPaczka, empikSurowe, wysylka, doPotwierdzenia);
  db.exec('BEGIN');
  try {
    for (const w of wiersze) zapisz.run(...w);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  if (wysylka.wyslane || wysylka.odrzucone) wynik.wysylka = wysylka;
  if (doPotwierdzenia.length) wynik.doPotwierdzenia = doPotwierdzenia;
  if (pelnyTeraz) stan.set('obserwacja_pelna', oferty.length);
  wynik.sekundy = Math.round((Date.now() - t0) / 1000);   // pulpit na ekranie Ceny pokazuje, ile trwał przebieg
  stan.set('przebieg', JSON.stringify(wynik));
  return { ...wynik, automat: kody };
}

// Empik: jeden import cen (PRI01) na przebieg. Do sprawdzenia promocji (import by ją skasował) bierzemy
// naszą ofertę z listy tego przebiegu (eksport), a zwykle z P11 tej samej obserwacji (ob.surowa); OF21 po
// SKU tylko awaryjnie — Empik go dławi (~33 s na zapytanie). Bez oferty nie wiemy, czy jest promocja,
// więc nie wysyłamy. Wynik trafia do wierszy decyzji (indeksy jak w `wiersz` w przebiegu: 7 = wyslano, 12 = blad).
// `ok` znaczy „Empik przyjął plik”; czy cena weszła, pokaże potwierdzenie (PRI02 + P11).
const W_WYSLANO = 7, W_BLAD = 12;
async function wyslijEmpik(paczka, surowe, wysylka, doPotwierdzenia) {
  const poSku = new Map((surowe || []).map((x) => [String(x.shop_sku || '').trim().toUpperCase(), x]));
  const doWyslania = [];
  for (const x of paczka) {
    let s = poSku.get(String(x.o.sku).trim().toUpperCase()) || (x.ob?.surowa ? { ...x.ob.surowa, shop_sku: x.o.sku } : null);
    if (!s) {
      try { s = (await empik.ofertaPoSku(x.o.sku))[0]; } catch (e) { x.blad = `nie udało się pobrać oferty Empik: ${e.message}`; }
    }
    if (s) doWyslania.push({ x, surowa: s });
    else x.blad ||= 'oferty nie ma na liście Empik';
  }
  const res = doWyslania.length ? await empik.ustawCeny(doWyslania.map(({ x, surowa }) => ({ surowa, cena: x.d.cena }))) : { importId: null, wyniki: [] };
  doWyslania.forEach(({ x }, i) => { const w = res.wyniki[i]; if (w.ok) x.ok = true; else x.blad = w.blad; });
  for (const x of paczka) {
    if (x.ok) { x.wiersz[W_WYSLANO] = 1; wysylka.wyslane++; doPotwierdzenia.push(x.o); }
    else { x.wiersz[W_BLAD] = x.blad || 'Empik: nie wysłano'; wysylka.odrzucone++; }
    console.log(new Date().toISOString(), `[pricing] EMPIK_PL ${x.o.sku}: ${x.ob.cena} → ${x.d.cena} ${x.ok ? `WYSŁANO (import ${res.importId})` : 'NIE WYSŁANO: ' + x.blad}`);
  }
  if (res.importId) stan.set('empik_import', JSON.stringify({ id: res.importId, ofert: paczka.filter((x) => x.ok).length }));
  return res.importId;
}

// Potwierdzenie po wysłaniu: Amazon pokazuje nową cenę po ~3 min, a pełny przebieg jest co 30.
// Sprawdzamy więc wysłane oferty jeszcze raz po PRICING_POTWIERDZENIE_MIN (domyślnie 5) — sama
// obserwacja, bez decyzji. Ekran WMS od razu ma wtedy faktyczny stan (cena i Buy Box po zmianie).
const POTWIERDZENIE_MS = interwalMsZMinut(process.env.PRICING_POTWIERDZENIE_MIN, 5, 'PRICING_POTWIERDZENIE_MIN');
// eMAG wprowadza nową cenę po ~4 min (test FPCNM42 15.10) — sprawdzamy później niż Amazona.
const POTWIERDZENIE_EMAG_MS = interwalMsZMinut(process.env.PRICING_POTWIERDZENIE_EMAG_MIN, 8, 'PRICING_POTWIERDZENIE_EMAG_MIN');
// Empik: czas od importu cen (PRI01) do ceny na stronie jeszcze nieznany — do zmierzenia testem zapisu.
const POTWIERDZENIE_EMPIK_MS = interwalMsZMinut(process.env.PRICING_POTWIERDZENIE_EMPIK_MIN, 10, 'PRICING_POTWIERDZENIE_EMPIK_MIN');
// Allegro: PATCH 200 = „zmiany wdrożymy od razu” (dokumentacja), 202 = w toku — czas do zmierzenia testem zapisu.
const POTWIERDZENIE_ALLEGRO_MS = interwalMsZMinut(process.env.PRICING_POTWIERDZENIE_ALLEGRO_MIN, 5, 'PRICING_POTWIERDZENIE_ALLEGRO_MIN');
// Kaufland: cena widoczna w rankingu Buy Boxa po 1–2 min (test HASG1777-G1784, 16.10).
const POTWIERDZENIE_KAUFLAND_MS = interwalMsZMinut(process.env.PRICING_POTWIERDZENIE_KAUFLAND_MIN, 3, 'PRICING_POTWIERDZENIE_KAUFLAND_MIN');

// Ręczne zmiany cen z ekranu (POST /api/ceny/cena) wysyła WMS, nie worker — worker tylko je potwierdza,
// tą samą drogą co własne wysyłki. Sprawdzamy dwa razy: po czasie propagacji platformy i po trzykrotności
// (Amazon 3–10 min, eMAG RO bywa wolniejszy), bo oferty bez automatu obserwujemy tylko co 6 h.
// Zapamiętane w pamięci procesu — po restarcie korekta z ostatnich 2 h może być sprawdzona raz jeszcze.
const PROPAGACJA_MS = { amazon: POTWIERDZENIE_MS, emag: POTWIERDZENIE_EMAG_MS, empik: POTWIERDZENIE_EMPIK_MS, allegro: POTWIERDZENIE_ALLEGRO_MS,
  kaufland: POTWIERDZENIE_KAUFLAND_MS };
const sprawdzoneKorekty = new Map();   // id decyzji → ile razy sprawdzona
function korektyDoPotwierdzenia() {
  const wiersze = db.prepare(`SELECT d.id AS dec_id, (julianday('now') - julianday(d.czas)) * 86400000 AS ms,
      o.id, o.platforma, o.rynek, o.sku, o.asin, o.tw_id, o.auto, o.genius, o.dopasowanie, o.prowizja
    FROM decyzje d JOIN oferty o ON o.id = d.oferta_id
    WHERE d.kod = 'korekta' AND d.wyslano = 1 AND d.czas >= datetime('now', '-2 hours')`).all();
  const lista = [];
  for (const w of wiersze) {
    const n = sprawdzoneKorekty.get(w.dec_id) || 0;
    const opoznienie = PROPAGACJA_MS[w.platforma] || POTWIERDZENIE_MS;
    if (n >= 2 || !PLATFORMY.has(w.platforma) || w.ms < opoznienie * (n ? 3 : 1)) continue;
    sprawdzoneKorekty.set(w.dec_id, n + 1);
    if (!lista.some((o) => o.id === w.id)) lista.push(w);
  }
  for (const id of sprawdzoneKorekty.keys()) if (!wiersze.some((w) => w.dec_id === id)) sprawdzoneKorekty.delete(id);
  return lista;
}

async function przebiegBezpieczny(opcje) {
  const t0 = Date.now();
  try {
    const w = await przebieg(opcje);
    const doPotwierdzenia = w.doPotwierdzenia || [];
    delete w.doPotwierdzenia;
    console.log(new Date().toISOString(), `[pricing] przebieg ${((Date.now() - t0) / 1000).toFixed(0)} s`, JSON.stringify(w));
    return doPotwierdzenia;
  } catch (e) {
    // Błąd jednego przebiegu (API, GT) nie zabija procesu — następny spróbuje znowu.
    stan.set('blad', e.message);
    console.error(new Date().toISOString(), '[pricing] błąd przebiegu:', e.message);
    return [];
  }
}

async function potwierdz(wszystkie) {
  const oferty = wszystkie.filter((o) => o.platforma === 'amazon');
  const emagOf = wszystkie.filter((o) => o.platforma === 'emag');
  const empikOf = wszystkie.filter((o) => o.platforma === 'empik');
  const allegroOf = wszystkie.filter((o) => o.platforma === 'allegro');
  if (emagOf.length) await potwierdzEmag(emagOf);
  if (empikOf.length) await potwierdzEmpik(empikOf);
  if (allegroOf.length) await potwierdzAllegro(allegroOf);
  const kauflandOf = wszystkie.filter((o) => o.platforma === 'kaufland');
  if (kauflandOf.length) await potwierdzKaufland(kauflandOf);
  if (!oferty.length) return;
  try {
    const obs = await obserwuj(oferty);
    for (const o of oferty) {
      const ob = obs.get(o.id);
      console.log(new Date().toISOString(), `[pricing] potwierdzenie ${o.rynek} ${o.sku}: na Amazonie ${ob ? ob.cena : '?'}`
        + `, Buy Box ${ob ? (ob.bbNasz ? 'nasz' : ob.bbNasz === false ? 'INNY' : '?') : '?'}`);
    }
  } catch (e) {
    console.error(new Date().toISOString(), '[pricing] błąd potwierdzenia:', e.message);
  }
}

// eMAG: bez pobierania całej listy (32 zapytania) — po jednym zapytaniu na wysłaną ofertę, a obserwacja
// tą samą drogą co w przebiegu (obserwujEmag: zmieniony stan = nowy wiersz, ekran przestaje „czekać”).
async function potwierdzEmag(oferty) {
  try {
    const surowe = [];
    for (const o of oferty) {
      surowe.push(...await emag.ofertaPoSku(o.sku, o.rynek));
      await new Promise((r) => setTimeout(r, 350));
    }
    const obs = await obserwujEmag(oferty, surowe);
    for (const o of oferty) {
      const ob = obs.get(o.id);
      console.log(new Date().toISOString(), `[pricing] potwierdzenie EMAG_${o.rynek} ${o.sku}: na eMAG ${ob ? ob.cena : '?'}`
        + `, Buy Box ${ob ? (ob.bbNasz ? 'nasz' : ob.bbNasz === false ? 'INNY' : '?') : '?'}`);
    }
  } catch (e) {
    console.error(new Date().toISOString(), '[pricing] błąd potwierdzenia eMAG:', e.message);
  }
}

// Empik: status ostatniego importu cen (PRI02, odrzucone linie z PRI03) i obserwacja wysłanych ofert z P11.
async function potwierdzEmpik(oferty) {
  try {
    const imp = (() => { try { return JSON.parse(stan.get('empik_import')?.wartosc || 'null'); } catch { return null; } })();
    if (imp?.id) {
      const st = await empik.statusImportu(imp.id);
      console.log(new Date().toISOString(), `[pricing] Empik import ${imp.id}: ${st ? `${st.status}, zmienione ${st.zmienione}, błędne linie ${st.bledy}` : 'brak statusu'}`);
      if (st?.raport) console.error(new Date().toISOString(), '[pricing] Empik odrzucone ceny:', (await empik.raportBledow(imp.id)).trim().slice(0, 2000));
    }
    const obs = await obserwujEmpik(oferty);
    for (const o of oferty) {
      const ob = obs.get(o.id);
      console.log(new Date().toISOString(), `[pricing] potwierdzenie EMPIK_PL ${o.sku}: na Empiku ${ob ? ob.cena : '?'}`
        + `, Buy Box ${ob ? (ob.bbNasz ? 'nasz' : ob.bbNasz === false ? 'INNY' : '?') : '?'}`);
    }
  } catch (e) {
    console.error(new Date().toISOString(), '[pricing] błąd potwierdzenia Empik:', e.message);
  }
}

// Allegro: po jednym zapytaniu na wysłaną ofertę (po numerze), obserwacja tą samą drogą co w przebiegu.
async function potwierdzAllegro(oferty) {
  try {
    const surowe = [];
    for (const o of oferty) {
      const s = await allegro.ofertaPoId(o.rynek, o.asin);
      if (s) surowe.push(s);
    }
    const obs = await obserwujAllegro(oferty, surowe);
    for (const o of oferty) {
      const ob = obs.get(o.id);
      console.log(new Date().toISOString(), `[pricing] potwierdzenie ALLEGRO_${o.rynek} ${o.sku}: na Allegro ${ob ? ob.cena : '?'}`);
    }
  } catch (e) {
    console.error(new Date().toISOString(), '[pricing] błąd potwierdzenia Allegro:', e.message);
  }
}

// Kaufland: unit wysłanej oferty po SKU (jedno zapytanie) + jej ranking Buy Boxa — ta sama droga co w przebiegu.
// Sprawdzamy po PRICING_POTWIERDZENIE_KAUFLAND_MIN (domyślnie 3 min).
async function potwierdzKaufland(oferty) {
  try {
    const surowe = [];
    for (const o of oferty) surowe.push(...await kaufland.unitPoSku(o.sku, o.rynek));
    const obs = await obserwujKaufland(oferty, surowe);
    for (const o of oferty) {
      const ob = obs.get(o.id);
      console.log(new Date().toISOString(), `[pricing] potwierdzenie KAUFLAND_${o.rynek} ${o.sku}: na Kauflandzie ${ob ? ob.cena : '?'}`
        + `, Buy Box ${ob ? (ob.bbNasz ? 'nasz' : ob.bbNasz === false ? 'INNY' : '?') : '?'}`);
    }
  } catch (e) {
    console.error(new Date().toISOString(), '[pricing] błąd potwierdzenia Kaufland:', e.message);
  }
}

module.exports = { przebieg, korektyDoPotwierdzenia };

// Log do pliku pisze SAM worker (logs/pricing.log), a zadanie harmonogramu uruchamia node.exe
// bezpośrednio. Wcześniej log szedł przez `cmd /c ... >> plik` — Stop-ScheduledTask zabijał wtedy
// tylko cmd, osierocony node działał dalej na starym kodzie i trzymał plik logu, przez co nowy
// start odbijał się błędem (2026-10-13).
function logujDoPliku() {
  const fs = require('fs');
  const path = require('path');
  const plik = path.join(__dirname, '..', 'logs', 'pricing.log');
  fs.mkdirSync(path.dirname(plik), { recursive: true });
  for (const metoda of ['log', 'error', 'warn']) {
    const oryg = console[metoda].bind(console);
    console[metoda] = (...a) => {
      oryg(...a);
      try { fs.appendFileSync(plik, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n'); } catch { /* log nie może zabić workera */ }
    };
  }
}

if (require.main === module) {
  if (process.argv.includes('--log')) logujDoPliku();
  if (process.argv.includes('--raz')) {
    przebiegBezpieczny({ pelny: process.argv.includes('--pelny') }).then(() => process.exit(0));
  } else {
    const ms = interwalMsZMinut(process.env.PRICING_INTERWAL_MIN, 30, 'PRICING_INTERWAL_MIN');
    console.log(`[pricing] worker startuje, przebieg co ${ms / 60000} min, `
      + (process.env.PRICING_ZAPIS === '1' ? 'oferty z automatem zmieniają ceny na Amazonie' : 'HAMULEC: PRICING_ZAPIS ≠ 1, żadna cena nie idzie na Amazona'));
    let trwa = false, korekty = false;
    const tik = async () => {
      // Przebieg trafił na potwierdzanie ręcznej korekty (kilka sekund) — czekamy, zamiast tracić 30 min.
      if (trwa) { if (korekty) setTimeout(tik, 15_000); return; }
      trwa = true;
      const doPotwierdzenia = await przebiegBezpieczny();
      trwa = false;
      const potw = (lista, ms) => lista.length && setTimeout(async () => { if (trwa) return; trwa = true; await potwierdz(lista); trwa = false; }, ms);
      potw(doPotwierdzenia.filter((o) => o.platforma === 'amazon'), POTWIERDZENIE_MS);
      potw(doPotwierdzenia.filter((o) => o.platforma === 'emag'), POTWIERDZENIE_EMAG_MS);
      potw(doPotwierdzenia.filter((o) => o.platforma === 'empik'), POTWIERDZENIE_EMPIK_MS);
      potw(doPotwierdzenia.filter((o) => o.platforma === 'allegro'), POTWIERDZENIE_ALLEGRO_MS);
      potw(doPotwierdzenia.filter((o) => o.platforma === 'kaufland'), POTWIERDZENIE_KAUFLAND_MS);
    };
    tik();
    setInterval(tik, ms);
    // Ręczne korekty z ekranu — co minutę, gdy nic innego nie trwa (przebieg i potwierdzenia dzielą `trwa`).
    setInterval(async () => {
      if (trwa) return;
      let lista;
      try { lista = korektyDoPotwierdzenia(); } catch (e) { console.error(new Date().toISOString(), '[pricing] korekty:', e.message); return; }
      if (!lista.length) return;
      trwa = korekty = true;
      try { await potwierdz(lista); } finally { trwa = korekty = false; }
    }, 60_000);
  }
}
