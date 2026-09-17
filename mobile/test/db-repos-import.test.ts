/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE DEVICE STORE IS REACHABLE FROM A TEST — ★ ADR-012 · CLAUDE.md convention 7
 *
 * Until 6 Sep, `src/db/repos.ts` could not be imported from any test at all. It
 * imports `'../t0/stateMachine.generated'`, `path.extname()` of that specifier
 * is `.generated`, and `test/shim.mjs`'s resolver treated any extension as "this
 * already names a file" — so `.ts` was never re-added and Node threw
 * `ERR_MODULE_NOT_FOUND`. Everything on top of the store — `net/ws.ts`,
 * `net/outboxDrain.ts`, `state/store.ts`, the whole T1 coordination plane on
 * the phone — was outside the test surface, and every new module paid the
 * callback-injection tax (`watchSession.ts`'s `WatchContext`) to route around a
 * one-line resolver bug.
 *
 * This file is the proof that the guard is fixed, and the tripwire that keeps it
 * fixed: if the resolver regresses, the FIRST import below fails to load and the
 * whole file errors, which is exactly the loud failure the old guard never gave.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cursorRepo, outboxRepo } from '../src/db/repos';
import { isDbOpen, openDb } from '../src/db/index';

test('★ db/repos.ts imports under the shim — a dotted specifier is a name, not an extension', () => {
  assert.equal(typeof outboxRepo.enqueue, 'function');
  assert.equal(typeof cursorRepo.get, 'function');
});

test('the store opens and migrates against the sqlite stub, and a repo read answers honestly empty', async () => {
  // The expo-sqlite stub answers every PRAGMA and SELECT with "nothing", so
  // openDb() runs the full migration list as no-ops and a cursor read comes back
  // null — the same answer a fresh install gives before its first frame.
  await openDb();
  assert.equal(isDbOpen(), true);
  assert.equal(await cursorRepo.get('incidents'), null);
});

test('the T1 net modules that sit on the store import too', async () => {
  // ws.ts and outboxDrain.ts are the two documented casualties of the old guard
  // (CLAUDE.md convention 7). Both are dynamic imports so a regression names the
  // module that broke rather than failing the file at load time.
  const ws = await import('../src/net/ws');
  const drain = await import('../src/net/outboxDrain');
  assert.equal(typeof ws.connectWs, 'function');
  assert.equal(typeof ws.onFrame, 'function');
  assert.ok(Object.keys(drain).length > 0, 'outboxDrain.ts exported nothing');
});
