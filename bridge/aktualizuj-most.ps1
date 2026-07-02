# aktualizuj-most.ps1 - jedno-klik aktualizacja mostu GtBridge (Faza C#9).
# Zatrzymuje most -> git pull -> dotnet publish -> uruchamia nowa wersje.
# Odpalany przez aktualizuj-most.cmd (dwuklik). Sciezki liczone wzgledem tego pliku,
# wiec dziala niezaleznie od tego, gdzie sklonowano repo.

$bridgeDir = $PSScriptRoot                    # ...\was\bridge
$repoDir   = Split-Path $bridgeDir -Parent    # ...\was  (katalog repo dla git)
$projDir   = Join-Path $bridgeDir 'GtBridge'  # projekt mostu (csproj)
$exe       = Join-Path $projDir 'bin\Release\net8.0-windows\win-x86\publish\GtBridge.exe'

Write-Host '=== Aktualizacja mostu WMS ===' -ForegroundColor Cyan
try {
    Write-Host '1/4 Zatrzymuje dzialajacy most...'
    taskkill /IM GtBridge.exe /F 2>$null | Out-Null   # brak procesu = OK, nie przerywamy
    Start-Sleep -Seconds 1

    Write-Host '2/4 Pobieram nowy kod (git pull)...'
    git -C $repoDir pull --ff-only
    if ($LASTEXITCODE -ne 0) { throw 'git pull nie powiodl sie (sprawdz polaczenie / lokalne zmiany)' }

    Write-Host '3/4 Buduje nowa wersje (dotnet publish)...'
    dotnet publish $projDir -c Release -r win-x86 --self-contained
    if ($LASTEXITCODE -ne 0) { throw 'dotnet publish nie powiodl sie' }

    Write-Host '4/4 Uruchamiam nowy most...'
    Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe -Parent)  # CWD=publish -> appsettings

    Write-Host ''
    Write-Host 'GOTOWE - most zaktualizowany i uruchomiony. Ikona wrocila przy zegarku.' -ForegroundColor Green
}
catch {
    Write-Host ''
    Write-Host ('BLAD: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host 'Most moze byc teraz wylaczony. Odpal recznie GtBridge.exe albo napisz do mnie.' -ForegroundColor Yellow
}
Write-Host ''
Read-Host 'Nacisnij Enter, aby zamknac to okno'
