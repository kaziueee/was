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
//  6. Podwyżka jest czuła na utratę Buy Boxa (decyzja usera 2026-10-13): jeśli po WYSŁANEJ podwyżce
//     straciliśmy BB, a nasza cena to wciąż ta podniesiona — wracamy od razu (bez schodka) do ceny
//     sprzed podwyżki, przy której BB był nasz. Po cofnięciu podwyżki są wstrzymane na
//     `blokadaPodwyzekH` godzin; obniżki i podłoga działają normalnie.
//     NIE dotyczy obserwacji z pełną listą konkurentów (`obs.konkurenci` — Allegro z Niezbędnikiem, decyzja
//     usera 2026-10-21): tam „utrata” po podwyżce znaczy tylko, że pojawił się tańszy konkurent — reguła 3
//     schodzi pod niego, a gdy zniknie, podwyżka wraca. BARJFL66 20.10: po podwyżce do 89,90 przyszedł
//     sprzedawca za 78,99 → cofnięcie do 87,95 (nic nie dało) i blokada, przez którą cena nie wróciła na
//     89,90 po jego zniknięciu.
//  7. Cena poniżej minimum idzie od razu na minimum (bez schodka) i się nie cofa — utrata BB
//     przy cenie minimalnej nie szkodzi (decyzja usera 2026-10-14).
//  8. Wojna o grosze (decyzja usera 2026-10-15): po `wojnaObnizek` WYSŁANYCH obniżkach do ceny
//     Buy Boxa (bez schodków −5% — te jeszcze nie dogoniły konkurenta) z rzędu,
//     po których Buy Box ani razu nie był nasz, obniżki stają na `wojnaPauzaH` godzin od ostatniej.
//     Drugi repricer odpowiada wtedy na każdy nasz krok w kilka minut — HWHHGV67 DE: 12 obniżek
//     w 6 h (83,45 → 83,03 €) i ani razu BB. Kolejne kroki tylko oddają marżę. Po pauzie jedna
//     obniżka; jeśli i ona nie da BB, znowu pauza — wojna idzie krokiem na dobę, nie co 30 min.
//     Zdobyty Buy Box zeruje licznik; podwyżki, podłoga i powrót spod minimum działają normalnie.
//  9. Szukanie ceny konkurenta (decyzja usera 2026-10-15, eMAG): mamy Buy Box, na produkcie są inne
//     oferty, ale platforma nie podaje ich cen (`konkurencjaNieznana`). Podnosimy o `sondaKrokPct` na
//     przebieg (nie wyżej niż max); gdy po takiej podwyżce stracimy BB, reguła 6 wraca do ostatniej
//     ceny z BB i wstrzymuje podwyżki na `blokadaPodwyzekH` — cena staje tuż pod konkurentem.
//     Jedyna oferta na produkcie (brak sygnału stopu) — bez zmian, nie podnosimy.
// 10. Platforma w ogóle nie podaje cen konkurencji (`konkurencjaNiedostepna`, Allegro od 2026-10-16) —
//     pilnujemy tylko podłogi: cena pod minimum idzie na minimum (reguła 7), poza tym bez zmian. Gdy raport
//     „Czynniki Top oferty” ocenia cenę jako „odpowiednią”, kod `top_raport` („cena OK”) — to nie brak danych, tylko
//     brak ceny NASTĘPNEGO konkurenta do podwyżki (19.10: 823 oferty ekajtek liczyły się w „Brak danych”). „Cena OK”
//     to nie pewny Top: 21.10 na 70 produktach dwie nasze oferty miały naraz „OK”, a Top na stronie jest jeden.

const DOMYSLNE_REGULY = {
  krok: 0.01,          // o ile schodzimy pod konkurenta
  progPodwyzki: 0.5,   // podnosimy dopiero, gdy zysk na cenie ≥ tyle (w walucie rynku) — bez drgań
  maxSpadekPct: 5,     // największa obniżka w jednym przebiegu, % obecnej ceny
  blokadaPodwyzekH: 24, // po cofnięciu podwyżki (utrata BB) tyle godzin bez kolejnych podwyżek
  maxWzrostPct: 10,    // największa podwyżka w jednym przebiegu — skok o 30–45% naraz (realne przypadki
                       // przy dalekim konkurencie) może odciąć sprzedaż albo Buy Box; podchodzimy schodami
  wojnaObnizek: 3,     // tyle wysłanych obniżek z rzędu bez Buy Boxa = wojna o grosze (reguła 8)
  wojnaPauzaH: 24,     // tyle godzin od ostatniej obniżki bez kolejnej
  sondaKrokPct: 3,     // krok szukania ceny konkurenta przy naszym BB, gdy jego ceny nie znamy (reguła 9)
};

const zaokr = (x) => Math.round(x * 100) / 100;

// obs: {
//   cena,            // nasza cena towaru (bez wysyłki)
//   wysylka,         // nasza wysyłka (0 gdy darmowa)
//   bbNasz,          // true/false/null — czy mamy Buy Box (null = nie wiadomo)
//   bbCena,          // cena landed zwycięzcy Buy Boxa (null = brak BB / brak danych)
//   bbFba,           // czy zwycięzca BB to FBA
//   najtanszaInna,   // najtańsza landed oferta INNEGO sprzedawcy (null = brak)
//   bbInnaNasza,     // Buy Box ma nasza INNA oferta tego samego ASIN-u
//   konkurencjaNieznana, // mamy Buy Box, są inne oferty, ale platforma nie podaje ich cen (eMAG)
//   najtanszaNasza,  // nie mamy Buy Boxa, choć nasza oferta jest najtańsza (eMAG: Buy Box nie tylko po cenie)
//   konkurencjaNiedostepna, // platforma nie podaje cen innych sprzedawców (Allegro) — reguła 10
// }
// pas: { min, max } — ceny towaru (bez wysyłki) z kalkulatora
// kontekst (z historii decyzji, liczy worker):
//   ostatniaPodwyzka — { cena_przed, cena_nowa } ostatnia WYSŁANA podwyżka z okna blokady (albo null)
//   blokadaPodwyzek  — true, gdy w oknie blokady było już cofnięcie
//   obnizkiBezBb     — { n, godzOd }: wysłane obniżki od ostatniej obserwacji z NASZYM Buy Boxem
//                      i ile godzin minęło od ostatniej z nich (reguła 8)
// Zwraca { cena, cel, zmiana, kod, powod } — `cena` to cena towaru do ustawienia w tym przebiegu,
// `cel` to cena docelowa (bez limitu schodka); bez zmiany cel = cena.
function decyzja(obs, pas, reguly = {}, kontekstWe = {}) {
  const r = { ...DOMYSLNE_REGULY, ...reguly };
  // Reguła 6 tylko tam, gdzie Buy Box zależy od rzeczy, których nie widzimy (opis wyżej).
  const kontekst = Array.isArray(obs.konkurenci) ? { ...kontekstWe, ostatniaPodwyzka: null, blokadaPodwyzek: false } : kontekstWe;
  const cena = Number(obs.cena);
  const wys = Number(obs.wysylka) || 0;
  const { min, max } = pas || {};
  const zostaw = (kod, powod) => ({ cena, cel: cena, zmiana: false, kod, powod });

  if (!(cena > 0)) return zostaw('brak_ceny', 'brak naszej ceny w odpowiedzi platformy');
  if (!(min > 0) || !(max >= min)) return zostaw('brak_pasa', 'brak poprawnego pasa min/max z kalkulatora');

  const ustaw = (cel, kod, powod) => {
    // min to podłoga zawsze; max ogranicza wyłącznie PODWYŻKI — wygrywającej oferty nie obniżamy
    // tylko dlatego, że stoi nad max (to byłoby oddawanie marży bez powodu).
    let nowa = zaokr(Math.max(min, cel));
    if (nowa > cena) nowa = zaokr(Math.min(nowa, Math.max(max, cena)));
    // Cena DOCELOWA = dokąd automat zmierza (po min/max, przed schodkami). Pierwszy krok bywa
    // krótszy (−5% / +10% na przebieg); ekran pokazuje oba.
    const docelowa = nowa;
    let limit = false;
    const dolKroku = zaokr(cena * (1 - r.maxSpadekPct / 100));
    if (nowa < dolKroku) { nowa = Math.max(dolKroku, min); limit = true; }
    // Schodki w górę dotyczą podwyżek „po zysk". Powrót spod minimum (pod_min) idzie od razu na
    // minimum — to podłoga marży, nie cel do negocjacji (decyzja usera 2026-10-14; ekran ostrzega
    // o tym przy włączaniu automatu).
    const goraKroku = zaokr(cena * (1 + r.maxWzrostPct / 100));
    if (nowa > goraKroku && kod !== 'pod_min') { nowa = goraKroku; limit = true; }
    // Cofnięcie podwyżki wraca do ceny, przy której BB był nasz — bez schodka w dół.
    if (kod === 'cofniecie') { nowa = zaokr(Math.max(min, cel)); limit = false; }
    if (Math.abs(nowa - cena) < 0.005) return zostaw(kod, powod);
    return { cena: nowa, cel: docelowa, zmiana: true, kod: limit ? kod + '_limit' : kod,
      powod: limit ? `${powod}; zmiana ścięta do ${nowa < cena ? r.maxSpadekPct : r.maxWzrostPct}% na przebieg` : powod };
  };

  // Buy Box ma nasza INNA oferta tego samego produktu (np. SKU z dopiskiem -1) — nie konkurujemy
  // sami ze sobą: ani obniżka (zabrałaby BB własnej ofercie), ani podwyżka „pod konkurenta".
  if (obs.bbInnaNasza) return zostaw('bb_nasza_inna', 'Buy Box ma nasza inna oferta tego produktu — nie konkurujemy sami ze sobą');

  // Reguła 6: straciliśmy BB zaraz po naszej podwyżce → cofamy. Dotyczy tylko podwyżek „po zysk",
  // czyli zaczętych z ceny w pasie (≥ min). Podniesienie spod minimum na minimum się nie cofa —
  // utrata BB przy cenie minimalnej „nie szkodzi" (decyzja usera 2026-10-14).
  const pod = kontekst.ostatniaPodwyzka;
  if (obs.bbNasz === false && pod && Math.abs(cena - pod.cena_nowa) < 0.005 && pod.cena_przed < cena
      && pod.cena_przed >= min - 0.005) {
    return ustaw(pod.cena_przed, 'cofniecie', `po podwyżce do ${pod.cena_nowa} straciliśmy Buy Box — wracamy do ${pod.cena_przed}; podwyżki wstrzymane na ${r.blokadaPodwyzekH} h`);
  }

  // Cena poza pasem (np. ktoś zmienił ją ręcznie, albo zmienił się koszt) — wracamy do pasa schodkami.
  if (cena < min - 0.005) return ustaw(min, 'pod_min', `cena ${cena} poniżej minimum ${min} — od razu na minimum`);

  if (obs.konkurencjaNiedostepna) {
    return obs.bbNasz === true
      ? zostaw('top_raport', 'cena OK w raporcie Top ofert — ceny następnego konkurenta nie znamy, więc nie podnosimy')
      : zostaw('bez_konkurencji', 'platforma nie podaje cen konkurencji — pilnujemy tylko minimum');
  }

  if (obs.bbNasz === true) {
    const nast = obs.najtanszaInna;
    if (!(nast > 0)) {
      // eMAG przy naszym Buy Boxie podaje jako „najlepszą ofertę" nas samych — ceny następnego
      // konkurenta nie znamy, więc nie podnosimy w ciemno (inaczej „jedyna oferta" kłamałaby na ekranie).
      if (obs.konkurencjaNieznana) {
        if (kontekst.blokadaPodwyzek) {
          return zostaw('top_blokada', `mamy Buy Box; szukanie ceny konkurenta wstrzymane po niedawnej utracie BB (${r.blokadaPodwyzekH} h)`);
        }
        const sonda = zaokr(Math.min(cena * (1 + r.sondaKrokPct / 100), max));
        if (sonda - cena < 0.005) return zostaw('top', 'mamy Buy Box, cena na maksimum');
        return ustaw(sonda, 'sonda', `mamy Buy Box, ceny konkurencji nieznane — szukamy jej: +${r.sondaKrokPct}% (po utracie BB powrót)`);
      }
      return zostaw('top_bez_konkurencji', 'mamy Buy Box, brak innych ofert do porównania');
    }
    const cel = zaokr(Math.min(nast - r.krok - wys, max));
    if (cel - cena >= r.progPodwyzki && kontekst.blokadaPodwyzek) {
      return zostaw('top_blokada', `mamy Buy Box; podwyżki wstrzymane po niedawnej utracie BB (${r.blokadaPodwyzekH} h)`);
    }
    if (cel - cena >= r.progPodwyzki) {
      return ustaw(cel, 'podwyzka', `mamy Buy Box, następny konkurent ${nast} (z wysyłką) — podnosimy pod niego`);
    }
    return zostaw('top', 'mamy Buy Box, cena już tuż pod konkurentem albo na maksimum');
  }

  // eMAG przyznaje Buy Box nie tylko po cenie — gdy już jesteśmy najtańsi, obniżka tylko oddaje marżę.
  if (obs.bbNasz === false && obs.najtanszaNasza) {
    return zostaw('przegrana_nie_cena', 'jesteśmy najtańsi (albo na równi), a Buy Box ma inna oferta — obniżka nie pomoże');
  }

  if (obs.bbNasz === false && obs.bbCena > 0) {
    const nasza = zaokr(cena + wys);
    // Reguła 8: tylko obniżki wstrzymujemy — `cel`/`min` liczymy dalej, żeby ekran pokazał, dokąd
    // automat by zszedł.
    const wojna = kontekst.obnizkiBezBb;
    const pauza = wojna && wojna.n >= r.wojnaObnizek && wojna.godzOd < r.wojnaPauzaH;
    const obnizka = (cel, kod, powod) => (pauza
      ? { ...zostaw('wojna_cenowa', `${wojna.n} obniżki z rzędu bez Buy Boxa — konkurent odpowiada na każdą; następna za ${Math.max(1, Math.ceil(r.wojnaPauzaH - wojna.godzOd))} h`), cel: zaokr(Math.max(min, cel)) }
      : ustaw(cel, kod, powod));
    if (Math.abs(nasza - obs.bbCena) < 0.005 && obs.bbFba) {
      return zostaw('remis_fba', `ta sama cena co zwycięzca FBA (${obs.bbCena}) — obniżka nie gwarantuje Buy Boxa`);
    }
    const cel = zaokr(obs.bbCena - r.krok - wys);
    if (cel < min - 0.005) {
      if (cena > min + 0.005) return obnizka(min, 'na_min', `Buy Box ${obs.bbCena} poniżej naszej podłogi — schodzimy na minimum ${min}`);
      return zostaw('pod_podloga', `Buy Box ${obs.bbCena} poniżej naszej podłogi ${min} — stoimy na minimum`);
    }
    if (cel < cena - 0.005) return obnizka(cel, 'obnizka', `Buy Box ${obs.bbCena} (z wysyłką) — schodzimy o ${r.krok} niżej`);
    // Jesteśmy tańsi albo równi, a Buy Boxa i tak nie mamy — cena nie jest powodem.
    return zostaw('przegrana_nie_cena', 'nasza cena nie wyższa niż Buy Box — przegrywamy z innego powodu niż cena');
  }

  return zostaw('brak_danych', 'brak danych o Buy Boxie');
}

module.exports = { decyzja, DOMYSLNE_REGULY };
