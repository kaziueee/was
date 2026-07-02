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

module.exports = { znajdzMM, znajdzMMpoKluczu, kluczRuchu, budujUwagiMM };
