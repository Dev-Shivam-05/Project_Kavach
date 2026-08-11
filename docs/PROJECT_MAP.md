# Project Map — Kavach

Written by recon on 2026-08-11 against commit `62ed6839`. Replaces re-reading the codebase at the
start of every session. If a fact here is wrong, fix it here first.
Status board: [PHASES.md](PHASES.md) · Risks: [RISK.md](RISK.md) · History: [history/SESSION-LOG.md](history/SESSION-LOG.md)

## Run it

| | Command | Dir |
|---|---|---|
| install | `npm ci`, then `cd mobile && npm ci` | root, `mobile/` |
| mobile dev | `npx expo start` — needs a dev client; **Expo Go cannot run this app** (D-001) | `mobile/` |
| mobile verify | `npm run verify` (= `tsc --noEmit` + `npm test`) | `mobile/` |
| backend | `go build ./...` · `go test ./... -race` (`CGO_ENABLED=1`) | `backend/` |
| codegen | `npm run gen` · drift check `npm run gen:check` | root |
| run stack | `docker compose -f ops/docker-compose.yml up --build -d` | root |
| release APK | `npx eas build --platform android --profile preview` | `mobile/` |

**Verified green 2026-08-11 (after W10-e):** `go build` ✅ · `go vet ./...` ✅ · `go test ./...` ✅
(`internal/escalation` **68 cases**) · `archlint` ✅ (14 packages, 42 edges — it counts test files
too, so the 36 recorded after W10-d became 42 when W10-e added two) · `tsc --noEmit` ✅ ·
`npm test` **165/165** ✅ · `gen:check` in sync (14 states · 20 events · 35 transitions · 16
fixtures) · `schema-lint` ✅ · `protolint` ✅ · `logx` deny-list ✅ · `TestLOCBudget` **963/1000**.
`go test -race` needs `CGO_ENABLED=1` **and a C compiler**; there is no gcc on this machine, so the
race gate runs in CI only.

**Two other toolchains are absent here, and it matters.** No JDK and no `ANDROID_HOME`, so the
Kotlin under `mobile/modules/kavach-t0/android/` **cannot be compiled on this machine** and no CI
gate compiles it either — the nine gates are Go, TypeScript and Node. Any change to the native
Tier-0 plane is unverifiable from this checkout (D-021). No Firebase credentials either: see
`KAVACH_FCM_CREDENTIALS` below.

Env vars: full table in [ops/README.md](../ops/README.md) §5. External services: **none** — no
Postgres, no Redis, no NATS, no cloud account. `backend/go.mod` has zero `require` lines.

## Stack

Go 1.26 **stdlib only** · Expo SDK 57 / RN 0.86 / React 19.2 / TypeScript 6.0 · Kotlin native module
(Android only) · zustand 5 · expo-sqlite · `@noble/{curves,ciphers,hashes}` 2.2. Storage is files.
**No linter exists** — no ESLint, Prettier, semgrep or textlint config (D-013).

## Architecture in 6 lines

Three planes, dependencies flow **downward only**: T0 survival (native, on-device, no network) → T1
coordination (fan-out, ack, degrades to SMS) → T2 intelligence (may be down a week).
Four Go binaries: `sos-ingest` :8081 (the sacred one — WAL fsync before ack, no DB on the request
path), `control-plane` :8080 (rich, allowed to be down), `realtime-gw` :8082 (hand-rolled RFC 6455),
`canary` :9090 (real incident every 15 min; the only page-worthy alert).
The seam between them is `bus/` — a file-backed append-only stream with durable cursors.
Auth is three different things: bearer token (control-plane), single-use 60 s tickets (realtime-gw),
and **nothing but a fail-open Ed25519 signature** on sos-ingest (ADR-018, deliberate).

## Where things live

| Concern | Path |
|---|---|
| state machine — source of truth | [spec/state-machine.yaml](../spec/state-machine.yaml) |
| codegen (4 files, never hand-edit) | [tools/smgen.mjs](../tools/smgen.mjs) |
| wire contract (frozen field numbers) | [proto/incident.proto](../proto/incident.proto) |
| backend routes | `backend/cmd/*/main.go` — one `routes()` block each |
| backend auth | `control-plane/main.go:1410` · `realtime-gw/main.go:318` |
| durable server state | `backend/internal/store/store.go` (JSON files, 11 tables) |
| screens | `mobile/app/` (expo-router, 22 routes) |
| client state | `mobile/src/state/{store,nodeStore,enrolStore}.ts` |
| T0 emergency plane | `mobile/src/t0/` |
| native Tier-0 | `mobile/modules/kavach-t0/` (Kotlin, Android only) |
| design tokens | `mobile/src/ui/theme.ts` |
| config / flags | `mobile/src/core/config.ts` + `mobile/app.json` `extra` |
| decisions | [docs/adr/](adr/) (22 ADRs) + [DECISIONS.md](DECISIONS.md) (chat-only ones) |

**Generated — never hand-edit** (all carry `DO NOT EDIT`): `mobile/src/t0/stateMachine.generated.ts`,
`backend/internal/incident/machine_gen.go`, `…/machine_gen_test.go`,
`mobile/src/t0/__generated__/fixtures.json`. Edit the YAML and run `npm run gen`; CI Gate 6 fails on drift.

## Screen inventory

| Screen | What a user can actually DO |
|---|---|
| `panic.tsx` | Press-and-hold SOS, countdown, cancel with PIN, CALL 112 via the native dialler |
| `probe.tsx` | Answer "Are you okay?" before escalation |
| `incident/[id].tsx` | Claim / on-scene / two-party resolve, read the four clocks and the ladder |
| `medical-card.tsx` | View/edit the 21:1 break-glass card (D-006) |
| `(tabs)/home.tsx` | Family health dashboard + the non-dismissable "agent silent" line |
| `(tabs)/map.tsx` | SVG scatter of members, select, add/delete geofences — **no basemap** |
| `(tabs)/incidents.tsx` | Browse incidents, false-positive ledger |
| `(tabs)/consent.tsx` | Who sees me / what I see, revoke grants |
| `(tabs)/settings.tsx` | Profile, locale, both PINs, pause monitoring, 9 sub-screens |
| `onboarding/index.tsx` | 6 steps in one route on purpose; fires a **real** drill SOS |
| `enrol.tsx` | Join a family by code/QR + spoken-fingerprint SAS. Fully offline |
| `diagnostics.tsx` | Permission/OEM self-checks that refuse to tick unprovable boxes |
| `vault.tsx` | Shamir 2-of-3 quorum unseal — **document rows point at files that do not exist** |
| `journeys.tsx` · `drills.tsx` | Start/monitor journeys · run a drill, read scorecards |
| `camera-node.tsx` · `camera-view.tsx` | Turn a spare phone into a motion-stills node · kill switch |
| `screen-time.tsx` | **Functionally inert** — hardcoded 5-app fixture, no `UsageStatsManager` bridge |

## Demo-mode surface

`CONFIG.demoMode` defaults **true** (`config.ts:66`, `app.json:140`) and is **not a mock layer** —
the state machine, crypto, timers and alarm are all real (D-004). Forks live in:
`src/net/api.ts` (17 endpoints short-circuited) · `src/net/ws.ts:302,365,472,490` ·
`connectivity.ts:123,319` · `outboxDrain.ts:265` · `store.ts:373,447,1130,1271,1280` ·
`settings.tsx:51,199,610,812` · `nodeStore.ts:405` (a fake camera peer). Fixtures:
`src/domain/demo.ts`, 1,261 lines. Demo PINs `1234` / `9119` are written to SecureStore at boot.

## Build and release

Prebuild/dev-client workflow — `expo prebuild`, custom native module, EAS profiles `development`
(dev client), `preview` (APK, the sideloadable one), `production` (`.aab`). Measured baseline
132.8 MB → **31.97 MB** after dropping x86/x86_64, R8 and resource shrinking; see
[mobile/docs/BUILD-SIZE.md](../mobile/docs/BUILD-SIZE.md) and D-008 for the two deliberate
trade-offs. **`eas.json` sets no `env`, so a release build ships in demo mode** — [RISK.md](RISK.md) §1.

## Conventions actually used

- **Every file opens with a `★` header citing the PRD / ADR / F- / P- id it implements** — 410
  citations. This is the documentation system; match it.
- Go: no router, no middleware framework — literal wrapping, `s.auth(s.idempotent(h))`.
- TS: camelCase fns, PascalCase types/components, `SCREAMING_SNAKE` constants; stores are `useX`,
  consumed one selector per field; `StyleSheet.create` with values from `theme.ts`.
- **Nothing throws into the UI** — every repo/network call goes through `safe()` (`store.ts:2478`).
- Imports are **100% relative**; the `@/*` alias is configured and deliberately unused.
- Zero `TODO`/`FIXME`/`HACK`/`@ts-ignore` in the tree. Outstanding work lives in `★` prose instead.

## Danger zones

| File | Why |
|---|---|
| `cmd/control-plane/main.go` (1667) | biggest file, ~30 routes, **zero tests** |
| `internal/store/store.go` (1170) | the durable record for everything; only the **device** table has tests (`store_test.go`, W10-a) |
| `internal/escalation/engine.go` (1140) | decides whether a human is woken. CLAIM/RELEASE (`claim_test.go`, W10-d), the ladder and the timer wheel (`ladder_test.go` + `timer_test.go`, W10-e) are covered. Still unpinned: `Cancel` and its duress twin, `Ack`, `OnScene`, two-party `Resolve`, the HLC |
| `cmd/realtime-gw/main.go` (1034) | hand-written WebSocket framing + backpressure, **zero tests** |
| `cmd/sos-ingest/main.go` | **963/1000 LOC** — CI Gate 4 fails past 1000 (ADR-002) |
| `src/state/store.ts` (2606) | consumed by 21 files; owns bootstrap and the L0 floor |
| `src/t0/triggerRouter.ts` (999) | cancel window, PIN compare, 500 ms budget — only the *generated* table is tested |

`internal/{bus,wal,consent}` plus all three of `control-plane`, `realtime-gw`, `canary` — roughly
**4,300 LOC with no direct tests**. `store` and `notify` are partially covered (W10-a) and
`escalation` is now the best-covered package in the backend (W10-d + W10-e, 68 cases); everything
those three do outside the device table, the FCM fan-out path, and the ladder / wheel / ownership
transitions is still unpinned.

**Env vars added by W10-a:** `KAVACH_FCM_CREDENTIALS` — path to a Google service-account JSON key
with FCM enabled. Unset is the current normal: the control plane logs `push_not_configured` at WARN
and every push leg records `KV-NOPUSHCFG`.

**The push path, end to end (W10-a + W10-b + W10-d).** Server: `internal/notify/fcm.go` (FCM HTTP v1,
stdlib only) ← `notify.go pushPayload()` (the F-21 safe set) ← `Device.push_token_fcm`. Device:
`src/state/notifications.ts acquireDevicePushToken()` registers the **native** FCM token, and
`src/state/pushReceive.ts` defines the `kavach.push.incident` background task **in module scope**,
imported by `mobile/index.ts` *before* `expo-router/entry` — order is load-bearing, see the file
header. Both `notifyIncident()` (socket) and `notifyIncidentFromPush()` (FCM) compose through one
`presentIncidentAlert()`, so the two paths cannot tell the family different stories.

**What a push says (F-21, seven fields since W10-d).** `incidentId · familyId · trigger · tier ·
subjectShortName · kind · ownerShortName`. `kind` is `alert | claimed | released`; anything
unrecognised degrades to `alert` on **both** sides (`Kind.wire()` in `notify.go`, `asKind()` in
`pushReceive.ts`) because a claim shown as an alert costs a wasted siren and the reverse costs the
alert. `ownerShortName` rides claims only. The allowlist is enforced twice, fail-closed:
`assertPushSafe` (server) and `readPushFields` (device). Adding a field means editing `docs/02`
§2.6.3, both allowlists, and D-022 — not just the sender. **A CLAIM presents through
`notifyOwnership()` / `presentOwnershipBanner()` on a fourth channel, `kavach-ownership`** (quiet,
sticky, PUBLIC on the lock screen — D-023), and the socket path at `store.ts reactToOwnState` /
`reactToRemoteState` routes through the same composer.

## Known broken

- `ops/run-backend.ps1:77` passes `-addr`/`-data` to all four binaries; two define neither and exit.
- `control-plane` and `sos-ingest` **both default to `:8081`** (main.go:60 / main.go:1138).
- `controlBase` falls back to `extra.apiBase` (`config.ts:51`), moving the control plane to :8081.
- `README.md:34` still says to use Expo Go, which cannot run this app.
- **`app.json` has no `android.googleServicesFile`.** Every build produced today therefore ships
  without Firebase config, `getDevicePushTokenAsync()` throws, `acquireDevicePushToken()` returns
  null, and the server records `KV-NOTOKEN` for that handset — forever. Adding
  `google-services.json` to the repo is not enough on its own; the key must be in `app.json` for
  `expo prebuild` to place it (PHASES 1.35d step 3).
- `mobile/docs/PHASE-STATUS.md` is **stale** — audited at `20a5fdf`, before ADRs/CI/proto existed.
- Windows: `go test ./...` may fail once with *"An Application Control policy has blocked this
  file"* on a freshly linked test binary. Re-run — it is the OS, not the code.
