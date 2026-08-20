# Decisions

**Architecture decisions do not go here.** They go in [docs/adr/](adr/) as a numbered ADR citing a
forcing requirement — this project's own rule (`docs/adr/README.md`: *"a decision without a forcing
requirement is a preference"*). 22 ADRs exist; the next is ADR-023.

This file holds the decisions that are **only visible in the code or in a chat transcript** — the
ones that would die on the next `/clear`. Recovered 2026-08-11; see
[history/SESSION-LOG.md](history/SESSION-LOG.md).

---

## D-001 — Expo Go was abandoned deliberately, not worked around

**Decision.** When Expo Go rejected the project at SDK 57 (27 Jul), the SDK was **not** downgraded.
The project moved to a prebuild / dev-client workflow and ships an APK.
**Why.** *"Expo Go is a sandbox that can't host a foreground service, send SMS without a tap, or
survive Direct Boot."* Downgrading would have bought compatibility by deleting the survival plane.
Diagnostics reports `nativeT0Present: false` under Expo Go rather than faking the capability.
**Evidence.** `mobile/package.json` — `expo-dev-client`, `prebuild` script, `modules/kavach-t0`.
`README.md:34` still says "scan the QR code with Expo Go" and is **wrong**.
**Consequence worth knowing.** This retires *"HARD RULE 4 — react-native-maps cannot run in Expo
Go"*, the first of three reasons `FamilyMapView.tsx` gives for having no map library. The other two
— third-party tile requests are silent location disclosure, and tiles need network — still stand.

## D-002 — The Kotlin module refuses an iOS stub

**Decision.** `modules/kavach-t0` is Android-only and ships no iOS implementation, not even a stub.
**Why.** *"It would let diagnostics report a capability that cannot exist."* A stub that returns
"unsupported" is honest; a stub that returns a plausible value is a lie told to the one screen whose
entire job is refusing to tick boxes it cannot prove.
**Evidence.** `expo-module.config.json` — `"platforms": ["android"]`. ADR-015 covers the Device
Owner rationale; this narrower rule is not in any ADR.
**Trigger to revisit.** An iOS plane would need ADR-015 reopened, not a stub added.

## D-003 — The shipped backend is not the architecture in `docs/02`

**Decision.** Go standard library only, zero `require` lines, file-backed store, in-process bus.
No Postgres, no NATS, no Cloudflare, no Kubernetes.
**Why.** The whole stack comes up on a laptop with one command, and `sos-ingest` keeps ≤5 direct
dependencies (ADR-002). ADR-006 chose Postgres and ADR-007 chose NATS — **both are recorded as
"not deployed"**, and `docs/02` still describes the undeployed version.
**Evidence.** `backend/go.mod` (no requires) · `internal/store/store.go` (JSON per table) ·
`internal/bus/bus.go` (`stream.wal` + `cursors.json`) · `backend/migrations/0001_init.sql` exists
and **nothing runs it**.
**Trigger to revisit.** Leaving one machine. Until then, treat the SQL as an executable spec — and
note nothing tests SQL-vs-store agreement, so it drifts silently.

## D-004 — Demo mode is an opt-out default, and it is not a mock layer

**Decision.** `CONFIG.demoMode` defaults **true** and runs the whole L0 floor locally: real state
machine, real timers, real alarm, real crypto — with a seeded family and simulated responders.
**Why.** *"Everything works with no backend"* is baked into five of the six workflow prompts that
built this app. It is what makes the APK explorable with nothing running.
**Evidence.** `src/core/config.ts:66` `demoMode: demoRaw !== 'false'` · `app.json:140` · ~40 gate
sites · `src/domain/demo.ts` (1,261 lines).
**The unreconciled collision.** The 07 Aug brief says *delete all mock data entirely*. Nobody
reconciled that with this rule. Resolution recorded in [PHASES.md](PHASES.md) §6.1: sequence the
deletion **after** the real-data path exists, and keep a `demo` build profile.
**Danger.** `eas.json` sets no `env`, so a `preview` or `production` APK **ships in demo mode and
fabricates family acknowledgements**. See [RISK.md](RISK.md) §1.

## D-005 — The theme splits every colour into a fill token and a text token

**Decision.** Each colour family has a saturated *fill* (white text sits on it) and a lightened
*text* token. Contrast is **computed and tested**, never asserted in a comment.
**Why.** Found numerically, not by taste: `#FF4A42` has luminance 0.27, so its contrast **ceiling**
is 6.3:1 against any background — the palette claimed 7:1 and shipped 5.3:1. Separately, risk steps
2 and 3 were 1.08:1 apart in luminance, invisible without colour vision.
**Evidence.** `src/ui/theme.ts` · `mobile/test/theme-contrast.test.ts` — AAA on every surface,
"a fill is never mistaken for a text token", "adjacent risk steps are distinguishable without colour
vision".
**Why it matters.** This is the single most consequential UI decision in the project and it exists
nowhere except the code. Any redesign (Phase 6.8) must keep the split and keep the tests.

## D-006 — The medical card inverts the theme, because it is not a UI

**Decision.** `app/medical-card.tsx` renders black-on-white at 21:1, overriding the dark theme, with
oversized blood group, maximum three allergies, full brightness and keep-awake.
**Why.** *"It is not a UI."* It is a document a stranger or paramedic reads under stress, possibly
in sunlight, on someone else's phone.
**Trigger to revisit.** Never for aesthetics. Its real gap is that it is a React route inside the
app rather than a `showWhenLocked` Activity — see [PHASES.md](PHASES.md) 1.28.

## D-007 — The duress flag never appears in a push payload

**Decision.** Push payloads carry `{incident_id, family_id, trigger, tier, subject_short_name}` and
**never** the duress bit.
**Why.** A payload is a side channel. I-7 requires duress and normal-cancel to be indistinguishable
by size and timing; leaking the bit into an unencrypted envelope defeats the fixed 1024-byte padding
and the constant-time PIN compare that exist to protect it.
**Evidence.** `docs/02` §2.6.3 (F-21, data-only payloads). The reasoning came from an agent going
beyond its brief and was endorsed.

## D-008 — Two deliberate APK size trade-offs

**Decision.** (a) Native libraries stay **compressed**. (b) `armeabi-v7a` is kept.
**Why.** (a) Compression halves the *download* and grows the *on-device* footprint — download wins,
because it decides whether a sideloaded APK gets installed at all. (b) Dropping 32-bit saves
**8.32 MB** and makes the app uninstallable on exactly the cheap handsets this product exists for.
**Evidence.** `mobile/docs/BUILD-SIZE.md` — 132.8 MB baseline → 74.5 MB after dropping x86/x86_64 →
**31.97 MB** measured on the 5 Aug release build.
**Trigger to revisit.** Only if 32-bit devices leave the target market.

## D-009 — `.gitignore` anchoring is load-bearing

**Decision.** `android/` rules are anchored (`/android/`, `/mobile/android/`); only
`**/android/build/` is excluded by directory name.
**Why.** An unanchored `android/` also matched `mobile/modules/kavach-t0/android/` and left **10 of
13 native module files untracked**. EAS uploads the git tree, and the JS side uses
`requireOptionalNativeModule` — so the APK would have compiled and shipped with **no Tier-0 plane at
all, degrading silently instead of failing loudly**.
**Evidence.** The comment block in [.gitignore](../.gitignore) — keep it.

## D-010 — "Exists" and "is wired up" are different questions

**Decision.** Every audit reports both. A module that compiles, tests and is called from nowhere
scores as missing.
**Why.** This codebase has produced zero-call-site code repeatedly: `noteLocationFix()`,
`evaluateGeofences()` and `connectWs()` were each complete, tested and dead (28 Jul); the 5 Aug fix
agents introduced **three fresh ones** in a single pass. From a family's point of view an
unreachable function and a missing one are the same function.
**Evidence.** All three original cases are now wired (`src/domain/presenceService.ts`,
`store.ts:1049/1073/1559`) — the rule is what caught them.

## D-011 — Recon before changes; incremental, never a rewrite

**Decision.** The 11 Aug session mapped the repo and verified the safety net before touching
anything, and no overhaul is planned.
**Why.** The rewrite test fails on three of four counts — the runtime is current (Go 1.26, Expo
SDK 57), the domain is far too large to re-specify in a day (3,371-line PRD, 22 ADRs, 410
requirement citations), and the survival core is the *strong* part. What is weak is wiring and test
coverage, which is what incremental work fixes.
**Method where coverage is missing.** Characterize current behaviour in a test first, then change it
and watch the test fail deliberately.

## D-012 — `docs/PHASES.md` is the board; §3 is the plan

**Decision.** `docs/03-Implementation-Guide.md` §3.3–§3.7 stays the authoritative long-range plan
and is **not** edited to reflect progress. `docs/PHASES.md` carries status against it.
**Why.** §3 is written against the PRD; the board is written against the code. Merging them destroys
the ability to see the gap between the two, which is the entire value of the exercise.

## D-013 — `.claude/skills/` are not skills, and the real tools get wired in properly

**Decision.** Untrack `.claude/skills/` from git (keep on disk), and add the genuinely useful tools
as real dev dependencies with CI gates.
**Why.** **None of the eight contains a `SKILL.md`**, so Claude Code can never load any of them.
They are cloned upstream repos — Reactotron, shadcn/ui (a *web* library, unusable in React Native),
dependency-cruiser, ESLint, Remotion (679 MB, unrelated), textlint, Trail-of-Bits semgrep rules, and
`ui-motion-engine` which is **empty**. They are **25,213 tracked files against 192 project files**,
and `.git` is 469 MB. None is wired in: the project has **no ESLint, no Prettier, no semgrep, no
textlint config at all** — `tsc --noEmit`, `go vet` and staticcheck are the entire static-analysis
surface.
**What to wire instead.** ESLint (with the RN/Expo config), semgrep with the Trail-of-Bits rules,
and dependency-cruiser to enforce on the TS side what `tools/archlint` already enforces on the Go
side. Each becomes a CI gate.
**Status.** Decided 11 Aug, **not yet executed** — it is the next session's first task.

## D-014 — One squashed commit was a mistake; commit per phase from here

**Decision.** Every phase ends in its own commit.
**Why.** `62ed6839 "Initial Commit"` collapsed twelve days of work into one commit on 9 Aug. There
is no bisect, no blame, and no way to see when a behaviour changed. Combined with `/clear` without
handoff, that is how the project's history was lost in the first place.

---

*Added 2026-08-11, session 2 (Phase 1 W10-a — remote push, send side).*

## D-015 — A delivery row must never claim a leg that was not attempted

**Decision.** `internal/notify` no longer models the FCM leg with a jittered sleep and an
unconditional `delivered`. It really sends, and records what happened: `KV-NOTOKEN` (this handset
never registered a token), `KV-NOPUSHCFG` (this deployment holds no FCM credentials),
`KV-UNREGISTERED` (T-218 — the token is dead), `KV-PUSHFAIL` (transient).
**Why.** Those rows are the input to the four clocks and the notification matrix (§2.6.1, §16.2) —
the only evidence a family has that the safety chain works. A green row for a leg that does not
exist is not an approximation, it is the system lying about the exact property W10 exists to
establish. The same argument the module's own header already makes for `KV-SHUTDOWN` ("record the
truth rather than a delivery we cannot vouch for") applies here and had simply not been applied.
**Consequence, stated plainly.** Until a Firebase project exists, **every** FCM row on a running
deployment reads `failed / KV-NOPUSHCFG`. That is a truthful red, not a regression, and it is the
first time the deployment has been able to say "no phone here can be reached with its app closed".
**Evidence.** `internal/notify/notify.go` `dispatch()` / `sendPush()`; `fcm_test.go` — one test per
outcome. The four modelled channels (APNs, PushKit, SMS, voice) are **untouched** and still
simulated; only FCM became real.

## D-016 — The native FCM token, never the Expo push service

**Decision.** `acquireDevicePushToken()` calls `getDevicePushTokenAsync()`, not
`getExpoPushTokenAsync()`, and the server sends to Google directly with the family's own
service-account credentials.
**Why.** The Expo push service is a relay. Using it puts a third party between an emergency and a
family phone, adds a hop that must be up at the one moment that matters, and means the alert's
routing depends on this app's Expo project rather than on infrastructure the family controls. The
same reasoning that put `apiDirect` beside the CDN endpoint (F-05) applies to the push fabric.
**Cost, accepted.** A Firebase project and `google-services.json` in the Android build become hard
requirements; the app cannot be push-tested from Expo Go at all (it already could not run there —
D-001).
**Evidence.** `mobile/src/state/notifications.ts`; `backend/internal/notify/fcm.go` (FCM HTTP v1).

## D-017 — The store↔migration column pairing is now machine-checked, for one table

**Decision.** `internal/store/store_test.go` pins the **complete set of persisted JSON keys** on
`Device` against the column names in `migrations/0001_init.sql`. Adding a column to the Go struct
fails the test until the list is updated, and the list is only allowed to name columns the migration
really has.
**Why.** [RISK.md](RISK.md) §8: the SQL is the target Postgres schema, the store is the live
implementation, five tables exist only in SQL, and **nothing checked that they agree**. Drift is
invisible until migration day. W10 needed to add a column, which made this the moment to make the
pairing cost something.
**Deliberately narrow.** One table. Generalising it to all eleven is worth doing and is *not* done —
doing it properly means parsing the SQL rather than hand-listing keys, and that is its own task.
**Consequence.** `push_token_fcm` is the migration's name, not an invented one. `push_token_apns`
and `push_token_voip` exist in the SQL and are deliberately **absent** from the Go struct: iOS is out
of scope (ADR-015), and a column nothing writes is D-010's failure mode in schema form.

## D-018 — W10 splits into send and receive; the Firebase project gates the half that can be proven

**Decision.** W10 is now W10-a (token registration + server send — **done**) and W10-b (device
receive + full-screen presentation — **not started**). W10-b is sequenced *after* creating a Firebase
project.
**Why.** W10's exit criterion is "an alert rings through Do Not Disturb on every device in the §17.2
matrix" — a physical-device check. W10-a is verifiable by test and is therefore honest work to do
without hardware; W10-b is *only* verifiable on a handset receiving a real push, so building it
before credentials exist means writing code that cannot be checked and calling it done. That is the
failure mode §3.8 and rule 8 both exist to prevent.
**Also true.** W10-b needs the same `showWhenLocked` Activity work as the medical card (1.28), so
the two should be one session, not two.
**Blocker owner: the user.** A Firebase project, `google-services.json` in the Android build, and a
service-account key at `KAVACH_FCM_CREDENTIALS`. Free, ~15 minutes, and nothing downstream of it can
be finished first.

## D-019 — The client reads the push payload through an allowlist, not a cast

**Decision.** `readPushFields()` takes the five lock-screen-safe fields **by name**, validates and
sanitises each, and drops every other key on the floor. It does not cast the payload to a type and
spread it into a notification.
**Why.** `fcm.go`'s `assertPushSafe` already fails closed on a forbidden key — but that is the
*sender* checking itself, and F-01 says the duress bit must not be inferable from anything that
leaves the device. A payload arrives over Google's fabric from a server the phone cannot audit. If
the only thing standing between `duress` and a lock screen is the sender's own assertion, then one
compromised or simply wrong server defeats the entire duress design. Two independent gates, on two
sides of the wire, is the same shape as the F-21 double-check already inside the backend.
**Consequence.** `subjectShortName` is clamped to printable ASCII, ≤8 chars (F-18 / I-2) — it is the
only server-supplied string that renders as text on a locked screen. Ids are restricted to
URL-unreserved characters so a hostile id cannot become a path segment of its own.
**Evidence.** `mobile/src/state/pushReceive.ts`; `mobile/test/push-receive.test.ts` — "the
notification carries the five fields and NOTHING else" sends `duress`, `lat`, `lon` and `note` and
asserts the presented `data` bag has exactly five keys.

## D-020 — The push wake path opens no database

**Decision.** The headless background task does exactly two things: parse the payload and present
the notification. It does not open SQLite, hydrate the store, or restore the member's locale.
**Why.** The locale lives in `t0ConfigRepo`, behind `requireDb()`. Reading it would localise the
alert (NFR-020) at the cost of putting a database open — with its own timeout, lock and corruption
failure modes — on the one code path whose entire job is to make a phone ring within seconds of a
message the OS may already be rate-limiting. A Gujarati-speaking responder reading an English
"NOBODY HAS RESPONDED YET" still gets the short name, the trigger label and the alarm; a responder
whose alert never fired because the DB was locked gets nothing.
**Cost, accepted and logged.** Alerts composed on a headless wake are English until the app opens.
Tracked as 1.35f(b), not silently absorbed.
**Related.** `ensureNotificationChannels()` **is** called there — three cheap native calls, no I/O,
and on API 26+ a notification posted to a channel that does not exist is dropped by the OS with no
error at all.

## D-021 — W10 splits a third time: the presentation half needs a toolchain this machine lacks

**Decision.** W10-b is now the **receive** half only (landed 11 Aug). The full-screen intent (1.37)
and the `showWhenLocked` medical card (1.28) become **W10-c** and were not started.
**Why.** Both are Kotlin: `expo-notifications` exposes no `fullScreenIntent` field at all, so this
is a new `Activity` plus a `setFullScreenIntent` post from the native module. This machine has **no
JDK and no Android SDK**, and the nine CI gates are Go, TypeScript and Node only — so Kotlin written
here cannot be compiled, cannot be run, and cannot be checked by anything in the repo. Writing it
anyway would produce the exact artefact D-010 exists to prevent, with the added twist that not even
`tsc` would notice.
**What the split buys.** W10-b was verifiable off-device and is now verified off-device: 14 tests,
including a wiring test that fails if `defineTask` ever moves out of module scope. That is the whole
of what could honestly be finished without hardware.
**Blocker owner: the user.** W10-c needs a workstation that can build the app, and 1.35d still needs
the Firebase project.

## D-022 — F-21's five lock-screen-safe fields become seven

**Decision.** The data-only push payload gains `kind` (`alert | claimed | released`) and
`ownerShortName`. `docs/02` §2.6.3 is updated; `assertPushSafe` and `readPushFields` are both
widened by exactly these two names and nothing else.
**Why.** §2.6.4 has always said "fan-out of CLAIM goes over BOTH channels simultaneously — never
rely on only one; a backgrounded device may have no WS." That requirement was unbuildable against
the original five, because the payload could not say *what it was about*: a CLAIM delivered over
push would have been parsed as a fresh emergency and rung the MAX/bypassDnd alarm channel at the
exact moment the design says to stop ringing. The alternative — leave CLAIM socket-only — abandons
the requirement for the one device it exists to serve, the one with its app closed.
**Why `ownerShortName` and not just `kind`.** §2.6.4 writes the copy: "Rohan is responding. Stand
by." Without a name the banner reads "Someone is responding", which is precisely the diffusion of
responsibility P-003 exists to convert into a person. It is the same class of string as
`subjectShortName`, gets the same ASCII ≤8 clamp, and is emitted **only** on a claim — a family
member's name on a stranger's lock screen for a rung that does not use it is a leak with no benefit.
**Why this does not weaken F-01.** A claim happens identically on duress and non-duress incidents,
so neither field narrows what an observer can infer about the duress bit. `duress` remains outside
the allowlist and remains asserted on both sides of the wire.
**Fail-safe direction, stated.** Unknown `kind` ⇒ `alert` on the server (`Kind.wire()`) and again on
the device (`asKind`). A claim mistakenly presented as an alert costs one wasted siren; an alert
mistakenly presented as a quiet banner costs the alert.
**Evidence.** `backend/internal/notify/fcm_test.go` — an alert payload is still exactly the five
plus `kind: "alert"` and carries no owner name; `mobile/test/push-receive.test.ts` — a claim with
`duress`/`lat`/`note` attached presents none of them.

## D-023 — The ownership banner gets its own Android channel

**Decision.** A fourth channel, `kavach-ownership`: DEFAULT importance, `sound: null`, no vibration,
`bypassDnd: false`, `lockscreenVisibility: PUBLIC`, posted sticky under `kavach.ownership.<id>`
after the emergency notification is dismissed.
**Why not an existing channel.** P-030 correction 1 asks for three things at once — quiet,
persistent, and readable on a lock screen. `kavach-emergency` is MAX + bypassDnd + alarm stream, so
it rings; that is its entire purpose and must not be softened. `kavach-health` is `PRIVATE`, so
"Rohan is responding" renders as "Notification" to the person deciding whether to grab their keys.
Android does not allow an existing channel's importance or lock-screen visibility to be changed
after creation, so retuning one is not an option on any handset that already has it.
**Why dismiss-then-post rather than replace in place.** Re-posting the same identifier on a
different channel to get "siren → banner" depends on Android's cross-channel replacement behaviour,
which cannot be verified from this checkout — and its failure mode is a phone that keeps screaming.
Two calls, no assumptions.
**Cost.** The family can mute this channel independently in Android settings. That is the correct
trade: it is the one Kavach channel that carries no emergency.

## D-024 — The SMS rung's state guard covers RESOLVING too

**Decision.** `execute`'s `ActionSMSTier` branch now skips `RESOLVING` alongside `PENDING` and
`OWNED`. One line in `internal/escalation/engine.go`, found by writing the characterization tests
for the ladder (W10-e) rather than by reading the code.
**Why it was reachable at all.** `cancelTimers` only touches rows still marked `pending`. A rung a
worker has already claimed is marked `fired`, so CLAIM and ON_SCENE cancel everything *except* the
timer that is in a worker's hands at that instant. The state guard at the top of each branch is the
second line of defence, and it is the only one that applies to a rung already in flight.
**Why it matters.** `RESOLVING` means the owner has physically arrived and only the second party's
confirmation is outstanding — further along than `OWNED`, which was already guarded. The rung would
have spent a billable A2P message, out of a per-family budget (1.49, `DefaultSMSCeiling`), to
escalate an incident somebody is standing over. That is the same trade `Claim()` already refuses
when it declines to broadcast ownership over SMS.
**Scope, stated honestly.** The window is narrow: the timer must have been claimed in the seconds
between the ladder running and the owner arriving. It is not a bug anyone would have hit this month.
It is in a file that decides whether a human is woken, so it is fixed with a test that was shown
failing first, not left as a comment.
**Evidence.** `internal/escalation/ladder_test.go` —
`TestAnInFlightSMSRungIsNotBilledOnceTheOwnerIsOnScene`, red at `187d3110`, green at `d3e7751b`.

## D-025 — `PutTimer` stays a blind upsert; the ladder-reset hole is recorded, not patched

**Decision.** W10-f pinned `store.PutTimer`'s current behaviour — `*old = t`, every column, no guard
on the row's current state — in
`TestPutTimerHasNoStateGuardAndOverwritesAClaimedRow`, and **did not change it**. The related
finding in `sos-ingest.armTimers` is written down (RISK item 15, PHASES) and left unfixed.
**What the hole is.** `armTimers` (`cmd/sos-ingest/main.go:1019`) derives each rung's id
deterministically as `incident|state|action`, and `projectOpen` calls it for an incident that
**already exists** without advancing that incident's state. So a second open record on an existing
incident rewrites the rungs already armed for its current state: `state` back to `pending`,
`fired_at` and `attempts` back to 0, and `fire_at` recomputed from a `ServerReceivedAt` that
`main.go:942` has just moved forward. A rung that already fired can fire again; a rung still pending
has its deadline pushed out — a repeated SOS **delays** the ladder.
**How it is reachable.** Not by bus redelivery — `project()` dedupes on `(incident, hlc)` at
`main.go:882`, and `markSeen` does the same on the request path. The way in is **F-04 coalescing**:
past `floodThreshold` the 4th unverified open from a family inside 60 s is rewritten onto the *first*
incident's id while carrying its **own** fresh HLC, so it passes both dedupes and lands in
`projectOpen` with `exists == true`. ADR-018 makes unverified the *likely* case during a stale key
cache, and pressing SOS repeatedly is what a frightened person actually does.
**Why not fixed here.** Three reasons, in order. (1) The fix does not belong in the store: a state
guard on `PutTimer` would also have to keep `engine.cancelTimers`' read-flip-write working, which
means encoding escalation's state rules in the persistence layer. It belongs in `armTimers` — arm
only what is not already on disk for that `(incident, state)`. (2) That file is
**963/1000 lines** (ADR-002, Gate 4) and `cmd/sos-ingest` has **no behavioural tests at all**; the
house rule for this repo is the characterization test first, and there is no rig there to hang one
on. (3) W10-f is a store phase. Absorbing an ingest fix would make it two.
**Stated honestly.** The store half is proven by a passing test. **The sos-ingest half is read, not
executed** — no test in this repo demonstrates the double-fire end to end, and the severity above is
an inference from four call sites, not a measurement. Proving or disproving it is the next phase,
and it is the first behavioural test `cmd/sos-ingest` would ever have.

---

## D-025 addendum (20 Aug, W10-g) — it reproduced; the guard went into `armTimers`

**What changed.** D-025 above closed with *"proving or disproving it is the next phase"*. W10-g
proved it. `cmd/sos-ingest/projector_test.go` drives a duress SOS through HTTP, the signature check,
the F-04 flood guard, the WAL, the bus and the projector; has a worker claim the `NO_ACK` rung with
`store.FireTimer`; then sends three more unverified reports inside the 60 s window. The fourth
coalesces onto the first incident's id carrying its own HLC, passes `markSeen` and `projSeen` both,
and lands in `projectOpen` with `exists == true`. The claimed rung comes back `pending`, `fired_at`
0, `attempts` 0, `fire_at` 15 s further out, and due again. Every consequence D-025 inferred from
four call sites is what the code does. That reproduction is commit `45663634`, kept as its own
commit so the red is in the history and not only in prose.

**The two bounds the characterization added, which D-025 did not know.**
`TimeoutsFor(PENDING)` is **empty** — an ordinary open arms no rungs at all, so only an incident
that has reached `ACTIVE_L1*` or `OWNED` has a ladder to reset. The way in through a *single* open
record is therefore duress, which skips the cancel window in `projectOpen` itself.

**The fix, and where it did NOT go.** Still not in the store: `PutTimer` remains a blind upsert
because `engine.cancelTimers` reads-flips-writes through it, and a state guard there would mean
encoding escalation's rules in the persistence layer. The guard is in `armTimers`, which reads the
incident's rungs once and skips any id already on disk. **Per rung id, never per incident** —
`project()` marks a record seen only when the whole projection succeeded, so a store failure inside
`armTimers` means the bus redelivers and the second pass sees `exists == true`; skipping by incident
would leave the ladder permanently unarmed on exactly the path that already went wrong once.
`TestArmTimersStillArmsAfterAPartialFailure` is what holds that line. A **cancelled** rung is
skipped too, which closes a second, smaller hole: a repeated open could previously resurrect a
ladder the engine had deliberately cancelled.

**Cost.** 963 → 970/1000 source lines (ADR-002). Additions without removals, against the board's own
instruction, and here is the argument for doing it anyway: the removal that pays for it is
`armTimers` itself, and whether that function should exist is D-026's question, not this one.
Leaving a proven safety bug in place to protect 7 lines of a 37-line budget is the wrong trade.

---

## D-026 — The rungs `sos-ingest` arms are executed by nobody, and that is recorded, not fixed

**Decision.** W10-g found, while proving D-025, that the escalation ladder `cmd/sos-ingest` arms is
never climbed — and **left it alone**. It is written down as RISK item 16 and nothing else.

**What the break is.** Three independent ones, any one of which is sufficient:
1. **Different stores.** `sos-ingest` opens `<data>/store` (`main.go:264`); with
   `KAVACH_SOS_DATA=/var/lib/kavach` that is `/var/lib/kavach/store`. `control-plane`, which owns
   `escalation.Engine`, opens `KAVACH_DATA_DIR` directly (`control-plane/main.go:71`) —
   `/var/lib/kavach/control-plane`. `engine.Run` polls its own store. The two never meet.
2. **Nothing bridges the bus.** The shared bus directory is the documented seam
   (`ops/docker-compose.yml:60`), and `sos-ingest` publishes every incident onto it. The only
   subscriber to `fam.*.incident` is `sos-ingest`'s own projector (`main.go:274`). `control-plane`
   subscribes to `cp.*` only, `realtime-gw` to the notify ticket and stream subjects, `canary` to
   the notify stream. `engine.OnIncidentOpen` has exactly one caller, and it is the control plane's
   own `POST /v1/incidents`.
3. **The action names disagree.** `escalation.arm` names the *work* — `ESCALATE_L2`, `SMS_TIER`,
   `REPEAT_L1` — with a minted UUID per rung. `sos-ingest.armTimers` names the *event*, straight
   from the generated machine, with a derived id. Three of the four actions it can derive
   (`AUTO_QUIESCE`, `PROBE_TIMEOUT`, `PROGRESS_WATCHDOG`) happen to collide with an action the
   engine implements. The fourth is `NO_ACK` — the entire L1→L2→L3 climb — and `execute` has no case
   for it. **Measured, not read:** `internal/escalation/action_routing_test.go` fires every derived
   action from a state that derives it and partitions the results.

**Why it is not fixed here.** Four reasons, in order. (1) It is a topology decision, not a bug fix:
either `control-plane` grows a durable subscriber on `fam.*.incident` that feeds
`engine.OnIncidentOpen`, or the two binaries share a store — and the second is the thing ADR-002
exists to prevent. (2) Whichever way it goes decides whether `armTimers` and `tierFor` should exist
in `sos-ingest` at all; if the engine arms its own ladder from the bus, ~20 lines come out of the
sacred binary and the LOC pressure eases. (3) `cmd/control-plane` has **zero tests**, so the
characterization this repo's rules demand does not exist yet. (4) It is well past one phase.

**Stated honestly.** The routing half is proven by a passing test. The topology half is read from
`main.go`, `control-plane/main.go` and `docker-compose.yml` — file and line given above — and from
an exhaustive grep for bus subscribers. **Nothing here has been run against a live stack**, and the
compose stack has never been brought up on this machine. Do not quote "no rung ever fires" as
measured; quote it as read, and read it yourself before acting on it.
