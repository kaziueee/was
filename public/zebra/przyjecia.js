// Zakladka "Przyjecia" na Zebrze: sam rozdzielacz do trzech szuflad przychodu - PW,
// "Do sprawdzenia" i Przywozka. Zero logiki i zero fetchy; kazdy z tych ekranow zostaje
// osobnym widokiem i sam sie laduje (przyjecia-wewn.js / do-sprawdzenia.js / przywozki.js).
//
// Przyciski btn-go-pw / btn-go-dosp / btn-go-przywozki przeprowadzily sie z menu glownego
// do tego widoku, ale zachowaly id - ich handlery siedza dalej w swoich plikach.
//
// Historia: wejscie pushuje {v:'przyjecia'}, wiec Wstecz z PW/Do sprawdzenia/Przywozki
// wraca TU, a nie do menu glownego (patrz WIDOKI_Z_HISTORIA w ruch.js).
(() => {
  el('btn-go-przyjecia').addEventListener('click', () => {
    pokazWidok('przyjecia');
    history.pushState({ v: 'przyjecia' }, '');
  });
  el('przyjecia-wstecz').addEventListener('click', () => history.back());
})();
