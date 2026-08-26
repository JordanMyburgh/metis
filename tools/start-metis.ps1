# start-metis.ps1 - bring Metis up at login: server first, then the app as the backdrop.
#
# Two jobs, in the order that matters:
#   1. make sure something is listening on 8780   - the app is a blank page without it
#   2. open the installed PWA, maximised, and drop it to the BOTTOM of the z-order
#
# Job 2's second half is the part that makes it a background rather than just another
# window: SetWindowPos(HWND_BOTTOM) puts Metis behind everything without minimising it,
# so it keeps rendering and keeps following the session, and anything opened afterwards
# lands in front of it. Alt-Tab still reaches it.
#
# Launched at login by the .vbs in the Startup folder (same pattern as the gitnexus and
# aether2 launchers already on this machine). Safe to run by hand at any time: it never
# starts a second server, and re-running it just re-fronts/re-backs the window.
#
#   powershell -ExecutionPolicy Bypass -File tools\start-metis.ps1 [-Front] [-NoApp] [-Fullscreen]
[CmdletBinding()]
param(
  [int]$Port = 8780,
  [switch]$Front,        # leave the window in front instead of sending it to the back
  [switch]$Fullscreen,   # F11-style, no title bar at all
  [switch]$NoApp,        # start the server only
  [int]$TimeoutSec = 25
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$AppId = 'cimaoblhhdgienpiglgamgpgdgmcdpek'
$Brave = Join-Path $env:LOCALAPPDATA 'BraveSoftware\Brave-Browser\Application\brave.exe'
$LogDir = Join-Path $Root 'logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$Log = Join-Path $LogDir 'startup.log'

function Write-Log([string]$m) {
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  Add-Content -Path $Log -Value $line -Encoding utf8
}

# A TCP connect is the only honest "is it up" check - a stale PID file lies.
function Test-Metis([int]$ms = 400) {
  $c = New-Object Net.Sockets.TcpClient
  try {
    $iar = $c.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne($ms, $false)) { return $false }
    $c.EndConnect($iar); return $true
  } catch { return $false } finally { $c.Close() }
}

Write-Log "start-metis: begin (port $Port)"

# ---------------------------------------------------------------- 1. the server
if (Test-Metis) {
  Write-Log 'server already listening, leaving it alone'
} else {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
  if (-not (Test-Path $node)) { Write-Log "FATAL: node not found at $node"; exit 1 }
  # Detached on purpose. Start-Process left node in the launching shell's console
  # group, so the CTRL_C/CTRL_CLOSE fired when that shell went away (a Claude Code
  # hook ending, a terminal closing) arrived at node as SIGINT - and server.mjs's
  # SIGINT handler shut down cleanly. That is exactly how it died on 2026-08-24
  # 09:32: exit 0, empty server.err.log, caches flushed at the same minute.
  # Win32_Process.Create reparents the server to WmiPrvSE, which shares no console,
  # so no console-control event can reach it and it outlives whatever started it.
  $outLog = Join-Path $LogDir 'server.out.log'
  $errLog = Join-Path $LogDir 'server.err.log'
  $srv    = Join-Path $Root 'server.mjs'
  $cmd    = 'cmd.exe /c ""{0}" "{1}" >> "{2}" 2>> "{3}""' -f $node, $srv, $outLog, $errLog
  $spawn  = ([wmiclass]'win32_process').Create($cmd, $Root)
  if ($spawn.ReturnValue -ne 0) { Write-Log "FATAL: spawn failed (WMI code $($spawn.ReturnValue))"; exit 1 }
  Write-Log "server spawned detached (pid $($spawn.ProcessId)), waiting for the port"
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while (-not (Test-Metis) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
  if (Test-Metis) { Write-Log 'server is up' }
  else { Write-Log "FATAL: server did not bind $Port within ${TimeoutSec}s"; exit 1 }
}

if ($NoApp) { Write-Log 'NoApp set, done'; exit 0 }

# ---------------------------------------------------------------- 2. the app window
if (-not (Test-Path $Brave)) { Write-Log "brave.exe not found at $Brave - server is up, app not opened"; exit 0 }

$braveArgs = @("--profile-directory=Default", "--app-id=$AppId")
if ($Fullscreen) { $braveArgs += '--start-fullscreen' } else { $braveArgs += '--start-maximized' }
Start-Process -FilePath $Brave -ArgumentList $braveArgs | Out-Null
Write-Log ("app launched ({0})" -f ($(if ($Fullscreen) { 'fullscreen' } else { 'maximised' })))

# Chromium honours --start-maximized inconsistently for --app-id launches, and it has
# no flag at all for "open behind everything". So the window is placed explicitly once
# it exists, which also means this works the same whichever browser installed the PWA.
Add-Type -Namespace MetisWin -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
[DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
'@

$SW_MAXIMIZE = 3
$HWND_BOTTOM = [IntPtr]1
$SWP_NOMOVE = 0x0002; $SWP_NOSIZE = 0x0001; $SWP_NOACTIVATE = 0x0010

# The PWA window carries the app's own title, so match on that rather than on the
# process - Brave's other windows are the same executable.
$hwnd = [IntPtr]::Zero
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
  $p = Get-Process -Name brave -ErrorAction SilentlyContinue |
       Where-Object { $_.MainWindowTitle -like 'Metis*' } | Select-Object -First 1
  if ($p) { $hwnd = $p.MainWindowHandle; break }
  Start-Sleep -Milliseconds 400
}

if ($hwnd -eq [IntPtr]::Zero) {
  Write-Log 'app window never appeared - it may still be loading; nothing placed'
  exit 0
}

# One ShowWindow call is not enough. The handle becomes visible to Get-Process before
# Brave has finished applying its own remembered bounds, so a maximise issued at that
# moment is silently overwritten a beat later - measured, not guessed: the first version
# of this script logged success and left a 1827x1398 window on a 2560x1440 screen.
# So: maximise, CHECK with IsZoomed, and repeat until it sticks.
if (-not $Fullscreen) {
  $placed = $false
  $stop = (Get-Date).AddSeconds(8)
  while ((Get-Date) -lt $stop) {
    [MetisWin.U]::ShowWindow($hwnd, $SW_MAXIMIZE) | Out-Null
    Start-Sleep -Milliseconds 250
    if ([MetisWin.U]::IsZoomed($hwnd)) { $placed = $true; break }
  }
  if ($placed) { Write-Log 'window maximised (verified)' }
  else { Write-Log 'WARN: window would not stay maximised within 8s' }
}

# Z-order goes LAST, so the maximise cannot knock it back to the front.
if (-not $Front) {
  [MetisWin.U]::SetWindowPos($hwnd, $HWND_BOTTOM, 0, 0, 0, 0, $SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOACTIVATE) | Out-Null
  Write-Log 'window sent to the back'
} else {
  Write-Log 'window left in front (-Front)'
}
exit 0
