param([switch]$Direct)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$profileDir = Join-Path $root 'chrome-profile'
$proxyPort = 7688

function Show-Tip([string]$msg) {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
    [System.Windows.Forms.MessageBox]::Show($msg, 'Gemini 专用环境', 'OK', 'Warning') | Out-Null
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

if (-not (Test-Path $chrome)) {
    Show-Tip "找不到 Chrome：`n$chrome"
    exit 1
}

$chromeArgs = @(
    "--user-data-dir=$profileDir",
    '--profile-directory=Default',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--lang=zh-CN',
    'https://gemini.google.com/app'
)

if (-not $Direct) {
    if (-not (Test-LocalPort $proxyPort)) {
        Show-Tip "Clash 代理 127.0.0.1:$proxyPort 没有启动。`n`n为避免用国内 IP 登录 Google，已取消启动。`n请先打开 Clash Verge；如果确实要直连，请运行：`nlaunch-gemini.ps1 -Direct"
        exit 1
    }

    $chromeArgs = @(
        "--proxy-server=http://127.0.0.1:$proxyPort",
        '--proxy-bypass-list=localhost;127.0.0.1'
    ) + $chromeArgs
}

Start-Process -FilePath $chrome -ArgumentList $chromeArgs