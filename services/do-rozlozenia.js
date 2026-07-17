'use strict';

// Wspolny rachunek "co jeszcze zostalo do rozlozenia na K4" - dla zwrotow i dostaw.
//
// Oba ekrany zadaja to samo pytanie, tylko o inny kubelek, wiec licza tym samym kodem. To NIE
// jest oszczednosc linijek: kolejnosc capowania kubelkow w rozbijDeficytK4 jest czescia
// DEFINICJI "ile zostalo", a nie detalem implementacji. Druga implementacja tego rachunku
// rozjechalaby liste z karta produktu - lista mowilaby "12 SKU", a po wejsciu bylo 8.
//
// Wejscie: kandydaci z GT (pobierzTowaryZeZwrotamiK4 / pobierzTowaryZDostawamiK4) + nazwa
// kubelka. Wyjscie: plaska lista pozycji (SKU x dokument), bo jeden SKU moze przyjsc dwiema
// fakturami i kazda jest osobnym zadaniem.

const db = require('../db/database');
const gtDokumenty = require('./gt-dokumenty');
const { pobierzStanyGt } = require('./gt-produkty');

const MAG = 'K4';

// kubelek: 'zwroty' | 'dostawy' | 'przywozki' (klucze z rozbijDeficytK4)
async function zbierz(kandydaci, kubelek) {
  if (!kandydaci.length) return [];

  const ids = kandydaci.map((k) => k.artykul_gt_id);
  const [dokMap, stany] = await Promise.all([
    gtDokumenty.pobierzDostawyK4(ids),
    pobierzStanyGt(ids),
  ]);

  const placeholders = ids.map(() => '?').join(',');

  // suma WMS per SKU - jednym zapytaniem, nie N+1 w petli
  const sumyWms = new Map();
  for (const r of db.prepare(
    `SELECT s.artykul_gt_id AS id, COALESCE(SUM(s.ilosc), 0) AS suma
     FROM stany_lokalizacji s JOIN lokalizacje l ON l.id = s.lokalizacja_id
     WHERE l.magazyn = ? AND s.artykul_gt_id IN (${placeholders})
     GROUP BY s.artykul_gt_id`
  ).all(MAG, ...ids)) {
    sumyWms.set(String(r.id), Number(r.suma) || 0);
  }

  // lokalizacja podstawowa: WMS (master lokalizacji) -> tw_Pole1 z GT -> brak.
  // Brak to NIE blad - operator moze wpisac kod recznie; nie blokujemy z tego powodu akcji.
  const lokWms = new Map();
  for (const r of db.prepare(
    `SELECT s.artykul_gt_id AS id, l.kod, s.artykul_ean AS ean
     FROM stany_lokalizacji s JOIN lokalizacje l ON l.id = s.lokalizacja_id
     WHERE l.magazyn = ? AND s.artykul_gt_id IN (${placeholders})
     ORDER BY s.ilosc DESC`
  ).all(MAG, ...ids)) {
    if (!lokWms.has(String(r.id))) lokWms.set(String(r.id), r);
  }

  const pozycje = [];
  for (const k of kandydaci) {
    const sg = stany.get(String(k.artykul_gt_id)) || {};
    const stanK4 = sg.K4?.ilosc ?? 0;
    const deficyt = stanK4 - (sumyWms.get(k.artykul_gt_id) ?? 0);
    const r = gtDokumenty.rozbijDeficytK4(deficyt, dokMap.get(k.artykul_gt_id) || [], {
      artykul_gt_id: k.artykul_gt_id, magazyn: MAG,
    });
    const wKubelku = r[kubelek] || [];
    if (!wKubelku.length) continue;   // rozlozone albo zjedzone deficytem - nie ma zadania

    const w = lokWms.get(k.artykul_gt_id);
    for (const d of wKubelku) {
      pozycje.push({
        artykul_gt_id: k.artykul_gt_id,
        symbol: k.symbol,
        nazwa: k.nazwa,
        ean: k.ean ?? w?.ean ?? null,
        zrodlo_dok: d.pz_nr,          // klucz atrybucji (ruchy.zrodlo_dok)
        dok_zrodlowy: d.fz_nr,        // podpis na ekranie: FZ przy dostawie, KFS przy zwrocie
        kontrahent: d.kontrahent ?? null,
        data: d.data,
        ilosc: d.ilosc,
        lokalizacja_kod: w?.kod ?? k.lok_gt ?? null,
        lok_zrodlo: w?.kod ? 'WMS' : (k.lok_gt ? 'GT' : null),
        stan_k4: stanK4,
        rezerwacja: sg.K4?.rezerwacja ?? 0,
      });
    }
  }
  return pozycje;
}

// sort = kolejnosc obchodu; pozycje bez miejsca na koncu (nie ma dokad z nimi isc)
function wgLokalizacji(a, b) {
  if (!a.lokalizacja_kod !== !b.lokalizacja_kod) return a.lokalizacja_kod ? -1 : 1;
  return (a.lokalizacja_kod || '').localeCompare(b.lokalizacja_kod || '')
    || (a.symbol || '').localeCompare(b.symbol || '');
}

module.exports = { zbierz, wgLokalizacji, MAG };
