'use strict';

const test = require('node:test');
const assert = require('node:assert');

process.env.PRICING_DB = ':memory:';
process.env.NIEZBEDNIK_API_KEY = 'test';
const k = require('../pricing/konkurencja-allegro');
const nsp = require('../pricing/niezbednik');
const { decyzja } = require('../pricing/model');
const { kolumna, wysylkaWstrzymana } = require('../pricing/kolumny');
const { db, stan } = require('../pricing/db');

const NASZE = new Set(['21818279', 'ekajtek_pl', '40613543', 'natropiezabawek']);
const kon = (login, cena, o = {}) => ({ oferta: `o-${login}`, sprzedawca: `id-${login}`, login, cena, dostawa: 0, stan: 10, popularnosc: 5, firma: true, ss: false, ...o });

test('konkurenci: bez naszych kont (numer albo login, wielkość liter), stanu < 3, prywatnych; popularność 0 zostaje; rosnąco', () => {
  const r = k.konkurenci([
    kon('drogi', 99), kon('ekajtek_pl', 50, { sprzedawca: '21818279' }), kon('NaTropieZabawek', 51, { sprzedawca: 'x' }),
    kon('malo', 40, { stan: 2 }), kon('martwy', 41, { popularnosc: 0 }), kon('osoba', 42, { firma: false }),
    kon('tani', 60), kon('nieznany', 70, { stan: null, popularnosc: null, firma: null }),
  ], NASZE);
  // brak danych ≠ powód do pominięcia; popularność 0 też nie (NERG0730: tak stała faktyczna Top oferta)
  assert.deepStrictEqual(r.lista.map((c) => c.login), ['martwy', 'tani', 'nieznany', 'drogi']);
  assert.deepStrictEqual(r.pomin, { nasze: 2, stan: 1, prywatne: 1 });
  assert.deepStrictEqual(r.nasze.map((c) => c.cena), [50, 51]);
});

test('wynik Niezbędnika → oferta: kwoty z tekstu, brakujące pola jako null', () => {
  const c = k.zWyniku({ offer_id: '1', seller_id: '2', seller_login: 'x', price: { amount: '239.00', currency: 'PLN' },
    delivery_price: { amount: null, currency: 'PLN' }, stock: 22, popularity: 1, is_company: true, is_superseller: false, name: 'FURBY' });
  assert.strictEqual(c.cena, 239);
  assert.strictEqual(c.dostawa, null);
  assert.strictEqual(c.stan, 22);
});

const teraz = Date.parse('2026-10-19T10:00:00Z');
const wpis = (oferty, o = {}) => ({ czas: '2026-10-19 08:00:00', oferty: JSON.stringify(oferty), ...o });

test('obserwacja z Niezbędnika: najtańszy po filtrach, czy jesteśmy najtańsi, lista cen do wyboru celu; stary wynik = null', () => {
  const w = wpis([kon('a', 69.9), kon('b', 74.5), kon('ekajtek_pl', 77.89, { sprzedawca: '21818279' })]);
  const obs = k.zNiezbednika(w, 77.89, NASZE, teraz);
  assert.strictEqual(obs.bbNasz, false);
  assert.strictEqual(obs.bbCena, 69.9);
  assert.deepStrictEqual(obs.konkurenci, [69.9, 74.5]);
  assert.strictEqual(obs.ofert, 2);
  assert.strictEqual(k.zNiezbednika(w, 69.9, NASZE, teraz).bbNasz, true);      // remis = nie drożej
  assert.strictEqual(k.zNiezbednika(w, 77.89, NASZE, teraz + 11 * 3_600_000, 12), null);
  assert.strictEqual(k.zNiezbednika({ ...w, blad: 'report_item_failed' }, 77.89, NASZE, teraz), null);
  // tylko nasza oferta — produkt znaleziony, konkurentów brak
  assert.strictEqual(k.zNiezbednika(wpis([kon('ekajtek_pl', 50, { sprzedawca: '21818279' })]), 50, NASZE, teraz).bbNasz, true);
});

// Pas jak z kalkulatora; reguły modelu z przebiciem oferty.
const pas = (min, max = 200) => ({ min, max });
const decyzjaAllegro = (cena, konkurenci, min, krok = 0.01) => {
  const ob = { cena, wysylka: 0, konkurenci };
  return decyzja(k.doModelu(ob, min, krok), pas(min), { krok });
};

test('wynik bez żadnej naszej oferty = brak danych (wyszukiwanie po EAN nie znalazło produktu), nie „brak konkurencji”', () => {
  assert.strictEqual(k.zNiezbednika(wpis([]), 169.99, NASZE, teraz), null);                        // NERF0319: 0 ofert
  assert.strictEqual(k.zNiezbednika(wpis([kon('obcy', 99)]), 169.99, NASZE, teraz), null);         // inny produkt po frazie
  assert.strictEqual(k.podsumowanie(wpis([]), NASZE, teraz).uzyteczny, false);
  // drugie nasze konto w wynikach wystarczy — produkt jest ten sam
  assert.ok(k.zNiezbednika(wpis([kon('NaTropieZabawek', 60, { sprzedawca: '40613543' }), kon('obcy', 55)]), 59, NASZE, teraz));
});

test('wariant C: konkurent nad minimum → schodzimy o przebicie pod niego', () => {
  const d = decyzjaAllegro(77.89, [69.9, 74.5], 60);
  assert.strictEqual(d.kod, 'obnizka_limit');          // −10,2% — pierwszy schodek −5%
  assert.strictEqual(d.cel, 69.89);
  assert.strictEqual(decyzjaAllegro(71, [69.9, 74.5], 60).cena, 69.89);
});

test('wariant C: tańszy konkurent pod naszym minimum jest pomijany — przebijamy najtańszego nad minimum', () => {
  const ob = k.doModelu({ cena: 80, wysylka: 0, konkurenci: [55, 72, 90] }, 60, 0.01);
  assert.strictEqual(ob.najtanszaInna, 72);
  assert.strictEqual(ob.podMin, 1);
  const d = decyzja(ob, pas(60), { krok: 0.01 });
  assert.strictEqual(d.cel, 71.99);
});

test('wariant C: wszyscy pod minimum → model schodzi na minimum i tam stoi', () => {
  assert.strictEqual(decyzjaAllegro(62, [50, 55], 60).kod, 'na_min');
  assert.strictEqual(decyzjaAllegro(60, [50, 55], 60).kod, 'pod_podloga');
});

test('jesteśmy tańsi od celu → podnosimy pod niego; remis (przebicie 0) = ta sama cena', () => {
  assert.strictEqual(decyzjaAllegro(70, [72, 90], 60).cena, 71.99);
  assert.strictEqual(decyzjaAllegro(70, [72, 90], 60, 0).cena, 72);
  assert.strictEqual(decyzjaAllegro(72, [72, 90], 60, 0).kod, 'top');
  assert.strictEqual(decyzjaAllegro(70, [], 60).kod, 'top_bez_konkurencji');
});

test('przebicie kwotą: 0,50 zł pod konkurenta, a cel pod minimum odpada przez kwotę', () => {
  assert.strictEqual(decyzjaAllegro(75, [72], 60, 0.5).cena, 71.5);
  // 60,30 − 0,50 < 60 → tego nie da się przebić nad minimum, celem jest następny
  assert.strictEqual(k.doModelu({ cena: 75, konkurenci: [60.3, 70] }, 60, 0.5).najtanszaInna, 70);
});

test('ustawienia oferty: co 1–4 h (inne = 4), przebicie 0–100 zł (brak = 1 gr)', () => {
  assert.strictEqual(k.coH(2), 2);
  assert.strictEqual(k.coH(null), 4);
  assert.strictEqual(k.coH(6), 4);
  assert.strictEqual(k.przebicie(null), 0.01);
  assert.strictEqual(k.przebicie(0), 0);
  assert.strictEqual(k.przebicie(0.5), 0.5);
  assert.strictEqual(k.przebicie(500), 0.01);
});

test('godzina polska i okno dnia — także po zmianie czasu na zimowy', () => {
  assert.strictEqual(k.godzinaPL(Date.parse('2026-10-19T05:00:00Z')), 7);   // CEST
  assert.strictEqual(k.godzinaPL(Date.parse('2026-12-01T06:00:00Z')), 7);   // CET
  assert.strictEqual(k.wOknie(Date.parse('2026-10-19T04:59:00Z'), [7, 23]), false);
  assert.strictEqual(k.wOknie(Date.parse('2026-10-19T20:59:00Z'), [7, 23]), true);
  assert.strictEqual(k.wOknie(Date.parse('2026-10-19T21:00:00Z'), [7, 23]), false);
});

test('harmonogram: wspólny EAN raz (najczęstsze ustawienie), co h z tolerancją przebiegu, najdawniej sprawdzane pierwsze', () => {
  const t = Date.parse('2026-10-19T10:00:00Z');   // 12:00 w Polsce
  const ost = new Map([
    ['5901111111111', { czas: '2026-10-19 09:15:00' }],      // 45 min temu: przy co 1 h — mieści się w tolerancji 20 min
    ['5902222222222', { czas: '2026-10-19 08:30:00' }],      // 1,5 h temu, co 4 h — jeszcze nie
    ['5903333333333', { czas: null, zlecono: '2026-10-19 05:00:00' }],  // zlecone 5 h temu, bez wyniku
  ]);
  const of = [{ ean: '5901111111111', co_h: 4 }, { ean: '5901111111111', co_h: 1 }, { ean: '5902222222222', co_h: null },
    { ean: '5903333333333' }, { ean: '5904444444444' }, { ean: '123' }, { ean: null }];
  assert.deepStrictEqual(k.doSprawdzenia(of, ost, t, { oknoH: [7, 23] }), ['5904444444444', '5903333333333', '5901111111111']);
  assert.deepStrictEqual(k.doSprawdzenia(of, ost, t, { oknoH: [7, 23], limit: 1 }), ['5904444444444']);
  assert.deepStrictEqual(k.doSprawdzenia(of, ost, Date.parse('2026-10-19T22:00:00Z'), { oknoH: [7, 23] }), []);   // północ
});

test('Allegro: automat da się włączyć, a wysyłka czeka na PRICING_ALLEGRO_WYSYLKA=1', () => {
  const kol = kolumna('allegro', 'EKAJTEK');
  assert.ok(!kol.tylkoOdczyt);
  delete process.env.PRICING_ALLEGRO_WYSYLKA;
  assert.strictEqual(wysylkaWstrzymana(kol), true);
  process.env.PRICING_ALLEGRO_WYSYLKA = '1';
  assert.strictEqual(wysylkaWstrzymana(kol), false);
  delete process.env.PRICING_ALLEGRO_WYSYLKA;
  assert.strictEqual(wysylkaWstrzymana(kolumna('emag', 'RO')), false);
});

// --- klient Niezbędnika (fetch podstawiony) ---

function podstawFetch(odpowiedzi) {
  const wywolania = [];
  const stary = global.fetch;
  global.fetch = async (url, opt) => {
    wywolania.push({ url, opt });
    const [status, body, naglowki = {}] = odpowiedzi.shift();
    return { status, ok: status >= 200 && status < 300, headers: { get: (h) => naglowki[h.toLowerCase()] ?? null }, text: async () => JSON.stringify(body) };
  };
  return { wywolania, przywroc: () => { global.fetch = stary; } };
}

test('Niezbędnik: ponowienie zlecenia po 503 idzie z TYM SAMYM Idempotency-Key (bez drugiej opłaty)', async () => {
  const f = podstawFetch([[503, {}, { 'retry-after': '0' }], [202, { id: 'r1', status: 'queued' }]]);
  try {
    const r = await nsp.zlecRaport(['5901111111111'], k.FILTRY);
    assert.strictEqual(r.id, 'r1');
    const [a, b] = f.wywolania.map((w) => w.opt.headers['Idempotency-Key']);
    assert.ok(a && a === b);
    assert.deepStrictEqual(JSON.parse(f.wywolania[0].opt.body), { marketplace_id: 'allegro-pl', eans: ['5901111111111'], filters: { has_smart: true, condition: 'new' } });
  } finally { f.przywroc(); }
});

test('Niezbędnik: brak sprawdzeń w pakiecie (402) → błąd z kodem, bez ponawiania', async () => {
  const f = podstawFetch([[402, { error: { code: 'competitor_checks_required', message: 'Brak sprawdzeń', details: { remaining_checks: 0 } } }]]);
  try {
    await assert.rejects(nsp.zlecRaport(['5901111111111']), (e) => e.kod === 'competitor_checks_required' && e.status === 402);
    assert.strictEqual(f.wywolania.length, 1);
  } finally { f.przywroc(); }
});

test('Niezbędnik: raport w toku → bez pozycji; zakończony → wszystkie strony', async () => {
  const f = podstawFetch([
    [200, { status: 'running', items: [] }],
    [200, { status: 'completed', items: [{ ean: '1' }], pagination: { has_more: true, next_cursor: 'c2' } }],
    [200, { status: 'completed', items: [{ ean: '2' }], pagination: { has_more: false, next_cursor: null } }],
  ]);
  try {
    assert.strictEqual((await nsp.raport('r1')).gotowy, false);
    const r = await nsp.raport('r1');
    assert.deepStrictEqual(r.items.map((i) => i.ean), ['1', '2']);
    assert.match(f.wywolania[2].url, /limit=100&cursor=c2/);
  } finally { f.przywroc(); }
});

// --- zlecenie i odbiór (baza w pamięci, API podstawione) ---

test('zlecenie i odbiór: EAN-y z harmonogramu, limit dzienny, wynik w allegro_konkurencja, błąd pozycji zostawia stary wynik', async () => {
  const stare = { zlecRaport: nsp.zlecRaport, raport: nsp.raport, pakiet: nsp.pakiet };
  const t = Date.parse('2026-10-19T10:00:00Z');
  let zlecone = null;
  nsp.zlecRaport = async (eans, filtry) => { zlecone = { eans, filtry }; return { id: 'r9', status: 'queued' }; };
  nsp.pakiet = async () => ({ remaining: 4400, valid_until: '2026-12-18T23:59:59Z' });
  db.prepare("INSERT INTO allegro_konkurencja (ean, czas, oferty) VALUES ('5902222222222', '2026-10-18 10:00:00', '[]')").run();
  try {
    process.env.PRICING_NSP_DZIENNIE = '2';
    const z = await k.zlec([{ ean: '5901111111111' }, { ean: '5902222222222', konk_co_h: 1 }, { ean: '5903333333333' }], t);
    assert.strictEqual(z.eanow, 2);                                     // limit dzienny 2
    assert.deepStrictEqual(zlecone.eans, ['5901111111111', '5903333333333']);   // bez wyniku pierwsze (najdawniej)
    assert.deepStrictEqual(zlecone.filtry, k.FILTRY);
    assert.strictEqual((await k.zlec([{ ean: '5904444444444' }], t)).pominiete, 'poprzedni raport jeszcze trwa');

    nsp.raport = async () => ({ status: 'partially_failed', gotowy: true, cost: { charged: 1 }, items: [
      { ean: '5901111111111', status: 'completed', result: { checked_at: '2026-10-19T10:01:00+00:00', total: 3, offers: [
        { offer_id: '1', seller_id: '9', seller_login: 'inny', price: { amount: '69.90' }, delivery_price: { amount: '0' }, stock: 5, popularity: 2, is_company: true }] } },
      { ean: '5903333333333', status: 'failed', result: null, error: { message: 'timeout' } },
    ] });
    const r = await k.odbierz();
    assert.deepStrictEqual({ ok: r.ok, bledy: r.bledy }, { ok: 1, bledy: 1 });
    const w = k.wyniki();
    assert.strictEqual(w.get('5901111111111').czas, '2026-10-19 10:01:00');
    assert.strictEqual(JSON.parse(w.get('5901111111111').oferty)[0].cena, 69.9);
    assert.strictEqual(w.get('5903333333333').blad, 'timeout');
    assert.ok(w.get('5903333333333').zlecono);                          // harmonogram nie zleci go w kółko
    assert.strictEqual(stan.get('nsp_raport').wartosc, '');
    assert.strictEqual(JSON.parse(stan.get('nsp_dzis').wartosc).n, 2);
    // drugi przebieg tego samego dnia: limit wyczerpany
    assert.strictEqual((await k.zlec([{ ean: '5905555555555' }], t)).eanow, 0);
  } finally {
    Object.assign(nsp, stare);
    delete process.env.PRICING_NSP_DZIENNIE;
  }
});

// --- EAN z katalogu Allegro (oferta → produkt → EAN) ---

test('EAN z produktu Allegro: parametr „EAN (GTIN)”, pierwsza poprawna wartość (XSH36786: 12 cyfr i z zerem)', () => {
  assert.strictEqual(k.eanZProduktu({ parameters: [{ name: 'Marka', values: ['X-Shot'] }, { name: 'EAN (GTIN)', values: ['193052070883', '0193052070883'] }] }), '193052070883');
  assert.strictEqual(k.eanZProduktu({ parameters: [{ name: 'EAN (GTIN)', values: ['abc'] }] }), null);
  assert.strictEqual(k.eanZProduktu(null), null);
});

test('odświeżenie EAN: katalog Allegro wygrywa z GT; świeży (doba) nie odpytuje; błąd Allegro zostawia stary EAN', async () => {
  const allegro = require('../pricing/allegro');
  const stare = allegro.api;
  const wolania = [];
  allegro.api = async (konto, sciezka) => {
    wolania.push(sciezka);
    if (sciezka === '/sale/product-offers/18681598333') return { productSet: [{ product: { id: 'd4febc6c' } }] };
    if (sciezka === '/sale/products/d4febc6c') return { parameters: [{ name: 'EAN (GTIN)', values: ['5010993842094'] }] };
    throw new Error('Allegro 503');
  };
  const t = Date.parse('2026-10-19T12:30:00Z');
  const ins = db.prepare("INSERT INTO oferty (platforma, rynek, sku, asin, tw_id, ean, ean_czas) VALUES ('allegro', 'EKAJTEK', ?, ?, ?, ?, ?)");
  const a = Number(ins.run('NERF0319', '18681598333', 1, '195166115597', null).lastInsertRowid);           // EAN z GT, nigdy nie z Allegro
  const b = Number(ins.run('SWIEZY', '111', 2, '5900000000001', '2026-10-19 10:00:00').lastInsertRowid);  // sprawdzony 2,5 h temu
  const c = Number(ins.run('BLAD', '222', 3, '5900000000002', null).lastInsertRowid);                     // Allegro odpowiada błędem
  try {
    const of = db.prepare('SELECT id, rynek, asin, tw_id, ean, ean_czas FROM oferty WHERE id IN (?, ?, ?)').all(a, b, c);
    await k.odswiezEan(of, t);
    const po = (id) => db.prepare('SELECT ean, ean_zrodlo FROM oferty WHERE id = ?').get(id);
    assert.deepStrictEqual({ ...po(a) }, { ean: '5010993842094', ean_zrodlo: 'allegro' });
    assert.deepStrictEqual({ ...po(b) }, { ean: '5900000000001', ean_zrodlo: null });
    assert.deepStrictEqual({ ...po(c) }, { ean: '5900000000002', ean_zrodlo: null });
    assert.ok(!wolania.some((w) => w.includes('/111')));                                                    // świeży — bez zapytania
  } finally { allegro.api = stare; }
});

test('zapisy EAN: 12 cyfr ↔ 13 z zerem, lista z oferty bez powtórzeń i śmieci', () => {
  assert.deepStrictEqual(k.wariantyEan('193052070883'), ['193052070883', '0193052070883']);
  assert.deepStrictEqual(k.wariantyEan('0193052070883'), ['0193052070883', '193052070883']);
  assert.deepStrictEqual(k.wariantyEan('5010993842094'), ['5010993842094']);
  assert.deepStrictEqual(k.eanyOferty({ ean: '193052070883,0193052070883' }), ['193052070883', '0193052070883']);
  assert.deepStrictEqual(k.eanyOferty({ ean: '193052070883' }), ['193052070883', '0193052070883']);   // stary zapis — dokładamy wariant
  assert.deepStrictEqual(k.eanyOferty({ ean: 'abc, ' }), []);
  assert.deepStrictEqual(k.eanyZProduktu({ parameters: [{ name: 'EAN (GTIN)', values: ['193052070883', '0193052070883', 'x'] }] }), ['193052070883', '0193052070883']);
});

test('wyniki dla kilku zapisów EAN łączą się (XSH36786: humbi tylko pod EAN-em z zerem) — cel to humbi', () => {
  const ean12 = wpis([kon('ekajtek_pl', 149.89, { sprzedawca: '21818279', oferta: '18292340594' }), kon('swiatbajekpl', 149.9)]);
  const ean13 = wpis([kon('www_humbi_pl', 149.8, { stan: 101, ss: true })]);
  const obs = k.zNiezbednika([ean12, ean13], 149.89, NASZE, teraz);
  assert.deepStrictEqual(obs.konkurenci, [149.8, 149.9]);
  assert.strictEqual(obs.bbNasz, false);
  // sam wynik bez naszej oferty dalej nic nie znaczy, ale razem z drugim zapisem — tak
  assert.strictEqual(k.zNiezbednika([ean13], 149.89, NASZE, teraz), null);
  const p = k.podsumowanie([ean12, ean13], NASZE, teraz);
  assert.deepStrictEqual(p.lista.map((c) => c.login), ['www_humbi_pl', 'swiatbajekpl']);
  assert.strictEqual(p.uzyteczny, true);
  // ta sama oferta pod dwoma zapisami liczy się raz
  assert.strictEqual(k.zNiezbednika([ean12, ean12], 149.89, NASZE, teraz).ofert, 1);
});

test('reguła 6 nie dotyczy pełnej listy konkurentów: po podwyżce przyszedł tańszy — schodzimy bez cofnięcia; zniknął — podwyżka mimo blokady', () => {
  // BARJFL66 20.10: podniesione do 89,90, Niezbędnik pokazuje nowego sprzedawcę za 78,99 (nad minimum 77,99), remis
  const kontekst = { ostatniaPodwyzka: { cena_przed: 87.95, cena_nowa: 89.9 }, blokadaPodwyzek: true };
  const ob = k.doModelu({ cena: 89.9, wysylka: 0, konkurenci: [69.95, 70, 78.99, 89.9] }, 77.99, 0);
  const d = decyzja(ob, pas(77.99, 116.98), { krok: 0 }, kontekst);
  assert.strictEqual(d.kod, 'obnizka_limit');             // nie 'cofniecie' do 87,95
  assert.strictEqual(d.cel, 78.99);
  // sprzedawca za 78,99 zniknął — wracamy pod 89,90 mimo cofnięcia w ostatnich 24 h
  const ob2 = k.doModelu({ cena: 78.99, wysylka: 0, konkurenci: [69.95, 70, 89.9, 89.99] }, 77.99, 0);
  const d2 = decyzja(ob2, pas(77.99, 116.98), { krok: 0 }, kontekst);
  assert.strictEqual(d2.kod, 'podwyzka_limit');
  assert.strictEqual(d2.cel, 89.9);
  // bez listy konkurentów (Amazon, eMAG, raport Top) reguła 6 działa jak dotąd
  const amazon = decyzja({ cena: 89.9, wysylka: 0, bbNasz: false, bbCena: 85 }, pas(77.99, 116.98), {}, kontekst);
  assert.strictEqual(amazon.kod, 'cofniecie');
});
