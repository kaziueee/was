'use strict';

// Kanał dokumentu — przypadki z prawdziwych FS/ZK OKITRADE (pomiary 2026-10-20, docs/analiza-sprzedazy.md).
const test = require('node:test');
const assert = require('node:assert');
const { kanalDokumentu, NAZWY_KANALOW } = require('../services/analiza-kanal');

const k = (d) => kanalDokumentu(d);

test('„Źródło” FS rozstrzyga kanał (Sellasist po 14.10, BaseLinker)', () => {
  assert.deepStrictEqual(k({ zrodlo_fs: 'Amazon_DE', kat_fs: 'Amazon_DE', waluta: 'EUR', kraj: 'Austria' }), { kanal: 'DE', rynek: 'DE', regula: 'zrodlo_fs' });
  assert.deepStrictEqual(k({ zrodlo_fs: 'Kaufland_DE', waluta: 'EUR' }), { kanal: 'KAUFLAND_DE', rynek: 'DE', regula: 'zrodlo_fs' });
  assert.deepStrictEqual(k({ zrodlo_fs: 'emaghu', waluta: 'HUF' }), { kanal: 'EMAG_HU', rynek: 'HU', regula: 'zrodlo_fs' });
  assert.deepStrictEqual(k({ zrodlo_fs: 'empik', waluta: 'PLN' }), { kanal: 'EMPIK_PL', rynek: 'PL', regula: 'zrodlo_fs' });
  assert.deepStrictEqual(k({ zrodlo_fs: 'amazon', waluta: 'PLN' }), { kanal: 'PL', rynek: 'PL', regula: 'zrodlo_fs' });
});

test('Allegro: konto z „Źródła”, rynek z waluty; konto spoza repricera to „Allegro (inne konto)”', () => {
  assert.deepStrictEqual(k({ zrodlo_fs: 'Allegro - ekajtek_pl', waluta: 'CZK' }), { kanal: 'ALLEGRO_EKAJTEK', rynek: 'CZ', regula: 'zrodlo_fs' });
  assert.deepStrictEqual(k({ zrodlo_fs: 'Allegro - NaTropieZabawek', waluta: 'EUR' }), { kanal: 'ALLEGRO_NATROPIE', rynek: 'SK', regula: 'zrodlo_fs' });
  assert.strictEqual(k({ zrodlo_fs: 'Allegro - OutletZabawek-pl', waluta: 'PLN' }).kanal, 'ALLEGRO');
  // FS bez „Źródła”, ZK z kategorią Internet (= Allegro, potwierdzone na 1527 ZK)
  assert.deepStrictEqual(k({ zrodlo_fs: '', kat_fs: 'Sprzedaż', kat_zk: 'Internet', waluta: 'PLN' }), { kanal: 'ALLEGRO', rynek: 'PL', regula: 'kategoria_zk' });
});

test('FS „marketplace” (Sellasist do 14.10): rynek z kategorii dokumentu, Amazon IT z kraju', () => {
  assert.deepStrictEqual(k({ zrodlo_fs: 'marketplace', kat_fs: 'Amazon_FR', waluta: 'EUR', kraj: 'Holandia' }), { kanal: 'FR', rynek: 'FR', regula: 'zrodlo_fs' });
  assert.strictEqual(k({ zrodlo_fs: 'marketplace', kat_fs: 'Kaufland', waluta: 'EUR' }).kanal, 'KAUFLAND_DE');
  assert.deepStrictEqual(k({ zrodlo_fs: 'marketplace', zrodlo_zk: 'marketplace', kat_fs: 'Sprzedaż', waluta: 'EUR', kraj: 'Włochy' }), { kanal: 'IT', rynek: 'IT', regula: 'kraj' });
});

test('Amazon EU przed Sellasist: numer zamówienia w uwagach (IDEA) albo „amazon” w EUR → rynek z kraju płatnika', () => {
  const idea = { zrodlo_fs: '', kat_fs: 'Sprzedaż', waluta: 'EUR', uwagi: 'Am302-7328303-6994704-1 Kurs 2026-06-09' };
  assert.deepStrictEqual(k({ ...idea, kraj: 'Niemcy' }), { kanal: 'DE', rynek: 'DE', regula: 'numer_amazona_kraj' });
  assert.deepStrictEqual(k({ ...idea, kraj: 'Austria' }), { kanal: 'DE', rynek: 'DE', regula: 'numer_amazona_kraj' });
  assert.deepStrictEqual(k({ ...idea, kraj: 'Francja' }), { kanal: 'FR', rynek: 'FR', regula: 'numer_amazona_kraj' });
  assert.deepStrictEqual(k({ ...idea, kraj: 'Belgia' }), { kanal: 'FR', rynek: 'FR', regula: 'kraj_niepewny' });
  assert.deepStrictEqual(k({ ...idea, kraj: 'Szwecja' }), { kanal: 'AMAZON_EU', rynek: null, regula: 'kraj_nieznany' });
  // BaseLinker 2025: „Źródło” amazon w EUR to Amazon EU, nie Amazon PL
  assert.deepStrictEqual(k({ zrodlo_fs: 'amazon', waluta: 'EUR', kraj: 'Niemcy' }), { kanal: 'DE', rynek: 'DE', regula: 'zrodlo_amazon_kraj' });
  // ZK z BaseLinkera: „Amazon.de” w EUR (X.2025: 196 tys. zł) to Amazon EU; w PLN — Amazon PL
  assert.deepStrictEqual(k({ zrodlo_fs: '', zrodlo_zk: 'Amazon.de', waluta: 'EUR', kraj: 'Francja' }), { kanal: 'FR', rynek: 'FR', regula: 'zrodlo_amazon_kraj' });
  assert.strictEqual(k({ zrodlo_zk: 'Amazon.de', kat_zk: 'Amazon_PL', waluta: 'PLN' }).kanal, 'PL');
});

test('kanały spoza repricera mają swoje nazwy (Rozliczenia: tergpl = Media Expert, personal = Fenom)', () => {
  assert.strictEqual(k({ zrodlo_fs: 'tergpl', waluta: 'PLN' }).kanal, 'MEDIA_EXPERT');
  assert.strictEqual(k({ zrodlo_fs: 'personal', waluta: 'PLN' }).kanal, 'FENOM');
  assert.strictEqual(k({ zrodlo_zk: 'Fenom/Kup na ceneo', waluta: 'PLN' }).kanal, 'FENOM');
  assert.strictEqual(k({ zrodlo_fs: 'inpsa', waluta: 'PLN' }).kanal, 'INPOST_PAY');
  assert.strictEqual(k({ zrodlo_fs: 'erli_connector', waluta: 'PLN' }).kanal, 'ERLI');
  assert.strictEqual(k({ zrodlo_fs: 'pigu', waluta: 'EUR', kraj: 'Litwa' }).kanal, 'PIGU');
  for (const kanal of ['MEDIA_EXPERT', 'FENOM', 'INPOST_PAY', 'ERLI', 'PIGU', 'ALLEGRO', 'DE', 'EMAG_RO']) assert.ok(NAZWY_KANALOW[kanal], kanal);
});

test('ZK bez FS (dzisiejsze zamówienia): kanał ze „Źródła” albo kategorii ZK', () => {
  assert.strictEqual(k({ zrodlo_zk: 'Allegro - ekajtek_pl', kat_zk: 'Internet', waluta: 'PLN' }).kanal, 'ALLEGRO_EKAJTEK');
  assert.strictEqual(k({ zrodlo_zk: '', kat_zk: 'Emag_RO', waluta: 'RON' }).kanal, 'EMAG_RO');     // eMAG ma puste „Źródło” na ZK
  assert.strictEqual(k({ zrodlo_zk: 'Amazon.de', kat_zk: 'Amazon_PL', waluta: 'PLN' }).kanal, 'PL');
  assert.strictEqual(k({ zrodlo_zk: 'Empik', kat_zk: 'Empik', waluta: 'PLN' }).kanal, 'EMPIK_PL');
});

test('bez żadnego sygnału — „Bez źródła”, nie zgadujemy', () => {
  assert.deepStrictEqual(k({ zrodlo_fs: '', kat_fs: 'Sprzedaż', kraj: 'Polska', waluta: 'PLN' }), { kanal: 'INNE', rynek: null, regula: 'brak' });
  assert.deepStrictEqual(k({}), { kanal: 'INNE', rynek: null, regula: 'brak' });
  // EUR z Niemiec bez znaku Amazona — wciąż Amazon DE z samego kraju (reguła widoczna jako „kraj”)
  assert.deepStrictEqual(k({ waluta: 'EUR', kraj: 'Niemcy' }), { kanal: 'DE', rynek: 'DE', regula: 'kraj' });
});
