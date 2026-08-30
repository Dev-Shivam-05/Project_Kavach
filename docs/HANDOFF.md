# HANDOFF — Kavach — Phase 6-D-2b — 2026-08-30

Branch **`shivam`**, commit `813f4aa3`, **pushed** to `origin/shivam`. This handoff supersedes the
30 Aug 6-D-2a one (commit `7f2b5866`), preserved in git history.

## Done

- **6-D-2b shipped: icon sweep, part 2 of 2 — the sweep is now complete.** All 8 remaining files from
  the spec-A4 grep are clean: `panic.tsx` (4 occurrences), `camera-view.tsx` (5), `incident/[id].tsx`
  (1), `consent.tsx` (1), `drills.tsx` (2), `journeys.tsx` (1), `vault.tsx` (1), `camera-node.tsx` (1).
  `grep -rn "[⌂◎⚠⚙▣↯▮▤◉]" mobile/` now returns **nothing at all** — spec A4's acceptance criterion is
  met, and the two-part split from 6-D-2a is done.
- **`Pill` gained a public `icon?: keyof typeof Feather.glyphMap` prop**, additive next to `glyph`,
  mirroring `ListItem`/`EmptyState`'s existing pattern (icon wins over glyph, which wins over the
  per-tone `DEFAULT_ICON`, which wins over the per-tone `DEFAULT_GLYPH`). 6-D-2a only exposed a
  *tone-default* Feather icon internally (`warn` → `alert-triangle`); this phase needed callers to
  override with a specific icon per occurrence (`incident/[id].tsx`'s DRILL pill, four Pills in
  `camera-view.tsx`), which the tone-default mechanism alone could not express.
- **Selective conversion inside mixed strings/functions** — three places returned more than one
  glyph and only one of the returned values was in the catalogued 9-character set, so the fix could
  not be "swap the function," it had to be "swap one branch of the function":
  - `panic.tsx`'s `degradationGlyph()` → renamed `degradationMark()`, returns `{ glyph } | { icon }`
    (same shape as 6-D-2a's `home.tsx homeEventGlyph`). Only the worst-tier mark (`⚠`) became
    `alert-triangle`; `✓` and `ℹ` are untouched, per D-032.
  - `panic.tsx`'s `NotifiedList` row (`✓` stays text, `⚠` → icon) and PIN-entry prompt row (`•` stays
    text, `⚠` → icon) — both now branch on the boolean that already existed (`row.delivered`, `wrong`)
    rather than switching on a returned character.
  - `vault.tsx`'s `KIND_GLYPH` map lost its `document: '▤'` entry (type narrowed to
    `Partial<Record<...>>`); a new `kindMark()` helper returns `{ icon: 'archive' }` for `document`
    and `{ glyph: KIND_GLYPH[kind] }` for the other four kinds (`✚ ☰ ▦ ⚿`, all untouched). A new local
    `KindGlyph` component renders the raw `<Text>` in the quorum-object card header; the `ListItem`
    call site spreads `{...kindMark(v.kind)}` directly.
  - `panic.tsx`'s "nobody responded" banner had only one glyph (`⚠`, always shown) — swapped straight
    to `Feather alert-triangle`, and the now-fully-dead `nobodyGlyph` style was deleted (same as
    6-D-2a's `_layout.tsx` `warnGlyph` removal).
- **`camera-node.tsx`'s local `Rule` component gained an optional `icon` prop** (`glyph` is now
  optional too, same pattern as `ListItem`). Only its `⌂` call site (the "switches off automatically
  when someone is home" rule) became `icon="home"`; the other four `Rule` glyphs in the same list
  (`● ◼ ⚿ ✕`) are untouched — not in the catalogued set.
- **Per-occurrence icon choices, not a character→icon lookup table** (same judgment call as 6-D-2a,
  restated because the same character split differently again this time):
  - `▣` → `camera` (both camera-view.tsx occurrences: the empty state and the Section count Pill).
  - `↯` → `zap` (camera-view.tsx, motion-detected Pill).
  - `▮` → `battery` / `battery-charging`, chosen dynamically off `node.charging` (camera-view.tsx,
    battery Pill). The `⚡` character already in that Pill's label text is untouched — not one of the 9.
  - `▤` → `image` (camera-view.tsx, snapshot-count Pill — a photo, not a document) **vs.** `▤` →
    `archive` (drills.tsx "Backup restore" ListItem, and vault.tsx's `document` kind — both documents).
  - `◎` → `target` (incident/[id].tsx DRILL Pill) **vs.** `◎` → `users` (journeys.tsx "Nobody is
    travelling" empty state, matching 6-D-2a's map.tsx "Nobody to map" → `users`).
  - `◉` → `eye` (consent.tsx access-log row — "you viewed X's location").
  - `⚠` → `alert-triangle` everywhere it appeared (5 occurrences across panic.tsx and drills.tsx) —
    the one character that was unambiguous every time.
- Verified green: `tsc --noEmit` (0 errors), `npm test` **171/171**, `npm run verify` exit code 0.

## Files changed

- `mobile/app/panic.tsx` — 4 glyph→icon swaps (all `⚠`→`alert-triangle`), `degradationGlyph` renamed
  `degradationMark` (mixed-return pattern), dead `nobodyGlyph` style removed, `Feather` import added.
- `mobile/app/camera-view.tsx` — 5 glyph→icon swaps (`▣`×2→`camera`, `↯`→`zap`, `▮`→dynamic battery
  icon, `▤`→`image`).
- `mobile/app/incident/[id].tsx` — 1 swap: DRILL `Pill` `glyph="◎"` → `icon="target"`.
- `mobile/app/consent.tsx` — 1 swap: access-log `ListItem` `glyph="◉"` → `icon="eye"`.
- `mobile/app/drills.tsx` — 2 swaps: `▤`→`archive`, `⚠`→`alert-triangle`.
- `mobile/app/journeys.tsx` — 1 swap: empty-state `◎`→`users`.
- `mobile/app/vault.tsx` — 1 swap (`▤`→`archive` for the `document` kind only), `KIND_GLYPH` narrowed
  to `Partial`, new `kindMark()` helper + `KindGlyph` local component, `Feather` import added.
- `mobile/app/camera-node.tsx` — 1 swap: local `Rule` component gained an `icon` prop, `⌂`→`home` on
  its one call site, `Feather` import added.
- `mobile/src/ui/components/Pill.tsx` — new public `icon` prop, wins over `glyph` and over the
  per-tone `DEFAULT_ICON`.
- `docs/PHASES.md` — 6-D-2b row → ✅; `## Now` / `## Next 3` repointed to 6-D-3.
- `docs/HANDOFF.md` — this file.

## Decisions made

- None new. This phase executes D-032 (6-D-2a, 30 Aug) to completion — no scope question came up that
  D-032 didn't already answer. The per-occurrence icon judgment calls above are implementation
  choices in the same category 6-D-2a's own handoff described as "not written down anywhere as a
  separate lock; treated as ordinary implementation judgment."

## Known broken / deliberately skipped

- **No screenshot exists of the changed screens** — same standing limitation as every 6-D UI phase:
  no JDK/Android SDK on this machine (D-021), no `react-native-web` dependency, so neither a device
  build nor `expo start --web` can render it here. Verified instead by `tsc`'s JSX/type check plus
  reading each diff against the existing, already-typechecked component patterns (D-2a's own
  precedent). `panic.tsx` and `incident/[id].tsx` — the two safety-critical files in this batch — got
  the closest reading: every change there is a leaf-level glyph→icon swap with zero logic touched
  (no state, no prop threading beyond the existing `colour`/`tone` variables already in scope).

## Next session starts here

- **Phase 6-D-3**: visual density — neutral/info `Pill` gets an outline variant, card padding moves
  to `space.lg`/`space.md` minimum (A5/A6 in the spec). Danger/warn tones on active incidents/sessions
  stay filled — nothing safety-critical is allowed to get quieter. Spec:
  [phase6b-redesign-and-family-watch.md](spec/phase6b-redesign-and-family-watch.md) row A5/A6.
- **First command:**
  ```
  git checkout shivam
  git log --oneline -1              # confirm you're on 813f4aa3 or later
  cd mobile && grep -rn "[⌂◎⚠⚙▣↯▮▤◉]" .   # confirm it still returns nothing
  npm run verify
  ```
- **Watch out for:**
  1. **The icon sweep (spec A4) is now fully done** — do not reopen it. Any future glyph you touch in
     this codebase is one of the ~16 non-catalogued characters (`✓ ✕ ℹ • ⚑ ▁ — ⚿ ↗ ≋ ◇ ≈ ✚ ☰ ▦ ●
     ◼`, etc.) that D-032 deliberately left alone; leave them alone too unless a *new* spec row asks
     for them by name.
  2. **`Pill` now has three ways to get a leading mark**: caller `icon` > caller `glyph` >
     per-tone `DEFAULT_ICON` > per-tone `DEFAULT_GLYPH`. 6-D-3's outline-Pill work touches the same
     component — read the current `PillImpl` fully before adding a fourth axis (outline vs filled) on
     top of this, rather than layering a new prop combination.
  3. **`vault.tsx`'s `KIND_GLYPH` is now `Partial`** — `KIND_GLYPH[kind]` can be `undefined` for
     `document`. Nothing currently indexes it directly for `document` (both call sites go through
     `kindMark()`), but a future edit that reaches into `KIND_GLYPH` directly needs to handle that.
  4. **No JSX-rendering test harness still** — same as every 6-D UI phase. `tsc --noEmit` catches
     type errors, not layout or visual bugs; no automated test fails if a chosen icon looks wrong.
