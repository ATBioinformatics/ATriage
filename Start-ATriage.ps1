param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
Set-Location -LiteralPath $projectRoot
if (Test-Path -LiteralPath (Join-Path $projectRoot '.env')) {
    foreach ($line in Get-Content -LiteralPath (Join-Path $projectRoot '.env')) {
        if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=(.*)$') {
            [Environment]::SetEnvironmentVariable($matches[1], $matches[2].Trim().Trim('"').Trim("'"), 'Process')
        }
    }
}
$bindAddress = if ($env:ADDR) { $env:ADDR } else { '127.0.0.1:8091' }
$port = [int]($bindAddress.Split(':')[-1])
$siteUrl = "http://127.0.0.1:$port"
function Open-ATriage([object]$health) {
    # The version query makes a browser request a fresh HTML entry point. The
    # hashed assets referenced by it can still use their normal cache safely.
    $version = if ($health.version) { [string]$health.version } else { 'current' }
    Start-Process "$siteUrl/?v=$version"
}
$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    try {
        $health = Invoke-RestMethod -Uri "$siteUrl/api/health" -TimeoutSec 3
        if ($health.app -ne 'ATriage') { throw 'Another service is using this port.' }
        if (!$NoBrowser) { Open-ATriage $health }
        Write-Host "ATriage is already running: $siteUrl (version $($health.version))"
        exit 0
    } catch {
        throw "Port $port is occupied. Change ADDR in .env or stop the other service."
    }
}
Push-Location (Join-Path $projectRoot 'frontend')
try {
    if (!(Test-Path 'node_modules')) {
        npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed.' }
    }
    npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
} finally { Pop-Location }
Push-Location (Join-Path $projectRoot 'backend')
try {
    go build -buildvcs=false -o atriage.exe .
    if ($LASTEXITCODE -ne 0) { throw 'Backend build failed.' }
    $server = Start-Process -FilePath (Join-Path $projectRoot 'backend\atriage.exe') -WorkingDirectory (Join-Path $projectRoot 'backend') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $projectRoot 'backend\server.log') -RedirectStandardError (Join-Path $projectRoot 'backend\server-error.log') -PassThru
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 500
        if ($server.HasExited) { throw 'Server exited. See backend/server-error.log.' }
        try { $health = Invoke-RestMethod -Uri "$siteUrl/api/health" -TimeoutSec 1 } catch { continue }
        if ($health.app -eq 'ATriage') { if (!$NoBrowser) { Open-ATriage $health }; Write-Host "ATriage is ready: $siteUrl (version $($health.version), PID $($server.Id))"; exit 0 }
    }
    throw 'Server did not become ready. See backend/server-error.log.'
} finally { Pop-Location }
