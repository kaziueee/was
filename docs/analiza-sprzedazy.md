# Analiza sprzedaży — moduł w WMS

Projekt z rozmowy 2026-10-20, **bez kodu**. Decyzje usera oznaczone **[decyzja]**. Liczby zmierzone tego dnia
na OKITRADE (tylko SELECT), okno „90 dni” = 22.07–20.10.2026, „rok” = 20.10.2025–19.10.2026.

## Po co

1. **Podgląd sprzedaży, który działa szybko**: co się sprzedało danego dnia, jak to się ma do analogicznego dnia
   i okresu rok temu, w podziale na kanały i grupy towarów.
2. **Telefon**: szybkie podsumowanie dnia i przewijanie (swipe) produktów: zdjęcie, SKU, ile poszło na Allegro,
   Amazonie i eMAG, z jaką marżą i zyskiem.
3. **Trendy i centrum alertów** (inspiracja: base analytics): co rośnie, co traci, co się kończy, co zalega,
   gdzie sprzedajemy ze stratą.
4. **Później: tiery towarów dla repricera** (`docs/strategie-cenowe.md`). Od tego zaczęła się rozmowa, ale
   tier jest odłożony (niżej).

## ERP Dashboard — co było i co z niego bierzemy

Osobny projekt z maja–czerwca 2026 (`~/Documents/Projekty AI/ERP DASHBOARD`, poza repo): Metabase na Macu
(`~/Metabase`) podłączony kontem `metabase` (tylko odczyt) do OKITRADE, 14 zapytań w `metabase/queries/` i
pięć widoków utworzonych w OKITRADE 18–26.05.2026:

| Widok | Co liczy |
|---|---|
| `Analiza_Sprzedazy_Historia` | 730 dni, FS + PA z K4, dzień × kanał (kategoria dokumentu) × kraj płatnika × SKU; zestawy rozbite na składniki wg `tc_CenaBrutto2`; koszt = dzisiejszy `tc_CenaNetto0`; stan = suma wszystkich magazynów (z BRK i K4R) |
| `Dashboard_Sprzedaz` | per SKU: szt / obrót / zysk / marża 30, 90 i 730 dni, dni do wyczerpania, status PILNE (<30 dni) / UWAGA (<60) / OK; tylko SKU z ≥3 szt. w 30 dni |
| `Dashboard_Wyprzedane` | stan 0 i >5 szt. w 30 dni |
| `Dashboard_YoY_30dni` | 30 zamkniętych dni vs 364 dni wcześniej |
| `Dashboard_Faktury_Dzien` | liczba FS i obrót dzień po dniu + r/r |

Niezrobione były: rotacja, marże z prowizjami, alerty, odbudowa porównania lat, pilot Evidence.dev. Karty
liczyły się 24–37 s, bo widoki przeliczają 730 dni przy każdym otwarciu.

**[decyzja] Moduł w WMS zastępuje ERP Dashboard.** Jedna definicja sprzedaży, z której czytają ekrany, telefon,
później repricer i zadanie sprzedażowe. Widoki w OKITRADE i Metabase zostają, jak są (nie kasujemy), ale nic
nowego tam nie budujemy. Metabase można wyłączyć, gdy moduł przejmie jego ekrany.

Co bierzemy z widoków (sprawdzone na danych):
- **Kanał z kategorii dokumentu (`dok_KatId` → `sl_Kategoria`).** To rozwiązało dziurę w historii rynków (niżej).
- **Rok temu = 364 dni wstecz** (ten sam dzień tygodnia) — tak jak `Dashboard_YoY_30dni`.

Czego nie bierzemy: `dok_Typ IN (2, 21)` z filtrem K4 nigdy nie łapał paragonów (PA idą wyłącznie z MAG); stanu
„wszystkie magazyny” (wlicza BRK i K4R); jedynego widoku zestawów rozbitych na składniki.

## Źródła danych

### Sprzedaż

| Co | Gdzie w GT | Skala (90 dni) | Decyzja |
|---|---|---|---|
| Sprzedaż internetowa | FS z K4: `dok_Typ=2, dok_Status=1, dok_MagId=4`, pozycje pod `ob_DokHanId`, `tw_Rodzaj` 1 i 8 | 29 395 FS, 42 271 szt., 2,79 mln zł netto, 2604 towary | podstawa |
| Zamówienia | ZK (`dok_Typ=16`), `FS.dok_DoDokId = ZK.dok_Id` | 99,7% FS ma ZK; 38 ZK z 27 587 bez FS (0,14%) | data zamówienia + bieżący dzień |
| Paragony | PA (`dok_Typ=21`) **wyłącznie z MAG** | 2002 PA, 5410 szt., 161 tys. zł, 2804 towary | **[decyzja] osobny kanał „Sklep”, poza tierem** |
| Korekty | KFS (`dok_Typ=6`) z K4 | 832 KFS, 1056 szt. (2,5%), 78 tys. zł | **[decyzja] tylko osobna kolumna „zwroty”, nie odejmujemy** |
| FS z MAG | `dok_MagId=1` | 12 FS, 312 szt. (0,7%) | pomijamy, jak w zadaniu sprzedażowym (decyzja 2026-10-06) |

**Data dnia [decyzja: „oba na razie”].** Każda pozycja ma dwie daty: **zamówienia** (ZK) i **faktury** (FS).
Ekrany mają przełącznik „wg zamówienia / wg faktury”. Po co obie: faktura powstaje tego samego dnia w 37%
przypadków, następnego w 48%, po 2 dniach w 9%, po 3 w 5%, a w weekend wcale (poniedziałek 12.10 = 936 FS). Wg
faktury dzień bieżący jest zawsze niepełny, a porównanie dnia z dniem rok temu miesza weekendy. Wg zamówienia
dzisiejsza sprzedaż jest widoczna od razu (z ZK), a po wystawieniu FS liczby się potwierdzają.

**Data ZK nie ma godziny i przy przestoju integracji dostaje datę wczytania.** W weekend 18–19.10.2025 do GT
weszły 2 ZK (sobota) i 0 (niedziela), a poniedziałek 20.10 zebrał 1047 ZK zamiast ~430 — porównanie „dzień do
dnia” z tym poniedziałkiem jest mylące (makieta: −64% za dzień przy −4% za 7 dni). Ratunek dla Allegro (~75%
sprzedaży): **ZK ma w `pwd_Tekst05` identyfikator zamówienia Allegro w formacie UUID v1, z zaszytą datą i godziną
złożenia** — ZK z 20.10.2025 naprawdę złożono 18.10 między 00:09 a 05:42. Projekt Rozliczenia używa tego samego
(decyzja usera tam: data zamówienia wyłącznie z dokumentów operatora, nigdy z `date_add` BaseLinkera). Dla
Amazona — raport transakcji, Kauflandu — Wareneingang. Etap 1: dla Allegro data i godzina z UUID, dla reszty data
ZK; dni z anomalią liczby ZK oznaczać na ekranie.

Jedno zamówienie = jeden zestaw wierszy: dopóki nie ma FS, liczby pochodzą z ZK (status „zamówione”), po FS
z faktury (status „zafakturowane”). Zadanie sprzedażowe zostaje przy dacie faktury, czyli przy dzisiejszym
znaczeniu.

**Historia:** FS z K4 od 2023 (19 tys.), 2024 – 143 tys., 2025 – 188 tys., 2026 do 20.10 – 104 tys. Porównanie
rok do roku dzień po dniu jest pełne od 2024.

### Kanał — rozstrzygany raz, przy wczytaniu

Pole „Źródło” bywało puste albo „marketplace”, ale kategoria dokumentu i kraj płatnika niosą rynek. Kanał
rozstrzyga kaskada reguł, a wynik zapisujemy razem z **regułą, która go dała** (`kanal_regula`), żeby ekran
mógł powiedzieć, ile sprzedaży ma kanał z reguły zastępczej:

1. **„Źródło” FS** (`pw_Dane`, `pwd_TypObiektu=-2`, `pwd_Tekst04`) przez `kolumnaZrodla`
   (`pricing/pulpit-model.js`): `Amazon_DE`, `Kaufland_DE`, `emagro`, `empik`, `Allegro - <konto>`, `amazon` + PLN…
2. **Kategoria FS** (`dok_KatId`): `Amazon_DE` (17), `Amazon_FR` (19), `Kaufland` (16), `Emag_RO/HU/BG`
   (13–15), `Empik` (22), `Amazon_PL` (20), `Erli` (23), `Allegro` (24), `InPost_Buy` (21).
3. **Kategoria ZK** — na ZK kanał bywa w kategorii, gdy na FS go nie ma: w tygodniu 6–13.10 ZK miały
   `Internet` (2172), `Amazon_DE` (391), `Empik` (142), `Emag_RO` (83), `Amazon_FR`, `Amazon_PL`, `Kaufland`,
   `Emag_BG/HU`. **`Internet` = Allegro — potwierdzone** (15–20.10.2026: 1527 ZK z `Internet`, wszystkie ze
   „Źródłem” `Allegro - ekajtek_pl` / `Allegro - NaTropieZabawek`). ZK ma też własne „Źródło” (`pwd_TypObiektu=-8`,
   `Tekst01`) w tej samej pisowni co FS, poza Amazon PL (`Amazon.de` + kategoria `Amazon_PL`) i eMAG (puste).
   **„Źródło” `amazon` w EUR** (BaseLinker, 2025 — wtedy tędy szedł Amazon EU) → rynek z kraju płatnika (reguła 4);
   `amazon` w PLN = Amazon PL. Bez tego Amazon DE rok temu wychodził zerowy (makieta 2026-10-20: 106 tys. zł w
   październiku 2025 siedziało w osobnym kubełku).
4. **Kraj płatnika + waluta** (`adr__Ewid`, `adr_IdObiektu = dok_PlatnikId`, `adr_TypAdresu = 1` →
   `sl_Panstwo`): Niemcy/Austria + EUR → Amazon DE, Francja → Amazon FR, Włochy → Amazon IT, Rumunia/RON →
   eMAG RO, Bułgaria → eMAG BG. Czechy/Słowacja/Węgry przy Allegro to rynek zagraniczny Allegro.
5. Reszta → „Inne”.

**Historia Amazon EU i Kauflandu sprzed 14.10 jest odtwarzalna z samego GT** — bez Sellasist API, raportów
SP-API i bez UPDATE w GT:
- **Od 26.08.2026** każda FS z Sellasist ma kategorię: `Amazon_DE` 2011 FS z „marketplace”, `Amazon_FR` 245,
  `Kaufland` 140. Po 14.10 kategoria zgadza się ze „Źródłem” w 100%.
- **Przed 26.08** kategoria to „Sprzedaż”, ale rynek wychodzi z kraju płatnika. Sprawdzone na FS z pewnym
  rynkiem: dla `Amazon_DE` 2243 z 2248 płatników to Niemcy lub Austria (5 = Holandia), dla `Amazon_FR` 276 z 277
  to Francja. **Że przed 26.08 „Niemcy + EUR + Sprzedaż” = Amazon DE, to hipoteza — sprawdzić na próbce przed
  wczytaniem historii** (np. ZK `Tekst01` / ID integratora).
- Niepewne: Amazon IT (kategoria „Sprzedaż”, kilka FS — reguła 4), Węgry w HUF przed sierpniem (Allegro HU czy
  eMAG HU), Belgia/Holandia (kilkadziesiąt FS).

**Pokrycie kaskady na sezonie XI–XII 2025** (baza porównań rok do roku; 87 145 FS, 9,57 mln zł netto):

| Reguła | FS | Obrót | Udział |
|---|---|---|---|
| 1. „Źródło” FS | 68 970 | 7,04 mln zł | 73,5% |
| 2. kategoria FS | 762 | 0,11 mln zł | 1,1% |
| 3. kategoria ZK „Internet” | 2 020 | 0,20 mln zł | 2,1% |
| 4. kraj: Niemcy / Austria EUR | 11 769 | 1,55 mln zł | 16,2% |
| 4. kraj: Francja EUR | 3 375 | 0,53 mln zł | 5,5% |
| 4. kraj: Czechy EUR | 33 | 0,10 mln zł | 1,0% (≈3 tys. zł na FS — hurt, nie Allegro; do sprawdzenia) |
| reszta (Holandia, Belgia, Polska PLN, RON, HUF, BGN…) | 216 | 0,05 mln zł | 0,6% |

Czyli ~23% obrotu sezonu (prawie cały Amazon EU) stoi na regule kraju — dlatego sprawdzenie hipotezy wyżej jest
warunkiem wczytania historii, a nie formalnością.

Konto Allegro i kraj zapisujemy osobno: kanał = konto (`Allegro ekajtek`, `Allegro NaTropie`), rynek = kraj
(PL / CZ / SK / HU), na ekranie rozwijane.

**Małe kanały** (nazwy wg projektu Rozliczenia, `scripts/attribution.py`): `tergpl` = Media Expert, `personal` =
sklep własny Fenom + Kup na Ceneo (oraz zamówienia osobiste/telefoniczne), `inpsa` = InPost Pay (sklep „Von
Halsky”), `erli_connector` = Erli, `pigu` = Pigu (LT/LV/EE/FI). Razem z FS bez żadnego źródła to ~2% obrotu
(19.09–20.10: Pigu 3,9 tys., tergpl 5,4 tys., personal 5,7 tys., bez źródła 19,6 tys. zł). Na ekranach jako
rozwijane „Inne kanały”. **B2B do oddzielenia**: Paperie s.r.o. (WDT 0% w EUR, Czechy — to te FS po ~3 tys. zł
z sezonu), żeby hurt nie mieszał się z marżą marketplace'ów.

### Grupy towarów

**[decyzja] Tylko grupy GT** (`tw__Towar.tw_IdGrupa` → `sl_GrupaTw`, 423 grupy), bez własnej warstwy
nadkategorii. To marki i linie na różnych poziomach: Nerf (556 tys. zł w 90 dni), Hot Wheels (275 tys.),
„china import” (156 tys.), Barbie obok MATTEL, HASBRO obok Hasbro Games, „Podstawowa” (105 towarów). Świadomie
pokazujemy je tak, jak są w Subiekcie.

### Stany wstecz — odtworzenie z dokumentów

GT nie trzyma stanów wstecz, ale da się je odtworzyć: **stan na koniec dnia D = dzisiejszy `st_Stan` − suma
ruchów po D**, osobno dla każdego magazynu. Ruch magazynowy niosą wyłącznie dokumenty MM, PZ, WZ, PW i RW
(pozycje pod `ob_DokMagId`; FS i PA ruszają stan przez swoje WZ, KFS przez PZ/WZ ze znakiem):
- PZ (10), PW (12): `+ ob_Ilosc × ob_Znak`; WZ (11), RW (13): `− ob_Ilosc × ob_Znak` (korekty mają znak −1).
- MM (9) to **jeden dokument**: `dok_MagId` = źródło (−), `dok_OdbiorcaId` = cel (+).

Test 2026-10-20 (365 dni wstecz, ~95 tys. towarów × 4 magazyny, `tw_Rodzaj` 1 i 8; stan ujemny = błąd metody):

| Magazyn | Towary z ujemnym stanem | Dni ujemne |
|---|---|---|
| K4G (8) | 0 | 0 |
| LS (6) | 0 | 0 |
| K4 (4) | 22 | 0,008% |
| MAG (1) | 166 | 0,06% |

Stan odtworzony na 20.10.2025: K4 150 tys., K4G 306 tys., MAG 41 tys., LS 6 tys. szt. (zgodne rzędem z
pomiarem 478 tys. szt. na 1.11.2025 z analizy kartonów). Ujemne wartości obcinamy do 0 i logujemy.

Wniosek: **„dni bez stanu” są dostępne od pierwszego dnia**, rok (zapewne i dwa) wstecz. Własne nocne zdjęcie
jest potrzebne tylko na to, czego wstecz nie odtworzymy: **rezerwacje** (`st_StanRez`) i **koszt zakupu z danego
dnia**. Nie jest już pilne przed sezonem — wchodzi w etapie 1.

### Koszt i zysk

- Koszt zakupu = `tw_Cena.tc_CenaNetto0`, zestaw = suma składników (`services/cennik.js` / `zestawy-model.js`).
  GT trzyma tylko dzisiejszy koszt, więc od startu modułu job zapisuje koszt każdego dnia (jako przedziały
  zmian), a historia sprzed startu liczy się dzisiejszym kosztem z oznaczeniem „koszt dzisiejszy”.
- **[decyzja] Zysk = po kosztach kanału**, z tego samego kalkulatora co repricer i Cennik (`config/rynki.js`):
  przychód netto − koszt zakupu − prowizja − nasza wysyłka − pozostałe składniki rynku. „Marża 20%” znaczy na
  ekranach to samo co w strategiach. To szacunek: stawki prowizji i wysyłek są dzisiejsze.
- **Zysk liczony na zamówienie, nie na sztukę.** 79% FS to 1 szt., ale FS z kilkoma sztukami niosą **45% sztuk
  i 29% przychodu** (1310 FS „1 towar × n szt.” + 4887 FS z 2+ towarami). Wysyłka od sztuki zawyżyłaby koszt
  prawie połowy sprzedaży. Na zamówienie: przychód z pozycji towarowych + pozycja TRANSPORT (57 tys. zł netto w
  90 dni), nasza wysyłka raz na paczkę (wg największego towaru, jak w analizie kartonów), prowizja wg reguł
  kanału; potem rozkład zysku na pozycje proporcjonalnie do wartości.
- **Rzeczywiste koszty kanałów istnieją w projekcie Rozliczenia** (`C:\Rozliczenia\data\rozliczenia.db` na SRV,
  SQLite WAL, zasilana nocą 03:00–04:00, kopia o 05:00; odczyt tylko `mode=ro` lokalnie na SRV albo z kopii, nigdy
  przez udział sieciowy). Per zamówienie: **Allegro PL** (`allegro_billing` z API od 01.01.2025, zgodne z panelem
  co do grosza; opłaty jednego zamówienia domykają się przez kilka dni, czasem ~30), **Amazon** (prowizja z
  settlement reportu — **brutto**, 15% × 1,23; I–IX.2026), **Kaufland DE**, **Media Expert**, **PayU**; Empik z
  pliku Mirakla. **Brak per zamówienie:** Allegro CZ/HU/SK, eMAG (tylko zbiorcze faktury), Erli (częściowo),
  Ceneo, a kosztów przewozu per paczka nie zbiera nikt (InPost tylko za 2 miesiące). Wniosek do decyzji (Otwarte
  pkt 7): zysk z kalkulatora jako podstawa, „zysk rzeczywisty” z `rozliczenia.db` tam, gdzie jest, z widocznym
  źródłem i opóźnieniem.
- Waluty: `dok_WartBrutto`/`ob_WartNetto` są w PLN; wartość w walucie = PLN / `dok_WalutaKurs` (HUF × 100) albo
  `ob_CenaWaluta` pozycji. Kurs NBP z dnia przed wystawieniem; KFS kursem faktury pierwotnej.
- Kanały z regułami w kalkulatorze: Allegro, Amazon DE/FR/IT/ES/NL, eMAG RO/HU/BG, Kaufland DE, Empik. Bez reguł
  (Amazon PL, Erli, InPost, Sklep, „personal”, „tergpl”) → marża handlowa (przychód − koszt zakupu) z dopiskiem
  „bez kosztów kanału”. Allegro CZ/SK/HU: czy reguły Allegro PL pasują — **do sprawdzenia**.

### Zestawy

**[decyzja] Oba widoki:**
- **„Jak sprzedano”** — zestaw (`tw_Rodzaj=8`) to osobny towar ze sprzedażą i zyskiem (koszt = suma
  składników). Pod ekrany, repricer i strategie, które wiszą na `tw_Id` zestawu.
- **„Zużycie składników”** — sztuki składników przez `tw_Komplet` (`kpl_Liczba`). Pod zakupy i dni zapasu
  składnika: zapas = stan / (sprzedaż własna + zużycie w zestawach). Tylko sztuki, bez przychodu.

## Magazyn danych — `db/sprzedaz.db`

**Szybkość [wymóg usera]: żaden ekran nie pyta GT.** Wszystko czyta z osobnej bazy SQLite z gotowymi sumami.
Cel: każdy ekran poniżej pół sekundy, także na telefonie. Osobny plik, a nie `wms.db`, bo to dane pochodne (da
się je odbudować z GT poza zdjęciami rezerwacji i kosztu), większe i z innym rytmem zapisu.

Tabele (szkic):

| Tabela | Wiersz | Uwagi |
|---|---|---|
| `pozycje` | pozycja zamówienia: ZK, FS, PA, KFS | `tw_id`, rodzaj, szt, netto PLN, cena w walucie, waluta, `data_zam`, `data_fs`, kanał + `kanal_regula`, rynek (kraj), status zamówione/zafakturowane, koszt/szt, zysk (szacunek, po rozkładzie z zamówienia) |
| `zuzycie_skladnikow` | dzień × składnik × kanał | sztuki składników z zestawów |
| `sumy_dzien` | data (zam/fs) × dzień × kanał × grupa GT | szt, przychód, zysk, zamówień, zwroty — pod podsumowania i trendy |
| `sumy_dzien_towar` | data (zam/fs) × dzień × towar × kanał | pod swipe, karty towarów i trendy towarów |
| `stany` | towar × magazyn × przedział dni | odtworzone wstecz + nocne zdjęcia; zapis tylko zmian (przedziały), nie dzień × towar |
| `rezerwacje`, `koszty` | towar × przedział dni | tylko z nocnych zdjęć, od startu modułu |
| `towary` | kopia kartoteki | symbol, nazwa, grupa, rodzaj, pierwsze przyjęcie; klucz `tw_Id` (symbol to etykieta — zasada „Tożsamość towaru” w CLAUDE.md) |
| `alerty` | alert (etap 2) | typ, priorytet, towar, kanał, liczby, przeczytany per użytkownik |

Joby (w WMS-Node, interwały przez `interwalMsZMinut`):
- **Wczytanie historii** — jednorazowy skrypt `scripts/` (od 2023), z dry-runem i raportem reguł kanału.
- **Nocny** (np. 02:00): FS/KFS/PA z ostatnich 14 dni na nowo (korekty, późne FS), zdjęcie stanów, rezerwacji i
  kosztu, przeliczenie sum, flag i (w etapie 2) alertów.
- **Bieżący co 10–15 min**: ZK z dziś i wczoraj + nowe FS. Ekran podpisuje się „stan na HH:MM”.

GT niedostępne → ekrany działają na ostatnich danych z podpisem, kiedy były wczytane (bez 503 — to odczyt
historii, a nie decyzja o stanach). Kopia zapasowa: `sprzedaz.db` dołączyć do backupu B2, bo zdjęć rezerwacji
i kosztu nie da się odtworzyć.

## Etap 1 — dzień, porównania, telefon  [decyzja: najpierw]

### Podsumowanie dnia (desktop i telefon)

- Przychód netto, zysk, marża, sztuki, zamówienia; **vs ten sam dzień tygodnia rok temu (−364 dni)
  [decyzja]**, data kalendarzowa w podpisie.
- Wiersz na kanał: szt · przychód · zysk · marża · % r/r. Allegro rozwijane na konta i kraje. „Sklep” (PA) to
  osobny wiersz. Zwroty (KFS) w osobnej kolumnie.
- Zakresy: dzień (← →), 7 dni, miesiąc do dziś, rok do dziś — każdy vs ten sam zakres przesunięty o 364 dni.
- Przełącznik „wg zamówienia / wg faktury”.

### Swipe produktów (telefon)

Karta na towar sprzedany w wybranym dniu (lub zakresie), domyślnie od największego zysku (przełącznik: sztuki,
przychód):
- zdjęcie (miniatura z istniejącego `GET /api/produkty/:tw_Id/zdjecie`, tap = duże), SKU, nazwa, grupa;
- per kanał: sztuki, marża %, zysk zł; suma;
- **[decyzja] stan i dni zapasu**: K4+K4G, Razem, dni zapasu przy obecnym tempie, flaga „kończy się”;
- **[decyzja] stan w repricerze**: per kanał automat tak/nie, Buy Box tak/nie, strategia (z `pricing.db`).

### Dostęp

- **[decyzja] Telefon przez Tailscale** (ta sama sieć co Mac i SRV, konto kaziueee@). Nic nie wystawiamy do
  internetu.
- **[decyzja] Admin + biuro**, wymuszone w backendzie (`auth.wymagajRoli('admin', 'biuro')`, także na odczyt),
  tak jak Cennik, Sprzedaż i Ceny.
- Telefon dostaje osobną, lekką stronę (PWA, „dodaj do ekranu głównego”) z tym samym logowaniem co WMS, a nie
  pełną aplikację desktopu.

### Zadanie sprzedażowe

`routes/sprzedaz.js` przechodzi na `sprzedaz.db` zamiast liczyć FS na żywo. Definicja bez zmian (FS z K4, data
faktury), więc liczby się nie zmieniają, tylko ekran przestaje czekać na GT.

## Etap 2 — trendy i centrum alertów

### Trendy

- Listy „trendujące” i „tracące popularność”, 30 dni: sztuki i sprzedaż netto z % zmiany, przełącznik % / #
  (jak base analytics).
- **[decyzja] Przełącznik porównania**: domyślnie vs poprzednie 30 dni, jednym kliknięciem vs te same 30 dni rok
  temu. Ten sam przełącznik dla towarów, grup GT i kanałów. Przy zabawkach październik do września zawsze
  „rośnie”, dlatego rok temu jest pod ręką.
- Minimalna baza (np. ≥5 szt. w bieżącym oknie), żeby 1 → 33 szt. nie stało na górze jako +3200%.
- Trend grup GT i kanałów: wykres tygodniowy z linią rok temu.

### Centrum alertów

**[decyzja] Desktop i telefon**: licznik nieprzeczytanych, filtry priorytet / typ, „oznacz jako przeczytane”
(per użytkownik), „zobacz więcej” = karta towaru. Push na telefon — później (wymaga HTTPS, np. Tailscale Serve).

**[decyzja] Rodzaje w pierwszej wersji:**
- **Sprzedaż towaru ↑↓** — spadek / wzrost: 7 dni vs poprzednie 7 dni, od minimalnej bazy (np. ≥5 szt.,
  zmiana ≥50%). Przewaga nad base analytics, które pisze tylko „sprawdź, czy oferta jest aktywna”: **alert podaje
  przyczynę**, bo znamy stan i repricer — „stan K4 = 0 od 15.10, 40 szt. leży na MAG”, „utracony Buy Box na
  Amazon DE 17.10”, „automat podniósł cenę o 12%”, „oferta wyłączona”.
- **Stan** — brak na stanie przy sprzedaży (stan K4+K4G = 0 i sprzedaż w 30 dni, z podpowiedzią „jest na
  MAG/LS”), kończy się (<30 dni zapasu), nadmiar, zalega, nowość bez sprzedaży. Zbiorczo („Masz 43 produkty…”)
  z listą do rozwinięcia.
- **Sprzedaż ze stratą** — zamówienie z zyskiem po kosztach kanału < 0 (zły koszt w kartotece, ręczna cena,
  za niska podłoga).

Odłożone: „kanał milczy” (kanał bez zamówień od X godzin, choć zwykle o tej porze są).

Alerty liczy job nocny (i bieżący dla dzisiejszych zamówień), jeden aktywny alert na (typ, towar). Reguły to
czyste funkcje z testami, bez SQLite i GT.

## Flagi towaru  [decyzja: progi usera]

| Flaga | Definicja | Ile dziś |
|---|---|---|
| **Nowość** | pierwsze przyjęcie (PZ/PW) < 30 dni temu | 93 towary (84 ze stanem) |
| **Zalega** | stan K4+K4G > 0, zero FS w 180 dni, nie nowość | 625 towarów, 16 642 szt. (390 z nich bez FS także przez rok) |
| **Nadmiar** | zapas > 730 dni **przy szybszym z temp** (30 dni / rok) | 1055 towarów, 362 524 szt. = **79% sztuk na K4+K4G** (460 077) — policzone przy tempie z roku, po zmianie mniej |
| **Kończy się** | zapas < 30 dni (zawsze, jest na karcie) | 223 towary |

Zmiana definicji nadmiaru z makiety 2026-10-20: przy samym tempie z roku HWHJBD90 (69 szt. w 30 dni, zapas 262
dni) wypadał jako nadmiar, bo rok temu sprzedawał się słabo. Szybko rotujący towar to nie nadmiar.

Nadmiar jest zdominowany drobnicą w ogromnych ilościach (strzałki, akcesoria). Sortować po wartości zapasu,
nie po liczbie sztuk. Dla porównania base analytics: „1439 produktów bez sprzedaży od ponad 60 dni”.

## Etap 3 — tiery i repricer  [decyzja: na razie zostawiamy]

**Tier: odłożony. Repricer: na razie nic z modułu nie bierze.** Dane do decyzji, gdy wrócimy (rok, FS z K4,
zysk handlowy jako przybliżenie zysku po kosztach kanału):
- 4790 towarów ze sprzedażą, 19,1 mln zł netto, zysk handlowy 10,3 mln zł. 175 towarów = 50% zysku,
  699 = 80%, 1707 = 95%.
- Regularność (tygodnie ze sprzedażą z 52): 1 → 1031 towarów, 2 → 466, 3–4 → 561, 5–8 → 726, 9–13 → 588,
  14–26 → 820, 27–39 → 370, 40–52 → 200.
- ABC 80/15/5 × regularność:

  | | regularne (26+) | sporadyczne (8–25) | rzadkie (<8) |
  |---|---|---|---|
  | A | 419 = 57% zysku | 246 = 21% | 34 = 2% |
  | B | 194 | 664 | 150 |
  | C | 28 | 603 | 2452 |

- **Sezon:** 704 towary robią ≥50% rocznego obrotu w XI–XII (408 ≥70%, 173 ≥90%), a **307 z 699 towarów A to
  towary sezonowe** — tier z samych 90 dni zepchnąłby je w październiku do C.
- Zapas K4+K4G przy tempie rocznym: ≤30 dni → 222, 31–90 → 153, 91–180 → 171, 181–365 → 337, 366–730 → 315,
  >730 → 1055 towarów.
- Propozycja z rozmowy (niezatwierdzona): tier z 365 dni + strzałka trendu 90 dni vs rok temu; repricer dostaje
  tylko propozycje strategii do zatwierdzenia przez człowieka.

## Pułapki

- **FS tylko w dni robocze** — wg faktury weekend = 0, to nie awaria.
- **Kanał przed 26.08 z kraju płatnika** — hipoteza do sprawdzenia przed wczytaniem historii.
- **Koszt historyczny** = dzisiejszy, do startu nocnych zdjęć kosztu. Zysk po kosztach kanału liczony dzisiejszymi
  stawkami.
- **Daty GT są lokalne** (`datetime` bez strefy). Dzień zapisujemy jako napis `YYYY-MM-DD` wprost z GT
  (`CONVERT(char(10), …, 23)`), bez przeliczeń stref — każde przeliczenie przesuwa sprzedaż z okolic północy na
  sąsiedni dzień (zob. „Czas” w CLAUDE.md: tam baza WMS jest w UTC, tu dane GT są lokalne).
- **Tożsamość:** klucz `tw_Id`, symbol i nazwa z kopii kartoteki odświeżanej nocą.
- **Zestaw:** stan kompletu w GT obejmuje PW/RW kompletacji — odtworzenie stanów liczy `tw_Rodzaj` 8 tak jak 1.
- **Ujemny odtworzony stan** (22 pary na K4) — obcinany do 0 i logowany, nie przerywa wczytania.
- **KFS nie ma pól własnych** — kanał i klucz bierzemy z faktury pierwotnej (`KFS.dok_DoDokId` → FS). Częsty wzorzec
  częściowego zwrotu: FS + pełna KFS + nowa FS na resztę (wg projektu Rozliczenia) — liczba „zwrotów” w sztukach
  zawyża wtedy prawdziwe zwroty.
- **Zysk rok temu** liczony dzisiejszym kosztem i dzisiejszymi stawkami: makieta pokazała 7 dni −4% przychodu, ale
  −19% zysku (marża 29,7% wobec 35,3%) — część różnicy to metoda, nie rynek. Ekran mówi to wprost do czasu, aż
  zbierze się historia kosztów.

## Otwarte

1. Tier i to, co z niego weźmie repricer (etap 3) — dane wyżej.
2. Sprawdzenie reguły kraju przed 26.08 (`Internet` = Allegro już potwierdzone).
3. Koszty kanału dla Allegro CZ/SK/HU.
4. Historia kosztu przed startem zdjęć: dzisiejszy koszt (domyślnie) czy ostatnia cena z PZ przed sprzedażą.
5. Push na telefon i alert „kanał milczy”.
6. Konsumenci później: pulpit repricera (`sprzedazWgZrodla`), strategia „za rynkiem” (`sprzedazTowarowZCena`),
   zakupy / domawianie.
7. **Zysk rzeczywisty z `rozliczenia.db`** (Allegro PL, Amazon, Kaufland, Media Expert, PayU) obok szacunku z
   kalkulatora — czy i od kiedy. WMS-Node stoi na tym samym SRV, więc odczyt `mode=ro` jest lokalny.

## Makieta (2026-10-20)

`~/Documents/makieta-analizy-sprzedazy.html` — etap 1 na prawdziwych danych (zamówienia pon. 19.10.2026 vs pon.
20.10.2025, tylko odczyt OKITRADE + `pricing.db` z SRV): desktop „Sprzedaż → Dzień” (kafle, kanały z
rozwijaniem, produkty dnia) i telefon (podsumowanie, swipe 361 kart: zdjęcie, per kanał szt / marża / zysk, stan
i zapas, repricer). Liczby: dzień wg zamówienia 41 101 zł / zysk 13 142 zł / marża 32,0%; wg faktury 88 235 zł
(−12% r/r); 7 dni 255 tys. zł (−4%). Uproszczenia makiety: zysk od sztuki (nie na zamówienie), „rok” bez zysku,
zdjęcia tylko 40 kart.
