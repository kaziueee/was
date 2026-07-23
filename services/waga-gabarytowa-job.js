'use strict';

// Job spojnosci wagi gabarytowej: waga gabarytowa jest FUNKCJA wymiarow, a wymiary mozna
// zmienic recznie w Subiekcie z pominieciem WMS-a. Wtedy pole "Waga gabarytowa DHL" zostaje
// z wartoscia wyliczona ze starych wymiarow - liczba wyglada poprawnie i nikt nie zauwaza,
// ze klamie. Ten job przelicza ja i poprawia.
//
// Sam nie liczy nic wlasnego - uzywa tych samych funkcji co zapis z UI (gt-atrybuty),
// zeby nie powstal drugi wzor, ktory z czasem rozjedzie sie z pierwszym.

const { query } = require('./gt-sql');
const audyt = require('./audyt');
const awarie = require('./awarie');
const kartony = require('./kartony');
const {
  KOLUMNY, TYP_OBIEKTU_TOWAR, rozbierzWymiary, liczWageGabarytowa,
} = require('./gt-atrybuty');

// Domyslnie 6 h - wymiary zmieniaja sie rzadko (zapis jest jednorazowy per produkt),
// wiec czestszy przebieg tylko obciazalby GT. Nadpisywalne w .env.
function interwalZKonfiguracji() {
  const min = Number(process.env.WAGA_GAB_INTERWAL_MIN);
  return Number.isFinite(min) && min > 0 ? min * 60_000 : 6 * 60 * 60_000;
}
const DOMYSLNY_INTERWAL_MS = interwalZKonfiguracji();

// Ile rekordow naraz poprawiamy w jednym UPDATE - jak we wsadzie wymiarow.
const PACZKA = 300;

// Uzgadnia JEDNA kolumne wagi gabarytowej (dhl albo kartonowa) z wymiarami: dla kazdego towaru
// z wymiarami liczy oczekiwana wartosc funkcja `licz(rozbite)` i poprawia rozjazdy. Wspolny
// silnik dla obu pol - zeby nie powstal drugi wzor, ktory z czasem rozjedzie sie z pierwszym.
// Zwraca {sprawdzone, poprawione, pominieteWyscigi, bledneWymiary, przyklady}.
async function uzgodnijKolumne(kolumna, licz) {
  const res = await query(
    `SELECT pwd_Id,
            pwd_IdObiektu,
            ${KOLUMNY.wymiary} AS wymiary,
            ${kolumna} AS zapisana
     FROM pw_Dane
     WHERE pwd_TypObiektu = ${TYP_OBIEKTU_TOWAR}
       AND ${KOLUMNY.wymiary} IS NOT NULL AND ${KOLUMNY.wymiary} <> ''`
  );

  const doPoprawy = [];
  let bledneWymiary = 0;
  for (const w of res.recordset) {
    const rozbite = rozbierzWymiary(w.wymiary);
    if (!rozbite) { bledneWymiary += 1; continue; }
    const oczekiwana = licz(rozbite);
    const zapisana = (w.zapisana || '').trim();
    if (oczekiwana !== null && oczekiwana !== zapisana) {
      doPoprawy.push({ pwd_Id: w.pwd_Id, tw_Id: w.pwd_IdObiektu, wymiary: w.wymiary, bylo: zapisana || null, ma: oczekiwana });
    }
  }

  let poprawione = 0;
  for (let i = 0; i < doPoprawy.length; i += PACZKA) {
    const paczka = doPoprawy.slice(i, i + PACZKA);
    // JOIN po (pwd_Id ORAZ niezmienione wymiary) zamiast samego pwd_Id: miedzy naszym
    // SELECT-em a UPDATE-em magazynier moze zapisac nowe wymiary z ekranu Parametry
    // (tamten zapis ustawia wymiary i wage gabarytowa spojnie, w jednej transakcji).
    // Dopasowanie po wymiarach sprawia, ze taki wiersz po prostu nie wejdzie do UPDATE -
    // zamiast dostac wage policzona ze STARYCH wymiarow i wisiec tak do nastepnego przebiegu.
    const parametry = {};
    const wiersze = paczka.map((p, n) => {
      parametry[`w${n}`] = p.wymiary;
      parametry[`g${n}`] = p.ma;
      return `(${p.pwd_Id}, @w${n}, @g${n})`;
    });
    const wynikUpdate = await query(
      `UPDATE d SET d.${kolumna} = v.nowa
       FROM pw_Dane d
       JOIN (VALUES ${wiersze.join(', ')}) AS v(id, wymiary, nowa)
         ON d.pwd_Id = v.id AND d.${KOLUMNY.wymiary} = v.wymiary`,
      parametry
    );
    poprawione += wynikUpdate.rowsAffected?.[0] ?? 0;
  }

  return {
    sprawdzone: res.recordset.length,
    poprawione,
    pominieteWyscigi: doPoprawy.length - poprawione,
    bledneWymiary,
    przyklady: doPoprawy.slice(0, 10),
  };
}

// Poprawia wage gabarytowa DHL (z golych wymiarow) ORAZ - gdy skonfigurowana jest kolumna
// pola "z kartonu" - wage gabarytowa z kartonu (ten sam mechanizm, licząca z aktualnej listy
// kartonow). Kartonowy przebieg jest zarazem KANALEM PROPAGACJI edycji listy kartonow na
// kartoteke: zmiana wymiarow kartonu w panelu admina zmienia oczekiwana wage czesci towarow.
async function wykonajSpojnoscWagiGabarytowej() {
  const dhl = await uzgodnijKolumne(KOLUMNY.waga_gabarytowa, liczWageGabarytowa);
  if (dhl.poprawione) {
    audyt.zapisz({
      // 'system:<job>' to UMOWA, nie ozdobnik: po tym prefiksie log odroznia prace automatu
      // od pracy czlowieka i domyslnie chowa te pierwsza (routes/audyt.js). Nowy job MUSI
      // sie tak podpisac, inaczej jego wpisy zasypia widok "kto to zmienil".
      uzytkownik: 'system:waga-gabarytowa',
      akcja: 'waga_gab_przeliczona',
      wynik: 'poprawione',
      ilosc: dhl.poprawione,
      // Same przyklady, nie cala lista - audyt ma powiedziec CO sie stalo, nie byc kopia bazy.
      szczegoly: { przyklady: dhl.przyklady, bledne_wymiary: dhl.bledneWymiary },
    });
  }

  // Pole "z kartonu" - tylko gdy user zalozyl je w Subiekcie i podal kolumne (placeholder=null
  // => pomijamy, feature "uspiony" w GT). Liczy z tej samej listy co podglad na Parametrach.
  let karton = null;
  if (KOLUMNY.waga_gabarytowa_karton) {
    karton = await uzgodnijKolumne(
      KOLUMNY.waga_gabarytowa_karton,
      (rozbite) => kartony.liczWageGabarytowaKarton(rozbite)?.waga ?? null
    );
    if (karton.poprawione) {
      audyt.zapisz({
        uzytkownik: 'system:waga-gabarytowa',
        akcja: 'waga_gab_karton_przeliczona',
        wynik: 'poprawione',
        ilosc: karton.poprawione,
        szczegoly: { przyklady: karton.przyklady },
      });
    }
  }

  // `poprawione` to liczba REALNIE zmienionych wierszy - moze byc mniejsza niz doPoprawy.length,
  // gdy ktos w miedzyczasie zapisal nowe wymiary (patrz JOIN w uzgodnijKolumne).
  return {
    sprawdzone: dhl.sprawdzone,
    poprawione: dhl.poprawione,
    pominieteWyscigi: dhl.pominieteWyscigi,
    bledneWymiary: dhl.bledneWymiary,
    karton: karton && { poprawione: karton.poprawione, pominieteWyscigi: karton.pominieteWyscigi },
  };
}

function start(interwalMs = DOMYSLNY_INTERWAL_MS) {
  const timer = setInterval(() => {
    wykonajSpojnoscWagiGabarytowej().catch((err) => {
      // GT bywa niedostepny - to nie awaria WMS-a, job po prostu sprobuje za interwal.
      awarie.blad('waga-gabarytowa-job', err.message);
      console.error('[waga-gab]', err.message);
    });
  }, interwalMs);
  timer.unref?.();
  return timer;
}

module.exports = { wykonajSpojnoscWagiGabarytowej, start };
