/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * T0 · ALARM — a stop that lands mid-start must win (t0-13, P-021)
 *
 * `startAlarm()` sets `alarmActive` and then awaits the audio session, the
 * siren synthesis and the volume raise. A `stopAlarm()` inside that window used
 * to be followed by `play()` and by storing a volume-restore handle that nobody
 * would ever call: a siren nothing could stop, at maximum volume, after the
 * person had already typed the PIN. The stubs here park each await behind a
 * deferred so the stop can be placed exactly between them.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

interface Gate {
  audioMode: (() => void) | null;
  maxVolume: (() => void) | null;
  plays: number;
  pauses: number;
  maxCalls: number;
  restores: number;
  torch: boolean[];
}
const gate: Gate = { audioMode: null, maxVolume: null, plays: 0, pauses: 0, maxCalls: 0, restores: 0, torch: [] };
(globalThis as unknown as { __kavachAlarm: Gate }).__kavachAlarm = gate;

const STUBS: Record<string, string> = {
  'react-native': `
    export const Platform = { OS: 'android', select: (o) => o.android ?? o.default };
    export const StyleSheet = { create: (s) => s, hairlineWidth: 1 };
    export const InteractionManager = { runAfterInteractions(fn) { fn(); } };
    export default { Platform, StyleSheet, InteractionManager };
  `,
  'expo-audio': `
    const g = globalThis.__kavachAlarm;
    export function setAudioModeAsync() {
      return new Promise((resolve) => { g.audioMode = resolve; });
    }
    export function createAudioPlayer() {
      return {
        loop: false, volume: 1,
        play() { g.plays++; },
        pause() { g.pauses++; },
        async seekTo() {},
        replace() {},
        remove() {},
      };
    }
  `,
  'expo-haptics': `
    export const ImpactFeedbackStyle = { Light: 'light', Medium: 'medium', Heavy: 'heavy' };
    export const NotificationFeedbackType = { Success: 'success', Warning: 'warning', Error: 'error' };
    export async function impactAsync() {}
    export async function notificationAsync() {}
    export async function selectionAsync() {}
  `,
  './native': `
    const g = globalThis.__kavachAlarm;
    export async function setTorch(on) { g.torch.push(on); }
    export function maxAlarmVolume() {
      g.maxCalls++;
      return new Promise((resolve) => { g.maxVolume = () => resolve(async () => { g.restores++; }); });
    }
  `,
};

const T0_DIR = new URL('../src/t0/', import.meta.url).href;

registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL ?? '';
    if (STUBS[specifier] && (!specifier.startsWith('.') || parent.startsWith(T0_DIR))) {
      return { url: `kavach-alarm-stub:${specifier}`, shortCircuit: true, format: 'module' };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('kavach-alarm-stub:')) {
      return { format: 'module', shortCircuit: true, source: STUBS[url.slice('kavach-alarm-stub:'.length)] };
    }
    return next(url, context);
  },
});

const alarm = await import('../src/t0/alarm.ts');

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

/** Wait until the module has parked on the named gate. */
async function parkedOn(key: 'audioMode' | 'maxVolume'): Promise<() => void> {
  for (let i = 0; i < 50 && gate[key] === null; i++) await flush();
  const release = gate[key];
  assert.ok(release, `startAlarm never reached ${key}`);
  gate[key] = null;
  return release;
}

afterEach(async () => {
  alarm.stopAlarm();
  gate.audioMode?.();
  gate.maxVolume?.();
  await flush();
  gate.audioMode = null;
  gate.maxVolume = null;
  gate.plays = 0;
  gate.pauses = 0;
  gate.maxCalls = 0;
  gate.restores = 0;
  gate.torch = [];
});

test('★ t0-13 · a stop during the audio-session await means the siren never plays and the volume is never raised', async () => {
  alarm.startAlarm({ silent: false, strobe: false, haptics: false });
  assert.equal(alarm.isAlarmActive(), true);
  const releaseAudioMode = await parkedOn('audioMode');

  alarm.stopAlarm(); // the PIN landed while the session was still being configured
  assert.equal(alarm.isAlarmActive(), false);
  releaseAudioMode();
  await flush();
  await flush();

  assert.equal(gate.plays, 0, 'play() after a stop is a siren nothing can silence');
  assert.equal(gate.maxCalls, 0, 'and the volume must not be touched either');
});

test('a stop while the volume is being raised restores it immediately instead of orphaning the handle', async () => {
  alarm.startAlarm({ silent: false, strobe: false, haptics: false });
  (await parkedOn('audioMode'))();
  const releaseVolume = await parkedOn('maxVolume');
  assert.equal(gate.plays, 1, 'the siren started normally before the stop');

  alarm.stopAlarm();
  assert.ok(gate.pauses >= 1, 'stop paused the player');
  releaseVolume();
  await flush();
  await flush();
  assert.equal(gate.restores, 1, 'the restore that arrived after the stop was called at once (P-021)');
});

test('an uninterrupted start plays, raises the volume once, and stop restores it once', async () => {
  alarm.startAlarm({ silent: false, strobe: false, haptics: false });
  (await parkedOn('audioMode'))();
  (await parkedOn('maxVolume'))();
  await flush();
  assert.equal(gate.plays, 1);
  assert.equal(gate.maxCalls, 1);
  assert.equal(gate.restores, 0);
  alarm.stopAlarm();
  await flush();
  assert.equal(gate.restores, 1);
});
