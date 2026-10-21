'use strict';

// Raport Allegro Analytics „Czynniki wpływające na wybór Top oferty” (xlsx z Sales Center → Allegro Analytics).
// Jedyne źródło ceny Top oferty od samego Allegro: API jej nie podaje, a /offers/listing jest zamknięte dla
// nowych aplikacji (pricing/allegro.js). Raport pobiera człowiek, gdy chce poszukać szans na Top ofertę,
// i wgrywa go na ekranie Ceny (POST /api/ceny/allegro-top). Automatycznego pobierania z panelu nie robimy —
// to panel, nie API (decyzja 2026-10-19).
//
// Co jest w raporcie (sprawdzone na plikach ekajtek z 19.10.2026): arkusz „Zakres danych” (Rynek, Konto
// Allegro = numer użytkownika, opcjonalnie Kategoria) i „Top oferta”: ID oferty, ID produktu, nazwa, oceny
// czynników (Promowanie, Jakość sprzedaży, Stan produktu, Jakość zdjęć, Gwarancja najniższej ceny, Cena,
// Czas dostawy: „odpowiednia/odpowiedni/odpowiednie” albo „do poprawy”, cena: „za wysoka”) i **Różnica w cenie**
// = o ile nasza cena przewyższa cenę Top oferty (HASF9494: 77,89 − 7,99 = 69,90 = najtańszy konkurent
// w raporcie Niezbędnika). Dane żyją w ciągu dnia (46 zmian różnicy między pobraniem 12:25 a 13:03), więc
// raport traktujemy jako ważny przez PRICING_ALLEGRO_TOP_H godzin (domyślnie 24).
//
// Cenę Top oferty zapisujemy KWOTOWO (nasza cena w chwili importu − różnica): to cena konkurenta, więc
// zostaje prawdziwa także po zmianie naszej ceny. Ocena „odpowiednia” mówi tylko, że to my jesteśmy Top
// ofertą PRZY cenie z chwili raportu — po zmianie naszej ceny przestaje być pewna.

const NAGLOWKI = {
  oferta: 'ID oferty', produkt: 'ID produktu', nazwa: 'Nazwa oferty', promowanie: 'Promowanie', jakosc: 'Jakość sprzedaży',
  stan: 'Stan produktu', zdjecia: 'Jakość zdjęć', gnc: 'Gwarancja najniższej ceny', cena: 'Cena', dostawa: 'Czas dostawy',
  roznica: 'Różnica w cenie',
};
// Czynniki inne niż cena — do pokazania, co jeszcze blokuje Top ofertę (ceną tego nie naprawimy).
const CZYNNIKI = { promowanie: 'promowanie', jakosc: 'jakość sprzedaży', stan: 'stan produktu', zdjecia: 'zdjęcia', gnc: 'GNC', dostawa: 'czas dostawy' };
const DO_POPRAWY = /do poprawy/i;
// Ile godzin raport jest dla repricera prawdziwy (dane żyją w ciągu dnia — patrz wyżej).
const WAZNOSC_H = Number(process.env.PRICING_ALLEGRO_TOP_H) > 0 ? Number(process.env.PRICING_ALLEGRO_TOP_H) : 24;
const czasRaportu = (top) => Date.parse(String(top?.raport_czas).replace(' ', 'T') + 'Z');
const aktualny = (top, teraz = Date.now(), waznoscH = WAZNOSC_H) => teraz - czasRaportu(top) <= waznoscH * 3_600_000;

const liczba = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const zaokr = (x) => Math.round(x * 100) / 100;

// arkusze (services/xlsx-czytnik.czytajXlsx) → { uzytkownik, rynek, kategoria, wiersze } albo wyjątek z opisem.
function raportTopOferty(arkusze) {
  const nazwy = Object.keys(arkusze || {});
  const top = nazwy.map((n) => arkusze[n]).find((w) => (w[0] || []).includes(NAGLOWKI.oferta) && (w[0] || []).includes(NAGLOWKI.roznica));
  if (!top) throw new Error('To nie jest raport „Czynniki wpływające na wybór Top oferty” (brak kolumn „ID oferty” i „Różnica w cenie”)');
  const idx = Object.fromEntries(Object.entries(NAGLOWKI).map(([k, n]) => [k, top[0].indexOf(n)]));
  const brak = Object.entries(idx).filter(([, i]) => i < 0).map(([k]) => NAGLOWKI[k]);
  if (brak.length) throw new Error(`W raporcie brakuje kolumn: ${brak.join(', ')} — Allegro zmieniło format?`);
  const zakres = arkusze['Zakres danych'] || [];
  const pole = (n) => { const i = (zakres[0] || []).indexOf(n); return i >= 0 && zakres[1] ? String(zakres[1][i] ?? '').trim() || null : null; };
  const wiersze = [];
  for (const r of top.slice(1)) {
    const oferta = String(r[idx.oferta] ?? '').trim();
    if (!/^\d+$/.test(oferta)) continue;
    const czynniki = Object.fromEntries(Object.keys(CZYNNIKI).map((k) => [k, r[idx[k]] == null ? null : String(r[idx[k]]).trim()]));
    wiersze.push({ oferta, produkt: r[idx.produkt] ? String(r[idx.produkt]) : null, nazwa: r[idx.nazwa] ? String(r[idx.nazwa]) : null,
      cena_ocena: r[idx.cena] == null ? null : String(r[idx.cena]).trim(), roznica: liczba(r[idx.roznica]), czynniki });
  }
  if (!wiersze.length) throw new Error('Raport nie ma żadnej oferty');
  return { uzytkownik: pole('Konto Allegro'), rynek: pole('Rynek'), kategoria: pole('Kategoria'), wiersze };
}

// Cena Top oferty kwotowo: tylko przy ocenie „za wysoka” z dodatnią różnicą.
const cenaTop = (cenaNasza, w) => (/za wysoka/i.test(w?.cena_ocena || '') && w.roznica > 0 && cenaNasza > 0 ? zaokr(cenaNasza - w.roznica) : null);
const doPoprawy = (czynniki) => Object.entries(czynniki || {}).filter(([, v]) => DO_POPRAWY.test(v || '')).map(([k]) => CZYNNIKI[k] || k);

// Obserwacja oferty z raportu — w kształcie pricing/model.js, jak Buy Box na innych platformach.
//   za wysoka   → Top oferta jest inna, jej cena = cel (bbNasz false, bbCena = cena Top)
//   odpowiednia → Top oferta to my, ale tylko gdy nasza cena się od raportu nie zmieniła; wyżej konkurencji nie
//                 znamy (konkurencjaNiedostepna — model pilnuje tylko minimum, podwyżki da Niezbędnik)
//   cena Top = cena naszej INNEJ oferty tego towaru (drugie konto albo duplikat SKU) → Top ma najpewniej ona;
//                 bbInnaNasza — model nie konkuruje sam ze sobą (pricing/model.js, `bb_nasza_inna`). Raport nie mówi,
//                 kto ma Top ofertę; równa cena co do grosza to nasz najlepszy dowód (decyzja usera 2026-10-19:
//                 „nie bić się z drugim kontem”). Przypadkowy remis z obcym = stoimy zamiast schodzić — bezpieczna strona.
// Raport nieświeży albo bez wiersza dla oferty → null (obserwacja jak bez raportu).
// inne — ceny naszych pozostałych ofert tego samego towaru albo tej samej strony produktu (oba konta).
// naszaTop — inna nasza oferta na tej samej stronie produktu ma w raporcie cenę „odpowiednią”, czyli to ona jest
// Top ofertą (NERE0011 21.10: Top 109,99 = nasz zestaw NERE0011Z6, a cztery inne nasze oferty tego produktu dostawały
// podpowiedź zejścia pod niego). Pewniejsze niż równa cena, bo nie zależy od tego, czy ceny zmieniły się od raportu.
function zRaportu(top, cena, teraz = Date.now(), waznoscH = WAZNOSC_H, inne = [], naszaTop = false) {
  if (!top || !(cena > 0) || !aktualny(top, teraz, waznoscH)) return null;
  if (top.cena_top > 0) {
    const nasza = naszaTop || inne.some((c) => Math.abs(c - top.cena_top) < 0.015);
    return { cena, wysylka: 0, bbNasz: false, bbInnaNasza: nasza, bbCena: top.cena_top, bbFba: false, najtanszaInna: nasza ? null : top.cena_top,
      konkurencjaNiedostepna: false, ofert: null };
  }
  if (/odpowiedni/i.test(top.cena_ocena || '') && Math.abs((top.cena_nasza ?? -1) - cena) < 0.005) {
    return { cena, wysylka: 0, bbNasz: true, bbInnaNasza: false, bbCena: cena, bbFba: false, najtanszaInna: null,
      konkurencjaNiedostepna: true, ofert: null };
  }
  return null;
}

// --- baza (pricing.db, tabela allegro_top z pricing/db.js) ---------------------------------------

// Zapis raportu: każda oferta z raportu dostaje wiersz (konto, numer oferty) — nowszy raport nadpisuje
// starszy, oferty spoza raportu zostają (raport bywa z jednej kategorii). Cena naszej oferty z ostatniej
// synchronizacji (oferty.cena). Zwraca podsumowanie do pokazania na ekranie.
function zapiszRaport(raport, kto) {
  const { db } = require('./db');
  const { KONTA } = require('./allegro');
  const konto = Object.keys(KONTA).find((k) => KONTA[k].id === String(raport.uzytkownik || ''));
  if (!konto) throw new Error(`Raport z konta Allegro nr ${raport.uzytkownik || '?'} — repricer zna tylko ${Object.values(KONTA).map((k) => `${k.login} (${k.id})`).join(', ')}`);
  if (raport.rynek && raport.rynek !== 'allegro-pl') throw new Error(`Raport z rynku ${raport.rynek} — repricer obsługuje allegro-pl`);
  const oferta = db.prepare(`SELECT o.id, o.cena, (SELECT min FROM decyzje WHERE oferta_id = o.id ORDER BY id DESC LIMIT 1) AS min
    FROM oferty o WHERE o.platforma = 'allegro' AND o.rynek = ? AND o.asin = ?`);
  const zapisz = db.prepare(`INSERT INTO allegro_top (konto, oferta, produkt, cena_ocena, roznica, cena_nasza, cena_top, czynniki, raport_czas, kto)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
    ON CONFLICT (konto, oferta) DO UPDATE SET produkt = excluded.produkt, cena_ocena = excluded.cena_ocena, roznica = excluded.roznica,
      cena_nasza = excluded.cena_nasza, cena_top = excluded.cena_top, czynniki = excluded.czynniki, raport_czas = excluded.raport_czas, kto = excluded.kto`);
  const wynik = { konto, kategoria: raport.kategoria, wierszy: raport.wiersze.length, dopasowane: 0, za_wysoka: 0, odpowiednia: 0, szanse: 0, ponizej_min: 0 };
  db.exec('BEGIN');
  try {
    for (const w of raport.wiersze) {
      const o = oferta.get(konto, w.oferta);
      const top = cenaTop(o?.cena, w);
      zapisz.run(konto, w.oferta, w.produkt, w.cena_ocena, w.roznica, o?.cena ?? null, top, JSON.stringify(w.czynniki), kto || null);
      if (!o) continue;
      wynik.dopasowane++;
      if (top != null) {
        wynik.za_wysoka++;
        if (o.min > 0 && top >= o.min - 0.005) wynik.szanse++; else if (o.min > 0) wynik.ponizej_min++;
      } else if (/odpowiedni/i.test(w.cena_ocena || '')) wynik.odpowiednia++;
    }
    db.prepare("INSERT INTO zmiany (kto, oferta_id, akcja, opis) VALUES (?, NULL, 'raport_top_allegro', ?)")
      .run(kto || null, `${konto}: ${wynik.wierszy} ofert, cena za wysoka ${wynik.za_wysoka} (szanse ${wynik.szanse}), odpowiednia ${wynik.odpowiednia}`);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return wynik;
}

// Nasze oferty per produkt katalogu Allegro (ID produktu z raportu): produkt → [{ klucz, cena, top }]. Ten sam produkt
// bywa wystawiony przez nas kilka razy (zestawy, duplikaty SKU, drugie konto) i zwykle jedna z tych ofert ma Top.
// cenaTeraz(klucz) — nasza cena z bieżącej listy Allegro (brak = cena z chwili raportu).
function naszeNaProduktach(raporty, cenaTeraz = () => null, teraz = Date.now(), waznoscH = WAZNOSC_H) {
  const m = new Map();
  for (const [k, w] of raporty) {
    if (!w.produkt || !aktualny(w, teraz, waznoscH)) continue;
    const cena = cenaTeraz(k) ?? w.cena_nasza;
    (m.get(w.produkt) || m.set(w.produkt, []).get(w.produkt)).push({ klucz: k, cena, top: /odpowiedni/i.test(w.cena_ocena || '') });
  }
  return m;
}

// Mapa `${konto}|${numer oferty}` → wiersz raportu (wszystkie; świeżość ocenia zRaportu).
function raportyTop() {
  const { db } = require('./db');
  return new Map(db.prepare('SELECT * FROM allegro_top').all().map((r) => [`${r.konto}|${r.oferta}`, r]));
}

module.exports = { NAGLOWKI, CZYNNIKI, WAZNOSC_H, aktualny, raportTopOferty, cenaTop, doPoprawy, zRaportu, naszeNaProduktach, zapiszRaport, raportyTop };
