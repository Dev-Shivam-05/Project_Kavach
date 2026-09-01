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

### D-026 addendum (W10-h, 20 Aug) — two of the three breaks are closed, and the third grew

**What changed.** `cmd/control-plane` now holds a durable subscription on `fam.*.incident`
(`incidentsDurable = "control-plane.incidents"`, `bus.StartAll`) whose handler projects the incident
into the control plane's store and calls `engine.OnIncidentOpen`. The bus leg is closed. The
action-name leg is closed with it, for free and by construction: the engine mints its own rungs, so
what lands on disk is `REPEAT_L1` / `SMS_TIER` / `ESCALATE_L2` / `ESCALATE_L3` / `AUTO_QUIESCE` —
names `execute` has cases for — and never the `NO_ACK` that `armTimers` derives.

The order this repo asks for was followed: `cmd/control-plane/main_test.go` landed first, asserting
that a `fam.*.incident` message armed **nothing** (commit `ae6dc1f7`, green); the subscriber turned
that test red; the same commit inverts it. `newServer` was extracted from `main()` first, as a pure
move, because a question about wiring cannot be answered while the wiring is inline next to a
listener and a signal handler.

**Three decisions inside the handler, each of which could have gone the other way.**

1. **The redelivery guard is "has rungs", not "exists".** `escalation.arm` mints a fresh UUID per
   rung, so an unguarded second delivery appends a *whole second ladder* rather than overwriting the
   first — D-025's mirror image, and `bus.StartAll` replays the entire retained stream at every
   boot, which makes it the ordinary case rather than the exotic one. But guarding on existence
   alone would strand an incident whose projection died between `PutIncident` and `OnIncidentOpen`:
   recorded, unarmed, and permanently skipped. Every incident the engine has opened carries at least
   the F-02 backstop, so "has rungs" is the honest test for "was fully projected". A re-arm re-reads
   the stored incident rather than the envelope, so it cannot rewind a ladder that has already
   climbed.
2. **`initialState` is now one function**, shared with `POST /v1/incidents`. DURESS opens
   `ACTIVE_L1_SILENT` and skips the window outright (§7.5 — a countdown the attacker can watch is
   not a safety feature); everything else opens `PENDING` and the server arms its own copy of the
   device's cancel window, which is what `defaultCancelWindowS` already said it was for ("the device
   may be underwater").
3. **An unknown family drops with a WARN, and does not retry.** The same call `sos-ingest`'s
   projector makes on the same question: there is nobody to escalate to, and five retries then park
   a poison record in front of every other family's incidents.

**What is NOT closed, and it is the bigger half.**

- **The store split stands.** `sos-ingest` still writes `<data>/store` and the control plane still
  reads `KAVACH_DATA_DIR`. That is now correct rather than broken — the bus is the seam and each
  binary owns its store, which is what ADR-002 asks for — but it means the control plane's store is
  the only place an incident's ladder exists, and `sos-ingest.armTimers` still writes rungs into a
  directory nothing polls. Those rungs are now dead weight rather than a broken ladder.
  `armTimers` and `tierFor` should come **out** of `sos-ingest` (~20 lines back into the ADR-002
  budget), and that is a separate phase with its own characterization: `projector_test.go` asserts
  the arming behaviour D-025 fixed, and deleting the function means deciding what those tests become.
- **⛔ Nothing crosses a process.** See **D-027**. Every test that proves the above runs in one
  process on one `*Bus` instance. In the deployed topology no rung reaches a container, and that is
  not a wiring gap this phase could have closed.

**So: is D-026 closed?** No. Its bus leg and its action-name leg are closed and measured; its
premise — that the two binaries can talk at all — turns out to be false one layer down.

---

## D-027 — The file-backed bus does not cross a process, and `ops/docker-compose.yml` assumes it does

**Found** 20 Aug (W10-h), while wiring D-026's subscriber. **Measured**, not read:
`internal/bus/crossprocess_test.go` — the first tests `internal/bus` has ever had.

**What the code does.**
- `Open` replays `stream.wal` **once**, at boot, into `b.msgs` (`bus.go:113`).
- `publish` appends to this instance's file handle and to this instance's slice (`bus.go:190`).
- `drain` walks that slice and nothing else (`bus.go:425`); the 250 ms ticker re-checks the same
  in-memory slice.
- No code path re-reads the file after boot.

**Three measured consequences.**
1. A second `*Bus` on the same directory **never receives** the first's messages. Not late —
   absent.
2. Both instances assign the same `Seq` to different messages.
3. The write offset is fixed at `Open` (`wal.go:75`, `w.size = st.Size()`) and advanced only by that
   instance's own appends (`wal.go:180`). `os.OpenFile` uses `O_RDWR|O_CREATE` — **no `O_APPEND`, no
   file lock** — and `w.mu` is an in-process mutex. So two live writers land every record at the
   same offset and **overwrite each other**. Reopening the directory afterwards finds one survivor.
   In the compose topology the record that gets erased is the SOS `sos-ingest` fsynced and acked to
   a frightened person's phone.

**Why this outranks D-026.** D-026 said the escalation engine was not subscribed to the incident
stream. That was true, and it is fixed. D-027 says that even subscribed, it cannot hear: `sos-ingest`
and `control-plane` are separate containers with separate `*Bus` instances. The same is true of
every other pair — `realtime-gw`'s socket frames, the canary's chain, the consent surfacing job.
**No message in this system has ever crossed a container boundary**, and the four-service stack in
`ops/docker-compose.yml` is four programs that each work alone.

**Not fixed here, deliberately.** Three routes, none of them a phase-sized edit:
1. **Real NATS JetStream**, which `internal/bus` says in its own comments it stands in for. Costs a
   dependency, and `backend/go.mod` must keep zero `require` lines (ADR-006 territory).
2. **Make the file bus multi-process** — a tailing reader plus a cross-process write lock. Needs
   `syscall.LockFileEx`/`Flock` behind build tags in a package that had zero tests until today, and
   a sequence-assignment scheme that survives two writers. Its own phase, probably its own ADR.
3. **Collapse the processes**, which is the thing ADR-002 exists to prevent.

**Stated honestly.** The mechanism is proven by three passing tests, in-process, with two `*Bus`
instances standing in for two containers. **The compose stack has still never been brought up on
this machine.** What is measured is that the transport cannot work across instances; what is
inferred is that containers behave as separate instances do, which follows from there being no
shared memory between them. Read `internal/bus/crossprocess_test.go` before acting on this.

### Addendum — 20 Aug (W10-i): route 2 taken, and it needed no build tags

**The decision: make the file bus multi-process.** Not NATS — `backend/go.mod` keeps zero `require`
lines and ADR-006/ADR-003 would both have had to be amended for a broker a family does not need.
Not "admit it is single-process" either: that is not a compose comment, it is a merge.
`realtime-gw` subscribes to tickets the control plane mints (`main.go:165`) and the canary
subscribes to frames escalation publishes (`main.go:229`), so admitting it means collapsing three
binaries into one and *still* not connecting `sos-ingest`, which is the arrow that matters.

**D-027's own estimate of route 2 was wrong, in our favour.** It said this needed
`syscall.LockFileEx`/`Flock` behind build tags. It does not. `O_APPEND` makes the kernel place each
record at the current end of file under its own lock, so one whole record per `Write` cannot
interleave with or land on top of another process's record — no advisory lock, no build tag, no
syscall. That was measured before it was designed: two OS processes, 500 records each, 1000 intact.

**What it cost instead**, none of which was in the estimate:

- **The writer no longer knows where its record went.** With `O_APPEND` the offset is the kernel's
  to choose, and on Windows the handle's own pointer counts only that process's writes — measured,
  and the reason `wal.Append` returns `-1` in shared mode rather than a number that is right on
  Linux and wrong on the platform the tests run on. Nothing read it: both bus call sites already
  discarded it.
- **`Seq` had to stop being a counter.** It was `len(b.msgs)+1` on whichever instance published, so
  two processes had two names for one record — and a cursor *is* a `Seq`. It is now the record's
  ordinal in the file, assigned when the record is read back, which is also why `publish` reads its
  own record back before returning.
- **`cursors.json` was a second, quieter instance of the same bug — and the first fix for it was
  wrong.** Every process holds a copy loaded at `Open`, so writing the whole copy back reset the
  other process's durables to where they stood at boot: a resolved incident replayed, a climbed
  ladder re-armed. Merge-on-write was the obvious answer and it is not sufficient — the test
  written for it, `TestADurableCursorIsNotErasedByAnotherProcess`, failed on about one run in six
  with `cursors.json = map[sos-ingest.projector:1]`, because two processes that both read before
  either renamed still lose one key. Read-modify-write across processes needs a lock; a file nobody
  else writes needs nothing. So it is **one file per durable** now, `bus/cursors/<name>.cursor`,
  and `SubscribeDurable` refuses a name that cannot be a filename rather than letting a consumer
  silently never persist. A `cursors.json` from an older build is still read at boot, so an upgrade
  resumes instead of replaying its whole stream.
- **Windows will not truncate through an `O_APPEND` handle** (`FILE_APPEND_DATA` without
  `FILE_WRITE_DATA`), so torn-tail repair opens its own.
- **A short tail is no longer evidence of a crash** — it is usually another process mid-`Write` —
  so repair settles for 20 × 5 ms before it truncates, and the header is written once by whoever
  wins `O_EXCL` instead of by every booting container.

**The inference is retired.** `internal/wal`'s `TestTwoRealProcessesAppendToOneSharedLog` and
`internal/bus`'s `TestTwoRealProcessesOnOneBusDirectory` re-execute the test binary as a second OS
process. The container boundary is a process boundary now, not an argument.

**And the arrow connects.** `ops/e2e-two-binaries.sh` runs the real `sos-ingest` and the real
`control-plane` as two processes on one `KAVACH_BUS_DIR` and posts a real SOS to sos-ingest's HTTP
front door. Observed, 20 Aug:

```
ack           {"incidentId":"1111…","verified":false,"flags":1}      <- ADR-018: accept, flag, count
control-plane ingest_incident_projected  state=PENDING trigger=MANUAL <- it heard the other process
              timer_armed AUTO_QUIESCE · timer_armed CANCEL_WINDOW
+20s          transition CANCEL_WINDOW_EXPIRED  PENDING -> ACTIVE_L1
              timer_armed REPEAT_L1 · SMS_TIER · ESCALATE_L2 · ESCALATE_L3
              fanout tier=1 label=L1 devices=0
cursors.json  {"control-plane.incidents":3,"sos-ingest.projector":3}  <- neither erased the other
```

That is D-026 and D-027 both closed, in a deployment shape, for the first time. Two things it does
not say: `devices 0` is correct and is RISK 14 — no device is enrolled and no FCM key exists, so
nobody's phone rang — and **this is two binaries on one host, not four containers.** Docker's daemon
is not running on this machine; `docker compose up` has still never been executed.

**What did not change.** `PublishEphemeral` still writes nothing and `Publish` still rejects
`KindLocationPrecise`; the write path was rewritten underneath that rule, so
`TestClassAPrimeNeverReachesTheFile` now guards it explicitly (§2.4.6). And `Open` — the
single-writer mode `sos.wal` uses — is untouched: ADR-002's durability file writes exactly as it
did, and `internal/wal`'s ten characterization tests were written before any of this and still pass
unmodified.

---

## D-028 — Enrolment is two routes and a bus projection, not a seed command

**Decided and executed** 21 Aug (W10-j), from the spec-lock table in
[spec/w10-j-enrolment.md](spec/w10-j-enrolment.md). Closes **RISK item 18**.

**The choice.** Item 18 said the fix was "one route (`POST /v1/family`) or one seed command, but
which of the two is an enrolment-flow decision (§W4)". It is the route, and it is **two** of them:
`POST /v1/family` and `POST /v1/members`, both `s.auth(s.idempotent(…))`. `POST /v1/devices` already
existed and was already correct — it only ever failed because `PutDevice → requireFamily` had
nothing to find. A seed command would have lived outside all nine CI gates and would still have been
a fixture.

**The part that was not obvious: the two binaries do not share a store.** In
`ops/docker-compose.yml` `sos-ingest` writes `/var/lib/kavach/store` and `control-plane` writes
`/var/lib/kavach/control-plane/store` — one volume, two directories. Pointing both at one directory
is the tempting one-line fix and it is **D-027 again**: `store.persist` rewrites a whole JSON table
under an in-process mutex, so two processes would overwrite each other in the table that decides
whether a signature verifies. So the **row** crosses the bus, never the file:
`bus.KindEnrolmentUpsert` carrying a shared `store.EnrolmentUpsert` on `fam.<id>.enrolment`,
published by the control plane after each successful write and applied by `sos-ingest.project`,
which then calls `refreshCache`.

The type is shared rather than rebuilt on each side on purpose — a field added by the writer and
forgotten by the reader is invisible, and every one of the writer's tests still passes. That bug has
shipped in this repo before (`notify.Fanout`'s neighbour leg).

**What the characterization found, which item 18 understates.** Item 18 says both projectors "drop
an incident whose family row is missing — silently, at WARN". They do, but **the request never gets
that far**: `ingestEnvelope` resolves the family from the in-memory cache and answers **404 unknown
family** (F-04 — "an unknown family is nobody to help"). On a freshly deployed stack the phone does
not receive a flagged ack, it receives an error. That is deliberate and it is now pinned by
`TestEnrolmentTurnsARejectedSOSIntoAProjectedOne`.

**Cost.** `cmd/sos-ingest` went 970 → **995/1000**. The spec locked ≤30 lines of headroom for the
projection and it took 25, so `armTimers`/`tierFor` were **not** deleted to pay for it — that is
still its own queue item, and `projector_test.go`'s four tests still pin what it would delete.

**Observed, not argued** (`ops/e2e-two-binaries.sh`, one run, 21 Aug): five 201s through the control
plane's API; two seconds later `sos-ingest`'s store directory — which nothing wrote into — holds
`family.json`, `member.json` and `device.json`; the SOS is accepted and projected; the ladder climbs
`PENDING → ACTIVE_L1`; and the fan-out line reads **`devices=1`**, where every previous run in this
repo read `devices=0`.

`devices=1` and not 2 because `notify.tierDevices` skips the incident subject's own phone: Priya
sent the SOS, Amit is the guardian who is told about it. **Still nobody's phone rings** —
`KAVACH_FCM_CREDENTIALS` is unset and the enrolled key is 32 zero bytes (RISK 14).

**Recorded, not fixed.** `publishOps("device.key.changed", …)` sends to `notify.OpsSubject`
(`ops.alert`), which **nothing in this repository subscribes to** — a grep across the whole tree
finds four publishers and zero subscribers. Its comment claims sos-ingest refreshes its key cache on
that event; sos-ingest subscribes to `fam.*.>` and has never seen it. The line is left in place with
a note at the call site, because deciding what `ops.alert` is for is not a thing to do while closing
item 18.

## D-029 — the on-device indicator/access-log/kill-switch for camera+mic is not a design choice up for renegotiation

**Decision.** 29 Aug, the user asked for a total redesign including remote family camera and mic
access with "no restrictions" and no on-device indicator, because every family member has already
agreed to the feature existing. The request was declined **as specified**; D2–D6 of
[phase6-pull-forward.md](spec/phase6-pull-forward.md) — frictionless for the viewer, but a
mandatory non-suppressible indicator, an access-log row, and a target-side kill-switch on the
watched device — were held and re-confirmed rather than reopened.
**Why.** This is not new caution — it is the user's **own** 21 Aug decision in this same file,
which names the indicator *"the line between a consented family feature and stalkerware."* A
one-time family agreement at setup does not make a later silent activation of someone's camera or
mic safe or legal in the moment it happens; audio-interception law in most jurisdictions requires
the observed person to know at the time, not once, months earlier. A tool with no indicator is
mechanically indistinguishable from spyware regardless of the stated intent behind it.
**What was NOT declined.** Everything else the user asked for is buildable and mostly does not
collide with D2–D6 at all: family creation, on-demand exact location, camera/mic access that opens
instantly with no approval friction for the viewer, front/back toggle, geofencing. The indicator
lives only on the *watched* device and does not slow the viewer down.
**Consequence.** Spec-locked as
[phase6b-redesign-and-family-watch.md](spec/phase6b-redesign-and-family-watch.md), approved (`go`)
same day.

## D-030 — SOS leaves the tab bar; the trigger and backend do not

**Decision.** The raised centre SOS button in `TabBar.tsx` is removed (29 Aug user decision,
confirmed scope: button only). `app/panic.tsx`, the T0 survival plane, and the whole escalation
ladder are unchanged.
**Why.** The user rated the pre-redesign UI heavy/cluttered and specifically named the SOS FAB;
removing it is most of that fix on its own (a 66dp raised red circle on every screen). The PRD
§6.4 hard requirement (≥88dp, full-width, bottom-third primary action) was never carried by the
FAB — `home.tsx` has always had its own compliant full-width footer button, and the FAB was a
Phase-6 (21 Aug) convenience layered on top of an already-compliant baseline, not the baseline
itself. Removing a redundant convenience while the underlying hard requirement stays intact is not
the same risk as removing the requirement.
**Open item, tracked not forgotten.** Removing the FAB drops SOS from "reachable with zero taps on
every screen" to "one tab away" outside Home — phase **6-D-1b** (docs/PHASES.md) restores a small
per-screen icon and has not landed yet. Do not treat 6-D-1 alone as closing this.

## D-031 — the new tab is "Watch", not "Family"

**Decision.** The new per-member location/camera/mic tab added in phase6-D-1 is named `tab.watch`
("Watch"), route `/watch` — not "Family" as the approved spec's own prose called it in passing.
**Why.** `tab.home` is already the localized string **"Family"** in all three languages
(`i18n/index.ts:60`) — it is the existing dashboard tab's bottom-bar label, discovered while
implementing, not before. Two tabs both labelled "Family" would be a worse redesign than the one
being fixed. "Watch" was picked because it matches the already-locked glossary term **Family
Watch** ([GLOSSARY.md](spec/GLOSSARY.md)) that names exactly this feature area. Resolved as a
defensible default per spec-lock's own rule rather than reopening approval for a label with no
functional consequence.

## D-032 — the icon sweep's scope is the 9 catalogued characters, not "every glyph app-wide"

**Decision.** Spec A4's binary acceptance criterion is a `grep -rn "[⌂◎⚠⚙▣↯▮▤◉]" mobile/`, and that
is what 6-D-2 (both halves) actually targets — not the looser prose in the same row ("replace every
text-character glyph… 1:1 by meaning… not just the tab bar"). Other Unicode glyph characters already
in `ListItem`/`EmptyState`/`Pill` call sites (`✓ ✕ ℹ • ⚑ ▁ — ⚿ ↗ ≋ ◇ ≈ ✚ → ⏱ ✎ ⇄`, etc.) are left as
plain text, untouched, in both 6-D-2a and 6-D-2b.
**Why.** The two readings imply wildly different blast radii: the catalogued set matched exactly 13
files repo-wide (verified by grep before starting); "every text-character glyph" would mean
rewriting `ListItem`/`EmptyState`/`Pill`'s entire default-glyph systems and touching every call site
across the app — tens of files, an undefined and much larger scope than the ≤8-files-per-phase rule
or the "likely more than 8 files" sizing note already in PHASES.md ever anticipated. The spec file's
own contract clause ("no implementation value may appear that is not in a table here") makes the
literal, checkable grep the locked value; the prose is rationale for *why*, not a wider *what*.
**Consequence for 6-D-2b and any future icon work.** Do not "clean up" the untouched glyphs while in
these files for another reason — that is exactly the scope creep this decision heads off. If the
broader sweep is ever wanted, it needs its own spec row and its own file-count estimate, not a
silent expansion of A4.
**How it was implemented.** `ListItem` and `EmptyState` gained an optional `icon?: keyof typeof
Feather.glyphMap` prop, additive next to the existing `glyph?: string` prop — Feather renders in
place of the text glyph when `icon` is given, same colour token, same slot width. `Pill` got a
parallel `DEFAULT_ICON` map used only for the `warn` tone's default mark (`alert-triangle`); a
caller-supplied `glyph` string still overrides it. This is the pattern 6-D-2b should reuse rather
than inventing a second mechanism.

## D-033 — Family Watch's frictionless auto-grant (F2) ships unwired; the join→store bridge does not exist yet

**Decision.** 6-D-4 built spec F2's grant-creation mechanics (`buildFamilyMembershipGrant`,
`grantFamilyMembershipScopes` in `store.ts`) as tested, exported, callable code — and deliberately
did **not** wire it to any call site, and did not build the missing bridge either. Scope confirmed
by the user mid-session (asked directly: plumbing-only-and-flag-it, vs. also building the bridge
now, vs. narrowing to the one flow — `createFamily` — that is real end to end today). The user chose
plumbing-only.
**Why.** F2 assumes grant creation attaches to "the existing enrolment flow" — but no such flow
reaches the safety-plane store. Two candidates exist and neither qualifies: `enrolStore.ts`'s P2P
device-pairing (spoken-fingerprint SAS) is architecturally airgapped by its own header comment ("IT
NEVER TALKS TO A SERVER… never touches `store.ts`"); the server-backed path W10-j proved exists
server-side (`POST /v1/members`) has no client call site anywhere in mobile — only `POST /v1/family`
(`createFamily`) is wired. Building the actual bridge (hooking `store.ts`'s bootstrap to read
`enrolStore`'s `joined` state, or writing the missing `POST /v1/members` client call) is new
architecture beyond F1–F4's locked spec rows, not a wire-up a consent-plumbing phase should absorb
silently.
**Consequence.** `grantFamilyMembershipScopes` is dead code by this repo's own convention #2
("Exists ≠ is wired up") until a future phase builds the bridge. Do not report Family Watch's
frictionless grant as working end to end. The phase that builds the bridge should call
`grantFamilyMembershipScopes` directly rather than reimplementing the grant shape — see the 6-D-4
entry in git history (`docs/HANDOFF.md` as of commit `822258ca`) for the exact call signature and
the two candidate bridge designs.

## D-034 — 6-D-5's Camera/Listen buttons render real grant state, but tapping an enabled one never opens a session or writes an access-log row

**Decision.** `watch.tsx`'s new Camera/Listen icon-buttons (spec B1–B3) compute their
enabled/disabled state from `grantStatusFor('camera'|'audio', ...)` and show the exact locked B3/F4
copy when disabled — real, not fake. Tapping an *enabled* button, though, does not open a live-view
or listen session: those screens, `react-native-webrtc`, and the TURN relay are all 6-D-7's scope
(unbuildable here regardless — D-021). It shows an honest `Alert` ("Camera view isn't built yet" /
"Listening isn't built yet") and writes nothing — no navigation to a stub screen, no
`AccessLogEntry` row.
**Why.** Two tempting alternatives were rejected. A stub live-view screen would have reached into
6-D-7's already-named scope (PHASES.md assigns "the actual live-view/listen screens" there
explicitly) — building it here would be scope creep the ≤8-files phase discipline exists to prevent.
A silent no-op was rejected because a button that visibly changed from disabled-with-a-reason to
enabled, and then does nothing when pressed, reads as a broken control on a feature this session just
proved has a real consent gate behind it — worse than the honest admission that the feature itself
isn't finished. Writing a real `AccessLogEntry` for a session that never opened would be the exact
fabrication D5/E4 and this app's whole honest-empty-state convention exist to prevent.
**Evidence.** `mobile/app/(tabs)/watch.tsx` — `alertWatchActionNotBuilt()`.
**Consequence.** 6-D-7 replaces this `Alert` call with the real navigation/session start — it should
not need to touch the enabled/disabled logic or the reason copy, which 6-D-5 already finished.
Do not report Camera/Listen as "working" beyond "correctly gated and honest about not being live yet."

## D-035 — 6-D-6 needed a cross-member location relay that had never once been wired, and built it

**Decision.** Scoping 6-D-6 (spec C1–C3, "on-demand location push") found that cross-member live
location had **zero working wire path outside demo-mode fixtures**, in either direction: `noteLocationFix`
(`store.ts`) writes only to the local on-device DB and never sends anything; `realtime-gw`'s
`location.report → location.update` relay (`handleMessage`, W1-era code) has always existed
server-side but no client ever called it; and `crypto.locationStreamKey`/`sealJson`/`openJson` — the
Location Stream Key documented in `docs/02-System-Architecture.md` §"content keys" — had never been
called from anywhere. This is the same failure shape `presenceService.ts`'s own header names for
`noteLocationFix`/`evaluateGeofences`/`connectWs` before it existed: "three complete, tested
subsystems with ZERO call sites." Presented to the user as a scope fork (build the relay too, in one
session, vs. split into 6-D-6a/6-D-6b across two) — the user chose to build both in one session.
**Why the design landed where it did — three real constraints, not preferences.**
1. **ADR-010 defence in depth (`net/api.ts`'s `stripClassA`) says no control-plane body may carry
   location, sealed or not.** So the fix is reported to `realtime-gw` (`POST /v1/location-report`,
   new), never to `control-plane`, spending the exact same single-use connect ticket the WS path
   already uses (F-16) rather than inventing a second auth scheme.
2. **The response leg must work from a killed app.** Expo's own docs are explicit that a
   headless-launched task mounts no views — `app/_layout.tsx`'s `bootstrap()` never runs, so
   `store.ts`'s module-level `groupSecret`/`authToken` are unset. `mobile/src/state/locationRefresh.ts`
   reads both straight out of SecureStore instead, and never opens `t0ConfigRepo` (SQLite) to learn
   this device's own id — the exact trade D-020 already declined once, for locale. The push payload
   itself now carries the target's own `deviceId` for that reason (`fcm.go`'s `pushSafeKeys` grew
   `type`/`requestId`/`deviceId`).
3. **`net/ws.ts` is the wrong shape for a fire-and-forget report.** It is a stateful,
   SQLite-cursor-backed singleton built for a long-lived connection with reconnect/backoff/heartbeat —
   not a one-shot POST from a task that may have seconds of budget left. A plain `fetch` is what that
   budget affords, so the client never opens a WebSocket to report a headless fix.
**Evidence.** `backend/internal/notify/{fcm.go,notify.go,location_refresh_test.go}` (the request leg,
FCM-only, bypasses `Fanout`) · `backend/cmd/control-plane/main.go` `requestLocationRefresh` +
`location_refresh_test.go` · `backend/cmd/realtime-gw/main.go` `reportLocation` + `report_test.go`
(realtime-gw's first tests) · `mobile/src/state/{locationRefresh.ts,pushReceive.ts}` ·
`mobile/src/state/store.ts` — the new `location.update` case in `handleWsFrame` is the only place
`openJson`/`locationStreamKey` are called anywhere in the client · `mobile/app/(tabs)/watch.tsx` —
the Refresh button.
**Consequence — what this does NOT close.** `presenceService.ts`'s ordinary `watchPositionAsync` tick
(the "existing 10s-foreground watch" C1's own prose assumes already broadcasts) still calls only
`noteLocationFix`, which still never leaves the device. Only a push-triggered Refresh reports a fix.
Ambient/continuous cross-member sharing while both apps are simply open is still not wired — same
category of gap as D-033's join→store bridge: flagged, not silently folded into this phase. A future
phase closing it should have a **foregrounded** device send over its own already-open `net/ws.ts`
socket directly (`sendFrame({type:'location.report', ...})`, sealed the same way) rather than reusing
`locationRefresh.ts`'s ticket+POST path, which exists specifically for the headless case.

## D-036 — 6-D-7 split: the Family Watch session plane ships (and is testable here); the media does not, so nothing in `app/` may open a session yet

**Decision.** 6-D-7's phase row bundles two things a single session cannot honestly deliver together
on this machine: the **session plane** (who invited whom, whether the watched phone's own grants
still allow it, the mandatory indicator's state, E2's 5-minute budget and "+5 min", D3's flip, D4's
End, D5/E4's two access-log rows) and the **media** (`react-native-webrtc`, a peer connection, a TURN
relay). The first is pure TS + one Go handler and is fully verifiable here. The second needs a device
build: `java -version` now succeeds on this machine (JDK 17, `JAVA_HOME` set — PROJECT_MAP.md's "no
JDK" line is stale) but **`ANDROID_HOME`/`ANDROID_SDK_ROOT` are still unset**, so D-021 stands
unchanged in practice. Split into **6-D-7a** (this session) and **6-D-7b** (needs a device build the
user triggers).

**The plane ships with no UI call site, deliberately.** GLOSSARY.md's Family Watch entry is explicit:
"This pairing — instant for the viewer, always visible to the watched — is what the spec calls the
line between a consented family feature and stalkerware. **Do not build one half without the other.**"
Wiring `watch.tsx`'s Camera/Listen buttons to `startWatchSession` in this build would open a session
that tells someone *"X is viewing your camera"*, writes a `camera_view_started` access-log row, and
carries no camera. That is the exact fabrication D-034 refused for the same buttons one phase ago, so
6-D-5's honest "isn't built yet" alert stays in place and `watchSession.ts` ships with zero call sites
from `app/` — the same deliberate state `grantFamilyMembershipScopes` shipped in for D-033's reason.
`store.ts` **does** route inbound `watch.signal` frames into it, so the receive half is wired; nothing
can send one until 6-D-7b installs a `WatchMedia`. Report this as "exists, not wired to the UI"
(CLAUDE.md convention 2), not as Family Watch being done.

**Design points worth not re-deriving.**
1. **The watched phone is the authority on consent, not the viewer.** F-14 makes Layer-1 revocation
   instant on the revoker's own phone and lets the key ratchet lag, so the viewer's grant list is
   exactly the copy a revocation has not reached. `onInvite` therefore re-checks against the watched
   device's own grants (`outboundGrantStatusFor`, new in `domain/consentStatus.ts` — `grantStatusFor`
   reads "their grant to me" and could not express "my grant to them") and declines with F4's copy.
2. **The access-log row is written BEFORE the accept goes out.** D2 pins the indicator at "before the
   viewer's first frame renders, not after"; making the answer depend on the row is the only way to
   guarantee that ordering rather than hope for it. Pinned by an ordered event log in the test, not
   by reading the code.
3. **Persistence is a `WatchContext` callback, not a `db/repos` import.** Two reasons, both real:
   `db/repos.ts` cannot be imported under the Node test shim at all (it reaches
   `t0/stateMachine.generated`, whose `.generated` reads as a file extension to the shim's
   `resolveExtensionless`, so the specifier never gets `.ts` re-added), and the store keeps its own
   in-memory `accessLog` that Settings › Privacy renders — a write straight to SQLite would leave that
   list stale until the next launch. `store.ts` does both legs, exactly as `findPhone` already does.
4. **`store.ts` imports `watchSession.ts`, so `watchSession.ts` may not import back.** Everything
   store-shaped arrives as an explicit `WatchContext` — the same circular-value-import trap 6-D-6
   split `readLocationRefreshFields` out to avoid. It also makes the whole plane drivable from a test
   with no store, no socket and no database.
5. **`watch.signal` is HIGH on the wire, not LOW and not CRITICAL.** LOW coalesces per key, which
   would keep only the last ICE candidate and produce a session that never connects. CRITICAL is for
   a responder's understanding of who is going (§2.5.2); a lost watch session is a feature degrading.
6. **The gateway relays ciphertext and takes the sender from the TICKET.** `sessionId`/`toMemberId`
   are cleartext routing fields; the signal body is sealed under a new `crypto.watchSessionKey`
   (`deriveKey(secret, 'watch', sessionId)` — identical construction to `incidentContentKey`), with
   `sealJson`'s AAD binding it to the same session id a second time so a relayed signal cannot be
   replayed into another session. A body-supplied `fromMemberId` would let any family member forge an
   invite from any other; `signal_test.go` pins that it is ignored.
7. **`durationS` (D5/E4) is left derivable rather than persisted.** `AccessLogEntry` has no such
   column and `db/schema.ts` still carries exactly one migration (the baseline). `ended.at − started.at`
   for the same pair gives the same number; making this app's first-ever schema migration for a
   derivable value is not the trade. Note also that `context` MUST stay `'routine'` — `consent.tsx`'s
   `incidentTag` renders any other value as "During an incident".

**Evidence.** `backend/cmd/realtime-gw/main.go` (`watch.signal` case in `handleMessage`) +
`signal_test.go` (3 tests, incl. the F-20 reduced-session guard) · `mobile/src/crypto/index.ts`
(`watchSessionKey`) · `mobile/src/domain/consentStatus.ts` (`outboundGrantStatusFor`) ·
`mobile/src/state/watchSession.ts` (new) · `mobile/src/state/store.ts` (`watch.signal` case,
`watchContext()`) · `mobile/test/watch-session.test.ts` (22 tests).

**Consequence.** 6-D-7b owns: `react-native-webrtc` + TURN, a `WatchMedia` implementation behind
`setWatchMedia()`, the viewer's live-view screen (D3's flip control, E2's countdown ring and "+5 min"),
the watched device's non-suppressible banner + dot + start-sound (D2/D3), and only then wiring
`watch.tsx`'s two buttons to `startWatchSession`. None of it is verifiable here until an Android SDK
exists on this machine or the user runs a device build.
