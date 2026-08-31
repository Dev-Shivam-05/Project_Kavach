# HANDOFF — Kavach — Phase 6-D-4 — 2026-08-31

Branch **`shivam`**, code commit `94ed2b7b` (docs closed out through `a3118619`), **pushed** to
`origin/shivam`. This handoff supersedes the 31 Aug 6-D-3 one (commit `7d7babff`), preserved in git
history.

## Done

- **6-D-4 shipped: consent plumbing for Family Watch (spec F1–F4)**, scoped to "plumbing only, flag
  the gap" per an explicit decision this session — see **Decisions made** below for the gap and why
  it was not papered over.
- **F1 — `camera` is a real `ConsentScope` end to end.** Added to `mobile/src/core/types.ts`'s
  `ConsentScope` union, to backend's `validScopes` map (`backend/internal/consent/consent.go`,
  new `ScopeCamera` constant), and to `backend/migrations/0001_init.sql`'s `scope` column comment
  (the naming authority, per this repo's own convention). Separately revocable from `audio` — a
  member can allow Listen and refuse Camera or the reverse, matching F1's own stated reason.
- **F2 — `'family_membership'` joins `ConsentGrant['grantedVia']`.** Pure builder
  `buildFamilyMembershipGrant()` and the scope pair `FAMILY_MEMBERSHIP_SCOPES = ['camera', 'audio']`
  added to `consentStatus.ts`. A new store action, `grantFamilyMembershipScopes(otherMemberIds)`,
  creates a `camera` + `audio` grant from **me** to each id in the list — same
  persist → outbox-enqueue → `postConsent` shape as the existing `grantConsent`, just built by the
  pure constructor instead of taking purpose/hours from a caller. Backend needed no change for the
  new `grantedVia` value: `Grant()` doesn't validate it against an enum, just defaults empty to
  `"self"` and passes anything else through verbatim — pinned by a new characterization test
  (`TestGrantPassesThroughFamilyMembershipVia`) rather than assumed.
- **F3 — 90-day silent self-renewal.** `dueForRenewal()`/`renewed()` in `consentStatus.ts`
  (`FAMILY_MEMBERSHIP_GRANT_WINDOW_MS = 90 days`). Swept once per app bootstrap, inside
  `loadEverything()`: any grant where `grantorMemberId === my member id`, `grantedVia ===
  'family_membership'`, `revokedAt === null`, and `expiresAt <= now` gets its `expiresAt` pushed
  another 90 days out, persisted via `consentRepo.upsert`. **Deliberately local-only** — there is no
  PATCH-consent endpoint on the control plane to sync a renewal to, and reusing `postConsent`'s
  idempotency key (`consent:${id}`) would replay the *original* cached response rather than update
  anything, so this does not call it. A revoked grant is never renewed, by construction (that would
  silently undo the one control F4 gives the grantor).
- **F4 — `grantStatusFor(scope, ...)` generalizes `shareStatusFor`** to any `ConsentScope`, so a
  future Watch-tab Camera/Listen button can derive granted/revoked/expired/none exactly the way
  `map.tsx` already does for `live_location`. `shareStatusFor` itself is an unchanged thin
  `'live_location'`-scoped wrapper over it — `map.tsx`'s behaviour is untouched (verified: no test
  file exercises it directly, but the wrapper is a 3-line delegation, and `watch.tsx`'s only current
  `shareStatusFor` call site is unaffected).
- **11 new mobile unit tests** (`test/consent-status.test.ts`) covering scope-specificity, the
  revoked-over-expired precedence, the 90-day window math, and that a manually-granted (`self`)
  scope is never swept into renewal. **3 new backend tests**
  (`internal/consent/consent_test.go` — this package had zero before) covering the new scope, the
  unchanged unknown-scope rejection, and the `grantedVia` passthrough.
- **`db/schema.ts` and `db/repos.ts` needed no code changes**, and I did not force one to match the
  acceptance-criteria file list literally: `consent_grant`'s `scope`/`granted_via` SQLite columns are
  plain `TEXT` with no `CHECK` constraint or enum list, and `repos.ts`'s `toGrant()` already casts
  generically (`r.scope as ConsentScope`). Reported honestly rather than edited for the sake of
  matching a checklist.
- **`net/api.ts` also needed no code change** — `postConsent`/`ConsentInput` are already
  `ConsentScope`-typed, so they accept `'camera'` the moment `core/types.ts` does.
- Verified green: `tsc --noEmit` (0 errors), `npm test` **182/182**, `npm run verify` exit 0,
  `go build`/`go vet`/staticcheck/archlint/`go test ./...` all clean (every backend package,
  including `cmd/sos-ingest` — no Application Control block this run), `schema-lint` clean,
  `gen:check` in sync.

## Files changed

- `mobile/src/core/types.ts` — `ConsentScope` += `'camera'`, `ConsentGrant['grantedVia']` +=
  `'family_membership'`.
- `mobile/src/domain/consentStatus.ts` — `grantStatusFor()` (generalized from `shareStatusFor`'s old
  body), `buildFamilyMembershipGrant()`, `FAMILY_MEMBERSHIP_SCOPES`,
  `FAMILY_MEMBERSHIP_GRANT_WINDOW_MS`, `dueForRenewal()`, `renewed()`.
- `mobile/src/state/store.ts` — new `grantFamilyMembershipScopes` action (interface + impl,
  unwired); F3's renewal sweep wired into `loadEverything()`.
- `mobile/app/consent.tsx` — `SCOPE_LABEL['camera']` and `VIA_LABEL['family_membership']` added (TS
  exhaustiveness on `Record<ConsentScope,…>`/`Record<ConsentGrant['grantedVia'],…>` forced this; the
  screen would not otherwise compile once the unions grew).
- `mobile/test/consent-status.test.ts` — new, 11 tests.
- `backend/internal/consent/consent.go` — `ScopeCamera` constant, added to `validScopes`.
- `backend/internal/consent/consent_test.go` — new, 3 tests (package's first).
- `backend/migrations/0001_init.sql` — `scope`/`granted_via` column comments updated (naming
  authority, per this repo's own convention #8).
- `docs/PHASES.md` — 6-D-4 row → done; `## Now` / `## Next 3` repointed to 6-D-5.
- `docs/HANDOFF.md` — this file.

## Decisions made

Recorded as [DECISIONS.md](DECISIONS.md) **D-033**.

- **F2's "existing enrolment flow" hook does not exist, and I asked rather than invented one.**
  Before writing code, I checked where "a member finishes joining a family" actually happens in this
  codebase and found two candidates, neither usable: (1) `enrolStore.ts`'s P2P device-pairing flow
  (spoken-fingerprint SAS, QR/code exchange) is explicitly, deliberately airgapped — its own header
  says "IT NEVER TALKS TO A SERVER" and "it never touches `store.ts`"; (2) the server-backed path
  (`POST /v1/members`, which W10-j proved exists and works on the backend) has **no client call site
  in mobile at all** — `net/api.ts` only wires `POST /v1/family` (`createFamily`, from spec row E1).
  I asked the user how to scope 6-D-4 given this; the answer was "plumbing only, flag the gap" —
  build F1–F4's mechanics as tested, callable functions, and document the missing bridge rather than
  inventing a fake call site or silently expanding scope to build it. `grantFamilyMembershipScopes`
  is exported, tested, and **not called from anywhere** — the next phase that builds the real
  join-to-store bridge (either wiring `enrolStore`'s `joined`+`restartRequired` into `store.ts`'s
  bootstrap, or building the missing `POST /v1/members` client call) should call it directly instead
  of reimplementing the grant shape.
- **F3's renewal sync was scoped down the same way, for a smaller, self-contained reason**: there is
  no PATCH/PUT-consent endpoint on the control plane, and `postConsent`'s idempotency-key scheme
  (`consent:${id}`) means re-POSTing an existing grant id would return the *original* cached response
  rather than update anything server-side. Rather than inventing a new wire endpoint (a contract
  decision beyond this phase's locked spec rows), renewal stays local-only. Flagged, not hidden.
- **`purpose: 'safety'` on auto-created family-membership grants is an implementation choice, not a
  spec-locked value** — F2 does not name one. Documented inline in `buildFamilyMembershipGrant`'s
  comment as a judgment call, same category as 6-D-2a/2b's per-occurrence icon choices.
- **`'family_membership'` needed no backend validation change** — discovered, not assumed:
  `Grant()`'s `GrantedVia` field is free-text server-side (defaults empty to `"self"`, otherwise
  passed through), unlike `Scope`/`Purpose` which are checked against enum maps. Pinned by
  `TestGrantPassesThroughFamilyMembershipVia` so this stays true on purpose rather than by accident.

## Known broken / deliberately skipped

- **`grantFamilyMembershipScopes` is dead code by design** — exists, tested, callable, zero call
  sites. Convention #2 applies: "Exists ≠ is wired up." Do not report Family Watch's frictionless
  grant as working end to end until the join-bridge phase lands.
- **F4's UI (Camera/Listen buttons, the exact B3/F4 reason strings) is 6-D-5's job, not this one** —
  the acceptance-criteria file list for F1–F4 named no UI file, and none was touched. `grantStatusFor`
  is the derivation layer 6-D-5 will call; the button rendering, the disabled-reason copy
  ("Not sharing location/camera/mic yet…", "{name} has turned this off.") and the live-view screen
  routes do not exist yet.

## Next session starts here

- **Phase 6-D-5**: Watch tab Camera/Listen buttons (spec rows B1–B3, D1–D2 partial, E1 partial —
  the UI shell only; live transport is 6-D-7). Wire `grantStatusFor('camera'|'audio', member, meId,
  presence, grants, now)` from `consentStatus.ts` into `watch.tsx`'s per-member card, using the exact
  B3 reason string for `kind: 'none'` and the exact F4 string for `kind: 'revoked'`. Spec:
  [phase6b-redesign-and-family-watch.md](spec/phase6b-redesign-and-family-watch.md) rows B1–B3.
- **First command:**
  ```
  git checkout shivam
  git log --oneline -1              # confirm you're on 94ed2b7b or later
  cd mobile && npm run verify
  cd ../backend && go build ./... && go vet ./... && go test ./...
  ```
- **Watch out for:**
  1. **The join→store bridge is still missing.** If 6-D-5 or a later phase needs a real "member just
     joined" trigger, that is new architecture (either hook `store.ts` bootstrap to read
     `useEnrol.getState().joined`, or build the missing `POST /v1/members` client call), not a
     5-minute wire-up. Read this handoff's Decisions section before assuming it is trivial.
  2. **`grantStatusFor` takes `presence` as a required param** even though camera/audio checks don't
     care about `monitoringPaused` the way location does — it was kept in the signature so `self`/
     `paused` short-circuit identically to `shareStatusFor` rather than diverging. Pass `undefined`
     for presence if the caller doesn't have it handy; the function already treats that as "not
     paused."
  3. **No JSX-rendering test harness still** — same as every 6-D UI phase. `tsc --noEmit` and the
     new consent-status tests catch type/logic errors, not layout.
