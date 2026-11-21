<# : SalHacham uninstaller - batch launcher - keep this part ASCII only
@echo off
setlocal
title SalHacham Uninstall
set "SH_SELF=%~f0"
set "SH_ARGS=%*"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; iex ([System.IO.File]::ReadAllText($env:SH_SELF, [System.Text.Encoding]::UTF8))"
set "SH_RC=%ERRORLEVEL%"
endlocal & exit /b %SH_RC%
#>

# ============================================================================
#  סל חכם - הסרה. Deletes only %LOCALAPPDATA%\SalHacham, then opens
#  chrome://extensions so the user can press "Remove" on the extension.
#  Switches:  -Yes       skip the confirmation (testing)
#             -NoLaunch  no Chrome, no message boxes (testing)
# ============================================================================

$ErrorActionPreference = 'Stop'
$argLine  = [string]$env:SH_ARGS
$NoLaunch = $argLine -match '(^|\s)[-/]NoLaunch(\s|$)'
$AutoYes  = $argLine -match '(^|\s)[-/]Yes(\s|$)'

if (-not $env:LOCALAPPDATA) { Write-Host 'ERROR: LOCALAPPDATA is not set.'; exit 2 }
$Root = Join-Path $env:LOCALAPPDATA 'SalHacham'

Add-Type -AssemblyName System.Windows.Forms
$opts = [System.Windows.Forms.MessageBoxOptions]::RtlReading -bor [System.Windows.Forms.MessageBoxOptions]::RightAlign
function Box([string]$text, $buttons, $icon) {
    return [System.Windows.Forms.MessageBox]::Show($text, 'סל חכם - הסרה', $buttons, $icon,
        [System.Windows.Forms.MessageBoxDefaultButton]::Button2, $opts)
}

function Find-Chrome {
    foreach ($k in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe',
                     'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe',
                     'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe')) {
        try { $v = (Get-ItemProperty -LiteralPath $k -ErrorAction Stop).'(default)'
              if ($v) { $v = $v.Trim('"'); if (Test-Path -LiteralPath $v) { return $v } } } catch { }
    }
    $c = @()
    if ($env:ProgramFiles)        { $c += (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe') }
    if (${env:ProgramFiles(x86)}) { $c += (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe') }
    $c += (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    foreach ($p in $c) { if (Test-Path -LiteralPath $p) { return $p } }
    return $null
}

$exists = Test-Path -LiteralPath $Root
if (-not $AutoYes -and -not $NoLaunch) {
    $q = "להסיר את סל חכם מהמחשב?`n`nהתיקייה הבאה תימחק:`n$Root"
    if (-not $exists) { $q = "התיקייה של סל חכם כבר לא קיימת במחשב.`n`nלפתוח את דף התוספים של כרום כדי להסיר את התוסף משם?" }
    $ans = Box $q ([System.Windows.Forms.MessageBoxButtons]::YesNo) ([System.Windows.Forms.MessageBoxIcon]::Question)
    if ($ans -ne [System.Windows.Forms.DialogResult]::Yes) { Write-Host 'Cancelled.'; exit 3 }
} elseif (-not $AutoYes -and $NoLaunch) {
    Write-Host 'NoLaunch without -Yes: nothing done.'; exit 3
}

if ($exists) {
    try {
        Remove-Item -LiteralPath $Root -Recurse -Force
        Write-Host "Removed: $Root"
    } catch {
        Write-Host ('ERROR: ' + $_.Exception.Message)
        if (-not $NoLaunch) {
            [void](Box "לא הצלחנו למחוק את התיקייה (אולי כרום משתמש בה). סגרו את כרום ונסו שוב.`n`n$Root`n`nפרטים: $($_.Exception.Message)" ([System.Windows.Forms.MessageBoxButtons]::OK) ([System.Windows.Forms.MessageBoxIcon]::Error))
        }
        exit 1
    }
} else {
    Write-Host 'Nothing to remove.'
}

if ($NoLaunch) { Write-Host 'NoLaunch: skipping Chrome and message box.'; exit 0 }

$chrome = Find-Chrome
if ($chrome) { Start-Process -FilePath $chrome -ArgumentList @('chrome://extensions') }
[void](Box "הקבצים של סל חכם נמחקו.`n`nשלב אחרון: בלשונית chrome://extensions שנפתחה בכרום, מצאו את הכרטיס של סל חכם ולחצו על `"הסר`" (Remove)." ([System.Windows.Forms.MessageBoxButtons]::OK) ([System.Windows.Forms.MessageBoxIcon]::Information))
exit 0
