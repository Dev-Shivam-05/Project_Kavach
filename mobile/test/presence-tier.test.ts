/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * PRESENCE SERVICE · one live location subscription, ever (NFR-005)
 *
 * `applyTier()` awaits `watchPositionAsync`. An SOS moves t0 state, risk and
 * connectivity within the same few milliseconds, so `refreshPresenceTier()` is
 * re-entered while that await is still outstanding. Each call cleared `sub` and
 * kept whatever ITS await returned — so the loser's BestForNavigation / 3 s
 * watcher was never removed: it delivered duplicate fixes, outlived the
 * incident and `stopPresence()`, and burned the battery budget the PRD calls a
 * safety metric. The stub here resolves subscriptions on a timer so two tier
 * changes can genuinely overlap, and counts what is still alive afterwards.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

interface LocState {
  live: Set<number>;
  created: number;
  delayMs: number;
  requested: string[];
}
const loc: LocState = { live: new Set(), created: 0, delayMs: 15, requested: [] };
(globalThis as unknown as { __kavachLoc: LocState }).__kavachLoc = loc;

const STUBS: Record<string, string> = {
  'react-native': `
    export const Platform = { OS: 'android', select: (o) => o.android ?? o.default };
    export const StyleSheet = { create: (s) => s, hairlineWidth: 1 };
    export const AppState = { currentState: 'active', addEventListener() { return { remove() {} }; } };
    export default { Platform, StyleSheet, AppState };
  `,
  'expo-location': `
    const g = globalThis.__kavachLoc;
    export const Accuracy = { Lowest: 1, Low: 2, Balanced: 3, High: 4, Highest: 5, BestForNavigation: 6 };
    export async function getForegroundPermissionsAsync() { return { status: 'granted' }; }
    export async function getLastKnownPositionAsync() { return null; }
    export function watchPositionAsync(opts, cb) {
      const id = ++g.created;
      g.requested.push(String(opts.accuracy));
      return new Promise((resolve) => setTimeout(() => {
        g.live.add(id);
        resolve({ remove() { g.live.delete(id); } });
      }, g.delayMs));
    }
  `,
};

registerHooks({
  resolve(specifier, context, next) {
    if (STUBS[specifier]) return { url: `kavach-loc-stub:${specifier}`, shortCircuit: true, format: 'module' };
    if (specifier === './stateMachine.generated' || specifier === '../t0/stateMachine.generated') {
      return { url: new URL('../src/t0/stateMachine.generated.ts', import.meta.url).href, shortCircuit: true, format: 'module-typescript' };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('kavach-loc-stub:')) {
      return { format: 'module', shortCircuit: true, source: STUBS[url.slice('kavach-loc-stub:'.length)] };
    }
    return next(url, context);
  },
});

const presence = await import('../src/domain/presenceService.ts');
const { DegradationLevel } = await import('../src/core/types.ts');
type PresenceDeps = import('../src/domain/presenceService.ts').PresenceDeps;

const world = { t0State: 'IDLE', risk: false, journey: false };

function deps(): PresenceDeps {
  return {
    noteLocationFix: async () => {},
    geofences: () => [],
    memberId: () => null,
    t0State: () => world.t0State,
    riskElevated: () => world.risk,
    journeyActive: () => world.journey,
    degradation: () => DegradationLevel.FULL,
    onCrossing: () => {},
    connectRealtime: () => {},
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, loc.delayMs * 4));

afterEach(() => {
  presence.stopPresence();
  presence.__resetPresenceForTest();
  loc.live.clear();
  loc.created = 0;
  loc.requested = [];
  world.t0State = 'IDLE';
  world.risk = false;
  world.journey = false;
});

test('★ t0-9 · two overlapping tier changes leave exactly ONE live subscription — the newest', async () => {
  await presence.startPresence(deps());
  assert.equal(loc.live.size, 1, 'idle watcher');

  // An SOS: incident state and risk change inside one await window.
  world.t0State = 'PENDING';
  const a = presence.refreshPresenceTier(); // → active
  world.t0State = 'IDLE';
  world.risk = true;
  const b = presence.refreshPresenceTier(); // → watch, while `a` is still awaiting
  await Promise.all([a, b]);
  await settle();

  assert.equal(loc.created, 3, 'three watchers were requested in all');
  assert.equal(loc.live.size, 1, 'the loser of the race must remove what it created');
  assert.equal(presence.presenceStatus().tier, 'watch', 'the tier reported is the one that is live');
  assert.equal(presence.presenceStatus().running, true);
});

test('stopPresence() during an in-flight tier change removes the subscription that arrives afterwards', async () => {
  await presence.startPresence(deps());
  world.t0State = 'ACTIVE_L1';
  const pending = presence.refreshPresenceTier();
  presence.stopPresence();
  await pending;
  await settle();
  assert.equal(loc.live.size, 0, 'nothing may outlive the stop');
  assert.equal(presence.presenceStatus().running, false);
});

test('the tier follows state: idle → active on an incident, back to idle after', async () => {
  await presence.startPresence(deps());
  world.t0State = 'ACTIVE_L1';
  await presence.refreshPresenceTier();
  await settle();
  assert.equal(presence.presenceStatus().tier, 'active');
  assert.equal(loc.requested.at(-1), '6', 'BestForNavigation only while an incident is live');
  world.t0State = 'RESOLVED';
  await presence.refreshPresenceTier();
  await settle();
  assert.equal(presence.presenceStatus().tier, 'idle');
  assert.equal(loc.live.size, 1);
});
