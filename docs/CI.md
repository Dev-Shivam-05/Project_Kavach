# CI — the eight day-one gates

`.github/workflows/ci.yml` runs on every push and every pull request. Each gate
is its own named step, so a red build names the invariant that broke.

Gate steps run even after an earlier one fails. Three red gates and one red gate
are different situations, and a pipeline that stops at the first failure hides
which one you are in.

Everything here runs locally. If you cannot run a gate on your machine, that is
a bug in the gate.

| Gate | Command | Working dir |
|---|---|---|
| 1a | `go vet ./...` | `backend/` |
| 1b | `staticcheck ./...` | `backend/` |
| 2 | `go test ./... -race` | `backend/` |
| 3 | `go run ./tools/archlint` | `backend/` |
| 4 | `go test ./cmd/sos-ingest -run TestLOCBudget -v` | `backend/` |
| 5 | `npx tsc --noEmit && npm test` | `mobile/` |
| 6 | `node tools/smgen.mjs --check` | repo root |
| 7 | `go test ./internal/logx -run 'TestDenyList\|TestDevHandler\|TestProdHandler' -v` | `backend/` |
| 8 | `node tools/schema-lint.mjs` | repo root |
| 9 | `node tools/protolint.mjs` | repo root |

---

## Gate 1a — `go vet`

The compiler's blind spots: a `Printf` verb that does not match its argument, a
lock copied by value, an unreachable branch. A failure is nearly always a real
defect and takes minutes to fix. Nothing downstream is worth reading until this
is green.

## Gate 1b — `staticcheck`

Deeper static analysis than vet: dead code, misuse of the standard library,
conditions that cannot be true. The step installs staticcheck with `go install
…@latest` rather than a pinned version, because staticcheck releases track Go
releases and a pin becomes a pin to a version that cannot parse the language
version we compile with. **If the install fails, the step prints a `::warning::`
saying staticcheck did not run and exits 0.** That is a skip, not a pass — the
step name says so, and a build whose only "green" analysis gate is vet has been
told less than it looks like. A staticcheck failure means the finding is real;
read it before silencing it.

## Gate 2 — `go test ./... -race`

The whole backend suite under the race detector: the envelope cross-language
vectors, the sos-ingest handler tests, the state-machine conformance fixtures.
The `-race` half is the part that matters. `sos-ingest` serves concurrent
requests against in-memory caches and a WAL, and the escalation engine runs N
stateless workers claiming timers; a data race there corrupts an incident under
load and never reproduces on a developer's laptop. A failure here is a
correctness bug in the survival path, not a flake — do not re-run it and move on.
The step sets `CGO_ENABLED=1` explicitly, because without cgo `-race` is not
merely slower, it is absent.

## Gate 3 — `go run ./tools/archlint` (I-12, ADR-002)

The import graph, checked against `backend/tools/archlint/rules.json`. Four
rules. The one that matters most: `cmd/sos-ingest` may import only
`internal/{envelope,wal,bus,store,logx,incident}`. ADR-002 makes it a separate
binary so a bad control-plane deploy cannot take SOS with it, and an import
reaching into control-plane code rebuilds that coupling while changing nothing
you can observe — the binary still starts, still answers, and now ships on the
control plane's cadence instead of its own twice-a-year one. The other three:
nothing under `internal/` may import a `cmd/` package; no kernel package may
import a control-plane module (which is how the first rule gets defeated from
below); and no control-plane module may import another — `vault` importing
`journey` is the canonical case, and the fence applies to packages that do not
exist yet, because every one of them is a control-plane module by default.

A failure prints the file, line, the offending edge, the rule and its reason. If
the edge is genuinely correct, the fix is an entry in `rules.json` with the
reason attached — not a deletion of the rule. The tool also fails if `rules.json`
has drifted from the tree (a rule naming a renamed package is a disarmed rule),
and if an exception in `allow_edges` no longer matches anything.

## Gate 4 — LOC budget (ADR-002, §2.5.1)

`TestLOCBudget` counts source lines in `backend/cmd/sos-ingest/main.go`, blanks
and comments excluded, and fails above 1000. The ceiling is not a style
preference: it is the mechanism that keeps the sacred binary small enough to read
end to end before a deploy, and small enough that its blast radius is knowable.
A failure means something belongs in the control plane. Move it there. Do not
raise the budget, and do not reach for the comment exclusion — comments are how
the file stays reviewable and must never be what pushes it over.

Gate 2 already runs this test. Gate 4 runs it alone so the failure message says
"LOC budget" and not "backend tests".

## Gate 5 — `tsc --noEmit` + `npm test` (I-2 and the mobile invariants)

TypeScript is `strict`, so a type error here is usually a real nullability or
shape bug. `npm test` is the invariant suite: the I-2 assertion that every byte
the SMS encoder emits is in 32..126 (one Devanagari character converts GSM-7 to
UCS-2 and drops the payload limit from 160 to 70, which truncates coordinates out
of the only transport that works when nothing else does); the constant-time
duress-PIN comparison; the GroupBox round-trips; the state-machine fixtures the
Go side also runs. A failure in the invariant tests is a failure of a stated
property, so read which test failed before touching the code it covers.

## Gate 6 — `node tools/smgen.mjs --check`

`spec/state-machine.yaml` is the single source of truth for the incident state
machine, and it generates two implementations plus the fixture set they both
run. This step regenerates in memory and fails if any generated file on disk
differs. A failure means someone edited generated code by hand or changed the
YAML without regenerating: run `node tools/smgen.mjs` and commit the result. The
gate exists because the two implementations diverging is a class of bug that
shows up as a phone and a server disagreeing about whether an incident is still
active.

## Gate 7 — PII deny-list (I-6, §10.5)

`backend/internal/logx/deny_test.go` asserts that `logx.Deny()` still contains
`lat, lon, latitude, longitude, address, coords, location, email, phone, name,
message`; that each term actually matches through the handler in its real
spellings (`user_lat`, `locLon`, `subjectLatitude`); that it does **not** match
`latency_ms`, `escalation_timer` or `namespace`, since a list that rejects those
gets weakened by the next person who needs to log one; and that the dev handler
panics rather than redacts. I-6 does not die from an attack. It dies at 3 a.m.
when somebody drops a term to get one fan-out line out and ships it. A failure
here means the deny-list has been shortened or its matching changed — if a field
genuinely must be logged, call `logx.Allow` on that exact key, which is a
greppable line in source rather than a silent hole.

## Gate 8 — Class-A schema lint (I-3, §2.4.6)

`tools/schema-lint.mjs` reads `backend/internal/store/store.go` and
`mobile/src/db/schema.ts` — the two files that decide what is persisted — and
fails on any column, struct field or JSON tag that reads as precise location
(`lat`, `lon`, `latitude`, `longitude`, `precise`, `address`) unless it is on the
Class-A′ allowlist carried in the script. `lat` and `lon` match as whole words,
not substrings, so `escalation_timer` and `latency_ms` are not casualties.

The allowlist has six entries, all on the device — the two `local_geofence`
columns, the two `location_point` columns, and the two `presence.loc_*` columns —
each with the reason it is safe where it is. **The server side is empty on
purpose.** §2.4.6 permits Class A′ on the wire and in `sms-inbound` process
memory; the only location the server persists is `coarse_h3_r7`, the ≈1 km cell.
A failure naming a file under `backend/` means the first Class-A column is about
to reach the server, and the reason you write for it has to explain why the
coarse cell is not enough. The lint also fails on a stale allowlist entry, so a
permission cannot outlive the column it was written for and be inherited by the
next one with the same name.

## Gate 9 — proto contract is additive-only (I-13, §8.4)

`tools/protolint.mjs` checks `proto/incident.proto` against the checked-in lock
file recording the shape of every field that has ever been published, and fails
on a removed field, a changed number, a changed type, a changed label or a reused
number. `/v1` is frozen because a phone running last year's build is the one that
has to reach help (P-060). This gate is not one of the eight in §3.2's day-one
list; it is here because the lint exists, and a lint that never runs is the exact
failure this workflow was written to end. A failure means the change is not
additive: add a new field with a new number instead. After a deliberate addition,
`node tools/protolint.mjs --update` rewrites the lock.

---

## Not yet gated

One §3.2 gate has no implementation to run: **string-lint** (NFR-020, en/hi/gu
coverage for every user-facing key). There is no string catalogue to lint yet.

It is listed here rather than quietly omitted, because a gate nobody has written
is a different thing from a gate nobody needs.
