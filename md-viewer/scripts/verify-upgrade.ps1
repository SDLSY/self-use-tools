param(
  [string]$Installer = (Join-Path $PSScriptRoot '..\release\MoYue-Setup-1.0.2-x64.exe'),
  [string]$ReopenDocument
)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public class UpgradeAssociation {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd,uint message,IntPtr w,IntPtr l);
  [DllImport("shlwapi.dll",CharSet=CharSet.Unicode)] public static extern uint AssocQueryString(uint flags,uint str,string extension,string extra,StringBuilder buffer,ref uint length);
}
'@
$exe = Join-Path $env:LOCALAPPDATA 'Programs\local-md-viewer\墨阅.exe'
$choiceKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\UserChoice'
$before = Get-ItemProperty $choiceKey
if ($before.ProgId -ne 'MoYue.Markdown') { throw 'Select MoYue as default before running this upgrade regression.' }
$windows = @(Get-Process | Where-Object { $_.Path -eq $exe -and $_.MainWindowHandle -ne 0 })
foreach ($window in $windows) {
  [UpgradeAssociation]::PostMessage($window.MainWindowHandle,0x10,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null
  if (!$window.WaitForExit(10000)) { throw 'Reader did not close.' }
}
$results = @()
try {
  # First upgrade exercises the previous installer's cleanup; the second uses
  # the newly fixed uninstaller and checks that a normal future upgrade is safe.
  foreach ($round in @(1,2)) {
    $process = Start-Process -FilePath $Installer -ArgumentList '/S' -PassThru -Wait
    if ($process.ExitCode -ne 0) { throw "Upgrade failed: $($process.ExitCode)" }
    $after = Get-ItemProperty $choiceKey
    if ($after.ProgId -ne $before.ProgId -or $after.Hash -ne $before.Hash) { throw 'Windows default selection changed.' }
    $command = (Get-Item 'HKCU:\Software\Classes\MoYue.Markdown\shell\open\command').GetValue('')
    if ($command -ne ('"' + $exe + '" "%1"')) { throw "Association command missing or wrong: $command" }
    $buffer = New-Object Text.StringBuilder 2048
    $length = [uint32]2048
    $status = [UpgradeAssociation]::AssocQueryString(0,2,'.md','open',$buffer,[ref]$length)
    if ($status -ne 0 -or $buffer.ToString() -ne $exe) { throw 'Windows resolved another default app after upgrade.' }
    $results += @{ round=$round; defaultExecutable=$buffer.ToString(); selectionPreserved=$true; version=(Get-Item -LiteralPath $exe).VersionInfo.ProductVersion }
  }
  $results | ConvertTo-Json -Depth 3 | Set-Content -Encoding UTF8 (Join-Path $PSScriptRoot '..\test-results\upgrade-report.json')
  Write-Output 'PASS: two real silent upgrades preserved the Windows choice and effective .md opener.'
} finally {
  if ($ReopenDocument) { Start-Process -FilePath $ReopenDocument }
}
