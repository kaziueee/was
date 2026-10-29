'use strict';

// Wczytanie sprzedaży z GT do db/sprzedaz.db — moduł analiz sprzedaży (docs/analiza-sprzedazy.md).
// Tylko SELECT-y do GT; pisze wyłącznie do własnej bazy. Czystą logikę trzymają services/analiza-kanal.js,
// services/analiza-model.js i config/rynki.js (wycenaZamowienia) — tu jest zbieranie i zapis.
//
// Zamówienie = ZK; FS bez ZK (0,3%) to zamówienie samo w sobie; paragon (PA, tylko z MAG) to kanał „Sklep”.
// ZK bez FS (dzisiejsze, wczorajsze) ma status „zamówione” i liczby z ZK — po wystawieniu FS ten sam wiersz
// dostaje liczby z faktury. ZK, które przez ZK_BEZ_FS_DNI nie dostało FS, przestaje być sprzedażą: 99,98% FS powstaje
// do 7 dni od ZK (pomiar 2026-10-21 na 290 tys. par), a starsze ZK bez FS to rezerwacje wewnętrzne („poszukiwacze”:
// „PLUSY INWENTURA 2026” 43,9 tys. zł, „ostoy wielki koncert” 81 tys. zł) i zdublowane importy z 24.11.2025. Koszt zakupu pozycji FS i PA = rzeczywisty rozchód dostaw z GT (POZ niżej),
// więc ponowne wczytanie daje ten sam koszt. ZK bez FS nie ma rozchodu — koszt z wycenaHurtem (średnia dostaw na stanie)
// zostaje z pierwszego wczytania, dopóki FS go nie zastąpi.

const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { query } = require('./gt-sql');
const { wycenaHurtem } = require('./cennik');
const rynki = require('../config/rynki');
const { KOLUMNY } = require('../pricing/kolumny');
const { MAGAZYN_GT_ID, MAGAZYNY_RAZEM } = require('../config/magazyny');
const { kanalDokumentu } = require('./analiza-kanal');
const { doZlozeniaMapa } = require('./gt-zestawy');
const am = require('./analiza-model');
const { db, meta } = require('../db/sprzedaz');
const { dzisLokalnie } = require('./sprzedaz-model');
const { doplatyOd } = require('./analiza-doplaty');

const ZK_BEZ_FS_DNI = 14;
const granicaZk = () => am.dodajDni(dzisLokalnie(), -ZK_BEZ_FS_DNI);

const KOL = Object.fromEntries(KOLUMNY.map((k) => [k.klucz, k]));
const WALUTA_KOLUMNY = { '€': 'EUR', 'zł': 'PLN', RON: 'RON', Ft: 'HUF' };
const TOWAR = (rodzaj) => rodzaj === 1 || rodzaj === 8;

// --- zapytania do GT ---------------------------------------------------------------------------------------
const KRAJ = `OUTER APPLY (SELECT TOP 1 pa.pa_Nazwa kraj FROM adr__Ewid a JOIN sl_Panstwo pa ON pa.pa_Id = a.adr_IdPanstwo
  WHERE a.adr_IdObiektu = d.dok_PlatnikId AND a.adr_TypAdresu = 1) kr`;
// dokument d (FS / KFS-pierwotna) + jego ZK
const POLA_FS = `d.dok_Id fs_id, d.dok_NrPelny numer, CONVERT(char(10), d.dok_DataWyst, 23) data_fs, d.dok_Waluta waluta,
  d.dok_WalutaKurs kurs, LTRIM(RTRIM(ISNULL(z2.pwd_Tekst04, ''))) zrodlo_fs, ISNULL(kf.kat_Nazwa, '') kat_fs,
  LEFT(ISNULL(d.dok_Uwagi, ''), 200) uwagi, ISNULL(kr.kraj, '') kraj,
  zk.dok_Id zk_id, CONVERT(char(10), zk.dok_DataWyst, 23) data_zk, LTRIM(RTRIM(ISNULL(z8.pwd_Tekst01, ''))) zrodlo_zk,
  ISNULL(kz.kat_Nazwa, '') kat_zk, z8.pwd_Tekst05 uuid, LEFT(ISNULL(zk.dok_Uwagi, ''), 200) uwagi_zk,
  ISNULL(zk.dok_NrPelnyOryg, '') oryg_zk`;
const ZLACZ_FS = `LEFT JOIN dok__Dokument zk ON zk.dok_Id = d.dok_DoDokId AND zk.dok_Typ = 16
  LEFT JOIN pw_Dane z2 ON z2.pwd_IdObiektu = d.dok_Id AND z2.pwd_TypObiektu = -2
  LEFT JOIN pw_Dane z8 ON z8.pwd_IdObiektu = zk.dok_Id AND z8.pwd_TypObiektu = -8
  LEFT JOIN sl_Kategoria kf ON kf.kat_Id = d.dok_KatId
  LEFT JOIN sl_Kategoria kz ON kz.kat_Id = zk.dok_KatId
  ${KRAJ}`;
const FS_W_OKNIE = `d.dok_Typ = 2 AND d.dok_Status = 1 AND d.dok_MagId = @mag AND d.dok_DataWyst >= @od AND d.dok_DataWyst < @do`;
const ZK_BEZ_FS = `d.dok_Typ = 16 AND d.dok_MagId = @mag AND d.dok_DataWyst >= @odZk AND d.dok_DataWyst < @do
  AND NOT EXISTS (SELECT 1 FROM dok__Dokument x WHERE x.dok_DoDokId = d.dok_Id AND x.dok_Typ = 2)`;
const PA_W_OKNIE = `d.dok_Typ = 21 AND d.dok_Status = 1 AND d.dok_DataWyst >= @od AND d.dok_DataWyst < @do`;
// Koszt pozycji = rzeczywisty koszt rozchodu z GT: dostawy, z których zeszła ta sprzedaż (dok_MagRuch po mr_PozId,
// wiersze rozchodu mają mr_MagId NULL), cena = ostatnia wycena serii (dok_MagWart, po korekcie FZ). Pomiar 2026-10-21:
// 2000 z 2000 pozycji FS ma rozchód w ilości równej sprzedanej; zestaw schodzi jako zmontowany, z wartością z
// kompletacji (NERCHIELIT300: 11,10 = 30 × 0,37 składnika). ZK bez FS jeszcze nie ma rozchodu — tam koszt z
// wycenaHurtem (średnia dostaw na stanie). Koszt: +0,3 s na największy miesiąc (XII 2025, 89 tys. pozycji).
const POZ = (warunek) => `SELECT p.ob_DokHanId dok_id, p.ob_TowId tw_id, ISNULL(t.tw_Rodzaj, 0) rodzaj, p.ob_Ilosc szt,
    p.ob_WartNetto netto, p.ob_CenaWaluta cena, p.ob_Znak znak, kz.wart koszt_wart, kz.ilosc koszt_szt
  FROM dok_Pozycja p JOIN dok__Dokument d ON d.dok_Id = p.ob_DokHanId LEFT JOIN tw__Towar t ON t.tw_Id = p.ob_TowId
  OUTER APPLY (SELECT SUM(m.mr_Ilosc * ISNULL(w.mw_Cena, m.mr_Cena)) wart, SUM(m.mr_Ilosc) ilosc FROM dok_MagRuch m
    OUTER APPLY (SELECT TOP 1 mw.mw_Cena FROM dok_MagWart mw WHERE mw.mw_SeriaId = m.mr_SeriaId ORDER BY mw.mw_Data DESC) w
    WHERE m.mr_PozId = p.ob_Id AND m.mr_MagId IS NULL) kz
  WHERE ${warunek}`;

async function pobierzOkno(od, doDnia) {
  const g = granicaZk();
  const par = { od, odZk: od > g ? od : g, do: doDnia, mag: MAGAZYN_GT_ID.K4 };
  const [fs, fsPoz, zk, zkPoz, pa, paPoz, kfs] = await Promise.all([
    query(`SELECT ${POLA_FS} FROM dok__Dokument d ${ZLACZ_FS} WHERE ${FS_W_OKNIE}`, par),
    query(POZ(FS_W_OKNIE), par),
    query(`SELECT d.dok_Id zk_id, d.dok_NrPelny numer, CONVERT(char(10), d.dok_DataWyst, 23) data_zk, d.dok_Waluta waluta,
        d.dok_WalutaKurs kurs, LTRIM(RTRIM(ISNULL(z8.pwd_Tekst01, ''))) zrodlo_zk, ISNULL(kz.kat_Nazwa, '') kat_zk,
        z8.pwd_Tekst05 uuid, LEFT(ISNULL(d.dok_Uwagi, ''), 200) uwagi, ISNULL(kr.kraj, '') kraj, ISNULL(d.dok_NrPelnyOryg, '') oryg_zk
      FROM dok__Dokument d LEFT JOIN pw_Dane z8 ON z8.pwd_IdObiektu = d.dok_Id AND z8.pwd_TypObiektu = -8
      LEFT JOIN sl_Kategoria kz ON kz.kat_Id = d.dok_KatId ${KRAJ} WHERE ${ZK_BEZ_FS}`, par),
    query(POZ(ZK_BEZ_FS), par),
    query(`SELECT d.dok_Id pa_id, d.dok_NrPelny numer, CONVERT(char(10), d.dok_DataWyst, 23) data_fs FROM dok__Dokument d WHERE ${PA_W_OKNIE}`, par),
    query(POZ(PA_W_OKNIE), par),
    query(`SELECT k.dok_Id kfs_id, k.dok_NrPelny kfs_numer, CONVERT(char(10), k.dok_DataWyst, 23) data_kfs, p.ob_TowId tw_id,
        ISNULL(t.tw_Rodzaj, 0) rodzaj, p.ob_Ilosc szt, p.ob_WartNetto netto, p.ob_Znak znak, ${POLA_FS}
      FROM dok__Dokument k JOIN dok_Pozycja p ON p.ob_DokHanId = k.dok_Id LEFT JOIN tw__Towar t ON t.tw_Id = p.ob_TowId
      LEFT JOIN dok__Dokument d ON d.dok_Id = k.dok_DoDokId ${ZLACZ_FS}
      WHERE k.dok_Typ = 6 AND k.dok_Status = 1 AND k.dok_MagId = @mag AND k.dok_DataWyst >= @od AND k.dok_DataWyst < @do`, par),
  ]);
  return { fs: fs.recordset, fsPoz: fsPoz.recordset, zk: zk.recordset, zkPoz: zkPoz.recordset,
    pa: pa.recordset, paPoz: paPoz.recordset, kfs: kfs.recordset };
}

async function skladZestawow(ids) {
  const wynik = new Map();
  const idy = [...new Set(ids.map(Number))].filter(Number.isInteger);
  for (let i = 0; i < idy.length; i += 1000) {
    // idy to liczby całkowite (filtr wyżej) — bezpieczne w IN
    const r = await query(`SELECT kpl_IdKomplet zestaw, kpl_IdSkladnik tw, kpl_Liczba liczba FROM tw_Komplet
      WHERE kpl_IdKomplet IN (${idy.slice(i, i + 1000).join(',')})`);
    for (const x of r.recordset) (wynik.get(x.zestaw) || wynik.set(x.zestaw, []).get(x.zestaw)).push({ tw: x.tw, liczba: Number(x.liczba) || 0 });
  }
  return wynik;
}

// --- składanie zamówień -------------------------------------------------------------------------------------
// Definicja rynku kalkulatora dla kanału (jak pricing/pas.js: kolumna → RYNKI po nazwie + rynekNadpisz).
function rynekKanalu(kanal) {
  const kol = KOL[kanal === 'ALLEGRO' ? 'ALLEGRO_EKAJTEK' : kanal];
  const def = kol && kol.kalkulator && rynki.RYNKI.find((r) => r.nazwa === kol.kalkulator);
  if (!def) return null;
  return { def: kol.rynekNadpisz ? { ...def, ...kol.rynekNadpisz } : def, waluta: WALUTA_KOLUMNY[kol.waluta] };
}

// Zysk zamówienia: po kosztach kanału z kalkulatora (wycenaZamowienia), a dla kanałów bez reguł — marża handlowa.
// Paczka = największy towar zamówienia (jak w analizie kartonów, decyzja usera 2026-09-23). Kurs = kurs dokumentu.
// doplata — dopłata Allegro do ceny, brutto PLN (services/analiza-doplaty.js); tylko Allegro PL z kalkulatorem.
function policzZysk(z, poz, wyceny, doplata = 0) {
  const handlowa = () => {
    for (const p of poz) p.zysk = p.netto - p.szt * (p.koszt || 0);
    return { zysk: poz.reduce((s, p) => s + p.zysk, 0), zrodlo: 'handlowa' };
  };
  const rk = rynekKanalu(z.kanal);
  if (!rk || !poz.length) return handlowa();
  const allegroZagranica = rk.def.typ === 'allegro' && z.waluta !== 'PLN';
  // eMAG BG do końca 2025 sprzedawał w BGN (od 01.01.2026 w EUR): lew jest sztywno związany z euro (1,95583),
  // więc przeliczamy do waluty kalkulatora zamiast spadać do marży handlowej.
  const bgn = z.waluta === 'BGN' && rk.waluta === 'EUR' ? 1.95583 : 1;
  if (!allegroZagranica && rk.waluta !== (bgn !== 1 ? 'EUR' : z.waluta)) return handlowa();
  const najw = poz.reduce((a, p) => ((wyceny.get(p.tw_id)?.waga || 0) > (wyceny.get(a.tw_id)?.waga || 0) ? p : a), poz[0]);
  const w = wyceny.get(najw.tw_id) || {};
  const g = { ...rynki.DOMYSLNE, waga: w.waga || rynki.DOMYSLNE.waga, paczka: w.paczka || null, genius: w.genius ?? null,
    docinanie: !!w.docinalny, docinanieOn: true };
  if (z.waluta === 'EUR' || bgn !== 1) g.eur = z.kurs * bgn; else if (z.waluta === 'RON') g.ron = z.kurs; else if (z.waluta === 'HUF') g.huf = z.kurs;
  // Allegro CZ/SK/HU: reguły Allegro PL przy cenie brutto w zł (netto × 1,23) — kosztów rynków zagranicznych Allegro
  // per zamówienie nie zna nikt (Rozliczenia: billing API tylko allegro-pl), więc oznaczamy źródło osobno.
  const wejscie = poz.map((p) => ({ koszt: p.koszt || 0, szt: p.szt,
    cena: allegroZagranica ? p.netto / p.szt * 1.23 : p.cena / bgn }));
  const D = rk.def.typ === 'allegro' && !allegroZagranica ? Math.max(0, Number(doplata) || 0) : 0;
  const r = rynki.wycenaZamowienia(rk.def, g, { pozycje: wejscie, wysylkaKlienta: allegroZagranica ? null : z.wysylka_klienta / bgn, doplata: D });
  if (r.blad) return handlowa();
  r.pozycje.forEach((x, i) => { poz[i].zysk = x.zysk; });
  return { zysk: r.zysk, zrodlo: allegroZagranica ? 'kalkulator_pl' : 'kalkulator', doplataNetto: D / (1 + (Number(rk.def.vat) || 0) / 100) };
}

function pozycjeDokumentu(lista) {
  const m = new Map();
  for (const p of lista) (m.get(p.dok_id) || m.set(p.dok_id, []).get(p.dok_id)).push(p);
  return m;
}

// Z surowych wierszy GT → { zamowienia, pozycje, skladniki, zwroty } gotowe do zapisu.
// koszty — Map 'zamId|tw_id' → koszt zapisany przy pierwszym wczytaniu (dla ZK bez rozchodu).
// doplaty — Map UUID płatności → dopłata Allegro brutto PLN (services/analiza-doplaty.js).
function zlozZamowienia(surowe, wyceny, sklady, koszty, doplaty = new Map()) {
  const zamowienia = [], pozycje = [], skladniki = [], zwroty = [];
  const dodaj = (z, wiersze, kanal, uuid = null) => {
    const poz = [];
    let wysylka = 0, wysylkaNetto = 0;
    for (const p of wiersze) {
      if (!TOWAR(p.rodzaj) || !p.tw_id) { wysylka += (Number(p.cena) || 0) * (Number(p.szt) || 0); wysylkaNetto += Number(p.netto) || 0; continue; }
      const szt = Number(p.szt) || 0;
      if (szt <= 0) continue;
      // koszt: rozchód z GT (FS, PA) → zapisany przy pierwszym wczytaniu (ZK) → dzisiejsza wycena (średnia dostaw)
      const rozchod = Number(p.koszt_szt) > 0 ? Number(p.koszt_wart) / Number(p.koszt_szt) : null;
      const zapisany = koszty.get(`${z.id}|${p.tw_id}`);
      poz.push({ zam_id: z.id, tw_id: p.tw_id, rodzaj: p.rodzaj, szt, netto: Number(p.netto) || 0, cena_wal: Number(p.cena) || 0,
        cena: Number(p.cena) || 0, koszt: rozchod ?? zapisany ?? wyceny.get(p.tw_id)?.koszt ?? null, zysk: null });
    }
    z.kanal = kanal.kanal; z.rynek = kanal.rynek; z.kanal_regula = kanal.regula;
    z.szt = poz.reduce((s, p) => s + p.szt, 0);
    z.netto = poz.reduce((s, p) => s + p.netto, 0);
    z.wysylka_klienta = wysylka;
    // przychód = cała faktura (towary + wysyłka klienta), jak FS i ERP Dashboard (decyzja usera 2026-10-20);
    // wysyłkę rozkładamy na pozycje wg wartości, żeby suma produktów = suma kanałów
    z.wysylka_netto = wysylkaNetto;
    for (const p of poz) p.wysylka = z.netto > 0 ? wysylkaNetto * p.netto / z.netto : 0;
    const zy = z.status === 'paragon' ? (() => { for (const p of poz) p.zysk = p.netto - p.szt * (p.koszt || 0); return { zysk: poz.reduce((s, p) => s + p.zysk, 0), zrodlo: 'handlowa' }; })()
      : policzZysk(z, poz, wyceny, kanal.kanal.startsWith('ALLEGRO') && uuid ? doplaty.get(uuid) : 0);
    // dopłata Allegro = przychód poza fakturą; na pozycje wg wartości (jak wysyłka), żeby suma produktów = suma kanałów
    z.doplata_netto = zy.doplataNetto > 0 ? zy.doplataNetto : null;
    for (const p of poz) p.doplata = z.doplata_netto && z.netto > 0 ? z.doplata_netto * p.netto / z.netto : null;
    z.zysk = zy.zysk; z.zysk_zrodlo = poz.some((p) => !(p.koszt > 0)) ? zy.zrodlo + '_bez_kosztu' : zy.zrodlo;
    zamowienia.push(z);
    for (const p of poz) {
      pozycje.push(p);
      if (p.rodzaj === 8) for (const s of sklady.get(p.tw_id) || []) skladniki.push({ zam_id: z.id, zestaw_id: p.tw_id, tw_id: s.tw, szt: p.szt * s.liczba });
    }
  };

  const fsPoz = pozycjeDokumentu(surowe.fsPoz);
  for (const d of surowe.fs) {
    const kanal = kanalDokumentu(d);
    const kurs = am.kursDokumentu(d.waluta, d.kurs);
    const data = am.dataZamowienia({ uuid: kanal.kanal.startsWith('ALLEGRO') ? d.uuid : null, dataZk: d.data_zk, dataFs: d.data_fs });
    dodaj({ id: d.zk_id ? `Z${d.zk_id}` : `F${d.fs_id}`, zk_id: d.zk_id || null, fs_id: d.fs_id, numer: d.numer, status: 'zafakturowane',
      data_zam: data.dzien, godz_zam: data.godz, data_zam_zrodlo: data.zrodlo, data_zk: d.data_zk || null, data_fs: d.data_fs,
      waluta: d.waluta, kurs }, fsPoz.get(d.fs_id) || [], kanal, uuidDokumentu(d));
  }
  const zkPoz = pozycjeDokumentu(surowe.zkPoz);
  for (const d of surowe.zk) {
    const kanal = kanalDokumentu({ zrodlo_zk: d.zrodlo_zk, kat_zk: d.kat_zk, kraj: d.kraj, waluta: d.waluta, uwagi: d.uwagi,
      oryg_zk: d.oryg_zk, konto_allegro: d.konto_allegro });
    const data = am.dataZamowienia({ uuid: kanal.kanal.startsWith('ALLEGRO') ? d.uuid : null, dataZk: d.data_zk });
    dodaj({ id: `Z${d.zk_id}`, zk_id: d.zk_id, fs_id: null, numer: d.numer, status: 'zamowione', data_zam: data.dzien, godz_zam: data.godz,
      data_zam_zrodlo: data.zrodlo, data_zk: d.data_zk, data_fs: null, waluta: d.waluta, kurs: am.kursDokumentu(d.waluta, d.kurs) },
    zkPoz.get(d.zk_id) || [], kanal, uuidDokumentu(d));
  }
  const paPoz = pozycjeDokumentu(surowe.paPoz);
  for (const d of surowe.pa) {
    dodaj({ id: `P${d.pa_id}`, zk_id: null, fs_id: null, numer: d.numer, status: 'paragon', data_zam: d.data_fs, godz_zam: null,
      data_zam_zrodlo: 'fs', data_zk: null, data_fs: d.data_fs, waluta: 'PLN', kurs: 1 }, paPoz.get(d.pa_id) || [],
    { kanal: 'SKLEP', rynek: 'PL', regula: 'paragon' });
  }
  for (const x of surowe.kfs) {
    const zw = am.zwrotZPozycji(x);
    if (!zw.szt && !zw.netto) continue;
    zwroty.push({ kfs_id: x.kfs_id, fs_id: x.fs_id || null, numer: x.kfs_numer, data: x.data_kfs,
      kanal: x.fs_id ? kanalDokumentu(x).kanal : 'INNE', tw_id: TOWAR(x.rodzaj) ? x.tw_id : null, szt: TOWAR(x.rodzaj) ? zw.szt : 0, netto: zw.netto });
  }
  return { zamowienia, pozycje, skladniki, zwroty };
}

// Konto Allegro z projektu Rozliczenia — dla FS Allegro bez „Źródła” (kategoria ZK „Internet”, konto GT „Szef”,
// XI.2025–VII.2026: 1963 FS). allegro_konto mapuje UUID zamówienia na konto; sprawdzone 2026-10-21 na 2202 FS ze
// znanym kontem: 100% zgodnie, rozstrzyga 1918 z 1963. Tylko odczyt, lokalnie na SRV (WAL — nigdy przez udział
// sieciowy); bez pliku (Mac) albo przy błędzie reguła się po prostu nie włącza.
const ROZLICZENIA_DB = process.env.ROZLICZENIA_DB || 'C:\\Rozliczenia\\data\\rozliczenia.db';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const uuidDokumentu = (d) => ((String(d.uuid || '').match(UUID) || String(d.uwagi_zk || '').match(UUID)
  || String(d.uwagi || '').match(UUID) || [])[0] || '').toLowerCase() || null;

function dopiszKontaAllegro(dokumenty) {
  const bez = dokumenty.filter((d) => kanalDokumentu(d).kanal === 'ALLEGRO' && uuidDokumentu(d));
  if (!bez.length || !fs.existsSync(ROZLICZENIA_DB)) return 0;
  let r = null;
  try {
    r = new DatabaseSync(ROZLICZENIA_DB, { readOnly: true });
    const st = r.prepare('SELECT konto FROM allegro_konto WHERE identyfikator = ?');
    let n = 0;
    for (const d of bez) { const k = st.get(uuidDokumentu(d))?.konto; if (k) { d.konto_allegro = k; n++; } }
    return n;
  } catch (e) {
    console.warn(`[analiza] konto Allegro z Rozliczeń niedostępne: ${e.message}`);
    return 0;
  } finally { r?.close(); }
}

// --- zapis --------------------------------------------------------------------------------------------------
function kosztyZapisane(ids) {
  const m = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const czesc = ids.slice(i, i + 500);
    const r = db.prepare(`SELECT zam_id, tw_id, koszt FROM pozycje WHERE koszt IS NOT NULL AND zam_id IN (${czesc.map(() => '?').join(',')})`).all(...czesc);
    for (const x of r) m.set(`${x.zam_id}|${x.tw_id}`, x.koszt);
  }
  return m;
}

const KOLUMNY_ZAM = ['id', 'zk_id', 'fs_id', 'numer', 'status', 'data_zam', 'godz_zam', 'data_zam_zrodlo', 'data_zk', 'data_fs',
  'kanal', 'rynek', 'kanal_regula', 'waluta', 'kurs', 'szt', 'netto', 'wysylka_netto', 'wysylka_klienta', 'zysk', 'zysk_zrodlo', 'doplata_netto'];

// Zapis jednego okna: zamówienia z okna zastępują swoje stare wersje; ZK „zamówione” z okna, których GT już nie
// zwraca (dostały FS z datą spoza okna albo zniknęły), są kasowane, żeby nie liczyły się podwójnie.
function zapisz({ zamowienia, pozycje, skladniki, zwroty }, { od, doDnia }) {
  // pierwszy — kiedy job pierwszy raz zobaczył zamówienie (telefon „Live”: godzina wpływu dla kanałów bez UUID).
  // Wiersz już znany zachowuje swoją wartość, także NULL sprzed kolumny (nie udajemy, że wpłynął w chwili wdrożenia).
  const insZam = db.prepare(`INSERT OR REPLACE INTO zamowienia (${KOLUMNY_ZAM.join(',')}, wczytano, pierwszy)
    VALUES (${KOLUMNY_ZAM.map(() => '?').join(',')}, CURRENT_TIMESTAMP,
      CASE WHEN EXISTS (SELECT 1 FROM zamowienia WHERE id = ?) THEN (SELECT pierwszy FROM zamowienia WHERE id = ?) ELSE CURRENT_TIMESTAMP END)`);
  const insPoz = db.prepare('INSERT INTO pozycje (zam_id, tw_id, rodzaj, szt, netto, wysylka, cena_wal, koszt, zysk, doplata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insSkl = db.prepare('INSERT INTO skladniki (zam_id, zestaw_id, tw_id, szt) VALUES (?, ?, ?, ?)');
  const insZw = db.prepare('INSERT INTO zwroty (kfs_id, fs_id, numer, data, kanal, tw_id, szt, netto) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const delPoz = db.prepare('DELETE FROM pozycje WHERE zam_id = ?');
  const delSkl = db.prepare('DELETE FROM skladniki WHERE zam_id = ?');
  const delZam = db.prepare('DELETE FROM zamowienia WHERE id = ?');
  const nowe = new Set(zamowienia.map((z) => z.id));
  db.exec('BEGIN');
  try {
    // ZK bez FS: z okna, których już nie ma w GT (anulowane, scalone), i wszystkie starsze niż ZK_BEZ_FS_DNI
    const stare = db.prepare("SELECT id FROM zamowienia WHERE status = 'zamowione' AND ((data_zk >= ? AND data_zk < ?) OR data_zk < ?)").all(od, doDnia, granicaZk());
    for (const { id } of stare) if (!nowe.has(id)) { delPoz.run(id); delSkl.run(id); delZam.run(id); }
    for (const z of zamowienia) { delPoz.run(z.id); delSkl.run(z.id); insZam.run(...KOLUMNY_ZAM.map((k) => z[k] ?? null), z.id, z.id); }
    for (const p of pozycje) insPoz.run(p.zam_id, p.tw_id, p.rodzaj, p.szt, p.netto, p.wysylka ?? 0, p.cena_wal, p.koszt, p.zysk, p.doplata ?? null);
    for (const s of skladniki) insSkl.run(s.zam_id, s.zestaw_id, s.tw_id, s.szt);
    db.prepare('DELETE FROM zwroty WHERE data >= ? AND data < ?').run(od, doDnia);
    for (const w of zwroty) insZw.run(w.kfs_id, w.fs_id, w.numer, w.data, w.kanal, w.tw_id, w.szt, w.netto);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Wczytaj okno [od, doDnia) — FS po dacie FS, ZK bez FS po dacie ZK, PA i KFS po swojej dacie.
// zapiszDoBazy=false → tylko policz i zwróć (dry-run skryptu historii).
async function wczytajOkno(od, doDnia, { zapiszDoBazy = true } = {}) {
  const surowe = await pobierzOkno(od, doDnia);
  dopiszKontaAllegro([...surowe.fs, ...surowe.zk, ...surowe.kfs.filter((x) => x.fs_id)]);
  const twIds = [...new Set([...surowe.fsPoz, ...surowe.zkPoz, ...surowe.paPoz].filter((p) => TOWAR(p.rodzaj) && p.tw_id).map((p) => p.tw_id))];
  const zestawy = [...new Set([...surowe.fsPoz, ...surowe.zkPoz, ...surowe.paPoz].filter((p) => p.rodzaj === 8).map((p) => p.tw_id))];
  const [wyceny, sklady] = await Promise.all([wycenaHurtem(twIds), skladZestawow(zestawy)]);
  const ids = [...surowe.fs.map((d) => (d.zk_id ? `Z${d.zk_id}` : `F${d.fs_id}`)), ...surowe.zk.map((d) => `Z${d.zk_id}`), ...surowe.pa.map((d) => `P${d.pa_id}`)];
  // dopłaty Allegro: wpis billingu powstaje przy zakupie, a ZK bywa do ZK_BEZ_FS_DNI starsze niż FS z okna — zapas 30 dni
  const wynik = zlozZamowienia(surowe, wyceny, sklady, kosztyZapisane(ids), doplatyOd(am.dodajDni(od, -30)));
  if (zapiszDoBazy) zapisz(wynik, { od, doDnia });
  return wynik;
}

// --- kartoteka i stany ---------------------------------------------------------------------------------------
// Kartoteka towarów. Datę pierwszego przyjęcia (MIN po PZ/PW — najdroższa część) liczymy tylko dla towarów, które jej
// jeszcze nie mają: raz ustalona się nie zmienia.
async function odswiezTowary(twIds) {
  const idy = [...new Set(twIds.map(Number))].filter(Number.isInteger);
  const znane = new Map(db.prepare('SELECT tw_id, pierwsze_przyjecie FROM towary WHERE pierwsze_przyjecie IS NOT NULL').all().map((x) => [x.tw_id, x.pierwsze_przyjecie]));
  const ins = db.prepare(`INSERT INTO towary (tw_id, symbol, nazwa, grupa, rodzaj, pierwsze_przyjecie, odswiezono) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(tw_id) DO UPDATE SET symbol = excluded.symbol, nazwa = excluded.nazwa, grupa = excluded.grupa, rodzaj = excluded.rodzaj,
      pierwsze_przyjecie = excluded.pierwsze_przyjecie, odswiezono = excluded.odswiezono`);
  for (let i = 0; i < idy.length; i += 1000) {
    const lista = idy.slice(i, i + 1000).join(',');   // liczby całkowite — bezpieczne w IN
    const bezDaty = idy.slice(i, i + 1000).filter((id) => !znane.has(id));
    const r = await query(`SELECT t.tw_Id tw_id, t.tw_Symbol symbol, t.tw_Nazwa nazwa, ISNULL(g.grt_Nazwa, '') grupa, t.tw_Rodzaj rodzaj,
        ${bezDaty.length ? `CASE WHEN t.tw_Id IN (${bezDaty.join(',')}) THEN (SELECT CONVERT(char(10), MIN(m.dok_DataWyst), 23) FROM dok_Pozycja p
          JOIN dok__Dokument m ON m.dok_Id = p.ob_DokMagId WHERE p.ob_TowId = t.tw_Id AND m.dok_Typ IN (10, 12) AND m.dok_Status = 1) END` : 'NULL'} pierwsze
      FROM tw__Towar t LEFT JOIN sl_GrupaTw g ON g.grt_Id = t.tw_IdGrupa WHERE t.tw_Id IN (${lista})`);
    db.exec('BEGIN');
    try { for (const x of r.recordset) ins.run(x.tw_id, x.symbol, x.nazwa, x.grupa, x.rodzaj, x.pierwsze ?? znane.get(x.tw_id) ?? null); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return idy.length;
}

// Zdjęcie stanów z dnia `dzien`: towary ze stanem na K4/K4G/MAG/LS (albo podane `twIds`). Razem = MAGAZYNY_RAZEM.
// Zdjęcie stanów na dziś. Na ekranach liczy się stan DOSTĘPNY = Razem (K4+K4G+MAG+LS) − rezerwacje na tych
// magazynach, a dla zestawu — ile kompletów da się złożyć ze składników, tym samym wzorem co repricer i Sellasist
// (gt-zestawy.doZlozeniaMapa; decyzje usera 2026-10-21). Stan zmontowanego zestawu (zwykle 0) nic nie mówi.
// twIds = null → wszystkie towary ze stanem + zestawy sprzedane w roku (stan 0, ale składniki na półce).
async function zdjecieStanow(dzien, twIds = null) {
  const kody = { K4: 'k4', K4G: 'k4g', MAG: 'mag', LS: 'ls' };
  const mag = Object.fromEntries(Object.entries(kody).map(([k, v]) => [MAGAZYN_GT_ID[k], v]));
  const magi = Object.keys(mag).join(',');
  const lista = (ids) => [...new Set(ids.map(Number))].filter(Number.isInteger);
  const filtr = twIds ? `s.st_TowId IN (${lista(twIds).join(',') || 0})`
    : `s.st_TowId IN (SELECT st_TowId FROM tw_Stan WHERE st_MagId IN (${magi}) AND st_Stan > 0)`;
  const r = await query(`SELECT s.st_TowId tw, s.st_MagId mag, s.st_Stan stan, s.st_StanRez rez FROM tw_Stan s
    WHERE s.st_MagId IN (${magi}) AND ${filtr}`);
  const pusty = () => ({ k4: 0, k4g: 0, mag: 0, ls: 0, rez_k4: 0, rez: 0 });
  const m = new Map();
  for (const x of r.recordset) {
    const w = m.get(x.tw) || m.set(x.tw, pusty()).get(x.tw);
    w[mag[x.mag]] = Number(x.stan) || 0;
    w.rez += Number(x.rez) || 0;
    if (mag[x.mag] === 'k4') w.rez_k4 = Number(x.rez) || 0;
  }
  const kandydaci = twIds ? lista(twIds)
    : db.prepare('SELECT t.tw_id FROM towary t JOIN tempa p ON p.tw_id = t.tw_id WHERE t.rodzaj = 8 AND p.szt365 > 0').all().map((x) => x.tw_id);
  const zestawy = await doZlozeniaMapa(kandydaci);          // wpis tylko dla zestawów; null = skład nieokreślony w GT
  for (const id of zestawy.keys()) if (!m.has(id)) m.set(id, pusty());
  const ins = db.prepare(`INSERT INTO stany (tw_id, dzien, k4, k4g, mag, ls, rez_k4, razem, rez, dostepne, czas)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(tw_id, dzien) DO UPDATE SET k4 = excluded.k4, k4g = excluded.k4g, mag = excluded.mag, ls = excluded.ls,
      rez_k4 = excluded.rez_k4, razem = excluded.razem, rez = excluded.rez, dostepne = excluded.dostepne, czas = excluded.czas`);
  db.exec('BEGIN');
  try {
    for (const [tw, w] of m) {
      const razem = MAGAZYNY_RAZEM.reduce((s, k) => s + (w[kody[k]] || 0), 0);
      const zestaw = zestawy.get(tw);
      const dostepne = zestaw != null ? zestaw : Math.max(0, razem - w.rez);
      ins.run(tw, dzien, w.k4, w.k4g, w.mag, w.ls, w.rez_k4, razem, w.rez, dostepne);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return m.size;
}

// Dni bez stanu wstecz (Trendy: filtr „Zakończone w okresie” — produkt, którego nie było, gorzej się sprzedaje, więc
// nie należy do „Spadku trendu” ani „Zgasłych”; decyzja usera 2026-10-23). GT nie trzyma stanów wstecz, a własne
// zdjęcia stanów są od 2026-10-20 — odtwarzamy z dokumentów: stan na koniec dnia = st_Stan − ruchy po tym dniu
// (MM/PZ/WZ/PW/RW, magazyny Razem; metoda i test roczny w docs/analiza-sprzedazy.md „Stany wstecz”). Tylko towary
// sprzedawane w tym czasie i bez zestawów (zestaw nie ma własnego stanu — leżą składniki). Okno: 400 dni, tyle sięga
// „rok temu” dla okna 30 dni. Pomiar 2026-10-23 na OKITRADE: 173 tys. wierszy ruchów, 1,3 s GT + 0,7 s liczenia —
// raz na dobę, w wątku analiz. Zapis: przedziały [od, do], cała tabela na nowo; zasięg w meta 'bez_stanu' = „od|do”.
const BEZ_STANU_DNI = 400;
async function odtworzBezStanu(dzis) {
  const od = am.dodajDni(dzis, -BEZ_STANU_DNI), wczoraj = am.dodajDni(dzis, -1);
  const magi = MAGAZYNY_RAZEM.map((k) => MAGAZYN_GT_ID[k]).join(',');
  const towary = db.prepare(`SELECT DISTINCT p.tw_id FROM pozycje p JOIN zamowienia z ON z.id = p.zam_id LEFT JOIN towary t ON t.tw_id = p.tw_id
    WHERE z.data_zam >= ? AND (t.rodzaj IS NULL OR t.rodzaj <> 8)`).all(od).map((x) => x.tw_id);
  const r = await query(`
    WITH r AS (
      SELECT p.ob_TowId tw, m.dok_MagId mag, CONVERT(char(10), m.dok_DataWyst, 23) dzien,
             CASE WHEN m.dok_Typ IN (10, 12) THEN 1 ELSE -1 END * p.ob_Znak * p.ob_Ilosc il
        FROM dok_Pozycja p JOIN dok__Dokument m ON m.dok_Id = p.ob_DokMagId
       WHERE m.dok_Typ IN (10, 11, 12, 13) AND m.dok_Status = 1 AND m.dok_DataWyst >= @od
      UNION ALL
      SELECT p.ob_TowId, m.dok_MagId, CONVERT(char(10), m.dok_DataWyst, 23), -p.ob_Ilosc
        FROM dok_Pozycja p JOIN dok__Dokument m ON m.dok_Id = p.ob_DokMagId
       WHERE m.dok_Typ = 9 AND m.dok_Status = 1 AND m.dok_DataWyst >= @od
      UNION ALL
      SELECT p.ob_TowId, m.dok_OdbiorcaId, CONVERT(char(10), m.dok_DataWyst, 23), p.ob_Ilosc
        FROM dok_Pozycja p JOIN dok__Dokument m ON m.dok_Id = p.ob_DokMagId
       WHERE m.dok_Typ = 9 AND m.dok_Status = 1 AND m.dok_DataWyst >= @od
    )
    SELECT tw, dzien, SUM(il) il FROM r WHERE mag IN (${magi}) GROUP BY tw, dzien`, { od });
  const st = await query(`SELECT st_TowId tw, SUM(st_Stan) stan FROM tw_Stan WHERE st_MagId IN (${magi}) GROUP BY st_TowId`);
  const teraz = new Map(st.recordset.map((x) => [x.tw, Number(x.stan) || 0]));
  const ruchy = new Map();
  for (const x of r.recordset) (ruchy.get(x.tw) || ruchy.set(x.tw, new Map()).get(x.tw)).set(x.dzien, Number(x.il) || 0);
  const ins = db.prepare('INSERT INTO bez_stanu (tw_id, od, do) VALUES (?, ?, ?)');
  let przedzialow = 0;
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM bez_stanu');
    for (const tw of towary) {
      for (const [a, b] of am.przedzialyBezStanu({ stanTeraz: teraz.get(tw), ruchy: ruchy.get(tw) || new Map(), dzis, od })) { ins.run(tw, a, b); przedzialow++; }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  meta.set('bez_stanu', `${od}|${wczoraj}`);
  return { towarow: towary.length, przedzialow };
}

// Raz na dobę: gdy zasięg nie sięga wczoraj (pierwszy przebieg po północy, po wdrożeniu, po padnięciu GT).
async function bezStanuJesliTrzeba(dzis) {
  const zasieg = meta.get('bez_stanu')?.wartosc?.split('|')[1] || '';
  return zasieg >= am.dodajDni(dzis, -1) ? null : odtworzBezStanu(dzis);
}

// Tempo sprzedaży na towar (do dni zapasu i flag): FS z K4 (bez paragonów Sklepu — K4 obsługuje internet) plus
// zużycie składników w sprzedanych zestawach, bo to też schodzi z półki. Jedno zapytanie po indeksie dat FS
// zamiast liczenia przy każdym otwarciu ekranu (tam to było ~1 s na 360 towarów).
function przeliczTempa(dzis) {
  const od = (d) => am.dodajDni(dzis, -d);
  const czesc = (tab) => `SELECT x.tw_id, CASE WHEN z.data_fs > @d30 THEN x.szt ELSE 0 END a,
      CASE WHEN z.data_fs > @d180 THEN x.szt ELSE 0 END b, x.szt c
    FROM ${tab} x JOIN zamowienia z ON z.id = x.zam_id
    WHERE z.status = 'zafakturowane' AND z.data_fs > @d365 AND z.data_fs <= @dzis`;
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM tempa');
    db.prepare(`INSERT INTO tempa (tw_id, szt30, szt180, szt365, dzien)
      SELECT tw_id, SUM(a), SUM(b), SUM(c), @dzis FROM (${czesc('pozycje')} UNION ALL ${czesc('skladniki')}) GROUP BY tw_id`)
      .run({ d30: od(30), d180: od(180), d365: od(365), dzis });
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return db.prepare('SELECT COUNT(*) n FROM tempa').get().n;
}

module.exports = { ZK_BEZ_FS_DNI, BEZ_STANU_DNI, odtworzBezStanu, bezStanuJesliTrzeba, przeliczTempa, wczytajOkno, zlozZamowienia, policzZysk, rynekKanalu, odswiezTowary, zdjecieStanow, pobierzOkno, meta };
