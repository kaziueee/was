'use strict';

// Worker robi jedną rzecz naraz — pełny przebieg, przebieg samego Allegro (po raporcie Top), potwierdzenia po
// wysłaniu cen, ręczne korekty — bo wszystkie piszą do tej samej bazy i odpytują te same API. Reguły kolejki
// (wcześniej trzy różne warunki `if (trwa)` w worker.js; testy w test/pricing-kolejka-workera.test.js):
//  - pełny przebieg trafił na coś krótkiego (potwierdzenie, korekta, przebieg Allegro — sekundy): czeka i rusza
//    zaraz po nim; trafił na poprzedni PEŁNY przebieg (dłuższy niż interwał): pomijany, następny za interwał.
//    Pominięcie zostawia wpis w logu z czasem trwania poprzedniego — przebieg dłuższy niż interwał to już
//    nieprawidłowość (zwykle 6–18 min), a do 24.10 kolejka pomijała po cichu i log milczał przez 2 h zawieszenia
//  - potwierdzenie po wysłaniu czeka na wolną kolejkę, najwyżej 30 min (potem odpuszcza — następny przebieg i tak
//    obserwuje te oferty). Wcześniej było wtedy POMIJANE: 19.10 potwierdzenia Allegro przepadły, bo w tej samej
//    chwili potwierdzał się Amazon; pełny przebieg wypadał, gdy trafił na czyjeś potwierdzenie (czekał tylko na korekty)
//  - zadanie co minutę (korekty, nowy raport Top): tylko gdy wolne, inaczej za minutę
//  - strażnik (`straznik()`, worker woła go co minutę): zadanie trwające dłużej niż `limitMs` raz wywołuje
//    `poZawieszeniu`. Kolejki NIE zwalniamy — zawieszone zadanie może się kiedyś obudzić i dokończyć zapis
//    (decyzje, wysyłka cen) obok nowego przebiegu. Worker kończy wtedy proces, a harmonogram stawia go od nowa.

function utworzKolejke({ czekajMs = 15_000, maxCzekaniaMs = 30 * 60_000, limitMs = 60 * 60_000, poZawieszeniu = () => {},
  zegar = setTimeout, teraz = Date.now, log = console.error } = {}) {
  let zajete = false, pelny = false, od = null, opisZadania = null, zgloszone = false;
  const czas = () => new Date(teraz()).toISOString();
  const minut = () => Math.round((teraz() - od) / 60_000);
  const blad = (co) => (e) => log(czas(), `[pricing] ${co}:`, e?.message || e);
  const wykonaj = async (fn, czyPelny, opis) => {
    zajete = true;
    pelny = czyPelny;
    od = teraz();
    opisZadania = opis;
    zgloszone = false;
    try { return await fn(); } finally { zajete = pelny = false; od = opisZadania = null; }
  };
  const k = {
    get zajete() { return zajete; },
    // Co trwa teraz: { opis, od (ms), minut } albo null.
    get biezace() { return zajete ? { opis: opisZadania, od, minut: minut() } : null; },
    // Pełny przebieg; `potem(wynik)` po jego końcu (planowanie potwierdzeń).
    przebieg(fn, potem = () => {}, opis = 'pełny przebieg') {
      if (zajete) {
        if (!pelny) zegar(() => k.przebieg(fn, potem, opis), czekajMs);
        else log(czas(), `[pricing] ${opis} pominięty — poprzedni trwa od ${new Date(od).toISOString()} (${minut()} min)`);
        return false;
      }
      wykonaj(fn, true, opis).then(potem, blad(opis));
      return true;
    },
    // Potwierdzenie po `opoznienieMs` — gdy wtedy coś trwa, czeka na swoją kolej (do maxCzekaniaMs).
    potwierdzenie(fn, opoznienieMs, opis = 'potwierdzenie') {
      const do_ = teraz() + opoznienieMs + maxCzekaniaMs;
      const sprobuj = () => {
        if (!zajete) return void wykonaj(fn, false, opis).catch(blad(opis));
        if (teraz() < do_) zegar(sprobuj, czekajMs);
        else log(czas(), `[pricing] ${opis} pominięte — worker zajęty ponad ${Math.round(maxCzekaniaMs / 60_000)} min`);
      };
      zegar(sprobuj, opoznienieMs);
    },
    // Zadanie okresowe: tylko gdy nic nie trwa. Zwraca, czy ruszyło.
    jesliWolne(fn, opis = 'zadanie') {
      if (zajete) return false;
      wykonaj(fn, false, opis).catch(blad(opis));
      return true;
    },
    // Czy bieżące zadanie nie wisi. Zgłasza raz na zadanie; zwraca, czy zgłosiło.
    straznik() {
      if (!zajete || zgloszone || teraz() - od <= limitMs) return false;
      zgloszone = true;
      const b = k.biezace;
      log(czas(), `[pricing] STRAŻNIK: ${b.opis} trwa ${b.minut} min (od ${new Date(b.od).toISOString()}, limit ${Math.round(limitMs / 60_000)} min)`);
      poZawieszeniu(b);
      return true;
    },
  };
  return k;
}

module.exports = { utworzKolejke };
