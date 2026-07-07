@echo off
REM Restart serwera WMS (Node): stop + start. Dwuklik.
schtasks /End /TN "WMS-Node"
timeout /t 3 /nobreak >nul
schtasks /Run /TN "WMS-Node"
echo.
echo Serwer WMS zrestartowany.
pause
