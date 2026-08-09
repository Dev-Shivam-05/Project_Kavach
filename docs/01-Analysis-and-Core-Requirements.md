# SECTION 1 — EXHAUSTIVE ANALYSIS & CORE REQUIREMENTS SUMMARY

> Source: `Project-Kavach-Family-Safety-Platform-PRD-v1.0.md` — 3,371 lines, 226,852 bytes, 24 parts (0–23) plus a closing section. Read in full, line by line.
> This section extracts what the document actually commits to, then reports the **delta**: contradictions, arithmetic errors, unspecified seams, and protocol-level defects that must be resolved before code is written.

---

## 1.1 What the source document is

| Attribute | Value |
|---|---|
| Type | PRD **and** technical blueprint, self-contained, RFC-2119 keyworded |
| Deployment target | Navsari, Gujarat, India. Self-hosted. Family of 4–10. |
| Team assumption | One intermediate full-stack developer, part-time |
| Budget ceiling | ₹10,000/month operational; document models ≈₹7,675 |
| Stated effort | 10–12 weeks to Phase 1; 18–24 months to full scope |
| Maturity | Unusually high. Contains schemas, protobuf, Kotlin, Go, SQL, ADRs, runbooks, drill protocols, and a legal analysis. |

**Assessment:** this is a top-decile internal engineering document. It is more rigorous than most funded commercial products' architecture docs. The analysis below therefore focuses on *defects*, not on praise — the strengths are catalogued in Section 4.

---

## 1.2 Requirement inventory (complete counts)

| Artefact class | Count | Range | Notes |
|---|---|---|---|
| Design principles | 10 | P1–P10 | Every decision traces to one |
| Constraints / assumptions | 8 | C1–C8 | C1 (family owns phones) unlocks the whole Device Owner strategy |
| Problems catalogued | **70** | P-001 – P-070 | 4 sub-catalogs: core safety (2.A), owner-raised (2.B), dev edge cases (2.C), "you will hit these" (2.D) |
| Functional requirements | **48** | FR-001…015 (T0, 15), FR-020…035 (T1, 16), FR-040…056 (T2, 17) | 25 MUST · 17 SHOULD · 6 MAY |
| Non-functional requirements | 20 | NFR-001 – NFR-020 | All measurable, all with a stated measurement method |
| Architecture Decision Records | 20 | ADR-001 – ADR-020 | Each with rejected alternatives |
| Risk register entries | 10 | RISK-001 – RISK-010 | Plotted on a likelihood × impact quadrant |
| Threat model entries | 9 | T1 – T9 | **Ordered by real likelihood, not by CVSS folklore** |
| Chaos tests | 18 | T-201 – T-218 | Named, with expected outcomes |
| Degradation levels | 6 | L0 – L5 | L0 = zero infrastructure; L5 = full fidelity |
| Incident states | 13 | IDLE, WATCH, SUSPECT, PROBE, PENDING, FALSE_ALARM, ACTIVE_L1, ACTIVE_L1_SILENT, ACTIVE_L2, ACTIVE_L3, OWNED, RESOLVING, RESOLVED | |
| Member roles | 8 | guardian, adult, minor, elder, relative, neighbour, staff, guest | |
| Trigger types | 12 (+UNSPECIFIED) | MANUAL … DRILL | |
| Escalation scenarios | 10 | manual panic → disaster | Each with its own cancel window and L2 timing |
| Control-plane modules | 11 | identity, family, policy, escalation, notify, vault, journey, automation, report, consent, device | |
| Data classes | 3 | A (E2EE always), B (server-readable), C (plaintext metadata) | |
| Permanently excluded features | 7 | §1.4.3 "NEVER build" | Excluded on principle, not effort |
| API error codes | 8 | KV-1001…1005, KV-2001…2002, KV-5001 | |
| Build phases | 6 | Phase 0 – Phase 5 | Two hard gates: end of Phase 1, end of Phase 3 |

---

## 1.3 The five load-bearing ideas

Everything else in the document is downstream of these. If an implementation preserves only these five, it preserves the design.

### ① The three-plane model with a strict downward dependency rule
`T0 Survival` (native, on-device, deterministic) → `T1 Coordination` (network, degrades to SMS) → `T2 Intelligence` (may be down for a week).
**The Prime Directive: dependencies flow downward only.** T0 never awaits T1; T1 never blocks on T2.
The document supplies a falsifiable test for the boundary: *kill the Dart VM and verify the SOS gesture still fires, the SMS still sends, the alarm still sounds, and the black box still seals.* Any failure means T0 has leaked into Flutter.

### ② Android Device Owner provisioning (ADR-015, Part 5)
One factory reset + ~15 min of ADB per phone, done before a Google account is added, collapses **eight** independent hard problems into one solved problem:

| Problem | Without | With Device Owner |
|---|---|---|
| P-004 OEM battery kill | Per-vendor whack-a-mole | Whitelisted |
| P-034 Permission auto-revocation | Silent failure | `PERMISSION_POLICY_AUTO_GRANT` |
| P-036 Force-stop | Agent dead until reopened | Effectively prevented |
| P-029 Factory reset | App gone | `DISALLOW_FACTORY_RESET` + FRP |
| Uninstall by a teenager | Trivial | `setUninstallBlocked()` |
| P-023 Kiosk intercom | Escapable launcher hack | `setLockTaskPackages()` |
| P-026 App blocking | Racy overlay | `setPackagesSuspended()` |
| P-060 Silent updates | Play Store or 8 manual APKs | `PackageInstaller` DO session |

This is the single highest-leverage decision in the document and it is only available because of constraint **C1** (the family owns the phones).

### ③ `sos-ingest` as a physically separate, sacred binary (ADR-002)
≤1000 LOC Go, ≤5 dependencies, **no database read on the request path**, no shared code with the control plane, deployed ≤2×/year, own health check, own pipeline, own rollback.
Rationale, stated plainly: *you will ship a bug to the control plane; when you do, SOS must still work.*

### ④ Fail open on the safety path (ADR-018, P8)
A deliberate inversion of standard security doctrine, documented so that no future reviewer "fixes" it. Bad signature → accept, flag `UNVERIFIED`, fan out with a warning banner. `KV-1002` (401) instructs the client to **retry anyway**. Rate limiting is *never* applied to a device's first incident.
Justification: a false alarm costs a phone call; a suppressed real alarm costs a life.

### ⑤ Consent as an expiring, purpose-bound, self-surfacing graph (P4, ADR-009, §10.6)
- `consent_grant.expires_at` is `NOT NULL` — **there is no permanent grant** in the schema.
- Every read writes an `access_log` row and a background job **surfaces it to the observed person**.
- Administration ≠ observation: a Guardian can manage membership and policy but **cannot** silently view an Adult's location.
- The Minor Autonomy Ramp (13 → 15 → 16 → 18) is *published to the minor* as data, not encoded in code.
- Geofences evaluated on-device only (ADR-010) so the server never learns the home address, the school, or ten years of routine.

The document is explicit that this is a **reliability feature, not a courtesy**: a teenager who can see the ratchet loosening on a published schedule is dramatically less likely to sabotage the system.

---

## 1.4 Non-negotiable invariants

These are the assertions that, if violated anywhere in the codebase, mean the system is broken. Each should become a CI check or a test, not a code review convention.

| # | Invariant | Source | Enforcement mechanism to build |
|---|---|---|---|
| **I-1** | T0 never synchronously awaits T1 or T2 | §0.4 Prime Directive | Kill-the-Dart-VM test in CI on a physical device |
| **I-2** | The emergency SMS payload is pure ASCII, ≤160 chars | P-033, ADR-020 | Unit test asserting `all { it.code in 32..126 }` |
| **I-3** | Zero Class-A plaintext at rest on the server | NFR-013, §10.2 | Schema lint in CI over every migration |
| **I-4** | `incident_event` is append-only | §8.1 trigger | Postgres `BEFORE UPDATE OR DELETE` trigger that raises |
| **I-5** | No permanent consent grants | §8.1 | `expires_at timestamptz NOT NULL` |
| **I-6** | No log line ever contains location, names, phone numbers, or message content | §10.5 | Custom `slog.Handler` with a compile-time PII deny-list that panics in dev |
| **I-7** | Duress and normal-cancel are indistinguishable by packet size and timing | §9.3, T-213 | Automated statistical test in CI |
| **I-8** | `incident_id` is client-generated UUIDv7; the server never allocates one | P-053 | Reject server-side ID minting in code review + a contract test |
| **I-9** | Transports fire in **parallel**, never sequentially | §4.4, P-005 | Structural: the dispatcher takes a list, not a chain |
| **I-10** | AI adjusts a confidence input; AI never decides | P7, §13.1 | The fusion stage is a readable ~80-line function, not a model |
| **I-11** | The escalation policy is server-authoritative and versioned; devices never write it | ADR-013 | No write path exists on the device |
| **I-12** | Cross-module imports in `control-plane` go through interfaces or NATS | §7.3 | `go-arch-lint` / import-graph test that fails the build |
| **I-13** | Additive-only schema and protobuf evolution; 24-month client support | NFR-016, §8.4, P-060 | Contract tests replaying recorded requests from 12- and 24-month-old builds |
| **I-14** | The system never auto-dials 112 | ADR-019, §12.4 | Absence of any `ACTION_CALL` to an emergency number |

---

## 1.5 The explicit anti-requirements (§1.4.3)

Seven capabilities are **permanently** out of scope, excluded on principle. They are technically trivial, which is exactly why the exclusion must be structural rather than aspirational:

1. Reading or analysing family members' message content for "concerning" language
2. Silent, invisible location tracking of an adult
3. Covert audio/video recording of a family member without their knowledge (the *only* permitted covert mode is **self-initiated by the subject**, i.e. duress)
4. Cloud LLM processing of raw location, health, or audio data
5. Behavioural risk-scoring or profiling of family members
6. Auto-dialling 112 without human confirmation
7. **Any feature whose primary user is the watcher rather than the watched**

Item 7 is the general rule the other six instantiate. The document's stated reason is operational, not moral: *the watched person always wins in the long run — by disabling, circumventing, or leaving.*

---

## 1.6 The four-clock metric framework

Referenced throughout (§16.3, §17.4, `incident.first_notified_at` = t3, `incident.first_ack_at` = t4) and listed in the glossary as "detection, confirmation, notification, response" — but **never formally defined**. Formalised here because every SLO depends on it:

| Clock | Definition | Stored as | Budget |
|---|---|---|---|
| **t0** | Trigger instant — gesture registered, or sensor fusion crosses threshold | `incident.opened_at` (client HLC) | — |
| **t1** | Confirmation — cancel window expires, or PROBE times out, or duress PIN entered | `incident_event` type `CONFIRMED` | policy-defined 0–300 s |
| **t2** | First transmit — the first byte of the first transport leaves the device | `incident_event.source_transport` earliest | < 500 ms after t1 |
| **t3** | First notification **delivered** to any family device | `incident.first_notified_at` | **p95 < 5 s** online (NFR-002); < 60 s SMS (NFR-003) |
| **t4** | First **human** acknowledgment (CLAIM or ACK tap) | `incident.first_ack_at` | **p95 < 120 s** (NFR-004) — *the number that matters* |

The document is emphatic that t4 is the only clock with life-saving meaning, and that optimising t3 while t4 is six minutes (because someone's phone is in DND) is mistake #7 on its wall-chart list.

---

## 1.7 ⚠️ FINDINGS — contradictions, defects, and unspecified seams

This is the analytical value-add. Each finding is rated:
**S1** = will cause a production failure or a silent correctness bug · **S2** = will cost a weekend · **S3** = imprecision to resolve before coding.

Resolutions are designed in full in Section 2.

---

### F-01 · `duress` boolean is size-distinguishable on the wire — **S1, security**
**Where:** §9.3 protobuf. The document asserts *"`duress` is ALWAYS present, ALWAYS same wire size"* and makes this the foundation of invariant I-7 and threat T4.

**Defect:** in proto3, a plain `bool duress = 12` with value `false` is **omitted from the wire entirely**. `true` costs 2 bytes. So a duress incident is 2 bytes larger *before* padding is applied. The whole constant-size argument rests on a false premise about proto3 encoding.

**Resolution:** declare `optional bool duress = 12;` (proto3 explicit field presence, available since protobuf 3.15). With explicit presence the field is emitted whenever it is set, including when set to `false`. Then pad to a fixed total after serialisation. See §2.9.1.

---

### F-02 · Canary + drill incidents will permanently freeze deploys — **S1, operational**
**Where:** P-070 mandates CI query `GET /internal/active-incidents` and refuses to deploy if non-empty. §16.2 mandates a canary firing a **real** incident every 15 minutes through the real handler.

**Defect:** every 15 minutes there is a live incident for several seconds. A CI deploy has a meaningful probability of landing inside that window and being refused, with no diagnostic explaining why. Worse, the weekly full-fidelity canary runs the SMS and voice legs and stays active for longer.

**Compounding defect:** an incident that reaches `OWNED` and never receives its two-party `RESOLVED` confirmation (subject hospitalised, responder forgets) stays active **forever**, which freezes deploys forever and leaves escalation timers armed.

**Resolution:** `/internal/active-incidents` MUST exclude `is_drill = true`. Add an `auto_quiesce_at` column and a `DORMANT` state reached after a policy-defined interval (default 6 h) with a guardian-visible banner. Add a documented `KAVACH_DEPLOY_OVERRIDE` break-glass with an audit event. See §2.11.3.

---

### F-03 · Drill incidents must not fan out to the family 96×/day — **S1, human factors**
**Where:** §16.2 canary runs every 15 minutes "REAL code path. Not a mock. Same handler, same NATS, same DB."

**Defect:** the notification stage is inside that path. Unless fan-out is scoped, every family phone rings 96 times a day and the system dies in week one from the exact alert fatigue it exists to prevent (RISK-002).

**Resolution:** `is_drill` incidents route to a `drill_audience` (canary receiver device only) unless the incident carries `drill_notifies_family = true`, set only by the quarterly drill orchestrator. Drill incidents are also excluded from the False Positive Ledger and from NFR-008 accounting. See §2.11.2.

---

### F-04 · Fail-open + no-rate-limit-on-first-incident is an unbounded cost and flood vector — **S1, security/cost**
**Where:** ADR-018, P8, KV-1005 (*"Never applied to the first incident from a device"*), §7.1 (accepts unverified incidents). Threat T8 is rated **LOW × MED**.

**Defect:** the rate-limit exemption keys on `device_id`, which is an attacker-chosen field inside an **unauthenticated** protobuf. An attacker enumerates fresh random `device_id`s and every request is a "first incident" — infinite fan-out. Each fan-out costs real SMS money and, more importantly, produces real sirens on real family phones. T8 is materially under-rated: likelihood is LOW only because nobody knows the endpoint exists, and impact is *system destruction via alert fatigue*, not MED.

**Resolution — fail open, but bound the blast radius:**
1. Fail open applies **only when `family_id` resolves to a known family**. An unknown `family_id` is dropped at the edge (no family = nobody to help).
2. Rate limiting is per-**family**, not per-device: the first incident from a family is always accepted; concurrent unverified incidents beyond N=3 within 60 s are **coalesced into one incident** with an `UNVERIFIED_FLOOD` flag rather than dropped. Coalescing preserves fail-open semantics (the alarm still fires) while capping fan-out.
3. A hard monthly SMS spend ceiling in `notify`, with the ceiling breach itself becoming a P0 page.
4. Cloudflare WAF rate limit sits in front but must **not** be the only control — see F-05.

See §2.5.1 and §2.6.4.

---

### F-05 · Cloudflare is a single point of failure in front of the most critical path — **S2, reliability**
**Where:** §4.3 container diagram: `CFW --> ING`.

**Defect:** the entire architecture is built to survive the failure of the control plane, Postgres, NATS, the region, and the provider. It is **not** built to survive Cloudflare. A Cloudflare edge incident takes the SOS path down while every other layer is healthy.

**Resolution:** the client pins **two** ingest endpoints — `api.kavach.example` (via Cloudflare) and `ingest-direct.kavach.example` (A/AAAA straight to the origin, TLS with its own pinned cert) — and fires **both in parallel** during an incident, consistent with I-9. Cost: one duplicate request per incident. See §2.7.2.

---

### F-06 · DR ingest writes to a read-only streaming replica — **S1, DR**
**Where:** §4.3: `ING2 --> PGD` where `PGD` is labelled "Streaming replica".

**Defect:** a PostgreSQL streaming replica is read-only. The DR `sos-ingest` cannot write to it. As drawn, DR failover accepts incidents and then loses them.

**Resolution:** DR `sos-ingest` writes **only** to its own local fsync'd WAL file and its own local NATS JetStream, and drives the SMS fan-out worker directly from that. `PGD` stays read-only until a *deliberate, manual* promotion documented in §19.8. Reconciliation replays the DR WAL into the primary after recovery, deduplicating on `(incident_id, hlc)`. See §2.12.3.

---

### F-07 · Nobody is designated as the MLS Delivery Service — **S1, crypto**
**Where:** ADR-008 / §10.3 adopt MLS (RFC 9420) via OpenMLS. No component is assigned the Delivery Service role.

**Defect:** MLS **requires** a Delivery Service that imposes a **total order on Commit messages per group**. Without it, two devices that commit concurrently fork the epoch and the group silently splits into two ciphertext universes that can no longer read each other. This is not a performance concern; it is a correctness precondition of the protocol. Recovery from a forked group is a manual re-bootstrap of the whole family.

**Resolution:** `control-plane/identity` implements the DS. Commits are serialised per `family_id` via a Postgres advisory lock or a `SELECT … FOR UPDATE` on `family.current_epoch`; a commit carrying a stale epoch is rejected with `KV-2003 epoch_conflict`, and the client re-fetches, re-applies, and retries. Welcome and Commit messages are stored in a per-family ordered `mls_message` table so a device offline for months can replay. See §2.4.4.

---

### F-08 · MLS is on the Phase 0 critical path at 21 days — the single biggest schedule risk — **S1, schedule**
**Where:** §18.1 gantt: `Auth + device enrolment + MLS bootstrap : 21d`.

**Defect:** for a developer who has not previously shipped MLS, 21 days covers *neither* OpenMLS FFI into Dart, *nor* the Delivery Service (F-07), *nor* epoch recovery, *nor* multi-device-per-member key packages, *nor* the key transparency log that §10.3 also requires. Realistic range is 8–14 weeks. Since Phase 0 blocks Phase 1, and *"Phase 1 IS the project"*, this line item is the most likely cause of the project never shipping (RISK-004).

**Resolution — phase the cryptography, not the privacy guarantee:**
- **Phase 1 crypto:** per-family static X25519 group key, distributed to each enrolled device via a libsodium `crypto_box_seal` to that device's identity public key. Content encrypted with XChaCha20-Poly1305 under keys derived from the group key. This is genuinely end-to-end encrypted against the server, satisfies NFR-013 and I-3 from week one, and is ~3 days of work.
- **What it lacks:** forward secrecy and post-compromise security. Document this explicitly in the ADR log as **ADR-021** with a dated migration commitment.
- **Phase 2:** migrate to MLS. The `sealed_payload` field is opaque bytes with a 1-byte scheme discriminator, so the migration is additive and old clients keep working (NFR-016).

This removes ~8 weeks from the critical path to the Phase 1 gate without weakening the server-side threat model at all. See §2.4.1.

---

### F-09 · SMS-inbound incidents cannot be deduplicated against their HTTP twin — **S1, correctness**
**Where:** §6.2.5 SMS payload carries `inc8` = "first 8 chars of incident UUID (base36)". §9.2 `POST /v1/incident/sms-inbound`. P-053 relies on client-generated UUIDv7 for idempotency.

**Defect:** 8 base36 characters cannot reconstruct a 128-bit UUID. The SMS path therefore creates an incident with a *different* `incident_id` than the same incident arriving over HTTP/WS/BLE. Result: the family gets **two incidents for one emergency** — precisely the failure P-053 exists to prevent, and it occurs in the degraded case where confusion is most costly.

**Resolution:** two-part.
1. The device, whenever it has *any* data path, publishes `(inc8 → full incident_id)` into a Valkey prefix index with 24 h TTL. `sms-inbound` resolves `inc8` against it first.
2. If unresolved (true SMS-only case), mint a **deterministic** UUIDv5 over `(family_id, inc8, floor(ts/300))` so that a *second* SMS carrying the same `inc8` maps to the same incident, and record `synthetic_from_sms = true`. When the device later reconnects and pushes the real incident, a reconciliation job merges the two by `inc8` prefix match within a 24 h window, emitting an `INCIDENT_MERGED` event. See §2.10.2.

---

### F-10 · SMS fallback structurally violates NFR-013 (zero Class-A plaintext) — **S1, privacy contract**
**Where:** §10.2 classifies precise location as Class A, *"E2EE always"*, and NFR-013 sets server-side Class-A plaintext to **Zero**. §6.2.5 sends `lat,lon` to 6 decimal places in cleartext SMS, through a third-party aggregator, into `POST /v1/incident/sms-inbound`.

**Defect:** this is not a bug — it is an unavoidable and *correct* trade-off (a screaming phone that tells your family where you are beats a privacy invariant). But the document never acknowledges the collision, so an implementer will either (a) faithfully implement NFR-013 and break SMS, or (b) implement SMS and silently persist Class-A plaintext, quietly falsifying the system's central privacy claim.

**Resolution:** introduce a fourth, explicitly-named class, **A′ (Degraded Survival Plaintext)**, with hard rules:
- Permitted only on the SMS and BLE-relay ingress paths, only during an incident.
- **Never persisted.** `sms-inbound` extracts coordinates, forwards them in-memory to the fan-out, persists **only** `coarse_h3_r7`, and discards the precise value. If a durable copy is needed for the timeline, the *subject's own device* re-uploads a sealed copy on reconnect.
- Every A′ event writes an `access_log` row visible to the subject: *"your precise location was sent unencrypted by SMS during incident X."*
- The third-party aggregator is named in the family agreement (§20.3) as a party that can see coordinates during an emergency.
- Covered by a schema lint exception with an explicit allowlist so I-3 remains machine-checkable.

See §2.4.6.

---

### F-11 · BLE advertisement exceeds the 31-byte legacy budget — **S2, protocol**
**Where:** §11.5: "Service UUID (2 bytes) + Manufacturer data (24 bytes)".

**Defect:** the arithmetic omits AD-structure framing. Legacy BLE advertising payload is 31 bytes *total*, and each AD structure costs `length(1) + type(1)`. As specified: Flags AD (3) + Service-UUID AD (2+2=4) + Manufacturer AD (2 + 2 company ID + 24 = 28) = **35 bytes**. It does not fit, and the Android advertiser will fail at runtime with `ADVERTISE_FAILED_DATA_TOO_LARGE`.

**Resolution:** use **non-connectable, undirected** advertising (`setConnectable(false)`), which lets Android omit the Flags AD. Drop the separate Service-UUID AD and use the 2-byte company identifier as the discriminator. Budget becomes `1 + 1 + 2 (company ID) + 27 payload = 31` — the 24-byte payload fits with 3 bytes spare for a future version byte. Do **not** rely on BLE 5 extended advertising: the fleet includes 4-year-old Android 10 devices. See §2.10.3.

---

### F-12 · The rotating BLE pseudonym breaks at window boundaries — **S2, protocol**
**Where:** §11.5: pseudonym = `HMAC(group_secret, floor(unix_time / 900))`.

**Defect:** two devices whose clocks differ by even a few seconds across a 15-minute boundary compute different pseudonyms and stop recognising each other — exactly at the moment one of them is in distress. P-052 already establishes that device clocks drift and lie.

**Resolution:** scanners accept windows `{n−1, n, n+1}` (3 HMAC comparisons, negligible cost). Advertisers rotate on the boundary; scanners tolerate ±15 minutes. Additionally document the residual privacy property honestly: the pseudonym is **family-wide**, so a persistent local observer can detect "a Kavach family device is present" and correlate that family across locations within a window. This is an accepted trade-off, not a flaw, but the family agreement should say so.

---

### F-13 · `escalation_timer` — leader election contradicts `SKIP LOCKED` — **S3, clarity**
**Where:** §7.4 says *"polled every 250 ms by a single leader-elected worker"*; ADR-014 says `FOR UPDATE SKIP LOCKED` gives *"safe concurrent workers with no coordination"*.

**Defect:** these are two different designs. `SKIP LOCKED` exists precisely so you do **not** need leader election; adding leader election introduces a failure mode (leader loss = all timers stall) that `SKIP LOCKED` was chosen to avoid.

**Resolution:** no leader election. N stateless workers, `FOR UPDATE SKIP LOCKED`, `LIMIT 100`. Replace the unconditional 250 ms poll with `LISTEN/NOTIFY` on timer insert plus an adaptive poll (250 ms when any timer is due within 5 s, 2 s otherwise) — same latency, ~90% fewer queries, quieter logs.

---

### F-14 · Consent revocation has no cryptographic enforcement path — **S1, privacy**
**Where:** §10.6 OpenFGA gates authorization. §8.1 `consent_grant.revoked_at`. §18.4 acceptance: *"Revoking a grant takes effect on all devices within 30 s."*

**Defect:** OpenFGA gates **server-side metadata reads**. But live location is Class A — the server holds only ciphertext, and the *plaintext* is available to anyone holding the location stream key. Revoking a grant in OpenFGA does not remove a key already on a revoked member's device, and does not stop them decrypting **future** points if the key does not change. The stated acceptance criterion is therefore unverifiable as specified.

**Resolution — two-layer authorization, stated explicitly:**
- **Layer 1 (metadata / routing):** OpenFGA + Postgres RLS. Governs who may *request* a stream, see incident metadata, or receive a key-wrap.
- **Layer 2 (plaintext):** cryptographic. Revoking a `live_location` grant triggers the **grantor's device** to ratchet the Location Stream Key and re-wrap it to the reduced recipient set. Until the grantor's device is online, the server refuses to route new location frames to the revoked member (Layer 1 holds the line), and the ledger UI shows *"revocation pending key rotation — takes effect when Priya's phone is next online."*
- Honesty requirement: the UI must **not** claim the revocation is complete before the ratchet lands.

See §2.4.5.

---

### F-15 · Append-only `incident_event` + "retention: forever" collides with DPDP erasure — **S2, legal**
**Where:** §8.3 retention: incident events = **Forever**. §8.1 enforces append-only with a raising trigger. §20.1: erasure on withdrawal is a DPDP obligation the moment a non-family member is onboarded (C8, P-061).

**Defect:** you cannot delete a staff member's data from a table protected by a `BEFORE UPDATE OR DELETE … RAISE EXCEPTION` trigger.

**Resolution:** **crypto-shredding.** Per-subject content keys are stored in a mutable `content_key` table. Erasure deletes the key row; the ciphertext and metadata remain as an unreadable tombstone, satisfying both append-only integrity and erasure. Document this as the erasure mechanism in the DPDP mapping and in the family agreement — "we destroy the key, not the row" is a defensible and increasingly standard position. See §2.8.6.

---

### F-16 · The realtime WebSocket auth scheme is unspecified and leak-prone as drawn — **S2, security**
**Where:** §9.2: `wss://rt.kavach.example/v1/stream?cursor=<hlc>`. Auth is not stated; the control-plane convention is a bearer token.

**Defect:** if the token rides in the query string it lands in access logs, proxy logs, and Loki — colliding with I-6. If the token is a normal 15-minute access token, every reconnect after expiry fails silently and presence dies.

**Resolution:** a single-use, 60-second **connect ticket** minted by `POST /v1/rt/ticket` (bearer-authenticated), sent in the `Sec-WebSocket-Protocol` header, exchanged for a session bound to `device_id`. The session survives access-token expiry for its full lifetime and is revoked by an explicit `session.revoke` NATS event. Never in the query string.

---

### F-17 · The emergency signing key may be unavailable during Direct Boot — **S2, platform risk**
**Where:** §10.3 requires a StrongBox Ed25519 key with `setUserAuthenticationRequired(false)`. §6.2.2 requires the agent to function before first unlock.

**Risk:** Android Keystore availability in Direct Boot is OEM-variable. If the key is unreachable pre-unlock, the signed HTTP envelope fails on exactly the 2 a.m.-reboot scenario P-035 exists to solve.

**Assessment:** the architecture is *already resilient* to this — fail-open (ADR-018) means an unsigned incident is still accepted as `UNVERIFIED`, and the SMS path uses an HMAC key held in Device Protected Storage, which is definitionally available pre-unlock. So the system degrades correctly.

**Resolution:** make it explicit and measured. Generate the key with `setUnlockedDeviceRequired(false)`, verify accessibility in Direct Boot as a **first-class item on the device test matrix** (§17.2), and record `t0_signing_available_predawn` in `device.diagnostics` so a fleet-wide OEM regression is visible on Dashboard 1 rather than discovered during an emergency.

---

### F-18 · `ascii_short_name` has no uniqueness constraint — **S3, correctness**
**Where:** §8.1 `member.ascii_short_name text NOT NULL CHECK (~'^[A-Za-z]{1,8}$')`; §6.2.5 allocates 8 SMS characters to it.

**Defect:** "Priya" and "Priyanka" both truncate into an 8-char field that a responder reads under stress at 2 a.m. Two family members can share a short name.

**Resolution:** `UNIQUE (family_id, lower(ascii_short_name))`, enforced at onboarding with a disambiguation prompt ("PRIYA" / "PRIYAS"). Add it to the Appendix E.4 onboarding checklist.

---

### F-19 · MLS is the wrong primitive for a 1 Hz location stream — **S2, performance**
**Where:** FR-023 requires 1–5 s live location during incidents. §8.1 `location_point.sealed_coords bytea` "E2EE".

**Defect:** one MLS application message per location point means a ratchet operation per point per recipient — hundreds of ratchet steps per minute, plus a large key schedule state. MLS is designed for messages, not telemetry streams.

**Resolution:** derive a **Location Stream Key** per 5-minute window from the MLS **exporter secret** (`MLS-Exporter(label="kavach-loc", context=window_id)`), then seal each point with XChaCha20-Poly1305 using a counter nonce. One MLS operation per 5 minutes; every point is a cheap AEAD. The document's key hierarchy already draws `LK "Location Stream Key — ratcheted per 5-min window"` — this makes the derivation explicit rather than leaving it as an implicit hope. Identical approach for the Incident Content Key.

---

### F-20 · Neighbours cannot be in the family MLS group, but no alternative scope is defined — **S2, crypto/privacy**
**Where:** FR-026 / §10.6 `can_view_reduced` grants trusted neighbours "reduced-detail alerts", 6-hour window.

**Defect:** MLS group membership is all-or-nothing. Putting a neighbour in the family group gives them the family's entire ciphertext history. Leaving them out means there is no defined channel through which they receive anything.

**Resolution:** neighbours are served **entirely from Class B/C** — incident state, trigger type, `coarse_h3_r7`, subject short name, and a 112 button. No Class-A payload is delivered to them at all, over any transport. This makes `can_view_reduced` a *cryptographic* boundary rather than an application `if`, which is precisely the property §10.6 says it wants. The 6-hour `time_window` condition then gates only the metadata feed.

---

### F-21 · Push notification content policy is undefined — **S2, privacy/UX**
**Where:** §12.1 requires L1 to produce a full-screen alert; §10.2 forbids Class A leaving the device in plaintext.

**Defect:** FCM/APNs payloads transit Google/Apple. Any human-readable alert body is by definition visible to them and appears on a **locked screen**. The document never states what the notification is allowed to say.

**Resolution:** push payloads are **data-only**, Class B/C exclusively — `{incident_id, family_id, trigger, tier, subject_short_name}`. The device composes the human-readable text locally from its own MLS/group-decrypted state. On iOS, a **Notification Service Extension** with keychain access performs the decryption before display. Lock-screen preview shows short name + trigger class only; detail requires unlock. This is both a privacy control and a UX decision, and it must be written down.

---

### F-22 · `sos-ingest` loses its verification ability across a restart during a Postgres outage — **S3, reliability**
**Where:** §7.1: key cache refreshed from Postgres every 60 min; *"If Postgres is unreachable, the cache simply goes stale."*

**Defect:** a *stale* cache is fine. An *empty* cache is not. If `sos-ingest` restarts while Postgres is down — the exact correlated-failure scenario — it starts with zero keys and flags **every** incident `UNVERIFIED`, defeating the signature layer at the worst moment.

**Resolution:** persist the key cache to a local `keycache.pb` on every refresh and load it at boot before serving. Adds ~15 lines and one dependency-free file write, and stays within the ≤1000 LOC / ≤5 dependency budget.

---

### F-23 · Minor arithmetic and consistency notes — **S3**

| # | Item | Note |
|---|---|---|
| a | `sos-ingest` size | §7.1 says ≤1000 LOC / ≤5 deps; §4.3 diagram says ~800 LOC / 4 deps. Harmonise to the §7.1 limits as the CI-enforced ceiling. |
| b | State machine targets | §7.5 says "implemented twice: Kotlin/Swift and Go". That is **three** codegen targets, not two. The generator must emit Kotlin, Swift, and Go from `spec/state-machine.yaml`. |
| c | SMS budget | 2+8+8+3+21+4+3+7+8 = 64 fixed + ~20 separators = 84; tail ~70 → 154 ≤ 160 ✅. Verified correct. The tail duplicates lat/lon, which is intentional (P-051: carriers strip links; the raw pair is the payload). |
| d | Idle power budget | Sums to 153 mAh/day against a 180 budget ✅, but excludes Flutter process residency, MLS/crypto, and OS overhead. Treat 153 as the *floor*, not the estimate, and gate on the measured NFR-005 fleet test. |
| e | Cost model omissions | Backblaze B2 (~₹200), Google Play one-time $25, Raspberry Pi + UPS (~₹6,000 capex), IMD/weather feed, LiveKit beyond free tier during long incidents, Postgres storage growth. Revised realistic monthly ≈ **₹8,100**, still under the ₹10,000 C6 ceiling. |
| f | DLT scope confusion | A2P/DLT registration applies to **server → family** SMS and to the aggregator inbound leg. The **device → family-number** SMS sent from the user's own SIM is P2P and is *not* subject to DLT. Worth stating, because conflating them causes people to believe the T0 SMS path is blocked on a 2-week registration. It is not — but the Phase-1 fan-out leg is. |
| g | iOS SMS fallback | `MFMessageComposeViewController` requires a user tap. Combined with no Direct Boot and no force-quit survival, an iPhone **as a subject device has no functioning L2 tier at all**. The document says this in §6.3; it deserves restating as a headline limitation, not a matrix row. |

---

## 1.8 Requirement summary — what must be true at the Phase 1 gate

The document's own gate (§18.3 W13–16) is the correct scope boundary. Restated as a checklist:

```
✅ NFR-001 … NFR-009 measured and met
✅ 2 quarterly-protocol drills passed
✅ Zero unexplained canary failures for 14 consecutive days
✅ Every family member has triggered AND cancelled a test SOS unaided
✅ T-204, T-205, T-207, T-213, T-216 pass on the full device matrix
✅ Every Android phone reports is_device_owner = true
✅ ASCII SMS lint passes; DLT templates live and delivery-tested to every number
✅ A message encrypted on phone A decrypts on phone B and is unreadable on the server
```

Everything in Parts 13–14 of the PRD (AI, IoT, wearables, CCTV, floor plans) is explicitly worthless if this gate is not met first. The document's closing line is the correct project management instruction: **ship Phase 1 in twelve weeks, then stop and use it for a month.**
