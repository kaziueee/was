// Wspolne formatowanie "karty produktu" - symbol/nazwa, stany GT (stany_gt)
// i lokalizacja wg pol wlasnych GT ze znacznikiem zgodnosci z WMS
// (lokalizacja_gt) - zob. routes/lokalizacje.js (dolaczDaneGt) i
// routes/produkty.js (dolaczLokalizacjeGt). Uzywane na listach wyboru
// i w widokach szczegolowych we wszystkich ekranach Zebry.

// Czy magazyn jest w ogole pokazywany na Zebrze. Flaga naZebrze z config/magazyny.js
// (przez /api/magazyny) - dzis wylacza K4R/Reklamacje: to proces biurkowy, magazynier
// na hali ich nie rusza. Chowamy je przed CZLOWIEKIEM, nie przed systemem - w rachunkach
// (stany, "do sprawdzenia", zgodnosc) magazyn dalej istnieje.
//
// To osobna sprawa niz liczyDoRazem: "czy pokazac" i "czy wliczyc do sumy" to dwa rozne
// pytania. BRK odpowiada na nie roznie - jest widoczny, ale poza suma.
function widocznyNaZebrze(kodMagazynu) {
  const m = (typeof magazynyMapa !== 'undefined') ? magazynyMapa[kodMagazynu] : null;
  return !m || m.naZebrze !== false;
}

// formatuje stany_gt ({K4: {ilosc, rezerwacja}, ...}) do podgladu, pomijajac
// magazyny z zerowym stanem i te ukryte na Zebrze, np. "K4:15 (rez 2) K4G:46 MAG:2"
function formatStanyGt(stanyGt) {
  const wpisy = Object.entries(stanyGt || {}).filter(([kod, w]) => w.ilosc !== 0 && widocznyNaZebrze(kod));
  if (wpisy.length === 0) return 'brak stanu w GT';
  return wpisy.map(([magazyn, w]) => {
    const rezerwacja = w.rezerwacja ? ` (rez ${w.rezerwacja})` : '';
    return `${magazyn}:${w.ilosc}${rezerwacja}`;
  }).join(' ');
}

// formatuje lokalizacje wg pol wlasnych GT z ikona zgodnosci wzgledem WMS -
// '' gdy brak danych z GT (np. produkt testowy bez prawdziwego tw_Id)
function formatLokalizacjaGt(lokalizacjaGt) {
  if (!lokalizacjaGt) return '';
  const ikona = lokalizacjaGt.zgodna ? '✅' : '❌';
  return `${ikona} ${lokalizacjaGt.tekst}`;
}

// klasa CSS badge'a statusu zgodnosci - te same stany co tabela desktopu (zgodnosc.ogolna)
const ZGODNOSC_BADGE = { OK: 'zg-ok', OF: 'zg-ok', t_GT: 'zg-info', NZ: 'zg-err', BD: 'zg-neutral' };

// kolorowy badge statusu zgodnosci WMS<->GT (OK / t_GT / NZ / BD / OF) - '' gdy brak danych
function statusZgodnosciBadge(produkt) {
  const z = produkt.zgodnosc;
  if (!z || !z.ogolna) return '';
  const klasa = ZGODNOSC_BADGE[z.ogolna] || 'zg-neutral';
  return `<span class="zg-badge ${klasa}" title="K4: ${z.k4 ?? '–'} | K4G: ${z.k4g ?? '–'}">${z.ogolna}</span>`;
}

// Czy magazyn wlicza sie do "Razem". BRK (braki) i K4R (reklamacje) NIE - to towar
// niepelnowartosciowy i nie ma zawyzac sumy "ile mam" (CLAUDE.md, "Magazyny").
//
// Zrodlem prawdy jest config/magazyny.js (flaga liczDoRazem), ktora Zebra dostaje gotowa
// z /api/magazyny - dlatego NIE wypisujemy tu kodow po raz trzeci. Backend liczy to samo
// dwoma sposobami (SORT_WYRAZENIA.razem w SQL + helper sumaRazem w Node); czwarta, reczna
// lista tutaj rozjechalaby sie przy pierwszym nowym magazynie - tak wlasnie K4R trafil do
// "Lacznego stanu" na Zebrze, choc backend go stamtad wykluczal.
function liczyDoRazem(kodMagazynu) {
  // magazynyMapa (ruch.js) laduje sie z /api/magazyny asynchronicznie po starcie. Karta
  // renderuje sie dopiero po skanie, wiec w praktyce jest juz gotowa; gdyby jeszcze nie byla,
  // wolimy policzyc magazyn (zachowanie sprzed zmiany) niz pokazac zanizone "Razem".
  const m = (typeof magazynyMapa !== 'undefined') ? magazynyMapa[kodMagazynu] : null;
  return !m || m.liczDoRazem !== false;
}

// suma "Razem" = K4+K4G+MAG+LS (bez BRK i K4R) - do POKAZANIA uzytkownikowi
function sumaRazemGt(stanyGt) {
  return Object.entries(stanyGt || {})
    .reduce((suma, [kod, w]) => suma + (liczyDoRazem(kod) ? (w.ilosc || 0) : 0), 0);
}

// suma rezerwacji - te same magazyny co "Razem". Bez tego produkt z K4R:60 (rez 60) pokazywal
// "Rezerwacje: 60", choc na polce nie jest zarezerwowane nic: stan na Reklamacjach jest w 100%
// zarezerwowany (zmierzone), wiec zalewalby ten licznik. Backend wyklucza je z REZ_RAZEM
// z tego samego powodu ("to inny proces, nie sprzedaz z polki").
function sumaRezerwacji(stanyGt) {
  return Object.entries(stanyGt || {})
    .reduce((suma, [kod, w]) => suma + (liczyDoRazem(kod) ? (w.rezerwacja || 0) : 0), 0);
}

// buduje {podetykieta, podetykieta2} dla pozycji listy wyboru (zob.
// renderujWybor) - wspolny uklad karty produktu: stany GT, potem
// lokalizacja wg GT
function etykietyKartyProduktu(produkt) {
  return {
    podetykieta: formatStanyGt(produkt.stany_gt),
    podetykieta2: formatLokalizacjaGt(produkt.lokalizacja_gt),
  };
}

// odmiana slowa "artykul" wg liczby, np. "1 artykuł", "3 artykuły", "5 artykułów"
function liczbaArtykulow(n) {
  if (n === 1) return `${n} artykuł`;
  const ostatniaCyfra = n % 10;
  const ostatnieDwieCyfry = n % 100;
  if (ostatniaCyfra >= 2 && ostatniaCyfra <= 4 && (ostatnieDwieCyfry < 12 || ostatnieDwieCyfry > 14)) {
    return `${n} artykuły`;
  }
  return `${n} artykułów`;
}

// suma ilosci z magazynow WIDOCZNYCH NA ZEBRZE - z BRK (widoczny, tylko poza suma "Razem"),
// bez K4R (ukryty). Do filtra "Ukryj produkty bez stanu" i do sprawdzenia "czy jest co robic".
//
// Liczy WIECEJ niz sumaRazemGt (bo bierze BRK) i MNIEJ niz caly stan_gt (bo pomija ukryte) -
// to trzecie pytanie: "czy z tym towarem da sie cokolwiek zrobic Z ZEBRY". Musi zgadzac sie
// z tym, co pokazuje formatStanyGt: gdyby liczylo takze ukryte magazyny, filtr "Ukryj produkty
// bez stanu" wpuscilby produkt lezacy tylko na Reklamacjach, a karta powiedzialaby mu zaraz
// "brak stanu w GT".
function sumaStanowGt(stanyGt) {
  return Object.entries(stanyGt || {})
    .reduce((suma, [kod, w]) => suma + (widocznyNaZebrze(kod) ? (w.ilosc || 0) : 0), 0);
}

// dla pierwszej lokalizacji produktu w WMS (brak lokalizacji zrodlowej) - zgaduje
// magazyn (K4/K4G) na podstawie stanu GT, do dialogu tworzenia nowej lokalizacji
function magazynDlaNowejLokalizacji(stanyGt) {
  const stany = stanyGt || {};
  if ((stany.K4?.ilosc ?? 0) > 0) return 'K4';
  if ((stany.K4G?.ilosc ?? 0) > 0) return 'K4G';
  return 'K4';
}

// wysyla ruch (MM/LOK) pod url, blokujac #btn-zatwierdz na czas zapytania;
// zwraca {ok, dane} - dane to JSON odpowiedzi (sukces) albo {blad: '...'} (blad sieci)
async function wyslijRuch(url, body) {
  const btn = document.getElementById('btn-zatwierdz');
  btn.disabled = true;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const dane = await res.json();
    return { ok: res.ok, dane };
  } catch (err) {
    return { ok: false, dane: { blad: 'Blad polaczenia z serwerem' } };
  } finally {
    btn.disabled = false;
  }
}

// renderuje liste produktow (np. wynik wyszukiwania po nazwie) do kontenera -
// karta produktu (symbol/nazwa, stany GT, lokalizacja wg GT) na klikalnym przycisku.
// Jesli checkboxUkryjZero jest zaznaczony, pomija produkty bez stanu w zadnym magazynie GT.
function renderujListeProduktow(kontener, produkty, checkboxUkryjZero, onWybierz) {
  kontener.innerHTML = '';

  const widoczne = checkboxUkryjZero && checkboxUkryjZero.checked
    ? produkty.filter((p) => sumaStanowGt(p.stany_gt) > 0)
    : produkty;

  if (widoczne.length === 0) {
    kontener.innerHTML = '<p class="hint">Brak produktów ze stanem w GT.</p>';
    return;
  }

  widoczne.forEach((produkt) => {
    const symbol = produkt.symbol ?? produkt.artykul_symbol;
    const nazwa = produkt.nazwa ?? produkt.artykul_nazwa;
    const { podetykieta, podetykieta2 } = etykietyKartyProduktu(produkt);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.innerHTML = `<span class="etykieta-glowna">`
      + `<span class="nazwa-produktu">${symbol} — ${nazwa} ${statusZgodnosciBadge(produkt)}</span>`
      + `<span class="stany-magazynowe">${podetykieta}</span>`
      + (podetykieta2 ? `<span class="stany-magazynowe">${podetykieta2}</span>` : '')
      + `</span>`;
    btn.addEventListener('click', () => onWybierz(produkt));
    kontener.appendChild(btn);
  });
}
