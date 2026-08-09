# SECTION 2 — END-TO-END SYSTEM ARCHITECTURE & TECHNICAL DESIGN

> This section takes the PRD's architecture as the accepted baseline (it is sound) and delivers the **implementable** version: every seam specified, every finding from §1.7 resolved, every contract concrete.
> Deltas from the PRD are marked **▲ CHANGE** (corrects a defect) or **✚ ADDS** (fills a gap). Everything unmarked is the PRD's design, restated precisely.

---

## 2.0 Architecture at a glance

```
                     ┌──────────────────────────────────────────────────┐
   SUBJECT DEVICE    │  T0 · NATIVE SURVIVAL PLANE  (Kotlin / Swift)    │
   ───────────────   │  own process · own storage · zero Flutter deps   │
                     │  trigger → state machine → alarm → dispatcher    │
                     └───────────────┬──────────────────────────────────┘
                                     │ TransportDispatcher fans out IN PARALLEL
        ┌──────────────┬─────────────┼─────────────┬──────────────┬─────────────┐
        ▼              ▼             ▼             ▼              ▼             ▼
    WebSocket      HTTPS via     HTTPS direct    SMS (all      BLE ADV      Local alarm
    (if warm)      Cloudflare    (bypass CF)     active SIMs)  (family      + torch +
                       │              │              │          mesh)       medical card
        └──────────────┴──────┬───────┘              │            │         + CALL 112
                              ▼                      ▼            ▼         (never blocked)
                       ┌─────────────┐        ┌────────────┐  ┌────────┐
                       │ sos-ingest  │◄───────│ aggregator │  │ peer   │
                       │ ≤1000 LOC   │        │  webhook   │  │ relay  │
                       │ no DB read  │        └────────────┘  └────────┘
                       └──────┬──────┘
                    fsync WAL │ then publish
                              ▼
                       ┌─────────────┐
                       │ NATS        │  fam.{id}.incident
                       │ JetStream   │
                       └──┬───────┬──┘
                          ▼       ▼
              ┌────────────────┐ ┌──────────────┐
              │ control-plane  │ │ realtime-gw  │
              │ 11 modules     │ │ WS + presence│
              │ escalation ▸   │ └──────┬───────┘
              │ notify     ▸   │        │
              └───┬────────────┘        │
                  │ FCM · APNs · PushKit · SMS · TTS voice
                  ▼                     ▼
            ═══════════ RESPONDER DEVICES ═══════════
            CLAIM → ladder halts → ownership broadcast
```

---

## 2.1 Architectural invariants (restated as enforceable rules)

| Rule | Enforcement |
|---|---|
| **R1** T0 runs in native code with no Dart dependency | CI test on a physical device: kill the Dart VM, then fire a fob trigger. Alarm + SMS + black-box seal must all succeed. |
| **R2** T0 → T1 is **fire-and-forget**. No T0 code path awaits a network result. | `TransportDispatcher` returns `void`. There is no `await` in the trigger path. Enforced by a lint rule on the `t0/` package. |
| **R3** Transports fan out in parallel | The dispatcher takes `List<Transport>`, never a chain. Structurally impossible to sequence. |
| **R4** The panic path has no branches | One `IncidentStateMachine`, one entry point `onTrigger(TriggerSource)`. No dialogs, no category pickers. |
| **R5** Fail open, bounded | Accept-and-flag, but bound blast radius per **family**, not per device (§2.5.1). |
| **R6** Dependencies flow downward only | `go-arch-lint` for the backend; a Gradle module-dependency rule for `t0/` (it may not depend on the Flutter engine). |

---

## 2.2 Client architecture

### 2.2.1 Process and module topology (Android)

**✚ ADDS — run T0 in a separate OS process.** The PRD specifies T0 as native code but leaves it in the app process, where a Flutter OOM kill takes T0 with it. Declaring the foreground service in its own process gives T0 an independent memory budget and an independent crash domain, at the cost of an AIDL boundary that is already needed for the platform channel.

```xml
<service android:name=".t0.KavachForegroundService"
         android:process=":t0"
         android:foregroundServiceType="location|connectedDevice"
         android:directBootAware="true"
         android:exported="false" />
```

```
android/app/src/main/kotlin/in/example/kavach/
├── t0/                                  ★ TIER 0 · process :t0 · SACRED
│   ├── KavachForegroundService.kt        host; owns everything below
│   ├── IncidentStateMachine.kt           GENERATED from spec/state-machine.yaml
│   ├── TriggerRouter.kt                  single entry: onTrigger(TriggerSource)
│   ├── trigger/
│   │   ├── PowerButtonWatcher.kt         5× within 3 s, programmatic registration
│   │   ├── VolumePatternWatcher.kt       vol-down held 3 s, screen off
│   │   ├── BleFobListener.kt             HMAC + monotonic counter (anti-replay)
│   │   ├── VoicePhraseListener.kt        Porcupine; duress phrase is separate
│   │   └── PocketSuppressor.kt           P-056: proximity<3cm ∧ lux<10 ∧ moving
│   ├── alarm/
│   │   ├── LocalAlarmController.kt       STREAM_ALARM, no audio focus request
│   │   ├── TorchStrobe.kt
│   │   └── MedicalCardActivity.kt        showWhenLocked, 48pt coords, CALL 112
│   ├── transport/
│   │   ├── TransportDispatcher.kt        ★ parallel fan-out, void return
│   │   ├── SignedEnvelope.kt             Ed25519 over canonical protobuf
│   │   ├── HttpTransport.kt              dual endpoint: CF + direct
│   │   ├── WsTransport.kt                only if a warm socket already exists
│   │   ├── SmsTransport.kt               multi-SIM, ASCII encoder
│   │   └── BleMeshTransport.kt           advertise + scan + relay
│   ├── storage/
│   │   ├── DeviceProtectedConfig.kt      P-035: pre-unlock config
│   │   ├── BlackBoxRingBuffer.kt         mmap, pre-allocated, encrypted
│   │   └── IncidentLog.kt                append-only, pre-allocated reserve
│   ├── sensor/
│   │   ├── SensorFusionEngine.kt         FIFO batched, maxReportLatencyUs=30e6
│   │   └── FusionScorer.kt               ★ hand-written ~80 lines. NOT a model.
│   ├── health/
│   │   ├── WatchdogAlarmReceiver.kt      setExactAndAllowWhileIdle, 15 min
│   │   ├── BootReceiver.kt               directBootAware=true
│   │   ├── ShutdownReceiver.kt           Final Breath (P-022)
│   │   └── SelfDiagnostics.kt            weekly; 7 checks (P-031)
│   └── T0Bridge.kt                       the ONLY class Flutter may touch
├── dpc/                                  Device Owner controller
│   ├── KavachDeviceAdminReceiver.kt
│   └── DeviceOwnerConfigurator.kt
└── node/                                 spare-phone roles
    ├── CctvService.kt
    └── KioskActivity.kt
```

### 2.2.2 The platform-channel contract — 14 methods, hard-capped

The PRD caps this at 14 methods. Fixing the list prevents drift:

```kotlin
// MethodChannel "in.example.kavach/t0" — versioned protobuf payloads only
1  getIncidentState()          → IncidentStateProto
2  requestTrigger(source)      → Ack            // Flutter MAY request; never gate
3  cancelPending(pin)          → CancelResult   // constant-time; duress-aware
4  claimIncident(id)           → Ack
5  releaseIncident(id)         → Ack
6  getDiagnostics()            → DiagnosticsProto
7  runSelfCheck()              → DiagnosticsProto
8  getDegradationLevel()       → int 0..5
9  sealBlackBox(id)            → BlobHandle
10 getT0Config()               → T0ConfigProto  // read-only mirror
11 updateT0Config(proto)       → Ack            // policy push from server, verified
12 getBlackBoxManifest(id)     → ManifestProto
13 triggerFindPhone(deviceId)  → Ack
14 getPeerPresence()           → PeerListProto

// EventChannel: incident_state_stream, diagnostics_stream
```

**Rule R7 (▲ CHANGE — the PRD states this in prose; make it structural):** there is **no** method by which Flutter can *block, veto, delay, or gate* a T0 action. `requestTrigger` is a request; `cancelPending` requires the user's PIN and runs inside T0. If a method that could suppress T0 is ever proposed, it is rejected.

### 2.2.3 iOS — the honest capability envelope

The PRD's §6.3 matrix is accurate. Restated as an operational rule rather than a table:

| Role | Android | iOS |
|---|---|---|
| **Subject device** (someone who may need help) | ✅ Full T0 | ⚠️ **Degraded to the point of unreliability.** No Direct Boot, no force-quit survival, no programmatic SMS, no power-button gesture, no persistent agent guarantee. |
| **Responder device** (someone who receives alerts) | ✅ | ✅ **Fully capable** via PushKit → CallKit |

**Design consequence, stated as policy:** every family member's *primary* safety device SHOULD be Android. An iPhone user who insists gets a **BLE panic fob** (§14.4 — ~₹1,500, a weekend of firmware) which restores the trigger path independent of iOS entirely, and the gap is written into the family agreement.

**PushKit + CallKit is the load-bearing iOS technique.** Constraint: iOS revokes VoIP push privileges unless you report an incoming call to CallKit for *every* VoIP push. So the push must actually create a WebRTC audio session to the incident — which FR-024 wants anyway.

### 2.2.4 Flutter (T1/T2) layering

```
lib/
├── presentation/    PanicScreen · FamilyMap · IncidentTimeline · ConsentLedger
│                    Vault · Journeys · Diagnostics · ScreenTime · FloorPlan
├── state/           Riverpod 2; degradationLevelProvider(0..5) is global
├── domain/          pure Dart — policy MIRROR (read-only), geofence evaluation,
│                    journey prediction, risk-context presentation
├── data/            Drift/SQLCipher · Dio · WS client · outbox drain · cursor
└── isolates/        crypto · route prediction · media transcode
```

**Geofence evaluation lives here and never leaves (ADR-010).** `local_geofence` holds full precise coordinates in on-device SQLCipher and is **never synced**. A crossing emits only `{geofence_id: <opaque uuid>, transition: EXIT}` — Class B.

### 2.2.5 The panic UI — hard constraints (unchanged, restated as acceptance tests)

| Constraint | Test |
|---|---|
| Primary action ≥ 88 dp tall, full width | Automated screenshot assertion |
| Bottom third only, thumb-reachable one-handed on 6.7" | Layout test with a 6.7" device profile |
| Contrast ≥ 7:1, never colour alone | Automated contrast lint |
| ≤ 4 words per element, present tense — *"Getting help."* | String-length lint on the panic string bundle |
| No animation except the cancel countdown ring | Code review + a golden-frame diff test |
| Accelerating haptic on the cancel countdown | Manual, on the device matrix |
| **There is no error screen.** Network failure renders *"Sent by SMS"* or *"Alarm on — show this screen to anyone nearby"* + huge coordinates. Never a red ✗. | Test T-204 asserts no error string is reachable from the panic route |
| Full TalkBack/VoiceOver completion of the panic flow | Manual audit each release (NFR-019) |

---

## 2.3 The T0 datapath — trigger to transmit

**Latency budget for t0 → t2 is 500 ms.** Allocated:

```
t0  ── trigger registered (KeyEvent / BLE / sensor fusion) ─────────── 0 ms
     │
     ├─ PocketSuppressor.check()                                  ≤   5 ms
     ├─ StateMachine.transition(IDLE|WATCH → PENDING)             ≤   2 ms
     ├─ LocalAlarmController.prime()  (audio session, not sound)  ≤  20 ms
     ├─ BlackBoxRingBuffer.seal()     (mmap flip, async fsync)    ≤  30 ms
     ├─ Location: LAST KNOWN, never a fresh fix ★                 ≤   1 ms
     ├─ SignedEnvelope.build() + Ed25519 sign (StrongBox)         ≤  80 ms
     └─ TransportDispatcher.fanOut()  → returns immediately       ≤  10 ms
t1  ── cancel window (policy: 0–300 s, risk-context modulated) ────────
t2  ── first byte leaves the device on ≥1 transport ───────── total ≤ 150 ms ✅
```

**★ Critical rule (✚ ADDS):** the envelope uses the **last known location**, never a fresh GNSS fix. A cold GNSS fix takes 5–30 s and would blow the entire t2 budget. A fresh fix is streamed as a *subsequent* `LOCATION_UPDATE` event once acquired. Accuracy is carried in `accuracy_m` so the responder UI can show a confidence radius rather than a false pin.

### 2.3.1 Cancel window, PROBE, and duress — one constant-time path

```
                     PENDING
                        │
   ┌────────────────────┼────────────────────┐
   │                    │                    │
 correct PIN        duress PIN          window expires
   │                    │                    │
   ▼                    ▼                    ▼
FALSE_ALARM      ACTIVE_L1_SILENT        ACTIVE_L1
(local cancel)   (UI shows the           (full alarm)
                  IDENTICAL "cancelled"
                  screen; alarm silent;
                  telemetry full)
```

**Constant-time requirements (I-7, T-213):**
- PIN comparison uses a constant-time compare over both candidate PINs, **always both**, regardless of the first result.
- The UI transition is byte-identical between `FALSE_ALARM` and `ACTIVE_L1_SILENT`: same screen, same strings, same timing, same haptic.
- The network envelope is padded to a fixed size (§2.9.1) and dispatched on the **same schedule** in both cases — a real cancel sends a `CANCELLED` event of identical size at the same offset.
- Duress incidents permanently disable two-way audio (FR-003 / P-011).
- CI test: 1,000 runs of each path; assert the distributions of packet size and inter-packet timing are statistically indistinguishable (two-sample KS test, p > 0.05).

### 2.3.2 Black box

Fixed-size, **pre-allocated at install time** (P-043), mmap'd, encrypted, circular. 60 s rolling window of sensor data plus optional audio. Sealed on trigger by flipping a header pointer and scheduling an async fsync — the seal itself must never block the trigger path.

**Legal note (§20.2):** the audio buffer is **self-recording by the subject**, a materially different legal position from recording a conversation you are not party to. Keep it that way — never allow a guardian to enable another member's buffer.

---

## 2.4 Cryptographic architecture

### 2.4.1 ▲ CHANGE — phase the crypto (resolves F-08)

| | Phase 1 (weeks 1–16) | Phase 2+ |
|---|---|---|
| **Scheme ID** | `0x01 GROUPBOX` | `0x02 MLS` |
| Group key | Per-family static X25519, generated on the founding device | MLS TreeKEM epoch secrets |
| Distribution | `crypto_box_seal` to each enrolled device's identity pubkey at enrolment | MLS Welcome messages |
| Content | XChaCha20-Poly1305, keys HKDF'd from the group key + context | HKDF from the MLS exporter secret |
| Forward secrecy | ❌ | ✅ |
| Post-compromise security | ❌ | ✅ |
| Server sees | **Ciphertext only** — NFR-013 and I-3 satisfied from week one | Ciphertext only |
| Effort | ~3 days | 8–14 weeks |

`sealed_payload` carries a 1-byte scheme discriminator, so the migration is additive and old clients keep working (NFR-016 / P-060). Record this as **ADR-021** with a dated commitment; do not let "we'll do MLS later" become "we never did MLS."

**Why this is the right call:** the *server-side* threat model (T3, the reason E2EE exists here) is fully satisfied by GroupBox. What GroupBox lacks — forward secrecy and PCS — matters for T6 (a compromised family device), which is rated **LOW × HIGH** and is not the threat that blocks shipping. Meanwhile MLS on the critical path is the single most likely cause of never reaching the Phase 1 gate.

### 2.4.2 Key hierarchy (both phases)

```
HARDWARE ROOT — never leaves the secure element
├── Device Identity Key      Ed25519 · biometric-gated · normal auth
└── ★ Emergency Signing Key  Ed25519 · NOT biometric-gated
                             setUnlockedDeviceRequired(false), StrongBox
                             can ONLY sign IncidentOpen-shaped payloads
GROUP LAYER
└── Family Group Secret  (Phase 1: static X25519 | Phase 2: MLS epoch secret)
CONTENT KEYS — all derived, never transmitted
├── Incident Content Key   HKDF(group, "kavach-inc" ‖ incident_id)
├── Location Stream Key    HKDF(group, "kavach-loc" ‖ window_id)   ← 5-min windows
├── Media Key              per object, wrapped to the group
└── ★ VAULT KEY — INDEPENDENT, never derived from the group
                  Shamir 2-of-3 · different threat model, different key
```

**The critical detail the PRD gets right and most implementations get wrong:** you need **two** hardware keys. An unconscious person cannot provide a fingerprint. Gating the emergency key on biometrics builds a system that works only for conscious people — excluding exactly the people who need it most.
- Android: `setUserAuthenticationRequired(false)` + `setUnlockedDeviceRequired(false)` + StrongBox
- iOS: Keychain, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, **no** `SecAccessControl` biometric flag

### 2.4.3 ✚ ADDS — stream key derivation (resolves F-19)

```
window_id      = floor(unix_seconds / 300)
LSK            = HKDF-Expand(exporter_secret, "kavach-loc" ‖ window_id, 32)
sealed_coords  = XChaCha20Poly1305(LSK, nonce = counter_u64 ‖ device_id_prefix,
                                   plaintext = {lat, lon, alt, speed, heading},
                                   aad = {device_id, ts, family_id})
```

One group operation per 5 minutes; each of the up-to-300 location points in that window is a cheap AEAD. Identical construction for the Incident Content Key. This is what the PRD's `LK "ratcheted per 5-min window"` box means, made explicit.

### 2.4.4 ✚ ADDS — the MLS Delivery Service (resolves F-07, Phase 2)

MLS requires a **total order on Commits per group**. Assign it explicitly:

```
control-plane/identity implements the DS.

POST /v1/mls/commit
  body: { family_id, expected_epoch, commit, welcome? }

  BEGIN;
    SELECT current_epoch FROM family WHERE id = $1 FOR UPDATE;   -- serialises
    IF current_epoch != expected_epoch
      → 409 KV-2003 epoch_conflict  { server_epoch }             -- client re-syncs
    INSERT INTO mls_message(family_id, seq, kind, blob);          -- ordered log
    UPDATE family SET current_epoch = current_epoch + 1;
  COMMIT;
  → publish NATS fam.{id}.mls
```

```sql
CREATE TABLE mls_message (
    family_id   uuid NOT NULL REFERENCES family(id) ON DELETE CASCADE,
    seq         bigint NOT NULL,
    kind        text NOT NULL,          -- commit | welcome | proposal | keypackage
    epoch       int  NOT NULL,
    blob        bytea NOT NULL,         -- opaque; the server cannot read it
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (family_id, seq)
);
```

A device offline for months replays `mls_message` from its last `seq`. Without this table, a phone that misses epochs is permanently locked out of its own family's history.

**Key transparency (§10.3):** `mls_message` of kind `keypackage` **is** the append-only key-addition log. Clients verify inclusion of their own device and alert on any addition they did not initiate — this is the control that stops a compromised server silently adding a device to the group, the classic E2EE server attack.

### 2.4.5 ✚ ADDS — two-layer authorization (resolves F-14)

| Layer | Mechanism | Governs | Revocation latency |
|---|---|---|---|
| **1 — Metadata / routing** | OpenFGA + Postgres RLS | Who may *request* a stream, view incident metadata, receive a key-wrap | **< 1 s** (server-side, immediate) |
| **2 — Plaintext** | Cryptographic: stream-key ratchet + re-wrap to the reduced set | Who can actually *decrypt* | **Until the grantor's device is next online** |

The consent-ledger UI **must** show pending state honestly:

> *Revoked. Rohan can no longer request your location. Key rotation completes when your phone next connects — until then he cannot receive new location data, but he retains the key for points already delivered.*

Never claim a revocation is complete before the ratchet lands. Two properties RBAC cannot give you and this preserves:
1. **Purpose binding** — a grant made "for safety" cannot satisfy a "routine" check; the purpose is part of the decision and is logged.
2. **`can_view_reduced`** — neighbours get a structurally different view enforced by the authz layer, not by application `if` statements.

### 2.4.6 ✚ ADDS — Class A′, Degraded Survival Plaintext (resolves F-10)

| | Class A′ |
|---|---|
| Contents | Precise coordinates in an emergency SMS or BLE relay |
| Where it exists | On the wire (aggregator, carrier), in `sms-inbound` process memory |
| **Persisted?** | **Never.** Fan-out consumes it in memory; only `coarse_h3_r7` is written. |
| Durable copy | Re-uploaded **sealed** by the subject's own device on reconnect |
| Accountability | Every A′ event writes an `access_log` row surfaced to the subject: *"your precise location was sent unencrypted by SMS during incident X"* |
| Disclosure | The aggregator is named in the family agreement (§20.3) as a party that can see coordinates during an emergency |
| CI | Schema lint carries an explicit A′ allowlist, so I-3 stays machine-checkable |

This resolves the collision between "SMS must carry `lat,lon` as plain text" (P-051) and "zero Class-A plaintext at rest" (NFR-013) **without weakening either** — the invariant becomes *at rest*, and the transient exception is named, bounded, logged, and disclosed.

### 2.4.7 Break-glass — three layers (unchanged)

| Layer | Mechanism | Latency |
|---|---|---|
| 1 — Offline | NFC tag / QR sticker / lock-screen widget with a deliberately **plaintext** minimal card: blood group, top 3 allergies, top 3 medications, 2 ICE numbers, first name only | Instant; works for a stranger with no app and no network |
| 2 — Family | On incident open, the medical record is auto-rewrapped to the Incident Content Key; any family member reads it during an active incident with no unlock | < 1 s |
| 3 — Vault | Shamir 2-of-3 guardian reconstruction | Minutes, deliberate |

**✚ ADDS — vault reconstruction protocol.** Shares must never be assembled server-side. Requester broadcasts a `VAULT_UNLOCK_REQUEST`; each approving guardian seals their share to the *requester's device key*; the requester reconstructs locally. The server sees only sealed shares and an approval count. Drill this annually (§17.4) — the difference between an inconvenience and losing the family's medical history forever.

---

## 2.5 Backend services

### 2.5.1 `sos-ingest` — the critical binary

**Budget (CI-enforced ceiling):** ≤1000 LOC Go · ≤5 direct dependencies · **no DB read on the request path** · no ORM, no reflection, no templates · no shared code with the control plane · deployed ≤2×/year · own health check, own pipeline, own rollback.

```go
func (s *Server) HandleIncidentOpen(w http.ResponseWriter, r *http.Request) {
    body, err := io.ReadAll(io.LimitReader(r.Body, 8<<10))
    if err != nil { http.Error(w, "", 400); return }

    var req pb.IncidentOpen
    if err := proto.Unmarshal(body, &req); err != nil { http.Error(w, "", 400); return }

    // ▲ CHANGE (F-04): fail open, but only into a KNOWN family.
    // Unknown family_id = nobody to help = drop at the edge.
    fam, known := s.familyCache.Load(req.FamilyId)
    if !known { s.metrics.UnknownFamily.Inc(); http.Error(w, "", 404); return }

    // 1. Verify against the IN-MEMORY key cache. Never touch the DB.
    verified := false
    if pk, ok := s.keyCache.Load(req.DeviceId); ok {
        verified = ed25519.Verify(pk, canonical(&req), sigFromHeader(r))
    }
    if !verified {                        // ADR-018: FAIL OPEN
        req.Flags |= pb.Flag_UNVERIFIED
        s.metrics.UnverifiedIncidents.Inc()

        // ▲ CHANGE (F-04): bound the blast radius per FAMILY, not per device.
        // Beyond N concurrent unverified incidents in 60 s, COALESCE — never drop.
        if n := s.floodGuard.Observe(req.FamilyId); n > 3 {
            req.Flags |= pb.Flag_UNVERIFIED_FLOOD
            req.IncidentId = fam.CoalesceTargetFor(req.FamilyId)
        }
    }

    // 2. Durability BEFORE acknowledgment. fsync the WAL.
    if err := s.wal.AppendSync(body); err != nil {
        s.log.Error("wal_append_failed", "err", err)   // still try NATS
    }

    // 3. Publish. At-least-once; consumers dedupe on (incident_id, hlc).
    _ = s.nats.Publish("fam."+req.FamilyId+".incident", body)

    // 4. Respond with the server timestamp — "help is on the way" is itself
    //    a safety feature.
    w.Header().Set("Content-Type", "application/x-protobuf")
    w.WriteHeader(200)
    _ = writeProto(w, &pb.IncidentAck{
        IncidentId: req.IncidentId,
        ServerTsMs: uint64(time.Now().UnixMilli()),
        Verified:   verified,
    })
}
```

**✚ ADDS (F-22) — cache durability.** Persist `keyCache` and `familyCache` to a local `cache.pb` on every 60-minute refresh and load it at boot **before** serving. A restart during a Postgres outage then starts warm instead of flagging everything `UNVERIFIED`. ~15 lines, zero new dependencies.

**Refresh:** a background goroutine reloads all device public keys every 60 minutes and on a NATS `device.key.changed` message. If Postgres is unreachable the cache goes stale — incidents keep flowing.

### 2.5.2 `realtime-gw`

One goroutine pair per connection. Resumable sessions via `?cursor=<hlc>`: replay from the NATS durable stream, then go live. Presence in Valkey, 45 s TTL, heartbeat-refreshed.

**▲ CHANGE (F-16) — connect tickets, not query-string tokens:**
```
POST /v1/rt/ticket        (bearer auth)  → { ticket, expires_in: 60 }
wss://rt.…/v1/stream?cursor=<hlc>
    Sec-WebSocket-Protocol: kavach.v1, ticket.<opaque>
```
Single-use, 60 s TTL, bound to `device_id`. The resulting session outlives access-token expiry and is killed by an explicit `session.revoke` NATS event. Nothing sensitive ever enters a URL (I-6).

**Backpressure priority — a correctness rule, not a performance one:**
```go
select {
case conn.send <- frame:
default:
    switch frame.Priority {
    case CRITICAL:  // state transitions, CLAIM, RELEASE, escalation
        // NEVER drop. Block up to 5 s, then force a full resync.
        // A dropped state transition means a responder's phone still thinks
        // the incident is unclaimed. That is a correctness bug.
        blockOrResync(conn, frame)
    case HIGH:      // messages, alerts
        conn.overflow.Push(frame)     // bounded queue, 200 items
    case LOW:       // location, presence, battery
        conn.coalesce(frame)          // keep only the LATEST per key
    }
}
```
Coalescing location is correct: a client 40 frames behind wants the *newest* position, not a replay of a 40-second-old track.

### 2.5.3 `control-plane` — 11 modules

| Module | Responsibility |
|---|---|
| `identity` | Passkeys, device enrolment, attestation, key-cache publication, **MLS Delivery Service** (§2.4.4) |
| `family` | Membership, roles, invites, autonomy ramp, temporary members |
| `policy` | Escalation policies, versioning, distribution to devices |
| `escalation` | Durable timers, ladder execution, ACK tracking, ownership, watchdog |
| `notify` | Channel orchestration (FCM, APNs, PushKit, SMS, voice), delivery receipts, **spend ceiling** |
| `vault` | Encrypted blob custody, Shamir share coordination |
| `journey` | Trips, ETAs, corridors, check-ins, dead-man timers |
| `automation` | Rules, schedules, HA bridge ingest, IMD alerts |
| `report` | After-action generation, four-clock metrics, drill scorecards |
| `consent` | Grant ledger, access logging, surfacing job, revocation |
| `device` | Heartbeats, health, diagnostics ingest, gap detection |

**Boundary enforcement (I-12):** a CI import-graph test fails the build if e.g. `vault` imports `journey`. Cross-module calls go through consumer-defined interfaces or NATS events. This is what lets a module be extracted into its own binary in 2029 without a rewrite.

### 2.5.4 Escalation engine — durable timers

**Do not use `time.AfterFunc`. Do not use cron.** Timers must survive restarts, deploys, and crashes.

```sql
SELECT id, incident_id, action, target_tier, policy_version
FROM escalation_timer
WHERE fire_at <= now() AND state = 'pending'
ORDER BY fire_at
FOR UPDATE SKIP LOCKED
LIMIT 100;
```

**▲ CHANGE (F-13):** **no leader election** — `FOR UPDATE SKIP LOCKED` exists so you don't need one, and a lost leader stalls every timer. N stateless workers. Replace the unconditional 250 ms poll with `LISTEN/NOTIFY` on insert + an adaptive poll (250 ms when a timer is due within 5 s, 2 s otherwise): same latency, ~90% fewer queries.

It is boring, debuggable, survives everything, and **you can inspect pending escalations with a `SELECT` at 3 a.m.** — which you will need to do.

### 2.5.5 The incident state machine — one YAML, three targets

**▲ CHANGE (F-23b):** the generator emits **Kotlin, Swift, and Go** from `spec/state-machine.yaml`. The PRD says "twice"; it is three.

```yaml
# spec/state-machine.yaml — the single source of truth
version: 3
states: [IDLE, WATCH, SUSPECT, PROBE, PENDING, FALSE_ALARM,
         ACTIVE_L1, ACTIVE_L1_SILENT, ACTIVE_L2, ACTIVE_L3,
         OWNED, RESOLVING, RESOLVED, DORMANT]      # ✚ DORMANT — see F-02
transitions:
  - { from: IDLE,     to: WATCH,   on: CONTEXT_ELEVATED }
  - { from: IDLE,     to: SUSPECT, on: SENSOR_ANOMALY }
  - { from: WATCH,    to: SUSPECT, on: SENSOR_ANOMALY, guard: lower_threshold }
  - { from: SUSPECT,  to: PROBE,   on: CONFIDENCE, guard: "0.4 <= c < 0.7" }
  - { from: SUSPECT,  to: PENDING, on: CONFIDENCE, guard: "c > 0.7" }
  - { from: PROBE,    to: IDLE,    on: USER_FINE }
  - { from: PROBE,    to: PENDING, on: TIMEOUT, after_s: 45 }
  - { from: IDLE,     to: PENDING, on: MANUAL_TRIGGER }
  - { from: PENDING,  to: FALSE_ALARM,       on: PIN_CORRECT }
  - { from: PENDING,  to: ACTIVE_L1_SILENT,  on: PIN_DURESS }   # constant-time twin
  - { from: PENDING,  to: ACTIVE_L1,         on: CANCEL_WINDOW_EXPIRED }
  - { from: ACTIVE_L1, to: ACTIVE_L2, on: NO_ACK, after_s: 90 }
  - { from: ACTIVE_L2, to: ACTIVE_L3, on: NO_ACK, after_s: 180 }
  - { from: [ACTIVE_L1, ACTIVE_L2, ACTIVE_L3], to: OWNED, on: CLAIM }
  - { from: OWNED,    to: ACTIVE_L2, on: RELEASE }
  - { from: OWNED,    to: ACTIVE_L2, on: PROGRESS_WATCHDOG, after_s: 300 }
  - { from: OWNED,    to: RESOLVING, on: ON_SCENE }
  - { from: RESOLVING, to: RESOLVED, on: TWO_PARTY_CONFIRM }
  - { from: ACTIVE_L1, to: RESOLVED, on: SELF_CLEAR_PIN }
  - { from: [ACTIVE_L1, ACTIVE_L2, ACTIVE_L3, OWNED],
      to: DORMANT, on: AUTO_QUIESCE, after_s: 21600 }            # ✚ 6 h
```

**Requirements:**
- Both implementations must pass the **same fixture set** generated from the YAML. Divergence between the Kotlin and Go machines is a class of bug you cannot afford.
- Every transition writes an `incident_event` row stamped with `policy_version`.
- `incident.state` is a **materialised projection**, recomputable at any time by folding the event log. If it is ever wrong, recompute it.

### 2.5.6 Per-scenario escalation policies (unchanged — data, not code)

| Scenario | Detection | Cancel | L1 audience | L2 at | Notes |
|---|---|---|---|---|---|
| Manual panic | Gesture | 10–30 s | All family + live audio | 90 s | Audio on by default |
| Two-wheeler crash | >4 g ∧ no motion 10 s ∧ speed drop | 20 s, loud | All family, type CRASH | 60 s | Black box sealed; helmet-beacon state attached |
| Fall (elder) | Accel signature ∧ no motion 30 s | 45 s, very loud | Primary caregiver, then all | 120 s | Voice-call the elder first; check for confusion |
| Medical (self-reported) | Manual + category | 0 s | Family + medical record | 60 s | Nearest hospital surfaced; no audio unless requested |
| Home emergency | HA smoke/gas/water | 60 s (high FP) | Everyone home **and** away | 180 s | Auto-unlock locks; cut gas |
| Child geofence breach | On-device geofence + no response | **5 min** | Guardians only | **never** neighbours | Deliberately the slowest, quietest policy |
| Dead-man / missed check-in | Timer | 15 min | Designated contact only | 30 min | Phone call first |
| Device silenced (P-022) | ACTION_SHUTDOWN during WATCH | 0 s | All family | 60 s | Escalating, **not** terminal |
| Missing device | No heartbeat ∧ no location | 4 h | Owner, then family | — | Not an emergency unless correlated |
| Disaster (IMD) | External feed | n/a | All: "Are you safe?" | — | Inverts the model: system asks, humans answer |

---

## 2.6 The real-time alert pipeline

### 2.6.1 End-to-end sequence with budget allocation

```
DEVICE                    INGEST           NATS      CONTROL PLANE        RESPONDER
  │ t0 trigger
  │──── ≤150 ms ────────►│
  │  (parallel: WS, HTTP-CF, HTTP-direct, SMS, BLE)
  │                       │ fsync WAL  ≤15 ms
  │◄──── IncidentAck ─────│           (client shows "help is on the way")
  │                       │──publish──►│
  │                                    │──► escalation.OnIncidentOpen   ≤20 ms
  │                                    │      · arm L2 timer @ +90 s
  │                                    │      · arm repeat-L1 @ +30 s
  │                                    │      · arm SMS-tier @ +60 s
  │                                    │──► notify.Fanout               ≤50 ms
  │                                    │      · FCM data (high priority)
  │                                    │      · APNs alert
  │                                    │      · PushKit VoIP → CallKit
  │                                    │      · WS frame (foreground devices)
  │                                    │──► realtime-gw broadcast       ≤10 ms
  │                                                          ──────────────►│ t3
  │                                                    ≈ 1–3 s wire+push    │
  │                                                                         │ ring
  │◄─────────────────── CLAIM (t4) ─────────────────────────────────────────│
  │                                    │ ladder HALTS, ownership broadcast
```

**Budget:** t3 p95 < 5 s (NFR-002). Server-side work is ~100 ms; the remaining ~4.9 s is FCM/APNs wire time, which you do not control. **This is why the SMS tier exists and why the canary measures the whole chain rather than your service's latency.**

### 2.6.2 The ladder (unchanged)

```
T+0s     L1 SIMULTANEOUS BLAST — FCM data + APNs + ★PushKit→CallKit★ +
         Live Activity / ongoing notification + Wear/watchOS haptic
T+30s    No ACK → REPEAT L1, louder, different tone
         (Humans genuinely miss the first one. Do not skip this step.)
T+60s    No ACK → SMS to all L1 members
         Independent of your infra AND of Google/Apple.
         Rides satellite NTN transparently where the carrier supports it.
T+90s    No ACK → L2: trusted neighbours (reduced detail) + extended
         relatives + automated TTS voice call to the primary contact
T+180s   No ACK → L3: TTS voice calls to ALL in parallel; full-screen
         CALL 112 on every device; subject device at max alarm
ANY TIME First CLAIM → ladder HALTS. Others switch siren → persistent
         quiet banner (NOT silence — P-030 correction 1).
```

### 2.6.3 Getting through Do Not Disturb (P-055 — the most common real-alert miss)

| Platform | Mechanism | Reality |
|---|---|---|
| iOS Critical Alerts | `UNNotificationSound.defaultCriticalSound` | Requires an Apple-granted entitlement. **Genuinely hard for a private app.** Apply anyway; have plan B. |
| **iOS PushKit + CallKit** | VoIP push → incoming-call UI | ★ **Plan B, and it is excellent.** Rings through silent and Focus with no entitlement. |
| Android full-screen intent | `USE_FULL_SCREEN_INTENT` | Restricted since Android 14 to calling/alarm-category apps; auto-granted for those. |
| Android DND bypass | Channel `setBypassDnd(true)` | Requires `ACCESS_NOTIFICATION_POLICY`; obtain at onboarding. |
| Android alarm stream | `STREAM_ALARM` | Plays at alarm volume regardless of ringer state. Underused, highly effective. |

**✚ ADDS (F-21) — notification content policy.** Push payloads are **data-only, Class B/C exclusively**: `{incident_id, family_id, trigger, tier, subject_short_name}`. The device composes human-readable text locally from decrypted state. iOS uses a **Notification Service Extension** with keychain access to decrypt before display. Lock-screen preview shows short name + trigger class only.

### 2.6.4 Responsibility transfer (P-003, P-030)

```
BROADCAST ──► every recipient sees "⚠️ NOBODY HAS RESPONDED YET"
    │          (deliberate copy: creates individual responsibility
    │           instead of diffusing it)
    ├─ first CLAIM ──► CLAIMED  "Rohan is responding. Stand by."
    │                            siren → persistent quiet banner
    │                     │
    │                     ├─ owner taps "I can't get there" ──┐
    │                     ├─ progress watchdog: 5 min, no ────┤──► RECLAIMED
    │                     │  movement, no messages            │      │
    │                     └─ responder confirms arrival ──► ONSCENE  │
    └◄─────────────── re-broadcast, urgent ────────────────────────┘
```

The `RECLAIMED` transition is essential. Without it, one person claims, gets stuck in traffic, and everyone else has stood down permanently.

**Fan-out of CLAIM goes over BOTH channels simultaneously** — WebSocket (instant, foreground) **and** FCM/APNs data (backgrounded devices). Never rely on only one; a backgrounded device may have no WS.

### 2.6.5 Why the system never auto-dials 112 (ADR-019)

1. **Legal/ethical:** false auto-dials consume finite public emergency capacity; in aggregate a buggy app harms *other people's* emergencies.
2. **Technical:** you cannot reliably place an emergency call programmatically, and wrapping one risks breaking **AML** — the very thing that makes the 112 call useful.
3. **Practical:** a silent 112 call with no speaker is often deprioritised. A family member who calls **and can describe the situation** produces a dramatically better dispatch outcome.

Instead: at L3, a full-screen 88 dp **CALL 112** button on every family device with coordinates pre-formatted for reading aloud. One tap. Then get out of the way.

---

## 2.7 Transport ladder & the parallel dispatcher

### 2.7.1 The degradation ladder (L0–L5)

```
L0  ZERO INFRASTRUCTURE      "Nothing works. Still helps."
    100 dB alarm on STREAM_ALARM · torch strobe · medical card full screen
    lat/long in 48 pt · one-tap CALL 112 · NFC/QR medical passport
L1  PEER ONLY                "No towers. Family is near."
    BLE distress advert (rotating pseudonym + HMAC) · family relay · Wi-Fi Direct
L2  SMS ONLY                 "1 bar. Data dead. SMS still goes."
    ≤160-char pure-ASCII payload → family numbers AND the SMS gateway
    ★ rides satellite NTN transparently where the carrier supports it ★
L3  PUSH ONLY                "Our server is down. Google is up."
    Device-to-device via FCM/APNs data push using cached tokens
L4  HTTP ONLY                "WebSocket blocked by proxy / portal."
L5  FULL FIDELITY            "Everything works."

★ L1–L4 fire IN PARALLEL, not in sequence. Five redundant messages cost
  ₹1.20. Sequential fallback costs 45 seconds. You are racing a clock.
```

### 2.7.2 Dispatcher (▲ CHANGE — adds the Cloudflare-bypass leg, F-05)

```kotlin
// T0/transport/TransportDispatcher.kt — returns Unit. Nothing awaits it.
fun fanOut(env: SignedEnvelope, level: DegradationLevel) {
    val legs = buildList {
        if (wsWarm)                add(WsTransport)            // free if already open
        add(HttpTransport(CF_ENDPOINT))                        // api.kavach.example
        add(HttpTransport(DIRECT_ENDPOINT))   // ★ bypasses Cloudflare entirely
        add(BleMeshTransport)                                  // always; costs nothing
        if (level >= SMS_ONLY || !ackedWithin(15_000))
            add(SmsTransport)                 // all active SIMs, in parallel
    }
    legs.forEach { scope.launch { runCatching { it.send(env) } } }  // no join
}
```

Two independent DNS names, two independent TLS chains, two pinned key sets. One duplicate request per incident; the server deduplicates on `incident_id`.

### 2.7.3 Connectivity detection (P-046 — captive portals lie)

```kotlin
suspend fun realConnectivity(): DegradationLevel {
    val caps = cm.getNetworkCapabilities(cm.activeNetwork)
    if (caps?.hasCapability(NET_CAPABILITY_INTERNET) != true) return SMS_ONLY
    val validated = caps.hasCapability(NET_CAPABILITY_VALIDATED)
    val probeOk = withTimeoutOrNull(1000) { httpHead("$BASE/healthz") } != null  // cached 30 s
    return when {
        !validated || !probeOk -> SMS_ONLY        // captive portal
        wsConnected            -> FULL
        else                   -> HTTP_ONLY
    }
}
```
**Never trust `NetworkCapabilities` alone.** Hotel Wi-Fi reports "connected" and blocks everything.

### 2.7.4 Multi-SIM SMS (P-033)

```
order = [user-preferred subId] → [system default] → [every other active SIM]
during a REAL incident: send on ALL of them immediately.
```
- You **cannot** query SIM balance programmatically. Do not try to be clever; ₹0.40 is not a consideration.
- Use the `sentIntent` / `deliveredIntent` `PendingIntent` callbacks and log result codes. `RESULT_ERROR_GENERIC_FAILURE` on one SIM is your signal to rely on the other.
- **Encoding is a trap:** one Devanagari or Gujarati character converts GSM-7 → UCS-2 and drops the limit from 160 to **70**. The payload MUST be pure ASCII; names transliterated (`Priya`, not `प्रिया`). Enforced by unit test (I-2).
- eSIM behaves identically through `SubscriptionManager` but can be remotely disabled by a carrier — do not treat it as more reliable than physical.

### 2.7.5 SMS payload (verified: 154 ≤ 160 ✅)

```
K1|<inc8>|<name8>|<type>|<lat>,<lon>|<acc>|<bat>|<ts>|<sig8>
K1      2   protocol version
inc8    8   first 8 chars of incident UUID, base36
name8   8   transliterated ASCII first name (UNIQUE per family — F-18)
type    3   SOS|CRA|FAL|MED|DED|SAF
lat,lon 21  6 decimal places
acc     4   accuracy metres
bat     3   battery percent
ts      7   unix seconds, base36
sig8    8   first 8 chars of HMAC-SHA256, base64url
seps   ~20
       ─────
        84  + ~70 human-readable tail = ~154
"PRIYA NEEDS HELP. Crash detected. 20.945123,72.932011 Open maps."
```
The tail deliberately **repeats** the coordinates as plain text — carriers strip and filter links (P-051), so the raw `lat,lon` pair is the payload and the link is a convenience.

**Two destinations, always both:** (1) directly to each family member's number — works with **zero server involvement**; (2) to the aggregator's inbound number, which becomes a server-side incident and fans out to everyone including people whose numbers are not hardcoded.

**DLT scope (F-23f):** device → family-number SMS is **P2P from the user's own SIM and is not subject to DLT**. Only the server → family fan-out (and the aggregator inbound leg) is A2P and needs registered headers and templates. Start registration in week 1 — it takes 1–2 weeks and blocks the Phase 1 fan-out, but it does **not** block the T0 direct path.

---

## 2.8 Data model

### 2.8.1 Core (PRD schema, retained)

`family`, `member`, `device`, `incident`, `incident_event`, `escalation_timer`, `notification`, `delivery_attempt`, `consent_grant`, `access_log`, `location_point` (hypertable), `device_heartbeat` (hypertable). Tenancy: `family_id` on **every** table; every query filters on it. Costs nothing now; enables sharding and federation later with no migration.

### 2.8.2 ▲ CHANGES to the PRD schema

```sql
-- F-18: short names must be unambiguous in an SMS read at 2 a.m.
ALTER TABLE member
  ADD CONSTRAINT member_short_name_unique
  UNIQUE (family_id, lower(ascii_short_name));

-- F-09 + F-02: SMS reconciliation and auto-quiesce
ALTER TABLE incident
  ADD COLUMN inc8               text,        -- base36 prefix, for SMS matching
  ADD COLUMN synthetic_from_sms boolean NOT NULL DEFAULT false,
  ADD COLUMN merged_into_id     uuid REFERENCES incident(id),
  ADD COLUMN auto_quiesce_at    timestamptz;
CREATE INDEX ON incident (family_id, inc8) WHERE inc8 IS NOT NULL;

-- F-02: the deploy-freeze query must ignore drills and dormant incidents
CREATE OR REPLACE VIEW active_incident_v AS
  SELECT * FROM incident
  WHERE (state LIKE 'ACTIVE%' OR state IN ('OWNED','RESOLVING','PENDING'))
    AND NOT is_drill
    AND merged_into_id IS NULL;
```

### 2.8.3 ✚ NEW tables

```sql
-- F-07: MLS Delivery Service ordered log (Phase 2; harmless to create now)
CREATE TABLE mls_message (
    family_id  uuid   NOT NULL REFERENCES family(id) ON DELETE CASCADE,
    seq        bigint NOT NULL,
    kind       text   NOT NULL,   -- commit | welcome | proposal | keypackage
    epoch      int    NOT NULL,
    blob       bytea  NOT NULL,   -- opaque to the server
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (family_id, seq)
);
ALTER TABLE family ADD COLUMN current_epoch int NOT NULL DEFAULT 0;

-- F-15: crypto-shredding is the erasure mechanism for an append-only log
CREATE TABLE content_key (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id    uuid NOT NULL REFERENCES family(id) ON DELETE CASCADE,
    subject_member_id uuid REFERENCES member(id),
    scope        text NOT NULL,        -- incident | media | vault_object
    scope_ref    uuid NOT NULL,
    wrapped_key  bytea NOT NULL,       -- wrapped to the group; server cannot use it
    shredded_at  timestamptz           -- ★ erasure = DELETE this row ★
);
CREATE INDEX ON content_key (family_id, scope, scope_ref);

-- F-04: hard spend ceiling; breach is a P0 page
CREATE TABLE notify_budget (
    family_id     uuid PRIMARY KEY REFERENCES family(id) ON DELETE CASCADE,
    month         date NOT NULL,
    sms_sent      int  NOT NULL DEFAULT 0,
    voice_seconds int  NOT NULL DEFAULT 0,
    sms_ceiling   int  NOT NULL DEFAULT 2000,
    breached_at   timestamptz
);

-- Drill orchestration, so canaries never touch the family (F-03)
CREATE TABLE drill_run (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id            uuid NOT NULL REFERENCES family(id),
    kind                 text NOT NULL,   -- canary | quarterly | annual_full
    notifies_family      boolean NOT NULL DEFAULT false,
    audience_device_ids  uuid[] NOT NULL DEFAULT '{}',
    started_at           timestamptz NOT NULL DEFAULT now(),
    scorecard            jsonb
);
```

### 2.8.4 Append-only enforcement (retained — do not remove)

```sql
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'incident_event is append-only'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER incident_event_immutable
  BEFORE UPDATE OR DELETE ON incident_event
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
```

### 2.8.5 On-device SQLite (SQLCipher)

| Table | Purpose | Note |
|---|---|---|
| `incident`, `incident_event` | Mirror of server, own family only | **Source of truth** for own incidents |
| `outbox` | Every unsent mutation, per-transport attempt counters | Drains on connectivity |
| `inbox_cursor` | Server stream position | Enables resumable sync |
| `local_geofence` | **Full precise coordinates** | ★ **NEVER synced** (ADR-010) |
| `blackbox_ring` | Fixed-size, pre-allocated, mmap'd, encrypted | Circular; sealed on trigger |
| `policy_cache` | Full escalation policy | So T0 escalates correctly with no network |
| `peer_keys` | Family device public keys | Offline BLE HMAC verification |
| `t0_config` | **Device Protected Storage** copy of minimal config | P-035 |
| `diagnostics` | Local self-check history | P-031 |

### 2.8.6 Retention & erasure

| Data | Retention | Configurable by | Erasure mechanism |
|---|---|---|---|
| Location points | 90 days | Each member, own data | TimescaleDB retention policy |
| Incident events | Indefinite | Family (2-of-3 to delete) | **Crypto-shred** `content_key` (F-15) |
| Device heartbeats | 400 days | — | DPDP Rule 6 one-year log floor |
| Delivery attempts | 400 days | — | Same |
| Access log | 400 days | — | Same — this is the accountability record |
| Media | 30 days post-resolution | Family | Delete object + shred key |
| CCTV frames | 7 days | Family | Delete object + shred key |
| Screen-time data | 90 days | **The person themself** | Their data, their call |

### 2.8.7 Defence in depth

```sql
ALTER TABLE incident       ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_point ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_grant  ENABLE ROW LEVEL SECURITY;
CREATE POLICY family_isolation ON incident
  USING (family_id = current_setting('app.family_id')::uuid);
-- repeat for every RLS-enabled table
```
RLS sits **behind** OpenFGA, not instead of it.

---

## 2.9 API contract

### 2.9.1 ▲ CHANGE — the critical-path protobuf (resolves F-01)

```protobuf
syntax = "proto3";
package kavach.v1;

message IncidentOpen {
  bytes    incident_id     = 1;   // UUIDv7, CLIENT-generated → idempotency
  bytes    family_id       = 2;
  bytes    device_id       = 3;
  uint64   client_ts_ms    = 4;
  bytes    hlc             = 5;   // 48-bit physical ‖ 16-bit logical ‖ 48-bit node
  Trigger  trigger         = 6;
  uint32   confidence_pct  = 7;
  uint32   risk_context    = 8;   // 0–4, opaque integer
  bytes    sealed_payload  = 9;   // scheme byte ‖ ciphertext. Server cannot read.
  string   coarse_h3_r7    = 10;  // ≈1 km cell. Routing only.
  uint32   battery_pct     = 11;

  // ★ F-01 FIX: `optional` gives EXPLICIT FIELD PRESENCE, so the field is
  //   emitted on the wire even when false. A plain proto3 `bool` omits false
  //   entirely, making duress messages 2 bytes larger — which defeats the
  //   entire constant-size argument in §9.3 of the PRD.
  optional bool duress     = 12;

  uint32   policy_version  = 13;
  bool     is_drill        = 14;
  uint32   flags           = 15;
  bytes    padding         = 16;  // ★ pad to a FIXED total size, computed AFTER
                                  //   a trial serialisation ★
}

enum Trigger {
  TRIGGER_UNSPECIFIED = 0; MANUAL = 1; FALL = 2; CRASH = 3; NO_MOTION = 4;
  DEADMAN = 5; GEOFENCE = 6; SENSOR_HOME = 7; DEVICE_SILENCED = 8;
  BLE_FOB = 9; VOICE_PHRASE = 10; RELAY = 11; DRILL = 12;
}

message IncidentAck { bytes incident_id = 1; uint64 server_ts_ms = 2; bool verified = 3; }
```

**Padding algorithm (must be specified, or it will be done wrong):**
```
1. Set padding = empty. Serialise. Measure n.
2. target = FIXED_ENVELOPE_SIZE (512 bytes)
3. Set padding = zeros(target − n − varint_overhead(target − n))
4. Re-serialise. Assert len == target. Fail closed on assertion — a
   mis-padded envelope leaks the duress bit.
```

### 2.9.2 Endpoints

**Critical path — `sos-ingest` (separate binary, separate host, dual endpoint):**

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/v1/incident/open` | Signed envelope | Idempotent on `incident_id`. **Fails open into a known family.** |
| POST | `/v1/incident/append` | Signed envelope | Append an event |
| POST | `/v1/incident/relay` | Signed envelope | BLE peer relay; carries the **original** signature and HLC |
| POST | `/v1/incident/sms-inbound` | Gateway shared secret | Aggregator webhook; A′ handling (§2.4.6), `inc8` resolution (§2.10.2) |
| GET | `/healthz` | none | Canary liveness |

**Auth (critical path):** `X-Device-Id` + `X-Sig` (Ed25519). **No bearer token. No expiry.** The SOS endpoint does not accept bearer tokens at all — this is the fix for P-007, a bug class that has killed people in production systems.

**Control plane:** `/v1/auth/passkey/*`, `/v1/devices*`, `/v1/family*`, `/v1/incidents*` (list, get, claim, release, resolve, classify, after-action), `/v1/policies/current`, `/v1/consents*`, `/v1/journeys`, `/v1/checkins`, `/v1/find-phone/{device_id}`, `/v1/drills`, `/v1/vault/objects`, `/v1/ha/events`, `/internal/active-incidents`.
**✚ ADDS:** `POST /v1/rt/ticket` (F-16), `POST /v1/mls/commit` (F-07).

**Conventions:** `/v1` frozen and additive-only · JSON for the control plane, protobuf for the critical path · `Idempotency-Key` on all mutating endpoints · RFC 7807 `application/problem+json` errors · RFC 3339 UTC, HLC for ordering.

### 2.9.3 Error codes

| Code | HTTP | Meaning | Client behaviour |
|---|---|---|---|
| `KV-1001` | 400 | Malformed protobuf | Log; do not retry; **fall back to SMS** |
| `KV-1002` | 401 | Bad signature | **Retry anyway with `flags=UNVERIFIED`.** Never block an SOS. |
| `KV-1003` | 409 | Duplicate incident | **Success.** Treat as 200. |
| `KV-1004` | 413 | Payload too large | Strip the black box; retry minimal |
| `KV-1005` | 429 | Rate limited | Never applied to a family's first incident. Backoff. |
| `KV-2001` | 403 | Consent grant expired/revoked | Show the reason; offer renewal |
| `KV-2002` | 403 | Purpose mismatch | Show which purpose the grant covers |
| **`KV-2003`** | 409 | **MLS epoch conflict** ✚ | Re-fetch `mls_message`, re-apply, retry the commit |
| `KV-5001` | 503 | Downstream unavailable | **Immediately escalate to the next transport tier** |

---

## 2.10 Degraded-mode and edge-case handling

### 2.10.1 Direct Boot (P-035 — a silent multi-hour outage most implementations ship)

Two storage contexts. Know which one you are in.

```kotlin
val deviceCtx = context.createDeviceProtectedStorageContext()  // available PRE-unlock
val credCtx   = context                                        // POST-unlock only
```

**Device Protected Storage holds exactly this and nothing more:**
emergency contact numbers (ASCII) · escalation policy snapshot (~4 KB JSON) · device signing key **alias** (the key itself is in StrongBox) · family peer public-key fingerprints (for BLE HMAC) · last known location.
Everything else — messages, medical records, vault — stays credential-protected.

**Consequence:** after a 2 a.m. reboot the agent is alive, can detect a fall, can sound the alarm, and can send SMS — **without anyone unlocking the phone.**

**✚ ADDS (F-17):** record `t0_signing_available_predawn` in `device.diagnostics` so an OEM regression that breaks Keystore access in Direct Boot becomes a Dashboard-1 line rather than a discovery during an emergency. The system degrades correctly regardless (fail-open + DPS-held HMAC for SMS).

### 2.10.2 ✚ ADDS — SMS reconciliation protocol (resolves F-09)

```
WHEN a device has any data path:
    PUT valkey  inc8:{family_id}:{inc8} = full_incident_id   TTL 24h

WHEN POST /v1/incident/sms-inbound arrives:
  1. Resolve family_id from the sender MSISDN (member.phone_e164, unique).
  2. Verify sig8 = HMAC-SHA256(family_group_hmac_key, payload)[0:8].
     ★ Fail open (ADR-018): a bad HMAC is flagged, not dropped.
  3. Look up inc8 in Valkey.
       HIT  → append to the existing incident. Done. No duplicate.
       MISS → incident_id = UUIDv5(NS_KAVACH, family_id ‖ inc8 ‖ floor(ts/300))
              synthetic_from_sms = true
              (deterministic ⇒ a SECOND SMS with the same inc8 maps to the
               same incident rather than creating a third)
  4. Class A′ handling (§2.4.6):
       · precise lat/lon → fan-out IN MEMORY ONLY
       · persist coarse_h3_r7 only
       · write an access_log row surfaced to the subject
  5. RECONCILIATION: when the device reconnects and posts the real incident,
     a job matches on (family_id, inc8) within 24 h, sets
     merged_into_id on the synthetic row, and emits INCIDENT_MERGED.
```

### 2.10.3 ▲ CHANGE — BLE mesh (resolves F-11, F-12)

**Advertisement (31-byte legacy budget, now actually fitting):**
```
Non-connectable, undirected advertising → Android omits the Flags AD.
No separate Service-UUID AD; the 2-byte company identifier is the discriminator.

  1  byte   AD length
  1  byte   AD type = 0xFF (Manufacturer Specific Data)
  2  bytes  company identifier
 ─────────
 27  bytes  available for payload; we use 24:
   1  version + flags        (the duress bit is NOT advertised separately)
   8  incident_id prefix
   1  risk / severity
   6  coarse position, H3 r9 packed
   8  HMAC-SHA256 truncated, keyed with the family group secret
 ─────────
 31  bytes total ✅  (3 bytes headroom)
```

**Pseudonym:** `HMAC(group_secret, floor(unix_time / 900))`.
**▲ CHANGE:** scanners accept windows `{n−1, n, n+1}` — three HMAC comparisons — so clock skew across a 15-minute boundary cannot make family devices invisible to each other at the exact moment one is in distress (P-052).
**Honest privacy note:** the pseudonym is family-wide, so a persistent local observer can detect "a Kavach family device is present" and correlate that family within a window. Accepted trade-off; disclose it in the family agreement.

**Battery:** 10% duty cycle in IDLE (scan 3 s / 30 s) with `SCAN_MODE_LOW_POWER` and a **hardware-offloaded** `ScanFilter`, so the app is never woken for non-matching adverts. Continuous only when risk context is elevated or a family member is in WATCH.

**Relay flow:**
```
Phone in distress (no cellular) ──BLE ADV every 2 s──► Brother's phone, 40 m, 4G
  Brother's phone verifies the HMAC → authentic family distress
  Becomes a SILENT relay. He is NOT notified yet.
  POST /v1/incident/relay (signed, over 4G, ORIGINAL signature + HLC preserved)
  Server dedupes by incident_id; source_transport = ble_relay
  Full fan-out: "relayed via Rohan's device"
  ★ NOW notify Rohan — he is the CLOSEST responder ★
    "Priya needs help. She is within 50 m of you."   ← highest-value alert in the system
```

### 2.10.4 Offline sync (ADR-012 — no CRDT library)

**The device is the source of truth. The server is a replica and a relay.** Every operation executes locally first, appends to a local log, then syncs. There is no loading state and no operation that requires connectivity to succeed.

| Data | Strategy | Why |
|---|---|---|
| Incident events | Append-only union, HLC-ordered | **Conflict-free by construction** — the merge of two divergent logs is their set union |
| Location points | Append-only, timestamped | Same |
| Member profile fields | Last-writer-wins per field, HLC tiebreak | Conflicts rare and benign |
| **Escalation policy** | **Server-authoritative, versioned. Devices never write.** | Two divergent policies is an unrecoverable bug class (ADR-013) |
| Consent grants | Server-authoritative + signed offline receipts | Security-relevant; must be totally ordered |
| Family checklist / shared notes | **Yjs** | Genuine concurrent text editing. Earn the dependency **here and nowhere else.** |

Cursor older than 7 days → the server sends a compacted snapshot + delta.

### 2.10.5 Clock skew (P-052)

**Hybrid Logical Clocks on every event:** 48-bit physical ms ‖ 16-bit logical counter ‖ 48-bit node ID = 12 bytes. The server stamps its own `server_received_at` separately. Timelines render from HLC; wall clock appears only as an annotation. `UNIQUE (incident_id, hlc)` gives cross-transport dedupe (P-053).

### 2.10.6 Other edge cases (retained from §2.D, with the resolution stated)

| ID | Handling |
|---|---|
| P-036 Force stop | Device Owner: prevented. Non-provisioned: **unsolvable** — detect the gap server-side and alert the family. |
| P-037 Exact alarms | Declare `USE_EXACT_ALARM`; fall back to `SCHEDULE_EXACT_ALARM`; verify with `canScheduleExactAlarms()` |
| P-038 `POST_NOTIFICATIONS` | Blocking onboarding screen; weekly check; **if denied and ungrantable, mark the device degraded and notify the family** |
| P-039 BLE permission split | `BLUETOOTH_SCAN` **with** `neverForLocation` for the fob path, **without** it for the family mesh (which genuinely derives proximity). Two code paths. |
| P-040 Background location | Two-screen onboarding with an illustration of the exact Settings screen. Verify afterwards. Never assume success. |
| P-041 FGS types | `location\|connectedDevice` main · `camera` CCTV · `microphone` intercom · `shortService` burst. Start from a foreground context or a Device-Owner-privileged path, **never** a plain background broadcast. |
| P-043 Storage full | Pre-allocate the ring buffer and a 5 MB incident-log reserve **at install time**. Daily free-space check; prune below 200 MB. |
| P-044 OTA reboot loop | Re-run full self-diagnostics on every `BOOT_COMPLETED`; compare `Build.FINGERPRINT` against the stored value; force re-verification on change. |
| P-047 IPv6-only / CGNAT | AAAA records; dual-stack TLS/WS; verify Happy Eyeballs (RFC 8305) in the client library. |
| P-048 Push token rotation | Refresh on every app start and `onNewToken`. On `NotRegistered`, mark degraded and **alert the family** — this is a silent-failure class. |
| P-049 Cert pinning | Pin **two** keys (current + next); rotate the backup before the primary expires; signed kill switch; pin expiry **fails open** rather than bricking devices. |
| P-058 SOS during an active incident | Do **not** open a second incident. Append `REESCALATE` and jump the ladder immediately. |
| P-065 Audio focus | The T0 alarm uses `STREAM_ALARM` and does **not** request audio focus. Incident audio pauses on `CALL_STATE_OFFHOOK` — never compete with a real 112 call. |
| P-066 Member disables the app | Their right (for adults), and it MUST be visible: *"Priya has paused safety monitoring."* Not an alarm. Just honesty. |
| P-067 / P-068 Leakage | `FLAG_SECURE` on sensitive activities; cover the iOS window in `applicationWillResignActive`; `android:allowBackup="false"`. |

---

## 2.11 Observability

### 2.11.1 Stack

Prometheus + Grafana (self-hosted) · OpenTelemetry → Tempo with **trace IDs originating on the device**, so one SOS is traceable phone → server → push → recipient · Loki with a compile-time PII deny-list · Sentry/GlitchTip · UptimeRobot **external to your infrastructure** · Grafana → Telegram/ntfy + SMS for P0.
**Do not route alerting through the system you are monitoring.**

### 2.11.2 ▲ CHANGE — the canary, with drill scoping (resolves F-03)

```
every 15 minutes, forever:
  canary device → POST /v1/incident/open { trigger: DRILL, is_drill: true,
                                           drill_run_id: <canary run> }
  ★ REAL code path. Same handler, same NATS, same DB. Not a mock. ★
  notify.Fanout resolves the audience from drill_run:
      notifies_family = false  ⇒  audience = [canary receiver device]
  canary receiver → CLAIM
  record four-clock timings
  if any leg fails OR t3 > 15 s → 🚨 PAGE  ← the ONLY page-worthy alert
```

**Why this matters more than any dashboard:** CPU graphs, error rates, and uptime checks all look green while your FCM service-account key silently expires, your DLT template gets deregistered, or an APNs certificate lapses. The canary catches every one of those within 15 minutes.

Add a **weekly full-fidelity canary** running all the way through SMS and a voice call, to catch aggregator and DLT problems before an emergency does.

**Exclusions (mandatory):** drill incidents are excluded from `active_incident_v` (deploy freeze), from the False Positive Ledger, and from NFR-008 accounting.

### 2.11.3 ▲ CHANGE — deploy freeze (resolves F-02)

```
GET /internal/active-incidents   →  SELECT * FROM active_incident_v
                                    (drills excluded, DORMANT excluded)

CI: if non-empty → refuse, print the incident IDs and states.
    Break-glass: KAVACH_DEPLOY_OVERRIDE=<reason> emits an audit event
    and a Telegram notice. Never silent.
Auto-quiesce: any incident older than 6 h transitions to DORMANT with a
    guardian-visible banner. Prevents a forgotten incident freezing deploys
    forever and leaving escalation timers armed.
```

### 2.11.4 Dashboards

**Dashboard 1 — Safety Chain Health (the only one checked daily):**
```
🟢 Canary: last success 4 min ago · t3 p95 = 2.8 s (budget 5 s)
🟢 sos-ingest: 100% success over 30 d · p99 latency 42 ms
🟡 Devices: 5/6 agents healthy
   ⚠️  Ma's phone: last heartbeat 19 h ago — LIKELY OEM KILL
🟢 Push: FCM 99.8% · APNs 99.9% (7 d rolling)
🟢 SMS: DLT template active · last test delivery 6 h ago
🟢 Escalation timers: 0 overdue
🟢 DR replica lag: 1.4 s
🟢 Node phones: CCTV 38 °C · Intercom 35 °C · battery health OK
```
> That one yellow line — a family member's agent silently dead for 19 hours — is worth more than every other metric in the system combined.

**Dashboard 2 — Four Clocks:** histograms of t1−t0, t2−t1, t3−t2, t4−t3, split by trigger type and degradation level.
**Dashboard 3 — False Positive Ledger:** every incident classified real/false/drill with its trigger and confidence. This is the tuning feedback loop and a **P0 metric**.

### 2.11.5 Alert routing

| Severity | Condition | Route |
|---|---|---|
| **P0 — page** | Canary fails · `sos-ingest` unhealthy · escalation timer overdue > 60 s · **notify budget breached** | Telegram + SMS, repeat every 5 min until acknowledged |
| **P1 — notify** | Agent silent > 6 h · push token invalid · DR lag > 60 s · node battery health bad | Telegram |
| **P2 — ticket** | Disk > 80% · FP rate rising · dependency CVE | Weekly digest |

---

## 2.12 Infrastructure

### 2.12.1 Topology

| Tier | Provider | Spec | ₹/mo |
|---|---|---|---|
| Primary app | DigitalOcean **Bangalore** | 4 vCPU / 8 GB / 100 GB NVMe | 2,000 |
| Managed Postgres | DigitalOcean | 4 vCPU / 16 GB / 200 GB + replica | 4,000 |
| DR | **Hetzner** (deliberately a different provider) | 3 vCPU / 4 GB | 700 |
| Edge | Cloudflare | Free tier + R2 (zero egress) | 25 |
| Media | LiveKit Cloud | Free tier at family scale | 0 |
| ✚ Offline backup | Backblaze B2 | | ~200 |
| **Revised total** | | | **≈ 8,100** (C6 ceiling ₹10,000 ✅) |

**Bangalore, not Frankfurt:** ~25 ms vs ~170 ms to Gujarat — a meaningful fraction of a 5 s p95 budget — and data stays in India for DPDP comfort.
**Cross-provider DR:** protects against provider-level failure, not merely region-level, at the same cost as cross-region within one provider.

### 2.12.2 Deployment

**Docker Compose + systemd. Not Kubernetes (ADR-005).**
1. **Blue-green for `control-plane`** (two ports, nginx switch), 60 s soak, automatic rollback on health-check failure.
2. **`sos-ingest` deploys separately and rarely**, its own pipeline, its own rollback.
3. **Deploy freeze during active incidents** (§2.11.3).

### 2.12.3 ▲ CHANGE — disaster recovery (resolves F-06)

| Failure | RTO | RPO | Action |
|---|---|---|---|
| Service crash | 10 s | 0 | Docker restart policy |
| App VM lost | 15 min | ~2 s | Cloudflare DNS → DR IP; devices retry automatically |
| Postgres primary lost | 30 min | ~5 s | Promote the replica; update the connection string; deploy |
| Region lost | 30 min | ~5 s | DR takes `/incident/*` only. Degraded: no history, but SOS + SMS fan-out works. |
| **Both providers down** | — | — | **Devices operate at L0–L2. Direct SMS + BLE mesh + 112. This is the design.** |
| Data corruption | 4 h | ≤24 h | PITR to a pre-corruption point |
| Ransomware / total compromise | 8 h | ≤24 h | Restore from the offline Backblaze copy; rotate every credential |

**▲ CHANGE — DR write path.** The DR `sos-ingest` writes **only** to its own local fsync'd WAL and its own local NATS, and drives the SMS fan-out worker from that. It does **not** write to the streaming replica (which is read-only — the PRD's container diagram shows `ING2 --> PGD`, which cannot work). `PGD` is promoted only by a deliberate, documented manual step. After recovery, the DR WAL is replayed into the primary and deduplicated on `(incident_id, hlc)`.

**Backup regime (3-2-1):** continuous WAL → R2 (30 d PITR) · daily `pg_dump -Fc`, age-encrypted → **Backblaze B2** (different provider), 90 d · monthly full snapshot to a physical drive in the home safe, 12 months · MLS/group key state + paper Shamir shares on every membership change · SOPS-encrypted config in git, mirrored.

> **An untested backup is a folder, not a backup.** Restore drills are quarterly and calendared.

### 2.12.4 Scalability — read this before over-engineering

**You will have 6–30 devices. You do not have a scaling problem. You have an evolution problem.** A single 4 vCPU / 8 GB Go server handles ~50,000 concurrent WebSockets — three to four orders of magnitude above your load. Every hour spent on Kubernetes is an hour not spent on the OEM battery-killer problem that will actually break your system.

Cheap decisions that preserve optionality and cost ~zero: `family_id` on every table + RLS · stateless services · NATS subjects namespaced `fam.{id}.*` · TimescaleDB hypertables for the only unbounded table · enforced module boundaries · API versioning from `v1`.

**The scaling problem you WILL have** is schema evolution over ten years while an old app version is still on a phone your mother refuses to update. Solve *that*.

---

## 2.13 AI & automation boundary

> **AI never decides. AI adjusts a confidence input to a deterministic state machine, or summarises for a human.**
> If you cannot state in one sentence what the deterministic system does when the model returns garbage, the model does not belong in that path.

| Capability | Runs | Model | Fallback when the model fails |
|---|---|---|---|
| Fall detection | Device NPU | 1D-CNN, ~200 KB, int8 | Threshold: impact > 3.5 g + no motion 30 s |
| Crash detection | Device NPU | Same, tuned for two-wheeler physics | Same |
| Audio event | Device NPU | YAMNet-derived, ~4 MB | Amplitude spike + spectral flatness |
| Voice duress phrase | Device | Keyword spotter, ~1 MB | Manual trigger |
| Routine baseline | Device | **EWMA + 3σ. No neural net.** | Fixed thresholds |
| Route/ETA | Device | Markov over learned routes | Naive great-circle ETA |
| ★ Incident summarisation | Device | On-device LLM (Apple Foundation Models / Gemini Nano / LiteRT-LM) | Structured template — 80% as good |

**The fusion stage is explicitly NOT a learned model.** It is a readable, testable ~80-line weighted evidence accumulator. That is the layer you will tune for two years; you must be able to reason about why it fired.

**Risk context engine:** consumes time of day, location class, motion state, BLE peers nearby, HR vs baseline, weather/IMD, user declaration → emits **one opaque integer 0–4** to the server and modulates detection thresholds, sampling rate (15 min → 5 s), cancel window (60 s → 10 s), escalation aggressiveness, and probe frequency. It needs continuous multi-sensor context, which is exactly why it runs entirely on-device and emits only the integer, never its inputs.

**Where AI must not go:** "should we escalate?" · "is this real?" · predicting who is at risk · auto-generating messages to emergency services · analysing family messages for "concerning content" · any cloud LLM over raw location/health/audio.

---

## 2.14 Home Assistant as the entire smart-home plane (ADR-016)

> **Do not build a Matter controller. Do not build Zigbee support. Do not write device drivers.**

```
sensors ──► Home Assistant (Pi + UPS) ──WebSocket API──► Safety Bridge (Go, ~400 LOC)
                                                            │ maps HA events →
                                                            │ SAFETY SEMANTICS
                                                            ▼ MQTT/TLS
                                                        Kavach platform
                                                            │ actions: unlock doors,
                                                            ▼ cut gas, light the escape path
```

**The bridge is where the value is.** HA says `binary_sensor.kitchen_smoke: on`. Your bridge translates that into a safety-semantic event: incident type, severity, who is home, and suggested actions. HA has no concept of an incident; you do.

Saves 8–12 months plus perpetual protocol maintenance. Cost: a dependency on a ₹4,000 Pi — mitigate with a UPS and a hot spare.
