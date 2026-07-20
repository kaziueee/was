@echo off
REM Restart / naprawa mostu GT (WMS). Dwuklik.
REM Zwalnia port 5000 (tez po zawieszonym procesie) i uruchamia most na czysto.
title Naprawa mostu GT
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\was\naprawmost.ps1"
