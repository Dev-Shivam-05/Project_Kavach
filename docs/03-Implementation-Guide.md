# SECTION 3 — GRANULAR, STEP-BY-STEP IMPLEMENTATION GUIDE

> The PRD supplies a phase gantt and weekly acceptance criteria. This section supplies the **execution layer**: what to build in what order, which file to open first, what command proves each step, and where the schedule is wrong.
>
> **Revised critical path:** Phase 1 gate at **week 16**, unchanged from the PRD — but achieved by moving MLS off the critical path (F-08) and spending the recovered time on the OEM/reliability work that actually determines whether the system survives.

---

## 3.0 The ordering principle

The build order matters more than the code. Three rules govern every sequencing decision below:

1. **Build the chain before the links are pretty.** Trigger → transmit → notify → acknowledge, end to end, on real devices, before anything is refactored.
2. **Build the thing that tells you it is broken, second.** The canary comes before the second feature — it will catch more real failures than every other observability investment combined.
3. **Anything that can be deferred without weakening the survival path, is deferred.** MLS, AI, IoT, wearables, CCTV, floor plans, screen time. All of it.

---

## 3.1 Day 0 — before any code

These block later work and have external lead times. Start all of them on day one, in parallel.

| # | Action | Lead time | Blocks |
|---|---|---|---|
| 1 | **The family conversation.** Explain what will be built, what Device Owner means (every restriction, listed), what each person can see about each other, and let each person choose their participation level. | 1 day | *Everything.* This is not a formality; it is RISK-003's only real mitigation. |
| 2 | **Submit DLT registration** — sender header + every SMS template, transactional route (promotional is blocked by DND) | **1–2 weeks** | Phase 1 W11 server→family SMS fan-out |
| 3 | Apple Developer enrolment + apply for the **Critical Alerts entitlement** (expect denial; PushKit is plan B) | 1–2 weeks | Phase 1 W10 |
| 4 | Register the domain; configure Cloudflare; create DigitalOcean + Hetzner + Backblaze accounts with billing alerts | 1 day | W3 |
| 5 | Record **every family device IMEI** in a temporary secure note (moves to the vault later) | 1 hour | P-029 recovery, forever |
| 6 | Designate **one phone that stays unprovisioned** as the control device | — | §19.7 escape hatch |
| 7 | Identify **two spare phones**: canary sender + canary receiver | — | W12 |
| 8 | Order 2× ESP32-C3 / nRF52840 dev boards for the panic fob | 1–2 weeks shipping | Phase 4 (but order now — it is a weekend of work whenever you get to it) |

**Deliverable at end of day 0:** the signed one-page family agreement (§20.3) covering what is collected, who sees what and for how long, what device management means, how to opt out and what it costs, **the limits of the system** (*"this is not a substitute for calling 112; it may fail; it is a second layer, not the first"*), and what happens to the data if someone leaves or dies.

---

## 3.2 Repository bootstrap — the first ten files, in order

Create the tree from Appendix C, then write these in exactly this sequence. Each one unblocks the next.

```
kavach/
├── docs/{PRD.md, adr/, runbook.md, family-agreement.md}
├── proto/{incident.proto, sync.proto}
├── spec/state-machine.yaml          ★ single source of truth
├── backend/
│   ├── cmd/{sos-ingest,realtime-gw,control-plane}/
│   ├── internal/{identity,family,policy,escalation,notify,vault,journey,
│   │             automation,report,consent,device}/
│   ├── migrations/
│   └── tools/{archlint,smgen}/
├── mobile/
│   ├── lib/                                     Flutter T1+T2
│   ├── android/app/src/main/kotlin/…/t0/        ★ Tier 0. Native. Sacred.
│   ├── android/app/src/main/kotlin/…/dpc/
│   └── ios/Runner/T0/
├── firmware/{panic-fob,room-beacon}/
├── bridge/home-assistant/
├── infra/{terraform,compose,grafana}/
└── canary/                          ★ the most important 300 lines you will write
```

| # | File | Why first |
|---|---|---|
| 1 | `docs/adr/ADR-001…021.md` | One file each. **ADR-021 is new** (phased crypto, §2.4.1). Writing them first forces the decisions to be conscious. |
| 2 | `spec/state-machine.yaml` | Generates three implementations. Everything downstream reads it. |
| 3 | `backend/tools/smgen/` | The generator: YAML → Kotlin + Swift + Go + a shared fixture set. ~250 LOC. |
| 4 | `proto/incident.proto` | The critical-path contract. Note `optional bool duress` (F-01). |
| 5 | `backend/migrations/0001_init.sql` | The schema from §2.8, including the ✚ NEW tables. |
| 6 | `backend/tools/archlint/` | Module-boundary CI check. Cheap now, impossible to retrofit. |
| 7 | `backend/internal/log/pii.go` | The `slog.Handler` with a compile-time PII deny-list that **panics in dev** (I-6). Write it before the first log line exists. |
| 8 | `backend/cmd/sos-ingest/main.go` | The sacred binary. |
| 9 | `canary/main.go` | Before the second feature. |
| 10 | `mobile/android/…/t0/KavachForegroundService.kt` | The T0 host. |

**CI gates to configure on day one** (they cost nothing now and are political battles later):
```yaml
- go vet ./... && staticcheck ./...
- go run ./tools/archlint          # module boundaries (I-12)
- go test ./... -race
- sql-lint: no new Class-A column reaches the server (I-3, A′ allowlist)
- proto-lint: additive only; no field-number reuse (I-13)
- loc-budget: cmd/sos-ingest ≤ 1000 LOC, ≤ 5 direct deps (§2.5.1)
- ascii-lint: SMS payload encoder output is 32..126 only (I-2)
- string-lint: en/hi/gu coverage for every user-facing key (NFR-020)
```

---

## 3.3 Phase 0 — Foundation (weeks 1–4)

### W1 — Consent, DLT, and the paper trail
| Task | Exit criterion |
|---|---|
| Family conversation, per person | Every adult has said yes **in writing**, and knows what they said yes to |
| Family agreement drafted and signed | Signed copy in the safe; a digital copy in `docs/` |
| DLT registration submitted | Application reference recorded in the runbook |
| Repo created with the Appendix C tree; CI skeleton green | `git push` runs the gate list above |

### W2 — Threat model and data classification
| Task | Exit criterion |
|---|---|
| Threat-model workshop (§10.1, T1–T9) | Written; T8 re-rated per F-04 |
| **Classify every field you plan to store** as A / B / C / A′ | **No unclassified field exists.** This is what makes the schema lint possible. |
| Write ADR-001 … ADR-021 | 21 files in `docs/adr/` |
| `spec/state-machine.yaml` + `tools/smgen` | `go run ./tools/smgen` emits Kotlin, Swift, Go, and a JSON fixture set; all three pass the fixtures |

### W3 — Infrastructure as code
| Task | Exit criterion |
|---|---|
| Terraform: DO Bangalore VM, managed Postgres + replica, Hetzner DR, Cloudflare DNS/WAF, R2, Backblaze | **`terraform apply` from zero reproduces the whole environment** |
| SOPS + age secrets committed encrypted | `sops -d` works from a clean checkout with the key |
| `migrations/0001_init.sql` applied | Schema v1 live; RLS enabled; append-only trigger present |
| GitHub Actions: build, test, push image, deploy | Green on `main` |

### W4 — ★ Device Owner provisioning + identity
> **This week is the highest-leverage week in the entire project.**

```bash
# Per phone, ~15 minutes. WIPES THE DEVICE.
# 1. Factory reset.
# 2. Welcome screen: SKIP Wi-Fi, SKIP the Google account.   ★ critical ★
# 3. Settings → About phone → tap Build number ×7 → Developer options.
# 4. Enable USB debugging.
adb install -r kavach-release.apk
adb shell dpm set-device-owner in.example.kavach/.dpc.KavachDeviceAdminReceiver
#   Expect: Success: Device owner set to package in.example.kavach
adb shell dumpsys device_policy | grep -A3 "Device Owner"
# 5. Now finish setup: Wi-Fi, Google account if desired.
```

**Apply policies in two waves — this ordering prevents locking yourself out:**

| Wave | When | Policies |
|---|---|---|
| **Wave 1 — now** | W4 | `setPermissionPolicy(AUTO_GRANT)` + explicit grants · `setUninstallBlocked` · `DISALLOW_SAFE_BOOT` · `DISALLOW_ADD_USER` · FRP policy · `STAY_ON_WHILE_PLUGGED_IN` (node phones only) |
| **Wave 2 — after one month of fleet stability** | ~W20 | `DISALLOW_FACTORY_RESET` · **`DISALLOW_DEBUGGING_FEATURES`** ← last, and only last |

`DISALLOW_DEBUGGING_FEATURES` removes your ADB escape hatch. Applied early plus a DPC bug equals an unmanageable phone whose only recovery is a recovery-mode factory reset that then hits your own FRP policy. **Always ship the `clearDeviceOwnerApp()` escape hatch behind a guardian-authenticated action first**, and keep the unprovisioned control phone.

**Ethical requirement, not optional:** ship the "This device is managed" screen listing every active restriction, always accessible, before Wave 1. Android already shows a system-level managed-device notice — do not attempt to hide it. Offer adults a **reduced policy set** (reliability restrictions only: permission auto-grant, uninstall block; **no** app suspension, **no** kiosk).

| Task | Exit criterion |
|---|---|
| Provision the fleet | Every family Android phone reports `is_device_owner = true` |
| Passkeys + device enrolment + hardware key generation | Two keys per device in StrongBox: identity (biometric) and **emergency (non-biometric)** |
| **GroupBox** crypto (ADR-021, §2.4.1) — *not* MLS | A message sealed on phone A opens on phone B and is **unreadable on the server** |
| Verify Direct Boot key access | `t0_signing_available_predawn` recorded in diagnostics (F-17) |

> **▲ SCHEDULE CHANGE:** the PRD allocates 21 days here to "Auth + device enrolment + **MLS** bootstrap". MLS realistically needs 8–14 weeks including the Delivery Service (F-07). Ship GroupBox in ~3 days, keep the same end-to-end guarantee against the server, and schedule MLS as a Phase 2 workstream. This is the single biggest schedule correction in this plan.

---

## 3.4 Phase 1 — Minimum Viable Safety (weeks 5–16) ★ THE GATE ★

> **Phase 1 IS the project.** If you build only this, your family is meaningfully safer than today. If you build Phases 3–5 while Phase 1 is shaky, you have a demo.

### W5 — `sos-ingest`
```
□ Protobuf contract with `optional bool duress` (F-01)
□ Fixed-size envelope padding, with the assertion that fails closed
□ WAL with fsync-before-ack
□ NATS publish; at-least-once
□ Ed25519 verification against an in-memory cache; fail open (ADR-018)
□ Family-scoped flood guard with coalescing (F-04)
□ Local cache persistence: keycache.pb loaded at boot (F-22)
□ Dual endpoint: api.kavach.example (via CF) + ingest-direct (bypass) (F-05)
```
**Exit:** `curl` with a signed protobuf returns 200 in **< 50 ms p99**. `docker compose stop postgres` — ingest is completely unaffected. LOC budget check passes.

### W6 — Android T0 skeleton
```
□ KavachForegroundService in process :t0, type location|connectedDevice
□ directBootAware=true on the service AND the boot receiver
□ DeviceProtectedConfig: contacts, policy snapshot, key alias, peer fingerprints
□ BootReceiver on LOCKED_BOOT_COMPLETED + BOOT_COMPLETED
□ WatchdogAlarmReceiver: setExactAndAllowWhileIdle, 15 min, logs SERVICE_DEATH
   with gap duration
□ SelfDiagnostics: the 7 checks from P-031
```
**Exit (T-207 precursor):** reboot the phone, **do not unlock it**, and confirm via `adb logcat` that the service is running. Force-stop the app and confirm the watchdog restarts it.

### W7 — State machine and triggers
```
□ IncidentStateMachine.kt + .go GENERATED from spec/state-machine.yaml
□ PowerButtonWatcher (5× within 3 s, registered programmatically)
□ VolumePatternWatcher (vol-down held 3 s, screen off)
□ In-app 88 dp button, bottom third
□ PocketSuppressor (proximity < 3 cm ∧ lux < 10 ∧ moving > 60 s)  P-056
□ Cancel window with accelerating haptics; length from risk context
□ Duress PIN: constant-time compare over BOTH candidates, always both
```
**Exit:** the Kotlin and Go machines pass the **same** fixture set from the YAML. **T-213 automated:** 1,000 duress runs vs 1,000 cancel runs are statistically indistinguishable in packet size and timing (two-sample KS, p > 0.05).

### W8 — The L0 floor
```
□ LocalAlarmController: STREAM_ALARM at max, no audio focus request (P-065)
□ Torch strobe
□ MedicalCardActivity: showWhenLocked, blood group / allergies / meds / ICE,
   coordinates at ≥48 pt
□ CALL 112 handoff to the NATIVE dialer — never wrap, intercept, or auto-place
□ BlackBoxRingBuffer: pre-allocated at install, mmap, encrypted, seal on trigger
□ Pre-allocated 5 MB incident-log reserve (P-043)
```
**Exit (T-205):** airplane mode on, app force-stopped, fob press → 100 dB alarm, readable medical card, working CALL 112 button. Fill the device storage to 100% and confirm the incident write still succeeds.

### W9 — Escalation engine
```
□ escalation_timer table + N stateless workers, FOR UPDATE SKIP LOCKED,
   NO leader election (F-13)
□ LISTEN/NOTIFY + adaptive poll
□ Ladder L1 → L2 → L3 with per-scenario policies as DATA
□ CLAIM / RELEASE + ownership broadcast over BOTH WS and push
□ Progress watchdog: 5 min, no movement, no messages → re-broadcast
□ Auto-quiesce → DORMANT after 6 h (F-02)
□ /internal/active-incidents reads active_incident_v (drills excluded)
```
**Exit (T-201):** timer accuracy ±500 ms across a service restart. Kill `control-plane` mid-incident, restart it, escalation resumes correctly.

### W10 — Notification orchestrator
```
□ FCM data messages, high priority, DATA-ONLY payloads (Class B/C only, F-21)
□ Notification channel with setBypassDnd(true) + USAGE_ALARM attributes
□ Full-screen intent (declare USE_FULL_SCREEN_INTENT)
□ APNs alert + Critical Alert path (if the entitlement lands)
□ ★ PushKit VoIP → CallKit incoming-call UI ★  ← the load-bearing iOS technique
□ iOS Notification Service Extension that decrypts before display
□ Live Activity (iOS) / ongoing notification (Android)
□ Wear OS / watchOS haptic burst
```
**Exit:** an alert rings through Do Not Disturb on **every device in the §17.2 matrix**. Verify per-device — this is the most common reason a real alert is missed at night (P-055).

### W11 — SMS and voice tiers
```
□ Multi-SIM enumeration and ordered attempt list; send on ALL SIMs in a real
   incident
□ ASCII payload encoder + the lint test (I-2)
□ sentIntent / deliveredIntent PendingIntent result logging per SIM
□ Aggregator inbound webhook with sig8 HMAC verification (fail open)
□ inc8 → incident_id Valkey index + UUIDv5 synthesis + reconciliation (F-09)
□ Class A′ handling: fan out in memory, persist only coarse_h3_r7 (F-10)
□ notify_budget spend ceiling; breach = P0 (F-04)
□ TTS voice tier
```
**Exit (T-204):** with data disabled, an SOS delivers SMS to every family member within 60 s, on both SIMs, and creates a server-side incident. Fire the same incident over WS + HTTP + SMS + BLE simultaneously → **exactly one incident**, four `source_transport` values (T-210).

### W12 — Canary and observability
```
□ canary/main.go — real POST every 15 min, is_drill=true, drill_run scoped
   to the canary receiver ONLY (F-03)
□ Four-clock recording
□ Grafana Dashboard 1 (Safety Chain Health), 2 (Four Clocks), 3 (FP Ledger)
□ P0 → Telegram + SMS, repeat every 5 min until acknowledged
□ Alerting hosted OUTSIDE the monitored system
□ Backup: WAL → R2, daily pg_dump → Backblaze, monthly to physical drive
□ Restore drill into a scratch VM
```
**Exit:** the canary has run **72 hours with zero failures**. A restore into a scratch VM works and a 6-month-old incident renders (T-216).

### W13–16 — ★ SOAK. Write no new features.
Daily real use by the whole family. Two drills. Fix only what the soak reveals.

**Gate checklist — do not proceed past week 16 until every box is ticked:**
```
✅ NFR-001 … NFR-009 measured and met
✅ 2 drills passed
✅ Zero unexplained canary failures for 14 consecutive days
✅ Every family member has triggered AND cancelled a test SOS unaided
✅ T-204, T-205, T-207, T-210, T-213, T-216 pass on the full device matrix
✅ Every Android phone reports is_device_owner = true
✅ ASCII lint passes; DLT templates live; delivery tested to every number
✅ A message sealed on phone A opens on phone B, unreadable on the server
✅ Idle battery drain < 4% / 24 h on the aggressive-OEM device
```

> **Then stop and use it for a month.** This instruction is in the PRD's closing section and it is the single most important project-management directive in the document. RISK-004 (scope creep, never ships) is rated high-likelihood for a reason.

---

## 3.5 Phase 2 — Presence & Coordination (weeks 17–30 + 4 soak)

| Workstream | Key tasks | Acceptance |
|---|---|---|
| **Realtime gateway** | Connect tickets (F-16) · resumable cursor · Valkey presence, 45 s TTL · priority backpressure | 8 concurrent connections stable for 7 days. A slow consumer never delays a fast one. **No CRITICAL frame is ever dropped.** |
| **Family map · timeline · after-action** | Four-clock rendering · notification matrix · `policy_version`-correct replay | An after-action report for a **6-month-old** incident renders correctly under the policy in force at the time |
| **Journeys · check-ins · dead-man** | Learned-route ETA · corridor deviation · missed-arrival escalation (guardians only, never neighbours) | A simulated missed arrival escalates on schedule. A simulated 14 h no-unlock on the elder's phone escalates. |
| **Consent ledger UI** | Grant CRUD · access log surfaced to the subject · two-layer revocation with honest pending state (F-14) | Every read of another member's data appears in the subject's ledger **within 60 s**. Layer-1 revocation < 1 s; the UI does not claim completion before the key ratchet. |
| **Find-phone + anti-theft** | FCM data message → `STREAM_ALARM` + torch + vibrate, restore prior volume · **BLE `FIND_ME` GATT fallback when the target has no data** · Final Breath on `ACTION_SHUTDOWN` | Find-phone works over FCM **and** over BLE with the target offline (P-021). Final Breath fires within the 2–5 s window (P-022). |
| **▲ MLS migration** (moved here from Phase 0) | OpenMLS + Dart FFI · **Delivery Service with per-group total ordering (F-07)** · `mls_message` replay · key transparency verification · exporter-derived stream keys (F-19) | A device offline for 60 days rejoins and reads history. Two concurrent commits produce one epoch and one `KV-2003`, never a fork. |

**Note on the MLS migration:** run it behind the `sealed_payload` scheme byte. Devices negotiate the highest scheme both sides support. Old clients keep working (NFR-016). Do not big-bang it.

---

## 3.6 Phase 3 — Autonomous Detection (weeks 31–49 + 6 soak) ★ STRICT GATE ★

> An automatic detector that cries wolf makes your family **less** safe than no automatic detector. This gate is the most important one in the plan.

| Workstream | Tasks | Acceptance |
|---|---|---|
| **Sensor fusion** | 50 Hz accel/gyro with **hardware FIFO batching** (`maxReportLatencyUs = 30_000_000` — this one line moves accelerometer cost from ~200 mAh/day to ~18) · bandpass 0.5–15 Hz · features (SMV, jerk, entropy, spectral centroid, tilt) · int8 NPU inference · **hand-written ~80-line fusion scorer** | ≥90% recall on a labelled set collected by *deliberately* dropping and crash-simulating a test phone. **≥200 negative samples from normal daily activity.** |
| **Risk context engine** | Deterministic weights, on-device, emits one opaque 0–4 integer | Battery stays within NFR-005 at every risk level. Only the integer reaches the server — never its inputs. |
| **PROBE state** | Silent haptic + one question before escalating | **≥70%** of would-be auto-escalations resolve at PROBE without waking the family |
| **BLE mesh** | 31-byte advert that actually fits (F-11) · ±1 pseudonym window (F-12) · offloaded ScanFilter · silent peer relay | Subject's phone in airplane mode, family phone 40 m away → the incident reaches the server via relay **within 30 s** |
| **★ THE GATE ★** | — | **False-positive rate < 1 per user per month, sustained over the 6-week soak.** If it is not, raise thresholds or **disable trigger types** until it is. **You do not proceed.** |

### Data collection protocol for detection training (the part nobody plans)
```
Positives  — 3 sessions × 2 people, on a padded surface:
             free fall onto foam · slip-and-fall · syncope-style collapse ·
             two-wheeler drop at 15 / 30 / 45 km/h (bike stationary, phone
             thrown to simulate; then a controlled low-speed skid on gravel)
Negatives  — ≥200 samples, ≥14 days, from EVERY family member's normal life:
             phone dropped on a bed / sofa / table · sitting down heavily ·
             running · pillion on a bad road · pocket transitions · washing
             machine · handing the phone to a child
Labelling  — the app records raw windows with a one-tap "that was a fall /
             that was not" prompt. Store on-device; export by cable. Never
             upload raw motion (Class A).
```

---

## 3.7 Phases 4 & 5 — Ecosystem and Depth

Build in this order. Each item is independently valuable and independently shippable.

**Phase 4 — Ecosystem**
1. **Home Assistant bridge** (~400 LOC Go). Highest value per hour in this phase: smoke, gas, water, door, locks, and the smart-plug elder-activity proxy, all for the cost of a Pi.
2. **★ BLE panic fob — build this BEFORE wearables.** Cheaper, more reliable, helps the grandparents *and* the iPhone users, and takes a weekend. ~₹800 in parts, two-year battery. Protocol: BLE advert with a rotating pseudonym and an HMAC over `(device_id, monotonic_counter, button_state)`; the counter prevents replay.
3. Wearables (Wear OS / watchOS / Garmin)
4. Trusted-neighbour tier — **Class B/C only, no Class-A payload ever** (F-20), 6-hour activation window
5. Live audio via LiveKit with insertable-stream E2EE (the SFU sees ciphertext)
6. **Intercom node BEFORE the CCTV node** — it creates daily positive value for an elderly family member; the CCTV node creates a privacy liability that needs mature consent machinery first

**Phase 5 — Depth**
On-device incident summarisation → elder passive monitoring → document vault + Shamir quorum → screen time → CCTV node → 2D floor plan → disaster mode.

**Node-phase safety requirement (P-032, treat as safety, not convenience):** both node roles get smart-plug charge cycling (cut at 80%, restore at 40%), `BatteryManager` polling every 5 min, a warning above 42 °C, camera/mic self-disable on `BATTERY_HEALTH_OVERHEAT`, case removed for airflow, and **quarterly physical inspection for swelling** on the drill checklist. A swollen battery in a phone taped behind a bookshelf is a genuine fire risk.

---

## 3.8 Definition of Done — automate it

A feature is not done until all nine are true. No exceptions, including for "small" changes. Automate items 1, 6, 7, 8 in CI; items 2–5 are a physical-device checklist.

```
1 ✅ Unit tests pass, including ≥1 failure-path test
2 ✅ Tested on a physical Android device at ≤5% battery
3 ✅ Tested with airplane mode on
4 ✅ Tested with the app force-stopped, then triggered externally
5 ✅ Tested on ≥1 aggressive-OEM device (Xiaomi / Vivo / Oppo / Realme)
6 ✅ Emits ≥1 metric and ≥1 structured log line, NEITHER containing Class-A data
7 ✅ If it touches T0, the end-to-end canary still passes
8 ✅ Its traceability-matrix entry is updated
9 ✅ Any new permission is documented in Appendix A with a user-facing
     justification string
```

**Per-release checklist (Appendix E.1), as a CI job + a manual gate:**
```
□ Full device test matrix passed (§17.2)
□ Chaos tests T-201 … T-218 passed
□ Canary green for 72 h on staging
□ Battery regression: idle drain still < 4% / 24 h
□ ASCII SMS payload lint passed
□ Old-client contract tests (12 and 24 months) passed
□ No new Class-A field reaching the server (schema lint)
□ Traceability matrix updated
□ Runbook updated if any operational procedure changed
```

---

## 3.9 The device test matrix — buy these before week 6

| Class | Example | Why |
|---|---|---|
| Aggressive-OEM mid-range | Redmi Note (MIUI/HyperOS) | The most likely real-world configuration in India |
| Old, low-RAM | 4-year-old, 3 GB RAM, Android 10 | Grandparent's phone |
| Modern stock | Pixel | Baseline correctness |
| iOS | Any supported iPhone | Verifies the reduced-capability path |
| Device Owner provisioned | One of the above | Verifies §5 policies actually apply |
| Node phone | Spare, plugged in | Verifies thermal and battery-health handling |

Every release MUST pass on all six.

---

## 3.10 Chaos tests — run them deliberately, on a calendar

| ID | Test | Expected |
|---|---|---|
| T-201 | Kill `control-plane` mid-incident | Incident continues; `sos-ingest` unaffected; escalation resumes on restart |
| T-202 | Kill Postgres | `sos-ingest` still returns 200; incidents queue in NATS; reconcile on recovery |
| T-203 | Kill NATS | `sos-ingest` writes WAL, returns 200; replays on recovery |
| T-204 | Airplane mode on the subject device | SMS + BLE fire; local alarm sounds; UI shows "Sent by SMS" |
| T-205 | Airplane mode on **all** devices | L0 total isolation: alarm, medical card, coordinates, CALL 112 |
| T-206 | Force-stop, then fire the BLE fob | DO devices: agent restarts. Non-provisioned: documented failure + server gap alert. |
| T-207 | Reboot, **do not unlock**, simulate a fall | Agent alive via Direct Boot; alarm sounds; SMS sends |
| T-208 | Set the device clock 3 h forward | HLC ordering still correct; timeline renders sensibly |
| T-209 | Captive-portal Wi-Fi | Detected as unvalidated; immediate drop to SMS tier |
| T-210 | Same incident over WS + HTTP + SMS + BLE | Exactly one incident; four `source_transport` values |
| T-211 | Two members trigger within 2 s | Two independent incidents, independent timers, **distinct notification sounds** |
| T-212 | Claim, then responder silent 6 min | Progress watchdog re-broadcasts |
| T-213 | Duress PIN vs normal cancel: packet size + timing | **Statistically indistinguishable.** Automated. |
| T-214 | Fill device storage to 100% | Pre-allocated reserve still accepts the incident write |
| T-215 | Revoke background location, wait 7 days | Self-diagnostic detects it; family alert at 48 h |
| T-216 | Restore into a scratch VM | Full restore; a 6-month-old incident renders; projections recompute from the log |
| T-217 | Rotate the TLS certificate | Backup pin holds; no client is bricked |
| T-218 | Simulate `NotRegistered` from FCM | Device marked degraded; family alerted |
| **✚ T-219** | Two MLS commits concurrently (Phase 2) | One epoch advance, one `KV-2003`. **Never a fork.** (F-07) |
| **✚ T-220** | SMS-only incident, then the device reconnects and posts the real one | Exactly one incident after reconciliation; `merged_into_id` set (F-09) |
| **✚ T-221** | Cloudflare unreachable (block it in `/etc/hosts`) | The direct-endpoint leg succeeds; incident delivered (F-05) |
| **✚ T-222** | Deploy while the canary is mid-run | Deploy proceeds — drills are excluded from the freeze (F-02) |
| **✚ T-223** | 200 unverified incidents from random `device_id`s in 60 s | Coalesced into ≤3 incidents; SMS budget not breached; fail-open preserved (F-04) |

---

## 3.11 The quarterly drill — 4 minutes, calendared, non-negotiable

```
T-24h   "Drill this week, sometime. Act normally."
        ★ Do NOT announce the exact time — you are testing DND, not people's
          willingness to sit by their phone.
T+0     A randomly-selected member's device fires a real incident with
        is_drill=true AND drill_notifies_family=true. Full ladder, real
        notifications, real sounds. SMS/voice simulated by default.
T+0..4m Family responds exactly as they would for real: claim, call, resolve.
T+5m    Automated scorecard:
          · per-member: alert received? at what latency? acknowledged?
          · who claimed first, and how long it took
          · any device that did NOT receive the alert, and WHY
          · four-clock measurements vs the SLO targets
T+1d    Fix everything the drill revealed. This is the entire point.

ANNUAL EXTRAS (once per year, folded into one of the four):
  □ Full fidelity: real SMS and real TTS voice calls to every member
  □ ★ Key-recovery drill: actually reconstruct the vault from Shamir shares.
    20 minutes. The difference between an inconvenience and losing your
    family's medical history forever.
  □ Backup restore into a scratch VM
  □ Runbook drill: someone ELSE executes Part 19 while you watch silently
  □ Physical inspection of node phones for battery swelling
  □ Verify every family member's IMEI is recorded in the vault
```

Make it a game: the dashboard shows response times and a family leaderboard. **Automate all measurement** so nobody has to record anything — drill fatigue (P-063) is what kills this.

---

## 3.12 Operational readiness — write these before you need them

| Artefact | When | Why |
|---|---|---|
| Printed runbook (Part 19) in the fireproof safe **and** the vault with 2-of-3 unlock | Before Phase 1 soak | P-020: the developer becomes unavailable |
| Breach-response runbook (Appendix E.3) | Week 2 | You will not write it well during a breach |
| Credential rotation calendar | Week 12 | APNs key, FCM service account, TLS (verify the **backup pin** covers the next key), Postgres password, aggregator API key, DLT templates on any text change, Shamir shares on any guardian change |
| "Removing Device Owner" procedure (§19.7) | Before Wave 2 policies | The escape hatch must exist before the lock |
| Break-glass second person with credentials | Before Phase 1 soak | Boring tech + a printed runbook + a second human = a system that survives you |

**Triage order when something is wrong:**
```
1. Is the canary green?  NO → §19.3.  YES → the core safety path works;
                                            the problem is T1/T2. Lower urgency.
2. Is a member's agent silent?              → §19.4
3. Are escalation timers overdue?           → restart control-plane. Timers are
                                              durable; they fire late, not never.
4. Is the DR replica lagging > 60 s?        → non-urgent. Ticket it.
```

**Before restarting `sos-ingest`, always:**
```bash
curl -s https://api.kavach.example/internal/active-incidents
# Must return []. If not, WAIT. Do not restart during a live emergency.
```

---

## 3.13 Effort reality check

| Phase | PRD estimate | Assessment | Note |
|---|---|---|---|
| Phase 0 | 4 weeks | **4 weeks ✅** — but only with the crypto change (F-08). With MLS in Phase 0 it is 12–18 weeks. |
| Phase 1 | 8 weeks + 4 soak | **8–11 weeks + 4 soak.** W10 (DND on six real devices) and W11 (DLT + multi-SIM + reconciliation) are each likely to overrun by ~50%. |
| Phase 2 | 10 + 4 | **14–20 + 4** with MLS folded in |
| Phase 3 | 13 + 6 | **13 + 6 ✅**, but the gate may force iteration. Budget one extra tuning cycle. |
| Phases 4–5 | ~35 weeks | Open-ended by design. Each item is independently shippable — treat the list as a backlog, not a plan. |
| **To Phase 1 gate** | **12 weeks** | **16 weeks including soak** — matching the PRD's own W13–16 |
| **To full scope** | 18–24 months | **24–30 months** at genuine part-time. This is fine: everything after Phase 1 is optional. |

**Where the time actually goes, ranked:**
1. Getting a real alert through DND on six different OEM skins (W10) — deceptively expensive, and it is the thing that determines whether the system works at 3 a.m.
2. Sensor-fusion false-positive tuning (Phase 3) — this is a two-year activity, not a two-week one.
3. MLS, if you attempt it on the critical path.
4. DLT registration and template churn — every message-text change requires re-registration **before** shipping.
5. Everything else.
