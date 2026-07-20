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
| `Stan K4`, `Stan K4Góra` | — | kopie stanów dla multistany | NIE dotykamy |
| `Ilość w op. zbiorczym`, `Baterie` | `pwd_Tekst04`, `pwd_Tekst05` | ręcznie | NIE dotykamy |

**„Lokalizacja Zapas" jest nieużywana (2026-07-19).** Overflow lokalizacji K4G ponad limit `tw_Pole8` zostaje **wyłącznie w WMS** — służy już tylko do oflagowania `ZGODNOSC.OBCIETE` („pole GT za krótkie, żeby pokazać wszystkie wpisy"). Wcześniej kod czytał ten overflow z `pwd_Tekst09` i doklejał go do tekstu lokalizacji K4G. To było podwójnie błędne: pole „Lokalizacja Zapas" siedzi w GT na **`pwd_Tekst08`**, a `pwd_Tekst09` trzyma dziś **„Waga gabarytowa DHL"** — więc do lokalizacji doklejała się waga (`K4G: M2-C6-P2(3); 0,61`). Odczyt usunięty z `gt-fields.js`; werdykty zgodności nigdy na tym nie ucierpiały, bo `zgodneZWms` liczy wyłącznie z `tw_Pole1`/`tw_Pole8`.

**Adnotacja stref w `tw_Pole1` (2026-07-19).** Do adresu K4 dopisywana jest informacja, ile sztuk leży POZA półką: `M2-J14-P2 +D20 +Z3` = 20 szt. z dostawy i 3 ze zwrotu czekają w strefie. Skróty **te same co kolumna „Strefa" na desktopie** (P=przywózka, D=dostawa, Z=zwrot, PW=przyjęcie wewn.) — magazynier nie uczy się drugiego alfabetu. Powód: pole „Miejsce na magazynie" to jedyne, co widzi człowiek szukający towaru z poziomu GT (wydruk, wyszukiwanie w Subiekcie); przy pustej półce mówiło tylko adres pustej półki, a strefy istniały wyłącznie w WMS.

- **To DOPISEK, nie część adresu.** Kto czyta `tw_Pole1` jako **kod do rozwiązania** (cel MM w uzupełnieniach, `pierwszyKodZPola` w „Do sprawdzenia", porównanie zgodności) MUSI przepuścić go przez `bezAdnotacjiStref()`. Kto tylko wyświetla — zostawia. Czyste funkcje w `services/adnotacja-stref.js` (osobny plik, żeby dało się je testować bez SQLite i GT), re-eksport z `gt-fields`.
- **Zgodność celowo IGNORUJE adnotację** — dopisuje ją job z danych GT, nie WMS, więc porównywanie jej wywalałoby na `NZ` każde SKU z otwartą dostawą mimo zgodnego adresu.
- **Pisze job** `services/strefy-w-gt-job.js` (co 10 min, `WMS_STREFY_INTERWAL_MIN`), bo strefa zmienia się, gdy w GT pojawi się dokument — czyli wtedy, gdy WMS nic nie robi i nie ma się od czego odpalić. Zapis **tylko przy zmianie** (inaczej setki UPDATE-ów co przebieg).
- **Zakres: KAŻDE SKU, które ma sztuki w strefie (zmiana 2026-07-20).** Wcześniej dopisek szedł tylko na SKU z domem WMS K4 — przez to towary, których adres istnieje wyłącznie w GT (albo wcale), nie dostawały nic, mimo że fizycznie leżały w strefie. Teraz granica bezpieczeństwa to **„SKU ma realny dokument strefowy na K4 (rodzaj 1)"**, a nie „WMS zna jego dom". Towary spoza obiegu K4 (książki, meble — tam `tw_Pole1` znaczy autor/pomieszczenie) **nie mają dokumentów na K4**, więc są odsiane strukturalnie, nie regułą. Adres bazowy: prawda WMS gdy znamy dom, **inaczej to, co jest w GT bez naszego dopisku** — doklejamy do adresu z GT (też „śmieciowego" typu `RB/A18 /`) albo do **pustego pola** (wtedy samo `+D20`, bez adresu = „20 szt. czeka w strefie dostaw, brak półki").
- **Usuwanie znacznika = skan GT po jego formacie, nie po domu WMS.** Job bierze DRUGĄ listę: SKU noszące nasz dopisek w GT (`tw_Pole1 LIKE '% +%'`, `tw_Rodzaj=1`, potwierdzone `bezAdnotacjiStref` — zob. `pobierzSkuZDopiskiem`). Dzięki temu zdejmie własny znacznik nawet gdy SKU **nie ma domu WMS** i wypadło z kandydatów (dokument zestarzał się za oknem). **Sam format `+SKRÓT<liczba>` jest kluczem do usunięcia** — odwracalność nie zależy od WMS. Round-trip: puste pole dostaje `+D20` **bez wiodącej spacji** (inaczej odczyt-z-trim rozjechałby się z zapisem i job pisałby w kółko — regex `ADNOTACJA_RE` łapie obie formy); człon `/zapas` (`M2-A7/C2P3`) przeżywa, bo ma ukośnik, nie ` +`.
- **Dom WMS wciąż chroni pole z INNYM adresem** (`decyzjaAdnotacji` z `maDomWms`): gdy GT trzyma bazę ≠ WMS (ręczna edycja / zaległy sync), job nie rusza — poprawianie adresu to robota `synchronizujLokalizacje` przy ruchu. Dla SKU bez domu ten strażnik nie bije (baza = to, co w GT).
- Ruch na SKU chwilowo zdejmuje dopisek (`synchronizujLokalizacje` pisze sam adres); job przywraca go przy najbliższym przebiegu. Świadome: po ruchu strefa i tak się zmieniła, a nieaktualne „+Z3" jest gorsze niż jego brak.

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
- **Źródło stanu K4 = ZAWSZE GT (Subiekt = master stanów).** WMS `stany_lokalizacji` to kopia, która się starzeje (sprzedaż w Subiekcie zbija stan bez wiedzy WMS → WMS bywa > GT), więc **ilości nigdy z niej nie czytamy** — WMS służy tylko za **master lokalizacji** (który SKU ma stałe miejsce w K4 i jaki to kod). Lista = **unia**: (a) `gt-produkty.pobierzK4NiskieStany` = GT `st_Stan` 1–5 z **niepustą `tw_Pole1`** i **`tw_Rodzaj=1`** (tylko towary — wycina zestawy/komplety `rodzaj 8` typu „Nerf + celownik + strzałki" i usługi; filtr po RODZAJU, nie po nazwie) dla SKU, których WMS nie zna, `lokalizacja = tw_Pole1`; (b) SKU, które WMS zna (ma wiersz K4) — **stan i Razem z GT** (`pobierzStanyGt`), `lokalizacja = kod z WMS`. Oba `zrodlo:'GT'`. WMS-wiersze dedupowane do 1 na SKU (preferuje ten z zapasem — 1 SKU = 1 lokalizacja). `ORDER BY` kod lokalizacji.
- **Warunek łącznego stanu:** dodatkowo `Razem ≤ 5` (`RAZEM_MAX`), gdzie Razem = K4+K4G+MAG+LS (bez BRK). Odsiewa towary z niskim K4, ale z zapasem na innych magazynach (np. setki na K4G = kandydat do uzupełnienia, nie do liczenia „ostatnich sztuk"). Gałąź GT: w SQL (`HAVING`); gałąź WMS-known: z `pobierzStanyGt` (K4+K4G+MAG+LS, wszystko GT). Na starcie ~700 pozycji — backlog drenowany przez 180 dni.
- `GET /ostatnie-sztuki` — jw.; przy niedostępnym GT zwraca **503**. **Nie robi ruchów WMS.**
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
| Waga gabarytowa DHL | `Waga gabarytowa DHL` | `pw_Dane.pwd_Tekst09`, w kg, **wyliczana** |

`pw_Dane` trzyma pola własne wszystkich obiektów; wiersz towaru = (`pwd_TypObiektu=-14`, `pwd_IdObiektu=tw_Id`). **Większość towarów nie ma tam wiersza** — dlatego zapis to UPSERT. `pwd_Id` NIE jest IDENTITY, **ale GT MA dla niego licznik**: tabela `ins_ident` (`ido_nazwa='pw_Dane'`, `ido_wartosc` = następny wolny numer), podbijana atomowo procedurą składowaną `spIdentyfikator`. WMS alokuje `pwd_Id` **przez `spIdentyfikator`** (tak jak Sfera), pod `UPDLOCK,HOLDLOCK` na sprawdzeniu istnienia wiersza — **NIGDY przez `MAX+1`**. `MAX+1` omijało ten licznik i wypychało `pw_Dane` ponad niego, przez co GT przy własnym zapisie pola własnego trafiał na zajęty `pwd_Id` → „naruszenie integralności danych" (także ręczny zapis w Subiekcie, także komplet — incydent 2026-07-20). `ab_Licznik` to faktycznie konfiguracja przypomnień, nie generator.

**Waga gabarytowa = dł×szer×wys/4000** (DHL), 2 miejsca, minimum `0,01`. Liczona **zawsze serwerowo** — `PUT /api/produkty/:id/atrybuty` ignoruje tę wartość przysłaną przez klienta, więc nie da się zapisać liczby niespójnej z wymiarami. Zmiana wymiarów przelicza ją w tej samej transakcji; `services/waga-gabarytowa-job.js` (co 6 h, `WAGA_GAB_INTERWAL_MIN`) łapie ręczne zmiany wymiarów zrobione w samym Subiekcie.

**Walidacja** (`sprawdzWymiary`/`sprawdzWage`, egzekwowane w `routes/produkty.js`): trzy liczby **> 0** (zero jest błędem — w danych z BaseLinkera trafiały się wpisy `0x65x53`), ostrzeżenie powyżej 150 cm, twardy limit 1000 cm.

⚠️ **Jednostki wag w GT są MIESZANE historycznie**: wartości całkowite = gramy (`916`), wartości z przecinkiem = już kilogramy (`6,5`). Ślepe dzielenie wszystkiego przez 1000 psuje dane. Z UI przyjmujemy wyłącznie kg i nigdy nie zgadujemy jednostki po kształcie liczby.

Ekran: **Parametry** (`public/zebra/parametry.js`, widok `#widok-parametry`), waga gabarytowa tylko do odczytu. Ścieżka **„Brak parametrów"** (`tryb: 'parametry'` w mapie `SCIEZKI`) — nowy gatunek ścieżki: **uzupełnia dane zamiast liczyć**, więc bez raportu i bez „niezgodności". Po skanie potwierdzającym otwiera ekran Parametry, po zapisie wraca i przechodzi dalej. Adres pozycji: WMS ma pierwszeństwo, fallback na `tw_Pole1`/`tw_Pole8` z GT (bez tego prawie cała lista byłaby bezadresowa — WMS zna lokalizacje tylko części asortymentu).

## Most C# — endpointy (localhost:5000)

```
POST /api/mm
POST /api/lok
GET  /api/stan/:magId
GET  /api/artykul/:id
POST /api/inwentaryzacja/rw
POST /api/inwentaryzacja/pw
```

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
