'use strict';

// Wsad wymiarow (+ wyliczonej wagi gabarytowej DHL) z eksportu BaseLinkera do pol wlasnych GT.
//   node scripts/wsad-wymiarow.js --baza=OKITRADE                  -> DRY-RUN, nic nie zapisuje
//   node scripts/wsad-wymiarow.js --baza=OKITRADE --zapisz         -> zapisuje
//   node scripts/wsad-wymiarow.js --baza=OKITRADE --zapisz --tylko=SYM1,SYM2   -> test na wybranych
//
// WEJSCIE: scripts/wymiary.json = {"SYMBOL": "dlxszerxwys", ...}, np. {"NERCHITAREL": "25,5x17,5x5,5"}.
// Plik jest w .gitignore (dane robocze, ~240 KB) - powstaje z eksportu BaseLinkera
// (BL_Produkty_Wymiary_*.xlsx, kolumny: produkt_sku, dlugosc, szerokosc, wysokosc).
// UWAGA przy odtwarzaniu: Excel psuje w tym eksporcie liczby z przecinkiem - wartosci
// o czesci calkowitej 1-12 zamienia na DATY (12,5 -> 2026-12-05), a reszte na TEKST
// z kropka ("16.5"). Odzysk: data -> miesiac + dzien/10; tekst -> Number po zamianie
// kropki na przecinek. Sciezke do innego pliku podaj przez --wymiary=/sciezka/plik.json
//
// Zapisuje WYLACZNIE Wymiary (pwd_Tekst07) i Wage gabarytowa (pwd_Tekst09). Wag produktu
// NIE dotyka - to osobna operacja, bo tam jednostki sa mieszane historycznie (liczby calkowite
// = gramy, z przecinkiem = juz kilogramy) i slepe dzielenie przez 1000 psuje dane.
//
// Waga gabarytowa idzie RAZEM z wymiarami swiadomie: jest ich funkcja i job spojnosci
// (services/waga-gabarytowa-job.js) i tak by ja uzupelnil przy najblizszym przebiegu.
//
// Poprawki z scripts/poprawki-wymiarow.json nadpisuja arkusz - w eksporcie sa rekordy
// w milimetrach i z zerami, ktore inaczej wrocilyby na produkcje.

const fs = require('fs');
const path = require('path');
const sql = require('mssql');
require('dotenv').config();

const {
  sprawdzWymiary, zlozWymiary, liczWageGabarytowa, KOLUMNY, TYP_OBIEKTU_TOWAR,
} = require('../services/gt-atrybuty');

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1];
const ZAPISZ = process.argv.includes('--zapisz');
const BAZA = arg('baza');
const TYLKO = (arg('tylko') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const PLIK_WYMIAROW = arg('wymiary') || path.join(__dirname, 'wymiary.json');
const PACZKA = 300;

if (!BAZA) {
  console.error('Podaj baze: --baza=OKITRADE');
  process.exit(1);
}

const cfg = {
  server: process.env.GT_SQL_HOST,
  port: Number(process.env.GT_SQL_PORT),
  database: BAZA,
  user: process.env.GT_SQL_USER,
  password: process.env.GT_SQL_PASSWORD,
  options: { encrypt: false, trustServerCertificate: true },
  connectionTimeout: 20000,
  requestTimeout: 120000,
};

const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

(async () => {
  // --- wejscie ---
  const wymiary = JSON.parse(fs.readFileSync(PLIK_WYMIAROW, 'utf8'));   // {SYMBOL: "dlxszerxwys"}
  const poprawki = JSON.parse(fs.readFileSync(path.join(__dirname, 'poprawki-wymiarow.json'), 'utf8'));
  for (const p of poprawki.poprawki) wymiary[p.symbol.toUpperCase()] = p.poprawne;
  console.log(`Arkusz: ${Object.keys(wymiary).length} SKU (w tym ${poprawki.poprawki.length} nadpisanych z poprawki-wymiarow.json)`);

  const pool = await new sql.ConnectionPool(cfg).connect();
  const db = (await pool.request().query('SELECT DB_NAME() db')).recordset[0].db;
  if (db !== BAZA) { console.error(`STOP: polaczono z ${db}, oczekiwano ${BAZA}`); process.exit(1); }
  console.log(`Baza: ${db}   tryb: ${ZAPISZ ? 'ZAPIS' : 'DRY-RUN (nic nie zapisuje)'}\n`);

  // --- walidacja arkusza (ta sama regula co PUT /api/produkty/:id/atrybuty) ---
  const poprawne = new Map();
  const odrzucone = [];
  for (const [symbol, tekst] of Object.entries(wymiary)) {
    if (TYLKO.length && !TYLKO.includes(symbol.toUpperCase())) continue;
    const w = sprawdzWymiary(tekst);
    if (w.blad) { odrzucone.push({ symbol, tekst, blad: w.blad }); continue; }
    poprawne.set(symbol.toUpperCase(), { wymiary: zlozWymiary(w.wymiary), gab: liczWageGabarytowa(w.wymiary), ostrzezenia: w.ostrzezenia });
  }
  console.log(`Walidacja: ${poprawne.size} poprawnych, ${odrzucone.length} odrzuconych`);
  for (const o of odrzucone.slice(0, 10)) console.log(`   ODRZUCONE ${o.symbol}: "${o.tekst}" - ${o.blad}`);
  const zOstrzezeniem = [...poprawne].filter(([, v]) => v.ostrzezenia.length);
  if (zOstrzezeniem.length) {
    console.log(`Ostrzezenia (>150 cm): ${zOstrzezeniem.length}`);
    for (const [s, v] of zOstrzezeniem.slice(0, 10)) console.log(`   ${s}: ${v.wymiary} - ${v.ostrzezenia.join(' ')}`);
  }

  // --- mapowanie SKU -> tw_Id ---
  const symbole = [...poprawne.keys()];
  const mapa = new Map();
  const duplikaty = [];
  for (const cz of chunk(symbole, 400)) {
    const req = pool.request();
    const nazwy = cz.map((s, i) => { req.input(`s${i}`, sql.VarChar, s); return `@s${i}`; });
    const r = await req.query(`SELECT tw_Id, tw_Symbol FROM tw__Towar WHERE tw_Usuniety = 0 AND tw_Symbol IN (${nazwy.join(',')})`);
    for (const x of r.recordset) {
      const k = x.tw_Symbol.trim().toUpperCase();
      if (mapa.has(k)) duplikaty.push(k); else mapa.set(k, x.tw_Id);
    }
  }
  const sieroty = symbole.filter((s) => !mapa.has(s));
  console.log(`\nMapowanie: ${mapa.size} dopasowanych, ${sieroty.length} sierot, ${duplikaty.length} duplikatow symbolu`);

  // --- stan istniejacy: UPDATE czy INSERT, i co juz jest zgodne ---
  const idy = [...mapa.values()];
  const istn = new Map();
  for (const cz of chunk(idy, 900)) {
    const r = await pool.request().query(
      `SELECT pwd_Id, pwd_IdObiektu, ${KOLUMNY.wymiary} AS wymiary, ${KOLUMNY.waga_gabarytowa} AS gab
       FROM pw_Dane WHERE pwd_TypObiektu = ${TYP_OBIEKTU_TOWAR} AND pwd_IdObiektu IN (${cz.join(',')})`
    );
    r.recordset.forEach((x) => istn.set(x.pwd_IdObiektu, x));
  }

  const doUpdate = []; const doInsert = []; const konflikty = []; let zgodne = 0;
  for (const [symbol, twId] of mapa) {
    const nowe = poprawne.get(symbol);
    const e = istn.get(twId);
    if (e) {
      const stare = (e.wymiary || '').trim();
      if (stare === nowe.wymiary && (e.gab || '').trim() === nowe.gab) { zgodne += 1; continue; }
      if (stare && stare !== nowe.wymiary) konflikty.push({ symbol, gt: stare, arkusz: nowe.wymiary });
      doUpdate.push({ pwd_Id: e.pwd_Id, symbol, ...nowe });
    } else {
      doInsert.push({ twId, symbol, ...nowe });
    }
  }
  console.log(`Plan: UPDATE=${doUpdate.length}  INSERT=${doInsert.length}  juz zgodne=${zgodne}`);
  console.log(`Konflikty (GT ma INNA niepusta wartosc): ${konflikty.length}`);
  for (const k of konflikty.slice(0, 15)) console.log(`   ${k.symbol}: GT="${k.gt}"  arkusz="${k.arkusz}"`);

  const raport = { baza: db, sieroty, duplikaty, odrzucone, konflikty, doUpdate: doUpdate.length, doInsert: doInsert.length, zgodne };
  const plikRaportu = path.join(__dirname, `raport-wsadu-${db}.json`);
  fs.writeFileSync(plikRaportu, JSON.stringify(raport, null, 1));
  console.log(`\nRaport: ${plikRaportu}`);

  if (!ZAPISZ) {
    console.log('\nDRY-RUN - nic nie zapisano. Dodaj --zapisz, zeby wykonac.');
    process.exit(0);
  }

  // --- backup przed zapisem ---
  const bak = (await pool.request().query(
    `SELECT pwd_Id, pwd_IdObiektu, ${KOLUMNY.wymiary} AS wymiary, ${KOLUMNY.waga_gabarytowa} AS gab
     FROM pw_Dane WHERE pwd_TypObiektu = ${TYP_OBIEKTU_TOWAR}`
  )).recordset;
  const plikBackup = path.join(__dirname, `backup-pw_Dane-${db}-${Object.keys(wymiary).length}.json`);
  fs.writeFileSync(plikBackup, JSON.stringify(bak));
  console.log(`\nBACKUP: ${bak.length} wierszy -> ${plikBackup}`);

  // --- zapis ---
  let u = 0;
  for (const cz of chunk(doUpdate, PACZKA)) {
    const tx = new sql.Transaction(pool); await tx.begin();
    try {
      const req = new sql.Request(tx);
      const wiersze = cz.map((x, i) => {
        req.input(`w${i}`, sql.VarChar, x.wymiary);
        req.input(`g${i}`, sql.VarChar, x.gab);
        return `(${x.pwd_Id}, @w${i}, @g${i})`;
      });
      await req.query(
        `UPDATE d SET d.${KOLUMNY.wymiary} = v.wym, d.${KOLUMNY.waga_gabarytowa} = v.gab
         FROM pw_Dane d JOIN (VALUES ${wiersze.join(',')}) AS v(id, wym, gab) ON d.pwd_Id = v.id`
      );
      await tx.commit(); u += cz.length; process.stdout.write(`\r  UPDATE ${u}/${doUpdate.length}`);
    } catch (e) { await tx.rollback(); console.error('\nBLAD UPDATE:', e.message); process.exit(1); }
  }
  if (doUpdate.length) console.log('');

  let i = 0;
  for (const cz of chunk(doInsert, PACZKA)) {
    const tx = new sql.Transaction(pool); await tx.begin();
    try {
      // pwd_Id nie jest IDENTITY i GT nie ma dla niego sekwencji - aplikacja nadaje MAX+1.
      // UPDLOCK/HOLDLOCK trzyma zakres na czas transakcji, wiec rownolegly zapis nie wezmie
      // tego samego numeru.
      const req = new sql.Request(tx);
      let n = (await req.query(`SELECT ISNULL(MAX(pwd_Id),0)+1 n FROM pw_Dane WITH (UPDLOCK, HOLDLOCK)`)).recordset[0].n;
      const req2 = new sql.Request(tx);
      const wiersze = cz.map((x, k) => {
        req2.input(`w${k}`, sql.VarChar, x.wymiary);
        req2.input(`g${k}`, sql.VarChar, x.gab);
        const v = `(${n}, ${TYP_OBIEKTU_TOWAR}, ${x.twId}, @w${k}, @g${k})`;
        n += 1;
        return v;
      });
      await req2.query(
        `INSERT INTO pw_Dane (pwd_Id, pwd_TypObiektu, pwd_IdObiektu, ${KOLUMNY.wymiary}, ${KOLUMNY.waga_gabarytowa})
         VALUES ${wiersze.join(',')}`
      );
      await tx.commit(); i += cz.length; process.stdout.write(`\r  INSERT ${i}/${doInsert.length}`);
    } catch (e) { await tx.rollback(); console.error('\nBLAD INSERT:', e.message); process.exit(1); }
  }
  if (doInsert.length) console.log('');

  // --- weryfikacja read-back ---
  let ok = 0; let zle = 0; const bledy = [];
  for (const cz of chunk([...mapa.entries()], 900)) {
    const r = await pool.request().query(
      `SELECT pwd_IdObiektu, ${KOLUMNY.wymiary} AS wymiary, ${KOLUMNY.waga_gabarytowa} AS gab
       FROM pw_Dane WHERE pwd_TypObiektu = ${TYP_OBIEKTU_TOWAR} AND pwd_IdObiektu IN (${cz.map(([, id]) => id).join(',')})`
    );
    const got = new Map(r.recordset.map((x) => [x.pwd_IdObiektu, x]));
    for (const [symbol, id] of cz) {
      const oczek = poprawne.get(symbol); const g = got.get(id);
      if (g && (g.wymiary || '') === oczek.wymiary && (g.gab || '') === oczek.gab) ok += 1;
      else { zle += 1; if (bledy.length < 5) bledy.push({ symbol, gt: g, oczek }); }
    }
  }
  console.log(`\nWERYFIKACJA: zgodne=${ok}  niezgodne=${zle}`);
  if (bledy.length) console.log('  probki:', JSON.stringify(bledy, null, 1));
  process.exit(0);
})().catch((e) => { console.error('BLAD', e.message); process.exit(1); });
