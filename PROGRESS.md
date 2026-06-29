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

#### Do zrobienia (kolejka)

- **Wyskakująca klawiatura** (pierwszy ogień): A) bez auto-focusu na `input-ilosc`
  (numeryczna klawiatura mimo steppera); B) `blur()` po poprawnym Enter/skanie; C) audyt
  pozostałych `focus()`; D) autofill — wyłączenie w ustawieniach Chrome/EHS.
- **Nowe ekrany** (czekają na komplet makiet): 3.1 zawartość lokalizacji, 3.2 rozkład
  produktu (mobilny odpowiednik desktopowego rozkładu, tap → „Dokąd i ile?").
- **Redesign kart listy** na `.lista-poz` (pasek statusu z lewej, mag-badge).
- **Inwentaryzacja od nowa**.
- Opcjonalnie: wybór operatora przy starcie apki; HTTPS + ikony PNG (prawdziwe PWA);
  sprzątnięcie wzmianek o inwentaryzacji w README/CONTEXT/moście C#.
