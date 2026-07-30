'use strict';

// Czytelne kopie lokalizacji obok backupu .db - warstwa AWARYJNA (DR).
// Cel: gdy wszystko padnie, czlowiek ma sie czym ratowac (wydruk / odbudowa mapy magazynu recznie).
// Dane biora sie WYLACZNIE z WMS (stany_lokalizacji + ruchy) - nie pytamy GT, wiec dzialaja
// nawet gdy most/Subiekt lezy (czyli dokladnie w awarii, kiedy sa potrzebne).
//
// Trzy pliki CSV (separator ';' - Excel PL, bo przecinek = separator dziesietny -> rozjechalby kolumny):
//   lokalizacje_zbiorczo_DATA.csv - 1 SKU = 1 wiersz (suma stanu WMS + wszystkie lokalizacje)  [glowny ratunek: do druku / odbudowy recznej]
//   lokalizacje_DATA.csv          - 1 wiersz na (SKU, polka)                                    [sort/filtr po lokalizacji, re-import maszynowy]
//   historia_DATA.csv             - dziennik ruchow z tabeli `ruchy`                            [filtr po kolumnie symbol = co sie dzialo na SKU]
//
// UWAGA co znaczy "razem"/"ilosc": to suma z POLEK WMS (K4+K4G) - jedyne, co WMS zna.
// To NIE jest "Razem" z karty produktu (tam dochodza MAG/LS z GT). Dla "gdzie to lezy na hali" - idealne.
// UWAGA historia z `ruchy`: cofniety ruch (DELETE /ruchy/:id) znika -> to "stan faktyczny", nie ksiega wieczysta.
//
// Czyste funkcje (budowanie CSV, grupowanie) oddzielone od IO - testowalne bez SQLite:
// test/backup-czytelne.test.js.

const fs = require('fs');
const path = require('path');

// --- CSV: czyste ---

const SEP = ';';

// Cytuje pole gdy zawiera separator ';', cudzyslow albo nowa linie (RFC 4180 z ';' jako sep).
// Przecinek NIE wymaga cytowania - przy separatorze ';' nie lamie kolumn (a nazwy typu "Barbie, kolor"
// sa czeste, wiec cytowanie ich tylko zasmiecaloby plik).
function polecsv(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function csv(naglowki, wiersze) {
  const linie = [naglowki.join(SEP)];
  for (const w of wiersze) linie.push(w.map(polecsv).join(SEP));
  return linie.join('\n') + '\n';
}

// Liczba po polsku: calkowita bez ulamka, inaczej przecinek dziesietny. Puste dla braku/nie-liczb
// (null/undefined/'' -> '', bo Number(null)===0 udawaloby stan zero, a to inna informacja niz "brak").
function liczbaPl(n) {
  if (n === null || n === undefined || n === '') return '';
  const x = Number(n);
  if (!Number.isFinite(x)) return '';
  return Number.isInteger(x) ? String(x) : String(x).replace('.', ',');
}

// K4 (regal zbioru) przed K4G (bulk); nieznane magazyny na koniec.
const ORDER_MAG = { K4: 0, K4G: 1 };

// Grupuje plaskie wiersze {symbol, nazwa, magazyn, lokalizacja, ilosc} do 1 SKU = 1 rekord.
// Zwraca [{symbol, nazwa, razem, lokalizacje}] gdzie lokalizacje = "K4: kod(il) | K4G: kod(il); kod(il)".
function grupujPoSku(wiersze) {
  const mapa = new Map();
  for (const r of wiersze) {
    if (!mapa.has(r.symbol)) mapa.set(r.symbol, { symbol: r.symbol, nazwa: r.nazwa, razem: 0, mags: new Map() });
    const g = mapa.get(r.symbol);
    g.razem += Number(r.ilosc) || 0;
    if (!g.mags.has(r.magazyn)) g.mags.set(r.magazyn, []);
    g.mags.get(r.magazyn).push(`${r.lokalizacja}(${liczbaPl(r.ilosc)})`);
  }
  return [...mapa.values()].map((g) => ({
    symbol: g.symbol,
    nazwa: g.nazwa,
    razem: g.razem,
    lokalizacje: [...g.mags.entries()]
      .sort((a, b) => (ORDER_MAG[a[0]] ?? 9) - (ORDER_MAG[b[0]] ?? 9))
      .map(([mag, lst]) => `${mag}: ${lst.join('; ')}`)
      .join(' | '),
  }));
}

// wiersze: {symbol, nazwa, magazyn, lokalizacja, ilosc, ostatnia_zmiana}
function csvPlaski(wiersze) {
  return csv(
    ['symbol', 'nazwa', 'magazyn', 'lokalizacja', 'ilosc', 'ostatnia_zmiana'],
    wiersze.map((r) => [r.symbol, r.nazwa, r.magazyn, r.lokalizacja, liczbaPl(r.ilosc), r.ostatnia_zmiana]),
  );
}

// wiersze jw. (grupowane wewnatrz)
function csvZbiorczy(wiersze) {
  return csv(
    ['symbol', 'nazwa', 'razem', 'lokalizacje'],
    grupujPoSku(wiersze).map((g) => [g.symbol, g.nazwa, liczbaPl(g.razem), g.lokalizacje]),
  );
}

// wiersze: {data, symbol, typ, z_lokalizacji, na_lokalizacje, ilosc, kto, status}
function csvHistoria(wiersze) {
  return csv(
    ['data', 'symbol', 'typ', 'z_lokalizacji', 'na_lokalizacje', 'ilosc', 'kto', 'status'],
    wiersze.map((r) => [r.data, r.symbol, r.typ, r.z_lokalizacji, r.na_lokalizacje, liczbaPl(r.ilosc), r.kto, r.status]),
  );
}

// --- IO: zapytania + zapis plikow ---

const Q_STANY = `
  SELECT s.artykul_symbol AS symbol, s.artykul_nazwa AS nazwa,
         l.magazyn, l.kod AS lokalizacja, s.ilosc, s.ostatnia_zmiana
  FROM stany_lokalizacji s
  JOIN lokalizacje l ON l.id = s.lokalizacja_id
  ORDER BY s.artykul_symbol, l.magazyn, l.kod`;

const Q_HIST = `
  SELECT r.data_ruchu AS data, r.artykul_symbol AS symbol, r.typ,
         zr.kod AS z_lokalizacji,
         COALESCE(cel.kod, r.mag_cel_zewnetrzny) AS na_lokalizacje,
         r.ilosc, r.operator AS kto, r.status
  FROM ruchy r
  LEFT JOIN lokalizacje zr  ON zr.id  = r.lok_zrodlo_id
  LEFT JOIN lokalizacje cel ON cel.id = r.lok_cel_id
  ORDER BY r.data_ruchu DESC`;

// Generuje 3 pliki CSV w `katalog` z data `data` (YYYY-MM-DD w nazwie). `db` = polaczenie z db/database.
// Zwraca { sciezki, liczbaSku, liczbaStanow, liczbaRuchow }.
function generujPliki(db, katalog, data) {
  fs.mkdirSync(katalog, { recursive: true });
  const stany = db.prepare(Q_STANY).all();
  const hist = db.prepare(Q_HIST).all();

  const pliki = [
    [`lokalizacje_zbiorczo_${data}.csv`, csvZbiorczy(stany)],
    [`lokalizacje_${data}.csv`, csvPlaski(stany)],
    [`historia_${data}.csv`, csvHistoria(hist)],
  ];
  const sciezki = [];
  for (const [nazwa, tresc] of pliki) {
    const p = path.join(katalog, nazwa);
    fs.writeFileSync(p, tresc);
    sciezki.push(p);
  }
  return { sciezki, liczbaSku: grupujPoSku(stany).length, liczbaStanow: stany.length, liczbaRuchow: hist.length };
}

module.exports = {
  polecsv, liczbaPl, csv,
  grupujPoSku, csvPlaski, csvZbiorczy, csvHistoria,
  generujPliki,
};
