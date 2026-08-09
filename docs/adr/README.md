# Architecture Decision Records

Twenty-one decisions, one file each. ADR-001..020 are the PRD §4.5 log;
ADR-021 is the phased-crypto decision recorded in
`docs/02-System-Architecture.md` §2.4.1.

These are not summaries of the code. They are the record of what was decided,
what was rejected, and **what the decision costs** — that last section is the
one worth reading. Roughly forty source files cite an ADR id in their header;
this directory is what they point at.

| ID | Decision | Status |
|---|---|---|
| [ADR-001](ADR-001.md) | Three planes, separated by criticality | Accepted |
| [ADR-002](ADR-002.md) | `sos-ingest` is a separate binary with its own deploy and durability | Accepted |
| [ADR-003](ADR-003.md) | Go, standard library only, for the whole backend | Accepted |
| [ADR-004](ADR-004.md) | Modular monolith, not microservices | Accepted |
| [ADR-005](ADR-005.md) | Docker Compose, not Kubernetes | Accepted |
| [ADR-006](ADR-006.md) | PostgreSQL + PostGIS + TimescaleDB as the only datastore | Accepted · not yet deployed |
| [ADR-007](ADR-007.md) | NATS JetStream, not Kafka | Accepted · realised as a file-backed bus |
| [ADR-008](ADR-008.md) | MLS (RFC 9420) for E2EE | Accepted · deferred in phase by ADR-021 |
| [ADR-009](ADR-009.md) | Relationship-based authorization, not roles | Accepted · OpenFGA not deployed |
| [ADR-010](ADR-010.md) | Geofences evaluated on-device; coordinates never leave it | Accepted |
| [ADR-011](ADR-011.md) | Cross-platform client over native T0; framework is React Native | Accepted · supersedes the PRD's Flutter row |
| [ADR-012](ADR-012.md) | Append-only event log; no CRDT library for incidents | Accepted |
| [ADR-013](ADR-013.md) | Escalation policy is server-authoritative and versioned | Accepted |
| [ADR-014](ADR-014.md) | Durable timers, `FOR UPDATE SKIP LOCKED`, 250 ms poll | Accepted |
| [ADR-015](ADR-015.md) | Android Device Owner provisioning on family-owned phones | Accepted |
| [ADR-016](ADR-016.md) | Home Assistant is the entire smart-home plane | Accepted · bridge not yet live |
| [ADR-017](ADR-017.md) | LiveKit Cloud for the SFU, insertable-stream E2EE | Accepted · **not implemented** |
| [ADR-018](ADR-018.md) | The safety path fails OPEN | Accepted · ★ deliberate inversion |
| [ADR-019](ADR-019.md) | Never place an emergency call programmatically | Accepted |
| [ADR-020](ADR-020.md) | SMS payload is pure ASCII English | Accepted |
| [ADR-021](ADR-021.md) | GroupBox now, MLS in Phase 2, behind a scheme byte | Accepted · review at the Phase 2 gate |
| [ADR-022](ADR-022.md) | The signature algorithm is a property of the key; verifier ships first | Accepted · **partially realised** |

## The five with outstanding work

Read these before believing a claim about what this system does today.

| | What is missing |
|---|---|
| **ADR-017** | Nothing implemented. No SFU, no media plane, no two-way audio. |
| **ADR-006** | Postgres is not deployed; `backend/internal/store/store.go` stands in, with no RLS and no PostGIS. |
| **ADR-016** | The Home Assistant bridge is modelled and exercised only by the demo generator. |
| **ADR-021** | The Phase 2 MLS migration is a commitment, not a shipped feature. |
| **ADR-022** | The server verifies both algorithms and the keystore key is created on device, but `buildSignedEnvelope()` still signs with the Ed25519 key in the JS heap. The trigger path is synchronous by design and the native keystore call is not; that change gets its own ADR. Until then, `js_heap` in diagnostics is the truth on every device. |

## Writing a new one

Same shape as the rest: the decision in the H1, a status line, then Context,
Decision, Alternatives, Consequences, Implementation. Two rules.

**Cite the PRD id.** `P-004`, `F-01`, `NFR-002`, `§10.2` — a decision without a
forcing requirement is a preference.

**Consequences is the section that earns the file.** An ADR that reads like an
advertisement for its own decision is worthless: nobody reaches for it during
the outage it predicted. State what the decision makes harder, what it costs,
and who pays.

Superseding an ADR does not mean editing it. Write the new one, and put
`Supersedes ADR-0NN` / `Superseded by ADR-0NN` in both status lines.
