# Risk Register — things that could bite during modification

Recon 2026-08-11, commit `62ed6839`. Only items that change how you should edit this repo.
Architectural and product risk lives in [docs/04-Pros-and-Cons-Analysis.md](04-Pros-and-Cons-Analysis.md)
§4.12 and the PRD risk register (Part 21).

## S1 — will ship something wrong

**1. A release build ships in demo mode.**
`mobile/eas.json` has no `env` block in any profile, so `EXPO_PUBLIC_KAVACH_DEMO` is unset and
`config.ts:66` falls back to `app.json` `extra.demoMode: "true"`. A `preview` or `production` APK
therefore runs `simulateResponders()` — **fabricated family claims and acknowledgements**,
indistinguishable from real ones to the person holding the phone. `config.ts:31` already flags this
in prose (`★ THIS IS NOT DONE UNTIL eas.json SETS THEM ★`); the fix was never made.

**2. Auth silently disables itself.**
`control-plane/main.go:1411` — if `KAVACH_API_TOKEN` is empty, `s.auth` becomes a pass-through and
every `/v1/*` endpoint is open. No warning, no startup refusal. `KAVACH_RT_ALLOW_NO_TICKET=1` does
the same for realtime-gw and is compiled into the production binary.

**3. The deploy gate is overridable by a request header.**
`control-plane/main.go:1340` accepts a plain `X-Kavach-Deploy-Override` header, not only the env
var. F-02 exists to stop a deploy during a live incident; anyone who can reach the endpoint bypasses it.

## S2 — will make a change unverifiable

**4. ~6,000 LOC of backend has no direct tests.**
`internal/{store,bus,wal,escalation,notify,consent}` and all of `control-plane`, `realtime-gw`,
`canary` — the durable record, the append-only log, the escalation ladder that decides whether a
human is woken, and a hand-written WebSocket frame codec. **Characterize before you change**: write
a test asserting current behaviour, then change it and watch the test fail deliberately.

**5. The project has no linter and no static analysis.**
No ESLint, Prettier, semgrep or textlint config exists. `tsc --noEmit`, `go vet` and staticcheck are
the entire surface — and CI Gate 1b **emits a warning and exits 0 if staticcheck fails to install**,
so a green CI does not prove it ran. Meanwhile 815 MB of exactly these tools sits unused in
`.claude/skills/` (see 10). Decision to wire them in: [DECISIONS.md](DECISIONS.md) D-013.

**6. `mobile/docs/PHASE-STATUS.md` is stale and will mislead you.**
It audits commit `20a5fdf` and asserts `docs/adr/`, `.github/`, `proto/incident.proto` and
`docs/family-agreement.md` do not exist. All four do. Re-verified at HEAD:

| Its finding | Status now |
|---|---|
| `noteLocationFix()` has no callers | **closed** — `presenceService.ts:151`, wired at `store.ts:1049` |
| `evaluateGeofences()` has no callers | **closed** — `presenceService.ts:157` |
| `connectWs()` never called | **closed** — `store.ts:1073`, `onFrame` at `:1559` |
| no live location acquisition | **closed** — `Location.watchPositionAsync` at `presenceService.ts:174` |
| `sealTo()` never called / no second device | **closed** — `enrolment.ts:451` + `app/enrol.tsx` |
| no push token ever requested | **still true** |
| no hardware trigger (power/volume) | **still true** |
| dead-man / missed-arrival escalation | **still true** — no `sweepJourneys` |

Do not quote its 59% / 70% / 52%. Those were measured once on 28 Jul and re-quoted four times over
ten days without re-measurement ([history/SESSION-LOG.md](history/SESSION-LOG.md)).
[PHASES.md](PHASES.md) replaces them.

**7. `sos-ingest` has 37 lines of headroom.**
`TestLOCBudget` reports **963/1000**; CI Gate 4 fails past 1000 (ADR-002, deliberate). Any feature
touching the sacred binary must remove lines to add lines.

**8. `migrations/0001_init.sql` and `internal/store/store.go` must stay in sync, and nothing checks
it.** The SQL is the target Postgres schema (ADR-006, not deployed); the store is the live
implementation. Five tables exist only in SQL. Drift is invisible until migration day.

## S3 — process and hygiene, but expensive

**9. Twelve days of history exists only outside the repo.**
`/clear` was run several times without a handoff, and everything was squashed into **one commit** on
9 Aug — no bisect, no blame, no way to see when a behaviour changed. The record survives only as
`.jsonl` transcripts under `~/.claude/projects/`, including six workflow scripts that exist in
exactly one directory. **Mitigated** by [history/SESSION-LOG.md](history/SESSION-LOG.md); the
transcripts should still be backed up. Rules adopted: never `/clear` without `/handoff`, commit per
phase.

**10. The repo is 99% vendored third-party code that cannot be used.**
`.claude/skills/` is **25,213 tracked files** against **192** of actual project, and `.git` is
**469 MB**. None of the eight directories contains a `SKILL.md`, so **none can ever load as a
skill**; one is empty and one (Remotion, 679 MB) is unrelated to this project. Decision: untrack and
wire the real tools in — D-013, not yet executed.

**11. `backend/canary.exe` is a 10 MB Windows binary committed in the initial commit.**
`.gitignore` covers `bin/` and `dist/` but nothing catches a stray `*.exe` at a package root. It is
already stale relative to its sources.

**12. A substantial product brief was dropped, not deferred.**
The 07 Aug requirements (Family ID, phone accounts, offline video calling, satellite map, mock-data
removal, bottom-nav redesign) produced **zero code** — the workflow scoping them died mid-recon and
the session ended. `DELIVERY.md`, written three hours later, does not mention them. Now recorded as
Phase 6 in [PHASES.md](PHASES.md), including the one design question that was asked and never
answered.

**13. Two documented quick-starts do not work.** `ops/run-backend.ps1` passes flags two of the four
binaries do not define; `README.md:34` tells you to use Expo Go, which cannot run this app.

## Not a risk — do not "fix" these

- **Fail-open on the safety path** (ADR-018). A bad signature *flags* and proceeds. A reviewer who
  "hardens" this has broken the product's reason for existing.
- **`ErrAppendOnly` on `incident_event` mutators** (I-4). That is the feature.
- **The 1000-line ceiling on `sos-ingest`** (ADR-002). It is meant to hurt.
- **Priority backpressure in realtime-gw** is a correctness rule (§2.5.2), not a tuning knob.
- **The envelope builder failing *closed*** when it cannot pad, and **the camera node failing closed
  on privacy** — the two deliberate inversions of fail-open.
