# Project Kavach — house rules

Read [docs/PROJECT_MAP.md](docs/PROJECT_MAP.md) before touching code, [docs/PHASES.md](docs/PHASES.md)
for status, and [docs/RISK.md](docs/RISK.md) before touching anything in its danger table.

## Commands

| | |
|---|---|
| backend | `cd backend && go build ./... && go vet ./... && go test ./...` |
| mobile | `cd mobile && npm run verify` (= `tsc --noEmit` + `npm test`) |
| codegen | `npm run gen` (root) · check drift with `npm run gen:check` |
| lints | `node tools/schema-lint.mjs` · `node tools/protolint.mjs` (root) |
| archlint | `cd backend && go run ./tools/archlint` — **from `backend/`, not the root.** The root has no `go.mod`, so running it there fails with `cannot find main module` |
| staticcheck | **is installed here**, and is not on PATH: `& "$env:USERPROFILE\go\bin\staticcheck.exe" ./...` from `backend/`. It is a local gate, unlike `-race` |
| stack | `docker compose -f ops/docker-compose.yml up --build -d` |

**`-race` does not run on this machine.** It needs `CGO_ENABLED=1` *and* a C compiler, and there is
no gcc here — `go test -race` fails with `cgo: C compiler "gcc" not found`, which is a toolchain
gap, not a test failure. CI gate 3 is the only place the race detector has ever run. Do not report
`-race` as passing locally; say it was not run.

**There is no JDK and no Android SDK on this machine either** (`java` is not on PATH, `ANDROID_HOME`
and `JAVA_HOME` are unset). The Kotlin under `mobile/modules/kavach-t0/android/` therefore cannot be
compiled here, and **no CI gate compiles it either** — the nine gates are Go, TypeScript and Node.
Changes to the native Tier-0 plane are unverifiable from this checkout; say so rather than reporting
Kotlin as done (D-021).

**`expo start --web` is not a fallback for screenshotting UI changes either.** `react-native-web` is
not a dependency (`npm run web` starts Metro but warns it is missing before anything renders), and
Expo Go can't run this app regardless (D-001, custom native modules). A pure-JS/RN change with no
native surface — like phase6-D-1b's header icon — is verified here by `tsc --noEmit` + `npm test`
plus reading the JSX, not by a screenshot; say that explicitly rather than attempting a web preview
that dead-ends.

Windows: `go test ./...` may fail with *"An Application Control policy has blocked this file"* —
that is the OS, not the code. Re-running sometimes clears it. **It also blocks a test that re-execs
its own binary** (`internal/{wal,bus}`'s two-real-process tests, `fork/exec …\b001\x.test.exe`).
Those skip themselves on that one error string, so the package stays green; to actually run them,
give the binary a stable path — `go test -c -o .gotmp/bus.test.exe ./internal/bus/` then
`./.gotmp/bus.test.exe -test.run=TestTwoRealProcesses…`. **For `cmd/sos-ingest` it does not**:
three consecutive runs failed identically on `sos-ingest.test.exe` while every other package passed.
The fix is to build somewhere else —
`mkdir -p backend/.gotmp && GOTMPDIR=/d/Projects/Project_Kavach/backend/.gotmp go test ./cmd/sos-ingest/`
— and delete `.gotmp` afterwards with plain **`rmdir`**, not `rm -rf`: `go test` leaves the
directory empty, and `rm -rf` on this machine is refused by the sandbox (so is
`Remove-Item -Recurse`). `mkdir -p` first, or `go` fails with "no such file or directory". Never
report this package green without having actually run it.

**`// @ts-expect-error` must sit on the line the import specifiers are on.** The tempting shape —
a trailing comment inside the braces of a multi-line `import { … } from 'expo-notifications'` —
suppresses **nothing**: `tsc` reports one TS2305 per specifier line, and the directive then applies
to the `} from …` line and reports itself unused. That shape shipped in `test/push-token.test.ts`
and left `tsc --noEmit` red while a handoff recorded it green. Use a single-line import with the
directive above it, and read the actual `npm run typecheck` output before claiming a gate passed.

**A new tab route needs a matching entry in `test/routes.test.ts`'s `NAVIGATOR_REACHED` set, or
`npm test` fails on a route that IS reachable.** The test scans `app/` for a literal `'/route'`
string in some OTHER file to prove reachability, but the `<Tabs>` navigator's own destinations live
in `src/ui/TabBar.tsx` — outside `app/`, so never scanned — and are reached by the tab bar itself,
not a `router.push`. `tsc --noEmit` is silent about this; only the test suite catches it. Added
`/watch` on 29 Aug (phase6-D-1); the same step is needed for every future tab.

## The conventions this codebase actually follows

1. **Every file opens with a `★` header citing the requirement it implements** (`F-05`, `NFR-002`,
   `P-043`, `I-4`, `ADR-018`) — 410 such citations. A change with no cited forcing requirement does
   not match this codebase. Decoder: [docs/spec/GLOSSARY.md](docs/spec/GLOSSARY.md).
2. **"Exists" ≠ "is wired up" — report both.** This repo has shipped complete, tested, zero-call-site modules more than once.
3. **Nothing throws into the UI.** Every repo/network call is wrapped in `safe()`
   (`mobile/src/state/store.ts:2478`); fire-and-forget is `void safe(...)`.
4. **Go has no framework.** Literal function wrapping, `s.auth(s.idempotent(h))`, stdlib only.
   `backend/go.mod` must keep zero `require` lines.
5. **Imports in `mobile/` are relative** — the `@/*` alias is deliberately unused. Styles come from
   `src/ui/theme.ts`, never literals.
6. **There is no linter.** `tsc --noEmit`, `go vet` and staticcheck are the whole static-analysis
   surface — match surrounding style by reading it, not by running a formatter.
7. **A mobile test that imports an Expo module needs a stub in `mobile/test/shim.mjs`.** Node runs
   the tests directly; there is no Metro and no jest. Add the specifier to `STUBS` and its source to
   `STUB_SOURCE`. Keep stubs *controllable* (`__setX` / `__emitX` exports) so behaviour can be
   driven, not just satisfied.
8. **Never invent a persisted field name.** `backend/migrations/0001_init.sql` is the naming
   authority for anything the server stores, even though nothing runs it (ADR-006, D-003).
   `internal/store/store_test.go` now enforces this for the `device` table: its key list must match
   the migration's columns exactly, so a new column fails the test until you add it there.

## Danger zones

- `backend/cmd/sos-ingest/` — **995/1000 lines.** CI Gate 4 fails past 1000 (ADR-002). To add lines
  here you must first remove lines here. W10-j's `projectEnrolment` spent 25 of the 30 that were
  left; `armTimers`/`tierFor` are ~20 dead lines and the obvious place to buy headroom back.
- The four generated files (`stateMachine.generated.ts`, `machine_gen.go`, `machine_gen_test.go`,
  `__generated__/fixtures.json`) — **never hand-edit.** Change `spec/state-machine.yaml`, `npm run gen`.
- `proto/incident.proto` — additive only; field numbers are frozen (`tools/protolint.mjs`, Gate 9).
- **`notify.Fanout` rebuilds `Step` by hand for the neighbour feed** (the `reduced` loop in
  `notify.go`). A field you add to `Step` and do not name there is silently dropped — for neighbours
  only, so every test on the main path still passes. Add the field *and* a neighbour-leg test.
- `internal/consent` and `cmd/{realtime-gw,canary}` have **zero tests**; `cmd/control-plane`
  (9 tests, now 18 with W10-j's enrolment file) and `internal/bus` (now 10) got their first in
  W10-h, `internal/wal` (19) in W10-i, and ~28 control-plane routes are still unpinned.
  `internal/store` covers two seams (the device table, W10-a; the escalation_timer row and
  `FireTimer`, W10-f) out of eleven tables. `internal/notify`
  and `internal/escalation` are the covered ones — escalation has 69 cases over CLAIM/RELEASE
  (W10-d), the ladder and the timer wheel (W10-e), action routing (W10-g), and still nothing on
  `Cancel`, `Ack`, `OnScene`, `Resolve` or the HLC. `cmd/sos-ingest` has its request path
  (`main_test.go`), its projector's arming path (`projector_test.go`, W10-g) and its enrolment
  projection (`enrolment_test.go`, W10-j); `replayWAL` is still unpinned and `refreshCache` is only
  reached through enrolment. Characterize current behaviour in a test *before* changing any of it. The
  shape that works: pin what the code already does, run it green, then add the new expectation and
  show it red before you make it pass. It is also how gaps get found — W10-e's characterization
  pass is what surfaced D-024.
- **`cancelTimers` cannot cancel a timer a worker already holds.** It only rewrites rows still
  marked `pending`, and a claimed row is `fired`. The state guard at the top of each `execute`
  branch is the *only* thing standing between an in-flight rung and a family woken (or billed) for
  an incident that has already moved on. Add a state to the machine, and every one of those guards
  is a place you must decide about.
- **`store.PutTimer` is a blind upsert — `*old = t`, no guard on the row's current state.** Writing
  a timer id that already exists resets `state` to `pending` and zeroes `fired_at` and `attempts`.
  `engine.cancelTimers` depends on that (read, flip, write back). `sos-ingest.armTimers` **was**
  bitten by it — proven, not inferred, in `projector_test.go` — and now carries the guard itself:
  it reads the incident's rungs once and skips any id already on disk, **per rung id, never per
  incident**, because a bus redelivery after a partial failure must still arm what is missing
  (D-025). Do not move that guard into the store without reading both callers.
- **`internal/bus` crosses a process now, and three things keep it that way (D-027, W10-i).**
  Break any one and it silently stops being a seam again, with every in-process test still green:
  **(1)** `stream.wal` is opened by `wal.OpenShared` — `O_APPEND`, one whole record per `Write`.
  Reintroduce `WriteAt` on that file and two processes overwrite each other. **(2)** `bus.poll()`
  re-stats and tails the file every 250 ms; records enter `b.msgs` there and in `publish`, nowhere
  else. **(3)** `Seq` is the record's ordinal *in the file*, not a per-instance counter — a cursor
  is a `Seq`, so the moment one process invents its own numbering the two disagree about what they
  have already delivered. `cursors.json` is merged, never replaced, for the same reason.
  `internal/wal`'s single-writer `Open` (that is `sos.wal`, ADR-002) is a different path and is
  unchanged — do not "unify" them.
  Proven by two real OS processes, not two values in one test binary:
  `TestTwoRealProcessesOnOneBusDirectory`, `TestTwoRealProcessesAppendToOneSharedLog`. Still say
  which kind of test you are quoting — **`docker compose up` has never been run on this machine**
  (no daemon), so the four-container claim remains untested; `ops/e2e-two-binaries.sh` is the
  strongest evidence that exists and it is two binaries on one host.
- **A bus test handler that blocks hangs the whole package, it does not fail it.** The cursor stops
  advancing, `Drain` never returns, and `Close` waits on the worker for ever — `go test` sits there
  until its timeout with no failing assertion to read. Publishing more messages than a test
  channel's buffer is the easy way to cause it; `subscribeInto` sends non-blocking for that reason.
  Always pass `-timeout` when a bus change is under test.
- **Enrolment rows cross the bus; the two binaries do NOT share a store (D-028, RISK 18).**
  `cmd/control-plane` owns every enrolment write — `POST /v1/family`, `POST /v1/members`,
  `POST /v1/devices` — and publishes `bus.KindEnrolmentUpsert` on `fam.<id>.enrolment`;
  `sos-ingest.projectEnrolment` applies it and calls `refreshCache`. Pointing both binaries at one
  store directory is the tempting one-liner and it reopens D-027: `store.persist` rewrites a *whole*
  JSON table under an in-process mutex, in the table that decides whether a signature verifies. The
  payload type is **shared** (`store.EnrolmentUpsert`) for the same reason `notify.Fanout`'s
  neighbour leg is a trap — a field the writer adds and the reader forgets is invisible, and every
  test on the writing side still passes.
  Two things that will surprise you: an SOS for a family `sos-ingest` has not been told about is
  **refused at the front door with 404** (`ingestEnvelope`, F-04) rather than dropped quietly by the
  projector; and `publishOps("device.key.changed", …)` goes to `ops.alert`, which **nothing in this
  repository subscribes to** (RISK 19) — it has never refreshed anybody's cache.
- **The rungs `sos-ingest` arms are executed by nobody, and are now redundant too (D-026 +
  addendum).** W10-h gave `cmd/control-plane` a durable subscription on `fam.*.incident` that
  projects the incident and calls `engine.OnIncidentOpen` — so the ladder is armed by the engine,
  with action names `execute` has cases for, **in one process**. `sos-ingest.armTimers` still derives
  `NO_ACK` rungs into `<data>/store`, which nothing polls and which `escalation.execute` has no case
  for (`action_routing_test.go`). `armTimers` and `tierFor` are ~20 deletable lines; deleting them
  means deciding what `projector_test.go`'s four tests become. Read D-026 and D-027 before you touch
  `armTimers`, `OnIncidentOpen`, `onIngestedIncident`, or either binary's data directory.
- **There is no working "a member joined this family" event on the mobile client — do not assume
  one to hook a feature to (D-033).** Two flows look like candidates and neither is: `enrolStore.ts`'s
  P2P device-pairing (spoken-fingerprint SAS) is deliberately airgapped by its own header comment
  ("IT NEVER TALKS TO A SERVER… never touches `store.ts`"); and although the backend route exists and
  works (`POST /v1/members`, W10-j), **no client in `mobile/` calls it** — `net/api.ts` only wires
  `POST /v1/family` (`createFamily`). `store.ts`'s `grantFamilyMembershipScopes` (6-D-4, spec F2) was
  built and tested against this gap rather than papered over it, and ships with zero call sites for
  that reason. Building the real bridge is new architecture (either wire `store.ts`'s bootstrap to
  read `useEnrol.getState().joined`, or write the missing `POST /v1/members` client call) — do not
  treat it as a five-minute wire-up inside an unrelated phase.

## Do not "fix" these

Fail-open on the safety path (ADR-018) · `ErrAppendOnly` on `incident_event` (I-4) · the
`sos-ingest` LOC ceiling · realtime-gw priority backpressure (a correctness rule, not tuning).
A bad signature flags and proceeds. That is the product.

## Contract seam (monorepo, no sibling repos)

`spec/state-machine.yaml` → 4 generated files · `proto/incident.proto` frozen field numbers ·
`backend/internal/envelope` ↔ `mobile/src/t0/envelope.ts`, byte-identical per `crosslang_test.go`.
Change the spec, never one side.

## Done means

CI's nine gates would pass: `go vet`, staticcheck, `go test -race`, archlint, LOC budget,
`tsc --noEmit` + mobile tests, `gen:check`, PII deny-list, Class-A schema lint, proto lint.
For UI, a screenshot of each state. For the danger table, the characterization test first — shown
failing before it passes. Never `/clear` without `/handoff`; commit per phase.
