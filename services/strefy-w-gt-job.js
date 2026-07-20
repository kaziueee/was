'use strict';

// Job adnotacji stref w tw_Pole1: dopisuje do adresu K4 informacje, ILE sztuk lezy poza polka.
//   "M2-J14-P2"  ->  "M2-J14-P2 +D20 +Z3"     (dopisek do adresu)
//   ""           ->  "+D20"                    (SKU bez adresu, tylko sztuki w strefie)
//
// PO CO: pole "Miejsce na magazynie" to jedyne, co widzi czlowiek szukajacy towaru z poziomu
// GT (wydruk, wyszukiwanie w Subiekcie). Gdy polka jest pusta, a 20 szt. z dostawy stoi na
// palecie w strefie, pole mowilo tylko adres pustej polki (albo nic) - i czlowiek odchodzil
// z niczym. Strefy istnialy WYLACZNIE w WMS (karta produktu, kolumna Strefa na desktopie).
//
// DLACZEGO JOB, A NIE ZAPIS PRZY RUCHU: strefa zmienia sie, gdy w GT pojawi sie dokument -
// czyli w momencie, gdy WMS nic nie robi i nie ma sie od czego odpalic. Bez cyklicznego
// przeliczania dopisek by sie zestarzal, a nieaktualne "+Z3" po odniesieniu towaru jest
// GORSZE niz jego brak: wysyla czlowieka po cos, czego juz nie ma.
//
// ZAKRES (zmiana 2026-07-20): dopisujemy do KAZDEGO SKU, ktore ma sztuki w strefie - nie tylko
// tym z domem WMS. Granica bezpieczenstwa to "SKU ma realny dokument strefowy na K4 (rodzaj 1)",
// a nie "WMS zna jego dom". Towary spoza obiegu K4 (ksiazki, meble - tam tw_Pole1 znaczy
// autor/pomieszczenie) NIE maja dokumentow na K4, wiec sa odsiane strukturalnie. Adres bazowy:
// prawda WMS gdy znamy dom, inaczej to, co jest w GT bez naszego dopisku (dopisujemy do adresu
// z GT albo do pustego pola).
//
// USUWANIE (odwracalnosc): oprocz kandydatow job bierze DRUGA liste - SKU noszace NASZ dopisek
// w GT (skan po formacie znacznika). Dzieki temu potrafi zdjac wlasny znacznik nawet gdy SKU
// wypadlo z kandydatow (dokument zestarzal sie za oknem) i nie ma domu WMS. Znacznik sam jest
// kluczem do swojego usuniecia.
//
// Zapisujemy TYLKO przy zmianie - inaczej kazdy przebieg to setki UPDATE-ow do bazy GT.

const db = require('../db/database');
const { query } = require('./gt-sql');
const gtFields = require('./gt-fields');
const gtDokumenty = require('./gt-dokumenty');
const awarie = require('./awarie');

const DOMYSLNY_INTERWAL_MIN = 10;

function interwalMs() {
  const min = Number(process.env.WMS_STREFY_INTERWAL_MIN);
  return (Number.isFinite(min) && min > 0 ? min : DOMYSLNY_INTERWAL_MIN) * 60 * 1000;
}

// Ile sztuk lezy w strefach, w rozbiciu na rodzaje - z tego samego rozbicia, co karta
// produktu i ekran "Do rozlozenia". Wlasny rachunek rozjechalby sie z nimi.
function strefyZRozbicia(rozbicie) {
  return {
    dostawa: (rozbicie.dostawy || []).reduce((s, d) => s + d.ilosc, 0),
    zwrot: (rozbicie.zwroty || []).reduce((s, d) => s + d.ilosc, 0),
    przywozka: (rozbicie.przywozki || []).reduce((s, d) => s + d.ilosc, 0),
    przyjecie_wewn: (rozbicie.przyjecia || []).reduce((s, d) => s + d.ilosc, 0),
  };
}

// Suma kopii WMS na K4 dla artykulu (kopia bywa starsza od GT - patrz rozbijStanK4).
function sumaWmsK4(id) {
  return Number(db.prepare(
    `SELECT COALESCE(SUM(s.ilosc), 0) AS suma FROM stany_lokalizacji s
     JOIN lokalizacje l ON l.id = s.lokalizacja_id WHERE l.magazyn = 'K4' AND s.artykul_gt_id = ?`
  ).get(String(id)).suma) || 0;
}

// Domy WMS K4: Map<tw_Id (string), baza>. Baza z obliczPolaLokalizacji ZAWIERA czlon "/zapas"
// (M2-A7/C2P3), wiec zdjecie strefy odtwarza pelny adres z zapasem. Tylko wpisy z niepusta baza.
function pobierzDomyWms() {
  const ids = db.prepare(
    `SELECT DISTINCT s.artykul_gt_id AS id FROM stany_lokalizacji s
     JOIN lokalizacje l ON l.id = s.lokalizacja_id WHERE l.magazyn = 'K4'`
  ).all().map((r) => String(r.id));
  const map = new Map();
  for (const id of ids) {
    const baza = gtFields.obliczPolaLokalizacji(id).miejsce_na_magazynie;
    if (baza) map.set(id, baza);
  }
  return map;
}

// Kandydaci = SKU z JAKIMKOLWIEK dokumentem strefowym na K4 w oknie (dostawa/zwrot/przywozka/PW,
// rodzaj 1). To granica bezpieczenstwa: towary spoza obiegu K4 nie maja dokumentow na K4.
// Zrodlo: RODZAJE_STREF (jedna mapa rodzajow) - nowy rodzaj dolaczy sie sam, bez ruszania tego pliku.
async function zbierzKandydatow() {
  const listy = await Promise.all(
    Object.values(gtDokumenty.RODZAJE_STREF).map(({ kandydaci }) => kandydaci())
  );
  const ids = new Set();
  for (const lista of listy) for (const k of lista) ids.add(String(k.artykul_gt_id));
  return ids;
}

// SKU noszace NASZ dopisek w GT: Map<tw_Id (string), tw_Pole1 po trim>. DRUGIE zrodlo listy -
// gwarantuje odwracalnosc: zdejmiemy wlasny znacznik takze gdy SKU wypadlo z kandydatow i nie
// ma domu WMS. Rozpoznajemy dopisek po formacie (bezAdnotacjiStref zmienia wartosc), nie po
// tresci. tw_Rodzaj = 1 - odcina ryzyko trafienia w autora/pomieszczenie ksiazki/mebla. LIKE
// '% +%' to pelny skan tw__Towar (nieindeksowalny), ale tabela jest rzedu dziesiatek tys.
// wierszy, a przebieg co 10 min - koszt akceptowalny.
async function pobierzSkuZDopiskiem() {
  const { recordset } = await query(
    `SELECT tw_Id, tw_Pole1 FROM tw__Towar WHERE tw_Rodzaj = 1 AND tw_Pole1 LIKE '% +%'`
  );
  const map = new Map();
  for (const r of recordset) {
    const v = String(r.tw_Pole1 ?? '').trim();
    if (gtFields.bezAdnotacjiStref(v) !== v) map.set(String(r.tw_Id), v);
  }
  return map;
}

async function przelicz() {
  const domyWms = pobierzDomyWms();
  const [kandydaci, zDopiskiem] = await Promise.all([zbierzKandydatow(), pobierzSkuZDopiskiem()]);

  const ids = [...new Set([...domyWms.keys(), ...kandydaci, ...zDopiskiem.keys()])];
  if (!ids.length) return { sprawdzone: 0, zapisane: 0, dopisane: 0, zdjete: 0 };

  const { pobierzStanyGt } = require('./gt-produkty');
  const [polaGt, dokMap, stany] = await Promise.all([
    gtFields.pobierzAktualnePolaLokalizacji(ids),
    gtDokumenty.pobierzDostawyK4(ids),
    pobierzStanyGt(ids),
  ]);

  let zapisane = 0, dopisane = 0, zdjete = 0;
  for (const id of ids) {
    const maDom = domyWms.has(id);
    const obecne = String(polaGt.get(String(id))?.tw_Pole1 ?? '').trim();
    // baza: prawda WMS gdy znamy dom; inaczej adres z GT bez naszego dopisku (albo pusty)
    const base = maDom ? domyWms.get(id) : gtFields.bezAdnotacjiStref(obecne);

    const stanK4 = stany.get(String(id))?.K4?.ilosc ?? 0;
    const suma = maDom ? sumaWmsK4(id) : 0;   // bez domu nie ma kopii polki - caly stan idzie do stref/reszty
    const rozbicie = gtDokumenty.rozbijStanK4(stanK4, suma, dokMap.get(String(id)) || [], {
      artykul_gt_id: id, magazyn: 'K4',
    });
    const adnotacja = gtFields.zbudujAdnotacjeStref(strefyZRozbicia(rozbicie), 50 - base.length);

    const d = gtFields.decyzjaAdnotacji({ base, obecne, adnotacja, maDomWms: maDom });
    if (!d.pisz) continue;

    try {
      await query('UPDATE tw__Towar SET tw_Pole1 = @pole WHERE tw_Id = @id', { pole: d.docelowe, id: Number(id) });
      zapisane++;
      if (d.akcja === 'dopisane') dopisane++; else zdjete++;
    } catch (err) {
      awarie.blad('strefy-w-gt', `tw_Id ${id}: ${err.message}`);
    }
  }

  return { sprawdzone: ids.length, zapisane, dopisane, zdjete };
}

function start(ms = interwalMs()) {
  const timer = setInterval(() => {
    przelicz().catch((err) => awarie.blad('strefy-w-gt', err.message));
  }, ms);
  timer.unref?.();
  return timer;
}

module.exports = { przelicz, start };
