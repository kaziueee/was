'use strict';

// Włączanie/wyłączanie automatu dla wybranych ofert (do czasu ekranu w WMS). Nigdy hurtem na cały
// katalog — tylko podane SKU (decyzja usera 2026-10-13: włączamy ręcznie albo grupami).
//
//   node pricing/automat.js wlacz DE PLA71602 FR SIM75818 ...   — pary rynek + SKU
//   node pricing/automat.js wylacz DE PLA71602 ...
//   node pricing/automat.js lista                               — oferty z włączonym automatem
//
// Przy włączaniu ostrzega, gdy ostatnia obserwacja pokazuje cenę poniżej minimum albo Buy Box
// pod naszą podłogą — wtedy automat podniesie cenę albo będzie stał, a nie gonił rynek.

const { db } = require('./db');
const { pasyHurtem } = require('./pas');

async function main([akcja, ...reszta]) {
  if (akcja === 'lista') {
    console.table(db.prepare(`SELECT o.rynek, o.sku, o.symbol_gt, o.ilosc,
        (SELECT kod || ': ' || cena_przed || ' → ' || cena_nowa FROM decyzje WHERE oferta_id = o.id ORDER BY id DESC LIMIT 1) AS ostatnia_decyzja
      FROM oferty o WHERE o.auto = 1 ORDER BY o.rynek, o.sku`).all());
    return;
  }
  if (!['wlacz', 'wylacz'].includes(akcja) || reszta.length < 2 || reszta.length % 2) {
    throw new Error('Użycie: node pricing/automat.js wlacz|wylacz <RYNEK> <SKU> [<RYNEK> <SKU> ...] | lista');
  }
  const pary = [];
  for (let i = 0; i < reszta.length; i += 2) pary.push([reszta[i].toUpperCase(), reszta[i + 1]]);

  const znajdz = db.prepare(`SELECT o.*, (SELECT cena FROM obserwacje WHERE oferta_id = o.id ORDER BY id DESC LIMIT 1) AS obs_cena,
      (SELECT bb_cena FROM obserwacje WHERE oferta_id = o.id ORDER BY id DESC LIMIT 1) AS obs_bb,
      (SELECT wysylka FROM obserwacje WHERE oferta_id = o.id ORDER BY id DESC LIMIT 1) AS obs_wys,
      (SELECT bb_nasz FROM obserwacje WHERE oferta_id = o.id ORDER BY id DESC LIMIT 1) AS obs_bb_nasz
    FROM oferty o WHERE platforma = 'amazon' AND rynek = ? AND sku = ?`);
  const oferty = pary.map(([r, s]) => ({ r, s, o: znajdz.get(r, s) }));
  for (const { r, s, o } of oferty) if (!o) throw new Error(`Nie ma oferty ${r} ${s} — najpierw node pricing/sync-oferty.js`);

  const ustaw = db.prepare('UPDATE oferty SET auto = ? WHERE id = ?');
  if (akcja === 'wylacz') {
    for (const { o } of oferty) ustaw.run(0, o.id);
    console.log(`Automat wyłączony dla ${oferty.length} ofert.`);
    return;
  }

  const pasy = await pasyHurtem(oferty.map(({ o }) => o.tw_id).filter(Boolean));
  for (const { r, s, o } of oferty) {
    const uwagi = [];
    if (!o.tw_id) uwagi.push('brak towaru GT — automat nie zadziała (node pricing/powiaz.js)');
    if (!(o.ilosc > 0)) uwagi.push('brak stanu — worker pomija oferty bez stanu');
    const pas = (pasy.get(o.tw_id) || {})[r];
    if (!pas) uwagi.push('brak pasa z kalkulatora (np. Amazon PL) — automat nie zdecyduje');
    else {
      const cena = o.obs_cena ?? o.cena;
      if (Math.round(cena * 100) < Math.round(pas.min * 100)) uwagi.push(`cena ${cena} poniżej minimum ${pas.min} — automat PODNIESIE ją do minimum`);
      if (o.obs_bb != null && !o.obs_bb_nasz && Math.round((o.obs_bb - (o.obs_wys || 0)) * 100) < Math.round(pas.min * 100)) uwagi.push(`Buy Box ${o.obs_bb} pod naszą podłogą ${pas.min} — automat nie będzie go gonił`);
    }
    ustaw.run(1, o.id);
    console.log(`${r} ${s}: automat włączony${uwagi.length ? '\n   ⚠ ' + uwagi.join('\n   ⚠ ') : ''}`);
  }
}

main(process.argv.slice(2)).then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
