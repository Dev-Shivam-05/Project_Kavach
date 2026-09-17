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
pwsh ops/run-backend.ps1          # build into ./bin and start all four
pwsh ops/run-backend.ps1 -Build   # build only
pwsh ops/run-backend.ps1 -Stop    # stop whatever is running
```

The script keeps everything under `./data` (`-DataDir` moves it) and starts the
four processes with the flags each one actually defines — `sos-ingest` first,
because if the safety path is not up nothing else matters. Two seconds after
launch it re-checks that all four are still alive, and if one is gone it exits
non-zero naming the `.log.err` to read instead of printing "running". (Until
6 Sep it passed `-addr`/`-data` to all four; `realtime-gw` and `canary` define
neither and died on the spot with the failure only in their log — RISK 13.)

These are the exact arguments it runs, for when you need one binary by hand.
They agree with the environment the compose file sets, so the two paths never
disagree about the layout:

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
project. `sos-ingest` owns the directory — it is `<KAVACH_SOS_DATA>/bus`, and
that binary reads no `KAVACH_BUS_DIR` at all. The other three are pointed at
that exact directory explicitly (`KAVACH_BUS_DIR`, or `-bus`) rather than by
defaulting, because their defaults are relative to each process's working
directory and silently disagree.

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

It runs `sos-ingest` and `control-plane` as two processes on one bus directory
(`<KAVACH_SOS_DATA>/bus`, handed to the control plane as `KAVACH_BUS_DIR`) and
posts a real SOS; the control plane should log `ingest_incident_projected`
and then climb `PENDING → ACTIVE_L1`, ending in `fanout … devices=1`.

Since 21 Aug (W10-j) it seeds nothing by hand. The family, two members and two
devices are created with five requests to the running control plane — `POST
/v1/family`, `POST /v1/members`, `POST /v1/devices` — and `sos-ingest`'s data
directory is never written to: it learns all five rows over the bus
(`bus.KindEnrolmentUpsert` on `fam.<id>.enrolment`) and only then stops
answering an SOS with `404 unknown family`. The two binaries keep **separate
store directories** on the shared volume, which is deliberate: `store.persist`
rewrites a whole JSON table, so pointing both at one directory reopens D-027 in
the table that decides whether a signature verifies.

`devices=1` is still not a phone ringing — no FCM credentials (RISK 14).

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
  "eas": {}
}
```

Then restart the bundler — `extra` is baked into the manifest at start, so a
hot reload will not pick it up:

```bash
cd mobile && npx expo start -c
```

### Or set it at build time (release builds, EAS)

`app.json` is the same in every build profile, so a release APK would ship the
emulator's hosts. `mobile/src/core/config.ts` reads `EXPO_PUBLIC_*` first and
falls back to `extra`; they are inlined at bundle time, so a build profile can
point a real build at a real host without editing `app.json`:

| Env (build time) | Sets |
|---|---|
| `EXPO_PUBLIC_KAVACH_API` | `apiBase` — sos-ingest, primary |
| `EXPO_PUBLIC_KAVACH_API_DIRECT` | `apiDirect` — sos-ingest, CDN bypass |
| `EXPO_PUBLIC_KAVACH_CONTROL` | `controlBase` — the control plane |
| `EXPO_PUBLIC_KAVACH_WS` | `wsBase` — realtime-gw |

### Three things that will bite you

1. **There is no demo mode, and no backend means no fan-out — not a fake one.**
   `demoMode` and its simulated responders were deleted on 22 Aug (RISK 1): the
   app never fabricates a claim. With the backend down an SOS is still real on
   the device — the state machine, the alarm, the SMS leg and the black box all
   run locally — and the network legs report their failure honestly. Expect the
   app to keep working when you kill the backend, because that is the point.

2. **`apiBase` and `apiDirect` are meant to be two different origins.** F-05:
   the client fires **both concurrently** on the critical path so that a CDN
   failure in front of the primary cannot take the survival path with it. The
   server deduplicates on `incident_id` (P-053), so the duplicate costs nothing.
   Pointing both at one LAN address is correct for local testing and wrong for
   production.

3. **`controlBase` falls back to `apiBase` when neither `EXPO_PUBLIC_KAVACH_CONTROL`
   nor its own value is set** — `mobile/src/core/config.ts`:

   ```ts
   controlBase: env('EXPO_PUBLIC_KAVACH_CONTROL') ?? extra.apiBase ?? 'http://10.0.2.2:8080',
   ```

   So setting only `apiBase` in `app.json` moves the control-plane base to port
   **8081**, where nothing answers `/v1/...`. For LAN testing of control-plane
   endpoints set `EXPO_PUBLIC_KAVACH_CONTROL=http://<lan-ip>:8080` at build
   time, or put one reverse proxy in front of both services on a single origin.

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
file sets the ones that need to differ from their defaults. **This table is
checked, not trusted:** `node tools/envlint.mjs` (CI Gate 10, `npm run lint`)
fails if a `KAVACH_*` literal in `backend/` has no row here, if a row names a
variable nothing reads, or if the compose file sets one the code ignores.
"Service" is which binary reads it — through `internal/logx` or
`internal/notify` where it says so.

| Variable | Service | Default here | Notes |
|---|---|---|---|
| `KAVACH_SOS_ADDR` | sos-ingest | `:8081` | |
| `KAVACH_SOS_DATA` | sos-ingest | `/var/lib/kavach` | owns `sos.wal`, `bus/`, `store/`. **sos-ingest reads no `KAVACH_BUS_DIR`** — its bus is `<KAVACH_SOS_DATA>/bus`, and the three below are pointed at that exact path. |
| `KAVACH_SMS_GATEWAY_SECRET` | sos-ingest | *(unset)* | HMAC on inbound SMS webhooks (F-09). Unsigned callbacks are rejected once set. |
| `KAVACH_CP_ADDR` | control-plane | `:8080` | set it explicitly; do not rely on the binary's own default |
| `KAVACH_DATA_DIR` | control-plane | `/var/lib/kavach/control-plane` | the control plane's **own** store — never sos-ingest's directory (D-028) |
| `KAVACH_DRAIN` | control-plane | `3s` | readiness drain before the listener closes |
| `KAVACH_ESCALATION_WORKERS` | control-plane | `3` | F-13: no leader, N competing workers |
| `KAVACH_SMS_CEILING` | control-plane | `2000` (`notify.DefaultSMSCeiling`) | SMS units per family per month before fan-out stops sending and pages once (§2.8.3 `notify_budget`). `0` or unset → the default. |
| `KAVACH_DEPLOY_OVERRIDE` | control-plane | *(unset)* | F-02. A non-empty reason makes `GET /internal/active-incidents` report `active: []` with `overridden: true` while a real incident would have blocked the deploy; logged at WARN, published to `ops.deploy_override` (P1) and the audit stream. The request header `X-Kavach-Deploy-Override` does the same per call. |
| `KAVACH_FCM_CREDENTIALS` | control-plane (`internal/notify`) | *(unset)* | **Path inside the container** to a Google service-account JSON key with the FCM API enabled (F-21, W10-a). Unset → every push is recorded `KV-NOPUSHCFG`; SMS is the last leg to a human. With compose, do not set this directly — export `KAVACH_FCM_CREDENTIALS_FILE=<host path>` and the recipe mounts it as a secret and points this at it. |
| `KAVACH_RT_ADDR` | realtime-gw | `:8082` | |
| `KAVACH_RT_ALLOW_NO_TICKET` | realtime-gw | `0` | `1` accepts unauthenticated sockets. Debugging aid, never a deployment (F-16). |
| `KAVACH_RT_DEV_FAMILY` | realtime-gw | *(unset)* | only with `KAVACH_RT_ALLOW_NO_TICKET=1`: the family id a ticket-less socket is treated as belonging to (device and member are stamped `dev`). |
| `KAVACH_CANARY_METRICS_ADDR` | canary | `:9090` | set it explicitly; do not rely on the binary's own default |
| `KAVACH_CANARY_INTERVAL` | canary | `15m` | |
| `KAVACH_CANARY_DEVICE_ID` | canary | *(unset)* | the device that plays the responder in the synthetic incident. Unset → the family's first enrolled device. |
| `KAVACH_API_BASE` | canary | `http://control-plane:8080` | the **control plane**, not sos-ingest — the canary enrols and claims through `/v1/…` |
| `KAVACH_PAGE_URL` | canary | *(unset)* | P0 webhook — ntfy topic, Telegram bot, PagerDuty events URL. Unset means failures are logged and never page anyone: correct for a laptop, wrong for production. |
| `KAVACH_BUS_DIR` | control-plane, realtime-gw, canary | `/var/lib/kavach/bus` | the seam. Must equal `<KAVACH_SOS_DATA>/bus` — sos-ingest does not read this variable. |
| `KAVACH_API_TOKEN` | control-plane, canary | *(unset)* | empty disables bearer auth. Compose feeds the same host value to both so they cannot drift apart. |
| `KAVACH_DEV` | realtime-gw, canary | `1` | `1` = developer logging: a PII deny-list hit (I-6) **panics**. `0` = JSON production formatter: the hit is redacted and counted. Compose sets one value for all four containers. |
| `KAVACH_ENV` | sos-ingest, control-plane (`internal/logx`) | *(unset)* | `production` = the redact-and-count formatter; anything else is development and panics on a deny-list hit. ★ **Two names for the one switch.** `logx.Dev()` reads this, the other two binaries read `KAVACH_DEV`, and the compose file sets only `KAVACH_DEV` — so today `KAVACH_DEV=0` alone leaves sos-ingest and control-plane in panic-on-PII mode. Being unified (audit ops-6); until it is, a production deployment must set **both** `KAVACH_DEV=0` and `KAVACH_ENV=production`. |

Overrides go in the environment, not in the compose file:

```bash
KAVACH_API_TOKEN=$(openssl rand -hex 32) \
KAVACH_PAGE_URL=https://ntfy.sh/kavach-pages-a8f3 \
KAVACH_FCM_CREDENTIALS_FILE=/etc/kavach/fcm-credentials.json \
KAVACH_DEV=0 \
  docker compose -f ops/docker-compose.yml up -d
```

The FCM key is the one value that cannot travel as an environment variable —
it is a file, and a real secret (`.gitignore` refuses `fcm-credentials*.json`).
`KAVACH_FCM_CREDENTIALS_FILE` names it on the **host**; the compose recipe
mounts it read-only at `/run/secrets/fcm-credentials` in the control plane and
sets `KAVACH_FCM_CREDENTIALS` to that path. Leave the variable unset and the
secret is `/dev/null` with the env var empty, so the binary takes its
not-configured branch and never reads the placeholder. The file has to be
readable by uid `10001`, the container's user.

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
| Data looks stale after a restart | The bus is replayed from `stream.wal` at boot. If two processes were writing to two *different* bus directories, they each replayed their own — check `KAVACH_BUS_DIR` on control-plane, realtime-gw and canary, and `KAVACH_SOS_DATA` on sos-ingest (its bus is `<KAVACH_SOS_DATA>/bus`). |
| Every push logs `KV-NOPUSHCFG` | `KAVACH_FCM_CREDENTIALS` is unset, or points at a path the container cannot read. With compose, export `KAVACH_FCM_CREDENTIALS_FILE=<host path to the key>` before `up` (§5). |
