'use strict';

// Zaklada zamowienie od klienta (ZK) w Subiekcie GT przez most (Sfera).
//   node scripts/zk-zaloz.js <zamowienie.json> --baza OKITRADE --most http://127.0.0.1:5000
//       -> walidacja w GT + PODGLAD w Sferze (ZK zbudowane w pamieci Subiekta, zamkniete BEZ zapisu)
//   ... --zapisz
//       -> to samo, a gdy podglad zgadza sie z zadaniem co do grosza - zapis
//
// Format pliku i reguly: services/zk-model.js. Ceny bierze z kartoteki GT (poziom_ceny, 5 = Hurt
// EUR), kurs waluty ustawia Sfera wg parametrow dokumentu (NBP z dnia poprzedniego, jak reczne ZK).
// Klucz z pliku trafia do uwag jako "WMS-ZK:<klucz>" - drugi raz ten sam klucz = odmowa, wiec
// ponowienie po zerwanej odpowiedzi mostu nie zalozy dubla.
//
// --baza MUSI wskazywac te sama baze, w ktorej siedzi most (walidacja czyta GT SQL-em, zapis idzie
// przez Sfere mostu). Testowy most na Z_KAJTEK: --baza Z_KAJTEK_IdeaERP --most http://127.0.0.1:5001.

const fs = require('fs');

function arg(nazwa) {
  const i = process.argv.indexOf(nazwa);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const plik = process.argv[2];
const baza = arg('--baza');
const most = arg('--most');
const ZAPISZ = process.argv.includes('--zapisz');

if (!plik || !baza || !most) {
  console.error('Uzycie: node scripts/zk-zaloz.js <zamowienie.json> --baza <baza GT> --most <url mostu> [--zapisz]');
  process.exit(2);
}
// Baza jawnie z linii polecen - nie z .env, ktore na Macu wskazuje Z_KAJTEK, a na SRV OKITRADE.
process.env.GT_SQL_DATABASE = baza;

const { query, getPool } = require('../services/gt-sql');
const model = require('../services/zk-model');
const { wariantyEan } = require('../pricing/konkurencja-allegro');

async function daneZGt(spec) {
  const poziom = Number(spec.poziom_ceny);
  if (!Number.isInteger(poziom) || poziom < 1 || poziom > 10) throw new Error(`poziom_ceny ${spec.poziom_ceny} - musi byc 1..10`);

  const { recordset: kontrahenci } = await query(
    `SELECT k.kh_Id, a.adr_Nazwa, a.adr_NIP FROM kh__Kontrahent k
     JOIN adr__Ewid a ON a.adr_IdObiektu = k.kh_Id AND a.adr_TypAdresu = 1
     WHERE REPLACE(REPLACE(REPLACE(a.adr_NIP, '-', ''), ' ', ''), 'PL', '') = @nip`,
    { nip: model.golyNip(spec.nip) });

  let vat = null;
  if (spec.vat) {
    ({ recordset: [vat] } = await query(
      'SELECT vat_Id, vat_Nazwa, vat_Stawka FROM sl_StawkaVAT WHERE vat_Symbol = @s', { s: spec.vat }));
  }
  const { recordset: [par] } = await query(`SELECT twp_WalutaCeny${poziom} AS waluta, twp_NazwaCeny${poziom} AS nazwa FROM tw_Parametr`);

  const kody = new Set();
  const symbole = new Set();
  for (const p of spec.pozycje || []) {
    if (p.symbol) symbole.add(String(p.symbol).trim());
    else for (const w of wariantyEan(p.ean)) kody.add(w);
  }
  const param = {};
  const lista = (zbior, pre) => [...zbior].map((v, i) => { param[`${pre}${i}`] = v; return `@${pre}${i}`; }).join(',') || "''";
  const { recordset: towary } = await query(
    `SELECT t.tw_Id, RTRIM(t.tw_Symbol) AS symbol, t.tw_Nazwa AS nazwa, t.tw_PodstKodKresk AS ean,
            t.tw_Usuniety AS usuniety, c.tc_CenaNetto${poziom} AS cena,
            (SELECT SUM(st_Stan) FROM tw_Stan WHERE st_TowId = t.tw_Id AND st_MagId = ${Number(spec.magazyn_id)}) AS stan_mag,
            (SELECT SUM(st_StanRez) FROM tw_Stan WHERE st_TowId = t.tw_Id AND st_MagId = ${Number(spec.magazyn_id)}) AS rez_mag,
            (SELECT STRING_AGG(kk_Kod, ',') FROM tw_KodKreskowy WHERE kk_IdTowar = t.tw_Id) AS kody
     FROM tw__Towar t JOIN tw_Cena c ON c.tc_IdTowar = t.tw_Id
     WHERE t.tw_Symbol IN (${lista(symbole, 's')})
        OR t.tw_PodstKodKresk IN (${lista(kody, 'k')})
        OR t.tw_Id IN (SELECT kk_IdTowar FROM tw_KodKreskowy WHERE kk_Kod IN (${lista(kody, 'k')}))`,
    param);

  let kluczZajety = null;
  if (spec.klucz) {
    const { recordset: [d] } = await query(
      'SELECT TOP 1 dok_NrPelny FROM dok__Dokument WHERE dok_Typ = 16 AND dok_Uwagi LIKE @u',
      { u: `%${model.znacznikKlucza(spec.klucz)}%` });
    kluczZajety = d ? d.dok_NrPelny : null;
  }

  return {
    kontrahenci,
    vat: vat || null,
    walutaPoziomu: par.waluta,
    nazwaPoziomu: par.nazwa,
    kluczZajety,
    towary: towary.map((t) => ({ ...t, usuniety: !!t.usuniety, kody: t.kody ? t.kody.split(',') : [] })),
  };
}

async function wyslij(zadanie) {
  const odp = await fetch(`${most.replace(/\/$/, '')}/api/zk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(zadanie),
  });
  return { status: odp.status, body: await odp.json().catch(() => null) };
}

(async () => {
  const spec = JSON.parse(fs.readFileSync(plik, 'utf8'));
  const gt = await daneZGt(spec);
  console.log(`Baza: ${baza}, most: ${most}`);
  for (const k of gt.kontrahenci) console.log(`Kontrahent: kh_Id ${k.kh_Id} ${k.adr_Nazwa} (${k.adr_NIP})`);
  console.log(`Ceny: poziom ${spec.poziom_ceny} "${gt.nazwaPoziomu}" (${gt.walutaPoziomu}), VAT: ${gt.vat ? gt.vat.vat_Nazwa : 'z kartoteki'}`);

  const { bledy, ostrzezenia, wiersze, zadanie } = model.zbudujZk(spec, gt, { podglad: true });
  for (const w of wiersze) {
    console.log(`  ${w.symbol.padEnd(18)} ${String(w.ilosc).padStart(4)} x ${String(w.cena).padStart(7)} = ${w.wartosc.toFixed(2).padStart(9)}  ${w.nazwa}`);
  }
  console.log(`  RAZEM ${wiersze.reduce((s, w) => s + w.ilosc, 0)} szt., ${wiersze.reduce((s, w) => s + w.wartosc, 0).toFixed(2)} ${spec.waluta || 'PLN'} netto`);
  for (const o of ostrzezenia) console.log(`  UWAGA: ${o}`);
  if (bledy.length) {
    console.error('Zamowienie odrzucone:\n  - ' + bledy.join('\n  - '));
    process.exit(1);
  }

  const podglad = await wyslij(zadanie);
  console.log(`PODGLAD (HTTP ${podglad.status}):`, JSON.stringify(podglad.body?.naglowek ?? podglad.body, null, 1));
  if (!podglad.body?.sukces) process.exit(1);
  const roznice = model.sprawdzPodglad(zadanie, podglad.body);
  if (roznice.length) {
    console.error('Sfera zbudowala inne ZK niz zadanie - nie zapisuje:\n  - ' + roznice.join('\n  - '));
    console.error('Pozycje wg Sfery:', JSON.stringify(podglad.body.pozycje, null, 1));
    process.exit(1);
  }
  console.log('Podglad zgodny z zadaniem (pozycje, ceny, VAT, suma netto).');
  if (!ZAPISZ) {
    console.log('Nic nie zapisano. Dodaj --zapisz, zeby zalozyc ZK.');
    return;
  }

  const zapis = await wyslij({ ...zadanie, podglad: false });
  console.log(`ZAPIS (HTTP ${zapis.status}):`, JSON.stringify(zapis.body?.naglowek ?? zapis.body, null, 1));
  if (!zapis.body?.sukces) {
    console.error(`Zapis nieudany. Zanim ponowisz, sprawdz w GT ZK z uwaga ${model.znacznikKlucza(spec.klucz)} (skrypt sam odmowi dubla).`);
    process.exit(1);
  }
  console.log(`Zalozone ${zapis.body.numer}.`);
})()
  .catch((e) => { console.error('BLAD:', e.message); process.exitCode = 1; })
  .finally(async () => { try { (await getPool()).close(); } catch { /* brak polaczenia */ } });
