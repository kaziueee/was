# Tworzenie zestawów (kompletów) — przepis

Status: **2026-11-18 — zapis przez Sferę przetestowany na Z_KAJTEK** (3 komplety testowe `TESTKOMPLETWMS1..3`). Narzędzie: endpoint mostu `POST /api/komplet` + `scripts/zestaw-zaloz.js`. Produkcja: **SPIN20148931Z2 założony 2026-11-18 (tw_Id 96720)**.
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

1. Wolny EAN z puli: arkusz **„eany GS1”**, zakładka **Kajtek+** (kolumna C = GTIN, A = symbol, H = nazwa) — wpisać symbol i nazwę w pierwszym pustym wierszu (rezerwacja, zasada usera).
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
- **Galeria** (jak 38122):
  - nowa miniatura: oba produkty razem na białym kwadracie 1000×1000,
  - zdjęcia składnika 1, potem zdjęcia składnika 2 — już wgrane do sklepu, podajemy ich nazwy plików, nie wgrywamy drugi raz,
  - pudełko 1, pudełko 2, na końcu nowe zdjęcie z oboma pudełkami.
- **Pliki zdjęć sklepu:** `https://poszukiwaczefrajdy.pl/services/picasso/thumb/<nazwa>`.
- **Opis:** jak na kartach składników — **bez tabeli**: `<p><b>nazwa</b></p>`, 2 akapity `<p>` językiem korzyści, `<p><b>Wyjątkowe cechy produktu:</b></p><ul>…</ul>`, `<p><b>Zawartość zestawu:</b></p><ul>…</ul>`, `<p><b>Wymiary pojazdów:</b> …</p>`, `<p><b>Wiek:</b> 3+</p>`. Fakty wyłącznie z kart składników. **Nie kopiować układu z 38122** — ma listy w `<table><th>` z pustymi wierszami i na stronie lista ląduje w wąskiej kolumnie bez punktorów (tak rozjechała się pierwsza wersja 38239, poprawione 2026-11-18).

**Założona 2026-11-18: karta 38239** `SPIN20148931Z2`, EAN 5900805605095, zestaw ze składnikami 36931 + 36930, profil 47, kategoria 904, kanały 1,3,4,5,6,7. Ma 12 zdjęć, z czego nowe są dwa: miniatura `uqvxpxx3.jpg` i oba pudełka `nixx5i34.jpg`. Cena i stan 0 — czeka na powiązanie w BaseLinkerze.

## 5. Platformy

- Własny EAN `5900805…` nie ma produktu w katalogach Allegro/Amazon/eMAG — każda platforma wymaga **założenia nowego produktu**, nie dopięcia do istniejącej karty. Allegro: przekazać sesji Allegro (`docs/wystawianie-allegro.md`), nie dublować.

## 5a. Pierwszy zestaw na produkcji (2026-11-18)

`SPIN20148931Z2` „Psi Patrol Rubble z buldożerem + Marshall z wozem”, **tw_Id 96720**, EAN 5900805605095, grupa SpinMaster (307), skład SPIN20148931 + SPIN20148929 po 1 szt. Ceny 119,98 zł / 172,98 RON / **89,99 zł sklep** / 11,82 EUR / Hurt 13,00 EUR netto, koszt 40,95 zł (marża sklepu 44 %). Waga 0,4 kg, opakowania karton 0,02 / tworzywa 0,002 / zbiorcze 0,8 kg, wymiary 42x22x8, flaga sklepu. Wagi gabarytowe (`pwd_Tekst09/10`) i docinkę uzupełni `waga-gabarytowa-job` (co 6 h).

Założony przez kopię mostu z nowym kodem (`C:\Users\Adm\most-komplet`) przełączoną na chwilę na OKITRADE — produkcyjny most nietknięty. Po zapisie kopia zatrzymana, zadanie `WMS-Most-Test-Komplet` usunięte, konfiguracja kopii wróciła na Z_KAJTEK (zostały w niej jawne hasła Sfery w `appsettings.json`, w profilu Adm). **Docelowo**: commit + `aktualizuj-most.cmd`, wtedy `/api/komplet` jest w produkcyjnym moście na `:5000`.

## 6. Otwarte

- Powiązanie karty 38239 w BaseLinkerze (wtedy dostanie cenę i stan); oferty na platformach (sekcja 5).
- Wdrożenie `/api/komplet` do produkcyjnego mostu (commit, `aktualizuj-most.cmd`).
- Komplety testowe `TESTKOMPLETWMS1..3` (tw_Id 93696–93698) zostają w Z_KAJTEK — baza testowa.
