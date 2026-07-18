'use strict';

// AUTO-DOPIS skladnikow z rozmontowanego zestawu na polke K4.
//
// Po co: gdy ktos rozmontuje zestaw w Subiekcie (RW na zestaw + PW na skladniki), skladniki
// fizycznie zostaja w obrebie K4 - zestaw stal na polce, wiec jego czesci sa tam, gdzie byly.
// Kazanie magazynierowi "odlozyc" cos, co juz lezy na miejscu, to pusta robota. Dlatego WMS
// dopisuje te sztuki do polki sam.
//
// NIE dotyczy rozmontowania ZWROTU (zestaw wrocil na KFS) - tam skladniki leza na WOZKU
// ZWROTOW i ktos musi je fizycznie rozwiezc. Te ida do strefy zwrotow jako zadanie
// (gt-dokumenty.js klasyfikuje je jako rodzaj 'zwrot'). Auto-dopis wpisalby nieprawde
// o lokalizacji. Filtr siedzi w pobierzRozmontowaniaZeStanuOd.
//
// DWA TWARDE BEZPIECZNIKI:
//  1) DATA ODCIECIA (WMS_ROZMONTOWANIA_OD) - rozmontowania sa w GT od 2019 r. (ponad 150 tys.
//     sztuk). Bez odciecia pierwszy przebieg wrzucilby cala te historie na polki. Brak
//     zmiennej = job WYLACZONY (bezpieczny default, nie "od poczatku swiata").
//  2) SUFIT STANU GT - dopisujemy najwyzej tyle, ile brakuje do stanu GT na K4
//     (inwariant #3: suma WMS = stan GT). Chroni, gdy ktos odlozyl te sztuki recznie.
//
// Idempotencja: kazdy dopis to ruch LOK podpisany numerem PW (ruchy.zrodlo_dok). Kolejny
// przebieg odejmuje juz dopisane przez iloscRozlozonaZDokumentu, wiec nie dubluje. Ten sam
// mechanizm sprawia, ze pozycja znika ze strefy PW - rozbicie widzi ja jako rozlozona.

const db = require('../db/database');
const gtDokumenty = require('./gt-dokumenty');
const { pobierzStanyGt } = require('./gt-produkty');
const { wykonajRuchGT } = require('./ruchy-gt');
const audyt = require('./audyt');
const awarie = require('./awarie');

const MAG = 'K4';
const OPERATOR = 'auto-rozmontowanie';
const INTERWAL_MIN = Number(process.env.WMS_ROZMONTOWANIA_INTERWAL_MIN) || 10;

// Dzien wdrozenia. Bez niego job nie rusza - patrz bezpiecznik 1.
function dataOdciecia() {
  const s = process.env.WMS_ROZMONTOWANIA_OD;
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Jedyna lokalizacja K4 tego SKU w WMS. Regula "1 SKU = 1 lokalizacja K4" powinna to
// gwarantowac, ale gdy wierszy jest 0 albo >1 NIE zgadujemy - zostawiamy pozycje w strefie
// PW, zeby czlowiek wskazal miejsce (to jest ta "szuflada do zlokalizowania").
function jedynaLokalizacjaK4(artykulGtId) {
  const wiersze = db.prepare(`
    SELECT l.id, l.kod FROM stany_lokalizacji s
    JOIN lokalizacje l ON l.id = s.lokalizacja_id
    WHERE s.artykul_gt_id = ? AND l.magazyn = ?
  `).all(String(artykulGtId), MAG);
  return wiersze.length === 1 ? wiersze[0] : null;
}

function sumaWmsK4(artykulGtId) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(s.ilosc), 0) AS suma FROM stany_lokalizacji s
    JOIN lokalizacje l ON l.id = s.lokalizacja_id
    WHERE s.artykul_gt_id = ? AND l.magazyn = ?
  `).get(String(artykulGtId), MAG);
  return Number(r?.suma) || 0;
}

// Jeden przebieg. Zwraca podsumowanie (do logu/testu), nie rzuca przy pojedynczej pozycji -
// jedna felerna nie moze zablokowac reszty.
async function przetworz() {
  const od = dataOdciecia();
  if (!od) return { wylaczone: true, powod: 'brak WMS_ROZMONTOWANIA_OD' };

  const pozycje = await gtDokumenty.pobierzRozmontowaniaZeStanuOd(od);
  if (pozycje.length === 0) return { pozycji: 0, dopisano: 0, pominieto: 0 };

  const stany = await pobierzStanyGt(pozycje.map((p) => p.artykul_gt_id));

  let dopisano = 0;
  let pominieto = 0;
  for (const p of pozycje) {
    try {
      const juz = gtDokumenty.iloscRozlozonaZDokumentu(p.artykul_gt_id, MAG, p.pw_nr);
      const pozostalo = p.ilosc - juz;
      if (pozostalo <= 0) continue; // juz dopisane wczesniejszym przebiegiem

      const lok = jedynaLokalizacjaK4(p.artykul_gt_id);
      if (!lok) { pominieto++; continue; } // 0 albo >1 lokalizacji - niech zdecyduje czlowiek

      // Sufit: nie wolno przekroczyc stanu GT na K4 (inwariant #3).
      const stanGt = stany.get(String(p.artykul_gt_id))?.[MAG]?.ilosc ?? 0;
      const wolne = stanGt - sumaWmsK4(p.artykul_gt_id);
      const ilo = Math.min(pozostalo, wolne);
      if (ilo <= 0) { pominieto++; continue; }

      zapiszDopis(p, lok, ilo);
      dopisano++;
    } catch (err) {
      pominieto++;
      awarie.blad('rozmontowania', `Auto-dopis nie powiodl sie dla ${p.symbol} / ${p.pw_nr}: ${err.message}`,
        { artykul: p.artykul_gt_id, pw: p.pw_nr });
    }
  }
  return { pozycji: pozycje.length, dopisano, pominieto };
}

// Zapis = dokladnie to samo, co robi /ruchy/rozloz dla LOK: ruch podpisany dokumentem +
// podbicie stanu lokalizacji. GT juz swoje zrobil (PW), wiec zaden dokument nie powstaje.
function zapiszDopis(p, lok, ilo) {
  let ruchId;
  db.exec('BEGIN');
  try {
    const ruch = db.prepare(`
      INSERT INTO ruchy (typ, artykul_gt_id, artykul_symbol, lok_zrodlo_id, lok_cel_id, mag_zrodlo_pula, zrodlo_dok, ilosc, status, operator)
      VALUES ('LOK', ?, ?, NULL, ?, ?, ?, ?, 'pending', ?)
    `).run(p.artykul_gt_id, p.symbol ?? String(p.artykul_gt_id), lok.id, MAG, p.pw_nr, ilo, OPERATOR);
    ruchId = ruch.lastInsertRowid;

    const stanCel = db.prepare('SELECT * FROM stany_lokalizacji WHERE lokalizacja_id = ? AND artykul_gt_id = ?')
      .get(lok.id, String(p.artykul_gt_id));
    if (stanCel) {
      db.prepare('UPDATE stany_lokalizacji SET ilosc = ilosc + ?, ostatnia_zmiana = CURRENT_TIMESTAMP, operator = ? WHERE id = ?')
        .run(ilo, OPERATOR, stanCel.id);
    } else {
      db.prepare(`
        INSERT INTO stany_lokalizacji (lokalizacja_id, artykul_gt_id, artykul_symbol, artykul_nazwa, artykul_ean, ilosc, operator)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(lok.id, String(p.artykul_gt_id), p.symbol ?? String(p.artykul_gt_id), p.nazwa ?? '', p.ean ?? null, ilo, OPERATOR);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // LOK nie wystawia dokumentu - domykamy tylko cykl statusu ruchu.
  wykonajRuchGT(ruchId).catch((err) => {
    awarie.blad('rozmontowania', `Domkniecie ruchu ${ruchId} nie powiodlo sie: ${err.message}`, { ruchId });
  });

  audyt.zapisz({
    uzytkownik: OPERATOR, akcja: 'rozmontowanie_auto',
    artykul_gt_id: p.artykul_gt_id, artykul_symbol: p.symbol,
    magazyn: MAG, lokalizacja: `${p.pw_nr} (${p.zestaw_symbol ?? 'zestaw'}) → ${lok.kod}`,
    ilosc: ilo, wynik: 'ok', ruch_id: ruchId,
  });
}

let timer = null;
function start() {
  const od = dataOdciecia();
  if (!od) {
    console.log('[rozmontowania] WMS_ROZMONTOWANIA_OD nie ustawione - auto-dopis skladnikow WYLACZONY. '
      + 'Ustaw na dzien wdrozenia, inaczej historia rozmontowan (od 2019 r.) nigdy sie nie dopisze - i dobrze.');
    return;
  }
  console.log(`[rozmontowania] auto-dopis aktywny od ${od.toISOString().slice(0, 10)}, co ${INTERWAL_MIN} min`);
  const uruchom = () => przetworz()
    .then((w) => { if (w.dopisano) console.log(`[rozmontowania] dopisano ${w.dopisano}, pominieto ${w.pominieto}`); })
    .catch((err) => awarie.blad('rozmontowania', `Przebieg nie powiodl sie: ${err.message}`, {}));
  uruchom();
  timer = setInterval(uruchom, INTERWAL_MIN * 60 * 1000);
  if (timer.unref) timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { przetworz, start, stop, dataOdciecia };
