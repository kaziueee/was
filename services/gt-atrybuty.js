'use strict';

// Atrybuty produktowe (wymiary, waga, waga gabarytowa) w polach wlasnych GT.
// To NIE sa stany magazynowe - GT jest tu zwyklym magazynem danych opisowych,
// wiec zapis idzie bezposrednim SQL-em, tak samo jak lokalizacje w gt-fields.js
// (patrz komentarz przy synchronizujLokalizacje). Most/Sfera obsluguje wylacznie
// dokumenty MM.
//
// Mapowanie na kolumny GT (potwierdzone na danych Z_KAJTEK_IdeaERP 2026-07-16):
//   Wymiary             -> pw_Dane.pwd_Tekst07   np. "25,5x17,5x5,5" (dl x szer x wys, cm)
//   Waga produktu       -> pw_Dane.pwd_Tekst06   w KILOGRAMACH
//   Waga gabarytowa DHL -> pw_Dane.pwd_Tekst09   w kg, wyliczana, nigdy z klienta
//
// pw_Dane trzyma wartosci pol wlasnych WSZYSTKICH obiektow; wiersz towaru jest
// identyfikowany przez (pwd_TypObiektu = -14, pwd_IdObiektu = tw_Id). Wiekszosc
// towarow nie ma tam wiersza wcale - dlatego zapis to UPSERT, nie UPDATE.
//
// pwd_Id: nie jest IDENTITY, ALE GT ma dla niego licznik - tabela ins_ident (ido_nazwa='pw_Dane',
// ido_wartosc = nastepny wolny numer), podbijana atomowo procedura spIdentyfikator. WMS alokuje
// pwd_Id przez spIdentyfikator (tak jak Sfera), NIGDY przez MAX(pwd_Id)+1 - MAX+1 omija ten licznik
// i rozjezdza numeracje GT ("naruszenie integralnosci danych" przy zapisie pol wlasnych, takze
// recznym w Subiekcie). ab_Licznik to faktycznie konfiguracja przypomnien, nie generator.
// Historia incydentu: pamiec projektu pwdane-insert-psuje-licznik-gt.

const { query } = require('./gt-sql');
const { MAGAZYN_GT_ID, MAGAZYNY_WMS } = require('../config/magazyny');
const kartony = require('./kartony');

const TYP_OBIEKTU_TOWAR = -14;

// Nazwa licznika w ins_ident, z ktorego spIdentyfikator alokuje kolejny pwd_Id (= nazwa tabeli).
const IDENT_NAZWA_PW_DANE = 'pw_Dane';

// Magazyny, na ktorych "towar u nas lezy" - stad bierzemy kandydatow do uzupelnienia
// parametrow. Z konfiguracji, nie z recznej listy: dodanie magazynu WMS ma je dociagnac
// samo (zob. CLAUDE.md, lekcja o fan-oucie wariantu bez recznej listy).
const MAGAZYNY_STANU_GT = MAGAZYNY_WMS.map((kod) => MAGAZYN_GT_ID[kod]).filter(Number.isInteger);

const KOLUMNY = {
  wymiary: 'pwd_Tekst07',
  waga: 'pwd_Tekst06',
  waga_gabarytowa: 'pwd_Tekst09',
  // Waga gabarytowa "z kartonu": najmniejszy pasujacy karton (fallback goly wymiar), liczona
  // z EDYTOWALNEJ listy kartonow (services/kartony). Osobne pole OBOK waga_gabarytowa - istniejacej
  // wagi z golych wymiarow NIE ruszamy. Pole wlasne GT "Waga gabarytowa karton DHL" = pwd_Tekst10
  // (zalozone przez usera 2026-07-23, potwierdzone w pw_Pole). Ustawione na null = feature "uspiony"
  // (liczymy i pokazujemy, ale nie czytamy/piszemy w GT) - bylo tak do czasu zalozenia pola.
  waga_gabarytowa_karton: 'pwd_Tekst10',
};

// Dzielnik wolumetryczny DHL: (dl * szer * wys w cm) / 4000 = kg.
const DZIELNIK_DHL = 4000;
// Ponizej tej wartosci waga gabarytowa i tak nie ma znaczenia dla kuriera, ale "0,00"
// wyglada jak brak danych - wpisujemy minimum, zeby odroznic drobiazg od luki.
const WAGA_GAB_MIN = 0.01;
// Powyzej tego wymiaru (cm) to niemal na pewno blad w danych zrodlowych, nie towar.
const WYMIAR_PODEJRZANY_CM = 150;
const WYMIAR_MAX_CM = 1000;

// Tekst z GT -> liczba. Akceptuje przecinek i kropke, obcina sufiks jednostki.
function liczba(wartosc) {
  if (wartosc === null || wartosc === undefined) return null;
  const tekst = String(wartosc).trim().toLowerCase().replace(/\s/g, '').replace(/(kg|cm|g)$/, '');
  if (tekst === '') return null;
  const n = Number(tekst.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// Liczba -> tekst dla GT: przecinek dziesietny, bez zbednych zer ("0,5" nie "0,500").
function formatuj(n, miejsca = 3) {
  const zaokraglone = Number(n).toFixed(miejsca);
  return zaokraglone.replace(/0+$/, '').replace(/\.$/, '').replace('.', ',');
}

// "25,5x17,5x5,5" -> {dlugosc, szerokosc, wysokosc}; null gdy sie nie da rozebrac.
function rozbierzWymiary(tekst) {
  if (!tekst) return null;
  const czesci = String(tekst).trim().toLowerCase().split('x');
  if (czesci.length !== 3) return null;
  const [dlugosc, szerokosc, wysokosc] = czesci.map(liczba);
  if ([dlugosc, szerokosc, wysokosc].some((n) => n === null)) return null;
  return { dlugosc, szerokosc, wysokosc };
}

function zlozWymiary({ dlugosc, szerokosc, wysokosc }) {
  return [dlugosc, szerokosc, wysokosc].map((n) => formatuj(n, 2)).join('x');
}

// Waga gabarytowa DHL w kg jako tekst, zawsze 2 miejsca po przecinku.
// Zwraca null gdy wymiarow brak - wtedy pole w GT ma zostac wyczyszczone,
// zeby nie zostawala wartosc wyliczona z poprzednich wymiarow.
function liczWageGabarytowa(wymiary) {
  if (!wymiary) return null;
  const { dlugosc, szerokosc, wysokosc } = wymiary;
  const kg = (dlugosc * szerokosc * wysokosc) / DZIELNIK_DHL;
  return Math.max(kg, WAGA_GAB_MIN).toFixed(2).replace('.', ',');
}

// Sprawdza wymiary wpisane przez czlowieka. Zwraca {blad} albo {wymiary, ostrzezenia}.
// Zero jest bledem, nie "malym wymiarem" - w danych z BaseLinkera trafily sie wpisy
// typu "0x65x53", ktore po cichu daja bezsensowna wage gabarytowa.
function sprawdzWymiary(wejscie) {
  const wymiary = typeof wejscie === 'string' ? rozbierzWymiary(wejscie) : wejscie;
  if (!wymiary) return { blad: 'Wymiary: podaj trzy liczby w formacie dlugosc x szerokosc x wysokosc.' };

  const pola = [
    ['dlugosc', 'Dlugosc'],
    ['szerokosc', 'Szerokosc'],
    ['wysokosc', 'Wysokosc'],
  ];
  const ostrzezenia = [];
  for (const [klucz, etykieta] of pola) {
    const n = liczba(wymiary[klucz]);
    if (n === null) return { blad: `${etykieta}: nie jest liczba.` };
    if (n <= 0) return { blad: `${etykieta}: musi byc wieksza od zera.` };
    if (n > WYMIAR_MAX_CM) return { blad: `${etykieta}: ${formatuj(n, 2)} cm to wartosc nierealna.` };
    if (n > WYMIAR_PODEJRZANY_CM) ostrzezenia.push(`${etykieta} ${formatuj(n, 2)} cm - sprawdz, czy to na pewno cm.`);
    wymiary[klucz] = n;
  }
  return { wymiary, ostrzezenia };
}

// Waga produktu w kg. Pole w GT historycznie mialo MIESZANE jednostki (liczby calkowite
// = gramy, liczby z przecinkiem = kilogramy), dlatego z UI przyjmujemy wylacznie kg
// i nigdy nie zgadujemy jednostki po ksztalcie liczby.
function sprawdzWage(wejscie) {
  const n = liczba(wejscie);
  if (n === null) return { blad: 'Waga: nie jest liczba.' };
  if (n <= 0) return { blad: 'Waga: musi byc wieksza od zera.' };
  if (n > 500) return { blad: `Waga: ${formatuj(n, 3)} kg to wartosc nierealna.` };
  return { waga: n };
}

// Odczyt atrybutow dla listy tw_Id. Zwraca Map<tw_Id jako string, {...}>;
// towary bez wiersza w pw_Dane po prostu nie trafiaja do mapy.
async function pobierzAtrybuty(twIds) {
  const wynik = new Map();
  const idy = [...new Set(twIds.map(Number).filter(Number.isFinite))];
  if (idy.length === 0) return wynik;

  // Limit ~2100 parametrow na zapytanie - idy sa liczbami z walidacji powyzej,
  // wiec wstawiamy je wprost, ale paczkujemy dla rozmiaru zapytania.
  for (let i = 0; i < idy.length; i += 900) {
    const paczka = idy.slice(i, i + 900);
    const res = await query(
      `SELECT pwd_IdObiektu,
              ${KOLUMNY.wymiary} AS wymiary,
              ${KOLUMNY.waga} AS waga,
              ${KOLUMNY.waga_gabarytowa} AS waga_gabarytowa
       FROM pw_Dane
       WHERE pwd_TypObiektu = ${TYP_OBIEKTU_TOWAR} AND pwd_IdObiektu IN (${paczka.join(',')})`
    );
    for (const w of res.recordset) {
      const rozbite = rozbierzWymiary(w.wymiary);
      // Waga gabarytowa "z kartonu" liczona NA ZYWO z wymiarow + aktualnej listy kartonow
      // (deterministyczna, nie musi byc czytana z GT). karton_kod = w jaki karton, albo null
      // gdy fallback na goly wymiar / brak wymiarow.
      const karton = rozbite ? kartony.liczWageGabarytowaKarton(rozbite) : null;
      wynik.set(String(w.pwd_IdObiektu), {
        wymiary: w.wymiary || null,
        rozbite,
        waga: w.waga || null,
        waga_gabarytowa: w.waga_gabarytowa || null,
        waga_gabarytowa_karton: karton?.waga ?? null,
        karton_kod: karton?.karton_kod ?? null,
        karton_zrodlo: karton?.zrodlo ?? null,
      });
    }
  }
  return wynik;
}

// UPSERT atrybutow jednego towaru. Brak klucza w `zmiany` = nie ruszaj pola.
// Waga gabarytowa NIE jest przyjmowana z zewnatrz - zawsze wyliczamy ja z wymiarow,
// zeby nie dalo sie zapisac wartosci niespojnej z wymiarami.
// Nie rzuca - zwraca {ok, dane} albo {ok:false, blad}, jak gt-fields.js.
async function zapiszAtrybuty(artykulGtId, zmiany) {
  const id = Number(artykulGtId);
  if (!Number.isFinite(id)) return { ok: false, blad: 'Bledny identyfikator artykulu.' };

  // [{kolumna, parametr}] zamiast gotowych fragmentow SQL - z tego skladamy i SET, i INSERT.
  // Wczesniej fragmenty "kol = @param" byly rozbierane z powrotem przez split('='), czyli
  // informacja byla budowana i natychmiast parsowana od nowa.
  const pola = [];
  const parametry = { id };
  const zapisane = {};

  if ('wymiary' in zmiany) {
    let wymiary = null;
    if (zmiany.wymiary !== null) {
      // Blad walidacji MUSI przerwac zapis. Wczesniej `.wymiary` bylo wtedy undefined,
      // co dawalo pusty string - czyli bledne wejscie po cichu CZYSCILO wymiary
      // i wage gabarytowa zamiast odmowic.
      const sprawdzone = sprawdzWymiary(zmiany.wymiary);
      if (sprawdzone.blad) return { ok: false, blad: sprawdzone.blad };
      wymiary = sprawdzone.wymiary;
    }
    const tekst = wymiary ? zlozWymiary(wymiary) : '';
    pola.push({ kolumna: KOLUMNY.wymiary, parametr: '@wymiary' });
    parametry.wymiary = tekst;
    zapisane.wymiary = tekst || null;

    // Wymiary i waga gabarytowa zmieniaja sie razem albo wcale.
    const gab = liczWageGabarytowa(wymiary);
    pola.push({ kolumna: KOLUMNY.waga_gabarytowa, parametr: '@wagaGab' });
    parametry.wagaGab = gab ?? '';
    zapisane.waga_gabarytowa = gab;

    // Waga gabarytowa "z kartonu" (najmniejszy pasujacy karton, fallback goly wymiar). Zawsze
    // trafia do `zapisane` (API/podglad); do GT pisana tylko gdy kolumna skonfigurowana - dopoki
    // placeholder=null, pole w GT jeszcze nie istnieje, wiec nie dokladamy go do UPSERT-a.
    const kartonWaga = wymiary ? kartony.liczWageGabarytowaKarton(wymiary) : null;
    zapisane.waga_gabarytowa_karton = kartonWaga?.waga ?? null;
    zapisane.karton_kod = kartonWaga?.karton_kod ?? null;
    zapisane.karton_zrodlo = kartonWaga?.zrodlo ?? null;
    if (KOLUMNY.waga_gabarytowa_karton) {
      pola.push({ kolumna: KOLUMNY.waga_gabarytowa_karton, parametr: '@wagaGabKarton' });
      parametry.wagaGabKarton = kartonWaga?.waga ?? '';
    }
  }

  if ('waga' in zmiany) {
    let tekst = '';
    if (zmiany.waga !== null) {
      // Bez tego liczba('abc') dawala null, a formatuj(null) -> "0": nieparsowalna waga
      // ladowala w GT jako zero i towar znikal ze sciezki jako "uzupelniony".
      const sprawdzona = sprawdzWage(zmiany.waga);
      if (sprawdzona.blad) return { ok: false, blad: sprawdzona.blad };
      tekst = formatuj(sprawdzona.waga, 3);
    }
    pola.push({ kolumna: KOLUMNY.waga, parametr: '@waga' });
    parametry.waga = tekst;
    zapisane.waga = tekst || null;
  }

  if (pola.length === 0) return { ok: true, dane: { sukces: true, zapisane: {} } };

  const ustawienia = pola.map((p) => `${p.kolumna} = ${p.parametr}`);
  const kolumnyInsert = pola.map((p) => p.kolumna);
  const parametryInsert = pola.map((p) => p.parametr);
  parametry.identNazwa = IDENT_NAZWA_PW_DANE;

  // UPSERT w jednej transakcji. Gdy wiersza nie ma, pwd_Id alokujemy z licznika GT procedura
  // spIdentyfikator (TAK SAMO jak Sfera), a NIGDY przez MAX(pwd_Id)+1. MAX+1 omijalo licznik
  // ins_ident['pw_Dane'] i wypychalo pw_Dane ponad niego, przez co GT przy WLASNYM zapisie pola
  // wlasnego trafial na zajety pwd_Id i rzucal "naruszenie integralnosci danych" (takze reczny
  // zapis w Subiekcie, takze komplet). spIdentyfikator atomowo czyta i podbija licznik, wiec
  // numeracja zostaje spojna. Patrz pamiec projektu pwdane-insert-psuje-licznik-gt.
  // UPDLOCK/HOLDLOCK na SELECT serializuje dwa rownolegle zapisy tego samego towaru - inaczej oba
  // wpadlyby w INSERT i zderzyly na indeksie unikalnym (pwd_IdObiektu, pwd_TypObiektu, pwd_IdPozycji).
  const sql = `
    SET XACT_ABORT ON;
    BEGIN TRAN;
      DECLARE @pwd INT;
      SELECT @pwd = pwd_Id FROM pw_Dane WITH (UPDLOCK, HOLDLOCK)
        WHERE pwd_TypObiektu = ${TYP_OBIEKTU_TOWAR} AND pwd_IdObiektu = @id;
      IF @pwd IS NOT NULL
        UPDATE pw_Dane SET ${ustawienia.join(', ')} WHERE pwd_Id = @pwd;
      ELSE
      BEGIN
        EXEC spIdentyfikator @identNazwa, 1, @pwd OUTPUT;
        INSERT INTO pw_Dane (pwd_Id, pwd_TypObiektu, pwd_IdObiektu, ${kolumnyInsert.join(', ')})
          VALUES (@pwd, ${TYP_OBIEKTU_TOWAR}, @id, ${parametryInsert.join(', ')});
      END
    COMMIT;
    SELECT @pwd AS pwd_Id;`;

  try {
    const res = await query(sql, parametry);
    return { ok: true, dane: { sukces: true, pwd_Id: res.recordset?.[0]?.pwd_Id ?? null, zapisane } };
  } catch (err) {
    return { ok: false, blad: `Zapis atrybutow (SQL): ${err.message}` };
  }
}

// "Brak danych" to nie tylko NULL i pusty string. W polach GT siedza tez smieci wpisane
// recznie: sama spacja, "0", a w Wymiarach trafialo sie doslowne "Wymiary". Bez tego towar
// z waga "0" wypadal ze sciezki jako uzupelniony i nikt juz do niego nie wracal.
// Waga musi byc liczba > 0. Bez TRY_CONVERT - ten SQL Server go nie zna (starszy niz 2012),
// wiec CASE (jedyna konstrukcja z GWARANTOWANA kolejnoscia wyliczania w T-SQL):
// najpierw odsiewamy wartosci z czymkolwiek poza cyframi i separatorem (litery, "60g", "$5" -
// samo ISNUMERIC by tu sklamalo i wywrocilo CONVERT), dopiero potem konwertujemy.
const trim = (kolumna) => `LTRIM(RTRIM(MAX(d.${kolumna})))`;
const BRAK_WYMIAROW_SQL = `(MAX(d.${KOLUMNY.wymiary}) IS NULL OR ${trim(KOLUMNY.wymiary)} = '')`;
const BRAK_WAGI_SQL =
  `(MAX(d.${KOLUMNY.waga}) IS NULL
    OR ${trim(KOLUMNY.waga)} = ''
    OR CASE
         WHEN ${trim(KOLUMNY.waga)} LIKE '%[^0-9.,]%' THEN 0
         WHEN ISNUMERIC(REPLACE(${trim(KOLUMNY.waga)}, ',', '.')) = 1
           THEN CONVERT(float, REPLACE(${trim(KOLUMNY.waga)}, ',', '.'))
         ELSE 0
       END <= 0)`;

// Czy wartosc pola naprawde niesie dane. Regula MUSI byc identyczna z SQL powyzej -
// inaczej pozycja wchodzi na liste (SQL: brak), ale z pustym `brakuje` (Node: jest)
// i magazynier oglada przystanek, na ktorym nic nie jest oznaczone do uzupelnienia.
const maWymiary = (v) => rozbierzWymiary(v) !== null;
const maWage = (v) => {
  const tekst = String(v ?? '').trim();
  // Cokolwiek poza cyframi i separatorem = do poprawy. "60g" celowo NIE przechodzi:
  // jednostka jest niejednoznaczna (gramy czy kilogramy?), a pole trzyma kilogramy -
  // to dokladnie ta pulapka, ktora przy konwersji g->kg zepsula 11 rekordow.
  if (!tekst || /[^0-9.,]/.test(tekst)) return false;
  const n = liczba(tekst);
  return n !== null && n > 0;
};

// Towary lezace na magazynach WMS, ktorym brakuje wymiarow ALBO wagi - lista dla sciezki
// "Brak parametrow". Zestawy (tw_Rodzaj = 8) i uslugi odpadaja: mierzy sie towar, nie komplet.
// Sortowanie po stanie malejaco - najpierw to, czego lezy najwiecej.
async function pobierzBrakParametrow(limit = 500) {
  if (MAGAZYNY_STANU_GT.length === 0) return [];
  const res = await query(
    `SELECT TOP (@limit)
            t.tw_Id, t.tw_Symbol, t.tw_Nazwa, t.tw_PodstKodKresk,
            t.tw_Pole1 AS lok_gt_k4, t.tw_Pole8 AS lok_gt_k4g,
            MAX(d.${KOLUMNY.wymiary}) AS wymiary,
            MAX(d.${KOLUMNY.waga}) AS waga,
            SUM(s.st_Stan) AS stan
     FROM tw__Towar t
     JOIN tw_Stan s ON s.st_TowId = t.tw_Id AND s.st_MagId IN (${MAGAZYNY_STANU_GT.join(',')})
     LEFT JOIN pw_Dane d ON d.pwd_TypObiektu = ${TYP_OBIEKTU_TOWAR} AND d.pwd_IdObiektu = t.tw_Id
     WHERE t.tw_Usuniety = 0 AND t.tw_Rodzaj = 1
     GROUP BY t.tw_Id, t.tw_Symbol, t.tw_Nazwa, t.tw_PodstKodKresk, t.tw_Pole1, t.tw_Pole8
     HAVING SUM(s.st_Stan) > 0
        AND (${BRAK_WYMIAROW_SQL} OR ${BRAK_WAGI_SQL})
     ORDER BY SUM(s.st_Stan) DESC`,
    { limit: Number(limit) }
  );
  return res.recordset.map((w) => ({
    artykul_gt_id: String(w.tw_Id),
    symbol: w.tw_Symbol,
    nazwa: w.tw_Nazwa,
    ean: w.tw_PodstKodKresk || null,
    stan: Number(w.stan),
    // Adres z KOPII w GT - fallback dla SKU, ktorych WMS nie zna (ten sam wzorzec co
    // sciezka "Ostatnie sztuki": WMS jest masterem lokalizacji tam, gdzie ja ma).
    lok_gt: (w.lok_gt_k4 || '').trim() || (w.lok_gt_k4g || '').trim() || null,
    wymiary: w.wymiary || null,
    waga: w.waga || null,
    // Ta sama regula co w SQL - "0" albo nierozbieralne wymiary licza sie jako BRAK,
    // wiec magazynier dostaje je do poprawy zamiast widziec puste pole na ekranie.
    brakuje: [!maWymiary(w.wymiary) && 'wymiary', !maWage(w.waga) && 'waga'].filter(Boolean),
  }));
}

module.exports = {
  pobierzAtrybuty,
  pobierzBrakParametrow,
  zapiszAtrybuty,
  sprawdzWymiary,
  sprawdzWage,
  rozbierzWymiary,
  zlozWymiary,
  liczWageGabarytowa,
  liczba,
  formatuj,
  KOLUMNY,
  TYP_OBIEKTU_TOWAR,
  WYMIAR_PODEJRZANY_CM,
};
