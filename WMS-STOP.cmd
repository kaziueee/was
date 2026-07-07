@echo off
REM Zatrzymuje serwer WMS (Node). Dwuklik.
schtasks /End /TN "WMS-Node"
echo.
echo Serwer WMS zatrzymany.
pause
