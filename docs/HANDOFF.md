# HANDOFF — Kavach — Phase 6-D-7a — 2026-09-01

Branch **`shivam`**, on top of commit `ae5cb3fd`. This handoff supersedes the 31 Aug 6-D-6 one
(commit `35b7f4f6`), preserved in git history.

## Done

- **6-D-7 was split into 6-D-7a (shipped today) and 6-D-7b (still blocked) — D-036.** The phase row
  bundled two things one session cannot honestly deliver together here: a **session plane** that is
  pure TS plus one Go handler, and the **media** (`react-native-webrtc` + TURN), which needs a device
  build. 6-D-7a is the first half, fully verified on this machine.
- **Backend: `realtime-gw`'s `watch.signal` relay.** A new C→S case in `handleMessage` — the first
  new frame type this binary has grown. It relays one opaque sealed blob plus two cleartext routing
  fields (`sessionId`, `toMemberId`) and stamps the sender from the **connect ticket**, never the
  request body; a body-supplied `fromMemberId` would let any family member forge a watch invite from
  any other, and a test pins that it is ignored. **HIGH** priority, deliberately: LOW coalesces per
  key and would keep only the last ICE candidate (a session that never connects), CRITICAL is
  reserved for a responder's understanding of who is going (§2.5.2). The existing F-20 guard already
  bars reduced/neighbour sessions from publishing it — also now pinned, because a new C→S type that
  forgot to be inside that guard is invisible: every other test on the main path still passes.
- **Mobile: `src/state/watchSession.ts` (new).** Owns everything about a Camera or Listen session
  except the media — invite, the watched phone's auto-accept or decline, the indicator's state, D5/E4's
  two access-log rows, E2's 5-minute Listen budget and repeatable "+5 min", D3's viewer-driven flip,
  D4's End from either party, 1↔1 enforcement, and the routing/replay checks.
- **Two properties that are the actual point of the phase, and are pinned by tests rather than by
  reading the code:**
  1. **The watched phone is the authority on consent.** F-14 makes Layer-1 revocation instant on the
     revoker's own phone and lets the key ratchet lag — so the *viewer's* grant list is exactly the
     copy a revocation has not reached. `onInvite` re-checks against the watched device's own grants
     via `outboundGrantStatusFor` (new in `domain/consentStatus.ts`; the existing `grantStatusFor`
     reads "their grant to me" and structurally cannot express "my grant to them") and declines with
     F4's copy.
  2. **The access-log row is on disk BEFORE the accept goes out.** D2 pins the indicator at "before
     the viewer's first frame renders, not after"; making the answer depend on the row is the only
     way to guarantee that ordering. The test asserts the exact event order
     `['log:camera_view_started', 'send:accept']`.
- **Crypto:** new `watchSessionKey(groupSecret, sessionId)` = `deriveKey(secret, 'watch', sessionId)`,
  identical construction to `incidentContentKey`. `sealJson`'s AAD binds each signal to the same
  session id a second time, so a relayed signal cannot be replayed into another session — tested
  both ways (wrong AAD and wrong key both fail to open).
- **⛔ It has ZERO call sites in `app/`, on purpose.** GLOSSARY.md's Family Watch entry: *"Do not
  build one half without the other."* Without media, opening a session would tell someone
  *"X is viewing your camera"*, write a `camera_view_started` row, and carry no camera — the exact
  fabrication D-034 refused for these same buttons one phase ago. 6-D-5's honest "isn't built yet"
  alert stays in `watch.tsx`, untouched. `store.ts` **does** route inbound `watch.signal` frames, so
  the receive half is wired; nothing can send one until 6-D-7b installs a `WatchMedia`.
- **Verified green:** `tsc --noEmit` (0 errors), `npm test` **218/218** (was 196), `npm run verify`
  exit 0. Backend: `go build`, `go vet`, staticcheck, archlint (14 packages, 66 edges) all clean;
  `go test` — `cmd/realtime-gw` **7** (was 4), full sweep (`cmd/control-plane`, `internal/{bus,
  consent,envelope,escalation,incident,logx,notify,store,wal}`) green, `cmd/sos-ingest` green via the
  `GOTMPDIR` workaround. `gen:check` in sync, `schema-lint` clean, `protolint` clean — no
  spec/proto/schema change this phase. **`-race` not run** (no gcc, CI gate 3 only).
- **No screenshot** — nothing rendered changed, and the usual rule applies anyway (no Android SDK, no
  `react-native-web`).

## Files changed

- `backend/cmd/realtime-gw/main.go` — `watch.signal` case in `handleMessage`, doc comment updated.
- `backend/cmd/realtime-gw/signal_test.go` — new, 3 tests (6 with subtests). First tests in this
  binary to drive `handleMessage` rather than a plain HTTP handler.
- `mobile/src/crypto/index.ts` — `watchSessionKey`.
- `mobile/src/domain/consentStatus.ts` — `outboundGrantStatusFor`.
- `mobile/src/state/watchSession.ts` — new, the whole session plane.
- `mobile/src/state/store.ts` — `handleWsFrame`'s `watch.signal` case; `watchContext()`, which is the
  single join point between the store and the plane.
- `mobile/test/watch-session.test.ts` — new, 22 tests.
- `docs/DECISIONS.md` — **D-036** appended.
- `docs/PHASES.md` — 6-D-7 row split into 6-D-7a (✅) / 6-D-7b (⛔); `## Now` and `## Next 3`
  repointed; stale "no JDK" blocker text corrected.
- `docs/PROJECT_MAP.md`, `CLAUDE.md` — same stale-JDK correction, plus the shim/`repos.ts` trap below.
- `docs/HANDOFF.md` — this file.

## Decisions made

Recorded durably as [DECISIONS.md](DECISIONS.md) **D-036** (the split, the seven design points, and
what 6-D-7b still owns). Session-local notes not worth their own entry:

- **`db/repos.ts` cannot be imported from any test in this repo**, and that shaped the design.
  It imports `'../t0/stateMachine.generated'`; the shim's `resolveExtensionless` bails whenever
  `path.extname(specifier)` is non-empty, and `.generated` reads as an extension, so `.ts` is never
  re-added and Node throws `ERR_MODULE_NOT_FOUND`. `watchSession.ts` therefore takes persistence as a
  `WatchContext.writeAccessLog` callback — which turned out to be the better design anyway: the store
  keeps its own in-memory `accessLog` that Settings › Privacy renders, so a write straight to SQLite
  would have left that list stale until the next launch. `store.ts` does both legs, exactly as
  `findPhone` already does. Now written into CLAUDE.md convention 7.
- **`context` on a watch access-log row MUST stay `'routine'`.** `consent.tsx`'s `incidentTag` renders
  any other value as "During an incident" — encoding a session id there would have made every watch
  session read as an emergency in the privacy log. Asserted in the tests.
- **`durationS` (D5/E4) is left derivable, not persisted.** `AccessLogEntry` has no such column and
  `db/schema.ts` still carries exactly one migration (the baseline); `ended.at − started.at` for the
  same pair gives the same number. Making this app's first-ever schema migration for a derivable value
  was not the trade.
- **A test that leaves an audio session open holds Node's event loop for five real minutes.**
  `armExpiry` arms a genuine `setTimeout(LISTEN_SESSION_MS)`; the first run of `npm run verify` looked
  hung rather than failed. Fixed with an `afterEach(__resetWatchSessionForTest)` and a comment saying
  why it is not belt-and-braces.
- **`java -version` now succeeds on this machine** (OpenJDK 17, `JAVA_HOME` set). `ANDROID_HOME` and
  `ANDROID_SDK_ROOT` are still unset, so D-021's conclusion is unchanged — but the *check* named in
  three docs was stale and would have passed misleadingly. All three corrected.

## Known broken / deliberately skipped

- **The whole of 6-D-7b.** No media, no live-view screen, no watched-side banner/dot/sound, no wiring
  of `watch.tsx`'s Camera/Listen buttons. Tapping them still shows 6-D-5's honest alert.
- **`watchSession.ts` has no call site in `app/`** — see above. Report it as "exists, not wired to the
  UI" (CLAUDE.md convention 2), never as Family Watch being done.
- **No TURN server exists**, and no ICE/STUN configuration has been written anywhere. `WatchSignal`
  carries `ice` and `sdp` variants and the relay moves them, but nothing produces one yet.
- **Ambient/continuous cross-member location sharing is still not wired** (D-035's consequence note),
  and **F2's auto-grant-on-join (D-033) is still open** — both unrelated to this phase and unchanged
  by it. D-033 in particular means that in the running app today virtually every member card shows
  the B3 "not sharing yet" reason for camera/audio, so even a finished 6-D-7b would decline most
  invites until D-033 is closed.
- **`backend/.gotmp` is not empty and was left alone.** It holds `bus.test.exe`/`wal.test.exe` and
  three temp dirs from an earlier session's two-real-process runs, so `rmdir` (the documented cleanup)
  refuses. Nothing of mine is in it and git does not see it; deleting another session's artefacts was
  not worth the risk.
- **No JSX-rendering test harness still**, same as every 6-D phase.

## What a working APK still needs (asked 1 Sep, checked not assumed)

An APK can be **built today** — `eas.json` has a `preview` profile that emits an APK, and EAS builds
run in Expo's **cloud**, so this machine's missing Android SDK does not block it (D-021 blocks
*compiling Kotlin here*, not *getting an APK*). What that APK would NOT do is anything involving
another family member, for three separate reasons — all outside the app code:

1. **No server a phone can reach.** `app.json`'s `extra.apiBase`/`apiDirect` are `http://10.0.2.2:8081`
   and `wsBase` is `ws://10.0.2.2:8082`. `10.0.2.2` is the **Android emulator's** alias for the host's
   localhost; on a physical phone it resolves to nothing. A real build must override
   `EXPO_PUBLIC_KAVACH_API`, `EXPO_PUBLIC_KAVACH_API_DIRECT` and the ws base (`src/core/config.ts:41`)
   with a host the phone can actually reach — and the backend has to be running there.
   `docker compose up` has still never been run on this machine (no daemon).
2. **No Firebase.** `app.json` has no `android.googleServicesFile`, and `KAVACH_FCM_CREDENTIALS` is
   unset. No FCM means no push: the escalation ladder cannot wake anybody's phone, and 6-D-6's
   Refresh button is push-triggered, so cross-member location cannot work either. Free, ~15 min,
   **owner: the user** (D-018).
3. **No way to add a second member from the app** (D-033, re-verified 1 Sep). `src/net/api.ts` wires
   `POST /v1/family` (create) and the device routes, but **no client calls `POST /v1/members`** —
   grep it. The backend route exists and works (W10-j); nothing in `mobile/` calls it. So the family
   stays a family of one and every Watch card stays empty, however well the transport works.

**What an APK built today WOULD prove**, which is not nothing: that the app installs, boots, and the
on-device T0/SOS plane runs on real hardware. **Nothing from this checkout has ever run on a device**
(D-001, D-021), so the first build failing on the `kavach-t0` native module or its config plugin is a
live possibility. Worth finding out early, in parallel with (1)–(3), rather than after them.

## Next session starts here

- **Phase 6-D-8** is the recommended next: geofencing arbitrary-location placement (spec G, an interim
  lat/lon text-entry fallback that does not need 6-B's MapLibre first). It is **fully verifiable on
  this machine** and closes a real gap — today's form only ever centres a fence on your own current
  position (`map.tsx:474`).
- **Phase 6-D-7b** is the alternative and needs the user to trigger a device build: `react-native-webrtc`
  + TURN, a `WatchMedia` implementation behind `setWatchMedia()`, the viewer's live-view screen (D3's
  flip control, E2's countdown ring and "+5 min"), the watched device's non-suppressible banner + dot
  + start-sound (D2/D3), and only then wiring `watch.tsx`'s two buttons to `startWatchSession`.
- **First command:**
  ```
  git checkout shivam
  git log --oneline -1              # confirm you're on this phase's commit or later
  cd mobile && npm run verify
  cd ../backend && go build ./... && go vet ./... && go test $(go list ./... | grep -v cmd/sos-ingest)
  ```
- **Watch out for:**
  1. **`ANDROID_HOME`, not `java -version`, is the check that fails now.** A JDK arrived; the SDK did
     not. Three docs said otherwise until today — if a fourth still does, fix it rather than trusting
     a green `java -version` into a session of native code.
  2. **If 6-D-7b is picked, read D-036 first.** The seam is `setWatchMedia()` and the session plane
     underneath it is finished and tested — do not rebuild invite/accept/expiry/access-log logic
     inside a WebRTC file. And do not wire `watch.tsx`'s buttons until media actually flows: the
     indicator and the access-log row would otherwise describe something that is not happening.
  3. **`watchSession.ts` must never import `store.ts`.** `store.ts` imports it; everything
     store-shaped arrives as an explicit `WatchContext`. Same circular-value-import trap 6-D-6 split
     `readLocationRefreshFields` out to avoid.
  4. **Any new test that opens an audio session needs the `afterEach` reset**, or `npm test` will sit
     for five minutes on a live expiry timer with no failing assertion to read.
