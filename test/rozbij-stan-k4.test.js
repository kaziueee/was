'use strict';

// Testy rdzenia rachunku "co lezy na K4" - rozbijStanK4 z services/rozbicie-stanu.js.
// Uruchomienie: node --test test/
//
// Czemu akurat ta funkcja ma testy, a reszta nie: to JEDYNE miejsce, gdzie zapisana jest
// definicja "ile zostalo do rozlozenia" i "co schodzi po czym". Kolejnosc zjadania jest
// decyzja biznesowa usera (2026-07-17), a w kodzie wychodzi z ODWROTNEJ kolejnosci
// przydzialu budzetu - czyli z rzeczy, ktora wyglada sensownie takze wtedy, gdy jest
// napisana na odwrot. Bez testu nastepna osoba "poprawi" sort jednym ruchem.
//
// Testy nie dotykaja GT ani SQLite: rozbijStanK4 czyta baze tylko przez wstrzykiwany licznik
// iloscRozlozona (w gt-dokumenty: iloscRozlozonaZDokumentu), a tu nie podajemy go ani
// artykul_gt_id. Import idzie z rozbicie-stanu WLASNIE dlatego, ze ten modul nie ciagnie
// db/database (SQLite) - inaczej rownolegle pliki testowe kolidowalyby na db/wms.db.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { rozbijStanK4, przydzielWydaniaSklepu, wydaneZPalety, KUBELKI_STREF, PRIORYTET_PRZYDZIALU, GRUPA_PRZYDZIALU } =
  require('../services/rozbicie-stanu');

// Wyciaga klucze najwyzszego poziomu z literalu obiektu `<nazwa> = { ... }` w tekscie zrodla.
// Front (public/zebra/ruch.js, public/desktop/app.js) to zwykly JS przegladarki (globalne el/
// pokazWidok, IIFE) - nie da sie go `require`, wiec czytamy plik i parsujemy. Skaner liczy
// glebokosc klamer i zbiera identyfikatory tylko na glebokosci 1 (klucze zagniezdzone pomija).
function kluczeObiektu(src, nazwa) {
  const start = src.indexOf(`${nazwa} = {`);
  if (start === -1) throw new Error(`nie znaleziono "${nazwa}" w zrodle`);
  const klucze = [];
  let depth = 0;
  let oczekujeKlucz = false;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    const c = src[i];
    if (c === '{') { depth++; oczekujeKlucz = depth === 1; continue; }
    if (c === '}') { depth--; if (depth === 0) break; continue; }
    if (depth === 1 && c === ',') { oczekujeKlucz = true; continue; }
    if (depth === 1 && oczekujeKlucz && /\S/.test(c)) {
      const m = src.slice(i).match(/^([A-Za-z_$][\w$]*)\s*:/);
      if (m) { klucze.push(m[1]); i += m[0].length - 1; }
      oczekujeKlucz = false;
    }
  }
  return klucze;
}

// Skrot na dokument. `data` steruje FIFO w obrebie rodzaju.
const dok = (rodzaj, ilosc, data, pz_nr = `PZ-${rodzaj}-${data}`) => ({ rodzaj, ilosc, data, pz_nr });

// Sumy kubelkow - do czytelnych asercji.
const sumy = (r) => ({
  dostawa: r.dostawy.reduce((s, d) => s + d.ilosc, 0),
  zwrot: r.zwroty.reduce((s, d) => s + d.ilosc, 0),
  przywozka: r.przywozki.reduce((s, d) => s + d.ilosc, 0),
  polka: r.polka,
  reszta: r.reszta,
});
const sumaPw = (r) => r.przyjecia.reduce((s, d) => s + d.ilosc, 0);

test('inwariant: kubelki + polka + reszta zawsze sumuja sie do stanu GT', () => {
  const przypadki = [
    [40, 10, [dok('dostawa', 20, '2026-07-20')]],
    [25, 10, [dok('dostawa', 20, '2026-07-20')]],
    [6, 10, [dok('dostawa', 20, '2026-07-20')]],
    [0, 10, [dok('dostawa', 20, '2026-07-20')]],
    [21, 0, [dok('dostawa', 20, '2026-07-20'), dok('zwrot', 2, '2026-07-15')]],
    [100, 30, []],
    [5, 0, [dok('przywozka', 3, '2026-07-20'), dok('zwrot', 4, '2026-07-19'), dok('dostawa', 9, '2026-07-18')]],
  ];
  for (const [stan, wms, dokumenty] of przypadki) {
    const r = rozbijStanK4(stan, wms, dokumenty);
    const suma = r.wDrodze + r.polka + r.reszta;
    assert.equal(suma, stan, `stan=${stan} wms=${wms}: ${r.wDrodze}+${r.polka}+${r.reszta} != ${stan}`);
  }
});

test('regula #3: sprzedaz zjada POLKE, a nie wiersz dostawy (pomiar NERE0011)', () => {
  // Sytuacja z pomiaru: paleta 20 czeka, polka C2 = 10 w kopii WMS, 10 szt. nadwyzki.
  const dostawa = [dok('dostawa', 20, '2026-07-20')];

  // Start: nic sie nie dzieje.
  assert.deepEqual(sumy(rozbijStanK4(40, 10, dostawa)), { dostawa: 20, zwrot: 0, przywozka: 0, polka: 10, reszta: 10 });

  // Sprzedaz 10 -> schodzi "do sprawdzenia" (granica modelu: reszta przed polka).
  assert.deepEqual(sumy(rozbijStanK4(30, 10, dostawa)), { dostawa: 20, zwrot: 0, przywozka: 0, polka: 10, reszta: 0 });

  // Sprzedaz 15 -> "do sprawdzenia" wyczerpane, TERAZ schodzi polka. Dostawa NIETKNIETA.
  // Przed zmiana: dostawa kurczyla sie do 15, a polka zostawala 10.
  assert.deepEqual(sumy(rozbijStanK4(25, 10, dostawa)), { dostawa: 20, zwrot: 0, przywozka: 0, polka: 5, reszta: 0 });

  // Sprzedaz 20 -> polka na zerze, dostawa dalej pelna.
  assert.deepEqual(sumy(rozbijStanK4(20, 10, dostawa)), { dostawa: 20, zwrot: 0, przywozka: 0, polka: 0, reszta: 0 });

  // Sprzedaz 34 -> polka pusta, ktos pickuje juz z palety.
  assert.deepEqual(sumy(rozbijStanK4(6, 10, dostawa)), { dostawa: 6, zwrot: 0, przywozka: 0, polka: 0, reszta: 0 });
});

test('polka_klamie mierzy sprzedaz, ktorej WMS nie zauwazyl', () => {
  const dostawa = [dok('dostawa', 20, '2026-07-20')];
  const r = rozbijStanK4(25, 10, dostawa);
  assert.equal(r.polka, 5, 'na polce moze lezec 5');
  assert.equal(r.polka_kopia, 10, 'WMS dalej twierdzi 10');
  assert.equal(r.polka_klamie, 5, 'roznica = 5 szt. zeszlo sprzedaza');

  // Gdy kopia jest zgodna, nic nie klamie.
  assert.equal(rozbijStanK4(40, 10, dostawa).polka_klamie, 0);
});

test('kolejnosc przy pustej polce i tej samej dacie: dostawa -> przywozka -> zwrot', () => {
  // Kazdy rodzaj po 10 szt., ta sama data, polka pusta. Obnizamy stan i patrzymy, co znika
  // pierwsze. Rowna data jest tu istotna: to jedyny przypadek, w ktorym o kolejnosci decyduje
  // RODZAJ. Gdy daty sie roznia, rozstrzyga data (nizej: przypadek LEG60369).
  const d = [dok('dostawa', 10, '2026-07-20'), dok('zwrot', 10, '2026-07-20'), dok('przywozka', 10, '2026-07-20')];

  // Pelny stan: wszystko sie miesci.
  assert.deepEqual(sumy(rozbijStanK4(30, 0, d)), { dostawa: 10, zwrot: 10, przywozka: 10, polka: 0, reszta: 0 });

  // Brakuje 5 -> zjada DOSTAWA (pierwsza w kolejnosci zjadania).
  assert.deepEqual(sumy(rozbijStanK4(25, 0, d)), { dostawa: 5, zwrot: 10, przywozka: 10, polka: 0, reszta: 0 });

  // Brakuje 15 -> dostawa na zerze, zaczyna schodzic PRZYWOZKA (84% przywozek w oknie to
  // dokumenty, ktorych towar juz zszedl - patrz rozbicie-stanu.js).
  assert.deepEqual(sumy(rozbijStanK4(15, 0, d)), { dostawa: 0, zwrot: 10, przywozka: 5, polka: 0, reszta: 0 });

  // Brakuje 25 -> zostaje sam ZWROT (ostatni w kolejnosci zjadania, bo jego zadanie
  // "odnies z wozka na regal" skasowane po cichu nie ma jak sie odtworzyc).
  assert.deepEqual(sumy(rozbijStanK4(5, 0, d)), { dostawa: 0, zwrot: 5, przywozka: 0, polka: 0, reszta: 0 });
});

test('polka schodzi PRZED kazda strefa', () => {
  // Polka 10 + dostawa 10. Brakuje 5 -> polka 5, dostawa NIETKNIETA.
  const d = [dok('dostawa', 10, '2026-07-20')];
  assert.deepEqual(sumy(rozbijStanK4(15, 10, d)), { dostawa: 10, zwrot: 0, przywozka: 0, polka: 5, reszta: 0 });
  // Dopiero po wyzerowaniu polki rusza dostawa.
  assert.deepEqual(sumy(rozbijStanK4(8, 10, d)), { dostawa: 8, zwrot: 0, przywozka: 0, polka: 0, reszta: 0 });
});

test('FIFO w obrebie rodzaju: najstarsza paleta schodzi pierwsza', () => {
  const stara = dok('dostawa', 10, '2026-07-01', 'PZ-STARA');
  const nowa = dok('dostawa', 10, '2026-07-20', 'PZ-NOWA');

  // Brakuje 5 -> resztowke dostaje STARA (nowa trzyma pelna ilosc).
  const r = rozbijStanK4(15, 0, [stara, nowa]);
  const wg = Object.fromEntries(r.dostawy.map((d) => [d.pz_nr, d.ilosc]));
  assert.equal(wg['PZ-NOWA'], 10, 'nowa paleta nietknieta');
  assert.equal(wg['PZ-STARA'], 5, 'stara absorbuje niedobor');

  // Kolejnosc wejsciowa nie moze miec znaczenia - sort ma byc deterministyczny.
  const rOdwrotnie = rozbijStanK4(15, 0, [nowa, stara]);
  const wgOdwrotnie = Object.fromEntries(rOdwrotnie.dostawy.map((d) => [d.pz_nr, d.ilosc]));
  assert.deepEqual(wgOdwrotnie, wg, 'wynik nie zalezy od kolejnosci wejsciowej');
});

test('PW (przyjecie wewn) widoczny mimo jednoczesnej dostawy - przypadek NERE9533', () => {
  // Sedno fixu: PW 3 szt bylo NIEWIDOCZNE bo dostawa+polka pochlaniaja stan (reszta=0).
  // Z kubelkiem PW (budzet PRZED polka) przychod jest widoczny co do sztuki.
  const d = [dok('dostawa', 20, '2026-07-16'), dok('przyjecie_wewn', 3, '2026-07-17')];
  const r = rozbijStanK4(314, 311, d);
  assert.equal(sumaPw(r), 3, 'PW widoczny: 3 szt');
  assert.equal(sumy(r).dostawa, 20, 'dostawa pelna');
  assert.equal(r.polka, 291, 'polka = 314 - 20 - 3');
  assert.equal(r.reszta, 0, 'nic niewyjasnionego');
  // inwariant trzyma z PW
  assert.equal(r.wDrodze + r.polka + r.reszta, 314);
});

test('remis dat w drobnicy: schodzi dostawa, potem przywozka, PW, na koncu zwrot', () => {
  const d = [dok('dostawa', 10, '2026-07-20'), dok('zwrot', 10, '2026-07-20'),
    dok('przyjecie_wewn', 10, '2026-07-20'), dok('przywozka', 10, '2026-07-20')];
  // pelny stan: wszystko sie miesci
  const pelny = rozbijStanK4(40, 0, d);
  assert.deepEqual(
    { ...sumy(pelny), pw: sumaPw(pelny) },
    { dostawa: 10, zwrot: 10, przywozka: 10, polka: 0, reszta: 0, pw: 10 }
  );
  // brakuje 25 -> znika dostawa(10) + przywozka(10) + PW(5); zwrot nietkniety.
  // Przy tej samej dacie rozstrzyga rodzaj, a najmocniej chroniony jest zwrot: jego zadanie
  // ("odnies sztuke z wozka na regal") skasowane po cichu nie ma jak sie odtworzyc.
  const chudy = rozbijStanK4(15, 0, d);
  assert.deepEqual(
    { ...sumy(chudy), pw: sumaPw(chudy) },
    { dostawa: 0, zwrot: 10, przywozka: 0, polka: 0, reszta: 0, pw: 5 }
  );
});

test('w drobnicy data bije rodzaj: swiezy zwrot zabiera sztuke starej przywozce (LEG60369)', () => {
  // Zgloszenie z produkcji 2026-09-08. Kajtek przywozi na K4 pojedyncze sztuki pod zamowienie
  // (MM 379 z 28.08, 2 szt.) i towar schodzi WZ-ka tego samego dnia, ale MM nikt w WMS nie
  // rozklada - dokument wisi cale okno drobnicy jako widmo. Zwrot (KFS 3264/K4/2026 z 03.09)
  // dostawal wtedy 0 szt. i znikal z listy zwrotow, choc to on lezal w strefie.
  const przywozkaWidmo = dok('przywozka', 2, '2026-08-28');
  const zwrotSwiezy = dok('zwrot', 1, '2026-09-03');
  const r = rozbijStanK4(1, 0, [przywozkaWidmo, zwrotSwiezy]);
  assert.deepEqual(sumy(r), { dostawa: 0, zwrot: 1, przywozka: 0, polka: 0, reszta: 0 });

  // ...i odwrotnie: gdy to przywozka jest swiezsza, nie klamiemy na jej niekorzysc
  const zwrotStary = dok('zwrot', 1, '2026-08-28');
  const przywozkaSwieza = dok('przywozka', 1, '2026-09-03');
  const odwrotnie = rozbijStanK4(1, 0, [zwrotStary, przywozkaSwieza]);
  assert.deepEqual(sumy(odwrotnie), { dostawa: 0, zwrot: 0, przywozka: 1, polka: 0, reszta: 0 });
});

test('rodzaj bije date: swieza dostawa schodzi przed starym zwrotem', () => {
  // To jest sedno decyzji usera - samo FIFO dalo by tu odwrotnie.
  const zwrotStary = dok('zwrot', 2, '2026-07-01');
  const dostawaSwieza = dok('dostawa', 20, '2026-07-20');
  const r = rozbijStanK4(21, 0, [zwrotStary, dostawaSwieza]);
  assert.deepEqual(sumy(r), { dostawa: 19, zwrot: 2, przywozka: 0, polka: 0, reszta: 0 });
});

test('KOLEJNOSC PRZYDZIALU jest ODWROTNA do kolejnosci zjadania', () => {
  // Straznik przed najlatwiejsza pomylka w tym pliku. Kto schodzi pierwszy (dostawa),
  // musi siegac po budzet OSTATNI, bo dostaje resztowke.
  assert.ok(GRUPA_PRZYDZIALU.dostawa > GRUPA_PRZYDZIALU.zwrot,
    'dostawa schodzi przed drobnica => przydzial dostawy jest PO drobnicy');
  // Wewnatrz drobnicy kolejnosc rozstrzyga DATA (nowszy dokument pierwszy) - patrz zgloszenie
  // LEG60369. PRIORYTET_PRZYDZIALU jest juz tylko tie-breakiem przy tej samej dacie i tam
  // najmocniej chroniony (= siegajacy po budzet pierwszy) jest zwrot.
  assert.deepEqual(
    [GRUPA_PRZYDZIALU.zwrot, GRUPA_PRZYDZIALU.przywozka, GRUPA_PRZYDZIALU.przyjecie_wewn],
    [GRUPA_PRZYDZIALU.zwrot, GRUPA_PRZYDZIALU.zwrot, GRUPA_PRZYDZIALU.zwrot],
    'zwrot, przywozka i PW konkuruja w JEDNEJ grupie - inaczej rodzaj znow bilby date');
  assert.ok(PRIORYTET_PRZYDZIALU.zwrot < PRIORYTET_PRZYDZIALU.przyjecie_wewn
    && PRIORYTET_PRZYDZIALU.przyjecie_wewn < PRIORYTET_PRZYDZIALU.przywozka,
    'remis dat: zwrot chroniony przed PW, PW przed przywozka');
});

test('kazdy rodzaj z KUBELKI_STREF ma grupe i priorytet (czwarty rodzaj nie wypadnie po cichu)', () => {
  assert.deepEqual(
    Object.keys(KUBELKI_STREF).sort(),
    Object.keys(GRUPA_PRZYDZIALU).sort(),
    'KUBELKI_STREF i GRUPA_PRZYDZIALU musza opisywac te same rodzaje'
  );
  // Ten sam blad trafil sie juz cztery razy - za kazdym razem dlatego, ze ktos skladal
  // liste rodzajow recznie i o jednym zapomnial. KUBELKI_STREF to kanoniczna lista rodzajow
  // (gt-dokumenty buduje z niej RODZAJE_STREF), wiec straznik anchoruje na niej.
  assert.deepEqual(
    Object.keys(KUBELKI_STREF).sort(),
    Object.keys(PRIORYTET_PRZYDZIALU).sort(),
    'KUBELKI_STREF i PRIORYTET_PRZYDZIALU musza opisywac te same rodzaje'
  );
});

test('RODZAJE_DOK we froncie zna te same rodzaje co KUBELKI_STREF w backendzie', () => {
  // Ten sam blad ("nowy rodzaj wypadl po cichu") trafil sie >=6 razy - ostatnio PW zniknelo
  // z karty produktu i modalu. Zrodlo naprawione: payload oddaje JEDNA liste wszystkie_k4,
  // wiec front nie skleja juz kubelkow recznie. Ale front nadal MAPUJE rodzaj -> podpis i
  // domyslny cel przez RODZAJE_DOK. Gdy backend pozna rodzaj, ktorego RODZAJE_DOK nie zna,
  // wpadnie on w `|| RODZAJE_DOK.dostawa` i pokaze sie jako "Dostawa" z celem K4G - cicha
  // pomylka. Ten straznik pilnuje, ze rejestr frontu i backendu opisuja te same rodzaje.
  const rodzajeBackend = Object.keys(KUBELKI_STREF).sort();
  for (const wzgledny of ['../public/zebra/ruch.js', '../public/desktop/app.js']) {
    const src = fs.readFileSync(path.join(__dirname, wzgledny), 'utf8');
    const kluczeFront = kluczeObiektu(src, 'RODZAJE_DOK').sort();
    assert.deepEqual(kluczeFront, rodzajeBackend,
      `${wzgledny}: RODZAJE_DOK musi miec te same rodzaje co RODZAJE_STREF`);
  }
});

test('dokument rozlozony w calosci nie wraca jak zombie', () => {
  // ilosc <= 0 po odjeciu rozlozonego - pomijamy. Tu symulujemy iloscia 0 z GT.
  const r = rozbijStanK4(10, 10, [dok('dostawa', 0, '2026-07-20')]);
  assert.equal(r.dostawy.length, 0, 'pusty dokument nie tworzy wiersza');
  assert.equal(r.polka, 10);
});

test('brak dokumentow: caly stan idzie na polke, nadwyzka do sprawdzenia', () => {
  assert.deepEqual(sumy(rozbijStanK4(30, 10, [])), { dostawa: 0, zwrot: 0, przywozka: 0, polka: 10, reszta: 20 });
  // Polka wieksza niz stan GT - kopia jest przestarzala, job ja sciagnie.
  const r = rozbijStanK4(3, 10, []);
  assert.deepEqual(sumy(r), { dostawa: 0, zwrot: 0, przywozka: 0, polka: 3, reszta: 0 });
  assert.equal(r.polka_klamie, 7);
});

test('wDrodze i wszystkie obejmuja KAZDY rodzaj', () => {
  // Konsumenci maja uzywac tych pol zamiast skladac [...dostawy, ...zwroty] recznie -
  // tak zniknely przywozki z /ruchy/rozloz i z reguly "cala ilosc" w /lok.
  const r = rozbijStanK4(30, 0, [
    dok('dostawa', 10, '2026-07-20'), dok('zwrot', 10, '2026-07-20'), dok('przywozka', 10, '2026-07-20'),
  ]);
  assert.equal(r.wszystkie.length, 3);
  assert.equal(r.wDrodze, 30);
});

test('wartosci brzegowe nie wysadzaja rachunku', () => {
  assert.equal(rozbijStanK4(0, 0, []).reszta, 0);
  assert.equal(rozbijStanK4(-5, 10, []).polka, 0, 'ujemny stan GT traktujemy jak zero');
  assert.equal(rozbijStanK4(10, -5, []).polka, 0, 'ujemna kopia WMS traktowana jak zero');
  assert.equal(rozbijStanK4(10, 5, null).polka, 5, 'brak listy dokumentow nie wysadza');
  assert.equal(rozbijStanK4(undefined, undefined, []).reszta, 0);
});

// Licznik rozlozonych dostaje dok_Id dokumentu - numer PZ zmienia sie przy edycji FZ w Subiekcie
// (Intek 2026-11-18: PZ 3954/2026 -> PZ 4099/2026), dok_Id nie. Bez id cala dostawa wracala jako
// nierozlozona.
test('iloscRozlozona dostaje dok_id dokumentu (klucz odporny na przenumerowanie PZ)', () => {
  const wolania = [];
  const iloscRozlozona = (art, mag, nr, id) => { wolania.push({ art, mag, nr, id }); return id === 6974580 ? 96 : 0; };
  const d = { ...dok('dostawa', 96, '2026-11-04', 'PZ 4099/2026'), dok_id: 6974580 };
  const r = rozbijStanK4(95, 72, [d], { artykul_gt_id: '95947', magazyn: 'K4', iloscRozlozona });
  assert.deepEqual(wolania, [{ art: '95947', mag: 'K4', nr: 'PZ 4099/2026', id: 6974580 }]);
  assert.equal(r.dostawy.length, 0);
  assert.equal(r.polka, 72);
});

// --- Wydania do sklepu z nierozlozonej dostawy (MM 1941/2026, 2026-11-26) -------------------
// Biuro przydziela nowosci sklepom recznym MM z K4 do MAG/LS, zanim ktos rozlozy dostawe.
// Dostawa ma podpowiadac tylko to, co zostalo na palecie - wczesniej "Rozloz N" pokazywalo
// dokladnie wydane sztuki i magazynier dokladal LOK, ktory job scinal po 10 minutach.

const dostawa = (ilosc, data, pz_nr, dok_id) => ({ rodzaj: 'dostawa', ilosc, data, pz_nr, dok_id });

test('wydanie idzie do najnowszej dostawy sprzed wydania, nadmiar na starsza', () => {
  const stara = dostawa(10, '2026-11-01', 'PZ 1/2026', 1);
  const nowa = dostawa(5, '2026-11-20', 'PZ 2/2026', 2);
  const pozniejsza = dostawa(50, '2026-11-25', 'PZ 3/2026', 3);   // przyszla PO wydaniu - nie jej
  przydzielWydaniaSklepu([stara, nowa, pozniejsza], [{ nr: 'MM 1941/2026', data: '2026-11-24', ilosc: 8 }]);
  assert.deepEqual(nowa.wydane_sklep, [{ nr: 'MM 1941/2026', data: '2026-11-24', ilosc: 5 }]);
  assert.deepEqual(stara.wydane_sklep, [{ nr: 'MM 1941/2026', data: '2026-11-24', ilosc: 3 }]);
  assert.deepEqual(pozniejsza.wydane_sklep, []);
});

test('wydanie bez dostawy sprzed niego przepada (MM z polki)', () => {
  const d = dostawa(20, '2026-11-25', 'PZ 9/2026', 9);
  przydzielWydaniaSklepu([d], [{ nr: 'MM 5/2026', data: '2026-11-10', ilosc: 4 }]);
  assert.deepEqual(d.wydane_sklep, []);
});

test('HWHHDJ95: paleta 56, 2 szt. do sklepu przed rozlozeniem, 1 WZ - dostawa podpowiada 53, nie 56', () => {
  const d = dostawa(56, '2026-11-20', 'PZ 4148/2026', 7000001);
  przydzielWydaniaSklepu([d], [{ nr: 'MM 1941/2026', data: '2026-11-24', ilosc: 2 }]);
  // nic jeszcze nie rozlozone; stan GT K4 = 56 - 2 (MM) - 1 (WZ) = 53, polka WMS 0
  const r = rozbijStanK4(53, 0, [d], {
    artykul_gt_id: '96756', iloscRozlozona: () => 0, pierwszeRozlozenie: () => null,
  });
  assert.equal(r.dostawy[0].ilosc, 53);
  assert.equal(r.reszta, 0);
  // Po rozlozeniu 53 dokument pokazuje jeszcze 1 szt. - to WZ sprzed rozlozenia. Sprzedazy
  // celowo NIE odejmujemy od dostawy (regula #3: zejscie bierze polka), ta zmiana dotyczy
  // wylacznie wydan do sklepu. Wczesniej zostawalo tu 3.
  const po = rozbijStanK4(53, 53, [d], {
    artykul_gt_id: '96756', iloscRozlozona: () => 53, pierwszeRozlozenie: () => '2026-11-26',
  });
  assert.equal(po.dostawy[0].ilosc, 1);
});

test('MATJMJ86: paleta 96, 2 szt. do sklepu - podpowiedz 94, po rozlozeniu 94 nic nie zostaje', () => {
  const d = dostawa(96, '2026-11-20', 'PZ 4149/2026', 7000002);
  przydzielWydaniaSklepu([d], [{ nr: 'MM 1941/2026', data: '2026-11-24', ilosc: 2 }]);
  const przed = rozbijStanK4(94, 0, [d], { artykul_gt_id: '1', iloscRozlozona: () => 0, pierwszeRozlozenie: () => null });
  assert.equal(przed.dostawy[0].ilosc, 94);
  const po = rozbijStanK4(94, 94, [d], { artykul_gt_id: '1', iloscRozlozona: () => 94, pierwszeRozlozenie: () => '2026-11-25' });
  assert.equal(po.dostawy.length, 0, 'zadnego "Rozloz 2" po rozlozeniu calej palety');
  assert.equal(po.polka, 94);
});

test('wydanie PO pierwszym rozlozeniu poszlo z polki - dostawy nie pomniejsza (NATJBG59)', () => {
  // PZ 4149 rozkladany 23.11 (42 na K4, 158 na gore), MM 1941 do sklepu 24.11 - z polki
  const d = dostawa(210, '2026-11-20', 'PZ 4149/2026', 7000002);
  przydzielWydaniaSklepu([d], [{ nr: 'MM 1941/2026', data: '2026-11-24', ilosc: 2 }]);
  assert.equal(wydaneZPalety(d, '2026-11-23'), 0);
  const r = rozbijStanK4(50, 40, [d], {
    artykul_gt_id: '1', iloscRozlozona: () => 200, pierwszeRozlozenie: () => '2026-11-23',
  });
  // 10 szt. zostalo na palecie wg dokumentu - wydanie z polki ich nie zjada
  assert.equal(r.dostawy[0].ilosc, 10);
  assert.equal(r.polka, 40);
});

test('wydanie w dniu pierwszego rozlozenia liczy sie jako z palety', () => {
  const d = dostawa(30, '2026-11-20', 'PZ 7/2026', 7);
  przydzielWydaniaSklepu([d], [{ nr: 'MM 8/2026', data: '2026-11-24', ilosc: 6 }]);
  assert.equal(wydaneZPalety(d, '2026-11-24'), 6);
  assert.equal(wydaneZPalety(d, '2026-11-23'), 0);
  assert.equal(wydaneZPalety(d, null), 6, 'bez rozlozenia liczy sie kazde wydanie');
});

test('inwariant sumy trzyma sie takze z wydaniami do sklepu', () => {
  const d = dostawa(56, '2026-11-20', 'PZ 4148/2026', 1);
  przydzielWydaniaSklepu([d], [{ nr: 'MM 1941/2026', data: '2026-11-24', ilosc: 2 }]);
  for (const [stan, wms] of [[53, 0], [53, 53], [60, 0], [10, 30], [0, 0]]) {
    const r = rozbijStanK4(stan, wms, [d], { artykul_gt_id: '1', iloscRozlozona: () => 0, pierwszeRozlozenie: () => null });
    assert.equal(r.wDrodze + r.polka + r.reszta, stan, `stan=${stan} wms=${wms}`);
  }
});
