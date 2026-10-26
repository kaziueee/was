'use strict';

// Uzupelnianie ceny Hurt_PLN w Sellasist: Hurt (EUR) × sredni kurs NBP (tabela A, ostatni ogloszony).
// Regula i tolerancja w sellasist-hurt-pln-model.js. Piszemy WYLACZNIE pole Hurt_PLN - reszty
// produktu (cena, Hurt, stany) nie dotykamy.
//
// Dwie drogi, ta sama sciezka zapisu:
//   - jednorazowo: node scripts/sellasist-hurt-pln.js [--zapisz] (podglad bez --zapisz),
//   - job raz na dobe (start), w nocy - przelicza tylko to, co odjechalo o > 1%.
// Cala praca to czekanie na siec (13,5 tys. produktow = ~14 stron /products_bulk), wiec
// glownego watku nie blokuje (zasada 7).

const { zmianyHurtPln, TOLERANCJA, POLE_HURT_PLN } = require('./sellasist-hurt-pln-model');

const STRONA = 1000;   // limit /products_bulk (odczyt i zapis)
const GODZINA_JOBA = 3;   // w nocy - Sellasist i Zebry maja wtedy spokoj

function skonfigurowane() {
  return Boolean(process.env.SELLASIST_ACCOUNT && process.env.SELLASIST_API_KEY);
}

const bazaApi = () => `https://${process.env.SELLASIST_ACCOUNT}.sellasist.pl/api/v1`;

// API Sellasist (HTTP/2) potrafi zerwac strumien w polowie odpowiedzi - ponawiamy.
async function api(sciezka, { metoda = 'GET', tresc } = {}) {
  let ostatni;
  for (let proba = 0; proba < 4; proba++) {
    try {
      const odp = await fetch(bazaApi() + sciezka, {
        method: metoda,
        headers: {
          apiKey: process.env.SELLASIST_API_KEY,
          accept: 'application/json',
          ...(tresc ? { 'content-type': 'application/json' } : {}),
        },
        body: tresc ? JSON.stringify(tresc) : undefined,
        signal: AbortSignal.timeout(120000),
      });
      const tekst = await odp.text();
      if (odp.status === 404 && metoda === 'GET') return [];   // „No records found” = koniec listy
      if (!odp.ok) throw new Error(`Sellasist ${metoda} ${sciezka.split('?')[0]}: HTTP ${odp.status} ${tekst.slice(0, 300)}`);
      return JSON.parse(tekst);
    } catch (err) {
      ostatni = err;
      if (/HTTP 4\d\d/.test(err.message)) break;   // blad danych - ponowienie nic nie zmieni
      await new Promise((r) => setTimeout(r, 2000 * (proba + 1)));
    }
  }
  throw ostatni;
}

async function kursNbpEur() {
  const odp = await fetch('https://api.nbp.pl/api/exchangerates/rates/a/eur/?format=json',
    { signal: AbortSignal.timeout(30000) });
  if (!odp.ok) throw new Error(`NBP: HTTP ${odp.status}`);
  const j = await odp.json();
  const r = j.rates && j.rates[0];
  if (!r || !(r.mid > 0)) throw new Error('NBP: brak kursu EUR w odpowiedzi');
  return { kurs: r.mid, tabela: r.no, data: r.effectiveDate };
}

async function idPolaHurtPln() {
  const pola = await api('/pricesfields');
  const pole = pola.find((p) => p.name === POLE_HURT_PLN);
  if (!pole) throw new Error(`Sellasist nie ma pola ceny „${POLE_HURT_PLN}”`);
  return Number(pole.id);
}

async function wszystkieProdukty() {
  const wynik = [];
  for (let offset = 0; ; offset += STRONA) {
    const strona = await api(`/products_bulk?limit=${STRONA}&offset=${offset}`);
    wynik.push(...strona);
    if (strona.length < STRONA) return wynik;
  }
}

// probne = true: tylko liczy. kurs = podany recznie (inaczej NBP). tolerancja jak w modelu.
// tylko = Set symboli - zawęża przebieg (test zapisu na jednym produkcie).
async function przelicz({ probne = true, kurs: kursRecznie = null, tolerancja = TOLERANCJA, tylko = null } = {}) {
  if (!skonfigurowane()) throw new Error('Sellasist nieskonfigurowany (SELLASIST_ACCOUNT / SELLASIST_API_KEY)');
  const kurs = kursRecznie ? { kurs: kursRecznie, tabela: 'recznie', data: null } : await kursNbpEur();
  const idPola = await idPolaHurtPln();
  let produkty = await wszystkieProdukty();
  if (tylko) produkty = produkty.filter((p) => tylko.has(p.symbol));

  const { zmiany, podejrzane, bezHurtu } = zmianyHurtPln(produkty, kurs.kurs, { tolerancja });
  const zWariantami = produkty.filter((p) => (p.variants || []).length).length;

  let zapisane = 0;
  const bledy = [];
  if (!probne) {
    for (let i = 0; i < zmiany.length; i += STRONA) {
      const paczka = zmiany.slice(i, i + STRONA);
      const odp = await api('/products_bulk', {
        metoda: 'PUT',
        tresc: paczka.map((z) => ({ product_id: z.product_id, pricesfieldsvalues: [{ pricesfield_id: idPola, value: z.nowa }] })),
      });
      const linie = Array.isArray(odp) ? odp : (odp.products || odp.data || []);
      for (const l of linie) {
        const blad = l.errors && l.errors.length ? l.errors : (l.warnings && l.warnings.length ? l.warnings : null);
        if (blad) bledy.push({ product_id: l.product_id, blad });
      }
      zapisane += paczka.length - linie.filter((l) => l.errors && l.errors.length).length;
    }
  }

  return { kurs, produktow: produkty.length, bezHurtu, zWariantami, zmiany, podejrzane, zapisane, bledy };
}

// Job: raz na dobe o GODZINA_JOBA. setTimeout do najblizszej 3:00 zamiast setInterval - restart
// WMS w ciagu dnia nie przesuwa przebiegu na godziny pracy.
function msDoNastepnego(teraz = new Date()) {
  const cel = new Date(teraz);
  cel.setHours(GODZINA_JOBA, 0, 0, 0);
  if (cel <= teraz) cel.setDate(cel.getDate() + 1);
  return cel - teraz;
}

function start() {
  if (process.env.SELLASIST_HURT_PLN_WYLACZ === '1' || !skonfigurowane()) return;
  const zaplanuj = () => {
    setTimeout(async () => {
      try {
        const r = await przelicz({ probne: false });
        console.log(`[sellasist-hurt-pln] kurs ${r.kurs.kurs} (${r.kurs.tabela}), zapisano ${r.zapisane}`
          + ` z ${r.produktow}, do sprawdzenia (> 2× ceny): ${r.podejrzane.length}${r.bledy.length ? `, bledy: ${r.bledy.length}` : ''}`);
      } catch (err) {
        console.error(`[sellasist-hurt-pln] ${err.message}`);
      }
      zaplanuj();
    }, msDoNastepnego()).unref();
  };
  zaplanuj();
}

module.exports = { przelicz, start, kursNbpEur, msDoNastepnego };
