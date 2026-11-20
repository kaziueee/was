'use strict';

// Uzupelnia ruchy.zrodlo_dok_id (dok_Id dokumentu GT) w rozlozeniach zapisanych przed 2026-11-20,
// kiedy WMS pamietal tylko NUMER dokumentu.
//   node scripts/zrodlo-dok-id.js                                   -> podglad, NIC nie zapisuje
//   node scripts/zrodlo-dok-id.js --zapisz                          -> zapisuje dopasowania jednoznaczne
//   node scripts/zrodlo-dok-id.js --mapa "PZ 3954/2026=6974580" ... -> recznie: stary numer = dok_Id
//
// PO CO: licznik "ile z dokumentu juz rozlozono" idzie teraz po dok_Id
// (services/rozlozone-dokumenty.js), bo numer PZ zmienia sie przy edycji FZ w Subiekcie
// (Intek 2026-11-18: PZ 3954/2026 -> PZ 4099/2026, PZ 3790/2026 -> PZ 4108/2026). Stare ruchy
// bez id licza sie dalej po numerze - wiec dla nieprzenumerowanych dokumentow ten skrypt nic
// nie zmienia w rachunku, tylko zabezpiecza je na przyszlosc. Dla przenumerowanych jest naprawa.
//
// JAK DOPASOWUJE (tylko SELECT do GT):
//   - numer istnieje w GT jako PZ/PW/MM i ten dokument ma na pozycjach WSZYSTKIE towary
//     z ruchow -> dopasowanie jednoznaczne, zapisywane przy --zapisz,
//   - numeru nie ma w GT (przenumerowany albo usuniety) -> wypisuje kandydatow: dokumenty
//     tego samego typu z tymi towarami, wystawione do 120 dni przed pierwszym ruchem. NIE
//     zgadujemy - dopasowanie podaje czlowiek przez --mapa, a skrypt sprawdza, czy towary sie
//     zgadzaja,
//   - numer pasuje do kilku dokumentow -> pomija i wypisuje.
// Numer w zrodlo_dok zostaje bez zmian - to zapis historyczny ("tak sie nazywal dokument").

const db = require('../db/database');
const { query, naCzesci } = require('../services/gt-sql');

const ZAPISZ = process.argv.includes('--zapisz');
const TYPY = { PZ: 10, PW: 12, MM: 9 };
const OKNO_KANDYDATOW_DNI = 120;

function mapaZArgumentow() {
  const mapa = new Map();
  process.argv.forEach((a, i) => {
    if (a !== '--mapa') return;
    const [nr, id] = String(process.argv[i + 1] ?? '').split('=');
    if (!nr || !Number(id)) throw new Error(`--mapa wymaga postaci "NUMER=dok_Id", jest: ${process.argv[i + 1]}`);
    mapa.set(nr.trim(), Number(id));
  });
  return mapa;
}

const typNumeru = (nr) => TYPY[String(nr).trim().split(/\s+/)[0]] ?? null;

async function pozycjeDokumentow(ids) {
  const wynik = new Map();
  for (const paczka of naCzesci([...new Set(ids)], 500)) {
    const { recordset } = await query(
      `SELECT DISTINCT ob_DokMagId AS dok, ob_TowId AS tw FROM dok_Pozycja WHERE ob_DokMagId IN (${paczka.join(',')})`);
    for (const r of recordset) {
      if (!wynik.has(r.dok)) wynik.set(r.dok, new Set());
      wynik.get(r.dok).add(String(r.tw));
    }
  }
  return wynik;
}

async function kandydaci(grupa) {
  const typ = typNumeru(grupa.nr);
  if (!typ) return [];
  const tw = grupa.artykuly.map(Number).filter(Boolean);
  const { recordset } = await query(`
    SELECT d.dok_Id AS id, d.dok_NrPelny AS nr, CONVERT(varchar(10), d.dok_DataWyst, 120) AS data
    FROM dok__Dokument d
    WHERE d.dok_Typ = @typ AND d.dok_DataWyst BETWEEN DATEADD(day, -${OKNO_KANDYDATOW_DNI}, @od) AND @do
      AND (SELECT COUNT(DISTINCT p.ob_TowId) FROM dok_Pozycja p
           WHERE p.ob_DokMagId = d.dok_Id AND p.ob_TowId IN (${tw.join(',')})) = ${tw.length}
    ORDER BY d.dok_DataWyst DESC`, { typ, od: grupa.od.slice(0, 10), do: grupa.do.slice(0, 10) });
  return recordset.map((r) => ({ id: r.id, nr: String(r.nr).trim(), data: r.data }));
}

(async () => {
  const mapa = mapaZArgumentow();
  const grupy = db.prepare(`
    SELECT zrodlo_dok AS nr, GROUP_CONCAT(DISTINCT artykul_gt_id) AS artykuly, COUNT(*) AS ruchow,
           SUM(ilosc) AS szt, MIN(data_ruchu) AS od, MAX(data_ruchu) AS do
    FROM ruchy WHERE zrodlo_dok IS NOT NULL AND zrodlo_dok_id IS NULL
    GROUP BY zrodlo_dok
  `).all().map((g) => ({ ...g, artykuly: String(g.artykuly).split(',') }));

  if (!grupy.length) {
    console.log('Wszystkie rozlozenia maja juz dok_Id - nie ma czego uzupelniac.');
    process.exit(0);
  }

  // dokumenty GT o tych numerach (PZ/PW/MM)
  const poNumerze = new Map();
  for (const paczka of naCzesci(grupy.map((g) => g.nr), 500)) {
    const parametry = {};
    const ph = paczka.map((nr, i) => { parametry[`n${i}`] = nr; return `@n${i}`; }).join(',');
    const { recordset } = await query(
      `SELECT dok_Id AS id, dok_NrPelny AS nr FROM dok__Dokument WHERE dok_Typ IN (9, 10, 12) AND dok_NrPelny IN (${ph})`,
      parametry);
    for (const r of recordset) {
      const nr = String(r.nr).trim();
      if (!poNumerze.has(nr)) poNumerze.set(nr, []);
      poNumerze.get(nr).push(r.id);
    }
  }
  const pozycje = await pozycjeDokumentow([...[...poNumerze.values()].flat(), ...mapa.values()]);
  const maTowary = (id, g) => g.artykuly.every((a) => pozycje.get(id)?.has(a));

  const doZapisu = [];
  const reczne = [];
  const brak = [];
  const niejednoznaczne = [];
  for (const g of grupy) {
    if (mapa.has(g.nr)) {
      const id = mapa.get(g.nr);
      if (!maTowary(id, g)) {
        console.log(`ODMOWA --mapa ${g.nr}=${id}: dokument nie ma na pozycjach wszystkich towarow z ruchow`);
        continue;
      }
      doZapisu.push({ ...g, id });
      reczne.push(g.nr);
      continue;
    }
    const pasujace = (poNumerze.get(g.nr) || []).filter((id) => maTowary(id, g));
    if (pasujace.length === 1) doZapisu.push({ ...g, id: pasujace[0] });
    else if (pasujace.length === 0) brak.push(g);
    else niejednoznaczne.push({ ...g, ids: pasujace });
  }

  console.log(`Numery bez dok_Id: ${grupy.length} (${grupy.reduce((s, g) => s + g.ruchow, 0)} ruchow)`);
  console.log(`  jednoznaczne po numerze: ${doZapisu.length - reczne.length}`);
  if (reczne.length) console.log(`  z --mapa: ${reczne.join(', ')}`);
  if (niejednoznaczne.length) {
    console.log(`  NIEJEDNOZNACZNE (pomijam): ${niejednoznaczne.length}`);
    for (const g of niejednoznaczne) console.log(`    ${g.nr} -> dok_Id ${g.ids.join(', ')}`);
  }
  if (brak.length) {
    console.log(`  BRAK W GT (przenumerowane albo usuniete): ${brak.length}`);
    for (const g of brak) {
      const k = await kandydaci(g);
      console.log(`    ${g.nr}: ${g.ruchow} ruchow, ${g.szt} szt., ${g.artykuly.length} towarow, ruchy ${g.od.slice(0, 10)}..${g.do.slice(0, 10)}`);
      if (!k.length) console.log('      kandydaci: brak');
      for (const c of k.slice(0, 5)) console.log(`      kandydat: ${c.nr} (${c.data}) -> --mapa "${g.nr}=${c.id}"`);
    }
  }

  if (!ZAPISZ) {
    console.log('\nPODGLAD - nic nie zapisano. Zapis: --zapisz');
    process.exit(0);
  }

  const upd = db.prepare('UPDATE ruchy SET zrodlo_dok_id = ? WHERE zrodlo_dok = ? AND zrodlo_dok_id IS NULL');
  let zmienione = 0;
  db.exec('BEGIN');
  try {
    for (const g of doZapisu) zmienione += Number(upd.run(g.id, g.nr).changes);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  console.log(`\nZapisano dok_Id w ${zmienione} ruchach (${doZapisu.length} dokumentow).`);
  process.exit(0);
})().catch((err) => {
  console.error('Blad:', err.message);
  process.exit(1);
});
