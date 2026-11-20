$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class BrightnessWindowProbe {
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(IntPtr cls,string title);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window,uint msg,IntPtr w,IntPtr l);
}
'@
$exe = Join-Path $PSScriptRoot '..\MonitorBrightness.exe'
if (Get-Process MonitorBrightness -ErrorAction SilentlyContinue) { throw 'Exit the existing tray app before testing.' }
$first = Start-Process -FilePath $exe -WindowStyle Normal -PassThru
Start-Sleep -Milliseconds 900
$second = Start-Process -FilePath $exe -WindowStyle Normal -PassThru
if (!$second.WaitForExit(3000)) { throw 'Second instance did not exit.' }
Start-Sleep -Milliseconds 400
$running = @(Get-Process MonitorBrightness)
if ($running.Count -ne 1 -or $running[0].Id -ne $first.Id) { throw 'Single instance check failed.' }
$window = [BrightnessWindowProbe]::FindWindow([IntPtr]::Zero, [string]([char[]]@(0x663e,0x793a,0x5668,0x4eae,0x5ea6) -join ''))
if ($window -eq [IntPtr]::Zero -or ![BrightnessWindowProbe]::IsWindowVisible($window)) { throw 'Existing instance did not open its panel.' }
'PASS deployed EXE reuses original process and opens panel on second launch'
[void][BrightnessWindowProbe]::PostMessage($window, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)
Start-Sleep -Milliseconds 250
if ([BrightnessWindowProbe]::IsWindowVisible($window)) { throw 'Panel close did not collapse it.' }
$first.Refresh()
if ($first.HasExited) { throw 'Closing the panel exited the tray app.' }
'PASS panel close collapses it while keeping tray process alive'
"RUNNING PID=$($first.Id)"
