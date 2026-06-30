# Lista Uzupełnień K4 — dokumentacja funkcji

Uzupełnianie K4 z K4 Góra (K4G). Zastępuje/rozszerza zestawienie Subiekta „uzupelnienia K4": ta sama lista towarów do ściągnięcia, **plus rozbicie rezerwacji na kanały wysyłki** (Desktop) i spięcie z ruchami MM na Zebrze.

## Cel

Pracownik widzi, które towary trzeba ściągnąć z K4G na K4 (bo na K4 skończyła się dostępność wobec rezerwacji), **ile sztuk na każdy kanał wysyłki** i zbiorczo, oraz lokalizację źródłową (K4G) i docelową (K4). Na Zebrze od razu robi przesunięcie (MM K4G→K4) i przechodzi do kolejnego towaru.

## Definicja listy (replika zestawienia Subiekta)

Towar trafia na listę, gdy:

- ma stan na **K4 Góra (mag_Id 8)** ≠ 0, **oraz**
- na **K4 (mag_Id 4)** brak dostępności: `stan − rezerwacja ≤ 0`.

Sort: **rezerwacje malejąco**. Kolumny: symbol, nazwa, lokalizacja K4 (`tw_Pole1`), lokalizacja górna (`tw_Pole8`), stan K4, stan góra, rezerwacje, dostępność.

> **Magazyny:** K4 = **tylko mag 4**. Zestawienie Subiekta liczy `st_MagId in (4,5)`, ale **mag 5 (ZW — Zestawy Wirtualne) świadomie pomijamy** (decyzja użytkownika). Lista odejdzie od zestawienia tylko dla kompletów. K4 Góra = mag 8.

## Rozbicie rezerwacji na kanały wysyłki

`st_StanRez` to goła liczba — nie niesie marketplace’u. Rozkładamy ją na kanały przez **otwarte zamówienia klienta (ZK)**:

- ZK = `dok__Dokument`, `dok_Typ = 16`. **`dok_Status = 7`** = otwarte (tworzy rezerwację), `= 8` = zrealizowane/zamknięte.
- Pozycje = `dok_Pozycja` (prefiks `ob_`): `ob_DokHanId`→dok_Id ZK, `ob_TowId`, `ob_Ilosc`, `ob_MagId`.
- Rezerwacja na K4 ≈ suma `ob_Ilosc` po otwartych ZK (status 7) na mag 4. Zweryfikowane na żywej bazie (zgodność co do sztuki).

### Atrybucja kanału (reguła: PLATFORMA > KURIER)

Sygnały na ZK (`vwPolaWlasne_Dokument`, 1:1 po `dok_Id`):

| Pole | Zawartość |
|---|---|
| `pwd_Tekst01` (źródło) | platforma+konto, np. `Amazon.de`, `Emag Rumunia`, `Allegro - ekajtek_pl`, `Kaufland.de`, `Empik` |
| `pwd_Tekst03` (dostawa) | kurier, np. `Allegro Paczkomaty24/7 InPost`, `Allegro One Kurier DPD` |
| `dok_NrPelnyOryg` | nr zewn.; dla natywnych IDEA (puste pola własne): `Am302-..._IDEA`, `Kaufland_..._IDEA` |
| `dok_Uwagi` | nr zamówienia / tag platformy `[amazon]/[kaufland]/[emag*]` |

**Kanały:** DHL Connect, InPost, DPD, DHL, UPS, One, Orlen Paczka, Poczta Polska, Packeta, Emag, nieklasyfikowane.

**Reguły (kolejność):**
1. **DHL Connect** = Amazon **DE/FR** + Kaufland. Kaufland: `Kaufland%` / `Kaufland.de` / `[kaufland]`. Amazon DE/FR: `Am%_IDEA` (natywne) lub źródło Amazon + szablon DE/FR (`Std/Exp DE`, `Std FR`, `DE Second`, `DHLDE_EuroHermers`). **Amazon PL (`std-ez-pl`) NIE jest DHL Connect → InPost.**
2. **Emag** = źródło `Emag*` / `[emag*]`.
3. **Kurier** wg `pwd_Tekst03` (słownik w `services/kanaly.js`). M.in.: Empik salon / KURIER / „pobranie" → **DPD**, Empik paczkomat → **InPost**; „Allegro One Kurier DPD/DHL/UPS" → **DPD/DHL/UPS**; „Allegro One Punkt/Box…" → **One**; Packeta CZ/SK/HU → **Packeta**.
4. Reszta (NULL/puste/Pigu/rezerwacje ręczne typu `BRAKI INWENTURA`) → **nieklasyfikowane**.

> **Pigu** (Bałtyk: `remote_self`, `post_ee/lv/lt/fi`, `itela_smartpost`…) — celowo nieobsługiwane (na razie brak tych zamówień) → nieklasyfikowane.

Weryfikacja: 12/12 testów brzegowych, ~98,5% pokrycia na 1000 ZK.

## Decyzje

- **Nie sugerujemy ilości** do ściągnięcia — pokazujemy rezerwacje (i rozbicie na kanały).
- **Rotacja 7 dni** — PARKING (do dodania później); źródło: wydania WZ (`dok_Typ=11`) z mag 4 za 7 dni.
- Ruch uzupełnienia = **MM K4G→K4** przez istniejące `/api/ruchy/mm` (generuje MM w GT).
- Lista **odświeżana na bieżąco** (bez snapshotu); wielu pracowników równolegle — pozycja schodzi z listy, gdy GT zaktualizuje rezerwację/stan po MM.
- Deadline / odjazdy kurierów — odłożone (brak czasu wejścia ZK w Subiekcie).

## Architektura

| Plik | Rola |
|---|---|
| `services/kanaly.js` | `kanalZK({zrodlo, dostawa, oryg, uwagi})` → kanał |
| `services/uzupelnienia.js` | `pobierzUzupelnienia()` → lista + rozbicie na kanały + lokalizacje WMS |
| `routes/uzupelnienia.js` | `GET /api/uzupelnienia` → `{pozycje, total}` |
| `routes/ruchy.js` | `POST /api/ruchy/uzupelnienie` → MM K4G→K4 „czyste GT" dla t_GT |

Kształt pozycji: `{artykul_gt_id, symbol, nazwa, lokalizacja_k4, lokalizacja_gora, stan_k4, stan_gora, rezerwacje, dostepnosc, kanaly:{kanał: ilość}, rozbicie_suma}`.

Wszystko czytane z bazy, którą WMS już używa (`services/gt-sql.js`, read-only).

## Baza danych

WMS czyta **`Z_KAJTEK_IdeaERP`** (host 192.168.0.200) — to odwzorowanie bazy docelowej. Lokalny `.env` wskazuje **snapshot (~2026-02-12)**; do dewelopki OK, ale lista pokazuje stan lutowy. Przeskok na żywą produkcję później = tylko zmiana `.env`, bez zmian w kodzie. (To NIE jest baza `OKITRADE` z projektu Rozliczeń — inna firma.)

## Status / roadmap

- ✅ **Faza 1 — Backend:** `kanaly.js`, `uzupelnienia.js`, endpoint. Zweryfikowane na żywej bazie.
- ✅ **Faza 2 — Desktop:** zakładka „Uzupełnienia" (`public/desktop/index.html` + `app.js`) — tabela jak zestawienie + chipy rozbicia na kanały, filtr po kanale (klient-side, sort po ilości w kanale), licznik. Kolumna **Akcje → „Edytuj"** otwiera ten sam modal co Produkty (rozkład lokalizacji + akcje przenieś/przypisz; modal sam dociąga `stany_gt`/zgodność przez `odswiezModalProdukt` po `artykul_gt_id`). Zweryfikowane w przeglądarce.
- ✅ **Faza 3 — Zebra:** ekran „Uzupełnienia K4" (`public/zebra/ruch.html` widok `widok-uzupelnienia` + `public/zebra/uzupelnienia.js` + style w `app.css`; `ruch.js` `pokazWidok` rozszerzony o 3. widok). Lista zbiorcza (z chipami kanałów + filtr) → karta produktu (uproszczona) → „Przesuń K4G→K4". Zweryfikowane na viewportcie TC52 (360×640), zero błędów konsoli.
  - **Karta (ostatni krok) — bez wyboru kanałów.** Magazynier bierze **całe potrzebne SKU + zapas** (żeby nie latać co 5 min), więc kanały zostają tylko na liście (priorytet), a na karcie ich nie ma. Karta pokazuje **blok info**: stany i lokalizacje (wg GT) K4 i K4G + rezerwacje na K4. Ilość domyślna = **rezerwacje (potrzebne)**, stepper do podbicia o zapas (max = stan źródła). Rozbicie na kanały odłożone do listy/desktopu; ewentualny wariant B (worklista per-batch kuriera) — gdyby był potrzebny.
  - **Źródło K4G:** w trybie **GT** (t_GT) pole wyboru/skanu **ukryte** — źródło wg GT z bloku info. W trybie **WMS** (lokalizacje w WMS) pokazujemy wybór/skan lokalizacji K4G (auto przy 1, skan/lista przy N).
  - **Lokalizacje WMS:** endpoint dokłada `wms_k4` (cel, **niezależnie od stanu — cel jest pusty**) i `wms_k4g` (źródła ze stanem >0, malejąco) z SQLite. Brak którejkolwiek → karta blokuje ruch z komunikatem „zlokalizuj w Ruchu".

## Lokalizacja tylko w GT (status t_GT)

Towary, które mają lokalizację wyłącznie w polach GT (`tw_Pole1`/`tw_Pole8`), a nie w bazie WMS (brak per-lokalizacyjnego stanu), to częsty przypadek na liście uzupełnień. Karta Zebry ma **dwa tryby** (auto-wykrywane w `otworzKarte`):

- **Tryb WMS** (towar ma `wms_k4` ORAZ `wms_k4g`): precyzyjna ścieżka — wybór/skan lokalizacji źródłowej K4G z id + stanem, ruch przez `POST /api/ruchy/mm` (pełny bookkeeping WMS, cap ilości = stan źródła).
- **Tryb GT** (brak którejkolwiek lokalizacji WMS = t_GT): źródło i cel **wg tekstu z GT**, skan K4G opcjonalny (potwierdzenie/audyt), cap ilości = stan góry. Ruch przez **`POST /api/ruchy/uzupelnienie`** — „czyste GT": most wystawia MM K4G→K4 (mag 8→4), rejestrujemy `ruchy`, ale **nie tworzymy lokalizacji ani stanu w WMS** (sync pól GT to no-op — pusty zbiór magazynów w `wykonajRuchGT`, więc kody w GT nie są nadpisywane). Towar zostaje t_GT; onboarding do WMS = osobno (lokalizowanie / rozjazdy). Reguła rezerwacji (zasada 6) egzekwowana przez GT na K4G.

Implementacja `/uzupelnienie`: ruch `typ='MM'`, `lok_zrodlo_id`/`lok_cel_id` = NULL, `mag_zrodlo_zewnetrzny='K4G'`, `mag_cel_zewnetrzny='K4'` (kolumna już istnieje, używa jej `/mm-zewnetrzny`). Dzięki temu `wykonajRuchGT` (i job ponawiania) działają bez zmian.

## Otwarte punkty

1. **Status ZK 6** (bufor, 23 dok w bazie) — czy wliczać do otwartych obok 7. Na razie tylko 7 (rekonsyliacja wyszła co do sztuki).
2. **Rotacja 7 dni** — implementacja (parking).
3. **Produkcja** — wskazanie żywej instancji Kajtek Idea w `.env`.
