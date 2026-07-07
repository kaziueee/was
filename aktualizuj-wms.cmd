@echo off
REM Dwuklik = aktualizacja serwera WMS (Node): git pull + npm ci + restart.
REM Uruchamia aktualizuj-wms.ps1 z pominieciem polityki wykonywania skryptow.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0aktualizuj-wms.ps1"
