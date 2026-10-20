'use strict';

// Wczytanie HISTORII sprzedaży z GT do db/sprzedaz.db (moduł analiz sprzedaży, docs/analiza-sprzedazy.md).
//   node scripts/analiza-wczytaj.js                         -> podgląd od 2023-01-01 do dziś, NIC nie zapisuje
//   node scripts/analiza-wczytaj.js --od 2025-01-01         -> podgląd od podanego dnia
//   node scripts/analiza-wczytaj.js --od 2025-01-01 --zapisz -> zapisuje (miesiąc po miesiącu)
//
// GT czytamy wyłącznie SELECT-ami; pisze tylko do własnej bazy modułu. Okna miesięczne (FS po dacie FS, ZK bez
// FS po dacie ZK, PA i KFS po swojej dacie) — ten sam kod (services/analiza-dane.js), co job WMS-Node, więc
// skrypt i job nie mogą się rozjechać. Ponowne uruchomienie jest bezpieczne: zamówienia z okna zastępują swoje
// stare wersje, a koszt zakupu zostaje z pierwszego wczytania.
//
// Raport na miesiąc: zamówienia, przychód, zysk, udział obrotu wg reguły kanału (ile stoi na regule zastępczej:
// kraj płatnika, numer Amazona, brak źródła) i ile zysku to marża handlowa (kanał bez reguł w kalkulatorze).

const dane = require('../services/analiza-dane');
const { dodajDni } = require('../services/analiza-model');
const { dzisLokalnie } = require('../services/sprzedaz-model');

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const ZAPISZ = process.argv.includes('--zapisz');
const OD = arg('--od') || '2023-01-01';
const DO = arg('--do') || dodajDni(dzisLokalnie(), 1);
if (!/^\d{4}-\d{2}-\d{2}$/.test(OD) || !/^\d{4}-\d{2}-\d{2}$/.test(DO)) { console.error('Daty w formacie YYYY-MM-DD'); process.exit(1); }

const nastMiesiac = (d) => { const [r, m] = d.split('-').map(Number); return m === 12 ? `${r + 1}-01-01` : `${r}-${String(m + 1).padStart(2, '0')}-01`; };
const zl = (x) => Math.round(x).toLocaleString('pl-PL');

(async () => {
  console.log(`${ZAPISZ ? 'ZAPIS' : 'PODGLĄD (bez zapisu)'}: ${OD} … ${DO} (do wyłącznie)`);
  const sumy = { zam: 0, netto: 0, zysk: 0 };
  const tw = new Set();
  for (let od = OD; od < DO; od = nastMiesiac(od)) {
    const doDnia = nastMiesiac(od) < DO ? nastMiesiac(od) : DO;
    const t0 = Date.now();
    let w;
    try { w = await dane.wczytajOkno(od, doDnia, { zapiszDoBazy: ZAPISZ }); }
    catch (e) { console.error(`${od}: BŁĄD ${e.message}`); process.exitCode = 1; continue; }
    const netto = w.zamowienia.reduce((s, z) => s + z.netto, 0), zysk = w.zamowienia.reduce((s, z) => s + (z.zysk || 0), 0);
    const reg = {}, handl = w.zamowienia.filter((z) => String(z.zysk_zrodlo).startsWith('handlowa')).reduce((s, z) => s + z.netto, 0);
    for (const z of w.zamowienia) reg[z.kanal_regula] = (reg[z.kanal_regula] || 0) + z.netto;
    const zastepcze = Object.entries(reg).filter(([r]) => !/^(zrodlo_fs|zrodlo_zk|kategoria_fs|kategoria_zk|paragon)$/.test(r))
      .sort((a, b) => b[1] - a[1]).map(([r, v]) => `${r} ${(100 * v / (netto || 1)).toFixed(1)}%`).join(', ');
    console.log(`${od.slice(0, 7)}: ${w.zamowienia.length} zam., ${zl(netto)} zł netto, zysk ${zl(zysk)} zł (${(100 * zysk / (netto || 1)).toFixed(1)}%)`
      + ` · marża handlowa ${(100 * handl / (netto || 1)).toFixed(1)}% obrotu · reguły zastępcze: ${zastepcze || '—'} · zwrotów ${w.zwroty.length}`
      + ` · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    sumy.zam += w.zamowienia.length; sumy.netto += netto; sumy.zysk += zysk;
    for (const p of w.pozycje) tw.add(p.tw_id);
    for (const s of w.skladniki) tw.add(s.tw_id);
  }
  console.log(`RAZEM: ${sumy.zam} zam., ${zl(sumy.netto)} zł netto, zysk ${zl(sumy.zysk)} zł, ${tw.size} towarów`);
  if (ZAPISZ) {
    console.log(`Kartoteka: ${await dane.odswiezTowary([...tw])} towarów`);
    console.log(`Stany dziś: ${await dane.zdjecieStanow(dzisLokalnie())} towarów`);
    console.log(`Tempa sprzedaży: ${dane.przeliczTempa(dzisLokalnie())} towarów`);
    const stare = dane.meta.get('historia_od');
    if (!stare || OD < stare.wartosc) dane.meta.set('historia_od', OD);
    dane.meta.set('historia_wczytana', new Date().toISOString());
  } else {
    console.log('Nic nie zapisano. Zapis: dodaj --zapisz');
  }
  process.exit(process.exitCode || 0);
})();
