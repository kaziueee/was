// Pelny ekran bez instalacji PWA / bez EHS - chowa pasek adresu i przyciski Chrome po HTTP.
// PODWOJNY TAP (dwa dotkniecia < 350 ms) WCHODZI w pelny ekran (nie wychodzi - zeby
// przypadkowy dwuklik nie wyrzucal z trybu). Wyjscie/przelaczanie tylko swiadomie przez
// przycisk "Tryb pelnoekranowy" w menu (window.przelaczPelnyEkran).
// Fullscreen API wymaga gestu - tap go zapewnia. W SPA (bez przeladowan) tryb trzyma sie
// przez caly czas pracy. Zero konfiguracji na terminalu.
(function () {
  function jestPelny() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }
  function wejdz() {
    var de = document.documentElement;
    var req = de.requestFullscreen || de.webkitRequestFullscreen;
    if (req) { try { req.call(de); } catch (e) { /* przegladarka nie pozwala */ } }
  }
  function wyjdz() {
    var ex = document.exitFullscreen || document.webkitExitFullscreen;
    if (ex) { try { ex.call(document); } catch (e) { /* ignoruj */ } }
  }
  function przelacz() { jestPelny() ? wyjdz() : wejdz(); }

  // dostepne dla przycisku w menu
  window.przelaczPelnyEkran = przelacz;

  // detekcja podwojnego tapu (maximum-scale=1 wylacza zoom, wiec nie koliduje)
  var ostatniTap = 0;
  document.addEventListener('pointerdown', function () {
    var teraz = Date.now();
    if (teraz - ostatniTap > 0 && teraz - ostatniTap < 350) {
      if (!jestPelny()) wejdz(); // podwojny tap tylko WCHODZI w pelny ekran (nie wychodzi)
      ostatniTap = 0;
    } else {
      ostatniTap = teraz;
    }
  });
})();
