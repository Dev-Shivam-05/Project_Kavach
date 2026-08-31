# HANDOFF — Kavach — Phase 6-D-5 — 2026-08-31

Branch **`shivam`**, code commit `71ba026d`, **pushed** to `origin/shivam`. This handoff supersedes
the 31 Aug 6-D-4 one (commit `94ed2b7b`, docs closed out through `a3118619`), preserved in git
history.

## Done

- **6-D-5 shipped: Watch tab Camera/Listen icon-buttons (spec B1–B3)** — UI/state layer only, exactly
  as PHASES.md's own 8-phase table scoped it (Refresh is 6-D-6, live transport is 6-D-7; neither
  touched here).
- Each member card in `app/(tabs)/watch.tsx` now renders two icon-buttons (Feather `video`, `mic`)
  next to the existing avatar/location/Pill row. Enabled state comes from
  `grantStatusFor('camera'|'audio', member, meId, undefined, grants, now)` — 6-D-4's generalisation
  of the location-consent rule. `presence` is passed as `undefined`, not the member's live presence,
  because camera/audio don't gate on `monitoringPaused` the way location does (a note `consentStatus`
  left for this exact caller in 6-D-4).
- New `disabledReasonFor(status, member)` in `consentStatus.ts` renders the exact locked copy: B3's
  *"Not sharing location/camera/mic yet — ask them to finish joining."* for `kind: 'none'`, F4's
  *"{name} has turned this off."* for `kind: 'revoked'`. `kind: 'expired'` gets a judgment-call string
  (not spec-locked — flagged below).
- Camera and audio reasons **dedupe to one line** when both scopes are blocked for the same reason
  (the common case) and show as **two lines** only when a member has revoked one scope but kept the
  other — this is F1's "separately revocable" requirement actually exercised, not just declared.
- Tapping an **enabled** button shows an honest `Alert` ("Camera view isn't built yet" / "Listening
  isn't built yet") rather than opening a session that doesn't exist, or writing a fake
  `AccessLogEntry` for one. Recorded as **D-034** — see that entry for why a stub screen and a silent
  no-op were both rejected.
- **4 new mobile unit tests** (`test/consent-status.test.ts`, now 15 in that file) covering
  `disabledReasonFor`'s four reachable branches (`none`, `revoked`, `granted`→null, `expired`).
- Verified green: `tsc --noEmit` (0 errors), `npm test` **186/186** (was 182), `npm run verify` exit
  0. **No screenshot** — per this repo's own rule, a pure RN change with no native surface is verified
  by `tsc`+tests+reading the JSX here, not a web preview (`react-native-web` isn't a dependency, and
  no JDK/Android SDK exists on this machine for a device build — D-021).
- Backend untouched this phase — not re-run, honestly, because nothing in `backend/` changed.

## Files changed

- `mobile/app/(tabs)/watch.tsx` — `WatchActionButton` (the icon-button primitive, local to this
  screen), `alertWatchActionNotBuilt()`, per-member camera/audio status + reason computation, updated
  header comment and footnote.
- `mobile/src/domain/consentStatus.ts` — new `disabledReasonFor(status, member)`.
- `mobile/test/consent-status.test.ts` — 4 new tests.
- `docs/DECISIONS.md` — **D-034** appended.
- `docs/PHASES.md` — 6-D-5 row → done; `## Now` / `## Next 3` repointed to 6-D-6.
- `docs/HANDOFF.md` — this file.

## Decisions made

Recorded durably as [DECISIONS.md](DECISIONS.md) **D-034**; the rest below are session-local
judgment calls kept here only, same convention 6-D-4 used.

- **Tapping an enabled Camera/Listen button is an honest "not built yet" alert, not a stub screen and
  not a silent no-op.** See D-034 for the full reasoning — the short version: a stub screen would
  have reached into 6-D-7's already-named scope, and a silent no-op on a button that just proved it
  has a real consent gate behind it reads as broken, not unfinished.
- **`disabledReasonFor`'s `'expired'` copy is a judgment call, not a spec-locked value** — B3/F4 only
  name the `'none'` and `'revoked'` strings. Wrote *"{name}'s access expired — it renews automatically
  once they reopen their app,"* consistent with F3's actual mechanism (the **grantor's** phone renews
  its own outbound grant on its next bootstrap — not mine, since the card shows grants made *to* me)
  and the tone of `map.tsx`'s existing location-expired string. Flagged, not silently invented, same
  category as 6-D-4's `purpose: 'safety'` call.
- **The B1 "one reason line" and F1 "separately revocable" requirements were reconciled by
  deduping**, not by picking one over the other — see "Done" above.
- **I corrected my own scope statement mid-session.** The phase I announced at boot said "Watch tab
  renders Refresh/Camera/Listen icon-buttons" — before I had read PHASES.md's own 8-phase table
  (the granular one, not the summary paragraph above it), which assigns Refresh to **6-D-6** (it needs
  a new push-triggered location mechanism: "touches `notify` + a client push-handler"). Built
  Camera/Listen only, per that table, once I found it. No Refresh button exists in `watch.tsx` yet —
  this was not a user correction, just a self-caught mismatch between what I said and what the
  project's own status board already specified.

## Known broken / deliberately skipped

- **No Refresh button yet** — that is 6-D-6's job, which needs a new server round-trip (a
  push-triggered one-shot `getCurrentPositionAsync`) this phase does not touch.
- **Camera/Listen do not open a real session** — tapping an enabled button is honest about this
  (D-034) rather than faking one. The live-view/listen screens, `react-native-webrtc`, and the TURN
  relay are all 6-D-7, and are unverifiable on this machine regardless (D-021 — no JDK/Android SDK).
- **The join→store bridge gap from 6-D-4 (D-033) is still open**, and this phase makes it more
  visible, not less: in the running app today, essentially every member's card will show the B3
  "not sharing yet" reason for camera/audio, because `grantFamilyMembershipScopes` still has zero
  call sites. This phase did not change that — it only makes the UI correctly *reflect* the gap
  instead of hiding it behind 6-D-4's hardcoded "coming in a later update" footnote.
- **No JSX-rendering test harness still** — same as every 6-D UI phase. `tsc --noEmit` and the new
  `disabledReasonFor` tests catch type/logic errors, not layout; the card's visual arrangement (two
  40×40 circles next to a Pill, an optional reason line below) has not been screenshotted.

## Next session starts here

- **Phase 6-D-6**: On-demand location push (spec rows C1–C3) — a push-triggered one-shot
  `getCurrentPositionAsync` for the Refresh button, 8s timeout with an honestly-labelled stale
  fallback if no fix returns. Adds the actual Refresh icon-button to `watch.tsx`'s per-member card,
  alongside the Camera/Listen buttons this session added.
- **First command:**
  ```
  git checkout shivam
  git log --oneline -1              # confirm you're on 71ba026d or later
  cd mobile && npm run verify
  cd ../backend && go build ./... && go vet ./... && go test ./...
  ```
- **Watch out for:**
  1. **6-D-6 is the first 6-D-* phase to touch the backend.** Read `internal/notify`'s existing FCM
     send path (`fcm.go`, `notify.go pushPayload()`) before adding a new message kind — F-21's
     seven-field allowlist is enforced twice, fail-closed (`assertPushSafe` server-side,
     `readPushFields` device-side, both in [PROJECT_MAP.md](PROJECT_MAP.md)'s "What a push says"
     section). A new push kind needs both allowlists updated, not just the sender.
  2. **The device being refreshed may have its app backgrounded or closed** — C1 says "regardless of
     whether their app is foregrounded," which is exactly what 1.35e (background push receive)
     already proves works for incident alerts. Reuse that receive path (`src/state/pushReceive.ts`)
     rather than building a second one.
  3. **The join→store bridge gap (D-033) is unrelated to 6-D-6 and still unresolved.** Do not let a
     future phase quietly fold that bridge into an unrelated phase's scope, per the same reasoning
     D-033 already recorded — it needs its own phase.
