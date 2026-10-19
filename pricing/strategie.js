'use strict';

// Strategie cenowe per towar (zakładka Ceny → „Strategie”) — czysta logika, bez SQLite, GT i API. Testy:
// test/pricing-strategie.test.js. Projekt i decyzje usera: docs/strategie-cenowe.md.
//
// Strategia to nazwany szablon (typ + parametry) przypisywany TOWAROWI (tw_Id), ponad rynkami. Strategia nie
// wyznacza ceny sama — zmienia tylko pas [min, max], na którym działa dzisiejszy model (pricing/model.js):
// Buy Box, schodki, cofnięcie, wojna o grosze i „szukanie” zostają bez zmian.
//   - parametry w % marży i zł zysku na sztuce, nigdy w walucie jednego rynku — cenę per rynek liczy kalkulator
//     (config/rynki.js: wysyłka, prowizja, VAT, kurs, docinanie kartonu);
//   - min = cena z kalkulatora przy parametrach strategii, max = min × mnożnik (decyzja usera 2026-10-19:
//     „min marża %, max × mnożnik”);
//   - wdrożenie kontrolowane (decyzja usera 2026-10-19): nowa strategia startuje jako PODGLĄD — liczy pas i
//     pokazuje różnicę, automat dalej używa dzisiejszych granic; zmienia ceny dopiero po przełączeniu na
//     „aktywna”. Działa tylko na towarach, którym ją przypisano; reszta = domyślna „All marża 20”, czyli dziś;
//   - ręczne granice oferty wygrywają ze strategią (najbardziej szczegółowe wygrywa) i są pokazywane jako
//     odstępstwo („strategia zmodyfikowana na tej ofercie”) — pricing/granice.js zGranicami.

// Typy strategii. Parametr: klucz, nazwa, jednostka, domyślna, zakres [od, do], opis. Domyślna „All marża 20” =
// kalkulator z config/rynki.js DOMYSLNE (marża 20%, minimalny zysk 5 zł) i dzisiejszy mnożnik × 1,5.
const P = {
  marza: (dom = 20) => ({ klucz: 'marza', nazwa: 'Marża minimum', jedn: '%', dom, od: 0, do: 80, opis: 'Podłoga = cena przy tej marży (% od przychodu netto) na każdym rynku' }),
  minzysk: { klucz: 'minzysk', nazwa: 'Minimalny zysk', jedn: 'zł', dom: 5, od: -1000, do: 1000, opis: 'Podłoga nie zejdzie poniżej tego zysku na sztuce (kalkulator: 5 zł); ujemny = sprzedaż ze stratą' },
  mnoznik: { klucz: 'mnoznik', nazwa: 'Maksimum × minimum', jedn: '×', dom: 1.5, od: 1.05, do: 5, opis: 'Sufit podwyżek = minimum × tyle (dziś × 1,5)' },
};
const TYPY = {
  marza: {
    nazwa: 'All marża X', opis: 'Sprzedawaj zawsze najtaniej, ale nie poniżej marży X na żadnym rynku.',
    parametry: [P.marza(20), P.minzysk, P.mnoznik],
  },
  wyprzedaz: {
    nazwa: 'Wyprzedaż', opis: 'Zejdź do Buy Boxa aż do zysku 0 zł na sztuce. Data końca obowiązkowa przy przypisaniu; koniec też, gdy stan GT spadnie do progu.',
    parametry: [
      { klucz: 'zysk', nazwa: 'Zysk na podłodze', jedn: 'zł', dom: 0, od: -1000, do: 1000, opis: 'Podłoga = cena przy tym zysku na sztuce; ujemny = sprzedaż ze stratą (wymaga potwierdzenia)' },
      P.mnoznik,
      { klucz: 'stanKoniec', nazwa: 'Koniec przy stanie', jedn: 'szt.', dom: 0, od: 0, do: 100000, calk: true, opis: 'Wyprzedaż kończy się, gdy stan Razem w GT spadnie do tylu sztuk' },
    ],
    wymagaKonca: true,
  },
  za_rynkiem: {
    nazwa: 'Za rynkiem ze sprzedażą', opis: 'Nigdzie nie sprzedawaj z mniejszym zyskiem niż tam, gdzie towar się sprzedaje: zysk z mediany cen FS najlepszego rynku (≥ N szt. w D dni) staje się podłogą na wszystkich rynkach. Tylko podnosi podłogę.',
    parametry: [
      P.marza(20), P.mnoznik,
      { klucz: 'dni', nazwa: 'Okno sprzedaży', jedn: 'dni', dom: 30, od: 7, do: 90, calk: true, opis: 'Z ilu dni liczymy sprzedaż (FS z K4)' },
      { klucz: 'minSzt', nazwa: 'Dowód sprzedaży', jedn: 'szt.', dom: 3, od: 1, do: 100, calk: true, opis: 'Rynek jest referencją, gdy sprzedał co najmniej tyle sztuk w oknie' },
    ],
  },
};

const zaokr = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const pl = (x, d = 2) => Number(x).toFixed(d).replace('.', ',');
const liczba = (v) => {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(String(v).trim().replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};

// Strategia domyślna = dzisiejszy automat. Nie da się jej edytować ani wyłączyć — zmiana marży wszystkich
// towarów naraz to nie jest kontrolowane wdrożenie.
const DOMYSLNA = { nazwa: 'All marża 20', typ: 'marza', parametry: { marza: 20, minzysk: 5, mnoznik: 1.5 } };

// Zapis szablonu: { nazwa, typ, parametry } → { nazwa, typ, parametry (komplet, liczby) } albo { blad }.
function walidujStrategie({ nazwa, typ, parametry = {} } = {}) {
  const n = String(nazwa ?? '').trim().replace(/\s+/g, ' ');
  if (!n) return { blad: 'podaj nazwę strategii' };
  if (n.length > 60) return { blad: 'nazwa za długa (najwyżej 60 znaków)' };
  const t = TYPY[typ];
  if (!t) return { blad: `nieznany typ strategii: ${typ ?? ''}` };
  const wynik = {};
  for (const p of t.parametry) {
    const v = liczba(parametry[p.klucz]);
    if (Number.isNaN(v)) return { blad: `${p.nazwa}: niepoprawna liczba (${parametry[p.klucz]})` };
    const x = v == null ? p.dom : v;
    if (x < p.od || x > p.do) return { blad: `${p.nazwa}: ${pl(x, p.calk ? 0 : 2)} ${p.jedn} poza zakresem ${p.od}–${p.do}` };
    if (p.calk && !Number.isInteger(x)) return { blad: `${p.nazwa}: podaj liczbę całkowitą` };
    wynik[p.klucz] = p.calk ? x : zaokr(x);
  }
  return { nazwa: n, typ, parametry: wynik };
}

// Ostrzeżenia do potwierdzenia przy zapisie (backend bez `potwierdz` odmawia — zasada 5).
function ostrzezeniaStrategii({ typ, parametry: p }) {
  const o = [];
  const dodaj = (kod, tekst) => o.push({ kod, tekst });
  if (typ === 'wyprzedaz' && p.zysk < 0) dodaj('strata', `podłoga ze stratą ${pl(-p.zysk)} zł na sztuce — automat może sprzedawać pod kosztem`);
  if (typ === 'marza' && p.minzysk < 0) dodaj('strata', `minimalny zysk ${pl(p.minzysk)} zł — przy niskiej marży automat może sprzedawać pod kosztem`);
  if ((typ === 'marza' || typ === 'za_rynkiem') && p.marza < 10) dodaj('marza', `marża minimum ${pl(p.marza, 1)}% — dużo niżej niż dzisiejsze 20%`);
  return o;
}

// Opis do listy i logu, np. „marża 10% · max × 1,5” albo „zysk 0 zł · do stanu 0 szt. · max × 1,5”.
function opisParametrow({ typ, parametry: p }) {
  if (typ === 'marza') return `marża ${pl(p.marza, p.marza % 1 ? 1 : 0)}%${p.minzysk !== 5 ? ` · min. zysk ${pl(p.minzysk)} zł` : ''} · max × ${pl(p.mnoznik)}`;
  if (typ === 'wyprzedaz') return `zysk ${pl(p.zysk)} zł · koniec przy stanie ${p.stanKoniec} szt. · max × ${pl(p.mnoznik)}`;
  if (typ === 'za_rynkiem') return `zysk najlepszego rynku (≥ ${p.minSzt} szt. / ${p.dni} dni), nie mniej niż marża ${pl(p.marza, 0)}% · max × ${pl(p.mnoznik)}`;
  return '';
}

// Nadpisania kalkulatora (`g` z config/rynki.js), z których powstaje podłoga — min = najwyższa z nich.
// ref — referencja „za rynkiem” ({ zysk }) albo null (brak dowodu sprzedaży = sama podłoga bazowa).
function nadpisaniaKalkulatora({ typ, parametry: p }, ref = null) {
  if (typ === 'marza') return [{ tryb: 'marza', marza: p.marza, minzysk: p.minzysk }];
  // Zysk 0 (albo ujemny) — próg minimalnego zysku kalkulatora (5 zł) musi zejść razem z podłogą.
  if (typ === 'wyprzedaz') return [{ tryb: 'zysk', celZysk: p.zysk, minzysk: p.zysk }];
  if (typ === 'za_rynkiem') {
    const n = [{ tryb: 'marza', marza: p.marza }];
    if (ref && Number.isFinite(ref.zysk)) n.push({ tryb: 'zysk', celZysk: ref.zysk });
    return n;
  }
  return [];
}

// Mediana ceny sprzedaży ważona sztukami. pozycje: [{ cena, szt }].
function mediana(pozycje) {
  const p = pozycje.filter((x) => x.cena > 0 && x.szt > 0).sort((a, b) => a.cena - b.cena);
  const suma = p.reduce((a, x) => a + x.szt, 0);
  if (!suma) return null;
  let narast = 0;
  for (let i = 0; i < p.length; i++) {
    narast += p[i].szt;
    if (narast * 2 > suma) return p[i].cena;
    if (narast * 2 === suma) return zaokr((p[i].cena + p[i + 1].cena) / 2);
  }
  return p[p.length - 1].cena;
}

// Rynek referencyjny „za rynkiem”: najwyższy zysk/szt. wśród kanałów, które sprzedały ≥ minSzt w oknie.
// sprzedaz: { KOLUMNA: { pozycje: [{ cena, szt }] } }; ocen: KOLUMNA → (cena) → { zysk } | null (kalkulator
// tego kanału — ten sam, co liczy podłogę). Zysk z MEDIANY cen, nie z maksimum: inaczej jedna sprzedaż po
// podwyżce „szukania” (+3% na eMAG) podnosiłaby podłogę na całe okno (zapadka). Kanał bez kalkulatora (Amazon
// PL) nie może być referencją. Zwraca { kolumna, zysk, mediana, szt } albo null.
function referencjaRynku(sprzedaz = {}, ocen, { minSzt = 3 } = {}) {
  let naj = null;
  for (const [kolumna, s] of Object.entries(sprzedaz)) {
    const szt = (s.pozycje || []).reduce((a, x) => a + (x.szt || 0), 0);
    if (szt < minSzt) continue;
    const med = mediana(s.pozycje || []);
    const oc = med != null ? ocen(kolumna, med) : null;
    if (!oc || !Number.isFinite(oc.zysk)) continue;
    if (!naj || oc.zysk > naj.zysk) naj = { kolumna, zysk: zaokr(oc.zysk), mediana: med, szt };
  }
  return naj;
}

// Czy przypisanie jeszcze działa. przypisanie: { do (YYYY-MM-DD, włącznie) }; strategia: szablon;
// stanRazem: stan GT towaru (null = nie wiemy — wtedy nie kończymy po stanie). teraz → dzień lokalny.
function koniecPrzypisania(przypisanie, strategia, { dzis, stanRazem = null } = {}) {
  if (przypisanie?.do && dzis > przypisanie.do) return { koniec: true, powod: `minęła data końca ${przypisanie.do}` };
  if (strategia?.typ === 'wyprzedaz' && stanRazem != null && stanRazem <= (strategia.parametry?.stanKoniec ?? 0)) {
    return { koniec: true, powod: `stan GT ${stanRazem} szt. — wyprzedane (próg ${strategia.parametry?.stanKoniec ?? 0})` };
  }
  return { koniec: false };
}

// Data końca przy przypisaniu: wymagana dla wyprzedaży, nie w przeszłości. → { do } albo { blad }.
function walidujKoniec(doWe, strategia, dzis) {
  const d = String(doWe ?? '').trim();
  if (!d) return TYPY[strategia.typ]?.wymagaKonca ? { blad: 'wyprzedaż wymaga daty końca' } : { do: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(new Date(`${d}T00:00:00Z`).getTime())) return { blad: `niepoprawna data końca: ${d}` };
  if (d < dzis) return { blad: `data końca ${d} już minęła` };
  return { do: d };
}

// Co zrobi automat od razu po aktywacji strategii na tej ofercie — tekst do podglądu (reguły model.js).
// o: { auto, cena, wysylka, bb_nasz, bb_cena (landed) }; przed / po: pasy { min, max } (null = brak pasa).
function skutek(o, przed, po) {
  if (!po?.min) return { kod: 'brak_pasa', tekst: 'brak pasa — automat nie decyduje' };
  const cena = o.cena;
  if (!(cena > 0)) return { kod: 'brak_ceny', tekst: 'brak naszej ceny' };
  const bez = !o.auto ? ' (oferta bez automatu — tylko podpowiedź)' : '';
  const rowne = (a, b) => a != null && b != null && Math.abs(a - b) < 0.005;
  if (przed && rowne(po.min, przed.min) && rowne(po.max, przed.max)) return { kod: 'bez_zmian', tekst: `strategia nie zmienia granic tej oferty${bez}` };
  if (cena < po.min - 0.005) {
    const juz = przed?.min && cena < przed.min - 0.005 ? ' (cena już dziś pod minimum)' : '';
    return { kod: 'w_gore', tekst: `podniesie od razu do ${pl(po.min)}${juz}${bez}` };
  }
  const bb = o.bb_cena > 0 ? zaokr(o.bb_cena - (o.wysylka || 0)) : null;
  if (o.bb_nasz === 0 && bb != null && przed?.min && bb < przed.min - 0.005 && po.min < przed.min - 0.005 && cena > po.min + 0.005) {
    return { kod: 'w_dol', tekst: `może zejść do Buy Boxa ${pl(bb)}, nie niżej niż ${pl(po.min)}${bez}` };
  }
  if (o.bb_nasz === 1 && przed?.max && po.max > przed.max + 0.005) return { kod: 'miejsce', tekst: `więcej miejsca na podwyżki: max ${pl(po.max)}${bez}` };
  if (o.bb_nasz === 1 && przed?.max && po.max < przed.max - 0.005 && po.max < cena) return { kod: 'sufit', tekst: `stoi nad nowym max ${pl(po.max)} — automat jej nie obniży, ale już nie podniesie${bez}` };
  return { kod: 'bez_zmian', tekst: `od razu bez zmian${bez}` };
}

module.exports = {
  TYPY, DOMYSLNA, walidujStrategie, ostrzezeniaStrategii, opisParametrow, nadpisaniaKalkulatora, mediana,
  referencjaRynku, koniecPrzypisania, walidujKoniec, skutek, pl,
};
