'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { utworzKolejke } = require('../pricing/kolejka-workera');

// Zegar na niby: zadania z czasem, `uplyw(ms)` odpala po kolei to, co przypada.
function zegarNaNiby() {
  let t = 0;
  const zadania = [];
  return {
    teraz: () => t,
    zegar: (fn, ms) => zadania.push({ kiedy: t + ms, fn }),
    async uplyw(ms) {
      const koniec = t + ms;
      for (;;) {
        zadania.sort((a, b) => a.kiedy - b.kiedy);
        const z = zadania[0];
        if (!z || z.kiedy > koniec) break;
        zadania.shift();
        t = z.kiedy;
        z.fn();
        await new Promise((ok) => setImmediate(ok));   // dokończ obietnice (wykonaj → finally)
      }
      t = koniec;
      await new Promise((ok) => setImmediate(ok));
    },
  };
}
// Zadanie, które trwa, dopóki go nie zwolnimy.
function blokada() {
  let zwolnij;
  const p = new Promise((ok) => { zwolnij = ok; });
  return { fn: () => p, zwolnij: async () => { zwolnij(); await new Promise((ok) => setImmediate(ok)); } };
}

test('potwierdzenie trafia na inne potwierdzenie — czeka na swoją kolej, nie przepada (19.10: Allegro za Amazonem)', async () => {
  const z = zegarNaNiby();
  const k = utworzKolejke({ zegar: z.zegar, teraz: z.teraz, log: () => {} });
  const amazon = blokada();
  const zrobione = [];
  k.potwierdzenie(amazon.fn, 300_000, 'Amazon');
  k.potwierdzenie(async () => { zrobione.push('allegro'); }, 300_000, 'Allegro');
  await z.uplyw(300_000);
  assert.strictEqual(k.zajete, true);            // Amazon trwa, Allegro czeka
  assert.deepStrictEqual(zrobione, []);
  await amazon.zwolnij();
  await z.uplyw(15_000);
  assert.deepStrictEqual(zrobione, ['allegro']);
});

test('potwierdzenie czeka najwyżej 30 min — potem odpuszcza z wpisem w logu', async () => {
  const z = zegarNaNiby();
  const logi = [];
  const k = utworzKolejke({ zegar: z.zegar, teraz: z.teraz, log: (...a) => logi.push(a.join(' ')) });
  const dlugi = blokada();
  k.jesliWolne(dlugi.fn);
  let zrobione = false;
  k.potwierdzenie(async () => { zrobione = true; }, 60_000, 'potwierdzenie Allegro');
  await z.uplyw(60_000 + 31 * 60_000);
  assert.strictEqual(zrobione, false);
  assert.match(logi.join('\n'), /potwierdzenie Allegro pominięte/);
});

test('pełny przebieg trafia na krótkie zadanie — czeka; trafia na poprzedni pełny — pominięty', async () => {
  const z = zegarNaNiby();
  const k = utworzKolejke({ zegar: z.zegar, teraz: z.teraz, log: () => {} });
  const krotkie = blokada();
  k.jesliWolne(krotkie.fn);
  let przebiegi = 0;
  assert.strictEqual(k.przebieg(async () => { przebiegi++; }), false);
  await krotkie.zwolnij();
  await z.uplyw(15_000);
  assert.strictEqual(przebiegi, 1);              // ruszył zaraz po krótkim

  const pelny = blokada();
  k.przebieg(pelny.fn);
  assert.strictEqual(k.przebieg(async () => { przebiegi++; }), false);
  await pelny.zwolnij();
  await z.uplyw(60_000);
  assert.strictEqual(przebiegi, 1);              // drugi pełny nie dobił się po pierwszym
});

test('zadanie co minutę rusza tylko przy wolnej kolejce; wynik przebiegu idzie do planowania potwierdzeń', async () => {
  const z = zegarNaNiby();
  const k = utworzKolejke({ zegar: z.zegar, teraz: z.teraz, log: () => {} });
  let wynik = null;
  k.przebieg(async () => ['oferta'], (w) => { wynik = w; });
  assert.strictEqual(k.jesliWolne(async () => {}), false);
  await z.uplyw(0);
  assert.deepStrictEqual(wynik, ['oferta']);
  assert.strictEqual(k.jesliWolne(async () => {}), true);
});
