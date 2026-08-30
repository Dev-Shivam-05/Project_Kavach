# HANDOFF — Kavach — Phase 6-D-2a — 2026-08-30

Branch **`shivam`**, commit `814a758e`, **pushed** to `origin/shivam`. This handoff supersedes the
29 Aug one (6-D-1b, commit `1604923b`), preserved in git history.

## Done

- **6-D-2a shipped: icon sweep, part 1 of 2.** `grep -rn "[⌂◎⚠⚙▣↯▮▤◉]" mobile/` found 13 files using
  one of the 9 catalogued text-glyph characters (spec A4) — over the ≤8-files rule, so the row was
  split into 6-D-2a (5 files: shared components + tab screens + root layout) and 6-D-2b (the
  remaining 8, unbuilt). All 5 files in 6-D-2a's scope are now clean of those 9 characters.
- **`ListItem` and `EmptyState` gained an optional `icon?: keyof typeof Feather.glyphMap` prop**,
  additive next to the existing `glyph?: string` prop — Feather renders in the same slot, same
  colour token, and wins over `glyph` when both are given. `Pill` got a parallel `DEFAULT_ICON` map
  used only for the `warn` tone's default mark (`alert-triangle`); a caller-supplied `glyph` string
  still overrides it, and the P-018 contrast rule is unchanged — colour still comes from
  `TONE_SURFACE`/`tint`, never a FILL token.
- **`home.tsx`**: `homeEventGlyph`'s `door` case (`⌂` → Feather `home`), "Agents reporting" (`◉` →
  `activity`), "Fixed nodes" (`▣` → `camera`). **`map.tsx`**: the "Nobody to map" empty state (`◎` →
  `users`), the geofence list row (`◎` → `map-pin`). **`settings.tsx`**: Vault (`▤` → `archive`),
  Drills (`◎` → `target`), Family cameras (`▣` → `camera`), Use this phone as a camera (`◉` →
  `video`). **`_layout.tsx`**: the degraded-status-bar warning triangle (`⚠` → Feather
  `alert-triangle`, replacing the now-dead `warnGlyph` style) and one doc-comment that used `⚠` as a
  marker (reworded to `NOTE:`, no character change needed there since it wasn't rendered UI).
- **Only the 9 catalogued characters were touched, deliberately** — other glyph values already
  in-scope (`✓ ✕ ℹ • ⚑ ▁ — ⚿ ↗ ≋ ◇ ≈ ✚ → ⏱ ✎ ⇄`, etc.) were left as plain text. Recorded as
  [DECISIONS.md](DECISIONS.md) **D-032**: the spec's binary acceptance criterion is the grep, not
  the looser "every text-character glyph app-wide" prose in the same row, because the two readings
  imply a 13-file scope versus an unbounded one.
- Verified green: `tsc --noEmit` (0 errors), `npm test` **171/171**, `npm run verify` green.

## Files changed

- `mobile/src/ui/components/ListItem.tsx` — new optional `icon` prop (Feather), wins over `glyph`.
- `mobile/src/ui/components/EmptyState.tsx` — same; `glyph` is now optional to make room for `icon`.
- `mobile/src/ui/components/Pill.tsx` — new `DEFAULT_ICON` map, used for the `warn` tone only.
- `mobile/app/(tabs)/home.tsx` — `homeEventGlyph` returns `{glyph} | {icon}`; 2 direct glyph→icon swaps.
- `mobile/app/(tabs)/map.tsx` — 2 glyph→icon swaps (EmptyState + geofence ListItem).
- `mobile/app/(tabs)/settings.tsx` — 4 glyph→icon swaps.
- `mobile/app/_layout.tsx` — degraded-bar warning icon swapped to Feather; dead `warnGlyph` style
  removed; one doc-comment reworded to drop a stray `⚠`.
- `docs/PHASES.md` — 6-D-2 row split into 6-D-2a (✅) / 6-D-2b (🔨); `## Now` / `## Next 3` repointed.
- `docs/DECISIONS.md` — **D-032** added (icon-sweep scope is the 9 characters, not "every glyph").
- `docs/PROJECT_MAP.md` — new convention note: two icon systems coexist (text-glyph + Feather),
  `icon` prop pattern documented so 6-D-2b doesn't reinvent it.

## Decisions made

- **D-032** (see [DECISIONS.md](DECISIONS.md)): the icon sweep's locked scope is exactly the 9
  characters in spec A4's grep command, not every glyph character in the app. Untouched glyphs in
  `ListItem`/`EmptyState`/`Pill` call sites are intentional, not missed.
- Per-occurrence Feather icon choices (`home`, `activity`, `camera`, `video`, `users`, `map-pin`,
  `archive`, `target`, `alert-triangle`) were made by matching each specific usage's meaning, not a
  single character→icon lookup table — the same character (`◎`, `◉`, `▣`) maps to different icons in
  different contexts. Not written down anywhere as a separate lock; treated as ordinary
  implementation judgment the way 6-D-1b's `alert-triangle` choice for SOS was.

## Known broken / deliberately skipped

- **6-D-2b (8 files) is not started**: `panic.tsx`, `camera-view.tsx`, `incident/[id].tsx`,
  `consent.tsx`, `drills.tsx`, `journeys.tsx`, `vault.tsx`, `camera-node.tsx` still contain one or
  more of the 9 catalogued characters.
- **No screenshot exists of the changed screens**, same standing limitation as 6-D-1b: no JDK/Android
  SDK on this machine (D-021) and no `react-native-web` dependency, so neither a device build nor
  `expo start --web` can render it here. Verified instead by `tsc`'s JSX/type check plus reading each
  diff against the existing, already-typechecked component patterns.

## Next session starts here

- **Phase 6-D-2b**: the other 8 files from the same grep. Reuse the `icon` prop on
  `ListItem`/`EmptyState` and the `DEFAULT_ICON` pattern on `Pill` — do not invent a second mechanism.
  `panic.tsx` (4 occurrences) and `incident/[id].tsx` (1) are the safety-critical ones; read D-032
  before starting so the same 9-character scope discipline holds.
- **First command:**
  ```
  git checkout shivam
  git log --oneline -1   # confirm you're on 814a758e or later
  cd mobile && grep -rn "[⌂◎⚠⚙▣↯▮▤◉]" .  # confirm the remaining 8 files are exactly what's expected
  npm run verify
  ```
- **Watch out for:**
  1. **Same character can mean different things in different files** — `◎`/`◉`/`▣` each mapped to
     more than one Feather icon in 6-D-2a depending on context (a heartbeat vs. a camera vs. a
     geofence pin). Pick per-occurrence, don't try to build one global character→icon table.
  2. **`panic.tsx` and `incident/[id].tsx` are the safety-critical files in this batch** — read the
     surrounding code carefully before swapping a glyph; these are exactly the screens
     [RISK.md](RISK.md) and CLAUDE.md's danger-zone table care most about, even though this is a
     pure visual change with zero logic touched.
  3. **There is still no JSX-rendering test harness** — same as every 6-D UI phase, `tsc --noEmit`
     catches type errors, not layout or visual bugs. No automated test fails if a chosen icon looks
     wrong.
  4. **`_layout.tsx`'s `warnGlyph` style is now gone** — if a future diff reintroduces a raw
     `<Text>⚠</Text>` anywhere, there is no shared style to reach for; use the `Feather
     name="alert-triangle"` pattern already in that file instead.
