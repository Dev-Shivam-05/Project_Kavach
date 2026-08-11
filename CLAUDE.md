# Project Kavach — house rules

Read [docs/PROJECT_MAP.md](docs/PROJECT_MAP.md) before touching code, [docs/PHASES.md](docs/PHASES.md)
for status, and [docs/RISK.md](docs/RISK.md) before touching anything in its danger table.

## Commands

| | |
|---|---|
| backend | `cd backend && go build ./... && go test ./... -race` |
| mobile | `cd mobile && npm run verify` (= `tsc --noEmit` + `npm test`) |
| codegen | `npm run gen` (root) · check drift with `npm run gen:check` |
| stack | `docker compose -f ops/docker-compose.yml up --build -d` |

Windows: `go test ./...` may fail once with *"An Application Control policy has blocked this
file"* — that is the OS, not the code. Re-run.

## The conventions this codebase actually follows

1. **Every file opens with a `★` header citing the requirement it implements** (`F-05`, `NFR-002`,
   `P-043`, `I-4`, `ADR-018`) — 410 such citations. A change with no cited forcing requirement does
   not match this codebase. Decoder: [docs/spec/GLOSSARY.md](docs/spec/GLOSSARY.md).
2. **"Exists" ≠ "is wired up" — report both.** This repo has shipped complete, tested, zero-call-site modules more than once.
3. **Nothing throws into the UI.** Every repo/network call is wrapped in `safe()`
   (`mobile/src/state/store.ts:2478`); fire-and-forget is `void safe(...)`.
4. **Go has no framework.** Literal function wrapping, `s.auth(s.idempotent(h))`, stdlib only.
   `backend/go.mod` must keep zero `require` lines.
5. **Imports in `mobile/` are relative** — the `@/*` alias is deliberately unused. Styles come from
   `src/ui/theme.ts`, never literals.
6. **There is no linter.** `tsc --noEmit`, `go vet` and staticcheck are the whole static-analysis
   surface — match surrounding style by reading it, not by running a formatter.

## Danger zones

- `backend/cmd/sos-ingest/` — **963/1000 lines.** CI Gate 4 fails past 1000 (ADR-002). To add lines
  here you must first remove lines here.
- The four generated files (`stateMachine.generated.ts`, `machine_gen.go`, `machine_gen_test.go`,
  `__generated__/fixtures.json`) — **never hand-edit.** Change `spec/state-machine.yaml`, `npm run gen`.
- `proto/incident.proto` — additive only; field numbers are frozen (`tools/protolint.mjs`, Gate 9).
- `internal/{store,bus,wal,escalation}` and `cmd/{control-plane,realtime-gw,canary}` have **zero
  tests**. Characterize current behaviour in a test *before* changing them.

## Do not "fix" these

Fail-open on the safety path (ADR-018) · `ErrAppendOnly` on `incident_event` (I-4) · the
`sos-ingest` LOC ceiling · realtime-gw priority backpressure (a correctness rule, not tuning).
A bad signature flags and proceeds. That is the product.

## Contract seam (monorepo, no sibling repos)

`spec/state-machine.yaml` → 4 generated files · `proto/incident.proto` frozen field numbers ·
`backend/internal/envelope` ↔ `mobile/src/t0/envelope.ts`, byte-identical per `crosslang_test.go`.
Change the spec, never one side.

## Done means

CI's nine gates would pass: `go vet`, staticcheck, `go test -race`, archlint, LOC budget,
`tsc --noEmit` + mobile tests, `gen:check`, PII deny-list, Class-A schema lint, proto lint.
For UI, a screenshot of each state. For the danger table, the characterization test first — shown
failing before it passes. Never `/clear` without `/handoff`; commit per phase.
