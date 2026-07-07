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

Lista magazynów: `config/magazyny.js`. **Stan „Razem" = K4+K4G+MAG+LS, bez BRK** — braki to towar niepełnowartościowy i nie mają zawyżać sumy „ile mam". Sterowane flagą `liczDoRazem: false` na BRK → eksport `MAGAZYNY_RAZEM`, czytany w `services/gt-produkty.js` (wyrażenie SQL `SORT_WYRAZENIA.razem` + helper `sumaRazem` dla trybu Node — muszą zostać spójne). BRK ma własną kolumnę i MM w obie strony, wypada tylko z sumy zbiorczej.

## Pola własne GT (kartoteka towaru)

| Pole | Kolumna w bazie GT | Zawartość | Kto pisze |
|---|---|---|---|
| `Miejsce na magazynie` | `tw__Towar.tw_Pole1` | lokalizacja K4, np. `M2-I35-37` | WMS |
| `Lokalizacja Górna` | `tw__Towar.tw_Pole8` | lokalizacje K4gora skompresowane | WMS |
| `Lokalizacja Zapas` | `pwd_Tekst09` (dynamiczne pole własne) | overflow K4gora | WMS |
| `Stan K4`, `Stan K4Góra` | — | kopie stanów dla multistany | NIE dotykamy |
| `Ilość w op. zbiorczym`, `Baterie` | `pwd_Tekst04`, `pwd_Tekst05` | ręcznie | NIE dotykamy |

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
| MM: ilość ≤ stan GT − rezerwacja (rezerwacje blokują MM) | ✅ backend | `/ruchy/mm`, `/przyjecie`, `/mm-zewnetrzny` |

Wszystkie inwarianty są egzekwowane w backendzie. Dodając nową regułę: najpierw `routes/`, front tylko jako UX.

## Schemat bazy (już w 001_init.sql)

Tabele: `lokalizacje`, `stany_lokalizacji`, `ruchy`, `rozjazdy`

`lokalizacje` ma cechy strukturalne (`hala`/`regal`/`alejka`/`strona`/`kolumna`/`typ`) wyliczane z kodu przez `services/lokalizacje-model.js` (`rozbierzKod(kod, magazyn)`) — wypełniane przy imporcie/dodaniu/edycji, do filtrów i raportów. Typ ∈ {paleta, trawers, polka, inny}, reguła `typ = f(magazyn, hala, regał)`: **K4G → zawsze paleta** (lokalizacje paletowe od P2); K4 → C,D,K=trawers (paleta dzielona na pół: podstawa+P1), E–J hala 1=polka (regały półkowe), E–J M2=trawers (M2 bez półek), A,B,L=paleta; RB/BIURO i kody spoza siatki regałów=inny. Typ można nadpisać ręcznie (`PUT /:id {typ}`) — edycja inline w tabeli desktop. Poziom (`-P<n>`) nie jest osobną kolumną — wynika z kodu. Skan/lookup akceptuje też kody bez myślnika (`A8P2` = `A8-P2`) przez `normalizujKodLokalizacji` — obejście dla starych naklejek (endpointy `/skan/:kod`, `/kod/:kod`).

Typy ruchów: `LOK` (lokalizowanie po PZ/FZ, bez dokumentu GT), `MM` (przesunięcie, generuje MM w GT)

> Moduł inwentaryzacji usunięty (2026-06-25) — tabele `inwentaryzacje`/`pozycje_inwentaryzacji`, route `/api/inwentaryzacja`, ekran Zebry i panel desktopu już nie istnieją. Do zrobienia od nowa. Most C# nadal ma endpointy RW/PW (nieużywane).

## Ekrany Zebry

1. **Ruch towaru** (`ruch.html`) — zlany MM + zmiana lokalizacji. Skan SKU/EAN/lokalizacji → wybór → krok „Dokąd i ile?": select **Cel** (Ta sama = LOK w obrębie magazynu / inny magazyn = MM) + ilość + lokalizacja. Operacja LOK/MM wyprowadzana automatycznie. Po zatwierdzeniu ekran sukcesu (dotknięcie zamyka) + sygnał dźwiękowy.
2. **Test wyszukiwania** (`produkty.html`) — podgląd karty produktu z GT.
3. **Ścieżki** (`sciezki.js`, widok w `ruch.html`) — zadania obchodu magazynu (Faza 6). Patrz sekcja „Ścieżki".

Pola skanu mają `inputmode="none"` (skaner DataWedge wstrzykuje dane, klawiatura nie wyskakuje; dotknięcie pola = ręczne wpisanie). DataWedge (działająca konfiguracja): Keystroke output → Basic data formatting → **Send ENTER key** ON (dokłada Enter) + Key event options → **Send Characters as Events** ON + **Send Enter as string** ON. `onScan` w `kreator.js` łapie ten Enter także jako znak CR / `inputType:insertLineBreak`.

## Ścieżki (Faza 6)

Proste zadania „obchodu" magazynu z checklistą, posortowane w kolejności zbierania. Zdarzenia lądują w tabeli `audyt` (bez nowych tabel). Kafelek „Ścieżki" w menu Zebry → `widok-sciezki` (SPA). Backend: `routes/sciezki.js` (`/api/sciezki`, montowany z `auth.wymagajSesjiNaZapisie`). Front: `public/zebra/sciezki.js` (IIFE na globalnych `el`/`pokazWidok`/`onScan`, wzorzec jak `historia.js`).

**Ścieżka 1 — „Ostatnie sztuki":** weryfikacja niskich stanów K4 (1–5 szt.).
- **Źródło stanu: WMS tam gdzie istnieje, inaczej GT.** WMS (`stany_lokalizacji`) zapełnia się z czasem — dla zlokalizowanego towaru trzyma ilość per lokalizacja i jest prawdą; dla reszty fallback na stan GT (`st_Stan` K4). Dziś WMS ma ~kilka wierszy, więc prawie wszystko idzie z GT — reguła jest na przyszłość. Lista = **unia**: (a) wiersze WMS K4 ze stanem 1–5 (`zrodlo:'WMS'`, lokalizacja = kod WMS), (b) `gt-produkty.pobierzK4NiskieStany` = GT `st_Stan` 1–5 z **niepustą `tw_Pole1`** i **`tw_Rodzaj=1`** (tylko towary — wycina zestawy/komplety `rodzaj 8` typu „Nerf + celownik + strzałki" i usługi; filtr po RODZAJU, nie po nazwie — tysiące towarów ma „zestaw" w nazwie) dla SKU, których WMS jeszcze nie zna (`zrodlo:'GT'`). WMS ma pierwszeństwo (SKU w WMS nie dubluje się z GT; gdy WMS>5, SKU wypada mimo niskiego GT). `ORDER BY` kod lokalizacji.
- **Warunek łącznego stanu:** dodatkowo `Razem ≤ 5` (`RAZEM_MAX`), gdzie Razem = K4+K4G+MAG+LS (bez BRK). Odsiewa towary z niskim K4, ale z zapasem na innych magazynach (np. setki na K4G = kandydat do uzupełnienia, nie do liczenia „ostatnich sztuk"). Dla gałęzi GT liczone w SQL (`HAVING`); dla gałęzi WMS: `K4_wms + (K4G+MAG+LS z GT)` (WMS nie zna innych magazynów) — stąd `pobierzStanyGt` dla SKU z WMS. Na starcie ~700 pozycji — backlog drenowany przez 180 dni.
- `GET /ostatnie-sztuki` — jw.; przy niedostępnym GT zwraca **503**. **Nie robi ruchów WMS.**
- Wyklucza parę (artykuł+lokalizacja) sprawdzoną w ciągu **180 dni** (`DNI_POMIN_SPRAWDZONE`) oraz SKU z przyjęciem z magazynu zewnętrznego (`ruchy.mag_zrodlo_zewnetrzny` NOT NULL) w ciągu **30 dni** (`DNI_POMIN_PRZYJECIE`) — świeżo dołożony stan jest znany. Oba filtry z SQLite, w Node.
- `POST /ostatnie-sztuki/sprawdzenie` `{artykul_gt_id, artykul_symbol, lokalizacja_kod, ilosc_policzona}` — porównuje policzone ze stanem wg tej samej reguły (WMS jeśli jest, inaczej `dostepneWGt` GT); zgodne → audyt `akcja='sprawdzenie_stanu'`, niezgodne → `akcja='sprawdzenie_niezgodne'` (do raportu, `przed={stan, zrodlo}`). Bez ruchu WMS. GT niedostępny (i brak WMS) → 503. Raport czyta `przed.stan`/`zrodlo`, ze wsteczną zgodnością ze starym `{stan_gt}`.
- `GET /ostatnie-sztuki/raport` — otwarte niezgodności: pary, dla których NAJNOWSZE sprawdzenie to `sprawdzenie_niezgodne` (późniejsze zgodne = domknięcie). Tap w raporcie → `window.ruchOtworzArtykul(symbol)` otwiera normalny ekran Ruch.

UX obchodu: skan SKU/EAN potwierdza właściwą pozycję → pole ilości → zgodne = krótki beep + auto-przejście; niezgodne = beep błędu + nakładka `ostrzezenie` (dotknięcie = dalej). „Brak cichych porażek" — dźwięki zgodne/niezgodne różne.

## Most C# — endpointy (localhost:5000)

```
POST /api/mm
POST /api/lok
GET  /api/stan/:magId
GET  /api/artykul/:id
POST /api/inwentaryzacja/rw
POST /api/inwentaryzacja/pw
```

## Obsługa rozjazdów

- GT > WMS → ekran "do zlokalizowania"
- GT < WMS w K4 → auto korekta (1 lokalizacja)
- GT < WMS w K4gora → ekran "rozjazdy", magazynier decyduje
- Job detekcji co godzinę w `services/rozjazdy.js`

## Stan obecny

Zbudowane i działające: baza + `routes/` (lokalizacje, ruchy, magazyny, produkty, rozjazdy, sciezki), most C# (`/api/mm`, `/api/lok`), ekran Zebry „Ruch towaru", moduł Ścieżki (Faza 6: ścieżka „Ostatnie sztuki" + raport), panel desktopu (produkty, rozjazdy, ruchy, lokalizacje, MM), job rozjazdów.

Do zrobienia od nowa: moduł inwentaryzacji (usunięty 2026-06-25).

Uruchomienie: `node app.js` (albo `start-wms.command` / `stop-wms.command` na macOS). Serwer na `:3000`, `/` → menu Zebry.
