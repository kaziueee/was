#!/bin/bash
# Zatrzymanie serwera WMS.
# Uzycie: dwuklik w Finderze (macOS) albo w terminalu: ./stop-wms.command

cd "$(dirname "$0")" || exit 1

if lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Zatrzymuje serwer WMS (port 3000)..."
  pkill -f "node app.js"
  sleep 1
  if lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Nie udalo sie zatrzymac automatycznie. Sprawdz: lsof -nP -iTCP:3000"
  else
    echo "Serwer WMS zatrzymany."
  fi
else
  echo "Serwer WMS nie byl uruchomiony (port 3000 wolny)."
fi

echo
echo "(mozesz zamknac to okno)"
