'use strict';

// Czysta logika rozbicia stanu K4 na kubelki stref (rozbijStanK4) + przydzialu zwrotow do
// rozmontowan (przydzielZwroty) + kanonicznej listy rodzajow stref i ich priorytetow.
//
// ZERO zaleznosci od SQLite (db/database) i SQL Server (gt-sql). To jest sedno tego pliku:
// wczesniej ta logika siedziala w services/gt-dokumenty, ktore w `require` otwiera db/database
// (SQLite, `PRAGMA journal_mode = WAL` + migracje przy ladowaniu). `node --test` uruchamia pliki
// testowe jako ROWNOLEGLE procesy - kolidowaly one na wspolnym db/wms.db i losowy plik padal
// z "database is locked" na poziomie PLIKU (nie asercji). Testy czystej logiki
// (test/rozbij-stan-k4, test/przydziel-zwroty, test/adnotacja-stref) importuja teraz stad,
// wiec nie dotykaja bazy ani GT. Ten sam powod, dla ktorego adnotacja-stref jest osobnym plikiem.
//
// gt-dokumenty importuje te symbole z powrotem: doklejaja `kandydaci` (funkcje siegajace do GT)
// do RODZAJE_STREF i wstrzykuje bazodanowy licznik "ile juz rozlozono" do rozbijStanK4 - dzieki
// czemu jego publiczne API nie zmienia sie ani na jotę.

// Kod magazynu WMS (ruchy.mag_zrodlo_pula) - domyslny magazyn dla rozbicia stanu.
const MAG_KOD_K4 = 'K4';

// KANONICZNA lista rodzajow stref: rodzaj -> nazwa kubelka w wyniku rozbijStanK4. To jest
// JEDNO zrodlo prawdy o tym, "jakie sa rodzaje". gt-dokumenty buduje z niej RODZAJE_STREF
// (dokladajac kandydaci), a testy-straznicy pilnuja, ze pochodne rejestry opisuja te same
// rodzaje: PRIORYTET_PRZYDZIALU (nizej), SKROTY_STREF (adnotacja-stref) i RODZAJE_DOK (front).
// Nowy rodzaj dodaj TUTAJ - konsumenci i straznicy zobacza go sami.
const KUBELKI_STREF = {
  dostawa:        'dostawy',
  zwrot:          'zwroty',
  przywozka:      'przywozki',
  przyjecie_wewn: 'przyjecia',
};

// Domyslne okno (dni), w ktorym zwrot na KFS pokrywa rozmontowanie. Produkcja wstrzykuje
// realna wartosc (gt-dokumenty: WMS_OKNO_DROBNICA_DNI || 14) jako 3. argument przydzielZwroty;
// ta stala jest fallbackiem dla uzycia standalone (testy licza na oknie 14 dni).
const OKNO_ROZMONTOWANIE_KFS_DNI_DOMYSLNE = 14;

// PRZYDZIAL ILOSCIOWY zwrotow do rozmontowan (zamiast flagi "czy istnieje jakikolwiek KFS").
//
// Po co: sam EXISTS odpowiadal wspolnie dla CALEGO SKU w oknie, wiec jeden zwrocony egzemplarz
// "uzyczal" flagi kazdemu kolejnemu rozmontowaniu tego zestawu - takze wzietemu ze stanu.
// Zmierzone na bazie: 34 ze 137 zestawow mialo wiecej rozmontowan oznaczonych "z zwrotu", niz
// kiedykolwiek wrocilo (NERCHIELIT100: 152 szt. oznaczone vs 65 zwroconych).
//
// Model: kazda zwrocona sztuka jest wazna przez `oknoDni` od daty KFS i moze byc zuzyta RAZ.
// Rozmontowania ida chronologicznie i konsumuja najstarsze wazne sztuki. Rozmontowanie, ktore
// skonsumowalo cokolwiek = "z zwrotu".
//
// Czesciowe pokrycie (rozmontowano 6, wrocila 1) tez liczymy jako "z zwrotu" - bledy nie sa
// symetryczne: falszywe "z zwrotu" to tylko zbedne zadanie (magazynier i tak odlozy towar na
// polke i stan wyjdzie dobrze), a falszywe "ze stanu" kaze auto-dopisowi WPISAC nieprawde
// o lokalizacji. W watpliwosci wybieramy zadanie.
function przydzielZwroty(rozmontowania, zwroty, oknoDni = OKNO_ROZMONTOWANIE_KFS_DNI_DOMYSLNE) {
  const oknoMs = oknoDni * 24 * 3600 * 1000;
  const pulaPoZestawie = new Map();
  for (const z of zwroty) {
    if (!pulaPoZestawie.has(z.zestaw_id)) pulaPoZestawie.set(z.zestaw_id, []);
    pulaPoZestawie.get(z.zestaw_id).push({ czas: z.data.getTime(), pozostalo: z.ilosc });
  }
  for (const lista of pulaPoZestawie.values()) lista.sort((a, b) => a.czas - b.czas);

  // chronologicznie - inaczej pozniejsze rozmontowanie zjadloby sztuke nalezna wczesniejszemu
  const wszystkie = [...rozmontowania].sort((a, b) => a.data.getTime() - b.data.getTime());
  for (const r of wszystkie) {
    const pula = pulaPoZestawie.get(r.zestaw_id) || [];
    const czas = r.data.getTime();
    let potrzeba = r.zestawow;
    let zuzyto = 0;
    for (const sztuki of pula) {
      if (potrzeba <= 0) break;
      // wazne: zwrot musi byc PRZED rozmontowaniem i nie starszy niz okno
      if (sztuki.pozostalo <= 0 || sztuki.czas > czas || sztuki.czas < czas - oknoMs) continue;
      const bierz = Math.min(sztuki.pozostalo, potrzeba);
      sztuki.pozostalo -= bierz;
      potrzeba -= bierz;
      zuzyto += bierz;
    }
    r.z_zwrotu = zuzyto > 0;
  }
  return wszystkie;
}

// Kolejnosc ZJADANIA stanu K4 - co schodzi, gdy stan GT spada (sprzedaz, RW, rozchod
// zewnetrzny, MM zrobione w Subiekcie, MM na Reklamacje). Decyzja usera 2026-07-17:
//
//   do sprawdzenia -> POLKA -> dostawa -> drobnica od NAJSTARSZEJ (zwrot / PW / przywozka)
//
// Sedno: konsumentow NIE rozpoznajemy. Kazdy z nich robi dokladnie jedno - zbija st_Stan na K4.
// Skoro polka jest RESZTA z odejmowania, kazdy zjada ja sam z siebie i nie ma listy typow
// dokumentow do utrzymania (regula przeszla test na magazynie K4R, o ktorym nikt nie wiedzial).
//
// Dlaczego dostawa schodzi pierwsza: to duza, prosta paleta; przy pustej polce towar jest tam,
// gdzie ona stoi, a pomylka jest GLOSNA - zasada 6 sprawdzi stan i rzuci bledem przy rozkladaniu.
// Drobnica (zwrot / PW / przywozka) jest chroniona za nia: zjedzona po cichu kasuje zadanie
// "odnies na regal", a sztuki zostaja w strefie i nikt sie o nich nie dowie.
//
// MIEDZY RODZAJAMI DROBNICY DECYDUJE DATA, NIE RODZAJ (zmiana 2026-09-08, zgloszenie
// LEG60369 + MATJBF94). Do tej pory przywozka byla chroniona najmocniej ("nie sprowadza sie
// towaru z MAG/LS, gdy stan jest na K4, wiec remis praktycznie nie zachodzi") - i to zalozenie
// okazalo sie nieprawdziwe. Kajtek przywozi na K4 pojedyncze sztuki pod konkretne zamowienie
// i towar schodzi WZ-ka tego samego dnia, ale MM nikt w WMS nie rozklada, wiec dokument wisi
// pelne okno drobnicy jako WIDMO i co przeliczenie zglasza sie po sztuke. Zmierzone na
// produkcji (okno 14 dni, K4): 49 z 58 SKU z przywozka (84%) ma stan K4 = 0, czyli towaru juz
// nie ma; dla zwrotow to 7 ze 140 (5%). Efekt: zwrot z 03.09 oddawal swoja jedyna sztuke
// przywozce z 28.08 i znikal z listy zwrotow, choc fizycznie lezal w strefie zwrotow.
//
// Regula: przy niedoborze stanu sztuki dostaje NOWSZY dokument - starszy z duzo wiekszym
// prawdopodobienstwem zdazyl zejsc. Remis dat (dok_DataWyst ma rozdzielczosc DNIA, wiec remis
// jest czesty) rozstrzyga PRIORYTET_PRZYDZIALU: zwrot > PW > przywozka, czyli najpierw ten
// rodzaj, ktorego blednie skasowane zadanie boli najbardziej.
//
// !!! W PETLI PRZYDZIELAMY BUDZET, wiec kolejnosc jest ODWROTNA do kolejnosci zjadania:
// kto schodzi PIERWSZY, dostaje resztowke, czyli musi byc w petli OSTATNI. Latwo napisac na
// odwrot i dostac wynik, ktory wyglada sensownie. Test to pilnuje.
//
// GRUPA_PRZYDZIALU = "czy ten rodzaj konkuruje data". Dostawa stoi osobno (grupa 1 = przydzial
// po calej drobnicy = zjadana pierwsza), zeby swieza paleta nie wypchnela starszego zwrotu -
// to nadal decyzja usera z 2026-07-17 i test tego pilnuje.
const GRUPA_DROBNICA = 0;
const GRUPA_PRZYDZIALU = { zwrot: GRUPA_DROBNICA, przyjecie_wewn: GRUPA_DROBNICA,
  przywozka: GRUPA_DROBNICA, dostawa: 1 };

// Tie-break przy tej samej dacie - w obrebie drobnicy. Dla dostawy wartosc nie ma znaczenia
// (rozstrzyga grupa), ale zostaje spojna z kolejnoscia zjadania: dostawa schodzi pierwsza.
const PRIORYTET_PRZYDZIALU = { zwrot: 0, przyjecie_wewn: 1, przywozka: 2, dostawa: 3 };

// Nieznany rodzaj ladowal dotad na kubelku `dostawa` (`kubelki[d.rodzaj] || kubelki.dostawa`),
// czyli po zmianie wskoczylby od razu na PIERWSZE miejsce zjadania i jego zadanie znikaloby
// najszybciej. Dajemy mu przydzial jako drobnicy z priorytetem -1 = przydzial pierwszy =
// zjadany ostatni: widoczny wiersz jest mniejszym zlem niz cicho skasowane zadanie. Prawdziwym
// zabezpieczeniem jest test sprawdzajacy, ze KUBELKI_STREF, GRUPA_PRZYDZIALU
// i PRIORYTET_PRZYDZIALU maja te same klucze.
const priorytet = (rodzaj) => PRIORYTET_PRZYDZIALU[rodzaj] ?? -1;
const grupa = (rodzaj) => GRUPA_PRZYDZIALU[rodzaj] ?? GRUPA_DROBNICA;

// Kolejnosc, w jakiej dokumenty siegaja po budzet stanu: drobnica przed dostawa, w obrebie
// grupy nowszy dokument pierwszy, a remis dat rozstrzyga rodzaj. Dla samych dostaw wychodzi
// dokladnie to, co wczesniej (jeden rodzaj -> sort po dacie malejaco).
function porownajPrzydzial(a, b) {
  return grupa(a.rodzaj) - grupa(b.rodzaj)
    || String(b.data ?? '').localeCompare(String(a.data ?? ''))
    || priorytet(a.rodzaj) - priorytet(b.rodzaj);
}

// Rozbija stan K4 na rozlaczne czesci, ktore NIE nachodza na siebie:
//   dostawy    - PZ<-FZ, paleta od dostawcy (rozkladana dowolnie, dol/gora, w czesciach)
//   zwroty     - PZ<-KFS, sztuki lezace w strefie zwrotow (wracaja na regal)
//   przywozki  - MM z MAG/LS, towar w strefie przywozki (wraca na regal)
//   polka      - ile MOZE lezec na polce pickowej wg GT (kopia WMS bywa starsza - patrz nizej)
//   reszta     - "do sprawdzenia": stan, o ktorym WMS nic nie wie (wszedl poza naszym obiegiem)
//
// Kubelek dokumentu = ilosc z PZ MINUS to, co z TEGO dokumentu juz rozlozylismy. Licznik
// "juz rozlozono" siega do SQLite, wiec jest WSTRZYKIWANY (opcje.iloscRozlozona) - dzieki temu
// ten plik zostaje czysty. gt-dokumenty wstrzykuje iloscRozlozonaZDokumentu; testy wywoluja
// bez artykul_gt_id, wiec licznik nie jest w ogole potrzebny.
//
// CAP STANEM, NIE DEFICYTEM (zmiana 2026-07-17). Wczesniej strefy byly capowane deficytem
// (stan GT - polka), przez co sprzedaz kurczyla WIERSZ DOSTAWY zamiast polki: paleta 4080 po
// dwoch dniach pokazywala 4075 i backend ucinal rozlozenie, zostawiajac w GT 5 szt. "na K4",
// ktore fizycznie pojechaly na gore. Teraz strefy ogranicza tylko sam stan (strefa nie moze
// trzymac wiecej sztuk, niz w ogole lezy na K4), a polka bierze to, co zostanie - czyli to ona
// absorbuje sprzedaz. To jest regula #3 usera: "zejscie ze stanu jest zawsze z lokalizacji
// zapisanej, chyba ze lokalizacji nie ma lub jest zero".
//
// GRANICA, swiadomie zostawiona: `reszta` schodzi PRZED polka, bo jest definiowana jako
// reszta - nie ma niezaleznej liczby, ktora dalaby sie zbic pozniej. Gdy reszta = 0 (stan
// docelowy), regula #3 dziala dokladnie. Naprawa wymagalaby snapshotow stanu GT.
//
// stanGt  - st_Stan z GT (master ilosci)
// sumaWms - suma stany_lokalizacji dla tego magazynu (kopia WMS; moze byc STARSZA od GT,
//           bo sprzedaz w Subiekcie zbija stan bez wiedzy WMS)
// opcje.iloscRozlozona - (artykul_gt_id, magazyn, pz_nr) => ile juz rozlozono z dokumentu;
//           wolane tylko gdy podano artykul_gt_id
function rozbijStanK4(stanGt, sumaWms, dokumenty, { artykul_gt_id, magazyn = MAG_KOD_K4, iloscRozlozona } = {}) {
  let zostalo = Math.max(Number(stanGt) || 0, 0);
  const polkaKopia = Math.max(Number(sumaWms) || 0, 0);
  const kubelki = { dostawa: [], zwrot: [], przywozka: [], przyjecie_wewn: [] };

  // stabilny sort: drobnica przed dostawa, dalej najnowszy dokument pierwszy (= najstarszy
  // dostaje resztowke = jest zjadany pierwszy), remis dat rozstrzyga rodzaj. `data` to
  // 'YYYY-MM-DD' albo null - patrz porownajPrzydzial.
  const wgPrzydzialu = [...(dokumenty || [])].sort(porownajPrzydzial);

  for (const d of wgPrzydzialu) {
    if (zostalo <= 0) break;
    const juz = artykul_gt_id && iloscRozlozona ? iloscRozlozona(artykul_gt_id, magazyn, d.pz_nr) : 0;
    const pozostalo = d.ilosc - juz;
    if (pozostalo <= 0) continue;             // ten dokument juz rozlozony w calosci
    const ilosc = Math.min(pozostalo, zostalo);
    (kubelki[d.rodzaj] || kubelki.dostawa).push({ ...d, ilosc });
    zostalo -= ilosc;
  }

  // Polka bierze, ile zostanie po strefach. Gdy kopia WMS jest wyzsza - roznica to sprzedaz,
  // ktorej WMS nie zauwazyl; auto-korekta w jobie rozjazdow sciagnie kopie do stanu GT.
  const polka = Math.min(polkaKopia, zostalo);
  zostalo -= polka;

  // `wszystkie` = te same pozycje w jednej liscie. Konsumenci, ktorych interesuje "ile lezy
  // w drodze", "co jest do rozlozenia" albo ktorzy skladaja liste pozycji na ekran, MAJA
  // uzywac tego pola (payload oddaje je jako `wszystkie_k4`) - recznie skladane
  // [...dostawy, ...zwroty] cichnie sie psuje przy kazdym nowym rodzaju (tak zniknely
  // przywozki z /ruchy/rozloz i z reguly "cala ilosc" w /lok, a potem PW z karty i modalu).
  //
  // Object.values(kubelki) -> kolejnosc wstawienia kluczy do `kubelki` (dostawa, zwrot,
  // przywozka, przyjecie_wewn): dostawa pierwsza (najwieksza robota), potem drobnica ze stref.
  // Nowy rodzaj dodany do inicjalizacji `kubelki` wpada tu SAM - o to chodzi, zeby konsument
  // wszystkie_k4 nie wymagal dotkniecia.
  const wszystkie = Object.values(kubelki).flat();
  return {
    dostawy: kubelki.dostawa,
    zwroty: kubelki.zwrot,
    przywozki: kubelki.przywozka,
    przyjecia: kubelki.przyjecie_wewn,      // PW - przychod wewnetrzny z dokumentem
    wszystkie,
    wDrodze: wszystkie.reduce((s, d) => s + d.ilosc, 0),
    polka,                                  // ile faktycznie moze lezec na polce
    polka_kopia: polkaKopia,                // co o tym mysli WMS
    polka_klamie: polkaKopia - polka,       // ile sprzedazy zeszlo z polki bez wiedzy WMS
    reszta: zostalo,                        // "do sprawdzenia" - przychod BEZ dokumentu
  };
}

module.exports = {
  MAG_KOD_K4, KUBELKI_STREF, PRIORYTET_PRZYDZIALU, GRUPA_PRZYDZIALU, priorytet, porownajPrzydzial,
  przydzielZwroty, rozbijStanK4,
};
