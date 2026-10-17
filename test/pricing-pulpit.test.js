'use strict';

const test = require('node:test');
const assert = require('node:assert');

const m = require('../pricing/pulpit-model');
const filtry = require('../pricing/filtry-cen');
const { KOLUMNY } = require('../pricing/kolumny');

const T = new Date('2026-10-17T22:00:00Z');
const godz = (h) => m.doBazy(T.getTime() - h * 3600e3);
const of = (o) => ({ tw_id: o.id, kolumna: 'DE', ilosc: 5, auto: 0, bb_nasz: 0, w: godz(0.5), zysk: null, ...o });

test('pulpit: stan w chwili T — odcinek potwierdzony za dawno nie liczy się (oferta wypadła z obserwacji)', () => {
  const s = m.stanNaChwile([
    of({ id: 1, bb_nasz: 1 }),
    of({ id: 2, bb_nasz: 1, w: godz(9) }),          // ostatnio widziana 9 h przed T — bez stanu, nie obserwujemy
    of({ id: 3, bb_nasz: 0, w: godz(7) }),          // 7 h: pełny przegląd co 6 h, jeszcze się liczy
  ], T).get('DE');
  assert.strictEqual(s.wszystkie.ofert, 2);
  assert.strictEqual(s.wszystkie.bb, 1);
  // „teraz” — populacja z macierzy, ostatni znany stan jak w macierzy
  assert.strictEqual(m.stanNaChwile([of({ id: 2, bb_nasz: 1, w: godz(9) })], T, { bezSwiezosci: true }).get('DE').wszystkie.bb, 1);
});

test('pulpit: jedna oferta na towar i kanał (większy stan), zysk tylko z ofert z automatem i Buy Boxem', () => {
  const s = m.stanNaChwile([
    of({ id: 10, tw_id: 7, ilosc: 1, bb_nasz: 1, auto: 1, zysk: 5 }),
    of({ id: 11, tw_id: 7, ilosc: 9, bb_nasz: 0, auto: 1, zysk: 3 }),   // NERE0011-1: ta sama komórka macierzy
    of({ id: 12, tw_id: 8, bb_nasz: 1, auto: 1, zysk: 4 }),
    of({ id: 13, tw_id: 9, bb_nasz: 0, auto: 1, zysk: 16755 }),           // cena-zapora bez BB nie wchodzi do sumy
    of({ id: 14, tw_id: 9, kolumna: 'FR', bb_nasz: 1 }),
  ], T);
  assert.deepStrictEqual([s.get('DE').wszystkie.ofert, s.get('DE').wszystkie.bb], [3, 1]);
  assert.deepStrictEqual([s.get('DE').automat.ofert, s.get('DE').automat.bb, s.get('DE').automat.zysk, s.get('DE').automat.zysk_n], [3, 1, 4, 1]);
  assert.deepStrictEqual([...s.get('DE').wszystkie.ids].sort(), [11, 12, 13]);
  assert.strictEqual(s.get('FR').automat.ofert, 0);
  assert.deepStrictEqual(m.liczbyStanu(s).get('DE'), { wszystkie: { ofert: 3, bb: 1 }, automat: { ofert: 3, bb: 1, zysk: 4, zysk_n: 1 } });
});

test('pulpit: bilans Buy Boxów — zyskane/stracone tylko wśród ofert widzianych w obu chwilach', () => {
  const teraz = m.stanNaChwile([of({ id: 1, bb_nasz: 1 }), of({ id: 2, bb_nasz: 1 }), of({ id: 3 }), of({ id: 4, bb_nasz: 1 })], T).get('DE').wszystkie;
  const wczoraj = m.stanNaChwile([of({ id: 1, bb_nasz: 1 }), of({ id: 2 }), of({ id: 3, bb_nasz: 1 }), of({ id: 5, bb_nasz: 1 })], T).get('DE').wszystkie;
  // id 4 doszła (nowa oferta), id 5 wypadła — zmieniają liczbę, ale to nie wygrana ani przegrana
  assert.deepStrictEqual(m.bilansBb(teraz, wczoraj), { teraz: 3, ofert: 4, przed: 3, zmiana: 0, zyskane: 1, stracone: 1 });
  // kanał bez obserwacji wtedy (eMAG HU przed 15.10) — nie porównujemy z zerem
  assert.deepStrictEqual(m.bilansBb(teraz, undefined), { teraz: 3, ofert: 4, przed: null, zmiana: null, zyskane: null, stracone: null });
  assert.strictEqual(m.bilansBb(undefined, wczoraj), null);
  const suma = m.zsumujBilanse([m.bilansBb(teraz, wczoraj), m.bilansBb(teraz, undefined), null]);
  assert.deepStrictEqual(suma, { teraz: 6, ofert: 8, przed: 3, zmiana: 0, zyskane: 1, stracone: 1, czesciowo: true });
  assert.deepStrictEqual(m.zsumujBilanse([m.bilansBb(teraz, undefined)]).zmiana, null);
});

test('pulpit: potwierdzenie ceny — grosze eMAG tak, stara cena przy schodku 1 Ft nie', () => {
  assert.ok(m.cenaPotwierdzona(10658.87, 10658.9, 10348.45));   // HU: netto 4 miejsca → brutto liczy eMAG
  assert.ok(m.cenaPotwierdzona(25.87, 25.86, 25.11));           // BG
  assert.ok(m.cenaPotwierdzona(7942.41, 7942.27, 8360.28));
  assert.ok(m.cenaPotwierdzona(47.18, 47.18, 47.76));           // Amazon — dokładnie
  assert.ok(!m.cenaPotwierdzona(47.76, 47.18, 47.76));          // dalej stara cena
  assert.ok(!m.cenaPotwierdzona(7000, 6999, 7000));             // schodek 1 Ft — stara cena to nie potwierdzenie
  assert.ok(!m.cenaPotwierdzona(null, 10, 9));
});

test('pulpit: warunek potwierdzenia w SQL = ten sam co w JS', () => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const sql = db.prepare(`SELECT ${m.sqlCenaPotwierdzona(':o', ':n', ':p')} AS ok`);
  const przypadki = [[10658.87, 10658.9, 10348.45], [25.87, 25.86, 25.11], [47.76, 47.18, 47.76], [7000, 6999, 7000],
    [47.18, 47.18, 47.76], [10, 10.004, null], [10, 10.01, null], [null, 10, 9], [100.09, 100, 80], [100.11, 100, 80]];
  for (const [obs, nowa, przed] of przypadki) {
    assert.strictEqual(!!sql.get({ o: obs, n: nowa, p: przed }).ok, m.cenaPotwierdzona(obs, nowa, przed), `${obs} / ${nowa} / ${przed}`);
  }
});

test('pulpit: aktywność — okna 24 h / 7 dni, ręczne osobno, niepotwierdzona tylko ostatnia wysyłka', () => {
  const w = (o) => ({ oferta_id: 1, kolumna: 'DE', sku: 'X', cena_przed: 10, cena_nowa: 9, kod: 'obnizka', wyslano: 1, blad: null, potw: null, ...o });
  const a = m.aktywnosc([
    w({ czas: godz(2), potw: godz(1.5) }),                                         // w dół, potwierdzona po 30 min
    w({ czas: godz(3), cena_nowa: 11, kod: 'podwyzka', potw: godz(2.9) }),           // w górę, po 6 min
    w({ oferta_id: 2, czas: godz(30), kod: 'korekta', cena_nowa: 12 }),             // ręczna, sprzed doby, nigdy niewidziana
    w({ oferta_id: 3, czas: godz(5), wyslano: 0, blad: 'Invalid price' }),
    w({ oferta_id: 4, czas: godz(4) }),                                            // zastąpiona późniejszą wysyłką
    w({ oferta_id: 4, czas: godz(3) }),                                            // ostatnia, >60 min, niewidziana
    w({ oferta_id: 5, czas: godz(0.5) }),                                          // świeża — jeszcze „w drodze”
    w({ oferta_id: 6, czas: godz(200) }),                                          // poza oknem 7 dni
  ], T);
  const de = a.get('DE');
  assert.deepStrictEqual(de.h24, { gora: 1, dol: 4, reczne: 0, odrzucone: 1 });
  assert.deepStrictEqual(de.d7, { gora: 1, dol: 4, reczne: 1, odrzucone: 1 });
  assert.strictEqual(de.niepotwierdzone, 2);                                      // oferta 2 i 4 (druga wysyłka)
  assert.deepStrictEqual(de.potwierdzenie, { n: 2, mediana: 18, p90: 27.6, max: 30 });
  assert.deepStrictEqual(de.ostatni_blad, { czas: godz(5), sku: 'X', tekst: 'Invalid price' });
  assert.deepStrictEqual(a.get('razem').d7, de.d7);
});

test('pulpit: „czeka na potwierdzenie” — ta sama reguła co w macierzy', () => {
  const c = m.czekajace([
    { kolumna: 'DE', wyslano: 1, dec_czas: godz(0.5), obs_czas: godz(1) },        // wysłane po obserwacji — czeka
    { kolumna: 'DE', wyslano: 1, dec_czas: godz(2), obs_czas: godz(1) },          // nowsza obserwacja — nie
    { kolumna: 'DE', wyslano: 0, dec_czas: godz(0.5), obs_czas: godz(1) },
    { kolumna: 'FR', wyslano: 1, dec_czas: godz(1.5), obs_czas: null },
  ], T);
  assert.deepStrictEqual(c.get('DE'), { n: 1, najdluzej_min: 30 });
  assert.deepStrictEqual(c.get('razem'), { n: 2, najdluzej_min: 90 });
});

test('pulpit: liczniki sytuacji per kanał = to, co macierz pokaże po kliknięciu', () => {
  const oferty = [
    { kolumna: 'DE', auto: 1, kod: 'wojna_cenowa', bb_nasz: 0, cena: 20, min: 15 },
    { kolumna: 'DE', auto: 0, kod: 'top', bb_nasz: 1, cena: 12, min: 15 },
    { kolumna: 'FR', auto: 0, kod: 'brak_pasa', bb_nasz: 0, cena: 20, min: null, blokada: 'Invalid price' },
  ];
  const s = m.sytuacjeKanalow(oferty);
  // macierz: kanał DE, każdy towar ma jedną komórkę — chip sytuacji liczy towary
  const towary = oferty.filter((o) => o.kolumna === 'DE').map((o, i) => ({ symbol: `S${i}`, rynki: { DE: o } }));
  for (const zakres of ['wszystkie', 'automat']) {
    const chipy = filtry.chipy(towary, zakres, 'wszystkie').sytuacje;
    for (const c of chipy) assert.strictEqual(s.get('DE')[zakres][c.klucz], c.n, `${zakres}/${c.klucz}`);
  }
  assert.deepStrictEqual([s.get('FR').wszystkie.zablokowane, s.get('FR').wszystkie.brak_danych], [1, 1]);
});

test('pulpit: zdrowie workera i synchronizacji', () => {
  const stan = {
    przebieg: { wartosc: JSON.stringify({ ofert: 4632, sekundy: 212, wysylka: { wyslane: 2, odrzucone: 0 } }), czas: godz(0.4) },
    blad: { wartosc: 'fetch failed', czas: godz(11) },                              // stary błąd — już nieaktualny
    sync_oferty: { wartosc: '[]', czas: godz(12) },
    sync_emag: { wartosc: '{}', czas: godz(0.4) },
    blad_emag: { wartosc: 'RO: HTTP 500', czas: godz(0.2) },                        // po ostatniej synchronizacji
    sync_kaufland: { wartosc: '{}', czas: godz(3) },                                // co przebieg, a 3 h nic
  };
  const z = m.zdrowie({ stan, teraz: T, interwalMin: 30, zapis: true, platformy: new Set(['amazon', 'emag', 'empik', 'kaufland']) });
  assert.strictEqual(z.worker.stan, 'ok');
  assert.strictEqual(z.worker.sekundy, 212);
  assert.strictEqual(z.worker.blad, null);
  const p = Object.fromEntries(z.platformy.map((x) => [x.platforma, x.stan]));
  assert.deepStrictEqual(p, { amazon: 'ok', emag: 'blad', empik: 'opoznienie', allegro: 'brak', kaufland: 'opoznienie' });
  assert.strictEqual(z.zapis, true);
  // świeży błąd po ostatnim udanym przebiegu
  assert.strictEqual(m.zdrowie({ stan: { ...stan, blad: { wartosc: 'x', czas: godz(0.1) } }, teraz: T }).worker.stan, 'blad');
  // od 2 interwałów (+15 min) nic — worker stoi
  assert.strictEqual(m.zdrowie({ stan: { przebieg: { wartosc: '{}', czas: godz(1.5) } }, teraz: T, interwalMin: 30 }).worker.stan, 'stoi');
  assert.strictEqual(m.zdrowie({ stan: {}, teraz: T }).worker.stan, 'brak');
});

test('pulpit: źródło zamówienia z FS → kanał repricera', () => {
  const klucze = new Set(KOLUMNY.map((k) => k.klucz));
  const k = (z, w = 'EUR') => m.kolumnaZrodla(z, w, klucze);
  assert.strictEqual(k('Amazon_DE'), 'DE');
  assert.strictEqual(k('Amazon_FR'), 'FR');
  assert.strictEqual(k('Amazon_IT'), 'IT');
  assert.strictEqual(k('amazon', 'PLN'), 'PL');                   // BaseLinker: Amazon PL
  assert.strictEqual(k('amazon', 'EUR'), m.INNE);
  assert.strictEqual(k('Kaufland_DE'), 'KAUFLAND_DE');
  assert.strictEqual(k('emagro', 'RON'), 'EMAG_RO');
  assert.strictEqual(k('emaghu', 'HUF'), 'EMAG_HU');
  assert.strictEqual(k('emagbg'), 'EMAG_BG');
  assert.strictEqual(k('empik', 'PLN'), 'EMPIK_PL');
  assert.strictEqual(k('Allegro - ekajtek_pl', 'CZK'), 'ALLEGRO_EKAJTEK');
  assert.strictEqual(k('Allegro - NaTropieZabawek', 'PLN'), 'ALLEGRO_NATROPIE');
  assert.strictEqual(k('marketplace'), m.MARKETPLACE);            // Sellasist przed 14.10 — kanał nieznany
  for (const z of ['personal', 'tergpl', '', null, 'Amazon_XX']) assert.strictEqual(k(z), m.INNE);
});

test('pulpit: sprzedaż z FS per kanał i trend z pustymi dniami', () => {
  const klucze = new Set(['DE', 'EMAG_HU']);
  const s = m.sprzedazKanalami(
    [{ dzien: '2026-10-16', zrodlo: 'Amazon_DE', waluta: 'EUR', zamowien: 3, szt: 4 }, { dzien: '2026-10-16', zrodlo: 'personal', waluta: 'PLN', zamowien: 1, szt: 9 }],
    [{ dzien: '2026-10-16', zrodlo: 'Amazon_DE', waluta: 'EUR', tw_id: 7, szt: 3 }, { dzien: '2026-10-16', zrodlo: 'Amazon_DE', waluta: 'EUR', tw_id: 8, szt: 1 }],
    new Map([['DE', new Set([7])]]), klucze);
  assert.deepStrictEqual(s.get('2026-10-16').get('DE'), { zamowien: 3, szt: 4, szt_auto: 3 });
  const dni = [{ dzien: '2026-10-15' }, { dzien: '2026-10-16' }];
  const st = (bb, auto) => ({ wszystkie: { ofert: 10, bb }, automat: { ofert: auto ? 2 : 0, bb: auto ? 1 : 0, zysk: auto ? 12.5 : 0, zysk_n: auto ? 1 : 0 } });
  const stany = new Map([['2026-10-15', new Map([['DE', st(5, true)]])], ['2026-10-16', new Map([['DE', st(6, true)], ['EMAG_HU', st(40, false)]])]]);
  const t = m.zlozTrend(dni, stany, s, klucze);
  assert.deepStrictEqual(t.dni, ['2026-10-15', '2026-10-16']);
  assert.deepStrictEqual(t.kanaly.DE[1], { bb: 6, bb_auto: 1, zysk_auto: 12.5, zysk_auto_n: 1, zamowien: 3, szt: 4, szt_auto: 3 });
  assert.strictEqual(t.kanaly.EMAG_HU[0].bb, null);                 // HU jeszcze nieobserwowany — punkt pusty, nie zero
  assert.strictEqual(t.kanaly.DE[0].zamowien, 0);                   // FS są, tylko tego dnia nic
  assert.deepStrictEqual(t.kanaly.razem[1], { bb: 46, bb_auto: 1, zysk_auto: 12.5, zysk_auto_n: 1, zamowien: 4, szt: 13, szt_auto: 3 });
  assert.deepStrictEqual(t.braki.bb, [['EMAG_HU'], []]);            // suma z 15.10 bez HU — niepełna
  assert.deepStrictEqual(t.braki.bb_auto, [[], []]);
  // Buy Boxy są, zysku brak (Amazon PL bez kalkulatora) — „—”, nie zero
  const bezZysku = new Map([['2026-10-16', new Map([['DE', { wszystkie: { ofert: 5, bb: 2 }, automat: { ofert: 3, bb: 2, zysk: 0, zysk_n: 0 } }]])]]);
  assert.deepStrictEqual([m.zlozTrend([{ dzien: '2026-10-16' }], bezZysku, null, klucze).kanaly.DE[0].zysk_auto], [null]);
  // GT nie odpowiada — sprzedaż pusta, Buy Boxy zostają
  assert.strictEqual(m.zlozTrend(dni, stany, null, klucze).kanaly.DE[1].zamowien, null);
});

test('pulpit: dni okna w czasie lokalnym, dzisiejszy kończy się teraz', () => {
  const teraz = new Date(2026, 10, 1, 9, 30);                     // 1 listopada, po zmianie czasu
  const d = m.dniOkna(3, teraz);
  assert.deepStrictEqual(d.map((x) => x.dzien), ['2026-10-30', '2026-10-31', '2026-11-01']);
  assert.deepStrictEqual(d.map((x) => x.zamkniety), [true, true, false]);
  assert.strictEqual(d[2].koniec.getTime(), teraz.getTime());
  assert.strictEqual(d[1].koniec.getTime(), new Date(2026, 10, 1).getTime());
  assert.strictEqual(m.oknoTrendu('30'), 30);
  assert.strictEqual(m.oknoTrendu('999'), 14);
});
