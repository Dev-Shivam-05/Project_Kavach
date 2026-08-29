# HANDOFF — Kavach — Phase 6-D-1b — 2026-08-29

Branch **`shivam`**, commit `1604923b`, **pushed** to `origin/shivam`. This handoff supersedes the
earlier 29 Aug one (6-D-1, commit `0bbf4742`), preserved in git history.

## Done

- **6-D-1b shipped: SOS is reachable in one tap from every tab, not just Home.** Removing the
  tab-bar FAB in 6-D-1 dropped Map/Incidents/Settings/Watch from "zero taps, any screen" to "one
  tab away" — this closes that gap. Each of those four screens' header now carries a small (44×44)
  outline SOS icon (Feather `alert-triangle`, `colors.dangerText`, no fill) that pushes `/panic` —
  the identical target and flow the old FAB used. `panic.tsx`, the arm/cancel-countdown logic, the
  T0 survival plane and the escalation ladder are **completely unchanged**.
- **New `src/ui/components/SosHeaderButton.tsx`** — one component, dropped into all four screens,
  rather than four hand-rolled copies. Reused the dormant `tab.sos` / `tab.sosHint` i18n strings
  (present in en/hi/gu since before 6-D-1, unused since the FAB left the tab bar) for its
  accessibility label/hint instead of inventing new copy.
- Each screen's `header` block (a single-column `View` with title + subtitle) was restructured into
  a `headerRow` (the existing column, now `flex: 1`, plus the new button) — done identically in all
  four files, including both the loading-skeleton and ready-state header instances where a screen
  has both (map.tsx, incidents.tsx, settings.tsx all do; watch.tsx has only the one).
- Verified green: `tsc --noEmit` (0 errors), `npm test` **171/171** (unchanged — no new tests were
  needed or added; there is no JSX-rendering test harness in this repo to extend, see "Watch out
  for" below).
- **Attempted a screenshot, found a real dead end, and recorded it rather than skipping silently:**
  `expo start --web` starts Metro but warns `react-native-web is not installed` before anything can
  render — this project has no web target dependency, so web preview is not a viable fallback for
  visual verification the way it might be in a typical Expo project. Added to `CLAUDE.md` so a
  future session doesn't spend the same few minutes rediscovering it.

## Files changed

- `mobile/src/ui/components/SosHeaderButton.tsx` **(new)** — the reusable 44×44 outline SOS icon
  button; `onPress` is `router.push('/panic')`.
- `mobile/src/ui/components/index.ts` — barrel export for the new component.
- `mobile/app/(tabs)/map.tsx` — header restructured to `headerRow` + `SosHeaderButton`, both header
  instances (skeleton + ready).
- `mobile/app/(tabs)/incidents.tsx` — same, both header instances.
- `mobile/app/(tabs)/settings.tsx` — same, both header instances.
- `mobile/app/(tabs)/watch.tsx` — same, single header instance.
- `docs/PHASES.md` — 6-D-1b row → ✅; `## Now` / `## Next 3` repointed at 6-D-2.
- `CLAUDE.md` — one new paragraph: `react-native-web` is absent, so `expo start --web` cannot be
  used to screenshot a change on this machine either.

## Decisions made

- None of DECISIONS.md's caliber this session — the only judgment calls (reusing `tab.sos`/
  `tab.sosHint` instead of new copy; one shared component instead of four inline copies) are
  ordinary implementation choices already explained in the commit message and the PHASES.md row,
  not spec conflicts or safety tradeoffs. No new `DECISIONS.md` entry was added.

## Known broken / deliberately skipped

- **No screenshot exists of the four new header icons.** Per house rule #8, done means verified, not
  just compiling — and this is the one part of #8 not met. Blocked on two independent things: no
  JDK/Android SDK for a device build (D-021), and no `react-native-web` for a web fallback (new
  finding this session, now in `CLAUDE.md`). What *is* verified: `tsc`'s JSX/type check on the exact
  markup, and the fact that all four screens now share one identical, already-typechecked
  `headerRow` pattern.
- Everything else in the Phase 6-D table is exactly as the 6-D-1 handoff left it — 6-D-2 (icon
  sweep), 6-D-3 (visual density), 6-D-4 (consent plumbing), 6-D-5/6/7/8 all unbuilt.

## Next session starts here

- **Phase 6-D-2**: the icon sweep — replace every remaining text-glyph icon (`⌂ ◎ ⚠ ⚙ ▣ ↯ ▮ ▤ ◉`)
  app-wide with `@expo/vector-icons` Feather (22px, 1.5px stroke), one-to-one by meaning. This is
  the actual "cringe" fix (A4 in the spec lock) and is likely to touch more than 8 files — check
  early and split the row in `PHASES.md` if so, per the ≤8-files rule.
- **First command:**
  ```
  git checkout shivam
  git log --oneline -1   # confirm you're on 1604923b or later
  cd mobile && npm run verify
  ```
- **Watch out for:**
  1. **There is no JSX-rendering test harness in this repo.** `mobile/test/*.test.ts` runs under
     plain Node (no Metro, no jest, no React Testing Library) and exercises logic — state machines,
     consent rules, i18n, contrast math — never a rendered component tree. A UI-only change like
     this one has no automated test that would fail if the JSX were wrong; `tsc --noEmit` catches
     type errors, not layout or visual bugs. This is the correct trade-off for this repo's toolchain,
     not an oversight, but it means icon-sweep work needs an actual device or extra care reading the
     diff, not just a green `npm test`.
  2. **`expo start --web` is a dead end for screenshotting anything here** — see the new `CLAUDE.md`
     paragraph. Don't re-attempt it; the fix (adding `react-native-web`) would be a new dependency
     no one has asked for, not a quick unblock.
  3. **`react-native-web` is absent for a reason worth checking before adding it**, if a future
     session is tempted to install it just to get screenshots: this repo's whole Kotlin/native-Tier-0
     story (D-021) already treats "can't verify visually on this machine" as a known, accepted
     limitation rather than a gap to engineer around — adding a new frontend target changes the
     project's supported-platform surface and is a call for the user, not a convenience fix.
