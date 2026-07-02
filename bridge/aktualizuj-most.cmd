@echo off
REM Dwuklik = aktualizacja mostu WMS: git pull + dotnet publish + restart.
REM Uruchamia aktualizuj-most.ps1 z pominieciem polityki wykonywania skryptow.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0aktualizuj-most.ps1"
