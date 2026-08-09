# migrations

Forward-only SQL, applied in filename order, one file per change: `000N_name.sql`.

```
psql "$KAVACH_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0001_init.sql
```

PostgreSQL 15 or newer. `0001_init.sql` runs in a single transaction and issues no
`CREATE EXTENSION`: an extension that is not installed raises and takes the whole
transaction with it, which leaves a database with no schema at all. TimescaleDB is
used for the two telemetry hypertables **if** it is already installed; without it
`location_point` and `device_heartbeat` are ordinary tables and retention is a cron
job you own.

## This is the target schema, not a fiction

There is no Postgres in this deliverable — no Docker, nothing to point a connection
string at. The control plane runs on `backend/internal/store/store.go`, a
file-backed store that is deliberately not a toy: it keeps the table names, the
column names and the semantics this file declares.

| §2.8 rule | Where it lives in `store.go` |
|---|---|
| `family_id` on every record | validated on every `Put*`; `ErrNoFamilyID`, `ErrUnknownFamily` |
| `incident_event` append-only | `UpdateEvent` and `DeleteEvent` exist and return `ErrAppendOnly` — discoverable and testable rather than merely absent |
| `UNIQUE (incident_id, hlc)` | `eventDedupe`, keyed `incident_id\|hlc` |
| `active_incident_v` | `ActiveIncidents()`, with the same three exclusions (drill, DORMANT, merged) |
| `consent_grant.expires_at` never null | `ExpiresAt` is never zero |

So the two can be read against each other. Eleven tables exist in both:
`family`, `member`, `device`, `incident`, `incident_event`, `escalation_timer`,
`consent_grant`, `access_log`, `notification`, `delivery_attempt`, `drill_run`.

Five exist only here, because nothing in Phase 0/1 writes them:
`location_point`, `device_heartbeat`, `mls_message`, `content_key`, `notify_budget`.
Their columns come straight from §2.8.3.

## Where the store's spelling won

The PRD schema (PRD §8.1) and the store drifted apart in a few places. The store is
what the running code uses, so the migration matches the store and the PRD's older
spelling loses:

| PRD | Here and in `store.go` |
|---|---|
| `family.current_policy_version` | `family.policy_version` |
| `notification.recipient_id` | `notification.member_id` |
| `notification.acknowledged_at` | `notification.acked_at` |
| `notification.detail_level` | folded into `delivery_attempt.reduced` — the reduced-detail decision is per delivery leg, and the authz layer makes it (§2.4.5) |
| `delivery_attempt.result` | `delivery_attempt.state` |
| `incident_event.hlc bytea` | `text` — 24 hex characters, because `(incident_id, hlc)` is compared as text across five transports and re-encoding it forks the dedupe key (P-053, F-09) |
| `bigserial` ids on `escalation_timer`, `notification`, `delivery_attempt` | `uuid` — those ids are minted by the escalation and notify engines before any insert |

One change is not a preference. §2.8.2 writes F-18 as
`ADD CONSTRAINT ... UNIQUE (family_id, lower(ascii_short_name))`; a Postgres table
constraint takes column names, not expressions, so that statement does not parse.
It is a unique **index** here. Same guarantee.

## Row level security

Every family-scoped table gets `ENABLE` **and** `FORCE ROW LEVEL SECURITY` plus a
`family_isolation` policy. `FORCE` is the half that is easy to omit: without it RLS
is inert for the table owner, which is exactly who a small deployment connects as,
and the policy still shows up in `\d` while doing nothing.

Two things the application must hold up:

- Ordinary sessions `SET app.family_id` before their first query. The policy uses
  the strict form of `current_setting`, so a session that forgets gets an error
  rather than a silent unfiltered read.
- The global deploy-freeze read (`GET /internal/active-incidents`, all families)
  and the escalation engine's cross-family sweeps run as a `BYPASSRLS` role.
  `active_incident_v` is `security_invoker`, so it does not hand that bypass to
  anyone else.

RLS sits **behind** OpenFGA, not instead of it.

## Writing the next one

- Additive. Same reason as the wire contract: an old client is never updated
  (P-060), and a rolling deploy runs both versions at once.
- Never `UPDATE` or `DELETE` `incident_event`. The trigger raises, and that is the
  point — it is the accountability record. A DPDP erasure request is satisfied by
  crypto-shredding the matching `content_key` row (F-15), which leaves the
  ciphertext in place and provably unreadable.
- If you add a family-scoped table, add it to the RLS loop at the bottom of
  `0001_init.sql` in the same change. A table with no policy is a table that
  returns every family's rows.
