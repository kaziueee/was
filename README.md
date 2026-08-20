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

## Dokumentacja

- **[docs/opis.md](docs/opis.md)** — zacznij tutaj: założenia, stack, schemat, bezpieczeństwo,
  logowanie, konwencje
- [docs/architektura.md](docs/architektura.md) — diagramy (kontekst, kanały do GT, przepływ ruchu, joby)
- [docs/zasady.md](docs/zasady.md) — reguły per element + gdzie są egzekwowane w kodzie
- [CLAUDE.md](CLAUDE.md) — pełny kontekst i dziennik decyzji (źródło prawdy)

PDF-y obok plików `.md` odświeża `node scripts/docs-pdf.js`.
