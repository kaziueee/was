'use strict';

// Ekran „Ceny" (repricer) — odczyt bazy repricera `db/pricing.db` + włączanie/wyłączanie automatu.
// Kanały (kolumny) z pricing/kolumny.js: Amazon DE…PL, eMAG RO/HU/BG, Empik i inne. Kanał oznaczony
// `tylkoOdczyt` — POST /automat odrzuca na nim włączenie automatu (zasada 5: blokada w backendzie).
// `wysylkaPoZgodzie` (Allegro) — automat da się włączyć, ale worker nie wysyła cen bez zgody w .env.
// Liczy i obserwuje osobny proces (pricing/worker.js, zadanie WMS-Pricing); WMS tylko czyta jego
// wyniki i zapisuje decyzję człowieka: automat (auto = 1, ceny idą na platformę) albo ręczny (0). Montowane z
// auth.wymagajRoli('admin', 'biuro') — w testach tylko administrator (2026-10-13), biuro od 2026-10-16 (decyzja usera).
//
//   GET  /api/ceny/macierz?q=&zakres=automat|reczne|wszystkie&sytuacja=…&kanal=&limit=&strona=   wiersze SKU × rynek
//        (strona od 1, po `limit` towarów — domyślnie 200; poza zakresem = ostatnia)
//        (sytuacje: pricing/filtry-cen.js; stary `filtr=` nadal rozumiany)
//        kanal = platforma (amazon, emag) albo klucz kolumny (DE, FR, …, EMAG_RO); puste = wszystkie
//   GET  /api/ceny/pulpit?dni=7|14|30                                  pulpit: Buy Box per kanał teraz / 24 h / 7 dni, wysyłki,
//        zdrowie workera, trend dzienny (BB, zysk/szt., FS z GT wg źródła) — pricing/pulpit-model.js
//   GET  /api/ceny/towar/:tw_id                                        karta SKU: wszystkie rynki towaru + historia
//   /api/ceny/strategie/…                                              strategie cenowe per towar — routes/ceny-strategie.js
//   GET  /api/ceny/log?limit=                                          zmiany cen (auto) + działania ludzi
//   POST /api/ceny/automat  { ids: [oferta_id...], auto: true|false }  — tylko podane oferty, nigdy hurtem
//   GET  /api/ceny/cena/podglad?oferta_id=&cena=                      zysk/marża przy wpisanej cenie + ostrzeżenia
//   GET  /api/ceny/cena/dla-marzy?oferta_id=&marza=                   cena przy wpisanej marży (kalkulator) + to samo co podgląd
//   POST /api/ceny/cena     { oferta_id, cena, potwierdz }             ręczna cena → platforma (pricing/reczna-cena.js);
//        wyłącza automat na tej ofercie (decyzja usera 2026-10-16); z ostrzeżeniami tylko z potwierdz = true
//   POST /api/ceny/cena/hurtem { zmiany: [{ oferta_id, cena | procent }], podglad, potwierdz }   to samo dla kilku ofert
//        naraz (karta produktu w Trendach: +5% / +10%); podglad = bez wysyłki
//   POST /api/ceny/granice  { oferta_id, min, max, potwierdz }         ręczne min/max repricera (puste = kalkulator)
//   GET  /api/ceny/powiazania                                          oferty do powiązania (bez GT / po obcięciu) + ręczne
//   POST /api/ceny/powiaz        { sku, kod }                          powiąż SKU z towarem GT (symbol/EAN)
//   POST /api/ceny/powiaz/potwierdz { sku }                            potwierdź obecne dopasowanie jako ręczne
//   POST /api/ceny/powiaz/usun   { sku }                               usuń ręczne powiązanie
//   POST /api/ceny/allegro-top   (plik xlsx w treści)                  raport Allegro „Czynniki Top oferty” → allegro_top
//   POST /api/ceny/konkurencja { oferta_id, co_h, przebicie }         Allegro: jak często Niezbędnik sprawdza konkurencję
//        (1–4 h, null = 4 h) i o ile przebijamy (zł, 0 = remis, null = 1 gr) — pricing/konkurencja-allegro.js

const express = require('express');
const router = express.Router();
const { db, stan } = require('../pricing/db');
const { linkiOferty } = require('../pricing/amazon');
const emag = require('../pricing/emag');
const empik = require('../pricing/empik');
const allegro = require('../pricing/allegro');
const kaufland = require('../pricing/kaufland');
const { KOLUMNY, kluczKolumny, kolumna, wysylkaWstrzymana } = require('../pricing/kolumny');
const { wycenaHurtem } = require('../services/cennik');
const { pobierzStanyGt, sumaRazem } = require('../services/gt-produkty');
const { doZlozeniaMapa } = require('../services/gt-zestawy');
const { pewneDopasowanie, znajdzTowar, powiaz, usunPowiazanie } = require('../pricing/powiazania');
const filtry = require('../pricing/filtry-cen');
const { czytajXlsx } = require('../services/xlsx-czytnik');
const allegroTop = require('../pricing/allegro-top');
const konkurencja = require('../pricing/konkurencja-allegro');
const { pasOferty } = require('../pricing/pas');
const granice = require('../pricing/granice');
const reczna = require('../pricing/reczna-cena');
const strategieDane = require('../pricing/strategie-dane');
const { opisParametrow: opisStrategii } = require('../pricing/strategie');

// Stan z GT (master stanów) dla pokazanych towarów: Razem (bez BRK) i K4. GT padnięte = null,
// ekran pokazuje wtedy „—", a nie zero (zero to pewna informacja, której nie mamy).
// Zestaw (rodzaj 8): Razem = ile kompletów da się złożyć ze składników — tyle samo Sellasist wystawia
// na platformy; własny stan GT zestawu to tylko zmontowane sztuki (zwykle 0), idzie do `zmontowane`.
async function stanyGt(twIds) {
  try {
    const [m, zestawy] = await Promise.all([pobierzStanyGt(twIds), doZlozeniaMapa(twIds)]);
    return (id) => {
      const s = m.get(String(id));
      if (!s) return null;
      const st = { razem: sumaRazem(s), k4: s.K4?.ilosc ?? 0, k4_rez: s.K4?.rezerwacja ?? 0 };
      if (!zestawy.has(Number(id))) return st;
      const z = zestawy.get(Number(id));
      return { ...st, zestaw: true, zmontowane: st.razem, razem: z ?? st.razem, sklad_nieokreslony: z == null };
    };
  } catch (e) {
    console.error('[ceny] GT stany:', e.message);
    return null;
  }
}

// Linki do oferty — każda platforma po swojemu (pricing/linki.js, wspólne z kartą produktu w Trendach).
const { linkiOferty: linki } = require('../pricing/linki');
// Nasze konta Allegro (numer + login) — raz na żądanie wystarczy, KONTA się nie zmieniają.
let naszeKontaCache = null;
const naszeKonta = () => (naszeKontaCache ||= konkurencja.naszeKonta());
// Niezbędnik w nagłówku ekranu: pakiet sprawdzeń, ostatni raport, trwający raport, błąd.
const zJson = (s) => { try { return s?.wartosc ? JSON.parse(s.wartosc) : null; } catch { return null; } };
const stanNiezbednika = () => ({
  pakiet: zJson(stan.get('nsp_pakiet')), ostatni: stan.get('nsp_ostatni') ? { ...zJson(stan.get('nsp_ostatni')), czas: stan.get('nsp_ostatni').czas } : null,
  trwa: !!stan.get('nsp_raport')?.wartosc, dzis: zJson(stan.get('nsp_dzis')), blad: stan.get('blad_niezbednik'), okno: konkurencja.okno(),
});

// Pola kanału doklejane do każdej oferty — ekran nie zgaduje waluty ani nazwy z kodu rynku.
const zKanalem = (o) => {
  const k = kolumna(o.platforma, o.rynek) || {};
  // Marża i zysk z decyzji są liczone przy cenie SPRZED zmiany. Gdy platforma pokazuje już cenę,
  // którą wysłaliśmy, do następnego przebiegu (do 30 min) przy nowej cenie wisiałaby stara marża
  // (NERCHIBAN3 15.10: 35,99 RON i „zysk −2,57 zł” z ceny 25,99) — bierzemy policzone dla nowej.
  if (o.wyslano && o.cena > 0 && Math.abs(o.cena - o.cena_nowa) < 0.005 && o.zysk_nowa != null) {
    o = { ...o, zysk: o.zysk_nowa, marza: o.marza_nowa };
  }
  return { ...o, kolumna: kluczKolumny(o.platforma, o.rynek), kanal_nazwa: k.nazwa || `${o.platforma} ${o.rynek}`,
    waluta: k.waluta || '', tylko_odczyt: !!k.tylkoOdczyt, bez_konkurencji: !!k.bezKonkurencji, linki: linki(o),
    reczna_cena: reczna.obslugiwana(o.platforma, o.aktywna !== 0), wysylka_wstrzymana: wysylkaWstrzymana(k),
    // Allegro: ustawienia sprawdzania konkurencji (Niezbędnik) i ostatni wynik dla EAN-u towaru.
    ...(o.platforma === 'allegro' ? { konkurencja: {
      co_h: konkurencja.coH(o.konk_co_h), przebicie: konkurencja.przebicie(o.konk_przebicie), wlasne: o.konk_co_h != null || o.konk_przebicie != null,
      ean: o.ean || null, ean_zrodlo: o.ean_zrodlo || null, okno: konkurencja.okno(),
      // Wyniki dla wszystkich zapisów EAN-u (pricing/konkurencja-allegro.js eanyOferty) — połączone.
      wynik: o.ean ? konkurencja.podsumowanie(konkurencja.wpisyOferty(o), naszeKonta()) : null } } : {}),
    // Allegro: raport „Czynniki Top oferty” (pricing/allegro-top.js) — cena Top oferty i co jeszcze blokuje.
    top: o.top_czas ? { ocena: o.top_ocena, cena: o.top_cena, roznica: o.top_roznica, cena_nasza: o.top_cena_nasza,
      czas: o.top_czas, aktualny: allegroTop.aktualny({ raport_czas: o.top_czas }), waznosc_h: allegroTop.WAZNOSC_H,
      do_poprawy: allegroTop.doPoprawy(JSON.parse(o.top_czynniki || '{}')) } : null };
};

// Filtry macierzy: zakres × sytuacja — pricing/filtry-cen.js (czyste, z testami).

// Ostatnia obserwacja i ostatnia decyzja każdej oferty — jedno zapytanie, korelowane po max(id).
const SQL_OFERTY = `
  SELECT o.id, o.platforma, o.rynek, o.sku, o.asin, o.tw_id, o.symbol_gt, o.nazwa, o.ilosc, o.auto, o.aktywna, o.dopasowanie, o.genius, o.blokada,
         o.prowizja, o.min_reczne, o.max_reczne, o.kategoria, o.kategoria_nazwa, o.ean, o.ean_zrodlo, o.konk_co_h, o.konk_przebicie,
         b.czas AS obs_czas, COALESCE(b.widziana, b.czas) AS obs_widziana, b.cena, b.wysylka, b.bb_nasz, b.bb_cena, b.bb_fba, b.najtansza_inna, b.ofert, b.bb_nasza_inna,
         d.kod, d.cena_nowa, d.powod, d.min, d.max, d.zysk, d.marza, d.zysk_nowa,
         d.czas AS dec_czas, d.wyslano, d.blad AS dec_blad, d.marza_nowa, d.cena_cel, d.zysk_cel,
         t.cena_ocena AS top_ocena, t.cena_top AS top_cena, t.roznica AS top_roznica, t.cena_nasza AS top_cena_nasza,
         t.czynniki AS top_czynniki, t.raport_czas AS top_czas
    FROM oferty o
    LEFT JOIN obserwacje b ON b.id = (SELECT MAX(id) FROM obserwacje WHERE oferta_id = o.id)
    LEFT JOIN decyzje d    ON d.id = (SELECT MAX(id) FROM decyzje WHERE oferta_id = o.id)
    LEFT JOIN allegro_top t ON o.platforma = 'allegro' AND t.konto = o.rynek AND t.oferta = o.asin
   WHERE o.aktywna = 1 AND o.tw_id IS NOT NULL AND o.ilosc > 0`;

// Filtr kanału (marketplace): platforma = wszystkie jej kolumny, klucz = jedna kolumna. Wybór zawęża
// i wiersze (towar musi mieć ofertę w kanale), i komórki — więc filtry „Szansa”, „Do podwyżki” i ich
// liczniki liczą się tylko z wybranego kanału. Platforma z jedną kolumną (eMAG RO) = jeden chip.
const kolumnyKanalu = (kanal) => KOLUMNY.filter((k) => k.platforma === kanal || k.klucz === kanal);
const zawez = (towary, kolumny) => {
  const kl = new Set(kolumny.map((k) => k.klucz));
  const tylko = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => kl.has(k)));
  return towary.map((t) => ({ ...t, rynki: tylko(t.rynki), dodatkowe: (t.dodatkowe || []).map(tylko).filter((r) => Object.keys(r).length) }))
    .filter((t) => Object.keys(t.rynki).length);
};
// Chipy kanałów; n = ile towarów w kanale przechodzi BIEŻĄCY filtr (i wyszukiwanie).
function chipyKanalow(towary, pasuje) {
  const ile = (kol) => zawez(towary, kol).filter(pasuje).length;
  const chipy = [{ klucz: '', nazwa: 'Wszystkie kanały', n: towary.filter(pasuje).length }];
  for (const p of [...new Set(KOLUMNY.map((k) => k.platforma))]) {
    const kol = KOLUMNY.filter((k) => k.platforma === p);
    if (kol.length === 1) { chipy.push({ klucz: p, nazwa: kol[0].nazwa, n: ile(kol) }); continue; }
    chipy.push({ klucz: p, nazwa: `${kol[0].nazwa.split(' ')[0]} — wszystkie`, n: ile(kol) });
    for (const k of kol) chipy.push({ klucz: k.klucz, nazwa: k.etykieta || k.rynek, n: ile([k]), rynek: true });
  }
  return chipy;
}

// Towary macierzy (pricing/filtry-cen.js grupujTowary): druga i kolejna oferta towaru w tej samej kolumnie dostaje
// własny wiersz pod towarem (`dodatkowe`). Wspólne dla macierzy i pulpitu (kafel liczy to samo, co macierz pokaże).
const towaryMacierzy = () => filtry.grupujTowary(db.prepare(SQL_OFERTY).all().map(zKanalem), (o) => o.kolumna);

// Express 4 nie łapie odrzuconych obietnic — wyjątek w handlerze async wywróciłby cały WMS.
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/macierz', asyncH(async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const { zakres, sytuacja } = filtry.parametry(req.query);
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
  // Nieznany kanał = wszystkie (nie pusta macierz) — stary link albo kanał wycofany z kolumn.
  const kolKanalu = kolumnyKanalu(String(req.query.kanal || ''));
  const kanal = kolKanalu.length ? String(req.query.kanal) : '';
  const kolumnyW = kanal ? kolKanalu : KOLUMNY;

  const towary = towaryMacierzy();

  const pasuje = (t) => {
    const of = filtry.ofertyTowaru(t);
    if (q && !(String(t.symbol).toLowerCase().includes(q) || String(t.nazwa || '').toLowerCase().includes(q)
      || of.some((o) => o.sku.toLowerCase().includes(q) || String(o.asin || '').toLowerCase() === q))) return false;
    if (q) return true;                                  // wyszukiwanie ma pierwszeństwo przed filtrem
    return filtry.towarPasuje(t, zakres, sytuacja);
  };
  const kazdy = [...towary.values()];
  const wszystkie = kanal ? zawez(kazdy, kolumnyW) : kazdy;
  const wiersze = wszystkie.filter(pasuje).sort(q ? filtry.porownaj(zakres, 'wszystkie') : filtry.porownaj(zakres, sytuacja));
  // Po stanie: stan z GT dla CAŁEGO wyniku, zanim go obetniemy do `limit` — inaczej na górze byłyby
  // największe stany spośród pierwszych 200 wg innej kolejności. GT padnięte = kolejność domyślna.
  const sort = filtry.sortuj(String(req.query.sort || ''));
  let stanGt = sort === 'stan' ? await stanyGt(wiersze.map((t) => t.tw_id)) : undefined;
  if (sort === 'stan' && stanGt) wiersze.sort(filtry.poStanie((t) => stanGt(t.tw_id)?.razem));

  // Strony (decyzja usera 2026-10-19 — wcześniej było tylko „Pokazano 200 z N, zawęź wyszukiwaniem”).
  // Strona spoza zakresu (filtr zawęził wynik po przejściu dalej) = ostatnia, a nie pusta macierz.
  const stron = Math.max(1, Math.ceil(wiersze.length / limit));
  const strona = Math.min(Math.max(Math.floor(Number(req.query.strona)) || 1, 1), stron);
  const pokazane = wiersze.slice((strona - 1) * limit, strona * limit);
  // Która komórka spełnia wybraną sytuację — ekran ją obrysowuje (w wierszu bywa kilka rynków).
  if (sytuacja !== 'wszystkie' && !q) {
    for (const t of pokazane) for (const o of filtry.ofertyTowaru(t)) o.trafienie = filtry.ofertaPasuje(o, zakres, sytuacja);
  }
  if (stanGt === undefined) stanGt = await stanyGt(pokazane.map((t) => t.tw_id));
  for (const t of pokazane) t.stan_gt = stanGt ? stanGt(t.tw_id) : null;

  res.json({
    rynki: kolumnyW.map((k) => k.klucz),
    kolumny: kolumnyW.map((k) => ({ klucz: k.klucz, nazwa: k.nazwa, waluta: k.waluta, tylko_odczyt: !!k.tylkoOdczyt, wysylka_wstrzymana: wysylkaWstrzymana(k) })),
    kanal,
    kanaly: chipyKanalow(kazdy, pasuje),
    emag: { sync: stan.get('sync_emag'), blad: stan.get('blad_emag') },
    empik: { sync: stan.get('sync_empik'), blad: stan.get('blad_empik') },
    allegro: { sync: stan.get('sync_allegro'), blad: stan.get('blad_allegro') },
    niezbednik: stanNiezbednika(),
    kaufland: { sync: stan.get('sync_kaufland'), blad: stan.get('blad_kaufland') },
    wysylanie: process.env.PRICING_ZAPIS === '1',    // globalny hamulec workera (ten sam .env)
    gt_ok: !!stanGt,
    przebieg: stan.get('przebieg'),
    obserwacja_pelna: stan.get('obserwacja_pelna'),
    blad: stan.get('blad'),
    zakres,
    sytuacja,
    sort,
    sorty: filtry.SORTY,
    ...filtry.chipy(wszystkie, zakres, sytuacja),     // { zakresy: [...], sytuacje: [...] } z licznikami
    razem: wiersze.length,
    strona,
    stron,
    na_strone: limit,
    wiersze: pokazane,
  });
}));

// --- Pulpit: jak idzie automat --------------------------------------------------------------------------------
// Liczby składa pricing/pulpit-model.js (czyste, testy), stany z historii czyta pricing/pulpit.js. „Teraz” liczymy
// na ofertach z macierzy (towaryMacierzy), więc kafel kanału pokazuje to, co macierz po kliknięciu.
const pulpit = require('../pricing/pulpit');
const pm = require('../pricing/pulpit-model');
const { sprzedazWgZrodla } = require('../services/gt-sprzedaz');
const { interwalMsZMinut } = require('../services/interwal');
const INTERWAL_MIN = interwalMsZMinut(process.env.PRICING_INTERWAL_MIN, 30, 'PRICING_INTERWAL_MIN') / 60000;

// FS z GT najwyżej co 10 min — minione dni się nie zmieniają, a pulpit otwiera się często.
const SPRZEDAZ_MS = 10 * 60_000;
let sprzedazPamiec = null;
async function sprzedazPulpitu(od) {
  if (sprzedazPamiec && sprzedazPamiec.od <= od && Date.now() - sprzedazPamiec.czas < SPRZEDAZ_MS) return sprzedazPamiec.dane;
  const dane = await sprzedazWgZrodla(od);
  sprzedazPamiec = { od, czas: Date.now(), dane };
  return dane;
}

router.get('/pulpit', asyncH(async (req, res) => {
  const teraz = new Date();
  const ileDni = pm.oknoTrendu(req.query.dni);
  const dni = pm.dniOkna(ileDni, teraz);
  const klucze = new Set(KOLUMNY.map((k) => k.klucz));
  const pokazane = [...towaryMacierzy().values()].flatMap(filtry.ofertyTowaru);
  const kohorta = pulpit.kohortaAutomatu();
  const { stan: stanTeraz, wiersze } = pulpit.stanTeraz(teraz, pokazane, kohorta.ids);
  const wczesniej = (h) => { const T = new Date(teraz.getTime() - h * 3600e3); return pm.stanNaChwile(pulpit.wierszeNaChwile(T, kohorta.ids), T); };
  const stan24 = wczesniej(24), stan7 = wczesniej(7 * 24);
  const akt = pm.aktywnosc(pulpit.wysylki(teraz), teraz);
  const czeka = pm.czekajace(pokazane, teraz);
  const syt = pm.sytuacjeKanalow(pokazane);

  let sprzedaz = null;
  try {
    const fs = await sprzedazPulpitu(dni[0].dzien);
    sprzedaz = pm.sprzedazKanalami(fs.dokumenty, fs.pozycje, kohorta.twPoKanale, klucze);
  } catch (e) { console.error('[ceny] pulpit — FS z GT:', e.message); }

  const obserwacje = new Map();
  for (const o of wiersze) if (!(obserwacje.get(o.platforma) >= o.w)) obserwacje.set(o.platforma, o.w);
  const platformy = new Set(db.prepare('SELECT DISTINCT platforma FROM oferty').all().map((x) => x.platforma));

  const poczatki = pulpit.poczatkiObserwacji();
  const bilans = (k, grupa) => ({
    h24: pm.bilansBb(stanTeraz.get(k)?.[grupa], stan24.get(k)?.[grupa]),
    d7: pm.bilansBb(stanTeraz.get(k)?.[grupa], stan7.get(k)?.[grupa]),
  });
  const kanaly = KOLUMNY.map((k) => ({
    klucz: k.klucz, nazwa: k.nazwa, etykieta: k.etykieta || k.rynek, platforma: k.platforma, waluta: k.waluta,
    tylko_odczyt: !!k.tylkoOdczyt, bez_konkurencji: !!k.bezKonkurencji, wysylka_wstrzymana: wysylkaWstrzymana(k),
    ofert: syt.get(k.klucz)?.wszystkie.wszystkie || 0,
    automat: syt.get(k.klucz)?.automat.wszystkie || 0,
    bb: { wszystkie: bilans(k.klucz, 'wszystkie'), automat: bilans(k.klucz, 'automat') },
    sytuacje: syt.get(k.klucz)?.wszystkie || null,
    sytuacje_auto: syt.get(k.klucz)?.automat || null,
    aktywnosc: akt.get(k.klucz) || null,
    czeka: czeka.get(k.klucz) || { n: 0, najdluzej_min: 0 },
    obserwacja_od: poczatki.get(k.klucz) || null,
  }));
  const suma = (grupa, okno) => pm.zsumujBilanse(kanaly.map((k) => k.bb[grupa][okno]));
  res.json({
    teraz: pm.doBazy(teraz),
    zdrowie: pm.zdrowie({ stan: pulpit.stanWorkera(), teraz, interwalMin: INTERWAL_MIN, zapis: process.env.PRICING_ZAPIS === '1', obserwacje, platformy }),
    kanaly,
    razem: {
      ofert: kanaly.reduce((a, k) => a + k.ofert, 0), automat: kanaly.reduce((a, k) => a + k.automat, 0),
      bb: { wszystkie: { h24: suma('wszystkie', 'h24'), d7: suma('wszystkie', 'd7') }, automat: { h24: suma('automat', 'h24'), d7: suma('automat', 'd7') } },
      aktywnosc: akt.get('razem') || null,
      czeka: czeka.get('razem') || { n: 0, najdluzej_min: 0 },
    },
    trend: { ...pm.zlozTrend(dni, pulpit.stanyDni(dni, teraz, kohorta.ids, stanTeraz), sprzedaz, klucze), gt_ok: !!sprzedaz },
    sytuacje: filtry.SYTUACJE.map(({ klucz, nazwa, opis }) => ({ klucz, nazwa, opis: opis || '' })),
    okno: ileDni, okna: pm.OKNA_TRENDU, tolerancja_h: pm.TOLERANCJA_H, czeka_min: pm.CZEKA_MIN,
  });
}));

// Karta SKU — wszystkie oferty towaru (każdy rynek, także bez stanu i z dopiskiem -1), ostatnia
// obserwacja i decyzja, historia do wykresu. Koszt i waga na żywo z GT; GT padnięte = karta bez nich.
// ?nieaktywne=1 (karta produktu w Sprzedaż → Trendy) — także oferty, które zniknęły z listy platformy (`aktywna = 0`:
// najczęściej stan 0 — eMAG, Empik i Kaufland wyłączają wtedy ofertę), bo i na nich da się włączyć automat (zadziała,
// gdy wróci stan) i zmienić cenę; towar bez żadnej oferty = pusta lista zamiast 404, plus kanały repricera, żeby
// ekran mógł powiedzieć, gdzie oferty nie ma.
const SQL_OFERTY_WSZYSTKIE = SQL_OFERTY.replace('AND o.ilosc > 0', '').replace('o.aktywna = 1 AND ', '');
router.get('/towar/:tw_id', asyncH(async (req, res) => {
  const twId = Number(req.params.tw_id);
  const nieaktywne = req.query.nieaktywne === '1';
  const oferty = nieaktywne
    ? db.prepare(SQL_OFERTY_WSZYSTKIE + ' AND o.tw_id = ? ORDER BY o.aktywna DESC, o.platforma, o.rynek, o.ilosc DESC').all(twId)
    : db.prepare(SQL_OFERTY.replace('AND o.ilosc > 0', '') + ' AND o.tw_id = ? ORDER BY o.platforma, o.rynek, o.ilosc DESC').all(twId);
  if (!oferty.length && !nieaktywne) return res.status(404).json({ blad: 'Brak ofert dla tego towaru' });
  const decyzje = db.prepare(`SELECT czas, cena_przed, cena_nowa, cena_cel, zysk_cel, min, max, kod, powod, wyslano, blad, auto, zysk, zysk_nowa
                                FROM decyzje WHERE oferta_id = ? ORDER BY id DESC LIMIT 30`);
  const obserwacje = db.prepare(`SELECT czas, cena, wysylka, bb_nasz, bb_cena, bb_fba, najtansza_inna
                                   FROM obserwacje WHERE oferta_id = ? ORDER BY id DESC LIMIT 60`);
  const zmiany = db.prepare('SELECT czas, kto, akcja FROM zmiany WHERE oferta_id = ? ORDER BY id DESC LIMIT 20');

  let gt = null;
  const { w, gtOk } = await wycenaTowaru(twId, { swieza: true });
  if (w) gt = { koszt: w.koszt, kosztZrodlo: w.kosztZrodlo, kosztKartoteka: w.kosztKartoteka, kosztUwaga: w.kosztUwaga,
    waga: w.waga, wagaZnana: w.wagaZnana, docinalny: w.docinalny };

  const stanGt = await stanyGt([twId]);
  // Strategia towaru: przypisanie do pokazania (także w podglądzie), granice tylko z aktywnej.
  const strat = await strategieDane.strategiaTowaru(twId);
  const opcjeStrat = strat.aktywna ? { strategia: strat.aktywna, oferty } : {};
  res.json({
    tw_id: twId,
    stan_gt: stanGt ? stanGt(twId) : null,
    strategia: strat.przypisanie ? { id: strat.przypisanie.strategia.id, nazwa: strat.przypisanie.strategia.nazwa, typ: strat.przypisanie.strategia.typ,
      opis: opisStrategii(strat.przypisanie.strategia), aktywna: strat.przypisanie.strategia.aktywna, dziala: !!strat.aktywna,
      do: strat.przypisanie.do, kto: strat.przypisanie.kto, czas: strat.przypisanie.czas } : null,
    symbol: oferty[0]?.symbol_gt ?? null,
    nazwa: oferty[0]?.nazwa ?? null,
    ...(nieaktywne ? { kolumny: KOLUMNY.map((k) => ({ klucz: k.klucz, platforma: k.platforma, nazwa: k.nazwa })) } : {}),
    gt_ok: !!gt,
    gt,
    przebieg: stan.get('przebieg'),
    oferty: oferty.map((o) => ({
      ...zKanalem(o),
      // Pas na TERAZ (koszt z GT, ręczne granice), nie z ostatniej decyzji — po zmianie granic ekran
      // pokazuje nowe od razu, a automat użyje ich w najbliższym przebiegu.
      granice: { min_reczne: o.min_reczne, max_reczne: o.max_reczne, ...opisPasa(pasOferty(w, o, opcjeStrat)), gt_ok: gtOk },
      propagacja: reczna.propagacja(o.platforma),
      decyzje: decyzje.all(o.id),
      obserwacje: obserwacje.all(o.id).reverse(),
      zmiany: zmiany.all(o.id),
    })),
  });
}));

router.get('/log', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
  // Nieznany kanał = wszystkie (nie pusta macierz) — stary link albo kanał wycofany z kolumn.
  const kolKanalu = kolumnyKanalu(String(req.query.kanal || ''));
  const kanal = kolKanalu.length ? String(req.query.kanal) : '';
  const kolumnyW = kanal ? kolKanalu : KOLUMNY;
  const decyzje = db.prepare(`
    SELECT 'decyzja' AS typ, d.czas, o.platforma, o.rynek, o.sku, o.symbol_gt, d.cena_przed, d.cena_nowa, d.kod, d.powod,
           d.wyslano, d.zysk, d.zysk_nowa, NULL AS kto
      FROM decyzje d JOIN oferty o ON o.id = d.oferta_id
     WHERE d.auto = 1 AND d.cena_nowa <> d.cena_przed
     ORDER BY d.id DESC LIMIT ?`).all(limit);
  const zmiany = db.prepare(`
    SELECT 'zmiana' AS typ, z.czas, o.platforma, o.rynek, o.sku, o.symbol_gt, NULL AS cena_przed, NULL AS cena_nowa, z.akcja AS kod,
           z.opis AS powod, NULL AS wyslano, NULL AS zysk, NULL AS zysk_nowa, z.kto
      FROM zmiany z LEFT JOIN oferty o ON o.id = z.oferta_id
     ORDER BY z.id DESC LIMIT ?`).all(limit);
  // Nazwa kanału i waluta jak w macierzy — sam kod rynku nie odróżnia Amazon DE od Kaufland DE.
  const zKanalemLogu = (x) => {
    const k = kolumna(x.platforma, x.rynek);
    return k ? { ...x, kanal_nazwa: k.nazwa, waluta: k.waluta } : x;
  };
  res.json({ wpisy: [...decyzje, ...zmiany].sort((a, b) => (a.czas < b.czas ? 1 : -1)).slice(0, limit).map(zKanalemLogu) });
});

router.post('/automat', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(Number).filter(Number.isInteger))] : [];
  const auto = req.body?.auto === true || req.body?.auto === 1 ? 1 : req.body?.auto === false || req.body?.auto === 0 ? 0 : null;
  if (!ids.length || auto === null) return res.status(400).json({ blad: 'Podaj ids (lista ofert) i auto (true/false)' });
  if (ids.length > 200) return res.status(400).json({ blad: 'Najwyżej 200 ofert naraz — automatu nie włączamy na cały katalog' });

  const kto = req.body.operator || null;              // wstrzyknięty z sesji (services/auth)
  const of = db.prepare('SELECT id, platforma, rynek, sku, auto, tw_id, dopasowanie FROM oferty WHERE id = ?');
  const ustaw = db.prepare('UPDATE oferty SET auto = ? WHERE id = ?');
  const log = db.prepare('INSERT INTO zmiany (kto, oferta_id, akcja, opis) VALUES (?, ?, ?, ?)');
  let zmienione = 0;
  const pominiete = [];
  db.exec('BEGIN');
  try {
    for (const id of ids) {
      const o = of.get(id);
      if (!o) { pominiete.push({ id, powod: 'nie ma oferty' }); continue; }
      if (auto && !o.tw_id) { pominiete.push({ id, sku: o.sku, powod: 'oferta bez towaru GT' }); continue; }
      if (auto && kolumna(o.platforma, o.rynek)?.tylkoOdczyt) { pominiete.push({ id, sku: o.sku, powod: `${o.platforma} ${o.rynek}: na razie tylko odczyt — automat niedostępny` }); continue; }
      // Automat tylko przy pewnym dopasowaniu do GT (wprost / ręczne) — zasada 5: wymuszone tu, nie na ekranie.
      if (auto && !pewneDopasowanie(o.dopasowanie)) {
        pominiete.push({ id, sku: o.sku, powod: 'dopasowanie do GT niepotwierdzone — potwierdź w zakładce „Do powiązania”' });
        continue;
      }
      if (o.auto === auto) continue;
      ustaw.run(auto, id);
      log.run(kto, id, auto ? 'automat_wl' : 'automat_wyl', `${o.rynek} ${o.sku}`);
      zmienione++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ ok: true, zmienione, pominiete });
});

// --- Ręczna cena i ręczne granice -------------------------------------------------------------
// Czysta logika (walidacja, pas po granicach, ostrzeżenia) w pricing/granice.js; wysyłka per platforma
// w pricing/reczna-cena.js. Wycena z GT jest potrzebna do zysku i minimum — trzymamy ją minutę, bo
// podgląd woła ją przy każdej zmianie wpisanej ceny.
const WYCENA_MS = 60_000;
const wyceny = new Map();   // tw_id → { w, czas }
async function wycenaTowaru(twId, { swieza = false } = {}) {
  const c = wyceny.get(twId);
  if (!swieza && c && Date.now() - c.czas < WYCENA_MS) return { w: c.w, gtOk: true };
  try {
    const w = (await wycenaHurtem([twId])).get(twId) || null;
    wyceny.set(twId, { w, czas: Date.now() });
    if (wyceny.size > 500) wyceny.delete(wyceny.keys().next().value);
    return { w, gtOk: true };
  } catch (e) {
    console.error('[ceny] GT:', e.message);
    return { w: null, gtOk: false };
  }
}

// Pas → JSON dla ekranu (bez funkcji `ocen`).
const opisPasa = ({ pas, kalk }) => ({
  min: pas?.min ?? null, max: pas?.max ?? null, zrodlo_min: pas?.zrodlo_min ?? null, zrodlo_max: pas?.zrodlo_max ?? null,
  kalk_min: kalk?.min ?? null, kalk_max: kalk?.max ?? null, blad: pas?.blad ?? null,
  // strategia towaru (aktywna) — `kalk` jest wtedy jej pasem, `bazowy` to pas bez strategii (kalkulator 20%)
  strategia: kalk?.strategia ?? null, bazowy: kalk?.bazowy ?? null, referencja: kalk?.referencja ?? null,
});

// Także oferty nieaktywne (stan 0) — karta w Trendach zmienia na nich cenę; czego platforma nie pozwala, odmawia
// pricing/reczna-cena.js (Allegro: zakończona oferta).
const ofertaPoId = (id) => (Number.isInteger(Number(id))
  ? db.prepare(SQL_OFERTY_WSZYSTKIE + ' AND o.id = ?').get(Number(id)) || null : null);

// Cena, którą oferta ma TERAZ: wysłana decyzja nowsza niż obserwacja = cena już poszła na platformę
// (tak samo liczy ekran — cenyPoWyslaniu w public/desktop/app.js).
const cenaTeraz = (o) => (o.wyslano && o.dec_czas && !(o.obs_czas && o.obs_czas > o.dec_czas) ? o.cena_nowa : o.cena) ?? null;

// Pas oferty tak, jak liczy go worker: kalkulator → AKTYWNA strategia towaru → ręczne granice oferty (odstępstwo).
// Strategia w podglądzie nie zmienia granic (wdrożenie kontrolowane). Genius i prowizja ze wszystkich ofert towaru.
const ofertyTowaru = (twId) => db.prepare('SELECT platforma, rynek, genius, prowizja FROM oferty WHERE tw_id = ? AND aktywna = 1').all(twId);
async function pasZeStrategia(w, o) {
  const { aktywna } = await strategieDane.strategiaTowaru(o.tw_id);
  return aktywna ? pasOferty(w, o, { strategia: aktywna, oferty: ofertyTowaru(o.tw_id) }) : pasOferty(w, o);
}

// Strategie cenowe per towar: biblioteka, przypisania, podgląd (routes/ceny-strategie.js).
router.use('/strategie', require('./ceny-strategie')({ SQL_OFERTY, zKanalem, cenaTeraz, asyncH }));

async function ocenaRecznejCeny(o, cenaWe) {
  const c = granice.walidujCene(cenaWe);
  if (c.blad) return { blad: c.blad };
  const { w, gtOk } = await wycenaTowaru(o.tw_id);
  const p = await pasZeStrategia(w, o);
  const teraz = cenaTeraz(o);
  const ocena = granice.ocenCene(c.cena, { teraz, pas: p.pas, gtOk, niepewneDopasowanie: !pewneDopasowanie(o.dopasowanie) });
  const przed = teraz != null && p.pas?.ocen ? p.pas.ocen(teraz) : null;
  return { cena: c.cena, teraz, p, ocena, przed, gtOk };
}

const podgladCeny = (o, r) => ({
  oferta_id: o.id, kolumna: kluczKolumny(o.platforma, o.rynek), kanal_nazwa: kolumna(o.platforma, o.rynek)?.nazwa || `${o.platforma} ${o.rynek}`,
  waluta: kolumna(o.platforma, o.rynek)?.waluta || '', sku: o.sku, auto: !!o.auto,
  cena: r.cena, zysk: r.ocena.zysk, marza: r.ocena.marza, ostrzezenia: r.ocena.ostrzezenia,
  teraz: r.teraz, zysk_teraz: r.przed?.zysk ?? null, marza_teraz: r.przed?.marza ?? null,
  granice: opisPasa(r.p), gt_ok: r.gtOk, obslugiwana: reczna.obslugiwana(o.platforma, !!o.aktywna), propagacja: reczna.propagacja(o.platforma),
});

router.get('/cena/podglad', asyncH(async (req, res) => {
  const o = ofertaPoId(req.query.oferta_id);
  if (!o) return res.status(404).json({ blad: 'Nie ma takiej oferty' });
  const r = await ocenaRecznejCeny(o, req.query.cena);
  if (r.blad) return res.status(400).json({ blad: r.blad });
  res.json(podgladCeny(o, r));
}));

// Cena przy zadanej marży (karta produktu w Sprzedaż → Trendy: pole „marża %”). Ten sam kalkulator co minimum
// automatu (pricing/pas.js `policz`: koszty, prowizja i Genius oferty), cena „,99” jak w Cenniku — więc marża
// wychodzi w okolicy wpisanej (20% → 19,6–20,2%); podgląd pokazuje prawdziwą. Bez progu minimalnego zysku (5 zł): wpisana
// marża ma dać tę marżę, a stratę i zejście pod minimum i tak zgłaszają ostrzeżenia przy wysyłce.
const MARZA_ZAKRES = [-50, 80];
router.get('/cena/dla-marzy', asyncH(async (req, res) => {
  const o = ofertaPoId(req.query.oferta_id);
  if (!o) return res.status(404).json({ blad: 'Nie ma takiej oferty' });
  const m = granice.liczba(req.query.marza);
  if (m == null || !(m >= MARZA_ZAKRES[0] && m <= MARZA_ZAKRES[1])) return res.status(400).json({ blad: `Marża od ${MARZA_ZAKRES[0]} do ${MARZA_ZAKRES[1]}%` });
  const { w, gtOk } = await wycenaTowaru(o.tw_id);
  if (!w) return res.status(503).json({ blad: gtOk ? 'Brak wyceny towaru w GT' : 'Subiekt nie odpowiada — bez kosztu zakupu nie policzę ceny' });
  const { kalk } = await pasZeStrategia(w, o);
  if (!kalk?.policz) return res.status(400).json({ blad: `${kolumna(o.platforma, o.rynek)?.nazwa || o.platforma}: kalkulator nie zna tego rynku — wpisz cenę` });
  const cena = kalk.policz({ tryb: 'marza', marza: m, minzysk: -1e9 });
  if (!(cena > 0)) return res.status(400).json({ blad: `Przy marży ${granice.pl(m, 1)}% kalkulator nie daje ceny` });
  const r = await ocenaRecznejCeny(o, cena);
  if (r.blad) return res.status(400).json({ blad: r.blad });
  res.json({ ...podgladCeny(o, r), marza_wpisana: m });
}));

// Raport Allegro Analytics „Czynniki wpływające na wybór Top oferty” — plik xlsx w surowej treści żądania
// (globalny parser JSON przyjmuje 100 kB, raport ma ~0,5 MB). Operatora wstrzykuje logowanie do req.body,
// zanim parser surowej treści go podmieni — stąd zapamiętanie przed parserem.
router.post('/allegro-top', (req, res, next) => { req.kto = req.body?.operator || null; next(); },
  express.raw({ type: () => true, limit: '40mb' }), (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ blad: 'Wyślij plik xlsx raportu' });
    let raport;
    try { raport = allegroTop.raportTopOferty(czytajXlsx(req.body)); } catch (e) { return res.status(400).json({ blad: e.message }); }
    try { res.json({ ok: true, ...allegroTop.zapiszRaport(raport, req.kto) }); } catch (e) { res.status(400).json({ blad: e.message }); }
  });

// Allegro: ustawienia sprawdzania konkurencji przy ofercie (pricing/konkurencja-allegro.js). null = domyślne.
router.post('/konkurencja', (req, res) => {
  const o = ofertaPoId(req.body?.oferta_id);
  if (!o) return res.status(404).json({ blad: 'Nie ma takiej oferty' });
  if (o.platforma !== 'allegro') return res.status(400).json({ blad: 'Ustawienia konkurencji są na razie tylko dla Allegro' });
  const coH = req.body?.co_h == null || req.body.co_h === '' ? null : Number(req.body.co_h);
  if (coH != null && !konkurencja.CO_H.includes(coH)) return res.status(400).json({ blad: `Sprawdzanie co ${konkurencja.CO_H.join(', ')} h` });
  const p = req.body?.przebicie == null || req.body.przebicie === '' ? null : granice.liczba(req.body.przebicie);
  if (p !== null && !(p >= 0 && p <= konkurencja.PRZEBICIE_MAX)) {
    return res.status(400).json({ blad: `Przebicie od 0 (remis) do ${konkurencja.PRZEBICIE_MAX} zł` });
  }
  const przeb = p == null ? null : Math.round(p * 100) / 100;
  db.prepare('UPDATE oferty SET konk_co_h = ?, konk_przebicie = ? WHERE id = ?').run(coH, przeb, o.id);
  const opis = (x, dom, f) => (x == null ? `${f(dom)} (domyślnie)` : f(x));
  const zl = (x) => (x === 0 ? 'remis' : `${granice.pl(x)} zł`);
  db.prepare("INSERT INTO zmiany (kto, oferta_id, akcja, opis) VALUES (?, ?, 'konkurencja', ?)")
    .run(req.body.operator || null, o.id, `${kluczKolumny(o.platforma, o.rynek)} ${o.sku}: sprawdzanie co ${opis(coH, konkurencja.DOMYSLNE.co_h, (h) => `${h} h`)}, przebicie ${opis(przeb, konkurencja.DOMYSLNE.przebicie, zl)}`);
  res.json({ ok: true, co_h: konkurencja.coH(coH), przebicie: konkurencja.przebicie(przeb) });
});

// Czy na tej ofercie wolno zmienić cenę z ekranu — null = tak, inaczej powód (zasada 5: także dla zbiorczej zmiany).
function odmowaRecznej(o) {
  const kol = kluczKolumny(o.platforma, o.rynek);
  if (!reczna.obslugiwana(o.platforma)) return `${kol}: ręczna zmiana ceny z ekranu jeszcze nieobsługiwana`;
  if (!reczna.obslugiwana(o.platforma, !!o.aktywna)) return `${kolumna(o.platforma, o.rynek)?.nazwa || kol} ${o.sku}: oferta nieaktywna (zakończona) — cenę zmienisz po jej wznowieniu`;
  return null;
}

router.post('/cena', asyncH(async (req, res) => {
  const o = ofertaPoId(req.body?.oferta_id);
  if (!o) return res.status(404).json({ blad: 'Nie ma takiej oferty' });
  const kol = kluczKolumny(o.platforma, o.rynek);
  const odmowa = odmowaRecznej(o);
  if (odmowa) return res.status(400).json({ blad: odmowa });
  const r = await ocenaRecznejCeny(o, req.body?.cena);
  if (r.blad) return res.status(400).json({ blad: r.blad });
  if (r.teraz != null && Math.abs(r.cena - r.teraz) < 0.005) return res.status(400).json({ blad: `${kol} ${o.sku}: ${granice.pl(r.cena)} to już obecna cena` });
  // Ostrzeżenia (pod minimum, strata, skok…) nie blokują — ale bez wyraźnego potwierdzenia nie wysyłamy.
  if (r.ocena.ostrzezenia.length && req.body?.potwierdz !== true) {
    return res.status(409).json({ blad: `Cena wymaga potwierdzenia: ${r.ocena.ostrzezenia.map((x) => x.tekst).join('; ')}`, ostrzezenia: r.ocena.ostrzezenia, potwierdzenie: true });
  }
  const w = await wyslijRecznaCene(o, r, req.body.operator || null);   // operator wstrzyknięty z sesji (services/auth)
  if (!w.ok) return res.status(502).json({ blad: `${kolumna(o.platforma, o.rynek)?.nazwa || kol} nie przyjął zmiany: ${w.blad}` });
  res.json({ ok: true, cena: w.cena, automat_wylaczony: w.automat_wylaczony, propagacja: reczna.propagacja(o.platforma) });
}));

// Wysyłka ręcznej ceny jednej oferty (POST /cena i /cena/hurtem): automat, decyzja `korekta`, log zmian.
// r = ocenaRecznejCeny (po walidacji). → { ok, cena, automat_wylaczony, blad } — odmowa platformy to wynik.
async function wyslijRecznaCene(o, r, kto) {
  const kol = kluczKolumny(o.platforma, o.rynek);
  // Ręczna cena wyłącza automat na tej ofercie (decyzja usera 2026-10-16). Wyłączamy PRZED wysłaniem:
  // worker sprawdza automat jeszcze raz tuż przed swoją wysyłką, więc przebieg, który właśnie trwa,
  // nie nadpisze ręcznej ceny. Odmowa platformy = nic się nie zmieniło, automat wraca.
  const byl = o.auto === 1;
  if (byl) db.prepare('UPDATE oferty SET auto = 0 WHERE id = ?').run(o.id);
  const w = await reczna.wyslij(o, r.cena);
  if (!w.ok && byl) db.prepare('UPDATE oferty SET auto = 1 WHERE id = ? AND auto = 0').run(o.id);

  const pas = r.p.pas;
  const po = pas?.ocen ? pas.ocen(r.cena) : null;
  db.prepare(`INSERT INTO decyzje (oferta_id, cena_przed, cena_nowa, cena_cel, min, max, kod, powod, wyslano, auto, zysk, marza, zysk_nowa, marza_nowa, zysk_cel, blad)
              VALUES (?, ?, ?, ?, ?, ?, 'korekta', ?, ?, 0, ?, ?, ?, ?, ?, ?)`)
    .run(o.id, r.teraz, r.cena, r.cena, pas?.min ?? null, pas?.max ?? null, `ręczna zmiana ceny (${kto || 'ekran'})`, w.ok ? 1 : 0,
      r.przed?.zysk ?? null, r.przed?.marza ?? null, po?.zysk ?? null, po?.marza ?? null, po?.zysk ?? null, w.ok ? null : (w.blad || 'odrzucone'));
  if (w.ok) {
    const log = db.prepare('INSERT INTO zmiany (kto, oferta_id, akcja, opis) VALUES (?, ?, ?, ?)');
    log.run(kto, o.id, 'korekta_ceny', `${kol} ${o.sku}: ${r.teraz != null ? granice.pl(r.teraz) : '?'} → ${granice.pl(r.cena)}`);
    if (byl) log.run(kto, o.id, 'automat_wyl', `${kol} ${o.sku}: ręczna zmiana ceny`);
  }
  console.log(new Date().toISOString(), `[ceny] ręczna cena ${kol} ${o.sku}: ${r.teraz} → ${r.cena} ${w.ok ? 'WYSŁANO' : `ODRZUCONO: ${w.blad}`} (${kto || '?'})`);
  return w.ok ? { ok: true, cena: w.cena ?? r.cena, automat_wylaczony: byl } : { ok: false, blad: w.blad || 'odrzucone', automat_wylaczony: false };
}

// Zbiorcza zmiana ceny (karta produktu w Sprzedaż → Trendy: „+5% / +10%” na zaznaczonych ofertach towaru).
// zmiany: [{ oferta_id, cena } | { oferta_id, procent }] — procent liczony od ceny TERAZ (jak cenaTeraz), do grosza.
// podglad: true → tylko pozycje z marżą, zyskiem i ostrzeżeniami, nic nie idzie na platformy. Bez podglądu: każda
// pozycja przechodzi te same reguły co POST /cena (odmowaRecznej, ocenaRecznejCeny), ostrzeżenia którejkolwiek =
// 409 bez `potwierdz`, a wysyłka idzie po kolei przez wyslijRecznaCene (ręczna cena wyłącza automat). Pozycja, której
// nie da się zmienić, nie zatrzymuje reszty — wraca z `blad`.
const HURTEM_MAX = 30, PROCENT_ZAKRES = [-50, 100];
router.post('/cena/hurtem', asyncH(async (req, res) => {
  const b = req.body || {};
  const zmiany = Array.isArray(b.zmiany) ? b.zmiany : [];
  if (!zmiany.length) return res.status(400).json({ blad: 'Podaj zmiany: [{ oferta_id, cena | procent }]' });
  if (zmiany.length > HURTEM_MAX) return res.status(400).json({ blad: `Najwyżej ${HURTEM_MAX} ofert naraz` });
  const pozycje = [], widziane = new Set();
  for (const z of zmiany) {
    const o = ofertaPoId(z?.oferta_id);
    const p = { oferta_id: Number(z?.oferta_id) };
    pozycje.push(p);
    if (!o) { p.blad = 'nie ma takiej oferty'; continue; }
    Object.assign(p, { kanal_nazwa: kolumna(o.platforma, o.rynek)?.nazwa || `${o.platforma} ${o.rynek}`, sku: o.sku,
      waluta: kolumna(o.platforma, o.rynek)?.waluta || '', auto: !!o.auto });
    if (widziane.has(o.id)) { p.blad = 'oferta podana dwa razy'; continue; }
    widziane.add(o.id);
    const odmowa = odmowaRecznej(o);
    if (odmowa) { p.blad = odmowa; continue; }
    let cenaWe = z.cena;
    if (z.procent != null) {
      const pr = granice.liczba(z.procent);
      if (pr == null || !(pr >= PROCENT_ZAKRES[0] && pr <= PROCENT_ZAKRES[1])) { p.blad = `procent od ${PROCENT_ZAKRES[0]} do +${PROCENT_ZAKRES[1]}`; continue; }
      const teraz = cenaTeraz(o);
      if (!(teraz > 0)) { p.blad = 'brak obecnej ceny (oferta jeszcze nieobserwowana) — nie ma od czego liczyć procentu'; continue; }
      cenaWe = Math.round(teraz * (1 + pr / 100) * 100) / 100;
    }
    const r = await ocenaRecznejCeny(o, cenaWe);
    if (r.blad) { p.blad = r.blad; continue; }
    if (r.teraz != null && Math.abs(r.cena - r.teraz) < 0.005) { p.blad = `${granice.pl(r.cena)} to już obecna cena`; continue; }
    Object.assign(p, podgladCeny(o, r));
    Object.defineProperty(p, 'wysylka', { value: { o, r }, enumerable: false });   // nie idzie do JSON-a
  }
  const doWyslania = pozycje.filter((p) => p.wysylka);
  if (b.podglad === true) return res.json({ ok: true, podglad: true, pozycje });
  if (!doWyslania.length) return res.status(400).json({ blad: 'Żadnej z tych cen nie da się wysłać', pozycje });
  const ostrz = doWyslania.flatMap((p) => p.ostrzezenia.map((x) => ({ ...x, tekst: `${p.kanal_nazwa} ${p.sku}: ${x.tekst}` })));
  if (ostrz.length && b.potwierdz !== true) {
    return res.status(409).json({ blad: `Ceny wymagają potwierdzenia: ${ostrz.map((x) => x.tekst).join('; ')}`, ostrzezenia: ostrz, potwierdzenie: true, pozycje });
  }
  const kto = b.operator || null;
  for (const p of doWyslania) {
    const w = await wyslijRecznaCene(p.wysylka.o, p.wysylka.r, kto);
    Object.assign(p, { wyslano: w.ok, automat_wylaczony: w.automat_wylaczony, ...(w.ok ? { cena: w.cena } : { blad: w.blad }) });
  }
  res.json({ ok: true, wyslane: doWyslania.filter((p) => p.wyslano).length, pozycje });
}));

router.post('/granice', asyncH(async (req, res) => {
  const o = ofertaPoId(req.body?.oferta_id);
  if (!o) return res.status(404).json({ blad: 'Nie ma takiej oferty' });
  const { w, gtOk } = await wycenaTowaru(o.tw_id, { swieza: true });
  const { kalk } = await pasZeStrategia(w, o);
  const g = granice.walidujGranice(req.body?.min, req.body?.max, kalk);
  if (g.blad) return res.status(400).json({ blad: g.blad });
  const ostrzezenia = granice.ocenGranice(g, kalk, { gtOk });
  if (ostrzezenia.length && req.body?.potwierdz !== true) {
    return res.status(409).json({ blad: `Granice wymagają potwierdzenia: ${ostrzezenia.map((x) => x.tekst).join('; ')}`, ostrzezenia, potwierdzenie: true });
  }
  const nowe = { ...o, min_reczne: g.min, max_reczne: g.max };
  const kol = kluczKolumny(o.platforma, o.rynek);
  if (g.min !== (o.min_reczne ?? null) || g.max !== (o.max_reczne ?? null)) {
    const t = (v) => (v == null ? 'kalkulator' : granice.pl(v));
    db.prepare('UPDATE oferty SET min_reczne = ?, max_reczne = ? WHERE id = ?').run(g.min, g.max, o.id);
    db.prepare("INSERT INTO zmiany (kto, oferta_id, akcja, opis) VALUES (?, ?, 'granice', ?)")
      .run(req.body.operator || null, o.id, `${kol} ${o.sku}: min ${t(o.min_reczne)} → ${t(g.min)}, max ${t(o.max_reczne)} → ${t(g.max)}`);
  }
  res.json({ ok: true, granice: { min_reczne: g.min, max_reczne: g.max, ...opisPasa(await pasZeStrategia(w, nowe)), gt_ok: gtOk } });
}));

// --- Do powiązania ---------------------------------------------------------------------------
router.get('/powiazania', (req, res) => {
  const bez = db.prepare(`SELECT sku, group_concat(rynek, ' ') AS rynki, max(nazwa) AS nazwa, max(ilosc) AS ilosc,
      max(asin) AS asin, min(rynek) AS rynek
    FROM oferty WHERE platforma = 'amazon' AND aktywna = 1 AND tw_id IS NULL GROUP BY sku ORDER BY max(ilosc) DESC, sku`).all();
  const doPotw = db.prepare(`SELECT sku, group_concat(rynek, ' ') AS rynki, max(nazwa) AS nazwa, max(ilosc) AS ilosc,
      max(asin) AS asin, min(rynek) AS rynek, symbol_gt, tw_id
    FROM oferty WHERE platforma = 'amazon' AND aktywna = 1 AND tw_id IS NOT NULL AND (dopasowanie IS NULL OR dopasowanie NOT IN ('wprost', 'reczne'))
    GROUP BY sku ORDER BY sku`).all();
  const reczne = db.prepare(`SELECT p.sku, p.symbol_gt, p.kto, p.czas, (SELECT group_concat(rynek, ' ') FROM oferty o WHERE o.platforma = p.platforma AND o.sku = p.sku) AS rynki
    FROM powiazania p WHERE p.platforma = 'amazon' ORDER BY p.czas DESC`).all();
  const z = (w) => ({ ...w, linki: linkiOferty(w.rynek, w.asin) });
  res.json({ bez: bez.map(z), do_potwierdzenia: doPotw.map(z), reczne });
});

router.post('/powiaz', asyncH(async (req, res) => {
  const sku = String(req.body?.sku || '').trim();
  if (!sku) return res.status(400).json({ blad: 'Podaj SKU oferty' });
  let towar;
  try { towar = await znajdzTowar(req.body?.kod); } catch (e) { return res.status(400).json({ blad: e.message }); }
  const n = powiaz('amazon', sku, towar, req.body.operator);
  res.json({ ok: true, sku, symbol: towar.tw_Symbol, nazwa: towar.tw_Nazwa, oferty: n });
}));

// Potwierdzenie obecnego (automatycznego) dopasowania — staje się ręcznym, więc automat jest dozwolony.
router.post('/powiaz/potwierdz', (req, res) => {
  const sku = String(req.body?.sku || '').trim();
  const o = db.prepare("SELECT tw_id, symbol_gt FROM oferty WHERE platforma = 'amazon' AND sku = ? AND tw_id IS NOT NULL LIMIT 1").get(sku);
  if (!o) return res.status(404).json({ blad: 'Oferta nie ma dopasowanego towaru — powiąż ją z symbolem GT' });
  const n = powiaz('amazon', sku, { tw_Id: o.tw_id, tw_Symbol: o.symbol_gt }, req.body.operator);
  res.json({ ok: true, sku, symbol: o.symbol_gt, oferty: n });
});

router.post('/powiaz/usun', (req, res) => {
  const sku = String(req.body?.sku || '').trim();
  if (!sku) return res.status(400).json({ blad: 'Podaj SKU oferty' });
  res.json({ ok: true, oferty: usunPowiazanie('amazon', sku, req.body.operator) });
});

module.exports = router;
