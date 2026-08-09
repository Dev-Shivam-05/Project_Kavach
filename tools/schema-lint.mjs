#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * schema-lint — invariant I-3, with the Class-A′ allowlist from §2.4.6
 *
 * I-3 is "zero Class-A plaintext at rest on the server". NFR-013 and the whole
 * E2EE argument in §2.4 rest on it, and it is broken by a single column: someone
 * adds `lat REAL` to make a query easier, the migration lands, and the server is
 * now a location database. Nothing fails, nothing pages, and the property is
 * gone until an audit finds it.
 *
 * §2.4.6 concedes exactly one class of exception — Class A′, precise coordinates
 * that must exist transiently because SMS cannot carry ciphertext (P-051, F-10)
 * — and requires that the exception be an explicit allowlist so I-3 stays
 * machine-checkable. That allowlist is ALLOWLIST below, each entry carrying the
 * reason it is on the list. Adding an entry is the reviewable act; adding a
 * column is not.
 *
 * Scope: the two files that decide what is persisted.
 *   backend/internal/store/store.go   the server's tables (§2.8)
 *   mobile/src/db/schema.ts           the on-device store (ADR-012)
 *
 * Usage:  node tools/schema-lint.mjs
 * Exit:   0 clean · 1 a name is not on the allowlist, or an entry has gone stale
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Terms long enough that a substring hit is never a false positive: nothing
 * legitimate is called `…latitude…`.
 */
const SUBSTRING_TERMS = ['latitude', 'longitude', 'address', 'precise'];

/**
 * Terms that must match a whole word. As substrings, `lat` rejects
 * escalation_timer and latency_ms and `lon` rejects colon — and a lint that
 * rejects escalation_timer is a lint somebody switches off. Word matching still
 * catches lat, user_lat, userLat, loc_lat and locLat.
 */
const WORD_TERMS = ['lat', 'lon'];

/**
 * The Class-A′ allowlist (§2.4.6). Every entry is a name that looks like precise
 * location and is permitted to exist where it is, with the reason.
 *
 * ★ The backend list is deliberately empty. ★ A′ exists on the wire and in
 * sms-inbound process memory; the only location the server ever persists is
 * `coarse_h3_r7`, the ≈1 km cell. An entry here would be the first Class-A
 * column on the server, which is the exact event this file exists to make loud.
 */
const ALLOWLIST = [
  {
    file: 'mobile/src/db/schema.ts',
    field: 'local_geofence.lat',
    reason:
      'ADR-010. local_geofence is in NEVER_SYNCED_TABLES and api.ts asserts it before a POST leaves the device. A fence centre is a home, a school or a clinic; crossings are evaluated on-device and only the resulting event leaves, carrying the coarse cell.',
  },
  {
    file: 'mobile/src/db/schema.ts',
    field: 'local_geofence.lon',
    reason: 'As local_geofence.lat.',
  },
  {
    file: 'mobile/src/db/schema.ts',
    field: 'location_point.lat',
    reason:
      'Class A on the device, which ADR-012 makes the source of truth. 90-day local retention (§2.8.6); the `synced` column exists because upload is conditional on a live consent grant, never on the row existing.',
  },
  {
    file: 'mobile/src/db/schema.ts',
    field: 'location_point.lon',
    reason: 'As location_point.lat.',
  },
  {
    file: 'mobile/src/db/schema.ts',
    field: 'presence.loc_lat',
    reason:
      'Device-local presence cache behind the family map. A pin is drawn only against a live, unrevoked, unexpired live_location grant; the row is never uploaded.',
  },
  {
    file: 'mobile/src/db/schema.ts',
    field: 'presence.loc_lon',
    reason: 'As presence.loc_lat.',
  },
];

const TARGETS = [
  { file: 'backend/internal/store/store.go', extract: goStructFields },
  { file: 'mobile/src/db/schema.ts', extract: sqlColumns },
];

/** Split a name into lowercase words across snake_case, camelCase and digits. */
function words(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** The term a name matches, or null. */
function hit(name) {
  const lower = name.toLowerCase();
  for (const t of SUBSTRING_TERMS) if (lower.includes(t)) return t;
  const ws = words(name);
  for (const t of WORD_TERMS) if (ws.includes(t)) return t;
  return null;
}

/**
 * Column names out of the CREATE TABLE bodies in a TS template literal. Returns
 * { qualified: 'location_point.lat', names: ['lat'], line }.
 */
function sqlColumns(src) {
  const out = [];
  const lines = src.split('\n');
  let table = null;
  for (let i = 0; i < lines.length; i++) {
    const bare = lines[i].replace(/--.*$/, '').trim();
    if (!bare) continue;
    const open = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_]\w*)\s*\(/i.exec(bare);
    if (open) {
      table = open[1];
      continue;
    }
    if (table === null) continue;
    if (/^\)/.test(bare)) {
      table = null;
      continue;
    }
    // Table-level constraints declare no column.
    if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(bare)) continue;
    const col = /^([A-Za-z_]\w*)\s+/.exec(bare);
    if (!col) continue;
    out.push({ qualified: `${table}.${col[1]}`, names: [col[1]], line: i + 1 });
  }
  return out;
}

/**
 * Field names and json tags out of top-level Go struct declarations. Both are
 * checked: the tag is the persisted name, the field is what a reader sees.
 */
function goStructFields(src) {
  const out = [];
  const lines = src.split('\n');
  let struct = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const open = /^type\s+([A-Za-z_]\w*)\s+struct\s*\{/.exec(raw);
    if (open) {
      struct = open[1];
      continue;
    }
    if (struct === null) continue;
    if (/^\}/.test(raw)) {
      struct = null;
      continue;
    }
    const tag = /`[^`]*json:"([^"]*)"/.exec(raw);
    const body = raw.replace(/`[^`]*`/g, '').replace(/\/\/.*$/, '').trim();
    if (!body) continue;
    // `Name Type` and `A, B Type`; an embedded field has no type and is skipped.
    const decl = /^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+\S/.exec(body);
    if (!decl) continue;
    const names = decl[1].split(',').map((s) => s.trim());
    const json = tag ? tag[1].split(',')[0] : '';
    for (const n of names) {
      out.push({
        qualified: `${struct}.${n}`,
        names: json && names.length === 1 ? [n, json] : [n],
        line: i + 1,
      });
    }
  }
  return out;
}

// ── run ───────────────────────────────────────────────────────────────────────
const failures = [];
const matchedAllowlist = new Set();

for (const target of TARGETS) {
  const abs = path.join(ROOT, target.file);
  let src;
  try {
    src = fs.readFileSync(abs, 'utf8');
  } catch {
    failures.push({
      kind: 'missing',
      text: `${target.file} is not readable. schema-lint cannot vouch for a file it did not open.`,
    });
    continue;
  }
  for (const field of target.extract(src)) {
    let term = null;
    for (const n of field.names) {
      term = hit(n);
      if (term) break;
    }
    if (!term) continue;
    const key = `${target.file}::${field.qualified}`;
    const allowed = ALLOWLIST.find(
      (a) => a.file === target.file && a.field === field.qualified,
    );
    if (allowed) {
      matchedAllowlist.add(key);
      continue;
    }
    failures.push({
      kind: 'unlisted',
      file: target.file,
      line: field.line,
      field: field.qualified,
      term,
    });
  }
}

// A stale entry is a permission for a column that no longer exists; leaving it
// means the next column with that name inherits a reason written for another one.
for (const a of ALLOWLIST) {
  if (!matchedAllowlist.has(`${a.file}::${a.field}`)) {
    failures.push({ kind: 'stale', file: a.file, field: a.field });
  }
}

if (failures.length === 0) {
  console.log(
    `schema-lint: ${TARGETS.length} files, ${ALLOWLIST.length} Class-A′ allowlist entries, all accounted for — clean`,
  );
  process.exit(0);
}

console.error('\nschema-lint FAILED — invariant I-3 (zero Class-A plaintext at rest)\n');
for (const f of failures) {
  if (f.kind === 'missing') {
    console.error(`  ${f.text}\n`);
    continue;
  }
  if (f.kind === 'stale') {
    console.error(`  ${f.file}`);
    console.error(`    allowlist entry '${f.field}' matches nothing.`);
    console.error(
      `    The column is gone. Remove the entry from ALLOWLIST in tools/schema-lint.mjs`,
    );
    console.error(`    so the next '${f.field}' has to argue for itself.\n`);
    continue;
  }
  console.error(`  ${f.file}:${f.line}  ${f.field}`);
  console.error(`    matches '${f.term}' — this is precise location (§2.4.6, I-3).`);
  console.error(
    `    If it must exist, add it to ALLOWLIST in tools/schema-lint.mjs with the`,
  );
  console.error(
    `    reason it is safe where it is. On the server that reason has to explain`,
  );
  console.error(`    why coarse_h3_r7 is not enough.\n`);
}
process.exit(1);
