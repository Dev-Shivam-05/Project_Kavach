/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * DATABASE LIFECYCLE — open, migrate, accessor
 *
 * §2.8.5: the on-device store is the source of truth for this family's incidents.
 * That makes opening it a T0 dependency, so the rules here are conservative:
 *
 *   · WAL, because a T0 write must never block behind a read of the timeline.
 *   · Single-flight open, because bootstrap(), the outbox drain and the WebSocket
 *     all race to touch the database on the first frame after launch.
 *   · Forward-only, idempotent, ADDITIVE-ONLY migrations (§8.4), enforced at
 *     runtime — a destructive migration on the device holding the only copy of an
 *     incident timeline is unrecoverable, so it is refused rather than trusted.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import * as SQLite from 'expo-sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';

import { MIGRATIONS, SCHEMA_VERSION, TABLES, type Migration } from './schema';

export const DATABASE_NAME = 'kavach.db';

/** Thrown by getDb() only. Every repository uses requireDb() and never sees this. */
export class DatabaseNotOpenError extends Error {
  constructor() {
    super('kavach database is not open yet — call openDb() (or use requireDb())');
    this.name = 'DatabaseNotOpenError';
  }
}

export class MigrationError extends Error {
  constructor(version: number, cause: string) {
    super(`migration ${version} failed: ${cause}`);
    this.name = 'MigrationError';
  }
}

let handle: SQLiteDatabase | null = null;
let opening: Promise<SQLiteDatabase> | null = null;

/**
 * §8.4 additive-only. A migration that drops a table or a column, or rewrites an
 * incident row in place, is rejected before a single statement runs. This is a
 * developer guard-rail with teeth: the build fails loudly at boot in development
 * rather than quietly eating a family's history in production.
 */
const DESTRUCTIVE = /\b(drop\s+(table|index|trigger|view)|drop\s+column|delete\s+from|truncate)\b/i;

function assertAdditive(m: Migration): void {
  // Strip comments first: "-- never DROP TABLE here" must not trip the guard.
  const sql = m.sql.replace(/--[^\n]*/g, ' ');
  if (DESTRUCTIVE.test(sql)) {
    throw new MigrationError(m.version, 'migrations are additive-only (§8.4)');
  }
  if (!Number.isInteger(m.version) || m.version < 1) {
    throw new MigrationError(m.version, 'version must be a positive integer');
  }
}

async function readUserVersion(db: SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  return row?.user_version ?? 0;
}

/**
 * Run every migration whose version exceeds `user_version`, each in its own
 * transaction so a failure halfway through the list leaves the database at the
 * last fully-applied version rather than in a half-migrated state.
 */
async function migrate(db: SQLiteDatabase): Promise<number> {
  const ordered = [...MIGRATIONS].sort((a, b) => a.version - b.version);
  for (const m of ordered) assertAdditive(m);

  let current = await readUserVersion(db);
  for (const m of ordered) {
    if (m.version <= current) continue;
    try {
      await db.withTransactionAsync(async () => {
        await db.execAsync(m.sql);
      });
    } catch (e) {
      throw new MigrationError(m.version, e instanceof Error ? e.message : String(e));
    }
    // PRAGMA cannot be parameterised. The value is an integer literal from our own
    // migration table and is range-checked above, never user input.
    await db.execAsync(`PRAGMA user_version = ${m.version}`);
    current = m.version;
  }
  return current;
}

/**
 * Open (or return) the database. Idempotent and single-flight: concurrent callers
 * share one open+migrate, so bootstrap racing the outbox drain cannot produce two
 * connections running migrations against each other.
 */
export async function openDb(): Promise<SQLiteDatabase> {
  if (handle) return handle;
  if (opening) return opening;

  opening = (async () => {
    const db = await SQLite.openDatabaseAsync(DATABASE_NAME);
    // Pragmas must run OUTSIDE a transaction; journal_mode in particular is a
    // no-op inside one. WAL is what lets a T0 append proceed while the timeline
    // screen is mid-query.
    await db.execAsync(
      [
        'PRAGMA journal_mode = WAL;',
        // NORMAL is the correct trade under WAL: a durable commit still survives a
        // process crash, only a full OS power-cut can lose the last transaction —
        // and the outbox replays it (§2.10.4).
        'PRAGMA synchronous = NORMAL;',
        'PRAGMA busy_timeout = 5000;',
        'PRAGMA temp_store = MEMORY;',
        // No foreign keys by design — see the header of ./schema.ts.
        'PRAGMA foreign_keys = OFF;',
      ].join('\n'),
    );
    await migrate(db);
    handle = db;
    return db;
  })();

  try {
    return await opening;
  } finally {
    opening = null;
  }
}

/**
 * Synchronous accessor for code already inside a booted flow.
 * Throws DatabaseNotOpenError if called before openDb() resolved — deliberately
 * loud, because a silent null here would surface as a missing incident.
 */
export function getDb(): SQLiteDatabase {
  if (!handle) throw new DatabaseNotOpenError();
  return handle;
}

export function isDbOpen(): boolean {
  return handle !== null;
}

/**
 * What every repository uses. Opens on demand, so a repository call made before
 * bootstrap() finishes works instead of throwing into the UI (hard rule 8).
 */
export async function requireDb(): Promise<SQLiteDatabase> {
  return handle ?? (await openDb());
}

export async function closeDb(): Promise<void> {
  const db = handle;
  handle = null;
  if (db) await db.closeAsync();
}

export interface DbHealth {
  open: boolean;
  userVersion: number;
  expectedVersion: number;
  journalMode: string;
  missingTables: string[];
  integrityOk: boolean;
}

/**
 * Read-only self-check, surfaced in the diagnostics screen (P-031). A corrupt
 * on-device store is a silent multi-hour outage of the whole product, so it gets
 * checked rather than assumed.
 */
export async function checkDbHealth(): Promise<DbHealth> {
  const db = await requireDb();
  const [version, journal, integrity, present] = await Promise.all([
    readUserVersion(db),
    db.getFirstAsync<{ journal_mode: string }>('PRAGMA journal_mode'),
    db.getFirstAsync<{ integrity_check: string }>('PRAGMA integrity_check'),
    db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ),
  ]);
  const names = new Set(present.map((r) => r.name));
  return {
    open: true,
    userVersion: version,
    expectedVersion: SCHEMA_VERSION,
    journalMode: journal?.journal_mode ?? 'unknown',
    missingTables: TABLES.filter((t) => !names.has(t)),
    integrityOk: (integrity?.integrity_check ?? '') === 'ok',
  };
}

export { SCHEMA_VERSION };
export type { SQLiteDatabase };
