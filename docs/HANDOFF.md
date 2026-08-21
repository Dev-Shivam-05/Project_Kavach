# HANDOFF — Kavach — Phase 1 (W10-j, RISK 18 closed; a stack can enrol itself) — 2026-08-21

Branch **`shivam`**, 10 new commits on top of `389f5e46`, pushed. W10-i's handoff is superseded by
this one; its content is in commit `389f5e46`.

**`java -version` was the first command of the session.** Not found, `JAVA_HOME` and `ANDROID_HOME`
unset (D-021), so W10-c was unreachable for the fourth time. The board's next item was `docker
compose up` — **Docker's daemon is not running either** (`npipe:…dockerDesktopLinuxEngine`) — so the
session took the item under it: enrolment, RISK 18.

**A deployed stack can now create its own family, and the fan-out line reads `devices=1`.** Every
previous run in this repository read `devices=0`.

## Done

- **`POST /v1/family` and `POST /v1/members`** on `cmd/control-plane`, both
  `s.auth(s.idempotent(…))` like every other mutating route. `POST /v1/devices` was **not** changed —
  it was always correct and only ever failed because `PutDevice → requireFamily` had nothing to find.
  Every default and every check is `migrations/0001_init.sql`'s, not a preference: `sms_ceiling`
  2000, `policy_version` 1, `current_epoch` 0, `locale` `en`, `ascii_short_name ^[A-Za-z]{1,8}$`
  (P-033 — one non-ASCII character flips the SMS to UCS-2 and 160 characters become 70), the eight
  `member_role` values, and F-18's case-insensitive uniqueness as a 409 `KV-1008`.
- **The row crosses the bus, never the file.** Each successful write publishes
  `bus.KindEnrolmentUpsert` (payload `store.EnrolmentUpsert`) on `fam.<id>.enrolment`;
  `sos-ingest.projectEnrolment` applies it and calls `refreshCache`. The two binaries keep separate
  store directories on one volume, and pointing both at one directory is D-027 again —
  `store.persist` rewrites a *whole* JSON table under an in-process mutex, in the table that decides
  whether a signature verifies.
- **Three characterizations first, each shown red before it was inverted.** `POST /v1/family` and
  `POST /v1/members` were 405s — not 404s, because the `OPTIONS /` pattern matches the whole subtree
  — green in their own commit `d6d0fae2`; an enrolment record on the bus reached sos-ingest's store
  not at all, green in `4af3c761`. 13 tests now: 9 in `cmd/control-plane/enrolment_test.go`, 4 in
  `cmd/sos-ingest/enrolment_test.go`.
- **The characterization found what RISK 18 understated.** Item 18 said both projectors "drop an
  incident whose family row is missing — silently, at WARN". They do, but the request never gets
  that far: `ingestEnvelope` resolves the family from the in-memory cache and answers **404 unknown
  family** (F-04, "an unknown family is nobody to help"). On a freshly deployed stack the phone got
  an error, not a flagged ack. Pinned by `TestEnrolmentTurnsARejectedSOSIntoAProjectedOne`.
- **`ops/e2e-two-binaries.sh` seeds nothing by hand.** `seed_store()` — which wrote `family.json` and
  `member.json` into *both* store directories — is deleted, as its own comment asked. Observed, one
  run on this machine:

  ```
  201 ×5                     enrolment through the control plane's API
  sos-ingest store           device.json family.json member.json   <- learnt over the bus
  ack                        {"verified":false,"flags":1}          <- ADR-018
  control-plane              ingest_incident_projected
  +20s                       transition CANCEL_WINDOW_EXPIRED  PENDING -> ACTIVE_L1
                             timer_armed REPEAT_L1, SMS_TIER, ESCALATE_L2, ESCALATE_L3
                             fanout tier=1 label=L1 devices=1      <- was 0
  ```

  `devices=1` and not 2 because `notify.tierDevices` skips the incident subject's own phone: Priya
  sent the SOS, Amit is the guardian who is told about it.
- **RISK 19, found while closing 18:** four kinds are published to `notify.OpsSubject`
  (`"ops.alert"`) — including `ops.budget_breached`, marked `severity: P0` — and **nothing in the
  repository subscribes to it.** Six non-test subscriptions exist and none matches. `enrolDevice`'s
  comment claiming sos-ingest refreshes its key cache on `device.key.changed` has never been true.
  Recorded with a note at the call site, not fixed: what `ops.alert` is *for* is a paging decision.
- Verified green: `go build`, `go vet ./...`, `staticcheck ./...`, `go test ./...` (escalation **69**,
  notify **28**, sos-ingest **31**, control-plane **26**, store **21**, wal **19**, bus **10**),
  `archlint` (14 packages, **59** edges), `TestLOCBudget` **995/1000**, `schema-lint`, `protolint`,
  `gen:check`, `tsc --noEmit`, `npm test` **165/165**. `-race` was **not** run — no gcc here.

## Files changed

**Backend**
- `cmd/control-plane/main.go` — `subjEnrolmentLeaf`, two routes, `createFamily`, `createMember`,
  `validShortName`, `memberRoles`, `publishEnrolment`; `enrolDevice` gains one publish line and a
  note about `ops.alert`. 1911 → **2083**.
- `cmd/control-plane/enrolment_test.go` **(new, 9 tests)**.
- `cmd/sos-ingest/main.go` — `project()` dispatches enrolment on `m.Kind` before the record
  unmarshal, because the payload is a row and not a `record`; plus `projectEnrolment`.
  970 → **995/1000**.
- `cmd/sos-ingest/enrolment_test.go` **(new, 4 tests)**.
- `internal/bus/bus.go` — `KindEnrolmentUpsert`.
- `internal/store/store.go` — `EnrolmentUpsert`, the shared wire type.

**Ops** — `ops/e2e-two-binaries.sh` (`seed_store` deleted; five API calls, two members, two
devices); `ops/README.md`.

**Docs** — `spec/w10-j-enrolment.md` **(new — the locked spec, written before any code)**,
`DECISIONS.md` (D-028), `RISK.md` (18 **closed**, **19** added, two stale line refs refreshed),
`PHASES.md`, `PROJECT_MAP.md`, `spec/GLOSSARY.md`, `CLAUDE.md`, this file.

## Decisions made

- **The route, not a seed command.** Item 18 offered both; a seed script lives outside all nine CI
  gates and is still a fixture. Two routes were needed rather than one — `PutMember` had no non-test
  caller either, so a family route alone still could not produce an enrollable phone.
- **Separate store directories stay separate.** The row travels on the bus; see above.
- **The payload type is shared** (`store.EnrolmentUpsert`) rather than rebuilt on each side. A field
  the writer adds and the reader forgets is invisible, and every writer-side test still passes —
  `notify.Fanout`'s neighbour leg is that bug, already shipped once in this repo.
- **`armTimers`/`tierFor` were NOT deleted to pay for the LOC.** The spec locked ≤30 lines of
  headroom and the projection took 25. Deleting them is still its own queue item, and
  `projector_test.go`'s four tests still pin what it would delete.
- **Validation is transcribed, not designed.** Every rule is a line of `0001_init.sql` (ADR-006).

## Known broken / deliberately skipped

- **⛔ `docker compose up` has still never been run on this machine.** Docker's daemon is not
  running. It is now the only unexecuted claim left in the repo, and RISK 18 no longer stops it.
- **⛔ Still nobody's phone rings.** `devices=1` means *addressed*, not delivered:
  `KAVACH_FCM_CREDENTIALS` is unset, `mobile/google-services.json` is absent, and the key the e2e
  enrols is 32 zero bytes. RISK 14, 1.35d, unchanged.
- **RISK 19 is recorded, not fixed** — `ops.alert` has four publishers and no subscriber.
- **No `GET`/`PATCH`/`DELETE /v1/members`**, no member removal, no family deletion, no passkeys
  (W4.3), no MLS group creation, no SAS pairing. Out of scope in the locked spec.
- **`cmd/sos-ingest` is at 995/1000.** The next line added there must be paid for first.
- **`go test -race` was not run** — no gcc on this machine. CI gate 3 only.
- **1.37 / 1.28 (W10-c) not started** — D-021, unchanged. **1.35f(a/b/c) untouched.**
- `realtime-gw`'s socket frames and the canary's chain have still never been observed.

## Next session starts here

- **Check `java -version` first.** With a JDK: **W10-c** — one `Activity` in
  `modules/kavach-t0/android/` (`showWhenLocked`, `turnScreenOn`, `excludeFromRecents`) posted via
  `setFullScreenIntent`, closing **1.37 and 1.28**. **Without one, do not.**
- **Without a JDK, in order:** (1) **Start Docker Desktop and bring `ops/docker-compose.yml` up.**
  Four containers have never once run. Enrolment no longer blocks it — bring the stack up empty and
  enrol it over its own API, exactly as `ops/e2e-two-binaries.sh` now does in five requests.
  (2) `armTimers`/`tierFor` out of `sos-ingest` — worth ~20 lines against a 995/1000 ceiling.
  (3) The rest of `escalation`. (4) Decide what `ops.alert` is for (RISK 19).
- **First command:**

  ```
  git checkout shivam
  bash ops/e2e-two-binaries.sh /tmp/kavach-e2e-check
  ```

  Nothing is outstanding; the branch is pushed.
- **Watch out for:** **never write into the other binary's store directory.** `store.persist`
  rewrites a whole JSON table under an in-process mutex, so one shared directory reopens D-027 in
  the table that decides whether a signature verifies. Enrolment crosses on the bus for exactly that
  reason, and the three things that keep the bus a seam are unchanged and still fragile — `O_APPEND`
  on `stream.wal`, `bus.poll()` tailing the file, and `Seq` being the record's ordinal in the file.

  Second trap, unchanged since W10-d: **`notify.Fanout` rebuilds `Step` by hand for the neighbour
  feed** (the `reduced` loop in `notify.go`). A field added to `Step` and not named there is dropped
  for neighbours only, so every test on the main path still passes.
