# HANDOFF — Kavach — Phase 1 (W10-h, D-026's bus leg closed; D-027 found) — 2026-08-20

Branch **`shivam`**, 5 new commits on top of `580f24e8`. Session W10-g's handoff is superseded by
this one; its content is in commit `580f24e8`.

**W10-c was not started, again, and for the same reason.** First command of the session was
`java -version` — not found, `JAVA_HOME` and `ANDROID_HOME` unset (D-021). The board's instruction
for that case named D-026 as the next item, and that is what this session did.

It closed two of D-026's three breaks — and found that the third one was never the real problem.

## Done

- **`newServer` is extracted from `main()`** (`607bcdc3`). A pure move: same order, same log events,
  same failure behaviour. It exists because "does this binary subscribe to anything" is a question
  about wiring, and the wiring was inline in `main()` between a listener and a signal handler.
- **`cmd/control-plane` has tests** — its first, ever. Nine of them (`main_test.go`). The matched
  pair is the point: `POST /v1/incidents` arms all five rungs, and the same incident published on
  `fam.*.incident` **armed nothing**. That second test landed green, in its own commit
  (`ae6dc1f7`), *before* the fix — the red is in the history, not only in prose.
- **D-026's bus leg is closed** (`23989003`). `cmd/control-plane` now holds a durable subscription
  on `fam.*.incident` (`control-plane.incidents`, `StartAll`) whose handler projects the incident
  into its own store and calls `engine.OnIncidentOpen`. **The action-name leg closed with it, by
  construction**: the engine mints its own rungs, so what lands on disk is
  `REPEAT_L1`/`SMS_TIER`/`ESCALATE_L2`/`ESCALATE_L3`/`AUTO_QUIESCE` — names `execute` has cases for
  — and never the `NO_ACK` `armTimers` derives.
- **Three judgement calls inside that handler, each of which could have gone the other way.**
  1. **The redelivery guard is "has rungs", not "exists".** `escalation.arm` mints a fresh UUID per
     rung, so an unguarded second delivery appends *a whole second ladder* — D-025's mirror image,
     and `StartAll` replays the whole stream at every boot, which makes it the ordinary case. But
     guarding on existence alone would strand an incident whose projection died between
     `PutIncident` and `OnIncidentOpen`: recorded, unarmed, skipped forever. A re-arm re-reads the
     **stored** incident, so it cannot rewind a ladder that has already climbed.
  2. **`initialState` is now one function**, shared with the HTTP front door so the two cannot
     drift. DURESS skips the cancel window (§7.5); everything else gets the server's own copy of it,
     which is what `defaultCancelWindowS` already said it was for — "the device may be underwater".
  3. **An unknown family drops with a WARN and does not retry** — the same call `sos-ingest`'s
     projector makes on the same question. Retrying parks a poison record in front of every other
     family's incidents.
- **⛔ D-027 — no message in this system has ever crossed a process.** Found while wiring the above,
  and it is bigger than the thing it was found under. `internal/bus` has its first tests
  (`crossprocess_test.go`, 3), and they measure:
  - `Open` replays `stream.wal` **once**, at boot, into `b.msgs` (`bus.go:113`); `publish` appends
    to that slice (`bus.go:190`); `drain` walks it and nothing else (`bus.go:425`). **Nothing tails
    the file.** A second `*Bus` on the same directory receives nothing — not late, absent.
  - Both instances assign **`Seq` 1** to different messages.
  - The write offset is fixed at `Open` (`wal.go:75`) and the file is opened `O_RDWR|O_CREATE` — no
    `O_APPEND`, no lock, and `w.mu` is an in-process mutex. Two live writers land every record at
    the same offset and **overwrite each other**. Reopening the directory afterwards finds **one
    survivor**; in compose the erased record is the SOS `sos-ingest` fsynced and acked.
  So the four containers in `ops/docker-compose.yml` are four programs that each work alone, and
  that file's comment claiming "the shared directory IS the seam" was false. **Recorded, not
  fixed** — RISK item 17, D-027.
- Verified green: `go build`, `go vet ./...`, `staticcheck ./...`, `go test ./...`
  (control-plane **9**, bus **3**, sos-ingest **27**, escalation **69**, store **21**), `archlint`
  (14 packages, **54** edges), `TestLOCBudget` **970/1000**, `logx` deny-list, `gen:check`,
  `schema-lint`, `protolint`, `tsc --noEmit`, `npm test` **165/165**.

## Files changed

**Backend**
- `cmd/control-plane/main.go` — `newServer`/`serverConfig` extracted from `main()`; `initialState`
  extracted from `openIncident`; `subjFamIncident` + `incidentsDurable`; `incidents *bus.Sub` on
  `server`; `ingestRecord` + `onIngestedIncident` (~120 lines); drain on shutdown. 1708 → **1911**.
- `cmd/control-plane/main_test.go` **(new, 296 lines)** — 9 tests. `newPlane` builds through
  `newServer`; `sosIngestOpen` synthesises the bus message; `armedActions`, `waitForRungs`.
- `internal/bus/crossprocess_test.go` **(new, 165 lines)** — 3 tests, the package's first.

**Ops** — `ops/docker-compose.yml`: the bus comment was a false claim and is now where D-027 is
explained.

**Docs** — `DECISIONS.md` (D-026 addendum, D-027), `RISK.md` (item 16 updated, **new S1 items 17
and 18**, items 4 and 7 updated), `PHASES.md` (the Now blocker rewritten around D-027, the W10-h paragraph,
the queue reordered, the W9 heading, 1.29, a new board rule), `PROJECT_MAP.md` (danger table ×3,
coverage), `CLAUDE.md` (the bus danger zone replaces the old D-026 one, coverage), this file.

## Decisions made

- **W10-h instead of W10-c** — `java` is not on PATH. Checked first, before picking the phase.
- **The subscriber, not a shared store.** ADR-002 exists to stop the second one. The bus is the
  seam and each binary keeps its own store; the control plane projects what it hears.
- **Shipped the leg knowing D-027 stops it at the container boundary.** The alternative — hold the
  fix until the transport is decided — leaves a phase with no functional change and a decision
  nobody has the evidence to make. What is *not* allowed is the tick, so the test file, the commit
  message, `DECISIONS.md`, `RISK.md`, `PROJECT_MAP.md`, `CLAUDE.md` and the board each say in their
  own words that these nine green tests stop at one process.
- **D-027 recorded, not fixed.** Three routes, none phase-sized: real NATS (a `require` line
  `go.mod` may not take), a tailing reader plus a cross-process write lock (build-tagged `syscall`
  work in a package whose only tests are the three written today), or admitting the stack is
  single-process. It is a decision before it is code.
- **`armTimers` left in place.** Its rungs are now dead weight rather than a broken ladder, and
  deleting it means deciding what `projector_test.go`'s four tests become. Queued at #2, not taken.

## Known broken / deliberately skipped

- **⛔ D-027 is measured in-process, with two `*Bus` instances standing in for two containers.**
  What is *measured* is that the transport cannot work across instances; what is *inferred* is that
  containers behave as separate instances do — which follows from their having no shared memory,
  but **the compose stack has still never been brought up on this machine.** Read
  `internal/bus/crossprocess_test.go` before acting on it.
- **⛔ D-026 is not closed.** Its bus leg and action-name leg are. Its premise — that the two
  binaries can talk — is what D-027 falsified.
- **⛔ Still nobody's phone has rung, and none can** — 1.35d, RISK 14, unchanged and untouched:
  `KAVACH_FCM_CREDENTIALS` unset, `mobile/google-services.json` absent, no
  `android.googleServicesFile` in `app.json`.
- **`go test -race` was not run** — no gcc on this machine. CI gate 3 only.
- **`go test ./cmd/sos-ingest/` still needs the `GOTMPDIR` workaround** in `CLAUDE.md`. It was run,
  and it passes: 27 tests, `TestLOCBudget` 970/1000.
- **⛔ No running binary can create a family** — **RISK item 18, new.** Noticed while writing the
  seed helper and then checked properly: `store.PutFamily` has zero non-test call sites, there is
  only `GET /v1/family`, no seed script, and nothing runs the migration. Both incident projectors
  gate on the family row, so on a freshly deployed stack *every* incident is dropped at WARN. Fixing
  it is one route or one command, but which is an enrolment-flow decision (§W4), so it is recorded
  and not plugged. Verified by grep and the route table; **not** verified against a running stack.
- **~30 control-plane routes are still unpinned.** Nine tests is a place to hang the next one.
- **`escalation` is still not comprehensively covered** — `Cancel` and its duress twin, `Ack`,
  `OnScene`, two-party `Resolve` and the HLC have nothing.
- **`internal/store`'s other nine tables are unpinned**; `cmd/sos-ingest`'s `replayWAL` and
  `refreshCache` are unpinned; `internal/{wal,consent}` and `cmd/{realtime-gw,canary}` have no tests.
- **1.37 / 1.28 (W10-c) not started** — D-021, unchanged.
- **1.35f(a/b/c) untouched** — no drill flag on the wire, headless alerts are English (D-020), a
  terminated-app action tap is still dropped.

## Next session starts here

- **Check `java -version` first.** With a JDK: **W10-c** — one `Activity` in
  `modules/kavach-t0/android/` (`showWhenLocked`, `turnScreenOn`, `excludeFromRecents`) posted via
  `setFullScreenIntent`, closing **1.37 and 1.28** together. **Without one, do not.**
- **Without a JDK, in order:** (1) **D-027**, and it outranks everything, because it is the reason
  Phase 1's last arrow still does not connect in a deployment. Read RISK 17 and D-027 first, and
  consider actually bringing the compose stack up — everything about it is measured in-process and
  reasoned about across containers. It is a *decision* first: NATS, a tailing reader with a
  cross-process lock, or an honest admission that the stack is single-process. (2) Take `armTimers`
  and `tierFor` **out** of `sos-ingest` — ~20 lines back into the ADR-002 budget, and the phase is
  really "decide what `projector_test.go`'s four tests become". (3) The rest of `escalation` —
  `Cancel`'s duress twin deserves the care `verifyPin` got. (4) Phase 2's `policyRepo.byVersion()`.
- **First command:**

  ```
  git checkout shivam
  cd backend && go test ./internal/bus/ ./cmd/control-plane/ -v
  ```

  Nothing is outstanding once the branch is pushed.
- **Watch out for:** **an in-process green test is not an end-to-end green.** Nine control-plane
  tests and three bus tests pass, and the escalation ladder still does not climb for a real SOS in
  `ops/docker-compose.yml`. That is D-027, and it is now the single most consequential fact about
  this backend — it is also true of `realtime-gw`'s socket frames and the canary's chain, neither of
  which anyone has checked.

  Second trap, unchanged since W10-d: **`notify.Fanout` rebuilds `Step` by hand for the neighbour
  feed** (the `reduced` loop in `notify.go`). A field added to `Step` and not named there is dropped
  for neighbours only, so every test on the main path still passes.
