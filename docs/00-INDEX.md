# PROJECT KAVACH — ARCHITECTURE, IMPLEMENTATION & ANALYSIS

Deliverable derived from an exhaustive read of `Project-Kavach-Family-Safety-Platform-PRD-v1.0.md`
(3,371 lines · 226,852 bytes · Parts 0–23 + closing).

| Section | File | Contents |
|---|---|---|
| **1** | [01-Analysis-and-Core-Requirements.md](01-Analysis-and-Core-Requirements.md) | Complete requirement inventory · the five load-bearing ideas · 14 non-negotiable invariants · the four-clock framework formalised · **23 findings** (contradictions, defects, unspecified seams) |
| **2** | [02-System-Architecture.md](02-System-Architecture.md) | Client (Android T0 / iOS / Flutter) · cryptography (phased GroupBox → MLS, Delivery Service, stream keys, Class A′) · backend services · real-time alert pipeline · transport ladder · corrected data model · API contract · degraded-mode protocols · observability · infrastructure |
| **3** | [03-Implementation-Guide.md](03-Implementation-Guide.md) | Day 0 external lead times · repo bootstrap (first 10 files in order) · Phase 0–5 week by week with exit criteria · detection data-collection protocol · CI gates · chaos suite (+5 new tests) · drill protocol · effort reality check |
| **4** | [04-Pros-and-Cons-Analysis.md](04-Pros-and-Cons-Analysis.md) | Rated evaluation across 11 dimensions · strengths, trade-offs and 21 named optimisations · the ten things most likely to kill the project, ranked |

### The decisions themselves

The four sections above are the analysis. What was actually decided, and what it cost,
lives next to the code:

| | |
|---|---|
| [adr/](adr/) | **ADR-001 … ADR-021** — one file per architectural decision, each with the option that was rejected and why. [adr/README.md](adr/README.md) carries the index and, more usefully, the table of decisions that are **recorded but not yet fully realised** (ADR-006, ADR-016, ADR-017, ADR-021) so nobody reads a Status line as a shipped fact. **ADR-011 supersedes the Flutter row in PRD §4.5**: the client in this repo is React Native / Expo. |
| [CI.md](CI.md) | The nine gates in `.github/workflows/ci.yml`, what each one exists to catch, and the one NFR (string-lint, NFR-020) that is named as ungated rather than quietly dropped. |
| [family-agreement.md](family-agreement.md) | The plain-language document a family signs before Device Owner is provisioned. Not legal boilerplate — it is the ethical precondition for holding MDM privilege over a person's phone. |

---

## Findings index

Severity: **S1** = production failure or silent correctness bug · **S2** = costs a weekend · **S3** = imprecision to resolve before coding.

| ID | Finding | Sev | Resolved in |
|---|---|---|---|
| F-01 | `duress` bool is size-distinguishable on the wire — proto3 omits `false`, defeating the constant-size argument | **S1** | §2.9.1 — `optional bool` for explicit field presence |
| F-02 | Canary + drill incidents permanently freeze deploys; incidents never auto-quiesce | **S1** | §2.11.3 — `active_incident_v` view + `DORMANT` state |
| F-03 | Drill incidents would fan out to the family 96×/day | **S1** | §2.11.2 — `drill_run` audience scoping |
| F-04 | Fail-open + first-incident rate-limit exemption is an unbounded flood/cost vector | **S1** | §2.5.1 — known-family scoping, per-family limits, **coalesce not drop** |
| F-05 | Cloudflare is an undefended SPOF in front of the critical path | S2 | §2.7.2 — dual endpoint, direct-origin bypass |
| F-06 | DR `sos-ingest` writes to a read-only streaming replica | **S1** | §2.12.3 — DR writes to its own WAL + NATS |
| F-07 | No component is assigned the MLS Delivery Service role — concurrent commits fork the epoch | **S1** | §2.4.4 — `identity` as DS, `mls_message` ordered log |
| F-08 | MLS at 21 days on the Phase 0 critical path — realistically 8–14 weeks | **S1** (schedule) | §2.4.1 / §3.3 — phased crypto (ADR-021) |
| F-09 | SMS-inbound incidents cannot dedupe against their HTTP twin → two incidents, one emergency | **S1** | §2.10.2 — `inc8` index + deterministic UUIDv5 + reconciliation |
| F-10 | SMS fallback structurally violates NFR-013 (zero Class-A plaintext) | **S1** | §2.4.6 — Class **A′**, never persisted, logged, disclosed |
| F-11 | BLE advertisement is 35 bytes against a 31-byte budget | S2 | §2.10.3 — non-connectable advertising, no Flags AD |
| F-12 | Rotating BLE pseudonym breaks at 15-minute window boundaries | S2 | §2.10.3 — accept windows {n−1, n, n+1} |
| F-13 | Leader election contradicts `FOR UPDATE SKIP LOCKED` | S3 | §2.5.4 — no leader; N workers + `LISTEN/NOTIFY` |
| F-14 | Consent revocation has no cryptographic enforcement path | **S1** | §2.4.5 — two-layer authz with honest pending-state UI |
| F-15 | Append-only log + "retention forever" collides with DPDP erasure | S2 | §2.8.6 — crypto-shredding via `content_key` |
| F-16 | WebSocket auth unspecified; query-string tokens leak into logs | S2 | §2.5.2 — 60 s single-use connect tickets |
| F-17 | Emergency signing key may be unreachable in Direct Boot | S2 | §2.10.1 — degrades correctly; make it measured |
| F-18 | `ascii_short_name` has no uniqueness constraint | S3 | §2.8.2 — `UNIQUE (family_id, lower(...))` |
| F-19 | MLS is the wrong primitive for a 1 Hz location stream | S2 | §2.4.3 — exporter-derived 5-minute stream keys |
| F-20 | Neighbours cannot join the MLS group; no alternative scope defined | S2 | §2.4 / §2.6 — Class B/C only, a cryptographic boundary |
| F-21 | Push notification content policy undefined | S2 | §2.6.3 — data-only payloads + iOS NSE decryption |
| F-22 | `sos-ingest` restart during a Postgres outage starts with an empty key cache | S3 | §2.5.1 — persist the cache to disk, load at boot |
| F-23 | Arithmetic and consistency notes (LOC budget, 3 codegen targets not 2, cost omissions, DLT scope) | S3 | §1.7 F-23 a–g |

---

## The single most important recommendation

**Move MLS off the Phase 0 critical path.** Ship Phase 1 with a per-family static X25519 GroupBox (≈3 days), which is genuinely end-to-end encrypted against the server and satisfies NFR-013 from week one, and schedule the MLS migration as a Phase 2 workstream behind the `sealed_payload` scheme byte.

This removes roughly 8 weeks from the path to the twelve-week gate that carries 90% of the life-saving value, without weakening the server-side threat model (T3) at all. What it defers — forward secrecy and post-compromise security — addresses T6, rated LOW × HIGH, and is not what blocks shipping.

Record it as **ADR-021** with a dated migration commitment, so "later" does not become "never."
