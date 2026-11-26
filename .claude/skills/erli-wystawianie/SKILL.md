---
name: erli-wystawianie
description: Wystawianie produktów na Erli.pl jako kopii ofert Allegro ekajtek (cena Allegro +2%). Użyj, gdy user prosi o wystawienie / skopiowanie ofert na Erli, listę kandydatów na Erli albo sprawdzenie, czego brakuje na Erli.
---

# Wystawianie na Erli (kopia oferty Allegro)

Zakres (decyzje usera 2026-11-26): **tylko zakładanie produktów** na Erli. Bez zamówień, bez repricera, bez synchronizacji ceny. Stanem po założeniu zajmuje się **BaseLinker** — user wiąże tam nowy produkt sam.

Kopia ma kształt 10 tys. kopii, które na Erli już są (test 2026-11-26: BARBBDS6 → produkt 19134158717, aktywny, bez problemów z zakupem): `externalId` = numer oferty Allegro, `sku` = symbol GT, kategoria i parametry z identyfikatorami Allegro, producent GPSR z Allegro, zdjęcia i opis z oferty, cennik dostawy o tej samej nazwie, wysyłka 24 h. **Cena = Allegro × 1,02 w górę do ,99.** Stan startowy = stan oferty Allegro (to już stan BaseLinkera, ucięty do 50).

Kod: `pricing/erli-model.js` (logika i blokady, testy `test/erli-model.test.js`), `pricing/erli.js` (klient API), `scripts/erli-wystaw.js` (narzędzie). Dokumentacja API: https://erli.pl/svc/shop-api/doc/

## Gdzie uruchamiać

**Tylko na SRV, z `C:\was`** (klucz `ERLI_API_KEY` w `.env.dpapi`, tokeny Allegro w `pricing.db`, GT OKITRADE). Z Maca przez SSH:

```bash
ssh Adm@100.107.156.67 'cd C:\was; node --no-warnings --experimental-sqlite scripts/erli-wystaw.js --lista --limit 30'
```

Skrypt musi być w wersji z `main` na SRV (po `git pull` / `aktualizuj-wms.cmd`). Nie zostawiaj w `C:\was` plików spoza repo — blokują `git pull`.

## Przebieg

1. **Lista kandydatów** (tylko odczyt): `--lista [--limit N] [--min-stan N] [--csv C:\Users\Adm\erli.csv]`. Aktywne oferty ekajtek bez kopii na Erli, jedna na SKU, wstępnie ocenione z GT i feedu sklepu. Pokaż userowi liczby i blokady.
2. **Podgląd** wybranych (tylko odczyt): `--oferty NR,NR` albo `--symbole SYM,SYM` (`--json` = pełna treść). Pobiera pełną ofertę Allegro i podaje wszystkie blokady. Pokaż userowi: tytuł, cena Allegro → Erli, stan, kategoria, blokady.
3. **Zapis tylko na wyraźne „wystaw”** od usera, dla pozycji, które pokazał podgląd: ta sama komenda + `--zapisz` (najwyżej 50 naraz). „Lista” to przegląd, nie zgoda na wystawienie. Pozycje z blokadami skrypt pomija sam.
4. Po zapisie przypomnij: **powiązać nowe produkty w BaseLinkerze** (stan) i że Erli publikuje zmiany do ~20 min. Próby zapisują się w `pricing.db` `wystawienia` (platforma `erli`) — widać je w historii Ceny → „Do wystawienia”, odhaczenie „podpięte” = powiązane w BaseLinkerze.

## Producent GPSR

Erli łączy producenta ze swoim słownikiem (`/dictionaries/responsibleProducers`, klucz = id producenta w Allegro). Producenta spoza słownika **po cichu pomija** — skrypt najpierw dodaje brakującego z danymi z Allegro (podgląd pokazuje „nowy w słowniku Erli”). Niepełne dane producenta w Allegro (brak e-maila, adresu) = blokada; poprawia się je na Allegro.

## Blokady (zasady usera dla każdej nowej oferty)

Flaga „sklep internetowy” i cena Specjalna > 0 w Subiekcie · EAN + waga (kg z przecinkiem) + wymiary w GT · karta na Fenomie (feed sklepu) · bez Tefal / Rowenta · nigdy kategoria „Pozostałe” · oferta Allegro aktywna, ze stanem i zdjęciami · cennik dostawy o tej nazwie istnieje na Erli · na Erli nie ma już produktu z tym numerem oferty (także zarchiwizowanego) ani niezarchiwizowanego z tym SKU · jedna kopia na SKU.

Brak danych w GT naprawia się w Subiekcie / Parametrach WMS, nie obchodzi skryptem.

## Czego nie robić

- Nie zmieniać istniejących produktów Erli (ceny ~10 tys. starych kopii są inne niż Allegro +2% — to osobna decyzja usera).
- Nie przywracać zarchiwizowanych kopii przez API — user robi to w panelu Erli.
- Nie ruszać pól zamrożonych (`frozen`) ani `overrideFrozen`.
- Klucza API nie wypisywać ani nie wpisywać; nowy klucz user dopisuje do `C:\was\.env`, potem `node scripts/sekrety.js zaszyfruj ERLI_API_KEY`.
