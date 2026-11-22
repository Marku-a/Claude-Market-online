<# : SalHacham installer - batch launcher - keep this part ASCII only
@echo off
setlocal
title SalHacham Setup
set "SH_SELF=%~f0"
set "SH_ARGS=%*"
echo SalHacham setup - please wait...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; iex ([System.IO.File]::ReadAllText($env:SH_SELF, [System.Text.Encoding]::UTF8))"
set "SH_RC=%ERRORLEVEL%"
endlocal & exit /b %SH_RC%
#>

# ============================================================================
#  סל חכם - מתקין חצי-אוטומטי ל-Windows (PowerShell 5.1)
#  The batch part above runs this same file through PowerShell, for this
#  process only (-ExecutionPolicy Bypass). Nothing outside
#  %LOCALAPPDATA%\SalHacham is changed. No admin, no registry writes,
#  no Chrome policies/preferences. The only network access is downloading
#  the GitHub ZIP over HTTPS.
#
#  Switches (passed to the .cmd):  -NoLaunch   test mode: no Chrome, no
#                                              clipboard, no message box.
#  Test-only env override:         SALHACHAM_ZIP_URL
# ============================================================================

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

$argLine  = [string]$env:SH_ARGS
$NoLaunch = $argLine -match '(^|\s)[-/]NoLaunch(\s|$)'

$DefaultZipUrl = 'https://github.com/Marku-a/Claude-Market-online/archive/refs/heads/main.zip'
$ZipUrl = $DefaultZipUrl
if ($env:SALHACHAM_ZIP_URL) { $ZipUrl = $env:SALHACHAM_ZIP_URL }   # testing only

if (-not $env:LOCALAPPDATA) { Write-Host 'ERROR: LOCALAPPDATA is not set.'; exit 2 }
$Root    = Join-Path $env:LOCALAPPDATA 'SalHacham'
$ExtDir  = Join-Path $Root 'extension'
$NewDir  = Join-Path $Root 'extension.new'
$OldDir  = Join-Path $Root 'extension.old'
$Guide   = Join-Path $Root 'guide.html'
$Logo    = Join-Path $Root 'logo-256.png'
$VerFile = Join-Path $Root 'version.txt'

function Say([string]$msg) { Write-Host $msg }   # ASCII only

function Show-Box([string]$text, [string]$kind) {
    if ($NoLaunch) { return }
    try {
        Add-Type -AssemblyName System.Windows.Forms
        $icon = [System.Windows.Forms.MessageBoxIcon]::Information
        if ($kind -eq 'error') { $icon = [System.Windows.Forms.MessageBoxIcon]::Error }
        $opts = [System.Windows.Forms.MessageBoxOptions]::RtlReading -bor [System.Windows.Forms.MessageBoxOptions]::RightAlign
        [void][System.Windows.Forms.MessageBox]::Show($text, 'סל חכם', [System.Windows.Forms.MessageBoxButtons]::OK, $icon,
            [System.Windows.Forms.MessageBoxDefaultButton]::Button1, $opts)
    } catch { }
}

# Hebrew failure: carries a user-facing message
function Fail([string]$heb, [string]$ascii) {
    $e = New-Object System.Exception($ascii)
    $e.Data['heb'] = $heb
    throw $e
}

function Remove-Dir([string]$p) {
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }
}

function Move-DirRetry([string]$from, [string]$to) {
    for ($i = 0; $i -lt 5; $i++) {
        try { [System.IO.Directory]::Move($from, $to); return }
        catch { if ($i -eq 4) { throw }; Start-Sleep -Milliseconds 700 }
    }
}

function Find-Chrome {
    $keys = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe'
    )
    foreach ($k in $keys) {
        try {
            $v = (Get-ItemProperty -LiteralPath $k -ErrorAction Stop).'(default)'
            if ($v) { $v = $v.Trim('"'); if (Test-Path -LiteralPath $v) { return $v } }
        } catch { }
    }
    $cands = @()
    if ($env:ProgramFiles)        { $cands += (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe') }
    if (${env:ProgramFiles(x86)}) { $cands += (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe') }
    $cands += (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    foreach ($c in $cands) { if (Test-Path -LiteralPath $c) { return $c } }
    return $null
}

function HtmlEnc([string]$s) { [System.Net.WebUtility]::HtmlEncode($s) }

function Write-Guide([bool]$isUpdate, [string]$version) {
    $pathH = HtmlEnc $ExtDir
    $css = @'
*{box-sizing:border-box}
body{margin:0;background:#F3EDE4;color:#3A2E22;font-family:"Segoe UI",Arial,"Noto Sans Hebrew",sans-serif;font-size:19px;line-height:1.55}
.wrap{max-width:860px;margin:0 auto;padding:28px 22px 60px}
header{display:flex;align-items:center;gap:18px;margin-bottom:18px}
header img{width:84px;height:84px;border-radius:18px}
h1{margin:0;font-size:34px;color:#B85A45}
.sub{color:#56707A;margin:2px 0 0;font-size:18px}
.card{background:#fff;border-radius:16px;padding:22px 24px;margin:16px 0;box-shadow:0 2px 10px rgba(58,46,34,.08);border-right:6px solid #D4705A}
.step{display:flex;gap:18px;align-items:flex-start}
.num{flex:0 0 52px;height:52px;border-radius:50%;background:#D4705A;color:#fff;font-size:28px;font-weight:700;display:flex;align-items:center;justify-content:center}
.step h2{margin:4px 0 6px;font-size:24px;color:#3A2E22}
.step p{margin:6px 0}
.lbl{display:inline-block;background:#F3EDE4;border:1px solid #d8cbb8;border-radius:8px;padding:1px 10px;font-weight:700;white-space:nowrap}
.en{direction:ltr;unicode-bidi:isolate;font-family:Consolas,"Segoe UI",monospace;color:#56707A}
.pathbox{display:flex;gap:12px;align-items:stretch;margin:12px 0 4px;flex-wrap:wrap}
.path{flex:1 1 420px;direction:ltr;text-align:left;font-family:Consolas,monospace;font-size:22px;font-weight:700;background:#3A2E22;color:#F3EDE4;border-radius:10px;padding:14px 16px;word-break:break-all;user-select:all}
button{font:inherit;font-size:22px;font-weight:700;background:#D4705A;color:#fff;border:0;border-radius:10px;padding:10px 28px;cursor:pointer}
button:hover{background:#B85A45}
.ok{color:#56707A;font-size:16px;min-height:1.4em}
.notes{background:#fff;border-radius:16px;padding:16px 24px;margin-top:22px;border-right:6px solid #56707A}
.notes h3{margin:4px 0 8px;color:#56707A}
.notes li{margin:6px 0}
.big{font-size:22px}
'@
    $copyBlock = @"
<div class="pathbox"><div class="path" id="p">$pathH</div><button id="copy" type="button">העתק</button></div>
<div class="ok" id="ok">הנתיב כבר הועתק בשבילכם - אפשר פשוט להדביק (Ctrl+V).</div>
"@
    if (-not $isUpdate) {
        $title = 'כמעט סיימנו - 3 לחיצות בכרום'
        $sub   = 'הקבצים של סל חכם כבר הותקנו במחשב. נשאר רק לחבר אותם לכרום, פעם אחת.'
        $body = @"
<div class="card step"><div class="num">1</div><div>
<h2>מפעילים &quot;מצב מפתח&quot;</h2>
<p>בלשונית <span class="en">chrome://extensions</span> שנפתחה, בפינה <b>העליונה</b> (בצד שמאל כשכרום בעברית, בצד ימין כשכרום באנגלית) יש מתג בשם
<span class="lbl">מצב מפתח</span> / <span class="lbl en">Developer mode</span>. לוחצים עליו כך שיידלק.</p>
</div></div>
<div class="card step"><div class="num">2</div><div>
<h2>לוחצים על &quot;טען פריט לא ארוז&quot;</h2>
<p>אחרי שהמתג נדלק מופיעה שורת כפתורים. לוחצים על
<span class="lbl">טען פריט לא ארוז</span> / <span class="lbl en">Load unpacked</span>.</p>
</div></div>
<div class="card step"><div class="num">3</div><div>
<h2>מדביקים את הנתיב ובוחרים תיקייה</h2>
<p>בחלון בחירת התיקייה, לוחצים על שורת הכתובת למעלה, מדביקים (Ctrl+V) את הנתיב הזה ולוחצים Enter:</p>
$copyBlock
<p>ואז לוחצים <span class="lbl">בחר תיקייה</span> / <span class="lbl en">Select Folder</span>.</p>
</div></div>
<div class="card step"><div class="num">&#10003;</div><div>
<h2>מצמידים לסרגל</h2>
<p>לוחצים על סמל <b>חלק הפאזל</b> &#129513; (<span class="en">Extensions</span>) ליד שורת הכתובת, ומצמידים &#128204; (<span class="en">Pin</span>) את <b>סל חכם</b> כדי שיהיה תמיד בהישג יד.</p>
</div></div>
"@
    } else {
        $title = 'סל חכם עודכן'
        $sub   = "הגרסה החדשה ($(HtmlEnc $version)) כבר הותקנה באותה תיקייה. ההגדרות שלכם נשמרות."
        $body = @"
<div class="card step"><div class="num">1</div><div>
<h2>לוחצים על &quot;טען מחדש&quot; &#8635;</h2>
<p class="big">בלשונית <span class="en">chrome://extensions</span> שנפתחה, מוצאים את הכרטיס של <b>סל חכם</b> ולוחצים על חץ הטעינה מחדש <b>&#8635;</b> (<span class="en">Reload</span>). זהו!</p>
<p>לא רואים את סל חכם ברשימה? מתקינים כמו בפעם הראשונה: מדליקים <span class="lbl">מצב מפתח</span> / <span class="lbl en">Developer mode</span>,
לוחצים <span class="lbl">טען פריט לא ארוז</span> / <span class="lbl en">Load unpacked</span>, מדביקים את הנתיב ולוחצים <span class="lbl">בחר תיקייה</span> / <span class="lbl en">Select Folder</span>:</p>
$copyBlock
</div></div>
"@
    }
    $html = @"
<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>סל חכם - הוראות התקנה</title>
<style>
$css
</style>
</head>
<body>
<div class="wrap">
<header><img src="logo-256.png" alt="סל חכם"><div><h1>$title</h1><p class="sub">$sub</p></div></header>
$body
<div class="notes"><h3>טוב לדעת</h3><ul>
<li>כרום עשוי להציג הודעה צהובה על &quot;תוספים במצב מפתח&quot; (<span class="en">developer mode extensions</span>). זה <b>רגיל</b> לתוסף שמותקן מחוץ לחנות - אפשר לסגור את ההודעה.</li>
<li><b>אל תמחקו</b> את התיקייה <span class="en">$(HtmlEnc $Root)</span> - כרום טוען ממנה את התוסף בכל הפעלה.</li>
<li>לעדכון בעתיד: מריצים שוב את קובץ ההתקנה ולוחצים &#8635; על סל חכם.</li>
</ul><p class="ok">גרסה: <span class="en">$(HtmlEnc $version)</span></p></div>
</div>
<script>
(function(){
  var btn=document.getElementById('copy'), p=document.getElementById('p'), ok=document.getElementById('ok');
  if(!btn) return;
  function done(){ ok.textContent='הועתק! עכשיו מדביקים עם Ctrl+V.'; btn.textContent='הועתק ✓'; setTimeout(function(){btn.textContent='העתק';},2500); }
  function fallback(){ var t=document.createElement('textarea'); t.value=p.textContent; document.body.appendChild(t); t.select();
    try{ document.execCommand('copy'); done(); }catch(e){ ok.textContent='לא הצלחנו להעתיק - סמנו את הנתיב והעתיקו ידנית (Ctrl+C).'; } document.body.removeChild(t); }
  btn.addEventListener('click', function(){
    if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(p.textContent).then(done, fallback); } else { fallback(); }
  });
})();
</script>
</body>
</html>
"@
    [System.IO.File]::WriteAllText($Guide, $html, (New-Object System.Text.UTF8Encoding($true)))
}

# ---------------------------------------------------------------------------
$tmpBase = Join-Path ([System.IO.Path]::GetTempPath()) ('SalHacham-' + [guid]::NewGuid().ToString('N'))
$swapped = $false
$hadOld  = $false
$rc = 0
try {
    Say 'Step 1/5: preparing folders...'
    New-Item -ItemType Directory -Force -Path $Root | Out-Null
    # recover from an interrupted earlier run
    if (-not (Test-Path -LiteralPath $ExtDir) -and (Test-Path -LiteralPath $OldDir)) { Move-DirRetry $OldDir $ExtDir }
    Remove-Dir $NewDir
    Remove-Dir $OldDir
    $isUpdate = Test-Path -LiteralPath (Join-Path $ExtDir 'manifest.json')

    Say 'Step 2/5: downloading from GitHub...'
    New-Item -ItemType Directory -Force -Path $tmpBase | Out-Null
    $zip = Join-Path $tmpBase 'sal.zip'
    $unz = Join-Path $tmpBase 'unz'
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $ZipUrl -OutFile $zip -UseBasicParsing -TimeoutSec 180
    } catch {
        Fail "ההורדה מ-GitHub נכשלה. בדקו שיש חיבור לאינטרנט ונסו שוב.`n`nפרטים: $($_.Exception.Message)" "download failed: $($_.Exception.Message)"
    }

    Say 'Step 3/5: extracting and verifying...'
    try { Expand-Archive -LiteralPath $zip -DestinationPath $unz -Force }
    catch { Fail "הקובץ שהורד פגום ולא ניתן לפתוח אותו. נסו להריץ שוב את ההתקנה.`n`nפרטים: $($_.Exception.Message)" "extract failed: $($_.Exception.Message)" }

    $src = $null
    foreach ($d in @(Get-ChildItem -LiteralPath $unz -Directory)) {
        $m = Join-Path $d.FullName 'extension\manifest.json'
        if (Test-Path -LiteralPath $m) { $src = Join-Path $d.FullName 'extension'; break }
    }
    if (-not $src) { Fail 'הקובץ שהורד אינו מכיל את התוסף סל חכם (manifest.json חסר). ההתקנה בוטלה.' 'manifest.json not found in archive' }
    try { $man = [System.IO.File]::ReadAllText((Join-Path $src 'manifest.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json }
    catch { Fail 'קובץ ההגדרות של התוסף (manifest.json) פגום. ההתקנה בוטלה.' 'manifest.json is not valid JSON' }
    if ($man.manifest_version -ne 3 -or -not ([string]$man.name).Contains('סל חכם')) {
        Fail 'הקובץ שהורד אינו התוסף סל חכם הצפוי (Manifest V3). ההתקנה בוטלה.' 'manifest check failed (version/name)'
    }
    $version = [string]$man.version

    Say 'Step 4/5: installing files...'
    Copy-Item -LiteralPath $src -Destination $NewDir -Recurse -Force
    if (-not (Test-Path -LiteralPath (Join-Path $NewDir 'manifest.json'))) { Fail 'העתקת הקבצים נכשלה. ההתקנה בוטלה.' 'copy to extension.new failed' }

    if (Test-Path -LiteralPath $ExtDir) { Move-DirRetry $ExtDir $OldDir; $hadOld = $true }
    $swapped = $true
    Move-DirRetry $NewDir $ExtDir

    $logoSrc = Join-Path $src 'icons\logo-256.png'
    if (Test-Path -LiteralPath $logoSrc) { Copy-Item -LiteralPath $logoSrc -Destination $Logo -Force }
    Write-Guide $isUpdate $version
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    [System.IO.File]::WriteAllText($VerFile, "version=$version`r`ninstalled=$stamp`r`nsource=$ZipUrl`r`n", (New-Object System.Text.UTF8Encoding($false)))

    # success: drop the backup
    Remove-Dir $OldDir
    $swapped = $false
    if ($isUpdate) { Say "OK: updated to version $version" } else { Say "OK: installed version $version" }
    Say "Folder: $ExtDir"

    Say 'Step 5/5: opening Chrome...'
    if ($NoLaunch) {
        Say 'NoLaunch: skipping clipboard, Chrome and message box.'
    } else {
        try { Set-Clipboard -Value $ExtDir } catch { }
        $guideUrl = ([System.Uri]$Guide).AbsoluteUri
        $chrome = Find-Chrome
        if ($chrome) {
            Start-Process -FilePath $chrome -ArgumentList @('chrome://extensions', $guideUrl)
            if ($isUpdate) {
                Show-Box "סל חכם עודכן לגרסה $version.`n`nבכרום נפתחו שתי לשוניות: לחצו על ↻ (טעינה מחדש) בכרטיס של סל חכם, לפי ההוראות." 'info'
            } else {
                Show-Box "ההתקנה הושלמה — המשיכו לפי ההוראות שנפתחו בכרום.`n`nנתיב התיקייה כבר הועתק, כך שבשלב בחירת התיקייה פשוט מדביקים (Ctrl+V)." 'info'
            }
        } else {
            Start-Process -FilePath $Guide
            Show-Box "הקבצים הותקנו, אבל לא מצאנו את Google Chrome במחשב.`n`nסל חכם עובד רק בכרום: התקינו את Chrome מ- google.com/chrome ואז המשיכו לפי ההוראות שנפתחו (או הריצו שוב את ההתקנה)." 'info'
        }
    }
} catch {
    $rc = 1
    $err = $_.Exception
    $heb = $err.Data['heb']
    if (-not $heb) { $heb = "אירעה שגיאה בזמן ההתקנה. שום דבר לא השתנה במחשב.`n`nפרטים: $($err.Message)" }
    # roll back to the previous working version
    try {
        Remove-Dir $NewDir
        if ($swapped) {
            if ($hadOld) {
                Remove-Dir $ExtDir
                if (Test-Path -LiteralPath $OldDir) { Move-DirRetry $OldDir $ExtDir }
            } else {
                Remove-Dir $ExtDir
            }
        }
        # first install that failed: leave nothing behind
        if (-not (Test-Path -LiteralPath $ExtDir) -and -not (Test-Path -LiteralPath $OldDir)) {
            if (Test-Path -LiteralPath $Root) {
                $left = @(Get-ChildItem -LiteralPath $Root -Force)
                if ($left.Count -eq 0 -or -not ($left | Where-Object { $_.Name -notin @('guide.html','logo-256.png','version.txt') })) { Remove-Dir $Root }
            }
        }
    } catch {
        $heb += "`n`nשחזור הגרסה הקודמת נכשל: $($_.Exception.Message)"
    }
    Say ('ERROR: ' + $err.Message)
    Show-Box $heb 'error'
} finally {
    try { Remove-Dir $tmpBase } catch { }
}
exit $rc
