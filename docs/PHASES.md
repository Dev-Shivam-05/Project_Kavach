# Phases — status board

Authoritative plan: [docs/03-Implementation-Guide.md](03-Implementation-Guide.md) §3.3–§3.7.
This file is the **status of that plan against the code at HEAD**, re-verified 2026-08-11.

`✅` done and wired · `🔨` incomplete · `⛔` blocked on something code cannot do

> **Two traps.** `W1…W16` are **week numbers, not workstream ids** — they run continuously across
> Phases 0 and 1. Each phase's soak is *inside* its week range, not added on top.

---

## Now

**Phase 1 · W10-c — present the alert on a locked screen.** The receive half landed on 11 Aug
(W10-b): a data-only FCM message now wakes the bundle, is read through an allowlist, and is
presented on the bypass-DND alarm channel. What is left is **1.37** (full-screen intent) and **1.28**
(`showWhenLocked` medical card) — one `Activity` in `modules/kavach-t0/android/`, since both are the
same native work and `expo-notifications` has no `fullScreenIntent` surface at all.

> ⛔ **Two independent blockers, both outside code.**
> 1. **No Firebase project.** `google-services.json`, an `android.googleServicesFile` line in
>    `app.json`, and a service-account key at `KAVACH_FCM_CREDENTIALS`. Free, ~15 min,
>    **owner: the user.** W10's exit criterion is a physical device ringing through DND (D-018).
> 2. **No Android toolchain on this machine** — no JDK, no `ANDROID_HOME`. Kotlin written here
>    cannot be compiled, let alone run, and the nine CI gates are Go/TS/Node only. W10-c is the
>    first phase whose output no gate in this repo can check (D-021).

## Next 3

1. **W10-c (1.37 + 1.28)** — full-screen intent and the `showWhenLocked` medical card. *(above)*
2. **Hardware trigger (1.16, 1.17)** — `PowerButtonWatcher` (5× in 3 s) and `VolumePatternWatcher`
   (vol-down 3 s, screen off). Both **absent**; nothing in the app observes a hardware button, which
   makes `PocketSuppressor` (1.19, complete) a guard on a door nobody can open. A panic button you
   must unlock the phone and open an app to reach is not a panic button.
3. **Exact-alarm Kotlin watchdog (1.13)** — `exactAlarmsPermitted` is *checked* and no exact alarm is
   ever *scheduled*, so on a force-stopped app on an aggressive OEM nothing resurrects the agent.
   §4.12 names OEM battery managers as risk #3.

Then the measurement work: T-213 statistically, NFR instrumentation, drills, the four-week soak.

---

> **Retired figures.** The numbers **59% / 70% / 52%** appear in chat logs and in
> `mobile/docs/PHASE-STATUS.md`. They were measured once on 28 Jul and then re-quoted four times
> over ten days **without re-measurement**, including a week later as if current. They also predate
> the 04 Aug workflow that landed the ADRs, CI, proto contract, migrations, hardware keys and device
> enrolment. Do not quote them. This board replaces them.

---

## Phase 0 — Foundation (§3.3, weeks 1–4) 🔨

Consent, paper trail, reproducible infra and Device Owner before any safety code.
W4 carries a ★ — "the highest-leverage week in the entire project". No soak.

| # | Item | Status | Evidence / what is missing |
|---|---|---|---|
| W1.1 | Family conversation + signed agreement | ⛔ | [docs/family-agreement.md](family-agreement.md) is written (268 lines, 9 sections + signature block). **Nobody has signed it.** This is the primary defence against §4.12 risk #4 |
| W1.2 | DLT registration (sender header + templates) | ⛔ | Absent. Bodies exist in `mobile/src/t0/smsPayload.ts`; unregistered they are undeliverable to DND numbers on Indian carriers. 1–2 weeks, needs an aggregator account |
| W1.3 | Repo + CI skeleton | ✅ | [.github/workflows/ci.yml](../.github/workflows/ci.yml) — 9 gates, each `if: !cancelled()` so one red gate does not mask seven |
| W2.1 | Threat model + data classification | ✅ | PRD §10.1–§10.2; Class A′ carved out in `docs/02` §2.4.6 |
| W2.2 | No unclassified field exists | ✅ | [tools/schema-lint.mjs](../tools/schema-lint.mjs) enforces I-3 over `store.go` + `schema.ts`; backend allowlist is deliberately empty |
| W2.3 | ADR files | ✅ | [docs/adr/](adr/) — 22, all Accepted |
| W2.4 | Codegen → Kotlin + Swift + Go + fixtures | 🔨 | `tools/smgen.mjs` emits **TS + Go + fixtures only**. Kotlin and Swift are not generated; the Kotlin plane consumes the JS machine |
| W3.1 | Terraform reproduces the environment from zero | 🔨 | No `infra/`, no Terraform, no SOPS. The stack runs from `ops/docker-compose.yml` on a laptop |
| W3.2 | Schema v1 live, RLS on, append-only trigger | 🔨 | [backend/migrations/0001_init.sql](../backend/migrations/0001_init.sql) is written (475 lines, RLS + triggers) and **nothing runs it**. The live store is files; `ErrAppendOnly` gives the rule teeth without SQL |
| W4.1 | Every family Android reports `is_device_owner = true` | ⛔ | Code complete — `DeviceOwnerConfigurator.kt`, `KavachDeviceAdminReceiver.kt`, escape hatch before the lock. **Zero phones provisioned** |
| W4.2 | Two keys per device, emergency key non-biometric | ✅ | `src/crypto/hardware.ts` prefers AndroidKeyStore (StrongBox/TEE) over the JS-heap key and **refuses** an auth-gated emergency key — an unconscious person cannot authenticate |
| W4.3 | Passkeys | 🔨 | Absent. No WebAuthn/passkey path anywhere |
| W4.4 | Sealed on phone A opens on phone B | 🔨 | Mechanism complete — `src/domain/enrolment.ts:451` calls `sealTo()`, `app/enrol.tsx` runs both halves of the SAS. **Never executed on two physical phones** |
| W4.5 | `t0_signing_available_predawn` recorded | ✅ | `KavachT0Module.kt:572` — a real device-protected-storage probe that reports **false** when unreadable rather than assuming true |

### 🔨 To close Phase 0
Four of the five open items are **paper, process or hardware, not code**: sign the agreement, file
DLT, provision one phone, pair two phones. The only real code gaps are Kotlin/Swift codegen and
passkeys. Terraform is optional while the stack is a laptop.

### ★ To make it extraordinary
- **Generate the Kotlin machine too.** Today the Kotlin survival plane consumes the JS machine —
  which means the one plane that must work when JS is dead depends on JS for its state table.
  Emitting Kotlin from `spec/state-machine.yaml` and running the same 16 fixtures in a Kotlin test
  makes T0 provably conformant standalone. This is the single highest-value item in Phase 0.
- **Hash the signed agreement into the repo.** Store the SHA-256 of the scanned signature page in
  `docs/`, so "every adult consented" becomes verifiable, not remembered.
- **`terraform apply` from zero** the day this leaves the laptop — plus SOPS, so a clean checkout
  can rebuild the environment without you.

---

## Phase 1 — Minimum Viable Safety (§3.4, weeks 5–16) ★ THE GATE ★ 🔨

*"Phase 1 IS the project."* Trigger → transmit → notify → acknowledge, end to end, on real phones.
Soak is W13–16: **four weeks, write no new features.**

### W5 — `sos-ingest` ✅ (one gap)
| # | Item | Status | Evidence |
|---|---|---|---|
| 1.1 | Wire contract with explicit `duress` presence | ✅ | [proto/incident.proto](../proto/incident.proto) `optional bool duress = 12`; frozen field numbers enforced by `tools/protolint.mjs` (Gate 9). Shipped format is canonical JSON in a padded envelope, proven byte-identical by `crosslang_test.go` |
| 1.2 | Fixed-size padding that fails closed | ✅ | `src/t0/envelope.ts` throws `EnvelopeSizeError` rather than emitting a short envelope — a deliberate inversion of fail-open |
| 1.3 | WAL fsync before ack | ✅ | `backend/internal/wal/wal.go` — CRC32 framing, `AppendSync`, torn-tail truncation at `Open()` |
| 1.4 | At-least-once bus, durable cursors | ✅ | `backend/internal/bus/bus.go`. Not NATS; the ADR-007 semantics are preserved |
| 1.5 | Ed25519 verify, fail open | ✅ | Bad signature sets `FLAG_UNVERIFIED` and proceeds (ADR-018) |
| 1.6 | Family-scoped flood guard, coalesce not drop | ✅ | 3 per 60 s; excess opens coalesce into the first (F-04) |
| 1.7 | Key cache warm before the listener opens | ✅ | `sos-ingest/main.go:266` (F-22) |
| 1.8 | Dual endpoint, CDN + direct bypass | 🔨 | `src/net/api.ts` genuinely fires both concurrently. **Both default to the same origin** (`config.ts:42,49`) — the mechanism is real, the redundancy is not configured |

### W6 — Android T0 skeleton ✅ (one gap)
| 1.9–1.12 | `:t0` process, `directBootAware`, DeviceProtectedConfig, boot receiver | ✅ | `modules/kavach-t0/android/…/AndroidManifest.xml`, `KavachForegroundService.kt:505-529`, `BootReceiver.kt` records the blind gap since last heartbeat before anything else |
| 1.13 | Watchdog: exact alarm, 15 min | 🔨 | **No Kotlin alarm receiver.** `src/t0/watchdog.ts` uses `expo-background-task` (opportunistic) plus a foreground timer. `exactAlarmsPermitted` is *checked* and no exact alarm is ever *scheduled*. On a force-stopped app on an aggressive OEM, nothing resurrects the agent |
| 1.14 | Self-diagnostics | ✅ | `src/t0/diagnostics.ts` — 9 checks, undeterminable ⇒ reported false and listed |

### W7 — State machine and triggers 🔨 (the big hole)
| 1.15 | Both machines pass the same fixtures | ✅ | 14 states · 20 events · 35 transitions · 16 fixtures, `gen:check` green |
| 1.16 | **PowerButtonWatcher — 5× in 3 s** | 🔨 | **Absent.** No `KeyEvent`, no `ACTION_SCREEN_*`, nothing observes a hardware button |
| 1.17 | **VolumePatternWatcher — vol-down 3 s, screen off** | 🔨 | **Absent** |
| 1.18 | In-app panic button | ✅ | `PANIC_BUTTON_HEIGHT = 96`, rendered in the `app/panic.tsx` footer |
| 1.19 | PocketSuppressor | ✅ | Full conjunctive gate + darkness-only fallback. Correct and complete — **and guarding a door nobody can open** while 1.16/1.17 are absent |
| 1.20 | Cancel window, risk-scaled, accelerating haptics | ✅ | `triggerRouter.ts` + `policy.ts effectiveCancelWindowS()` |
| 1.21 | Duress PIN, constant-time over BOTH candidates | ✅ | `verifyPin` — no early return, one shared accept path, same envelope offset |
| 1.22 | T-213 automated: 1000 vs 1000, KS p > 0.05 | 🔨 | Only a **structural** assertion in `test/invariants.test.ts`. The statistical two-sample test on real packets has never run |

### W8 — The L0 floor ✅ (one gap)
| 1.23–1.27 | Alarm at STREAM_ALARM max, torch strobe, native 112 handoff, black box, pre-allocated reserve | ✅ | `src/t0/alarm.ts` synthesises the siren at runtime (no bundled asset to lose); `blackbox.ts` claims `RESERVE_SLOTS` at init |
| 1.28 | **MedicalCardActivity, `showWhenLocked`** | 🔨 | `app/medical-card.tsx` is a complete card — 21:1 contrast, tap-to-call ICE, keep-awake. But it is a **React route inside the app**, so a stranger holding a locked phone cannot reach it. The single most important property of this screen is the missing one |

### W9 — Escalation engine ✅ (two gaps)
| 1.29 | Durable timer rows, N workers, atomic claim, no leader | ✅ | `internal/escalation/engine.go` — the header refuses `time.AfterFunc` explicitly |
| 1.30 | LISTEN/NOTIFY + adaptive poll | 🔨 | In-process bus wake + polling. Semantics hold; the Postgres mechanism does not exist |
| 1.31 | Ladder L1→L2→L3 as data | ✅ | `engine.go` + `src/core/policy.ts` |
| 1.32 | CLAIM / RELEASE broadcast over **both** WS and push | 🔨 | WS leg is now live (`store.ts:1073`, `onFrame` at `:1559`). The push **send** leg exists as of W10-a; a claim still does not fan out over it, and no device consumes a push yet — see W10 |
| 1.33–1.34 | Progress watchdog 5 min, auto-quiesce 6 h, `/internal/active-incidents` excludes drills | ✅ | `afterS: 300` / `afterS: 21600` in the YAML; F-02 honoured |

### W10 — Notification orchestrator 🔨 **the weakest week in the project**

Split into **W10-a (send)**, **W10-b (receive)** and **W10-c (present)** on 11 Aug — all on branch
`phase1-w10-remote-push`. W10-a and W10-b have landed; W10-c has not started.

| 1.35a | **FCM data-only, high priority — send side** | ✅ | `backend/internal/notify/fcm.go` — FCM HTTP v1, stdlib only (RS256 service-account JWT, cached access token). Data-only always; `assertPushSafe` fails closed on anything outside the lock-screen-safe five, so the duress bit cannot ride the push side channel (F-01/F-21). TTL read off the generated machine's `AUTO_QUIESCE` transition, not hardcoded. 20 tests |
| 1.35b | **Device push token registration** | ✅ | `acquireDevicePushToken()` (`notifications.ts`) uses the **native** FCM token, not the Expo relay — no third party between an emergency and a family phone. Wired at `store.ts` bootstrap; rolled tokens re-register via `addPushTokenListener`. Server side: `Device.push_token_fcm` + `PATCH /v1/devices/{id}` |
| 1.35c | **Delivery rows now tell the truth** | ✅ | The FCM leg used to record `delivered` for a push it never sent. It now records `KV-NOTOKEN` (this handset never registered), `KV-NOPUSHCFG` (no credentials in this deployment), `KV-UNREGISTERED` (T-218), `KV-PUSHFAIL`. The four clocks stop averaging in a number the process invented about itself |
| 1.35d | **⛔ FCM credentials** | ⛔ | **Blocked on a Firebase project, which is yours to create.** Four steps, all verified missing on 11 Aug: (1) a Firebase project with an Android app on package `in.example.kavach`; (2) `mobile/google-services.json`; (3) **`"googleServicesFile": "./google-services.json"` under `expo.android` in `app.json` — currently absent, so even with the file present `prebuild` would not place it and FCM would never initialise**; (4) a service-account key at `KAVACH_FCM_CREDENTIALS`. Until then `NewFCMFromEnv` returns `ErrPushNotConfigured`, the control plane logs `push_not_configured` at WARN, and **every push leg records KV-NOPUSHCFG**. No push has ever reached a handset |
| 1.35e | **Receive side — W10-b** | ⛔ | **Code complete and wired, exit criterion unmeetable.** `src/state/pushReceive.ts` defines `kavach.push.incident` with `TaskManager.defineTask` in module scope and registers it with `Notifications.registerTaskAsync`; `index.ts` imports it **before** `expo-router/entry` (ES modules evaluate in source order, so the reverse defines the task too late on the one launch that matters). `readPushFields()` is an allowlist reader, not a cast — the client half of F-01 does not depend on the server half being right. Degrades rather than drops: an unknown trigger or unparseable tier still rings. **14 tests**, incl. a wiring test that fails if `defineTask` ever moves into a function. ⛔ because **no handset has received one** — 1.35d, and §3.8 says the code compiling is not the bar |
| 1.36 | Bypass-DND channel, USAGE_ALARM | ✅ | `src/state/notifications.ts` — `AndroidImportance.MAX`, alarm usage, locally-composed text (F-21) |
| 1.37 | Full-screen intent — W10-c | 🔨 | `USE_FULL_SCREEN_INTENT` declared in `app.json:27` and **never requested or presented**. Confirmed 11 Aug: **`expo-notifications` has no `fullScreenIntent` surface** — zero matches in the package — so this is native work, not a content field. Needs an `Activity` (`showWhenLocked`, `turnScreenOn`) in `modules/kavach-t0/android/` plus a `setFullScreenIntent` notification posted from Kotlin, and a bridge function for `pushReceive.ts` to call. Same Activity as 1.28 |
| 1.35f | Push-borne gaps left open by W10-b | 🔨 | Three, each small and each real. **(a) No drill flag on the wire** — `pushPayload` sends the safe five and `isDrill` is not one, so `notifyIncidentFromPush` passes `false`. Fail-safe direction (a real alert shown as a drill is the unrecoverable error), and a drill usually carries `trigger: 'DRILL'` which renders as "Drill" anyway — but a `notifies_family` quarterly drill on another trigger presents as real. **(b) Headless alerts are English** — the locale lives in `t0ConfigRepo` behind SQLite, and opening the DB on the wake path was judged the wrong trade (D-020); `t()` falls back to `en` (NFR-020). **(c) A terminated-app action tap is still dropped** — Android routes it to the same task, `readPushFields` correctly refuses to re-alarm on it, and nothing yet applies `ACTION_PROBE_FINE`. That one is the P-002 spiral `notifications.ts` names in its own header |
| 1.38–1.42 | APNs Critical Alert · PushKit→CallKit · iOS NSE · Live Activity · Wear/watchOS | 🔨 | Absent. iOS is out of scope by ADR-015; the Android ongoing notification exists |

> **Stated plainly, end of 11 Aug:** the server can address a phone and really sends; the device now
> really listens, parses and presents. Both halves of the wire exist and are tested. **No handset has
> received one, because no deployment holds FCM credentials and no build contains
> `google-services.json`** — and with the app closed the only working leg to another human is still
> SMS. The honest status of W10 is "the mechanism is complete and has never once been exercised."
> Two things stand between here and a phone ringing, and neither is code: a Firebase project
> (1.35d), and a handset to ring.

### W11 — SMS and voice tiers ✅ (two gaps)
| 1.43 | Multi-SIM enumeration, send on ALL | ✅ | `KavachT0Module.kt` — `SubscriptionManager`, per-subscription `SmsManager` |
| 1.44 | ASCII payload + lint | ✅ | `smsPayload.ts` (K1, ≤160, transliterated) + the 32..126 assertion (I-2) |
| 1.45 | `sentIntent` / `deliveredIntent` per SIM | 🔨 | `deliveredIntent` is passed **null** — "the carrier accepted it" is recorded, "the handset received it" is not |
| 1.46–1.49 | sig8 HMAC webhook · inc8→UUIDv5 reconciliation · Class A′ ephemeral fan-out · notify budget | ✅ | F-09 and F-10 both closed; `PublishEphemeral` is a structurally separate subscriber list |
| 1.50 | TTS voice tier | 🔨 | `expo-speech` is a dependency imported by **no file**. An unused dependency is not a voice tier |

### W12 — Canary and observability 🔨
| 1.51–1.52 | Real incident every 15 min, four clocks | ✅ | `cmd/canary/main.go`, `httptrace`-instrumented |
| 1.53 | Grafana dashboards 1–3 | 🔨 | No Grafana. The three dashboards exist as **app screens** (`home.tsx`, `drills.tsx`, `incidents.tsx`). No operator view of a fleet |
| 1.54 | P0 page repeating until acknowledged | 🔨 | One webhook with 5-min re-page suppression. No SMS leg, no acknowledgement protocol |
| 1.55 | Alerting hosted OUTSIDE the monitored system | 🔨 | The canary is a binary in the same tree on the same machine |
| 1.56–1.57 | Backups (WAL→R2, pg_dump, physical) + restore drill | 🔨 | Absent entirely |

### ★ THE GATE ★ — 0 of 9 ticked
```
🔨 NFR-001 … NFR-009 measured and met            — no NFR measurement exists in the repo
🔨 2 drills passed                                — app/drills.tsx can run one; none has been run
🔨 Zero unexplained canary failures for 14 days   — never run against a deployed server
🔨 Every member has triggered AND cancelled       — tracked as rehearsalSkipped, surfaced as failing
🔨 T-204/205/207/210/213/216 on the device matrix — five need hardware; T-213 needs the KS test
⛔ Every Android reports is_device_owner = true   — zero phones provisioned
⛔ ASCII lint ✅ · DLT templates live · delivery tested to every number
🔨 A message sealed on A opens on B               — code ready, two phones never paired
🔨 Idle drain < 4% / 24 h on the aggressive OEM   — never measured
```
Then: **"stop and use it for a month."** §3.4 calls that the most important project-management
directive in the document.

### 🔨 To close Phase 1 — in dependency order
1. **Remote push — the last unbuilt piece is 1.37 + 1.28 (W10-c).** Nothing else in this phase
   matters if no phone rings. Token registration → server token store → data-only FCM send (W10-a)
   and the device receive path (W10-b) are **done, 11 Aug**. What remains is presentation: one
   `showWhenLocked` / `turnScreenOn` Activity in `modules/kavach-t0/android/` and a Kotlin
   `setFullScreenIntent` post, closing 1.37 and 1.28 together.
   **Do the Firebase project first** (1.35d), and note that W10-c needs a **JDK and an Android SDK
   that this machine does not have** — its output is Kotlin, which no CI gate here compiles. Both
   the writing and the checking of it need a workstation that can build the app.
2. **Hardware trigger (1.16, 1.17).** A panic button you must unlock the phone and open an app to
   reach is not a panic button.
3. **`showWhenLocked` medical card (1.28)** and the **exact-alarm Kotlin watchdog (1.13)** — both
   small native additions with outsized value.
4. Then the measurement work: T-213 statistically, NFR instrumentation, drills, soak.

### ★ To make Phase 1 extraordinary
- **A delivery ladder with per-channel receipts, not just "we sent it."** You already write a
  durable `delivery_attempt` row per attempt. Surface it as a live per-incident matrix — who was
  told, on which channel, at what millisecond, and *who has not been told yet* — and escalate on the
  gap rather than on a timer. This converts t3 from a metric into a control loop.
- **Pull the BLE panic fob forward from Phase 4.** §3.7 already says build it *before* wearables:
  ~₹800, two-year battery, a weekend of work. It solves 1.16/1.17 more completely than a
  power-button watcher ever can — it works with the phone in another room, and an attacker taking
  the phone does not take the fob.
- **Server-side agent-gap alerting.** `BootReceiver` already records the blind gap since the last
  heartbeat. Send it up and alert *the family* when someone's agent has been silent — §4.12 names
  OEM battery managers killing the agent as risk #3, and this is its named defence.
- **Make T-213 a CI gate.** 1,000 duress vs 1,000 cancel runs, two-sample KS, fail the build at
  p ≤ 0.05. A timing side-channel that only a statistical test can see will never be caught by review.
- **Run the canary from a second machine.** Alerting inside the monitored system is not alerting.

---

## Phase 2 — Presence & Coordination (§3.5, weeks 17–30) 🔨

No consolidated gate; acceptance is per workstream.

| Workstream | Status | Evidence / what is missing |
|---|---|---|
| Realtime: connect tickets (F-16), resumable cursor, backpressure | ✅ | Server `realtime-gw/main.go:315`; client `src/net/ws.ts` — CRITICAL never dropped, LOW coalesced by key. **`connectWs()` is now wired** at `store.ts:1073` (it had zero call sites in the 28 Jul audit) |
| Presence, 45 s TTL | ✅ | `presenceService.ts` + `CONFIG.presenceTtlMs` |
| **Live location acquisition** | ✅ | `Location.watchPositionAsync` at `presenceService.ts:174` → `noteLocationFix()` at `:151`. This was the single most consequential gap in the 28 Jul audit and it is **closed** |
| Geofence crossings | ✅ | `evaluateGeofences()` called at `presenceService.ts:157` — also previously dead |
| Family map with consent gating | ✅ | A pin is drawn only against a live, unrevoked, unexpired grant; otherwise the member is listed with the reason, never pinned at a stale position |
| Four-clock rendering + notification matrix | ✅ | `app/drills.tsx`, derived from delivery receipts |
| `policy_version`-correct replay | 🔨 | Version is stamped, persisted and **displayed**, but `policyRepo` has `current()` and `version()` and **no `byVersion()`**. A six-month-old incident renders under today's rules while labelled with yesterday's version — worse than not labelling it |
| Journeys: learned ETA, corridor deviation | ✅ | `journey.ts predictEta()` — median + MAD, peak conditioning, "no opinion" below confidence 0.4 |
| **Missed-arrival / dead-man escalation** | 🔨 | **Absent.** The DEADMAN policy is fully specified in `policy.ts` and `'DEADMAN'` is never passed to `trigger()`. There is no `sweepJourneys`. A journey can start and can never be overdue |
| Consent CRUD, access log to subject, two-layer revocation | ✅ | `expiresAt` is never null; revocation sets `keyRotationPending` and the UI renders the pending ratchet verbatim rather than claiming completion (F-14) |
| Find-phone | 🔨 | Consent bookkeeping complete; delivery depends on push (W10) |
| BLE `FIND_ME` GATT fallback | 🔨 | Absent. `bleAdvertise()` exists for the distress advert only — no GATT server, no scanner |
| Final Breath on `ACTION_SHUTDOWN` | ✅ | `ShutdownReceiver.kt` — per-SIM send in the 2–5 s window, `commitBlocking` because `apply()` would not survive |
| MLS migration | 🔨 | Deferred by ADR-021. `SCHEME_MLS = 0x02` is reserved and shipped — correct groundwork, not the migration |

### ★ To make Phase 2 extraordinary
- **`byVersion()` first.** An after-action report that misattributes the policy is a lie told
  confidently. It is one repo method.
- **Dead-man that uses the confidence you already compute.** `predictEta()` returns a confidence;
  escalate on `eta + f(confidence)` rather than a fixed grace, so a well-learned route escalates
  fast and a novel one does not cry wolf.
- **BLE `FIND_ME` closes the loop that push cannot** — it reaches a phone that is offline and on
  silent, which is exactly the phone you are looking for.

---

## Phase 3 — Autonomous Detection (§3.6, weeks 31–49) ★ STRICT GATE ★ 🔨

*"An automatic detector that cries wolf makes your family less safe than no automatic detector."*

| Workstream | Status | Evidence / what is missing |
|---|---|---|
| Sensor fusion | 🔨 | `src/t0/fusion.ts` exists — 687 lines (the guide budgeted "a readable, testable ~80-line scorer") and **untested**. No hardware FIFO batching, so the 200 mAh/day → 18 mAh/day optimisation is unclaimed |
| Risk context engine | ✅ | `riskContext.ts` — deterministic, emits one opaque 0–4 integer; only the integer leaves the device |
| PROBE state | ✅ | `app/probe.tsx` + `PROBE` in the state machine |
| BLE mesh relay | 🔨 | `bleAdvertise()` exists; **no scanner, no relay, no ScanFilter offload**. F-11/F-12 are designed, not built |
| Labelled dataset + FP measurement | 🔨 | No collection tooling, no labelled set, no FP rate measured |
| **★ THE GATE ★** FP < 1 / user / month over a 6-week soak | 🔨 | Not attempted. Nothing in the repo measures it |

### ★ To make Phase 3 extraordinary
- **Build the labelling tool before the detector.** One-tap "that was not a fall" on the incident
  card, stored on-device, exported by cable — never uploaded (raw motion is Class A). Without a
  labelled negative set from ≥200 real days, threshold tuning is guesswork.
- **FIFO batching is the difference between shipping and not.** 50 Hz continuously is ~200 mAh/day;
  with `maxReportLatencyUs = 30_000_000` it is ~18. Above ~5%/day users disable the app, and battery
  is therefore a safety metric.
- **Give the gate teeth in software:** if the measured FP rate exceeds the budget, the app should
  *itself* raise thresholds or disable a trigger type and say so — rather than relying on a human to
  honour a checklist.

---

## Phases 4 & 5 — Ecosystem and Depth (§3.7) 🔨

§3.7 gives no week ranges and §3.13 calls these *"open-ended by design… treat the list as a backlog,
not a plan."* Several Phase-5 items were built early, out of order.

| Item | Phase | Status |
|---|---|---|
| Home Assistant bridge | 4 | 🔨 ADR-016 models it; no live integration. **~400 LOC Go — the highest value per hour in the whole backlog** |
| ★ BLE panic fob | 4 | 🔨 Absent. §3.7 says build it **before** wearables |
| Wearables (Wear OS / watchOS / Garmin) | 4 | 🔨 Absent |
| Trusted-neighbour tier (Class B/C only, F-20) | 4 | 🔨 `allowNeighbours` flags exist in `policy.ts`; no neighbour identity or 6-hour activation window |
| Live audio (LiveKit, insertable-stream E2EE) | 4 | 🔨 ADR-017 — recorded and **explicitly not implemented**. No media plane exists |
| Intercom node (before CCTV) | 4 | 🔨 Absent — and the CCTV node was built first, inverting the stated order |
| Document vault + Shamir 2-of-3 | 5 | ✅ `app/vault.tsx` + hand-rolled GF(256) Shamir. **Document rows point at files that do not exist** (demo fixtures) |
| Screen time | 5 | 🔨 `app/screen-time.tsx` renders a hardcoded 5-app fixture. **No `UsageStatsManager` bridge** — visually complete, functionally inert |
| CCTV node | 5 | ✅ `app/camera-node.tsx` — stills every 300 ms, DC-only JPEG luma motion detection, deleted after comparison. Runs only while the screen is on |
| Elder passive monitoring | 5 | 🔨 Partial — `sweepSilentAgents` exists; no activity-proxy integration |
| On-device incident summarisation · 2D floor plan · disaster mode | 5 | 🔨 Absent |

### ★ To make Phases 4–5 extraordinary
Do them in the stated order and resist the rest. **Home Assistant bridge → BLE fob → intercom.**
Those three add smoke/gas/water/door sensing, a trigger that works without the phone, and two-way
voice — each independently shippable, each cheap. Everything else is optional, and §4.12 risk #5 is
developer burnout.

---

## Phase 6 — The 07 Aug product brief 🔨 **not started**

Given on 07 Aug 17:03. A workflow was launched at 17:05:37 to scope it; **all four agents stopped by
17:07:31 with zero results**, and the session ended. **No source file has changed since 05 Aug
21:56** — this brief has never had a line of code written for it. `DELIVERY.md`, written three
hours later, does not mention it.

Per your 11 Aug decision this runs **after the Phase 1 gate**, because §4.12 names scope creep
before the gate as the single most likely way this project dies.

| # | Item | Status | What exists today |
|---|---|---|---|
| 6.1 | Delete all mock data | 🔨 | `src/domain/demo.ts` is **1,261 lines** of fixtures and `demoMode` **defaults true** (`config.ts:66`, `app.json:140`). ~40 gate sites, incl. 17 short-circuited endpoints in `api.ts`, plus a fake camera peer at `nodeStore.ts:405` |
| 6.2 | Family ID you type in to join | 🔨 | Enrolment is invite-code + QR + spoken-fingerprint SAS. `familyId` is **sealed inside the guardian's reply** (`enrolment.ts:526`) and never typed by a human. Onboarding does not touch enrolment at all |
| 6.3 | Account from real mobile number | 🔨 | `phoneE164` is a type field, a DB column and a demo value — with **no input anywhere**. Settings shows "no phone number on file". No OTP path exists |
| 6.4 | Offline video calling, front + rear | 🔨 | No WebRTC, no media dependency. `cctv.ts:13-28` records that expo-camera SDK 57 has no frame processor; `camera-node.tsx:24` — "IT DOES NOT RECORD" |
| 6.5 | Satellite view + pinch zoom | 🔨 | `FamilyMapView.tsx:1-31` — "THE MAP THAT IS NOT A MAP". Hand-drawn SVG equirectangular scatter, auto-fit only. **Zero gesture handlers in the entire app** |
| 6.6 | Bottom-nav redesign | 🔨 | Stock `expo-router` bar, glyphs are plain text characters, three lines of styling (`(tabs)/_layout.tsx:121-125`) |
| 6.7 | Privacy controls → Settings | 🔨 | Settings already aggregates 9 sub-screens, but Consent is still a **top-level tab** |
| 6.8 | Total visual redesign | 🔨 | A real design system exists (`theme.ts`, 17 components, computed contrast) but predates the brief |

### ⚠ Three of these reverse documented decisions
6.1, 6.4 and 6.5 are not merely unbuilt — they are **argued against in load-bearing file headers**.
Building them means writing ADRs that overturn prior ones, not just adding screens.

- **6.5 vs ADR-010.** `FamilyMapView` gives three reasons for having no basemap. One is now dead:
  "react-native-maps cannot run in Expo Go" stopped applying on 27 Jul when the project moved to a
  prebuild/dev-client workflow. Two still stand: every tile request is a silent precise-location
  disclosure to a third party with no consent grant and no access-log row, and tiles need network in
  the exact moment the map matters.
- **6.4 vs ADR-017.** There is no media plane, by record.
- **6.1 vs the build doctrine.** "Everything works with no backend" is baked into five of the six
  workflow prompts that built this app. Demo mode is what makes it explorable with nothing running.

### ★ How to build Phase 6 without breaking the product
- **6.2/6.3 — add a discovery layer, do not replace the security layer.** A typed Family ID is
  convenient; a typed code is not authentication. Keep the SAS fingerprint as the step that actually
  admits a device, and let the Family ID + phone number be how people *find* each other. For OTP,
  reuse the SMS aggregator you already need for DLT rather than adding a vendor.
- **6.5 — pre-cached offline tiles, per your decision.** Bundle MBTiles for the family's own area so
  the map works at ZERO_INFRA and leaks nothing. **Licence constraint, stated honestly:** Google and
  Mapbox terms forbid tile caching, so the viable sources are open imagery (Sentinel-2 / Landsat) or
  a licensed set you may redistribute. A 20 km box at usable zoom is tens of MB — real, but bounded.
  Add pinch/pan with `react-native-gesture-handler`, which is already a dependency and currently
  unused.
- **6.4 — one question still gates the design, and it is yours to answer.** On 07 Aug the honest
  answer was: Wi-Fi Direct reaches ~30–50 m indoors, ~100–200 m outdoors; Wi-Fi Aware is missing on
  many budget phones; Bluetooth cannot carry video. **Truly offline video cannot reach your daughter
  across the city — no app can.** So: same-building (a real, buildable feature — intercom between
  family phones during an incident when the router is down) or across-city (which means "works on
  bad networks", a different and easier feature)? Pick one before any code.
- **6.1 — sequence it after push lands, not before.** Deleting demo data today empties Home, the
  incident stack, Consent, drills and the vault, because nothing else fills them yet. Do it as the
  *last* step of the real-data path, and keep a `demo` build profile for showing the app to people.
- **6.6/6.7/6.8 are the cheap wins and have no architectural conflict.** A custom tab bar with a
  safe-area-aware height, an active pill, haptic feedback on change, and **five tabs down to four**
  by moving Consent into Settings — that is 6.6 and 6.7 in one change, and it is the change you see
  every time you open the app.

---

## Rules for this board

- One phase per session. Past ~8 files, split the row.
- 🔨 → ✅ requires the demoable outcome demonstrated, not the code compiling — plus §3.8's nine-point
  Definition of Done, of which items 2–5 are a **physical-device checklist** no CI can fake.
- Anything touching `internal/{store,bus,wal,escalation}` or `cmd/{control-plane,realtime-gw}` needs
  a characterization test first — ~6,000 lines there have no direct tests ([RISK.md](RISK.md) §4).
- `sos-ingest` has **37 lines of headroom** (963/1000). Budget removals before additions.
