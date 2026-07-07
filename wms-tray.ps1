Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function New-WIcon([System.Drawing.Color]$kolor) {
  $bmp = New-Object System.Drawing.Bitmap 32,32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $brush = New-Object System.Drawing.SolidBrush $kolor
  $g.FillEllipse($brush,1,1,29,29)
  $font = New-Object System.Drawing.Font('Segoe UI',15,[System.Drawing.FontStyle]::Bold)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = [System.Drawing.StringAlignment]::Center
  $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
  $g.DrawString('W',$font,[System.Drawing.Brushes]::White,(New-Object System.Drawing.RectangleF(0,0,32,32)),$sf)
  $g.Dispose()
  return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

# niebieski = serwer dziala, szary = zatrzymany (przelaczane w timerze co 5s)
$script:iconOn  = New-WIcon ([System.Drawing.Color]::FromArgb(255,30,90,200))
$script:iconOff = New-WIcon ([System.Drawing.Color]::FromArgb(255,140,140,140))
$script:ni = New-Object System.Windows.Forms.NotifyIcon
$script:ni.Icon = $script:iconOn
$script:ni.Text = 'WMS'
$script:ni.Visible = $true

function Invoke-Restart { $script:ni.ShowBalloonTip(2000,'WMS','Restartuje serwer...',[System.Windows.Forms.ToolTipIcon]::Info); Stop-ScheduledTask -TaskName 'WMS-Node' -EA SilentlyContinue; Start-Sleep -Seconds 2; Start-ScheduledTask -TaskName 'WMS-Node' -EA SilentlyContinue }
function Invoke-Stop { Stop-ScheduledTask -TaskName 'WMS-Node' -EA SilentlyContinue; $script:ni.ShowBalloonTip(2000,'WMS','Serwer zatrzymany',[System.Windows.Forms.ToolTipIcon]::Warning) }
function Invoke-Start { Start-ScheduledTask -TaskName 'WMS-Node' -EA SilentlyContinue; $script:ni.ShowBalloonTip(2000,'WMS','Serwer uruchomiony',[System.Windows.Forms.ToolTipIcon]::Info) }

$menu = New-Object System.Windows.Forms.ContextMenuStrip
[void]$menu.Items.Add('Otworz WMS (desktop)',$null,{ Start-Process 'http://localhost:3000/desktop/' })
[void]$menu.Items.Add('Otworz menu Zebry',$null,{ Start-Process 'http://localhost:3000/' })
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add('Pokaz log serwera (bledy)',$null,{
  $log = Get-ChildItem 'C:\was\logs\error-*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($log) { Start-Process notepad $log.FullName } else { Start-Process explorer 'C:\was\logs' }
})
[void]$menu.Items.Add('Pokaz folder logow',$null,{ Start-Process explorer 'C:\was\logs' })
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add('Restart serwera',$null,{ Invoke-Restart })
[void]$menu.Items.Add('Zatrzymaj serwer',$null,{ Invoke-Stop })
[void]$menu.Items.Add('Uruchom serwer',$null,{ Invoke-Start })
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add('Zamknij ikone (serwer dziala dalej)',$null,{ $script:ni.Visible=$false; [System.Windows.Forms.Application]::Exit() })
$script:ni.ContextMenuStrip = $menu
$script:ni.add_MouseDoubleClick({ Start-Process 'http://localhost:3000/desktop/' })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.add_Tick({
  $up = @(Get-NetTCPConnection -LocalPort 3000 -State Listen -EA SilentlyContinue).Count -gt 0
  $script:ni.Icon = if ($up) { $script:iconOn } else { $script:iconOff }
  $script:ni.Text = if ($up) { 'WMS - dziala (:3000)' } else { 'WMS - ZATRZYMANY' }
})
$timer.Start()

[System.Windows.Forms.Application]::Run()
