@echo off
REM Restart mostu GT: stop + start. Dwuklik.
schtasks /End /TN "WMS-Bridge"
timeout /t 3 /nobreak >nul
schtasks /Run /TN "WMS-Bridge"
echo.
echo Most GT zrestartowany.
pause
