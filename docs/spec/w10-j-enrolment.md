# W10-j — enrolment: family, member, device (RISK 18)

★ Implements **RISK item 18** · §W4 (`docs/03-Implementation-Guide.md`) · F-18 ·
ADR-006 (`migrations/0001_init.sql` is the naming authority) · ADR-002 (the sos-ingest LOC ceiling) ·
D-026 / D-027 (the bus is the seam between the two binaries).

Locked 2026-08-21, before any code. Implementation may not introduce a value that is not in this
file. A missing decision found mid-build stops the build and adds a row here.

## The problem this closes

`store.PutFamily` and `store.PutMember` had **zero non-test call sites**. `cmd/control-plane` served
`GET /v1/family` and no `POST`. A family therefore existed only inside a test's `t.TempDir()`, and
both incident projectors — `sos-ingest.projectOpen` and `control-plane.onIngestedIncident` — drop an
incident whose family row is missing, silently, at WARN. On a freshly deployed stack that is *every*
incident.

`POST /v1/devices` (`enrolDevice`) already existed and was already correct. It only ever failed
because `PutDevice → requireFamily` had nothing to find.

## Locked decisions

| # | Decision | Locked value | Forcing reason |
|---|---|---|---|
| 1 | Family creation surface | `POST /v1/family`, wired `s.auth(s.idempotent(s.createFamily))`, 201 + the `store.Family` JSON | `POST /v1/devices` already sits at that seam. A seed script lives outside all nine CI gates and is still a fixture |
| 2 | Member creation surface | `POST /v1/members`, wired `s.auth(s.idempotent(s.createMember))`, 201 + the `store.Member` JSON | `enrolDevice` requires `memberId`; a family route alone still cannot produce an enrollable phone |
| 3 | Device route | **Unchanged** — no new code in `enrolDevice` | It is correct today; only the missing family row broke it |
| 4 | Request field names | camelCase, mirroring the existing `deviceReq`. Family: `{id?, displayName, smsHmacKey?, smsCeiling?, policyVersion?}`. Member: `{id?, displayName, asciiShortName, role, phoneE164?, locale?, membershipExpiresAt?, avatarColor?}` | `deviceReq` is this binary's convention. Persisted names stay the migration's snake_case (ADR-006) |
| 5 | Defaults | `smsCeiling` 2000 · `policyVersion` 1 · `currentEpoch` 0 · `locale` `"en"` · `createdAt` `time.Now().UnixMilli()` · absent `id` → `uuidv7()` | Every value copied from `backend/migrations/0001_init.sql:34-50`, not chosen |
| 6 | Validation and error codes | empty `displayName` → 400 `KV-1001` · `asciiShortName` not matching `^[A-Za-z]{1,8}$` → 400 `KV-1001` · `role` outside the eight `member_role` values → 400 `KV-1001` · duplicate `lower(asciiShortName)` within the family → 409 `KV-1008` | The regex and the enum are the migration's `CHECK` and `TYPE`. F-18 is the uniqueness rule. `KV-1008` is this binary's existing 409 — no new code invented |
| 7 | How `sos-ingest` learns | New `bus.KindEnrolmentUpsert = "enrolment_upsert"`, published to `bus.Subject(familyID, "enrolment")` after each successful write. Payload `{"family":…,"member":…,"device":…}`, any subset. Applied by sos-ingest's **existing** `fam.*.>` durable, then `refreshCache()` | The two binaries have separate store directories on one volume (compose: `/var/lib/kavach` vs `/var/lib/kavach/control-plane`). Pointing both at one store dir means two processes rewriting one whole JSON file — the D-027 failure mode, in the table that decides whether a signature verifies |
| 8 | sos-ingest LOC | The projection must fit the 30 lines of headroom (970/1000). Over 30, the phase stops and asks | ADR-002. `armTimers`/`tierFor` are **not** deleted to pay for it — that is queue item 3 and its own decision |
| 9 | The e2e fixture | `seed_store()` deleted from `ops/e2e-two-binaries.sh`; the script calls the three routes instead. Nothing is written into either data directory by hand | Its own comment says to delete it the day a route exists |
| 10 | What "it works" looks like | Two members — `PRIYA` (adult, the SOS subject) and `AMIT` (guardian, the responder) — and one device on Amit → `fanout tier=1 label=L1 devices=1` | `tierDevices` skips the subject's own member (`internal/notify/notify.go:830`), so a one-member family can never produce a non-zero fanout |
| 11 | `device.key.changed` on `ops.alert` | Left exactly as it is | Nothing in the repository subscribes to `ops.alert`. Recorded as a finding this phase, not fixed inside it |

## Out of scope

- **Nobody's phone rings.** `devices=1` means *addressed*, not delivered — no FCM credentials exist
  (RISK 14, 1.35d).
- No `GET`/`PATCH`/`DELETE /v1/members`, no member removal, no family deletion.
- No passkeys (W4.3), no MLS group creation, no SAS pairing (`mobile/src/domain/enrolment.ts`).
- No caller→family authorization beyond today's bearer token and `X-Family-Id`.
- `docker compose up` (queue item 1) and the `armTimers`/`tierFor` deletion (queue item 3).

## Acceptance criteria

- [ ] `POST /v1/family` on the running binary returns 201, and after a restart `GET /v1/family`
      still returns it
- [ ] Two `POST /v1/members` return 201; a third with `asciiShortName: "priya"` returns 409 `KV-1008`
- [ ] `POST /v1/devices` with that `memberId` returns 201 — today it returns 400 `KV-1006`
- [ ] `ops/e2e-two-binaries.sh` contains no `cat > …/family.json`, and its run still prints
      `ingest_incident_projected`, `timer_armed`, and `PENDING -> ACTIVE_L1`
- [ ] That same run prints `devices=1`, with sos-ingest's store seeded **only** over the bus
- [ ] `TestLOCBudget` ≤ 1000; `cmd/control-plane` test count above 9, each new one shown red first
- [ ] `go vet`, staticcheck, `go test ./...`, archlint, `tsc --noEmit`, `npm test`, `gen:check`,
      schema-lint, protolint green. `-race` is not run on this machine (no gcc) — CI gate 3 only

## Risks

- **A stale redelivery overwrites a newer row.** `PutFamily`, `PutMember` and `PutDevice` are all
  blind upserts (`*old = f`). Cheapest way to find out: a projector test that applies one record
  twice, and an older record after a newer one.
- **`phone_e164` and display names now enter `stream.wal` on disk.** Class B, in the same file that
  already carries incident bodies. Gate 7 governs *logs*, so these handlers log ids only.
- **The 21-line estimate for the projection.** If it exceeds the headroom the phase stops on
  decision 8 rather than absorbing queue item 3.
