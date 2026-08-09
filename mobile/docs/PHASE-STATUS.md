# PROJECT KAVACH — PHASE COMPLETION AUDIT

**Scope:** Phase 0, Phase 1 and Phase 2 as defined in `docs/03-Implementation-Guide.md`
§3.3, §3.4 and §3.5.
**Method:** every checklist box in those three sections became one row. Each row was
resolved by reading the code that would have to exist for it to be true, not by reading
the commit message that claimed it. A row cites the file that implements it or names it
as missing.
**Audited:** commit `20a5fdf`. Rows describe that commit. Uncommitted work by other
hands landing after it — at the time of writing, `src/state/store.ts`,
`src/domain/presenceService.ts` and `src/state/nodeStore.ts` were being changed
concurrently — is deliberately **not** scored here; re-run the affected rows once it
commits. Rows 2.1–2.5 are the ones that concurrent work is most likely to move.

---

## How to read the verdicts

A feature whose UI exists but whose logic is never invoked is **not** complete. Several
rows below are exactly that: a correct, tested, well-documented module that nothing
calls. Those score at most 0.25, because from the family's point of view an
unreachable function and a missing one are the same function.

| Verdict | Credit | Means |
|---|---|---|
| **DONE** | 1.0 | Implemented, reachable at runtime, and the mechanism it claims is the mechanism it uses |
| **MOSTLY** | 0.75 | Implemented and reachable; one named sub-property is missing or degraded |
| **PARTIAL** | 0.5 | Real work exists and does something, but the acceptance criterion in §3 is not met |
| **THIN** | 0.25 | A declaration, a constant, a permission or an unreachable implementation. Counts for almost nothing |
| **ABSENT** | 0.0 | Not present in the repository |

The percentage at the end of each phase is `Σ credit ÷ row count`, stated with its
arithmetic. **It counts boxes, and boxes are not equal in value.** Phase 1 scores 70%
and is nonetheless *nowhere near* its gate, because the boxes it is missing (W10 remote
push, W13–16 soak) are the ones that decide whether an alert wakes anybody. The
percentage is a completeness measure, not a readiness measure. The gate checklist below
it is the readiness measure, and it is failed.

---

## PHASE 0 — Foundation (§3.3, weeks 1–4)

| # | Item (§3.3) | Evidence | Verdict |
|---|---|---|---|
| 0.1 | Family conversation + signed one-page agreement | `mobile/app/onboarding/index.tsx` — step 2 `agreement` renders it in full and requires an explicit tick before Continue. There is no `docs/family-agreement.md` and no signed copy in the repo | PARTIAL |
| 0.2 | DLT registration (sender header + every SMS template, transactional route) | Nothing. The message bodies exist (`mobile/src/t0/smsPayload.ts`) and were never registered; on a real Indian carrier they are undeliverable to DND numbers | ABSENT |
| 0.3 | Appendix C repo tree | Present: `spec/`, `backend/cmd/{sos-ingest,control-plane,realtime-gw,canary}`, `backend/internal/*`, `mobile/`, `tools/smgen.mjs`, `ops/`. Absent: `proto/`, `backend/migrations/`, `backend/tools/archlint/`, `infra/`, `firmware/`, `bridge/`, `docs/adr/` | PARTIAL |
| 0.4 | The eight day-one CI gates | There is no `.github/` in the repository — no CI runs at all. Two of the eight exist as tests a human must remember to run: LOC budget (`backend/cmd/sos-ingest/main_test.go` `TestLOCBudget`) and ASCII SMS lint (`mobile/test/invariants.test.ts`). `go vet`/`staticcheck`, `-race`, archlint, sql-lint, proto-lint and string-lint: absent | THIN |
| 0.5 | ADR-001 … ADR-021 as files | `docs/adr/` does not exist. ADR ids are cited in roughly forty source headers (`src/crypto/index.ts` → ADR-021, `src/net/api.ts` → ADR-018, `src/domain/geofence.ts` → ADR-010) but the decisions themselves were never written down. The citations point at documents that are not there | ABSENT |
| 0.6 | `spec/state-machine.yaml` + `tools/smgen` → three implementations + fixtures | `spec/state-machine.yaml` (v3, 14 states, 21 events, 16 fixtures) → `tools/smgen.mjs` → `mobile/src/t0/stateMachine.generated.ts` + `backend/internal/incident/machine_gen.go` + `mobile/src/t0/__generated__/fixtures.json`. Both machines run the same fixtures (`machine_gen_test.go`, `test/invariants.test.ts`). Kotlin/Swift are not generated — the Kotlin plane consumes the JS machine | DONE |
| 0.7 | `proto/incident.proto` with `optional bool duress` (F-01) | No protobuf anywhere. The wire format is canonical JSON inside a fixed-size padded envelope (`mobile/src/t0/envelope.ts`, `backend/internal/envelope/envelope.go`), byte-for-byte cross-checked by `backend/internal/envelope/crosslang_test.go`. F-01 is honoured — duress is one bit inside the ciphertext — but the contract file and its additive-only lint do not exist | PARTIAL |
| 0.8 | `migrations/0001_init.sql`, RLS, append-only trigger | No SQL. Device schema is `mobile/src/db/schema.ts` (expo-sqlite). Server durability is `backend/internal/store/store.go`, a file-backed store that keeps the §2.8 table and column names and returns `ErrAppendOnly` from every mutator on `incident_event`, so the rule is testable rather than merely absent. RLS has no analogue | PARTIAL |
| 0.9 | `internal/log/pii.go` — deny-list that panics in dev | `backend/internal/logx/logx.go` — substring and whole-token deny lists, panics in development, redacts in production, `Deny()` exported so CI can assert the list was not quietly shortened. The CI that asserts it does not exist (see 0.4) | MOSTLY |
| 0.10 | `cmd/sos-ingest` — the sacred binary | `backend/cmd/sos-ingest/main.go` — 8 KB `LimitReader`, in-memory family and key caches, Ed25519 verify that **flags** rather than rejects (ADR-018), WAL fsync before ack, bus publish, F-04 family-scoped flood coalescing at 3/60 s, F-22 cache warm before the listener opens, zero direct dependencies | DONE |
| 0.11 | `canary/main.go` before the second feature | `backend/cmd/canary/main.go` — real POST on a 15-minute tick, `is_drill`, four-clock capture, P0 page webhook with 5-minute re-page suppression | DONE |
| 0.12 | `KavachForegroundService.kt` — the T0 host | `mobile/modules/kavach-t0/android/.../KavachForegroundService.kt` + `AndroidManifest.xml`: `android:process=":t0"`, `directBootAware="true"`, `foregroundServiceType="location\|connectedDevice"` (the Android-15 boot-permitted set), `stopWithTask="false"` | DONE |
| 0.13 | Device Owner provisioning, two waves, escape hatch first | `DeviceOwnerConfigurator.kt`, `KavachDeviceAdminReceiver.kt`, `res/xml/kavach_device_admin.xml`; `applyDeviceOwnerPolicy(wave)` and `releaseDeviceOwner(guardianToken)` are both exposed from `KavachT0Module.kt`, and the escape hatch exists before the lock. The restriction list §5.4 demands is assembled from live state in `mobile/app/(tabs)/settings.tsx`. No phone has actually been provisioned — that is an operations act, not a code gap | DONE |
| 0.14 | Two keys per device in StrongBox: identity (biometric) + emergency (non-biometric) | `mobile/src/crypto/index.ts` generates identity, emergency and box keypairs, and `loadKeyMaterial()` in `src/state/store.ts` stores them **as base64 JSON in expo-secure-store** with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`. That is not StrongBox, it is not hardware-bound, and the private keys are readable by the JS runtime. The F-17 property that matters (no biometric gate on the emergency key) is honoured; the hardware property is not | THIN |
| 0.15 | Device enrolment — a second phone joins the family | Absent. `crypto.sealTo()` can seal the group secret to another device's box key and **nothing calls it**. `loadKeyMaterial()` generates a fresh 32-byte group secret whenever one is missing, so every install founds its own family of one. There is no enrolment UI, no invite, no key exchange, and no passkeys | ABSENT |
| 0.16 | GroupBox crypto (ADR-021), unreadable on the server | `mobile/src/crypto/index.ts` — X25519 seal, XChaCha20-Poly1305 under HKDF per-scope keys, `scheme` byte for the future MLS migration, constant-time compare. Exercised by `test/invariants.test.ts` | DONE |
| 0.17 | Direct Boot key access verified (`t0_signing_available_predawn`) | `KavachT0Module.kt:572` `t0SigningAvailablePredawn()` is a real device-protected-storage probe, surfaced through `src/t0/diagnostics.ts` and `app/diagnostics.tsx`, and reported **false** when it cannot be read rather than assumed true. It has never been confirmed on a phone that was rebooted and not unlocked | MOSTLY |

**Phase 0 = (0.5+0+0.5+0.25+0+1+0.5+0.5+0.75+1+1+1+1+0.25+0+1+0.75) ÷ 17 = 10.00 ÷ 17 = 59%**

The 41% that is missing is almost entirely *paper and process*: ADRs, migrations, the
proto contract, DLT, CI. The one missing item that is not paper is 0.15 — **there is no
way for a second device to join a family**, which means the E2EE group has one member
and every "family" feature above it is, on real hardware, a single-user feature.

---

## PHASE 1 — Minimum Viable Safety (§3.4, weeks 5–16) ★ THE GATE ★

### W5 — `sos-ingest`

| # | Item | Evidence | Verdict |
|---|---|---|---|
| 1.1 | Protobuf contract with `optional bool duress` | See 0.7. JSON-in-padded-envelope; F-01 satisfied, contract file absent | PARTIAL |
| 1.2 | Fixed-size envelope padding + the assertion that fails closed | `src/t0/envelope.ts` — `FIXED_ENVELOPE_SIZE`, `padEnvelope()`, `EnvelopeSizeError` thrown when the plaintext will not fit rather than emitting a short envelope; mirrored in `backend/internal/envelope/envelope.go` | DONE |
| 1.3 | WAL with fsync-before-ack | `backend/internal/wal/wal.go` — length+CRC32 framing, `AppendSync`, torn-tail truncation at `Open()` with an explicit report | DONE |
| 1.4 | NATS publish, at-least-once | `backend/internal/bus/bus.go` — file-backed in-process pub/sub with `fam.{id}.*` subjects, durable replayable stream, restart-surviving cursors, at-least-once delivery, and `PublishEphemeral` for Class A′. It is not NATS; the semantics ADR-007 relies on are preserved | PARTIAL |
| 1.5 | Ed25519 verification against an in-memory cache, fail open | `sos-ingest/main.go` — bad signature sets `FLAG_UNVERIFIED` and the incident proceeds | DONE |
| 1.6 | Family-scoped flood guard with coalescing (F-04) | `sos-ingest/main.go` — `floodThreshold = 3` / `floodWindow = 60s`, unverified opens beyond the bound coalesce into the first, `CoalescedInto` returned to the caller | DONE |
| 1.7 | Local cache persistence: key cache loaded at boot (F-22) | `sos-ingest/main.go:266` — caches warmed from disk before the listener opens | DONE |
| 1.8 | Dual endpoint: CDN + direct bypass (F-05) | `src/net/api.ts` genuinely fires both concurrently and resolves on first success. But `src/core/config.ts` defaults `apiBase` and `apiDirect` to **the same origin** (`10.0.2.2:8081`), so the shipped app has one DNS name, one TLS chain and one point of failure. The mechanism is real; the redundancy is not configured | PARTIAL |

### W6 — Android T0 skeleton

| # | Item | Evidence | Verdict |
|---|---|---|---|
| 1.9 | Service in process `:t0`, type `location\|connectedDevice` | `modules/kavach-t0/android/src/main/AndroidManifest.xml` | DONE |
| 1.10 | `directBootAware=true` on the service AND the boot receiver | Same manifest — both carry it, and the receiver runs in `:t0` | DONE |
| 1.11 | DeviceProtectedConfig: contacts, policy snapshot, key alias, peer fingerprints | `KavachForegroundService.kt:505-529` — `KEY_EMERGENCY_NUMBERS`, `KEY_POLICY_SNAPSHOT`, `KEY_SIGNING_KEY_ALIAS`, `KEY_PEER_FINGERPRINTS`, plus last-fix and heartbeat keys, all in device-protected storage | DONE |
| 1.12 | BootReceiver on `LOCKED_BOOT_COMPLETED` + `BOOT_COMPLETED` | `BootReceiver.kt` — both, plus `MY_PACKAGE_REPLACED`, and it records the blind-gap since the last heartbeat before anything else | DONE |
| 1.13 | WatchdogAlarmReceiver: `setExactAndAllowWhileIdle`, 15 min, logs SERVICE_DEATH with gap | **There is no Kotlin alarm receiver.** `src/t0/watchdog.ts` implements the disk-persisted tick, the `DEATH_FACTOR` gap test and the SERVICE_DEATH emit — but on `expo-background-task`, which is opportunistic and best-effort, plus a foreground timer. `exactAlarmsPermitted` is *checked* by diagnostics and no exact alarm is ever *scheduled*. On a force-stopped app on an aggressive OEM, nothing resurrects the agent | PARTIAL |
| 1.14 | SelfDiagnostics: the seven P-031 checks | `src/t0/diagnostics.ts` — nine checks, with the honesty rule (undeterminable ⇒ reported false and listed by `unknownChecks()`), OEM profiles from Appendix B, and remediation text per key. Rendered by `app/diagnostics.tsx` | DONE |

### W7 — State machine and triggers

| # | Item | Evidence | Verdict |
|---|---|---|---|
| 1.15 | Machines generated from the YAML, both passing the same fixtures | See 0.6 | DONE |
| 1.16 | PowerButtonWatcher — 5× within 3 s, registered programmatically | **Absent.** No `KeyEvent`, no `ACTION_SCREEN_*`, no accessibility service, nothing in `KavachT0Module.kt` or anywhere else observes a hardware button | ABSENT |
| 1.17 | VolumePatternWatcher — vol-down held 3 s, screen off | **Absent**, same as 1.16 | ABSENT |
| 1.18 | In-app 88 dp button, bottom third | `src/ui/theme.ts` `PANIC_BUTTON_HEIGHT = 96`, `CALL_112_HEIGHT = 88`; `app/panic.tsx` renders it in the footer; `app/(tabs)/home.tsx` carries the entry press | DONE |
| 1.19 | PocketSuppressor (proximity < 3 cm ∧ lux < 10 ∧ motion > 60 s) | `src/t0/pocketSuppressor.ts` — full conjunctive gate, per-decision logging, a stricter darkness-only fallback when no proximity sensor is reachable, and only button-sourced triggers are eligible. Correct and complete — but with 1.16/1.17 absent there is currently no trigger for it to suppress | MOSTLY |
| 1.20 | Cancel window with accelerating haptics, length from risk context | `src/t0/triggerRouter.ts` + `src/core/policy.ts` `effectiveCancelWindowS()` + `src/t0/alarm.ts` cue ladder; risk from `src/domain/riskContext.ts` | DONE |
| 1.21 | Duress PIN: constant-time compare over BOTH candidates, always both | `src/t0/triggerRouter.ts` `verifyPin` — no early return, both compared every time, one shared accept path, same fixed-size envelope at the same offset. Asserted in `test/invariants.test.ts` | DONE |

### W8 — The L0 floor

| # | Item | Evidence | Verdict |
|---|---|---|---|
| 1.22 | LocalAlarmController: STREAM_ALARM at max, no audio-focus request (P-065) | `src/t0/alarm.ts` — PCM siren synthesised at runtime (no bundled asset to lose), `interruptionMode: 'mixWithOthers'`, loudness via native `setAlarmVolume` | DONE |
| 1.23 | Torch strobe | `src/t0/alarm.ts` + `KavachT0Module.kt` `setTorch` | DONE |
| 1.24 | MedicalCardActivity, `showWhenLocked` | `app/medical-card.tsx` is a complete L0 card — 21:1 contrast, oversized blood group, three allergies max, tap-to-call ICE, `BigCoordinates`, keep-awake and full brightness restored on unmount. But it is a React route **inside the app**: there is no `showWhenLocked` Activity, so a stranger holding a locked phone cannot reach it. The single most important property of this screen is the one that is missing | PARTIAL |
| 1.25 | CALL 112 handoff to the NATIVE dialer — never wrapped | `src/ui/components/Call112Button.tsx` | DONE |
| 1.26 | BlackBoxRingBuffer: pre-allocated, encrypted, sealed on trigger | `src/t0/blackbox.ts` — pre-allocated fixed-length slots claimed at init, allocation-free `pushSample`, seal rewrites at identical length, never awaited on the trigger path | DONE |
| 1.27 | Pre-allocated incident-log reserve (P-043) | Same file — `RESERVE_SLOTS` × `RESERVE_BYTES` claimed once at init, which is exactly the T-214 scenario | DONE |

### W9 — Escalation engine

| # | Item | Evidence | Verdict |
|---|---|---|---|
| 1.28 | `escalation_timer` + N stateless workers, atomic claim, no leader election (F-13) | `backend/internal/escalation/engine.go` — every timer is a store row, claimed atomically; the header refuses `time.AfterFunc` explicitly | DONE |
| 1.29 | LISTEN/NOTIFY + adaptive poll | In-process bus wake plus polling. The semantics hold; the Postgres mechanism does not exist | PARTIAL |
| 1.30 | Ladder L1→L2→L3 with per-scenario policies as DATA | `engine.go` + `mobile/src/core/policy.ts` (per-trigger scenarios, audience roles, neighbour flags) | DONE |
| 1.31 | CLAIM / RELEASE + ownership broadcast over BOTH WS and push | Server broadcasts on the bus and the gateway serves it. **Push does not exist (1.35) and the client never opens the socket (2.5)**, so on a real device neither leg arrives | PARTIAL |
| 1.32 | Progress watchdog: 5 min → re-broadcast | `engine.go`, and `PROGRESS_WATCHDOG` at `afterS: 300` in `spec/state-machine.yaml` | DONE |
| 1.33 | Auto-quiesce → DORMANT after 6 h (F-02) | `spec/state-machine.yaml` `afterS: 21600` from all five active states; `sweepAutoQuiesce()` in `src/state/store.ts` | DONE |
| 1.34 | `/internal/active-incidents` excludes drills | `backend/internal/store/store.go` — `active_incident_v` excludes `is_drill` and `DORMANT`, called out as F-02 in the package header | DONE |

### W10 — Notification orchestrator ← **the weakest week in the project**

| # | Item | Evidence | Verdict |
|---|---|---|---|
| 1.35 | FCM data messages, high priority, DATA-ONLY (F-21) | **Absent.** Nothing in `mobile/` ever obtains a push token — no `getDevicePushTokenAsync`, no `getExpoPushTokenAsync`, no registration call anywhere. `backend/internal/notify/notify.go` states in its own header that there are no FCM/APNs credentials and that the content leg rides the realtime bus instead. There is no remote push in this system | ABSENT |
| 1.36 | Channel with `setBypassDnd(true)` + `USAGE_ALARM` attributes | `src/state/notifications.ts` — `AndroidImportance.MAX`, `AndroidAudioUsage.ALARM`, bypass DND, plus the locally-composed-text policy F-21 demands | DONE |
| 1.37 | Full-screen intent (declare `USE_FULL_SCREEN_INTENT`) | The permission is declared in `mobile/app.json:27` and **nothing ever requests or presents one**. A declared permission with no call site is a line in a manifest | THIN |
| 1.38 | APNs alert + Critical Alert path | Absent. iOS is out of scope for the native module by design (`modules/kavach-t0/src/KavachT0.types.ts`), and no APNs path exists on either side | ABSENT |
| 1.39 | ★ PushKit VoIP → CallKit incoming-call UI | Absent — and §3.4 calls this "the load-bearing iOS technique" | ABSENT |
| 1.40 | iOS Notification Service Extension that decrypts before display | Absent | ABSENT |
| 1.41 | Live Activity (iOS) / ongoing notification (Android) | Ongoing Android incident notification exists (`src/state/notifications.ts`, re-posted rather than cleared on `OWNED` per P-030). No Live Activity | PARTIAL |
| 1.42 | Wear OS / watchOS haptic burst | Absent | ABSENT |

> **The W10 consequence, stated plainly.** Combining 1.35 with 2.5: on a real device
> there is **no IP path by which one family member's SOS reaches another family
> member's phone**. The incident reaches the server correctly over HTTP; the server
> escalates it correctly; and no phone is listening. The only peer-delivery leg that
> actually functions on hardware is SMS (1.43), which works and is unencrypted. In
> `CONFIG.demoMode` — the default — `src/domain/demo.ts` `simulateResponders()`
> fabricates the claims and acknowledgements locally, which is honest as a
> demonstration and must not be mistaken for delivery.

### W11 — SMS and voice tiers

| # | Item | Evidence | Verdict |
|---|---|---|---|
| 1.43 | Multi-SIM enumeration; send on ALL SIMs | `KavachT0Module.kt` — `SubscriptionManager` enumeration, a per-subscription `SmsManager`, ordered attempt list; `READ_PHONE_STATE`/`READ_PHONE_NUMBERS` declared with the reason in the manifest | DONE |
| 1.44 | ASCII payload encoder + the lint test (I-2) | `src/t0/smsPayload.ts` (K1 protocol, ≤160, transliterated names) + the 32..126 assertion in `test/invariants.test.ts` | DONE |
| 1.45 | `sentIntent` / `deliveredIntent` result logging per SIM | `KavachT0Module.kt:281-363` — a one-shot immutable `sentPendingIntent` per message part per subscription. The **deliveredIntent is passed as `null`**, so "the carrier accepted it" is recorded and "the handset received it" is not | MOSTLY |
| 1.46 | Aggregator inbound webhook with sig8 HMAC, fail open | `sos-ingest/main.go:708` `handleSMSInbound` — sig8 verified, failure flags rather than rejects (ADR-018) | DONE |
| 1.47 | inc8 → incident index + UUIDv5 synthesis + reconciliation (F-09) | `sos-ingest/main.go` — `inc8` index with a 24 h TTL, `envelope.UUIDv5(family\|inc8\|window)` synthesis, `synthetic_from_sms` on the record, `merged_into_id` in the store schema | DONE |
| 1.48 | Class A′: fan out in memory, persist only `coarse_h3_r7` (F-10) | `backend/internal/bus/bus.go` `PublishEphemeral` — a structurally separate subscriber list that the durable stream cannot reach; `Incident.coarseH3R7` is the only location that is persisted | DONE |
| 1.49 | `notify_budget` spend ceiling; breach = P0 (F-04) | `backend/internal/notify/notify.go` — `Budget` / `BudgetLedger` per family per calendar month | DONE |
| 1.50 | TTS voice tier | **Absent.** `expo-speech` is a dependency in `mobile/package.json` and is imported by no file in `src/` or `app/`. An unused dependency is not a voice tier | ABSENT |

### W12 — Canary and observability

| # | Item | Evidence | Verdict |
|---|---|---|---|
| 1.51 | Real POST every 15 min, `is_drill=true`, drill scoped to the canary receiver (F-03) | `backend/cmd/canary/main.go` | DONE |
| 1.52 | Four-clock recording | `canary/main.go` (`httptrace`-instrumented) + `FourClocks` in `mobile/src/core/types.ts`, rendered in `app/drills.tsx` | DONE |
| 1.53 | Grafana Dashboards 1 (Safety Chain Health), 2 (Four Clocks), 3 (FP Ledger) | No Grafana, no `infra/grafana`. The three dashboards exist **as app screens**: `app/(tabs)/home.tsx` is Dashboard 1 including the non-dismissable yellow line, `app/drills.tsx` renders the four clocks, `app/(tabs)/incidents.tsx` is the false-positive ledger with drills excluded arithmetically. There is no operator-side view of a fleet | PARTIAL |
| 1.54 | P0 → Telegram + SMS, repeating every 5 min until acknowledged | `canary/main.go` — a single page webhook (`ntfy`/Telegram) with 5-minute re-page suppression. No SMS leg and no acknowledgement protocol, so "until acknowledged" is not implemented | PARTIAL |
| 1.55 | Alerting hosted OUTSIDE the monitored system | The canary is a binary in the same tree, run on the same machine as everything else | ABSENT |
| 1.56 | Backups: WAL → R2, daily `pg_dump` → Backblaze, monthly physical | Absent. There is no Postgres and no backup job of any kind | ABSENT |
| 1.57 | Restore drill into a scratch VM | Absent | ABSENT |

**Phase 1 = 39.75 ÷ 57 = 70%**
(W5 6.50/8 · W6 5.50/6 · W7 4.75/7 · W8 5.50/6 · W9 6.00/7 · **W10 1.75/8** · W11 6.75/8 · W12 3.00/7)

### The W13–16 gate checklist — **not passed**, and not close

§3.4 says: *do not proceed past week 16 until every box is ticked.* Not one of these
nine is ticked. This table is deliberately not folded into the percentage, because the
gate is pass/fail and the percentage would soften it.

| Gate item | Status |
|---|---|
| NFR-001 … NFR-009 measured and met | **No.** No measurement of any NFR exists in the repo |
| 2 drills passed | **No.** `app/drills.tsx` can run one; none has been run |
| Zero unexplained canary failures for 14 consecutive days | **No.** The canary has never been run against a deployed server |
| Every family member has triggered AND cancelled a test SOS unaided | **No** — and the app now knows it, per `rehearsalSkipped` in `src/state/store.ts`, surfaced as a failing check in `app/diagnostics.tsx` |
| T-204/205/207/210/213/216 on the full device matrix | **No.** T-213 (duress indistinguishability) is asserted structurally in `test/invariants.test.ts` — the statistical two-sample test on real packets has not been run. The other five require hardware |
| Every Android phone reports `is_device_owner = true` | **No.** Zero phones provisioned |
| ASCII lint passes; DLT templates live; delivery tested to every number | **Lint passes** (`test/invariants.test.ts`). DLT: absent (0.2). Delivery: untested |
| A message sealed on phone A opens on phone B | **Cannot be attempted** — there is no enrolment path for a phone B (0.15) |
| Idle battery drain < 4% / 24 h on the aggressive-OEM device | **No.** Never measured |

---

## PHASE 2 — Presence & Coordination (§3.5, weeks 17–30)

| # | Workstream item | Evidence | Verdict |
|---|---|---|---|
| 2.1 | Realtime: connect tickets (F-16) | Server complete: `control-plane/main.go:454` `POST /v1/rt/ticket`, `realtime-gw/main.go:315` validates it out of `Sec-WebSocket-Protocol`, never a query string. Client `postRtTicket()` exists in `src/net/api.ts` and is only reachable from code that never runs (2.5) | PARTIAL |
| 2.2 | Realtime: resumable cursor | Server: `realtime-gw/main.go`. Client: `src/net/ws.ts` + `cursorRepo` in `src/db/repos.ts`. Same caveat | PARTIAL |
| 2.3 | Presence, 45 s TTL | Server broadcasts `presence.changed` (`realtime-gw/main.go:966`); `CONFIG.presenceTtlMs = 45_000`. Client-side presence is written locally by `checkIn()`/`pauseMonitoring()` and never exchanged | PARTIAL |
| 2.4 | Priority backpressure — no CRITICAL frame ever dropped | Implemented on both sides — `realtime-gw/main.go` and `src/net/ws.ts` (CRITICAL never dropped or coalesced, LOW coalesced by key). Correct code; see 2.5 | PARTIAL |
| 2.5 | **The realtime plane actually reaches the phone** | **It does not.** `connectWs()` is exported from `src/net/ws.ts:424` and is called from **nowhere** in `src/` or `app/`; `onFrame()` is likewise never subscribed. 490 lines of correct, careful transport code are dead on the device. Acceptance ("8 concurrent connections stable for 7 days") cannot even be attempted | ABSENT |
| 2.6 | Four-clock rendering | `app/drills.tsx` | DONE |
| 2.7 | Notification matrix (who got it, when, why not) | `app/drills.tsx` scorecard, derived from delivery receipts in the incident log rather than hand-entered | DONE |
| 2.8 | `policy_version`-correct replay | `incident.policyVersion` is stamped at open (`src/state/store.ts` `openIncidentRecord`), persisted (`src/db/repos.ts` `INCIDENT_COLUMNS`) and **displayed** (`policy v{n}` in `app/incident/[id].tsx:531`). The ladder next to it is rebuilt with `currentPolicy()`, and `policyRepo` (`src/db/repos.ts:1564`) has `current()` and `version()` but **no `byVersion()`**. A six-month-old incident renders under today's rules while labelled with yesterday's version — which is worse than not labelling it | THIN |
| 2.9 | Family map with consent gating | `app/(tabs)/map.tsx` + `src/ui/components/FamilyMapView.tsx` — a pin is drawn only against a live, unrevoked, unexpired `live_location` grant; otherwise the member is listed with the reason, never pinned at a stale position | DONE |
| 2.10 | Geofence crossings (enter / exit / dwell) | **Never evaluated.** `src/domain/geofence.ts` `evaluateGeofences()` is complete and careful — hysteresis, accuracy-widened thresholds, coarse fixes refused rather than guessed — and has **no call sites anywhere**. Fences can be created (`store.addGeofence`), listed on the map, and shown in the Settings restriction list, and no crossing is ever computed. There is no geofence alert in this product | ABSENT |
| 2.11 | Live location acquisition | **Absent, and it is the most consequential gap in the audit.** Nothing calls `Location.watchPositionAsync` or `startLocationUpdatesAsync`; `expo-location` is imported only by `src/t0/diagnostics.ts` (to read the permission) and `app/onboarding/index.tsx` (to request it). `store.noteLocationFix()` — whose own comment says it is "the ONLY way the cached fix T0 reads ever changes" — has **no callers**. The fix T0 seals into an incident is whatever `primeCaches()` read out of SQLite at boot: the demo seed in demo mode, and **nothing at all** in a fresh real install. Everything downstream — map pins, corridor deviation, geofences, the coordinates on the panic screen and in the SMS — inherits that | ABSENT |
| 2.12 | Learned-route ETA | `src/domain/journey.ts` `predictEta()` (median + MAD, peak/off-peak conditioning, exponential recency decay, "no opinion" below confidence 0.4) wired into `store.startJourney()` | DONE |
| 2.13 | Corridor deviation | `corridorDeviationM()` is real and rendered in `app/journeys.tsx`. But with 2.11 absent the corridor only ever contains the single point captured at journey start, so `corridorPoints.length >= 2` is false and the screen correctly says so. `journeyStatus()` is never used to escalate | PARTIAL |
| 2.14 | Missed-arrival / dead-man escalation | **Absent.** The DEADMAN policy is fully specified in `src/core/policy.ts` — guardians only, `allowNeighbours: false`, 15-minute L2 boundary, zero cancel window — and `'DEADMAN'` is never passed to `store.trigger()` by anything. There is no sweep comparing `etaAt` or `lastCheckInAt` to now; `src/state/store.ts` has `sweepSilentAgents` and `sweepAutoQuiesce` and no `sweepJourneys`. A journey can be started, and it can never be overdue | ABSENT |
| 2.15 | Consent: grant CRUD | `app/(tabs)/consent.tsx` + `store.grantConsent` — `expiresAt` is never null, even for a nonsense `hours` | DONE |
| 2.16 | Consent: access log surfaced to the subject | `store.findPhone()` and the read paths write `access_log` rows with `surfacedToSubject`; rendered to the subject in `app/(tabs)/consent.tsx`. Server side: `backend/internal/consent/consent.go` | DONE |
| 2.17 | Two-layer revocation with an honest pending state (F-14) | `store.revokeConsent()` sets `revokedAt` locally in under a millisecond and sets `keyRotationPending: true`; the UI renders the pending ratchet verbatim rather than claiming completion | DONE |
| 2.18 | Find-phone over FCM → alarm + torch + vibrate, prior volume restored | `store.findPhone()` writes the consent-bearing access-log row and calls `postFindPhone()`. **On the target device nothing listens** — no push (1.35), no socket (2.5) — so no phone ever rings. The consent bookkeeping is complete; the feature is not | THIN |
| 2.19 | BLE `FIND_ME` GATT fallback when the target has no data | Absent. `BLUETOOTH_ADVERTISE` is declared and `bleAdvertise()` exists for the distress advert only; there is no GATT server, no scanner and no `FIND_ME` characteristic | ABSENT |
| 2.20 | Final Breath on `ACTION_SHUTDOWN` (P-022) | `modules/kavach-t0/android/.../ShutdownReceiver.kt` — `ACTION_SHUTDOWN` + both `QUICKBOOT_POWEROFF` variants, per-SIM send inside the 2–5 s window, result committed with `commitBlocking` because `apply()` would not survive the shutdown | DONE |
| 2.21 | ▲ MLS migration (OpenMLS, DS with per-group ordering, replay, key transparency, exporter keys) | Absent. `SCHEME_MLS = 0x02` in `src/crypto/index.ts` is a reserved constant with a comment. The scheme byte that makes the migration additive is real and shipped, which is the correct groundwork and is not the migration | ABSENT |

**Phase 2 = (0.5+0.5+0.5+0.5+0 +1+1+0.25+1+0+0 +1+0.5+0 +1+1+1 +0.25+0+1 +0) ÷ 21 = 11.00 ÷ 21 = 52%**

---

## Summary

| Phase | Rows | Credit | Completion | Gate |
|---|---|---|---|---|
| Phase 0 — Foundation | 17 | 10.00 | **59%** | n/a |
| Phase 1 — Minimum Viable Safety | 57 | 39.75 | **70%** | **FAILED** — 0 of 9 gate items |
| Phase 2 — Presence & Coordination | 21 | 11.00 | **52%** | not reached |

### The five findings that matter more than the percentages

1. **No live location layer** (2.11). `noteLocationFix()` has no callers. Every
   coordinate the product shows or transmits is a boot-time database read.
2. **No peer delivery over IP** (1.35 + 2.5). No push token is ever requested and
   `connectWs()` is never called. A correctly-escalated incident reaches a server that
   no phone is listening to. SMS is the only working leg to another human.
3. **No hardware trigger** (1.16, 1.17). The panic button works only from inside a
   running app, on screen. The pocket suppressor guards a door nobody can open.
4. **No second device** (0.15). The group secret is generated locally and never sealed
   to anyone, so "family" is a single-device concept on real hardware.
5. **Three complete, tested subsystems with zero call sites** — `evaluateGeofences()`,
   `noteLocationFix()`, `connectWs()`. This is the failure mode this document exists to
   catch: each of them reviews well, tests well, and does nothing.

### What is genuinely strong

The survival core. `sos-ingest` with its LOC budget and fail-open verification; the WAL;
the durable escalation ladder; the generated state machine with a cross-language
conformance suite; GroupBox; the SMS encoder and its ASCII lint; the constant-time
duress path; the black box with its pre-allocated reserve; the native Direct Boot
service, boot receiver and Final Breath; and the diagnostics screen that refuses to tick
a box it could not read. Those are the parts that are hard to get right, and they are
right. What is missing is mostly the wiring between them and the phone in someone's
pocket.
