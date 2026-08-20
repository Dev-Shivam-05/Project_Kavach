# Kavach — Operations

Everything needed to run the backend and point a real phone at it.

Two ways to run it. They are equivalent; pick the one that matches what you
have installed.

| | `docker-compose.yml` | `run-backend.ps1` |
|---|---|---|
| Needs | Docker Compose **v2.17+** (`dockerfile_inline`) | A Go **1.26+** toolchain |
| Isolation | Four containers, one named volume | Four processes, one directory |
| Survives reboot | `restart: unless-stopped` | No |

There is no Postgres, no Redis, no NATS and no cloud account anywhere in this
stack. The Go module is standard-library only — `backend/go.mod` has zero
`require` lines — and the store, the WALs and the message bus are all files.
That is what lets the whole thing come up on a laptop with one command, and it
is also why the on-disk layout below is worth understanding.

---

## 1. Run it

### With Docker

```bash
docker compose -f ops/docker-compose.yml up --build -d
docker compose -f ops/docker-compose.yml ps          # health of all four
docker compose -f ops/docker-compose.yml logs -f canary
docker compose -f ops/docker-compose.yml down        # stop, KEEP the data
docker compose -f ops/docker-compose.yml down -v     # stop and WIPE the data
```

The first build compiles four Go binaries from source and takes a couple of
minutes. Afterwards the layer cache makes it seconds.

### Without Docker

```powershell
pwsh ops/run-backend.ps1 -Build   # build the four binaries into ./bin
pwsh ops/run-backend.ps1 -Stop    # stop whatever is running
```

> **Known gap in `run-backend.ps1`.** Its start path passes `-addr` and `-data`
> to all four binaries, but `realtime-gw` and `canary` define neither `-data`
> (they take `-bus`) and `canary` defines no `-addr` (it takes `-metrics`).
> Both exit immediately with `flag provided but not defined`. Until the script
> is fixed, use `-Build` and start them by hand — the env vars below are the
> same ones the compose file sets, so the two paths stay in agreement:

```powershell
$env:KAVACH_BUS_DIR = "$PWD\data\bus"
Start-Process bin\sos-ingest.exe    "-addr :8081 -data $PWD\data"
Start-Process bin\control-plane.exe "-addr :8080 -data $PWD\data\control-plane -bus $env:KAVACH_BUS_DIR"
Start-Process bin\realtime-gw.exe   "-addr :8082 -bus $env:KAVACH_BUS_DIR"
Start-Process bin\canary.exe        "-metrics :9090 -bus $env:KAVACH_BUS_DIR -api http://127.0.0.1:8080"
```

### Verify it is actually up

```bash
curl http://localhost:8081/healthz                    # ★ the one that matters
curl http://localhost:8080/readyz
curl http://localhost:8082/healthz
curl http://localhost:9090/healthz                    # canary: last probe result
curl http://localhost:9090/metrics                    # the four clocks, per run
curl http://localhost:8080/internal/active-incidents  # F-02 deploy gate
```

---

## 2. The ports

| Port | Service | What it is |
|---|---|---|
| **8081** | `sos-ingest` | ★ **The binary that must never break.** Open, append, relay, SMS-inbound. In-memory family and key caches, WAL fsync **before** the response, no DB read on the request path. Deployed **separately and rarely** — ADR-002 budgets ≤2 deploys/year and a CI-enforced LOC ceiling. Its `docker-compose` block has its own Dockerfile and no `depends_on` for exactly this reason: it must accept an SOS with every other service in this file dead. |
| **8080** | `control-plane` | Family, incidents, consent, policy, journeys, drills, devices, after-action, realtime tickets. Rich, and **allowed to be down**. Blue-green friendly: `SIGTERM` flips `/readyz` to failing and drains for `KAVACH_DRAIN` before the listener closes. |
| **8082** | `realtime-gw` | WebSocket (`/v1/stream`), subprotocol `kavach.v1`. RFC 6455 handshake and frame codec written by hand over `net/http` Hijack — stdlib only. Priority backpressure is a **correctness** rule, not a tuning knob (§2.5.2): a dropped state transition means two responders both drive across town. |
| **9090** | `canary` | ★ Fires a **real** incident through the **real** handler every 15 minutes, forever, and measures all four clocks. `/metrics` for the numbers, `/healthz` for the verdict. |

> **The canary is the only page-worthy alert in the system.** Everything else is
> a ticket. CPU graphs, error rates and uptime checks all stay green while an
> FCM service-account key silently expires, a DLT template is deregistered or an
> APNs certificate lapses — none of those produce an error anywhere, they
> produce a family that does not get woken up. If `canary` goes red, the chain
> between a phone screaming and a human being told is broken.

### On-disk layout (inside the `kavach-store` volume, or `./data`)

```
/var/lib/kavach/
├── sos.wal                  sos-ingest: fsynced BEFORE any 2xx is written
├── store/                   sos-ingest: family + device-key caches (F-22)
├── bus/                     ★ THE SEAM
│   ├── stream.wal              append-only, O_APPEND; tailed on a 250 ms poll
│   ├── cursors/                one file per durable consumer
│   │   ├── control-plane.incidents.cursor
│   │   └── sos-ingest.projector.cursor
│   └── cursors.json            legacy: written by builds before 20 Aug, still read
└── control-plane/           control-plane: incidents, consent, drills, audit
```

`bus/` is the file-backed stand-in for NATS JetStream and is the **only** thing
`sos-ingest` shares with anything downstream: it publishes, the other three
project. All four services are pointed at that one directory explicitly
(`KAVACH_BUS_DIR`) rather than by defaulting, because the defaults in the four
`main.go` files are relative to each process's working directory and silently
disagree.

**Why a directory of cursor files instead of one JSON map** (D-027): the map was
read-modify-written by every process, and two that read before either renamed
produced a file holding only the second writer's durable. A vanished cursor is a
consumer that resumes from `start` — for a `StartAll` projector, the whole
stream replayed. One file per durable needs no merge because nobody else writes
it. A `cursors.json` left by an older build is still read at boot, so an upgrade
resumes rather than replaying.

To watch the seam work, without Docker:

```
bash ops/e2e-two-binaries.sh /tmp/kavach-e2e
```

It runs `sos-ingest` and `control-plane` as two processes on one `KAVACH_BUS_DIR`
and posts a real SOS; the control plane should log `ingest_incident_projected`
and then climb `PENDING → ACTIVE_L1`. Read its header before believing it: it
seeds a family by writing `family.json` directly, because nothing in the system
can create one yet.

The volume is **named**, not a bind mount, so `docker compose down` does not
erase the incident log. An append-only log that a container teardown can delete
is not an append-only log (§11.2). Use `down -v` when you actually mean it.

---

## 3. The four clocks

Five marks, four intervals. The dashboards plot the **intervals** — `t1−t0`,
`t2−t1`, `t3−t2`, `t4−t3` — which is why it is called the four-clock framework
and not the five-clock one. Formalised in
`docs/01-Analysis-and-Core-Requirements.md` §1.6; the client mirrors it as
`FourClocks` in `mobile/src/core/types.ts`.

| Mark | Definition | Recorded as | Budget |
|---|---|---|---|
| **t0** | **Trigger.** The gesture is registered, or sensor fusion crosses threshold. | `incident.opened_at` (client HLC) · `t0TriggerAt` | — |
| **t1** | **Confirmation.** The cancel window expires, or `PROBE` times out, or a duress PIN is entered. | `incident_event` type `CONFIRMED` · `t1ConfirmedAt` | policy-defined, 0–300 s |
| **t2** | **First transmit.** The first byte of the first transport leaves the device. | earliest `incident_event.source_transport` · `t2FirstTransmitAt` | < 500 ms after t1 |
| **t3** | **First notification delivered** to any family device. | `incident.first_notified_at` · `t3FirstNotifiedAt` | **p95 < 5 s** online (NFR-002), p99 < 12 s · < 60 s over SMS (NFR-003) |
| **t4** | **First human acknowledgment** — a CLAIM or an ACK tap. | `incident.first_ack_at` · `t4FirstAckAt` | **p95 < 120 s** (NFR-004) |

**t4 is the only clock with life-saving meaning.** Optimising t3 from 4 s to 2 s
while t4 sits at six minutes because someone's phone is in Do Not Disturb is
the seventh entry on the PRD's list of ways this project fails. Read the t3
histogram to find broken infrastructure; read the t4 histogram to find out
whether the family will actually arrive.

The canary measures all five marks on every run and pages when
`t3 − t0 > 15 s`. That threshold is deliberately looser than the NFR-002 budget:
a page means *the chain is broken*, not *the chain is slower than we would like*.
Slow is a ticket.

Related SLOs, both verified by the canary rather than by an uptime checker:

| | Target | How it is measured |
|---|---|---|
| NFR-001 | 99.99% `sos-ingest` availability | end-to-end canary every 15 min |
| NFR-002 | trigger → first family push, online | HLC client stamp vs server stamp |

---

## 4. Point the app at this machine

**The phone is a different device.** `localhost` on the phone is the phone.
`10.0.2.2` only means "the host" inside the Android *emulator*. A physical
handset needs this machine's **LAN IP**, and both devices need to be on the same
network with the host firewall allowing inbound 8080–8082.

### Find the LAN IP

```powershell
# Windows
(Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.InterfaceAlias -notmatch 'Loopback|vEthernet' }).IPAddress
```

```bash
# macOS
ipconfig getifaddr en0
# Linux
hostname -I | awk '{print $1}'
```

You want something like `192.168.1.42` or `10.0.0.7` — never `127.0.0.1`, never
`169.254.x.x` (that means DHCP failed).

### Set it in `mobile/app.json`

```jsonc
"extra": {
  "apiBase":   "http://192.168.1.42:8081",   // sos-ingest, primary
  "apiDirect": "http://192.168.1.42:8081",   // sos-ingest, CDN bypass (F-05)
  "wsBase":    "ws://192.168.1.42:8082",     // realtime-gw
  "demoMode":  "false",                       // ← stop faking it, use the network
  "eas": {}
}
```

Then restart the bundler — `extra` is baked into the manifest at start, so a
hot reload will not pick it up:

```bash
cd mobile && npx expo start -c
```

### Three things that will bite you

1. **`demoMode` defaults to `"true"`, and that is not a mock.** With it on, the
   app runs the whole L0 floor locally: incidents open, the state machine runs,
   the alarm sounds, the escalation ladder advances on real timers and simulated
   responders claim. Nothing here has to be running. Set it to `"false"` only
   when you specifically want to exercise the network path — and expect the app
   to keep working when you then kill the backend, because that is the point.

2. **`apiBase` and `apiDirect` are meant to be two different origins.** F-05:
   the client fires **both concurrently** on the critical path so that a CDN
   failure in front of the primary cannot take the survival path with it. The
   server deduplicates on `incident_id` (P-053), so the duplicate costs nothing.
   Pointing both at one LAN address is correct for local testing and wrong for
   production.

3. **`controlBase` is currently derived from `apiBase`** — see
   `mobile/src/core/config.ts`:

   ```ts
   controlBase: extra.apiBase ?? 'http://10.0.2.2:8080',
   ```

   So setting `apiBase` also moves the control-plane base to port **8081**,
   where nothing answers `/v1/...`. For LAN testing of control-plane endpoints,
   put one reverse proxy in front of both services on a single origin and set
   `apiBase` to that. The demo path is unaffected.

### Building an installable APK

```bash
cd mobile
npx eas build --platform android --profile preview   # ← the profile that emits an APK
```

`preview` is `distribution: internal` + `buildType: apk` — a standalone APK you
can sideload. `development` also emits an APK but needs the dev client and a
running Metro. `production` emits an `.aab`, which a phone cannot install
directly.

---

## 5. Configuration reference

Every value below is read from the environment by the Go binaries; the compose
file sets the ones that need to differ from their defaults.

| Variable | Service | Default here | Notes |
|---|---|---|---|
| `KAVACH_SOS_ADDR` | sos-ingest | `:8081` | |
| `KAVACH_SOS_DATA` | sos-ingest | `/var/lib/kavach` | owns `sos.wal`, `bus/`, `store/` |
| `KAVACH_SMS_GATEWAY_SECRET` | sos-ingest | *(unset)* | HMAC on inbound SMS webhooks (F-09). Unsigned callbacks are rejected once set. |
| `KAVACH_CP_ADDR` | control-plane | `:8080` | binary's own default is `:8081` — always set it |
| `KAVACH_DATA_DIR` | control-plane | `/var/lib/kavach/control-plane` | |
| `KAVACH_DRAIN` | control-plane | `3s` | readiness drain before the listener closes |
| `KAVACH_ESCALATION_WORKERS` | control-plane | `3` | F-13: no leader, N competing workers |
| `KAVACH_RT_ADDR` | realtime-gw | `:8082` | |
| `KAVACH_RT_ALLOW_NO_TICKET` | realtime-gw | `0` | `1` accepts unauthenticated sockets. Debugging aid, never a deployment (F-16). |
| `KAVACH_CANARY_METRICS_ADDR` | canary | `:9090` | binary's own default is `:9101` |
| `KAVACH_CANARY_INTERVAL` | canary | `15m` | |
| `KAVACH_API_BASE` | canary | `http://control-plane:8080` | |
| `KAVACH_PAGE_URL` | canary | *(unset)* | P0 webhook — ntfy topic, Telegram bot, PagerDuty events URL. Unset means failures are logged and never page anyone: correct for a laptop, wrong for production. |
| `KAVACH_BUS_DIR` | all four | `/var/lib/kavach/bus` | the seam |
| `KAVACH_API_TOKEN` | control-plane, canary | *(unset)* | empty disables bearer auth. Compose feeds the same host value to both so they cannot drift apart. |
| `KAVACH_DEV` | all four | `1` | `0` switches to the JSON production formatter |

Overrides go in the environment, not in the compose file:

```bash
KAVACH_API_TOKEN=$(openssl rand -hex 32) \
KAVACH_PAGE_URL=https://ntfy.sh/kavach-pages-a8f3 \
  docker compose -f ops/docker-compose.yml up -d
```

The builder image is pinned to `golang:1.26-alpine` to match `backend/go.mod`
(`go 1.26`). Bump both together or neither.

---

## 6. When something is wrong

| Symptom | First thing to check |
|---|---|
| `canary` unhealthy | `docker compose logs canary` — it names the exact link that broke and lists per-clock failures. This is the page. |
| Phone cannot reach the backend | Host firewall on 8080–8082, then confirm both devices are on the same subnet, then `curl` the LAN IP **from another machine** before blaming the app. |
| Control-plane 401 on everything | `KAVACH_API_TOKEN` is set on the server but the client is not sending it. |
| WebSocket closes with 1008 | F-16: connect tickets are single-use and live 60 s. Mint a fresh one via `POST /v1/rt/ticket`. |
| A deploy is frozen | F-02: `GET /internal/active-incidents`. Canary and drill incidents auto-quiesce to `DORMANT`; a real one blocking a deploy is the gate doing its job. |
| Data looks stale after a restart | The bus is replayed from `stream.wal` at boot. If two processes were writing to two *different* bus directories, they each replayed their own — check `KAVACH_BUS_DIR` on all four. |
