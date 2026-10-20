'use strict';

// Raport sprzedaży mailem — podgląd i wysyłka ręczna (to samo, co job WMS-Node wysyła codziennie o 7:00).
//   node scripts/analiza-raport.js                          -> podgląd za wczoraj do pliku raport-sprzedazy.html
//   node scripts/analiza-raport.js --dzien 2026-10-19       -> podgląd za podany dzień
//   node scripts/analiza-raport.js --tydzien                -> z sekcją tygodnia (jak w poniedziałek)
//   node scripts/analiza-raport.js --wyslij [--do adres]    -> wysyła (domyślnie do ANALIZA_RAPORT_DO)
// Czyta tylko db/sprzedaz.db; wysyła przez Gmail API z zakresem tylko do wysyłania (services/gmail-wysylka.js).

require('../config/env');
const fs = require('fs');
const raport = require('../services/analiza-raport');
const gmail = require('../services/gmail-wysylka');

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const WYSLIJ = process.argv.includes('--wyslij');

(async () => {
  const r = await raport.zbierzRaport(arg('--dzien'), { tydzien: process.argv.includes('--tydzien') ? true : null });
  const temat = raport.tematRaportu(r);
  if (!WYSLIJ) {
    let html = raport.htmlRaportu(r);
    for (const o of r.obrazy) html = html.replace('cid:' + o.cid, `data:${o.typ};base64,${o.bufor.toString('base64')}`);
    fs.writeFileSync('raport-sprzedazy.html', html);
    console.log(`Podgląd: raport-sprzedazy.html\nTemat: ${temat}\nNic nie wysłano. Wysyłka: --wyslij`);
    return process.exit(0);
  }
  const doKogo = arg('--do') || process.env.ANALIZA_RAPORT_DO;
  if (!doKogo) { console.error('Brak adresatów: ANALIZA_RAPORT_DO w .env albo --do'); return process.exit(1); }
  const w = await gmail.wyslij({ do: doKogo, temat, html: raport.htmlRaportu(r), obrazy: r.obrazy });
  console.log(`Wysłano do ${doKogo} (Gmail id ${w.id})\nTemat: ${temat}`);
  process.exit(0);
})().catch((e) => { console.error('BŁĄD:', e.message); process.exit(1); });
