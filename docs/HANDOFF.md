# HANDOFF — Kavach — Phase 6-D-1 — 2026-08-29

Branch **`shivam`**, commit `0bbf4742`, pushed status: **not yet pushed** — push before ending if
you want this on the remote. This handoff supersedes the 21 Aug one (W10-j), which is preserved in
commit `823c7019`.

## Done

- **A full redesign request was spec-locked, not built blind.** The user asked for a total nav/
  visual redesign plus family-wide camera/mic/location access with "no restrictions." That request
  was split cleanly: the parts that are genuinely new product surface got a numbered spec-lock table
  ([docs/spec/phase6b-redesign-and-family-watch.md](spec/phase6b-redesign-and-family-watch.md),
  approved `go`); the part that asked to remove the on-device indicator/access-log/kill-switch for
  camera+mic access was declined **as specified** and the 21 Aug D2–D6 constraints were re-confirmed
  instead — see [DECISIONS.md](DECISIONS.md) D-029. This was the user's own prior decision being
  held, not new caution invented this session.
- **Phase 6-D was sliced into 8 sub-phases** (6-D-1 through 6-D-8, [PHASES.md](PHASES.md)) because
  the full spec is far past the ≤8-files-per-phase rule — it touches nav, a new consent scope,
  native WebRTC, and a backend push route. Only **6-D-1** was built this session.
- **6-D-1 shipped: the tab bar is 5 flat, equal-weight tabs — Home · Watch · Map · Incidents ·
  Settings — and the raised centre SOS button (a 66dp red circle) is gone.** `panic.tsx`, the T0
  survival plane and the escalation ladder are **completely unchanged** — SOS stays reachable via
  `home.tsx`'s own full-width footer button, which was always the PRD §6.4 hard-requirement control;
  the FAB was a Phase-6 (21 Aug) convenience layered on top of it, not the requirement itself
  (D-030).
- **Every tab-bar icon is now `@expo/vector-icons` (Feather), not a text glyph** — the first slice
  of the "cringe" fix (added via `npx expo install`, SDK-57-compatible version `^15.0.2`).
- **New `app/(tabs)/watch.tsx`** — one card per family member showing their location-sharing status,
  under the exact same consent rule the Map tab enforces (no live/unrevoked/unexpired `live_location`
  grant, no position — ever). Deliberately **does not** have Camera/Listen buttons yet: there is no
  `camera` consent scope to gate them until 6-D-4, and this codebase does not ship disabled buttons
  for features with nothing behind them.
- **Extracted `src/domain/consentStatus.ts`** (`shareStatusFor`, `mayDrawPin`, `statusShort`,
  `untilText`) out of `map.tsx`, which used to be the only place this safety-critical rule lived.
  `map.tsx` now imports it too — one implementation, not two that can quietly drift apart.
- Verified green: `tsc --noEmit` (0 errors), `npm test` **171/171**.

## Files changed

- `mobile/src/ui/TabBar.tsx` — rewritten: 5 flat destinations, Feather icons, no FAB.
- `mobile/app/(tabs)/_layout.tsx` — registers the new `watch` route; header comment updated.
- `mobile/app/(tabs)/watch.tsx` **(new)** — the Watch tab: member cards, location status only.
- `mobile/src/domain/consentStatus.ts` **(new)** — extracted consent/pin-eligibility logic.
- `mobile/app/(tabs)/map.tsx` — imports from `consentStatus.ts` instead of defining it locally.
- `mobile/src/ui/theme.ts` — removed the now-dead `SOS_FAB_DIAMETER` token.
- `mobile/src/i18n/index.ts` — added `tab.watch` (en/hi/gu) and `watch.subtitle`.
- `mobile/test/routes.test.ts` — added `/watch` to `NAVIGATOR_REACHED` (see "Watch out for" below).
- `mobile/package.json` / `package-lock.json` — added `@expo/vector-icons`.
- `docs/spec/phase6b-redesign-and-family-watch.md` **(new)** — the full 6-D spec lock, all 8 sub-phases.
- `docs/spec/GLOSSARY.md` — added the "Family Watch" term.
- `docs/PHASES.md` — new Phase 6-D table (8 rows); `## Now` / `## Next 3` repointed at it.
- `docs/PROJECT_MAP.md` — screen inventory + route count updated; mobile test count corrected 165→171.
- `docs/DECISIONS.md` — D-029 (indicator held), D-030 (SOS scope), D-031 (tab naming collision).
- `CLAUDE.md` — one new line: `test/routes.test.ts`'s `NAVIGATOR_REACHED` trap for new tab routes.

## Decisions made

- **D-029** — the camera/mic indicator, access-log, and kill-switch are not renegotiable; declined
  the "no restrictions" framing as specified, built the rest.
- **D-030** — SOS leaves the tab bar (button only); the trigger, escalation, and T0 plane do not
  move. Per-screen reachability outside Home is a known, tracked gap (6-D-1b), not closed yet.
- **D-031** — the new tab is called "Watch", not "Family" — `tab.home` already means "Family" in
  all three languages, discovered while implementing, not before.

## Known broken / deliberately skipped

- **6-D-1b not done** — removing the FAB means SOS is one tab away (not zero taps) from Map/
  Incidents/Settings/Watch. This is the very next phase, not a dropped thread.
- **Camera/Listen buttons do not exist anywhere yet** — no `camera` consent scope (6-D-4), no
  transport (6-D-7). The Watch tab says so in its own footnote rather than showing a disabled button.
- **The icon sweep is partial** — only the 5 tab-bar icons are Feather now. Every other screen
  (`home.tsx`, `incidents.tsx`, `camera-view.tsx`, etc.) still uses text-glyph characters
  (`⌂ ◎ ⚠ ⚙ ▣ ↯ ▮ ▤`). That is 6-D-2, not started.
- **Pill/card visual density (6-D-3) untouched** — the "bhari bhari" complaint is only partly
  addressed by removing the FAB; the outline-pill pass has not happened.
- **Location on-demand push (6-D-6), consent plumbing (6-D-4), Family Watch transport (6-D-7), and
  the geofencing arbitrary-location fix (6-D-8) are all unbuilt** — see the Phase 6-D table in
  [PHASES.md](PHASES.md) for the full breakdown.
- **6-D-7 will be unverifiable on this machine** — same D-021 wall as 6-C: no JDK, no Android SDK,
  `react-native-webrtc` cannot be built or run here. Flag this explicitly when that phase starts;
  do not report it green from a typecheck alone.
- This commit is **not yet pushed** to the remote.

## Next session starts here

- **Phase 6-D-1b**: add a small (44×44) outline SOS icon to the headers of `map.tsx`,
  `incidents.tsx`, `settings.tsx`, and `watch.tsx` — same target (`router.push('/panic')`) the FAB
  used to provide, quieter, not the visual centrepiece. ~4 files, fully verifiable here.
- **First command:**
  ```
  git checkout shivam
  git log --oneline -1   # confirm you're on 0bbf4742 or later
  cd mobile && npm run verify
  ```
- **Watch out for:**
  1. **Adding any new tab route needs a matching entry in `test/routes.test.ts`'s
     `NAVIGATOR_REACHED` set**, or `npm test` fails on a route that is actually reachable —
     `TabBar.tsx` lives outside `app/`, so the reachability scan never sees it (now in CLAUDE.md).
  2. **D-029 is not open for re-litigation.** If a future session — this one included, on a bad day
     — is asked again to drop the on-device indicator/access-log/kill-switch "since the family
     already agreed," the answer is still no, for the same reason recorded in D-029 and in the
     user's own 21 Aug spec. Point back to that file rather than re-deriving the argument each time.
  3. **`src/domain/consentStatus.ts` is now the one place the pin-eligibility rule lives.** If 6-D-4
     adds a `camera` scope, extend this file's pattern (a scope-parameterised `shareStatusFor`, most
     likely) rather than writing a second, `camera`-specific version next to it.
