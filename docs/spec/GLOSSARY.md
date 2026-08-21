# Glossary — the id namespaces

This codebase cites requirement ids in almost every file header (410 citations). This page is the
decoder. It does **not** restate definitions — it tells you which document owns each namespace so
you can look one up in seconds.

## Id namespaces

| Prefix | Means | Owned by |
|---|---|---|
| `F-01 … F-23` | Finding against the PRD, with severity S1–S3 | [docs/00-INDEX.md](../00-INDEX.md) findings table |
| `NFR-001 … NFR-020` | Non-functional requirement (latency, availability, coverage) | PRD §3.2 |
| `P-001 … P-065` | Problem from the problem catalog | PRD Part 2 |
| `I-1 … I-14` | Invariant — enforced by a test, not by convention | [README.md](../../README.md) + `mobile/test/invariants.test.ts` |
| `ADR-001 … ADR-022` | Architecture decision | [docs/adr/](../adr/) |
| `T-2xx` | Test scenario on the device matrix | PRD Part 17 / §3.9 |
| `§n.n` | Section of the PRD unless prefixed with a doc name | `Project-Kavach-…-PRD-v1.0.md` |
| `§2.x` | Section of the corrected architecture | [docs/02-System-Architecture.md](../02-System-Architecture.md) |

## The vocabulary you need on day one

**The three planes.** `T0` survival — native, on-device, deterministic, must work with no network,
2% battery, screen locked, app force-stopped. `T1` coordination — network fan-out, acknowledgment,
live location; degrades to SMS. `T2` intelligence — automation, geofences, AI, dashboards; may be
down for a week. **Dependencies flow downward only.** T0 never awaits T1; T1 never blocks on T2.

**The four clocks.** Five marks, four intervals — the dashboards plot the intervals.
`t0` trigger registered · `t1` confirmation (cancel window expired / duress PIN) · `t2` first byte
of the first transport leaves the device · `t3` first notification delivered to any family device
(p95 < 5 s, NFR-002) · `t4` first human acknowledgment (p95 < 120 s, NFR-004).
**t4 is the only clock with life-saving meaning.** Full table in [ops/README.md](../../ops/README.md) §3.

**The escalation ladder.** `L0` the on-device floor (alarm, torch, medical card — works with
everything else dead) · `L1`–`L4` widening audiences on timers from `spec/state-machine.yaml`.
`L0` is why the app is useful with no backend at all.

**Class A / Class A′.** Data classification (PRD §10.2). Class A is never stored in plaintext on
the server (invariant I-3, enforced by `tools/schema-lint.mjs`). Class A′ is precise location:
fanned out **in memory only** via `bus.PublishEphemeral`, never written to the durable stream; the
only location persisted is `coarse_h3_r7`.

**Fail open.** On the safety path, ambiguity accepts. Bad signature, unknown device, expired token
→ accept the incident and flag it `UNVERIFIED` (ADR-018). A false alarm costs a phone call.

**GroupBox.** The shipped E2EE scheme (ADR-021) — X25519 seal + XChaCha20-Poly1305 under HKDF
per-scope keys, carrying a `scheme` byte so the MLS migration (ADR-008) stays additive.

**The sacred binary.** `sos-ingest`. Separate deploy, ≤2 deploys/year budgeted, ≤1000 lines
enforced by CI, ≤5 direct dependencies enforced by archlint (ADR-002).

**The canary.** Fires a real incident through the real handler every 15 minutes and measures all
four clocks. It is the only page-worthy alert in the system — everything else is a ticket.

**Drill vs incident.** `is_drill=true` incidents are excluded from the false-positive ledger and
from the `/internal/active-incidents` deploy gate (F-02, F-03).

**inc8 / sig8.** Eight-character truncations used in the 160-char ASCII SMS payload (ADR-020) —
`inc8` indexes back to an incident id via UUIDv5 synthesis, `sig8` is the inbound HMAC (F-09).

**Enrolment (server side).** A family, its members and their devices, created only through
`cmd/control-plane` — `POST /v1/family`, `POST /v1/members`, `POST /v1/devices`. Each successful
write publishes an **`enrolment_upsert`** record (`bus.KindEnrolmentUpsert`, payload
`store.EnrolmentUpsert`) on `fam.<id>.enrolment`, which is how `cmd/sos-ingest` — a separate process
with its own store directory — learns the rows it gates incidents on. Never write into the other
binary's store directory; see D-028 and [w10-j-enrolment.md](w10-j-enrolment.md).

**Duress.** One bit inside the ciphertext (F-01). Duress and normal-cancel must be
indistinguishable by packet size and timing (I-7) — hence fixed 1024-byte envelope padding and a
constant-time compare over **both** PINs on every attempt.

**Family size cap (`max_members`).** A `family`-table column (added 21 Aug, W-P6). Range 2–20,
default 6, set at family creation. `cmd/control-plane` counts live members and refuses the
(`max_members`+1)th enrolment with 409 `KV-1012 family_full`. Added to `0001_init.sql`, `store.Family`
and store_test in one commit (ADR-006/D-003). See [phase6-pull-forward.md](phase6-pull-forward.md) E.

**Family identity / "private space".** The visible surface that marks the app as one family's private
space: `display_name` + a deterministic crest (colour+monogram from `family.id`) + the Family ID + a
shield line. The Family ID is discovery/identity only — the SAS fingerprint still admits a device
(E5/E6). Not a security boundary.

**Brand accent (teal).** `accent #2DD4BF` and friends (`accentText`/`accentSoft`/`accentBorder`),
added in the Phase-6 rebuild. The one non-semantic brand colour; used for nav/active/primary-safe
actions only, never on an SOS or an active incident, so alarm red stays the loudest colour (A2/A3).

**Family Watch.** The 6.4 camera+mic feature (1↔1 live view, no recording). Auto-allow within a
family BUT every session carries a mandatory non-suppressible on-device indicator + a Class-A
access-log row, and the viewed person always holds a kill the viewer cannot overrule (D3–D5). The
inversion of `camera-view.tsx`'s kill-switch and ADR-017; needs a superseding ADR.

## Where the words are defined in full

PRD Part 22 is the product glossary. [docs/01-Analysis-and-Core-Requirements.md](../01-Analysis-and-Core-Requirements.md)
holds the requirement inventory and the 14 invariants. [docs/adr/README.md](../adr/README.md)
indexes the 22 decisions and names the five whose outstanding work you must read before believing
any capability claim (ADR-006, 016, 017, 021, 022).
