param([switch]$Direct)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = 'D:\Antigravity\Antigravity IDE.exe'
$dataDir = Join-Path $root 'antigravity-data'
$extDir = Join-Path $root 'antigravity-extensions'
$proxyPort = 7688

function Show-Tip([string]$msg) {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
    [System.Windows.Forms.MessageBox]::Show($msg, 'Antigravity 专用环境', 'OK', 'Warning') | Out-Null
}

function Test-LocalPort([int]$port) {
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $client.Connect('127.0.0.1', $port)
        $client.Close()
        return $true
    }
    catch {
        return $false
    }
}

if (-not (Test-Path $exe)) {
    Show-Tip "找不到 Antigravity：`n$exe"
    exit 1
}

New-Item -ItemType Directory -Force -Path $dataDir, $extDir | Out-Null

$appArgs = @(
    "--user-data-dir=$dataDir",
    "--extensions-dir=$extDir"
)

if (-not $Direct) {
    if (-not (Test-LocalPort $proxyPort)) {
        Show-Tip "Clash 代理 127.0.0.1:$proxyPort 没有启动。`n`n为避免用国内 IP 登录 Google，已取消启动。`n请先打开 Clash Verge；如果确实要直连，请运行：`nlaunch-antigravity.ps1 -Direct"
        exit 1
    }

    $appArgs += "--proxy-server=http://127.0.0.1:$proxyPort"
    $env:HTTP_PROXY = "http://127.0.0.1:$proxyPort"
    $env:HTTPS_PROXY = "http://127.0.0.1:$proxyPort"
    $env:NO_PROXY = 'localhost,127.0.0.1'
}

Start-Process -FilePath $exe -ArgumentList $appArgs -WorkingDirectory (Split-Path $exe)