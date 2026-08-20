# HANDOFF — Kavach — Phase 1 (W10-g, D-025 executed and closed; D-026 found) — 2026-08-20

Branch **`shivam`**, 3 new commits on top of `61302e68`. Session W10-f's handoff is superseded by
this one; its content is in commit `f34b5ae1`.

**W10-c was not started, again, and for the same reason.** First command of the session was
`java -version` — not found, `JAVA_HOME` and `ANDROID_HOME` unset (D-021). The board's instruction
for that case named D-025 as the next item, and that is what this session did.

It shipped one safety fix, and it found a bigger hole than the one it was sent to close.

## Done

- **D-025 reproduces, and it is closed.** `cmd/sos-ingest/projector_test.go` (new) drives a duress
  SOS through the real front door — HTTP, the signature check, the F-04 flood guard, the WAL, the
  bus, the projector — has a worker claim the `NO_ACK` rung with `store.FireTimer`, then sends three
  more unverified reports inside the 60 s window. The fourth coalesces onto the first incident's id
  carrying its own HLC, passes `markSeen` and `projSeen` both, and lands in `projectOpen` with
  `exists == true`. **The claimed rung came back `pending`, `fired_at` 0, `attempts` 0, deadline 15 s
  further out, and back in `TimersDue`.** The F-02 six-hour backstop moved with it. Every consequence
  D-025 inferred from four call sites is what the code does.
- **The reproduction is its own commit (`45663634`), green, before the fix.** The red is in the
  history, not only in prose. The fix commit (`08dcf861`) then shows it going the other way.
- **The guard is in `armTimers`, not in the store.** It reads the incident's rungs once and skips
  any id already on disk. **Per rung id, never per incident** — `project()` marks a record seen only
  when the whole projection succeeded, so a store failure inside `armTimers` means the bus redelivers
  and the second pass sees `exists == true`; skipping by incident would leave the ladder permanently
  unarmed on exactly the path that already went wrong once. A **cancelled** rung is skipped too,
  which closes a second smaller hole: a repeated open could previously resurrect a ladder the engine
  had deliberately cancelled. `PutTimer` is untouched — `cancelTimers` still needs the blind write.
- **Two bounds the characterization found that D-025 did not know.** `TimeoutsFor(PENDING)` is
  **empty**, so an ordinary open arms no rungs at all and there is nothing to reset; the way in
  through a single open record is duress, which skips the cancel window inside `projectOpen`.
- **⛔ D-026 — nothing executes the rungs `sos-ingest` arms.** Found while proving D-025.
  Three independent breaks, any one sufficient:
  1. **Different stores.** `sos-ingest` opens `<data>/store` (`main.go:264`, i.e.
     `/var/lib/kavach/store`); `control-plane`, which owns `escalation.Engine`, opens
     `KAVACH_DATA_DIR` directly (`control-plane/main.go:71`, i.e. `/var/lib/kavach/control-plane`).
     `engine.Run` polls its own store.
  2. **Nothing bridges the bus.** The only subscriber to `fam.*.incident` is `sos-ingest`'s own
     projector (`main.go:274`). `control-plane` subscribes to `cp.*` only, `realtime-gw` to the
     notify ticket and stream subjects, `canary` to the notify stream. `engine.OnIncidentOpen` has
     exactly one caller: the control plane's own `POST /v1/incidents` (`main.go:797`).
  3. **The action names disagree.** `escalation.arm` names the work (`ESCALATE_L2`) with minted UUID
     ids; `armTimers` names the event (`NO_ACK`) with derived ids. Three of the four actions the
     projector can derive collide with an action the engine implements; `NO_ACK` — the whole
     L1→L2→L3 climb — hits `execute`'s `default` arm. **Measured**, not read:
     `internal/escalation/action_routing_test.go` (new).
  **Recorded, not fixed** — RISK item 16, D-026. See "Next session" below.
- Verified green: `go build`, `go vet ./...`, `staticcheck ./...`, `go test ./...`
  (escalation **69**, sos-ingest **27**, store **21**), `archlint` (14 packages, **47** edges),
  `TestLOCBudget` **970/1000**, `logx` deny-list, `gen:check`, `schema-lint`, `protolint`,
  `tsc --noEmit`, `npm test` **165/165**.

## Files changed

**Backend**
- `cmd/sos-ingest/projector_test.go` **(new, 426 lines)** — 4 tests. Reuses `seed`, `envFor`,
  `sealed` and `post` from `main_test.go`; adds `projClock` (a settable clock — the arming path
  reads `s.now()` twice over, for the flood window and for every `fire_at`), `newClockedServer`,
  `openUnverified`, `duressEnv`, `rungsFor`, `rungByID`.
- `cmd/sos-ingest/main.go` — 7 source lines in `armTimers`. 963 → **970/1000**.
- `internal/escalation/action_routing_test.go` **(new, 68 lines)** — 1 test, reusing `rig`,
  `atState` and `fire` from `ladder_test.go`.

**Docs** — `DECISIONS.md` (D-025 addendum, D-026), `RISK.md` (item 15 closed, **new S1 item 16**,
items 4 and 7 updated), `PHASES.md` (a blocker note at the top of Now, the W10-g paragraph, the
no-JDK queue reordered with D-026 at #1, the W9 heading, 1.29, a new board rule), `PROJECT_MAP.md`
(gate line, danger table ×3, coverage paragraph, the GOTMPDIR workaround), `CLAUDE.md`
(Application Control, the `PutTimer` entry, a new D-026 danger zone, LOC, coverage), this file.

## Decisions made

- **W10-g instead of W10-c** — `java` is not on PATH. Checked first, before picking the phase.
- **D-025 addendum — fixed, and the LOC budget was spent to do it.** 963 → 970 is an addition
  without a removal, against the board's own instruction. The argument for doing it anyway: the
  removal that would pay for it is `armTimers` itself, and whether that function should exist is
  D-026's question. Leaving a proven safety bug in place to protect 7 lines of a 37-line budget is
  the wrong trade.
- **D-026 — recorded, not fixed.** It is a topology decision, not a bug fix: either `control-plane`
  grows a durable subscriber on `fam.*.incident` feeding `engine.OnIncidentOpen`, or the two
  binaries share a store — and the second is the thing ADR-002 exists to prevent. Whichever way it
  goes decides whether `armTimers` and `tierFor` belong in the sacred binary at all. And
  `cmd/control-plane` has zero tests, so the characterization this repo's rules demand does not
  exist yet. Full reasoning in `DECISIONS.md`.

## Known broken / deliberately skipped

- **⛔ D-026's topology half is read, not executed.** The routing half is proven by a passing test.
  The store split and the missing subscriber are read from `main.go:264`,
  `control-plane/main.go:71` and `:314`, `ops/docker-compose.yml:114` and `:140`, plus an exhaustive
  grep for bus subscribers — **the compose stack has never been brought up on this machine.**
  Do not quote "no rung ever fires" as measured. Read it yourself before acting on it.
- **⛔ Still nobody's phone has rung, and none can** — 1.35d, RISK 14, unchanged and untouched:
  `KAVACH_FCM_CREDENTIALS` unset, `mobile/google-services.json` absent, no
  `android.googleServicesFile` in `app.json`.
- **`go test -race` was not run** — no gcc on this machine. CI gate 3 only.
- **`go test ./cmd/sos-ingest/` is blocked by Windows Application Control on every run here**, not
  intermittently: three consecutive attempts failed identically on `sos-ingest.test.exe` while
  `internal/store` passed. `GOTMPDIR=/d/Projects/Project_Kavach/backend/.gotmp go test …` is the
  workaround, now in `CLAUDE.md`. CLAUDE.md's "re-run" advice is not sufficient for this package.
- **`escalation` is still not comprehensively covered** — `Cancel` and its duress twin, `Ack`,
  `OnScene`, two-party `Resolve` and the HLC have nothing.
- **`internal/store`'s other nine tables are unpinned.** Two of eleven have tests.
- **`cmd/sos-ingest`'s `replayWAL` and `refreshCache` are unpinned.**
- **1.37 / 1.28 (W10-c) not started** — D-021, unchanged.
- **1.35f(a/b/c) untouched** — no drill flag on the wire, headless alerts are English (D-020), a
  terminated-app action tap is still dropped.

## Next session starts here

- **Check `java -version` first.** With a JDK: **W10-c** — one `Activity` in
  `modules/kavach-t0/android/` (`showWhenLocked`, `turnScreenOn`, `excludeFromRecents`) posted via
  `setFullScreenIntent`, closing **1.37 and 1.28** together. **Without one, do not.**
- **Without a JDK, in order:** (1) **D-026** — and it now outranks everything else on that list,
  because Phase 1's promise is trigger → transmit → notify → **escalate** and the last arrow is not
  connected. Read RISK 16 and D-026 before writing anything. The honest first step is
  `cmd/control-plane`'s **first test**, then a durable subscriber on `fam.*.incident` feeding
  `engine.OnIncidentOpen`. If that lands, `armTimers` and `tierFor` come **out** of `sos-ingest` and
  ~20 lines return to the budget. (2) The rest of `escalation` — `Cancel`'s duress twin deserves the
  care `verifyPin` got. (3) Phase 2's `policyRepo.byVersion()`.
- **First command:**

  ```
  git checkout shivam
  cd backend && GOTMPDIR=./.gotmp go test ./cmd/sos-ingest/ ./internal/escalation/ -v
  ```

  Nothing is outstanding once the branch is pushed.
- **Watch out for:** **every ✅ in W9 is true of the escalation engine in isolation and untrue end
  to end.** The ladder tests pass, the timer wheel tests pass, the claim is atomic and durable — and
  none of it runs for an SOS that arrives at the front door. That is D-026, and it is the single
  most consequential fact about this backend right now.

  Second trap, unchanged since W10-d: **`notify.Fanout` rebuilds `Step` by hand for the neighbour
  feed** (the `reduced` loop in `notify.go`). A field added to `Step` and not named there is dropped
  for neighbours only, so every test on the main path still passes.
