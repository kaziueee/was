# ============================================================
#  NAPRAWA MOSTU GT (WMS)
#  Zwalnia port 5000, uruchamia most na czysto, sprawdza wynik.
#  Odporny na "zombie" - proces, ktory zawisl i trzyma port,
#  przez co zwykly restart sie nie udaje.
#  Wolane przez MOST-RESTART.cmd (dwuklik). Rusza WYLACZNIE most.
# ============================================================
$ErrorActionPreference = 'SilentlyContinue'
chcp 1250 | Out-Null

function Port5000Zajety {
    return [bool](Get-NetTCPConnection -LocalPort 5000 -State Listen -EA 0)
}

Write-Host ""
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "   NAPRAWA MOSTU GT" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host ""

# 1. Zatrzymaj most dwoma sposobami:
#    - przez zadanie (czysty stop)
#    - twardo po nazwie procesu (lapie tez zawieszonego zombie,
#      ktorego zadanie juz nie "widzi")
Write-Host "[1/4] Zatrzymuje most i zwalniam port 5000..."
schtasks /End /TN "WMS-Bridge" 2>$null | Out-Null
Get-Process GtBridge -EA 0 | Stop-Process -Force -EA 0

# 2. Poczekaj az port 5000 przestanie byc zajety (do 15 s)
Write-Host "[2/4] Czekam, az port sie zwolni..."
$portWolny = $false
for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 1
    if (-not (Port5000Zajety)) { $portWolny = $true; break }
}

if (-not $portWolny) {
    Write-Host ""
    Write-Host "  PROBLEM: port 5000 nadal zajety." -ForegroundColor Red
    Write-Host "  Cos go trzyma i nie chce puscic." -ForegroundColor Red
    Write-Host ""
    Write-Host "  CO ZROBIC: uruchom pecet ponownie (restart Windows)" -ForegroundColor Yellow
    Write-Host "  albo zadzwon po pomoc i podaj:" -ForegroundColor Yellow
    Write-Host "  'most - port 5000 zajety, nie zwalnia sie'." -ForegroundColor Yellow
    Write-Host ""
    Read-Host "Nacisnij Enter, aby zamknac"
    exit 1
}

# 3. Uruchom most
Write-Host "[3/4] Port wolny. Uruchamiam most..."
schtasks /Run /TN "WMS-Bridge" 2>$null | Out-Null

# 4. Sprawdz, czy wstal (czeka do 25 s az zacznie nasluchiwac)
Write-Host "[4/4] Sprawdzam, czy most wstal..."
$dziala = $false
for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Seconds 1
    if (Port5000Zajety) { $dziala = $true; break }
}

Write-Host ""
if ($dziala) {
    Write-Host "=====================================" -ForegroundColor Green
    Write-Host "   MOST DZIALA" -ForegroundColor Green
    Write-Host "=====================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Jeszcze potwierdz w WMS:" -ForegroundColor White
    Write-Host "   1. Ekran logowania - 'Most' na zielono."
    Write-Host "   2. Wystaw MM na 1 szt. i cofnij go -"
    Write-Host "      jesli przejdzie, most na pewno dziala."
} else {
    Write-Host "=====================================" -ForegroundColor Red
    Write-Host "   MOST NIE WSTAL" -ForegroundColor Red
    Write-Host "=====================================" -ForegroundColor Red
    Write-Host ""
    Write-Host "  Port sie zwolnil, ale most nie ruszyl." -ForegroundColor Yellow
    Write-Host "  Sprobuj jeszcze raz (dwuklik tego samego pliku)." -ForegroundColor Yellow
    Write-Host "  Jesli dalej nie wstaje - zadzwon po pomoc i podaj:" -ForegroundColor Yellow
    Write-Host "  'most nie wstaje mimo naprawy, port byl wolny'." -ForegroundColor Yellow
}
Write-Host ""
Read-Host "Nacisnij Enter, aby zamknac"
