param([string]$TitleSuffix = 'DeepSeek Harness')
$ErrorActionPreference = 'Stop'

# Diagnostics: append one line per invocation so a click can be confirmed even
# when the handler is started with no console (wscript / hidden powershell).
$logPath = Join-Path $env:USERPROFILE '.dsh\dsh-TaskCompletedNotification-plugin\focus.log'
try {
  $dir = Split-Path -Parent $logPath
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  Add-Content -LiteralPath $logPath -Encoding UTF8 -Value ((Get-Date).ToString('HH:mm:ss.fff') + ' invoked args=[' + ($args -join ' ') + ']')
} catch { }

Add-Type -Namespace DshWinNotify -Name Focus -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetActiveWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
'@

$VK_MENU = 0x12
$KEYEVENTF_KEYUP = 0x0002

# Find the Harness main window. The title is "<session title> — DeepSeek Harness",
# so match on the suffix and require a real top-level window.
$target = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$TitleSuffix*" } |
  Select-Object -First 1
if (-not $target) { Write-Output 'no-window'; exit 3 }

$h = $target.MainWindowHandle
$wasIconic = [DshWinNotify.Focus]::IsIconic($h)
if ($wasIconic) { $null = [DshWinNotify.Focus]::ShowWindow($h, 9) }   # SW_RESTORE

$fg = [DshWinNotify.Focus]::GetForegroundWindow()
$fgPid = 0
$fgThread = [DshWinNotify.Focus]::GetWindowThreadProcessId($fg, [ref]$fgPid)
$myThread = [DshWinNotify.Focus]::GetCurrentThreadId()

$steps = @()
$ok = [DshWinNotify.Focus]::SetForegroundWindow($h)
$steps += "SetForegroundWindow=$ok"

if (-not $ok) {
  # Documented workaround #1: join the foreground thread's input queue, raise,
  # then detach.
  $joined = [DshWinNotify.Focus]::AttachThreadInput($myThread, $fgThread, $true)
  $steps += "AttachThreadInput=$joined"
  $null = [DshWinNotify.Focus]::BringWindowToTop($h) | Out-Null
  $ok = [DshWinNotify.Focus]::SetForegroundWindow($h)
  $steps += "SetForegroundWindow2=$ok"
  $null = [DshWinNotify.Focus]::SetActiveWindow($h) | Out-Null
  $null = [DshWinNotify.Focus]::SetFocus($h) | Out-Null
  $null = [DshWinNotify.Focus]::AttachThreadInput($myThread, $fgThread, $false)
}

if (-not $ok) {
  # Documented workaround #2, and the strongest: hold ALT while raising the
  # window, which makes Windows treat the caller as user-initiated.
  [DshWinNotify.Focus]::keybd_event($VK_MENU, 0, 0, [System.UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  $ok = [DshWinNotify.Focus]::SetForegroundWindow($h)
  $steps += "alt+SetForegroundWindow=$ok"
  Start-Sleep -Milliseconds 40
  [DshWinNotify.Focus]::keybd_event($VK_MENU, 0, $KEYEVENTF_KEYUP, [System.UIntPtr]::Zero)
}

if (-not $ok) {
  # Last resort: minimise then restore, which some shells treat as activation.
  $null = [DshWinNotify.Focus]::ShowWindow($h, 6)   # SW_MINIMIZE
  Start-Sleep -Milliseconds 150
  $null = [DshWinNotify.Focus]::ShowWindow($h, 9)   # SW_RESTORE
  $steps += 'minimize+restore'
}

Start-Sleep -Milliseconds 250
$nowFg = [DshWinNotify.Focus]::GetForegroundWindow()
$nowPid = 0
$null = [DshWinNotify.Focus]::GetWindowThreadProcessId($nowFg, [ref]$nowPid)
$isFg = ($nowFg -eq $h) -or ($nowPid -eq $target.Id)
Write-Output ("result=" + $(if ($isFg) { 'FOREGROUND' } else { 'not-foreground' }) + " wasMinimized=$wasIconic targetPid=$($target.Id) fgPidNow=$nowPid | " + ($steps -join ' '))
exit $(if ($isFg) { 0 } else { 4 })
