# aktualizuj-wms.ps1 - jedno-klik aktualizacja serwera WMS (Node).
# Model: serwer chodzi jako Scheduled Task 'WMS-Node' (autostart pod Adm).
# Zatrzymuje task -> git pull -> npm ci -> uruchamia task. Odpalany przez aktualizuj-wms.cmd.
$ErrorActionPreference = 'Stop'
$repoDir = $PSScriptRoot                       # C:\was
$env:Path = 'C:\Users\Adm\nodejs;' + $env:Path # Node w PATH uzytkownika Adm

Write-Host '=== Aktualizacja serwera WMS ===' -ForegroundColor Cyan
try {
    Write-Host '1/4 Zatrzymuje serwer (task WMS-Node)...'
    Stop-ScheduledTask -TaskName 'WMS-Node' -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2

    Write-Host '2/4 Pobieram nowy kod (git pull)...'
    git -C $repoDir pull --ff-only
    if ($LASTEXITCODE -ne 0) { throw 'git pull nie powiodl sie (sprawdz polaczenie / lokalne zmiany)' }

    Write-Host '3/4 Instaluje zaleznosci (npm ci)...'
    Push-Location $repoDir
    npm ci
    if ($LASTEXITCODE -ne 0) { Write-Host 'npm ci nieudane - probuje npm install...' -ForegroundColor Yellow; npm install }
    Pop-Location

    Write-Host '4/4 Uruchamiam serwer...'
    Start-ScheduledTask -TaskName 'WMS-Node'
    Start-Sleep -Seconds 8
    if (@(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).Count -gt 0) {
        Write-Host 'GOTOWE - serwer WMS zaktualizowany i dziala na :3000.' -ForegroundColor Green
    } else {
        Write-Host 'UWAGA: serwer nie nasluchuje na :3000 - sprawdz logi w C:\was\logs.' -ForegroundColor Yellow
    }
}
catch {
    Write-Host ('BLAD: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host 'Uruchom serwer recznie: WMS-START.cmd (albo schtasks /Run /TN WMS-Node).' -ForegroundColor Yellow
}
Write-Host ''
Read-Host 'Nacisnij Enter, aby zamknac'
