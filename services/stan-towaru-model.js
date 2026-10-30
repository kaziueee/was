'use strict';

// Sprzedaż → Stan (desktop, tylko admin): każdy towar ze stanem w jednym kubełku — leżaki, nadmiar, wolna rotacja,
// OK, kończy się, brak. Czysta logika (testy test/stan-towaru-model.test.js, bez SQLite i GT); dane składa
// services/analiza-stan.js w wątku analiz.
//
// Decyzje usera 2026-10-30 (progi dobrane z rozkładu na produkcji 30.10: 2 635 SKU internetowych za 7,7 mln zł,
// z czego 5,4 mln to zapas > 365 dni):
//   - zakres = WSZYSTKO RAZEM: stan K4+K4G+MAG+LS (bez BRK, jak MAGAZYNY_RAZEM), sprzedaż = FS + paragony Sklepu.
//     Sklep (MAG) sprzedaje paragonami — bez nich cały MAG wyglądałby jak leżaki,
//   - leżak = 0 szt. w 180 dni (albo nigdy, odkąd moduł ma historię — od 10.2024),
//   - zapas w dniach = dostępne ÷ tempo; < 30 kończy się, 30–180 OK, 180–365 wolna rotacja, > 365 nadmiar,
//   - nowości (pierwsza dostawa < 60 dni) osobno — za wcześnie na ocenę, tempo jeszcze nic nie mówi.
//
// Tempo = SZYBSZE z 90 dni i roku. Sam rok zaniża tempo towarów sezonowych przed sezonem, a same 90 dni — towarów,
// które w tym kwartale akurat się nie sprzedawały. Okno skracamy do wieku towaru (od pierwszej dostawy): towar
// sprzedawany od 4 miesięcy z 120 szt. ma tempo 1 szt./dzień, nie 120/365.

const DZIEN_MS = 864e5;
const PROGI = { nowoscDni: 60, lezakDni: 180, konczyDni: 30, okDni: 180, nadmiarDni: 365 };

// Kolejność = kolejność kafli na ekranie: od tego, co wymaga ruchu (brak, kończy się), do zamrożonego kapitału.
const KUBELKI = [
  { k: 'brak', nazwa: 'Brak', opis: 'nic do sprzedania (dostępne 0), a sprzedaż w 30 dni' },
  { k: 'konczy', nazwa: 'Kończy się', opis: `zapas < ${PROGI.konczyDni} dni` },
  { k: 'ok', nazwa: 'OK', opis: `zapas ${PROGI.konczyDni}–${PROGI.okDni} dni` },
  { k: 'wolna', nazwa: 'Wolna rotacja', opis: `zapas ${PROGI.okDni}–${PROGI.nadmiarDni} dni` },
  { k: 'nadmiar', nazwa: 'Nadmiar', opis: `zapas > ${PROGI.nadmiarDni} dni — sprzedaje się, ale za wolno do stanu` },
  { k: 'lezak', nazwa: 'Leżaki', opis: `0 szt. w ${PROGI.lezakDni} dni` },
  { k: 'nowosc', nazwa: 'Nowości', opis: `pierwsza dostawa < ${PROGI.nowoscDni} dni — za wcześnie na ocenę` },
];

const dniMiedzy = (od, doDnia) => Math.round((Date.parse(doDnia) - Date.parse(od)) / DZIEN_MS);

// Sztuk dziennie. wiek = dni od pierwszej dostawy (null = nieznany → pełne okna).
function tempoDzienne({ szt90 = 0, szt365 = 0, wiek = null }) {
  const okno = (n) => Math.max(1, wiek == null ? n : Math.min(n, wiek));
  return Math.max(szt90 / okno(90), szt365 / okno(365));
}

// dostepne — Razem − rezerwacje; razem — K4+K4G+MAG+LS; ostatnia — dzień ostatniej sprzedaży (null = brak w historii).
// Wynik: { kub, tempo (szt./dzień), dni (zapas) } albo null, gdy towar nie należy do analizy (nic na stanie i brak
// sprzedaży w 30 dni — albo cały stan zarezerwowany bez świeżej sprzedaży: nie ma czego oceniać).
function ocenTowar({ dostepne = 0, razem = 0, szt30 = 0, szt90 = 0, szt365 = 0, ostatnia = null, pierwszePrzyjecie = null, dzis }) {
  const wiek = pierwszePrzyjecie ? dniMiedzy(pierwszePrzyjecie, dzis) : null;
  const tempo = tempoDzienne({ szt90, szt365, wiek });
  if (dostepne <= 0) return szt30 > 0 ? { kub: 'brak', tempo, dni: 0 } : null;
  if (wiek != null && wiek < PROGI.nowoscDni) return { kub: 'nowosc', tempo, dni: tempo > 0 ? Math.round(dostepne / tempo) : null };
  if (!ostatnia || dniMiedzy(ostatnia, dzis) > PROGI.lezakDni) return { kub: 'lezak', tempo, dni: null };
  const dni = tempo > 0 ? Math.round(dostepne / tempo) : null;
  const kub = dni == null || dni > PROGI.nadmiarDni ? 'nadmiar' : dni > PROGI.okDni ? 'wolna' : dni >= PROGI.konczyDni ? 'ok' : 'konczy';
  return { kub, tempo, dni };
}

// Sumy kafli: liczba SKU, sztuki (Razem) i wartość stanu w cenie zakupu, per kubełek i łącznie.
function podsumuj(wiersze) {
  const kub = Object.fromEntries(KUBELKI.map((x) => [x.k, { sku: 0, szt: 0, wart: 0 }]));
  const razem = { sku: 0, szt: 0, wart: 0 };
  for (const w of wiersze) {
    for (const s of [kub[w.kub], razem]) { s.sku++; s.szt += w.razem || 0; s.wart += w.wart || 0; }
  }
  for (const s of [...Object.values(kub), razem]) s.wart = Math.round(s.wart);
  return { kub, razem };
}

module.exports = { PROGI, KUBELKI, tempoDzienne, ocenTowar, podsumuj, dniMiedzy };
