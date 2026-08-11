# HANDOFF — Kavach — Phase 1 (W10-a, remote push: send side) — 2026-08-11

Branch **`phase1-w10-remote-push`**, 3 commits, **not pushed**. Previous handoff (session 1, the
documentation spine) is in [history/SESSION-LOG.md](history/SESSION-LOG.md) and its commit
`cf42d7c4` — that session's `docs/` output had never been committed and is now in git.

## Done

- **The server can address a specific family phone and really sends to it.** A device acquires its
  native FCM registration token at boot, registers it with the control plane, and re-registers when
  FCM rolls it. `internal/notify` performs a real FCM HTTP v1 send on the `fcm` leg.
- **The push payload cannot leak the duress bit.** Data-only always, and an allowlist assertion
  fails closed on anything outside `{incidentId, familyId, trigger, tier, subjectShortName}` —
  enforced in two independent places (F-01, F-21, D-007).
- **The delivery matrix stopped lying.** The FCM leg used to record `delivered` for a push it never
  sent. It now records `KV-NOTOKEN` / `KV-NOPUSHCFG` / `KV-UNREGISTERED` / `KV-PUSHFAIL`. On this
  deployment every FCM row now reads `failed / KV-NOPUSHCFG` — truthfully.
- **`internal/store` and `internal/notify` have their first direct tests** (they had zero — RISK §4).
  The store test was shown failing on the new column *before* the field was added.
- Verified green: `go build`, `go vet ./...`, `go test ./...`, `tsc --noEmit`, `npm test`
  **144/144** (was 139), `gen:check`, `schema-lint`, `protolint`, `TestLOCBudget` **963/1000**.

## Files changed

**Backend**
- `internal/notify/fcm.go` **(new, 380 lines)** — FCM HTTP v1 sender. Stdlib only, because
  `go.mod` must keep zero `require` lines (ADR-002): RS256 service-account JWT via `crypto/rsa`,
  cached access token with 60 s skew, PKCS#8 and PKCS#1 keys. `assertPushSafe` is the F-21 gate.
- `internal/notify/fcm_test.go` **(new, 20 tests)** — fan-out audience rules (subject excluded,
  drill scoping, dead agent) plus every FCM delivery outcome, and the wire shape against a stub FCM.
- `internal/notify/notify.go` — `Deps.Push` (optional), `sendPush()`, the two new eligibility checks
  in `dispatch()`. `startLeg` no longer models FCM.
- `internal/store/store.go` — `Device.PushTokenFCM` (`push_token_fcm`, the migration's name).
- `internal/store/store_test.go` **(new, 6 tests)** — pins the device table's persisted key set
  against `migrations/0001_init.sql`, tenancy-on-write, by-value row copies.
- `cmd/control-plane/main.go` — `deviceReq.PushTokenFCM` as a **pointer** so omitting ≠ clearing;
  revocation clears the token; `NewFCMFromEnv` at startup, WARN (never fatal) when unconfigured.

**Mobile**
- `src/state/notifications.ts` — `acquireDevicePushToken()`, `subscribePushTokenChanges()`.
- `src/net/api.ts` — `putDevicePushToken()`; `PATCH` added to the `control()` method union.
- `src/state/store.ts` — `registerForRemotePush()`, called from `doBootstrap()` after
  `initNotifications()`.
- `test/push-token.test.ts` **(new, 5 tests)** · `test/shim.mjs` — controllable `expo-notifications`
  and `expo-router` stubs.

**Docs** — `PHASES.md`, `RISK.md`, `PROJECT_MAP.md`, `DECISIONS.md` (D-015…D-018), this file.

## Decisions made

- **D-015 — a delivery row must never claim a leg that was not attempted.** The four clocks are the
  family's only evidence the chain works; a green row for a nonexistent leg corrupts them.
- **D-016 — the native FCM token, never the Expo push relay.** No third party between an emergency
  and a family phone. Costs a mandatory Firebase project.
- **D-017 — the store↔migration column pairing is machine-checked, for the `device` table only.**
  Narrow on purpose; generalising means parsing the SQL, which is its own task.
- **D-018 — W10 splits into send (done) and receive (not started),** because W10's exit criterion is
  a physical-device check and the receive half cannot be honestly verified without credentials.

## Known broken / deliberately skipped

- **Nobody's phone rings yet, and none will.** The **receive** half does not exist: a data-only FCM
  message needs `TaskManager.defineTask` + `Notifications.registerTaskAsync` in an early-loaded
  module to wake a killed app. Without it the server sends into the void. — *because* it is W10-b,
  and pairing it with the full-screen intent (1.37) and the `showWhenLocked` medical card (1.28) is
  one coherent session instead of three half ones.
- **⛔ No FCM credentials exist anywhere.** — *because* creating the Firebase project is yours, not
  mine: a project, `google-services.json` in the Android build, a service-account key at
  `KAVACH_FCM_CREDENTIALS`. Free, ~15 min. **Nothing in W10 can be verified on a handset until this
  exists**, so it is the true first task.
- **`go test -race` was not run.** — *because* it needs `CGO_ENABLED=1` **and a C compiler**, and
  there is no gcc on this machine. CI gate 3 covers it; it has not been observed passing locally.
- **APNs, PushKit, SMS and voice legs are still modelled** with jittered latency. — *because* only
  FCM was in scope; iOS is out of scope by ADR-015 and SMS is W11.
- **1.32 (CLAIM/RELEASE over push) is still open.** The send mechanism now exists; nothing fans a
  claim out over it. — *because* it is downstream of a device that can receive.
- **`store_test.go` covers the `device` table only.** Ten other tables remain unpinned.
- **This session touched 11 files against the ~8 rule.** — *because* landing the server side without
  the mobile leg would have shipped exactly the zero-call-site module D-010 exists to prevent.
  Flagged rather than absorbed silently.

## Next session starts here

- **Phase 1, W10-b:** make a real handset ring — a `TaskManager` background task that composes the
  alert from the five push fields through the existing `notifyIncident()`, then a `showWhenLocked`
  full-screen-intent Activity to present it, closing 1.35e, 1.37 and 1.28 together.
- **First command:**

  ```
  git checkout phase1-w10-remote-push && cd mobile && npm run verify
  ```

  Then, before writing code, confirm the blocker is cleared:
  `echo $env:KAVACH_FCM_CREDENTIALS` and check `mobile/google-services.json` exists.
- **Watch out for:** **do not build W10-b before the Firebase project exists.** Its entire exit
  criterion is a physical device ringing through Do Not Disturb; without credentials you will write
  a receive path that typechecks, cannot be exercised, and will be reported as done. That is the
  precise failure this project has already shipped more than once (D-010), and it is how W10 stays
  the weakest week in the project for another twelve days.

  Second trap: `expo-notifications` background tasks must be registered in an **early-loaded module**
  (`index.ts`), not inside a React component — registering from a screen silently never fires when
  the app is killed, which is the only case that matters. Read
  https://docs.expo.dev/versions/v57.0.0/sdk/notifications/ before writing it; `mobile/AGENTS.md`
  requires the versioned docs, and SDK 57 moved this API.
