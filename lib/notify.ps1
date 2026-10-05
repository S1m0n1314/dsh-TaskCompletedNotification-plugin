# dsh-taskcompletednotification-plugin
#
# Windows toast notification helper for the dsh-taskcompletednotification-plugin Harness plugin.
#
# Invocation:
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
#     -File notify.ps1 -Markup <toast.xml> [-AppId <aumid>] [-Result <result.txt>] `
#     [-SkipIfIdleBelowMs <n>]
#
# -Markup is a UTF-8 file holding ready-made toast markup the plugin built:
#   <toast><visual><binding template="ToastText02">
#     <text id="1">title</text><text id="2">body</text>
#   </binding></visual></toast>
#
# Why the markup is built by the plugin and merely loaded here: the obvious
# `GetTemplateContent(...)` + `$xml.CreateElement('text')` recipe is wrong.
# `CreateElement` without a namespace puts the new node in the NULL namespace,
# so appending it to the template's namespaced <text id="1"> yields nested
# malformed markup (`<text id="1"><text>title<text>body</text></text></text>`),
# and Windows then renders only its generic "new notification" header. Verified
# against this machine's WinRT. A plain LoadXml of the same content renders the
# title and body correctly.
#
# ASCII only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 with the
# ANSI code page, so non-ASCII text must arrive through UTF-8 files.
#
# Exit codes: 0 = shown or deliberately skipped, 1 = notification layer failed.

param(
  [Parameter(Mandatory = $true)][string]$Markup,
  [string]$AppId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe',
  [string]$Result = '',
  [string]$SkipIfIdleBelowMs = ''
)

$ErrorActionPreference = 'Stop'

function Write-Result([string]$text) {
  if ([string]::IsNullOrEmpty($Result)) { return }
  try {
    Set-Content -LiteralPath $Result -Value $text -Encoding UTF8 -ErrorAction Stop
  } catch {
    # The result note is best-effort only.
  }
}

try {
  $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
} catch {
  Write-Result ('winrt-unavailable: ' + $_.Exception.Message)
  exit 1
}

# Optional presence gate: the user just touched the keyboard or mouse, so the
# text answer is already on screen and a toast would only be noise.
if ($SkipIfIdleBelowMs -ne '') {
  $threshold = 0
  if ([int]::TryParse($SkipIfIdleBelowMs, [ref]$threshold) -and $threshold -gt 0) {
    try {
      if (-not ('DshWinNotify.Idle' -as [type])) {
        Add-Type -Namespace DshWinNotify -Name Idle -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)]
public struct LASTINPUTINFO {
  public uint cbSize;
  public uint dwTime;
}

[DllImport("user32.dll")]
private static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

public static uint IdleMilliseconds() {
  LASTINPUTINFO info = new LASTINPUTINFO();
  info.cbSize = (uint)System.Runtime.InteropServices.Marshal.SizeOf(typeof(LASTINPUTINFO));
  if (!GetLastInputInfo(ref info)) return uint.MaxValue;
  return unchecked((uint)Environment.TickCount - info.dwTime);
}
'@
      }
      if ([DshWinNotify.Idle]::IdleMilliseconds() -lt [uint32]$threshold) {
        Write-Result 'skipped-user-active'
        exit 0
      }
    } catch {
      # The idle gate is an optimisation; never let it block a notification.
      Write-Result ('idle-gate-failed: ' + $_.Exception.Message)
    }
  }
}

try {
  $text = Get-Content -LiteralPath $Markup -Raw -Encoding UTF8
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml($text)
  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
  # A fresh tag per toast keeps Windows from collapsing repeated reminders into
  # one grouped entry.
  $toast.Tag = 'dsh' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
  # An explicit AppUserModelID is required: the parameterless overload throws
  # 0x80070490 ("element not found") under Windows PowerShell 5.1.
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($toast)
  Write-Result 'shown'
  exit 0
} catch {
  Write-Result ('show-failed: ' + $_.Exception.Message)
  exit 1
}
