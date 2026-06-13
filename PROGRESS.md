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

- **`bridge/GtBridge/Services/SferaGtService.cs`** — wszystkie metody
  (`WystawMmAsync`, `ZapiszLokalizacjeAsync`, `PobierzStanyAsync`, `PobierzArtykulAsync`,
  `WystawRwAsync`, `WystawPwAsync`) to szkielet (`NotImplementedException`).
  Implementacja wymaga modelu obiektowego Sfery (`SuDokumentyManager`, `TowaryManager`,
  `SuPozycja`, `Towar.Pole1`/`Pole8`, `TwCechy`/`pwd_Tekst09`, sekwencja logowania).
  `sfera.pdf` / `sfera opis.txt` w repo to głównie grafika (drzewo obiektów jako obraz,
  bez tekstu do wyciągnięcia). Potrzebne: zrzuty/tekst z `Pomoc > gta.chm > Model
  obiektowy - Subiekt Sfera` z maszyny z zainstalowanym InsERT GT, albo przykładowy kod.
  **Zgodnie z decyzją: ten temat zostaje na koniec, po dopracowaniu reszty WMS.**

## Dziennik zmian

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
