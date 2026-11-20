$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$antigravity = 'D:\Antigravity\Antigravity IDE.exe'
$proxyPort = 7688

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

Write-Host '=== Gemini / Antigravity 专用环境检查 ===' -ForegroundColor Cyan
Write-Host ''

if (Test-Path $chrome) { Write-Host "[OK] Chrome: $chrome" -ForegroundColor Green }
else { Write-Host "[FAIL] 找不到 Chrome: $chrome" -ForegroundColor Red }

if (Test-Path $antigravity) { Write-Host "[OK] Antigravity: $antigravity" -ForegroundColor Green }
else { Write-Host "[FAIL] 找不到 Antigravity: $antigravity" -ForegroundColor Red }

if (Test-Path (Join-Path $root 'chrome-profile\Default\Preferences')) {
    Write-Host "[OK] Chrome 独立配置已存在" -ForegroundColor Green
}
else {
    Write-Host "[WARN] Chrome 独立配置不存在，首次启动会自动创建" -ForegroundColor Yellow
}

if (Test-LocalPort $proxyPort) {
    Write-Host "[OK] Clash 代理 127.0.0.1:$proxyPort 可用" -ForegroundColor Green
    try {
        $json = curl.exe -s -m 15 -x "http://127.0.0.1:$proxyPort" https://ipinfo.io/json | ConvertFrom-Json
        Write-Host ("     出口 IP: {0}  ({1}, {2})" -f $json.ip, $json.city, $json.country) -ForegroundColor Gray
        if ($json.country -eq 'SG') {
            Write-Host '     出口地区与 VPS 一致（新加坡）' -ForegroundColor Green
        }
        else {
            Write-Host '     注意：出口不是新加坡，和 VPS 不一致' -ForegroundColor Yellow
        }
    }
    catch {
        Write-Host '     代理可用，但查询出口 IP 失败' -ForegroundColor Yellow
    }
}
else {
    Write-Host "[FAIL] Clash 代理 127.0.0.1:$proxyPort 不可用，请先启动 Clash Verge" -ForegroundColor Red
}

Write-Host ''
Write-Host '检查完成。' -ForegroundColor Cyan