# Postęp prac — WMS dla Subiekt GT

Dziennik zmian i status prac. Kolejność budowania i architektura — zob. `CLAUDE.md`.

## Status "Kolejności budowania" (CLAUDE.md)

| # | Krok | Status |
|---|---|---|
| 1 | `db/001_init.sql` + `db/database.js` | ✅ zrobione |
| 2 | `routes/lokalizacje.js` — CRUD | ✅ zrobione |
| 3 | `public/zebra/mm.html` — ekran MM | ✅ zrobione |
| 4 | `bridge/GtBridge/` — endpointy `/api/mm`, `/api/lok` | ⚠️ szkielet (mock), bez realnej Sfery — zob. "Otwarte" |
| 5 | Integracja MM end-to-end | ✅ zrobione (na mocku bridge'a) |
| 6 | `public/zebra/lokalizowanie.html` | ✅ zrobione |
| 7 | `services/rozjazdy.js` — job detekcji rozjazdów | ✅ zrobione |
| 8 | `public/zebra/inwentaryzacja.html` | ✅ zrobione |
| 9 | `public/desktop/index.html` — panel admina | ✅ zrobione |
| 10 | tabela kontrolna "Produkty" (desktop) | ✅ zrobione |

Logika WMS (routes/services/ekrany Zebra+desktop) jest funkcjonalnie kompletna.

## Krok 10 — tabela kontrolna "Produkty" (desktop)

Po dopracowaniu kroków 1-9 zapadła decyzja: zamiast dalszych osobnych ekranów,
zbudować **nowy widok desktop "Produkty"** — tabelę wszystkich towarów z GT razem
z danymi WMS i statusem zgodności. Ma być fundamentem dla kolejnych funkcji
(edycja lokalizacji, MM z tej tabeli itd.), ale **na razie tylko podgląd
(read-only), bez edycji** — o edycji zdecydujemy później (w tabeli vs. karta
produktu).

### Ustalony projekt tabeli (14 kolumn)

| Kolumna | Źródło | Uwagi |
|---|---|---|
| SKU | GT `tw_Symbol` | |
| Nazwa | GT `tw_Nazwa` | |
| EAN | GT `tw_PodstKodKresk` | |
| K4 | GT stan (`pobierzStanyGt`) | |
| K4G | GT stan | |
| MAG | GT stan | tylko info, bez lokalizacji WMS |
| LS | GT stan | tylko info, bez lokalizacji WMS |
| Razem | suma stanów GT | |
| WMS K4 | `stany_lokalizacji` | format `kod (ilość)`, 1:1 |
| WMS K4G | `stany_lokalizacji` | spakowane w 1 polu: `B1: 2, B2: 1` (1 wiersz = 1 produkt, bez rowspan) |
| K4G razem | suma WMS K4G | |
| Zgodność | WMS ⇄ pola własne GT | 1 wartość/wiersz = "najgorszy przypadek" z K4 i K4G wg priorytetu **❌ niezgodne > 🆕 tylko GT > ✅ zgodne > — puste**; hover = rozbicie K4/K4G + treść pola GT |
| Lokalizacja K4 z GT | `tw_Pole1` (raw) | dodane "dla spokoju" — weryfikacja logiki zgodności na start |
| Lokalizacja K4G z GT | `tw_Pole8`+`pwd_Tekst09` (raw) | jak wyżej |

### Ustalone zasady

- **Edycja**: na razie brak (decyzja later).
- **Filtry**: zawsze widoczne i zmienialne przez użytkownika, zero ukrytych
  wartości domyślnych.
- **Wyszukiwanie**: SKU/EAN (exact 1:1) + fraza w nazwie — reużyć merge
  WMS+GT jak w `/api/lokalizacje/skan/:kod`.
- **Stany GT**: bez cache, na żywo, ale tylko dla widocznej (paginowanej)
  strony — 1 zapytanie zbiorcze do GT per strona (jak `pobierzStanyGt`).
- **🆕 "tylko w GT"** = produkt, którego WMS jeszcze nie dotknął (pole GT ma
  wartość sprzed WMS) → kandydat do importu lokalizacji do WMS.
  **❌ "niezgodne"** = WMS ma dane, ale pole GT się rozjechało → manualna
  edycja w Subiekcie albo nieudany zapis (ruch `pending`).

### Co już istnieje / czego brakuje

Istnieje (do reużycia):
- `services/gt-produkty.js`: `pobierzStanyGt(ids)` — batch K4/K4G/MAG/LS, gotowe.
- `services/gt-fields.js`: `obliczPolaLokalizacji(artykulGtId)` (oczekiwane
  wartości pól wg WMS, eksportowana), `pobierzAktualnePolaLokalizacji(ids)`
  (rzeczywiste tw_Pole1/tw_Pole8/pwd_Tekst09 z GT, batch — **ale NIE
  eksportowana**), `zgodneZWms` (1 bool dla wszystkich 3 pól razem).

Brakuje (krok 10):
1. **`listujProdukty({q, limit, offset})`** w `gt-produkty.js` — paginowana
   lista towarów z GT (jak `szukajProdukty`, ale z `OFFSET/FETCH` i bez
   wymogu frazy gdy `q` puste), zwraca też `total`.
2. **Eksport `pobierzAktualnePolaLokalizacji`** z `gt-fields.js` + nowa
   funkcja klasyfikująca per magazyn (K4/K4G) do 4 stanów (🆕/✅/❌/—) —
   `zgodneZWms` trzeba rozbić na K4 vs K4G osobno + dodać przypadek "GT ma,
   WMS nie ma".
3. **Nowy endpoint `GET /api/produkty`** (paginowany, filtry, `q`) w
   `routes/produkty.js` (obecnie tylko `GET /:identyfikator` 1:1) — łączy
   1+2 + dane WMS z `stany_lokalizacji`/`lokalizacje`.
4. **Nowa zakładka desktop "Produkty"** w `public/desktop/index.html`
   (wzorzec jak Rozjazdy/Lokalizacje) + `odswiezProdukty`/`renderujProdukty`
   w `app.js`.

### Zaimplementowane (2026-06-13)

- `services/gt-produkty.js`: `listujProdukty({q, limit, offset})` — paginowana
  lista katalogu GT, eksportowana.
- `services/gt-fields.js`: wyeksportowano `pobierzAktualnePolaLokalizacji`,
  dodano `pobierzPrzegladLokalizacji(artykulGtIds)` + `ZGODNOSC`
  (❌/🆕/✅/—) — klasyfikacja per K4/K4G + "ogólna" wg priorytetu.
- `routes/produkty.js`: nowy `GET /api/produkty` (q/limit/offset) — łączy
  stany GT, lokalizacje WMS (`wms_k4`, `wms_k4g`, `k4g_razem`, `razem`) i
  zgodność. Błąd GT → 500 (bez degradacji, w odróżnieniu od ekranów Zebry).
- `public/desktop/`: nowa (pierwsza, domyślna) zakładka "Produkty" — tabela
  14 kolumn, wyszukiwanie SKU/EAN/nazwa, paginacja 50/stronę
  (`.tabela-wrapper`, `.paginacja` w `style.css`).
- Zweryfikowano na żywych danych GT (`/api/produkty?limit=5`, `?q=nerf`,
  `?offset=5`) i krzyżowo dla NERE0011 — K4 ✅ (M2-C7 zgodne), K4G ❌
  (WMS oczekuje M2-B27-P3, GT ma starą wartość) — zgodne z istniejącym
  `/api/produkty/NERE0011` (`zgodna: false`).

### ⚠️ Znalezisko: szum 🆕 dla towarów spoza K4/K4G

Przy teście na całym katalogu (92k towarów) trafił się przykład: towar
"Karnet z kopertą..." (kategoria niezwiązana z K4/K4G, stany K4=K4G=0) ma
`tw_Pole8 = "oprawa: folia"` — w tej kategorii Pole8 oznacza coś innego
(jak opisano w CLAUDE.md). Nasz klasyfikator widzi to jako "🆕 tylko w GT"
dla K4G, bo WMS nie oczekuje tam nic, a GT ma niepustą wartość.

CLAUDE.md zakładał, że to się "nie nakłada", bo towary bez stanu K4/K4G nie
mają znaczących wartości w tych polach — w praktyce mogą mieć (inne
przeznaczenie pola). Skala problemu nieznana — może dotyczyć dużej części
katalogu (książki, akcesoria, kartki itp.) i zaszumić kolumnę Zgodność
fałszywymi 🆕. Do oceny/decyzji w kolejnej sesji: czy ograniczyć 🆕 tylko do
towarów z `stany_gt.K4 > 0 || stany_gt.K4G > 0` (lub innym sygnałem "to
towar K4/K4G"), zamiast klasyfikować cały katalog.

## Krok 10b — filtry/sortowanie tabeli "Produkty"

Rozszerzenie kroku 10 o filtrowanie i sortowanie tabeli "Produkty" (desktop).

### Dwa tryby `/api/produkty`

- **`tryb: 'katalog'`** (domyślny, gdy filtr Zgodność wyłączony) — paginacja,
  sortowanie i filtrowanie magazynowe po stronie SQL na całym katalogu GT
  (jedno zapytanie agregujące `tw__Towar`/`tw_Stan`/`sl_Magazyn` z `GROUP BY`,
  `HAVING` dla filtra magazynowego, `OFFSET/FETCH`). `razem` liczone w SQL —
  bez osobnego wywołania `pobierzStanyGt`.
- **`tryb: 'zbior_wms'`** (gdy filtr Zgodność aktywny) — operuje na
  ograniczonym "zbiorze WMS" (`stany_gt.K4>0 OR K4G>0`, aktywne ∪ wszystko co
  WMS ma w `stany_lokalizacji`, ~2300-2400 towarów), liczy Zgodność dla
  każdego towaru i filtruje/sortuje/paginuje w Node (`pobierzProduktyZUniwersum`
  w `services/gt-produkty.js`).

### Nowe parametry `/api/produkty`

- `sort` — `sku|nazwa|ean|razem|k4|k4g|mag|ls`, `dir` — `asc|desc`.
- `magazyn` — lista kodów rozdzielona przecinkami (`K4,K4G,MAG,LS`) — produkt
  zostaje, jeśli ma stan > 0 w którymś z wybranych magazynów (`HAVING` w
  trybie katalog, filtr w Node w trybie zbiór WMS).
- `zgodnosc` — lista kodów `BD,t_GT,NZ,OK` — jeśli niepusta, aktywuje tryb
  `zbior_wms`. Pole zgodności sprawdzane zależy od wyboru magazynów: K4 bez
  K4G → `zgodnosc.k4`, K4G bez K4 → `zgodnosc.k4g`, w innych przypadkach
  (oba, żaden, albo tylko MAG/LS) → `zgodnosc.ogolna`.
- `pokaz_zablokowane=1` — domyślnie ukryte produkty z `tw_Zablokowany=1`
  (45804 aktywnych vs 92309 łącznie w całym katalogu GT).

Kombinacje filtrów dające zero wyników (np. `magazyn=LS&zgodnosc=NZ`) zwracają
po prostu pustą listę (`total: 0`) — zgodnie z zasadą "filtry zawsze widoczne
i zmienialne", bez specjalnych blokad UI.

### Recode `ZGODNOSC`

Krótkie kody zamiast emoji (też jako wartości filtra `zgodnosc`):
`NIEZGODNE → 'NZ'`, `TYLKO_GT → 't_GT'`, `ZGODNE → 'OK'`, `PUSTE → 'BD'`.
Logika klasyfikacji (`klasyfikujZgodnosc`, `PRIORYTET_ZGODNOSCI`) bez zmian.

### ⚠️ Rozwiązane: szum 🆕/`t_GT` dla towarów spoza K4/K4G

Zbiór WMS (tryb `zbior_wms`) jest z definicji ograniczony do towarów z
`stany_gt.K4>0 OR K4G>0` — towary jak "Karnet z kopertą" (K4=K4G=0,
`tw_Pole8` używane do czegoś innego niż lokalizacja) nigdy nie wchodzą do
zbioru i nie pojawiają się jako `t_GT` przy filtrowaniu po Zgodności
(zweryfikowane: `?q=Karnet&zgodnosc=NZ,OK,t_GT,BD` → `total: 0`). W trybie
`katalog` (bez filtra Zgodność) kolumna Zgodność nadal jest liczona dla
całego widocznego zakresu i taki szum tam pozostaje widoczny, ale nie wpływa
na żaden filtr/sortowanie.

### UI (desktop, panel Produkty)

- Checkbox "Pokaż zablokowane".
- Grupa checkboxów "Magazyn" (K4/K4G/MAG/LS, multi-select, `.filtr-grupa`).
- Grupa checkboxów "Zgodność" (BD/t_GT/NZ/OK, multi-select).
- Selecty sortowania: kolumna (`#prod-sort`) + kierunek ↑/↓ (`#prod-dir`).
- `prod-zakres` dopisuje " (zbiór WMS)" gdy odpowiedź ma `tryb: 'zbior_wms'`.
- Każda zmiana filtra/sortowania resetuje paginację (`prodOffset = 0`).

### Zweryfikowano (na żywych danych GT)

- `?limit=5` — `tryb: 'katalog'`, `total: 45804`.
- `?sort=razem&dir=desc&limit=5` — sortowanie po sumie stanów K4+K4G+MAG+LS
  działa (najwyższe `razem` na górze).
- `?magazyn=K4,K4G&limit=5` — `total: 2337` (zbiór towarów ze stanem w K4/K4G).
- `?pokaz_zablokowane=1` — `total: 92309` (45804 aktywnych + 46505
  zablokowanych = cały katalog).
- `?zgodnosc=NZ&limit=5` — `tryb: 'zbior_wms'`, `total: 1` (NERE0011, K4G NZ —
  zgodne z wcześniejszym ręcznym sprawdzeniem z kroku 10).
- `?zgodnosc=t_GT&magazyn=K4&limit=10` — wszystkie wiersze mają
  `zgodnosc.k4 === 't_GT'` (pole `k4` wybrane wg reguły K4-bez-K4G).
- `?magazyn=LS&zgodnosc=NZ` — pusta lista, `total: 0`, bez błędu.
- `?q=NERE0011` (katalog) vs `?q=NERE0011&zgodnosc=NZ,OK,t_GT,BD` (zbiór WMS)
  — identyczna `zgodnosc`/`lokalizacja_k4_gt`/`lokalizacja_k4g_gt` w obu
  trybach.
- `?q=Karnet&zgodnosc=NZ,OK,t_GT,BD` — `total: 0` (potwierdza rozwiązanie
  szumu 🆕/`t_GT` opisanego wyżej).

## Otwarte

- **MM przez Sferę — ✅ DZIAŁA (przetestowane na żywym GT 2026-06-14).** `WystawMmAsync`
  + logowanie (`Polacz`) w `SferaGtService.cs` wg modelu z `gta.chm`. Most stoi na
  maszynie Windows z GT+Sferą (`C:\Users\Mateusz\Desktop\GtBridge`), build x86
  self-contained. Szczegóły testu i fixów (STA, `Dodaj(-27)`) — dziennik 2026-06-14.
  Środowisko: Windows ze stroną kodową 1250 + PL, user SQL z VIEW SERVER STATE (sa ma).
- **Zapis lokalizacji — ✅ ZROBIONE (przetestowane na bazie testowej 2026-06-15).**
  `tw_Pole1` (K4) + `tw_Pole8` (K4G) zapisywane `UPDATE tw__Towar` bezpośrednim SQL-em
  z Node (`gt-fields.js synchronizujLokalizacje`, połączenie `sa`, bez mostu/Sfery).
  `pwd_Tekst09` (Lokalizacja Zapas) **całkowicie pomijane** — overflow ponad ~50 znaków
  K4G zostaje tylko w WMS. To świadome odejście od zasady nadrzędnej #1 z CLAUDE.md
  (pola lokalizacyjne nie są stanami). Test: artykuł 46226 (NERE0011) — `tw_Pole1`
  `"M2-C7  "`→`"M2-C7"`, `tw_Pole8` przeliczone na `"M2-B27-P3(2010)"` zgodnie z WMS.
  `gtBridge.zapiszLokalizacje`/`/api/lok` w moście C# usunięte z Node (martwe);
  `ZapiszLokalizacjeAsync` w C# zostaje nieużywanym stubem.
- **Pozostałe metody Sfery** (`PobierzStanyAsync`, `PobierzArtykulAsync`, `WystawRwAsync`,
  `WystawPwAsync`) — nadal szkielet. RW/PW (inwentaryzacja) do zrobienia analogicznie
  do MM, gdy MM się sprawdzi na Windows.
- **Tryb pracy mostu — DECYZJA (na później): start na kliknięcie użytkownika.**
  Chodzi o łatwy restart, gdy most się wysypie/zawiesi (np. po błędzie Sfery)
  — użytkownik ma móc go odpalić jednym kliknięciem, bez grzebania w konsoli/
  terminalu na Windows. (Dodatkowo: most trzyma sesję Sfery cały czas, dopóki
  proces żyje — `Polacz()` cache'uje `_subiekt`, zwalniane tylko przy
  `Dispose`/`Zakoncz` — więc start-na-żądanie pomaga też z licencją, ale to
  drugoplanowy powód.) Szczegóły (np. .bat/skrót na pulpicie, ewentualnie
  auto-restart) do dopracowania później.

## Plan — kolejne etapy (2026-06-15, ustalone z userem, jeszcze nie zaczęte)

Kolejność robocza (niekoniecznie priorytet), ustalona w rozmowie:

1. ~~**Zapis lokalizacji (Pole1/Pole8) bezpośrednim SQL**~~ — ✅ zrobione
   2026-06-15, opisane wyżej w "Otwarte".
2. **Baza lokalizacji z typami i ewentualnie wymiarami** — rozbudowa `lokalizacje`
   (dziś pewnie tylko kod/magazyn) o typ lokalizacji (np. regał/półka/paleta) i
   może wymiary (do walidacji co się gdzie zmieści?). Szczegóły do dopracowania.
3. **Log / historia zmian** — log audytowy zmian (kto/co/kiedy zmienił —
   lokalizacje, stany, dokumenty GT), do diagnostyki i rozliczalności.
4. **Przegląd zabezpieczeń / uprawnień WMS↔GT** — co WMS może, a czego **nie
   powinien** móc zrobić na bazie Subiekta (np. ograniczyć `sa` do potrzebnego
   minimum, osobny user SQL z węższymi prawami, walidacja po stronie Node przed
   zapisem). Do przemyślenia po zapisie lokalizacji, gdy będzie jasne co realnie
   piszemy do GT.
5. **Interfejs desktop dla użytkowników** — dziś desktop to głównie tabela
   kontrolna "Produkty" (read-only, dla admina). Potrzebny osobny,
   prostszy interfejs dla zwykłych użytkowników (jakie akcje, jaki zakres —
   do ustalenia).
6. **Most jako proces z ikoną w trayu (tray icon)** — preferencja usera
   (ustalone 2026-06-19): most ma działać jako proces z **ikoną przy zegarze**
   (system tray), gdzie jednym kliknięciem widać czy działa i można go
   zrestartować. **NIE** ukryta usługa Windows — user chce widoczny, sterowalny
   proces. Bonus: proces działa w sesji użytkownika, więc Sfera (COM) nie ma
   problemu z brakiem sesji (problem usługi Windows opisany przez kolegę).
   Alternatywa minimalna: po prostu otwarte okno konsoli też jest OK.
   Zastępuje wcześniejsze "Most na kliknięcie".
7. **Analityka magazynowa** — raporty/wskaźniki na bazie danych WMS+GT
   (np. rotacja, rozjazdy w czasie, wykorzystanie lokalizacji) — zakres do
   ustalenia.
8. **Postawienie w sieci na WiFi** — Node WMS + most razem na maszynie Windows
   z GT/Sferą (most zostaje na `localhost`, Node wystawia port 3000 na LAN dla
   Zebr/desktopów). Odłożone na razie.

### Dodatkowe punkty (ustalone 2026-06-15)

- **Backup `db/wms.db` — MUST HAVE.** To jedyne źródło prawdy dla lokalizacji
  WMS (GT to tylko odzwierciedlenie). Priorytet wysoki, niezależny od kolejności
  powyżej — zrobić jak najszybciej (np. prosty cron/skrypt kopiujący plik z
  rotacją).
- **WAŻNE — `Z_KAJTEK_IdeaERP` to baza TESTOWA**, nie produkcyjna/aktualna —
  ma taką samą strukturę jak realna, ale dane nie są "live". Dotychczasowe
  testy mostu (MM 180/2026, MM 316/2026) były więc na danych testowych, nie
  na żywej produkcji — bezpieczniejsze niż wcześniej zakładano. Do potwierdzenia:
  czy docelowo WMS ma się przełączyć na inną (prawdziwą produkcyjną) bazę, czy
  ta testowa zostaje "na zawsze" jako środowisko WMS.
- **Kontrolki połączenia / brak cichych porażek.** Jeśli zapis (MM, lokalizacja)
  się nie powiedzie, użytkownik musi to widzieć — np. wskaźnik stanu połączenia
  z mostem/GT w UI, i operacja (np. zamknięcie ekranu/procesu na Zebrze) nie
  powinna się "zamknąć"/zakończyć sukcesem, jeśli zapis faktycznie nie przeszedł.
- **Prosty mechanizm użytkowników/logowania** — dodawanie userów + logowanie,
  potrzebne m.in. do punktu 3 (log historii — kto co zmienił) i do punktu 5
  (interfejs dla zwykłych użytkowników).
- Punkt 4 (zabezpieczenia/uprawnienia) — wciąż do ustalenia, bez zmian.

### Z propozycji kolegi (gist, analiza 2026-06-19)

Kolega przysłał plan przejścia na C#/ASP.NET + React (MVP = moduł MM end-to-end).
Decyzja: **zostajemy na Node** (działający system), ale bierzemy z propozycji
rzeczy infrastrukturalne, niezależne od stosu:

- **Tailscale (VPN)** — zdalny dostęp do peceta/WMS bez wystawiania portów na
  świat. Czysty zysk, do wzięcia od ręki.
- **Login SQL least-privilege zamiast `sa`** — PILNE. Dziś łączymy się jako `sa`;
  zrobić dedykowany login `db_datareader` (+ `VIEW SERVER STATE` dla Sfery) na
  bazie testowej. Pokrywa się z punktem 4 powyżej.
- **Env-guard** — aplikacja przy starcie sprawdza nazwę bazy; odmawia startu, jeśli
  nie wskazuje na znaną bazę testową (ochrona "dev build trafił na prod").
- **deploy.ps1 / rollback.ps1** — skrypt jedno-klik: backup wms.db → build →
  podmiana → health-check → auto-rollback przy błędzie. Do zrobienia przy
  wdrożeniu na pecet.
- **Do zweryfikowania:** czy Sfera umie zapisać `Towar.Pole1/Pole8` (standardowe
  pola dodatkowe). Jeśli tak — można zamknąć direct-SQL dla lokalizacji bez
  rewrite'u, przez istniejący most. `pwd_Tekst09` (dynamiczne pole) to osobny,
  trudniejszy przypadek.
- **Rewrite na C# — odłożony.** Dobry kierunek długoterminowy (jeden język, brak
  mostu, brak direct-SQL), ale nie nagła konieczność dla działającego systemu
  solo-dev. Jeśli kiedyś robić, to dokładnie jak kolega: MVP MM na teście, Node
  żyje równolegle, cutover później jako osobna decyzja.

## Edytowalna tabela produktu — ZREALIZOWANE (2026-06-20, cd.)

Zastąpiliśmy zakładki MM/Lok jednym oknem z rozkładem towaru. Szczegóły w dzienniku
niżej (wpis "2026-06-20 (cd. — edytowalna tabela)"). Plan poniżej został wdrożony.

## Plan na kolejną sesję — edytowalna tabela produktu (zamiast zakładek MM/Lok)

Ustalone z userem 2026-06-20. Zmieniamy podejście do edycji w modalu produktu:
dziś są dwie zakładki (MM, Zmień lok.) z formularzami. Docelowo ma być **jedna
edytowalna tabela** pokazująca pełny rozkład towaru po magazynach i lokalizacjach.

### UX docelowy

1. **Na liście Produkty: jeden przycisk akcji** (zamiast dwóch [MM] [Lok]) —
   otwiera to samo okno/modal co teraz.
2. **W oknie: dane jako edytowalna tabela.** Przykład (produkt X, stan GT 180):
   ```
   Produkt X — stan GT 180

   K4
     lokalizacja | stan | rezerwacja
     A2          | 20   | 1
   K4G
     A3          | 60   | 0
     (nieprzypisano) | 100 |
     razem 160
   MAG
     brak | 0
   LS
     brak | 0
   ```
3. **Edycja w polach:**
   - Zmiana pola **lokalizacji** (np. A1 → A2) = działa jak zmiana lokalizacji (LOK).
   - Usunięcie/zmniejszenie **stanu** na lokalizacji → pojawia się info "wolne do
     przeniesienia"; zapis na inny magazyn = **MM**.
   - **Dodawanie nowej lokalizacji** (przycisk +): do rozbijania towaru na 2+
     lokalizacje, albo przypisania puli "(nieprzypisano)".
4. **"(nieprzypisano)"** = stan GT danego magazynu minus suma WMS (to dzisiejsze
   `modalLokNiezlok` / status NZ na K4G). Rozłożenie tej puli = LOK z lok_zrodlo_id=null.

### Otwarte pytanie (do decyzji na starcie sesji)

Czy edytujemy **inline w komórce** (klik w pole lokalizacji/stanu → edycja w miejscu),
czy dajemy **osobne kolumny "zmień"** dla lokalizacji i stanu?
- Rekomendacja: **inline w komórce** + jeden przycisk "Zapisz zmiany" na dole, który
  zbiera wszystkie edycje i wykonuje je jako serię ruchów (LOK/MM) — spójne z dzisiejszą
  "listą zbiorczą" w panelu MM. Mniej klikania niż osobne kolumny, czytelniejsze przy
  wielu lokalizacjach. Ryzyko: trzeba dobrze rozróżnić "zmiana lokalizacji" (LOK) od
  "przeniesienie ilości na inny magazyn" (MM) na podstawie tego, co user zmienił.

### Otwarte pytanie 2 — lokalizacja K4 z "zapasem" (połączona)

Przypadek brzegowy (user, 2026-06-20): czasem towar na K4 jest **wyjątkowo w dwóch
miejscach** — zbiór na półce (np. H10-P1), a nadmiar na innej (P5). W GT zapisywane
jako **`H10-P1/P5`** (lokalizacja połączona).

Kontekst: na K4 ilość WMS **nie jest autorytatywna** (rządzi GT, sprzedaż zmniejsza
GT bez WMS) → zgodność K4 jest tekstowa, nie ilościowa. Więc lokalizacja K4 to raczej
"wskaźnik gdzie leży", nie licznik per półka.

**DECYZJA (user, 2026-06-20): idziemy w wariant A.**

- **A (WYBRANE): lokalizacja K4 + opcjonalne pole "zapas" (adnotacja).** Jedna
  realna lokalizacja zbioru + krótki "zapas" (P5), składane w GT jako `H10-P1/P5`.
  WMS nie dzieli ilości na dwa liczniki. 1 SKU = 1 miejsce zbioru zostaje; "/P5" to
  podpowiedź o nadmiarze. W edytowalnej tabeli: komórka "lokalizacja" + opcjonalna
  "zapas". Tanie, zgodne z modelem i notacją GT.
- ~~B: dwa wpisy K4 z ilościami~~ — odrzucone (łamie prostotę "jedno miejsce",
  korzyść wątpliwa skoro ilość K4 nie jest rozliczana per lokalizacja).

Do przemyślenia przy implementacji A:
- Gdzie trzymać "zapas" — najprościej dodatkowe pole przy lokalizacji K4 SKU
  (np. kolumna w `stany_lokalizacji` dla wpisu K4, albo osobny lekki zapis).
- Składanie `tw_Pole1` = `zbior/zapas` (gdy zapas pusty → samo `zbior`).
- Poluzować regułę "1 SKU = 1 lokalizacja K4", ale tylko o pole zapasu (nie o
  drugą pełną lokalizację).
- "/" jako separator zbiór/zapas — uważać przy parsowaniu starych wpisów GT.

Uwaga: backend ma twardą regułę "1 SKU = 1 lokalizacja K4" (`routes/ruchy.js` ~72-90,
+ analogiczne w `/lok` i `/przyjecie`) — przy każdym wariancie trzeba ją poluzować
dla pola "zapas".

### Co reużyć

- Backend gotowy: `POST /api/ruchy/lok` (zmiana lokalizacji + pierwsze/dodatkowe
  przypisanie z `lok_zrodlo_id=null`), `POST /api/ruchy/mm` + `/przyjecie` +
  `/mm-zewnetrzny`. Logika "(nieprzypisano)" = stan GT − suma WMS już policzona we
  froncie (`modalLokNiezlok`) i w backendzie (zgodność K4G ilościowa).
- `GET /api/lokalizacje/k4-dom/:artykul_gt_id` — stałe miejsce K4 (też puste).
- `GET /api/lokalizacje/artykul/:symbol` — lokalizacje WMS z zapasem.
- Combo z wyszukiwaniem (`ustawDatalist`/`lokComboId`) — do pól lokalizacji w tabeli.
- "Pozostanie na lokalizacji" (`aktualizujPozostanie`) — do walidacji rozbijania ilości.

## Dziennik zmian

### 2026-07-02 — most z ikoną w trayu + git na Windows + jedno-klik aktualizacja (Faza C#9)

Most przestał być „oknem konsoli, którego trzeba szukać" — jest aplikacją z ikoną przy zegarze,
a jego aktualizacja to jeden klik zamiast kopiuj-wklej plików.

- **Ikona w trayu** (`bridge/GtBridge/Tray/TrayIkona.cs`, `Services/StanMostu.cs`): kolor = stan
  ostatniej operacji GT (szary start / zielony OK / czerwony błąd), dymek = „Most WMS :5000 …".
  Menu: Testuj połączenie z GT (`TestPolaczeniaAsync` — Polacz bez wystawiania dok.), Restart
  mostu (zwalnia :5000 przed startem nowej instancji), Pokaż log (konsola na wierzch), Zamknij.
  `Program.Main` [STAThread]: `host.Start()` nieblokująco + `Application.Run(tray)`.
  csproj: `UseWindowsForms=true` (konsola zostaje). Zbudowane i uruchomione na Windows — ikona OK.
- **Git na pececie** (koniec kopiuj-wklej): sklonowano repo do `C:\Users\Mateusz\Desktop\was`
  (git 2.38, login przez przeglądarkę). `appsettings.json` z hasłami: `skip-worktree` (pull go
  nie rusza; w repo pusty szablon). Most budowany/uruchamiany z klona `...\was\bridge\GtBridge`.
- **Jedno-klik aktualizacja** (`bridge/aktualizuj-most.cmd` → `aktualizuj-most.ps1`): dwuklik →
  taskkill → `git pull --ff-only` → `dotnet publish -r win-x86` → start nowego exe. Ścieżki
  względem pliku (`$PSScriptRoot`), więc działa niezależnie od miejsca klona.
- **Konsola w tle** (dokończone tego samego dnia): most startuje jako sama ikona — konsola
  UKRYTA na starcie, a jej krzyżyk (X) wyłączony (`GetSystemMenu`+`DeleteMenu` SC_CLOSE), żeby
  pokazana konsola nie dała się przypadkiem zamknąć i ubić proces. Menu: „Pokaż log" / „Ukryj
  log" steruje jej widocznością; wyjście tylko przez „Zamknij most". Rozwiązuje wpadkę „zamknąłem
  okno i most padł".
- **Autostart** (w toku): most czyta `appsettings.json` też z katalogu `.exe`
  (`AppContext.BaseDirectory`, nie tylko CWD) — żeby start z Autostartu/Harmonogramu nie zgubił
  haseł. Metoda: skrót do `publish\GtBridge.exe` w folderze `shell:startup` (sesja użytkownika —
  Sfera COM tego wymaga, NIE usługa Windows). Wstaje jako sama ikona.
- **Do zrobienia (szlif):** Tailscale (dostęp zdalny) — osobny krok. **Gdy Node przejdzie na
  Windows (Faza C):** autostart obejmie też Node, a Tailscale da zdalny dostęp do całości.

### 2026-07-02 — prewencja duplikatów MM + Uwagi kto/kiedy + brak cichych porażek (Faza A#3 domknięta)

Domknięcie gwarancji numeru MM: do tej pory mieliśmy WYKRYWANIE duplikatów (reconciliacja),
teraz jest też PREWENCJA — przy zgubionej odpowiedzi HTTP ponowienie NIE wystawia drugiego MM.

- **Klucz idempotencji w `dok_Uwagi`.** Most C# wpisuje do Uwag wystawianego dokumentu MM gotowy
  tekst z Node: `WMS-RUCH:<id> | <operator> | <czas>` (np. `WMS-RUCH:123 | Jan Kowalski |
  02.07.2026 11:45`). Cały format buduje Node (`services/gt-dokumenty.js budujUwagiMM`), most
  tylko zapisuje string (`SferaGtService.WystawMmAsync` → `dok.Uwagi`). Czas z `data_ruchu`
  (realny moment przesunięcia, strefa Europe/Warsaw), NIE z chwili wystawienia — ważne przy MM
  ponowionym po godzinach. `MmRequest.RuchId`→`Uwagi`; mock loguje `uwagi`.
- **Sprawdzenie przy ponowieniu.** `services/ruchy-gt.js`: gdy `mm_proby > 0` (ruch już
  próbowany), przed wysłaniem MM Node szuka w GT dokumentu z kluczem (`znajdzMMpoKluczu` —
  `dok_Uwagi LIKE 'WMS-RUCH:<id> |%'`, separator ` |` odcina 12 vs 123). Znaleziony → adoptuje
  numer + `dok_Id` zamiast wystawiać drugi. GT SQL niedostępny → NIE wystawia (bezpieczniej
  wstrzymać niż zdublować; Sfera i tak zwykle pada razem z SQL). Pierwsza próba (`mm_proby=0`)
  pomija skan GT (dokument nie może jeszcze istnieć — happy-path bez obciążania `dok__Dokument`).
- **Blokada in-flight per ruch** (`Set` w `ruchy-gt.js`): POST /mm i job ponawiania (co 5 min)
  mogłyby zbiec się na tym samym `pending` ruchu (oba czytają `mm_proby=0` i wystawiają dokument).
  Jeden proces Node → Set w pamięci wystarcza; drugi równoległy zwraca aktualny stan.
- **Migracja:** kolumna `ruchy.mm_proby INTEGER NOT NULL DEFAULT 0` (licznik prób, rośnie tuż
  przed wywołaniem mostu). `dok_gt_id` dopisane też do `001_init.sql` (świeże instalacje).
- **„Brak cichych porażek" (Zebra `ruch.js` + `app.css`).** MM (`/mm`, `/przyjecie`,
  `/mm-zewnetrzny`) niepotwierdzony w GT (`status !== 'ok'`) NIE pokazuje zielonego sukcesu —
  pomarańczowy ekran ostrzeżenia (ikona ⏳, inny dźwięk, „NIE potwierdzone w GT — oczekuje.
  Zapisane w WMS, zostanie ponowione."). LOK bez zmian (nie tworzy dokumentu — `pending` to tylko
  zaległy sync pól, zmiana WMS autorytatywna → miękki dopisek „· GT: oczekuje", zielony sukces).
- **Zweryfikowano:** parser czasu (UTC→PL lato/zima), fallback operatora „WMS", dopasowanie
  prefiksu (12≠123), migracja `mm_proby` (świeża + stara baza), overlay ostrzeżenia w podglądzie
  (kolor `rgba(146,64,14)`, ikona ⏳, `white-space: pre-line`).
- **✅ POTWIERDZONE NA ŻYWO (2026-07-02):** przebudowano most na Windows (`dotnet publish
  -r win-x86 --self-contained`), test MM → w Uwagach dokumentu `WMS-RUCH:121 | Mateusz |
  02.07.2026 16:58` (ruch 121 = MM 334/2026, 10 szt). `znajdzMMpoKluczu(121)` znalazł dokument
  po kluczu — pełny łańcuch prewencji duplikatów działa. Właściwość `Uwagi` w Sferze — OK.

### 2026-07-02 — kody bez myślnika (stare naklejki) + ślad „nie znaleziono"

- **Odczyt kodów bez myślnika** (obejście do czasu wymiany naklejek): `A8P2` czytane jak
  `A8-P2`. `services/lokalizacje-model.js` `normalizujKodLokalizacji(kod)` — usuwa myślniki/
  spacje, składa kanonicznie (`M2A8P2`→`M2-A8-P2`); kody spoza wzorca (RB, BIURO, SKU, EAN)
  bez zmian. Wpięte w `GET /api/lokalizacje/skan/:kod` (lookup WMS + `szukajPoLokalizacjiGt`
  po znormalizowanym kodzie; GT trzyma kod z myślnikiem, więc dla znalezionej lok. używam
  `lokalizacja.kod`) i `GET /api/lokalizacje/kod/:kod`. Zweryfikowane po HTTP: `A1P2`→`A1-P2`.
- **Ślad przy „nie znaleziono"**: skan/wpis, który nic nie znalazł, ZOSTAJE w polu (zaznaczony,
  by kolejny skan go zastąpił) i pokazuje się w komunikacie „Nie znaleziono: „<kod>"".
  `public/zebra/ruch.js` (`wykonajSkan` + tryb „szukaj") i `public/zebra/produkty.js`.
  Zweryfikowane w przeglądarce (Zebra ruch: pole=`ZZ99P9`, komunikat z kodem).

### 2026-07-02 — RESET mapy lokalizacji + import na świeżo z pliku (Faza B#5 wykonana)

Wyczyszczenie testowej mapy i wgranie realnej mapy z `~/Documents/lokalizacje-do-importu.xlsx`
(arkusze K4 + K4G). Produkty wróciły do statusu „tylko GT" — magazynier przypisze skanem.

- **Backup przed operacją**: `db/wms-przed-resetem-20260702-022150.db` (zachowany).
- **Usunięto**: 95 lokalizacji, 36 `stany_lokalizacji` (przypisania → produkty `t_GT`),
  23 `plan_lokalizacji`, 5 `rozjazdy`. **Historia zachowana**: `ruchy` (107) + `audyt`
  zostają — odpięto tylko `ruchy.lok_zrodlo_id/lok_cel_id` (FK do kasowanych lokalizacji;
  `stany_lokalizacji` i `ruchy` referują `lokalizacje(id)`, `foreign_keys=ON`).
- **Zaimportowano 1948 lokalizacji**: K4 = 855, K4G = 1093. Typy: paleta 1218 · polka 396 ·
  trawers 332 · inny 2 (RB, BIURO). Cechy strukturalne wyliczone `rozbierzKod` przy insercie.
- **⚠️ Błąd w źródle**: 10 kodów `E2-P4`…`E11-P4` było w OBU arkuszach (K4 i K4G). Kod jest
  globalnie unikalny; wg reguły E–J=półki na K4 → przypisane do K4, duplikaty K4G odrzucone
  (stąd K4G=1093, nie 1103). Do ewentualnej poprawki w arkuszu.
- Jeden wpis audytu `reset_import_lokalizacji` (liczby). Operacja jednorazowym skryptem
  (usunięty po wykonaniu — destrukcyjny, nie zostaje w repo).
- **Nie zaimportowano** arkuszy „Luki" (67, do weryfikacji przejść) i „Do ręki" (21, do
  ujednolicenia) — to nadal otwarte (zob. mapa-lokalizacji: pozostaje weryfikacja luk + długości regałów).

### 2026-07-02 — kolejność listy lokalizacji jak w pliku mapy

- `GET /api/lokalizacje` sortuje `ORDER BY magazyn, (hala IS NULL), hala, regal, kolumna, kod`
  zamiast tekstowego `ORDER BY kod` (który dawał A1, A10, A11, A2…). Teraz: A1, A2, … A10,
  A11 … B…, C…, a **M2 po hali 1**; grupy K4→K4G jak arkusze w xlsx; „inny" (bez struktury)
  na końcu magazynu. Kolumna liczbowa `kolumna` daje sort numeryczny, `kod` domyka poziom
  (A1, A1-P2, A1-P3). Front renderuje w kolejności z endpointu (bez własnego sortu).

### 2026-07-02 — poprawka reguły typów + ręczna edycja typu

User skorygował reguły `typ` (moja poprzednia wersja z xlsx była błędna):
- **K4G = zawsze paleta** (to lokalizacje paletowe od poziomu P2 — cały magazyn).
- **trawers = paleta dzielona na pół wysokości** (podstawa + P1) → regały **C,D,K** na K4.
- **półka = tylko K4 hala 1, regały E–J**; **M2 nie ma półek** → E–J na M2 = trawers.
- Reguła: `typ = f(magazyn, hala, regał)` (poziom nie wchodzi). `services/lokalizacje-model.js`:
  `rozbierzKod(kod, magazyn)` — magazyn wpływa TYLKO na typ.
- Rozkład na realnych 1958 kodach: K4 = 125 paleta / 332 trawers / 396 polka / 2 inny;
  K4G = 1103 paleta. Kolumna „Typ" w xlsx (stara reguła) — nieużywana.
- **Ręczna edycja typu** (`PUT /api/lokalizacje/:id {typ}` — nadpisanie reguły; walidacja
  ∈ {paleta,trawers,polka,inny}; audyt przed/po). Desktop: dropdown w kolumnie „Typ" →
  dropdown → zapis. Edycja kodu bez `typ` = przeliczenie regułowe.
- Zweryfikowano: parser na 1958 kodach (rozkład wyżej), re-derive 45 wierszy testowych,
  override typ + walidacja + audyt + przeliczenie przy edycji kodu (przez serwer).

### 2026-07-01 — import zbiorczy lokalizacji (desktop, Faza B#5)

Przygotowanie desktopu pod wgranie mapy lokalizacji (~855 K4 + ~1103 K4G z
`~/Documents/lokalizacje-do-importu.xlsx`, zob. [[mapa-lokalizacji]]).

- **Backend `POST /api/lokalizacje/import`** (`routes/lokalizacje.js`) — body
  `{ lokalizacje: [{kod, magazyn}], podglad?, operator? }`. Idempotentny: istniejący
  `kod` pomijany (bez nadpisania); walidacja `magazyn ∈ {K4,K4G}`, trim/uppercase,
  dedupe w paczce, puste linie ignorowane. `podglad:true` tylko liczy (nic nie
  zapisuje). Zapis w jednej transakcji (`db.exec('BEGIN'/'COMMIT'/'ROLLBACK')` —
  `node:sqlite` nie ma `db.transaction()`) + **jeden** wpis audytu `import_lokalizacji`.
  Zwraca `{dodane, pominiete, bledy:[{kod,powod}]}`. Reguły w backendzie (CLAUDE.md #5).
- **UI desktop** (panel Lokalizacje) — `<details>` „Import zbiorczy": textarea (kod
  na linię, wklejasz kolumnę z arkusza K4/K4G), wybór magazynu, „Podgląd" (ile
  nowych/pominiętych/błędnych zanim cokolwiek zapisze) → „Importuj" (aktywne dopiero
  po udanym podglądzie; zmiana tekstu/magazynu wymusza ponowny podgląd).
- **Zweryfikowano end-to-end** (żywy serwer + token sesji): podgląd (dedupe/lowercase/
  zły magazyn/puste linie), realny import 2 szt., idempotencja (ponowny → pominięte),
  audyt. Testowe kody i sesje sprzątnięte, baza z powrotem na 45 lok. testowych.
- **NIE ruszono danych.** Faktyczny wipe testu (29/45 lok. ma powiązane
  `stany_lokalizacji` — trzeba czyścić oba poziomy) + import realnej mapy = osobny,
  świadomy krok, gdy mapa będzie finalna (wg [[mapa-lokalizacji]]: 67 luk + 21 „do ręki").

**Cechy strukturalne lokalizacji (ten sam dzień, cd.):** tabela `lokalizacje`
rozszerzona o `hala`/`regal`/`alejka`/`strona`/`kolumna`/`typ` — do
filtrowania/raportów „na przyszłość". Poziom (`-P<n>`) NIE jest osobną kolumną
(wynika z kodu) — usunięty po uwadze usera; parser nadal rozpoznaje kody z poziomem.

- **Parser `services/lokalizacje-model.js`** (`rozbierzKod`) — deterministyczny,
  wylicza cechy z samego kodu (`[M2-]<REGAL><KOL>[-P<n>]`). Reguły potwierdzone na
  danych (arkusz `lokalizacje-do-importu.xlsx` ma te kolumny policzone): regał→alejka/
  strona (A,B→1 · C,D→2 … K,L→6; nieparzysta='a', parzysta='b'); **typ = f(hala,regał)**:
  hala 1: A,B,L=paleta · C,D,K=trawers · E–J=polka; M2: A,B,C,D=paleta · E–J=polka
  (w M2 C,D to paleta, nie trawers!); RB/BIURO/śmieci=`nazwana`. **Zwalidowano parser
  na wszystkich 1958 kodach z xlsx → 1958/1958 zgodne** z policzonymi kolumnami.
- **Migracja + backfill** (`db/database.js`) — ALTER TABLE + przeliczenie istniejących
  45 wierszy z ich kodu; indeksy `idx_lok_typ`, `idx_lok_alejka`. `001_init.sql`
  zaktualizowany dla świeżych instalacji.
- **Endpointy** — import, `POST /` (dodaj 1) i `PUT /:id` (edycja kodu) wypełniają/
  przeliczają cechy przez `rozbierzKod`. Podgląd importu zwraca rozbicie `typy` (ile
  paleta/trawers/polka/nazwana wejdzie).
- **Desktop** — tabela Lokalizacje pokazuje kolumny Typ (kolorowa plakietka)/Hala/
  Alejka·strona; podgląd importu pokazuje rozbicie typów.
- **Zweryfikowano** — parser 1958/1958, migracja+backfill 45 wierszy, import przez
  serwer (typy: C5→trawers, E7-P3→polka, BIURO→nazwana, istniejące pominięte), GET
  zwraca nowe pola, tabela desktop renderuje kolumny. Dane testowe sprzątnięte (45 lok.).

### 2026-06-20 (cd. 2 — okno akcji, inline edycja, dopracowania)

- **Akcja w osobnym oknie** — „Przenieś"/„Przypisz" otwiera overlay na wierzchu modalu
  produktu (z-index 1100), zamiast doklejać panel na dole. Nagłówek: typ + `SKU nazwa —
  z <źródło>`. Pola w jednym rzędzie (Magazyn | Ilość | Lokalizacja). Błędy walidacji
  w oknie akcji, sukces → komunikat na modalu produktu.
- **Inline zmiana lokalizacji** w tabeli rozkładu: klik w komórkę „Lokalizacja" →
  combo (lokalizacje tego samego magazynu) → wybór → LOK od razu (cała ilość wiersza).
  Kropkowane podkreślenie jako podpowiedź. Wpisanie nieistniejącego kodu → błąd
  „Lokalizacja … nie istnieje w systemie" (zamiast cichego powrotu). Esc/brak zmiany
  → revert. Tylko gdy stan > 0.
- **Reguła domyślnego magazynu w „Przenieś"**: źródło K4 → domyślnie K4G, źródło K4G
  → domyślnie K4 (pętla uzupełniania/odkładania); zewnętrzny → K4G. Po wydzieleniu
  zmiany lokalizacji do inline, „Przenieś" służy głównie do przesunięć ilości / MM.
- **Pole „zapas" K4 z podpowiedziami** — combo z listą lokalizacji K4 (datalist),
  z możliwością wpisania własnego kodu (to adnotacja nadmiaru, nie musi być formalną
  lokalizacją).
- **Fix `.brak-pola` zawsze widoczne** — `.brak-pola` (display:inline-block) wygrywało
  z `.hidden`; dodano `.brak-pola.hidden { display:none }`. Teraz „brak pola" tylko
  dla magazynu zewnętrznego.

### 2026-06-20 (cd. — edytowalna tabela produktu)

Przebudowa modalu produktu wg makiety usera (Wariant A → finalnie układ tabelaryczny).

- **Jeden przycisk „Edytuj"** na liście Produkty (zamiast [MM] [Lok]). Modal pokazuje
  pełny rozkład; akcje wykonuje się per wiersz.
- **Modal = jedna tabela:** `Magazyn | Stan | Lokalizacja | Zapas | (akcja) | Ost. edycja`.
  Stan z rezerwacją inline `20(2)` (rezerwacja na poziomie magazynu). Podsumowania
  „{mag} razem", „Razem" (suma GT), „Rezerwacje". Nagłówek: `Status: <zgodność ogólna>`.
- **Wspólny panel akcji** (przenieś/zmień/przypisz) zamiast osobnych formularzy MM/Lok.
  Dobór operacji automatyczny: ten sam magazyn WMS lub przypisanie z GT → LOK;
  między magazynami → MM (`mmBudujPayload`: /mm, /przyjecie, /mm-zewnetrzny).
  „Na źródle → pozostanie" liczone z dostępnej ilości.
- **Pole „zapas" K4 (decyzja A) — funkcjonalne.** Kolumna Zapas edytowalna dla K4;
  zapis przez `PUT /api/lokalizacje/k4-zapas/:id` → składa `tw_Pole1` jako `zbiór/zapas`
  (np. `A1/P5`). Migracja: kolumna `zapas_kod` w `stany_lokalizacji`; `obliczPolaLokalizacji`
  składa zbiór/zapas; nie dzieli ilości.
- **Plan lokalizacji z GT (K4 i K4G)** — `plan_lokalizacji (artykul_gt_id, magazyn, tekst)`.
  Gdy coś jest nieprzypisane, przy pierwszym otwarciu zapamiętujemy oryginalny tekst
  lokalizacji GT i pokazujemy go jako ściągę na wierszu „(nieprzypisano)" — żeby przy
  rozkładaniu np. 3 lokalizacji nie zgubić pozostałych po nadpisaniu pola GT przez WMS.
  Czyszczony, gdy wszystko zlokalizowane. Endpointy `GET/PUT /api/lokalizacje/plan/:id`.
- **Data ostatniej edycji** dodana do odpowiedzi `/artykul/:symbol` i `/k4-dom`.
- **Fix: badge zgodności = `ogolna` wszędzie** (lista i modal) + filtr zgodności po
  `ogolna`. Wcześniej lista pokazywała wymiar zależny od filtra magazynu → rozjazd
  „lista OK / modal NZ" dla NERE9533 (K4 OK, K4G NZ). Teraz spójne, naprawia też
  stary „filtruję BD a widzę t_GT".
- **UX wyciszony (oczopląs):** „(nieprzypisano)"/niezgodność w bursztynie zamiast
  czerwieni (czerwień tylko realny błąd), panel akcji stonowany, mniej ramek, cache
  statyków wyłączony (`no-cache`) by zmiany były od razu widoczne.

### 2026-06-20

Sesja testów MM/lokalizacji na żywym moście + UX panelu Produkty:

- **Zapis lokalizacji bez mostu — potwierdzony w boju.** `synchronizujLokalizacje`
  robi `UPDATE tw__Towar` przez SQL (bez Sfery). Wymagał restartu serwera po
  poprzedniej sesji (stary kod w pamięci Node).
- **MM przez most z Maca** — działa po: ustawieniu `GT_BRIDGE_URL=http://192.168.0.200:5000`
  w `.env` (Node na Macu, most na Windows) i zmianie `Program.cs` mostu na
  `UseUrls("http://0.0.0.0:5000")` (nasłuch na LAN, nie tylko localhost) +
  reguła firewalla na porcie 5000. Na produkcji (Node+most na jednym pececie)
  zostanie localhost.
- **LOK na K4 poprawione:** zniesiono wymóg "całej ilości"; ilość brana z GT
  (sprzedaż w Subiekcie zmienia stan bez WMS); transakcja czyści stare wpisy K4.
- **Pierwsze i dodatkowe przypisanie lokalizacji** w modalu "Zmień lok.": źródło
  "↪ z GT (niezlokalizowane)" pozwala rozkładać stan, który jest w GT a nie ma
  jeszcze lokalizacji WMS (wysyłka `lok_zrodlo_id=null`). Z limitem (nie więcej
  niż niezlokalizowano) i auto-wyborem gdy towar tylko w GT.
- **Zgodność K4G = ilościowa** (`services/gt-fields.js` `pobierzPrzegladLokalizacji`):
  Σ WMS K4G vs stan GT K4G (mag 8). Różnica → NZ (część niezlokalizowana/nadmiar),
  równe + pole za krótkie → OF, równe + tekst OK → OK, nic w WMS + jest w GT → t_GT.
  K4 zostaje porównaniem tekstu (ilość K4 zmienia się przez sprzedaż — to normalne).
  Nowy status **OF** (Obcięte) — zielony, nie błąd.
- **UX panelu Produkty:**
  - Lokalizacje: każdy wpis w osobnej linii, bez zawijania w środku wpisu
    (`komorkaLok` + `.lok-wpis`); stare wpisy GT z separatorem `/` zostają jak są.
  - Szerszy layout (`max-width: min(1600px,96vw)`), mniejszy padding komórek.
  - Badge zgodności pokazuje wymiar zgodny z filtrem magazynu (tylko K4 → k4,
    tylko K4G → k4g, inaczej ogólna) — koniec "filtruję BD a widzę t_GT".
- **Pola lokalizacji = combo z wyszukiwaniem** (input + datalist) we wszystkich
  formularzach MM/Lok — wpisywanie zawęża listę (przy dziesiątkach lokalizacji).
  Walidacja kod→id (`lokComboId`), "z listy" przy błędzie.
- **"Pozostanie na lokalizacji"** — dynamiczny wiersz pod ilością (stan źródła −
  wpisana ilość; czerwony gdy ujemne).
- **Cel = K4 podpowiada stałe miejsce** (`/k4-dom`) z info "Na K4: N (rez M)".
- **Naprawione buggi:** stale pool w `gt-sql.js` (odrzucona obietnica cache'owana
  na zawsze → reset przy błędzie), `st_TwId`→`st_TowId`, typ id (SQLite tekst vs
  SQL Server liczba) w sumach K4G, cache przeglądarki (`no-cache` w HTML),
  `data-tab` na modal-tab-content, null-source crash w `ruchy-gt.js`,
  migracja `mag_zrodlo_zewnetrzny`.
- **Decyzja: most jako tray icon, nie usługa Windows** (widoczny, restartowalny,
  proces w sesji usera = brak problemu COM/Sfery bez sesji).
- **Analiza propozycji kolegi (gist)** — zostajemy na Node, bierzemy Tailscale +
  login least-privilege + deploy.ps1; rewrite C# odłożony (sekcja wyżej).

### 2026-06-15 (cd.)

- **Zapis lokalizacji przez SQL — zaimplementowane i przetestowane.**
  `services/gt-fields.js`: `synchronizujLokalizacje` zamiast wołać most
  (`gtBridge.zapiszLokalizacje`/`/api/lok`) robi `UPDATE tw__Towar SET
  tw_Pole1=..., tw_Pole8=...` przez istniejące połączenie SQL (`gt-sql.js`,
  user `sa`) - bez Sfery/mostu. `pwd_Tekst09` ("Lokalizacja Zapas") nadal
  pomijane. Kształt wyniku (`{ok, dane:{sukces}}` / `{ok:false, blad}`)
  zachowany, więc `ruchy-gt.js`, `routes/inwentaryzacja.js`,
  `routes/rozjazdy.js` działają bez zmian. Usunięto martwy kod:
  `gtBridge.zapiszLokalizacje` z `services/gt-bridge.js` (import `gtBridge`
  w `gt-fields.js` też usunięty). `ZapiszLokalizacjeAsync` w C# (most)
  zostaje nieużywanym stubem.
  - **Test na żywo (baza testowa Z_KAJTEK_IdeaERP):** artykuł 46226 (NERE0011),
    `synchronizujLokalizacje(46226, {K4, K4G})` → `{ok:true, dane:{sukces:true}}`.
    `tw_Pole1` `"M2-C7  "` → `"M2-C7"`, `tw_Pole8` `"M2-B27-B34-P4/M2-C13-15-P4/  "`
    → `"M2-B27-P3(2010)"` (zgodnie z aktualnym stanem WMS). Działa z Maca, bez
    mostu na Windows.

### 2026-06-14

- **Most MM przez Sferę — implementacja** (`bridge/GtBridge`). Na podstawie modelu
  obiektowego wyciągniętego z `gta.chm` (InsERT GT dla aplikacji 1.0):
  - `SferaGtService.Polacz()` — logowanie przez `InsERT.GT`: `Produkt=1` (Subiekt),
    `Autentykacja=0` (mieszana), Serwer/Baza/Uzytkownik/UzytkownikHaslo/Operator,
    hasła szyfrowane w runtime przez `InsERT.Dodatki.Szyfruj`, uruchomienie dedykowanej
    instancji w tle `Uruchom(2, gtaUruchomNowy|gtaUruchomWTle = 6)`.
  - `SferaGtService.WystawMmAsync()` — `Subiekt.Dokumenty.DodajMM()`, ustawienie
    `MagazynNadawczyId`/`MagazynOdbiorczyId` (dowolny kierunek K4/K4G/MAG/LS),
    `Pozycje.Dodaj(tw_Id)` + `IloscJm`, `StatusDokumentu=1` (Wywolany), `Zapisz()`,
    odczyt `NumerPelny`. Błędy COM mapowane na czytelne komunikaty (brak towaru
    0x80040F60, brak licencji Sfery, zła strona kodowa itd.) → zwracane w
    `DokumentResponse.Blad` (ruch zostaje `pending`, nie ginie).
  - `Dispose` zamyka aplikację przez `Zakoncz()`.
  - `SferaOptions`/`appsettings.json` — `ProgId="InsERT.GT"`, dodane
    `Uzytkownik`/`UzytkownikHaslo` (SQL, jawne — szyfrowane w runtime).
  - `MmRequest` — dodane `magazyn_zrodlowy_id`/`magazyn_docelowy_id` (mag_Id GT).
  - Node: `config/magazyny.js` — `gtId` per magazyn (K4=4, K4G=8, MAG=1, LS=6,
    z `sl_Magazyn`) + `MAGAZYN_GT_ID`; `gt-bridge.js`/`ruchy-gt.js` rozwiązują
    symbol→mag_Id i wysyłają id do mostu.
  - **Fix STA (z pierwszego testu na żywym GT):** Sfera (COM automation) wymaga
    wątku STA. Wątki ASP.NET Core są MTA → tworzenie obiektu COM zwracało
    `0x8000FFFF E_UNEXPECTED` ("katastrofalny błąd"). `SferaGtService` przerobiony:
    cała praca z COM (tworzenie + użycie + Zakoncz) idzie na jeden dedykowany
    wątek STA (`BlockingCollection` + `NaWatkuSta`), który zarazem serializuje
    wywołania (zastąpił `lock`).
  - **Fix nazwy metody (z testu):** `Subiekt.Dokumenty` to kolekcja `SuDokumenty`
    (nie ma `DodajMM`). MM tworzy się przez `Dokumenty.Dodaj(gtaSubiektDokumentMM)`,
    gdzie `gtaSubiektDokumentMM = -27` (0xFFFFFFE5). Poprawione.
  - **✅ PRZETESTOWANE NA ŻYWYM GT (2026-06-14).** Build x86 self-contained,
    most startuje (env Production = prawdziwa Sfera). Test MM 1 szt K4→K4G dla
    towaru 4180 (PANBAT02475): zwrócił `sukces:true`, `numer "MM 180/2026"`;
    zweryfikowano w bazie — stany realnie ruszyły (K4 26→25, K4G 0→1), dokument
    MM 180/2026 istnieje. Most MM działa end-to-end.
  - **Wnioski środowiskowe (Windows):** PowerShell `Invoke-RestMethod` szło przez
    systemowe proxy (502 na localhost) — testować klientem z `UseProxy=$false`
    (Node tego nie dotyczy). Build/run: `dotnet publish -c Release -r win-x86
    --self-contained` + uruchamiać `...\publish\GtBridge.exe` (runtime w środku,
    omija brak x86 runtime).

### 2026-06-15

- **Cofnięcie testowego MM (K4G→K4, 1 szt, towar 4180/PANBAT02475)** — drugi
  test mostu, w odwrotnym kierunku niż 2026-06-14. Zwrócił `sukces:true`,
  `numer "MM 316/2026"`. Zweryfikowano w bazie: K4 25→26, K4G 1→0 (powrót do
  stanu wyjściowego), dokument MM 316/2026 istnieje. **Most MM potwierdzony
  w obu kierunkach** — uznajemy temat MM za zamknięty, kolejne kroki:
  zapis lokalizacji (SQL) i RW/PW.

### 2026-06-12

- **Fix wyszukiwania po nazwie (ekran MM, Lokalizowanie, Inwentaryzacja)** —
  wpisanie fragmentu nazwy (np. "nerf") wcześniej czasem przeskakiwało wprost do
  jednego artykułu/lokalizacji, gdy trafiało w dokładnie 1 wynik. Teraz zawsze
  pokazuje listę dopasowanych artykułów do wyboru (nawet z 1 pozycją).
  - `routes/lokalizacje.js` (`/api/lokalizacje/skan/:kod`): usunięte skróty
    "1 wynik = przejdź wprost"; wyszukiwanie po nazwie łączy wynik z historii WMS
    (`stany_lokalizacji`, niezależnie od bieżącego stanu) z całym katalogiem GT
    (`szukajProdukty`) — bez filtra `ilosc > 0`. Filtrowanie po stanie = checkbox
    "Ukryj produkty bez stanu" na froncie. Exact-match po SKU/EAN (1:1) działa jak
    dotychczas.
  - `public/zebra/karta-produktu.js`: nowy helper `liczbaArtykulow(n)` — poprawna
    polska odmiana ("1 artykuł" / "2 artykuły" / "5 artykułów").
  - `mm.js`, `lokalizowanie.js`, `inwentaryzacja.js` — nagłówki list wyboru
    używają `liczbaArtykulow(...)`.

### 2026-06-25 — usunięcie inwentaryzacji + backend = źródło prawdy

- **Moduł inwentaryzacji usunięty w całości** (do zrobienia od nowa): tabele
  `inwentaryzacje`/`pozycje_inwentaryzacji` (DROP + `001_init.sql`), `routes/inwentaryzacja.js`,
  rejestracja w `app.js`, blokady MM/LOK w `routes/ruchy.js`, helpery RW/PW w `gt-bridge.js`,
  ekran Zebry i panel desktopu. Most C# (RW/PW) zostaje nieużywany.
- **Zlanie MM + Lokalizowanie → jeden ekran „Ruch towaru"** (`ruch.html`/`ruch.js`),
  operacja LOK/MM wyprowadzana z wyboru celu. Wspólny `kreator.js`. Usunięte `mm.*`,
  `lokalizowanie.*`. Redirect `/` → menu.
- **Zasada 5 (CLAUDE.md): backend = jedyne źródło prawdy dla inwariantów.** Audyt +
  domknięcie reguł, które żyły tylko we froncie:
  - przypisanie (LOK bez źródła): `ilość ≤ stan_GT − suma_WMS` (`/ruchy/lok`),
  - przyjęcie z zewn.: `ilość ≤ stan GT magazynu MAG/LS` (`/ruchy/przyjecie`),
  - K4 LOK = cała ilość (`/ruchy/lok`).
- **Skan po EAN** znajduje lokalizacje WMS po symbolu z GT (gdy `stany_lokalizacji` nie ma EAN).
- **Guard pola K4G**: `gt-fields.js` nie nadpisuje `tw_Pole8` dopóki `deficyt_k4g > 0`
  (plan lokalizacji w GT przeżywa). Status zgodności (OK/t_GT/NZ/BD/OF) w odpowiedzi skanu.
- **DataWedge**: skan = Enter — działa przez „Send ENTER key" + „Send Enter as string";
  `onScan` łapie CR także jako `inputType:insertLineBreak`. Strona diag. `test-skan.html`.
- Startery macOS: `start-wms.command` / `stop-wms.command` (caffeinate, adres LAN).

### 2026-06-29 — Zebra v2: system projektowy + SPA + pełny ekran

- **System projektowy `app.css`**: tokeny `:root` (kolory/typografia/odstępy), powłoka
  3-strefowa (stały nagłówek / przewijana treść / stała stopka), komponenty
  (`btn-akcja`/`btn-wstecz`, `pole-skan` z ikoną, `stepper`, `badge`, `karta-info`, `chip`).
  Galeria `kit.html`. Fix poziomego rozpychania (`min-width:0` na polach flex).
- **SPA**: menu + Ruch w jednym dokumencie (`ruch.html`), przełączanie widoków bez
  przeładowania (żeby utrzymać pełny ekran). Systemowy Back → menu, bez pull-to-refresh.
- **Pełny ekran bez PWA/EHS** (`fullscreen.js`): podwójny tap WCHODZI w pełny ekran (nie
  wychodzi), przycisk „Tryb pełnoekranowy" w menu przełącza. PWA manifest + ikona — gotowe
  na HTTPS (po HTTP Chrome nie da instalacji/standalone). Na zablokowanym terminalu docelowo EHS Kiosk.
- **Ekran Ruch — przebudowa**: nagłówek SKU+nazwa+chipy **tylko na kroku „cel"** (znika
  przy Wstecz); bez „Ruch towaru"/operatora/podpisu GT i bez „Dokąd przenieść?"/boxa stanu.
  Kolejność **Cel → Lokalizacja docelowa → Ilość**. Stepper ilości, „Pozostanie w X"
  (0 neutralne), etykieta akcji opisuje skutek (PRZENIEŚ/ZMIEŃ/ZAPISZ). Ikona skanera = Enter.
  Niższy nagłówek (−50%) i pola/przyciski (−15..25%). Atrybuty anty-autofill.
- **Klawiatura**: usunięty auto-focus na pole ilości (`type=number`) → koniec z numeryczną
  klawiaturą przy zmianie magazynu/skanie; `blur()` po poprawnym skanie lokalizacji.
- **Przypisanie (towar bez lokalizacji WMS)**: select magazynu WMS ze stanem GT
  (K4/K4G + ilość), ilość pobierana z wybranego magazynu, podpowiedź „wg GT" pod polem
  lokalizacji (miejsce z `tw_Pole1`/`tw_Pole8` per magazyn). Usunięty przycisk-ikona skanera.
- **Widok zawartości lokalizacji (3.1)**: nagłówek = kod lokalizacji + magazyn (chip) w jednej
  linii; pole „Skanuj produkt"; lista z widocznym statusem (OK/NZ/t_GT/BD), bez opisów GT;
  na dole tylko „Wstecz".

- **Ekran 3.2 — rozkład produktu (zrobione)**: po skanie SKU/EAN z 2+ lokalizacjami
  (albo deficytem K4G) `obsluzArtykul` pokazuje rozkład źródeł zamiast płaskiej listy
  (`pokazRozkladZrodel`/`renderujRozklad` w `ruch.js`). Górny pasek: SKU + badge zgodności
  (NZ/OK/…) + nazwa. Treść: tytuł „Wybierz lokalizację źródłową", podsumowanie
  „Łączny stan: N szt. | Rezerwacje: M" (`.podsumowanie-stanu` z separatorem; łączny stan
  = suma stanów GT = suma wszystkich wierszy), etykieta + pole skanu, lista `.lista-poz`
  (mag-badge, kod, ilość, „(N rez.)" raz per magazyn, strzałka) + czerwony wiersz
  `.brak` „BRAK LOKALIZACJI / (nieprzypisano) / wg GT: …" dla deficytu K4G. Tap w wiersz →
  istniejące `wybierzOpcje` → krok „Dokąd i ile?" (źródło = lokalizacja, albo przypisanie
  dla wiersza BRAK). `focus({preventScroll})` na polu skanu (tytuł zostaje na górze).
  Wspólny `przygotujKrokWybor()` chowa sekcje rozkładu w pozostałych trybach kroku „wybór"
  (zawartość lokalizacji 3.1, lista po nazwie) — oba nietknięte. Fast-path 0/1 lokalizacji
  bez zmian. CSS: `.podsumowanie-stanu`, `#krok-wybor` gap, `.brak .poz-mag`/`.poz-kod`.

- **Urządzenie docelowe = Zebra TC52** (5.0", 1280×720 px, DPR 2.0). Viewport CSS w Chrome
  potwierdzony na żywo: **360×640** (pełny ekran) / **360×536** (worst-case: Chrome z paskiem
  URL ~56px + dolną nawigacją ~48px, gdy fullscreen pada — częste po wygaszeniu ekranu).
- **Budżet ekranu (fullscreen = bonus, nie założenie)**: kroki **decyzyjne** (start,
  „Dokąd i ile?") mają mieścić się **bez scrolla przy 360×536**. Listy (rozkład) mogą się
  przewijać — to naturalne. Audyt 2026-06-29: wszystkie warianty kroku „cel" (zmiana lok. K4,
  MM K4↔K4G, MM zewnętrzny, przypisanie, worst-case z 2-liniową nazwą) = 0px nadmiaru przy 360×536.
- **Stopka „Dokąd i ile?" w podziale**: jeden rząd — `Wstecz` (wtórne, lewo, `flex 1`) |
  `Zmień lokalizację/Przenieś` (główne, prawo, `flex 2`), oba 48px. Gdy `Zatwierdź` ukryty
  (kroki start/wybór) — `Wstecz` wypełnia rząd. `app.css`: `.ekran-stopka` row + niższy padding.
  **„Cel" zostaje** (magazyny zewnętrzne MAG/LS nie mają lokalizacji do skanu — to jedyny
  sposób wskazania celu). Kontekst „Z:/magazyn" już w nagłówku (chipy za nazwą).
- **Fix specyficzności (regresja złapana w audycie)**: `#krok-wybor` (id) wygrywał z `.hidden`
  (klasa) → sekcja „wybór" nie chowała się i nachodziła na inne kroki (duch pól na ekranie
  start). Poprawione na `#krok-wybor:not(.hidden)`.
- **Cache statyk** (`app.js`): `express.static` z `Cache-Control: no-cache` — Chrome na Zebrze
  ZAWSZE rewaliduje CSS/JS/HTML, więc po edycji terminal dostaje świeżą wersję (bez tego
  serwował stary `app.css` → mylące „duchy" po zmianach). Wymaga restartu `node app.js`.
- **Czyszczenie tekstów + domyślny cel (iteracja na makietach)**: start — bez etykiety „Kod";
  rozkład produktu — bez tytułu „Wybierz lokalizację źródłową", bez etykiety/hintu nad polem,
  placeholder „Skanuj kod lokalizacji". Nagłówek zmiany lokalizacji — chip magazynu (wypełniony
  navy `.chip-magazyn`) PRZED chipem „Z: <lok>". Opcja „ta sama" w selekcie Cel = „<MAG> — bez MM"
  (symbol z przodu). **Domyślny cel = przeciwny magazyn WMS** (źródło K4→K4G, K4G→K4; najczęstszy
  ruch pick-floor↔bulk) zamiast zapamiętanego — usunięty `localStorage` `wms_cel`.

### 2026-06-30 — Zebra: ekran wyszukiwania, magazyny zewnętrzne, rezerwacje, fixy K4/statusy

- **Ekran wyszukiwania (lista artykułów po nazwie) na nowy styl**: tytuł „Znaleziono N — wybierz"
  (h2, nie box), checkbox skrócony „Ukryj stan: 0", karty `.lista-poz` (SKU + badge statusu,
  nazwa, `Razem · K4 · K4G`, linia lokalizacji z GT, lewy pasek koloru wg zgodności — bez emoji).
  Dedykowany `renderujListaArtykulow` w `ruch.js` (test page `produkty.html` zostaje na starym).
- **Magazyny zewnętrzne (MAG/LS) jako źródło w rozkładzie**: wiersze bez konkretnej lokalizacji
  (mag-badge + nazwa + „magazyn zewnętrzny" + ilość/rez), pojawiają się zawsze gdy jest stan
  zewnętrzny. Tap → krok „Dokąd i ile?": cel WMS → `POST /ruchy/przyjecie`, cel zewn → `POST
  /ruchy/mm-zewnetrzny`. Pełna parytetowość z desktopem. `czyZrodloZewn`/`zrodloEtykieta`.
- **Rezerwacja na ekranach**: krok celu — żółty chip `rez N` w nagłówku (rezerwacja magazynu
  źródła, tylko gdy >0); karty wyszukiwania — `(rez N)` za stanem magazynu.
- **Fix: przypisanie nieprzypisanego stanu K4 z rozkładu** — wiersz „BRAK LOKALIZACJI" w rozkładzie
  uogólniony na K4 i K4G (liczony klient-side `GT − Σ WMS`). K4 tylko gdy brak lokalizacji K4
  (1 SKU = 1 lok). Wcześniej towar ze stanem zewn. wpadał w rozkład bez możliwości przypisania K4.
- **Fix: blokada częściowego przypisania K4** (źródło prawdy + UX) — `routes/ruchy.js` wymaga
  `ilo === deficyt` dla przypisania K4 (`400` przy częściowej); front: pole ilości readonly dla K4
  w przypisaniu. Bez tego dało się zapisać część stanu K4 i utknąć (kolejne przypisanie blokowane).
- **Fix: mieszanie stanów K4/K4G przy przypisaniu** — `przetworzLokalizacjeCelu` brało ilość ślepo
  z `iloscSugestia` (deficyt K4G) gdy `celMagazynNowejLokalizacji` ustawione → deficyt K4G (np. 360)
  wpadał do przypisania K4 (powinno 4). Teraz ilość liczona wg magazynu SKANOWANEJ lokalizacji.
- **Powrót do wyników wyszukiwania**: Wstecz z rozkładu/celu otwartego z listy wyników wraca do
  wyników (nie do czystego skanu). Flaga `powrotDoWyszukiwania`.
- **Status zgodności: częściowo zlokalizowane → NZ** (`gt-fields.js` `obliczOgolna`). `t_GT` tylko
  gdy NIC nie zlokalizowane; gdy część zrobiona (OK/OF) a reszta w GT bez WMS → `NZ` (spójnie z
  częściowym K4G). Kubełki: t_GT=od zera · NZ=do dokończenia/poprawy · OK=zrobione. Logika
  zweryfikowana tabelą prawdy (11 przypadków); liczy się przez most GT (restart + skan).
- **Wpisany tekst wyszukiwania zostaje w polu** (`ruch.js`): po szukaniu po nazwie zapytanie
  pozostaje w polu wyników (do doprecyzowania/poprawy), kursor na końcu BEZ zaznaczenia. Skan
  (bez dotknięcia pola) kasuje stary tekst przy pierwszym znaku (flaga `prefillWyszukiwaniaStale`,
  rozróżnienie tap=edycja vs skan=czyść). Czyszczone w rozkładzie/zawartości lokalizacji i przy reset.
- **Klawiatura chowa się po Enterze przy ręcznym wpisaniu** (`kreator.js` `onScan`): pole w trybie
  `inputmode="text"` (klawiatura) → po Enterze `blur()` ją chowa; skan (`inputmode="none"`)
  zostawiamy z fokusem na kolejny skan.
- **Zapas K4 w Zebrze** (`ruch.html`/`ruch.js`): dodatkowy adres K4 dla SKU (adnotacja `zapas_kod`,
  GT `tw_Pole1` = „miejsce/zapas"; backend `PUT /api/lokalizacje/k4-zapas/:id`). Mały przycisk
  „+ Dodaj zapas K4" / „Zapas K4: <kod> — zmień" pojawia się **gdy cel = K4** (zmiana K4→K4, MM
  K4G/MAG/LS→K4, przypisanie K4); tap rozwija pole (skan/wpis). Zapis **po** udanym ruchu (lokalizacja
  K4 już istnieje) — jedno „Zatwierdź" robi ruch + zapas; tylko gdy wartość się zmieniła.
  **Tryb tylko-zapas:** w K4→K4 bez nowej lokalizacji etykieta → „ZAPISZ ZAPAS K4" i `PUT /k4-zapas`
  bez ruchu (`tylkoZapasK4`/`zapiszTylkoZapas`). Rozkład: wiersz K4 pokazuje obecny zapas.
- **Typografia Zebry zmniejszona** (`app.css`): tokeny `--font-*` (label 16→14, body 18→16, title
  24→20, sku 32→24, quantity 28→22) + wagi 800→700 / 700→600 — lżejszy, mniej „bulky" wygląd.

#### Do zrobienia (kolejka)

- **Audyt** pozostałych `focus()` (start/wybór — `blur()` po sukcesie) + autofill (wyłączenie
  w ustawieniach Chrome/EHS — atrybuty HTML już są).
- **Redesign kart listy 3.1** (zawartość lokalizacji) na `.lista-poz` (wyszukiwanie i rozkład już są).
- Decyzja: przycinać linię lokalizacji na kartach wyszukiwania (`K4: A2 · K4G: …`) czy zostaje.
- **Inwentaryzacja od nowa**.
- Opcjonalnie: wybór operatora przy starcie apki; HTTPS + ikony PNG (prawdziwe PWA);
  sprzątnięcie wzmianek o inwentaryzacji w README/CONTEXT/moście C#.

## Plan wejścia na PRODUKCJĘ (ustalone z userem 2026-07-01)

Cel: „ruszyć z testami i już na główną bazę". Most MM zweryfikowany dziś na żywym GT
(14/14 ruchów WMS = dokumenty w Subiekcie, co do towaru i sztuki — patrz Dziennik 2026-07-01).

**Kontekst kluczowy:**
- **Baza produkcyjna = osobna baza na TYM SAMYM serwerze (192.168.0.200)** — kontynuacja
  testowej. `Z_KAJTEK_IdeaERP` zamrożona w lutym; produkcyjna to druga baza w tym samym
  Subiekcie. Trzeba przepiąć GT_SQL + most i ZWERYFIKOWAĆ tam `mag_Id` (K4/K4G/MAG/LS/braki)
  — mogą się różnić. (Próba listingu baz 2026-07-01 nieudana — GT chwilowo nieosiągalny.)
- **Topologia docelowa: Node WMS + most RAZEM na Windows** z GT/Sferą (most `localhost`,
  Node port 3000 na LAN dla Zebr/desktopów). Node przeprowadza się z Maca na pecet.
- **Wymóg usera: numer MM zawsze ten sam w WMS i Subiekcie.**

### Faza A — Bezpieczeństwo i poprawność (czysty Node, robić teraz; działa tak samo na Win)
1. ~~**Backup `wms.db`**~~ — ✅ ZROBIONE 2026-07-01 (`services/backup.js`, patrz Dziennik niżej).
2. ~~**Log błędów + audyt zmian**~~ — ✅ ZROBIONE 2026-07-01 (rozdzielone: `services/awarie.js`
   = log awarii do plików; `services/audyt.js` + tabela `audyt` = audyt biznesowy). Patrz Dziennik.
3. **Gwarancja numeru MM** — ✅ ZROBIONE (Node 2026-07-01, most + prewencja 2026-07-02).
   `dok_gt_id` (PK GT) obok numeru; „sukces bez numeru" NIE oznacza `ok`; job reconciliacji
   WMS↔GT z alarmem (wykrywanie). **Prewencja duplikatów (2026-07-02):** klucz `WMS-RUCH:<id>`
   w `dok_Uwagi` (most stempluje) + sprawdzenie przy ponowieniu (Node szuka dokumentu po kluczu
   zamiast wystawiać drugi MM przy zgubionej odpowiedzi HTTP) + blokada in-flight per ruch.
   Uwagi zawierają też **kto/kiedy** zrobił przesunięcie. „Brak cichych porażek" w UI Zebry:
   MM niepotwierdzony w GT = pomarańczowy ekran ostrzeżenia (nie zielony sukces). Patrz Dziennik.
4. ~~**Logowanie + użytkownicy**~~ — ✅ ZROBIONE 2026-07-01 (patrz Dziennik): profile +
   login/token, operator z sesji, panel admina (CRUD), wybór profilu Zebra+desktop, twarda
   blokada edycji produktu (desktop + Zebra). Follow-up: job sprzątania sesji (dziś leniwe).

### Faza B — Dane startowe
5. **Import lokalizacji** — 🔄 W TOKU 2026-07-01: mapa z pól GT rozpisana i wyczyszczona
   (patrz Dziennik + pamięć [[mapa-lokalizacji]]). Zostaje: weryfikacja luk/„do ręki" przez
   usera → potem endpoint/skrypt importu masowego do tabeli `lokalizacje`.
6. **Magazyn „braki"** — jak ZEW (tylko cel MM, stan w GT, bez lokalizacji WMS); 1 linia
   w `config/magazyny.js` + dopuszczenie jako cel. Potrzebny `mag_Id` z produkcji.

### Faza C — Przepięcie na produkcję (Windows)
7. **Przepięcie GT_SQL + most na bazę produkcyjną** + weryfikacja `mag_Id` + **env-guard**
   (apka odmawia startu na nieoczekiwanej bazie).
8. **Login SQL least-privilege** zamiast `sa` (PILNE) — `db_datareader` + `VIEW SERVER STATE`.
9. **Node + most na Windows**; most z **ikoną w trayu / restart jednym klikiem** (NIE ukryta
   usługa — user chce widoczny, sterowalny proces), nasłuch zawężony z `0.0.0.0` do `localhost`.
10. **deploy.ps1 / rollback.ps1** (poprawki z Maca: backup→build→health-check→auto-rollback)
    + opcjonalnie Tailscale (VPN, zdalny dostęp bez wystawiania portów).

### Faza D — Dashboard i reszta
11. **Dashboard magazyniera** — ruchy `error`/`pending`, rozjazdy, uzupełnienia na dziś,
    „do zlokalizowania".
12. *Później:* inwentaryzacja od nowa (RW/PW w moście), analityka magazynowa, polish Zebry
    (karty 3.1, audyt `focus()`, HTTPS+PWA), rewrite na C# (świadomie odłożony).

**Start:** Faza A #1+#2 (backup + log) — siatka bezpieczeństwa zanim cokolwiek dotknie produkcji.

### Specyfikacja: logi + backup (ustalone z userem 2026-07-01)

Trzy ROZDZIELNE mechanizmy (user wyraźnie chciał osobno):

**A) Audyt biznesowy — „kto/co/gdzie/kiedy ruszył"**
- Cel: rozliczalność, trwały zapis każdej zmiany stanu/lokalizacji.
- Gdzie: tabela `audyt` w `wms.db` (przeszukiwalna, wchodzi do backupu), append-only.
- Pola: czas, użytkownik, akcja (MM/LOK/przyjęcie/przypisanie/edycja lokalizacji/korekta
  stanu/zapas K4/usunięcie ruchu), artykuł, magazyn, lokalizacja, przed→po (ilość/kod),
  wynik, `ruch.id`, `dok_gt_numer`. `ruchy` zostaje operacyjne; audyt łapie też nie-ruchy
  (edycje lokalizacji, korekty, usunięcia, akcje admina).
- Zależność: prawdziwe „kto" dopiero po logowaniu (Faza A#4); do tego czasu tyle ile mamy.
- Retencja: długa (12–24 mies. lub bez kasowania — wiersze małe).

**B) Log awarii — techniczny**
- Gdzie: PLIKI na dysku `logs/error-YYYY-MM-DD.log`, rotacja dzienna. CELOWO poza bazą
  (przetrwa awarię bazy, nie puchnie w `wms.db`).
- Co: wyjątki, `uncaughtException`, nieudane wywołania mostu/GT, ruchy `pending`, błędy SQL,
  nieudane backupy, nieudany `integrity_check`.
- + UI „brak cichych porażek": ekran Zebry nie kończy się sukcesem, gdy zapis nie przeszedł.
- Retencja: 60–90 dni plików.

**C) Backup `wms.db`**
- Częstotliwość: **co godzinę w godz. pracy (np. 7:00–20:00) + 1 nocny.** (strata ≤ 1h)
- Jak: **nowy plik z datą** `wms_YYYY-MM-DD_HHMM.db` przez `VACUUM INTO` (spójna kopia bez
  `-wal/-shm`). NIGDY nie nadpisujemy.
- Integrity-guard: przed backupem `PRAGMA integrity_check`; jeśli baza uszkodzona → alarm +
  **NIE kasujemy starych** kopii (zepsuty stan nie wyprze dobrej historii).
- Rotacja warstwowa (dziadek-ojciec-syn), kasujemy tylko stare w warstwie: godzinowe ~48
  (2 dni) · dzienne ~30 (miesiąc) · miesięczne ~12 (rok). → przywrócenie: dowolna godzina
  z 2 dni / dzień z miesiąca / miesiąc z roku.
- **Drugie miejsce:** kopie lokalnie (`db/backups/`) + mirror dziennych/miesięcznych poza
  pecet (drugi dysk / chmura / Mac przez Tailscale — konkret do ustalenia przy wdrożeniu).
- **Pre-deploy:** przed deployem/migracją/zmianą bazy wymuszony backup `wms_pre-deploy_...db`,
  WYŁĄCZONY z rotacji.

### 2026-07-01 — mapa lokalizacji K4/K4G (Faza B#5, w toku)
Analiza pól lokalizacyjnych z ŻYWEGO Subiekta (eksport usera, bo GT-SQL zamrożony w lutym).
Pełne reguły i stan → pamięć [[mapa-lokalizacji]]. Skrót:
- Reguły poziomów K4 hala 1 (od usera): A,B=podstawa · C,D,K=podstawa+P1 (typ TRAWERS) ·
  E–J=P1–P6 (półka) · L=podstawa. Hala 1 GENEROWANA z reguł (czysta). K4 M2=podstawa+P1
  (P2+ na paletach = to górna K4G). K4G=tylko z poziomem (bez podstawy). RB, BIURO=nazwane K4.
- Parser rozbija bałagan (separatory / ; \ spacje, brak myślników, ilość w nawiasie,
  ZAKRESY M2-A20-23-P4→pojedyncze, cap kolumny>50). NIE przypisujemy towarów — sama mapa.
- Stan: K4=855, K4G=1103. Pliki analityczne w ~/Documents/lokalizacje-do-importu.xlsx
  (K4, K4G, Luki(weryfikacja)=67 kodów, Do ręki=21, Autor-wymiary=303 — złe pola książek/mebli).
- Uwaga: eksport niefiltrowany → autorzy/wymiary w polach; do per-SKU trzeba eksportu
  filtrowanego po stanie K4/K4G + SKU. GT: BRK(braki)=mag 10.
- ZOSTAJE: user weryfikuje 67 luk (przejście vs brak) i 21 „do ręki", potem skrypt importu
  masowego do tabeli `lokalizacje`.

### 2026-07-01 — logowanie + użytkownicy + blokada edycji (Faza A#4) ZROBIONE
Decyzje usera: PIN opcjonalny, twarda blokada edycji, zarządzanie tylko admin.
- **Model**: tabele `uzytkownicy` (imie, pin_hash/pin_salt scrypt, rola admin|magazynier,
  aktywny), `sesje` (token→user, wygasa po 12h bezczynności), `blokady_edycji`
  (1 wiersz=1 produkt, heartbeat, timeout 2 min). Seed: `Admin` (admin, bez PIN).
- **services/auth.js**: hash/sprawdz PIN (scrypt), tokeny, middleware `wymagajSesji`
  (WSTRZYKUJE operatora z tokenu do req.body — „kto" wiarygodne, handlery nietknięte),
  `wymagajSesjiNaZapisie` (GET otwarte, POST/PUT/DELETE wymagają sesji), `wymagajAdmin`.
- **routes/uzytkownicy.js**: `/profile` (lista do wyboru), `/login` (PIN opcjonalny),
  `/logout`, `/ja`; CRUD (admin): create/PUT/DELETE=dezaktywacja, guard „ostatni admin".
- **routes/blokady.js + services/blokady.js**: zajmij (409 gdy edytuje kto inny),
  heartbeat, zwolnij, status. Wymaga sesji.
- **app.js**: mount `/api/uzytkownicy`, `/api/blokady`; middleware auth na `/ruchy`,
  `/lokalizacje`, `/uzupelnienia` (operator z tokenu, nie z pola). GET otwarte.
- **Front wspólny `public/shared/auth.js`** (ładowany w desktop `index.html` i Zebra
  `ruch.html` PRZED app): monkey-patch `fetch` dokleja `x-wms-token` do `/api/` (wszystkie
  istniejące fetch-e niosą token bez zmian w kodzie — także uzupelnienia.js równoległej
  sesji); ekran „Wybierz profil" (+PIN); badge z wylogowaniem. Zdarzenie `wms-zalogowano`.
- **Desktop**: zakładka „Użytkownicy" (tylko admin — `#tab-uzytkownicy` hidden dla
  magazyniera), formularz + tabela (Ustaw PIN/Bez PIN/zmiana roli/Dezaktywuj); stare pole
  Operator ukryte, `operator()` z `WMS.user()`. Twarda blokada w `otworzModalProdukt`
  (zajmij; 409 → „edytuje X", nie otwiera; heartbeat co 30s; `zamknijModal` zwalnia).
  `api()` dokleja `status`+`dane` do błędu (rozróżnienie 409).
- **Zweryfikowane w preview**: podszycie operatora w body nadpisane tokenem (audyt=Admin);
  zapis bez tokenu=401; PIN wymagany/bledny=401; CRUD admina; twarda blokada (409 „edytuje
  Bartek", modal nie otwiera; happy-path zajmij→zwolnij); ekran profilu na Zebrze (mobile).
- **Follow-up**: blokada edycji na Zebrze (dziś tylko desktop); job sprzątania sesji
  (dziś leniwe wygasanie przy odczycie). „PIN na Zebrze" z pierwotnego planu → zrealizowane
  jako PIN opcjonalny per user (nie osobno per urządzenie).

### 2026-07-01 — gwarancja numeru MM (Faza A#3, część Node) ZROBIONE
- Migracja: kolumna `dok_gt_id` (PK GT) w `ruchy` — `dok_NrPelny` NIE jest unikalny, więc
  sam numer nie identyfikuje dokumentu; PK domyka jednoznaczność.
- `services/gt-dokumenty.js` `znajdzMM(nrPelny, twId)` — namierza dokument MM w GT po
  numerze + tw_Id (bo numer się powtarza), zwraca `{dok_Id, ilosc}`; nie rzuca (GT SQL
  może być chwilowo down).
- `services/ruchy-gt.js`: (a) „sukces bez numeru" NIE oznacza `ok` — ruch zostaje pending
  + alarm (dawniej `numer=null` szło na `ok`); (b) po udanym MM ustala i zapisuje `dok_gt_id`
  (brak GT SQL nie blokuje — numer wystarcza, logujemy brak).
- `services/reconciliacja-mm.js` (job co godzinę, +2 min po starcie): dla każdego MM
  `ok` z numerem sprawdza w GT numer+tw_Id i ilość; rozjazd/brak/inna ilość → ALARM do
  logu awarii; domyka brakujące `dok_gt_id`. Wpięte w `app.js` (`reconciliacjaMM.start()`).
  `WMS_RECON_DISABLED=1` wyłącza.
- Zweryfikowane na żywym GT: **15/15 MM zgodne, 0 rozjazdów**; wszystkie realne MM mają
  teraz `dok_gt_id`.
- ⏳ ZOSTAJE (most C#): prewencja duplikatów przy zgubionej odpowiedzi HTTP = klucz
  idempotencji (`ruch.id` → `dok_Opis` w GT) + sprawdzenie przy retry. Dziś: reconciliacja
  WYKRYWA duplikat/rozjazd (alarm), ale go nie zapobiega.

### 2026-07-01 — scalenie Ruchy → Log (zakładka Ruchy usunięta) ZROBIONE
- Decyzja usera: zakładki Ruchy i Log pokrywały się; **zostaje Log**, Ruchy skasowana,
  a przyciski **Ponów/Usuń** przeniesione do Logu (nie tracimy zarządzania kolejką).
- `routes/audyt.js`: LEFT JOIN ruchy → `ruch_status`/`ruch_blad` (żywy status). Kolumna
  „Wynik" w Logu pokazuje żywy status ruchu (fallback na zapisany `wynik`).
- `app.js`: usunięty cały blok Ruchów (panele.ruchy, odswiezRuchy, renderujRuchy,
  pobierzMapeLokalizacji, kodLokalizacji, lokalizacjeMap — nic nie było współdzielone).
  `wierszLog` ma kolumnę „Akcje": dla wpisu o żywym `ruch_status==='pending'` przyciski
  Ponów (`/api/ruchy/:id/retry`) i Usuń (`DELETE /api/ruchy/:id`) → odświeżają Log.
  Modal historii „H" bez kolumny Akcje (read-only).
- `index.html`: usunięty link nav „Ruchy" + sekcja `panel-ruchy`; dodana kolumna „Akcje".
- Zweryfikowane w preview: brak zakładki Ruchy; wiersz pending pokazuje Ponów/Usuń,
  zrealizowane i nie-ruchowe bez przycisków; zero błędów w konsoli. **Audyt potwierdzony
  na żywo** — user zrestartował serwer, w `audyt` realne wpisy (Plan lok., Przypisanie itd.).

### 2026-07-01 — Log biznesowy w desktopie (zakładka + ikona „H") ZROBIONE
- Endpoint `GET /api/audyt` (`routes/audyt.js`, mount w `app.js`): najnowsze pierwsze,
  filtry `artykul_gt_id`/`uzytkownik`/`akcja`/`q`, limit/offset, zwraca `{wiersze,total}`.
- **Zakładka „Log"** (desktop, `index.html`+`app.js`): tabela Kiedy/Akcja/SKU/Magazyn/
  Lokalizacja(kierunek)/Ilość/Zmiana(przed→po)/Wynik/Dok.GT/Kto, filtr tekstowy + select akcji.
- **Ikona „H"** w nagłówku modala produktu → `otworzHistorie(artykul_gt_id)` = modal z
  historią ruchów/zmian tego SKU (`/api/audyt?artykul_gt_id=`). Wspólny `wierszLog()`.
- Zweryfikowane w preview (port 3020): 5 przykładowych wpisów renderuje się poprawnie
  (kierunki →, przed→po, badge wyniku, kto); modal „H" filtruje po SKU (2/5 dla NERE0011);
  brak błędów w konsoli. Wpisy testowe posprzątane.

### 2026-07-01 — logi: awarie + audyt biznesowy (Faza A#2) ZROBIONE
Rozdzielone na DWA osobne mechanizmy (decyzja usera) + checkpoint WAL.
- **Log AWARII (techniczny)** — `services/awarie.js`: pliki `logs/error-YYYY-MM-DD.log`,
  rotacja dzienna, retencja 90 dni. Podpięte w `app.js`: `awarie.start()` (łapie
  `uncaughtException`/`unhandledRejection`) + `awarie.middleware` jako Express
  error-handler PO trasach (loguje + zwraca 500 bez wycieku stacka). Błędy backupu też
  tu trafiają. CELOWO poza bazą (przetrwa awarię bazy).
- **AUDYT BIZNESOWY (kto/co/gdzie/kiedy)** — tabela `audyt` w `wms.db` (migracja w
  `db/database.js`, append-only, indeksy czas/artykul/uzytkownik) + `services/audyt.js`
  (`zapisz()` — nigdy nie rzuca; błąd audytu → log awarii). Pola: czas, uzytkownik,
  akcja, artykul, magazyn, lokalizacja, przed→po, ilosc, wynik, ruch_id, dok_gt_numer,
  szczegoly. Jeden wspólny strumień.
- **Zinstrumentowane endpointy:** `routes/ruchy.js` — MM, LOK, przypisanie, przyjecie,
  MM-zewn, usuniecie_ruchu; `routes/lokalizacje.js` — lokalizacja_nowa/edycja/usuniecie,
  zapas_k4, plan_lok. Test e2e (serwer na :3010): POST/PUT/DELETE lokalizacji → 3 wpisy
  audytu z przed→po. `ruchy` zostaje tabelą operacyjną/kolejką; audyt to równoległy trail.
- **"kto":** dziś `operator` z requestu; po logowaniu (Faza A#4) z sesji.
- **Checkpoint WAL:** po udanym backupie `PRAGMA wal_checkpoint(TRUNCATE)` — WAL z 4 MB → 0.
- **Do dokończenia:** (a) audyt nie łapie sukcesu z retry/joba `ruchy-retry` (wpis ma
  status z chwili utworzenia = pending; finalny status jest w `ruchy`); (b) UI "brak
  cichych porażek" na Zebrze (ekran nie kończy sukcesem, gdy zapis nie przeszedł) — front,
  osobny punkt. (c) Logowania/usery dodadzą prawdziwe "kto".

### 2026-07-01 — backup `wms.db` (Faza A#1) ZROBIONE
- `services/backup.js`: `VACUUM INTO` → nowy plik z datą `wms_YYYY-MM-DD_HHMM.db` (spójny,
  bez `-wal/-shm`), nigdy nie nadpisujemy. Integrity-guard: przed backupem `PRAGMA
  integrity_check` zywej bazy + weryfikacja powstalego pliku; jeśli baza uszkodzona →
  alarm w logu i **brak rotacji** (zepsuty stan nie wyprze dobrej historii).
- Rotacja warstwowa: godzinowe 48 + dzienne 30 + miesięczne 12 → ~84–90 plików na stałe
  (~9 MB). Przetestowane: 5110 sztucznych plików/rok → 84 + pre-deploy nienaruszone;
  pokrycie godzina/2dni · dzień/miesiąc · miesiąc/rok.
- Harmonogram: co godzinę 7–20 + nocny 2:00; backup też od razu przy starcie (restart =
  świeża migawka). Podpięte w `app.js` (`backupJob.start()`).
- Drugie miejsce: `WMS_BACKUP_MIRROR` (env) — kopia poza pecet; do ustawienia przy
  przeprowadzce na Windows. Inne env: `WMS_BACKUP_DIR`, `WMS_BACKUP_DISABLED=1`.
- CLI: `node scripts/backup.js` (zwykły) / `node scripts/backup.js pre-deploy` (etykieta,
  WYŁĄCZONA z rotacji — wołać z deploy.ps1 przed deployem/migracją).
- Logi backupu: `logs/backup-YYYY-MM-DD.log`. `.gitignore`: `db/backups/`, `logs/`.
- TODO przy okazji logu awarii (Faza A#2): błędy backupu kierować też do wspólnego logu
  awarii + alarm w UI; checkpoint WAL (urósł do 4 MB) — `PRAGMA wal_checkpoint(TRUNCATE)`.

### 2026-07-01 — weryfikacja mostu MM na żywym GT
- Sprawdzono zgodność WMS↔Subiekt dla wszystkich realnych ruchów MM (`ruchy` typ=MM,
  status=ok, bez sufiksu `/MOCK`): 14 dokumentów (MM 181–188, 317–322 /2026) — **14/14
  zgodne** co do towaru (tw_Id) i ilości. Most działa poprawnie na żywej bazie.
- **Odkrycie: `dok__Dokument.dok_NrPelny` NIE jest unikalny** — numeracja MM resetuje się
  per magazyn/seria (np. „MM 181/2026" istnieje 2×: styczeń mag 8 + czerwiec mag 4, różne
  towary). Reconciliacja po samym numerze daje fałszywe rozjazdy; dopasowywać po numerze +
  tw_Id. Stąd rekomendacja zapisu `dok_Id` w WMS (Faza A #3).
- Schemat GT: nagłówki `dok__Dokument` (dok_Id, dok_NrPelny, dok_MagId, dok_DataWyst,
  dok_Typ=9=MM), pozycje `dok_Pozycja` (klucz `ob_DokMagId`=dok_Id, `ob_TowId`, `ob_Ilosc`).
