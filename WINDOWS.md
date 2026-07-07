# WMS na pececie produkcyjnym (Windows) — operacje i setup

Cały stack chodzi na pececie **SRV** pod kontem **`Adm`**, w `C:\was` (klon tego repo).
Mac jest maszyną administracyjną (dostęp przez Tailscale + SSH).

## Co gdzie chodzi (Scheduled Tasks, autostart `AtLogOn` Adm)

| Task | Co | Port | Uwagi |
|---|---|---|---|
| `WMS-Node` | serwer WMS (Node, `node app.js`) | 3000 | Node z `C:\Users\Adm\nodejs` (PATH usera) |
| `WMS-Bridge` | most GT (`GtBridge.exe`, Sfera COM) | 5000 | ikona w zasobniku, „Testuj polaczenie z GT" |
| `WMS-Tray` | ikona WMS (niebieskie „W") | — | menu: otwórz/restart/stop/start serwera |

Wszystkie: LogonType Interactive, RunLevel Limited, restart po awarii, bez limitu czasu.
**Warunek autostartu po reboocie: `Adm` musi się zalogować** (autologin albo ręcznie).

## Dostęp

- **Zebra / PC w magazynie (LAN):** `http://192.168.0.200:3000` (menu Zebry) · `…/desktop/` (desktop). IP statyczny.
- **Admin z Maca (Tailscale):** `http://100.107.156.67:3000/desktop/` · SSH: `ssh Adm@100.107.156.67`
- Logowanie: user `Mateusz` (bez PIN) / `Admin` (z PIN).

## Codzienne sterowanie

- **Ikona „W"** w zasobniku → prawy klik (otwórz/restart/stop/start).
- **Skróty na pulpicie:** `WMS-STOP/START/RESTART.cmd`, `MOST-STOP/START/RESTART.cmd`.
- **PowerShell:** `schtasks /End|/Run /TN WMS-Node` (albo `WMS-Bridge`).

## Aktualizacja kodu

- **Node:** dwuklik **`aktualizuj-wms.cmd`** (stop task → `git pull` → `npm ci` → start task).
- **Most (C#):** dwuklik **`bridge\aktualizuj-most.cmd`** (`git pull` → `dotnet publish` → restart).
- Zdalnie z Maca: `ssh Adm@… "cd C:\was; …"` (patrz też skrypty w historii wdrożenia).

## Setup od zera (odtworzenie środowiska)

Robione raz, udokumentowane na wypadek reinstalu:

1. **Repo:** `C:\was` (klon `git@github.com:kaziueee/was.git`). Po przeniesieniu z innego profilu:
   `git config --global --add safe.directory C:/was` oraz nadać `Adm` prawa:
   `icacls C:\was /grant "SRV\Adm:(OI)(CI)M" /T` (inaczej SQLite: „readonly database").
2. **Node ≥22.5:** zip z nodejs.org rozpakowany do `C:\Users\Adm\nodejs`, dodany do PATH usera. `npm ci` w `C:\was`.
3. **Pliki poza repo (ręcznie):** `C:\was\.env` (GT_SQL_* + `GT_BRIDGE_URL=http://localhost:5000`),
   `C:\was\db\wms.db` (skopiowany z Maca — lista lokalizacji). Oba w `.gitignore`.
4. **Taski:** `WMS-Node`, `WMS-Bridge`, `WMS-Tray` (New-ScheduledTask, Interactive/Adm, AtLogOn).
5. **Firewall:** inbound TCP 3000 (`New-NetFirewallRule -DisplayName 'WMS Node 3000' -LocalPort 3000 -Action Allow`).
6. **Zdalny dostęp:** OpenSSH Server (paczka GitHub, gdy Feature-on-Demand niedostępny) + klucz Maca
   w `C:\ProgramData\ssh\administrators_authorized_keys`; `LocalAccountTokenFilterPolicy=1` dla elewacji przez sieć.
   Tailscale jako usługa (unattended), autostart GUI wyłączony.

## Uwaga: baza

Domyślnie stack celuje w **kopię `Z_KAJTEK_IdeaERP`** (`.env` GT_SQL_DATABASE + `bridge` `appsettings.json` Sfera:Baza).
Przełączenie na produkcyjną = podmiana nazwy bazy w obu miejscach + restart `WMS-Node` i `WMS-Bridge`.
