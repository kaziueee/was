// kreator.js - wspolne fundamenty ekranow-kreatorow Zebry (skan -> kroki -> komunikaty).
// Laduj w HTML PRZED <ekran>.js (i PO shared/auth.js). Wymaga elementu #komunikat.
// Zob. ruch.js, produkty.js - kazdy korzysta z tych helperow zamiast trzymac wlasne kopie.

const el = (id) => document.getElementById(id);

// --- komunikaty (wymaga #komunikat) ---
const komunikat = el('komunikat');
function pokazKomunikat(tekst, typ) {
  komunikat.textContent = tekst;
  komunikat.className = `komunikat ${typ}`;
}
function ukryjKomunikat() {
  komunikat.className = 'komunikat hidden';
}

// --- operator: zalogowany profil z shared/auth.js (dawniej pole #input-operator + localStorage
// 'wms_operator' - pole zniklo przy przejsciu na logowanie profilem, wiec czytanie tego klucza
// zwracalo juz zawsze null). Backend i tak NADPISUJE req.body.operator imieniem z sesji
// (services/auth.js, wymagajSesji), wiec to jest tylko podpowiedz dla UI - nie autorytet.
function operator() {
  return (window.WMS?.user() || {}).imie || null;
}

// --- skan/Enter na polu tekstowym: trim + uppercase, czysci pole, ignoruje puste ---
// Dwie drogi zatwierdzenia:
//  1) keydown Enter - klawiatura ekranowa oraz DataWedge z "Send Characters as Events".
//  2) znak konca linii w wartosci - DataWedge potrafi "wkleic" dane z koncowym \n bez
//     zdarzenia Enter (WebView/Chrome). Reczne pisanie nie wstawia \n do pola jednoliniowego,
//     wiec nie odpala drogi 2. Obie drogi czyszcza pole, wiec nie ma podwojnego wywolania.
function onScan(input, callback) {
  function zatwierdz() {
    const wartosc = input.value.replace(/[\r\n]+/g, '').trim().toUpperCase();
    input.value = '';
    // Reczne wpisanie (pole w trybie tekstowym = klawiatura na ekranie) -> po Enterze
    // chowamy klawiature przez blur (blur handler wraca do inputmode="none"). Skan
    // (inputmode="none", bez klawiatury) zostawiamy z fokusem, by kolejny skan wpadl.
    if (input.getAttribute('inputmode') === 'text') input.blur();
    if (!wartosc) return;
    callback(wartosc);
  }
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    zatwierdz();
  });
  input.addEventListener('input', (e) => {
    // DataWedge "Send Enter as string": CR/LF dochodzi jako znak danych, nie jako klawisz.
    // Pole jednoliniowe potrafi wyciac go z value, ale InputEvent niesie to w inputType/data,
    // wiec sprawdzamy wszystkie trzy zrodla. Zwykle znaki maja inputType "insertText" bez \n.
    if (e.inputType === 'insertLineBreak'
        || /[\r\n]/.test(e.data || '')
        || /[\r\n]/.test(input.value)) {
      zatwierdz();
    }
  });
}

// Pola skanu: klawiatura ekranowa nie wyskakuje przy automatycznym .focus() miedzy krokami.
// Skaner (DataWedge) wstrzykuje dane jako zdarzenia klawiszy niezaleznie od klawiatury, wiec
// na tych polach jest ona zbedna. Domyslnie inputmode="none" (brak klawiatury). Dotkniecie
// pola przelacza je chwilowo na tryb tekstowy i pokazuje klawiature (reczne wpisanie, np.
// szukanie po nazwie); po wyjsciu z pola wraca do "none", by kolejny skan byl bez klawiatury.
// Czas ostatniego programowego fokusu (fokusBezKlawiatury) - do odsiania "ghost click".
let ostatniAutoFokusTs = 0;

function polaSkanuBezKlawiatury(...inputy) {
  for (const inp of inputy) {
    if (!inp) continue;
    inp.setAttribute('inputmode', 'none');
    inp.addEventListener('click', () => {
      // Ignoruj "ghost click": tap w wiersz rozkladu przechodzi krok, a syntetyczny click z
      // tego tapu lada na nowo pokazanym polu. Prawdziwe dotkniecie (> 600ms po auto-fokusie)
      // = reczne wpisanie: przywracamy datalist (podpowiedzi) i pokazujemy klawiature.
      if (Date.now() - ostatniAutoFokusTs < 600) return;
      if (inp.dataset.list) inp.setAttribute('list', inp.dataset.list);
      inp.blur();
      inp.setAttribute('inputmode', 'text');
      inp.focus();
    });
    inp.addEventListener('blur', () => inp.setAttribute('inputmode', 'none'));
  }
}

// Programowy fokus na pole skanu BEZ otwierania klawiatury (po skanie/przejsciu kroku).
// Wymusza inputmode="none" tuz przed .focus() - inaczej pole moze miec zostawiony
// inputmode="text" (po wczesniejszym dotknieciu) i klawiatura wyskakuje sama. Skan DataWedge
// dziala normalnie; klawiatura pojawia sie dopiero na DOTKNIECIE pola (click w polaSkanuBezKlawiatury).
function fokusBezKlawiatury(inp) {
  if (!inp) return;
  ostatniAutoFokusTs = Date.now(); // znacznik do odsiania ghost-click w polaSkanuBezKlawiatury
  inp.setAttribute('inputmode', 'none');
  // Datalist (list=) sprawia, ze Chrome na PROGRAMOWY fokus otwiera klawiature + autofill
  // (pole "Skanuj lub wpisz" z lista). Zdejmujemy go na czas auto-fokusu - skan DataWedge
  // dziala bez niego; wraca przy dotknieciu pola (polaSkanuBezKlawiatury). To roznica miedzy
  // input-cel (z lista -> klawiatura) a input-wybor-skan (bez listy -> bez klawiatury).
  const list = inp.getAttribute('list');
  if (list) { inp.dataset.list = list; inp.removeAttribute('list'); }
  inp.focus();
}
