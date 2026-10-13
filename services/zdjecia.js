'use strict';

// Zdjecia produktow: Sellasist (po SKU) -> cache na dysku serwera -> ekrany WMS.
// Reguly i pomiary zrodla w services/zdjecia-model.js.
//
// Cache siedzi w db/zdjecia/ (poza repo) i ma dwa zadania:
//  - Zebra nie ciagnie zdjec z internetu przy kazdym otwarciu karty (Wi-Fi w hali),
//  - ekran pokazuje zdjecie takze wtedy, gdy Sellasist nie odpowiada - ostatnia kopia jest
//    lepsza niz nic, a zdjecie to tylko podglad, nie dane, od ktorych cokolwiek zalezy.
//
// Klucz pliku = SKU (znormalizowany). Zmiana symbolu w Subiekcie niczego tu nie psuje: nowe SKU
// to nowy klucz, a stary wpis po prostu przestaje byc czytany. Symbol MUSI przyjsc swiezo z GT
// (routes/produkty.js) - kopia w WMS po przemianowaniu pokazalaby zdjecie innego towaru.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { normalizujSymbol, adresyRozmiarow, czyAktualny } = require('./zdjecia-model');

const KATALOG = path.join(__dirname, '..', 'db', 'zdjecia');
const LIMIT_BAJTOW = 5 * 1024 * 1024;
const TIMEOUT_API_MS = 8000;
const TIMEOUT_OBRAZU_MS = 15000;

class ZdjeciaNiedostepne extends Error {}

function skonfigurowane() {
  return Boolean(process.env.SELLASIST_ACCOUNT && process.env.SELLASIST_API_KEY);
}

function klucz(symbol) {
  return crypto.createHash('sha1').update(normalizujSymbol(symbol)).digest('hex').slice(0, 24);
}

const sciezkaMeta = (k) => path.join(KATALOG, `${k}.json`);
const sciezkaPliku = (k, rozmiar) => path.join(KATALOG, `${k}.${rozmiar}`);

async function czytajMeta(k) {
  try {
    return JSON.parse(await fsp.readFile(sciezkaMeta(k), 'utf8'));
  } catch {
    return null;
  }
}

async function zapiszMeta(k, meta) {
  await fsp.mkdir(KATALOG, { recursive: true });
  // zapis przez plik tymczasowy - urwany zapis nie zostawi pol-JSON-a, ktory by udawal brak cache
  const tmp = `${sciezkaMeta(k)}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(meta));
  await fsp.rename(tmp, sciezkaMeta(k));
}

// fetch z timeoutem i jednym ponowieniem - API Sellasist (HTTP/2) potrafi zerwac strumien
// w polowie odpowiedzi; drugie podejscie prawie zawsze przechodzi.
async function pobierz(url, opcje, timeoutMs) {
  let ostatni;
  for (let proba = 0; proba < 2; proba++) {
    try {
      const odp = await fetch(url, { ...opcje, signal: AbortSignal.timeout(timeoutMs) });
      const bufor = Buffer.from(await odp.arrayBuffer());
      return { odp, bufor };
    } catch (err) {
      ostatni = err;
    }
  }
  throw ostatni;
}

// URL zdjecia (miniatury) z Sellasist dla SKU; null = Sellasist zna towar bez zdjecia albo
// go nie zna. Rzuca, gdy nie da sie zapytac (brak konfiguracji, siec, blad API).
async function adresZSellasist(symbol) {
  if (!skonfigurowane()) throw new ZdjeciaNiedostepne('Sellasist nieskonfigurowany (SELLASIST_ACCOUNT / SELLASIST_API_KEY)');
  const url = `https://${process.env.SELLASIST_ACCOUNT}.sellasist.pl/api/v1/products?symbol=${encodeURIComponent(symbol)}`;
  const { odp, bufor } = await pobierz(url, {
    headers: { apiKey: process.env.SELLASIST_API_KEY, accept: 'application/json' },
  }, TIMEOUT_API_MS);
  if (odp.status === 404) return null; // "No records found"
  if (!odp.ok) throw new ZdjeciaNiedostepne(`Sellasist HTTP ${odp.status}`);
  const lista = JSON.parse(bufor.toString('utf8'));
  // Filtr symbol= jest dokladny, ale API potrafi oddac ten sam produkt kilka razy - bierzemy
  // pierwszy ze zgodnym symbolem i niepustym zdjeciem.
  const szukany = normalizujSymbol(symbol);
  const trafienie = (Array.isArray(lista) ? lista : [])
    .find((p) => normalizujSymbol(p.symbol) === szukany && p.image_url);
  return trafienie ? trafienie.image_url : null;
}

async function istnieje(plik) {
  try {
    await fsp.access(plik, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function wczytaj(k, rozmiar, meta) {
  return { bufor: await fsp.readFile(sciezkaPliku(k, rozmiar)), typ: meta.pliki[rozmiar].typ };
}

// {bufor, typ} albo null (towar nie ma zdjecia). Rzuca ZdjeciaNiedostepne, gdy zrodlo nie
// odpowiada, a w cache nie ma czego oddac.
async function zdjecieDlaSymbolu(symbol, rozmiar) {
  const k = klucz(symbol);
  let meta = await czytajMeta(k);

  if (!czyAktualny(meta)) {
    try {
      const url = await adresZSellasist(symbol);
      meta = {
        symbol: normalizujSymbol(symbol),
        url,
        sprawdzono: Date.now(),
        // pliki zostaja, jesli adres sie nie zmienil - inaczej zdjecie podmienione w Sellasist
        // trzeba sciagnac od nowa (porownanie po adresie zrodlowym nizej i tak to zlapie)
        pliki: meta && meta.url === url ? (meta.pliki || {}) : {},
      };
      await zapiszMeta(k, meta);
    } catch (err) {
      if (!meta) throw err instanceof ZdjeciaNiedostepne ? err : new ZdjeciaNiedostepne(err.message);
      // Sellasist nie odpowiada - zostajemy przy tym, co wiemy (nawet starym)
    }
  }

  if (!meta.url) return null;

  const zrodlo = adresyRozmiarow(meta.url)[rozmiar];
  const zapisany = meta.pliki?.[rozmiar];
  const plik = sciezkaPliku(k, rozmiar);
  if (zapisany && zapisany.zrodlo === zrodlo && await istnieje(plik)) return wczytaj(k, rozmiar, meta);

  try {
    const { odp, bufor } = await pobierz(zrodlo, {}, TIMEOUT_OBRAZU_MS);
    const typ = odp.headers.get('content-type') || '';
    if (!odp.ok || !typ.startsWith('image/')) throw new ZdjeciaNiedostepne(`obraz HTTP ${odp.status} ${typ}`);
    if (bufor.length > LIMIT_BAJTOW) throw new ZdjeciaNiedostepne(`obraz za duzy (${bufor.length} B)`);
    await fsp.mkdir(KATALOG, { recursive: true });
    await fsp.writeFile(plik, bufor);
    meta.pliki = { ...(meta.pliki || {}), [rozmiar]: { zrodlo, typ } };
    await zapiszMeta(k, meta);
    return { bufor, typ };
  } catch (err) {
    // stara kopia (np. sprzed podmiany zdjecia) jest lepsza niz pusta ramka
    if (zapisany && await istnieje(plik)) return wczytaj(k, rozmiar, meta);
    throw err instanceof ZdjeciaNiedostepne ? err : new ZdjeciaNiedostepne(err.message);
  }
}

// Jedno zapytanie na raz per (SKU, rozmiar): lista na ekranie potrafi poprosic o to samo
// zdjecie kilka razy, zanim pierwsze sie sciagnie.
const wToku = new Map();

function pobierzZdjecie(symbol, rozmiar) {
  const id = `${klucz(symbol)}.${rozmiar}`;
  if (!wToku.has(id)) {
    wToku.set(id, zdjecieDlaSymbolu(symbol, rozmiar).finally(() => wToku.delete(id)));
  }
  return wToku.get(id);
}

module.exports = { pobierzZdjecie, ZdjeciaNiedostepne, skonfigurowane, KATALOG };
