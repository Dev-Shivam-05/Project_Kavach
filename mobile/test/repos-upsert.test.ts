/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * REPOSITORIES · "never seen" must stay NULL through an upsert (t0-15)
 *
 * `presenceRepo.upsert` and `deviceRepo.upsert` resolved a conflict with
 * `MAX(COALESCE(old, 0), COALESCE(new, 0))`, which turns two NULLs into 0 — so a
 * member paused before ever being seen rendered as "last seen 56 years ago", and
 * every `=== null` freshness check treated 1970 as a real sighting.
 *
 * These run the REAL repository SQL against the REAL schema on Node's built-in
 * SQLite: `expo-sqlite` is swapped for a thin adapter over `node:sqlite` so the
 * migrations, the pragmas and the upsert statements are the ones that ship.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const SQLITE_ADAPTER = `
  import { DatabaseSync } from 'node:sqlite';
  export async function openDatabaseAsync() {
    const db = new DatabaseSync(':memory:');
    return {
      execAsync: async (sql) => { db.exec(sql); },
      runAsync: async (sql, params = []) => {
        const r = db.prepare(sql).run(...params);
        return { lastInsertRowId: Number(r.lastInsertRowid), changes: Number(r.changes) };
      },
      getAllAsync: async (sql, params = []) => db.prepare(sql).all(...params),
      getFirstAsync: async (sql, params = []) => db.prepare(sql).get(...params) ?? null,
      withTransactionAsync: async (fn) => {
        db.exec('BEGIN');
        try { await fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
      },
      closeAsync: async () => { db.close(); },
    };
  }
`;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'expo-sqlite') return { url: 'kavach-sqlite-stub:expo-sqlite', shortCircuit: true, format: 'module' };
    if (specifier === './stateMachine.generated' || specifier === '../t0/stateMachine.generated') {
      return { url: new URL('../src/t0/stateMachine.generated.ts', import.meta.url).href, shortCircuit: true, format: 'module-typescript' };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'kavach-sqlite-stub:expo-sqlite') return { format: 'module', shortCircuit: true, source: SQLITE_ADAPTER };
    return next(url, context);
  },
});

const { openDb, checkDbHealth } = await import('../src/db/index.ts');
const { presenceRepo, deviceRepo } = await import('../src/db/repos.ts');
const { DegradationLevel } = await import('../src/core/types.ts');
type MemberPresence = import('../src/core/types.ts').MemberPresence;
type Device = import('../src/core/types.ts').Device;

await openDb();

function presence(over: Partial<MemberPresence> = {}): MemberPresence {
  return {
    memberId: 'm1',
    lastSeenAt: null,
    batteryPct: null,
    agentHealthy: true,
    degradationLevel: DegradationLevel.FULL,
    location: null,
    room: null,
    monitoringPaused: false,
    ...over,
  };
}

function device(over: Partial<Device> = {}): Device {
  return {
    id: 'd1',
    familyId: 'f1',
    memberId: 'm1',
    platform: 'android',
    model: null,
    manufacturer: null,
    osVersion: null,
    signingPubkey: '',
    isDeviceOwner: false,
    imei: null,
    lastHeartbeatAt: null,
    batteryPct: null,
    batteryTempC: null,
    batteryHealth: null,
    agentHealthy: true,
    diagnostics: {} as Device['diagnostics'],
    ...over,
  };
}

test('the shipped schema migrates on node:sqlite and passes its own health check', async () => {
  const health = await checkDbHealth();
  assert.equal(health.integrityOk, true);
  assert.deepEqual(health.missingTables, []);
  assert.equal(health.userVersion, health.expectedVersion);
});

test('★ t0-15 · presence: a member paused before ever being seen stays "never", not 1970', async () => {
  await presenceRepo.setPaused('never-seen', true);
  await presenceRepo.upsert(presence({ memberId: 'never-seen', monitoringPaused: true }));
  const row = await presenceRepo.get('never-seen');
  assert.ok(row);
  assert.equal(row.lastSeenAt, null);
  assert.equal(row.monitoringPaused, true);
});

test('presence: last_seen_at keeps the newest known value across every NULL combination', async () => {
  await presenceRepo.upsert(presence({ memberId: 'a', lastSeenAt: 100 }));
  await presenceRepo.upsert(presence({ memberId: 'a', lastSeenAt: null }));
  assert.equal((await presenceRepo.get('a'))?.lastSeenAt, 100, 'a NULL update must not erase a sighting');

  await presenceRepo.upsert(presence({ memberId: 'b', lastSeenAt: null }));
  await presenceRepo.upsert(presence({ memberId: 'b', lastSeenAt: 200 }));
  assert.equal((await presenceRepo.get('b'))?.lastSeenAt, 200, 'a first sighting lands');

  await presenceRepo.upsert(presence({ memberId: 'c', lastSeenAt: 300 }));
  await presenceRepo.upsert(presence({ memberId: 'c', lastSeenAt: 200 }));
  assert.equal((await presenceRepo.get('c'))?.lastSeenAt, 300, 'an older report never moves it backwards');
});

test('★ t0-15 · device: last_heartbeat_at follows the same rule', async () => {
  await deviceRepo.upsert(device({ id: 'never', lastHeartbeatAt: null }));
  await deviceRepo.upsert(device({ id: 'never', lastHeartbeatAt: null }));
  assert.equal((await deviceRepo.get('never'))?.lastHeartbeatAt, null);

  await deviceRepo.upsert(device({ id: 'seen', lastHeartbeatAt: 500 }));
  await deviceRepo.upsert(device({ id: 'seen', lastHeartbeatAt: null }));
  assert.equal((await deviceRepo.get('seen'))?.lastHeartbeatAt, 500);

  await deviceRepo.upsert(device({ id: 'seen', lastHeartbeatAt: 700 }));
  assert.equal((await deviceRepo.get('seen'))?.lastHeartbeatAt, 700);
});
