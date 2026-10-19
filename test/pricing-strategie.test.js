'use strict';

const test = require('node:test');
const assert = require('node:assert');

const s = require('../pricing/strategie');
const { pasyZWyceny } = require('../pricing/pas');
const { zGranicami, ocenCene } = require('../pricing/granice');

const strat = (typ, parametry = {}, nazwa = 'T') => {
  const w = s.walidujStrategie({ nazwa, typ, parametry });
  assert.ok(!w.blad, w.blad);
  return { id: 1, ...w };
};

test('strategie: walidacja uzupełnia domyślne i pilnuje zakresów', () => {
  assert.deepStrictEqual(s.walidujStrategie({ nazwa: ' Marża  10 ', typ: 'marza', parametry: { marza: '10,5' } }),
    { nazwa: 'Marża 10', typ: 'marza', parametry: { marza: 10.5, minzysk: 5, mnoznik: 1.5 } });
  assert.deepStrictEqual(s.walidujStrategie({ nazwa: 'W', typ: 'wyprzedaz' }).parametry, { zysk: 0, mnoznik: 1.5, stanKoniec: 0 });
  assert.deepStrictEqual(s.walidujStrategie({ nazwa: 'R', typ: 'za_rynkiem' }).parametry, { marza: 20, mnoznik: 1.5, dni: 30, minSzt: 3 });
  assert.match(s.walidujStrategie({ nazwa: '', typ: 'marza' }).blad, /nazwę/);
  assert.match(s.walidujStrategie({ nazwa: 'X', typ: 'cokolwiek' }).blad, /nieznany typ/);
  assert.match(s.walidujStrategie({ nazwa: 'X', typ: 'marza', parametry: { marza: 95 } }).blad, /poza zakresem/);
  assert.match(s.walidujStrategie({ nazwa: 'X', typ: 'marza', parametry: { mnoznik: 1 } }).blad, /poza zakresem/);
  assert.match(s.walidujStrategie({ nazwa: 'X', typ: 'marza', parametry: { marza: 'abc' } }).blad, /niepoprawna liczba/);
  assert.match(s.walidujStrategie({ nazwa: 'X', typ: 'za_rynkiem', parametry: { minSzt: 2.5 } }).blad, /całkowitą/);
});

test('strategie: ostrzeżenia do potwierdzenia — strata i niska marża', () => {
  assert.deepStrictEqual(s.ostrzezeniaStrategii(strat('wyprzedaz', { zysk: -3 })).map((o) => o.kod), ['strata']);
  assert.deepStrictEqual(s.ostrzezeniaStrategii(strat('wyprzedaz')), []);
  assert.deepStrictEqual(s.ostrzezeniaStrategii(strat('marza', { marza: 8 })).map((o) => o.kod), ['marza']);
  assert.deepStrictEqual(s.ostrzezeniaStrategii(strat('marza', { marza: 15 })), []);
});

test('strategie: nadpisania kalkulatora per typ', () => {
  assert.deepStrictEqual(s.nadpisaniaKalkulatora(strat('marza', { marza: 12, minzysk: 3 })), [{ tryb: 'marza', marza: 12, minzysk: 3 }]);
  // wyprzedaż: próg minimalnego zysku kalkulatora (5 zł) schodzi razem z podłogą
  assert.deepStrictEqual(s.nadpisaniaKalkulatora(strat('wyprzedaz', { zysk: 0 })), [{ tryb: 'zysk', celZysk: 0, minzysk: 0 }]);
  assert.deepStrictEqual(s.nadpisaniaKalkulatora(strat('za_rynkiem'), null), [{ tryb: 'marza', marza: 20 }]);
  assert.deepStrictEqual(s.nadpisaniaKalkulatora(strat('za_rynkiem'), { zysk: 41.5 }), [{ tryb: 'marza', marza: 20 }, { tryb: 'zysk', celZysk: 41.5 }]);
});

test('strategie: mediana ważona sztukami i rynek referencyjny', () => {
  assert.strictEqual(s.mediana([{ cena: 10, szt: 1 }, { cena: 20, szt: 1 }, { cena: 12, szt: 1 }]), 12);
  assert.strictEqual(s.mediana([{ cena: 10, szt: 2 }, { cena: 20, szt: 2 }]), 15);
  assert.strictEqual(s.mediana([{ cena: 10, szt: 3 }, { cena: 20, szt: 1 }]), 10);
  assert.strictEqual(s.mediana([]), null);
  const zysk = { DE: (c) => ({ zysk: c * 2 }), EMPIK_PL: (c) => ({ zysk: c - 10 }), PL: () => null };
  const ocen = (k, c) => zysk[k]?.(c) ?? null;
  const ref = s.referencjaRynku({
    DE: { pozycje: [{ cena: 30, szt: 2 }] },                                         // 2 szt. < 3 — za mało dowodu
    EMPIK_PL: { pozycje: [{ cena: 80, szt: 2 }, { cena: 90, szt: 1 }, { cena: 200, szt: 1 }] }, // mediana 85, nie 200
    PL: { pozycje: [{ cena: 999, szt: 9 }] },                                         // bez kalkulatora — nie referencja
  }, ocen, { minSzt: 3 });
  assert.deepStrictEqual(ref, { kolumna: 'EMPIK_PL', zysk: 75, mediana: 85, szt: 4 });
  assert.strictEqual(s.referencjaRynku({ DE: { pozycje: [{ cena: 30, szt: 1 }] } }, ocen, { minSzt: 3 }), null);
});

test('strategie: koniec przypisania — data i wyprzedany stan', () => {
  const w = strat('wyprzedaz', { stanKoniec: 2 });
  assert.deepStrictEqual(s.koniecPrzypisania({ do: '2026-10-31' }, w, { dzis: '2026-10-31', stanRazem: 5 }), { koniec: false });
  assert.match(s.koniecPrzypisania({ do: '2026-10-31' }, w, { dzis: '2026-11-01', stanRazem: 5 }).powod, /minęła data/);
  assert.match(s.koniecPrzypisania({ do: '2026-10-31' }, w, { dzis: '2026-10-20', stanRazem: 2 }).powod, /wyprzedane/);
  // stan nieznany (GT padnięte) — nie kończymy po stanie
  assert.deepStrictEqual(s.koniecPrzypisania({ do: '2026-10-31' }, w, { dzis: '2026-10-20', stanRazem: null }), { koniec: false });
  // marża nie kończy się po stanie
  assert.deepStrictEqual(s.koniecPrzypisania({ do: null }, strat('marza'), { dzis: '2026-10-20', stanRazem: 0 }), { koniec: false });
  assert.match(s.walidujKoniec('', w, '2026-10-19').blad, /wymaga daty/);
  assert.match(s.walidujKoniec('2026-10-18', w, '2026-10-19').blad, /minęła/);
  assert.deepStrictEqual(s.walidujKoniec('2026-10-19', w, '2026-10-19'), { do: '2026-10-19' });
  assert.deepStrictEqual(s.walidujKoniec('', strat('marza'), '2026-10-19'), { do: null });
  assert.match(s.walidujKoniec('19.10.2026', strat('marza'), '2026-10-19').blad, /niepoprawna data/);
});

test('strategie: skutek aktywacji na ofercie (podgląd)', () => {
  const o = (x) => ({ auto: 1, cena: 20, wysylka: 0, bb_nasz: 0, bb_cena: 15, ...x });
  assert.strictEqual(s.skutek(o({ cena: 20 }), { min: 18, max: 27 }, { min: 22, max: 33 }).kod, 'w_gore');
  assert.strictEqual(s.skutek(o({ cena: 20 }), { min: 18, max: 27 }, { min: 14, max: 21 }).kod, 'w_dol');   // BB 15 był pod podłogą 18
  assert.strictEqual(s.skutek(o({ bb_nasz: 1 }), { min: 18, max: 27 }, { min: 19, max: 30 }).kod, 'miejsce');
  assert.strictEqual(s.skutek(o({ bb_nasz: 1, cena: 26 }), { min: 18, max: 27 }, { min: 15, max: 22.5 }).kod, 'sufit');
  assert.strictEqual(s.skutek(o({ bb_cena: 25 }), { min: 18, max: 27 }, { min: 17, max: 25.5 }).kod, 'bez_zmian');
  assert.match(s.skutek(o({ auto: 0, cena: 10 }), { min: 18, max: 27 }, { min: 22, max: 33 }).tekst, /tylko podpowiedź/);
  assert.strictEqual(s.skutek(o({}), { min: 18, max: 27 }, null).kod, 'brak_pasa');
  // strategia nie zmienia granic (np. „za rynkiem” bez dowodu sprzedaży) — to nie ona podniesie cenę
  assert.match(s.skutek(o({ cena: 10 }), { min: 18, max: 27 }, { min: 18, max: 27 }).tekst, /nie zmienia granic/);
  assert.match(s.skutek(o({ cena: 10 }), { min: 18, max: 27 }, { min: 22, max: 33 }).tekst, /już dziś pod minimum/);
});

// Pas strategii z prawdziwego kalkulatora (config/rynki.js) — towar 50 zł, 1 kg.
const W = { koszt: 50, waga: 1, docinalny: false };

test('strategie: All marża X — niższa podłoga, max = min × mnożnik, pas bazowy zapamiętany', () => {
  const baza = pasyZWyceny(W);
  const p = pasyZWyceny(W, { strategia: strat('marza', { marza: 10, mnoznik: 1.8 }, 'Marża 10') });
  for (const k of ['DE', 'FR', 'EMAG_RO', 'EMPIK_PL']) {
    assert.ok(p[k].min < baza[k].min, `${k}: ${p[k].min} < ${baza[k].min}`);
    assert.strictEqual(p[k].max, +(p[k].min * 1.8).toFixed(2));
    assert.deepStrictEqual(p[k].bazowy, { min: baza[k].min, max: baza[k].max });
    assert.strictEqual(p[k].zrodlo, 'strategia');
    assert.deepStrictEqual(p[k].strategia, { id: 1, nazwa: 'Marża 10', typ: 'marza' });
    assert.ok(p[k].ocen(p[k].min).marza >= 9, `${k}: marża przy podłodze ${p[k].ocen(p[k].min).marza}`);
  }
  assert.strictEqual(p.PL, undefined);                              // Amazon PL bez kalkulatora — bez pasa jak dziś
});

test('strategie: wyprzedaż — podłoga przy zysku ~0 zł', () => {
  const p = pasyZWyceny(W, { strategia: strat('wyprzedaz') });
  for (const k of ['DE', 'EMAG_RO', 'EMPIK_PL', 'KAUFLAND_DE']) {
    const z = p[k].ocen(p[k].min).zysk;
    assert.ok(Math.abs(z) < 2.5, `${k}: zysk przy podłodze ${z} (cena zaokrąglana do ,99)`);
  }
});

test('strategie: za rynkiem — zysk z mediany najlepszego rynku staje się podłogą, tylko w górę', () => {
  const baza = pasyZWyceny(W);
  const cenaEmpik = Math.round(baza.EMPIK_PL.min * 1.4 * 100) / 100;       // Empik sprzedaje drożej niż minimum
  const st = { ...strat('za_rynkiem', {}, 'Za rynkiem'), sprzedaz: { EMPIK_PL: { pozycje: [{ cena: cenaEmpik, szt: 4 }] }, DE: { pozycje: [{ cena: baza.DE.min, szt: 1 }] } } };
  const p = pasyZWyceny(W, { strategia: st });
  const ref = baza.EMPIK_PL.ocen(cenaEmpik).zysk;
  assert.strictEqual(p.DE.referencja.kolumna, 'EMPIK_PL');
  assert.ok(Math.abs(p.DE.referencja.zysk - ref) < 0.01);
  for (const k of ['DE', 'FR', 'EMAG_RO']) {
    assert.ok(p[k].min >= baza[k].min, `${k}: podłoga tylko w górę`);
    assert.ok(Math.abs(p[k].ocen(p[k].min).zysk - ref) < 2.5, `${k}: zysk przy podłodze ${p[k].ocen(p[k].min).zysk} ≈ ${ref}`);
  }
  // bez dowodu sprzedaży — podłoga bazowa (marża 20%)
  const bez = pasyZWyceny(W, { strategia: { ...st, sprzedaz: {} } });
  assert.strictEqual(bez.DE.min, baza.DE.min);
  assert.strictEqual(bez.DE.referencja, null);
});

test('strategie: ręczne granice oferty = odstępstwo od strategii', () => {
  const p = pasyZWyceny(W, { strategia: strat('marza', { marza: 10 }, 'Marża 10') }).DE;
  const bez = zGranicami(p, {});
  assert.deepStrictEqual([bez.zrodlo_min, bez.zrodlo_max, bez.min, bez.strategia.nazwa], ['strategia', 'strategia', p.min, 'Marża 10']);
  const reczne = zGranicami(p, { min_reczne: p.min + 3 });
  assert.deepStrictEqual([reczne.zrodlo_min, reczne.min, reczne.strategia.nazwa], ['reczne', p.min + 3, 'Marża 10']);
  assert.match(ocenCene(p.min - 1, { pas: bez }).ostrzezenia.find((o) => o.kod === 'pod_min').tekst, /strategia „Marża 10”/);
});
