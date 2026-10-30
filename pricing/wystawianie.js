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
const { odrzucenieMarki } = require('./katalogi-model');
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
    if (/HTTP|timeout|fetch|abort/i.test(e.message)) return { status: 'blad', opis: `nie wiadomo, czy oferta ${id} powstała — sprawdź w panelu eMAG: ${opis}`, id_platformy: id };
    if (odrzucenieMarki(opis)) {
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

const WYSTAW = { emag: wystawEmag };

// pozycje = już ocenione i potwierdzone przez routes/ceny-wystawianie.js (wm.ocenPozycje bez blokad).
// Po kolei, z przerwą — eMAG liczy limity na konto, a wystawienie to 3 zapytania.
async function wystaw(pozycje, { kto = null, auto = true } = {}) {
  const wyniki = [];
  for (const p of pozycje) {
    const blokady = wm.powodyBlokady(wm.ocenPozycje(p));
    let r;
    if (blokady.length) r = { status: 'odrzucone', opis: blokady.join('; ') };
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

module.exports = { wystaw, dopnijWystawione, wolneIdEmag };
