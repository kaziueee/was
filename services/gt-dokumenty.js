'use strict';

// Odczyt dokumentow MM z GT (SQL, tylko-do-odczytu) - do gwarancji numeru MM (Faza A#3).
//
// UWAGA: dok__Dokument.dok_NrPelny NIE jest unikalny - numeracja MM resetuje sie per
// magazyn/rok (np. "MM 181/2026" istnieje 2x, rozne towary/magazyny). Dlatego dokument
// namierzamy po numerze PELNYM + tw_Id pozycji, a jednoznaczny uchwyt to dok_Id (PK).
//
// Schemat GT: naglowki dok__Dokument (dok_Id, dok_NrPelny, dok_Typ=9=MM), pozycje
// dok_Pozycja (klucz ob_DokMagId = dok_Id, ob_TowId, ob_Ilosc).

const { query } = require('./gt-sql');

// Uwagi dokumentu MM (Faza A#3): Node buduje tu cala tresc, ktora most C# wpisuje do
// dok_Uwagi wystawianego dokumentu. Sklada sie z klucza idempotencji + kto + kiedy:
//   "WMS-RUCH:<id> | <operator> | <czas ruchu, strefa PL>"
// Dzieki temu dokument jest samoopisowy: (a) przy ponowieniu ruchu (gdy poprzednia odpowiedz
// HTTP zaginela) odnajdujemy go po kluczu zamiast wystawiac drugi MM; (b) w Subiekcie widac
// kto i kiedy zrobil przesuniecie. Format zna TYLKO Node - most jedynie zapisuje gotowy tekst.
const KLUCZ_PREFIX = 'WMS-RUCH:';
function kluczRuchu(ruchId) { return `${KLUCZ_PREFIX}${ruchId}`; }

// Formatuje czas ruchu (data_ruchu z SQLite jest w UTC bez znacznika strefy) na czas
// scienny w Polsce, np. "02.07.2026 11:45". Niezalezne od strefy serwera Node.
function formatCzasPL(dbTimestamp) {
  if (!dbTimestamp) return '';
  const d = new Date(String(dbTimestamp).replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return String(dbTimestamp);
  return new Intl.DateTimeFormat('pl-PL', {
    timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).format(d).replace(',', '');
}

// Buduje tresc Uwag dokumentu MM (klucz + kto + kiedy). Czas bierzemy z data_ruchu (moment,
// w ktorym magazynier zatwierdzil ruch), a NIE z chwili wystawienia - dzieki temu przy MM
// ponowionym po godzinach dokument pokazuje realny czas przesuniecia, nie czas retry.
function budujUwagiMM(ruchId, operator, dataRuchu) {
  const kto = (operator && String(operator).trim()) || 'WMS';
  const kiedy = formatCzasPL(dataRuchu);
  return kiedy ? `${kluczRuchu(ruchId)} | ${kto} | ${kiedy}` : `${kluczRuchu(ruchId)} | ${kto}`;
}

// Szuka dokumentu MM wystawionego dla danego ruchu WMS (po kluczu w dok_Uwagi). Zwraca
// { dok_Id, dok_NrPelny, ilosc } (najnowszy, gdyby klucz sie powtorzyl), null (brak) albo
// { blad } gdy GT SQL niedostepny. NIGDY nie rzuca - wywolujacy decyduje (prewencja duplikatu).
// Dopasowanie po prefiksie "WMS-RUCH:<id> |" - separator " |" po numerze odcina falszywe
// trafienia (WMS-RUCH:12 nie zlapie WMS-RUCH:123). Id to liczba, wiec brak znakow LIKE.
async function znajdzMMpoKluczu(ruchId) {
  try {
    const { recordset } = await query(
      `SELECT TOP 1 d.dok_Id, d.dok_NrPelny,
              (SELECT SUM(p.ob_Ilosc) FROM dok_Pozycja p WHERE p.ob_DokMagId = d.dok_Id) AS ilosc
       FROM dok__Dokument d
       WHERE d.dok_Uwagi LIKE @wzorzec
       ORDER BY d.dok_Id DESC`,
      { wzorzec: `${kluczRuchu(ruchId)} |%` }
    );
    if (!recordset.length) return null;
    return { dok_Id: recordset[0].dok_Id, dok_NrPelny: recordset[0].dok_NrPelny, ilosc: Number(recordset[0].ilosc) };
  } catch (err) {
    return { blad: err.message };
  }
}

// Namierza dokument MM po numerze pelnym + tw_Id. Zwraca { dok_Id, ilosc } (najnowszy,
// gdy numer sie powtarza) albo null (brak), albo { blad } gdy GT SQL niedostepny.
// NIGDY nie rzuca - wywolujacy decyduje co zrobic (numer i tak juz mamy).
async function znajdzMM(nrPelny, twId) {
  try {
    const { recordset } = await query(
      `SELECT d.dok_Id, SUM(p.ob_Ilosc) AS ilosc
       FROM dok__Dokument d
       JOIN dok_Pozycja p ON p.ob_DokMagId = d.dok_Id
       WHERE d.dok_NrPelny = @nr AND p.ob_TowId = @tw
       GROUP BY d.dok_Id
       ORDER BY d.dok_Id DESC`,
      { nr: nrPelny, tw: Number(twId) }
    );
    if (!recordset.length) return null;
    return { dok_Id: recordset[0].dok_Id, ilosc: Number(recordset[0].ilosc) };
  } catch (err) {
    return { blad: err.message };
  }
}

// Otwarte ZK (zamowienia klienta) rezerwujace dany towar na K4. Rezerwacja GT
// (tw_Stan.st_StanRez) na K4 = suma pozycji otwartych ZK (dok_Typ=16,
// dok_Status=7) na tym magazynie - potwierdzone na zywej bazie: suma pozycji =
// st_StanRez. Ten sam wzorzec co uzupelnienia.js/kanaly.js, tylko per jeden
// towar i ze zwrotem numerow dokumentow (do podgladu "z czego wynika rezerwacja").
//
// ob_TowId = @tow odsiewa pozycje bez towaru (uslugi/notatki maja ob_TowId NULL).
// SUM(ob_Ilosc) per dokument - ten sam towar moze byc w kilku liniach jednego ZK.
// Sort: najnowsze na gorze (data wystawienia malejaco).
//
// dok_NrPelny (np. "ZK 15123/2026") to stabilny numer dokumentu; dok_NrPelnyOryg
// bywa smieciem (reczne ZK maja tam opis typu "NIEZGODNOSCI BRAKI") - dlatego
// oba pola oddajemy, front pokazuje NrPelny jako glowny identyfikator.
//
// Rzuca gdy GT SQL niedostepny - wywolujacy (endpoint) mapuje na 503.
const ZK_TYP = 16;
const ZK_STATUS_OTWARTE = 7;
const MAG_K4 = 4;

async function pobierzZkRezerwujaceK4(twId) {
  const { recordset } = await query(
    `SELECT d.dok_Id, d.dok_NrPelny, d.dok_NrPelnyOryg AS oryg,
            d.dok_DataWyst AS data, SUM(o.ob_Ilosc) AS ilosc
     FROM dok_Pozycja o
     JOIN dok__Dokument d ON d.dok_Id = o.ob_DokHanId
     WHERE d.dok_Typ = @typ AND d.dok_Status = @status
       AND o.ob_TowId = @tow AND o.ob_MagId = @mag
     GROUP BY d.dok_Id, d.dok_NrPelny, d.dok_NrPelnyOryg, d.dok_DataWyst
     ORDER BY d.dok_DataWyst DESC`,
    { typ: ZK_TYP, status: ZK_STATUS_OTWARTE, tow: Number(twId), mag: MAG_K4 }
  );
  return recordset.map((r) => ({
    dok_id: r.dok_Id,
    nr_pelny: r.dok_NrPelny ? String(r.dok_NrPelny).trim() : null,
    oryg: r.oryg ? String(r.oryg).trim() : null,
    data: r.data instanceof Date ? r.data.toISOString().slice(0, 10) : null,
    ilosc: Number(r.ilosc) || 0,
  }));
}

module.exports = { znajdzMM, znajdzMMpoKluczu, kluczRuchu, budujUwagiMM, pobierzZkRezerwujaceK4 };
