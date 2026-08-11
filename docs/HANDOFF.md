# HANDOFF — Kavach — Phase 1 (W10-f, the atomic claim gets a test) — 2026-08-11

Branch **`phase1-w10-remote-push`**, 2 new commits on top of W10-e's `f76339e4`. Session W10-e's
handoff is superseded by this one; its content is in commit `f76339e4`.

**W10-c was not started, again, and for the same reason.** First command of the session was
`Get-Command java` — not found, `JAVA_HOME` and `ANDROID_HOME` unset (D-021). The board's own
instruction for that case names the store's timer contract as the next thing to pin, and that is
what this session did. It shipped no feature. It closed the last hole in the escalation stack's
test coverage — and found a new one a layer up.

## Done

- **`store.FireTimer` has a test.** It is the primitive `engine.claim()` is one line of
  (`c.FireTimer(t.ID) == nil`), and everything that stops N workers fanning out the same tier N
  times lives on the other side of it. W10-e proved the *engine* prefers the transactional path and
  that the path is exclusive — but against `claimingStore`, a hand-written double in the escalation
  package. The production implementation (`store.go:918`) was exercised by nothing. **15 tests now;
  `internal/store` runs 21, all green.**
- **The claim is exclusive and it is durable.** 16 goroutines start together on one row: exactly one
  gets nil, `attempts` is 1, and the refusal does not mutate the row it refused. Reopened from the
  same directory — the crashed worker's successor — the claimed rung is not in `TimersDue`, cannot
  be re-claimed, and carries the same `fired_at`. A claim that is not on disk before the rung fires
  is not a claim.
- **The disk contract is pinned like the device table's.** All 11 persisted keys asserted against
  `CREATE TABLE escalation_timer` (`0001_init.sql:194`) column for column, and the three state
  literals against its `CHECK (state IN (…))`. The engine keeps its own copies of those strings, so
  they are a three-way contract.
- **The read paths the engine's ordering rests on.** `Timers()` oldest-first (the batch limit defers
  the tail rather than dropping it, which is only correct if the oldest is first); `TimersDue`'s
  three-part predicate including the inclusive boundary and the torn `pending`-with-`fired_at` row;
  `TimersForIncident`'s scope, and that it returns non-pending rows because `cancelTimers` filters
  them itself. Rows cross the boundary by value on all three.
- **The characterization pass found a real gap — and this time it was left open, on purpose
  (D-025).** `PutTimer` is a blind upsert (`*old = t`, no state guard).
  `sos-ingest.armTimers` derives rung ids as `incident|state|action`, and `projectOpen` calls it for
  an incident that **already exists** without advancing its state — so a second open record rewrites
  the rungs armed for its current state back to `pending`, zeroes `fired_at`/`attempts`, and
  recomputes `fire_at` from a `ServerReceivedAt` that `main.go:942` has just moved forward.
  **A fired rung can fire again; a pending rung's deadline is pushed out, so a repeated SOS delays
  the ladder.** Reachable via F-04 coalescing, which rewrites the 4th unverified open onto the first
  incident's id while keeping its own HLC — passing both the `markSeen` and `projSeen` dedupes.
- Verified green: `go build`, `go vet ./...`, `staticcheck ./...`, `go test ./...`,
  `archlint` (14 packages, **42** edges — unchanged), `TestLOCBudget` 963/1000, `logx` deny-list,
  `gen:check`, `schema-lint`, `protolint`, `tsc --noEmit`, `npm test` **165/165**.

## Files changed

**Backend**
- `internal/store/timer_test.go` **(new, 538 lines)** — 15 tests. Reuses `openWithFamily` from
  `store_test.go`; adds `openWithTimers` (fixed clock), `sampleTimer`, `mustPut`, `getTimer`, and a
  local restatement of `escalation.TimerClaimer` as a compile-time guard (`store` cannot import
  `escalation` back).

**Docs** — `DECISIONS.md` (D-025), `RISK.md` (new S1 item 15, §4 updated), `PHASES.md` (Now, the
no-JDK queue, 1.29, a new board rule), `PROJECT_MAP.md` (gates, danger table ×2, coverage
paragraph), `CLAUDE.md` (danger zone: `PutTimer`'s missing guard), this file.

## Decisions made

- **W10-f instead of W10-c** — `java` is not on PATH. Checked first, before picking the phase.
- **D-025 — the ladder-reset hole is recorded, not patched.** Opposite call to D-024's, and the
  reason is the location, not the severity. D-024 was one line inside the file already under test.
  This fix belongs in `armTimers` (arm only what is not already on disk for that `(incident,
  state)`), in a file at **963/1000 lines** whose package has **no behavioural test to hang a
  characterization on**. A state guard in `PutTimer` instead would have to keep
  `cancelTimers`' read-flip-write working, i.e. encode escalation's state rules in the persistence
  layer. Full reasoning in `DECISIONS.md`.
- **Both divergences from the migration are pinned as characterizations, not fixed.** `PutTimer`'s
  missing state guard, and `FireTimer` being keyed by id with **no tenancy check** where the
  migration has RLS (`0001_init.sql:433`). The second is not reachable today — the engine only
  passes ids it just read from the same store — and the test says so, along with why a naive fix
  would be worse: `engine.claim()` reads any non-nil error as "somebody else has it" and skips the
  rung silently.

## Known broken / deliberately skipped

- **⛔ Still nobody's phone has rung, and none can.** — *because* 1.35d. Unchanged and not touched
  by this work: `KAVACH_FCM_CREDENTIALS` unset, `mobile/google-services.json` absent, no
  `android.googleServicesFile` in `app.json`. RISK item 14.
- **D-025's sos-ingest half is read, not executed.** Nothing in this repo demonstrates the
  double-fire end to end. The severity above is an inference from four call sites
  (`main.go:882`, `:942`, `:1002`, `:1019`) plus the coalescing branch at `:652`, not a measurement.
  **Do not quote it as proven.** The store half *is* proven —
  `TestPutTimerHasNoStateGuardAndOverwritesAClaimedRow`.
- **`go test -race` was not run.** — *because* there is no gcc on this machine. CI gate 3 only. The
  16-goroutine exclusivity test is exactly the one that would benefit; it passes without the
  detector, which is not the same as being proven race-free.
- **`escalation` is still not comprehensively covered.** `Cancel` and its duress twin, `Ack`,
  `OnScene`, two-party `Resolve` and the HLC have nothing. `Reescalate` is touched by one assertion.
- **`internal/store`'s other nine tables are unpinned.** Two of eleven have tests.
- **1.37 / 1.28 (W10-c) not started.** — *because* D-021. Unchanged.
- **1.35f(a/b/c) untouched** — no drill flag on the wire, headless alerts are English (D-020), a
  terminated-app action tap is still dropped.

## Next session starts here

- **Check `java -version` first.** With a JDK: **W10-c** — one `Activity` in
  `modules/kavach-t0/android/` (`showWhenLocked`, `turnScreenOn`, `excludeFromRecents`) posted via
  `setFullScreenIntent`, closing **1.37 and 1.28** together. **Without one, do not.**
- **Without a JDK, in order:** (1) **D-025** — `cmd/sos-ingest`'s first behavioural test. Drive a
  coalesced second open into `projectOpen` against a real store and assert what happens to the rungs
  already armed. If it reproduces, the guard goes in `armTimers`, and **removals come before
  additions: 963/1000**. If it does not, delete RISK item 15 and say why in D-025. (2) The rest of
  `escalation` — `Cancel`'s duress twin deserves the care `verifyPin` got. (3) Phase 2's
  `policyRepo.byVersion()`.
- **First command:**

  ```
  git checkout phase1-w10-remote-push && cd backend && go test ./internal/store/ -v
  ```

  Nothing is outstanding once the branch is pushed.
- **Watch out for:** **`PutTimer` has no state guard, and two callers disagree about whether that is
  a feature.** `cancelTimers` needs the blind write; `armTimers` is bitten by it. Do not add a guard
  in the store without reading both — the test that pins this says which one you broke.

  Second trap, unchanged since W10-d: **`notify.Fanout` rebuilds `Step` by hand for the neighbour
  feed** (the `reduced` loop in `notify.go`). A field added to `Step` and not named there is dropped
  for neighbours only, so every test on the main path still passes.
