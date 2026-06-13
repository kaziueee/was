'use strict';

// Klient HTTP do mostu C# (bridge/GtBridge), ktory rozmawia z Subiekt GT przez Sfere.
// Adres mostu zgodny z CLAUDE.md ("Most C# - endpointy localhost:5000").

const BASE_URL = process.env.GT_BRIDGE_URL ?? 'http://localhost:5000';

// Wywoluje most C#. Nigdy nie rzuca na bledach sieciowych/HTTP - zwraca {ok, status, dane, blad},
// zeby wywolujacy mogl zdecydowac co zrobic z ruchem w kolejce (np. zostawic status 'pending').
async function wywolaj(sciezka, opcje = {}) {
  try {
    const res = await fetch(`${BASE_URL}${sciezka}`, {
      ...opcje,
      headers: { 'Content-Type': 'application/json', ...(opcje.headers ?? {}) },
    });

    let dane = null;
    try {
      dane = await res.json();
    } catch {
      // brak body (np. 204) - zostaw dane = null
    }

    return { ok: res.ok, status: res.status, dane, blad: null };
  } catch (err) {
    return { ok: false, status: 0, dane: null, blad: `Brak polaczenia z mostem GT (${BASE_URL}): ${err.message}` };
  }
}

// POST /api/mm - wystawia dokument MM w GT, zwraca numer dokumentu
function wystawMM({ artykul_gt_id, magazyn_zrodlowy, magazyn_docelowy, ilosc, operator }) {
  return wywolaj('/api/mm', {
    method: 'POST',
    body: JSON.stringify({ artykul_gt_id, magazyn_zrodlowy, magazyn_docelowy, ilosc, operator }),
  });
}

// POST /api/lok - aktualizuje pola wlasne artykulu (lokalizacje WMS) w kartotece GT
function zapiszLokalizacje({ artykul_gt_id, miejsce_na_magazynie, lokalizacja_gorna, lokalizacja_zapas }) {
  return wywolaj('/api/lok', {
    method: 'POST',
    body: JSON.stringify({ artykul_gt_id, miejsce_na_magazynie, lokalizacja_gorna, lokalizacja_zapas }),
  });
}

// GET /api/stan/:magId - stany magazynowe z GT (do joba rozjazdow)
function pobierzStany(magId) {
  return wywolaj(`/api/stan/${encodeURIComponent(magId)}`);
}

// GET /api/artykul/:id - dane artykulu z kartoteki GT
function pobierzArtykul(artykulGtId) {
  return wywolaj(`/api/artykul/${encodeURIComponent(artykulGtId)}`);
}

// POST /api/inwentaryzacja/rw - wystawia RW w GT (niedobory z inwentaryzacji)
function wystawRW({ magazyn, pozycje, operator }) {
  return wywolaj('/api/inwentaryzacja/rw', {
    method: 'POST',
    body: JSON.stringify({ magazyn, pozycje, operator }),
  });
}

// POST /api/inwentaryzacja/pw - wystawia PW w GT (nadwyzki z inwentaryzacji)
function wystawPW({ magazyn, pozycje, operator }) {
  return wywolaj('/api/inwentaryzacja/pw', {
    method: 'POST',
    body: JSON.stringify({ magazyn, pozycje, operator }),
  });
}

module.exports = { wystawMM, zapiszLokalizacje, pobierzStany, pobierzArtykul, wystawRW, wystawPW };
