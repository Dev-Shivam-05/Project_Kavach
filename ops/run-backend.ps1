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
#
# ★ Each binary takes ITS OWN flags. Until 6 Sep this loop passed `-addr`/`-data`
# to all four; Go's flag package exits 2 on a flag it does not define, so
# realtime-gw (no -data) and canary (no -addr, no -data) died at once with the
# failure only in their .log.err, while this script printed "running" (RISK 13).
# The lines below are the arguments ops/README.md §1 documents and the layout
# ops/docker-compose.yml sets through the environment:
#
#   sos-ingest     owns <data>/sos.wal, <data>/bus and <data>/store
#   control-plane  its OWN store under <data>/control-plane — the two binaries
#                  never share a store directory (D-028) — and reads <data>/bus
#   realtime-gw    reads <data>/bus
#   canary         reads <data>/bus; probes the control plane, not sos-ingest
#
# Ports are passed explicitly because two of the binaries' own defaults disagree
# with this table (ops/README.md §5).
$DataDir = (Resolve-Path $DataDir).Path
$busDir = Join-Path $DataDir 'bus'
$cpBase = 'http://127.0.0.1:8080'
# The compose file names the seam through KAVACH_BUS_DIR; the -bus flags below
# say the same thing, so a binary started by hand from this shell agrees too.
$env:KAVACH_BUS_DIR = $busDir

$procs = @(
    @{ Name = 'sos-ingest';    Port = 8081; Args = @('-addr', ':8081', '-data', $DataDir) },
    @{ Name = 'control-plane'; Port = 8080; Args = @('-addr', ':8080', '-data', (Join-Path $DataDir 'control-plane'), '-bus', $busDir) },
    @{ Name = 'realtime-gw';   Port = 8082; Args = @('-addr', ':8082', '-bus', $busDir) },
    @{ Name = 'canary';        Port = 9090; Args = @('-metrics', ':9090', '-bus', $busDir, '-api', $cpBase) }
)

foreach ($p in $procs) {
    $exe = Join-Path $binDir "$($p.Name).exe"
    $log = Join-Path $DataDir "$($p.Name).log"
    Start-Process -FilePath $exe `
        -ArgumentList $p.Args `
        -RedirectStandardOutput $log `
        -RedirectStandardError "$log.err" `
        -WindowStyle Hidden
    Write-Host ("  {0,-14} :{1}   log: {2}" -f $p.Name, $p.Port, $log) -ForegroundColor Gray
}

Start-Sleep -Seconds 2

# "Running" means all four processes are still alive, not that four were
# launched. A binary that rejected its flags is already gone by now, and its
# reason is in <name>.log.err — say so instead of printing a green line.
$dead = @($procs | Where-Object { -not (Get-Process -Name $_.Name -ErrorAction SilentlyContinue) })
if ($dead.Count -gt 0) {
    Write-Host ''
    foreach ($p in $dead) {
        Write-Host ("  {0} exited. See {1}.log.err" -f $p.Name, (Join-Path $DataDir $p.Name)) -ForegroundColor Red
    }
    Write-Host 'Kavach backend is NOT fully up.' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host 'Kavach backend running.' -ForegroundColor Green
Write-Host ''
Write-Host '  Health:   curl http://localhost:8081/healthz     (sos-ingest - the one that matters)'
Write-Host '            curl http://localhost:8080/readyz      (control-plane)'
Write-Host '            curl http://localhost:8082/healthz     (realtime-gw)'
Write-Host '            curl http://localhost:9090/healthz     (canary: last probe result)'
Write-Host '  Metrics:  curl http://localhost:9090/metrics'
Write-Host '  Active:   curl http://localhost:8080/internal/active-incidents'
Write-Host ''
Write-Host 'Point a phone at this machine: ops/README.md section 4 (LAN IP, not localhost;'
Write-Host 'a physical handset cannot reach 10.0.2.2, that is the emulator alias).'
Write-Host ''
Write-Host 'Stop with:  pwsh ops/run-backend.ps1 -Stop' -ForegroundColor Yellow
