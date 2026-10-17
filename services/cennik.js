'use strict';

// Wycena towaru po SKU/EAN: koszt zakupu z GT (tw_Cena.tc_CenaNetto0, zlaczenie tc_IdTowar=tw_Id)
// + waga rozliczeniowa DHL z GT + reguly rynkow z config/rynki. Polaczenie read-only (gt-sql).
//
// Waga rozliczeniowa = max(rzeczywista, gabarytowa). Ktora gabarytowa:
//   rzeczywista  = pw_Dane.pwd_Tekst06 ("Waga produktu")
//   gab. karton  = pw_Dane.pwd_Tekst10 ("Waga gabarytowa karton DHL") - domyslnie
//   gab. zwykla  = pw_Dane.pwd_Tekst09 ("Waga gabarytowa DHL", z wymiarow produktu)
// KARTON WLASNY ("Ilosc w opakowaniu zbiorczym" pwd_Tekst04 = 1): towar jedzie we wlasnym pudelku
//   -> gab. ZWYKLA (Tekst09), nie kartonowa (Tekst10). Rozpoznaje maWlasnyKarton (ta sama regula co docinka).
// DOCINANIE: "docinalny" liczymy TA SAMA funkcja co pole "Docinanie kartonu" w WMS (ocenDocinkeZListy:
//   prog 5 kg, zapas 0,5 cm, lista kartonow z DB, wylaczenie wlasnych kartonow) - dzieki temu cennik
//   zgadza sie z rekomendacja z ekranu Parametry i dziala tak samo w kopii i na produkcji. Gdy globalny
//   checkbox "uwzglednij docinanie" wlaczony, caly cennik DHL liczy sie o 1 prog nizej (config/rynki).
//   Uwaga: pwd_Tekst10 (deklarowane kurierowi) zostaje NIEdociete - docinanie to tylko podpowiedz ceny.

const { query } = require('./gt-sql');
const rynki = require('../config/rynki');
const kartony = require('./kartony');                               // lista kartonow (DB) - do oceny docinki
const { maWlasnyKarton, ocenDocinkeZListy } = require('../config/kartony');
const { rozbierzWymiary } = require('./gt-atrybuty');
const { kosztZakupu } = require('./zestawy-model');

// tekst GT ("0,874" albo "1.31") -> liczba; 0 gdy brak/niepoprawne.
function liczba(v) {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

// Zestaw (rodzaj 8): koszt = suma składników (services/zestawy-model.js kosztZakupu). Podzapytania liczą
// się dla każdego wiersza, ale zwykły towar nie ma wierszy w tw_Komplet, więc to tani pusty lookup.
const KOLUMNY = `t.tw_Id, t.tw_Symbol, t.tw_Nazwa, t.tw_Rodzaj AS rodzaj, c.tc_CenaNetto0 AS koszt,
            (SELECT SUM(k.kpl_Liczba * cs.tc_CenaNetto0) FROM tw_Komplet k
               JOIN tw_Cena cs ON cs.tc_IdTowar = k.kpl_IdSkladnik WHERE k.kpl_IdKomplet = t.tw_Id) AS kosztSkladnikow,
            (SELECT COUNT(*) FROM tw_Komplet k WHERE k.kpl_IdKomplet = t.tw_Id) AS skladnikow,
            (SELECT COUNT(*) FROM tw_Komplet k LEFT JOIN tw_Cena cs ON cs.tc_IdTowar = k.kpl_IdSkladnik
               WHERE k.kpl_IdKomplet = t.tw_Id AND ISNULL(cs.tc_CenaNetto0, 0) <= 0) AS skladnikowBezCeny,
            pw.pwd_Tekst06 AS wagaRzecz, pw.pwd_Tekst10 AS gabKarton, pw.pwd_Tekst09 AS gabZwykla,
            pw.pwd_Tekst07 AS wymiary, pw.pwd_Tekst04 AS zbiorcze
       FROM tw__Towar t
       JOIN tw_Cena c ON c.tc_IdTowar = t.tw_Id
       LEFT JOIN pw_Dane pw ON pw.pwd_TypObiektu = -14 AND pw.pwd_IdObiektu = t.tw_Id`;

async function wycenaPoSku(sku, nadpisz = {}) {
  const r = await query(`SELECT TOP 1 ${KOLUMNY} WHERE t.tw_Symbol = @sku OR t.tw_PodstKodKresk = @sku`, { sku });
  const row = r.recordset[0];
  if (!row) return null;
  return wycenaZWiersza(row, nadpisz);
}

// Wycena wielu towarów naraz po tw_Id — jedno zapytanie na paczkę zamiast jednego na towar
// (repricer wycenia ~2000 ofert na przebieg; pojedyncze zapytania przez VPN zrywały pulę połączeń).
// Ta sama matematyka co wycenaPoSku (wycenaZWiersza). Zwraca Map(tw_Id → wycena).
async function wycenaHurtem(twIds, nadpisz = {}) {
  const ids = [...new Set(twIds.map(Number).filter((x) => Number.isInteger(x) && x > 0))];
  const wynik = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const paczka = ids.slice(i, i + 500);                       // liczby całkowite — bezpieczne w IN
    const r = await query(`SELECT ${KOLUMNY} WHERE t.tw_Id IN (${paczka.join(',')})`);
    for (const row of r.recordset) wynik.set(row.tw_Id, wycenaZWiersza(row, nadpisz));
  }
  return wynik;
}

function wycenaZWiersza(row, nadpisz = {}) {

  const kz = kosztZakupu(row);   // zestaw: suma składników; zwykły towar: kartoteka
  const koszt = kz.koszt;
  const rzecz = liczba(row.wagaRzecz);
  const gabZwykla = liczba(row.gabZwykla);   // pwd_Tekst09 (z wymiarow produktu)
  const gabKarton = liczba(row.gabKarton);   // pwd_Tekst10 (z najmniejszego kartonu WMS)

  // Karton wlasny (ilosc w opak. zbiorczym = 1) -> gab. zwykla; inaczej kartonowa.
  const kartonWlasny = maWlasnyKarton(row.zbiorcze);
  const gab = kartonWlasny ? (gabZwykla || gabKarton) : (gabKarton || gabZwykla);
  let wagaGT = Math.max(rzecz, gab);
  const wagaZnana = wagaGT > 0;
  if (!wagaZnana) wagaGT = rynki.DOMYSLNE.waga; // brak wymiarow w GT -> domyslna

  // Docinalny = ta sama ocena co pole "Docinanie kartonu" w WMS (lista kartonow z DB + wymiary z GT).
  let docinalny = false;
  try {
    const ocena = ocenDocinkeZListy(
      kartony.aktywneKartony(), rozbierzWymiary(row.wymiary), rzecz, { iloscZbiorcze: row.zbiorcze });
    docinalny = !!(ocena && ocena.potrzebna);
  } catch { docinalny = false; }

  const docinanieOn = !!nadpisz.docinanieOn;          // globalny checkbox z panelu
  const docinanieAktywne = docinalny && docinanieOn;  // faktycznie obniza prog DHL

  // waga reczna z panelu nadpisuje; inaczej waga rozliczeniowa z GT
  const waga = nadpisz.waga != null ? +nadpisz.waga : wagaGT;

  // Genius na eMAG: rozstrzyga oferta z API eMAG (nadpisz.genius — przekazuje repricer), a gdy jej
  // nie ma, wymiary z GT: towar za duzy do automatu nie dostanie dostawy do automatu, wiec i Genius.
  // null = nie wiemy (brak wymiarow) -> kalkulator liczy jak Genius (wiekszosc paczek).
  const automat = rynki.miesciSieWAutomacie(rozbierzWymiary(row.wymiary));
  const genius = typeof nadpisz.genius === 'boolean' ? nadpisz.genius : automat;
  const geniusZrodlo = typeof nadpisz.genius === 'boolean' ? 'api' : automat == null ? null : 'wymiary';

  // nadpisania preset (DOMYSLNE) z panelu
  // Paczka do wyceny wysyłki wg gabarytu (Empik): towar w najmniejszym pasującym kartonie, a we własnym
  // kartonie albo za duży na każdy karton — sam towar. null = brak wymiarów w GT.
  const wymiary = rozbierzWymiary(row.wymiary);
  let paczka = wymiary;
  if (wymiary && !kartonWlasny) { try { paczka = kartony.dobierzKarton(wymiary) || wymiary; } catch { paczka = wymiary; } }

  const over = { waga, docinanie: docinalny, docinanieOn, genius, paczka };
  if (nadpisz.tryb) over.tryb = nadpisz.tryb;
  if (nadpisz.bufor != null) over.bufor = +nadpisz.bufor;
  if (nadpisz.anchor && nadpisz.anchor.nazwa) over.anchor = nadpisz.anchor; // reczna cena na Allegro/Amazon DE

  return {
    sku: row.tw_Symbol,
    nazwa: row.tw_Nazwa,
    koszt,
    kosztZrodlo: kz.zrodlo,        // 'kartoteka' | 'skladniki' (zestaw)
    kosztKartoteka: kz.kartoteka,  // zestaw: cena zakupu z kartoteki zestawu — do pokazania obok
    kosztUwaga: kz.uwaga || null,
    waga,
    wagaGT,
    wagaZnana,
    kartonWlasny,
    docinalny,           // czy towar jest docinalny (ocena jak w WMS)
    docinanieOn,         // stan checkboxa
    docinanieAktywne,    // czy faktycznie obnizono prog DHL
    genius,              // eMAG: true/false/null (null = nie wiemy -> liczone jak Genius)
    paczka,              // wymiary paczki (karton albo towar) — wysyłka wg gabarytu (Empik)
    geniusZrodlo,        // 'api' | 'wymiary' | null
    tryb: over.tryb || rynki.DOMYSLNE.tryb,
    bufor: over.bufor != null ? over.bufor : rynki.DOMYSLNE.bufor,
    rynki: rynki.policzWszystkie(koszt, over),
  };
}

module.exports = { wycenaPoSku, wycenaHurtem };
