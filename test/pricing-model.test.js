'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { decyzja } = require('../pricing/model');

const pas = { min: 20, max: 30 };
const obs = (o) => ({ cena: 25, wysylka: 4.99, bbNasz: null, bbCena: null, bbFba: false, najtanszaInna: null, ...o });

test('brak danych o konkurencji — nic nie zmieniamy', () => {
  const d = decyzja(obs({}), pas);
  assert.strictEqual(d.zmiana, false);
  assert.strictEqual(d.kod, 'brak_danych');
});

test('mamy Buy Box i konkurent wyraźnie wyżej — podnosimy pod niego (porównanie z wysyłką)', () => {
  // konkurent 32,99 landed; my 26 + 4,99 → cel towaru 32,98 − 4,99 = 27,99
  const d = decyzja(obs({ cena: 26, bbNasz: true, najtanszaInna: 32.99 }), pas);
  assert.strictEqual(d.zmiana, true);
  assert.strictEqual(d.kod, 'podwyzka');
  assert.strictEqual(d.cena, 27.99);
});

test('podwyżka nie przekracza max', () => {
  const d = decyzja(obs({ cena: 28, bbNasz: true, najtanszaInna: 60 }), pas);
  assert.strictEqual(d.cena, 30);
});

test('duża podwyżka idzie schodami — najwyżej 10% na przebieg', () => {
  const d = decyzja(obs({ bbNasz: true, najtanszaInna: 60 }), pas);   // cel = max 30, z 25 to +20%
  assert.strictEqual(d.cena, 27.5);
  assert.strictEqual(d.kod, 'podwyzka_limit');
});

test('mamy Buy Box, konkurent tuż nad nami — bez drgań (próg podwyżki)', () => {
  const d = decyzja(obs({ bbNasz: true, najtanszaInna: 30.2 }), pas);   // cel 25,20 → +0,20
  assert.strictEqual(d.zmiana, false);
  assert.strictEqual(d.kod, 'top');
});

test('wygrywającej oferty nad max nie obniżamy', () => {
  const d = decyzja(obs({ cena: 35, bbNasz: true, najtanszaInna: 41 }), pas);
  assert.strictEqual(d.zmiana, false);
});

test('przegrywamy w pasie — schodzimy na Buy Box minus grosz', () => {
  const d = decyzja(obs({ bbNasz: false, bbCena: 28.99 }), pas);   // cel 28,98 − 4,99 = 23,99
  assert.strictEqual(d.kod, 'obnizka');
  assert.strictEqual(d.cena, 23.99);
});

test('Buy Box pod naszą podłogą — schodzimy na min, dalej stoimy', () => {
  const d1 = decyzja(obs({ cena: 21, bbNasz: false, bbCena: 22 }), pas);  // cel 17,00 < min
  assert.strictEqual(d1.kod, 'na_min');
  assert.strictEqual(d1.cena, 20);
  const d2 = decyzja(obs({ cena: 20, bbNasz: false, bbCena: 22 }), pas);
  assert.strictEqual(d2.zmiana, false);
  assert.strictEqual(d2.kod, 'pod_podloga');
});

test('remis z ofertą FBA — stoimy, nie zaczynamy wojny o grosz', () => {
  const d = decyzja(obs({ bbNasz: false, bbCena: 29.99, bbFba: true }), pas);
  assert.strictEqual(d.zmiana, false);
  assert.strictEqual(d.kod, 'remis_fba');
});

test('remis z ofertą NIE-FBA — schodzimy o grosz', () => {
  const d = decyzja(obs({ bbNasz: false, bbCena: 29.99, bbFba: false }), pas);
  assert.strictEqual(d.cena, 24.99);
});

test('duży spadek idzie schodami — najwyżej 5% na przebieg', () => {
  const d = decyzja(obs({ cena: 100, bbNasz: false, bbCena: 60 }), { min: 50, max: 150 });
  assert.strictEqual(d.cena, 95);
  assert.strictEqual(d.kod, 'obnizka_limit');
});

test('schodek nie schodzi pod min', () => {
  const d = decyzja(obs({ cena: 20.5, bbNasz: false, bbCena: 10 }), pas);
  assert.strictEqual(d.cena, 20);
});

test('cena daleko pod minimum — od razu na minimum, bez schodka', () => {
  const d = decyzja(obs({ cena: 15, bbNasz: true, najtanszaInna: 30 }), pas);
  assert.strictEqual(d.kod, 'pod_min');
  assert.strictEqual(d.cena, 20);
});

test('utrata BB po podniesieniu spod minimum — nie cofamy (minimum to podłoga)', () => {
  const kontekst = { ostatniaPodwyzka: { cena_przed: 15, cena_nowa: 20 } };
  const d = decyzja(obs({ cena: 20, bbNasz: false, bbCena: 22 }), pas, {}, kontekst);
  assert.notStrictEqual(d.kod, 'cofniecie');
  assert.ok(d.cena >= 20);
});

test('przegrywamy, choć jesteśmy tańsi — cena nie jest powodem, nie ruszamy', () => {
  const d = decyzja(obs({ cena: 22, bbNasz: false, bbCena: 28.99 }), pas);  // my 26,99 < 28,99
  assert.strictEqual(d.zmiana, false);
  assert.strictEqual(d.kod, 'przegrana_nie_cena');
});

test('bez pasa z kalkulatora nie decydujemy', () => {
  assert.strictEqual(decyzja(obs({ bbNasz: false, bbCena: 20 }), { min: 0, max: 0 }).kod, 'brak_pasa');
});

test('utrata BB po wysłanej podwyżce — cofamy od razu do ceny sprzed podwyżki (bez schodka)', () => {
  const kontekst = { ostatniaPodwyzka: { cena_przed: 18.69, cena_nowa: 20.09 } };
  const d = decyzja(obs({ cena: 20.09, bbNasz: false, bbCena: 25.08 }), { min: 13.99, max: 20.98 }, {}, kontekst);
  assert.strictEqual(d.kod, 'cofniecie');
  assert.strictEqual(d.cena, 18.69);                     // −7%, mimo limitu −5% na przebieg
});

test('utrata BB, ale cena już inna niż po podwyżce — zwykła logika, bez cofania', () => {
  const kontekst = { ostatniaPodwyzka: { cena_przed: 18.69, cena_nowa: 20.09 } };
  const d = decyzja(obs({ cena: 19.5, bbNasz: false, bbCena: 25.08 }), pas, {}, kontekst);
  assert.notStrictEqual(d.kod, 'cofniecie');
});

test('cofnięcie dotyczy tylko podwyżek zaczętych w pasie — wraca dokładnie do ceny sprzed', () => {
  const kontekst = { ostatniaPodwyzka: { cena_przed: 21, cena_nowa: 23.1 } };
  const d = decyzja(obs({ cena: 23.1, bbNasz: false, bbCena: 30 }), pas, {}, kontekst);
  assert.strictEqual(d.kod, 'cofniecie');
  assert.strictEqual(d.cena, 21);
});

test('po cofnięciu podwyżki wstrzymane — mamy BB, konkurent daleko, stoimy', () => {
  const d = decyzja(obs({ cena: 26, bbNasz: true, najtanszaInna: 40 }), pas, {}, { blokadaPodwyzek: true });
  assert.strictEqual(d.zmiana, false);
  assert.strictEqual(d.kod, 'top_blokada');
});

test('blokada podwyżek nie blokuje obniżki', () => {
  const d = decyzja(obs({ bbNasz: false, bbCena: 28.99 }), pas, {}, { blokadaPodwyzek: true });
  assert.strictEqual(d.kod, 'obnizka');
});

test('cena docelowa: schodek w dół ma cel w pełnej odległości', () => {
  const d = decyzja(obs({ cena: 100, bbNasz: false, bbCena: 60 }), { min: 50, max: 150 });
  assert.strictEqual(d.cena, 95);
  assert.strictEqual(d.cel, 55.0);                    // 60 − 0,01 − 4,99
});

test('cena docelowa: schodek w górę ma cel pod konkurentem (nie wyżej niż max)', () => {
  const d = decyzja(obs({ bbNasz: true, najtanszaInna: 60 }), pas);
  assert.strictEqual(d.cena, 27.5);
  assert.strictEqual(d.cel, 30);
});

test('bez zmiany cel = obecna cena', () => {
  const d = decyzja(obs({ bbNasz: true, najtanszaInna: 30.2 }), pas);
  assert.strictEqual(d.cel, 25);
});

test('Buy Box ma nasza inna oferta tego produktu — stoimy, nie konkurujemy sami ze sobą', () => {
  const d = decyzja(obs({ cena: 24.99, bbNasz: false, bbInnaNasza: true, bbCena: 24.99, najtanszaInna: 39.95 }), pas);
  assert.strictEqual(d.zmiana, false);
  assert.strictEqual(d.kod, 'bb_nasza_inna');
});

test('wojna o grosze: 3 obniżki z rzędu bez Buy Boxa — kolejna wstrzymana na 24 h', () => {
  const o = obs({ cena: 25, bbNasz: false, bbCena: 29.5 });            // cel 29,49 − 4,99 = 24,50
  const w = decyzja(o, pas, {}, { obnizkiBezBb: { n: 3, godzOd: 0.5 } });
  assert.strictEqual(w.zmiana, false);
  assert.strictEqual(w.kod, 'wojna_cenowa');
  assert.strictEqual(w.cena, 25);
  assert.strictEqual(w.cel, 24.5);                                      // ekran widzi, dokąd by zszedł
  assert.match(w.powod, /następna za 24 h/);
});

test('wojna o grosze: po pauzie jedna obniżka, dwie obniżki to jeszcze nie wojna', () => {
  const o = obs({ cena: 25, bbNasz: false, bbCena: 29.5 });
  assert.strictEqual(decyzja(o, pas, {}, { obnizkiBezBb: { n: 3, godzOd: 24.2 } }).kod, 'obnizka');
  assert.strictEqual(decyzja(o, pas, {}, { obnizkiBezBb: { n: 2, godzOd: 0.5 } }).kod, 'obnizka');
});

test('wojna o grosze wstrzymuje też zejście na minimum, ale nie podwyżki i nie powrót spod minimum', () => {
  const ctx = { obnizkiBezBb: { n: 5, godzOd: 1 } };
  assert.strictEqual(decyzja(obs({ cena: 25, bbNasz: false, bbCena: 22 }), pas, {}, ctx).kod, 'wojna_cenowa');   // byłoby na_min
  assert.strictEqual(decyzja(obs({ cena: 18, bbNasz: false, bbCena: 22 }), pas, {}, ctx).kod, 'pod_min');
  assert.strictEqual(decyzja(obs({ cena: 26, bbNasz: true, najtanszaInna: 32.99 }), pas, {}, ctx).kod, 'podwyzka');
});

test('szukanie ceny konkurenta (eMAG): mamy BB, konkurencja nieznana — +3% na przebieg, nie ponad max', () => {
  const o = obs({ cena: 25, wysylka: 0, bbNasz: true, konkurencjaNieznana: true, ofert: 4 });
  const d = decyzja(o, pas);
  assert.strictEqual(d.zmiana, true);
  assert.strictEqual(d.kod, 'sonda');
  assert.strictEqual(d.cena, 25.75);
  const naMax = decyzja(obs({ cena: 29.5, wysylka: 0, bbNasz: true, konkurencjaNieznana: true }), pas);
  assert.strictEqual(naMax.cena, 30);
  assert.strictEqual(decyzja(obs({ cena: 30, wysylka: 0, bbNasz: true, konkurencjaNieznana: true }), pas).zmiana, false);
});

test('szukanie: po utracie BB powrót do ceny sprzed kroku, potem 24 h bez szukania', () => {
  // krok 25 → 25,75 wysłany, BB stracony → cofnięcie na 25
  const po = decyzja(obs({ cena: 25.75, wysylka: 0, bbNasz: false, bbCena: null, najtanszaNasza: false }), pas, {},
    { ostatniaPodwyzka: { cena_przed: 25, cena_nowa: 25.75 } });
  assert.strictEqual(po.kod, 'cofniecie');
  assert.strictEqual(po.cena, 25);
  // BB wrócił, ale w oknie blokady — nie szukamy znowu
  const blok = decyzja(obs({ cena: 25, wysylka: 0, bbNasz: true, konkurencjaNieznana: true }), pas, {}, { blokadaPodwyzek: true });
  assert.strictEqual(blok.zmiana, false);
  assert.strictEqual(blok.kod, 'top_blokada');
});

test('szukanie nie dotyczy jedynej oferty ani ceny pod minimum', () => {
  assert.strictEqual(decyzja(obs({ cena: 25, wysylka: 0, bbNasz: true, ofert: 1 }), pas).kod, 'top_bez_konkurencji');
  assert.strictEqual(decyzja(obs({ cena: 18, wysylka: 0, bbNasz: true, konkurencjaNieznana: true }), pas).kod, 'pod_min');
});
