// kreator.js - wspolne fundamenty ekranow-kreatorow Zebry (skan -> kroki -> komunikaty).
// Laduj w HTML PRZED <ekran>.js. Wymaga elementu #komunikat; #input-operator jest opcjonalne.
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

// --- operator (zapamietany w localStorage; pole opcjonalne na danym ekranie) ---
const inputOperator = el('input-operator');
if (inputOperator) {
  inputOperator.value = localStorage.getItem('wms_operator') || '';
  inputOperator.addEventListener('change', () => {
    localStorage.setItem('wms_operator', inputOperator.value.trim());
  });
}

// biezacy operator albo null - do pola operator w ruchach
function operator() {
  return (inputOperator && inputOperator.value.trim()) || null;
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
function polaSkanuBezKlawiatury(...inputy) {
  for (const inp of inputy) {
    if (!inp) continue;
    inp.setAttribute('inputmode', 'none');
    inp.addEventListener('click', () => {
      inp.blur();
      inp.setAttribute('inputmode', 'text');
      inp.focus();
    });
    inp.addEventListener('blur', () => inp.setAttribute('inputmode', 'none'));
  }
}
