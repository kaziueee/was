'use strict';

// Wystawianie ofert na rynkach, na których towar ma już kartę produktu (ekran Ceny → „Do wystawienia”,
// routes/ceny-wystawianie.js). Logika i walidacja: pricing/wystawianie-model.js (czyste, testy). Każda próba —
// także odrzucona — zostaje w tabeli `wystawienia` i w `zmiany` (audyt).
//
// Po wystawieniu oferta jest POZA Sellasist: stanu nikt nie aktualizuje, dopóki user nie podepnie jej w Sellasist
// (decyzja 2026-10-30 — WMS tylko zakłada ofertę). Historia na ekranie pokazuje to jako zadanie.
//
// Automat repricera włącza `dopnijWystawione()` (worker, po synchronizacji list ofert): gdy sync zobaczy nową ofertę,
// dostaje ona auto = 1 według tych samych reguł co POST /api/ceny/automat (pewne dopasowanie, kanał nie tylkoOdczyt).

const { db, stan } = require('./db');
const emag = require('./emag');
const wm = require('./wystawianie-model');
const { oznaczMarke } = require('./katalogi');
const { rodzajBleduEmag } = require('./katalogi-model');
const { kolumna } = require('./kolumny');
const { pewneDopasowanie } = require('./powiazania');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const zapiszProbe = db.prepare(`INSERT INTO wystawienia (kto, tw_id, platforma, rynek, sku, ean, produkt_id, id_platformy, cena, ilosc, status, opis, auto_po)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const zapiszZmiane = db.prepare('INSERT INTO zmiany (kto, oferta_id, akcja, opis) VALUES (?, ?, ?, ?)');

// Wolne id oferty eMAG (nasze vendor_ext_id). Licznik w `stan` (emag_id_nast) + sprawdzenie w API, że na tym
// rynku nie ma oferty o tym id — save z zajętym id NADPISAŁBY cudzą (naszą inną) ofertę, nie założył nowej.
async function wolneIdEmag(kraj) {
  let id = Math.max(Number(stan.get('emag_id_nast')?.wartosc) || 0, wm.EMAG_ID_START);
  for (let i = 0; i < 50; i++, id++) {
    const zajete = await emag.api('product_offer', 'read', { id, currentPage: 1, itemsPerPage: 1 }, 3, kraj);
    if (!(zajete || []).some((o) => Number(o.id) === id)) {
      stan.set('emag_id_nast', id + 1);
      return id;
    }
  }
  throw new Error('nie znaleziono wolnego id oferty eMAG w 50 próbach');
}

async function wystawEmag(p, kto) {
  // Wszystko PRZED product_offer/save, co się nie uda, znaczy na pewno „oferta nie powstała” → odrzucone (pozycja
  // wraca na listę kandydatów). Dopiero niepewny wynik samego save to `blad`.
  if (!emag.skonfigurowany()) return { status: 'odrzucone', opis: 'brak EMAG_RO_USER / EMAG_RO_PASS w .env tej maszyny' };
  let id;
  try { id = await wolneIdEmag(p.rynek); } catch (e) { return { status: 'odrzucone', opis: `nie udało się przydzielić id oferty: ${e.message}` }; }
  const o = wm.ofertaEmag(p, id);
  if (o.blad) return { status: 'odrzucone', opis: o.blad };
  try {
    // proby = 1: przy timeoucie nie wiemy, czy oferta powstała — ponowienie z tym samym id byłoby bezpieczne,
    // ale wynik „blad” każe człowiekowi sprawdzić panel, zamiast udawać, że wiemy.
    await emag.api('product_offer', 'save', [o.oferta], 1, p.rynek);
  } catch (e) {
    const opis = e.message.replace(/^eMAG product_offer\/save: /, '');
    const rodzaj = rodzajBleduEmag(e.message);
    if (rodzaj === 'siec') return { status: 'blad', opis: `nie wiadomo, czy oferta ${id} powstała — sprawdź w panelu eMAG: ${opis}`, id_platformy: id };
    if (rodzaj === 'marka') {
      const n = oznaczMarke('emag', p.rynek, p.katalog.marka, opis);
      return { status: 'odrzucone', opis: `${opis} (marka ${p.katalog.marka} oznaczona na ${n} towarach)`, id_platformy: id };
    }
    return { status: 'odrzucone', opis, id_platformy: id };
  }
  // Wymiary i waga (zasada usera): osobne zapytanie; błąd tutaj nie cofa oferty, tylko trafia do opisu.
  const w = wm.wymiaryEmag(p, id);
  let opis = `oferta ${id}, ${o.netto} netto`;
  try {
    if (w.blad) throw new Error(w.blad);
    await emag.api('measurements', 'save', [w.pomiar], 2, p.rynek);
    opis += `; wymiary ${w.pomiar.length}×${w.pomiar.width}×${w.pomiar.height} mm, ${w.pomiar.weight} g — sprawdź „Volumetrie” w panelu`;
  } catch (e) { opis += `; WYMIARY NIE PRZESZŁY: ${e.message} — wpisz w panelu`; }
  return { status: 'wyslane', opis, id_platformy: id };
}

// Empik (Mirakl): jeden import OF01 na całą paczkę z ekranu — import jest asynchroniczny, Empik przetwarza go kilka
// minut i liczy limity na importy, nie na oferty. Wynik od razu = „plik przyjęty” (`wyslane`, id_platformy = numer
// importu); odrzucone linie dociąga worker (sprawdzImportyEmpik, raport OF03), a ofertę widoczną — sync (OF52).
// Tryb importu ZAWSZE NORMAL: REPLACE usunąłby z Empiku wszystkie nasze oferty spoza pliku.
async function wystawEmpikHurt(pozycje) {
  const empik = require('./empik');
  if (!empik.skonfigurowany()) return pozycje.map(() => ({ status: 'odrzucone', opis: 'brak EMPIK_API_KEY w .env tej maszyny' }));
  const oferty = pozycje.map((p) => wm.ofertaEmpik(p));
  const doWyslania = oferty.filter((o) => !o.blad).map((o) => o.wiersz);
  if (!doWyslania.length) return oferty.map((o) => ({ status: 'odrzucone', opis: o.blad }));
  const form = new FormData();
  form.append('file', new Blob([wm.plikOfertEmpik(doWyslania)], { type: 'text/csv' }), 'oferty-wms.csv');
  form.append('import_mode', 'NORMAL');
  let importId = null, blad = null;
  try {
    // proby: 1 — ponowiony POST mógłby wysłać import drugi raz
    const { dane } = await empik.api('offers/imports', { metoda: 'POST', body: form, proby: 1 });
    importId = dane?.import_id ?? null;
    if (importId == null) blad = `Empik nie zwrócił numeru importu: ${JSON.stringify(dane).slice(0, 200)}`;
  } catch (e) { blad = e.message; }
  return oferty.map((o) => {
    if (o.blad) return { status: 'odrzucone', opis: o.blad };
    if (blad) return { status: /HTTP 4\d\d/.test(blad) ? 'odrzucone' : 'blad', opis: `import OF01: ${blad}` };
    return { status: 'wyslane', opis: `import ${importId}, klasa logistyczna ${o.wiersz['logistic-class']} — Empik przetwarza import kilka minut`,
      id_platformy: `import:${importId}` };
  });
}

// Grupa wysyłki Amazon (merchant_shipping_group) — bierzemy ją z naszej aktywnej oferty na tym rynku, żeby nowa
// oferta miała te same stawki co reszta konta (DE/FR/IT: szablony z identyfikatorem, ES/NL/PL: legacy-template-id).
// Pamiętana dobę w `stan` (amazon_grupa_<rynek>).
async function grupaWysylkiAmazon(amazon, rynek) {
  const klucz = `amazon_grupa_${rynek}`;
  const z = stan.get(klucz);
  if (z?.wartosc && Date.now() - new Date(String(z.czas).replace(' ', 'T') + 'Z').getTime() < 24 * 3600e3) return z.wartosc;
  const mp = amazon.RYNKI_AMAZON[rynek].id;
  const wzory = db.prepare("SELECT sku FROM oferty WHERE platforma = 'amazon' AND rynek = ? AND aktywna = 1 ORDER BY id LIMIT 5").all(rynek);
  for (const w of wzory) {
    try {
      const t = await amazon.api('GET', `/listings/2021-08-01/items/${amazon.SELLER_ID}/${encodeURIComponent(w.sku)}?marketplaceIds=${mp}&includedData=attributes`);
      const grupa = t?.attributes?.merchant_shipping_group?.[0]?.value;
      if (grupa) { stan.set(klucz, grupa); return grupa; }
    } catch { /* następny wzór */ }
  }
  return null;
}

// Amazon: najpierw restrictions (na żywo — nocny skan sprawdza ASIN raz na 7 dni), potem VALIDATION_PREVIEW, dopiero
// czysty podgląd idzie zapisem. Cokolwiek padnie PRZED zapisem = „oferta nie powstała” → odrzucone.
async function wystawAmazon(p) {
  const amazon = require('./amazon');
  const { amazonOgraniczenia } = require('./katalogi');
  const r = amazon.RYNKI_AMAZON[p.rynek];
  if (!r) return { status: 'odrzucone', opis: `Amazon: nieznany rynek ${p.rynek}` };
  const asin = p.katalog?.produkt_id;
  let ograniczenie;
  try { ograniczenie = await amazonOgraniczenia(asin, p.rynek); } catch (e) { return { status: 'odrzucone', opis: `nie udało się sprawdzić ograniczeń: ${e.message}` }; }
  if (ograniczenie) {
    db.prepare("UPDATE katalog SET ograniczenie = ? WHERE platforma = 'amazon' AND rynek = ? AND produkt_id = ?").run(ograniczenie, p.rynek, asin);
    return { status: 'odrzucone', opis: ograniczenie };
  }
  let grupa;
  try { grupa = await grupaWysylkiAmazon(amazon, p.rynek); } catch (e) { return { status: 'odrzucone', opis: `grupa wysyłki: ${e.message}` }; }
  const o = wm.ofertaAmazon(p, { marketplaceId: r.id, waluta: r.waluta, grupaWysylki: grupa });
  if (o.blad) return { status: 'odrzucone', opis: o.blad };
  const sciezka = `/listings/2021-08-01/items/${amazon.SELLER_ID}/${encodeURIComponent(p.sku)}?marketplaceIds=${r.id}&issueLocale=pl_PL`;
  try {
    const podglad = wm.problemyAmazon(await amazon.api('PUT', `${sciezka}&mode=VALIDATION_PREVIEW`, o.body));
    if (podglad.bledy.length) return { status: 'odrzucone', opis: `Amazon (podgląd): ${podglad.bledy.join(' | ')}` };
  } catch (e) { return { status: 'odrzucone', opis: `Amazon (podgląd): ${e.message}` }; }
  let odp;
  try { odp = await amazon.api('PUT', sciezka, o.body); } catch (e) {
    // 4xx = Amazon odrzucił zgłoszenie (oferta nie powstała); sieć / 5xx po ponowieniach = nie wiemy.
    if (/: 4\d\d /.test(e.message)) return { status: 'odrzucone', opis: `Amazon: ${e.message}`, id_platformy: asin };
    return { status: 'blad', opis: `nie wiadomo, czy oferta powstała — sprawdź w Seller Central (${p.sku}): ${e.message}`, id_platformy: asin };
  }
  const pr = wm.problemyAmazon(odp);
  if (odp?.status !== 'ACCEPTED' || pr.bledy.length) return { status: 'odrzucone', opis: `Amazon ${odp?.status || '?'}: ${pr.bledy.join(' | ') || 'bez opisu'}`, id_platformy: asin };
  const uwagi = pr.ostrzezenia.length ? `; ostrzeżenia: ${pr.ostrzezenia.join(' | ').slice(0, 300)}` : '';
  return { status: 'wyslane', opis: `ASIN ${asin}, ${o.body.attributes.purchasable_offer[0].our_price[0].schedule[0].value_with_tax} ${r.waluta}, zgłoszenie ${odp.submissionId || '?'}${uwagi}`, id_platformy: asin };
}

const WYSTAW = { emag: wystawEmag, amazon: wystawAmazon };
const WYSTAW_HURT = { empik: wystawEmpikHurt };

// pozycje = już ocenione i potwierdzone przez routes/ceny-wystawianie.js (wm.ocenPozycje bez blokad).
// Po kolei, z przerwą — eMAG liczy limity na konto, a wystawienie to 3 zapytania.
async function wystaw(pozycje, { kto = null, auto = true } = {}) {
  // Platformy z importem hurtowym: najpierw jeden plik na platformę dla wszystkich pozycji bez blokad.
  const zHurtu = new Map();
  for (const [platforma, fn] of Object.entries(WYSTAW_HURT)) {
    const tu = pozycje.filter((p) => p.platforma === platforma && !wm.powodyBlokady(wm.ocenPozycje(p)).length);
    if (!tu.length) continue;
    let rr;
    try { rr = await fn(tu); } catch (e) { rr = tu.map(() => ({ status: 'blad', opis: e.message })); }
    tu.forEach((p, i) => zHurtu.set(p, rr[i]));
  }
  const wyniki = [];
  for (const p of pozycje) {
    const blokady = wm.powodyBlokady(wm.ocenPozycje(p));
    let r;
    if (blokady.length) r = { status: 'odrzucone', opis: blokady.join('; ') };
    else if (zHurtu.has(p)) r = zHurtu.get(p);
    else if (!WYSTAW[p.platforma]) r = { status: 'odrzucone', opis: wm.gotowyRynek(p.platforma, p.rynek).powod };
    else {
      try { r = await WYSTAW[p.platforma](p, kto); } catch (e) { r = { status: 'blad', opis: e.message }; }
    }
    const wiersz = zapiszProbe.run(kto, p.tw_id, p.platforma, p.rynek, p.sku, p.ean, p.katalog?.produkt_id ?? null, r.id_platformy != null ? String(r.id_platformy) : null,
      p.cena, Math.floor(Number(p.ilosc) || 0), r.status, r.opis || null, auto ? 1 : 0);
    zapiszZmiane.run(kto, null, r.status === 'wyslane' ? 'wystawienie' : 'wystawienie_odrzucone',
      `${p.platforma} ${p.rynek} ${p.sku}: ${p.cena} × ${p.ilosc} — ${r.opis || r.status}`);
    wyniki.push({ id: Number(wiersz.lastInsertRowid), tw_id: p.tw_id, sku: p.sku, platforma: p.platforma, rynek: p.rynek, ...r });
    await sleep(400);
  }
  return wyniki;
}

// Worker po synchronizacji list: wystawione oferty, które sync już widzi → status `widoczna` + oferta_id (także `blad` —
// skoro sync ją widzi, save jednak przeszedł); z auto_po = 1
// automat włączony (te same warunki co POST /api/ceny/automat). Oferta wstrzymana przez platformę (Invalid price itd.)
// też jest `widoczna` (z powodem w ofercie), ale automatu nie dostaje — repricer i tak by jej nie ruszył.
function dopnijWystawione() {
  const pary = db.prepare(`SELECT w.id AS w_id, w.kto, w.auto_po, w.tw_id AS w_tw, o.id, o.platforma, o.rynek, o.sku, o.tw_id, o.dopasowanie, o.auto, o.aktywna
      FROM wystawienia w JOIN oferty o ON o.platforma = w.platforma AND o.rynek = w.rynek AND UPPER(o.sku) = UPPER(w.sku)
     WHERE w.status IN ('wyslane', 'blad') AND w.id_platformy IS NOT NULL AND (o.aktywna = 1 OR o.wstrzymana = 1)`).all();
  const ustawW = db.prepare("UPDATE wystawienia SET status = 'widoczna', oferta_id = ? WHERE id = ?");
  const wlacz = db.prepare('UPDATE oferty SET auto = 1 WHERE id = ? AND auto = 0');
  let widoczne = 0, automat = 0;
  db.exec('BEGIN');
  try {
    for (const x of pary) {
      ustawW.run(x.id, x.w_id);
      widoczne++;
      const k = kolumna(x.platforma, x.rynek);
      const mozna = x.auto_po && x.aktywna && x.tw_id === x.w_tw && pewneDopasowanie(x.dopasowanie) && k && !k.tylkoOdczyt;
      if (mozna && wlacz.run(x.id).changes) {
        automat++;
        zapiszZmiane.run(x.kto, x.id, 'automat_wl', 'po wystawieniu z WMS');
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { widoczne, automat };
}

// Worker: wynik importów OF01 (Empik). Import COMPLETE z błędnymi liniami → raport OF03, odrzucone pozycje dostają
// treść błędu (wracają na listę kandydatów); FAILED → całe odrzucone. Linie przyjęte zostają `wyslane` do czasu, aż
// sync zobaczy ofertę (dopnijWystawione). Sprawdzamy importy z ostatnich 2 dni, nie młodsze niż 3 min.
async function sprawdzImportyEmpik() {
  const czekajace = db.prepare(`SELECT id, sku, id_platformy FROM wystawienia WHERE platforma = 'empik' AND status = 'wyslane'
      AND id_platformy LIKE 'import:%' AND czas <= datetime('now', '-3 minutes') AND czas >= datetime('now', '-2 days')`).all();
  if (!czekajace.length) return { importy: 0, odrzucone: 0 };
  const empik = require('./empik');
  const ustaw = db.prepare("UPDATE wystawienia SET status = 'odrzucone', opis = ? WHERE id = ?");
  const poImporcie = new Map();
  for (const w of czekajace) poImporcie.set(w.id_platformy.slice(7), [...(poImporcie.get(w.id_platformy.slice(7)) || []), w]);
  let odrzucone = 0;
  for (const [id, wiersze] of poImporcie) {
    const { dane: imp } = await empik.api(`offers/imports/${encodeURIComponent(id)}`);
    if (imp?.status === 'FAILED') {
      for (const w of wiersze) { ustaw.run(`import ${id} nieudany: ${imp.reason_status || 'FAILED'}`, w.id); odrzucone++; }
      continue;
    }
    if (imp?.status !== 'COMPLETE' || !(Number(imp.lines_in_error) > 0)) continue;
    const raport = wm.bledyImportuEmpik((await empik.api(`offers/imports/${encodeURIComponent(id)}/error_report`)).tekst);
    for (const w of wiersze) {
      const b = raport.get(String(w.sku).toUpperCase());
      if (b) { ustaw.run(`Empik odrzucił: ${b}`, w.id); odrzucone++; }
    }
  }
  return { importy: poImporcie.size, odrzucone };
}

module.exports = { wystaw, dopnijWystawione, wolneIdEmag, sprawdzImportyEmpik };
