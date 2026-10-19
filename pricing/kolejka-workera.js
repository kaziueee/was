'use strict';

// Worker robi jedną rzecz naraz — pełny przebieg, przebieg samego Allegro (po raporcie Top), potwierdzenia po
// wysłaniu cen, ręczne korekty — bo wszystkie piszą do tej samej bazy i odpytują te same API. Reguły kolejki
// (wcześniej trzy różne warunki `if (trwa)` w worker.js; testy w test/pricing-kolejka-workera.test.js):
//  - pełny przebieg trafił na coś krótkiego (potwierdzenie, korekta, przebieg Allegro — sekundy): czeka i rusza
//    zaraz po nim; trafił na poprzedni PEŁNY przebieg (dłuższy niż interwał): pomijany, następny za interwał
//  - potwierdzenie po wysłaniu czeka na wolną kolejkę, najwyżej 30 min (potem odpuszcza — następny przebieg i tak
//    obserwuje te oferty). Wcześniej było wtedy POMIJANE: 19.10 potwierdzenia Allegro przepadły, bo w tej samej
//    chwili potwierdzał się Amazon; pełny przebieg wypadał, gdy trafił na czyjeś potwierdzenie (czekał tylko na korekty)
//  - zadanie co minutę (korekty, nowy raport Top): tylko gdy wolne, inaczej za minutę

function utworzKolejke({ czekajMs = 15_000, maxCzekaniaMs = 30 * 60_000, zegar = setTimeout, teraz = Date.now, log = console.error } = {}) {
  let zajete = false, pelny = false;
  const blad = (co) => (e) => log(new Date(teraz()).toISOString(), `[pricing] ${co}:`, e?.message || e);
  const wykonaj = async (fn, czyPelny) => {
    zajete = true;
    pelny = czyPelny;
    try { return await fn(); } finally { zajete = pelny = false; }
  };
  const k = {
    get zajete() { return zajete; },
    // Pełny przebieg; `potem(wynik)` po jego końcu (planowanie potwierdzeń).
    przebieg(fn, potem = () => {}) {
      if (zajete) {
        if (!pelny) zegar(() => k.przebieg(fn, potem), czekajMs);
        return false;
      }
      wykonaj(fn, true).then(potem, blad('przebieg'));
      return true;
    },
    // Potwierdzenie po `opoznienieMs` — gdy wtedy coś trwa, czeka na swoją kolej (do maxCzekaniaMs).
    potwierdzenie(fn, opoznienieMs, opis = 'potwierdzenie') {
      const do_ = teraz() + opoznienieMs + maxCzekaniaMs;
      const sprobuj = () => {
        if (!zajete) return void wykonaj(fn, false).catch(blad(opis));
        if (teraz() < do_) zegar(sprobuj, czekajMs);
        else log(new Date(teraz()).toISOString(), `[pricing] ${opis} pominięte — worker zajęty ponad ${Math.round(maxCzekaniaMs / 60_000)} min`);
      };
      zegar(sprobuj, opoznienieMs);
    },
    // Zadanie okresowe: tylko gdy nic nie trwa. Zwraca, czy ruszyło.
    jesliWolne(fn, opis = 'zadanie') {
      if (zajete) return false;
      wykonaj(fn, false).catch(blad(opis));
      return true;
    },
  };
  return k;
}

module.exports = { utworzKolejke };
