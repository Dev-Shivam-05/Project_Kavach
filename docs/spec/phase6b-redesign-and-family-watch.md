# SPEC LOCK — Phase 6-B: nav redesign + Family Watch (location / camera / mic)

Locked 2026-08-29, pending user approval. Written against commit `52acfb76` on branch `shivam`.

This file is the contract. A future session with no memory of this chat must build the identical
thing from it. No implementation value may appear that is not in a table here; a missing decision
found mid-build means: stop, add a row, get one-word approval.

**Supersedes** rows **B1–B5** of [phase6-pull-forward.md](phase6-pull-forward.md) (the centre SOS
button) — that button is removed from the tab bar per the user's 29 Aug decision (RISK 20 revisited,
[HANDOFF.md](../HANDOFF.md) 29 Aug entry). **Confirms unchanged**: sections C (map), D (camera+mic —
"Family Watch"), E (family creation/size/identity), G (mock removal) of that file. D2–D6 in
particular are **fixed inputs to this spec, not open questions** — they were locked by this same
user on 21 Aug and re-confirmed on 29 Aug after a direct discussion of why D3 (the on-device
indicator) does not become optional. See that file's own words: *"The line between a consented
family feature and stalkerware."*

**Confirmed 29 Aug**: SOS is removed from its centre-tab position only. The underlying trigger
(`app/panic.tsx`, the arm/cancel-countdown flow, the T0 survival plane, the escalation ladder) is
**unchanged and stays wired** — this is a navigation change, not a removal of the safety system.

---

## A · Nav — the SOS button leaves the tab bar

| # | Ambiguity | Locked value | Why this default |
|---|-----------|--------------|------------------|
| A1 | tab layout after the FAB is removed | 5 flat, equal-weight tabs, same height (60dp + safe-area inset), no raised element: **Home · Family · Map · Incidents · Settings**. | Removing the 66px raised red circle is most of the "bhari bhari" (heavy) fix on its own — a flat bar of five is the plainest replacement, not a redesign-within-a-redesign. |
| A2 | new "Family" tab | A new screen — see section D below — showing one card per family member with location / camera / listen actions. This is the direct home for the feature set you described. | The task you described ("kisi ki location dekhna, camera access, mic access") needs one place to live; today it is spread across Map (location only) and nowhere (camera/mic don't exist yet). |
| A3 | where SOS goes | A small (40×40dp) outline icon button, top-right of the Home screen header. Glyph: Feather `alert-triangle`. No fill, no red background — `colors.dangerText` on transparent, 1.5px stroke. Tapping it pushes `/panic`, identical flow to today (hold-to-fire, cancel countdown) — **zero change to `panic.tsx` or the arm/cancel logic**. | Present and reachable in one tap from the home screen, as required by having a real safety system at all — but visually the quietest control on the screen, not the centrepiece. Outline-not-fill keeps `danger` (fill) as a state reserved for an actually active incident, never a resting nav element (A3 in the original lock — alarm red stays the one loud colour, and now the SOS *entry point* is not loud either, only an *active* incident is). |
| A4 | icon-glyph replacement, whole app | Add `@expo/vector-icons` (Feather set, 22px, 1.5px stroke, no fill except where a token already specifies a filled treatment — pills, badges). Replace every text-character glyph (`⌂ ◎ ⚠ ⚙ ▣ ↯ ▮ ▤ ◉` etc.) 1:1 by meaning across every screen, not just the tab bar. | This is the actual "cringe" fix. Text-character glyphs read as placeholder art; a real icon set is the single highest-leverage visual change available and touches nothing safety-tested (contrast rule applies equally to icon colour, unchanged). `@expo/vector-icons` ships inside `expo` itself — zero new native dependency, unlike WebRTC/MapLibre already accepted below. |
| A5 | card density ("heavy") | Neutral/info pills (`Pill` component, most `tone="neutral"` and `tone="info"` uses) switch from filled-soft-background to **outline-only**: 1px border in the tone's `*Border` token, transparent fill, text in the tone's `*Text` token. `danger` and `warn` pills involved in an **active incident or an active Family Watch session** keep their filled treatment — nothing safety-critical gets quieter. | Roughly halves the number of solid colour blocks on a typical card (Home, Incidents, the new Family tab) without touching a single contrast-tested pair — outline pills use the same `*Border`/`*Text` tokens already computed at 7:1/3:1. |
| A6 | card padding | Card internal padding becomes `space.lg` (16) all sides, minimum `space.md` (12) gap between stacked rows inside one card — up from the current mix of `space.sm`/`space.md`. | More breathing room per card reads as "modern"; both values already exist in `theme.ts`'s 4pt scale, nothing invented. |

## B · The new "Family" tab

| # | Ambiguity | Locked value | Why this default |
|---|-----------|--------------|------------------|
| B1 | one member's card contents | Avatar/crest colour + name · a location line (`"320m away · updated 12s ago"` or, honestly, `"Location not shared"` per the existing non-negotiable rule) · three icon-buttons: **Refresh** (Feather `refresh-cw`), **Camera** (Feather `video`), **Listen** (Feather `mic`). | One row per member, one glance answers "where / can I see / can I hear" — directly the three actions you described. |
| B2 | "Listen" not "Recording" as the button label | The UI never uses the word "recording" anywhere in this feature. Button says **Listen**; the live-audio screen header says **"Listening to {name}"**. | You described the behaviour as "agle kuch minutes tak sun sake" — live listening, not persisted audio. D6 (already locked) is "no recording, no storage of any camera/mic stream." Calling the button "Recording" would tell the user something is being saved when it is not — mislabelling a live feature as a recorder is the kind of thing that gets an app removed from a store and a builder sued. The functionality you asked for is exactly what "Listen" delivers. |
| B3 | member with no grant yet | Card still renders (name, avatar) with all three actions **disabled** and a one-line reason: `"Not sharing location/camera/mic yet — ask them to finish joining."` See row D-CONSENT below for how a member starts sharing. | Matches the existing honest-empty-state rule (map.tsx: never fabricate, never imply access that isn't there). |

## C · Location — the one-tap "check now"

| # | Ambiguity | Locked value | Why this default |
|---|-----------|--------------|------------------|
| C1 | what "Refresh" does | Tapping Refresh on a member's card sends that member's phone a silent data-push (reuses the existing FCM data-only channel, `notify` package) asking for **one immediate `expo-location.getCurrentPositionAsync` fix**, regardless of whether their app is foregrounded. The result comes back over the existing realtime/push path and updates the pin + card line the moment it arrives. | This is the actual mechanism behind "ek click kare to unki current location update ho jaye" — the existing 10s-foreground watch (already locked, C6 in the prior spec) only helps while B's app is open; a push-triggered one-shot fix is what makes it work when B's phone is in their pocket. |
| C2 | while waiting | Refresh icon shows a spinner for up to 8s. If no fix returns (phone offline, no GPS lock), the card falls back to the last-known fix with its honest age (`"showing a fix from 6 minutes ago"`) — never a fabricated "live" label on a stale point. | Matches the map screen's existing non-negotiable honesty rule (C5 of the prior lock). |
| C3 | accuracy shown | Distance-from-you + a small accuracy-radius chip when the fix's GPS accuracy is worse than 30m (`"±45m"`). | Matches `FamilyMapView`'s existing accuracy-circle convention (C4 of the prior lock) — this is that same data, in card form. |

## D · Camera — "Family Watch" live view

| # | Ambiguity | Locked value | Why this default |
|---|-----------|--------------|------------------|
| D1 | tap behaviour | Tapping Camera on a member's card opens a live-view screen **immediately** — no approval dialog on the viewer's side, matching D2 (already locked: "auto-allow within the family, frictionless"). Transport: WebRTC per D1 of the prior lock, TURN relay for across-city. | This is the one-tap-and-it-opens behaviour you described. Nothing added here slows the viewer down. |
| D2 | on the WATCHED person's phone, at the same moment | The mandatory, non-suppressible banner + status dot + start-sound from D3 (prior lock) appears the instant the session opens — before the viewer's first frame renders, not after. | D3 is non-negotiable; this row only pins the *timing* (immediate, not delayed) so it can never be raced. |
| D3 | front/back toggle | A flip-camera icon (Feather `refresh-ccw`, distinct from the Refresh icon above) sits bottom-centre of the **viewer's** (A's) live-view screen. Tapping it remotely switches which of B's two cameras is streaming. The on-device indicator on B's phone does not change wording when the camera flips — still just "X is viewing your camera." | You asked for the toggle explicitly; putting the control on the viewer's screen is the only placement that matches "family member A ko dikhna chahiye" without requiring B to do anything mid-session. |
| D4 | session length, camera | No fixed timer — stays open until either party ends it (viewer taps End, or the watched person uses their always-available kill from D5, prior lock). | Matches "abhi kya ho raha hai" — an open live view, not a clip. |
| D5 | access log entry | One `AccessLogEntry` row written at session start (`what: "camera_view_started"`) and one at end (`what: "camera_view_ended", durationS`). Both are readable by the watched person in Settings › Privacy, same list that already shows other access-log entries. | D4 (prior lock) — a property nobody can see is a promise nobody can check. Re-uses the existing `AccessLogEntry` type and existing Settings screen, no new surface. |

## E · Listen — live-audio session

| # | Ambiguity | Locked value | Why this default |
|---|-----------|--------------|------------------|
| E1 | tap behaviour | Same as Camera (D1) — opens immediately, audio-only WebRTC, same on-device indicator (D2 above) at the same instant. | Consistency; also the cheapest way to prove the transport works before video (RISK note already in the prior lock: "audio-only 1↔1... before video/UI"). |
| E2 | session length | **5 minutes**, shown as a countdown ring around the End button. A **"+5 min"** button extends it once tapped, repeatable with no cap. Auto-ends at 0:00 unless extended. | You said "agle kuch minutes tak" — a bounded default that matches your own words exactly, extendable so a real need is never cut off, and bounded by default so a family member's mic is never left open indefinitely by accident (battery + the same transparency principle as D3 — an indicator that could stay lit for hours unnoticed is weaker than one that visibly has to be renewed). |
| E3 | what the watched person sees during Listen | Identical indicator to Camera (D2/D3 prior lock) — banner + dot + sound. The banner text distinguishes the two: `"{name} is viewing your camera"` vs `"{name} is listening"`. | One mechanism, two label strings — no new UI system. |
| E4 | access log | Same shape as D5, `what: "listen_started" / "listen_ended"`. | Consistency with D5. |

## F · Consent plumbing under B/D/E (new — not in the 21 Aug lock)

| # | Ambiguity | Locked value | Why this default |
|---|-----------|--------------|------------------|
| F1 | new consent scope | Add `'camera'` to the `ConsentScope` union in `core/types.ts` (currently `live_location \| history \| vitals \| audio \| documents \| screen_time`). `audio` already exists and covers Listen. | `camera` (video) and `audio` (mic) are different capabilities and must be separately revocable — a member should be able to allow Listen and refuse Camera, or vice versa. |
| F2 | how the "frictionless" grant is created | Add `'family_membership'` to `ConsentGrant.grantedVia` (currently `'self' \| 'guardian_policy' \| 'autonomy_ramp'`). When a member finishes joining a family (existing enrolment flow), the app auto-creates **mutual** `camera` and `audio` grants between them and every existing member — this is what makes D1/E1 frictionless with no per-session approval. | Matches D2's already-locked "auto-allow within the family" — the grant exists because you're in the family, not because you clicked yes twice. |
| F3 | expiry (I-5: no permanent grant) | These auto-created grants expire **90 days** from `grantedAt` and silently self-renew unless the member has revoked that scope in Settings › Privacy. Revoking is instant (existing Layer-1 revocation) and immediately disables Camera/Listen on that member's card for everyone. | `expiresAt` is never null anywhere in this schema (I-5) — a "frictionless" grant still has to be a real, bounded, revocable grant, not a special-cased permanent one. 90 days matches the order of magnitude of other long-lived grants already in the codebase pattern (autonomy-ramp style windows) without inventing a new number class. |
| F4 | member who revokes | Their card in the Family tab still shows their location (if `live_location` is separately still granted) but Camera/Listen show disabled with `"{name} has turned this off."` — never hidden entirely, never silently re-enabled. | Matches the app's own existing revocation-is-visible convention (F-14). |

## G · Geofencing — fix the "only my current position" gap

| # | Ambiguity | Locked value | Why this default |
|---|-----------|--------------|------------------|
| G1 | today's real limitation | `app/(tabs)/map.tsx`'s existing add-geofence form only accepts *your own current position* as the centre (`"Add a geofence centred on your current position"`, line 474) — it cannot place a fence at an arbitrary named place like "office" while you're at home. This is a real gap against what you asked for ("ye particular location, x jagah"), independent of the redesign. | Read from the current code, not assumed. |
| G2 | fix | Once the MapLibre map lands (6-B, already locked as C1–C7 in the prior spec), geofence creation becomes tap-and-hold on the map to drop a centre pin anywhere in view (not just your position), then a radius drag-handle, then the existing name field. Until MapLibre lands, the interim fix on the current SVG map is a manual lat/lon entry field as a second option alongside "use my position." | Ties the real fix to the map engine that can actually support it (tap-anywhere-on-a-real-map); gives you the capability sooner via a plain text-entry fallback rather than waiting on 6-B. |

---

## OUT OF SCOPE (will NOT build)
- Persisted/stored recordings of camera or mic sessions (D6, already locked — a live-only feature, not a DVR).
- Removing D2–D6 (the on-device indicator, access log, kill-switch) — fixed, not up for renegotiation, per the 29 Aug discussion.
- Removing the SOS trigger, the escalation ladder, or any T0/backend safety code — only the tab-bar button moves; confirmed 29 Aug.
- Group camera/mic sessions (still 1↔1, per the prior lock's OUT OF SCOPE).
- A basemap/tile provider decision beyond what C1–C3 already locked (MapTiler Standard + Satellite) — not reopened here.

## ACCEPTANCE CRITERIA (binary)
- [ ] Tab bar shows 5 equal-weight tabs, no raised element; SOS opens `/panic` via a 40×40dp outline icon on Home, unchanged arm/cancel flow underneath.
- [ ] Every text-glyph icon in the app is replaced by a Feather icon of matching meaning; `grep -rn "[⌂◎⚠⚙▣↯▮▤◉]" mobile/` returns nothing outside `theme.ts`'s own historical comments.
- [ ] Family tab renders one card per member with Refresh/Camera/Listen; a member with no grant shows all three disabled with the stated reason string, never a broken/blank control.
- [ ] Tapping Refresh updates the card's location line within 8s or falls back to a labelled stale fix — never an unlabelled one.
- [ ] Tapping Camera or Listen opens the live session with zero intermediate dialog on the viewer's side, AND the watched device's indicator (banner+dot+sound) is confirmed on screen before or at the same instant the viewer's first frame/audio arrives — never after.
- [ ] Front/back toggle on the viewer's live-view screen switches the watched device's active camera within 2s.
- [ ] A Listen session shows a 5:00 countdown, auto-ends at 0:00, "+5 min" extends it; an ended session (by either party) closes both sides' screens within 1s.
- [ ] One `AccessLogEntry` row exists per session start and end, visible to the watched person in Settings › Privacy.
- [ ] Revoking `camera` or `audio` scope disables the corresponding button on that member's card everywhere in the app within one app-foreground cycle, and shows `"{name} has turned this off"` rather than hiding the control.
- [ ] `tsc --noEmit` and `npm test` green with the new `ConsentScope`/`grantedVia` values wired through `core/types.ts`, `db/schema.ts`, `db/repos.ts`, `net/api.ts`, `state/store.ts`.

## RISKS
- D/E (camera+mic transport) are still the least-verifiable, highest-cost piece on this machine — same native-WebRTC-plus-device limitation already recorded in the prior lock (D-021). TS/consent/UI logic is buildable and testable here; the actual live stream needs a device build.
- Adding `@expo/vector-icons` touches every screen's icon usage in one pass — do it as its own commit, separate from any behavioural change, so a visual regression is easy to isolate.
- The new `family_membership` grant path means every future enrolment test needs an assertion that the mutual grants were actually created — add it alongside the enrolment characterization tests already in the codebase (`enrolment_test.go`, `enrolment.test.ts`), not as an afterthought.
- 90-day auto-renewal (F3) is a genuinely new kind of grant lifecycle in this codebase — the existing renewal/expiry sweep job (if any) needs to know about it; confirm during implementation rather than assuming it is automatic.

Reply `go` to build all of it, or `change <row numbers>` with your values.
