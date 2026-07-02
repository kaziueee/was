# Handoff: most GtBridge (Sfera) — kontynuacja na maszynie Windows

Ten plik to instrukcja dla sesji Claude Code uruchomionej **na maszynie Windows z
Subiekt GT + Sferą**. Sesja startuje bez pamięci wcześniejszej rozmowy — tu jest cały
potrzebny kontekst. Pełny status: `PROGRESS.md`. Architektura: `CLAUDE.md` (ale uwaga
na rozjazd opisany niżej).

## Po co ten most

WMS dla Subiekt GT. Większość systemu to Node.js (działa na Macu). **Most `bridge/GtBridge`
to jedyny kawałek w C#** — bo tylko przez **Sferę** (Windows COM, biblioteka InsERT)
można bezpiecznie wystawiać dokumenty magazynowe (MM/RW/PW) w GT. Most to lokalny REST
na `http://localhost:5000`, który woła aplikacja Node.

Łańcuch: `Zebra/przeglądarka → WMS (Node) → most GtBridge (C#/.NET) → Sfera → Subiekt GT`

## Stan na 2026-06-14

- **MM przez Sferę — ZAIMPLEMENTOWANE, nieprzetestowane.** `SferaGtService.Polacz()` +
  `WystawMmAsync()` napisane wg modelu obiektowego z `gta.chm`. Trzeba to przetestować
  na żywym GT (patrz "Następny krok").
- **Zapis lokalizacji — decyzja: bezpośredni SQL z Node**, nie przez Sferę (Pole1=K4,
  Pole8=K4G; `pwd_Tekst09` pomijamy). Jeszcze nieimplementowane. `ZapiszLokalizacjeAsync`
  w C# zostaje martwym stubem.
- **Pozostałe metody Sfery** (`PobierzStanyAsync`, `PobierzArtykulAsync`, `WystawRwAsync`,
  `WystawPwAsync`) — stuby (`NotImplementedException`). RW/PW do zrobienia analogicznie
  do MM, gdy MM się sprawdzi.

## Środowisko / pułapki (Windows) — już rozwiązane, ale pamiętaj

- **Sfera to 32-bit COM** → proces .NET musi być **x86**. `GtBridge.csproj` ma już
  `TargetFramework=net8.0-windows` + `PlatformTarget=x86`.
- **Runtime x86** bywa problemem. Najpewniej buduj **self-contained** (runtime w środku,
  nic nie trzeba instalować w systemie):
  ```powershell
  dotnet publish -c Release -r win-x86 --self-contained
  ```
  Uruchamiasz potem: `.\bin\Release\net8.0-windows\win-x86\publish\GtBridge.exe`
- **`appsettings.json` to JSON** — ukośniki w `Serwer` muszą być podwójne (`SERWER\\InsERTGT`)
  albo użyj formy z IP (`192.168.0.200,49951`). Pojedynczy `\` wywala start aplikacji.
- Most czyta `appsettings.json` z **bieżącego katalogu** (CWD), nie z folderu exe —
  uruchamiaj z folderu, w którym jest poprawiony `appsettings.json`.
- Wybór mocka vs Sfery: `Startup.cs` bierze prawdziwy `SferaGtService` w Production
  (domyślne środowisko na Windows). Mock wchodzi tylko w Development lub gdy
  `Sfera:UzyjMock=true`.
- Wymagania systemowe (z gta.chm): strona kodowa **1250**, ustawienia regionalne **PL**,
  user SQL z uprawnieniem **VIEW SERVER STATE** (`sa` ma).

## Konfiguracja (`bridge/GtBridge/appsettings.json`)

Sekcja `Sfera` (hasła jawne — most je szyfruje w runtime przez `InsERT.Dodatki.Szyfruj`):
```json
"Sfera": {
  "ProgId": "InsERT.GT",
  "Serwer": "192.168.0.200,49951",
  "Baza": "Z_KAJTEK_IdeaERP",
  "Uzytkownik": "sa",
  "UzytkownikHaslo": "<haslo_sa>",
  "Operator": "<operator_GT, np. Szef>",
  "OperatorHaslo": "<jesli ma haslo>"
}
```
**NIE commituj pliku z hasłami.** W repo zostaje pusty szablon.

## Następny krok: test MM (to tutaj utknęliśmy)

1. Zbuduj self-contained i uruchom most (patrz wyżej) → ma zawisnąć na
   `Now listening on: http://localhost:5000`.
2. W drugim oknie PowerShell wystaw testowe MM — **1 szt z K4 na K4G**, towar testowy
   `PANBAT02475` (`tw_Id = 4180`, stan K4 ~26, K4G 0):
   ```powershell
   $body = @{ artykul_gt_id="4180"; magazyn_zrodlowy_id=4; magazyn_docelowy_id=8; ilosc=1 } | ConvertTo-Json
   Invoke-RestMethod -Uri http://localhost:5000/api/mm -Method Post -Body $body -ContentType "application/json"
   ```
3. Sukces = `sukces:True` + `numer_dokumentu:"MM .../2026"`, a w Subiekcie towar 4180
   ma K4=25, K4G=1 i nowy dokument MM. Cofnij testem odwrotnym (źródło 8, cel 4).
4. Błąd wraca jako czytelny `blad` (mapowane HRESULT-y Sfery: brak licencji, brak towaru,
   zła strona kodowa, brak VIEW SERVER STATE itd.) — diagnozuj wg komunikatu.

## Przepis Sfery (z gta.chm) — gdyby trzeba poprawić kod

- **Logowanie:** `InsERT.GT` → `Produkt=1` (Subiekt), `Autentykacja=0` (mieszana),
  `Serwer`/`Baza`/`Uzytkownik`/`UzytkownikHaslo`(szyfr.)/`Operator`/`OperatorHaslo`(szyfr.)
  → `Uruchom(2 /*DopasujOperatora*/, gtaUruchomNowy|gtaUruchomWTle = 6)` → zwraca `Subiekt`.
  Hasła szyfruje `InsERT.Dodatki.Szyfruj(jawne)`.
- **MM:** `Subiekt.Dokumenty.DodajMM()` → `MagazynNadawczyId`/`MagazynOdbiorczyId`
  (mag_Id GT) → `Pozycje.Dodaj(tw_Id)` → `IloscJm` → **`dok.Uwagi = request.Uwagi`**
  (Faza A#3, patrz niżej) → `StatusDokumentu=1` (Wywolany, realny skutek magazynowy) →
  `Zapisz()` → odczyt `NumerPelny`.

## Faza A#3 — Uwagi dokumentu MM (✅ POTWIERDZONE NA ŻYWO 2026-07-02)

Most wpisuje do **Uwag** wystawianego MM gotowy tekst z Node (`request.Uwagi`), np.
`WMS-RUCH:121 | Mateusz | 02.07.2026 16:58`. To (a) **klucz idempotencji** — Node przy
ponowieniu szuka dokumentu po `dok_Uwagi LIKE 'WMS-RUCH:<id> |%'` i adoptuje go zamiast
wystawić drugi MM (gdy odpowiedź HTTP zaginęła); (b) ślad **kto/kiedy** zrobił przesunięcie.

`SferaGtService.WystawMmAsync` ustawia `dok.Uwagi = request.Uwagi`. **Właściwość `Uwagi`
działa** — zweryfikowane na żywym GT (ruch 121 = MM 334/2026, `znajdzMMpoKluczu` znalazł
dokument po kluczu). `MmRequest` ma pole `uwagi` (string), już nie `ruch_id`.

### Deploy zmian C# na Windows (most = ręczna kopia plików, NIE git)
1. Podmień zmienione pliki `.cs` na Windowsie (kopia/wklej z Maca).
2. Zamknij działający most: Ctrl+C w jego oknie albo `taskkill /IM GtBridge.exe /F`.
3. W folderze projektu (z `GtBridge.csproj`): `dotnet publish -c Release -r win-x86 --self-contained`.
4. Odpal nowy: `.\bin\Release\net8.0-windows\win-x86\publish\GtBridge.exe` (czeka na
   `Now listening on: http://0.0.0.0:5000`, `Hosting environment: Production`).
- **Id magazynów GT** (z `sl_Magazyn`): **K4=4, K4G=8, MAG=1, LS=6**.
- Plik z modelem: `gta.chm` (InsERT GT dla aplikacji). Rozpakowanie na nie-Windows:
  `extract_chmLib gta.chm <katalog>` (chmlib) — strony HTML w `htm/`.

## Kluczowe pliki

- `bridge/GtBridge/Services/SferaGtService.cs` — `Polacz()` + `WystawMmAsync()` (+ stuby reszty)
- `bridge/GtBridge/Services/SferaOptions.cs` + `appsettings.json` — konfiguracja połączenia
- `bridge/GtBridge/Models/MmRequest.cs` — kontrakt (zawiera `magazyn_*_id`)
- `services/gt-bridge.js`, `services/ruchy-gt.js`, `config/magazyny.js` (Node) — strona WMS,
  rozwiązuje symbol magazynu → mag_Id i woła most
- `PROGRESS.md` — pełny dziennik i sekcja "Otwarte"
