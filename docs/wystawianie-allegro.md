# Wystawianie ofert Allegro z WMS: badanie i plan (2026-11-17)

Krok 4 procesu: towar jest już w Subiekcie (oznaczony „Sklep internetowy”), w sklepie poszukiwaczefrajdy.pl i w BaseLinkerze / Sellasist. Teraz trzeba go wystawić na Allegro. Wszystkie pomiary niżej zrobiłem **tylko odczytem** na SRV (skrypty `C:\Users\Adm\al-sonda*.js`). Nie powstała żadna oferta ani szkic.

## 1. Co już mamy

**Uprawnienia są.** Tokeny obu kont w `pricing.db` (`allegro_tokeny`, aplikacja „WMS Price”) mają dziś zakres:
`sale:offers:read/write`, `sale:settings:read/write`, `profile:read`, `billing:read`, `orders:read`, `payments:read`, `shipments:read`, `campaigns`, `ads`.
`sale:offers:write` wystarcza do `POST /sale/product-offers`. **Nie trzeba ponownie autoryzować kont ani zmieniać aplikacji.**

**Odczyty działają:** `GET /sale/products?phrase=<EAN>&mode=GTIN&language=pl-PL`, `GET /sale/products/{id}`, cenniki dostaw, warunki zwrotów i reklamacji, producenci GPSR, osoby odpowiedzialne, `POST /pricing/offer-fee-preview` (prowizja przed wystawieniem). `GET /offers/listing` (ceny konkurencji) nadal daje 403. Ceny rywali bierzemy z Niezbędnika jak w repricerze.

## 2. Jak dziś wyglądają nasze oferty (wzór dla nowych)

Sprawdzone na najnowszych ofertach (ekajtek z 16–17.11, NaTropie z 26.10–9.11) i 25 ofertach Hasbro. Wszystkie mają ten sam kształt:

| Pole | ekajtek | NaTropie |
|---|---|---|
| `productSet[0].product.id` | produkt z katalogu Allegro (UUID), `quantity 1` | jw. |
| `external.id` | **SKU = symbol GT** | jw. |
| `name` | własny tytuł WIELKIMI LITERAMI z kodem modelu (`PLAYMOBIL … 71270`) | jw. |
| `description` | własny: zdjęcie + `<h1>` + akapity | jw. |
| `parameters` | tylko `Stan=Nowy` | jw. |
| `delivery.shippingRates` | „DHL Inpost Poczta” (2835 z 2965), „Kurier i Packeta” (127) | „DHL Inpost Poczta” (1875), „Kurier i Packeta” (88) |
| `delivery.handlingTime` | `PT0S` | jw. |
| zwroty / reklamacje / gwarancja | „Warunki zwrotów” / „Warunki reklamacji PoszukiwaczeFrajdy” / „Gwarancja na okres 24 miesięcy” | „Warunki zwrotów” / „Reklamacje” / „Gwarancja” |
| `payments.invoice` | `VAT`, `taxSettings` 23% PL | jw. |
| `responsibleProducer` | id z listy konta (99 wpisów, np. Playmobil, Hasbro) | osobna lista (90) |
| `safetyInformation` | `TEXT`, zwykle „Nie nadaje się dla dzieci w wieku poniżej 36 miesięcy.” (22/25 Hasbro), czasem dłuższa lista GPSR | jw. |
| rynki dodatkowe | business-pl, cz, sk, hu, business-cz: `APPROVED`, ceny przeliczone przez Allegro | jw. |
| `stock.available` | **ograniczone do 50** (1355 ofert = 50, 729 1–9, 879 10–49, 1 > 50) | jw. (956 = 50) |

Identyfikatory (cenniki, warunki, producenci) są **inne na każdym koncie**, więc trzymamy je w konfiguracji per konto, nie w kodzie.

## 3. Kto pilnuje stanu (pytanie 2)

Oferty Allegro **nie idą przez Sellasist, tylko przez BaseLinker** (wiadomo z pamięci repricera; SubLinker BL ↔ GT). Stan na Allegro to stan GT ucięty do 50. Wygląda to na ustawienie synchronizacji BaseLinkera („maksymalna ilość”), bo 729 ofert ma realne 1–9 szt., czyli stan jest synchronizowany. **WMS nie ma tokenu API BaseLinkera**, więc nie sprawdzi powiązania sam.

Wniosek: ofertę założoną przez WMS trzeba **powiązać w BaseLinkerze z produktem magazynu**. Dopiero wtedy BL aktualizuje jej stan. BL ma import ofert spoza systemu i automatyczne powiązania (po SKU / EAN). Nasza oferta niesie `external.id` = SKU, jak wszystkie obecne, więc powiązanie po SKU powinno zadziałać. To **trzeba potwierdzić na ofercie testowej** w panelu BL. Tak samo jak przy eMAG / Kauflandzie w Sellasist: WMS zakłada ofertę, człowiek podpina ją raz, a ekran ma w historii odhaczenie „podpięte”. Dla Allegro odhaczenie znaczy „podpięte w BaseLinkerze”.

Do czasu powiązania WMS powinien wystawiać **ilość = min(stan dostępny, 50)**, czyli tyle, ile postawiłby BL.

## 4. Pokrycie katalogu (pytanie 3)

Pomiar 17.11 na OKITRADE, konto ekajtek:

- towary rodzaj 1 z EAN-em i stanem dostępnym ≥ 4 (próg z ekranu „Do wystawienia”): **4 324**;
- bez oferty na ekajtek: **2 397** (z tego `tw_SklepInternet = 1`: **401**); bez oferty na obu kontach: **2 391**;
- próbka 80 z tych 2 397 (co n-ty po `tw_Id`): **67 (84%) ma produkt Allegro z dokładnie naszym EAN-em**, wszystkie w statusie `LISTED` (Allegro: najszybsza publikacja). 3 dały inny produkt, 10 nic.
- Spośród 19 towarów sklepowych w próbce 16 ma produkt. **Tylko 1 z 67 miał już ofertę** w jakimkolwiek statusie (HASF0231-F1913 na NaTropie). Reszta nie ma oferty nawet zakończonej, więc to nie jest „wznów starą”.

Szacunek: **~2 000 towarów** da się dopiąć do istniejącej karty Allegro (~340 sklepowych). Przykłady z próbki: MGA566977 LOL Remix Hair Flip (**360 szt.**, nie ma go na Allegro), NIC83264 TMNT Raphael (82), HASE5556-E5579 Captain America (41), ZUR6701 Metal Machines (40).

Wąskie gardło jest to samo co na innych rynkach: **waga i wymiary w GT**. Z 16 sklepowych trafień komplet ma 8.

Zastrzeżenie: 85 ofert ekajtek i 241 NaTropie ma SKU niedopasowane do GT. Część „braków” może więc być wystawiona pod innym SKU. Allegro i tak sprawdza duplikat (ten sam produkt, to samo konto) przy walidacji asynchronicznej.

## 5. Ceny i marża

Kalkulator Allegro już istnieje (rynek „Allegro”, prowizja per oferta, Ads 1,32% ekajtek, dopłata Smart). `pricing/pas.js` liczy pas dla kolumny `ALLEGRO_EKAJTEK` także dla towaru bez oferty, np.:

| SKU | koszt | min | max | prowizja (podgląd) | nasze inne ceny |
|---|---|---|---|---|---|
| HASE5556-E5579 | 14,76 | 32,99 | 49,48 | 14,16% | Empik 39,99 |
| MGA566977 | 16,05 | 35,99 | 53,98 | 11,09% | Amazon PL 59,99, Empik 55,99 |
| NIC83264 | 13,04 | 29,99 | 44,98 | 14,17% | Amazon PL 54,99, Empik 43,99 |
| ZUR6701 | 21,32 | 49,99 | 74,98 | 14,16% | Empik 42,99 |

Prowizję liczy `offer-fee-preview` z kategorią produktu przed wystawieniem, a nie stała stawka. Cenę rynku daje Niezbędnik (1 sprawdzenie na EAN z pakietu 5000).

## 6. Proponowany plan wdrożenia

Wpasowane w istniejący ekran Ceny → „Do wystawienia” (`pricing/katalogi*.js`, `pricing/wystawianie*.js`, `routes/ceny-wystawianie.js`):

1. **Katalog**: rynek `allegro:EKAJTEK` (i ewentualnie `allegro:NATROPIE`) w `RYNKI_KATALOGU`. Skan po EAN-ie: `GET /sale/products?mode=GTIN`, bierzemy produkt, którego parametr „EAN (GTIN)” zawiera nasz EAN (nie pierwszy wynik). Zapis do `katalog`: `produkt_id` (UUID), `nazwa`, `kategoria_id`, status produktu; `mamy` = jest oferta SKU w dowolnym statusie (`GET /sale/offers?external.id=`). Limit Allegro ~9000 zapytań/min na konto, więc 12 tys. EAN to kilka minut w nocnym oknie.
2. **Cena startowa** = max(min pasa, cena rynku z Niezbędnika), jak `cenaStartowa`; bez danych rynku = min pasa. Niezbędnik tylko dla pozycji zaznaczonych na ekranie, nie dla całego katalogu (pakiet).
3. **Treść oferty** (`ofertaAllegro` w `wystawianie-model.js`, czysta funkcja z testami):
   - `productSet: [{ product: { id }, quantity: { value: 1 }, responsibleProducer: { id }, safetyInformation: { type: 'TEXT', description } }]`;
   - **sygnatura (`external.id`) = nasze SKU, czyli symbol GT, ZAWSZE** (wymóg usera 17.11). Bez niej repricer nie dopasuje oferty do towaru (`oferty.tw_id` po SKU), a BaseLinker nie powiąże jej ze stanem. Pusta albo inna sygnatura = blokada wysyłki. Po wystawieniu sprawdzamy, że Allegro ją zapisało;
   - `sellingMode` BUY_NOW, cena PLN; `stock.available` = min(dostępne, 50);
   - `delivery` = „DHL Inpost Poczta”; „Kurier i Packeta”, gdy nie mieści się w paczkomacie C (64×41×38, ≤ 25 kg, ta sama reguła co klasa Empik; **reguła do potwierdzenia przez usera**); `handlingTime PT0S`;
   - zwroty / reklamacje / gwarancja, faktura VAT, rynki dodatkowe: jak na obecnych ofertach konta (id z konfiguracji);
   - `parameters` Stan=Nowy; `publication.status` ACTIVE.
   - **Producent GPSR**: id producenta z listy NASZEGO konta, wybrany jak w naszych ofertach tej marki (najczęstszy `responsibleProducer` wśród ofert z tym samym prefiksem SKU / marką katalogu). Brak dopasowania = blokada „dodaj producenta w Allegro”. Nie zakładamy producentów automatem, bo lista konta ma ręczne duplikaty (Hasbro ×4).
   - **Tytuł i opis**: patrz decyzje niżej.
4. **Wysyłka**: `POST /sale/product-offers` → 201 albo 202 + `/operations/{id}` (303 → id oferty). Odmowa walidacji to wynik zapisany w `wystawienia.opis`. Przed zapisem robimy `offer-fee-preview`.
5. **Po wystawieniu**: sync listy Allegro w workerze (`dopnijWystawione`) widzi ofertę i włącza automat wg reguł `POST /automat` (wysyłka cen Allegro działa od 19.10). Historia ma odhaczenie „podpięte w BaseLinkerze”.
6. **Kolejność**: jedna oferta testowa ręcznym skryptem → powiązanie w BL i sprawdzenie, czy stan się synchronizuje → kod + `allegro:EKAJTEK gotowe:true` → paczka.

## 7. Decyzje usera (2026-11-17)

1. **Konto:** test na **ekajtek**.
2. **Tytuł:** WIELKIMI LITERAMI i **sprzedażowy**, z wykorzystaniem limitu 75 znaków. Sklep dostaje nazwę techniczną, zgodną z katalogiem; Allegro dostaje tytuł pod wyszukiwanie: postać po polsku i po angielsku, wysokość, wyróżnik (tarcza), marka, kod modelu.
3. **Opis:** **własny, w sekcjach, każda sekcja ze zdjęciem.** Wzór obecnych ofert: sekcja 1 = zdjęcie + `<h1>` + wstęp, sekcja 2 = zdjęcie + „Najważniejsze cechy” (lista), sekcja 3 = zdjęcie + „Zawartość zestawu” + wymiary / wiek / kod. Treść: karta sklepu, katalog Allegro i karty z innych rynków. Piszemy tylko to, co tam stoi, bez dopisywania cech.
4. **Cennik dostaw:** reguła potwierdzona: nie mieści się w paczkomacie C → „Kurier i Packeta”, inaczej „DHL Inpost Poczta”.
5. **Rynki CZ/SK/HU:** tak, **od razu z regułą „Przelicznik cen”** (EXCHANGE_RATE, `644bd75d07bd9c00ddaf5786`, domyślna na koncie). Nasze obecne oferty mają ceny CZ/SK/HU, ale `GET /sale/price-automation/offers/{id}/rules` = 404 „brak reguł”, więc ceny ustawiono raz, bez reguły. Nowa oferta: rynki dodatkowe w `publication.marketplaces.additional` bez cen. Potem sprawdzamy reguły oferty, a gdy ich nie ma, przypisujemy przelicznik przez `POST /sale/offer-price-automation-commands` (cz, sk, hu). Do sprawdzenia na teście: czy reguła na rynku zagranicznym nie blokuje repricera (`zmianaCeny` odrzuca oferty z regułą na `sellingMode` bazowym).
6. **Powiązanie w BaseLinkerze:** do sprawdzenia na ofercie testowej.

## 7a. Produktyzacja: wybór produktu katalogu (kluczowe, uwaga usera)

Zła karta = oferta pod cudzym towarem (lekcja z Kauflandu: TEF82380 dostał kartę zestawu garnków pod naszym EAN-em). Reguły, wszystkie muszą przejść, inaczej pozycja jest zablokowana do decyzji człowieka:
- **EAN dokładny:** nasz EAN (po `normalizujEan`, 12↔13 cyfr) jest wśród wartości parametru „EAN (GTIN)” produktu. Nie bierzemy pierwszego wyniku wyszukiwania.
- **Jeden kandydat:** więcej niż jeden produkt z naszym EAN-em = wybór człowieka na ekranie (nazwy, zdjęcia, kategorie obok siebie).
- **Kod modelu:** kod z symbolu GT (`HASE5556-E5579` → `E5579`) występuje w nazwie, „Kodzie producenta” albo opisie produktu. „Kod producenta” w katalogu bywa inny (tu `2577121`), więc sam ten parametr nie wystarczy. Brak kodu wszędzie = ostrzeżenie, nie blokada (nie każdy towar ma kod w symbolu).
- **Sztuki:** „Liczba sztuk” = 1, a w nazwie nie ma „zestaw / komplet / N szt. / pak”, chyba że towar GT też jest zestawem. Multipak pod pojedynczym EAN-em to najczęstsza pułapka.
- **Marka:** parametr „Marka” zgodny z marką towaru (prefiks symbolu / kartoteka). „bez marki” = blokada.
- **Status:** `LISTED` (Allegro: najszybsza publikacja). `PROPOSED` / inne = ostrzeżenie.
- **Wymiary:** parametry produktu (wys./szer./gł.) nie mogą przeczyć wymiarom opakowania w GT o rząd wielkości (cm↔mm).
- Flagi z wyszukiwania zapisujemy do katalogu: `hasProtectedBrand` (marka chroniona: parametry karty edytuje tylko marka; przy Hasbro = true, a nasze oferty Hasbro istnieją, więc to nie blokada), `aiCoCreatedContent` (parametry karty uzupełniało AI, mniej wiarygodne).

Pomiar na teście: EAN 5010993596133 → dokładnie 1 produkt (`6fc1a748…`, Hasbro, 1 szt., LISTED, E5579 w opisie). Wyszukiwanie po frazie znajduje jeszcze 3 karty „Captain America 24 cm” z innymi EAN-ami (dwie „bez marki”). Właśnie dlatego dobieramy wyłącznie po EAN-ie.

## 7b. Miniatura i galeria (uwaga usera: „miniatura też jest ważna”)

Pierwsze zdjęcie oferty Allegro **jest tym samym obrazkiem co pierwsze zdjęcie karty w sklepie**: kompozycja 1:1, produkt duży, pudełko mniejsze. Sprawdzone na HWHHPC07 (identyczny obraz) i Playmobil 71270 (pudełko, jak w sklepie). Reguła:
- **galeria oferty = galeria karty w sklepie, w tej samej kolejności** (miniatura → produkt → lifestyle → pudełko na końcu, zasady sklepu z `docs/wystawianie-sklep.md`). Zdjęcia wgrywamy do Allegro po URL-u (`POST https://upload.allegro.pl/sale/images {url}`), bo opis może pokazywać tylko zdjęcia z galerii oferty;
- zdjęcia karty katalogu Allegro tylko awaryjnie. Ich pierwsze zdjęcie to często samo pudełko albo zdjęcie amatorskie (u E5579 jest zdjęcie figurki w pudełku zrobione telefonem);
- **towar bez karty w sklepie nie idzie na Allegro**: nie ma miniatury w naszym stylu, a krok 2 procesu (sklep) i tak poprzedza krok 4.

## 8. Oferta testowa (do wystawienia po zgodzie usera)

**HASE5556-E5579** „Figurka Hasbro Avengers Captain America 24 cm”, EAN 5010993596133, konto **ekajtek**:
- produkt Allegro `6fc1a748-b786-40b6-8908-7a22278ef17e` (LISTED, kategoria 322030), brak naszej oferty na obu kontach w żadnym statusie;
- stan dostępny 41 szt., waga 0,2 kg, wymiary 25,5×13×5 cm (paczkomat → „DHL Inpost Poczta”);
- producent „Hasbro” `8f14d06c-521d-4203-96bf-3b379418f4da` (19 z 25 naszych ofert Hasbro), bezpieczeństwo „Nie nadaje się dla dzieci w wieku poniżej 36 miesięcy.”;
- koszt 14,76 zł, pas Allegro 32,99–49,48 zł, prowizja 14,16%; propozycja **39,99 zł** (jak nasz Empik), albo cena z Niezbędnika po 1 sprawdzeniu;
- ilość 41;
- tytuł (72 zn.): **MARVEL AVENGERS DUŻA FIGURKA KAPITAN AMERYKA 24 CM Z TARCZĄ HASBRO E5579**;
- galeria ze sklepu: `u4um0ge1.png` (miniatura: pudełko + figurka), `hzyvqzmj.jpg` (figurka), `zxjenrr5.jpg` (pudełko); 3 sekcje opisu, każda ze swoim zdjęciem;
- rynki business-pl, CZ, SK, HU, business-cz z przelicznikiem.

### Wynik testu (2026-11-17 14:34, za „tak” usera)

**Oferta 19130199688** (https://allegro.pl/oferta/19130199688): ACTIVE od razu, sygnatura `HASE5556-E5579` zgodna, 39,99 zł, 41 szt., „DHL Inpost Poczta”, 3 sekcje opisu (zdjęcie + tekst), pierwsze zdjęcie = miniatura ze sklepu.

Lekcje do kodu:
- `publication.marketplaces.base` jest tylko do odczytu: w zapytaniu = 422 `UnknownJSONProperty` „...base” i nic nie powstaje. `publication.marketplaces.additional` przechodzi, ale jest **przestarzałe** (ostrzeżenie `DeprecatedField`): o rynkach zagranicznych decyduje **cennik dostawy**. „DHL Inpost Poczta” obejmuje pl, business-pl, cz, business-cz, sk, hu, więc wystarczy cennik. W kodzie tego pola nie wysyłamy.
- Odpowiedź 202 → `/operations/{id}` 303 po ~5 s, oferta ACTIVE. Ostrzeżenie `SAFETY_INFO_DESCRIPTION_SUGGESTED_DATA_VERIFICATION_NEEDED` to formułka o odpowiedzialności sprzedawcy, nie błąd.
- **Rynki zagraniczne po wystawieniu: PENDING** (business-pl, CZ, SK, HU, business-cz), bez reguł (`/rules` = 404). `POST /sale/offer-price-automation-commands` z „Przelicznikiem cen” na cz/sk/hu → SUCCESS w 0,6 s, reguły widoczne w `/rules`, ceny wyliczone: **222 Kč, 9,08 €, 3 310 Ft**. Na rynku bazowym `priceAutomation` = null, więc repricer (`zmianaCeny`) może zmieniać cenę PLN.
- **Allegro dokleja do galerii zdjęcia karty katalogu**: wysłaliśmy 3 zdjęcia, oferta ma 6. Nasze 3 są pierwsze (miniatura się zgadza), za nimi 3 z katalogu, w tym amatorskie zdjęcie figurki w pudełku. Do decyzji: zostawić czy próbować usuwać (PATCH `images`; nie wiadomo, czy Allegro nie doklei ich znowu).
- Wgranie zdjęcia po URL-u daje adres Allegro po skrócie treści: miniatura sklepu `u4um0ge1.png` dostała ten sam adres co zdjęcie z katalogu, bo to ten sam plik.
- Do zrobienia przez człowieka: **powiązać ofertę w BaseLinkerze** i potwierdzić, że BL zmienia jej stan. Test był skryptem, więc oferty nie ma w tabeli `wystawienia`. Sync repricera dopnie ją do `oferty` przy następnym przebiegu.

Skrypt: `C:\Users\Adm\al-wystaw-test.js` (bez flagi = podgląd treści; `--wyslij` = wgranie zdjęć → `POST /sale/product-offers` → operacja → przelicznik). Po wystawieniu: sprawdzić ofertę na allegro.pl i rynki CZ/SK/HU, powiązać w BaseLinkerze i potwierdzić, że BL zmienia jej stan.
