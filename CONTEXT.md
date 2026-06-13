# WMS — kontekst projektu

## Cel
Lekki system WMS jako uzupełnienie Subiekt GT. Sellasist obsługuje zbiór i wysyłkę — WMS obsługuje tylko lokalizacje magazynowe, przesunięcia MM i inwentaryzację.

---

## Struktura magazynów

| Magazyn GT | Typ | Lokalizacje w WMS |
|---|---|---|
| K4 | Pick floor | TAK — 1 SKU = 1 lokalizacja |
| K4gora | Bulk storage | TAK — 1 SKU = N lokalizacji |
| Magazyny zewnętrzne (ZEW1, ZEW2...) | Zewnętrzne | NIE — tylko stan w GT |

---

## Pola własne w GT (kartoteka towaru)

| Pole | Zawartość | Limit | Kto pisze |
|---|---|---|---|
| `Miejsce na magazynie` | lokalizacja K4, np. `M2-I35-37` | ~50 znaków | WMS |
| `Lokalizacja Górna` | lokalizacje K4gora (skompresowane), np. `M2-J14-P2; M2-J14-P3` | ~50 znaków | WMS |
| `Lokalizacja Zapas` | overflow K4gora gdy za dużo lokalizacji | ~50 znaków | WMS |
| `Stan K4` | kopia stanu — czyta dodatek multistany | ~50 znaków | NIE dotykamy |
| `Stan K4Góra` | kopia stanu — czyta dodatek multistany | ~50 znaków | NIE dotykamy |
| `Ilość w op. zbiorczym` | mnożnik — ręcznie | ~50 znaków | NIE dotykamy |
| `Baterie` | flaga — ręcznie | ~50 znaków | NIE dotykamy |

### Format lokalizacji
- Zapis atomowy w WMS: `M2-J14-P2` (magazyn-regał-półka)
- Zapis skrócony do GT: `M2-J14-J16-P2/3/4` (zakres gdy wiele lokalizacji)
- Algorytm kompresji: grupuj po magazynie i regale, połącz zakresy przez `/`
- Podział na dwa pola gdy nie mieści się w 50 znakach

---

## Zasady nadrzędne

1. **GT = master stanów ilościowych** — ile sztuk w którym magazynie
2. **WMS = master lokalizacji** — gdzie konkretnie towar leży
3. **Pola własne GT = widok do wyświetlenia** — kopia dla handlowca, nie źródło prawdy
4. **Inwariant:** `suma sztuk na lokalizacjach WMS = stan GT` dla każdej pary (artykuł, magazyn)

---

## Obsługa rozjazdów (GT ≠ WMS)

| Sytuacja | Wykrycie | Naprawa |
|---|---|---|
| GT > WMS | Ekran "do zlokalizowania" | Magazynier skanuje i przypisuje lokalizację |
| GT < WMS w K4 | Job co godzinę + przy operacji na SKU | Auto — odejmij z jedynej lokalizacji K4 |
| GT < WMS w K4gora | Job co godzinę | Ekran "rozjazdy" — magazynier decyduje z której lokalizacji |
| Sfera padła | Błąd HTTP przy zapisie | Komunikat na Zebrze, ruch zostaje `pending`, ponów ręcznie |
| Fizyczne przeniesienie bez skanu | Niewykrywalne | Korekta przy inwentaryzacji |

---

## Moduły aplikacji (3 ekrany Zebra + desktop)

### Ekran 1 — Lokalizowanie towaru
Uruchamiany po PZ/FZ w GT. Pokazuje listę artykułów gdzie `stan_GT > suma_lokalizacji_WMS`.
- Skan SKU → skan etykiety lokalizacji → wpisz ilość → zapisz
- Typ ruchu: `LOK`
- Nie generuje dokumentu w GT — tylko aktualizuje pole własne

### Ekran 2 — Przesunięcie MM
- Skan SKU → system pokazuje dostępne lokalizacje z ilościami → wybór lokalizacji źródłowej → cel (magazyn + lokalizacja) → ilość → zatwierdź
- Typ ruchu: `MM`
- Generuje dokument MM w GT przez Sferę
- Przy celu = magazyn zewnętrzny: brak lokalizacji celu, tylko magazyn

### Ekran 3 — Inwentaryzacja
- Wybierz magazyn (K4 lub K4gora)
- System pobiera snapshot stanów z GT
- Skanuj lokalizacja po lokalizacji: skan etykiety lok → skan SKU → ilość
- Po zakończeniu: raport różnic (ilosc_gt vs ilosc_liczona)
- Zatwierdzenie generuje RW (nadmiar) lub PW (niedobór) w GT przez Sferę
- Podczas inwentaryzacji: blokada MM i LOK dla danego magazynu

### Desktop (przeglądarka)
Te same dane, dodatkowe widoki:
- Edytor lokalizacji (ręczna zmiana bez Zebry)
- Raport rozjazdów GT vs WMS
- Historia ruchów
- Podgląd mapy magazynu (co gdzie leży)

---

## Schemat bazy SQLite

```sql
-- Tabela 1: lokalizacje
CREATE TABLE lokalizacje (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kod TEXT NOT NULL UNIQUE,         -- np. M2-J14-P2
  magazyn TEXT NOT NULL,            -- K4 lub K4gora
  aktywna INTEGER NOT NULL DEFAULT 1,
  utworzona DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tabela 2: stany lokalizacji
CREATE TABLE stany_lokalizacji (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lokalizacja_id INTEGER NOT NULL REFERENCES lokalizacje(id),
  artykul_gt_id TEXT NOT NULL,      -- tw_Id z GT
  artykul_symbol TEXT NOT NULL,
  artykul_nazwa TEXT NOT NULL,
  ilosc DECIMAL NOT NULL DEFAULT 0,
  ostatnia_zmiana DATETIME DEFAULT CURRENT_TIMESTAMP,
  operator TEXT,
  UNIQUE(lokalizacja_id, artykul_gt_id)
);

-- Tabela 3: ruchy
CREATE TABLE ruchy (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  typ TEXT NOT NULL,                -- LOK lub MM
  artykul_gt_id TEXT NOT NULL,
  artykul_symbol TEXT NOT NULL,
  lok_zrodlo_id INTEGER REFERENCES lokalizacje(id),   -- NULL przy LOK
  lok_cel_id INTEGER REFERENCES lokalizacje(id),      -- NULL gdy cel = ZEW
  mag_cel_zewnetrzny TEXT,          -- np. ZEW1 gdy cel to mag. zewnętrzny
  ilosc DECIMAL NOT NULL,
  dok_gt_numer TEXT,                -- numer MM w GT, NULL przy LOK
  status TEXT NOT NULL DEFAULT 'pending',  -- pending / ok / error
  blad_opis TEXT,
  data_ruchu DATETIME DEFAULT CURRENT_TIMESTAMP,
  operator TEXT
);

-- Tabela 4: inwentaryzacje
CREATE TABLE inwentaryzacje (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  magazyn TEXT NOT NULL,            -- K4 lub K4gora
  status TEXT NOT NULL DEFAULT 'otwarta',  -- otwarta / zamknieta
  data_otwarcia DATETIME DEFAULT CURRENT_TIMESTAMP,
  data_zamkniecia DATETIME,
  operator TEXT
);

-- Tabela 5: pozycje inwentaryzacji
CREATE TABLE pozycje_inwentaryzacji (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inwentaryzacja_id INTEGER NOT NULL REFERENCES inwentaryzacje(id),
  lokalizacja_id INTEGER NOT NULL REFERENCES lokalizacje(id),
  artykul_gt_id TEXT NOT NULL,
  artykul_symbol TEXT NOT NULL,
  ilosc_gt DECIMAL NOT NULL DEFAULT 0,     -- snapshot z GT przy otwarciu
  ilosc_liczona DECIMAL,                   -- ze skanu, NULL = nieskanowana
  roznica DECIMAL GENERATED ALWAYS AS (ilosc_liczona - ilosc_gt) VIRTUAL,
  zatwierdzona INTEGER NOT NULL DEFAULT 0,
  operator TEXT
);

-- Tabela 6: rozjazdy
CREATE TABLE rozjazdy (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artykul_gt_id TEXT NOT NULL,
  artykul_symbol TEXT NOT NULL,
  magazyn TEXT NOT NULL,
  ilosc_gt DECIMAL NOT NULL,
  ilosc_wms DECIMAL NOT NULL,
  roznica DECIMAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'nowy',     -- nowy / wyjasniowy
  opis TEXT,
  wykryty DATETIME DEFAULT CURRENT_TIMESTAMP,
  wyjasniomy DATETIME,
  operator TEXT
);

-- Indeksy
CREATE INDEX idx_stany_artykul ON stany_lokalizacji(artykul_gt_id);
CREATE INDEX idx_stany_lokalizacja ON stany_lokalizacji(lokalizacja_id);
CREATE INDEX idx_ruchy_artykul ON ruchy(artykul_gt_id);
CREATE INDEX idx_ruchy_status ON ruchy(status);
CREATE INDEX idx_rozjazdy_status ON rozjazdy(status);
```

---

## Stack techniczny

| Komponent | Technologia |
|---|---|
| Backend | Node.js + Express |
| Baza danych | SQLite (plik `wms.db`) |
| Frontend Zebra | PWA — HTML + vanilla JS (Chrome na Zebrze) |
| Frontend Desktop | Ta sama apka, inny layout |
| Skanowanie | DataWedge — wstrzykuje skan do aktywnego `<input>` |
| Integracja GT | C# .NET — lokalny REST endpoint → Sfera GT (COM) |

### Struktura folderów
```
wms/
├── db/
│   ├── 001_init.sql          # schemat bazy
│   └── database.js           # połączenie SQLite
├── routes/
│   ├── lokalizacje.js
│   ├── ruchy.js
│   └── inwentaryzacja.js
├── services/
│   ├── gt-bridge.js          # HTTP klient do mostu C#
│   ├── gt-fields.js          # logika kompresji pól własnych GT
│   └── rozjazdy.js           # job detekcji rozjazdów
├── public/
│   ├── zebra/                # PWA na Zebrę
│   │   ├── index.html
│   │   ├── lokalizowanie.html
│   │   ├── mm.html
│   │   └── inwentaryzacja.html
│   └── desktop/              # widok desktopowy
│       └── index.html
├── bridge/                   # projekt C# (osobny folder)
│   └── GtBridge/
├── app.js                    # entry point Express
└── package.json
```

---

## Most C# do Sfera GT

Osobny proces .NET wystawiający REST API na `localhost:5000`.

### Endpointy mostu
```
POST /api/mm          -- wystaw dokument MM w GT
POST /api/lok         -- zapisz pole własne artykułu w GT
GET  /api/stan/:magId -- pobierz stany magazynowe z GT
GET  /api/artykul/:id -- pobierz dane artykułu z GT
POST /api/inwentaryzacja/rw  -- wystaw RW w GT
POST /api/inwentaryzacja/pw  -- wystaw PW w GT
```

---

## Logika kompresji lokalizacji do pól własnych GT

```
Wejście: ["M2-J14-P2", "M2-J14-P3", "M2-J15-P1", "M2-J16-P2", "M2-J16-P4"]

Grupuj po magazyn+regał:
  M2-J14: P2, P3       → M2-J14-P2/3
  M2-J15: P1           → M2-J15-P1
  M2-J16: P2, P4       → M2-J16-P2/4

Połącz: "M2-J14-P2/3; M2-J15-P1; M2-J16-P2/4"  (34 znaki → mieści się w polu 1)

Jeśli całość > 50 znaków → podziel na dwa pola (Lokalizacja Górna + Lokalizacja Zapas)
Jeśli > 100 znaków → reszta tylko w WMS, GT pokazuje tyle ile może + "..."
```

---

## Kolejność budowania

1. `001_init.sql` + `database.js` — baza SQLite
2. REST API — CRUD lokalizacje i stany
3. PWA ekran MM (najprostszy, test DataWedge)
4. Most C# — endpoint `/api/mm` i `/api/lok`
5. Integracja MM end-to-end
6. PWA ekran LOK (lokalizowanie po PZ)
7. Job rozjazdów
8. PWA inwentaryzacja
9. Widok desktopowy

---

## Ważne uwagi dla Claude Code

- GT jest masterem stanów ilościowych — WMS nigdy nie modyfikuje stanów bezpośrednio, tylko przez dokumenty (MM, RW, PW)
- WMS jest masterem lokalizacji — pola własne GT to kopia do wyświetlenia
- Każdy ruch zapisuje się najpierw do tabeli `ruchy` ze statusem `pending`, dopiero potem wywołuje most C#. Przy błędzie Sfery ruch zostaje `pending` — nie ginie.
- Przy K4: waliduj że artykuł nie ma już innej aktywnej lokalizacji przed zapisem LOK
- Przy MM z K4gora do ZEW: `lok_cel_id` = NULL, `mag_cel_zewnetrzny` = nazwa magazynu
- Inwentaryzacja blokuje MM i LOK dla danego magazynu (sprawdź tabelę `inwentaryzacje` gdzie status = 'otwarta')
