# Phases — status board

Authoritative plan: [docs/03-Implementation-Guide.md](03-Implementation-Guide.md) §3.3–§3.7.
This file is the **status of that plan against the code at HEAD**, re-verified 2026-08-11.

`✅` done and wired · `🔨` incomplete · `⛔` blocked on something code cannot do

> **Two traps.** `W1…W16` are **week numbers, not workstream ids** — they run continuously across
> Phases 0 and 1. Each phase's soak is *inside* its week range, not added on top.

---

## Now

> ★★★ **31 Aug — Phase 6-D (nav redesign + Family Watch) is the active work, per the 21 Aug
> decision to pull Phase 6 ahead of Phase 1.** Spec locked and approved 29 Aug:
> [phase6b-redesign-and-family-watch.md](spec/phase6b-redesign-and-family-watch.md). **6-D-1, 6-D-1b,
> 6-D-2a, 6-D-2b, 6-D-3, 6-D-4, 6-D-5 and 6-D-6 have all landed** — 5-tab flat nav, the SOS FAB is gone,
> a new Watch tab lists every member's location status, Map/Incidents/Settings/Watch each carry a small
> outline SOS icon in their header, **the icon sweep (spec A4) is fully closed**: `grep -rn
> "[⌂◎⚠⚙▣↯▮▤◉]" mobile/` returns nothing anywhere in the app, **visual density (A5/A6) is done**:
> `Pill`'s `neutral`/`info` tones render outline-only, eight standalone notice-card containers carry
> `space.lg` padding with a `space.md` minimum row gap, **consent plumbing (spec F1–F4) is done**:
> `camera` is a real `ConsentScope` end to end (mobile types + backend `validScopes` + migration
> comments), `family_membership`-grant build/renew/status logic exists and is tested, **Watch tab
> Camera/Listen buttons (spec B1–B3) are done**: each member card renders them enabled/disabled from
> real grant state with the exact B3/F4 copy, and tapping an enabled one is honest that the live
> session isn't built rather than faking one (D-034), and **on-demand location refresh (spec C1–C3) is
> done**: the Watch tab's Refresh button push-triggers a one-shot GPS fix, 8s honest spinner, and — the
> part that turned out to be the real work — a cross-member location relay that had **never once been
> wired in either direction** before this phase (D-035): `realtime-gw` gained its first-ever tests
> (`POST /v1/location-report`, ticket-authed, no new control-plane surface per ADR-010), and
> `store.ts`'s `handleWsFrame` now has the only `location.update`/`locationStreamKey` decrypt call in
> the client. ⛔ **F2's auto-grant-on-join is still NOT wired to any call site** — there is no real "a
> member just joined" event in this codebase yet to attach it to (D-033) — so in the running app
> today, virtually every card actually shows the B3 "not sharing yet" reason for camera/audio, not the
> granted state 6-D-5 also makes possible. ⛔ **Ambient/continuous cross-member sharing is still not
> wired** — only a push-triggered Refresh reports a fix; `presenceService.ts`'s ordinary
> `watchPositionAsync` tick still never leaves the device (D-035's consequence). See the Phase 6-D
> table below for the full 8-phase breakdown (6-D-1 through 6-D-8) and [DECISIONS.md](DECISIONS.md)
> D-029 through D-035 for what was and was not renegotiated along the way — in particular, the
> on-device indicator/access-log/kill-switch for camera+mic access (D-029) is a fixed constraint
> carried over from the user's own 21 Aug decision, not open for reinterpretation in any later 6-D
> phase.
>
> **1 Sep — 6-D-7 split into 6-D-7a (landed) and 6-D-7b (blocked), per D-036.** The row bundled two
> things one session cannot honestly deliver together here. **6-D-7a shipped the session plane**:
> `realtime-gw`'s `watch.signal` relay (opaque ciphertext + two routing fields, sender taken from the
> connect ticket) and `mobile/src/state/watchSession.ts` — invite/auto-accept/decline, the watched
> phone's own grants as the authority (F-14: the viewer's copy is the one a revocation has not
> reached), D5/E4's two access-log rows with the row written **before** the accept goes out (D2's
> ordering), E2's 5-minute Listen budget and repeatable "+5 min", D3's viewer-driven flip, D4's End
> from either party. ⛔ **It has no call site in `app/` on purpose.** GLOSSARY.md: "Do not build one
> half without the other" — without media, opening a session would tell someone *"X is viewing your
> camera"* and carry no camera, the exact fabrication D-034 refused one phase ago. 6-D-5's honest
> "isn't built yet" alert stays; `store.ts` routes inbound `watch.signal` frames, so the receive half
> is wired and nothing can send one until a `WatchMedia` is installed.
>
> **Next: 6-D-7b** — `react-native-webrtc` + TURN + the live-view/listen screens + the watched
> device's non-suppressible banner/dot/sound, then wiring `watch.tsx`'s two buttons. **Still
> unverifiable here**: `java -version` now succeeds (JDK 17, `JAVA_HOME` set — PROJECT_MAP.md's "no
> JDK" line is stale), but `ANDROID_HOME`/`ANDROID_SDK_ROOT` are unset, so D-021 stands in practice.
> 6-D-8 (geofencing arbitrary-location placement) remains the fully-verifiable-here alternative.

> ★ **D-026 and D-027 are both closed (20 Aug, W10-h + W10-i), and Phase 1's last arrow connects.**
> Observed, not argued: `ops/e2e-two-binaries.sh` posts a real SOS to the `sos-ingest` binary and
> the `control-plane` binary — a separate OS process on one `KAVACH_BUS_DIR` — projects it, arms
> `AUTO_QUIESCE`+`CANCEL_WINDOW`, and 20 s later climbs `PENDING → ACTIVE_L1` and arms
> `REPEAT_L1`/`SMS_TIER`/`ESCALATE_L2`/`ESCALATE_L3`.
>
> W10-h closed D-026's bus and action-name legs (`cmd/control-plane` subscribes to `fam.*.incident`
> and calls `engine.OnIncidentOpen`) and found D-027 underneath: `internal/bus` could not deliver
> across a process at all. **W10-i closed that** — `stream.wal` is opened `O_APPEND` so the kernel
> places each record at the end of the file under its own lock, and `bus.poll()` tails it on the
> 250 ms ticker it already had. No dependency and no build tags; D-027 expected
> `LockFileEx`/`Flock` and was wrong about that. `Seq` is now the record's ordinal in the *file*,
> which is what makes one container's cursor mean anything to another.
>
> ⛔ **Two things this does NOT say.** `devices 0` in that fanout line is correct — nobody's phone
> rang, because no device is enrolled and no FCM key exists (1.35d, RISK 14). And **`docker compose
> up` has still never been run on this machine** — Docker's daemon is not running, so the evidence
> is two binaries on one host, not four containers. `realtime-gw`'s socket frames and the canary's
> chain now rest on a transport that works, but nobody has watched either.
>
> ★ **W10-j (21 Aug) closed RISK 18: a running stack can now enrol itself, and that fanout line
> reads `devices=1`.** `POST /v1/family` and `POST /v1/members` exist (`POST /v1/devices` always
> did), every default and check copied from `migrations/0001_init.sql`, and each write publishes
> `bus.KindEnrolmentUpsert` on `fam.<id>.enrolment` so `sos-ingest` — which keeps its own store
> directory — learns the row over the bus instead of from a file somebody else writes.
> `ops/e2e-two-binaries.sh` seeds nothing by hand any more: five requests, and two seconds later
> sos-ingest's untouched directory holds `family.json`, `member.json` and `device.json`. The
> characterization found something item 18 understated — an SOS for an unknown family is not dropped
> quietly by the projector, it is refused at the front door with **404 unknown family** (F-04). It
> also found **RISK 19**: nothing subscribes to `ops.alert`, including the P0 SMS-budget alarm.
> `devices=1` is still not a phone ringing (RISK 14), and `cmd/sos-ingest` is now **995/1000**.

**Phase 1 · W10-c — present the alert on a locked screen.** The receive half landed on 11 Aug
(W10-b): a data-only FCM message now wakes the bundle, is read through an allowlist, and is
presented on the bypass-DND alarm channel. **W10-d** followed the same day and closed **1.32** — a
CLAIM now fans out over push as well as the socket, and the receiving phone presents it as a quiet
banner naming the responder instead of a second alarm. What is left is **1.37** (full-screen intent)
and **1.28** (`showWhenLocked` medical card) — one `Activity` in `modules/kavach-t0/android/`, since
both are the same native work and `expo-notifications` has no `fullScreenIntent` surface at all.
**W10-e** followed W10-d on the same day and wrote no feature at all: with W10-c unreachable on this
machine it spent the session on the coverage debt underneath W9 instead, pinning the escalation
ladder (1.31) and the timer wheel (1.29) with 40 characterization tests and closing the one gap they
found (**D-024**, the SMS rung was still billable at `RESOLVING`). **W10-f** did the same on the
same day, one layer down: 15 tests over `store.FireTimer` — the atomic claim the whole no-leader
design rests on, which W10-e could only exercise through a hand-written double. It found the ladder
can be **re-armed after it has already climbed** (RISK item 15, **D-025**) and recorded that rather
than fixing it: the fix belongs in `sos-ingest`, which has 37 lines of headroom and no behavioural
test to hang a characterization on. **W10-g** (20 Aug) executed it. D-025 reproduces exactly as
written — a coalesced repeat SOS puts a rung an escalation worker is holding back to `pending` with
`attempts` 0 and its deadline 15 s further out — and the guard now sits in `armTimers`
(963 → 970/1000). While proving it, W10-g found something larger and did **not** fix it: **nothing
executes the rungs `sos-ingest` arms.** The escalation engine polls a different store, no process
subscribes to `fam.*.incident`, and `NO_ACK` is not an action `execute` implements. RISK item 16,
**D-026**. **W10-h** (20 Aug) went and closed it — and found the floor underneath. It extracted
`newServer` from `main()` so the wiring was reachable, wrote `cmd/control-plane`'s first test
asserting that a published incident armed **nothing** (green, its own commit), then added a durable
subscriber on `fam.*.incident` that projects the incident and calls `engine.OnIncidentOpen` and
watched that test go red before inverting it. Nine tests now. Two of D-026's three breaks are shut:
the bus leg, and the action names — the engine mints its own rungs, so `NO_ACK` is never written.
Then, while proving it, W10-h measured why none of it reaches a container: **`internal/bus` is
in-process only.** `Open` replays the log once into a slice, nothing tails the file, and two writers
put every record at the same offset and overwrite each other. RISK item 17, **D-027**. **W10-i**
(20 Aug) took that decision and closed it. `java -version` was checked first and W10-c was again
unreachable. Route: make the file bus multi-process, stdlib only — not NATS (`go.mod` keeps zero
`require` lines) and not "admit it is single-process", which is a merge of three binaries and still
would not connect `sos-ingest`. `internal/wal` got its first tests — **ten characterizations before
a line of it changed**, since it is the file ADR-002 rests on — then `OpenShared`: `O_APPEND`, one
whole record per `Write`, `Tail` re-stats the file. `internal/bus` tails on its existing 250 ms
ticker, `Seq` became the record's ordinal in the file, and cursors moved to one file per durable —
merge-on-write was tried first and **measured losing** a cursor on roughly one run in six. Then the honest part: both
packages got a test that **re-executes the test binary as a second OS process**, and
`ops/e2e-two-binaries.sh` ran the two real binaries end to end and watched the ladder climb. What is
left of D-026 is tidying — `armTimers` writing rungs nothing polls — and what is left of D-027 is
that nobody has run `docker compose up`.

> ⛔ **Two independent blockers, both outside code.**
> 1. **No Firebase project.** `google-services.json`, an `android.googleServicesFile` line in
>    `app.json`, and a service-account key at `KAVACH_FCM_CREDENTIALS`. Free, ~15 min,
>    **owner: the user.** W10's exit criterion is a physical device ringing through DND (D-018).
> 2. **No Android toolchain on this machine.** Re-checked 1 Sep: a **JDK now exists** (OpenJDK 17,
>    `JAVA_HOME` set — the older "no JDK" wording here and in PROJECT_MAP.md was stale), but
>    `ANDROID_HOME` and `ANDROID_SDK_ROOT` are still unset, so D-021's conclusion is unchanged:
>    Kotlin written here cannot be compiled, let alone run, and the nine CI gates are Go/TS/Node
>    only. W10-c is the first phase whose output no gate in this repo can check (D-021).

## Next 3

> ★★★ **Superseded for now by Phase 6-D (29 Aug).** The actual next 2, in order: **6-D-7b** (native
> WebRTC camera/mic transport — hits the D-021 wall; the TS/state/signalling layer was built
> separately as 6-D-7a and is done), **6-D-8** (geofencing arbitrary-location placement, an interim
> lat/lon text-entry fallback that does not need 6-B's MapLibre first, fully verifiable on this
> machine). 6-D-1 through 6-D-7a are closed — 6-D-6 (31 Aug) touched Go as well as TS
> (`internal/notify`, `cmd/control-plane`, `cmd/realtime-gw` — the last of these got its first-ever
> tests) and is the reason "backend" stopped meaning "no JDK needed but also no Go" for this phase
> group. The device-gated list below is what comes after Phase 6-D's verifiable slice (6-D-1 through
> 6-D-7a, 6-D-8) is done.

> ⚠ **All three need an Android SDK. Check `ANDROID_HOME` before picking one, not after** — and
> note that `java -version` is no longer the check that fails (a JDK arrived; the SDK did not).
> W10-d exists because that check was run first on 11 Aug; the alternative was a session of Kotlin
> that no gate in this repo can compile, run, or check, with every familiar green tick still green
> (D-021).
>
> ⛔ **And none of the three is the highest-value work available.** D-027 was the top of the board
> on 20 Aug and is closed; **enrolment (RISK 18) was the next one and closed on 21 Aug** — the
> fan-out line reads `devices=1` now. What replaces both needs no JDK either: **bring the compose
> stack up**, the one claim in this repo that has never once been executed. See "the queue as it
> stands" below. This list stays as-is because these three are the *named* phases, not because they
> are next.

1. **W10-c (1.37 + 1.28)** — full-screen intent and the `showWhenLocked` medical card. *(above)*
2. **Hardware trigger (1.16, 1.17)** — `PowerButtonWatcher` (5× in 3 s) and `VolumePatternWatcher`
   (vol-down 3 s, screen off). Both **absent**; nothing in the app observes a hardware button, which
   makes `PocketSuppressor` (1.19, complete) a guard on a door nobody can open. A panic button you
   must unlock the phone and open an app to reach is not a panic button.
3. **Exact-alarm Kotlin watchdog (1.13)** — `exactAlarmsPermitted` is *checked* and no exact alarm is
   ever *scheduled*, so on a force-stopped app on an aggressive OEM nothing resurrects the agent.
   §4.12 names OEM battery managers as risk #3.

**On a machine with no JDK, do these instead** — fully covered by the nine gates. **W10-e, W10-f,
W10-g, W10-h, W10-i and W10-j did the first six**: the escalation ladder and the timer wheel are pinned by 40
tests (`escalation/ladder_test.go` 24, `escalation/timer_test.go` 16), which found and closed D-024;
`store.FireTimer` by 15 more (`store/timer_test.go`), which found D-025; the projector's arming path
by 4 (`sos-ingest/projector_test.go`), which proved D-025 and closed it; and the control plane by 9
(`cmd/control-plane/main_test.go`, its first), which closed D-026's bus leg — while three more
(`internal/bus/crossprocess_test.go`, also its first) found D-027 underneath it. **W10-i** then gave
`internal/wal` its first 19 — ten characterizations written before a line of it changed, nine for
the new shared mode — and rewrote the bus's three into seven, closing D-027. **W10-j** closed
RISK 18 the same way: three characterizations first (`POST /v1/family` and `POST /v1/members` were
405s; an enrolment record on the bus reached sos-ingest's store not at all), each shown red before
the code that inverted it, ending in eleven more tests across the two binaries. What is still
unpinned in `escalation`: `Cancel` and its duress twin, `Ack`, `OnScene`, two-party `Resolve`, and
the HLC.

> ★★★ **#1 PRIORITY — 21 Aug user decision: pull Phase 6 forward. It is now the top of the queue,
> ahead of everything below.** This overrides the 11-Aug "Phase 6 runs after the Phase 1 gate"
> sequencing. §4.12 names scope-creep-before-the-gate as the single most likely way this project
> dies — flagged in one line, and it is the user's call; recorded, not argued. **Not yet
> spec-locked, no code written.** Scope, in the user's own words:
>
> - **A big centre panic button in the tab bar** — voice-assistant style, sits in the middle of the
>   bottom tabs, easy to hit with a thumb. → Phase 6 **6.6**.
> - **Every member sees every other member's EXACT LIVE LOCATION** on a real map. Worked example the
>   user gave: a 5-person family scattered across Surat / Gonda Devi / Lunsikui / Kabilpore / home;
>   the Kabilpore member opens the tab and sees exactly where the other four are. → Phase 6 **6.5**.
> - **A real basemap** with **satellite / street / traffic / standard** layers, zoomable and pannable
>   "like iPhone Maps". → Phase 6 **6.5**.
> - **Every member can reach every other member's CAMERA and MICROPHONE** (the user's example: the
>   Kabilpore member viewing the Surat member's live camera). → Phase 6 **6.4**.
> - **A new theme and a total UI rebuild** — the user rates the current UI −5/10. → Phase 6 **6.8**.
>
> **Four hard collisions this must resolve with NEW ADRs, not by ignoring the old ones** (see the
> Phase 6 table and "★ How to build Phase 6 without breaking the product" further down):
>
> 1. **Exact-location-always vs ADR-010 / P-008 / F-14.** "Always exact" removes the consent-grant
>    gate the map exists to enforce. Build it on the existing `live_location` grants — mutual,
>    revocable, logged, freshness shown — so it is exact AND honest, not a silent tracker. The
>    plumbing is already there; the grants just have to be mutual by default within a family.
> 2. **Satellite/street/traffic basemap vs ADR-010.** Every third-party tile is a silent precise-
>    location disclosure with no grant and no access-log row, and tiles need network in the one
>    moment the map matters (ZERO_INFRA). Phase 6's stated path: pre-cached open imagery
>    (Sentinel-2 / Landsat) for the family's own box + `react-native-gesture-handler` for pinch/pan;
>    Google/Mapbox terms forbid caching. Street/traffic are online-only third-party feeds — decide
>    per layer whether they are worth the leak.
> 3. **Mutual camera + mic vs P-024 / ADR-017.** Today `camera-view.tsx` is a KILL SWITCH by design:
>    you can only turn a camera OFF from another phone, ON needs physical presence, "an objection can
>    never be overruled from another room." Remote view + listen is the exact inversion, and the
>    app's own threat model says the person most likely to be filmed by a family camera is a family
>    member. **Non-negotiable build constraint:** every remote camera/mic session carries a mandatory,
>    non-suppressible on-device live indicator + an access-log row + a per-target consent grant. That
>    is the line between a consented family feature and stalkerware — and it is exactly the user's own
>    stated value ("kuch chhupā nahi, koi privacy problem nahi"). Push notifications stay optional as
>    the user asked; the on-device indicator does not.
> 4. **The user's own example answers 6.4's one open question.** Kabilpore→Surat is across-city, so
>    "truly offline video" is off the table — no app carries video across a city with no network. It
>    becomes WebRTC over the internet with a TURN relay ("works on bad networks"), not Wi-Fi Direct.
>
> **SPEC LOCKED + APPROVED 21 Aug** → [spec/phase6-pull-forward.md](spec/phase6-pull-forward.md).
> Three additions folded in on approval:
>   - **Family creation + a size cap** (E) — create a family, set `max_members` (2–20, default 6),
>     and the (cap+1)th enrolment is refused server-side with 409 `KV-1012 family_full`. New column
>     in `0001_init.sql` + `store.Family` + store_test (ADR-006/D-003).
>   - **A family "private space" identity** (E5) — `display_name` + deterministic crest + Family ID +
>     a shield line, so it is unmistakable this space is one family's and private.
>   - **100% mock-data removal now IN scope** (G) — user override of the earlier "sequence after
>     push" call. `demo.ts` deleted, `demoMode` default → false. **Consequence, flagged and
>     accepted:** every screen empties unless the real-data path lands with it, so G is the LAST step
>     of 6-A and rides the family-create flow (E). Honest empty states replace fabricated ones.
> **Build order:** 6-A (theme+nav+rebuild+family+mock-removal — all verifiable here) ships first and
> fully; 6-B (MapLibre map) and 6-C (Family Watch camera/mic) need a device build + keys + infra
> (D-021) and ship after, design+ADR locked. RISK 20 governs the surveillance-safety constraints.
>
> **★ Progress (22 Aug) — 7 commits on `shivam`, each verified (tsc/tests/go-gates):**
>   - ✅ **A2** teal brand accent tokens + contrast-test coverage (the light-fill trap pinned).
>   - ✅ **E4** `family.max_members` column + first family column-parity test (red→green).
>   - ✅ **E2/E3** family size cap — (cap+1)th member → 409 `KV-1012`; go/vet/staticcheck/archlint, LOC 995.
>   - ✅ **B / 6.7** centre SOS button + 4-tab custom bar (`src/ui/TabBar.tsx`); Consent → Settings › Privacy.
>   - ✅ **E5** deterministic family crest + "private space" identity on Home/Settings (5 unit tests).
>   - ✅ **E1** create/name a family + set size 2-20 (`app/create-family.tsx` + `store.createFamily` + `api.createFamily`).
>   - The **family feature is end-to-end** now (create/name/size → server cap → identity crest).
>   **Remaining in 6-A:** **A4** the fuller visual rebuild (typecheck-verifiable, but VISUALS need a
>   device — D-021), and **G** 100% mock removal — user decision 22 Aug: **do G LAST, after the app
>   runs on a device/backend** so real data fills the screens it empties. **6-B/6-C** unchanged
>   (native + keys + infra + device).

**Then, after the Phase 6 pull-forward above, the no-JDK queue as it stood:**
1. **Bring `ops/docker-compose.yml` up.** ★ *Now that the transport works and a stack can enrol
   itself, this is the last unexecuted claim in the repo.* Every statement about the four-container
   topology — including the ones written on 20 and 21 Aug — is either a Go test or two binaries on
   one host (`ops/e2e-two-binaries.sh`). Docker's daemon is not running on this machine, so step one
   is starting Docker Desktop. **RISK 18 no longer stops it**: the stack can now be brought up empty
   and enrolled over its own API, which is what `ops/e2e-two-binaries.sh` does in five requests.
   Expect to find other things; W10-i's whole lesson is that a plausible sentence about a deployment
   is worth nothing next to one run of it. `realtime-gw`'s socket frames and the canary's chain have
   never been observed either.
2. **Take `armTimers` and `tierFor` out of `sos-ingest`.** D-026's leftover, and it costs more than
   it did: the binary is at **995/1000** since W10-j's enrolment projection. The engine arms the
   ladder from the bus now, so the rungs the projector derives are written into a directory nothing
   polls: dead weight in the one binary with a LOC ceiling. ~20 lines back into the ADR-002 budget.
   `projector_test.go` pins the behaviour being deleted, so the phase is really "decide what those
   four tests become" — not a delete.
3. **The rest of `escalation`** — `Cancel`'s duress twin is a constant-time sibling of `verifyPin`
   and deserves the same care.
4. **Decide what `ops.alert` is for (RISK 19, found 21 Aug).** Four kinds are published to it,
   including `ops.budget_breached` marked `severity: P0`, and nothing in the repository subscribes.
   A page-worthy alarm that nobody receives is not an alarm.
5. **Phase 2's `policyRepo.byVersion()`** — one repo method, and without it a six-month-old incident
   renders under today's rules while labelled with yesterday's version.

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
| 1.4 | At-least-once bus, durable cursors | ✅ | `backend/internal/bus/bus.go`. Not NATS; the ADR-007 semantics are preserved. **Multi-process since W10-i (D-027)** — `O_APPEND` writes, a tailing 250 ms poll, `Seq` as the record's ordinal in the file, one cursor file per durable. Proven by two real OS processes; `internal/wal` got its first 19 tests underneath it |
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

### W9 — Escalation engine ✅ (two gaps) — ⛔ **and still not reachable from a real SOS**

> Every ✅ in this table is true of the engine **in one process**. W10-h wired the missing arrow:
> `cmd/control-plane` holds a durable subscription on `fam.*.incident` that projects the incident and
> calls `engine.OnIncidentOpen`, so an SOS no longer has to arrive through the control plane's own
> `POST /v1/incidents` to get a ladder. **D-026's bus leg and action-name leg are closed** and proved
> by `cmd/control-plane/main_test.go`.
> ⛔ **And it still does not run end to end**, because `internal/bus` does not cross a process:
> `sos-ingest` and `control-plane` are separate containers with separate in-memory streams, and their
> writes overwrite each other on disk. **D-027 / RISK 17.** Do not read a ✅ below as "this fires for
> a real SOS" until that is closed.
| 1.29 | Durable timer rows, N workers, atomic claim, no leader | ✅ | `internal/escalation/engine.go` — the header refuses `time.AfterFunc` explicitly. **Pinned by `escalation/timer_test.go` (W10-e, 11 Aug):** claim exclusivity on both the transactional and the optimistic path, fire order, batch limit, the 60 s overdue P0 page (§2.11.5), re-arm-then-abandon, adaptive poll. **The claim itself is pinned by `store/timer_test.go` (W10-f):** 16 goroutines on one row yield one winner; the claim is on disk before it returns, so a restarted worker cannot re-fire it; the persisted key set and the three state literals match `migrations/0001_init.sql` column for column. Two divergences from that migration are recorded as-is — `PutTimer` has no state guard (**D-025**) and `FireTimer` has no tenancy check where Postgres has RLS. **D-025 was proved and closed in `sos-ingest`, not here (W10-g, 20 Aug):** `PutTimer` is still a blind upsert because `cancelTimers` needs it; the guard is in `armTimers`. ★ **It runs for a real SOS across two binaries (W10-h + W10-i, 20 Aug).** W10-h connected the front door to this engine over the bus (D-026); W10-i made the bus cross a process (D-027). `ops/e2e-two-binaries.sh` posts an SOS to the `sos-ingest` binary and watches this engine arm the ladder in `control-plane` and climb `PENDING → ACTIVE_L1`. Never yet observed in a container — `docker compose up` has not been run. |
| 1.30 | LISTEN/NOTIFY + adaptive poll | 🔨 | Bus wake + polling — in-process immediately, cross-process on the 250 ms file tail (W10-i). Semantics hold; the Postgres mechanism does not exist |
| 1.31 | Ladder L1→L2→L3 as data | ✅ | `engine.go` + `src/core/policy.ts`. **Pinned by `ladder_test.go` (W10-e):** what `OnIncidentOpen` arms per entry state, every rung's tier/channels/state guard, `Ladder()` matching the timers actually armed, L3 anchored at L1 entry, terminal-and-merged disarm, F-02 auto-quiesce, the P-030 watchdog reclaim, t3 stamped once. Found **D-024** — the SMS rung was still billable at `RESOLVING` |
| 1.32 | CLAIM / RELEASE broadcast over **both** WS and push | ⛔ | **Code complete both ends, exit criterion unmeetable.** Landed 11 Aug (W10-d). `Claim()` now calls `notifyStep` with WS+FCM+APNs+PushKit and no billable channel, so §2.6.4's "both channels simultaneously" is built rather than described. F-21 grew by two fields to make it expressible — `kind` and `ownerShortName` (D-022) — and the device presents `claimed` as a persistent quiet banner on a fourth channel (D-023) instead of a second alarm. Both the socket and push paths compose through one `notifyOwnership()`. `internal/escalation` got its first tests: `claim_test.go`, 6 characterization + 4 requirement. ⛔ for the same reason as 1.35e — no handset has received one (1.35d) |
| 1.33–1.34 | Progress watchdog 5 min, auto-quiesce 6 h, `/internal/active-incidents` excludes drills | ✅ | `afterS: 300` / `afterS: 21600` in the YAML; F-02 honoured |

### W10 — Notification orchestrator 🔨 **the weakest week in the project**

Split into **W10-a (send)**, **W10-b (receive)**, **W10-c (present)** and **W10-d (claim fan-out)**
on 11 Aug — all on branch `phase1-w10-remote-push`. W10-a, W10-b and W10-d have landed; **W10-c has
not started and cannot be started here** (D-021: its output is Kotlin, this machine has no JDK).

| 1.35a | **FCM data-only, high priority — send side** | ✅ | `backend/internal/notify/fcm.go` — FCM HTTP v1, stdlib only (RS256 service-account JWT, cached access token). Data-only always; `assertPushSafe` fails closed on anything outside the lock-screen-safe set (five fields, seven since W10-d — D-022), so the duress bit cannot ride the push side channel (F-01/F-21). TTL read off the generated machine's `AUTO_QUIESCE` transition, not hardcoded. 20 tests |
| 1.35b | **Device push token registration** | ✅ | `acquireDevicePushToken()` (`notifications.ts`) uses the **native** FCM token, not the Expo relay — no third party between an emergency and a family phone. Wired at `store.ts` bootstrap; rolled tokens re-register via `addPushTokenListener`. Server side: `Device.push_token_fcm` + `PATCH /v1/devices/{id}` |
| 1.35c | **Delivery rows now tell the truth** | ✅ | The FCM leg used to record `delivered` for a push it never sent. It now records `KV-NOTOKEN` (this handset never registered), `KV-NOPUSHCFG` (no credentials in this deployment), `KV-UNREGISTERED` (T-218), `KV-PUSHFAIL`. The four clocks stop averaging in a number the process invented about itself |
| 1.35d | **⛔ FCM credentials** | ⛔ | **Blocked on a Firebase project, which is yours to create.** Four steps, all verified missing on 11 Aug: (1) a Firebase project with an Android app on package `in.example.kavach`; (2) `mobile/google-services.json`; (3) **`"googleServicesFile": "./google-services.json"` under `expo.android` in `app.json` — currently absent, so even with the file present `prebuild` would not place it and FCM would never initialise**; (4) a service-account key at `KAVACH_FCM_CREDENTIALS`. Until then `NewFCMFromEnv` returns `ErrPushNotConfigured`, the control plane logs `push_not_configured` at WARN, and **every push leg records KV-NOPUSHCFG**. No push has ever reached a handset |
| 1.35e | **Receive side — W10-b** | ⛔ | **Code complete and wired, exit criterion unmeetable.** `src/state/pushReceive.ts` defines `kavach.push.incident` with `TaskManager.defineTask` in module scope and registers it with `Notifications.registerTaskAsync`; `index.ts` imports it **before** `expo-router/entry` (ES modules evaluate in source order, so the reverse defines the task too late on the one launch that matters). `readPushFields()` is an allowlist reader, not a cast — the client half of F-01 does not depend on the server half being right. Degrades rather than drops: an unknown trigger or unparseable tier still rings. **14 tests**, incl. a wiring test that fails if `defineTask` ever moves into a function. ⛔ because **no handset has received one** — 1.35d, and §3.8 says the code compiling is not the bar |
| 1.36 | Bypass-DND channel, USAGE_ALARM | ✅ | `src/state/notifications.ts` — `AndroidImportance.MAX`, alarm usage, locally-composed text (F-21) |
| 1.37 | Full-screen intent — W10-c | 🔨 | `USE_FULL_SCREEN_INTENT` declared in `app.json:27` and **never requested or presented**. Confirmed 11 Aug: **`expo-notifications` has no `fullScreenIntent` surface** — zero matches in the package — so this is native work, not a content field. Needs an `Activity` (`showWhenLocked`, `turnScreenOn`) in `modules/kavach-t0/android/` plus a `setFullScreenIntent` notification posted from Kotlin, and a bridge function for `pushReceive.ts` to call. Same Activity as 1.28 |
| 1.35f | Push-borne gaps left open by W10-b | 🔨 | Three, each small and each real. **(a) No drill flag on the wire** — `pushPayload` sends the F-21 safe set and `isDrill` is not in it, so `notifyIncidentFromPush` passes `false`. Fail-safe direction (a real alert shown as a drill is the unrecoverable error), and a drill usually carries `trigger: 'DRILL'` which renders as "Drill" anyway — but a `notifies_family` quarterly drill on another trigger presents as real. **(b) Headless alerts are English** — the locale lives in `t0ConfigRepo` behind SQLite, and opening the DB on the wake path was judged the wrong trade (D-020); `t()` falls back to `en` (NFR-020). **(c) A terminated-app action tap is still dropped** — Android routes it to the same task, `readPushFields` correctly refuses to re-alarm on it, and nothing yet applies `ACTION_PROBE_FINE`. That one is the P-002 spiral `notifications.ts` names in its own header |
| 1.38–1.42 | APNs Critical Alert · PushKit→CallKit · iOS NSE · Live Activity · Wear/watchOS | 🔨 | Absent. iOS is out of scope by ADR-015; the Android ongoing notification exists |

> **Stated plainly, end of 11 Aug:** the server can address a phone and really sends; the device
> really listens, parses and presents; and a CLAIM now travels the same wire, so the transport
> carries both halves of the conversation — "somebody needs help" and "somebody is going". Every
> non-native piece of W10 exists and is tested. **No handset has received any of it, because no
> deployment holds FCM credentials and no build contains `google-services.json`** — and with the app
> closed the only working leg to another human is still SMS. The honest status of W10 is "the
> mechanism is complete and has never once been exercised." Two things stand between here and a phone
> ringing, and neither is code: a Firebase project (1.35d), and a handset to ring. The one piece
> still unbuilt, W10-c, needs a third thing this machine does not have: a JDK.

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
   matters if no phone rings. Token registration → server token store → data-only FCM send (W10-a),
   the device receive path (W10-b) and the CLAIM fan-out over both channels (W10-d, 1.32) are
   **done, 11 Aug**. What remains is presentation: one `showWhenLocked` / `turnScreenOn` Activity in
   `modules/kavach-t0/android/` and a Kotlin `setFullScreenIntent` post, closing 1.37 and 1.28
   together.
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

## Phase 6-D — Nav redesign + Family Watch (29 Aug user decision) 🔨

Spec: [docs/spec/phase6b-redesign-and-family-watch.md](spec/phase6b-redesign-and-family-watch.md), locked
and approved (`go`) 29 Aug. Supersedes B1–B5 of the 21 Aug lock (the centre SOS button). Confirmed
same day: SOS is removed from the tab bar ONLY — `panic.tsx`, the escalation ladder and the T0 plane
are unchanged. D2–D6 of the 21 Aug lock (frictionless-for-the-viewer, non-suppressible on-device
indicator, access-log row, target kill-switch, no recording) are fixed inputs, re-confirmed 29 Aug
after a direct discussion of why the indicator does not become optional — not reopened by any row
below.

Sliced into phases per the ≤8-files rule; each row below touches ~8 files or fewer and produces one
demoable thing.

| # | Item | Status | Notes |
|---|---|---|---|
| 6-D-1 | Nav shell — 5 flat tabs, remove the raised SOS FAB, new **Watch** tab (real per-member location cards, read-only) | ✅ | Landed 29 Aug. `TabBar.tsx` now 5 equal destinations (Feather icons via new `@expo/vector-icons` dep), no FAB; `SOS_FAB_DIAMETER` removed as dead. Home's existing full-width footer SOS button (PRD §6.4, ≥88dp) is untouched and is the actual hard-requirement control — the FAB was a Phase-6 convenience layered on top of it. `src/domain/consentStatus.ts` extracted from `map.tsx` (`shareStatusFor`/`mayDrawPin`/`statusShort`/`untilText`) so the pin/status rule has one home, not two — `map.tsx` now imports it too. New `app/(tabs)/watch.tsx`: one card per member, location status only (Camera/Listen deliberately absent — no scope to gate them until 6-D-4). `test/routes.test.ts`'s `NAVIGATOR_REACHED` whitelist updated for `/watch`. Verified: `tsc --noEmit` clean, `npm test` 171/171 |
| 6-D-1b | Restore per-screen SOS reachability | ✅ | Landed 29 Aug. New `src/ui/components/SosHeaderButton.tsx` — 44×44 outline circle, Feather `alert-triangle` on `colors.dangerText`, no fill — dropped into a new `headerRow` (title column + button) on Map/Incidents/Settings/Watch. `onPress` is `router.push('/panic')`, identical to `home.tsx`'s existing calls — zero change to `panic.tsx`. Reused the dormant `tab.sos`/`tab.sosHint` i18n strings (all three locales) left over from the pre-6-D-1 tab, rather than inventing new copy. Verified: `tsc --noEmit` clean, `npm test` 171/171. **Not screenshot-verified** — this machine has no JDK/Android SDK (D-021) and the project has no `react-native-web` dependency, so neither a device build nor `expo start --web` can render it here; confirmed instead by matching the exact `styles.header` structure already proven correct on all four screens and by `tsc`'s JSX/type check |
| 6-D-2a | Icon sweep, part 1 — shared components + tab screens | ✅ | Landed 30 Aug. Split from 6-D-2 after `grep -rn "[⌂◎⚠⚙▣↯▮▤◉]" mobile/` found **13** files, over the ≤8-files rule. `ListItem` and `EmptyState` gained an optional `icon?: keyof typeof Feather.glyphMap` prop (Feather wins over `glyph` when both given, same colour token, no new abstraction beyond that one prop); `Pill`'s `warn`-tone default glyph became a `DEFAULT_ICON` entry (`alert-triangle`) alongside the untouched `DEFAULT_GLYPH` text defaults for `ok`/`danger`/`info`/`neutral` — P-018's contrast rule is unchanged, `color` still comes from `TONE_SURFACE`/`tint`, never a FILL token. `home.tsx` (`homeEventGlyph`'s `door` case, "Agents reporting", "Fixed nodes"), `map.tsx` (both `◎` rows), `settings.tsx` (Vault/Drills/Family cameras/Use this phone as a camera), `_layout.tsx` (the degraded-status-bar triangle + one doc-comment `⚠`) all clear. Only the 9 catalogued characters were touched — other glyph values already in these files (`✓ ✕ ℹ • ⚑ ▁ — ⚿ ↗ ≋ ◇ ≈`, etc.) were left as-is, out of the locked scope. Verified: `tsc --noEmit` clean, `npm test` 171/171, `npm run verify` green |
| 6-D-2b | Icon sweep, part 2 — remaining screens | ✅ | Landed 30 Aug. The other 8 files from the same grep: `panic.tsx` (4), `camera-view.tsx` (5), `incident/[id].tsx` (1), `consent.tsx` (1), `drills.tsx` (2), `journeys.tsx` (1), `vault.tsx` (1), `camera-node.tsx` (1) — all clean. `Pill` gained a public `icon` prop (mirrors `ListItem`/`EmptyState`) for per-occurrence overrides beyond the tone default; three mixed glyph-returning spots (`panic.tsx degradationGlyph`, its `NotifiedList` row, its PIN prompt row, `vault.tsx KIND_GLYPH`) converted only the one catalogued branch each, leaving `✓ ℹ • ✚ ☰ ▦ ⚿` etc. untouched per D-032. **`grep -rn "[⌂◎⚠⚙▣↯▮▤◉]" mobile/` now returns nothing at all — spec A4 is fully closed.** Verified: `tsc --noEmit` clean, `npm test` 171/171, `npm run verify` exit 0 |
| 6-D-3 | Visual density | ✅ | Landed 31 Aug. `Pill`'s `neutral`/`info` tones go outline-only (transparent fill, border unchanged, label switches to the tone's own `*Text` token — safe only because the soft fill is gone); `ok`/`warn`/`danger` stay filled unconditionally, scoped purely by `tone` so active-incident/Family-Watch pills need no context flag (A5). Eight standalone notice-card containers (`consent.tsx rung`, `incident/[id].tsx` unacked/responding banners, `panic.tsx notified`/`noFix`, `journeys.tsx deadman`/`corridorEmpty`, `medical-card.tsx emptyCard`) move to `space.lg` padding / `space.md` minimum row gap (A6); `panic.tsx`'s "WHO HAS BEEN TOLD" card had *zero* gap between rows before this. Excluded `journeys.tsx`'s `metric` stat tile and `diagnostics.tsx`'s repeated check-row as atomic/repeated elements, not cards (same category as the `ListItem`/`MemberRow` exclusions). Verified: `tsc --noEmit` clean, `npm test` 171/171, `npm run verify` exit 0 |
| 6-D-4 | Consent plumbing for Family Watch | ✅ | Landed 31 Aug. `ConsentScope` += `'camera'` (mobile + backend `validScopes` + migration comments), `grantedVia` += `'family_membership'` (F1). Pure builders (`buildFamilyMembershipGrant`, `dueForRenewal`, `renewed`) and a `grantFamilyMembershipScopes` store action exist and are tested for the mutual-grant + 90-day self-renewal shape (F2/F3); `grantStatusFor` generalises `shareStatusFor` to any scope for F4. **⛔ F2's auto-grant is NOT wired to any call site** — there is no real "a member just joined" event in this codebase yet: `enrolStore.ts`'s P2P join is deliberately airgapped from the server/store, and mobile has no client call to `POST /v1/members` at all. Flagged as D-033, not papered over — user decision this session was "plumbing only." F3's renewal is local-only (no PATCH-consent endpoint exists). `db/schema.ts`/`db/repos.ts`/`net/api.ts` needed no edits (already scope-agnostic). Verified: `tsc --noEmit` clean, `npm test` 182/182, `npm run verify` exit 0, full Go build/vet/staticcheck/archlint/test clean, schema-lint clean, `gen:check` in sync |
| 6-D-5 | Watch tab actions | ✅ | Landed 31 Aug. Each member card in `watch.tsx` gets Camera/Listen icon-buttons (Feather `video`/`mic`), enabled state from `grantStatusFor('camera'\|'audio', member, meId, undefined, grants, now)` (`presence` deliberately `undefined` — camera/audio don't gate on `monitoringPaused`). New `disabledReasonFor()` in `consentStatus.ts` renders the exact B3 ("Not sharing location/camera/mic yet…") and F4 ("{name} has turned this off.") copy, deduped to one line when camera/audio share a reason and split to two when a member has revoked only one (F1's "separately revocable"). Tapping an *enabled* button is honest that the live session doesn't exist yet (D-034) rather than opening a fake one or writing a fake `AccessLogEntry` — that stays 6-D-7's job. **Refresh is NOT in this row** — confirmed against this table mid-session and corrected out of the phase; it is 6-D-6. Verified: `tsc --noEmit` clean, `npm test` 186/186, `npm run verify` exit 0. Backend untouched, not re-run |
| 6-D-6 | On-demand location push | ✅ | Landed 31 Aug. Turned out to need more than the Refresh button: cross-member location had **never once been wired in either direction** before this phase (D-035) — `noteLocationFix` only ever wrote to the local DB, and `realtime-gw`'s existing `location.report`→`location.update` relay plus `crypto.locationStreamKey` had zero callers. Built: **(1)** the request leg — `notify.RequestLocationRefresh` (Android-only FCM, bypasses `Fanout`), `POST /v1/members/{id}/location-refresh` on control-plane, `fcm.go`'s `pushSafeKeys` +3 (`type`/`requestId`/`deviceId`). **(2)** the response leg — `mobile/src/state/locationRefresh.ts`, a headless-safe handler (reads `groupSecret`/session straight from SecureStore, per D-020's precedent never opens `t0ConfigRepo`) that acquires one fix (`Promise.race`, 8s — `getCurrentPositionAsync` has no built-in timeout), seals it with the Location Stream Key, and reports it to a NEW `POST /v1/location-report` on **realtime-gw** (its first-ever tests) rather than control-plane (ADR-010: no control-plane body carries location, sealed or not) — reusing the existing single-use connect ticket (F-16), never opening a WebSocket from a headless task. **(3)** the receive leg — `store.ts handleWsFrame`'s new `location.update` case is the only place `openJson`/`locationStreamKey` are called client-side; feeds `presence[memberId].location` for both the push-triggered path and, incidentally, any future foregrounded sender. **(4)** `watch.tsx`'s Refresh button (Feather `refresh-cw`, first in the row per B1), 8s spinner gated on `mayDrawPin`, distance-from-you (`geofence.haversineM`, reused not duplicated) + a `±Xm` accuracy chip past 30m (C3). ⛔ **Ambient/continuous sharing still not wired** — only a push-triggered Refresh reports a fix; `presenceService.ts`'s regular watch-position tick still never leaves the device. Verified: `tsc --noEmit` clean, `npm test` 196/196, `npm run verify` exit 0; `go build`/`go vet`/staticcheck/archlint clean; `go test` — `internal/notify` 32 (+7), `cmd/control-plane` 21 (+2), `cmd/realtime-gw` 4 (its first ever); `gen:check`/schema-lint/protolint unaffected (no schema/proto change) |
| 6-D-7a | Family Watch session plane (no media) | ✅ | Landed 1 Sep. Split out of 6-D-7 because the row bundled a fully-verifiable TS/Go layer with a device-only one (D-036). Built: **(1)** `realtime-gw`'s `watch.signal` C→S case — relays one opaque sealed blob plus `sessionId`/`toMemberId`, stamps the sender from the connect **ticket** (a body-supplied `fromMemberId` would let any member forge an invite from any other), HIGH priority because LOW coalesces per key and would keep only the last ICE candidate; the existing F-20 guard already bars reduced/neighbour sessions and a test now pins that. **(2)** `mobile/src/state/watchSession.ts` — invite → the watched phone's auto-accept against **its own** grants (`outboundGrantStatusFor`, new in `consentStatus.ts`; `grantStatusFor` reads "their grant to me" and cannot express "my grant to them"), decline with F4's copy, D5/E4's `camera_view_*`/`listen_*` rows with the row on disk **before** the accept is sent (D2 pins the indicator at "before the viewer's first frame renders"), E2's 5-min budget + repeatable "+5 min" extending from the current expiry not from now, D3's viewer-driven flip, D4's End from either party, 1↔1 enforced. **(3)** `crypto.watchSessionKey` (`deriveKey(secret,'watch',sessionId)`, same construction as `incidentContentKey`) with `sealJson`'s AAD binding each signal to its session. **(4)** `store.ts`'s `watch.signal` case + `watchContext()`. ⛔ **Zero call sites in `app/` on purpose** — GLOSSARY.md's "do not build one half without the other"; a session with no media would claim "X is viewing your camera" and carry none (D-034's rule). `durationS` (D5) is left derivable from the two rows rather than triggering this app's first-ever schema migration. Verified: `tsc --noEmit` clean, `npm test` **218/218** (was 196), `npm run verify` exit 0; `go build`/`go vet`/staticcheck/archlint clean; `go test` — `cmd/realtime-gw` 7 (+3), full sweep green, `cmd/sos-ingest` green via `GOTMPDIR`; `gen:check`/schema-lint/protolint unaffected |
| 6-D-7b | Family Watch transport (camera + listen, live) | ⛔ | What 6-D-7a deliberately left: `react-native-webrtc` (new native dep) + TURN relay (new infra), a `WatchMedia` implementation behind `setWatchMedia()`, the viewer's live-view screen (D3's flip control, E2's countdown ring and "+5 min" button), the watched device's non-suppressible banner + dot + start-sound (D2/D3), and only then wiring `watch.tsx`'s Camera/Listen buttons to `startWatchSession`. **Unverifiable on this machine**: a JDK now exists (17, `JAVA_HOME` set) but `ANDROID_HOME`/`ANDROID_SDK_ROOT` are unset, so D-021's conclusion is unchanged — needs a device build the user triggers |
| 6-D-8 | Geofencing — arbitrary-location placement | 🔨 | Today's form only centres a fence on your own current position (a real gap, not a preference — `map.tsx:474`). Real fix rides 6-B's MapLibre (tap-anywhere-on-map); an interim lat/lon text-entry fallback can ship independently of 6-B |

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
- Anything touching `internal/{bus,wal,consent}` or `cmd/{control-plane,realtime-gw,canary}` needs
  a characterization test first — ~4,300 lines there still have no direct tests
  ([RISK.md](RISK.md) §4). `store`, `notify`, `escalation` and now `cmd/sos-ingest` are partially
  pinned; the rule applies to the parts of them that are not.
- `sos-ingest` has **30 lines of headroom** (970/1000). Budget removals before additions.
- **A characterization pass that finds a gap does not have to close it in the same session.** D-024
  was one line in the file already under test and was fixed on the spot; D-025 landed in a different
  package with no test rig, so it was written down and closed a session later. Record where the fix
  belongs and why it waited — an undocumented finding is worse than an unfixed one.
- **But it must be executed before it is quoted.** D-025 spent a session as an inference from four
  call sites, correctly labelled "read, not executed". W10-g ran it and every word held — and the
  same pass found D-026, which no amount of re-reading `armTimers` would have surfaced, because it
  is in a different binary's `main()`. W10-h then went to fix D-026 and found **D-027** one layer
  below it, in a package neither decision had named. **Reading finds the bug; running finds the one
  next to it.**
- **Wire the leg anyway, and say what it does not reach.** W10-h shipped D-026's subscriber knowing
  D-027 stops it at the container boundary. The alternative — hold the fix until the transport is
  decided — leaves a phase with no functional change and a decision nobody has the evidence to
  make. What is *not* allowed is the tick: `cmd/control-plane/main_test.go`, `DECISIONS.md`,
  `RISK.md` and this board all say in their own words that these nine green tests stop at one
  process. **"Exists" ≠ "is wired up" ≠ "runs in production" — report all three.**
