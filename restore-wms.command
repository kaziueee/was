#!/bin/bash
# Przywracanie bazy WMS z backupu - krok po kroku, dwuklik w Finderze.
# Wybierasz kopie z listy, skrypt zabezpiecza obecna baze i podmienia plik.

cd "$(dirname "$0")" || exit 1

echo "=================================================="
echo "  WMS - PRZYWRACANIE BAZY Z BACKUPU"
echo "=================================================="
echo

# 1. serwer musi byc zatrzymany (inaczej trzyma plik bazy)
if lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "!! Serwer WMS DZIALA. Najpierw go zatrzymaj:"
  echo "   - kliknij stop-wms.command, albo Ctrl+C w oknie serwera."
  echo
  read -n 1 -s -r -p "Nacisnij dowolny klawisz, aby zamknac..."
  exit 1
fi

# 2. pokaz dostepne kopie
node scripts/restore.js
echo

# 3. zapytaj ktora przywrocic
echo "Wpisz nazwe pliku do przywrocenia (skopiuj z listy wyzej)."
echo "Albo zostaw puste i nacisnij Enter, aby ANULOWAC."
read -r -p "Plik: " WYBOR

if [ -z "$WYBOR" ]; then
  echo "Anulowano - nic nie zmieniono."
  read -n 1 -s -r -p "Nacisnij dowolny klawisz, aby zamknac..."
  exit 0
fi

# 4. przywroc (skrypt sam zrobi kopie 'pre-restore' obecnej bazy)
echo
node scripts/restore.js "$WYBOR"
WYNIK=$?
echo

if [ $WYNIK -eq 0 ]; then
  read -r -p "Uruchomic teraz serwer? [t/N]: " ST
  if [ "$ST" = "t" ] || [ "$ST" = "T" ]; then
    exec ./start-wms.command
  fi
fi

read -n 1 -s -r -p "Gotowe. Nacisnij dowolny klawisz, aby zamknac..."
