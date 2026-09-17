/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * T0 · SELF-WATCHDOG — the death that was detected and told to nobody (P-004)
 *
 * `registerWatchdog()` runs from `initT0` in the store's `t0` stage; the death
 * sink and the heartbeat sender are installed a stage later. The boot tick —
 * the module's own comment says it is "the one that DETECTS a death" — therefore
 * always ran with `deathSink === null`: the SERVICE_DEATH went to watchdog.json
 * and nowhere else, which is precisely the "silent restart" FR-011 exists to
 * make observable. These cases drive that order — register first, install the
 * sink afterwards — and require the boot death and the boot heartbeat to arrive.
 *
 * The file system is an in-memory stub so `lastTickAt` can be seeded to an hour
 * ago; expo-background-task reports "restricted" so no OS registration is tried.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

interface MemFs {
  files: Map<string, string>;
}
const fs: MemFs = { files: new Map() };
(globalThis as unknown as { __kavachFs: MemFs }).__kavachFs = fs;

const STUBS: Record<string, string> = {
  'expo-file-system': `
    const mem = globalThis.__kavachFs.files;
    export const Paths = { document: '/doc', cache: '/cache', bundle: '/bundle' };
    export class Directory {
      constructor(base, name) { this.path = (typeof base === 'string' ? base : base.path) + '/' + name; this.exists = true; }
      create() {}
    }
    export class File {
      constructor(dir, name) { this.path = (typeof dir === 'string' ? dir : dir.path) + '/' + name; this.uri = 'file://' + this.path; }
      get exists() { return mem.has(this.path); }
      create() { if (!mem.has(this.path)) mem.set(this.path, ''); }
      write(s) { mem.set(this.path, typeof s === 'string' ? s : '<bytes>'); }
      textSync() { return mem.get(this.path) ?? ''; }
      delete() { mem.delete(this.path); }
    }
  `,
  'expo-background-task': `
    export const BackgroundTaskStatus = { Restricted: 1, Available: 2 };
    export const BackgroundTaskResult = { Success: 1, Failed: 2 };
    export async function getStatusAsync() { return BackgroundTaskStatus.Restricted; }
    export async function registerTaskAsync() {}
    export async function unregisterTaskAsync() {}
  `,
};

registerHooks({
  resolve(specifier, context, next) {
    if (STUBS[specifier]) return { url: `kavach-wd-stub:${specifier}`, shortCircuit: true, format: 'module' };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('kavach-wd-stub:')) {
      return { format: 'module', shortCircuit: true, source: STUBS[url.slice('kavach-wd-stub:'.length)] };
    }
    return next(url, context);
  },
});

const wd = await import('../src/t0/watchdog.ts');
const { CONFIG } = await import('../src/core/config.ts');

const STATE_FILE = '/doc/kavach-watchdog/watchdog.json';
const HOUR = 60 * 60_000;

function seedLastTick(agoMs: number): void {
  fs.files.set(
    STATE_FILE,
    JSON.stringify({ v: 1, lastTickAt: Date.now() - agoMs, lastTickSource: 'foreground', ticks: 3, deaths: [] }),
  );
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

afterEach(async () => {
  await wd.unregisterWatchdog();
  wd.__resetWatchdogForTest();
  fs.files.clear();
});

test('★ t0-6 · a death detected by the boot tick reaches a sink installed AFTER registration', async () => {
  seedLastTick(HOUR); // well past 2.5 × 15 min
  await wd.registerWatchdog();
  assert.equal(wd.deathLog().length, 1, 'the boot tick detected the death');
  assert.ok((wd.lastGapMs() ?? 0) >= HOUR - 1000);

  const seen: { gapMs: number; source: string }[] = [];
  wd.setWatchdogSink((e) => seen.push({ gapMs: e.gapMs, source: e.source }));
  assert.equal(seen.length, 1, 'the boot death must be replayed into the late sink');
  assert.equal(seen[0].source, 'boot');
  assert.ok(seen[0].gapMs >= HOUR - 1000);

  // Once delivered, never delivered twice.
  wd.setWatchdogSink((e) => seen.push({ gapMs: e.gapMs, source: e.source }));
  assert.equal(seen.length, 1);
});

test('the boot heartbeat owed while no sender existed is sent when one is installed', async () => {
  seedLastTick(60_000);
  await wd.registerWatchdog();
  assert.equal(wd.watchdogStatus().lastHeartbeatAt, null, 'nothing could be sent yet');

  let sent = 0;
  wd.setHeartbeatSender(() => {
    sent++;
  });
  await tick();
  assert.equal(sent, 1, 'the owed heartbeat goes out on install');
  assert.equal(wd.watchdogStatus().lastHeartbeatOk, true);

  // A second install with nothing owed sends nothing.
  wd.setHeartbeatSender(() => {
    sent++;
  });
  await tick();
  assert.equal(sent, 1);
});

test('a sink installed before the tick is called directly, and a normal gap is no death', async () => {
  seedLastTick(60_000); // one minute: merely late, not dead
  const seen: unknown[] = [];
  wd.setWatchdogSink((e) => seen.push(e));
  await wd.registerWatchdog();
  assert.equal(seen.length, 0);
  assert.equal(wd.deathLog().length, 0);
  assert.equal(wd.watchdogStatus().ticks, 1);
  assert.equal(wd.watchdogStatus().intervalMs, CONFIG.watchdogIntervalMs);
});

test('a sink that throws does not lose the death from the persisted log', async () => {
  seedLastTick(HOUR);
  wd.setWatchdogSink(() => {
    throw new Error('store not ready');
  });
  await wd.registerWatchdog();
  assert.equal(wd.deathLog().length, 1);
  const persisted = JSON.parse(fs.files.get(STATE_FILE) ?? '{}') as { deaths: unknown[] };
  assert.equal(persisted.deaths.length, 1, 'the disk copy is the one that survives a crash');
});
