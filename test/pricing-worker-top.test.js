'use strict';

const test = require('node:test');
const assert = require('node:assert');

process.env.PRICING_DB = ':memory:';
const { db, stan } = require('../pricing/db');
const { nowyRaportTop } = require('../pricing/worker');

test('worker: nowy raport Top ofert = przeliczenie Allegro od razu; przeliczony raport już nie', () => {
  assert.strictEqual(nowyRaportTop(), null);                         // brak raportu
  db.prepare("INSERT INTO allegro_top (konto, oferta, raport_czas) VALUES ('EKAJTEK', '1', '2026-10-19 11:48:22')").run();
  assert.strictEqual(nowyRaportTop(), '2026-10-19 11:48:22');        // nigdy nieprzeliczony
  stan.set('top_przeliczony', '2026-10-19 11:48:22');
  assert.strictEqual(nowyRaportTop(), null);
  db.prepare("INSERT INTO allegro_top (konto, oferta, raport_czas) VALUES ('NATROPIE', '2', '2026-10-19 12:05:00')").run();
  assert.strictEqual(nowyRaportTop(), '2026-10-19 12:05:00');        // drugie konto wgrane później
});
