# HANDOFF — Kavach — Phase 1 (W10-e, the ladder and the timer wheel get tests) — 2026-08-11

Branch **`phase1-w10-remote-push`**, 3 new commits (`187d3110`, `d3e7751b`, `a8953225`) on top of
W10-d's `a285a031`. Session W10-d's handoff is superseded by this one; its content is in commit
`a285a031`.

**W10-c was not started, again, and for the same reason.** The first command of the session was
`Get-Command java` — not found, `JAVA_HOME` and `ANDROID_HOME` unset (D-021). Its entire output is
Kotlin that nothing here can compile and no CI gate can check. The board's own instruction for that
case — pin the escalation ladder and the timer wheel — is what this session did instead. It shipped
no feature. It bought the right to change the file that decides whether a human is woken.

## Done

- **`internal/escalation` is now the best-covered package in the backend.** 40 new tests over the
  1,140 lines that run the ladder; the package runs **49 test functions / 68 cases**, all green.
  `claim_test.go` (W10-d) had covered CLAIM and RELEASE and nothing else.
- **The ladder is pinned as behaviour, not as code shape** (`ladder_test.go`, 24 tests). What
  `OnIncidentOpen` arms from each entry state; every rung's tier, channels and state guard; the
  §2.5.6 cancel-window table trigger by trigger including the unknown-trigger fallback; F-02's death
  date at birth; the P-030 watchdog reclaim clearing the owner and re-arming L3; terminal *and*
  merged incidents disarming the rest of the ladder; t3 stamped by the first rung and never
  overwritten.
- **Two divergence guards that no other test would have caught.** `Ladder()` — the shape devices
  cache so an offline phone escalates on the server's schedule — is asserted rung-for-rung against
  the timers the server actually arms. And the four ladder timings are asserted to come *from
  `incident.Transitions`*, not from a constant in `engine.go`: a hardcoded `90` would pass every
  other test in the file and silently split the two planes (§2.5.5).
- **The timer wheel is pinned** (`timer_test.go`, 16 tests). Claim exclusivity on **both** paths —
  the transactional `FireTimer` and the optimistic fallback — including two engines racing one row
  and eight goroutines polling one timer; fire order oldest-first; the batch limit deferring rather
  than dropping; the §2.11.5 P0 page at 61 s late and no page at 59 s; re-arm 5 s out on failure and
  abandon after three; the F-13 adaptive poll, all four branches; and the real worker pool finding a
  row with no leader and stopping with its context.
- **The characterization pass found a real gap and closed it (D-024).** The SMS rung's guard skipped
  `PENDING` and `OWNED` and let `RESOLVING` through. `cancelTimers` only rewrites rows still marked
  `pending`, so a rung a worker had already claimed when the owner reported ON_SCENE survives every
  cancel — and would spend a billable A2P message to escalate an incident somebody is standing over.
  Shown failing at `187d3110`, one-line guard at `d3e7751b`, 68/68 green after.
- Verified green: `go build`, `go vet ./...`, **`staticcheck ./...`** (it *is* installed on this
  machine: `C:\Users\shiva\go\bin\staticcheck.exe` — the previous handoffs' "static analysis is CI
  only" applies to `-race`, not to this), `go test ./...`, `archlint` (14 packages, **42** edges),
  `TestLOCBudget` 963/1000, `logx` deny-list, `gen:check`, `schema-lint`, `protolint`,
  `tsc --noEmit`, `npm test` **165/165**.

## Files changed

**Backend**
- `internal/escalation/ladder_test.go` **(new, 810 lines)** — the rungs. Also holds the shared
  `testClock`, `rig`/`rigWith` and `atState` helpers that `timer_test.go` uses.
- `internal/escalation/timer_test.go` **(new, 469 lines)** — the wheel. Adds `claimingStore` (a
  store that offers the transactional claim) and `failingFanout`.
- `internal/escalation/engine.go` — **9 lines**: `ActionSMSTier` now also skips `RESOLVING`, with
  the reason inline.

**Docs** — `PHASES.md` (Now, Next 3, 1.29, 1.31, the board rule), `RISK.md` §4 (escalation off the
no-tests list; ~5,400 LOC → ~4,300), `PROJECT_MAP.md` (gates re-verified, danger table, coverage
paragraph), `DECISIONS.md` (D-024), `CLAUDE.md`, this file.

## Decisions made

- **W10-e instead of W10-c** — `java` is not on PATH. Checked first, before picking the phase, which
  is the discipline W10-d established and the board now states as a warning.
- **D-024 — the SMS rung's state guard covers `RESOLVING` too.** The alternative was to leave the
  hole documented in a test comment. It is a one-line guard in the same statement as the two that
  were already there, in a file whose whole job is deciding whether to wake somebody, and the fix
  was shown red first. Full reasoning in `DECISIONS.md`.
- **Rungs are tested through `execute`, the wheel through `pollOnce`.** Driving rung semantics
  through the poller means ladder ordering interferes with every assertion (five due timers fire in
  FireAt order and the state moves under you). Splitting them keeps each test about one thing.
- **The tests use a movable clock, never `time.Sleep`.** The one exception is the worker-pool test,
  which must run the real `Run` loop; it polls for its condition with a 2 s deadline rather than
  sleeping a fixed amount.

## Known broken / deliberately skipped

- **⛔ Still nobody's phone has rung, and none can.** — *because* 1.35d. Re-verified again this
  session: `KAVACH_FCM_CREDENTIALS` unset, `mobile/google-services.json` absent, no
  `android.googleServicesFile` in `app.json`. RISK item 14. Unchanged and not touched by this work.
- **`store.Store.FireTimer` — the real atomic claim — still has no test.** `timer_test.go` proves
  the *engine* prefers the transactional path and that the path is exclusive, but it does so against
  a hand-written double. The production implementation (`store.go:918`) is exercised by nothing.
  That is the natural next hour of work and it is one test file.
- **`escalation` is still not comprehensively covered.** `Cancel` and its duress twin, `Ack`,
  `OnScene`, two-party `Resolve` (including `ErrSameParty`) and the HLC have nothing. `Reescalate`
  is touched by exactly one assertion, about its `Kind`.
- **`go test -race` was not run.** — *because* there is no gcc on this machine. CI gate 2 only. The
  concurrency tests here (8 goroutines on one row, the 4-worker pool) are exactly the ones that
  would benefit; they pass without the detector, which is not the same as being proven race-free.
- **1.37 / 1.28 (W10-c) not started.** — *because* D-021. Unchanged.
- **1.35f(a/b/c) untouched** — no drill flag on the wire, headless alerts are English (D-020), a
  terminated-app action tap is still dropped.

## Next session starts here

- **Check `java -version` first.** With a JDK: **W10-c** — one `Activity` in
  `modules/kavach-t0/android/` (`showWhenLocked`, `turnScreenOn`, `excludeFromRecents`) posted via
  `setFullScreenIntent`, closing **1.37 and 1.28** together. **Without one, do not.**
- **Without a JDK, in order:** (1) `store.Store.FireTimer` and the timer rows' disk contract — the
  claim primitive the whole no-leader design rests on, currently proven only against a double;
  (2) the rest of `escalation` — `Cancel`'s duress twin is a constant-time sibling and deserves the
  same care `verifyPin` got; (3) Phase 2's `policyRepo.byVersion()`.
- **First command:**

  ```
  git checkout phase1-w10-remote-push && cd backend && go test ./internal/escalation/ -v
  ```

  Nothing is outstanding — the branch is pushed.
- **Watch out for:** **`cancelTimers` cannot cancel a rung a worker already holds.** It only
  rewrites rows still marked `pending`, and a claimed row is `fired`. Every guard at the top of an
  `execute` branch exists for that window, and D-024 was one of them being one state short. If you
  add a state to `spec/state-machine.yaml`, each of those guards is a decision you have to make on
  purpose — the compiler will not ask you.

  Second trap, unchanged from W10-d and still live: **`notify.Fanout` rebuilds `Step` by hand for
  the neighbour feed** (the `reduced` loop in `notify.go`). A field added to `Step` and not named
  there is dropped for neighbours only, so every test on the main path still passes.
