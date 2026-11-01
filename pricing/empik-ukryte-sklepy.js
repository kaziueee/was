'use strict';

// Sklepy Empik, których oferty P11 (`products/offers`) zwraca, a empik.com NIE pokazuje klientom — ani na karcie
// produktu, ani w „Ten produkt u innych sprzedawców”. Repricer i cena rynku na „Do wystawienia” je pomijają,
// inaczej gonimy ceny, których nikt nie widzi (PLA71602: TOYSMARF 238 zł jako „Buy Box”, na stronie najtaniej 248,99).
//
// Skąd lista: przebieg 2026-11-01 po WSZYSTKICH 2797 naszych produktach — posortowana lista sprzedawców ze strony
// (zapytanie `getSortedOffersForProduct`, to samo, z którego korzysta karta produktu) porównana sklep po sklepie z P11.
// Te sklepy są w P11 na 356 produktach, a na stronie nie ma ich NIGDZIE; 31.10 → 01.11 lista się nie zmieniła.
// Widoczność jest cechą sklepu, nie oferty — żaden sklep nie był raz widoczny, raz nie.
//
// Żadne pole P11 ich nie odróżnia (401 ofert ukrytych vs 2685 widocznych): brak ocen, wysyłka ORLEN i strefa POLAND
// są u nich częstsze, ale występują też u widocznych — dlatego lista, nie reguła.
//
// Odświeżanie: strona Empiku jest za ochroną przed botami (z SRV 403), więc listę sprawdza się z przeglądarki,
// tym samym przebiegiem co 2026-11-01. Nowy ukryty sklep = dopisz tu; sklep, który pojawi się na stronie = usuń.
const SPRAWDZONO = '2026-11-01';

const UKRYTE = [
  'Geszeft', 'MegaDyskont  - sklep z zbawkami', 'Hapini', 'Luxe', 'Prime Store', 'Rokicki', 'TerdomToys', 'xshoes',
  'Spinkids', '1001JOUETS', 'KIDASHKA', 'MaxTopShop', 'OLINOO', 'Agromet', 'mstech', 'ToyPlanet', 'ALLFORYOU24',
  'TOYSMARF', 'LC_WROC', 'SL commerce', 'MARKET KLOCKÓW WOJCIECH WRÓŻ', 'Pakami', 'Bobaskowy Świat', 'Rondo Bazar',
  'Eni Multisklep', 'adremjdkl', 'JACK AUDIO MOBILE', 'e-lumo', 'kolejkowy', 'Domsense', 'bricks_mania', 'eOffice Media',
  'Wesoły Szkolak', 'KUBUŚ TOYS', 'toys.and.fun', 'jdoutlet', 'sklepbobas', 'Testowy Empik', 'allYouNeed Store',
  'umniekup', 'Polaris', 'FDIK', 'Pricessio', 'Primks', 'RealizmMagiczny', 'ajsklep',
];

// Nazwy porównujemy bez wielkości liter i ze zwiniętymi spacjami (P11 bywa niekonsekwentne: „MegaDyskont  - …”).
const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
const ZBIOR = new Set(UKRYTE.map(norm));

const ukrytySklep = (nazwa) => ZBIOR.has(norm(nazwa));

module.exports = { SPRAWDZONO, UKRYTE, ukrytySklep };
