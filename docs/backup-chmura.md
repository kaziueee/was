# Kopia poza maszynę (chmura / DR)

Cel **czysto awaryjny**: gdy padnie pecet (dysk, kradzież, ransomware, pożar), off-site zostaje się czym ratować. Kod jest w `services/backup-czytelne.js` (generacja CSV) + `services/backup.js` (paczka dnia + wysyłka). Funkcja jest **wyłączona, dopóki nie ustawisz `WMS_RCLONE_REMOTE`** — nic się nie zmienia w dotychczasowym backupie lokalnym.

## Co i jak leci

Raz dziennie (przy pierwszym backupie danego dnia) powstaje **paczka dnia** w `db/backups/chmura/` i idzie do B2 przez `rclone copy` (jednokierunkowo — push nigdy nie kasuje w chmurze):

| Plik | Co to | Do czego w awarii |
|---|---|---|
| `wms_DATA.db` | spójna kopia całej bazy (VACUUM INTO) | pełne odtworzenie systemu |
| `lokalizacje_zbiorczo_DATA.csv` | 1 SKU = 1 wiersz (suma stanu + wszystkie lokalizacje) | **główny ratunek** — druk / odbudowa mapy ręcznie |
| `lokalizacje_DATA.csv` | 1 wiersz na (SKU, półka) | sort/filtr po półce, re-import maszynowy |
| `historia_DATA.csv` | dziennik ruchów (`ruchy`) | filtr po kolumnie `symbol` = co się działo na SKU |

Dane biorą się **wyłącznie z WMS** (`stany_lokalizacji` + `ruchy`) — nie pytamy GT, więc pliki powstają nawet gdy most/Subiekt leży (czyli dokładnie w awarii). Lokalnie trzymamy ostatnie **14 dni** paczek (`WMS_CHMURA_TRZYMAJ_DNI`); **chmura trzyma komplet** (copy nic zdalnie nie usuwa, ~0,6 MB/dzień = lata w darmowym progu).

Błąd wysyłki → alarm w logu awarii (`services/awarie`) + retry przy kolejnym backupie (znacznik „wysłane" ustawiamy dopiero po sukcesie).

## Konfiguracja (jednorazowo) — po Twojej stronie

Tych kroków nie zrobię za Ciebie: dotyczą Twojego konta i haseł.

### 1. Backblaze B2
1. Załóż konto na backblaze.com (B2 Cloud Storage).
2. **Utwórz kubełek (bucket)** z **włączonym Object Lock** i domyślną retencją np. **30 dni**. To sedno odporności: plik zablokowany na 30 dni jest **nie do skasowania ani nadpisania nawet z ważnym kluczem** — więc zainfekowany pecet nie dosięgnie kopii. (Object Lock trzeba włączyć przy tworzeniu kubełka.)
3. **Utwórz Application Key** ograniczony do tego kubełka (read+write). Zapisz `keyID` i `applicationKey` — klucz pokazuje się raz. (Object Lock i tak chroni przed kasowaniem; jeśli chcesz pas i szelki, wygeneruj klucz bez uprawnienia `deleteFiles` — `rclone copy` go nie potrzebuje.)

### 2. rclone na pececie (Windows, konto Adm)
1. Pobierz `rclone.exe` z rclone.org/downloads (albo `winget install Rclone.Rclone`). Odłóż np. do `C:\was\bin\rclone.exe`.
2. Skonfiguruj remote (jako **Adm**, żeby `rclone.conf` trafił w profil, z którego chodzi zadanie):
   ```
   rclone config create b2wms b2 account <keyID> key <applicationKey>
   ```
   (albo interaktywnie: `rclone config` → `n` → nazwa `b2wms` → typ `b2` → wklej keyID/key.)
3. Test ręczny:
   ```
   rclone lsd b2wms:
   ```
   Powinien pokazać Twój kubełek.

### 3. Zmienne w `C:\was\.env`
```
WMS_RCLONE_REMOTE=b2wms:NAZWA-KUBELKA/wms
WMS_RCLONE_BIN=C:\was\bin\rclone.exe
```
Opcjonalnie `WMS_RCLONE_CONFIG=C:\...\rclone.conf` (gdy zadanie chodzi z innego profilu niż ten, w którym robiłeś `rclone config`), `WMS_CHMURA_DIR`, `WMS_CHMURA_TRZYMAJ_DNI`.

### 4. Restart i weryfikacja
1. Zrestartuj serwer: `schtasks /Run /TN WMS-Node` (po wcześniejszym `/End`), albo z ikony w trayu.
2. **Wymuś pierwszą wysyłkę i sprawdź wynik** (czeka na rclone, wypisuje OK/BŁĄD):
   ```
   node scripts/backup-chmura-teraz.js
   ```
3. Zajrzyj do B2 (web) — powinny leżeć `wms_DATA.db` + trzy CSV.

## Test odtwarzalności (raz na kwartał) — WAŻNE

Backup, którego nigdy nie odtworzyłeś, to nie backup. Raz na kwartał:
```
rclone copy b2wms:NAZWA-KUBELKA/wms C:\tmp\restore-test
```
Otwórz `lokalizacje_zbiorczo_DATA.csv` w Excelu (czy sensowny) i sprawdź bazę:
```
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('C:/tmp/restore-test/wms_DATA.db',{readOnly:true});console.log(d.prepare('PRAGMA integrity_check').get());"
```
Ma wyjść `{ integrity_check: 'ok' }`.

## Uwagi
- **„razem" w CSV = suma z półek WMS (K4+K4G)**, nie „Razem" z karty produktu (tam dochodzą MAG/LS z GT). Dla „gdzie to leży na hali" — właściwe.
- **Historia z `ruchy`**: cofnięty ruch (`DELETE /ruchy/:id`) znika → to „stan faktyczny", nie księga wieczysta. Do zerknięcia „co się działo na SKU" wystarcza; twardy ślad jest w `audyt`.
- Separator CSV to **średnik `;`** (Excel PL), otwiera się dwuklikiem bez rozjazdu kolumn.
