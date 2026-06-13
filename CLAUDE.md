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
│   └── inwentaryzacja.js
├── services/
│   ├── gt-bridge.js       # HTTP klient do mostu C#
│   ├── gt-fields.js       # kompresja lokalizacji do pól własnych GT
│   └── rozjazdy.js        # job detekcji rozjazdów GT vs WMS
├── public/
│   ├── zebra/
│   │   ├── index.html
│   │   ├── lokalizowanie.html
│   │   ├── mm.html
│   │   └── inwentaryzacja.html
│   └── desktop/
│       └── index.html
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
| ZEW1, ZEW2... | Zewnętrzne | NIE — tylko stan w GT |

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

## Schemat bazy (już w 001_init.sql)

Tabele: `lokalizacje`, `stany_lokalizacji`, `ruchy`, `inwentaryzacje`, `pozycje_inwentaryzacji`, `rozjazdy`

Typy ruchów: `LOK` (lokalizowanie po PZ/FZ, bez dokumentu GT), `MM` (przesunięcie, generuje MM w GT)

## Ekrany Zebry

1. **Lokalizowanie** — lista artykułów gdzie `stan_GT > suma_WMS`. Skan SKU → skan lok → ilość → zapisz
2. **MM** — skan SKU → wybór lok źródłowej → cel + ilość → MM w GT
3. **Inwentaryzacja** — snapshot GT → skan po lokalizacjach → raport różnic → RW/PW w GT

Inwentaryzacja blokuje MM i LOK dla danego magazynu (sprawdź `inwentaryzacje` gdzie `status = 'otwarta'`).

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

## Kolejność budowania

1. `db/001_init.sql` + `db/database.js`
2. `routes/lokalizacje.js` — CRUD
3. `public/zebra/mm.html` — ekran MM (test DataWedge)
4. `bridge/GtBridge/` — endpoint `/api/mm` + `/api/lok`
5. Integracja MM end-to-end
6. `public/zebra/lokalizowanie.html`
7. `services/rozjazdy.js` — job
8. `public/zebra/inwentaryzacja.html`
9. `public/desktop/index.html`
