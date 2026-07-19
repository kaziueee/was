'use strict';

// Konwersja pol wagowych w GT z GRAMOW na KILOGRAMY.
//   node scripts/konwersja-wag.js --baza=OKITRADE            -> DRY-RUN, nic nie zapisuje
//   node scripts/konwersja-wag.js --baza=OKITRADE --zapisz   -> zapisuje
//
// ⚠️ POWOD ISTNIENIA TEGO SKRYPTU (a nie zwyklego UPDATE /1000):
// jednostki w tych polach sa MIESZANE historycznie. Regula, ktora wyszla z danych:
//   - wartosc CALKOWITA        -> gramy    -> dzielimy przez 1000
//   - wartosc Z PRZECINKIEM    -> JUZ KILOGRAMY -> zostawiamy w spokoju
//   - wartosc z sufiksem "g"   -> gramy    -> obcinamy sufiks i dzielimy
//
// Dowod rozstrzygajacy: HWHHKX48 (Hot Wheels Mega garaz) mial Tworzywa 6,5 + Karton 1,2
// = Zbiorcze 7,7. Sumuje sie, wiec to kilogramy. Slepe dzielenie wszystkiego przez 1000
// zamienilo 6,5 kg na 0,007 kg - tak zepsulem 11 rekordow na bazie testowej 2026-07-19.
//
// Skrypt WYPISUJE wszystkie wartosci pozostawione bez zmian, zeby dalo sie je przejrzec
// przed zapisem. Nie zgadujemy jednostki po niczym innym niz ksztalt liczby.

const fs = require('fs');
const path = require('path');
const sql = require('mssql');
require('dotenv').config();

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1];
const ZAPISZ = process.argv.includes('--zapisz');
const BAZA = arg('baza');
const PACZKA = 300;

if (!BAZA) { console.error('Podaj baze: --baza=OKITRADE'); process.exit(1); }

const POLA = {
  pwd_Tekst01: 'Waga opakowania Tworzywa',
  pwd_Tekst02: 'Waga opakowania Karton',
  pwd_Tekst03: 'Waga opakowania Zbiorcze',
  pwd_Tekst06: 'Waga produktu',
};

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

// kg jako tekst: przecinek, do 3 miejsc, bez zbednych zer ("0,916", "0,5", "0,002").
const kg = (v) => (Math.round(v * 1000) / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '').replace('.', ',');

// Zwraca {akcja:'dziel'|'zostaw'|'pomin', gramy?} - jedyne miejsce, gdzie decydujemy o jednostce.
function zaklasyfikuj(surowa) {
  const t = String(surowa ?? '').trim();
  if (t === '') return { akcja: 'pomin' };
  if (/^\d+$/.test(t)) return { akcja: 'dziel', gramy: Number(t) };                 // 916    -> gramy
  if (/^\d+\s*g$/i.test(t)) return { akcja: 'dziel', gramy: Number(t.replace(/\s*g$/i, '')) }; // "60g" -> gramy
  if (/^\d+[.,]\d+$/.test(t)) return { akcja: 'zostaw', powod: 'ma przecinek = juz kilogramy' };
  return { akcja: 'zostaw', powod: 'nierozpoznany format' };
}

(async () => {
  const pool = await new sql.ConnectionPool(cfg).connect();
  const db = (await pool.request().query('SELECT DB_NAME() db')).recordset[0].db;
  if (db !== BAZA) { console.error(`STOP: polaczono z ${db}, oczekiwano ${BAZA}`); process.exit(1); }
  console.log(`Baza: ${db}   tryb: ${ZAPISZ ? 'ZAPIS' : 'DRY-RUN (nic nie zapisuje)'}\n`);

  const kolumny = Object.keys(POLA);
  const wiersze = (await pool.request().query(
    `SELECT pwd_Id, pwd_IdObiektu, ${kolumny.join(', ')} FROM pw_Dane WHERE pwd_TypObiektu = -14`
  )).recordset;

  const zmiany = [];        // {pwd_Id, ustaw: {kolumna: nowaWartosc}}
  const zostawione = [];    // do przejrzenia przez czlowieka
  for (const w of wiersze) {
    const ustaw = {};
    for (const kol of kolumny) {
      const k = zaklasyfikuj(w[kol]);
      if (k.akcja === 'pomin') continue;
      if (k.akcja === 'zostaw') { zostawione.push({ pwd_Id: w.pwd_Id, pole: POLA[kol], wartosc: String(w[kol]).trim(), powod: k.powod }); continue; }
      const nowa = kg(k.gramy / 1000);
      if (nowa !== String(w[kol]).trim()) ustaw[kol] = nowa;
    }
    if (Object.keys(ustaw).length) zmiany.push({ pwd_Id: w.pwd_Id, ustaw });
  }

  console.log(`Wierszy pw_Dane(-14): ${wiersze.length}`);
  console.log(`Do przeliczenia (gramy -> kg): ${zmiany.length} wierszy`);
  console.log(`\nPOZOSTAWIONE BEZ ZMIAN: ${zostawione.length} - przejrzyj te liste:`);
  for (const z of zostawione) {
    // Symbol dociagniemy tylko dla tych kilku - to lista do oczu ludzkich.
    console.log(`   pwd_Id ${String(z.pwd_Id).padEnd(9)} ${z.pole.padEnd(26)} "${z.wartosc}"   (${z.powod})`);
  }

  const raport = path.join(__dirname, `raport-konwersji-wag-${db}.json`);
  fs.writeFileSync(raport, JSON.stringify({ baza: db, doPrzeliczenia: zmiany.length, zostawione }, null, 1));
  console.log(`\nRaport: ${raport}`);

  if (!ZAPISZ) { console.log('\nDRY-RUN - nic nie zapisano. Dodaj --zapisz, zeby wykonac.'); process.exit(0); }

  const plikBackup = path.join(__dirname, `backup-wag-${db}.json`);
  fs.writeFileSync(plikBackup, JSON.stringify(wiersze));
  console.log(`\nBACKUP: ${wiersze.length} wierszy -> ${plikBackup}`);

  let n = 0;
  for (const cz of chunk(zmiany, PACZKA)) {
    const tx = new sql.Transaction(pool); await tx.begin();
    try {
      // Kazdy wiersz moze zmieniac inny podzbior kolumn, wiec osobne UPDATE w jednej transakcji.
      for (const z of cz) {
        const req = new sql.Request(tx);
        const sety = Object.entries(z.ustaw).map(([kol, val], i) => { req.input(`v${i}`, sql.VarChar, val); return `${kol} = @v${i}`; });
        req.input('id', sql.Int, z.pwd_Id);
        await req.query(`UPDATE pw_Dane SET ${sety.join(', ')} WHERE pwd_Id = @id`);
      }
      await tx.commit(); n += cz.length; process.stdout.write(`\r  ${n}/${zmiany.length}`);
    } catch (e) { await tx.rollback(); console.error('\nBLAD:', e.message); process.exit(1); }
  }
  console.log('');

  // read-back
  const po = (await pool.request().query(
    `SELECT pwd_Id, ${kolumny.join(', ')} FROM pw_Dane WHERE pwd_TypObiektu = -14`
  )).recordset;
  const mapa = new Map(po.map((x) => [x.pwd_Id, x]));
  let ok = 0; let zle = 0; const bledy = [];
  for (const z of zmiany) {
    const g = mapa.get(z.pwd_Id);
    const zgodny = Object.entries(z.ustaw).every(([kol, val]) => String(g?.[kol] ?? '').trim() === val);
    if (zgodny) ok += 1; else { zle += 1; if (bledy.length < 5) bledy.push({ pwd_Id: z.pwd_Id, oczek: z.ustaw, jest: g }); }
  }
  console.log(`\nWERYFIKACJA: zgodne=${ok}  niezgodne=${zle}`);
  if (bledy.length) console.log(JSON.stringify(bledy, null, 1));
  process.exit(0);
})().catch((e) => { console.error('BLAD', e.message); process.exit(1); });
