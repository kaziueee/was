# Tworzenie zestawów (kompletów) — przepis

Status: **2026-11-18 — zapis przez Sferę przetestowany na Z_KAJTEK** (3 komplety testowe `TESTKOMPLETWMS1..3`). Narzędzie: endpoint mostu `POST /api/komplet` (na produkcji od 18.11) + `scripts/zestaw-zaloz.js`. Produkcja: **SPIN20148931Z2 założony 2026-11-18 (tw_Id 96720)**.
Zakres (decyzja usera 2026-11-18): **cały ciąg** — komplet w Subiekcie GT → karta w sklepie poszukiwaczefrajdy.pl → oferty na platformach.

## 1. Jak wyglądają dziś komplety w GT (pomiar OKITRADE 2026-11-18)

- **1415 kompletów** (`tw_Rodzaj = 8`, nieusunięte), z czego **1344** z flagą „do sklepu internetowego” (`tw_SklepInternet = 1`).
- **Symbol** = symbol głównego składnika + `Z<n>`: `NERG1132Z1`…`Z4`, `HASF9703-G1698Z1`, `MOJ84486Z1`. Wyjątki: `NERG1132Z1Z2` (wariant wariantu), `KKZC2`.
- **Nazwa** = główny składnik + „+ dodatki” (`Nerf Fortnite Frenz 4 Ever + cele opaska strzałki`) albo „x N” dla wielopaków (`Minecraft saszetka figurka niespodzianka x5`). Limit `tw_Nazwa` w GT jest krótki (nazwy ucięte na ~50 znakach), pełna nazwa żyje w sklepie.
- **EAN własny z puli `5900805…`** (prefiks GS1 firmy). Ma go 147 kompletów i ~240 innych towarów (warianty, np. `MAGI36884G`). Numery idą po kolei: ostatni `5900805605088`, wolne m.in. `…5071`, `…5095`, `…5101`. **Jak pula jest prowadzona (rejestr w MojeGS1? arkusz?), trzeba potwierdzić u usera** — luka `…5071` sugeruje, że numer bywa rezerwowany poza GT.
- **Skład** w `tw_Komplet` (`kpl_IdKomplet`, `kpl_IdSkladnik`, `kpl_Liczba`, klucz `kpl_Id` z licznika `ins_ident` `tw_Komplet`). Wielopak = jeden wiersz z `kpl_Liczba = 5`.
- **Ceny** (`tw_Cena`) — komplet ma własne ceny na wszystkich poziomach, jak zwykły towar:
  | poziom | waluta | znaczenie (z danych) | NERG1132Z4 |
  |---|---|---|---|
  | 0 | PLN | cena zakupu = **suma składników × ilość** (42,25 = 39 + 3×0,47 + 1,11 + 0,73) — do potwierdzenia, czy GT liczy ją sam | 42,25 netto |
  | 1 | PLN | detal | 104,99 brutto |
  | 2 | RON | eMAG | 169,99 brutto |
  | 3 | PLN | internet (sklep) | 104,99 brutto |
  | 4 | EUR | ? | 11,96 brutto |
  | 5 | EUR | Hurt (do Sellasist Hurt_PLN) | 13,53 netto |
- **Pola własne** (`pw_Dane`) i `tw_Pole1`/`tw_Pole8` są **kopią głównego składnika**: wymiary, waga, op. zbiorcze (NERG1132Z4 ma wymiary samej wyrzutni `36x32x7`, choć w zestawie są jeszcze 3 paczki strzałek, opaska i cele), adresy półek składnika. WMS i tak traktuje komplet jako `ZEST` (bez lokalizacji), więc adresy w polach to notatka człowieka.
- **Stan** kompletu w GT prawie zawsze 0 — montuje go „Automatyczna Kompletacja” (RW składników + PW kompletu) przy sprzedaży. Ile kompletów da się złożyć, liczy WMS w `services/gt-zestawy.js` (`doZlozeniaMapa`).

## 2. Zapis do GT: przez Sferę, nie SQL-em

**Wniosek: komplet zakładamy przez Sferę (most C#).** SQL odpada:
- `tw__Towar` ma **13 triggerów** (m.in. `tr_TwTowar_Inserting`, `thw_tr_towar_insert`, `tr_tw__Towar_Synch_insert`, `s2s_AktualizacjaProduktu`, `TRI_InsSearch_tw__Towar`) — synchronizacje do systemów zewnętrznych, wyszukiwarka, historia zmian. Ręczny INSERT nie odtworzy tego, co robi Subiekt przy zapisie towaru (wiersze `tw_Cena`, `tw_Stan` per magazyn, indeks wyszukiwania).
- Klucze `tw__Towar`, `tw_Cena`, `tw_Komplet`, `tw_KodKreskowy`, `pw_Dane` nadaje `spIdentyfikator` / `ins_ident` — ominięcie licznika już raz zepsuło zapis pól własnych (incydent `pw_Dane` 2026-07-20).

**Sfera ma wszystko, czego trzeba** (dokumentacja `gta.chm` z `C:\Program Files (x86)\InsERT\InsERT GT\Pomoc\`):

| Krok | Sfera |
|---|---|
| nowy komplet | `Subiekt.TowaryManager.DodajKomplet()` (od GT 1.12) |
| symbol, nazwa, grupa | `Towar.Symbol`, `.Nazwa`, `.GrupaId` |
| skład | `Towar.Skladniki.Dodaj(tw_Id składnika)` → `TwSkladnik.Ilosc = n` |
| EAN | `Towar.KodyKreskowe.Podstawowy = "5900805…"` |
| ceny | `Towar.Ceny.Element(i).Brutto` / `.Netto` (ustawienie przelicza netto/marżę jak ręcznie w Subiekcie) |
| flaga sklepu | `Towar.DoSklepuInternetowego = True` |
| pola własne | `Towar.PoleWlasne("Wymiary") = "36x32x7"` (zapis do `pw_Dane` przez Sferę — licznik `pwd_Id` obsługuje Sfera) |
| zapis | `Towar.Zapisz()`, potem `Zamknij()` |

## 3. Test na Z_KAJTEK (2026-11-18)

Druga instancja mostu (`C:\Users\Adm\most-komplet`, zadanie `WMS-Most-Test-Komplet`, `127.0.0.1:5001`, baza Z_KAJTEK) obok produkcyjnego — **licencja Sfery pozwala na dwie sesje naraz**.

- **Mapowanie cen**: `Ceny.Element(i)` = poziom `i` w `tw_Cena`: 1 Detaliczna PLN · 2 Emag_RO RON · 3 **Specjalna PLN (sklep)** · 4 EUR · 5 Hurt EUR. Ustalone trybem *podgląd* (komplet budowany w pamięci Subiekta i zamykany bez `Zapisz` — liczniki GT nie drgnęły).
- **Zapis**: `tw__Towar` (rodzaj 8, `szt.`, VAT 23 % domyślnie), `tw_Komplet` (wiersz na składnik, `kpl_Liczba`), `tw_Cena`, `tw_Stan` na wszystkich 9 magazynach (0), EAN w `tw_PodstKodKresk`, pola własne w `pw_Dane`. **Wszystkie klucze z `ins_ident`** (licznik podbity równo z wierszami: `tw__Towar` 93696→93697, `tw_Komplet` +2, `pw_Dane` +1).
- **Cena zakupu (poziom 0) Sfera sama NIE liczy** (pierwszy test: 0, marża 100 %). Dlatego most ustawia `CenaKartotekowa` = suma kosztów składników × ilość **przed** cenami sprzedaży (na nowym towarze `CenaKartotekowa` przelicza poziomy wg narzutów — ceny z żądania kładziemy na wierzch). Drugi test: 2,95 zł, ceny sprzedaży bez zmian, marża policzona.
- **Zajęty EAN** Sfera odrzuca sama (`0x800411EF` „Wartość musi być unikalna”), bez zapisu — most zwraca odmowę biznesową (409). Skrypt sprawdza EAN, symbol i składniki wcześniej, w SQL.

## 3a. Jak założyć zestaw

1. Wolny EAN z puli: arkusz **„eany GS1”**, zakładka **Kajtek+** (kolumna C = GTIN, H = nazwa, **J = symbol**; A zostaje pusta) — wpisać nazwę (H) i symbol (J) w pierwszym wierszu z wolnym GTIN-em (rezerwacja, zasada usera 2026-11-19: symbol zawsze w J).
2. Plik zestawu (przykład niżej), `node scripts/zestaw-zaloz.js zestaw.json --baza <baza> --most <url>` → walidacja + podgląd w Sferze; potem to samo z `--zapisz`.
3. `--baza` musi być bazą, do której wpięty jest most (walidacja idzie SQL-em, zapis Sferą). Most słucha tylko na `127.0.0.1` SRV — z Maca przez tunel `ssh -L 15001:127.0.0.1:5001 Adm@<SRV>`.

```json
{ "symbol": "SPIN20148931Z2", "nazwa": "Psi Patrol Rubble z buldożerem + Marshall z wozem",
  "ean": "5900805605095",
  "skladniki": [{ "symbol": "SPIN20148931", "ilosc": 1 }, { "symbol": "SPIN20148929", "ilosc": 1 }],
  "ceny": [{ "poziom": 1, "brutto": 119.98 }, { "poziom": 2, "brutto": 172.98 }, { "poziom": 3, "brutto": 89.99 },
           { "poziom": 4, "brutto": 11.82 }, { "poziom": 5, "netto": 13.00 }],
  "pola_wlasne": { "Wymiary": "42x22x8" } }
```

Reguły (decyzje usera 2026-11-18):
- **Ceny:** sklep (poz. 3) ustalany ręcznie (tu ok. 5 % taniej niż osobno), pozostałe poziomy = suma składników. Koszt (poz. 0) liczy skrypt.
- **Wymiary** podaje człowiek: paczka ze składników **rozłożonych na płasko** (dwa pudełka 22x21x8 obok siebie → 42x22x8).
- **Ze składników (suma × ilość) liczy skrypt**, ręcznie wpisana wartość musi się zgadzać z sumą: „Waga produktu” (wymagana) i „Waga opakowania Karton / Tworzywa / Zbiorcze” (wszystkie składniki puste = pole puste; część pusta = błąd, bo suma byłaby zaniżona). Wagi przyjmujemy tylko jako `0` albo kg z przecinkiem — liczba całkowita (historycznie gramy) blokuje, do poprawy w GT.
- **Baterie** (`ilość;typ;T/N`, w GT też `3 x LR44 - T`): suma po typie (Furby 2 × 3 LR44 → `6;LR44;T`); różne typy albo T z N → wpisać ręcznie w `pola_wlasne`.
- **„Ilość w opakowaniu zbiorczym”** zestawu zostaje **pusta** (zestaw nie ma kartonu zbiorczego; WMS czyta puste jako „potrzebny karton wysyłkowy”).
- Pola czytane po **nazwie** z `pw_Pole` (numer `pwd_TekstNN` różni się między bazami). Grupa = grupa pierwszego składnika. `tw_Pole1/8` (adresy półek) puste — WMS traktuje komplet jako `ZEST`.

## 4. Sklep poszukiwaczefrajdy.pl

Karta zestawu = zwykła karta wg zasad z `docs/wystawianie-sklep.md` (worktree automate-product-listing), plus **dwie rzeczy specyficzne dla zestawu** (uwaga usera 2026-11-18):
- **`Product.IsSet` = zaznaczone** („produkt jest zestawem”),
- **`ProductsSet.Ids[]` = id kart składników w sklepie** (np. 36931 Rubble, 36930 Marshall). Karty składników muszą istnieć wcześniej.

Sklep pokazuje **stan kompletu** (karta 38122 `SPIN20148931Z1` ma 233 szt., choć w GT komplet ma 0) — liczy go BaseLinker ze składników po powiązaniu. Nowa karta zaczyna z ceną i stanem 0 (zasada 2).

**Wzór = najnowsza karta-zestaw z tej samej serii** (dla Psi Patrol: 38122 „…Rubble 20148931 + Tablet Psi Patrol 91608”). Bierzemy z niej kategorię, profil i cechy, a podmieniamy:
- nazwę, opis, cechę 151 „Symbol” (numery katalogowe obu składników po przecinku) i cechę 145 „Wymiary opakowania”,
- zestaw i składniki, kod, EAN, zdjęcia i kanały.

Formularz najprościej zbudować, serializując kartę-wzór (select bez wyboru pomijać).
- **Nazwa:** nazwa składnika 1 z numerem + „ + ” + nazwa składnika 2 bez „Psi Patrol Zestaw” z numerem — kończy się numerem katalogowym.
- **Galeria = 6 zdjęć** (zasada usera 2026-11-18, ograniczył tak galerię 38239):
  1. nowa miniatura — oba pojazdy z figurkami, jeden pod drugim, na białym kwadracie 1000×1000. **Na górze drugi pojazd (ten, który odróżnia zestaw), na dole wspólny składnik serii** (Rubble z buldożerem) — poprawka usera 2026-11-18, podmienione na 38239 i 38250–38255;
  2. po **2 zdjęcia każdego składnika**: pojazd z pieskiem w środku (ujęcie pod kątem) i pojazd obok figurki. Bierzemy je z kart składników po nazwie pliku, bez ponownego wgrywania;
  3. nowe zdjęcie z oboma pudełkami.
  Pojedynczych pudełek, ujęć z przodu, lifestyle'ów i choinek **nie dajemy**.
- **Pliki zdjęć sklepu:** `https://poszukiwaczefrajdy.pl/services/picasso/thumb/<nazwa>`.
- **Opis:** jak na kartach składników — **bez tabeli**: `<p><b>nazwa</b></p>`, 2 akapity `<p>` językiem korzyści, `<p><b>Wyjątkowe cechy produktu:</b></p><ul>…</ul>`, `<p><b>Zawartość zestawu:</b></p><ul>…</ul>`, `<p><b>Wymiary pojazdów:</b> …</p>`, `<p><b>Wiek:</b> 3+</p>`. Fakty wyłącznie z kart składników. **Nie kopiować układu z 38122** — ma listy w `<table><th>` z pustymi wierszami i na stronie lista ląduje w wąskiej kolumnie bez punktorów (tak rozjechała się pierwsza wersja 38239, poprawione 2026-11-18).

**Założona 2026-11-18: karta 38239** `SPIN20148931Z2`, EAN 5900805605095, zestaw ze składnikami 36931 + 36930, profil 47, kategoria 904, kanały 1,3,4,5,6,7. Ma 12 zdjęć, z czego nowe są dwa: miniatura `uqvxpxx3.jpg` i oba pudełka `nixx5i34.jpg`. Cena i stan 0 — czeka na powiązanie w BaseLinkerze.

### Seria Rubble + pojazd (2026-11-18)

Wszystkie 7 zestawów ma ten sam schemat: SPIN20148931 (Rubble) + 1 pojazd po 1 szt.

| Symbol | Drugi składnik | tw_Id | Karta sklepu | EAN | Sklep (poz. 3) | Koszt |
|---|---|---|---|---|---|---|
| SPIN20148931Z2 | SPIN20148929 Marshall | 96720 | 38239 | 5900805605095 | 89,99 | 40,95 |
| SPIN20148931Z3 | SPIN20148932 Skye | 96721 | 38250 | 5900805605101 | 89,99 | 40,95 |
| SPIN20148931Z4 | SPIN20148933 Zuma | 96722 | 38251 | 5900805605118 | 89,99 | 40,95 |
| SPIN20148931Z5 | SPIN6071212 Ryder | 96723 | 38252 | 5900805605125 | 89,99 | 48,99 |
| SPIN20148931Z6 | SPIN20153731 Święta Chase | 96724 | 38253 | 5900805605132 | 94,99 | 43,12 |
| SPIN20148931Z7 | SPIN20153733 Święta Skye | 96725 | 38254 | 5900805605149 | 94,99 | 43,12 |
| SPIN20148931Z8 | SPIN20153732 Święta Marshall | 96726 | 38255 | 5900805605156 | 94,99 | 43,12 |

- **Cena sklepu** = suma cen sklepu składników × 0,95, zaokrąglona do pełnych złotych, minus 1 gr (94,98 → 89,99; 99,98 → 94,99). Pozostałe poziomy = suma składników.
- **Nazwa w GT** (≤ 50 znaków): „Psi Patrol Rubble z buldożerem + ‹pojazd›”. Gdy przekracza limit, skracamy, np. „+ Skye helikopter”.
- **Nazwa w sklepie:** „‹nazwa karty Rubble› + ‹pojazd› z Figurką ‹postać› ‹nr katalogowy›”.
- Wszystkie składniki mają pudełko 22x21x8, więc zestaw ma wymiary 42x22x8. Wagi i wagi opakowań są sumowane przez skrypt.
- Karty powstały na wzorze 38239 z `Product.IsSet` zaznaczonym przed zapisem. Wszystkie mają cenę i stan 0 i czekają na BaseLinkera.

### Torba cel + strzałki (+ Fang) (2026-11-19)

| Symbol | Skład | tw_Id | Karta sklepu | EAN | Sklep | Koszt |
|---|---|---|---|---|---|---|
| NERCHITORLZ33Z1 | NERCHITORLZ33 torba cel + NERCHIKOL100 strzałki 100 szt. | 96727 | 38256 | 5900805605163 | 65,99 | 15,23 |
| NERCHITORLZ33Z2 | torba + strzałki + NERE6973 Nerf Fang QS-4 | 96728 | 38257 | 5900805605170 | 108,99 | 28,26 |

- Decyzje usera: strzałki NERCHIKOL100, Fang NERE6973 (niebieski), **oba symbole od torby**, wymiary 37x32x10 (strzałki i Fang leżą na płaskiej torbie). Cena wg reguły Rubble.
- Karta 1: wzór = karta torby 36071 (profil Wyrzutnie, kategorie: dodatki do wyrzutni + strzałki, cecha 157 „100”), galeria 5 zdjęć (składniki bez pudełek).
- Karta 2: wzór = istniejący zestaw Fanga NERE6973Z1 (30852: profil Nerf, Karabiny / Alpha Strike, cecha 157 „10+100”), galeria 8 zdjęć — 2 na składnik + pudełko Fanga na końcu.
- Nazwy w sklepie kończą się numerem katalogowym, gdy ma go któryś składnik (E6973). Torba i strzałki go nie mają.

## 4a. BaseLinker (zbadane 2026-11-18, niedokończone)

- Subiekt → BaseLinker łączy **SubLinker** (instancja „Magazyn_synchronizacja”, konfiguracja `C:\ProgramData\Infologic\Sublinker\8f4a4fb0-….json`, log `C:\Users\Sublinker\AppData\Roaming\Infologic\SubLinker\Magazyn_synchronizacja_info.log*`). Co kilka minut aktualizuje stany i ceny **tylko produktów, które już są w BL** (dopasowanie `SymbolSKU`). `AddStorageItems = false`, więc **nowych produktów nie zakłada** — nowy zestaw sam do BL nie trafi.
- Zestawy w BL to **produkty typu zestaw** (stan liczony przez BL ze składników). SubLinker co przebieg próbuje im ustawić stan i dostaje setki odmów „Stan zestawu jest wyznaczany automatycznie…” — to szum w logu, nie awaria.
- **Otwarte:** jak dotychczasowe zestawy (np. `SPIN20148931Z1`) trafiały do BL — ręcznie w panelu, import ze sklepu (kanał 7 na karcie) czy inaczej. Do sprawdzenia w panelu BL, porównując Z1 i Z2. Odczytu API kluczem z konfiguracji SubLinkera nie robimy (brak zgody).

## 5. Platformy

- Własny EAN `5900805…` nie ma produktu w katalogach Allegro/Amazon/eMAG — każda platforma wymaga **założenia nowego produktu**, nie dopięcia do istniejącej karty. Ogólne zasady Allegro: `docs/wystawianie-allegro.md`.

### Allegro: zestaw jako jeden produkt

Zestaw wystawiamy jako **jedną ofertę na nowej karcie produktu** z EAN-em zestawu (nie „zestaw 2 produktów” z kart składników — decyzja usera 19.11 przy Psi Patrol). Karta powstaje razem z ofertą (`productSet[0].product` z `name`, `category`, `parameters`, `images` w `POST /sale/product-offers`).
- **Marka karty — od początku marka oryginalnego składnika** (zasada usera 20.11): zestaw z oryginalnym Nerfem = karta z marką **NERF** (precedens: karta `11ac0f5b…`, nasz EAN 5900805602353, marka NERF, LISTED). **Marki karty potem nie zmienisz:** karta z naszym EAN-em już istnieje, a PATCH oferty z inną marką = 422 „wartość parametru Marka … różni się od wartości w produkcie z katalogu”. Zostaje zgłoszenie zmiany karty, którego bez zgody usera nie wysyłamy. „Poszukiwacze Frajdy” tylko wtedy, gdy Allegro zablokuje markę składnika (Spin Master przy Psi Patrol). Producent GPSR: „Producent Kajtek” (`e2143a70…`), bezpieczeństwo jak na ofercie składnika.
- Parametry karty: EAN zestawu, wymiary i waga z GT, kod producenta = symbol zestawu, kod taryfy celnej (zabawki-broń `95030081`), wiek, materiał, kolor — ze słownika kategorii.
- Przy karcie z marką „Poszukiwacze Frajdy”: **start bez obcej marki** w tytule, nazwie karty i opisie (NERF, Psi Patrol…), bo inaczej aktywacja pada na ochronie marek. Po ACTIVE (0–45 min) PATCH pełnego tytułu i opisu + przelicznik CZ/SK/HU. Przy karcie z marką składnika jego nazwa w tytule nie jest obcą marką.
- **Opis (zasada usera 20.11):** miniatura + `<h1>` = tytuł + wstęp; potem **sekcja na każdą część zestawu: jej zdjęcie + jej zalety**; zdjęcia bez tekstu parami pomiędzy; na końcu **podsumowanie** (zawartość, 1 zdanie, wymiary, wiek, kod) **ze zdjęciem całego zestawu**. Fakty tylko z kart składników.
- NERCHITORLZ33Z2 poszedł jeszcze z marką „Poszukiwacze Frajdy”; zgłoszenie zmiany na NERF (`ba98a930…`, 20.11) wysłane przez API, zanim user napisał „nie zgłaszaj” — czeka na weryfikację Allegro.
- **Cena: pytać usera.** Psi Patrol: 15% marży z kalkulatora repricera (polecenie usera 19.11); NERCHITORLZ33Z2: 69,99 zł (sklep 108,99, składniki osobno na Allegro 114,98).
- Skrypty na SRV: `C:\Users\Adm\al-psi-nowa.js` (Psi), `C:\Users\Adm\al-lz33z2.js` (wzór z opisem per składnik: podgląd / `--utworz --cena X` / `--dokoncz`).

| Zestaw | Oferta ekajtek | Karta Allegro | Cena |
|---|---|---|---|
| SPIN20148931Z2–Z8 | 19137572079 … 19137574086 | nowe, EAN zestawów | 15% marży |
| NERCHITORLZ33Z2 | 19140198785 | 260c9589-483b-49f2-a417-1e84e3968a5f (marka Poszukiwacze Frajdy) | 69,99 × 50 |
| NERCHITORLZ33Z1 | 19140571694 | e258dc7f-25dc-49fb-b26c-62be382e3263 (marka Blaster Squad = marka torby) | 49,99 × 50 |

Skrypt Z1: `C:\Users\Adm\al-lz33z1.js` (kopia Z2 z galerią karty 38256). Miniatura Z1 (20.11): kompozycja z OpenAI `gpt-image-2.6-sunburst` (`/v1/images/edits`, ~0,06 USD) poprawiona lokalnie — stosy strzałek i „100” przeklejone z miniatury Z2, tarcza „25” podmieniona.

## 5a. Pierwszy zestaw na produkcji (2026-11-18)

`SPIN20148931Z2` „Psi Patrol Rubble z buldożerem + Marshall z wozem”, **tw_Id 96720**, EAN 5900805605095, grupa SpinMaster (307), skład SPIN20148931 + SPIN20148929 po 1 szt. Ceny 119,98 zł / 172,98 RON / **89,99 zł sklep** / 11,82 EUR / Hurt 13,00 EUR netto, koszt 40,95 zł (marża sklepu 44 %). Waga 0,4 kg, opakowania karton 0,02 / tworzywa 0,002 / zbiorcze 0,8 kg, wymiary 42x22x8, flaga sklepu. Wagi gabarytowe (`pwd_Tekst09/10`) i docinkę uzupełni `waga-gabarytowa-job` (co 6 h).

Założony przez kopię mostu z nowym kodem (`C:\Users\Adm\most-komplet`) przełączoną na chwilę na OKITRADE — produkcyjny most nietknięty. Po zapisie kopia zatrzymana, zadanie `WMS-Most-Test-Komplet` usunięte, konfiguracja kopii wróciła na Z_KAJTEK (zostały w niej jawne hasła Sfery w `appsettings.json`, w profilu Adm). **Od 2026-11-18 (commit fbdbf13) `/api/komplet` jest w produkcyjnym moście na `:5000`** — kolejne zestawy: `--baza OKITRADE --most http://127.0.0.1:5000` (na SRV albo przez tunel SSH). Kopia testowa (`C:\\Users\\Adm\\most-komplet`, konfiguracja Z_KAJTEK) zostaje do testów — uruchamiana ręcznie na `:5001`.

## 6. Otwarte

- Powiązanie karty 38239 w BaseLinkerze (wtedy dostanie cenę i stan); oferty na platformach (sekcja 5).
- Komplety testowe `TESTKOMPLETWMS1..3` (tw_Id 93696–93698) zostają w Z_KAJTEK — baza testowa.
