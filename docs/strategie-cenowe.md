# Strategie cenowe per produkt

**Wersja pierwsza wdrożona 2026-10-19** (ekran Ceny → „Strategie”; sekcja „Wdrożenie v1” niżej). Ustalenia z
rozmowy 2026-10-18 oznaczone **[decyzja]**, decyzje z 2026-10-19 — **[decyzja 19.10]**. Repricer (`pricing/`,
ekran Ceny) dostaje strategie ustawiane dla całego towaru naraz, ponad rynkami.

## Skąd to się wzięło

Dziś każda oferta (SKU × kanał) liczy się osobno: minimum = cena przy marży 20% z kalkulatora
(`config/rynki.js` przez `pricing/pas.js`), maksimum = minimum × 1,5, a w tym pasie reguły z
`pricing/model.js` (zejście do Buy Boxa schodkami −5%, podwyżka pod konkurenta +10%, cofnięcie po utracie
BB + 24 h blokady, pauza wojny o grosze, „szukanie” +3% na eMAG). Ręczne granice min/max per oferta są od
2026-10-16 (`pricing/granice.js`), ręczna cena wyłącza automat oferty.

Nie da się powiedzieć „ten towar wyprzedaj” ani „ten towar sprzedawaj z marżą 10%” raz dla wszystkich
rynków. A zysk na sztuce tego samego towaru bardzo się rozjeżdża między rynkami. Pomiar 2026-10-18 na
produkcji: 370 towarów z automatem, z czego 178 na 2+ kanałach ze znanym zyskiem. Różnica zysku/szt
między najlepszym a najgorszym kanałem tego samego towaru wynosi: mediana 11 zł, p75 20 zł, p90 35 zł.

## Model

**Biblioteka nazwanych strategii [decyzja].** Strategia to szablon z nazwą, typem i parametrami. Towarowi
(`tw_Id`) przypisujemy szablon, pojedynczo albo hurtem. Zmiana szablonu działa od razu na wszystkie
przypisane towary.

- **„All marża 20” = dzisiejszy automat [decyzja]** — strategia domyślna każdego towaru bez przypisania.
  Po wdrożeniu nic się więc nie zmienia, dopóki ktoś nie przypisze innej strategii.
- Strategia działa na każdej ofercie towaru z **włączonym automatem**. Na pozostałych liczy się tak jak
  dziś: jako podpowiedź (decyzja w logu, bez wysyłki).
- **Strategia nie wyznacza ceny sama.** Zmienia tylko wejście do dzisiejszego modelu: podłogę (min),
  sufit (max) i ewentualnie parametry reguł. Buy Box, schodki, cofnięcie, wojna o grosze i „szukanie”
  działają dalej, bez zmian. *(Pierwotnie: „All marża 10” obniża minimum, a maksimum zostaje z „All marża 20”;
  od 19.10 maksimum = minimum × mnożnik strategii.)*
- **Parametry w % albo w zł zysku na sztuce**, nigdy w walucie jednego rynku. Na cenę per rynek
  przelicza kalkulator: wysyłka (DHL, eMAG, Empik wg gabarytu), prowizja, VAT, kurs, docinanie kartonu.
  Kalkulator już to umie: `g.marza` dla marży, `tryb:'zysk'` + `celZysk` dla zysku
  (tak liczy się ręczna kotwica w Cenniku, `policzZRecznaCena`).
- **Pierwszeństwo [decyzja 18.10, zmieniona 19.10 — teraz ręczne granice oferty wygrywają, patrz „Wdrożenie v1”]:** przypisana strategia wygrywa z ręcznymi granicami oferty. Kolejność:
  kalkulator → ręczne granice oferty → strategia przypisana. Przy strategii domyślnej („All marża 20”)
  ręczne granice działają jak dziś. *Niepotwierdzone — user chce to przemyśleć, patrz „Otwarte” pkt 1
  (strategia zmodyfikowana zamiast osobnej warstwy).* Ręczne granice zostają zapisane, więc wracają po
  zdjęciu strategii. Ręczna cena wyłącza automat oferty jak dziś, więc strategia na tej ofercie stoi.
- **Podłoga podniesiona przez strategię działa od razu [decyzja]**, tak jak reguła 7 dziś (cena pod
  minimum idzie na minimum w jednym przebiegu, bez schodków). Dotyczy też końca wyprzedaży: cena wraca na
  normalne minimum w jednym kroku.
- **Maksimum** *(zastąpione 19.10: max = min × mnożnik strategii — „Wdrożenie v1”)*. Pierwotnie: domyślnie maksimum z „All marża 20” (min 20% × 1,5). Gdy podłoga strategii wychodzi
  ponad nie, maksimum = podłoga × 1,5 — ta sama zasada co przy ręcznym minimum (`zGranicami`), żeby pas
  nie był „do góry nogami”.

## Strategie (wersja pierwsza)

### All marża X  („sprzedawaj zawsze najtaniej, w marży X”)

- **Co robi:** podłoga = cena przy marży X% (zamiast 20%) na każdym rynku. Reszta jak dziś.
- **Parametry:** `marza` (%). Opcjonalnie `minzysk` (zł) — kalkulator ma dziś stały próg minimalnego
  zysku 5 zł/szt. Bez zdjęcia tego progu „marża 5%” na tanim towarze i tak nie zejdzie niżej niż 5 zł
  zysku.
- **Dane:** kalkulator. **Mamy dziś:** tak.

### Za rynkiem ze sprzedażą  („wyrównaj do rynku, na którym przy tej cenie się sprzedaje”)

- **Co robi:** szuka rynku referencyjnego, czyli takiego, który udowodnił, że przy danej cenie towar się
  sprzedaje. Zysk zł/szt z tej sprzedaży staje się **PODŁOGĄ** na wszystkich rynkach z automatem
  **[decyzja]**: nigdzie nie sprzedajemy z mniejszym zyskiem niż tam.
  - Strategia tylko **podnosi** podłogę: na każdym rynku obowiązuje wyższa z dwóch wartości — podłoga
    bazowa (marża 20%) albo cena dająca zysk referencyjny.
- **Rynek referencyjny (domyślne; user bez preferencji):** rynek z najwyższym zyskiem/szt wśród rynków,
  które sprzedały **≥ 3 szt. w ostatnich 30 dniach**.
  - Zysk liczony z **mediany** cen sprzedaży z FS. Nie z ceny maksymalnej, bo podłoga działałaby jak
    zapadka: jedna sprzedaż po podwyżce „szukania” (+3% na eMAG) podnosiłaby podłogę na 30 dni.
  - Referencją może być kanał bez automatu (np. Allegro): liczą się jego sprzedaże, a podłoga obowiązuje
    na kanałach z automatem.
  - Gdy żaden rynek nie spełnia progu, obowiązuje podłoga bazowa. Strategia przypięta zostaje i sama
    wraca, gdy pojawi się sprzedaż.
- **Parametry:** `marza` bazowa (20), `dni` (30), `minSzt` (3), `cena` ('mediana').
- **Skutek, który user przyjął:** na rynkach, gdzie Buy Box stoi pod tą podłogą, stoimy na podłodze bez
  BB (`pod_podloga`). Na FR Buy Box jest średnio 37,5% pod naszym dzisiejszym minimum — tam strategia nic
  nie da, tylko utrzyma cenę. Przykład HWHJBD90: Empik 8 szt. przy zysku ~78 zł staje się referencją, a
  podłoga na Allegro (37 szt. przy ~61 zł) idzie w górę o ~24 zł.
- **Dane:** FS z rynkiem i ceną (niżej). **Mamy dziś:** tak — dla kanałów BaseLinkera od dawna, dla Amazon
  DE/FR i Kauflandu od 26.08.2026 (rynek FS „marketplace” z kategorii dokumentu, od 2026-10-20), Amazon IT od
  14.10.
- Amazon PL nie ma kalkulatora (`brak_pasa`), więc nie może być ani referencją, ani odbiorcą podłogi,
  dopóki nie dostanie rynku w `config/rynki.js`.

### Wyprzedaż

- **Co robi (domyślne; user bez preferencji):** podłoga = cena przy **zysku 0 zł/szt** (zakup + nasza
  wysyłka + prowizja + obsługa), próg `minzysk` zdjęty. Reguły BB jak dziś, czyli automat schodzi do
  Buy Boxa aż do tej podłogi.
- **Koniec:** data końca jest **obowiązkowa** (przy przypisaniu, nie w szablonie — każdy towar może mieć
  inną). Wcześniejszy koniec, gdy stan GT towaru spadnie do N (domyślnie 0). Po końcu towar wraca na
  strategię domyślną, a cena na normalne minimum od razu.
- **Strata:** podłoga pod kosztem tylko w osobnym szablonie (`zysk` < 0) i z potwierdzeniem przy
  przypisaniu. Ten sam mechanizm ostrzeżeń, co przy ręcznych granicach (`ocenGranice`).
- **Dane:** kalkulator + stan GT (`pobierzStanyGt`). **Mamy dziś:** tak.

### Na później [decyzja: „ustalimy”]

Kandydaci do biblioteki, nieuzgodnieni:
- **Ochrona niskiego stanu** — stan GT ≤ N → wyższa podłoga, bez obniżek.
- **Rotacja** — brak sprzedaży X dni → podłoga schodkami w dół, po sprzedaży wraca.
- **Trzymaj cenę** — tylko podłoga i podwyżki: nowość, towar bez konkurencji, cena producenta.
- **Najtaniej agresywnie** — bez pauzy wojny i bez stania przy remisie z FBA.

## Dane o sprzedaży per rynek

Sprawdzone 2026-10-18 na OKITRADE, tylko odczyt.

- **Źródło: FS z K4** (`dok_Typ=2`, `dok_Status=1`, `dok_MagId=4`). Rynek = pole „Źródło zamówienia”
  (`pw_Dane`, `pwd_TypObiektu=-2`, `pwd_Tekst04`), tłumaczone na kanał przez `kolumnaZrodla`
  (`pricing/pulpit-model.js`, to samo co pulpit). Cena = `ob_CenaWaluta` pozycji, czyli cena brutto
  towaru w walucie rynku. Wysyłka jest osobną pozycją `TRANSPORT`, więc liczymy tylko `tw_Rodzaj` 1 i 8.
  Kalkulator dokłada wysyłkę klienta sam (`wycenaPrzyCenie`).
- **Dziury:**
  - **Amazon DE/FR/IT/ES/NL i Kaufland DE: „Źródło” z rynkiem dopiero od 2026-10-14 12:22.** Wcześniej
    Sellasist pisał „marketplace” dla każdego rynku. **Rozwiązane 2026-10-20 bez poprawiania GT:** rynek takiej
    FS siedzi w kategorii dokumentu (`dok_KatId` → `sl_Kategoria`: `Amazon_DE`, `Amazon_FR`, `Kaufland`) —
    od 26.08 ma ją każda FS Sellasist, a po 14.10 zgadza się ze „Źródłem” w 100%. `kolumnaZrodla`
    (`pricing/pulpit-model.js`) bierze ją dla „marketplace”. Efekt w oknie 30 dni (21.09–20.10): Amazon DE
    254 → 1338 szt., FR 37 → 174, Kaufland DE 27 → 98, w „marketplace” zostały 2 szt. (Amazon IT przed 14.10
    ma kategorię „Sprzedaż”). Pary towar × kanał z automatem z ≥3 szt. w 30 dni: 34 → 80 (towary z rynkiem
    referencyjnym 33 → 68). Okno nie czeka już do 13.11.
  - **FS powstają tylko w dni robocze**, więc opóźnienie do 3 dni (po weekendzie poniedziałek nadrabia:
    936 FS 12.10). ZK są na bieżąco (`pwd_TypObiektu=-8`, `Tekst01`), ale eMAG ma tam puste „Źródło”,
    Amazon PL pisze „Amazon.de”, a ZK to zamówienie, nie sprzedaż. Dla podłogi lepsze FS: pewniejsze,
    opóźnienie nie szkodzi przy oknie 30 dni.
  - **Allegro CZ/SK/HU** (FS w CZK/HUF/EUR ze „Źródłem” Allegro): ceny przelicza Allegro z ceny PL
    regułami kursowymi, więc nie są osobnymi rynkami referencyjnymi. Na razie pomijane.
  - **Sprzedaży jest mało.** Z 178 towarów z automatem na 2+ kanałach tylko 49 sprzedało w 30 dni na 2+
    rozpoznanych kanałach, zwykle po 1–3 szt. na kanał. Wolumen robi Allegro.
- ~~Do sprawdzenia: raport zamówień Amazona (SP-API) dla historii sprzed 14.10~~ — niepotrzebne, rynek jest
  w kategorii dokumentu (wyżej). Historia sprzed 26.08 (kategoria „Sprzedaż”) jest odtwarzalna z kraju płatnika
  — zob. `docs/analiza-sprzedazy.md`; strategii to nie dotyczy, bo okno ma 30 dni.

## Pułapki i zabezpieczenia

- **Zapadka podłogi:** referencja z mediany cen sprzedaży i okno 30 dni, które samo wygasa. Nasza
  bieżąca cena nie jest nigdy referencją — tylko cena, po której się sprzedało.
- **Przeciąganie między rynkami:** podłoga tylko w górę i tylko ze zrealizowanych sprzedaży. Zmiana
  ceny jednego rynku nie przesuwa podłogi innego, dopóki nie przyjdzie sprzedaż po tej cenie.
- **Rynki bez danych:** brak sprzedaży = podłoga bazowa. Rynek bez kalkulatora (Amazon PL) = strategia
  nie działa (`brak_pasa` jak dziś). Ekran mówi to wprost.
- **Sprzedaż ze stratą:** tylko szablon wyprzedaży z `zysk` < 0, z potwierdzeniem i datą końca.
  Wyprzedaż bez daty nie istnieje.
- **Waluty:** zysk w zł liczony ostrożnymi kursami kalkulatora (EUR 4,20, RON 0,79, HUF 0,0115) —
  tymi samymi dla rynku referencyjnego i docelowego, więc porównanie jest spójne.
- **Zestawy:** strategia wisi na `tw_Id` oferty. Zestaw to osobny towar (koszt = suma składników), a
  wyprzedaż składnika nie obejmuje zestawów z nim. Stan „do wyczerpania” zestawu = stan kompletu w GT.
- **Allegro:** kanał tylko do odczytu (`tylkoOdczyt`) — strategia pokaże tam podpowiedź, ale niczego
  nie wyśle, dopóki automat Allegro nie zostanie dopuszczony.

## Wdrożenie v1 (2026-10-19)

Decyzje usera 19.10 do pytań z tego dokumentu:
- **Wdrożenie kontrolowane [decyzja 19.10]:** nowa strategia startuje jako **podgląd** — liczy nowe min/max i
  pokazuje różnicę (zakładka Strategie, karta SKU), ale automat dalej używa dzisiejszych granic. Ceny zmienia
  dopiero przełącznik **„Aktywuj”** (per strategia, z potwierdzeniem w oknie i w backendzie). Działa tylko na
  towarach z przypisaniem; reszta = „All marża 20”, czyli dziś. Domyślnej nie da się edytować.
- **W pierwszej wersji wszystkie trzy [decyzja 19.10]:** All marża X, Wyprzedaż, Za rynkiem ze sprzedażą.
- **Zakres granic [decyzja 19.10]:** min = cena z kalkulatora przy parametrach strategii (marża % albo zysk zł),
  **max = min × mnożnik** (parametr, domyślnie × 1,5). Uwaga: niższa podłoga z mnożnikiem × 1,5 obniża też
  sufit — oferta z BB ponad nowym max nie jest obniżana (`model.js`: max ogranicza tylko podwyżki), ale już nie
  podniesie. Podgląd pokazuje to jako „stoi nad nowym max”; większe pole do podwyżek = większy mnożnik.
- **Pierwszeństwo [decyzja 19.10] — zamyka „Otwarte” pkt 1:** ręczne granice oferty wygrywają ze strategią
  (najbardziej szczegółowe wygrywa): kalkulator → strategia towaru → ręczne granice oferty. Na ekranie to
  odstępstwo od strategii („strategia zmodyfikowana na tej ofercie”), nie osobna warstwa.

Kod:
- `pricing/strategie.js` — czysta logika: typy i parametry (z zakresami), walidacja, ostrzeżenia (strata, marża
  < 10%), nadpisania kalkulatora, mediana ważona sztukami, rynek referencyjny, koniec przypisania, skutek do
  podglądu. Testy `test/pricing-strategie.test.js` (w tym pas strategii z prawdziwym `config/rynki.js`).
- `pricing/pas.js` — `pasyZWyceny(w, { strategia })`: pas strategii liczony tym samym kalkulatorem (te same koszty,
  prowizja, Genius), z polami `zrodlo: 'strategia'`, `bazowy`, `referencja`; `opcjeZOfert` = Genius i prowizja ze
  wszystkich ofert towaru (jak w workerze — „za rynkiem” porównuje kanały).
- `pricing/granice.js` — `zGranicami` przenosi źródło pasa (`strategia`) i nakłada ręczne granice jako odstępstwo.
- `pricing/strategie-dane.js` + tabele `strategie`, `strategie_towarow` w `pricing.db` — zapis, przypisania
  hurtem (symbol / EAN), sprzedaż z FS (`sprzedazTowarowZCena`, pamięć 3 h, przy awarii GT ostatnia znana),
  stan Razem dla końca wyprzedaży (zestaw = ile da się złożyć).
- `pricing/worker.js` — automat bierze tylko AKTYWNE strategie; przypisania po dacie końca albo wyprzedane
  zdejmuje sam (`zmiany`: `strategia_koniec`, kto `system:strategie`). Powód decyzji kończy się „· strategia „X””.
- `routes/ceny-strategie.js` (`/api/ceny/strategie`, admin + biuro) — walidacja, potwierdzenia (409), podgląd
  skutków per oferta. `routes/ceny.js`: karta SKU, ręczna cena i granice liczą pas z aktywną strategią.
- `public/desktop/ceny-strategie.js` — widok: biblioteka, formularz, przypisanie, tabela „bez strategii / ze
  strategią / co zrobi automat”; karta SKU pokazuje strategię i źródło granic.

Nie w v1 (na później): znaczek strategii w macierzy i filtr „ze strategią”, przypisanie z macierzy hurtem,
strategie z listy „Na później”.

## Pomiar: schodki w dół (−5% na przebieg), 2026-10-19

Pytanie usera: po co trzymamy schodki w dół. Pomiar na `pricing.db` z produkcji (decyzje 13–19.10, 407
epizodów schodków, tylko odczyt):

| Koniec epizodu | Ile | Znaczenie |
|---|---|---|
| doszliśmy do ceny docelowej | 242 (59%) | schodki tylko opóźniły (mediana 1,1 h, 3 kroki; najdłużej ~9–10 h) |
| Buy Box w połowie schodów | 99 (24%) | BB przy cenie średnio 4,5% (mediana) wyżej niż cel startowy |
| konkurent wrócił w górę | 11 (3%) | pierwotny powód („anomalia”); zysk 0,6–9% |
| konkurent zszedł niżej | 13 (3%) | schodki bez znaczenia |

BB w połowie schodów per kanał: Amazon IT 18/23, eMAG BG 13/27, HU 35/94, RO 20/56, Amazon DE 8/65,
Kaufland 3/39, Amazon FR 2/48, Empik 0/17. Czyli na eMAG i IT schodki działają jak szukanie ceny w dół
(tam BB nie zależy tylko od ceny), a na DE/FR/Kaufland/Empik głównie opóźniają. Przed stratą i tak chroni
minimum.

**Decyzja usera: zostawić jak jest**; wrócić przy większej próbce (ES/NL bez epizodów, IT/BG/Empik małe).
Gdyby kiedyś zmieniać, wystarczy `reguly: { maxSpadekPct }` per kolumna w `pricing/kolumny.js`. Dla
strategii (np. „Najtaniej agresywnie”) to naturalny parametr szablonu.

## Otwarte

1. ~~Pierwszeństwo strategii i ręcznych granic~~ — rozstrzygnięte 19.10: ręczne granice oferty wygrywają jako odstępstwo (wyżej). Historycznie: **do przemyślenia (user, 2026-10-18).** Pomysł usera:
   strategia jest „na sztywno”, a ręczna zmiana na towarze/ofercie nie jest osobną warstwą, tylko robi z
   niej **strategię zmodyfikowaną** (wariant szablonu z odstępstwem, widoczny jako taki). Do rozstrzygnięcia
   razem z tym: czy ręczne granice per oferta w ogóle zostają, czy przechodzą w modyfikację strategii.
   Zapis „strategia wygrywa z ręcznymi granicami” w sekcji Model jest przez to tymczasowy.
2. Progi „za rynkiem” (3 szt., 30 dni, mediana) i domyślne N dla końca wyprzedaży — przyjęte domyślnie,
   bez decyzji usera.
3. Dodatkowe strategie („ustalimy”).
4. ~~Historia Amazon EU sprzed 14.10~~ — rozwiązane 2026-10-20 kategorią dokumentu (sekcja „Dziury”).
5. Czy liczyć sprzedaż Allegro CZ/SK/HU jako dowód dla ceny Allegro PL.
