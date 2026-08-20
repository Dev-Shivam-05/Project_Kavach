# HANDOFF — Kavach — Phase 1 (W10-i, D-027 closed; the arrow connects) — 2026-08-20

Branch **`shivam`**, 6 new commits on top of `b1a416bb`. Session W10-h's handoff is superseded by
this one; its content is in commit `b1a416bb`.

**W10-c was not started, again, and for the same reason.** First command of the session was
`java -version` — not found, `JAVA_HOME` and `ANDROID_HOME` unset (D-021). The board's instruction
for that case named D-027 as the next item, and that is what this session did.

**An SOS posted to the `sos-ingest` binary now climbs the escalation ladder in the `control-plane`
binary.** That has never been true before today.

## The decision (this phase was a decision before it was code)

D-027 offered three routes and two of them needed an ADR amended, so it was put to the user as a
spec-lock table. **Route chosen: make the file bus multi-process, stdlib only.** Not NATS —
`backend/go.mod` keeps zero `require` lines (ADR-003/ADR-006) and the stack grows a broker. Not
"admit it is single-process" — that is not a compose comment but a merge of three binaries, because
`realtime-gw` subscribes to tickets the control plane mints and the canary to frames escalation
publishes, and it *still* would not connect `sos-ingest`.

**D-027's own estimate of the chosen route was wrong, in our favour.** It said this needed
`syscall.LockFileEx`/`Flock` behind build tags. It does not: `O_APPEND` makes the kernel place each
record at the end of the file under its own lock. That was measured before anything was designed —
a throwaway probe, two OS processes, 500 records each, 1000 intact, no overwrite.

## Done

- **`internal/wal` has tests — 19, its first ever** (`wal_test.go` 10, `shared_test.go` 9). The ten
  came **first**, before a line of the file changed, because it is the file ADR-002 rests on: the
  8-byte header, the length+CRC framing, the `Append`-offset/`ReadAt` contract, refusal of empty and
  oversize records, survival across close/reopen, `ErrClosed` everywhere, and both crash-repair
  paths. One of them, `TestReplayReadsOnlyUpToThisInstancesOwnSize`, is D-027's root cause stated in
  `wal`'s own terms — and it still passes, because `Open` (single-writer, `sos.wal`) is untouched.
- **`wal.OpenShared`** (`216f644e`) — the multi-process mode, opt-in, used only by the bus.
  `O_APPEND` and one whole record per `Write`; `Tail(from, fn)` re-stats the file and stops without
  error at a record that is not yet whole. Four things that were not in D-027's estimate:
  1. **The writer no longer knows where its record went.** On Windows the handle's own pointer
     counts only that process's writes — measured — so `Append` returns `-1` in shared mode rather
     than a number that is right on Linux and wrong where the tests run. Nothing read it.
  2. **Windows will not truncate through an `O_APPEND` handle** (`FILE_APPEND_DATA` without
     `FILE_WRITE_DATA`); torn-tail repair opens its own.
  3. **A short tail is no longer evidence of a crash** — it is usually another process mid-`Write` —
     so repair settles 20 × 5 ms before truncating.
  4. **The header is written once**, by whoever wins `O_EXCL`, not by every booting container.
- **`internal/bus` crosses a process** (`df23c001`). `poll()` tails the file on the 250 ms ticker it
  already had; records enter `b.msgs` there and in `publish`, nowhere else. **`Seq` is now the
  record's ordinal in the file**, not `len(b.msgs)+1` on whichever instance published — a cursor
  *is* a `Seq`, so two processes may not have two names for one record. `publish` reads its own
  record back to learn it, which is also why an in-process subscriber is still woken immediately
  instead of 250 ms later.
- **`crossprocess_test.go` is the same file, inverted.** Its W10-h version promised to fail and name
  the sentence that stopped being true, and it did, both of them — `the second instance received
  "i-sos"` and `seq 1 and 2 … no longer collide`. That red is in the run log above the commit.
- **The inference is retired.** `TestTwoRealProcessesAppendToOneSharedLog` and
  `TestTwoRealProcessesOnOneBusDirectory` **re-execute the test binary as a second OS process**.
  D-027 was measured with two values in one binary and said honestly that containers behaving the
  same way was an inference. It is not one now.
- **`ops/e2e-two-binaries.sh`** (`d8b46e88`) — the two real binaries, one `KAVACH_BUS_DIR`, a real
  SOS to sos-ingest's HTTP front door. Run six times:

  ```
  ack           {"verified":false,"flags":1}          ADR-018: accept, flag, count
  control-plane ingest_incident_projected             it heard the other process
                timer_armed AUTO_QUIESCE, CANCEL_WINDOW
  +20s          transition CANCEL_WINDOW_EXPIRED      PENDING -> ACTIVE_L1
                timer_armed REPEAT_L1, SMS_TIER, ESCALATE_L2, ESCALATE_L3
                fanout tier=1 label=L1 devices=0
  ```

- **A bug my own test caught, and the first fix for it was wrong.** `cursors.json` is shared, and
  each process holds a copy loaded at `Open`, so writing that copy back reset the *other* process's
  durables to where they stood at boot. Merge-on-write was the obvious answer and it is not
  sufficient: `TestADurableCursorIsNotErasedByAnotherProcess` failed on roughly one run in six with
  `cursors.json = map[sos-ingest.projector:1]`, because two processes that both read before either
  renamed still lose a key. It is **one file per durable** now — `bus/cursors/<name>.cursor` — and
  `SubscribeDurable` refuses a name that cannot be a filename. A legacy `cursors.json` is still read
  at boot so an upgrade resumes instead of replaying.
- Verified green: `go build`, `go vet ./...`, `staticcheck ./...`, `go test ./...` (wal **19**, bus
  **10**, control-plane **9**, sos-ingest **27**, escalation **69**, store **21**), `internal/bus`
  at `-count=6`, `archlint` (14 packages, **54** edges), `TestLOCBudget` **970/1000**, `schema-lint`,
  `protolint`, `gen:check`, `tsc --noEmit`, `npm test` **165/165**.

## Files changed

**Backend**
- `internal/wal/wal.go` — `OpenShared`/`open(path, shared)`, `Tail`, `endLocked`, `createShared`,
  `awaitHeader`, `repairTo`, `walk` split out of `scan`. 344 → **~470**.
- `internal/wal/wal_test.go` **(new, 10 tests)** · `internal/wal/shared_test.go` **(new, 9)**.
- `internal/bus/bus.go` — `wal.OpenShared`, `poll`, `tailLocked`, `readOff`, `TailErrors`,
  `writeCursors`/`loadCursors`/`cursorPath`/`safeDurable`; `publish` no longer assigns `Seq`.
- `internal/bus/crossprocess_test.go` — inverted; 3 tests → **10**.

**Ops** — `ops/e2e-two-binaries.sh` **(new)**; `docker-compose.yml`'s bus comment is true now and
says what keeps it true; `README.md` gains the cursor-directory layout and the e2e recipe.

**Docs** — `DECISIONS.md` (D-027 W10-i addendum), `RISK.md` (16 and 17 **closed**, 4 loses `wal`),
`PHASES.md` (Now, the queue reordered), `PROJECT_MAP.md`, `ADR-007`, `CLAUDE.md`, this file.

## Decisions made

- **W10-i instead of W10-c** — `java` is not on PATH. Checked first, before picking the phase.
- **The user chose the route**, from a table with the ADR cost of each spelled out. Two of the three
  needed an accepted ADR amended, which is not a call to make while implementing.
- **`Open` was left alone.** The multi-writer mode is opt-in, so `sos.wal` — ADR-002's durability
  file — writes exactly as it did, and its ten characterization tests pass unmodified. Do not
  "unify" the two modes.
- **Per-durable cursor files over merge-on-write**, once the merge was measured losing. A format
  change beats a spin loop in a file that decides whether a family is woken twice.
- **The e2e script is committed rather than described.** It seeds `family.json` by hand — RISK 18 —
  with a comment saying to delete that helper the day a real seed route exists, because a fixture
  that outlives the gap it works around is why nobody closes the gap.

## Known broken / deliberately skipped

- **⛔ `docker compose up` has still never been run on this machine.** Docker's daemon is not
  running (`failed to connect to the docker API at npipe:…dockerDesktopLinuxEngine`). Everything
  above is Go tests plus **two binaries on one host** — not four containers. This is now the single
  weakest claim in the repo and it is #1 on the queue.
- **⛔ Still nobody's phone has rung, and none can** — `devices 0` in that fanout line is correct:
  no device is enrolled, `KAVACH_FCM_CREDENTIALS` is unset, `mobile/google-services.json` absent.
  1.35d, RISK 14, unchanged.
- **⛔ No running binary can create a family** — RISK 18, unchanged and now load-bearing: the e2e
  script only gets past it by writing `family.json` directly, and a real `docker compose up` will
  drop every incident at WARN until it is closed.
- **`realtime-gw`'s socket frames and the canary's chain have still never been observed.** They now
  rest on a transport that works; nobody has watched either.
- **`go test -race` was not run** — no gcc on this machine. CI gate 3 only.
- **The Windows Application Control policy blocks re-exec intermittently.** Both real-process tests
  skip — and only for that one error string — when it does; they run on Linux and in CI. If you see
  it, `go test -c -o .gotmp/bus.test.exe ./internal/bus/` and run the binary directly.
- **`armTimers` and `tierFor` are still in `sos-ingest`** — dead weight now, ~20 lines against a
  1000-line ceiling. Queued at #3, not taken.
- **`escalation` is still not comprehensively covered** — `Cancel` and its duress twin, `Ack`,
  `OnScene`, two-party `Resolve`, the HLC.
- **1.37 / 1.28 (W10-c) not started** — D-021, unchanged. **1.35f(a/b/c) untouched.**

## Next session starts here

- **Check `java -version` first.** With a JDK: **W10-c** — one `Activity` in
  `modules/kavach-t0/android/` (`showWhenLocked`, `turnScreenOn`, `excludeFromRecents`) posted via
  `setFullScreenIntent`, closing **1.37 and 1.28**. **Without one, do not.**
- **Without a JDK, in order:** (1) **Start Docker Desktop and bring `ops/docker-compose.yml` up.**
  It is the only claim left in this repo that has never once been executed, and W10-i's whole lesson
  is what one run is worth against a plausible sentence. Expect RISK 18 to stop you immediately.
  (2) **Enrolment — `POST /v1/family` and a device** (RISK 18, §W4): the difference between a ladder
  that climbs and a phone that rings. (3) `armTimers`/`tierFor` out of `sos-ingest`. (4) The rest of
  `escalation`.
- **First command:**

  ```
  git checkout shivam
  bash ops/e2e-two-binaries.sh /tmp/kavach-e2e
  ```

  Nothing is outstanding once the branch is pushed.
- **Watch out for:** **three things hold the seam open, and breaking any one leaves every in-process
  test green** — `O_APPEND` on `stream.wal` (never `WriteAt`), `bus.poll()` tailing the file, and
  `Seq` being the record's ordinal in the file. A record split across two `Write` calls reopens
  D-027 silently.

  Second trap, unchanged since W10-d: **`notify.Fanout` rebuilds `Step` by hand for the neighbour
  feed** (the `reduced` loop in `notify.go`). A field added to `Step` and not named there is dropped
  for neighbours only, so every test on the main path still passes.
