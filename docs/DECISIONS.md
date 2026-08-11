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
