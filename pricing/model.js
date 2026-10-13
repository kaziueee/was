'use strict';

// Decyzja cenowa repricera dla JEDNEJ oferty (SKU × rynek) — czysta funkcja, bez SQLite, GT i API,
// testy w `test/pricing-model.test.js`. Adapter platformy dostarcza obserwację, kalkulator WMS
// (`config/rynki.js` przez `services/cennik.js`) dostarcza pas [min, max]; tu zapada tylko decyzja.
//
// Porównujemy ceny Z WYSYŁKĄ (landed), bo tak rozstrzyga Buy Box — oferta 20,00 + 4,99 przegrywa
// z 24,50 + 0. Wynik zwracamy jako cenę TOWARU (bez wysyłki), bo tylko ją repricer ustawia.
//
// Reguły (lekcje z testu Amazon Automate Pricing, 06–12.10.2026):
//  1. Brak danych o konkurencji → nic nie zmieniamy.
//  2. Mamy Buy Box i następny konkurent jest wyraźnie wyżej → PODNOSIMY pod niego (nie wyżej niż max).
//     Tego automat Amazona nie robi wcale (103 obniżki, 2 podwyżki na 112 ofertach).
//  3. Nie mamy Buy Boxa → schodzimy na cenę zwycięzcy minus krok, ale nigdy pod min.
//  4. Remis z ofertą FBA (ta sama cena landed, a Buy Box ma FBA) → stoimy. W teście 26 z 47
//     przegranych miało cenę równą zwycięzcy — grosz w dół nie daje gwarancji Buy Boxa, za to
//     zaczyna wojnę cenową z ofertą, którą Amazon i tak faworyzuje.
//  5. Jeden przebieg nie zbija ceny o więcej niż `maxSpadekPct` ani nie podnosi o więcej niż
//     `maxWzrostPct` — duża zmiana idzie schodami
//     (i widać go w logu decyzji), zamiast jednym skokiem po chwilowej anomalii konkurenta.

const DOMYSLNE_REGULY = {
  krok: 0.01,          // o ile schodzimy pod konkurenta
  progPodwyzki: 0.5,   // podnosimy dopiero, gdy zysk na cenie ≥ tyle (w walucie rynku) — bez drgań
  maxSpadekPct: 5,     // największa obniżka w jednym przebiegu, % obecnej ceny
  maxWzrostPct: 10,    // największa podwyżka w jednym przebiegu — skok o 30–45% naraz (realne przypadki
                       // przy dalekim konkurencie) może odciąć sprzedaż albo Buy Box; podchodzimy schodami
};

const zaokr = (x) => Math.round(x * 100) / 100;

// obs: {
//   cena,            // nasza cena towaru (bez wysyłki)
//   wysylka,         // nasza wysyłka (0 gdy darmowa)
//   bbNasz,          // true/false/null — czy mamy Buy Box (null = nie wiadomo)
//   bbCena,          // cena landed zwycięzcy Buy Boxa (null = brak BB / brak danych)
//   bbFba,           // czy zwycięzca BB to FBA
//   najtanszaInna,   // najtańsza landed oferta INNEGO sprzedawcy (null = brak)
// }
// pas: { min, max } — ceny towaru (bez wysyłki) z kalkulatora
// Zwraca { cena, zmiana, kod, powod } — `cena` to cena towaru do ustawienia.
function decyzja(obs, pas, reguly = {}) {
  const r = { ...DOMYSLNE_REGULY, ...reguly };
  const cena = Number(obs.cena);
  const wys = Number(obs.wysylka) || 0;
  const { min, max } = pas || {};
  const zostaw = (kod, powod) => ({ cena, zmiana: false, kod, powod });

  if (!(cena > 0)) return zostaw('brak_ceny', 'brak naszej ceny w odpowiedzi platformy');
  if (!(min > 0) || !(max >= min)) return zostaw('brak_pasa', 'brak poprawnego pasa min/max z kalkulatora');

  const ustaw = (cel, kod, powod) => {
    // min to podłoga zawsze; max ogranicza wyłącznie PODWYŻKI — wygrywającej oferty nie obniżamy
    // tylko dlatego, że stoi nad max (to byłoby oddawanie marży bez powodu).
    let nowa = zaokr(Math.max(min, cel));
    if (nowa > cena) nowa = zaokr(Math.min(nowa, Math.max(max, cena)));
    let limit = false;
    const dolKroku = zaokr(cena * (1 - r.maxSpadekPct / 100));
    if (nowa < dolKroku) { nowa = Math.max(dolKroku, min); limit = true; }
    // Schodki w górę dotyczą podwyżek „po zysk"; powrót spod minimum (pod_min) idzie od razu —
    // minimum to podłoga marży, nie cel do negocjacji.
    const goraKroku = zaokr(cena * (1 + r.maxWzrostPct / 100));
    if (nowa > goraKroku && kod !== 'pod_min') { nowa = goraKroku; limit = true; }
    if (Math.abs(nowa - cena) < 0.005) return zostaw(kod, powod);
    return { cena: nowa, zmiana: true, kod: limit ? kod + '_limit' : kod,
      powod: limit ? `${powod}; zmiana ścięta do ${nowa < cena ? r.maxSpadekPct : r.maxWzrostPct}% na przebieg` : powod };
  };

  // Cena poza pasem (np. ktoś zmienił ją ręcznie, albo zmienił się koszt) — najpierw wracamy do pasa.
  if (cena < min - 0.005) return ustaw(min, 'pod_min', `cena ${cena} poniżej minimum ${min} — wracamy na minimum`);

  if (obs.bbNasz === true) {
    const nast = obs.najtanszaInna;
    if (!(nast > 0)) return zostaw('top_bez_konkurencji', 'mamy Buy Box, brak innych ofert do porównania');
    const cel = zaokr(Math.min(nast - r.krok - wys, max));
    if (cel - cena >= r.progPodwyzki) {
      return ustaw(cel, 'podwyzka', `mamy Buy Box, następny konkurent ${nast} (z wysyłką) — podnosimy pod niego`);
    }
    return zostaw('top', 'mamy Buy Box, cena już tuż pod konkurentem albo na maksimum');
  }

  if (obs.bbNasz === false && obs.bbCena > 0) {
    const nasza = zaokr(cena + wys);
    if (Math.abs(nasza - obs.bbCena) < 0.005 && obs.bbFba) {
      return zostaw('remis_fba', `ta sama cena co zwycięzca FBA (${obs.bbCena}) — obniżka nie gwarantuje Buy Boxa`);
    }
    const cel = zaokr(obs.bbCena - r.krok - wys);
    if (cel < min - 0.005) {
      if (cena > min + 0.005) return ustaw(min, 'na_min', `Buy Box ${obs.bbCena} poniżej naszej podłogi — schodzimy na minimum ${min}`);
      return zostaw('pod_podloga', `Buy Box ${obs.bbCena} poniżej naszej podłogi ${min} — stoimy na minimum`);
    }
    if (cel < cena - 0.005) return ustaw(cel, 'obnizka', `Buy Box ${obs.bbCena} (z wysyłką) — schodzimy o ${r.krok} niżej`);
    // Jesteśmy tańsi albo równi, a Buy Boxa i tak nie mamy — cena nie jest powodem.
    return zostaw('przegrana_nie_cena', 'nasza cena nie wyższa niż Buy Box — przegrywamy z innego powodu niż cena');
  }

  return zostaw('brak_danych', 'brak danych o Buy Boxie');
}

module.exports = { decyzja, DOMYSLNE_REGULY };
