# Project Kavach — house rules

Read [docs/PROJECT_MAP.md](docs/PROJECT_MAP.md) before touching code, [docs/PHASES.md](docs/PHASES.md)
for status, and [docs/RISK.md](docs/RISK.md) before touching anything in its danger table.

## Commands

| | |
|---|---|
| backend | `cd backend && go build ./... && go vet ./... && go test ./...` |
| mobile | `cd mobile && npm run verify` (= `tsc --noEmit` + `npm test`) |
| codegen | `npm run gen` (root) · check drift with `npm run gen:check` |
| lints | `node tools/schema-lint.mjs` · `node tools/protolint.mjs` (root) |
| stack | `docker compose -f ops/docker-compose.yml up --build -d` |

**`-race` does not run on this machine.** It needs `CGO_ENABLED=1` *and* a C compiler, and there is
no gcc here — `go test -race` fails with `cgo: C compiler "gcc" not found`, which is a toolchain
gap, not a test failure. CI gate 3 is the only place the race detector has ever run. Do not report
`-race` as passing locally; say it was not run.

**There is no JDK and no Android SDK on this machine either** (`java` is not on PATH, `ANDROID_HOME`
and `JAVA_HOME` are unset). The Kotlin under `mobile/modules/kavach-t0/android/` therefore cannot be
compiled here, and **no CI gate compiles it either** — the nine gates are Go, TypeScript and Node.
Changes to the native Tier-0 plane are unverifiable from this checkout; say so rather than reporting
Kotlin as done (D-021).

Windows: `go test ./...` may fail once with *"An Application Control policy has blocked this
file"* — that is the OS, not the code. Re-run.

**`// @ts-expect-error` must sit on the line the import specifiers are on.** The tempting shape —
a trailing comment inside the braces of a multi-line `import { … } from 'expo-notifications'` —
suppresses **nothing**: `tsc` reports one TS2305 per specifier line, and the directive then applies
to the `} from …` line and reports itself unused. That shape shipped in `test/push-token.test.ts`
and left `tsc --noEmit` red while a handoff recorded it green. Use a single-line import with the
directive above it, and read the actual `npm run typecheck` output before claiming a gate passed.

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
7. **A mobile test that imports an Expo module needs a stub in `mobile/test/shim.mjs`.** Node runs
   the tests directly; there is no Metro and no jest. Add the specifier to `STUBS` and its source to
   `STUB_SOURCE`. Keep stubs *controllable* (`__setX` / `__emitX` exports) so behaviour can be
   driven, not just satisfied.
8. **Never invent a persisted field name.** `backend/migrations/0001_init.sql` is the naming
   authority for anything the server stores, even though nothing runs it (ADR-006, D-003).
   `internal/store/store_test.go` now enforces this for the `device` table: its key list must match
   the migration's columns exactly, so a new column fails the test until you add it there.

## Danger zones

- `backend/cmd/sos-ingest/` — **963/1000 lines.** CI Gate 4 fails past 1000 (ADR-002). To add lines
  here you must first remove lines here.
- The four generated files (`stateMachine.generated.ts`, `machine_gen.go`, `machine_gen_test.go`,
  `__generated__/fixtures.json`) — **never hand-edit.** Change `spec/state-machine.yaml`, `npm run gen`.
- `proto/incident.proto` — additive only; field numbers are frozen (`tools/protolint.mjs`, Gate 9).
- `internal/{bus,wal}` and `cmd/{control-plane,realtime-gw,canary}` have **zero tests**;
  `internal/{store,escalation}` have one test file each covering one seam (device table, W10-a ·
  CLAIM/RELEASE, W10-d) and nothing else. Characterize current behaviour in a test *before*
  changing any of them. The shape that works: pin what the code already does, run it green, then
  add the new expectation and show it red before you make it pass.

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
