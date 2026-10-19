'use strict';

// Minimalny czytnik .xlsx bez zależności: xlsx = ZIP z plikami XML, a Node ma `zlib`. Wystarcza do raportów
// eksportowanych z paneli (Allegro Analytics): tekst ze wspólnej tabeli, liczby, tekst w komórce. Bez
// formuł, stylów i dat — tego nie potrzebujemy, a każda biblioteka xlsx to kilka MB zależności, których
// produkcja (bez modułów natywnych, `npm ci`) nie chce. Czyste funkcje — testy w test/xlsx-czytnik.test.js.

const zlib = require('zlib');

// ZIP → Map(nazwa pliku → Buffer). Czytamy katalog centralny (koniec pliku), nie nagłówki lokalne —
// rozmiary w nagłówku lokalnym bywają zerowe (bit 3: „data descriptor”).
function plikiZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('to nie jest plik xlsx (brak katalogu ZIP)');
  const ile = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const pliki = new Map();
  for (let n = 0; n < ile; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('uszkodzony katalog ZIP');
    const metoda = buf.readUInt16LE(p + 10);
    const rozmiar = buf.readUInt32LE(p + 20);
    const dlNazwy = buf.readUInt16LE(p + 28), dlExtra = buf.readUInt16LE(p + 30), dlKom = buf.readUInt16LE(p + 32);
    const lokalny = buf.readUInt32LE(p + 42);
    const nazwa = buf.toString('utf8', p + 46, p + 46 + dlNazwy);
    const start = lokalny + 30 + buf.readUInt16LE(lokalny + 26) + buf.readUInt16LE(lokalny + 28);
    const dane = buf.subarray(start, start + rozmiar);
    if (metoda === 0) pliki.set(nazwa, dane);
    else if (metoda === 8) pliki.set(nazwa, zlib.inflateRawSync(dane));
    else throw new Error(`nieobsługiwana kompresja ZIP (${metoda}) w ${nazwa}`);
    p += 46 + dlNazwy + dlExtra + dlKom;
  }
  return pliki;
}

const ENCJE = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const dekoduj = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#'
  ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
  : ENCJE[e] ?? m));
const tekst = (xml) => dekoduj([...String(xml).matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));
const xmlPliku = (pliki, nazwa) => { const b = pliki.get(nazwa); return b ? b.toString('utf8').replace(/^﻿/, '') : null; };

// „AB12” → indeks kolumny 27
const kolumna = (ref) => [...String(ref).replace(/\d+$/, '')].reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0) - 1;

// Arkusze skoroszytu: { nazwa → wiersze (tablice wartości: tekst albo liczba) }.
function czytajXlsx(buf) {
  const pliki = plikiZip(buf);
  const wspolne = [...(xmlPliku(pliki, 'xl/sharedStrings.xml') || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => tekst(m[1]));
  const rels = new Map([...(xmlPliku(pliki, 'xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\s[^>]*>/g)]
    .map((m) => [(m[0].match(/\bId="([^"]+)"/) || [])[1], (m[0].match(/\bTarget="([^"]+)"/) || [])[1]]));
  const arkusze = {};
  for (const m of (xmlPliku(pliki, 'xl/workbook.xml') || '').matchAll(/<sheet\s[^>]*>/g)) {
    const nazwa = dekoduj((m[0].match(/\bname="([^"]*)"/) || [])[1] || '');
    const cel = rels.get((m[0].match(/\br:id="([^"]+)"/) || [])[1]);
    if (!cel) continue;
    const xml = xmlPliku(pliki, cel.startsWith('/') ? cel.slice(1) : `xl/${cel}`);
    if (!xml) continue;
    const wiersze = [];
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const wiersz = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const atr = c[1], wn = c[2] || '';
        const ref = (atr.match(/\br="([A-Z]+\d+)"/) || [])[1];
        const typ = (atr.match(/\bt="(\w+)"/) || [])[1];
        const v = (wn.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        let wart = null;
        if (typ === 's') wart = v == null ? null : wspolne[Number(v)] ?? null;
        else if (typ === 'inlineStr') wart = tekst(wn);
        else if (typ === 'str' || typ === 'e') wart = v == null ? null : dekoduj(v);
        else if (typ === 'b') wart = v === '1';
        else if (v != null) wart = Number.isFinite(Number(v)) ? Number(v) : dekoduj(v);
        wiersz[ref ? kolumna(ref) : wiersz.length] = wart;
      }
      wiersze.push(Array.from(wiersz, (x) => (x === undefined ? null : x)));
    }
    arkusze[nazwa] = wiersze;
  }
  return arkusze;
}

module.exports = { czytajXlsx, plikiZip, kolumna };
