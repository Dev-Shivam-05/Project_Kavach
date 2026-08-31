# HANDOFF — Kavach — Phase 6-D-3 — 2026-08-31

Branch **`shivam`**, commit `45fc5d18`, **not yet pushed**. This handoff supersedes the 30 Aug
6-D-2b one (commit `813f4aa3`), preserved in git history.

## Done

- **6-D-3 shipped: visual density (spec A5 + A6).**
- **A5 — `Pill`'s `neutral`/`info` tones are now outline-only.** Transparent background, border
  unchanged (`TONE_BORDER[tone]`, already the peripheral-vision-strength colour), and — new — the
  label itself renders in the tone's own text token (`TONE_SURFACE[tone].fg`: `infoText` / `textDim`)
  instead of the universal `colors.text`. That inversion is safe specifically because the soft fill is
  gone: `*Text` tokens are pre-validated at ≥7:1 on every surface `theme.ts` exports, so reading one
  directly off the page needs no fill pairing to protect it — unlike the filled tones, which still use
  `colors.text` to stay clear of the low-contrast fill+tone-text pairing documented at the top of the
  file. `ok`/`warn`/`danger` are **unconditionally unaffected** — no context flag, no "is this an
  active incident" check anywhere in `Pill`. The scoping is purely by `tone`, which is what makes A5's
  own caveat ("danger/warn stay filled on an active incident or Family Watch session") automatically
  true: those tones never touch the outline branch at all.
- **A6 — eight standalone notice-card containers now carry `padding: space.lg` (16) with a
  `space.md` (12) minimum gap between their stacked rows**, up from a mix of `space.sm`/`space.xs`/
  `space.xxs`:
  - `consent.tsx` `rung` (the autonomy-ramp age card: age+title row, then a body line).
  - `incident/[id].tsx` `unackedBanner` and `respondingBanner` (padding was already `lg`; only the
    row gap moved).
  - `panic.tsx` `notified` (the "WHO HAS BEEN TOLD" card — went from asymmetric `paddingVertical:
    sm`/`paddingHorizontal: md` to uniform `lg`, and **gained a `gap` it did not have at all**: the
    title and every `notifiedRow` were previously flush siblings with zero space between them) and
    `noFix` (padding already `lg`; only the gap moved).
  - `journeys.tsx` `deadman` (padding+gap both moved) and `corridorEmpty` (padding already `lg`; only
    the gap moved).
  - `medical-card.tsx` `emptyCard` (padding already `lg`; only the gap moved).
- Verified green: `tsc --noEmit` (0 errors), `npm test` **171/171**, `npm run verify` exit code 0.

## Files changed

- `mobile/src/ui/components/Pill.tsx` — outline branch for `neutral`/`info` tones (background,
  border-preserved, label colour), new header note explaining why the label-colour rule inverts only
  there.
- `mobile/app/consent.tsx` — `rung` padding/gap.
- `mobile/app/incident/[id].tsx` — `unackedBanner`, `respondingBanner` gap.
- `mobile/app/panic.tsx` — `notified` padding+gap (was two directional padding props, no gap at all),
  `noFix` gap.
- `mobile/app/journeys.tsx` — `deadman` padding/gap, `corridorEmpty` gap.
- `mobile/app/medical-card.tsx` — `emptyCard` gap.
- `docs/PHASES.md` — 6-D-3 row → done; `## Now` / `## Next 3` repointed to 6-D-4.
- `docs/HANDOFF.md` — this file.

## Decisions made

- **A6's true scope was not "every `space.sm` in the app" — it was 8 files, not 19.** A first grep for
  `space.sm` padding/gap anywhere under `mobile/app` hit 19 files, which would have blown past the
  ~8-file one-phase budget. A background Explore agent then classified those hits: most were incidental
  (icon-to-label gaps, Pill/button internals, single-row list items) rather than "card internal
  padding." Only 6 files (10 style instances, since some files had 2–3) were genuine standalone
  notice-card containers. That distinction — a bordered/tinted panel holding **stacked** rows, vs. a
  single-row list item or an atomic control's own internal padding — is what A6's own wording turns
  on ("card internal padding," "gap between stacked rows **inside** one card").
- **Two of the agent's ten flagged instances were excluded on inspection, not converted:**
  - `journeys.tsx`'s `metric` (the distance/duration stat tile inside `metricRow`) — a small tile in a
    row of tiles, not itself the card; converting its padding to 16 would have made three tiles not fit
    a phone-width row. Left untouched.
  - `diagnostics.tsx`'s `row`/`rowHead` (one row per self-test check, ~9 of them, accordion-expandable)
    — structurally the same repeated-list-row pattern as `ListItem.tsx`/`MemberRow.tsx`, which the
    survey itself excluded elsewhere for being "single-row list items, not stacked rows inside a card."
    Bumping padding to 16 on 9 repeated rows would have read as a bug, not a redesign. Left untouched.
  Both are ordinary implementation judgment in the same category 6-D-2a/2b's per-occurrence icon calls
  were — not written down as a separate spec-lock row.
- **A5 needed no "is this pill on an active incident" check.** The spec's own wording momentarily reads
  as if `danger`/`warn` might sometimes go outline too ("danger and warn pills involved in an active
  incident... keep their filled treatment"), but the first sentence scopes the whole change to
  `neutral`/`info` only — the second sentence is reassurance that those two tones are untouched, not a
  second rule. Implemented as a pure `tone`-keyed branch; no new prop, no caller-side context threading.

## Known broken / deliberately skipped

- **No screenshot exists of the changed screens** — same standing limitation as every 6-D UI phase: no
  JDK/Android SDK on this machine (D-021), no `react-native-web` dependency. Verified by `tsc`'s
  JSX/type check, the full green test suite (including `theme-contrast.test.ts`, which re-asserts every
  `*Text`/fill pairing this phase relies on), and reading each diff against the existing,
  already-typechecked patterns. None of these six screens are the two safety-critical ones
  (`panic.tsx`/`incident/[id].tsx`) beyond the padding/gap change itself — no state, no logic, no prop
  threading touched anywhere in this diff.
- **Not yet pushed to `origin/shivam`** — commit `45fc5d18` is local only as of this handoff.

## Next session starts here

- **Phase 6-D-4**: consent plumbing for Family Watch — the new `camera` scope. Spec:
  [phase6b-redesign-and-family-watch.md](spec/phase6b-redesign-and-family-watch.md), section D
  (D2–D6 are fixed inputs, not open questions — see that file's header for why D3, the on-device
  indicator, is non-negotiable).
- **First command:**
  ```
  git checkout shivam
  git log --oneline -1              # confirm you're on 45fc5d18 or later
  cd mobile && npm run verify
  ```
- **Watch out for:**
  1. **`Pill` now has an outline branch keyed purely on `tone`** (`neutral`/`info` outline,
     `ok`/`warn`/`danger` filled, always). Any future Pill work should read `PillImpl` fully before
     adding a context-dependent override — the deliberate choice this phase made was to avoid one.
  2. **The `metric` tile in `journeys.tsx` and the `row`/`rowHead` pair in `diagnostics.tsx` were
     excluded from A6 on purpose** (see Decisions above) — do not reopen them as a "missed spot" without
     rereading why.
  3. **No JSX-rendering test harness still** — same as every 6-D UI phase. `tsc --noEmit` and
     `theme-contrast.test.ts` catch type/contrast errors, not layout; no automated test fails if
     spacing looks wrong.
