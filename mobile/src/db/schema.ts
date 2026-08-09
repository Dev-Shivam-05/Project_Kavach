/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ON-DEVICE STORE — DDL
 *
 * ADR-012 / §2.10.4: **the device is the source of truth, the server is a replica
 * and a relay.** Every operation executes locally first, appends to a local log,
 * then syncs. Nothing in this schema requires connectivity to be correct, which
 * is why the app is fully usable at L0 (PRD §4.4) with no backend at all.
 *
 * Column naming is snake_case to match the PostgreSQL schema in §2.8 one-for-one;
 * the repositories in ./repos.ts are the only place that translation happens.
 *
 * ★ There are deliberately NO FOREIGN KEYS. ★
 * Sync delivers an incident_event before its incident far more often than you
 * would expect (SMS reconciliation, F-09; BLE relay, §2.10.3). A foreign key here
 * turns a benign out-of-order arrival into a dropped emergency event. Referential
 * integrity is the server's job; survivability is this file's job.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

/**
 * Migration 1 — the baseline. Every statement is `IF NOT EXISTS` so re-running it
 * on a partially-created database converges instead of failing (§8.4: forward-only,
 * idempotent, additive-only).
 */
const M1 = `
-- ─────────────────────────────────────────────────────────────────────────────
-- INCIDENTS · mirror of the server for our own family; source of truth for ours
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS incident (
  id                  TEXT    PRIMARY KEY,        -- UUIDv7, CLIENT-generated (P-053)
  family_id           TEXT    NOT NULL,
  subject_member_id   TEXT    NOT NULL,
  state               TEXT    NOT NULL,           -- projection; recomputable via fold()
  trigger_type        TEXT    NOT NULL,
  policy_version      INTEGER NOT NULL,
  duress              INTEGER NOT NULL DEFAULT 0,
  is_drill            INTEGER NOT NULL DEFAULT 0,
  coarse_h3_r7        TEXT,                       -- the only plaintext location (§10.2)
  owner_member_id     TEXT,
  opened_at           INTEGER NOT NULL,           -- t0
  first_notified_at   INTEGER,                    -- t3
  first_ack_at        INTEGER,                    -- t4
  resolved_at         INTEGER,
  outcome             TEXT,
  outcome_note        TEXT,
  inc8                TEXT    NOT NULL,           -- F-09 SMS reconciliation prefix
  synthetic_from_sms  INTEGER NOT NULL DEFAULT 0,
  merged_into_id      TEXT,
  auto_quiesce_at     INTEGER,                    -- F-02
  confidence_pct      INTEGER NOT NULL DEFAULT 0,
  risk_context        INTEGER NOT NULL DEFAULT 0,
  -- Class A. Decrypted client-side only; this column holds the PLAINTEXT JSON and
  -- is why the database file itself must be encrypted at rest (§2.8.5).
  sealed_json         TEXT,
  updated_at          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_incident_family_opened
  ON incident (family_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_incident_state
  ON incident (state) WHERE merged_into_id IS NULL;
-- F-09: the SMS leg carries only 8 base36 characters; this index is how the
-- inbound reconciler finds the HTTP-originated twin instead of forking a duplicate.
CREATE INDEX IF NOT EXISTS idx_incident_inc8
  ON incident (family_id, inc8);
-- F-02: a forgotten incident must be found cheaply by the quiesce sweep.
CREATE INDEX IF NOT EXISTS idx_incident_quiesce
  ON incident (auto_quiesce_at) WHERE auto_quiesce_at IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- INCIDENT EVENTS · append-only log. The state column above is only a projection.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS incident_event (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id        TEXT    NOT NULL,
  family_id          TEXT    NOT NULL,
  hlc                TEXT    NOT NULL,            -- 12-byte hybrid logical clock, hex
  event_type         TEXT    NOT NULL,
  sealed_payload     TEXT,                        -- base64 ciphertext; opaque here
  source_device_id   TEXT,
  source_transport   TEXT    NOT NULL,
  policy_version     INTEGER NOT NULL,
  server_received_at INTEGER,
  local_created_at   INTEGER NOT NULL,
  detail_json        TEXT
);
-- P-053: the SAME event arrives over ws AND http AND http_direct AND sms AND ble.
-- This is the cross-transport dedupe. It is a correctness constraint, not a tidiness one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_incident_event_dedupe
  ON incident_event (incident_id, hlc);
CREATE INDEX IF NOT EXISTS idx_incident_event_timeline
  ON incident_event (incident_id, hlc ASC);
CREATE INDEX IF NOT EXISTS idx_incident_event_family
  ON incident_event (family_id, local_created_at DESC);

-- §2.8.4 append-only enforcement, mirrored on-device. An incident timeline that
-- can be edited after the fact is not evidence and cannot support an after-action
-- report. Rewriting history must be impossible, not merely discouraged.
-- (Erasure is crypto-shredding of the content key — F-15 — never a DELETE.)
CREATE TRIGGER IF NOT EXISTS incident_event_immutable_update
  BEFORE UPDATE ON incident_event
BEGIN
  SELECT RAISE(ABORT, 'incident_event is append-only');
END;
CREATE TRIGGER IF NOT EXISTS incident_event_immutable_delete
  BEFORE DELETE ON incident_event
BEGIN
  SELECT RAISE(ABORT, 'incident_event is append-only');
END;

-- ─────────────────────────────────────────────────────────────────────────────
-- OUTBOX · every unsent mutation, with PER-TRANSPORT attempt counters so a dead
-- leg (say, a blocked WebSocket) never starves the legs that still work.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outbox (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  kind               TEXT    NOT NULL,
  payload            TEXT    NOT NULL,
  incident_id        TEXT,
  created_at         INTEGER NOT NULL,
  attempts           INTEGER NOT NULL DEFAULT 0,
  last_attempt_at    INTEGER,
  next_attempt_at    INTEGER NOT NULL DEFAULT 0,
  transport_attempts TEXT    NOT NULL DEFAULT '{}',
  delivered          INTEGER NOT NULL DEFAULT 0,
  delivered_at       INTEGER,
  last_error         TEXT,
  -- incident_id ‖ hlc. The server deduplicates on exactly this, so enqueuing the
  -- same mutation twice locally must also be a no-op (§2.10.5).
  dedupe_key         TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_dedupe
  ON outbox (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON outbox (next_attempt_at ASC) WHERE delivered = 0;

-- ─────────────────────────────────────────────────────────────────────────────
-- INBOX CURSOR · resumable server stream position (§2.5.2)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inbox_cursor (
  stream     TEXT    PRIMARY KEY,
  cursor_hlc TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ─────────────────────────────────────────────────────────────────────────────
-- ★ LOCAL GEOFENCE ★
-- FULL PRECISE COORDINATES. This table is **NEVER SYNCED** (ADR-010).
--
-- A geofence is a home address, a school, a clinic, a lover's flat. Uploading the
-- centre point would hand the server a precise map of the family's life, which is
-- exactly the surveillance product this system refuses to be. Evaluation happens
-- on-device; only the resulting BREACH event leaves, and it carries the ≈1 km
-- coarse cell, never these columns.
--
-- Nothing in ./repos.ts, ../net/api.ts or ../net/outboxDrain.ts may read this
-- table into a request body. Keep it that way.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS local_geofence (
  id              TEXT    PRIMARY KEY,
  label           TEXT    NOT NULL,
  lat             REAL    NOT NULL,   -- ★ precise · never leaves the device
  lon             REAL    NOT NULL,   -- ★ precise · never leaves the device
  radius_m        REAL    NOT NULL,
  notify_on_enter INTEGER NOT NULL DEFAULT 1,
  notify_on_exit  INTEGER NOT NULL DEFAULT 1,
  dwell_s         INTEGER,
  member_ids      TEXT    NOT NULL DEFAULT '[]',
  created_at      INTEGER NOT NULL
);

-- ─────────────────────────────────────────────────────────────────────────────
-- BLACK BOX METADATA · the ring buffer itself is a pre-allocated file (P-043);
-- only its index lives here (PRD FR-007: 60 s at 50 Hz).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS blackbox_meta (
  ref         TEXT    PRIMARY KEY,
  incident_id TEXT,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  sample_hz   INTEGER NOT NULL,
  window_ms   INTEGER NOT NULL,
  bytes       INTEGER NOT NULL DEFAULT 0,
  file_ref    TEXT    NOT NULL,
  sealed      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_blackbox_incident ON blackbox_meta (incident_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- POLICY CACHE · so T0 escalates correctly with no network (ADR-013).
-- Server-authoritative and versioned; the device NEVER writes a new version.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS policy_cache (
  version     INTEGER PRIMARY KEY,
  policy_json TEXT    NOT NULL,
  fetched_at  INTEGER NOT NULL,
  active      INTEGER NOT NULL DEFAULT 0
);

-- ─────────────────────────────────────────────────────────────────────────────
-- PEER KEYS · family device public keys, cached so BLE HMAC verification and
-- envelope signature checks work with zero infrastructure (§2.10.3).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS peer_keys (
  device_id      TEXT    PRIMARY KEY,
  family_id      TEXT    NOT NULL,
  member_id      TEXT    NOT NULL,
  signing_pubkey TEXT    NOT NULL,
  box_pubkey     TEXT,
  fingerprint    TEXT    NOT NULL,
  verified_at    INTEGER,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_peer_keys_member ON peer_keys (family_id, member_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- T0 CONFIG · P-035 Direct Boot. Mirrored into Device Protected Storage so the
-- T0 path is armed BEFORE the first unlock after a reboot. Minimal by design:
-- if it does not fit here, T0 does not need it.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS t0_config (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ─────────────────────────────────────────────────────────────────────────────
-- DIAGNOSTICS HISTORY · P-031. A single green self-check proves nothing; the
-- history is what shows a permission silently revoked three weeks ago.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS diagnostics_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  checked_at  INTEGER NOT NULL,
  report_json TEXT    NOT NULL,
  all_green   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_diagnostics_at ON diagnostics_history (checked_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- FAMILY
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS member (
  id                    TEXT    PRIMARY KEY,
  family_id             TEXT    NOT NULL,
  display_name          TEXT    NOT NULL,
  ascii_short_name      TEXT    NOT NULL,
  role                  TEXT    NOT NULL,
  dob                   TEXT,
  locale                TEXT    NOT NULL DEFAULT 'en',
  identity_pubkey       TEXT    NOT NULL DEFAULT '',
  phone_e164            TEXT,
  membership_expires_at INTEGER,
  created_at            INTEGER NOT NULL,
  avatar_color          TEXT    NOT NULL DEFAULT '#888888'
);
-- F-18: two people called "PRI" in one SMS read at 2 a.m. is a fatal ambiguity.
CREATE UNIQUE INDEX IF NOT EXISTS idx_member_short_name
  ON member (family_id, lower(ascii_short_name));

CREATE TABLE IF NOT EXISTS device (
  id                TEXT    PRIMARY KEY,
  family_id         TEXT    NOT NULL,
  member_id         TEXT    NOT NULL,
  platform          TEXT    NOT NULL,
  model             TEXT,
  manufacturer      TEXT,
  os_version        TEXT,
  signing_pubkey    TEXT    NOT NULL DEFAULT '',
  is_device_owner   INTEGER NOT NULL DEFAULT 0,
  imei              TEXT,
  last_heartbeat_at INTEGER,
  battery_pct       INTEGER,
  battery_temp_c    REAL,
  battery_health    TEXT,
  agent_healthy     INTEGER NOT NULL DEFAULT 1,
  diagnostics_json  TEXT    NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_device_member ON device (family_id, member_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- CONSENT · the anti-stalkerware machinery. P-008: expires_at is NOT NULL, always.
-- There is no permanent grant, so the schema must make one unrepresentable.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS consent_grant (
  id                   TEXT    PRIMARY KEY,
  family_id            TEXT    NOT NULL,
  grantor_member_id    TEXT    NOT NULL,
  grantee_member_id    TEXT    NOT NULL,
  scope                TEXT    NOT NULL,
  purpose              TEXT    NOT NULL,
  granted_at           INTEGER NOT NULL,
  expires_at           INTEGER NOT NULL CHECK (expires_at > 0),
  revoked_at           INTEGER,
  granted_via          TEXT    NOT NULL DEFAULT 'self',
  key_rotation_pending INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_consent_live
  ON consent_grant (family_id, grantee_member_id, expires_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_consent_grantor
  ON consent_grant (grantor_member_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS access_log (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id          TEXT    NOT NULL,
  grant_id           TEXT,
  accessor_member_id TEXT    NOT NULL,
  subject_member_id  TEXT    NOT NULL,
  what               TEXT    NOT NULL,
  context            TEXT    NOT NULL DEFAULT 'routine',
  at                 INTEGER NOT NULL,
  -- The subject is TOLD. An access log nobody reads is theatre; the surfacing job
  -- drives off this flag.
  surfaced_to_subject INTEGER NOT NULL DEFAULT 0,
  -- F-10: marks a Class A' disclosure — precise coordinates sent as SMS plaintext
  -- because that was the only surviving transport. Always disclosed afterwards.
  degraded_plaintext  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_access_log_subject ON access_log (subject_member_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_access_log_unsurfaced
  ON access_log (at DESC) WHERE surfaced_to_subject = 0;

-- ─────────────────────────────────────────────────────────────────────────────
-- JOURNEYS · corridor_json holds precise points and is Class A: never synced.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS journey (
  id                  TEXT    PRIMARY KEY,
  family_id           TEXT    NOT NULL,
  member_id           TEXT    NOT NULL,
  label               TEXT    NOT NULL,
  started_at          INTEGER NOT NULL,
  eta_at              INTEGER,
  arrived_at          INTEGER,
  origin_name         TEXT    NOT NULL DEFAULT '',
  dest_name           TEXT    NOT NULL DEFAULT '',
  corridor_json       TEXT    NOT NULL DEFAULT '[]',  -- ★ precise · never synced (ADR-010)
  state               TEXT    NOT NULL DEFAULT 'active',
  check_in_interval_s INTEGER,
  last_check_in_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_journey_active
  ON journey (family_id, started_at DESC) WHERE state = 'active';

-- ─────────────────────────────────────────────────────────────────────────────
-- VAULT · ciphertext lives on disk/object storage; only the index is here.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vault_object (
  id              TEXT    PRIMARY KEY,
  family_id       TEXT    NOT NULL,
  title           TEXT    NOT NULL,
  kind            TEXT    NOT NULL,
  size_bytes      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  quorum_required INTEGER NOT NULL DEFAULT 0,   -- Shamir 2-of-3 to open
  ciphertext_ref  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vault_family ON vault_object (family_id, created_at DESC);

-- One card per member; it is read by strangers at the roadside, so it is small.
CREATE TABLE IF NOT EXISTS medical_card (
  member_id  TEXT    PRIMARY KEY,
  family_id  TEXT    NOT NULL,
  card_json  TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ─────────────────────────────────────────────────────────────────────────────
-- SCREEN TIME · P-026. Retention 90 days and, per §2.8.6, erasure is the
-- person's own decision — hence the day partition, so pruning is a cheap DELETE.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_usage (
  package_name  TEXT    NOT NULL,
  day           TEXT    NOT NULL,              -- YYYY-MM-DD, device local
  label         TEXT    NOT NULL,
  minutes_today INTEGER NOT NULL DEFAULT 0,
  limit_minutes INTEGER,
  suspended     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (package_name, day)
);
CREATE INDEX IF NOT EXISTS idx_app_usage_day ON app_usage (day);

-- ─────────────────────────────────────────────────────────────────────────────
-- DRILLS · F-03. audience_device_ids is what keeps a canary off the family's
-- phones at 03:00.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS drill_run (
  id                  TEXT    PRIMARY KEY,
  family_id           TEXT    NOT NULL,
  kind                TEXT    NOT NULL,
  notifies_family     INTEGER NOT NULL DEFAULT 0,
  audience_device_ids TEXT    NOT NULL DEFAULT '[]',
  started_at          INTEGER NOT NULL,
  scorecard_json      TEXT
);
CREATE INDEX IF NOT EXISTS idx_drill_started ON drill_run (family_id, started_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- HOME ASSISTANT bridge (ADR-016)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ha_event (
  id                TEXT    PRIMARY KEY,
  entity            TEXT    NOT NULL,
  kind              TEXT    NOT NULL,
  severity          TEXT    NOT NULL,
  at                INTEGER NOT NULL,
  suggested_actions TEXT    NOT NULL DEFAULT '[]',
  acknowledged_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ha_event_at ON ha_event (at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- LOCATION POINTS · Class A. Precise. Retention 90 days (§2.8.6), pruned locally.
-- The 'synced' column exists because uploading is conditional on a live consent
-- grant, not on the point existing.
-- (No backticks in this file: the DDL lives inside a TS template literal.)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS location_point (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id   TEXT    NOT NULL,
  member_id   TEXT    NOT NULL,
  at          INTEGER NOT NULL,
  lat         REAL    NOT NULL,
  lon         REAL    NOT NULL,
  accuracy_m  REAL    NOT NULL DEFAULT 0,
  speed       REAL,
  heading     REAL,
  battery_pct INTEGER,
  incident_id TEXT,
  synced      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_location_member_at ON location_point (member_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_location_unsynced ON location_point (at ASC) WHERE synced = 0;
CREATE INDEX IF NOT EXISTS idx_location_incident ON location_point (incident_id) WHERE incident_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- PRESENCE · 45 s TTL, heartbeat-refreshed (§2.5.2). monitoring_paused is P-066:
-- an adult switching monitoring off is their right and MUST be visible — stated
-- honestly, not as an alarm.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS presence (
  member_id         TEXT    PRIMARY KEY,
  last_seen_at      INTEGER,
  battery_pct       INTEGER,
  agent_healthy     INTEGER NOT NULL DEFAULT 1,
  degradation_level INTEGER NOT NULL DEFAULT 5,
  loc_lat           REAL,
  loc_lon           REAL,
  loc_accuracy_m    REAL,
  loc_at            INTEGER,
  room              TEXT,
  monitoring_paused INTEGER NOT NULL DEFAULT 0
);
`;

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/**
 * Forward-only and additive-only (§8.4). Append new entries; never edit an entry
 * that has shipped, and never write a migration that drops a table or a column —
 * ./index.ts refuses to run one, because a destructive migration on a device that
 * holds the only copy of an incident timeline is unrecoverable.
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'baseline', sql: M1 },
];

/** The full baseline DDL, for a fresh database or a schema assertion in a test. */
export const SCHEMA_SQL: string = MIGRATIONS.map((m) => m.sql).join('\n');

/** Target `PRAGMA user_version` once every migration has been applied. */
export const SCHEMA_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1].version;

/** Every table this schema owns — used by the integrity check in ./index.ts. */
export const TABLES: readonly string[] = [
  'incident',
  'incident_event',
  'outbox',
  'inbox_cursor',
  'local_geofence',
  'blackbox_meta',
  'policy_cache',
  'peer_keys',
  't0_config',
  'diagnostics_history',
  'member',
  'device',
  'consent_grant',
  'access_log',
  'journey',
  'vault_object',
  'medical_card',
  'app_usage',
  'drill_run',
  'ha_event',
  'location_point',
  'presence',
];

/**
 * Tables that hold precise, Class-A location and MUST NOT appear in any request
 * body. Asserted by ../net/api.ts before a control-plane POST leaves the device
 * (ADR-010). Cheap, and it turns a privacy regression into a loud failure.
 */
export const NEVER_SYNCED_TABLES: readonly string[] = ['local_geofence'];
