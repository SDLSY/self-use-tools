param([string]$Samples = (Join-Path $PSScriptRoot '..\samples'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class MarkdownShell {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct ExecuteInfo {
    public int cbSize; public uint fMask; public IntPtr hwnd;
    public string lpVerb; public string lpFile; public string lpParameters; public string lpDirectory;
    public int nShow; public IntPtr hInstApp; public IntPtr lpIDList; public string lpClass;
    public IntPtr hkeyClass; public uint dwHotKey; public IntPtr hIcon; public IntPtr hProcess;
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool ShellExecuteEx(ref ExecuteInfo info);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wparam, IntPtr lparam);
  public static void Open(string file) {
    var info = new ExecuteInfo { cbSize = Marshal.SizeOf<ExecuteInfo>(), fMask = 1 | 0x400, lpVerb = "open", lpFile = file, lpClass = "MoYue.Markdown", nShow = 1 };
    if (!ShellExecuteEx(ref info)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  }
}
'@
function Get-ReaderWindows {
  $all = [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)
  return @($all | Where-Object { $_.Current.Name -like '* — 墨阅' })
}
function Wait-Title([string]$title) {
  for ($i = 0; $i -lt 60; $i++) {
    $windows = @(Get-ReaderWindows)
    if ($windows.Count -eq 1 -and $windows[0].Current.Name -eq $title) { return $windows[0] }
    Start-Sleep -Milliseconds 200
  }
  throw "Expected one reader window titled $title"
}
if (@(Get-ReaderWindows).Count -ne 0) { throw 'Close existing reading windows before this isolated shell test.' }
# Specify the registered ProgID, as Windows does after the user chooses this application.
# This exercises ShellExecute without changing the user's protected default-app selection.
[MarkdownShell]::Open((Resolve-Path (Join-Path $Samples '阅读示例.md')).Path)
$first = Wait-Title '阅读示例.md — 墨阅'
$pidFirst = $first.Current.ProcessId
$handleFirst = $first.Current.NativeWindowHandle
[MarkdownShell]::Open((Resolve-Path (Join-Path $Samples '中文 空格\另一篇.markdown')).Path)
$second = Wait-Title '另一篇.markdown — 墨阅'
if ($second.Current.ProcessId -ne $pidFirst -or $second.Current.NativeWindowHandle -ne $handleFirst) { throw 'Shell-open created a second instance.' }
[MarkdownShell]::Open((Resolve-Path (Join-Path $Samples '阅读示例.md')).Path)
$third = Wait-Title '阅读示例.md — 墨阅'
[MarkdownShell]::PostMessage([IntPtr]$third.Current.NativeWindowHandle, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
@{ checks = @('Cold start via registered Windows ShellExecute ProgID', 'Warm .markdown open reuses process and window', 'Reopen .md activates existing document'); process = $pidFirst; userDefaultChanged = $false; limitation = 'Uses explicit registered ProgID; Windows default-app confirmation is left to the user.' } | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $PSScriptRoot '..\test-results\shell-report.json')
Write-Output 'PASS: Windows shell-open cold start, warm open and reuse; defaults unchanged.'
