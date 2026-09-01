# HANDOFF — Kavach — Phase 6-D-7a/b/c/d + 6-D-8 — 2026-09-01

Branch **`shivam`**, on top of commit `3069e27b`. This handoff supersedes the 6-D-7a one written
earlier the same day (commit `9633bc59`), preserved in git history.

**Phase 6-D is code-complete.** 6-D-1 through 6-D-8 have all landed. It is not *proven* — see
"Known broken" below, which is the section that matters most in this handoff.

## Done

- **6-D-7a — the Family Watch session plane.** `realtime-gw`'s `watch.signal` relay (opaque sealed
  blob + two routing fields; the sender is stamped from the connect ticket, never the request body)
  and `mobile/src/state/watchSession.ts`: invite → the watched phone's auto-accept against **its
  own** grants → decline with F4's copy, D5/E4's two access-log rows, E2's 5-minute Listen budget and
  repeatable "+5 min", D3's viewer-driven flip, D4's End from either party, 1↔1 enforced. The
  access-log row is written **before** the accept goes out, because D2 pins the indicator at "before
  the viewer's first frame renders" and making the answer depend on the row is the only way to
  guarantee it. 22 tests.
- **6-D-7b — the media, the viewer screen, the indicator.** `react-native-webrtc@124.0.8` +
  `@config-plugins/react-native-webrtc@15.0.2`. `watchMedia.ts` fills the `WatchMedia` seam: the
  viewer offers, the watched device captures and answers, ICE is trickled, and the flow is **one
  direction only** — the viewer's own camera and microphone are never opened. `app/watch-session.tsx`
  is the viewer's screen (D3 flip, E2 countdown ring + "+5 min", honest waiting/ended copy instead of
  a black rectangle). `src/ui/WatchIndicator.tsx` is the half GLOSSARY.md forbids omitting: banner +
  dot + a new distinctive `watch` cue, mounted **above** the navigator so no route can cover it or
  forget it, with no prop, no setting and no dismiss. `watch.tsx`'s Camera/Listen buttons now open
  real sessions — D-034's honest alert is retired because the thing it was honest about now exists.
- **6-D-7c — the enrolment bridge. Closes D-033.** `store.syncEnrolment()` carries a completed SAS
  pairing into `store.ts`. **`POST /v1/members` finally has a caller anywhere in `mobile/`**, and
  6-D-4's `grantFamilyMembershipScopes` finally has a call site. Called from `bootstrap` on every
  boot and from all three `enrol.tsx` completion paths; idempotent because every step keys on
  `memberIdForDevice(deviceId)`.
- **6-D-7d — ambient location sharing. Closes D-035's open consequence.** `noteLocationFix` now seals
  each fix and sends `location.report` down the already-open socket, so a member's card updates while
  both apps are simply open rather than only when somebody taps Refresh. Three refusals: no group
  secret, `monitoringPaused` (P-066), socket not open.
- **6-D-8 — arbitrary-location geofences.** `parseLatLon` + a "Where I am now" / "Type a location"
  chooser in `map.tsx`'s fence sheet. A fence around a school no longer requires standing at the
  school. Refuses DMS, out-of-range values (never clamped) and 0,0. 9 tests.
- **★ A live contract bug was found and fixed.** `realtime-gw`'s `handleMessage` read only a `data`
  field; `mobile`'s `WsFrame` has never had one (`{type, hlc, key, payload, priority}`). **Every C→S
  frame the app has ever sent arrived with a nil body**, was relayed as `"sealed": null`, and was
  dropped silently by the receiving client — nothing errored, because a nil `json.RawMessage`
  marshals to `null`. The gateway now accepts `payload` as an alias (`data` still wins), pinned by
  two tests. It surfaced only because a *new* caller was written for an *old* endpoint.
- **Verified green:** `tsc --noEmit` 0 errors · `npm test` **233/233** (196 at session start) ·
  `npm run verify` exit 0 · `go build`, `go vet`, staticcheck, archlint (14 packages, 66 edges) all
  clean · `go test` — `cmd/realtime-gw` **9** (was 4), full backend sweep green, `cmd/sos-ingest`
  green via `GOTMPDIR` · `gen:check` in sync · schema-lint clean · protolint clean.
  **`-race` not run** (no gcc; CI gate 3 only).

## Files changed

- `backend/cmd/realtime-gw/main.go` — `watch.signal` case; `payload`/`data` alias.
- `backend/cmd/realtime-gw/signal_test.go` — new, 5 tests (watch.signal ×3, frame alias ×2).
- `mobile/package.json`, `app.json` — `react-native-webrtc` + config plugin; `iceServers`/`turn*` extra.
- `mobile/src/core/config.ts` — ICE/TURN config, env-overridable.
- `mobile/src/core/ids.ts` — `memberIdForDevice`.
- `mobile/src/crypto/index.ts` — `watchSessionKey`.
- `mobile/src/domain/consentStatus.ts` — `outboundGrantStatusFor`.
- `mobile/src/domain/geofence.ts` — `parseLatLon`.
- `mobile/src/net/api.ts` — `postMember` (+ `MemberDraft`).
- `mobile/src/net/ws.ts` — `location.report` added to `LOW_TYPES`.
- `mobile/src/state/watchSession.ts` — new, the session plane.
- `mobile/src/state/watchMedia.ts` — new, the WebRTC transport.
- `mobile/src/state/store.ts` — `watch.signal` routing, `watchContext()`/`watchContextForUi()`,
  `syncEnrolment()`, `shortNameFor()`, `broadcastFix()`.
- `mobile/src/t0/alarm.ts` — the `watch` cue.
- `mobile/src/ui/WatchIndicator.tsx` — new.
- `mobile/app/_layout.tsx` — installs the transport, mounts the indicator above the navigator.
- `mobile/app/watch-session.tsx` — new, the viewer's screen.
- `mobile/app/(tabs)/watch.tsx` — buttons open real sessions.
- `mobile/app/(tabs)/map.tsx` — typed-location fence placement.
- `mobile/app/enrol.tsx` — calls `syncEnrolment` on all three completion paths.
- `mobile/test/{watch-session,member-id,latlon}.test.ts` — new, 22 + 6 + 9 tests.
- `docs/{DECISIONS,PHASES,HANDOFF,PROJECT_MAP}.md`, `CLAUDE.md`.

## Decisions made

Recorded durably as **D-036** (the 6-D-7a/b split and its seven design points) and **D-037** (this
session's full scope, the derivation choice, and the contract bug). Session-local notes:

- **The user asked twice, explicitly, for everything to be finished in one session.** The concern
  that camera/mic cannot be verified here was raised once and the instruction reaffirmed, so the
  ~8-file rule in CLAUDE.md was broken deliberately and on the record, not by drift.
- **`ANDROID_HOME` being unset does not block adding a native dependency** — EAS builds in Expo's
  cloud. It blocks *verifying* one. That distinction is why 6-D-7b was buildable at all.
- **`db/repos.ts` cannot be imported from any test** (the shim's `resolveExtensionless` treats
  `.generated` as a file extension), which is why `watchSession.ts` takes persistence as a
  `WatchContext` callback — and that turned out to be the better design anyway, since the store keeps
  its own in-memory `accessLog` that Settings › Privacy renders.
- **`context` on a watch access-log row must stay `'routine'`** — `consent.tsx`'s `incidentTag`
  renders any other value as "During an incident".
- **A test that leaves an audio session open holds Node's event loop for five real minutes.** Fixed
  with `afterEach(__resetWatchSessionForTest)`.

## Known broken / deliberately skipped

- **★ No camera or microphone stream has ever been observed.** 6-D-7b is `tsc`-clean and test-green
  and otherwise **unrun** — no Android SDK here. The first device build is the first test; treat a
  failure there as expected work, not a regression.
- **Three things stand between this and a working APK, and none is code in this repo.**
  1. **No server a phone can reach.** `app.json` still defaults to `10.0.2.2` — the Android
     *emulator's* alias for its host, which resolves to nothing on a real handset. A real build must
     set `EXPO_PUBLIC_KAVACH_API`, `_API_DIRECT` and `_WS`, and the backend must actually be running
     somewhere. `docker compose up` has still never been run on this machine.
  2. **No Firebase.** No `android.googleServicesFile`, no `KAVACH_FCM_CREDENTIALS` → no push, so no
     escalation ladder reaching anyone and no push-triggered Refresh (D-018). ~15 min, free,
     **owner: the user.**
  3. **No TURN relay.** STUN is configured and connects most pairs; across-city sessions need a
     relay. `CONFIG.turnUrl` and friends are env-overridable and the viewer's screen says so honestly
     when none is set. Optional infrastructure, not a code gap.
- **The joiner cannot derive the guardian's member id offline** — it never learns the guardian's
  device id. It adopts the family and reads the roster from `GET /v1/family`, so pairing populates
  the **guardian's** roster only until a reachable server exists.
- **`backend/.gotmp` is not empty and was left alone** — it holds another session's
  `bus.test.exe`/`wal.test.exe`, so the documented `rmdir` cleanup refuses. Nothing of mine is in it.
- **No JSX-rendering test harness**, so every screen written today is verified by `tsc` + tests +
  reading the JSX, not by a screenshot.

## Next session starts here

- **Phase: a first device build.** `npm run build:apk` (EAS, cloud — does not need the missing local
  SDK). Nothing below the TypeScript layer has ever been tested from this checkout, and that is now
  the single largest unknown in the project.
- **First command:**
  ```
  git checkout shivam
  git log --oneline -1              # confirm you are on 3069e27b or later
  cd mobile && npm run verify
  cd ../backend && go build ./... && go vet ./... && go test $(go list ./... | grep -v cmd/sos-ingest)
  ```
- **Watch out for:** **the APK will build and still do nothing useful** until the two deployment
  blockers above are closed — it is a smoke test of installation and the on-device T0/SOS plane, not
  of Family Watch. Say that plainly rather than reporting a successful build as a working feature.
  And do not "simplify" the two seams this phase depends on: `memberIdForDevice` is frozen (changing
  it silently unpairs every family, with no error anywhere), and `react-native-webrtc` may only be
  imported from `watchMedia.ts`, registered in `app/_layout.tsx` — never from `store.ts`, which would
  drag it into every Node test and onto the headless push path.
