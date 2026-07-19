'use strict';

// Job adnotacji stref w tw_Pole1: dopisuje do adresu K4 informacje, ILE sztuk lezy poza polka.
//   "M2-J14-P2"  ->  "M2-J14-P2 +D20 +Z3"
//
// PO CO: pole "Miejsce na magazynie" to jedyne, co widzi czlowiek szukajacy towaru z poziomu
// GT (wydruk, wyszukiwanie w Subiekcie). Gdy polka jest pusta, a 20 szt. z dostawy stoi na
// palecie w strefie, pole mowilo tylko adres pustej polki - i czlowiek odchodzil z niczym.
// Strefy istnialy WYLACZNIE w WMS (karta produktu, kolumna Strefa na desktopie).
//
// DLACZEGO JOB, A NIE ZAPIS PRZY RUCHU: strefa zmienia sie, gdy w GT pojawi sie dokument -
// czyli w momencie, gdy WMS nic nie robi i nie ma sie od czego odpalic. Bez cyklicznego
// przeliczania dopisek by sie zestarzal, a nieaktualne "+Z3" po odniesieniu towaru jest
// GORSZE niz jego brak: wysyla czlowieka po cos, czego juz nie ma.
//
// ZAKRES: tylko SKU, ktorym WMS zna dom na K4. Dopisek OZDABIA adres, wiec bez adresu nie ma
// czego ozdabiac - a pisanie w tw_Pole1 towarow spoza naszego obiegu jest niebezpieczne:
// w innych kategoriach (ksiazki, meble) to pole znaczy autor/pomieszczenie (zob. CLAUDE.md).
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

async function przelicz() {
  const sku = db.prepare(
    `SELECT DISTINCT s.artykul_gt_id AS id FROM stany_lokalizacji s
     JOIN lokalizacje l ON l.id = s.lokalizacja_id WHERE l.magazyn = 'K4'`
  ).all().map((r) => r.id);
  if (!sku.length) return { sprawdzone: 0, zapisane: 0, dopisane: 0, zdjete: 0 };

  const [polaGt, dokMap] = await Promise.all([
    gtFields.pobierzAktualnePolaLokalizacji(sku),
    gtDokumenty.pobierzDostawyK4(sku),
  ]);

  const sumaWmsK4 = (id) => Number(db.prepare(
    `SELECT COALESCE(SUM(s.ilosc), 0) AS suma FROM stany_lokalizacji s
     JOIN lokalizacje l ON l.id = s.lokalizacja_id WHERE l.magazyn = 'K4' AND s.artykul_gt_id = ?`
  ).get(String(id)).suma) || 0;

  const { pobierzStanyGt } = require('./gt-produkty');
  const stany = await pobierzStanyGt(sku);

  let zapisane = 0, dopisane = 0, zdjete = 0;
  for (const id of sku) {
    const baza = gtFields.obliczPolaLokalizacji(id).miejsce_na_magazynie;
    if (!baza) continue;                       // brak domu w WMS - nie ma czego ozdabiac

    const stanK4 = stany.get(String(id))?.K4?.ilosc ?? 0;
    const rozbicie = gtDokumenty.rozbijStanK4(stanK4, sumaWmsK4(id), dokMap.get(String(id)) || [], {
      artykul_gt_id: id, magazyn: 'K4',
    });
    const adnotacja = gtFields.zbudujAdnotacjeStref(strefyZRozbicia(rozbicie), 50 - baza.length);
    const docelowe = `${baza}${adnotacja}`;

    const obecne = String(polaGt.get(String(id))?.tw_Pole1 ?? '').trim();
    if (obecne === docelowe) continue;

    // Nie ruszamy pola, ktorego BAZA sie nie zgadza - to znaczy, ze GT ma tam cos innego niz
    // adres z WMS (reczna edycja albo zalegly sync). Poprawianie adresu to robota
    // synchronizujLokalizacje przy ruchu, nie tego joba - on odpowiada tylko za dopisek.
    if (gtFields.bezAdnotacjiStref(obecne) !== baza) continue;

    try {
      await query('UPDATE tw__Towar SET tw_Pole1 = @pole WHERE tw_Id = @id', { pole: docelowe, id: Number(id) });
      zapisane++;
      if (adnotacja) dopisane++; else zdjete++;
    } catch (err) {
      awarie.blad('strefy-w-gt', `tw_Id ${id}: ${err.message}`);
    }
  }

  return { sprawdzone: sku.length, zapisane, dopisane, zdjete };
}

function start(ms = interwalMs()) {
  const timer = setInterval(() => {
    przelicz().catch((err) => awarie.blad('strefy-w-gt', err.message));
  }, ms);
  timer.unref?.();
  return timer;
}

module.exports = { przelicz, start };
