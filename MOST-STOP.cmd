@echo off
REM Zatrzymuje most GT (GtBridge). Dwuklik.
schtasks /End /TN "WMS-Bridge"
echo.
echo Most GT zatrzymany.
pause
