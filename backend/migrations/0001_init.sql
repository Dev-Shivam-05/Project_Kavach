-- ═══════════════════════════════════════════════════════════════════════════════
-- KAVACH — 0001_init
--
-- The control-plane schema of docs/02-System-Architecture.md §2.8, whole. §2.8.2
-- is applied inline rather than as ALTERs after the fact: an init migration
-- should produce the shape the code expects, not a history lesson.
--
-- backend/internal/store/store.go is the file-backed stand-in that runs today,
-- and it keeps these table and column names. See migrations/README.md for the
-- handful of places where the store's spelling won and the PRD's older one lost.
--
-- Six things in here are load-bearing. Each is commented where it is declared:
--   · consent_grant.expires_at NOT NULL        no permanent grants (P-008)
--   · incident_event_immutable trigger         the log is a record or it is not
--   · RLS + FORCE on every family-scoped table defence behind OpenFGA (§2.8.7)
--   · UNIQUE (family_id, lower(ascii_short_name))  unambiguous SMS names (F-18)
--   · active_incident_v excludes drills and DORMANT (F-02)
--   · content_key as the erasure mechanism     crypto-shredding (F-15)
-- ═══════════════════════════════════════════════════════════════════════════════

-- Requires PostgreSQL 15+: gen_random_uuid() is core from 13, security_invoker
-- views from 15. No CREATE EXTENSION anywhere in this file — an extension that
-- is not installed on the box raises and takes the whole transaction with it,
-- and a database with no schema is a worse outcome than one without compression.
-- TimescaleDB is used if the DBA has already installed it; see the bottom.

BEGIN;

-- ── tenancy ──────────────────────────────────────────────────────────────────
-- family_id is on EVERY table and every query filters on it. It costs nothing
-- now and it is what makes sharding and federation a configuration change later
-- instead of a migration (§2.8.1).

CREATE TABLE family (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name    text NOT NULL,
    mls_group_id    bytea,
    policy_version  int  NOT NULL DEFAULT 1,
    -- F-07: MLS epoch the Delivery Service has committed. A device offline for
    -- months replays mls_message from its last seq to catch up.
    current_epoch   int  NOT NULL DEFAULT 0,
    -- Verifies the sig8 tag on an inbound SMS (§2.10.2). NOT the E2EE group
    -- secret — the server must never hold that. Its only power is to say "this
    -- SMS really came from this family's app".
    sms_hmac_key    bytea,
    -- Per-family copy of the notify_budget ceiling, read on the SMS path so a
    -- fan-out never waits on a join (F-04).
    sms_ceiling     int  NOT NULL DEFAULT 2000,
    -- phase6-pull-forward E2/E3: the family size cap. Members past this are
    -- refused by cmd/control-plane with 409 KV-1012 (the live guard; this CHECK
    -- is spec-only, nothing runs the migration - ADR-006/D-003).
    max_members     int  NOT NULL DEFAULT 6 CHECK (max_members BETWEEN 2 AND 20),
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE member_role AS ENUM
    ('guardian','adult','minor','elder','relative','neighbour','staff','guest');

CREATE TABLE member (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id             uuid NOT NULL REFERENCES family(id) ON DELETE CASCADE,
    display_name          text NOT NULL,
    -- P-033: GSM-7 only. A non-ASCII character in an SMS flips the whole message
    -- to UCS-2 and cuts the payload from 160 characters to 70, which does not fit.
    ascii_short_name      text NOT NULL CHECK (ascii_short_name ~ '^[A-Za-z]{1,8}$'),
    role                  member_role NOT NULL,
    dob                   date,
    locale                text NOT NULL DEFAULT 'en',
    identity_pubkey       bytea,
    phone_e164            text,
    membership_expires_at timestamptz,   -- NULL = permanent
    avatar_color          text,
    created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX member_family_idx ON member (family_id);

-- ★ F-18: UNIQUE (family_id, lower(ascii_short_name)). Two members called
-- "Priya" produce two identical SMS alerts, and the person reading one at 2 a.m.
-- cannot tell which of them is in trouble. lower() because "priya" and "Priya"
-- are the same name to a human under stress.
--
-- A unique INDEX, not the ADD CONSTRAINT UNIQUE that §2.8.2 writes: a Postgres
-- table constraint takes column names only, so the constraint form does not
-- parse and the migration would fail on this line. The guarantee is identical.
CREATE UNIQUE INDEX member_short_name_unique ON member (family_id, lower(ascii_short_name));

CREATE TABLE device (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id         uuid NOT NULL REFERENCES family(id) ON DELETE CASCADE,
    member_id         uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
    platform          text NOT NULL CHECK (platform IN ('android','ios','node','fob','ha')),
    model             text,
    manufacturer      text,
    os_version        text,
    -- The Ed25519 EMERGENCY key. Deliberately not biometric-gated: an
    -- unconscious person cannot present a fingerprint (P-007). This is the key
    -- sos-ingest verifies T0 envelopes against.
    signing_pubkey    bytea NOT NULL,
    identity_pubkey   bytea,
    attestation_state text NOT NULL DEFAULT 'unverified',
    is_device_owner   boolean NOT NULL DEFAULT false,
    imei              text,                        -- CEIR blocking (P-029)
    push_token_fcm    text,
    push_token_apns   text,
    push_token_voip   text,
    last_heartbeat_at timestamptz,
    battery_pct       int,
    battery_temp_c    numeric(4,1),                -- P-032
    battery_health    text,                        -- P-032
    agent_healthy     boolean NOT NULL DEFAULT true,
    diagnostics       jsonb NOT NULL DEFAULT '{}', -- permission self-check (P-031)
    revoked_at        timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX device_family_idx ON device (family_id);
CREATE INDEX device_liveness_idx ON device (last_heartbeat_at) WHERE agent_healthy;

-- ── incidents ────────────────────────────────────────────────────────────────

CREATE TABLE incident (
    id                  uuid PRIMARY KEY,   -- UUIDv7, CLIENT-generated → idempotent ingest
    family_id           uuid NOT NULL REFERENCES family(id),
    subject_member_id   uuid NOT NULL REFERENCES member(id),
    state               text NOT NULL,      -- projection of spec/state-machine.yaml
    trigger             text NOT NULL,
    policy_version      int  NOT NULL,
    duress              boolean NOT NULL DEFAULT false,
    is_drill            boolean NOT NULL DEFAULT false,
    -- ≈1 km cell. The ONLY plaintext location the server is allowed to hold
    -- (§10.2); precise coordinates live in sealed_payload and stay unreadable.
    coarse_h3_r7        text,
    owner_member_id     uuid REFERENCES member(id),
    opened_at           timestamptz NOT NULL,
    first_notified_at   timestamptz,        -- four-clock t3
    first_ack_at        timestamptz,        -- four-clock t4
    resolved_at         timestamptz,
    outcome             text CHECK (outcome IN ('real','false_alarm','drill','unknown')),
    outcome_note        text,
    confidence_pct      int,
    risk_context        smallint,           -- 0–4, opaque integer
    flags               int NOT NULL DEFAULT 0,
    server_received_at  timestamptz NOT NULL DEFAULT now(),
    sealed_payload      bytea,              -- Class A ciphertext. Routed, never read.
    -- F-09: base36 prefix of the incident id, carried in the 160-character SMS.
    -- It is how an SMS-borne emergency finds its HTTP twin instead of becoming a
    -- second incident the family has to reason about.
    inc8                text,
    synthetic_from_sms  boolean NOT NULL DEFAULT false,
    merged_into_id      uuid REFERENCES incident(id),
    -- F-02: when auto-quiesce fires. A forgotten incident that stays live
    -- forever freezes deploys forever and drains every phone in the family.
    auto_quiesce_at     timestamptz
);
CREATE INDEX incident_family_opened_idx ON incident (family_id, opened_at DESC);
CREATE INDEX incident_inc8_idx ON incident (family_id, inc8) WHERE inc8 IS NOT NULL;

CREATE TABLE incident_event (
    id                  bigserial PRIMARY KEY,
    incident_id         uuid NOT NULL REFERENCES incident(id) ON DELETE CASCADE,
    family_id           uuid NOT NULL,
    -- Hybrid logical clock, 24 hex characters. Ordering comes from here, never
    -- from a wall clock: device clocks drift and lie (P-052).
    hlc                 text  NOT NULL,
    event_type          text  NOT NULL,
    sealed_payload      bytea,
    source_device_id    uuid,
    source_transport    text,   -- ws | http | http_direct | sms | ble_relay | push | local
    policy_version      int,
    flags               int NOT NULL DEFAULT 0,
    -- Server-visible metadata only: state transitions, tier labels. Anything
    -- about the SUBJECT belongs in sealed_payload.
    detail              jsonb NOT NULL DEFAULT '{}',
    local_created_at    timestamptz,
    server_received_at  timestamptz NOT NULL DEFAULT now(),
    -- P-053: one emergency arrives over five transports on purpose. This is what
    -- makes the fan-out at-least-once instead of five-times-over.
    -- Its index is also the timeline read path, so §8.1's separate
    -- (incident_id, hlc) index would be a second copy of this one.
    UNIQUE (incident_id, hlc)
);

-- ★ APPEND-ONLY ENFORCEMENT (§2.8.4). Do not remove this. ★
-- incident_event is the accountability record — who was told what, when, and
-- what the system did about it. A record that can be edited after the fact is
-- not a record, and the edit that matters is the one made by whoever is about to
-- be held responsible. Erasure is handled by crypto-shredding content_key
-- (F-15), not by DELETE.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'incident_event is append-only'; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER incident_event_immutable
  BEFORE UPDATE OR DELETE ON incident_event
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ── escalation and notification ──────────────────────────────────────────────

CREATE TABLE escalation_timer (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id      uuid NOT NULL REFERENCES family(id) ON DELETE CASCADE,
    incident_id    uuid NOT NULL REFERENCES incident(id) ON DELETE CASCADE,
    action         text NOT NULL,   -- escalate_l2 | escalate_l3 | watchdog | repeat_l1 | quiesce
    target_tier    int,
    policy_version int  NOT NULL,
    fire_at        timestamptz NOT NULL,
    fired_at       timestamptz,
    state          text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','fired','cancelled')),
    -- A timer that failed to fire is re-armed, not forgotten. An overdue
    -- escalation timer is a P0 page (§2.11.5): it means the ladder stopped
    -- climbing while someone was still waiting.
    attempts       int NOT NULL DEFAULT 0,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX escalation_timer_due_idx ON escalation_timer (fire_at) WHERE state = 'pending';

CREATE TABLE notification (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id   uuid NOT NULL REFERENCES family(id) ON DELETE CASCADE,
    incident_id uuid NOT NULL REFERENCES incident(id) ON DELETE CASCADE,
    member_id   uuid NOT NULL REFERENCES member(id),
    tier        int  NOT NULL,   -- 1 | 2 | 3
    label       text,
    channel     text,
    -- F-03: keeps drill fan-out out of the False Positive Ledger and out of
    -- NFR-008 accounting. The canary runs every 15 minutes; counted, it would
    -- swamp the real numbers the ledger exists to show.
    is_drill    boolean NOT NULL DEFAULT false,
    audience    uuid[] NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now(),
    sent_at     timestamptz,
    acked_at    timestamptz
);
CREATE INDEX notification_incident_idx ON notification (incident_id);

CREATE TABLE delivery_attempt (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id           uuid NOT NULL REFERENCES family(id) ON DELETE CASCADE,
    incident_id         uuid REFERENCES incident(id) ON DELETE CASCADE,
    notification_id     uuid NOT NULL REFERENCES notification(id) ON DELETE CASCADE,
    member_id           uuid REFERENCES member(id),
    device_id           uuid REFERENCES device(id),
    channel             text NOT NULL,   -- fcm|apns|voip|sms|voice|email|ws
    sim_subscription_id int,             -- P-033: which SIM actually sent it
    state               text,            -- sent|delivered|failed|expired
    attempted_at        timestamptz NOT NULL DEFAULT now(),
    delivered_at        timestamptz,
    latency_ms          bigint,
    provider_ref        text,
    error_code          text,
    -- §2.4.5: a neighbour-tier delivery carries structurally less data. The
    -- authz layer decides this, not an application if-statement.
    reduced             boolean NOT NULL DEFAULT false
);
CREATE INDEX delivery_attempt_notification_idx ON delivery_attempt (notification_id);

-- ── consent ──────────────────────────────────────────────────────────────────
-- This is the anti-stalkerware machinery. Treat it as load-bearing.

CREATE TABLE consent_grant (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id         uuid NOT NULL REFERENCES family(id) ON DELETE CASCADE,
    grantor_member_id uuid NOT NULL REFERENCES member(id),
    grantee_member_id uuid NOT NULL REFERENCES member(id),
    scope             text NOT NULL,   -- live_location|history|vitals|audio|documents|screen_time
    purpose           text NOT NULL,   -- safety|incident_only|routine|care
    granted_at        timestamptz NOT NULL DEFAULT now(),
    -- ★ P-008: NOT NULL. There is no permanent grant. ★
    -- A grant that never expires is surveillance with an onboarding flow: the
    -- day the relationship changes, nobody remembers it exists. Expiry forces
    -- the question to be asked again, out loud, by someone who can say no.
    expires_at        timestamptz NOT NULL,
    revoked_at        timestamptz,
    granted_via       text NOT NULL,   -- self|guardian_policy|autonomy_ramp
    -- F-14: layer-1 revocation is instant, the layer-2 key ratchet may lag. The
    -- UI must never claim a completeness the crypto does not yet have.
    key_rotation_pending boolean NOT NULL DEFAULT false,
    CHECK (expires_at > granted_at)
);
CREATE INDEX consent_grant_expiry_idx ON consent_grant (grantor_member_id, expires_at);

CREATE TABLE access_log (
    id                  bigserial PRIMARY KEY,
    family_id           uuid NOT NULL REFERENCES family(id) ON DELETE CASCADE,
    grant_id            uuid REFERENCES consent_grant(id),
    accessor_member_id  uuid NOT NULL REFERENCES member(id),
    subject_member_id   uuid NOT NULL REFERENCES member(id),
    what                text NOT NULL,
    context             text,            -- incident id, or 'routine'
    at                  timestamptz NOT NULL DEFAULT now(),
    -- ★ A job MUST drive this to true. An access log nobody sees is not
    -- accountability, it is a database table.
    surfaced_to_subject boolean NOT NULL DEFAULT false,
    -- F-10: Class A′ — precise coordinates left the system unencrypted during an
    -- emergency (the SMS path cannot carry ciphertext). The subject is told
    -- afterwards, in those words.
    degraded_plaintext  boolean NOT NULL DEFAULT false
);
CREATE INDEX access_log_subject_idx ON access_log (subject_member_id, at DESC);
CREATE INDEX access_log_unsurfaced_idx ON access_log (surfaced_to_subject) WHERE NOT surfaced_to_subject;

-- ── telemetry ────────────────────────────────────────────────────────────────

CREATE TABLE location_point (
    device_id     uuid NOT NULL,
    family_id     uuid NOT NULL,
    ts            timestamptz NOT NULL,
    sealed_coords bytea NOT NULL,   -- E2EE. ADR-010: precise coordinates never land in plaintext.
    coarse_h3_r7  text,             -- routing only
    accuracy_m    int,
    battery_pct   int,
    risk_context  smallint
);
CREATE INDEX location_point_family_ts_idx ON location_point (family_id, ts DESC);

CREATE TABLE device_heartbeat (
    device_id       uuid NOT NULL,
    family_id       uuid NOT NULL,
    ts              timestamptz NOT NULL,
    battery_pct     int,
    battery_temp_c  numeric(4,1),
    agent_uptime_s  bigint,
    degradation_lvl smallint,   -- 0–5, §4.4
    diagnostics_ok  boolean
);
CREATE INDEX device_heartbeat_device_ts_idx ON device_heartbeat (device_id, ts DESC);

-- ── §2.8.3 new tables ────────────────────────────────────────────────────────

-- F-07: the MLS Delivery Service ordered log. Without it a phone that misses
-- epochs while offline is permanently locked out of its own family's history.
-- §10.3: rows of kind 'keypackage' ARE the append-only key-addition log —
-- clients verify their own device's inclusion and alert on an addition they did
-- not initiate, which is the control that stops a compromised server quietly
-- adding a device to the group.
CREATE TABLE mls_message (
    family_id  uuid   NOT NULL REFERENCES family(id) ON DELETE CASCADE,
    seq        bigint NOT NULL,
    kind       text   NOT NULL CHECK (kind IN ('commit','welcome','proposal','keypackage')),
    epoch      int    NOT NULL,
    blob       bytea  NOT NULL,   -- opaque to the server
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (family_id, seq)
);

-- ★ F-15 — CRYPTO-SHREDDING IS THE ERASURE MECHANISM ★
-- A DPDP erasure request cannot be satisfied by DELETE: incident_event is
-- append-only by trigger, and the same audit obligation that makes it
-- append-only also requires it to survive. So the plaintext is never in the row
-- to begin with — it is sealed under a content key that lives HERE, and erasure
-- destroys the key. The ciphertext stays, provably unreadable by anyone including
-- us. One key destroyed, one lifetime of data gone.
CREATE TABLE content_key (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id         uuid NOT NULL REFERENCES family(id) ON DELETE CASCADE,
    subject_member_id uuid REFERENCES member(id),
    scope             text NOT NULL CHECK (scope IN ('incident','media','vault_object')),
    scope_ref         uuid NOT NULL,
    wrapped_key       bytea NOT NULL,   -- wrapped to the group; the server cannot use it
    created_at        timestamptz NOT NULL DEFAULT now(),
    shredded_at       timestamptz,
    -- A row stamped shredded while the key material is still sitting in it is a
    -- compliance lie that reads as compliance. Shred = empty the bytes AND stamp
    -- the time, in one statement, or the row is rejected.
    CHECK (shredded_at IS NULL OR length(wrapped_key) = 0)
);
CREATE INDEX content_key_scope_idx ON content_key (family_id, scope, scope_ref);

-- F-04: hard spend ceiling. Ingest fails open by design (ADR-018), which without
-- a ceiling is an unbounded bill payable by an attacker. Breach is a P0 page,
-- never a silent stop — an SMS not sent is an alert not delivered.
CREATE TABLE notify_budget (
    family_id     uuid PRIMARY KEY REFERENCES family(id) ON DELETE CASCADE,
    month         date NOT NULL,
    sms_sent      int  NOT NULL DEFAULT 0 CHECK (sms_sent >= 0),
    voice_seconds int  NOT NULL DEFAULT 0 CHECK (voice_seconds >= 0),
    sms_ceiling   int  NOT NULL DEFAULT 2000,
    breached_at   timestamptz
);

-- F-03: drill orchestration, so a canary never touches the family. audience is
-- explicit because the failure mode is waking six people at 3 a.m. to prove the
-- pipeline works.
CREATE TABLE drill_run (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id           uuid NOT NULL REFERENCES family(id) ON DELETE CASCADE,
    kind                text NOT NULL CHECK (kind IN ('canary','quarterly','annual_full')),
    notifies_family     boolean NOT NULL DEFAULT false,
    audience_device_ids uuid[] NOT NULL DEFAULT '{}',
    started_at          timestamptz NOT NULL DEFAULT now(),
    scorecard           jsonb
);
CREATE INDEX drill_run_family_idx ON drill_run (family_id, started_at DESC);

-- ── ★ F-02: the deploy-freeze view ★ ─────────────────────────────────────────
--
-- GET /internal/active-incidents reads this, and a non-empty result freezes
-- deploys. Three exclusions, each one an outage if it is dropped:
--
--   is_drill        the canary opens a drill incident every 15 minutes. Include
--                   drills and deploys are frozen permanently, from day one.
--   DORMANT         auto-quiesce exists precisely so a forgotten incident stops
--                   holding the freeze. It is absent from the state list below,
--                   and it must stay absent — a DORMANT incident is over.
--   merged_into_id  a synthetic SMS row reconciled into its HTTP twin (F-09) is
--                   one emergency, not two.
--
-- The state list is spec/state-machine.yaml `active:` verbatim. It is spelled out
-- rather than matched with LIKE 'ACTIVE%' so that a state added to the machine
-- later has to be considered here on purpose.
--
-- security_invoker because a view otherwise runs as its OWNER, which silently
-- turns it into an RLS bypass for every caller. The global form of the
-- deploy-freeze query (GET /internal/active-incidents, all families) is expected
-- to run as a BYPASSRLS role; ordinary sessions see their own family only.
CREATE VIEW active_incident_v WITH (security_invoker = true) AS
  SELECT * FROM incident
   WHERE state IN ('PENDING','ACTIVE_L1','ACTIVE_L1_SILENT','ACTIVE_L2','ACTIVE_L3','OWNED','RESOLVING')
     AND NOT is_drill
     AND merged_into_id IS NULL;

-- ── ★ ROW LEVEL SECURITY (§2.8.7) ★ ──────────────────────────────────────────
--
-- This sits BEHIND OpenFGA, not instead of it. It is the layer that holds when
-- an application query forgets its WHERE family_id — the one bug class that
-- turns a single missing predicate into every family's incidents.
--
-- FORCE matters as much as ENABLE: without it RLS is inert for the table owner,
-- which is exactly who a small deployment connects as, and the policy looks
-- present in \d while doing nothing.
--
-- current_setting('app.family_id') is the strict form on purpose. A session that
-- forgot to SET it gets an error, not a silent unfiltered read.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'member','device','incident','incident_event','escalation_timer',
    'notification','delivery_attempt','consent_grant','access_log',
    'location_point','device_heartbeat','mls_message','content_key',
    'notify_budget','drill_run'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY family_isolation ON %I USING (family_id = current_setting(''app.family_id'')::uuid)', t);
  END LOOP;
END $$;

-- family has no family_id column; it is keyed by it.
ALTER TABLE family ENABLE ROW LEVEL SECURITY;
ALTER TABLE family FORCE ROW LEVEL SECURITY;
CREATE POLICY family_isolation ON family
  USING (id = current_setting('app.family_id')::uuid);

-- ── retention (§2.8.6) ───────────────────────────────────────────────────────
-- Skipped when TimescaleDB is not installed, and downgraded to a NOTICE if its
-- API has moved on: compression and auto-drop are an optimisation, the schema is
-- not, and a renamed helper function must not be able to leave this database
-- with no tables at all. The PL/pgSQL handler runs in its own subtransaction, so
-- the work above it commits either way.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('location_point', 'ts', chunk_time_interval => INTERVAL '1 day');
    PERFORM create_hypertable('device_heartbeat', 'ts', chunk_time_interval => INTERVAL '1 day');
    EXECUTE 'ALTER TABLE location_point SET (timescaledb.compress, timescaledb.compress_segmentby = ''device_id'')';
    PERFORM add_compression_policy('location_point', INTERVAL '7 days');
    -- 90 days, overridable per member: it is their data (§2.8.6).
    PERFORM add_retention_policy('location_point', INTERVAL '90 days');
    -- 400 days: DPDP Rule 6 one-year log floor, plus a month of slack.
    PERFORM add_retention_policy('device_heartbeat', INTERVAL '400 days');
  ELSE
    RAISE NOTICE 'timescaledb absent: location_point and device_heartbeat are plain tables, retention is yours to schedule';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'timescaledb setup skipped (%): the tables exist, schedule retention yourself', SQLERRM;
END $$;

COMMIT;
