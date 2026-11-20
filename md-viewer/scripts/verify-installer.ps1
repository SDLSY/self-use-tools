param([string]$Installer = (Join-Path $PSScriptRoot '..\release\MoYue-Setup-1.0.0-x64.exe'))
$ErrorActionPreference = 'Stop'
$existingAssociation = Test-Path 'HKCU:\Software\Classes\MoYue.Markdown\shell\open\command'
$existingChoice = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\UserChoice' -ErrorAction SilentlyContinue
$existingMarkdownChoice = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.markdown\UserChoice' -ErrorAction SilentlyContinue
$expectedState = if ($existingAssociation -or $existingChoice.ProgId -eq 'MoYue.Markdown' -or $existingMarkdownChoice.ProgId -eq 'MoYue.Markdown') { 1 } else { 0 }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class InstallerNative {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr wparam, IntPtr lparam, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
}
'@
function Get-InstallerWindow {
  $all = [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)
  foreach ($element in $all) { if ($element.Current.Name -like '墨阅 安装*') { return $element } }
}
function Get-Controls($window) {
  return $window.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
}
function Invoke-Next($window) {
  $next = Get-Controls $window | Where-Object { $_.Current.AutomationId -eq '1' } | Select-Object -First 1
  [InstallerNative]::PostMessage([IntPtr]$window.Current.NativeWindowHandle, 0x111, [IntPtr]1, [IntPtr]$next.Current.NativeWindowHandle) | Out-Null
}
function Set-Check($control, [int]$value) {
  $result = [IntPtr]::Zero
  [InstallerNative]::SendMessageTimeout([IntPtr]$control.Current.NativeWindowHandle, 0xF1, [IntPtr]$value, [IntPtr]::Zero, 2, 1000, [ref]$result) | Out-Null
}
$window = Get-InstallerWindow
if (!$window) { $process = Start-Process -FilePath $Installer -PassThru }
for ($i = 0; $i -lt 30 -and !$window; $i++) { Start-Sleep -Milliseconds 200; $window = Get-InstallerWindow }
if (!$window) { throw 'Installer window did not appear.' }
$checkbox = $null
for ($i = 0; $i -lt 6; $i++) {
  $checkbox = Get-Controls $window | Where-Object { $_.Current.Name -eq '关联 .md 和 .markdown 文件' } | Select-Object -First 1
  if ($checkbox) { break }
  Invoke-Next $window
  Start-Sleep -Milliseconds 400
}
if (!$checkbox) { throw 'Association page not found.' }
$state = [IntPtr]::Zero
[InstallerNative]::SendMessageTimeout([IntPtr]$checkbox.Current.NativeWindowHandle, 0xF0, [IntPtr]::Zero, [IntPtr]::Zero, 2, 1000, [ref]$state) | Out-Null
if ($state.ToInt32() -ne $expectedState) { throw 'Association page did not preserve the previous association state.' }
$rect = $window.Current.BoundingRectangle
$bitmap = New-Object Drawing.Bitmap ([int]$rect.Width), ([int]$rect.Height)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$dc = $graphics.GetHdc()
try { [InstallerNative]::PrintWindow([IntPtr]$window.Current.NativeWindowHandle, $dc, 2) | Out-Null }
finally { $graphics.ReleaseHdc($dc) }
$bitmap.Save((Join-Path $PSScriptRoot '..\test-results\installer-associations.png'))
$graphics.Dispose(); $bitmap.Dispose()
Set-Check $checkbox 1
Invoke-Next $window
$completed = $false
for ($i = 0; $i -lt 100; $i++) {
  Start-Sleep -Milliseconds 250
  $controls = Get-Controls $window
  $finish = $controls | Where-Object { $_.Current.AutomationId -eq '1' -and $_.Current.Name -like '*完成*' } | Select-Object -First 1
  if ($finish) {
    $run = $controls | Where-Object { $_.Current.Name -like '运行 墨阅*' } | Select-Object -First 1
    if ($run) { Set-Check $run 0 }
    Invoke-Next $window
    $completed = $true
    break
  }
}
if (!$completed) { throw 'Installer did not complete.' }
$command = (Get-Item 'HKCU:\Software\Classes\MoYue.Markdown\shell\open\command').GetValue('')
if ($command -notmatch '^".+\\墨阅\.exe" "%1"$') { throw "Invalid association command: $command" }
foreach ($extension in '.md', '.markdown') {
  $key = Get-Item "HKCU:\Software\Classes\$extension\OpenWithProgids"
  if ('MoYue.Markdown' -notin $key.GetValueNames()) { throw "Missing $extension registration." }
}
@{ checks = @('GUI association checkbox respects previous state', 'GUI installation with association enabled', 'Quoted executable and file path in command', '.md and .markdown OpenWith registration'); command = $command } | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $PSScriptRoot '..\test-results\installer-report.json')
Write-Output 'PASS: GUI association page, selected installation, both extensions and quoted command.'
