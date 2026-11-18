'use strict';

// Zaklada nowy komplet (zestaw, tw_Rodzaj = 8) w Subiekcie GT przez most (Sfera).
//   node scripts/zestaw-zaloz.js <zestaw.json> --baza OKITRADE --most http://127.0.0.1:5000
//       -> walidacja + PODGLAD w Sferze (komplet zbudowany w pamieci Subiekta, zamkniety BEZ zapisu)
//   ... --zapisz
//       -> to samo, a po udanym podgladzie zapis
//
// zestaw.json:
//   { "symbol": "SPIN20148931Z2", "nazwa": "...(<= 50 znakow)", "ean": "5900805605095",
//     "skladniki": [{ "symbol": "SPIN20148931", "ilosc": 1 }, ...],
//     "ceny": [{ "poziom": 3, "brutto": 89.99 }, { "poziom": 5, "netto": 13 }],
//     "pola_wlasne": { "Wymiary": "42x22x8" },
//     "grupa_id": 307 (opcjonalnie - domyslnie grupa pierwszego skladnika),
//     "sklep_internetowy": true (domyslnie) }
// Poziomy cen (potwierdzone w Sferze 2026-11-18): 1 Detaliczna PLN, 2 Emag_RO RON,
// 3 Specjalna PLN (sklep internetowy), 4 EUR, 5 Hurt EUR. Cena kartotekowa (koszt) liczy sie
// sama = suma kosztow skladnikow x ilosc. Ze skladnikow licza sie tez (zasady usera 2026-11-18):
// "Waga produktu" i trzy "Waga opakowania ..." (suma x ilosc, kg z przecinkiem), "Baterie"
// (suma po typie; rozne typy = wpisz recznie w pola_wlasne). "Ilosc w opakowaniu zbiorczym"
// zestawu zostaje pusta. Wymiary podaje czlowiek (paczka rozlozona na plasko).
//
// --baza MUSI wskazywac te sama baze, w ktorej siedzi most (walidacja czyta GT SQL-em, zapis
// idzie przez Sfere mostu). Testowy most na Z_KAJTEK: --baza Z_KAJTEK_IdeaERP --most :5001.
// EAN z puli firmy trzeba wczesniej odhaczyc w arkuszu "eany GS1" (zakladka Kajtek+).
// Przepis: docs/zestawy-tworzenie.md.

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
  console.error('Uzycie: node scripts/zestaw-zaloz.js <zestaw.json> --baza <baza GT> --most <url mostu> [--zapisz]');
  process.exit(2);
}
// Baza jawnie z linii polecen - nie z .env, ktore na Macu wskazuje Z_KAJTEK, a na SRV OKITRADE.
process.env.GT_SQL_DATABASE = baza;

const { query, getPool } = require('../services/gt-sql');
const model = require('../services/zestawy-tworzenie-model');

async function daneZGt(spec) {
  const symbole = spec.skladniki.map((s) => s.symbol);
  const param = {};
  const lista = symbole.map((s, i) => { param[`s${i}`] = s; return `@s${i}`; }).join(',');
  const { recordset: skl } = await query(
    `SELECT t.tw_Id, RTRIM(t.tw_Symbol) AS symbol, t.tw_Nazwa, t.tw_Rodzaj, t.tw_Usuniety, t.tw_IdGrupa,
            c.tc_CenaNetto0 AS koszt
     FROM tw__Towar t LEFT JOIN tw_Cena c ON c.tc_IdTowar = t.tw_Id
     WHERE t.tw_Symbol IN (${lista})`, param);
  const { recordset: [sym] } = await query(
    'SELECT COUNT(*) AS n FROM tw__Towar WHERE tw_Symbol = @s', { s: spec.symbol });
  let eanZajety = false;
  if (spec.ean) {
    const { recordset: [e] } = await query(
      `SELECT (SELECT COUNT(*) FROM tw__Towar WHERE tw_PodstKodKresk = @e)
            + (SELECT COUNT(*) FROM tw_KodKreskowy WHERE kk_Kod = @e) AS n`, { e: spec.ean });
    eanZajety = e.n > 0;
  }
  // Pola wlasne skladnikow PO NAZWIE (kolumna pwd_TekstNN rozni sie miedzy bazami).
  const polaPoNazwie = {};
  if (skl.length) {
    const { recordset: def } = await query(
      'SELECT pwp_Nazwa, pwp_Pole FROM pw_Pole WHERE pwp_TypObiektu = -14');
    const kolumny = def.filter((d) => model.POLA_ZE_SKLADNIKOW.includes(d.pwp_Nazwa)
      && /^pwd_Tekst\d\d$/.test(d.pwp_Pole));
    if (kolumny.length) {
      const ids = skl.map((r, i) => { param[`t${i}`] = r.tw_Id; return `@t${i}`; }).join(',');
      const { recordset: wiersze } = await query(
        `SELECT pwd_IdObiektu, ${kolumny.map((d) => d.pwp_Pole).join(', ')} FROM pw_Dane
         WHERE pwd_TypObiektu = -14 AND pwd_IdObiektu IN (${ids})`, param);
      for (const w of wiersze) {
        polaPoNazwie[w.pwd_IdObiektu] = Object.fromEntries(
          kolumny.map((d) => [d.pwp_Nazwa, w[d.pwp_Pole] == null ? '' : String(w[d.pwp_Pole])]));
      }
    }
  }
  return {
    symbolZajety: sym.n > 0,
    eanZajety,
    skladniki: new Map(skl.map((r) => [r.symbol, {
      tw_Id: r.tw_Id, nazwa: r.tw_Nazwa, rodzaj: r.tw_Rodzaj, usuniety: !!r.tw_Usuniety,
      grupa_id: r.tw_IdGrupa, koszt: Number(r.koszt) || 0, pola: polaPoNazwie[r.tw_Id] || {},
    }])),
  };
}

async function wyslij(zadanie) {
  const odp = await fetch(`${most.replace(/\/$/, '')}/api/komplet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(zadanie),
  });
  return { status: odp.status, body: await odp.json().catch(() => null) };
}

(async () => {
  const spec = JSON.parse(fs.readFileSync(plik, 'utf8'));
  const gt = await daneZGt(spec);
  const bledy = model.sprawdzSpecyfikacje(spec, gt);
  console.log(`Baza: ${baza}, most: ${most}`);
  for (const s of spec.skladniki) {
    const t = gt.skladniki.get(s.symbol);
    console.log(`  skladnik ${s.symbol} x${s.ilosc}: ${t ? `tw_Id ${t.tw_Id}, koszt ${t.koszt}, ${t.nazwa} ${JSON.stringify(t.pola)}` : 'BRAK W GT'}`);
  }
  if (bledy.length) {
    console.error('Specyfikacja odrzucona:\n  - ' + bledy.join('\n  - '));
    process.exit(1);
  }

  const zadanie = model.zbudujZadanie(spec, gt, { podglad: true });
  console.log('Zadanie dla mostu:', JSON.stringify({ ...zadanie, podglad: undefined }));
  const podglad = await wyslij(zadanie);
  console.log(`PODGLAD (HTTP ${podglad.status}):`, JSON.stringify(podglad.body, null, 1));
  if (!podglad.body?.sukces) process.exit(1);
  if (!ZAPISZ) {
    console.log('Podglad OK, nic nie zapisano. Dodaj --zapisz, zeby zalozyc komplet.');
    return;
  }

  const zapis = await wyslij(model.zbudujZadanie(spec, gt, { podglad: false }));
  console.log(`ZAPIS (HTTP ${zapis.status}):`, JSON.stringify(zapis.body, null, 1));
  if (!zapis.body?.sukces) process.exit(1);
  console.log(`Zalozony komplet ${spec.symbol}, tw_Id ${zapis.body.tw_id}.`);
})()
  .catch((e) => { console.error('BLAD:', e.message); process.exitCode = 1; })
  .finally(async () => { try { (await getPool()).close(); } catch { /* brak polaczenia */ } });
