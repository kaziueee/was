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

// POST /api/mm - wystawia dokument MM w GT, zwraca numer dokumentu.
// magazyn_*_id (sl_Magazyn.mag_Id) sa tym, czym posluguje sie Sfera; symbole ida
// dodatkowo do logow/diagnostyki.
function wystawMM({ artykul_gt_id, magazyn_zrodlowy, magazyn_docelowy, magazyn_zrodlowy_id, magazyn_docelowy_id, ilosc, operator }) {
  return wywolaj('/api/mm', {
    method: 'POST',
    body: JSON.stringify({ artykul_gt_id, magazyn_zrodlowy, magazyn_docelowy, magazyn_zrodlowy_id, magazyn_docelowy_id, ilosc, operator }),
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

module.exports = { wystawMM, pobierzStany, pobierzArtykul };
