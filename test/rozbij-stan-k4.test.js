'use strict';

// Testy rdzenia rachunku "co lezy na K4" - rozbijStanK4 z services/gt-dokumenty.js.
// Uruchomienie: node --test test/
//
// Czemu akurat ta funkcja ma testy, a reszta nie: to JEDYNE miejsce, gdzie zapisana jest
// definicja "ile zostalo do rozlozenia" i "co schodzi po czym". Kolejnosc zjadania jest
// decyzja biznesowa usera (2026-07-17), a w kodzie wychodzi z ODWROTNEJ kolejnosci
// przydzialu budzetu - czyli z rzeczy, ktora wyglada sensownie takze wtedy, gdy jest
// napisana na odwrot. Bez testu nastepna osoba "poprawi" sort jednym ruchem.
//
// Testy nie dotykaja GT ani SQLite: rozbijStanK4 czyta baze tylko przez
// iloscRozlozonaZDokumentu, a to wywolanie jest pomijane, gdy nie podamy artykul_gt_id.

const test = require('node:test');
const assert = require('node:assert/strict');

const { rozbijStanK4, RODZAJE_STREF, PRIORYTET_PRZYDZIALU } = require('../services/gt-dokumenty');

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

test('kolejnosc przy pustej polce: dostawa -> zwrot -> przywozka', () => {
  // Kazdy rodzaj po 10 szt., polka pusta. Obnizamy stan i patrzymy, co znika pierwsze.
  const d = [dok('dostawa', 10, '2026-07-20'), dok('zwrot', 10, '2026-07-20'), dok('przywozka', 10, '2026-07-20')];

  // Pelny stan: wszystko sie miesci.
  assert.deepEqual(sumy(rozbijStanK4(30, 0, d)), { dostawa: 10, zwrot: 10, przywozka: 10, polka: 0, reszta: 0 });

  // Brakuje 5 -> zjada DOSTAWA (pierwsza w kolejnosci zjadania).
  assert.deepEqual(sumy(rozbijStanK4(25, 0, d)), { dostawa: 5, zwrot: 10, przywozka: 10, polka: 0, reszta: 0 });

  // Brakuje 15 -> dostawa na zerze, zaczyna schodzic ZWROT.
  assert.deepEqual(sumy(rozbijStanK4(15, 0, d)), { dostawa: 0, zwrot: 5, przywozka: 10, polka: 0, reszta: 0 });

  // Brakuje 25 -> zostaje sama PRZYWOZKA (ostatnia w kolejnosci zjadania).
  assert.deepEqual(sumy(rozbijStanK4(5, 0, d)), { dostawa: 0, zwrot: 0, przywozka: 5, polka: 0, reszta: 0 });
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

test('rodzaj bije date: swieza dostawa schodzi przed starym zwrotem', () => {
  // To jest sedno decyzji usera - samo FIFO dalo by tu odwrotnie.
  const zwrotStary = dok('zwrot', 2, '2026-07-01');
  const dostawaSwieza = dok('dostawa', 20, '2026-07-20');
  const r = rozbijStanK4(21, 0, [zwrotStary, dostawaSwieza]);
  assert.deepEqual(sumy(r), { dostawa: 19, zwrot: 2, przywozka: 0, polka: 0, reszta: 0 });
});

test('KOLEJNOSC PRZYDZIALU jest ODWROTNA do kolejnosci zjadania', () => {
  // Straznik przed najlatwiejsza pomylka w tym pliku. Kto schodzi pierwszy (dostawa),
  // musi miec NAJWYZSZY priorytet przydzialu, bo dostaje resztowke budzetu.
  assert.ok(PRIORYTET_PRZYDZIALU.dostawa > PRIORYTET_PRZYDZIALU.zwrot,
    'dostawa schodzi przed zwrotem => przydzial dostawy jest PO zwrocie');
  assert.ok(PRIORYTET_PRZYDZIALU.zwrot > PRIORYTET_PRZYDZIALU.przywozka,
    'zwrot schodzi przed przywozka => przydzial zwrotu jest PO przywozce');
});

test('kazdy rodzaj z RODZAJE_STREF ma priorytet (czwarty rodzaj nie wypadnie po cichu)', () => {
  // Ten sam blad trafil sie juz cztery razy - za kazdym razem dlatego, ze ktos skladal
  // liste rodzajow recznie i o jednym zapomnial.
  assert.deepEqual(
    Object.keys(RODZAJE_STREF).sort(),
    Object.keys(PRIORYTET_PRZYDZIALU).sort(),
    'RODZAJE_STREF i PRIORYTET_PRZYDZIALU musza opisywac te same rodzaje'
  );
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
