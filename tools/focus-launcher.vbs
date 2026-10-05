' dsh-win-notify launcher (no console window).
'
' Windows starts this through the HKCU protocol registration
'   HKCU\Software\Classes\dsh-win-notify\shell\open\command
' when the user clicks a notification banner. It resolves the plugin's own
' lib\focus-window.ps1 through the registered AppUserModelId key and runs it
' hidden, so clicking a toast raises the DeepSeek Harness window instead of
' flashing a console.
Option Explicit

Dim appId, key, libDir, script, shell, fso, qt
appId = "DeepSeek.Harness.Notify"
qt = Chr(34)

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

On Error Resume Next
key = "HKCU\Software\Classes\AppUserModelId\" & appId
libDir = shell.RegRead(key & "\DshWinNotifyLibDir")
On Error GoTo 0

If libDir = "" Or Not fso.FileExists(libDir & "\focus-window.ps1") Then
  WScript.Quit 3
End If

script = libDir & "\focus-window.ps1"
shell.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File " & qt & script & qt, 0, False
