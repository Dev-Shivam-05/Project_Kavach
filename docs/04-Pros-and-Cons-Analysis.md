# SECTION 4 — COMPREHENSIVE PROS & CONS ANALYSIS

> Evaluation of the architecture as designed in Section 2 (the PRD's design plus the corrections from §1.7). Organised by concern, with each dimension carrying **strengths**, **weaknesses / trade-offs accepted**, and **optimisation opportunities**.
> Ratings: **A** = genuinely excellent, better than most funded products · **B** = solid, industry-standard · **C** = adequate but a known liability · **D** = a real problem.

---

## 4.1 Executive verdict

| Dimension | Rating | One-line assessment |
|---|---|---|
| Architectural soundness | **A** | The three-plane model with a strict downward dependency rule is the correct decomposition for a safety system, and it is applied consistently rather than aspirationally. |
| Reliability engineering | **A** | Device Owner + exact-alarm watchdog + server-side gap detection + canary is a four-layer defence against the dominant real failure mode. Very few products build even one layer. |
| Privacy architecture | **A** | On-device geofencing (ADR-010) and the expiring-consent graph are stronger than anything in the commercial family-safety market, and are motivated *operationally* rather than morally. |
| Security posture | **B+** | Excellent threat ordering and a correct fail-open inversion. Weakened by the fail-open flood vector (F-04) and by cryptographic seams that were named but not designed (F-07, F-14). All fixable. |
| Scalability | **A** (for its actual target) | Correctly refuses to over-engineer. "You have an evolution problem, not a scaling problem" is exactly right, and the cheap optionality decisions are genuinely cheap. |
| Performance / battery | **B+** | The power budget is treated as a first-class SLO, which is unusual and correct. The specific numbers are optimistic and will need measurement. |
| Maintainability | **B** | Boring technology and enforced module boundaries help enormously. Undermined by the sheer breadth of Phases 4–5 relative to one part-time developer. |
| Cost efficiency | **A** | ≈₹8,100/month for capability a commercial service charges ₹800–2,000/month **per person**. The cost-trap table is genuinely instructive. |
| Legal / compliance | **A−** | DPDP mapping is accurate and forward-looking; the ethical stance on Device Owner is exemplary. Erasure vs append-only was unresolved (F-15). |
| Human factors | **A** | The strongest dimension. Alert fatigue, bystander effect, teenage sabotage, drill fatigue, and engagement decay are all first-class design inputs. |
| **Schedule realism** | **C** | The MLS line item (F-08) is a project-killing under-estimate as written. With the phased-crypto correction it becomes **B+**. |

**Overall: this is a design that will work.** The dominant risk is not technical — it is that a single part-time developer, faced with a 24-month scope, never reaches the twelve-week gate that carries 90% of the life-saving value.

---

## 4.2 Architecture

### Strengths

**A1 · The three-plane model is the correct primitive.** Most safety apps have one plane and therefore one failure domain. Splitting by *criticality* rather than by *feature* means a bug in the smart-home integration cannot reach the panic button. The Prime Directive (dependencies flow downward only) is enforceable, and the PRD supplies a falsifiable test: kill the Dart VM, verify the SOS still fires. A design principle with an executable test is worth ten without one.

**A2 · `sos-ingest` as a physically separate binary.** ≤1000 LOC, ≤5 dependencies, no DB read on the hot path, deployed twice a year. The reasoning — *you will ship a bug to the control plane; when you do, SOS must still work* — is empirically correct and almost never acted on. This single decision converts "the app was down" from a possible incident report into an architectural impossibility.

**A3 · Parallel, not sequential, transport fan-out.** "Five redundant messages cost ₹1.20; a sequential fallback chain costs 45 seconds" is the single best sentence in the document. Sequential fallback with timeouts is the default mistake in every offline-first system, and the cost asymmetry here is roughly 40:1 in favour of redundancy.

**A4 · The degradation ladder has a defined *floor*, not an error state.** L0 — a screaming phone showing a medical card and coordinates in 48pt type — means there is no reachable state where the product says "no connection" and gives up. Most "offline-first" claims collapse into a spinner; this one does not.

**A5 · Append-only event log with HLC ordering, and the explicit refusal to import a CRDT library.** ADR-012 is correct: append-only logs merge by set union and are conflict-free by construction. Reserving Yjs for genuinely concurrent text editing (shared notes) and nowhere else is exactly the right level of dependency discipline.

**A6 · Modular monolith over microservices (ADR-004), Docker Compose over Kubernetes (ADR-005).** With one developer and eight users, inter-service plumbing would consume ~60% of the effort. Enforced module boundaries via a CI import-graph check give ~90% of the decoupling at ~10% of the cost, and preserve the option to extract a module in a day.

**A7 · The state machine as data, generated into every runtime.** One `state-machine.yaml` generating Kotlin, Swift, and Go eliminates an entire bug class (divergent client/server escalation semantics) that would otherwise be nearly impossible to detect until a real emergency.

### Weaknesses and accepted trade-offs

**W1 · Flutter + native T0 is a two-language, three-runtime system.** Every T0 feature exists in Kotlin *and* Swift, with a protobuf bridge to Dart. The PRD honestly calls ADR-011 "the least important decision here," and it is right — but the *cost* is real: roughly 1.6× the client work of a single-platform build. **Mitigation:** the iOS T0 is deliberately a reduced subset, and the PRD's guidance that primary safety devices SHOULD be Android is the correct way to cap that cost.

**W2 · T0 in the app process (as originally specified) shares a failure domain with Flutter.** A Flutter OOM kill takes T0 with it, defeating R1. **Resolved in §2.2.1** by running T0 in `:t0`, at the cost of an AIDL boundary that was already needed.

**W3 · The BLE relay creates an implicit trust edge.** A relaying peer sees `incident_id`, risk level, and a coarse (H3 r9, ~180 m) position for a family member who has not chosen to share location with them. Within a family this is acceptable and arguably desirable. It should nonetheless be **disclosed in the family agreement**, because it is a location disclosure that bypasses the consent graph by design.

**W4 · Home Assistant is a hard external dependency for the whole T2 smart-home plane.** ADR-016 is correct (building a Matter controller costs 8–12 months), but a ₹4,000 Pi becomes load-bearing for smoke, gas, and water detection. **Mitigation as specified:** UPS + hot spare. **Additional:** the HA bridge should surface Pi liveness on Dashboard 1, because a dead Pi is exactly the silent failure the whole design philosophy targets.

### Optimisations

| # | Opportunity | Gain | Cost |
|---|---|---|---|
| O-1 | Run T0 in its own process (`android:process=":t0"`) | Independent memory budget and crash domain | ~1 day (AIDL) |
| O-2 | Dual ingest endpoint bypassing Cloudflare (F-05) | Removes the last SPOF on the critical path | ~2 hours |
| O-3 | Generate the client's transport dispatcher from the same YAML as the ladder | Client and server ladder cannot drift | ~1 day |
| O-4 | Publish `active_incident_v` as a Grafana panel | Turns the deploy-freeze condition into a visible state | ~1 hour |

---

## 4.3 Security

### Strengths

**S1 · The threat model is ordered by *actual* likelihood, and its top entry is the one nobody models.** T1 — intra-family surveillance and coercive control, HIGH × HIGH — is statistically the most likely harm a family safety product will ever cause, and every family-safety product on the market has been used as stalkerware. Naming it as threat #1 and designing the consent architecture around it is the most sophisticated single judgement in the document.

**S2 · Fail open on the safety path (ADR-018), documented as a deliberate inversion.** Most systems fail closed by reflex. Here the asymmetry is explicit — a false alarm costs a phone call, a suppressed real alarm costs a life — and, crucially, it is written down *so that no future reviewer "fixes" it*. `KV-1002` (401) instructing the client to retry anyway is the correct expression of this.

**S3 · Decoupling the panic path from authentication (P-007).** The SOS endpoint does not accept bearer tokens at all. This eliminates an entire bug class — expired token → 401 → nothing happens — that has genuinely killed people in production systems.

**S4 · Two hardware keys, one deliberately not biometric-gated.** *"An unconscious person cannot provide a fingerprint."* Gating the emergency signing key on biometrics builds a system that works only for conscious people — excluding exactly the people who need it most. Very few designs notice this.

**S5 · Duress as a first-class, constant-time path.** Pixel-identical cancel UI, fixed-size envelopes, padded timing, two-way audio permanently disabled, and an automated statistical test (T-213) that asserts indistinguishability. Treating side-channel resistance as a *testable requirement* rather than a code-review aspiration is the right call.

**S6 · Compile-time PII deny-list in the logger.** A `slog.Handler` that panics in development when a field key matches. Logging is where privacy architectures die quietly; making it a build-time failure is the only reliable control.

**S7 · Key transparency (append-only key-addition log with client-side inclusion verification).** This defends against the classic E2EE server attack — a compromised server silently adding a device to the group. Most E2EE products skip it.

### Weaknesses and trade-offs

**W5 · Fail-open + first-incident rate-limit exemption was an unbounded flood vector (F-04) — the most serious finding.** The exemption keyed on `device_id`, an attacker-chosen field in an *unauthenticated* protobuf. Enumerate fresh IDs → every request is a "first incident" → unbounded fan-out. The cost is real money, but the real damage is **real sirens on real family phones**, which destroys the system through the exact alert fatigue it exists to prevent. Threat T8 was materially under-rated at LOW × MED. **Resolved in §2.5.1** by scoping fail-open to known families, rate-limiting per family, and **coalescing rather than dropping** — which preserves fail-open semantics exactly.

**W6 · The duress size-channel claim rested on a false premise about proto3 (F-01).** A plain `bool duress = false` is omitted from the wire entirely. The entire constant-size argument — the foundation of threat T4's mitigation — did not hold as written. A one-keyword fix (`optional`), but a genuine security defect that a security review would have to catch, and the kind that survives review precisely because the surrounding prose is so confident.

**W7 · Two cryptographic seams were named but not designed.** The MLS Delivery Service (F-07) is a *correctness precondition* of RFC 9420, not an optimisation — without per-group total ordering of Commits, concurrent commits fork the epoch and the family silently splits into two ciphertext universes requiring a manual re-bootstrap. And consent revocation (F-14) had no cryptographic enforcement path: OpenFGA gates metadata, but a revoked member holding a stream key can still decrypt. Both are designed in §2.4.4 and §2.4.5.

**W8 · GroupBox (the Phase 1 crypto) has no forward secrecy or post-compromise security.** This is an *accepted, dated* trade-off (ADR-021), not an oversight. It fully addresses T3 (server compromise), which is the reason E2EE exists here. It does not address T6 (compromised family device), rated LOW × HIGH. Given that the alternative is an 8–14 week delay to the gate that carries 90% of the life-saving value, this is the right trade — **provided the MLS migration is actually scheduled and not quietly abandoned.**

**W9 · Class A′ is an honest weakening of a headline claim.** The SMS path transmits precise coordinates in plaintext through a carrier and a commercial aggregator. NFR-013 ("zero Class-A plaintext on the server") survives because A′ is never persisted — but the *marketing* claim "your location is always end-to-end encrypted" does not survive, and must not be made. The family agreement must name the aggregator as a party that can see coordinates during an emergency. Correctly resolved, but it is a real reduction in the privacy story.

**W10 · Device Owner is genuine, unilateral power over another adult's phone.** The PRD handles this better than most commercial MDM products — mandatory disclosure, a "this device is managed" screen listing every restriction, an explicit refusal to hide Android's own managed-device notice, a reduced policy set for adults, and a documented removal procedure. The residual risk is not technical: **the same capability that defeats MIUI's battery killer is the capability that would let a controlling family member suspend another adult's apps.** The mitigation is procedural (the reduced policy set + the signed agreement) and depends on the operator's good faith. That should be stated plainly rather than engineered around.

**W11 · Certificate pinning is a self-inflicted-outage risk.** Mitigated well (dual pins, documented rotation, a signed kill switch, and pin expiry that **fails open** rather than bricking devices) — but pinning remains the most common cause of "every client broke simultaneously" in mobile fleets. Given that the transport already runs TLS 1.3 to a Cloudflare-fronted origin, pinning buys relatively little here against a meaningful operational risk. **Consider dropping pinning on the control plane and retaining it only on `sos-ingest`.**

### Optimisations

| # | Opportunity | Gain |
|---|---|---|
| O-5 | Fuzz `sos-ingest`'s protobuf parser in CI (`go-fuzz`) | It is the only unauthenticated, internet-exposed parser in the system |
| O-6 | Make the padding assertion **fail closed** | A mis-padded envelope silently leaks the duress bit; failing closed converts a silent leak into a loud bug |
| O-7 | Add `T-223` (unverified flood) and `T-219` (MLS commit race) to the chaos suite | Both cover findings whose failure mode is invisible until exploited |
| O-8 | Annual manual review of every direct dependency (already specified) — extend to a **quarterly** review for `sos-ingest`'s five | Five dependencies is small enough to actually read |

---

## 4.4 Privacy

### Strengths

**P1 · On-device geofencing (ADR-010) is the highest-leverage privacy decision available, and it is nearly free.** One decision removes the home address, the children's school, the workplace, and ten years of daily routine from the server *permanently*. The functional cost is near zero: a crossing emits `{geofence_id: <opaque uuid>, transition: EXIT}` and the server orchestrates the response without ever learning where "school" is.

**P2 · Consent as an expiring graph with mandatory expiry in the schema.** `expires_at timestamptz NOT NULL` means there is no code path that can create a permanent grant. Enforcing a privacy property in a `NOT NULL` constraint rather than in application logic is exactly right — application-enforced security properties leak over time; schema-enforced ones do not.

**P3 · Access logs surfaced *to the observed person* by a background job.** Not merely recorded — actively shown. `access_log.surfaced_to_subject boolean NOT NULL DEFAULT false` with an index on the un-surfaced rows makes the surfacing job's backlog a visible, monitorable quantity.

**P4 · Administration ≠ Observation.** A Guardian manages membership, holds a recovery share, and configures policy, but **cannot** silently view an Adult Member's location. This separation is what makes the system acceptable to other adults in the house, and it is the difference between a family safety system and household surveillance.

**P5 · The published Minor Autonomy Ramp.** Age-based transitions encoded as data and *shown to the child*: full visibility into who is watching at 13, requestable expiry and private hours at 15, revocable routine location at 16, auto-promotion to Adult at 18. The PRD's framing is correct and unusually clear-eyed: this is a **reliability feature, not a courtesy** — a teenager who can see the ratchet loosening on a published schedule is dramatically less likely to sabotage the system.

**P6 · The "NEVER build" list, and its stated reason.** Seven capabilities excluded on principle, generalised by: *any feature whose primary user is the watcher rather than the watched.* And the justification is operational, not moral — *the watched person always wins in the long run, by disabling, circumventing, or leaving.* The passage on teenage message analysis (*"build a relationship with your teenager"*) is the clearest line in the document.

**P7 · Purpose binding in the authorization layer.** A grant made "for safety" cannot satisfy a "routine curiosity" check, and the purpose is logged as part of the decision. RBAC cannot express this. When your daughter asks "why could he see that?", you can answer precisely.

### Weaknesses and trade-offs

**W12 · Metadata is data — and the design admits it only once.** The system's own wall-chart lists mistake #10 as *"confusing 'encrypted' with 'private'; coarse location over time is a home address."* But `coarse_h3_r7` (≈1 km cells) is Class B, server-readable, and stored on **every** location point and incident. A 90-day series of 1 km cells at 5-minute resolution is a high-fidelity behavioural profile even without precise coordinates. It is far better than plaintext GPS, but the document under-states the residual. **Optimisation:** store `coarse_h3_r7` **only on incidents** (where it enables neighbour matching) and drop it from routine `location_point` rows entirely — the routine rows are already E2EE and the coarse cell adds nothing operationally there.

**W13 · Class A′ (F-10) is a real, documented privacy reduction on the degraded path.** See W9.

**W14 · Neighbour scope is a hard cryptographic boundary, which is correct but under-specified in the PRD (F-20).** Serving neighbours entirely from Class B/C — no Class-A payload over any transport — makes `can_view_reduced` a cryptographic property rather than an application `if`, which is what §10.6 says it wants. But it also means a neighbour 400 m away receives a coarse cell and a name, not a precise location. That is a deliberate trade of responder efficacy for privacy, and the family should be told which side of it they are on.

**W15 · The consent architecture protects against the *system*, not against the operator.** The developer is a family member with root on the VM, the Cloudflare account, the DNS, and the Device Owner policy. Every control described here is a control the operator can bypass. The PRD is honest about the ethical requirement but cannot engineer around it. **The only real mitigations are social**: the signed family agreement, the "this device is managed" screen, the break-glass second person, and the fact that the family knows the difference even if the code does not.

### Optimisations

| # | Opportunity | Gain |
|---|---|---|
| O-9 | Drop `coarse_h3_r7` from routine `location_point` rows | Removes the largest residual metadata profile at zero functional cost |
| O-10 | Weekly "here is what was seen about you" digest per member | Turns the access log from an audit artefact into a trust-building product feature |
| O-11 | Make the consent ledger the app's *home tab* for adults | Engagement (P-062) and transparency in one surface |
| O-12 | Publish a transparency note in the family agreement: what the operator *can* technically do | Converts W15 from an unstated risk into an acknowledged one |

---

## 4.5 Scalability

### Strengths

**Sc1 · The design correctly refuses to scale.** *"You will have 6–30 devices. You do not have a scaling problem. You have an evolution problem."* A single 4 vCPU Go server handles ~50,000 concurrent WebSockets — three to four orders of magnitude above the load. Every hour spent on Kubernetes is an hour not spent on the OEM battery-killer problem that will actually break the system. This is the most commonly violated piece of engineering judgement in hobby-scale infrastructure, and the document gets it right and *explains why*.

**Sc2 · Cheap optionality, taken deliberately.** `family_id` on every table + RLS · stateless services · NATS subjects namespaced `fam.{id}.*` · TimescaleDB hypertable for the only unbounded table · enforced module boundaries · `v1` from day one. Each costs approximately nothing now and buys sharding, federation, per-family key isolation, consumer partitioning, and module extraction later — **without a migration**.

**Sc3 · Naming the real scaling problem.** *"The scaling problem you WILL have is schema evolution over ten years while an old app version is still on a phone your mother refuses to update."* Additive-only migrations, never reusing a protobuf field number, 24-month backward compatibility, and contract tests replaying recorded requests from 12- and 24-month-old builds. This is the correct thing to invest in.

### Weaknesses

**W16 · Single-node NATS and single-node Valkey are unreplicated.** Acceptable at this scale, and `sos-ingest`'s WAL covers the durability gap. Worth noting that a NATS data-directory corruption loses in-flight non-incident events with no replica to recover from.

**W17 · The DR site is *deliberately* not a full replica.** DR runs `sos-ingest` + SMS fan-out only. During a region failure there is no history, no realtime, and no control plane. This is the right trade (it preserves the safety path at 1/6th the cost) but the RTO table should be read as *"the safety path has a 15-minute RTO; the product has a 30-minute RTO and a degraded feature set."*

**W18 · TimescaleDB is a meaningful dependency for a "boring technology" design.** It is the only exotic extension in the stack. Justified by `location_point` being the sole unbounded table, and mitigated by it being available on managed DigitalOcean Postgres — but it is worth noting that plain declarative partitioning plus a cron job would achieve ~80% of the benefit with zero extension risk.

### Optimisations

| # | Opportunity | Gain |
|---|---|---|
| O-13 | Add a second `control-plane` instance behind the nginx switch (already stateless) | Blue-green becomes true zero-downtime and doubles as capacity headroom; ~0 extra cost on the existing VM |
| O-14 | Ship the archlint CI check in week 3, not "later" | Module boundaries are free to enforce on day one and politically impossible to add at month twelve |

---

## 4.6 Performance & battery

### Strengths

**Pf1 · Battery is treated as a safety metric, not a nice-to-have.** *"Above ~5%/day users notice and disable. A disabled safety app is worse than none, because everyone believes they are protected."* NFR-005 (<4%/24 h) with a fleet battery regression test each release makes it an SLO with teeth.

**Pf2 · Hardware FIFO sensor batching is the single highest-leverage line of code in the client.** `maxReportLatencyUs = 30_000_000` lets the sensor hub buffer samples without waking the application processor, moving accelerometer cost from ~200 mAh/day to ~18. One line, an 11× improvement.

**Pf3 · Refusing to hold a persistent WebSocket when idle.** FCM/APNs already maintain a system-level persistent connection you are paying for regardless. Piggybacking on it can halve idle drain. Most "realtime" apps get this backwards.

**Pf4 · Hardware-offloaded BLE `ScanFilter`.** The app is never woken for non-matching advertisements — the difference between a 22 mAh/day scan and a 200 mAh/day one.

**Pf5 · The t2 ≤ 500 ms budget with last-known-location.** Never waiting for a fresh GNSS fix (5–30 s cold) on the trigger path, and streaming the accurate fix afterwards as a separate event, is the correct decomposition. The measured path in §2.3 comes in at ~150 ms.

### Weaknesses

**W19 · The 153 mAh/day idle budget is optimistic.** It accounts for sensors, BLE, location, heartbeat, inference, wake locks, and the ring buffer — but not Flutter process residency, crypto, MLS state, or OS overhead. Treat 153 as a **floor**, not an estimate, and gate on the measured NFR-005 fleet test rather than the table.

**W20 · The active-incident cost of ~900 mAh/h (≈20%/h) is high but correctly accepted** as time-bounded. The risk is a *stuck* incident: an incident that never resolves drains the battery of the person who most needs it. **This is another argument for the `DORMANT` auto-quiesce transition (F-02)** — it is a battery control as well as an operational one.

**W21 · The 5 s p95 notification budget is ~98% outside your control.** Server-side work is ~100 ms; the rest is FCM/APNs wire time. The architecture cannot improve it — which is precisely why the SMS tier and the whole-chain canary exist. The correct read: **optimise t4 (human acknowledgment), not t3.** The document says this itself as wall-chart mistake #7.

**W22 · Node phones plugged in 24/7 are a physical safety hazard, not a performance issue.** Battery swelling in an unattended phone taped behind a bookshelf is a genuine fire risk. The mitigation set (smart-plug charge cycling 40–80%, thermal throttling at 42 °C, self-disable at `BATTERY_HEALTH_OVERHEAT`, case removed, **quarterly physical inspection on the drill checklist**) is appropriate and should be treated as a safety requirement, exactly as P-032 says.

### Optimisations

| # | Opportunity | Gain |
|---|---|---|
| O-15 | Instrument per-subsystem battery attribution on-device (a diagnostics screen showing mAh by component) | Turns battery regressions from "the app feels heavy" into a specific line item |
| O-16 | Coalesce **every** timer into one 15-minute-aligned WorkManager job (already specified — verify it in the fleet test) | The wake-lock/scheduling line is 25 mAh/day, the third-largest item |
| O-17 | Add an automated overnight fleet battery harness in week 12, not week 30 | Battery regressions found in week 30 are six months of commits to bisect |

---

## 4.7 Reliability & operations

### Strengths

**R1 · The four-layer defence against silent agent death.** Device Owner (eliminates it) → exact-alarm self-watchdog (detects and restarts) → **server-side heartbeat gap detection that alerts the family** → guided per-OEM onboarding with programmatic verification → quarterly drills that catch post-OS-update regressions. Layer 3 is the highest-value single feature in the entire reliability story: it converts silent failure into visible failure. Dashboard 1's yellow line — *"Ma's phone: last heartbeat 19 h ago — LIKELY OEM KILL"* — is, as the PRD says, worth more than every other metric combined.

**R2 · The end-to-end canary as the *only* page-worthy alert.** CPU graphs, error rates, and uptime checks all look green while your FCM service-account key silently expires, your DLT template is deregistered, or an APNs certificate lapses. A real synthetic SOS through the real handler every 15 minutes catches every one of those within 15 minutes. Having exactly **one** page-worthy alert is also correct alert hygiene — everything else is a ticket.

**R3 · Durable timers in Postgres with `FOR UPDATE SKIP LOCKED`.** Boring, debuggable, survives restarts and deploys, safe concurrency with zero external coordination, and — the decisive property — **you can inspect pending escalations with a `SELECT` at 3 a.m.**, which you will need to do.

**R4 · Deploy freeze during active incidents (P-070).** Very few teams at any scale gate deploys on live user state.

**R5 · Drills as a product feature, with automated scorecards and a family leaderboard.** *"Untested is broken."* Keeping drills to four minutes, not announcing the exact time (you are testing DND, not people's willingness to sit by their phone), and automating all measurement is the correct answer to drill fatigue (P-063).

**R6 · Chaos tests named, numbered, and expected-outcome-specified.** T-201…T-218 is a real chaos suite, not an aspiration.

### Weaknesses

**W23 · The canary/drill interaction with the deploy freeze was a self-inflicted operational deadlock (F-02, F-03).** As written, a real incident every 15 minutes would (a) randomly block deploys with no diagnostic and (b) ring every family phone 96 times a day, destroying the system in week one via the exact alert fatigue it exists to prevent. Both are one-line scoping fixes, and both are the kind of interaction bug that only appears when two well-designed features meet.

**W24 · A single operator is the largest reliability risk in the system, and it is unmitigable by technology.** The PRD handles it as well as it can be handled: a printed runbook in a fireproof safe *and* the vault, a break-glass second person with credentials, boring technology, automated dependency updates, and an **annually-drilled handover** where someone else executes Part 19 while the author watches silently. RISK-006's real mitigation is the scope instruction: *choose a scope maintainable in 2 hours/month, not 20.*

**W25 · The runbook is only as good as its last drill.** Annual runbook execution by a second person is the right cadence, but the runbook references live IPs, dashboards, and console accounts that drift continuously. **Optimisation:** make the runbook a tested artefact — a CI job that at minimum verifies every URL and command in it still resolves.

**W26 · `sos-ingest` deployed "twice a year" means its deploy path is exercised twice a year.** Rarely-used deploy paths break silently. **Optimisation:** deploy `sos-ingest` to **staging** weekly with the full rollback drill, even when the binary is unchanged, so the pipeline stays warm.

### Optimisations

| # | Opportunity | Gain |
|---|---|---|
| O-18 | Make the runbook CI-verified (every URL and command resolves) | Prevents 3 a.m. discovery that the runbook is stale |
| O-19 | Weekly staging deploy + rollback of `sos-ingest` even when unchanged | Keeps the rarely-used critical pipeline exercised |
| O-20 | Surface Home Assistant Pi liveness on Dashboard 1 | A dead Pi is the exact silent failure the design philosophy targets |
| O-21 | Alert on `access_log.surfaced_to_subject` backlog | If the surfacing job stalls, the entire consent guarantee is silently void |

---

## 4.8 Maintainability

### Strengths

**M1 · "Boring technology, ruthlessly" (P6), applied consistently.** Go, Postgres, NATS, Docker Compose. One language, one toolchain, one static binary, one backup procedure, one restore drill, one set of operational knowledge. Postgres full-text search removes any need for Elasticsearch. Every exotic dependency is a future 3 a.m. outage during a real emergency.

**M2 · ADRs with rejected alternatives.** Twenty decisions, each with what was rejected and why. This is what lets a future maintainer — including future-you — understand *why* rather than merely *what*, and it is what stops a well-meaning reviewer "fixing" the fail-open behaviour.

**M3 · The traceability matrix.** Requirement → component → test case → status. *"It is how a reviewer verifies that nothing was quietly dropped."* Maintaining it is item 8 of the Definition of Done, which is the only way such matrices survive.

**M4 · Enforced module boundaries via a CI import-graph check.** Free on day one, impossible at month twelve, and it is what allows extracting a module into its own binary in 2029 without a rewrite.

### Weaknesses

**W27 · The scope-to-capacity ratio is the project's dominant risk.** One part-time developer, 48 functional requirements, 70 catalogued problems, an Android app, an iOS app, a Flutter app, three backend binaries, ESP32 firmware, a Home Assistant bridge, and a Terraform estate. RISK-004 (scope creep, never ships) is plotted at 0.85 likelihood — the highest on the register — and that placement is correct. **The mitigation is entirely in the ordering**, which is why the Phase 1 gate and the "then stop and use it for a month" instruction are the most operationally important sentences in the document.

**W28 · Three implementations of the state machine is a maintenance surface even with codegen.** Kotlin, Swift, and Go from one YAML removes *divergence*, but the generator itself, the fixture harness, and three sets of platform-specific side effects still need maintaining. It is the right design; it is not free.

**W29 · Phases 4–5 have no gate.** Phases 1 and 3 have hard gates. Phases 4–5 are a 35-week list with no exit criteria and no stopping rule. **Optimisation:** treat them explicitly as a *backlog*, not a plan, with a standing rule that nothing is started unless the Phase 1 SLOs are currently green.

**W30 · Documentation drift.** A 3,371-line PRD, 21 ADRs, a runbook, a traceability matrix, a family agreement, and a state-machine spec. The document's own closing line — *"a blueprint that stops being edited stops being true"* — identifies the risk. **Optimisation:** the traceability matrix and the ADR index should be CI-generated from code annotations wherever possible, so drift becomes a build failure rather than a discovery.

---

## 4.9 Cost

### Strengths

**C1 · ≈₹8,100/month (revised) for a family of 6–8 — about ₹1,000–1,350 per person per month — against ₹800–2,000 per person for a commercial medical-alert service in India, with a strictly larger feature set and no data-sharing.**

**C2 · The cost-trap table is genuinely instructive.** S3 egress → R2 zero egress (₹8/GB → 0) · over-provisioned managed services (₹25,000 → one managed PG) · hosted metrics SaaS (₹3,000 → self-hosted Prometheus) · Lambda per heartbeat (₹4,000 → one VM) · managed Kubernetes (₹6,000 + your time → Compose) · cloud LLM per summary (₹1,500 **+ a privacy violation** → on-device).

**C3 · The correct framing: "your time is the dominant cost."** *"₹7,675/month is noise. The genuinely expensive decisions are the ones that consume months: building your own IoT stack, your own SFU, running Kubernetes, or writing bespoke cryptography. Optimise for your hours until the rupees exceed ₹25,000/month."*

### Weaknesses

**W31 · The model omits ~₹425/month and ~₹6,000 capex.** Backblaze B2 (~₹200), IMD/weather feed, LiveKit above free tier during long incidents, Postgres storage growth, Google Play one-time $25, and the Raspberry Pi + UPS (~₹6,000 capex). Revised total ≈₹8,100 — still comfortably under the C6 ceiling of ₹10,000.

**W32 · SMS costs are modelled at ~200 messages/month.** A single bad month — one real multi-tier incident plus a false-positive cluster plus the weekly full-fidelity canary — can multiply that. Not financially material (₹0.20/message), but the `notify_budget` ceiling from F-04 exists to make a *runaway* visible rather than to save money.

**W33 · The DR site costs ₹700/month to provide a capability used approximately never.** This is correct insurance, not waste — but it is worth noting that its value depends entirely on the failover being *drilled*. An untested failover is a ₹700/month line item that does nothing.

---

## 4.10 Legal & compliance

### Strengths

**L1 · Accurate, current DPDP analysis with the right trigger identified.** Purely domestic processing is outside the Act's scope — **until a non-family member is onboarded** (driver, house-help, tutor, neighbour volunteer), at which point you become a Data Fiduciary with full obligations. *"Build the machinery now: it is cheap now and brutal to retrofit."* The mapping of each DPDP requirement to an existing implementation (notice screens, `consent_grant` with mandatory expiry, purpose in every authz decision, Class A/B/C minimisation, 400-day log retention per Rule 6, erasure endpoint) is genuinely done, not gestured at.

**L2 · The refusal to auto-dial 112, with three independent justifications.** Legal (false auto-dials consume finite public emergency capacity — in aggregate a buggy app harms *other people's* emergencies), technical (you cannot reliably place an emergency call programmatically, and wrapping one risks breaking AML), and practical (a silent call with no speaker is often deprioritised; a family member who can *describe* the situation produces a dramatically better dispatch outcome).

**L3 · Correct handling of the recording-law boundary.** The black-box audio buffer is **self-recording by the subject** — a materially different legal position from recording a conversation you are not party to. The document is explicit: *keep it that way.*

**L4 · The IT Act s.66E constraint encoded as a setup checklist item** — the CCTV node must never point at bedrooms or bathrooms. Encoding a legal constraint as a checklist step rather than a policy document is the right instinct.

**L5 · Liability management.** Never promise dispatch · a prominent "not a substitute for 112" · the 112 button always one tap away · no AI-generated medical advice, ever · a signed family agreement documenting the limitations.

### Weaknesses

**W34 · Append-only + "retention: forever" was legally incoherent with DPDP erasure (F-15).** You cannot delete a staff member's data from a table guarded by a `RAISE EXCEPTION` trigger. **Resolved via crypto-shredding** — destroy the key, leave the ciphertext as an unreadable tombstone. This is a defensible and increasingly standard position, but it **must be written into the family agreement and the DPDP mapping** as the stated erasure mechanism, not left as an implementation detail.

**W35 · Device Owner on an adult's phone is legally sensitive in a way the document treats only ethically.** App suspension and kiosk powers over another adult's device could, in an adversarial family situation, be characterised as coercive control. The reduced-adult-policy-set mitigation is correct; it deserves to be a **hard technical constraint** (adults are structurally ineligible for `setPackagesSuspended`) rather than a configuration default.

**W36 · DLT template churn is an ongoing compliance tax.** Every message-text change requires re-registration **before** shipping, taking 1–2 weeks. This makes SMS copy effectively frozen after Phase 1 and should be planned for: get the templates right the first time, with generous variable placeholders.

**W37 · Legal exposure if the system fails during a real emergency is acknowledged but cannot be engineered away.** The mitigations (never promise dispatch, prominent disclaimers, the signed agreement) are the right ones. It remains a residual risk that the operator accepts by building this at all — which the PRD, to its credit, says out loud.

---

## 4.11 Human factors — the strongest dimension

### Strengths

**H1 · False positives are correctly identified as *the* dominant failure mode.** *"A detector at 95% recall and 60% precision is strictly worse than one at 85% recall and 98% precision, because the second one is still trusted after six months."* Gating Phase 3 on <1 FP/user/month — with the instruction to **disable trigger types** until the gate passes — is the most disciplined decision in the build plan. Most teams would ship the detector and tune later; that path ends with a family that ignores alerts.

**H2 · The PROBE state.** Before escalating on an uncertain signal, do the cheapest possible thing: a silent haptic buzz and one question. Converts the majority of would-be false positives into non-events at the cost of one vibration. Target: ≥70% of auto-escalations resolved at PROBE without waking the family.

**H3 · The bystander effect designed against explicitly.** *"⚠️ NOBODY HAS RESPONDED YET"* in bold on every recipient's screen — copy chosen deliberately to create individual responsibility rather than diffuse it. Then CLAIM → ownership broadcast → others switch to *"Rohan is responding. Stand by."*

**H4 · Two corrections that most implementations miss.** (a) **Do not fully silence** the other responders — replace the siren with a persistent, non-dismissable quiet banner, because full silence causes the other five to forget an emergency is in progress. (b) You need an **un-claim path and a progress watchdog**, or one person claims, gets stuck in traffic, and everyone else has stood down permanently.

**H5 · The panic UI constraints are written for the actual user.** Someone with adrenaline-narrowed vision and shaking hands, possibly in the rain, in the dark, one-handed. ≥88 dp targets (2× the WCAG minimum), bottom third only, ≥7:1 contrast, ≤4 words per element in present tense (*"Getting help."*), no animation except the cancel countdown, an **accelerating** haptic that communicates urgency without vision, and — the best constraint in the document — **there is no error screen**. Never a red ✗.

**H6 · Non-emergency value as a reliability requirement (P-062).** *"An app that is only opened during emergencies will be uninstalled before the first emergency."* Family location glance, "reached safely" pings, shared checklists, document vault, screen-time dashboard, elderly check-in. Engagement (>80% weekly voluntary opens) is a **success metric**, not a growth metric.

**H7 · Accessibility as a survival requirement.** Every state change gets a distinct haptic **and** a distinct non-musical audio cue **and** a high-contrast visual. Full TalkBack/VoiceOver completion of the panic flow. *"Your parents will need this eventually."*

**H8 · The adult-override rule on screen time.** *"An adult must be able to override their own limits — otherwise this is not a wellbeing feature, it is control."* Limits are negotiated and visible, with a 5-minute warning before a block and a request-extension path that notifies rather than begs.

### Weaknesses

**W38 · The system's value depends on humans running drills for a decade.** Quarterly drills, annual key-recovery drills, annual runbook handovers, quarterly restore drills, monthly FP-ledger reviews, quarterly node-phone physical inspections. The mitigations (4 minutes, gamified, automated measurement, calendared) are the right ones, but this is a sustained behavioural commitment from a whole family, not just the developer. Realistically, expect drill compliance to decay after year two.

**W39 · An 8-character ASCII name in an SMS read at 2 a.m. is a small but real usability risk** (F-18), now constrained to be unique per family with an explicit disambiguation step at onboarding.

**W40 · The iOS experience will generate ongoing family friction.** An iPhone as a *subject* device has no Direct Boot, no force-quit survival, no programmatic SMS, no gesture trigger — meaning **no functioning L2 tier at all**. The mitigations (Android as primary, BLE fob for iPhone holders, written expectation-setting) are correct, but "your phone is a second-class citizen in the family safety system" is a conversation that will recur.

---

## 4.12 The ten things most likely to kill this project, ranked

| # | Failure mode | Likelihood | Primary defence |
|---|---|---|---|
| 1 | **Never reaching the Phase 1 gate** — scope creep, MLS on the critical path, building AI before SMS works | **Very high** | Phased crypto (F-08) · the Phase 1 gate · *"then stop and use it for a month"* |
| 2 | **Alert fatigue from false positives** | High | PROBE state · FP ledger as a P0 metric · the Phase 3 gate with authority to disable trigger types |
| 3 | **OEM battery managers killing the agent** | High | Device Owner · exact-alarm watchdog · **server-side gap alerting to the family** · quarterly drills |
| 4 | **The family perceives surveillance and disengages** | High | Consent ledger · expiring grants · autonomy ramp · admin ≠ observation · **the week-1 family conversation** |
| 5 | **Developer burnout** | High | Boring tech · scope maintainable in 2 h/month · the Phases 4–5 backlog rule (W29) |
| 6 | **Drill decay after year two** | Medium-high | Gamified 4-minute drills · fully automated measurement · calendared |
| 7 | **Battery drain → uninstall** | Medium | Power budget as an SLO · FIFO batching · no idle socket · fleet regression per release |
| 8 | **Silent notification-channel expiry** (FCM key, APNs cert, DLT template) | Medium | The 15-minute canary · the weekly full-fidelity canary · the rotation calendar |
| 9 | **Key loss → permanent data loss** | Low, catastrophic | Shamir 2-of-3 · paper share in a fireproof safe · a fourth share in another city · **annual recovery drill** |
| 10 | **The developer becomes unavailable** | Low, catastrophic | Printed runbook · break-glass second person · annually-drilled handover |

Note that **seven of the ten are human or operational, not technical.** That distribution is the clearest signal that the technical architecture is sound and that the remaining risk lives elsewhere — which is exactly what the PRD itself concludes.

---

## 4.13 Closing assessment

The Kavach blueprint is a genuinely strong piece of systems design whose greatest strengths are its *judgement calls*, not its technology choices: fail open on the safety path, AI advises and never decides, the panic path has no branches, consent is an expiring graph, absence of signal is signal, and the watched person always wins in the long run.

The defects found are real and several are serious — the proto3 duress size-channel (F-01), the unbounded fail-open flood vector (F-04), the missing MLS Delivery Service (F-07), the SMS/HTTP duplicate-incident bug (F-09), and the canary/deploy-freeze deadlock (F-02) would each have produced a production incident. But **all of them are local fixes to a correct architecture**, not symptoms of a wrong one. That is the difference between a design that needs hardening and a design that needs replacing.

The one change that matters most is not on that list. It is moving MLS off the critical path so that Phase 1 — the twelve weeks that carry 90% of the life-saving value — actually ships. Everything else in this analysis is refinement.

> **The blueprint's own closing line is the correct measure of success, and it should be the line the project is judged against:**
> *A family safety platform is not a feature set. It is a chain, and its value equals the reliability of its weakest link at the exact moment it is needed — which will be the moment when the battery is dead, the network is gone, and nobody is looking at their phone.*
