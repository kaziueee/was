# WMS dla Subiekt GT — kontekst projektu

Budujesz lekki WMS jako uzupełnienie Subiekt GT. Sellasist obsługuje zbiór i wysyłkę — ten system obsługuje tylko lokalizacje magazynowe, przesunięcia MM i inwentaryzację.

## Stack

- Backend: Node.js + Express
- Baza: SQLite (plik `wms.db` w folderze `db/`)
- Frontend Zebra: PWA — HTML + vanilla JS
- Frontend Desktop: ta sama apka, inny layout
- Skanowanie: DataWedge na Zebrze (wstrzykuje skan do aktywnego `<input>`)
- Integracja GT: most C# (`bridge/GtBridge/`) → Sfera GT (COM) → lokalny REST na `localhost:5000`

## Struktura folderów

```
wms/
├── db/
│   ├── 001_init.sql
│   └── database.js
├── routes/
│   ├── lokalizacje.js
│   ├── ruchy.js
│   ├── magazyny.js
│   ├── produkty.js
│   └── rozjazdy.js
├── services/
│   ├── gt-bridge.js       # HTTP klient do mostu C#
│   ├── gt-fields.js       # kompresja lokalizacji do pól własnych GT
│   └── rozjazdy.js        # job detekcji rozjazdów GT vs WMS
├── public/
│   ├── zebra/
│   │   ├── index.html
│   │   ├── ruch.html         # MM + zmiana lokalizacji (zlane)
│   │   ├── ruch.js
│   │   ├── kreator.js        # wspólne helpery ekranów-kreatorów
│   │   ├── karta-produktu.js
│   │   ├── produkty.html     # test wyszukiwania GT
│   │   └── test-skan.html    # diagnostyka skanera DataWedge
│   └── desktop/
│       ├── index.html
│       └── app.js
├── bridge/
│   └── GtBridge/          # projekt C# .NET
├── app.js
├── package.json
└── CLAUDE.md              # ten plik
```

## Magazyny

| Magazyn GT | Typ | Lokalizacje w WMS |
|---|---|---|
| K4 | Pick floor | TAK — 1 SKU = 1 lokalizacja |
| K4gora | Bulk storage | TAK — 1 SKU = N lokalizacji |
| MAG (Kajtek), LS (Leszno) | Zewnętrzne | NIE — tylko stan w GT |
| BRK (Braki, mag 10) | Zewnętrzny, towar niepełnowartościowy | NIE — tylko stan w GT |

Lista magazynów: `config/magazyny.js`. Wyprowadza dwie **różne** sumy, obie z flag na definicji magazynu — nie z ręcznych list: `MAGAZYNY_RAZEM` = K4+K4G+MAG+LS („ile mam") i `MAGAZYNY_ZAPAS_K4` = K4+K4G+LS („czy towar wróci na regał zbioru", ścieżka „Czyść zera" — MAG odpada). **Stan „Razem" = K4+K4G+MAG+LS, bez BRK** — braki to towar niepełnowartościowy i nie mają zawyżać sumy „ile mam". Sterowane flagą `liczDoRazem: false` na BRK → eksport `MAGAZYNY_RAZEM`, czytany w `services/gt-produkty.js` (wyrażenie SQL `SORT_WYRAZENIA.razem` + helper `sumaRazem` dla trybu Node — muszą zostać spójne). BRK ma własną kolumnę i MM w obie strony, wypada tylko z sumy zbiorczej.

## Pola własne GT (kartoteka towaru)

| Pole | Kolumna w bazie GT | Zawartość | Kto pisze |
|---|---|---|---|
| `Miejsce na magazynie` | `tw__Towar.tw_Pole1` | lokalizacja K4, np. `M2-I35-37` | WMS |
| `Lokalizacja Górna` | `tw__Towar.tw_Pole8` | lokalizacje K4gora skompresowane | WMS |
| `Lokalizacja Zapas` | `pwd_Tekst08` | **nieużywane** — patrz niżej | nikt |
| `Wymiary`, `Waga produktu`, `Waga gabarytowa DHL` | `pwd_Tekst07`, `pwd_Tekst06`, `pwd_Tekst09` | patrz „Parametry produktu" | WMS |
| `Waga gabarytowa karton DHL` | `pw_Dane.pwd_Tekst10` | waga gab. z najmniejszego pasującego kartonu (fallback goły wymiar) | WMS |
| `Stan K4`, `Stan K4Góra` | — | kopie stanów dla multistany | NIE dotykamy |
| `Ilość w op. zbiorczym`, `Baterie` | `pwd_Tekst04`, `pwd_Tekst05` | ręcznie | NIE dotykamy |

**„Lokalizacja Zapas" jest nieużywana (2026-07-19).** Overflow lokalizacji K4G ponad limit `tw_Pole8` zostaje **wyłącznie w WMS** — służy już tylko do oflagowania `ZGODNOSC.OBCIETE` („pole GT za krótkie, żeby pokazać wszystkie wpisy"). Wcześniej kod czytał ten overflow z `pwd_Tekst09` i doklejał go do tekstu lokalizacji K4G. To było podwójnie błędne: pole „Lokalizacja Zapas" siedzi w GT na **`pwd_Tekst08`**, a `pwd_Tekst09` trzyma dziś **„Waga gabarytowa DHL"** — więc do lokalizacji doklejała się waga (`K4G: M2-C6-P2(3); 0,61`). Odczyt usunięty z `gt-fields.js`; werdykty zgodności nigdy na tym nie ucierpiały, bo `zgodneZWms` liczy wyłącznie z `tw_Pole1`/`tw_Pole8`.

**Adnotacja stref w `tw_Pole1` (2026-07-19).** Do adresu K4 dopisywana jest informacja, ile sztuk leży POZA półką: `M2-J14-P2 +StD20 +StZ3` = 20 szt. z dostawy i 3 ze zwrotu czekają w strefie. Skróty: prefiks **`St`** (Strefa) + litera rodzaju — **StP**=przywózka, **StD**=dostawa, **StZ**=zwrot, **StPW**=przyjęcie wewn. Litery te same, co kolumna „Strefa" na desktopie (tam bez prefiksu: P/D/Z/PW), ale w `tw_Pole1` dostają `St`, bo dopisek stoi **inline przy adresie** i samo `+P1` zlewałoby się z poziomem półki (`M2-A7-P1`) — `+StP1` jest jednoznaczne (zmiana 2026-07-20; regex rozpoznaje też stary bezprefiksowy format, żeby dopiski sprzed zmiany dało się zmigrować). Powód: pole „Miejsce na magazynie" to jedyne, co widzi człowiek szukający towaru z poziomu GT (wydruk, wyszukiwanie w Subiekcie); przy pustej półce mówiło tylko adres pustej półki, a strefy istniały wyłącznie w WMS.

- **To DOPISEK, nie część adresu.** Kto czyta `tw_Pole1` jako **kod do rozwiązania** (cel MM w uzupełnieniach, `pierwszyKodZPola` w „Do sprawdzenia", porównanie zgodności) MUSI przepuścić go przez `bezAdnotacjiStref()`. Kto tylko wyświetla — zostawia. Czyste funkcje w `services/adnotacja-stref.js` (osobny plik, żeby dało się je testować bez SQLite i GT), re-eksport z `gt-fields`.
- **Zgodność celowo IGNORUJE adnotację** — dopisuje ją job z danych GT, nie WMS, więc porównywanie jej wywalałoby na `NZ` każde SKU z otwartą dostawą mimo zgodnego adresu.
- **Pisze job** `services/strefy-w-gt-job.js` (co 10 min, `WMS_STREFY_INTERWAL_MIN`), bo strefa zmienia się, gdy w GT pojawi się dokument — czyli wtedy, gdy WMS nic nie robi i nie ma się od czego odpalić. Zapis **tylko przy zmianie** (inaczej setki UPDATE-ów co przebieg).
- **Zakres: KAŻDE SKU, które ma sztuki w strefie (zmiana 2026-07-20).** Wcześniej dopisek szedł tylko na SKU z domem WMS K4 — przez to towary, których adres istnieje wyłącznie w GT (albo wcale), nie dostawały nic, mimo że fizycznie leżały w strefie. Teraz granica bezpieczeństwa to **„SKU ma realny dokument strefowy na K4 (rodzaj 1)"**, a nie „WMS zna jego dom". Towary spoza obiegu K4 (książki, meble — tam `tw_Pole1` znaczy autor/pomieszczenie) **nie mają dokumentów na K4**, więc są odsiane strukturalnie, nie regułą. Adres bazowy: prawda WMS gdy znamy dom, **inaczej to, co jest w GT bez naszego dopisku** — doklejamy do adresu z GT (też „śmieciowego" typu `RB/A18 /`) albo do **pustego pola** (wtedy samo `+StD20`, bez adresu = „20 szt. czeka w strefie dostaw, brak półki").
- **Usuwanie znacznika = skan GT po jego formacie, nie po domu WMS.** Job bierze DRUGĄ listę: SKU noszące nasz dopisek w GT (`tw_Pole1 LIKE '% +%'`, `tw_Rodzaj=1`, potwierdzone `bezAdnotacjiStref` — zob. `pobierzSkuZDopiskiem`). Dzięki temu zdejmie własny znacznik nawet gdy SKU **nie ma domu WMS** i wypadło z kandydatów (dokument zestarzał się za oknem). **Sam format `+SKRÓT<liczba>` jest kluczem do usunięcia** — odwracalność nie zależy od WMS. Round-trip: puste pole dostaje `+StD20` **bez wiodącej spacji** (inaczej odczyt-z-trim rozjechałby się z zapisem i job pisałby w kółko — regex `ADNOTACJA_RE` łapie formę z adresem i bez); człon `/zapas` (`M2-A7/C2P3`) przeżywa, bo ma ukośnik, nie ` +`.
- **Dom WMS wciąż chroni pole z INNYM adresem** (`decyzjaAdnotacji` z `maDomWms`): gdy GT trzyma bazę ≠ WMS (ręczna edycja / zaległy sync), job nie rusza — poprawianie adresu to robota `synchronizujLokalizacje` przy ruchu. Dla SKU bez domu ten strażnik nie bije (baza = to, co w GT).
- Ruch na SKU chwilowo zdejmuje dopisek (`synchronizujLokalizacje` pisze sam adres); job przywraca go przy najbliższym przebiegu. Świadome: po ruchu strefa i tak się zmieniła, a nieaktualne „+StZ3" jest gorsze niż jego brak.

`tw_Pole1`/`tw_Pole8` to standardowe pola dodatkowe (varchar 50) — w innych kategoriach towarów (książki, meble) mają inne znaczenie (autor, pomieszczenie), ale te towary nie mają stanu w K4/K4G, więc się nie nakładają.

Format atomowy w WMS: `M2-J14-P2`. Format skrócony do GT: `M2-J14-P2/3; M2-J15-P1`. Limit pola: ~50 znaków. Overflow do drugiego pola. Jeśli nie mieści się w 100 znakach łącznie — reszta tylko w WMS, GT dostaje tyle ile może + `...`.

## Zasady nadrzędne

1. **GT = master stanów ilościowych** — WMS nigdy nie zmienia stanów bezpośrednio, tylko przez dokumenty (MM, RW, PW) przez Sferę
2. **WMS = master lokalizacji** — pola własne GT to kopia do wyświetlenia
3. **Inwariant:** suma sztuk na lokalizacjach WMS = stan GT dla każdej pary (artykuł, magazyn)
4. **Kolejka:** każdy ruch zapisuje się do tabeli `ruchy` ze statusem `pending` zanim wywoła most C#. Przy błędzie Sfery ruch zostaje `pending` — nie ginie
5. **Backend = jedyne źródło prawdy dla inwariantów** — każda reguła biznesowa MUSI być wymuszona w `routes/` (serwer). Walidacja we froncie (desktop/Zebra) jest tylko dla UX (szybki feedback) i NIE jest autorytatywna. Nigdy nie zostawiamy reguły wyłącznie we froncie — drugi klient albo bezpośrednie wywołanie API ją ominie. Tak powstał rozjazd na HKV50: limit przypisania był tylko w desktopie, Zebra go omijała.
6. **Rezerwacje GT blokują MM** — zarezerwowanych sztuk nie wolno przesuwać. Z magazynu źródłowego można wyprowadzić najwyżej `stan GT − rezerwacja (st_StanRez)` dla danej pary (artykuł, magazyn). Inaczej Sfera odrzuca dokument MM ("brak towaru na magazynie źródłowym"), a ruch wisi `pending` bez szans na retry. Egzekwowane w backendzie dla każdego MM (`/ruchy/mm`, `/ruchy/przyjecie`, `/ruchy/mm-zewnetrzny`).

### Inwarianty — gdzie egzekwowane (audyt 2026-06-25)

| Inwariant | Egzekwowane | Gdzie |
|---|---|---|
| MM: ilość ≤ stan lokalizacji źródłowej | ✅ backend | `/ruchy/mm` |
| MM: cel w INNYM magazynie niż źródło | ✅ backend | `/ruchy/mm` |
| LOK: cel w TYM SAMYM magazynie co źródło | ✅ backend | `/ruchy/lok` |
| K4 = 1 SKU = 1 lokalizacja | ✅ backend | `/ruchy/mm`, `/lok`, `/przyjecie` |
| Przypisanie (LOK bez źródła): ilość ≤ stan_GT − suma_WMS | ✅ backend | `/ruchy/lok` |
| Lokalizacja: kod unikalny globalnie, magazyn ∈ {K4, K4G} | ✅ backend | `/lokalizacje` |
| Przyjęcie z zewn.: ilość ≤ stan GT magazynu MAG/LS | ✅ backend | `/ruchy/przyjecie` |
| K4 LOK = cała ilość (nie częściowa) | ✅ backend | `/ruchy/lok` |
| MM: ilość ≤ stan GT − rezerwacja (GT master; egzekwowane ZAWSZE, nie tylko przy rezerwacji — chroni też przed stale-wysoką kopią WMS K4) | ✅ backend | `/ruchy/mm`, `/przyjecie`, `/mm-zewnetrzny` |
| **Lokalizacja K4 przeżywa stan 0** — dom SKU nie jest funkcją ilości, ani w WMS, ani w kopii GT | ✅ backend | `/ruchy/mm`, `DELETE /ruchy/:id`, `services/gt-fields.js` |

Wszystkie inwarianty są egzekwowane w backendzie. Dodając nową regułę: najpierw `routes/`, front tylko jako UX.

**„Lokalizacja K4 przeżywa stan 0" — dlaczego osobny wiersz (2026-07-19).** K4 to magazyn zbioru: SKU ma tam jedno STAŁE miejsce, a ilość spada do zera przy każdym wyczerpaniu półki. Pusta półka czeka na uzupełnienie i **nie przestaje być adresem** — po tym adresie człowiek szuka towaru w GT (wydruk / wyszukiwanie po `tw_Pole1`), czytają go `/lokalizacje/k4-dom`, uzupełnienia, rozmontowania i ścieżki. Reguła żyła wyłącznie jako komentarz w `routes/ruchy.js` i przez to była łamana w DWÓCH miejscach naraz: `obliczPolaLokalizacji` miało `AND s.ilosc > 0` (wiersz był, ale pole GT szło puste = „wyczyść"), a `DELETE /ruchy/:id` kasowało sam wiersz przy cofnięciu ruchu na K4 (np. nieudanego uzupełnienia na pustą półkę). Dwie różne drogi, jeden skutek: SKU traciło adres w GT. **K4G jest celowo odwrotne** — tam ilość jest częścią tekstu pola (`kod(ilosc)`), więc zero naprawdę znaczy „nie ma czego pokazać".

## Schemat bazy (już w 001_init.sql)

Tabele: `lokalizacje`, `stany_lokalizacji`, `ruchy`, `rozjazdy`

`lokalizacje` ma cechy strukturalne (`hala`/`regal`/`alejka`/`strona`/`kolumna`/`typ`) wyliczane z kodu przez `services/lokalizacje-model.js` (`rozbierzKod(kod, magazyn)`) — wypełniane przy imporcie/dodaniu/edycji, do filtrów i raportów. Typ ∈ {paleta, trawers, polka, inny}, reguła `typ = f(magazyn, hala, regał)`: **K4G → zawsze paleta** (lokalizacje paletowe od P2); K4 → C,D,K=trawers (paleta dzielona na pół: podstawa+P1), E–J hala 1=polka (regały półkowe), E–J M2=trawers (M2 bez półek), A,B,L=paleta; RB/BIURO i kody spoza siatki regałów=inny. Typ można nadpisać ręcznie (`PUT /:id {typ}`) — edycja inline w tabeli desktop. Poziom (`-P<n>`) nie jest osobną kolumną — wynika z kodu. Skan/lookup akceptuje też kody bez myślnika (`A8P2` = `A8-P2`) przez `normalizujKodLokalizacji` — obejście dla starych naklejek (endpointy `/skan/:kod`, `/kod/:kod`).

**Dopasowanie do pól GT ignoruje myślnik (2026-08-04).** `tw_Pole1`/`tw_Pole8` są pisane **ręcznie**, więc ta sama półka siedzi tam w obu ortografiach — obok siebie `M2-B3-P3` i `C14P1`. WMS trzyma jeden kod kanoniczny, więc `kodJestTokenemLokalizacji` porównuje człony po formie gołej (`golyKod`), a prefiltr SQL pyta o **oba** zapisy (`LIKE '%A1-P1%' OR LIKE '%A1P1%'` — SQL nie umie porównać po gołej formie). Bez tego skan lokalizacji nie pokazywał towarów opisanych w GT bez myślnika: na Z_KAJTEK skan `J2-P3` dawał **0** towarów „tylko GT" zamiast 6. Nadal wymagany **pełny człon**, nie podciąg (`C16` ≠ `M2-C16-P2`) — myślnik to ortografia, nie znaczenie.

**Kod w bazie trzymamy WYŁĄCZNIE w postaci kanonicznej (2026-08-04).** Zapis (`POST /lokalizacje`, `/import`, `PUT /:id`) przepuszcza kod przez `normalizujKodLokalizacji` — inaczej powstaje wiersz, którego **żaden lookup już nie znajdzie**: każde szukanie normalizuje wejście do `L3-P3`, więc wiersz zapisany dosłownie jako `L3P3` jest niewidoczny dla skanu, mimo że leży na nim towar. Tak zniknęły na produkcji `L3P3` (216 szt.) i `C17P3` (495 szt.) — objawiało się to jako „część lokalizacji w regale L się nie czyta". Dodatkowo taki kod nie pasuje do `WZORZEC_KODU`, więc wiersz dostawał `typ='inny'` i puste cechy (wypadał z filtrów). Lookup ma jeszcze **fallback po formie gołej** (`REPLACE(kod,'-','')`, tylko dla kodów z siatki regałów — `kanonicznyKodSiatki`), żeby stare wiersze dało się odczytać przed migracją. Sprzątanie bazy: `node scripts/napraw-kody-lokalizacji.js` (dry-run; `--zapisz` poprawia kod + cechy, kolizje z istniejącym kanonicznym kodem tylko raportuje — scalenie stanów to decyzja człowieka).

Typy ruchów: `LOK` (lokalizowanie po PZ/FZ, bez dokumentu GT), `MM` (przesunięcie, generuje MM w GT)

> Moduł inwentaryzacji usunięty (2026-06-25) — tabele `inwentaryzacje`/`pozycje_inwentaryzacji`, route `/api/inwentaryzacja`, ekran Zebry i panel desktopu już nie istnieją. Do zrobienia od nowa. Most C# nadal ma endpointy RW/PW (nieużywane).

## Ekrany Zebry

1. **Ruch towaru** (`ruch.html`) — zlany MM + zmiana lokalizacji. Skan SKU/EAN/lokalizacji → wybór → krok „Dokąd i ile?": select **Cel** (Ta sama = LOK w obrębie magazynu / inny magazyn = MM) + ilość + lokalizacja. Operacja LOK/MM wyprowadzana automatycznie. Po zatwierdzeniu ekran sukcesu (dotknięcie zamyka) + sygnał dźwiękowy.
   - **Krok wyboru jest ZAWSZE (2026-07-19).** Skan nigdy nie wpada prosto w „Dokąd i ile?" — ani gdy produkt ma jedną lokalizację, ani gdy lokalizacja ma jeden produkt, ani gdy produkt nie ma jeszcze żadnej lokalizacji. Ekran wyboru to jedyne miejsce z panelem **Rezerwacje na K4** (które ZK trzymają towar), łącznym stanem i sztukami w zestawach — skróty zabierały tę informację akurat przy najprostszych przypadkach, gdzie decyzja zapada najszybciej. Nie kosztuje to tapa: pole skanu na tym ekranie przyjmuje kod lokalizacji (rozkład produktu) albo SKU/EAN (zawartość lokalizacji) i od razu przechodzi dalej. Jedyny wyjątek to `skrotPrzypisania` w `obsluzArtykul` — ustawiany WYŁĄCZNIE przez „➕ Dalej" (patrz niżej), bo tam rozkład widzieliśmy sekundę wcześniej.
   - **„Zostań w produkcie" (rozkładanie palet):** po zapisie backend liczy `deficyt_k4`/`deficyt_k4g` (stan GT − suma WMS, w `routes/lokalizacje.js` dolaczDaneGt). Gdy coś jeszcze nieprzypisane, ekran sukcesu daje **➕ Dalej** (zostaje w SKU, wraca do „Dokąd i ile?" w trybie przypisania, bez re-skanu) i **✓ Gotowe** (reset). Deficyt=0 → auto-reset. `pobierzPozostaloDoPrzypisania` w `ruch.js` (1 fetch `/skan/:symbol`, odświeża stany_gt).
   - **Ostatnie produkty/lokalizacje** pod polem skanu (`localStorage`, per urządzenie, ~10 szt.): tap = otwiera SKU/lokalizację bez skanu. Zasilane przy każdym zapisie ruchu.
2. **Test wyszukiwania** (`produkty.html`) — podgląd karty produktu z GT.
3. **Ścieżki** (`sciezki.js`, widok w `ruch.html`) — zadania obchodu magazynu (Faza 6). Patrz sekcja „Ścieżki".

Pola skanu mają `inputmode="none"` (skaner DataWedge wstrzykuje dane, klawiatura nie wyskakuje; dotknięcie pola = ręczne wpisanie). DataWedge (działająca konfiguracja): Keystroke output → Basic data formatting → **Send ENTER key** ON (dokłada Enter) + Key event options → **Send Characters as Events** ON + **Send Enter as string** ON. `onScan` w `kreator.js` łapie ten Enter także jako znak CR / `inputType:insertLineBreak`.

## Ścieżki (Faza 6)

Proste zadania „obchodu" magazynu z checklistą, posortowane w kolejności zbierania. Zdarzenia lądują w tabeli `audyt` (bez nowych tabel). Kafelek „Ścieżki" w menu Zebry → `widok-sciezki` (SPA). Backend: `routes/sciezki.js` (`/api/sciezki`, montowany z `auth.wymagajSesjiNaZapisie`). Front: `public/zebra/sciezki.js` (IIFE na globalnych `el`/`pokazWidok`/`onScan`, wzorzec jak `historia.js`).

**Ścieżka 1 — „Ostatnie sztuki":** weryfikacja niskich stanów K4 (1–5 szt.).
- **Źródło stanu K4 = ZAWSZE GT (Subiekt = master stanów).** WMS `stany_lokalizacji` to kopia, która się starzeje (sprzedaż w Subiekcie zbija stan bez wiedzy WMS → WMS bywa > GT), więc **ilości nigdy z niej nie czytamy** — WMS służy tylko za **master lokalizacji** (który SKU ma stałe miejsce w K4 i jaki to kod). Lista = **unia**: (a) `gt-produkty.pobierzK4NiskieStany` = GT `st_Stan` 1–5 z **niepustą `tw_Pole1`** i **`tw_Rodzaj=1`** (tylko towary — wycina zestawy/komplety `rodzaj 8` typu „Nerf + celownik + strzałki" i usługi; filtr po RODZAJU, nie po nazwie) dla SKU, których WMS nie zna, `lokalizacja = tw_Pole1` **przepuszczone przez `bezAdnotacjiStref`** (2026-08-04 — pole człowieka, nie czysty kod: job dokleja `+StD20`. Bez zdjęcia dopiska adres skakał przy każdej zmianie strefy, więc klucz pary w audycie sprawdzeń/pominięć przestawał pasować, a pozycja z **samym** dopiskiem — `+StP1`, puste pole w GT — sortowała się na sam **początek** obchodu. Puste po zdjęciu = SKU bez miejsca w K4, wypada z listy tak jak przed istnieniem dopisków); (b) SKU, które WMS zna (ma wiersz K4) — **stan i Razem z GT** (`pobierzStanyGt`), `lokalizacja = kod z WMS`. Oba `zrodlo:'GT'`. WMS-wiersze dedupowane do 1 na SKU (preferuje ten z zapasem — 1 SKU = 1 lokalizacja). Kolejność listy: patrz „Kolejność obchodu" niżej (nie sam `ORDER BY` z SQL — route re-sortuje).
- **Warunek łącznego stanu:** dodatkowo `Razem ≤ 5` (`RAZEM_MAX`), gdzie Razem = K4+K4G+MAG+LS (bez BRK). Odsiewa towary z niskim K4, ale z zapasem na innych magazynach (np. setki na K4G = kandydat do uzupełnienia, nie do liczenia „ostatnich sztuk"). Gałąź GT: w SQL (`HAVING`); gałąź WMS-known: z `pobierzStanyGt` (K4+K4G+MAG+LS, wszystko GT). Na starcie ~700 pozycji — backlog drenowany przez 180 dni.
- **Kolejność obchodu (zmiana 2026-07-24, rozszerzana 2026-07-30 i 2026-08-04):** domyślnie po kodzie lokalizacji (kolejność zbierania), ale **kilka grup idzie na KONIEC**, rosnąco: `zwykłe < biuro < poprezentacyjne/uszkodzone (p/u) < w strefie < w pełni zarezerwowane < policzone niedawno`. Wewnątrz każdej grupy nadal po lokalizacji. Czysta logika w `services/kolejnosc-obchodu.js` (`grupaObchodu`/`porownajObchod`, testy `test/kolejnosc-obchodu.test.js` bez SQLite/GT); sort w `/ostatnie-sztuki` **po** `dolaczOczekiwanaPolke` (potrzebuje `w_strefach`). Powód: te rodzaje wymagają innej uwagi niż liczenie pełnej półki (p/u = egzemplarz specjalny; strefa = część stanu leży poza półką; pełna rez = z półki i tak nic nie ruszysz), więc nie mają rozbijać rytmu obchodu zwykłych pozycji. Grupy z IF-ów w kolejności „najdalsza cecha wygrywa" — pozycja i w strefie, i zarezerwowana ląduje w rezerwacji; policzone niedawno bije **wszystko**.
  - **„W pełni zarezerwowane"** = `rezerwacja ≥ stan K4 (>0)` z GT (na parze). Częściowa rezerwacja **nie** spycha. Stan 0 celowo nie liczy się jako „pełna rez" (0 ≥ 0).
  - **„Biuro" (grupa 1, 2026-08-04)** — kody `biuro`/`BIURO`/`M2-BIURKO` sortują się po literach **przed `A1`**, więc obchód zaczynał się od wycieczki do biura zamiast od pierwszego regału. To nie przystanek na trasie, ale towar trzeba policzyć — więc idzie na koniec, tuż przed p/u. Rozpoznanie: fragment `BIUR` w kodzie (`czyBiuro`) — kod z siatki regałów to litera A–L + cyfry + `P<n>`, więc nigdy nie da fałszywego trafienia. Ta sama lokalizacja bywa zapisana różnie (część kodów pochodzi z ręcznie pisanych pól GT), stąd dopasowanie po fragmencie, nie po dokładnej wartości.
  - **„Policzone niedawno" (grupa 5, na sam koniec) rozwiązuje realny przypadek:** na obchodzie często PO sprawdzeniu **przypisujemy** SKU lokalizację (przypisanie = zmiana lokalizacji). Para (artykuł+**stara** lokalizacja) jest w audycie jako sprawdzona, ale item ma już **nową** lokalizację → wykluczenie po parze (`DNI_POMIN_SPRAWDZONE`) go nie łapie i **wraca na listę**, w dodatku sortem po nowej lokalizacji **wyprzedzając** pozycje jeszcze w ogóle nieliczone. Rozpoznajemy go **per SKU** (`sprawdzoneSku` = `artykul_gt_id` z tych samych świeżych wpisów `sprawdzenie_*` co `sprawdzone`; nie per para, bo lokalizacja się zmieniła) i dajemy na **sam koniec** — nigdy nie stoi przed czymś, czego nikt jeszcze nie policzył. Po 180 dniach stare sprawdzenie wygasa i SKU wraca do normalnej grupy.
  - **Rozpoznanie p/u = symbol na `p`/`u` I istnieje jego symbol BAZOWY w GT** (`oznaczWariantyPU` w `gt-produkty.js`, jedno zapytanie `IN`, best-effort — gdy padnie, po prostu nie wyróżniamy p/u). Sam suffiks **nie wystarcza**: `870BLU` (niebieski), `1696HU` (węgierski), `F2713P` (zwykły) też kończą się na u/p. Baza odsiewa je — empirycznie na Z_KAJTEK: z 165 kandydatów na u/p wykluczyła dokładnie 4 fałszywe (`u`=uszkodzony, `p`=poprezentacyjny).
- `GET /ostatnie-sztuki` — jw.; przy niedostępnym GT zwraca **503**. **Nie robi ruchów WMS.**
- **„Pomiń" nie rusza spisu (zmiana 2026-08-04, decyzja usera).** Zostawia sam wpis w audycie (`sprawdzenie_pominiete`): pozycja **nie wypada z listy** i **nie jest spychana na koniec** — przy następnym obchodzie stoi na swoim miejscu wg lokalizacji (zwykle blisko początku), chyba że łapie ją inna reguła (p/u, strefa, pełna rezerwacja, policzone niedawno). Droga do tego stanu: najpierw pominięcie chowało parę na 7 dni (zadanie znikało, a po tygodniu wracało jakby nigdy nic — stąd zgłoszenie „pominięte wracają na początek kolejki"), potem przez chwilę spychało ją na koniec spisu (za dużo — magazynier chce ją zobaczyć znowu tam, gdzie stała). Drugą szansę **w tym samym obchodzie** daje front: `pominPrzystanek` przerzuca pozycję na koniec bieżącej listy, a drugie pominięcie już jej nie cofa (inaczej „pomiń wszystko" kręciłoby listę w kółko). To zachowanie EKRANU — backend o pominięciach nie wie nic. Tak samo na pozostałych ścieżkach.
- Wyklucza parę (artykuł+lokalizacja) sprawdzoną w ciągu **180 dni** (`DNI_POMIN_SPRAWDZONE`) oraz SKU z przyjęciem z magazynu zewnętrznego (`ruchy.mag_zrodlo_zewnetrzny` NOT NULL) w ciągu **30 dni** (`DNI_POMIN_PRZYJECIE`) — świeżo dołożony stan jest znany. Oba filtry z SQLite, w Node.
- `POST /ostatnie-sztuki/sprawdzenie` `{artykul_gt_id, artykul_symbol, lokalizacja_kod, ilosc_policzona}` — porównuje policzone ze stanem **GT w K4** (`dostepneWGt`, `zrodlo` zawsze `'GT'`); zgodne → audyt `akcja='sprawdzenie_stanu'`, niezgodne → `akcja='sprawdzenie_niezgodne'` (do raportu, `przed={stan, zrodlo}`). Bez ruchu WMS. GT niedostępny → 503. Raport czyta `przed.stan`/`zrodlo`, ze wsteczną zgodnością ze starym `{stan_gt}`.
- `GET /ostatnie-sztuki/raport` — otwarte niezgodności: pary, dla których NAJNOWSZE sprawdzenie to `sprawdzenie_niezgodne` (późniejsze zgodne = domknięcie). Tap w raporcie → `window.ruchOtworzArtykul(symbol)` otwiera normalny ekran Ruch.

UX obchodu: skan SKU/EAN potwierdza właściwą pozycję → pole ilości → zgodne = krótki beep + auto-przejście; niezgodne = beep błędu + nakładka `ostrzezenie` (dotknięcie = dalej). „Brak cichych porażek" — dźwięki zgodne/niezgodne różne.

**Ścieżka 2 — „K4 pełna rezerwacja":** towar tylko w K4, cały stan zarezerwowany (`pobierzK4PelnaRezerwacja`). Endpointy `/k4-rezerwacja/*`, akcje audytu `sprawdzenie_rez*`. Mechanika identyczna jak Ścieżka 1.

**Ścieżka 3 — „Czyść zera" (2026-07-19):** zwalnianie slotów K4 po martwym towarze. K4 to regał ZBIORU — slotów jest ~855 i każdy zajęty przez martwy towar to miejsce, którego nie dostanie towar rotujący. Odkąd lokalizacja K4 przeżywa stan 0 (patrz inwariant wyżej), zera same nie znikają — ta ścieżka jest zaworem.
- Lista = wiersze WMS na K4, dla których **GT stan K4 = 0 I `zapas` = 0**, gdzie **`zapas` = K4+K4G+LS** (`sumaZapasK4`, lista `MAGAZYNY_ZAPAS_K4`). Zera **z zapasem celowo NIE wchodzą** — to robota dla Uzupełnień, które i tak je widzą. Zero czytamy z GT, nie z kopii WMS. **Bez dedupu po SKU** (inaczej niż Ścieżka 1): gdy artykuł trzyma dwa sloty, oba są do zwolnienia.
- **MAG (Kajtek) NIE liczy się do `zapasu`** (decyzja usera 2026-07-19) — towar leżący w Kajtku nie wraca na K4 sam z siebie, więc nie jest powodem, żeby blokować slot na hali. To inne pytanie niż „Razem" na karcie produktu (tam MAG się liczy) — stąd **osobna suma, nie filtr**. Sterowane flagą `zapasDlaK4: false` w `config/magazyny.js`, składaną z `liczDoRazem`, więc BRK i K4R wypadają same.
- **Nie ma warunku „od X dni bez ruchu"** — u nas nie ma szybkorotującego towaru z dostaw (decyzja usera 2026-07-19), więc pusto na K4+K4G+LS znaczy pusto naprawdę, a nie „chwilowo między dostawami". Przed omyłkowym zwolnieniem chroni ponowne sprawdzenie stanu GT przy zatwierdzeniu i to, że slot zwalnia człowiek stojący przy regale.
- `POST /czysc-zera/zwolnienie` — **JEDYNE miejsce w systemie, gdzie wolno skasować dom K4.** Inwariant zabrania tego automatom, bo automat wnioskuje ze STANU, a zero znaczy „półka pusta", nie „towaru tu już nie ma". Człowiek przy regale ma dowód, którego automat nie ma. Kasuje wiersz `stany_lokalizacji` + przelicza `tw_Pole1` (przy ostatnim wierszu K4 → pole się czyści; to jedyne zamierzone czyszczenie). Stan GT sprawdzany **ponownie przy zatwierdzeniu** — lista mogła się zestarzeć; GT niedostępny → 503, nie zgadujemy.
- Coś leży na slocie albo GT pokazuje stan → `zero_niezgodne`, slot ZOSTAJE, sprawa do raportu. Akcje audytu: `zero_zwolnione` / `zero_niezgodne` / `zero_zamkniete` / `zero_pominiete`.
- Tożsamość potwierdza **kod lokalizacji**, nie towaru (pusta półka nie ma czego zeskanować); symbol/EAN też przyjmowany. Ukryta przed rolą `uczen` (`data-bez-ucznia`) — jako jedyna ścieżka kasuje dane, wbrew domyślnej regule podmenu.

Front: ścieżki opisane mapą `SCIEZKI` w `public/zebra/sciezki.js` (endpoint, akcja, `udane(d)`, teksty). **Nowa ścieżka = wpis w tej mapie**, nie ify rozsiane po pliku.

## Parametry produktu (wymiary, waga, waga gabarytowa)

WMS jako warstwa **danych opisowych** nad GT. To NIE są stany — reguła #1 ich nie dotyczy; obowiązuje reguła #2 (WMS master, GT kopia). Zapis idzie **bezpośrednim SQL-em**, jak lokalizacje w `gt-fields.js` — most obsługuje wyłącznie dokumenty MM (`ZapiszLokalizacjeAsync` to niezaimplementowany stub, nigdy niepodłączony).

| Dane | Pole własne GT | Kolumna |
|---|---|---|
| Wymiary | `Wymiary` | `pw_Dane.pwd_Tekst07`, np. `25,5x17,5x5,5` (dł×szer×wys, cm) |
| Waga produktu | `Waga produktu` | `pw_Dane.pwd_Tekst06`, w **kg** |
| Waga gabarytowa DHL | `Waga gabarytowa DHL` | `pw_Dane.pwd_Tekst09`, w kg, **wyliczana** (z gołych wymiarów) |
| Waga gabarytowa z kartonu | `Waga gabarytowa karton DHL` | `pw_Dane.pwd_Tekst10`, w kg, **wyliczana z kartonu** (fallback goły wymiar) |

`pw_Dane` trzyma pola własne wszystkich obiektów; wiersz towaru = (`pwd_TypObiektu=-14`, `pwd_IdObiektu=tw_Id`). **Większość towarów nie ma tam wiersza** — dlatego zapis to UPSERT. `pwd_Id` NIE jest IDENTITY, **ale GT MA dla niego licznik**: tabela `ins_ident` (`ido_nazwa='pw_Dane'`, `ido_wartosc` = następny wolny numer), podbijana atomowo procedurą składowaną `spIdentyfikator`. WMS alokuje `pwd_Id` **przez `spIdentyfikator`** (tak jak Sfera), pod `UPDLOCK,HOLDLOCK` na sprawdzeniu istnienia wiersza — **NIGDY przez `MAX+1`**. `MAX+1` omijało ten licznik i wypychało `pw_Dane` ponad niego, przez co GT przy własnym zapisie pola własnego trafiał na zajęty `pwd_Id` → „naruszenie integralności danych" (także ręczny zapis w Subiekcie, także komplet — incydent 2026-07-20). `ab_Licznik` to faktycznie konfiguracja przypomnień, nie generator.

**Waga gabarytowa = dł×szer×wys/4000** (DHL), 2 miejsca, minimum `0,01`. Liczona **zawsze serwerowo** — `PUT /api/produkty/:id/atrybuty` ignoruje tę wartość przysłaną przez klienta, więc nie da się zapisać liczby niespójnej z wymiarami. Zmiana wymiarów przelicza ją w tej samej transakcji; `services/waga-gabarytowa-job.js` (co 6 h, `WAGA_GAB_INTERWAL_MIN`) łapie ręczne zmiany wymiarów zrobione w samym Subiekcie.

**Waga gabarytowa z kartonu (`pwd_Tekst10` „Waga gabarytowa karton DHL", 2026-07-23).** Drugie, OSOBNE pole obok DHL — liczone nie z gołego produktu, lecz z **najmniejszego pasującego kartonu wysyłkowego** (kurier liczy pudło, nie goły towar). Lista kartonów jest **edytowalna w panelu admina** (desktop, zakładka „Kartony", tylko admin — CRUD `/api/kartony` z `auth.wymagajAdmin`): tabela SQLite `kartony` (seed z `config/kartony.js`), dobór/waga w `services/kartony.js` z cache; **czysta logika** (`dobierzKartonZListy`, `liczWageKartonZListy`, `sprawdzKarton`) siedzi w `config/kartony.js` — testowalna bez DB/GT (`test/kartony.test.js`). Produkt niemieszczący się w żadnym kartonie → **fallback na goły wymiar** (`zrodlo:'wymiar'`); brak wymiarów → puste. Podgląd na ekranie Parametry (desktop + Zebra) przez `GET /api/kartony/dobierz` (odczyt otwarty). Zapis do GT tą **samą bezpieczną ścieżką UPSERT** co DHL (`pwd_Id` z `spIdentyfikator`, nigdy `MAX+1`) — `pwd_Tekst10` tylko dokładane do listy `pola`. Ten sam `waga-gabarytowa-job.js` uzgadnia OBA pola (helper `uzgodnijKolumne`), więc edycja listy kartonów propaguje się na kartotekę.

**Separator dziesiętny — KROPKA do GT, PRZECINEK na ekran (2026-07-23).** `pwd_Tekst09` (Waga gab. DHL) i `pwd_Tekst10` (Waga gab. karton DHL) zapisywane są do GT z **kropką** (`7.98`), bo **BaseLinker** czyta je jako liczbę, a przecinkowy tekst (`7,98`) mu się rozjeżdża. Ekran WMS (Parametry desktop/Zebra) pokazuje **przecinek** (locale PL, spójnie obok siebie) — stąd rozdział przy źródle: `liczWageGabarytowa`/`liczWageKartonZListy.waga` = przecinek (wyświetlanie), `liczWageGabarytowaGt`/`.wagaGt` = kropka (zapis GT). WMS nigdy nie czyta tych pól z GT do logiki (liczy na nowo), więc kropka w GT nie myli WMS-a. **`pwd_Tekst06` (Waga produktu) zostaje z przecinkiem** — działa z tym, co jest. Job przy pierwszym przebiegu po wdrożeniu przepisuje istniejące wartości przecinkowe na kropkowe.

**Walidacja** (`sprawdzWymiary`/`sprawdzWage`, egzekwowane w `routes/produkty.js`): trzy liczby **> 0** (zero jest błędem — w danych z BaseLinkera trafiały się wpisy `0x65x53`), ostrzeżenie powyżej 150 cm, twardy limit 1000 cm.

⚠️ **Jednostki wag w GT są MIESZANE historycznie**: wartości całkowite = gramy (`916`), wartości z przecinkiem = już kilogramy (`6,5`). Ślepe dzielenie wszystkiego przez 1000 psuje dane. Z UI przyjmujemy wyłącznie kg i nigdy nie zgadujemy jednostki po kształcie liczby.

Ekran: **Parametry** (`public/zebra/parametry.js`, widok `#widok-parametry`), waga gabarytowa tylko do odczytu. Ścieżka **„Brak parametrów"** (`tryb: 'parametry'` w mapie `SCIEZKI`) — nowy gatunek ścieżki: **uzupełnia dane zamiast liczyć**, więc bez raportu i bez „niezgodności". Po skanie potwierdzającym otwiera ekran Parametry, po zapisie wraca i przechodzi dalej. Adres pozycji: WMS ma pierwszeństwo, fallback na `tw_Pole1`/`tw_Pole8` z GT (bez tego prawie cała lista byłaby bezadresowa — WMS zna lokalizacje tylko części asortymentu).

## Most C# — endpointy (localhost:5000)

```
POST /api/mm
POST /api/lok
GET  /api/stan/:magId
GET  /api/artykul/:id
GET  /api/zdrowie          # stan mostu (nie dotyka Sfery) — czyta go routes/status.js
POST /api/inwentaryzacja/rw
POST /api/inwentaryzacja/pw
```

**Diagnostyka mostu (2026-08-05).** Most pisze log do `logs/most-YYYY-MM-DD.log` **obok exe** (`bridge/GtBridge/bin/Release/net8.0-windows/win-x86/publish/logs/`, rotacja 90 dni): start/stop procesu, logowanie do Sfery, każdy MM (czas trwania + numer albo błąd z HRESULT), przebieg zamykania sesji. Wcześniej most nie zapisywał **nic** — jego stan żył wyłącznie w ikonie w trayu, więc po restarcie przyczyna awarii przepadała (tak straciliśmy błąd z 2026-08-05).

- `GET /api/zdrowie` oddaje **tylko zapamiętany stan** (`sfera: ok|blad|nieznany`, komunikat, `zajety_od`, długość kolejki wątku STA). **Celowo nie woła Sfery** — health-check pukający w Sferę dokładałby zadań do tej samej zaklinowanej kolejki STA, czyli psułby to, co mierzy.
- `zajety_od` to jedyny tani sygnał „wywołanie COM wisi": Kestrel odpowiada niezależnie od wątku STA, więc samo „proces odpowiada na HTTP" **nie znaczy** „most działa". Na tym poległo stare sprawdzenie w `/api/status` (`GET /` + każda odpowiedź = OK) — kropka „Most" świeciła na zielono przez całą awarię Sfery.
- Kropka „Most" (desktop, Zebra, ekran logowania) gaśnie także wtedy, gdy proces żyje, ale ostatnia operacja Sfery skończyła się błędem — bo odpowiada na pytanie „czy MM przejdzie". Treść błędu ląduje w pasku instrukcji. Stary most bez `/api/zdrowie` → `sfera: null` i zachowanie jak dawniej (Node można wdrożyć przed mostem).
- Nieudane MM i nieudany sync lokalizacji idą teraz do `logs/error-*.log` (`awarie.blad`). `ruchy.blad_opis` **nie wystarcza** — jest czyszczony przy pierwszym udanym ponowieniu.
- **Czekanie na wątek STA zostaje bez timeoutu** i to jest świadome: wywołania COM nie da się przerwać, więc timeout zwolniłby tylko wątek HTTP, a zadanie dalej blokowałoby kolejkę. Zamiast udawanego ratunku — raportowanie (`zajety_od`).

## Log zmian (audyt)

Wpisy jobów podpisują się `uzytkownik: 'system:<job>'` (np. `system:rozjazdy`, `system:waga-gabarytowa`) i są **domyślnie ukryte** w Logu zmian — przy pytaniu „kto to zmienił" są szumem, bo powstają same i nikt za nie nie odpowiada. Widać je po wybraniu **„Wszystkie + automaty (U+A)"** albo konkretnej akcji automatu. Rozpoznanie idzie po **prefiksie użytkownika, nie po liście akcji** — lista wymagałaby dopisania przy każdym nowym jobie, a pierwszy zapomniany zasypałby widok. `uzytkownik = NULL` liczy się jako człowiek (akcja bez podanego operatora). Egzekwowane w `routes/audyt.js` (`?automaty=1`).

## Obsługa rozjazdów

- GT > WMS → ekran "do zlokalizowania"
- GT < WMS w K4 → auto korekta (1 lokalizacja)
- GT < WMS w K4gora → ekran "rozjazdy", magazynier decyduje
- Job detekcji co **10 min** (domyślnie; `ROZJAZDY_INTERWAL_MIN` w `.env`) w `services/rozjazdy.js` — auto-korekta K4 ściąga kopię WMS do stanu GT, więc częstszy przebieg = mniejsze okno rozjazdu na K4

## Stan obecny

Zbudowane i działające: baza + `routes/` (lokalizacje, ruchy, magazyny, produkty, rozjazdy, sciezki), most C# (`/api/mm`, `/api/lok`), ekran Zebry „Ruch towaru", moduł Ścieżki (Faza 6: ścieżka „Ostatnie sztuki" + raport), panel desktopu (produkty, rozjazdy, ruchy, lokalizacje, MM), job rozjazdów.

Do zrobienia od nowa: moduł inwentaryzacji (usunięty 2026-06-25).

Uruchomienie: `node app.js` (albo `start-wms.command` / `stop-wms.command` na macOS). Serwer na `:3000`, `/` → menu Zebry.
