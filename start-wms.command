#!/bin/bash
# Starter serwera WMS.
# Uzycie: dwuklik w Finderze (macOS) albo w terminalu: ./start-wms.command
# Okno trzymaj otwarte - zamkniecie okna konczy serwer. Stop: Ctrl+C.

# wejdz do katalogu projektu (tam gdzie lezy ten plik)
cd "$(dirname "$0")" || exit 1

# adres w sieci LAN (dla Zebry) - Wi-Fi en0, w razie czego en1
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)

echo "=================================================="
echo "  WMS - serwer"
echo "  Desktop:    http://localhost:3000"
if [ -n "$IP" ]; then
  echo "  Zebra/LAN:  http://$IP:3000"
else
  echo "  Zebra/LAN:  (brak adresu Wi-Fi - sprawdz polaczenie)"
fi
echo "  Stop:       Ctrl+C  (albo zamknij to okno)"
echo "=================================================="
echo

# jesli port 3000 jest zajety, zatrzymaj poprzednia instancje
if lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port 3000 zajety - zatrzymuje poprzedni serwer WMS..."
  pkill -f "node app.js"
  sleep 1
fi

# caffeinate -i: Mac nie zasnie w trakcie pracy serwera (zasniecie ubijalo proces).
# exec - serwer przejmuje proces, Ctrl+C dziala czysto.
exec caffeinate -i node app.js
