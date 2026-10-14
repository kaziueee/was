'use strict';

const test = require('node:test');
const assert = require('node:assert');
const rynki = require('../config/rynki');
const { pasyZWyceny } = require('../pricing/pas');

test('minimum dla towaru docinalnego liczy się z docinaniem (niższy próg DHL)', () => {
  // NERF7376: koszt 48,10 zł, waga 5,32 kg, docinalny — przy docinaniu FR wpada w próg 5 kg zamiast 10 kg
  const w = { koszt: 48.1, waga: 5.32, docinalny: true, rynki: rynki.policzWszystkie(48.1, { waga: 5.32, docinanie: true, docinanieOn: false }) };
  const bez = w.rynki.find((x) => x.nazwa === 'Amazon FR').cena;
  const p = pasyZWyceny(w).FR;
  assert.ok(p.min < bez, `min z docinaniem ${p.min} powinno być niższe niż bez (${bez})`);
});
