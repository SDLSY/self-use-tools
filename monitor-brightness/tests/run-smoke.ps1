$ErrorActionPreference = 'Stop'
if (Get-Process MonitorBrightness -ErrorAction SilentlyContinue) { throw 'Exit MonitorBrightness from its tray menu before running this hardware test.' }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
& $compiler /nologo /target:exe /main:Smoke /codepage:65001 /r:System.dll /r:System.Core.dll /r:System.Management.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll "/win32manifest:$PSScriptRoot\..\src\app.manifest" "/out:$PSScriptRoot\Smoke.exe" "$PSScriptRoot\..\src\MonitorControl.cs" "$PSScriptRoot\..\src\Program.cs" "$PSScriptRoot\Smoke.cs"
if ($LASTEXITCODE -ne 0) { throw 'Test build failed.' }
& "$PSScriptRoot\Smoke.exe"
exit $LASTEXITCODE
