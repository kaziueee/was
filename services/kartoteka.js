'use strict';

// Odswiezanie KOPII kartoteki GT w WMS: symbol, nazwa i EAN w `stany_lokalizacji`.
//
// PO CO (incydent SES66146E/SES66146B, 2026-09-16 - "Ulica Sezamkowa"):
// kopia symbolu zapisywana jest raz, przy wstawieniu wiersza, i nic jej dotad nie odswiezalo.
// W Subiekcie ktos zamienil symbole dwoch kart plusza (tw_Id 93795 dostalo `SES66146B` "Bert",
// a `SES66146E` przeszlo na tw_Id 93796 "Erni") - i od tej chwili:
//   - skan `SES66146E` sklejal DWA towary w jedna karte (49 szt. Berta pokazane jako Erni),
//     bo lookup szedl po kopii symbolu, a ta wskazywala na oba tw_Id,
//   - skan `SES66146B` mowil "brak lokalizacji WMS" mimo 39 szt. na polkach, bo ZADEN wiersz
//     nie nosil jeszcze nowego symbolu. Magazynier zaczal wiec przypisywac towar od nowa -
//     w 40 minut powstalo 8 prawdziwych dokumentow MM w GT.
// Tozsamosc rozstrzyga dzis GT (routes/lokalizacje.js pyta WMS po tw_Id), ale kopia i tak musi
// byc aktualna: to ona jest etykieta na kazdej liscie, wchodzi do wyszukiwania po nazwie,
// do rozjazdow i do awaryjnego lookupu, gdy GT nie odpowiada.
//
// Odswiezamy DWOMA drogami, bo zadna sama nie wystarcza:
//   1. przy skanie (odswiezZProduktu) - towar dotykany na biezaco naprawia sie natychmiast,
//   2. jobem raz na dobe (start) - reszta asortymentu nie czeka na to, az ktos ja zeskanuje.
// Czyste reguly porownania siedza w kartoteka-model.js (testowalne bez SQLite i GT).
//
// CZEGO NIE RUSZAMY: `ruchy` i `audyt`. Tam symbol jest zapisem historycznym - tak nazywal sie
// towar w chwili zdarzenia. Przepisanie go zacieraloby slad, ktory wlasnie pozwolil odtworzyc
// ten incydent. Otwarte rozjazdy odswiezaja sie same - job rozjazdow czyta symbol z tej kopii.

const db = require('../db/database');
const audyt = require('./audyt');
const awarie = require('./awarie');
const { roznice } = require('./kartoteka-model');
const { interwalMsZMinut } = require('./interwal');

const DOMYSLNY_INTERWAL_MIN = 24 * 60;
// Pierwszy przebieg krotko po starcie: na pececie WMS bywa restartowany rzadziej niz raz na
// dobe, ale gdy juz jest - kopia ma sie naprawic od razu, a nie za 24 h.
const OPOZNIENIE_STARTU_MS = 2 * 60 * 1000;
const PACZKA_SQLITE = 400;   // limit zmiennych w zapytaniu SQLite (SQLITE_MAX_VARIABLE_NUMBER)

function interwalMs() {
  return interwalMsZMinut(process.env.WMS_KARTOTEKA_INTERWAL_MIN, DOMYSLNY_INTERWAL_MIN, 'kartoteka');
}

// Znormalizowana karta GT ({symbol, nazwa, ean}) z wiersza tw__Towar.
function kartaZTowaru(towar) {
  return { symbol: towar.tw_Symbol, nazwa: towar.tw_Nazwa, ean: towar.tw_PodstKodKresk };
}

// Wiersze kopii - wszystkie albo tylko dla podanych tw_Id. Bierzemy TAKZE wiersze z iloscia 0
// (dom K4 przezywa stan 0 - zob. inwariant w CLAUDE.md); one tez maja etykiete do poprawienia.
function wierszeKopii(idy = null) {
  const kolumny = 'id, artykul_gt_id, artykul_symbol, artykul_nazwa, artykul_ean';
  if (!idy) return db.prepare(`SELECT ${kolumny} FROM stany_lokalizacji`).all();

  const lista = [...new Set(idy.map(String))];
  const wynik = [];
  for (let i = 0; i < lista.length; i += PACZKA_SQLITE) {
    const paczka = lista.slice(i, i + PACZKA_SQLITE);
    const znaki = paczka.map(() => '?').join(', ');
    wynik.push(...db.prepare(
      `SELECT ${kolumny} FROM stany_lokalizacji WHERE artykul_gt_id IN (${znaki})`
    ).all(...paczka));
  }
  return wynik;
}

// Zapisuje wyliczone zmiany. Wpis do Logu zmian idzie JEDEN NA ARTYKUL (nie na wiersz) i tylko
// dla zmiany tozsamosci - patrz rodzajZmiany w kartoteka-model.js.
function zapisz(zmiany, { uzytkownik }) {
  const opisane = new Set();
  let wierszy = 0;

  db.exec('BEGIN');
  try {
    for (const { wiersz, zmiany: pola } of zmiany) {
      const ustawienia = Object.keys(pola).map((k) => `${k} = ?`).join(', ');
      db.prepare(`UPDATE stany_lokalizacji SET ${ustawienia} WHERE id = ?`)
        .run(...Object.values(pola), wiersz.id);
      wierszy++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  for (const { wiersz, zmiany: pola, rodzaj } of zmiany) {
    if (rodzaj !== 'tozsamosc' || opisane.has(wiersz.artykul_gt_id)) continue;
    opisane.add(wiersz.artykul_gt_id);
    audyt.zapisz({
      uzytkownik,
      akcja: 'kartoteka_sync',
      artykul_gt_id: wiersz.artykul_gt_id,
      artykul_symbol: pola.artykul_symbol ?? wiersz.artykul_symbol,
      przed: { symbol: wiersz.artykul_symbol, nazwa: wiersz.artykul_nazwa },
      po: {
        symbol: pola.artykul_symbol ?? wiersz.artykul_symbol,
        nazwa: pola.artykul_nazwa ?? wiersz.artykul_nazwa,
      },
      wynik: 'ok',
    });
  }

  return wierszy;
}

// Raport z przebiegu - liczby osobno dla tozsamosci i dla samego EAN, bo przy pierwszym
// uruchomieniu tych drugich sa tysiace i bez rozdzielenia nie widac tych kilku waznych.
function raport(zmiany, { sprawdzone, zapisane }) {
  const tozsamosc = zmiany.filter((z) => z.rodzaj === 'tozsamosc');
  return {
    sprawdzone,
    zapisane,
    tozsamosc: tozsamosc.length,
    ean: zmiany.length - tozsamosc.length,
    artykuly: [...new Map(tozsamosc.map((z) => [z.wiersz.artykul_gt_id, {
      artykul_gt_id: z.wiersz.artykul_gt_id,
      symbol: { z: z.wiersz.artykul_symbol, na: z.zmiany.artykul_symbol ?? z.wiersz.artykul_symbol },
      nazwa: { z: z.wiersz.artykul_nazwa, na: z.zmiany.artykul_nazwa ?? z.wiersz.artykul_nazwa },
    }])).values()],
  };
}

// Odswieza kopie dla podanych tw_Id (albo dla calego WMS, gdy idy = null).
// `probne` = policz i zwroc raport, nic nie zapisuj (tryb skryptu).
async function odswiez({ idy = null, probne = false, uzytkownik = 'system:kartoteka' } = {}) {
  const wiersze = wierszeKopii(idy);
  if (wiersze.length === 0) return raport([], { sprawdzone: 0, zapisane: 0 });

  const { pobierzPodstawoweInfo } = require('./gt-produkty');
  const info = await pobierzPodstawoweInfo([...new Set(wiersze.map((w) => w.artykul_gt_id))]);
  const kartyGt = new Map([...info].map(([id, towar]) => [id, kartaZTowaru(towar)]));

  const zmiany = roznice(wiersze, kartyGt);
  const zapisane = (!probne && zmiany.length > 0) ? zapisz(zmiany, { uzytkownik }) : 0;
  return raport(zmiany, { sprawdzone: wiersze.length, zapisane });
}

// Odswiezenie przy skanie: tozsamosc mamy juz z GT (znajdzTowarPoKodzie), wiec zadnego
// zapytania nie dokladamy. Best-effort i SYNCHRONICZNE - to tylko poprawka etykiety,
// nie moze przerwac ani opoznic odpowiedzi na skan.
function odswiezZProduktu(produktGt) {
  if (!produktGt?.artykul_gt_id) return 0;
  try {
    const wiersze = wierszeKopii([produktGt.artykul_gt_id]);
    if (wiersze.length === 0) return 0;
    const kartyGt = new Map([[String(produktGt.artykul_gt_id), {
      symbol: produktGt.symbol, nazwa: produktGt.nazwa, ean: produktGt.ean,
    }]]);
    const zmiany = roznice(wiersze, kartyGt);
    return zmiany.length > 0 ? zapisz(zmiany, { uzytkownik: 'system:kartoteka' }) : 0;
  } catch (err) {
    awarie.blad('kartoteka', `odswiezanie po skanie tw_Id ${produktGt.artykul_gt_id}: ${err.message}`);
    return 0;
  }
}

function start(ms = interwalMs()) {
  const uruchom = () => odswiez().catch((err) => awarie.blad('kartoteka', err.message));
  const pierwszy = setTimeout(uruchom, OPOZNIENIE_STARTU_MS);
  pierwszy.unref?.();
  const timer = setInterval(uruchom, ms);
  timer.unref?.();
  return timer;
}

module.exports = { odswiez, odswiezZProduktu, start };
