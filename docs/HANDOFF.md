# HANDOFF — Kavach — Phase 1 (W10-d, CLAIM/RELEASE over push) — 2026-08-11

Branch **`phase1-w10-remote-push`**, 4 new commits, **pushed** (`2a912d78..a74fa0d7`). The first two
push attempts died on `Failed to connect to github.com port 443`; the third went through, so treat
that error here as flaky network and retry rather than diagnose. Session W10-b's handoff is
superseded by this one; its content is in commit `2a912d78`.

**W10-c was not started, and that was the session's first decision.** Its entire output is Kotlin,
this machine has no JDK and no Android SDK, and no CI gate here compiles Kotlin (D-021) — so
`npm run verify` would have gone green over a file no compiler had ever read. 1.32 was chosen
instead because it is the last piece of W10 that Go/TypeScript gates can actually check.

## Done

- **A CLAIM now reaches a phone whose app is closed.** `Claim()` published one bus frame and
  stopped, so §2.6.4's "fan-out of CLAIM goes over BOTH channels simultaneously — never rely on only
  one; a backgrounded device may have no WS" was written down and not built. It now calls
  `notifyStep` with WS+FCM+APNs+PushKit, tier 1 (the ladder has *stopped*; this must not read as an
  escalation in the after-action matrix) and no billable channel.
- **The receiving phone presents it as the ladder stopping, not as a second emergency.** `claimed`
  dismisses the alert and posts a persistent quiet banner: *"Rohan is responding. Stand by."* — the
  copy already in `i18n` as `panic.responding`, and the sentence P-003 exists to produce.
- **F-21 grew by exactly two fields, `kind` and `ownerShortName` (D-022).** The original five could
  not say what a push was *about*, which is why 1.32 sat open for three sessions with both halves of
  the wire built. Both are allowlisted fail-closed twice: `assertPushSafe` on the server,
  `readPushFields` on the device.
- **Unknown `kind` rings, on both sides.** A claim shown as an alert costs one wasted siren; an
  alert shown as a quiet banner costs the alert. Asserted in Go and in TS.
- **A pre-existing wording bug was fixed as a side effect.** Both `reactToOwnState` and
  `reactToRemoteState` re-posted the ALERT on `OWNED`, on the alarm channel, still reading
  "NOBODY HAS RESPONDED YET" — while somebody demonstrably had. Both now route through one
  `notifyOwnership()`, the same composer the push path uses.
- **`internal/escalation` has tests for the first time.** 1,140 lines that decide whether a human is
  woken had none (RISK §4). Six characterization tests passed against unchanged code, then three new
  requirement tests were shown failing before the behaviour changed.
- Verified green: `go build`, `go vet ./...`, `go test ./...`, `archlint`, `tsc --noEmit`,
  `npm test` **165/165** (was 158), `gen:check`, `schema-lint`, `protolint`.

## Files changed

**Backend**
- `internal/escalation/claim_test.go` **(new, ~430 lines)** — the package's first tests. Pins OWNED,
  owner + t4, ladder halted with auto-quiesce *kept* (F-02), watchdog armed, CRITICAL bus frame,
  refused claim mutates nothing — then states the push requirement.
- `internal/escalation/engine.go` — `Claim()` fans out; `Release()` marks its rung `KindReleased`.
- `internal/notify/notify.go` — `Kind` (zero value = alert, so no existing call site changes
  meaning), `Step.Kind`, `pushPayload` gains both fields, `kind` threaded through
  `dispatch → startLeg → sendPush`, **and copied into the reconstructed neighbour Step** — that
  reconstruction silently drops any field not named in it.
- `internal/notify/fcm.go` — `pushSafeKeys` +2, header prose.
- `internal/notify/fcm_test.go` — 5 new tests incl. the neighbour-leg regression and "an alert still
  carries no owner name".
- `internal/store/store.go` — the `PushTokenFCM` comment enumerated the five; corrected.

**Mobile**
- `src/state/notifications.ts` — `CHANNEL_OWNERSHIP`, `presentOwnershipBanner`, `notifyOwnership`,
  `notifyOwnershipFromPush`, `OwnershipAlertFields`; `clearIncident` takes the banner down too;
  the foreground handler keeps `kavach.ownership.` silent.
- `src/state/pushReceive.ts` — `PushKind`, `asKind`, both new fields read through the allowlist.
- `src/state/store.ts` — `ownerOf()`; both `OWNED` branches route through `notifyOwnership`.
- `test/push-receive.test.ts` — 7 new tests. `test/shim.mjs` — `dismissNotificationAsync` is now
  recorded (`__dismissed()`), because "siren off, banner on" is an ordering claim.

**Docs** — `02-System-Architecture.md` §2.6.3 (the payload's naming authority), `DECISIONS.md`
(D-022, D-023), `PHASES.md`, `PROJECT_MAP.md`, `CLAUDE.md`, this file.

## Decisions made

- **W10-d instead of W10-c** — the board's entire "Next 3" (W10-c, 1.16/1.17, 1.13) is Kotlin, and
  none of it is checkable here. 1.32 was the last non-native item in the weakest week.
- **D-022 — F-21's five become seven.** The alternative was leaving CLAIM socket-only, which
  abandons the requirement for the one device push exists to serve. Neither field is inferable from
  duress: a claim happens identically on duress and non-duress incidents.
- **D-023 — the ownership banner gets its own Android channel.** P-030 wants quiet + persistent +
  lock-screen-readable at once. The emergency channel rings (its whole point), the health channel is
  `PRIVATE` so "Rohan is responding" would render as "Notification", and Android cannot re-tune an
  existing channel's importance or visibility after creation. Dismiss-then-post rather than
  replace-in-place, because cross-channel replacement cannot be verified from this checkout and its
  failure mode is a phone that keeps screaming.

## Known broken / deliberately skipped

- **⛔ Still nobody's phone has rung, and none can.** — *because* 1.35d: no Firebase project, no
  `mobile/google-services.json`, **no `android.googleServicesFile` key in `app.json`**, and
  `KAVACH_FCM_CREDENTIALS` unset. All four re-verified missing this session. RISK item 14.
- **The banner has never been seen on a screen.** — *because* the same blocker. Every claim
  assertion in this session is off-device: channel id, sticky, sound, dismissal order and copy are
  asserted against a stub, not against Android. §3.8's UI bar is a screenshot of each state.
- **1.37 / 1.28 (W10-c) not started.** — *because* D-021. Unchanged.
- **`go test -race` was not run.** — *because* there is no gcc on this machine. CI gate 3 only.
- **`escalation` is still 90% unpinned.** — *because* scope. `claim_test.go` covers CLAIM and
  RELEASE; the ladder, the timer wheel, `FireTimer` claiming and two-party resolution have nothing.
- **1.35f(a/b/c) untouched** — no drill flag on the wire, headless alerts are English (D-020), a
  terminated-app action tap is still dropped.

## Next session starts here

- **Phase 1, W10-c** — *if and only if* you are on a machine with a JDK and an Android SDK. One
  `Activity` in `modules/kavach-t0/android/` (`showWhenLocked`, `turnScreenOn`,
  `excludeFromRecents`) posted via `setFullScreenIntent`, closing **1.37 and 1.28** together.
  **On this machine, do not.** The next verifiable items instead: pin the escalation ladder and
  timer wheel with characterization tests, or Phase 2's `policyRepo.byVersion()`.
- **First command:**

  ```
  git checkout phase1-w10-remote-push && cd mobile && npm run verify
  ```

  Nothing is outstanding — the branch is pushed. Before writing a line of W10-c, confirm the
  blockers:
  `echo $env:KAVACH_FCM_CREDENTIALS` · `Test-Path mobile/google-services.json` ·
  `Select-String -Path mobile/app.json -Pattern googleServicesFile` · `java -version`.
- **Watch out for:** **the board's next three items are all Kotlin.** W10-c, the hardware triggers
  (1.16/1.17) and the exact-alarm watchdog (1.13) cannot be compiled, run or checked from this
  checkout, and every green tick you are used to seeing will still be green over code no compiler
  has read. Check `java -version` *before* picking a phase, not after — that check is what turned
  this session into W10-d instead of three days of unverifiable Kotlin.

  Second trap, specific to what just landed: **`Fanout` rebuilds the `Step` for the neighbour feed
  by hand** (`notify.go`, the `reduced` loop). Any field added to `Step` and not named there is
  silently dropped for neighbours only — which for `Kind` would have meant a neighbour woken on the
  alarm stream to be told nothing is needed. There is a test for that one; the next field added
  needs its own.
