# HANDOFF — Kavach — Phase 6-D-6 — 2026-08-31

Branch **`shivam`**, on top of commit `29a6d99e`. This handoff supersedes the 31 Aug 6-D-5 one
(commit `71ba026d`), preserved in git history.

## Done

- **6-D-6 shipped: on-demand location push for the Watch tab's Refresh button (spec C1–C3).**
  Scoping it found the phase was bigger than its own row said: cross-member live location had
  **never once been wired in either direction** before today, in real (non-demo-mode) use — see
  **D-035** for the full finding and design. The user was asked whether to split into 6-D-6a/6-D-6b
  or build both in one session; chose one session.
- **Request leg (backend).** `notify.RequestLocationRefresh` — new, bypasses `Fanout` entirely (no
  incident, no audience/drill/budget), Android-only FCM, skips revoked devices, honest errors
  (`ErrPushUnregistered`/`ErrPushNotConfigured`/`ErrNoReachableDevice`) mirroring the existing
  KV-NOTOKEN/KV-NOPUSHCFG pattern. `fcm.go`'s F-21 allowlist (`pushSafeKeys`) grew exactly 3 keys:
  `type`, `requestId`, `deviceId`. New route `POST /v1/members/{id}/location-refresh` on
  control-plane.
- **Response leg (mobile).** New `mobile/src/state/locationRefresh.ts` — deliberately store-independent
  (same discipline `pushReceive.ts`/`notifications.ts` already use): Expo's own docs confirm a
  headless-launched task mounts no views, so `app/_layout.tsx`'s `bootstrap()` never runs and
  `store.ts`'s module-level `groupSecret`/`authToken` are unset in that context. This file reads both
  straight out of SecureStore, and never opens `t0ConfigRepo` (SQLite) to learn this device's own
  identity — same trade D-020 already declined once, for locale. The push payload therefore carries
  the target's own `deviceId`. Acquires one fix via `Promise.race` against an 8s timeout
  (`getCurrentPositionAsync` has no built-in timeout — confirmed against the exact v57 docs per
  `mobile/AGENTS.md`), seals it with the family's existing (previously uncalled) Location Stream Key
  (`crypto.locationStreamKey` + `sealJson`), and reports it to a **new** `POST /v1/location-report`
  on **realtime-gw** — not control-plane, because `net/api.ts`'s `stripClassA` and its comment are
  explicit that no control-plane body may carry location, sealed or not (ADR-010). Reuses the
  existing single-use connect ticket (F-16) rather than a new auth scheme, and a plain `fetch` rather
  than a WebSocket — `net/ws.ts` is a stateful, SQLite-cursor-backed singleton, the wrong shape for a
  fire-and-forget report from a task with seconds of budget left. **realtime-gw got its first tests
  ever** (`report_test.go`).
- **Receive leg.** `store.ts handleWsFrame`'s new `location.update` case is the only place
  `openJson`/`locationStreamKey` are called client-side anywhere in this app. Decrypts, updates
  `presence[memberId].location`, skips the echo of a device's own report back to itself.
- **UI.** `watch.tsx`'s Refresh button (Feather `refresh-cw`, first of the three per spec B1's order),
  8s spinner gated on `mayDrawPin(status)` (only meaningful when a location grant already exists),
  distance-from-you (reused `geofence.haversineM`, not duplicated) and a `±Xm` accuracy chip shown
  only past 30m (C2/C3).
- **Verified green:** `tsc --noEmit` (0 errors), `npm test` **196/196** (was 186), `npm run verify`
  exit 0. Backend: `go build`/`go vet`/staticcheck/archlint all clean; `go test` —
  `internal/notify` 32 (+7), `cmd/control-plane` 21 (+2), `cmd/realtime-gw` 4 (all new — its first
  ever), full sweep (`internal/store`, `internal/wal`, `internal/bus`, `internal/escalation`,
  `internal/consent`, `internal/envelope`, `internal/incident`, `internal/logx`) green, `cmd/sos-ingest`
  green via the `GOTMPDIR` workaround. `gen:check`/schema-lint/protolint unaffected — no
  spec/proto/schema change this phase.
- **No screenshot** — same rule as every 6-D UI phase (no JDK/Android SDK, no `react-native-web`):
  verified by `tsc` + tests + reading the JSX.

## Files changed

- `backend/internal/notify/fcm.go` — `pushSafeKeys` +3.
- `backend/internal/notify/notify.go` — `locationRefreshPushPayload`, `RequestLocationRefresh`,
  `ErrNoReachableDevice`.
- `backend/internal/notify/location_refresh_test.go` — new, 7 tests.
- `backend/cmd/control-plane/main.go` — `requestLocationRefresh` handler + route.
- `backend/cmd/control-plane/location_refresh_test.go` — new, 2 tests.
- `backend/cmd/realtime-gw/main.go` — `reportLocation` handler + route (first plain-HTTP handler in
  this binary beyond `/healthz`).
- `backend/cmd/realtime-gw/report_test.go` — new, 4 tests, this binary's first tests ever.
- `mobile/src/net/api.ts` — `postLocationRefreshRequest`, `postLocationReport`, `realtimeHttpBase`.
- `mobile/src/state/pushReceive.ts` — `readLocationRefreshFields`, `isActionResponse` extracted, task
  dispatcher now routes on payload shape.
- `mobile/src/state/locationRefresh.ts` — new. `handleLocationRefreshPush`, `acquireOneShotFix`
  (exported for test), SecureStore-direct `groupSecret`/session readers.
- `mobile/src/state/store.ts` — `handleWsFrame`'s new `location.update` case; `requestLocationRefresh`
  store action; `FramePayload`'s doc comment corrected (no longer claims location never arrives on
  any frame — `sealed` now does, opaquely).
- `mobile/app/(tabs)/watch.tsx` — Refresh button, 8s spinner state, distance/accuracy display, header
  comment updated.
- `mobile/test/push-receive.test.ts` — 6 new tests for the dispatch-routing/parsing split.
- `mobile/test/location-refresh.test.ts` — new, 4 tests for `acquireOneShotFix`'s timeout race.
- `mobile/test/shim.mjs` — new controllable `expo-location` stub
  (`__setNextFix`/`__setNextError`/`__setHang`).
- `docs/DECISIONS.md` — **D-035** appended.
- `docs/PHASES.md` — 6-D-6 row → done; `## Now` / `## Next 3` repointed to 6-D-7.
- `docs/HANDOFF.md` — this file.

## Decisions made

Recorded durably as [DECISIONS.md](DECISIONS.md) **D-035** (the scope discovery, the three design
constraints — ADR-010, D-020, `net/ws.ts`'s wrong shape — and what is still NOT wired). Session-local
notes not worth a DECISIONS.md entry on their own:

- **The push payload carries the target's OWN `deviceId`, not just a correlation id.** This was the
  one piece that made the whole headless response leg tractable without opening SQLite — worth
  restating here because it is easy to "simplify" away in a later edit without realising why it is
  there.
- **`requestLocationRefresh`'s family lookup uses the target member's own `FamilyID`
  (`s.st.Member(memberID).FamilyID`), not `s.familyID(r)`** — caught and fixed mid-session by
  re-reading `findPhone`'s existing pattern (it derives family from the resource, not the caller's
  header) rather than trusting whatever `X-Family-Id` a caller happens to send.
- **`readLocationRefreshFields` lives in `pushReceive.ts`, not `locationRefresh.ts`.** The dispatcher
  parses first and passes the typed result in, specifically so `locationRefresh.ts` never has to
  import back from `pushReceive.ts` at the value level (only a type-only import, erased at compile
  time) — avoids a real circular value-import between the two files.
- **The `hasFix` block's wording changed** (added a distance prefix, replaced the always-shown
  "accurate to about Xm" suffix with a conditional `±Xm` chip past 30m). This is additive — the block
  only ever renders when a fix has actually arrived, which could not happen for another member before
  today — not a rewrite of 6-D-1's already-shipped `locationLine()` status text, which is untouched.

## Known broken / deliberately skipped

- **Ambient/continuous cross-member sharing is still not wired.** Only a push-triggered Refresh
  reports a fix. `presenceService.ts`'s ordinary `watchPositionAsync` tick — the "existing 10s-
  foreground watch" C1's own spec prose assumes already broadcasts — still calls only
  `noteLocationFix()`, which still never leaves the device. In the running app today, a member's card
  updates only when someone taps Refresh, never ambiently while both apps are simply open. See D-035's
  consequence note for the design a future phase should reuse (send directly over the sender's own
  open `net/ws.ts` socket when foregrounded, rather than the ticket+POST path built for headless).
- **F2's auto-grant-on-join (D-033) is still open** — unrelated to this phase, unchanged by it.
- **No early-stop-on-arrival for the Refresh spinner.** It runs the full 8s regardless of whether a
  fresher fix arrives sooner; the card itself updates immediately either way via the ordinary
  `location.update` handler, so this only affects how long the spinner icon specifically keeps
  spinning. Simple flat timer chosen over synchronizing it to presence updates — matches "boring over
  clever."
- **The realtime-gw report endpoint is unauthenticated beyond the ticket** — same trust model the WS
  path already has (F-16), not a new gap.
- **No JSX-rendering test harness still**, same as every 6-D UI phase.

## Next session starts here

- **Phase 6-D-7**: Family Watch transport (camera + listen, live) — `react-native-webrtc` + TURN
  relay + the actual live-view/listen screens (spec D1–D5, E1–E4). **Unverifiable on this machine —
  no Android SDK/JDK (D-021).** Build the TS/state/signalling layer here; the live stream itself
  needs a device build the user triggers. **6-D-8** (geofencing arbitrary-location placement) is the
  fully-verifiable-here alternative if 6-D-7 stalls on the device-build blocker.
- **First command:**
  ```
  git checkout shivam
  git log --oneline -1              # confirm you're on this phase's commit or later
  cd mobile && npm run verify
  cd ../backend && go build ./... && go vet ./... && go test $(go list ./... | grep -v cmd/sos-ingest)
  ```
- **Watch out for:**
  1. **6-D-7 needs a device build before ANY of it is verifiable.** Check `java -version` /
     `ANDROID_HOME` first, same lesson W10-c and 6-C already paid for (D-021) — do not write a
     session of native code assuming the check will pass later.
  2. **Do not fold ambient/continuous location sharing into 6-D-7.** It is a real, separate gap
     (D-035's consequence note) with its own design already sketched — give it its own phase rather
     than discovering it again mid-session the way this phase discovered the relay gap.
  3. **The D-020 "no SQLite on the headless wake path" rule now has two independent instances**
     (`pushReceive.ts`'s locale fallback, `locationRefresh.ts`'s identity reads). If 6-D-7's live
     session needs anything from a headless context, read it from SecureStore directly rather than
     reaching for `t0ConfigRepo`/`store.ts`'s bootstrap — do not re-litigate this per file.
