<#
    Project Kavach — start the backend.

    No Docker, no Postgres, no external dependencies. The Go services use the
    standard library only and a file-backed store, which is what lets this run on
    any machine with a Go toolchain.

    Ports:
      8081  sos-ingest      ★ the critical binary. Its own process, its own
                              lifecycle. When the control plane breaks — and it
                              will — SOS keeps working (ADR-002).
      8080  control-plane     family, incidents, consent, policy, drills
      8082  realtime-gw       WebSocket, presence, priority backpressure
      9090  canary            ★ fires a REAL incident every 15 min through the
                              REAL handler. The only page-worthy alert (§16.2).

    Usage:  pwsh ops/run-backend.ps1            start everything
            pwsh ops/run-backend.ps1 -Stop      stop everything
            pwsh ops/run-backend.ps1 -Build     build only
#>
param(
    [switch]$Stop,
    [switch]$Build,
    [string]$DataDir = "$PSScriptRoot\..\data"
)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path "$PSScriptRoot\.."
$backend = Join-Path $root 'backend'
$binDir = Join-Path $root 'bin'

# Go is commonly installed outside PATH for the current session.
foreach ($p in @('C:\Program Files\Go\bin', "$env:LOCALAPPDATA\Programs\Go\bin")) {
    if ((Test-Path $p) -and ($env:Path -notlike "*$p*")) { $env:Path = "$p;$env:Path" }
}

if ($Stop) {
    Get-Process -Name 'sos-ingest', 'control-plane', 'realtime-gw', 'canary' -ErrorAction SilentlyContinue |
        Stop-Process -Force
    Write-Host 'Kavach backend stopped.' -ForegroundColor Yellow
    return
}

try { $null = (Get-Command go -ErrorAction Stop) } catch {
    Write-Host 'Go is not installed or not on PATH.' -ForegroundColor Red
    Write-Host 'Install with:  winget install GoLang.Go' -ForegroundColor Yellow
    exit 1
}

New-Item -ItemType Directory -Force -Path $binDir, $DataDir | Out-Null

Write-Host 'Building Kavach services...' -ForegroundColor Cyan
Push-Location $backend
try {
    go build -o (Join-Path $binDir 'sos-ingest.exe')    ./cmd/sos-ingest
    go build -o (Join-Path $binDir 'control-plane.exe') ./cmd/control-plane
    go build -o (Join-Path $binDir 'realtime-gw.exe')   ./cmd/realtime-gw
    go build -o (Join-Path $binDir 'canary.exe')        ./cmd/canary
} finally { Pop-Location }
Write-Host 'Build OK.' -ForegroundColor Green

if ($Build) { return }

# Start sos-ingest FIRST and everything else after. If the safety path is not up,
# nothing else matters.
$procs = @(
    @{ Name = 'sos-ingest';    Port = 8081 },
    @{ Name = 'control-plane'; Port = 8080 },
    @{ Name = 'realtime-gw';   Port = 8082 },
    @{ Name = 'canary';        Port = 9090 }
)

foreach ($p in $procs) {
    $exe = Join-Path $binDir "$($p.Name).exe"
    $log = Join-Path $DataDir "$($p.Name).log"
    Start-Process -FilePath $exe `
        -ArgumentList @('-addr', ":$($p.Port)", '-data', $DataDir) `
        -RedirectStandardOutput $log `
        -RedirectStandardError "$log.err" `
        -WindowStyle Hidden
    Write-Host ("  {0,-14} :{1}   log: {2}" -f $p.Name, $p.Port, $log) -ForegroundColor Gray
}

Start-Sleep -Seconds 2
Write-Host ''
Write-Host 'Kavach backend running.' -ForegroundColor Green
Write-Host ''
Write-Host '  Health:   curl http://localhost:8081/healthz'
Write-Host '  Metrics:  curl http://localhost:9090/metrics'
Write-Host '  Active:   curl http://localhost:8080/internal/active-incidents'
Write-Host ''
Write-Host 'Point the app at this machine by setting extra.apiBase in mobile/app.json'
Write-Host 'to your LAN IP (not localhost — the phone is a different device).'
Write-Host ''
Write-Host 'Stop with:  pwsh ops/run-backend.ps1 -Stop' -ForegroundColor Yellow
