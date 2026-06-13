# WMS dla Subiekt GT

Lekki system zarządzania magazynem (WMS) jako uzupełnienie Subiekt GT.
Obsługuje lokalizacje magazynowe, przesunięcia MM oraz inwentaryzację.
Zbiór i wysyłka pozostają po stronie Sellasist.

## Stack

- **Backend:** Node.js + Express
- **Baza:** SQLite (`db/wms.db`)
- **Frontend:** PWA (HTML + vanilla JS) — wspólna apka dla Zebry i desktopu
- **Skanowanie:** DataWedge na terminalach Zebra
- **Integracja GT:** most C# (`bridge/GtBridge/`) → Sfera GT (COM) → REST na `localhost:5000`

## Zasady nadrzędne

1. **GT = master stanów ilościowych** — WMS zmienia stany tylko przez dokumenty (MM, RW, PW) przez Sferę
2. **WMS = master lokalizacji** — pola własne GT to kopia do wyświetlenia
3. **Inwariant:** suma sztuk na lokalizacjach WMS = stan GT dla każdej pary (artykuł, magazyn)
4. **Kolejka:** każdy ruch zapisuje się do tabeli `ruchy` ze statusem `pending` zanim wywoła most C#

## Uruchomienie

```bash
npm install
node app.js
```

Szczegóły architektury i konwencji w [CLAUDE.md](CLAUDE.md).
