# HANDOFF — Kavach — Phase 1 (W10-b, remote push: receive side) — 2026-08-11

Branch **`phase1-w10-remote-push`**, 5 commits, **not pushed** at the time of writing. Session
W10-a's handoff is superseded by this one; its content is in commit `a4e0ab0e`.

## Done

- **A killed app now consumes a data-only FCM message and presents the alert.** The task
  `kavach.push.incident` is defined with `TaskManager.defineTask` **in module scope** and registered
  with `Notifications.registerTaskAsync`; `mobile/index.ts` imports it **before**
  `expo-router/entry`. That order is the whole feature: ES modules evaluate in source order, and
  `expo-task-manager` looks the task up by name the moment it finishes loading the bundle — so a
  task defined from a screen or an effect is defined too late on the one launch that matters.
- **The client refuses to believe the payload.** `readPushFields()` is an allowlist reader, not a
  cast: five fields by name, each validated, everything else dropped. A sender that puts `duress`,
  `lat` or a note in the payload cannot get any of it onto a lock screen — F-01 no longer depends on
  the sender checking itself (D-019).
- **It degrades instead of dropping.** An unknown trigger or an unparseable tier still rings, on the
  generic label at tier 1. Only a payload with no usable incident/family id presents nothing.
- **One place composes the words.** `notifyIncident()` (socket, app alive) and
  `notifyIncidentFromPush()` (FCM, app killed) both route through `presentIncidentAlert()`, so the
  two paths cannot drift into telling a family two different stories about the same incident.
- **A pre-existing red gate was found and fixed.** `test/push-token.test.ts` did **not** typecheck at
  HEAD, although the previous handoff recorded `tsc --noEmit` as green. See "Watch out for".
- Verified green: `go build`, `go vet ./...`, `go test ./...`, `tsc --noEmit`, `npm test`
  **158/158** (was 144), `gen:check`, `schema-lint`, `protolint`.

## Files changed

**Mobile**
- `src/state/pushReceive.ts` **(new, ~190 lines)** — the task, the allowlist reader, the sanitisers.
  `subjectShortName` is clamped to printable ASCII ≤8 (F-18/I-2) because it is the only
  server-supplied string that renders on a locked screen; ids are restricted to URL-unreserved
  characters so a hostile id cannot become a path segment.
- `src/state/notifications.ts` — `ensureNotificationChannels()` exported (a channel that does not
  exist means the OS drops the notification silently on API 26+); `IncidentAlertFields`,
  `presentIncidentAlert()`, `notifyIncidentFromPush()`; `scenarioLabel()` now takes a `TriggerType`.
- `index.ts` — the two imports, in the order that matters, with the reason above them.
- `test/push-receive.test.ts` **(new, 14 tests)** — incl. a **wiring test** that fails if `defineTask`
  ever moves out of module scope, and one that sends `duress`/`lat`/`lon`/`note` and asserts the
  presented `data` bag has exactly five keys.
- `test/shim.mjs` — controllable `expo-task-manager` stub (`__runTask`, `__definedTasks`);
  `expo-notifications` now records what was presented (`__presented`, `__resetPresented`).
- `test/push-token.test.ts` — the `@ts-expect-error` fix.

**Docs** — `PHASES.md`, `DECISIONS.md` (D-019…D-021), `PROJECT_MAP.md`, `RISK.md` (new item 14),
`CLAUDE.md`, this file.

**Not touched: the backend.** Nothing on the server needed to change for the receive half.

## Decisions made

- **D-019 — the client reads the payload through an allowlist, not a cast.** `assertPushSafe` in
  `fcm.go` is the sender checking itself; a phone cannot audit the server it is hearing from.
- **D-020 — the push wake path opens no database.** Restoring the member's locale means opening
  SQLite on the one code path whose job is to ring within seconds. Headless alerts are English until
  the app opens; logged as 1.35f(b), not silently absorbed.
- **D-021 — 1.37 and 1.28 become W10-c and were not started.** Both are Kotlin, this machine has no
  JDK and no Android SDK, and no CI gate compiles Kotlin. Writing it here would produce code that
  cannot be compiled, run, or checked by anything in the repo.

## Known broken / deliberately skipped

- **⛔ Still nobody's phone has rung, and none can.** — *because* no Firebase project exists.
  Newly found and previously unrecorded: **`app.json` has no `android.googleServicesFile` key**, so
  even dropping `google-services.json` into the repo would not put it in the build. All four steps
  are in PHASES 1.35d. This is now RISK item 14.
- **1.37 (full-screen intent) and 1.28 (`showWhenLocked` medical card) — not started.** — *because*
  D-021. Confirmed while scoping: `expo-notifications` has **no** `fullScreenIntent` surface (zero
  matches in the package), so this is a native `Activity` plus a Kotlin `setFullScreenIntent` post,
  not a content field. That is W10-c and needs a workstation that can build the app.
- **A drill can present as a real alert.** — *because* the wire carries the safe five and `isDrill`
  is not one of them, so `notifyIncidentFromPush` passes `false`. That is the fail-safe direction (a
  real alert mislabelled "DRILL —" is the unrecoverable error) and a drill usually carries
  `trigger: 'DRILL'`, which renders as "Drill" anyway. Logged as 1.35f(a).
- **A terminated-app action tap is still dropped.** — *because* Android routes it to the same task,
  `readPushFields` correctly refuses to re-alarm on it, and applying `ACTION_PROBE_FINE` needs the
  store and the network. Logged as 1.35f(c); it is the P-002 spiral `notifications.ts` names in its
  own header.
- **`go test -race` was not run.** — *because* there is no gcc on this machine. CI gate 3 only.
- **1.32 (CLAIM/RELEASE over push) is still open.** Both halves of the wire now exist; nothing fans a
  claim out over it.

## Next session starts here

- **Phase 1, W10-c:** one `Activity` in `modules/kavach-t0/android/` — `showWhenLocked`,
  `turnScreenOn`, `excludeFromRecents` — posted via `setFullScreenIntent` from the native module and
  called from `pushReceive.ts`, closing **1.37 and 1.28** together.
- **First command:**

  ```
  git checkout phase1-w10-remote-push && cd mobile && npm run verify
  ```

  Then confirm both blockers are cleared before writing a line:
  `echo $env:KAVACH_FCM_CREDENTIALS` · `Test-Path mobile/google-services.json` ·
  `Select-String -Path mobile/app.json -Pattern googleServicesFile` · `java -version`.
- **Watch out for:** **do not start W10-c on a machine with no JDK.** Its entire output is Kotlin,
  nothing in this repo compiles Kotlin, and `npm run verify` will go green over a file that has
  never been parsed by a compiler. That is a worse version of the trap W10-b was split to avoid,
  because the usual green ticks are still there.

  Second trap, and the concrete lesson of this session: **read the gate output, do not trust the
  previous handoff's summary of it.** `tsc --noEmit` was recorded green on 11 Aug and was red — a
  `// @ts-expect-error` written as a trailing comment inside multi-line import braces suppresses
  nothing, because `tsc` reports one error per specifier. Now in `CLAUDE.md`.
