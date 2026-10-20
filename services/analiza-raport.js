'use strict';

// Raport sprzedaży mailem (moduł analiz, docs/analiza-sprzedazy.md): codziennie za wczoraj, w poniedziałek także
// tydzień i miesiąc do dziś. Liczby z services/analiza-zapytania.js — te same co ekran Sprzedaż / telefon.
// Decyzje usera 2026-10-20: Gmail API (tylko wysyłka), do usera i PawelkaZ@gmail.com (ANALIZA_RAPORT_DO), w treści
// kafle, kanały, top 10 produktów ze zdjęciem, kończący się zapas, sprzedaż ze stratą, dni nietypowe.
// HTML z samych tabel i stylów w linii — Gmail wycina <style> i nie pobierze obrazka z sieci firmowej, więc zdjęcia
// idą w mailu jako załączniki inline (cid:).

const q = require('./analiza-zapytania');
const am = require('./analiza-model');
const { db } = require('../db/sprzedaz');
const { dzisLokalnie } = require('./sprzedaz-model');
const { NAZWY_KANALOW } = require('./analiza-kanal');

const KONCZY_DNI = 14;          // „kończy się zapas”: mniej niż tyle dni przy tempie z 30 dni
const KONCZY_MIN_SZT30 = 10;    // … i towar naprawdę się sprzedaje (≥ 10 szt. w 30 dni)
const ADRES_TELEFON = 'http://100.107.156.67:3000/sprzedaz/';

const nf0 = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const zl = (x) => (x == null || !isFinite(x) ? '—' : nf0.format(Math.round(x)) + '&nbsp;zł');
const szt = (x) => nf0.format(x || 0);
const pct = (x) => (x == null || !isFinite(x) ? '—' : nf1.format(x) + '%');
const naSzt = (z, n) => (z == null || !n ? '—' : (Math.abs(z / n) < 10 ? nf1.format(z / n) : nf0.format(Math.round(z / n))) + '&nbsp;zł/szt.');
const marza = (g) => (g && g.netto ? g.zysk / g.netto * 100 : null);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const DNI = ['niedz.', 'pon.', 'wt.', 'śr.', 'czw.', 'pt.', 'sob.'];
const dzienTxt = (s) => { const d = new Date(s + 'T12:00:00'); return `${DNI[d.getDay()]} ${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`; };
const zakresTxt = (o) => (o[0] === o[1] ? dzienTxt(o[0]) : `${o[0].slice(8, 10)}.${o[0].slice(5, 7)}–${o[1].slice(8, 10)}.${o[1].slice(5, 7)}.${o[1].slice(0, 4)}`);
function zmiana(cur, prev, { tekst = false } = {}) {
  if (!prev || cur == null) return tekst ? '' : '<span style="color:#6b7280">—</span>';
  const p = (cur / prev - 1) * 100, s = `${p >= 0 ? '+' : '−'}${nf0.format(Math.abs(Math.round(p)))}%`;
  return tekst ? s : `<span style="color:${p >= 0 ? '#1a7f37' : '#c62828'};font-weight:600">${s}</span>`;
}

function okres(dzien, zakres, baza = 'zam') {
  const p = q.parametry({ dzien, zakres, baza });
  const d = q.podsumowanie(p);
  return { ...d, sc: q.sumaInternetu(d.cur.kanaly), sp: q.sumaInternetu(d.prev.kanaly) };
}

// Kończący się zapas: sprzedaje się (≥ 10 szt./30 dni), a stanu dostępnego (Razem − rezerwacje; zestaw — ze
// składników) zostało mniej niż na 14 dni (albo nic).
function konczySie(limit = 12) {
  const kand = db.prepare('SELECT tw_id, szt30 FROM tempa WHERE szt30 >= ?').all(KONCZY_MIN_SZT30);
  const stany = q.stanyTowarow(kand.map((k) => k.tw_id));
  const wynik = [];
  for (const k of kand) {
    const s = stany.get(k.tw_id);
    if (!s) continue;
    const stan = q.dostepneZeStanu(s), dni = am.dniZapasu(stan, k.szt30);
    if (dni != null && dni < KONCZY_DNI) wynik.push({ tw_id: k.tw_id, szt30: k.szt30, stan, dni });
  }
  wynik.sort((a, b) => b.szt30 - a.szt30);
  return q.uzupelnijTowary(wynik.slice(0, limit), { zRepricerem: false }).produkty.map((p, i) => ({ ...p, ...wynik[i] }));
}

// Sprzedaż ze stratą danego dnia (wg zamówienia): pozycje z zyskiem po kosztach kanału poniżej zera.
function strata(dzien, limit = 10) {
  const r = db.prepare(`SELECT x.tw_id, z.kanal, SUM(x.szt) szt, SUM(x.netto + IFNULL(x.wysylka, 0)) netto, SUM(x.zysk) zysk, MIN(x.koszt) koszt
    FROM pozycje x JOIN zamowienia z ON z.id = x.zam_id
    WHERE z.data_zam = ? AND x.zysk < 0 AND z.zysk_zrodlo NOT LIKE '%bez_kosztu' AND z.status != 'paragon'
    GROUP BY x.tw_id, z.kanal ORDER BY SUM(x.zysk) LIMIT ?`).all(dzien, limit);
  const info = q.uzupelnijTowary(r.map((x) => ({ tw_id: x.tw_id })), { zRepricerem: false }).produkty;
  return r.map((x, i) => ({ ...x, symbol: info[i].symbol, nazwa: info[i].nazwa }));
}

// zdjecia: true → miniatury z Sellasist do wklejenia w mail (cid:), false → podgląd w przeglądarce (adres WMS).
async function zbierzRaport(dzien, { tydzien = null, zdjecia = true } = {}) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(dzien || '')) ? dzien : am.dodajDni(dzisLokalnie(), -1);
  const poniedzialek = new Date(am.dodajDni(d, 1) + 'T12:00:00').getDay() === 1;    // raport za niedzielę = poniedziałek rano
  const zTygodniem = tydzien == null ? poniedzialek : !!tydzien;
  const r = {
    dzien: d, tydzien: zTygodniem, wygenerowano: new Date().toISOString(), nazwy: NAZWY_KANALOW,
    dzienZam: okres(d, 'dzien', 'zam'), dzienFs: okres(d, 'dzien', 'fs'), mtd: okres(d, 'mtd', 'zam'),
    t7: okres(d, 't7', 'zam'),             // w temacie zawsze (stabilniejsze niż jeden dzień), sekcja tylko w poniedziałek
    top: q.produkty(q.parametry({ dzien: d, zakres: 'dzien', baza: 'zam' }), { sort: 'zysk', limit: 10, zRepricerem: false }).produkty,
    konczy: konczySie(), strata: strata(d), obrazy: [],
  };
  if (zdjecia) {
    const { pobierzZdjecie } = require('./zdjecia');
    for (const p of r.top) {
      if (!p.symbol) continue;
      try {
        const z = await pobierzZdjecie(p.symbol, 'mini');
        if (z) { p.cid = `tw${p.tw_id}@wms`; r.obrazy.push({ cid: p.cid, typ: z.typ, bufor: z.bufor }); }
      } catch { /* bez zdjęcia — wiersz i tak jest */ }
    }
  }
  return r;
}

// Temat: dzień + r/r, a obok 7 dni r/r — jeden dzień bywa przekłamany (przestój integracji rok temu dał −38% przy
// −4% w tygodniu). Gdy porównywany dzień jest nietypowy, zamiast procentu piszemy to wprost.
function tematRaportu(r) {
  const { sc, sp, okresy, nietypowe } = r.dzienZam;
  const zly = (nietypowe || []).some((n) => n.dzien === okresy.prev[0] || n.dzien === okresy.cur[0]);
  const rr = zly ? 'r/r niemiarodajne' : `${zmiana(sc.netto, sp.netto, { tekst: true }) || '—'} r/r`;
  const t7 = r.t7 ? `, 7 dni ${zmiana(r.t7.sc.netto, r.t7.sp.netto, { tekst: true }) || '—'}` : '';
  return `Sprzedaż ${dzienTxt(r.dzien)}: ${nf0.format(Math.round(sc.netto))} zł (${rr}${t7}) · zysk ${nf0.format(Math.round(sc.zysk))} zł`
    + ` (${nf1.format(marza(sc) || 0)}%)${r.tydzien ? ' · + tydzień' : ''}`;
}

// --- HTML ---------------------------------------------------------------------------------------------------
// telefon (~360 px) — małe odstępy, liczby bez łamania, nazwy się łamią
const TD = 'padding:5px 5px;border-bottom:1px solid #eef0f2;font-size:12px;';
const TDN = TD + 'text-align:right;white-space:nowrap;';
const TH = 'padding:5px 5px;border-bottom:1px solid #d6d9de;font-size:11px;color:#6b7280;text-align:left;font-weight:600;';
const THN = TH + 'text-align:right;';
const sekcja = (tytul, tresc, opis = '') => `<tr><td style="padding:18px 16px 4px"><div style="font-size:15px;font-weight:700;color:#1d3557">${tytul}</div>`
  + (opis ? `<div style="font-size:12px;color:#6b7280;margin-top:2px">${opis}</div>` : '') + `</td></tr><tr><td style="padding:4px 16px">${tresc}</td></tr>`;

function kafle(o) {
  const { sc, sp } = o;
  const mc = marza(sc), mp = marza(sp);
  const k = [
    ['Przychód netto', zl(sc.netto), zmiana(sc.netto, sp.netto), zl(sp.netto)],
    ['Zysk', zl(sc.zysk), zmiana(sc.zysk, sp.zysk), zl(sp.zysk)],
    ['Marża', pct(mc), mc != null && mp != null ? `<span style="color:${mc >= mp ? '#1a7f37' : '#c62828'};font-weight:600">${mc >= mp ? '+' : '−'}${nf1.format(Math.abs(mc - mp))}&nbsp;pp</span>` : '', pct(mp)],
    ['Zysk na sztuce', naSzt(sc.zysk, sc.szt), zmiana(sc.szt ? sc.zysk / sc.szt : null, sp.szt ? sp.zysk / sp.szt : null), naSzt(sp.zysk, sp.szt)],
    ['Sztuki', szt(sc.szt), zmiana(sc.szt, sp.szt), szt(sp.szt)],
    ['Zamówienia', szt(sc.zam), zmiana(sc.zam, sp.zam), szt(sp.zam)],
  ];
  // 2 kafle w rzędzie — 3 nie mieszczą się na telefonie (Gmail nie zawsze honoruje media queries)
  const kom = (x) => `<td width="50%" style="padding:7px;border:1px solid #e3e5e8;vertical-align:top"><div style="font-size:11px;color:#6b7280">${x[0]}</div>`
    + `<div style="font-size:18px;font-weight:700;color:#1a1a1a;white-space:nowrap">${x[1]}</div><div style="font-size:11px;color:#6b7280">${x[2]} · rok temu ${x[3]}</div></td>`;
  return `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed">`
    + [0, 2, 4].map((i) => `<tr>${k.slice(i, i + 2).map(kom).join('')}</tr>`).join('') + '</table>';
}

function tabelaKanalow(o, nazwy) {
  const sc = o.sc;
  const wiersze = Object.entries(o.cur.kanaly).filter(([k]) => !q.POZA_SUMA.includes(k)).sort((a, b) => b[1].netto - a[1].netto);
  const wiersz = ([k, g], poza = false) => {
    const prev = o.prev.kanaly[k];
    const handl = g.handl && g.netto && g.handl / g.netto > 0.5;
    return `<tr><td style="${TD}">${esc(nazwy[k] || k)}${poza ? ' <span style="color:#6b7280;font-size:11px">(poza sumą)</span>' : ''}</td>`
      + `<td style="${TDN}">${zl(g.netto)}</td><td style="${TDN}">${zmiana(g.netto, prev?.netto)}</td><td style="${TDN}">${pct(marza(g))}</td>`
      + `<td style="${TDN}">${handl ? '≈&nbsp;' : ''}${zl(g.zysk)}</td></tr>`;
  };
  const sklep = q.POZA_SUMA.map((k) => [k, o.cur.kanaly[k]]).filter(([, g]) => g);
  return `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr><th style="${TH}">Kanał</th><th style="${THN}">Przychód</th>`
    + `<th style="${THN}">r/r</th><th style="${THN}">Marża</th><th style="${THN}">Zysk</th></tr>`
    + wiersze.map((w) => wiersz(w)).join('')
    + `<tr><td style="${TD}font-weight:700">Razem internet</td><td style="${TDN}font-weight:700">${zl(sc.netto)}</td><td style="${TDN}">${zmiana(sc.netto, o.sp.netto)}</td>`
    + `<td style="${TDN}font-weight:700">${pct(marza(sc))}</td><td style="${TDN}font-weight:700">${zl(sc.zysk)}</td></tr>`
    + sklep.map((w) => wiersz(w, true)).join('') + '</table>';
}

function htmlRaportu(r, { podglad = false } = {}) {
  const nazwy = r.nazwy || NAZWY_KANALOW;
  const z = r.dzienZam, f = r.dzienFs;
  const ostrz = [];
  if (!z.historia_pelna) ostrz.push('Historia sprzed roku nie jest wczytana w całości — porównanie r/r może być zaniżone.');
  for (const o of [z, r.tydzien ? r.t7 : null].filter(Boolean)) for (const n of o.nietypowe || []) {
    ostrz.push(`${dzienTxt(n.dzien)}: ${szt(n.zamowien)} zamówień, zwykle ~${szt(n.mediana)} — porównanie z tym dniem jest mylące (przestój integracji albo dzień promocji).`);
  }
  // dane nieświeże (GT nie odpowiadało, job stał) — mail mówi to wprost, zamiast udawać pełny dzień
  const biezacy = z.wczytanie?.biezacy ? new Date(z.wczytanie.biezacy) : null;
  if (!podglad && (!biezacy || Date.now() - biezacy.getTime() > 3 * 3600e3)) {
    ostrz.unshift(`Dane wczytane ostatnio ${biezacy ? biezacy.toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' }) : '—'} — liczby mogą być niepełne (GT nie odpowiadało?).`);
  }
  const unik = [...new Set(ostrz)];
  const foto = (p) => (podglad ? `/api/produkty/${p.tw_id}/zdjecie?rozmiar=mini` : p.cid ? `cid:${p.cid}` : null);
  const top = r.top.map((p, i) => {
    const src = foto(p);
    return `<tr><td style="${TD}width:60px">${src ? `<img src="${src}" width="56" height="56" alt="" style="display:block;width:56px;height:56px;object-fit:contain;border:1px solid #e3e5e8;border-radius:4px">` : ''}</td>`
      + `<td style="${TD}"><div style="font-weight:700;font-family:Menlo,Consolas,monospace;font-size:12px">${i + 1}. ${esc(p.symbol || p.tw_id)}</div>`
      + `<div style="font-size:12px;color:#333">${esc((p.nazwa || '').slice(0, 70))}</div>`
      + `<div style="font-size:12px;margin-top:2px"><b>${szt(p.szt)}</b> szt. · marża <b>${pct(marza(p))}</b> · <b>${naSzt(p.zysk, p.szt)}</b> · zysk <b>${zl(p.zysk)}</b></div>`
      + `<div style="font-size:11px;color:#6b7280">${p.kanaly.map((c) => `${esc(nazwy[c.k] || c.k)} ${szt(c.szt)}`).join(' · ')}`
      + `${p.stan ? ` · dostępne ${szt(p.stan.dostepne)}${p.dni_zapasu != null ? `, zapas ~${szt(p.dni_zapasu)} dni` : ''}` : ''}</div></td></tr>`;
  }).join('');
  const konczy = r.konczy.length ? `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr><th style="${TH}">Towar</th>`
    + `<th style="${THN}">30 dni</th><th style="${THN}">Dostępne</th><th style="${THN}">Zapas</th></tr>`
    + r.konczy.map((p) => `<tr><td style="${TD}"><b style="font-family:Menlo,Consolas,monospace;font-size:12px">${esc(p.symbol || p.tw_id)}</b> <span style="font-size:12px;color:#333">${esc((p.nazwa || '').slice(0, 45))}</span></td>`
      + `<td style="${TDN}">${szt(p.szt30)}&nbsp;szt.</td><td style="${TDN}">${szt(p.stan)}</td>`
      + `<td style="${TDN}color:${p.dni < 7 ? '#c62828' : '#a15c00'};font-weight:600">${p.stan > 0 ? `~${szt(p.dni)}&nbsp;dni` : 'brak'}</td></tr>`).join('') + '</table>'
    : '<div style="font-size:13px;color:#6b7280">Nic — wszystkie dobrze sprzedające się towary mają zapas na co najmniej 14 dni.</div>';
  const strata = r.strata.length ? `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr><th style="${TH}">Towar</th>`
    + `<th style="${TH}">Kanał</th><th style="${THN}">Szt.</th><th style="${THN}">Przychód</th><th style="${THN}">Zysk</th></tr>`
    + r.strata.map((x) => `<tr><td style="${TD}"><b style="font-family:Menlo,Consolas,monospace;font-size:12px">${esc(x.symbol || x.tw_id)}</b> <span style="font-size:12px;color:#333">${esc((x.nazwa || '').slice(0, 40))}</span></td>`
      + `<td style="${TD}">${esc(nazwy[x.kanal] || x.kanal)}</td><td style="${TDN}">${szt(x.szt)}</td><td style="${TDN}">${zl(x.netto)}</td>`
      + `<td style="${TDN}color:#c62828;font-weight:600">${zl(x.zysk)}</td></tr>`).join('') + '</table>'
    : '<div style="font-size:13px;color:#6b7280">Brak — żadne zamówienie z tego dnia nie wyszło poniżej zera.</div>';
  const tydzien = r.tydzien && r.t7 ? sekcja(`Tydzień ${zakresTxt(r.t7.okresy.cur)}`, kafle(r.t7), `vs ${zakresTxt(r.t7.okresy.prev)} · wg daty zamówienia`)
    + sekcja('Kanały w tygodniu', tabelaKanalow(r.t7, nazwy)) : '';
  const m = r.mtd;
  const godz = new Date(r.wygenerowano).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Warsaw' });
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(tematRaportu(r))}</title></head>
<body style="margin:0;padding:0;background:#f2f2f2;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f2f2f2"><tr><td align="center" style="padding:12px 6px">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border-radius:10px;border-collapse:separate">
<tr><td style="background:#1d3557;color:#ffffff;padding:14px 16px;border-radius:10px 10px 0 0">
  <div style="font-size:12px;opacity:.8">Raport sprzedaży${r.tydzien ? ' · dzień i tydzień' : ''}</div>
  <div style="font-size:20px;font-weight:700">${dzienTxt(r.dzien)}</div>
  <div style="font-size:12px;opacity:.8">internet (FS z K4) · rok temu = ${dzienTxt(z.okresy.prev[0])} (ten sam dzień tygodnia)</div>
</td></tr>
${unik.length ? `<tr><td style="padding:12px 16px 0"><div style="background:#fff4e5;border:1px solid #f3cf9a;color:#6b4500;border-radius:8px;padding:8px 10px;font-size:12px;line-height:1.45">${unik.map(esc).join('<br>')}</div></td></tr>` : ''}
${sekcja('Dzień — wg daty zamówienia', kafle(z), `Ostatnie 7 dni: ${zl(r.t7.sc.netto)} (${zmiana(r.t7.sc.netto, r.t7.sp.netto)} r/r). `
    + (f.sc.zam ? `Wg faktury: ${zl(f.sc.netto)} (${zmiana(f.sc.netto, f.sp.netto)} r/r), ${szt(f.sc.zam)} FS — tak liczy ERP Dashboard.`
      : 'Wg faktury: tego dnia nie wystawiono FS (weekend albo święto) — faktury dojdą w najbliższy dzień roboczy.')
    + (z.sc.zamowione ? ` ${szt(z.sc.zamowione)} zamówień jeszcze bez faktury.` : ''))}
${sekcja('Kanały', tabelaKanalow(z, nazwy), '„≈” = marża handlowa (kanał bez reguł w kalkulatorze). Sklep = paragony z MAG, poza sumą.')}
${sekcja(`Miesiąc do dziś (${zakresTxt(m.okresy.cur)})`, `<div style="font-size:13px">Przychód <b>${zl(m.sc.netto)}</b> (${zmiana(m.sc.netto, m.sp.netto)} r/r) · zysk <b>${zl(m.sc.zysk)}</b> (${zmiana(m.sc.zysk, m.sp.zysk)}) · marża <b>${pct(marza(m.sc))}</b> · ${szt(m.sc.zam)} zam.</div>`)}
${tydzien}
${sekcja('Top 10 produktów dnia (wg zysku)', `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${top}</table>`)}
${sekcja('Kończy się zapas', konczy, `Sprzedaje się (≥ ${KONCZY_MIN_SZT30} szt. w 30 dni), a stanu dostępnego (Razem − rezerwacje, zestaw — ze składników) zostało na mniej niż ${KONCZY_DNI} dni.`)}
${sekcja('Sprzedaż ze stratą', strata, 'Zamówienia z tego dnia z zyskiem po kosztach kanału poniżej zera (koszt = rzeczywisty rozchód dostaw z GT) — do sprawdzenia: ręczna cena albo za niska podłoga.')}
<tr><td style="padding:18px 16px 16px;font-size:11px;color:#6b7280;line-height:1.5;border-top:1px solid #eef0f2">
  Zysk po kosztach kanału = kalkulator repricera liczony na całe zamówienie (wysyłka raz na paczkę, kurs z faktury). Przychód = cała faktura netto (towary + wysyłka klienta).
  Wygenerowano ${godz} z bazy modułu analiz WMS. Pełny widok: <a href="${ADRES_TELEFON}" style="color:#1d4ed8">${ADRES_TELEFON}</a> (Tailscale).
</td></tr>
</table></td></tr></table></body></html>`;
}

module.exports = { zbierzRaport, htmlRaportu, tematRaportu, konczySie, strata, KONCZY_DNI, KONCZY_MIN_SZT30 };
