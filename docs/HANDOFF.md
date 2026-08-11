# Handoff

## Session: 2026-08-11 — context recovery + documentation spine

**Goal.** The project had been `/clear`ed several times without a handoff, so twelve days of
decisions existed only in transcripts. Recover that history and write the spine.
**Source changes: zero.** Only `docs/` and `CLAUDE.md` were written.

### What was done

- **Recovered the lost history** by mining `~/.claude/projects/` transcripts (10 MB, 5,097 lines,
  26 Jul → 7 Aug). Found the six workflow scripts that encode the plan actually executed, the phase
  claims and their contradictions, and the point where the session died.
  → [history/SESSION-LOG.md](history/SESSION-LOG.md)
- **Verified the safety net green** — every later change is now falsifiable:

  | Check | Result |
  |---|---|
  | `cd backend && go build ./...` | pass |
  | `cd backend && go test ./...` | pass (5 test files; 9 packages have none) |
  | `cd mobile && npm run typecheck` | pass, clean |
  | `cd mobile && npm test` | **139 / 139** |
  | `npm run gen:check` | in sync — 14 states · 20 events · 35 transitions · 16 fixtures |
  | `go test ./cmd/sos-ingest -run TestLOCBudget` | **963 / 1000** |

- **Re-scored every phase at HEAD** rather than trusting the old numbers, and retired the
  59% / 70% / 52% figures with the evidence that they were measured once and re-quoted four times
  over ten days. → [PHASES.md](PHASES.md)
- **Measured the 07 Aug brief item by item: 0 of 8 built, 7 absent, 1 partial by accident.** Three
  of the eight reverse documented architecture decisions. Recorded as Phase 6.
- Wrote [PROJECT_MAP.md](PROJECT_MAP.md), [DECISIONS.md](DECISIONS.md) (14 decisions that existed
  only in code or chat), [RISK.md](RISK.md), [spec/GLOSSARY.md](spec/GLOSSARY.md), `CLAUDE.md`.

### Decisions taken this session

1. **Phase 1 gate before the Aug-7 product brief** — §4.12 names scope creep before the gate as the
   most likely way this project dies.
2. **The satellite map must respect ADR-010** — pre-cached offline tiles, no live third-party tile
   requests.
3. **Untrack `.claude/skills/` and wire the real tools in** — none of the eight has a `SKILL.md`, so
   none can load; the project has no linter at all. → D-013, **not yet executed.**

### What was NOT done

- No source file was touched. No test added, no dependency changed, no git history altered.
- `mobile/docs/PHASE-STATUS.md` was **not** corrected — [PHASES.md](PHASES.md) supersedes it. Leave
  it as a historical artifact or delete it in a later session, but do not half-update it.
- D-013 (untracking skills, wiring ESLint/semgrep/dependency-cruiser) is decided and unexecuted.
- The earlier transcript `2f4187f3-….jsonl` (1.1 MB, 26 Jul) was not mined; it may hold the original
  architecture reasoning.

### Next session starts here

**Phase 1, W10 — remote push.** It is the top of the dependency chain: today a phone hears about an
incident **only while its WebSocket is alive**, so with the app closed the only working leg to
another human is SMS. Nothing else in Phase 1 matters until a phone rings.

Scope, in order: request a device push token → store it server-side → data-only FCM send from
`internal/notify` → present a full-screen intent (the `USE_FULL_SCREEN_INTENT` permission is already
declared in `app.json:27` and never used). Split into two sessions if it grows past ~8 files.

Two smaller items are good candidates if you want a quick win first: the `showWhenLocked` medical
card Activity (PHASES 1.28), and the exact-alarm Kotlin watchdog (1.13).

Read first: [CLAUDE.md](../CLAUDE.md) → [PROJECT_MAP.md](PROJECT_MAP.md) → [PHASES.md](PHASES.md)
Phase 1. Check [RISK.md](RISK.md) before touching anything in its danger table.

### Open question carried forward

For **offline video calling** (Phase 6.4), the design is blocked on one answer that was asked on
07 Aug and never given: **same room / same building** (Wi-Fi Direct, ~30–50 m indoors — buildable),
or **across the city** (which no app can do without a network)? Pick one before any code.
