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

Windows: `go test ./...` may fail with *"An Application Control policy has blocked this file"* —
that is the OS, not the code. Re-running sometimes clears it. **For `cmd/sos-ingest` it does not**:
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

- `backend/cmd/sos-ingest/` — **970/1000 lines.** CI Gate 4 fails past 1000 (ADR-002). To add lines
  here you must first remove lines here.
- The four generated files (`stateMachine.generated.ts`, `machine_gen.go`, `machine_gen_test.go`,
  `__generated__/fixtures.json`) — **never hand-edit.** Change `spec/state-machine.yaml`, `npm run gen`.
- `proto/incident.proto` — additive only; field numbers are frozen (`tools/protolint.mjs`, Gate 9).
- **`notify.Fanout` rebuilds `Step` by hand for the neighbour feed** (the `reduced` loop in
  `notify.go`). A field you add to `Step` and do not name there is silently dropped — for neighbours
  only, so every test on the main path still passes. Add the field *and* a neighbour-leg test.
- `internal/consent` and `cmd/{realtime-gw,canary}` have **zero tests**; `cmd/control-plane`
  (9 tests) and `internal/bus` (now 7) got their first in W10-h, `internal/wal` (19) in W10-i, and
  ~30 control-plane routes are still unpinned. `internal/store` covers two seams (the device table, W10-a; the escalation_timer row and
  `FireTimer`, W10-f) out of eleven tables. `internal/notify`
  and `internal/escalation` are the covered ones — escalation has 69 cases over CLAIM/RELEASE
  (W10-d), the ladder and the timer wheel (W10-e), action routing (W10-g), and still nothing on
  `Cancel`, `Ack`, `OnScene`, `Resolve` or the HLC. `cmd/sos-ingest` has its request path
  (`main_test.go`) and its projector's arming path (`projector_test.go`, W10-g); `replayWAL` and
  `refreshCache` are still unpinned. Characterize current behaviour in a test *before* changing any of it. The
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
- **The rungs `sos-ingest` arms are executed by nobody, and are now redundant too (D-026 +
  addendum).** W10-h gave `cmd/control-plane` a durable subscription on `fam.*.incident` that
  projects the incident and calls `engine.OnIncidentOpen` — so the ladder is armed by the engine,
  with action names `execute` has cases for, **in one process**. `sos-ingest.armTimers` still derives
  `NO_ACK` rungs into `<data>/store`, which nothing polls and which `escalation.execute` has no case
  for (`action_routing_test.go`). `armTimers` and `tierFor` are ~20 deletable lines; deleting them
  means deciding what `projector_test.go`'s four tests become. Read D-026 and D-027 before you touch
  `armTimers`, `OnIncidentOpen`, `onIngestedIncident`, or either binary's data directory.

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
