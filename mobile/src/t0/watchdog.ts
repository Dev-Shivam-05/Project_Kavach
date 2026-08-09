/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * T0 · SELF-WATCHDOG + HEARTBEAT   (P-004, FR-011, NFR-007)
 *
 * "The OS or the OEM battery manager kills the background service. Nothing tells
 *  anyone. The system is dead for weeks and is discovered only on the night it
 *  was needed."
 *
 * This is not a bug you fix once. Xiaomi, Oppo/Realme, Vivo, OnePlus and Samsung
 * all ship battery managers that override documented Android behaviour, and
 * Android 16 tightened background-start rules further. The only honest posture
 * is: assume you WILL be killed, and make the resurrection observable.
 *
 * So the contract here is narrow and testable:
 *   1. Tick every 15 minutes, from the OS scheduler and from a foreground timer.
 *   2. Persist the tick time to disk, outside the JS heap, so it survives a
 *      force-stop and a reboot.
 *   3. On the next tick, if the gap is far larger than the interval, we were
 *      DEAD. Write a SERVICE_DEATH event carrying the gap duration and surface
 *      it — a silent restart is the failure mode P-004 is actually about.
 *
 * The real fix is Device Owner provisioning (ADR-015); this is what you do for
 * the phones you could not provision. `registerWatchdog()` never throws: on a
 * platform without background tasks (Expo Go, web) it degrades to the foreground
 * timer and says so in `watchdogStatus()`.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import * as TaskManager from 'expo-task-manager';
import * as BackgroundTask from 'expo-background-task';
import { Directory, File, Paths } from 'expo-file-system';
import { CONFIG } from '../core/config';

export const WATCHDOG_TASK = 'kavach-t0-watchdog';

/** A gap beyond this multiple of the interval means we were not merely late. */
const DEATH_FACTOR = 2.5;
const DEATH_LOG_LIMIT = 20;

export type TickSource = 'background' | 'foreground' | 'boot';

export interface ServiceDeathEvent {
  /** When the gap was DETECTED (we cannot know when we died, only when we woke). */
  at: number;
  /** How long we were gone, ms. This is the number that goes to the server. */
  gapMs: number;
  expectedMs: number;
  source: TickSource;
}

interface WatchdogState {
  v: 1;
  lastTickAt: number;
  lastTickSource: TickSource;
  ticks: number;
  deaths: ServiceDeathEvent[];
}

const EMPTY_STATE: WatchdogState = {
  v: 1,
  lastTickAt: 0,
  lastTickSource: 'boot',
  ticks: 0,
  deaths: [],
};

// ── Persistence (survives force-stop and reboot; the JS heap does not) ────────

function stateFile(): File {
  const dir = new Directory(Paths.document, 'kavach-watchdog');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return new File(dir, 'watchdog.json');
}

function readState(): WatchdogState {
  try {
    const f = stateFile();
    if (!f.exists) return { ...EMPTY_STATE, deaths: [] };
    const parsed = JSON.parse(f.textSync()) as Partial<WatchdogState>;
    return {
      v: 1,
      lastTickAt: typeof parsed.lastTickAt === 'number' ? parsed.lastTickAt : 0,
      lastTickSource: parsed.lastTickSource ?? 'boot',
      ticks: typeof parsed.ticks === 'number' ? parsed.ticks : 0,
      deaths: Array.isArray(parsed.deaths) ? parsed.deaths : [],
    };
  } catch {
    return { ...EMPTY_STATE, deaths: [] };
  }
}

/**
 * Returns whether the write landed. This used to be checked by reading the file
 * back and comparing `lastTickAt` — a second full synchronous read whose only
 * job was to confirm the first synchronous write, on the cold-start path and
 * then every 15 minutes for the life of the process. The write either throws or
 * it does not; that is the same information for a third of the disk I/O.
 */
function writeState(state: WatchdogState): boolean {
  try {
    const f = stateFile();
    if (!f.exists) f.create({ intermediates: true, overwrite: true });
    f.write(JSON.stringify(state));
    return true;
  } catch {
    // A watchdog that cannot persist still ticks; it just cannot detect death.
    // Reported honestly through watchdogStatus().persistent.
    return false;
  }
}

// ── Runtime state ─────────────────────────────────────────────────────────────

let deathSink: ((e: ServiceDeathEvent) => void) | null = null;
let heartbeatSender: (() => void | Promise<void>) | null = null;
let foregroundTimer: ReturnType<typeof setInterval> | null = null;
let backgroundRegistered = false;
let persistent = true;
let lastGap: number | null = null;
let lastTickAt: number | null = null;
let lastHeartbeatAt: number | null = null;
let lastHeartbeatOk: boolean | null = null;
let tickCount = 0;
let deaths: ServiceDeathEvent[] = [];

/** Where SERVICE_DEATH events go — normally the incident event log (FR-006). */
export function setWatchdogSink(sink: ((e: ServiceDeathEvent) => void) | null): void {
  deathSink = sink;
}

/**
 * The heartbeat itself is a T1 concern (it needs the network), so the watchdog
 * only owns the SCHEDULE. Injecting the sender keeps T0 free of any dependency
 * on the sync plane — T0 never awaits T1.
 */
export function setHeartbeatSender(sender: (() => void | Promise<void>) | null): void {
  heartbeatSender = sender;
}

/**
 * One tick. Runs in the headless background context and in the foreground, and
 * must be safe in both — no React, no store, no network of its own.
 */
async function tick(source: TickSource): Promise<void> {
  const now = Date.now();
  const state = readState();
  const expected = CONFIG.watchdogIntervalMs;

  if (state.lastTickAt > 0) {
    const gap = now - state.lastTickAt;
    lastGap = gap;
    if (gap > expected * DEATH_FACTOR) {
      const event: ServiceDeathEvent = { at: now, gapMs: gap, expectedMs: expected, source };
      deaths = [event, ...state.deaths].slice(0, DEATH_LOG_LIMIT);
      state.deaths = deaths;
      try {
        deathSink?.(event);
      } catch {
        // The event is persisted regardless; the sink can pick it up later.
      }
    } else {
      deaths = state.deaths;
    }
  } else {
    deaths = state.deaths;
  }

  state.lastTickAt = now;
  state.lastTickSource = source;
  state.ticks = state.ticks + 1;
  persistent = writeState(state);

  lastTickAt = now;
  tickCount++;

  if (heartbeatSender) {
    try {
      await heartbeatSender();
      lastHeartbeatOk = true;
    } catch {
      // FR-034: a heartbeat that cannot be sent is exactly what the server's
      // gap analysis is for. Failing here changes nothing locally.
      lastHeartbeatOk = false;
    }
    lastHeartbeatAt = Date.now();
  }
}

// ★ Module scope, before any registration. TaskManager requires the task to be
//   defined synchronously at import time so it is present when the OS re-enters
//   a killed process headlessly and immediately runs it.
TaskManager.defineTask(WATCHDOG_TASK, async () => {
  try {
    await tick('background');
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

// ── Public API ────────────────────────────────────────────────────────────────

export async function registerWatchdog(): Promise<void> {
  // Foreground timer first: it is the leg that always works, including in Expo
  // Go, and it costs nothing while the app is alive.
  if (foregroundTimer === null) {
    foregroundTimer = setInterval(() => {
      void tick('foreground');
    }, CONFIG.watchdogIntervalMs);
  }

  // Boot tick: this is the one that DETECTS a death, because it runs the moment
  // the process comes back — whether that was a restart, a reboot or a
  // resurrection after an OEM battery manager killed us.
  await tick('boot');

  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status !== BackgroundTask.BackgroundTaskStatus.Available) {
      backgroundRegistered = false;
      return;
    }
    const already = await TaskManager.isTaskRegisteredAsync(WATCHDOG_TASK);
    if (!already) {
      await BackgroundTask.registerTaskAsync(WATCHDOG_TASK, {
        // 15 minutes is the OS floor. The system treats it as a minimum delay,
        // not a promise — which is exactly why we measure the gap rather than
        // assuming the schedule held.
        minimumInterval: Math.max(15, Math.round(CONFIG.watchdogIntervalMs / 60_000)),
      });
    }
    backgroundRegistered = true;
  } catch {
    // Expo Go, web, or a device with background execution disabled.
    backgroundRegistered = false;
  }
}

export async function unregisterWatchdog(): Promise<void> {
  if (foregroundTimer !== null) {
    clearInterval(foregroundTimer);
    foregroundTimer = null;
  }
  try {
    if (await TaskManager.isTaskRegisteredAsync(WATCHDOG_TASK)) {
      await BackgroundTask.unregisterTaskAsync(WATCHDOG_TASK);
    }
  } catch {
    // Never registered, or the module is unavailable.
  }
  backgroundRegistered = false;
}

/**
 * Milliseconds between the previous tick and this one. Larger than
 * `CONFIG.watchdogIntervalMs × 2.5` means we were dead for that long — the
 * number FR-011 requires us to report.
 */
export function lastGapMs(): number | null {
  return lastGap;
}

/** Persisted death log, newest first. Survives restarts. */
export function deathLog(): readonly ServiceDeathEvent[] {
  return deaths;
}

/** Force a tick now — used by the canary drill (§16.2) and by pull-to-refresh. */
export async function heartbeatNow(): Promise<void> {
  await tick('foreground');
}

export interface WatchdogStatus {
  backgroundRegistered: boolean;
  foregroundTimerRunning: boolean;
  /** False means the state file is unwritable, so death detection is blind. */
  persistent: boolean;
  intervalMs: number;
  deathFactor: number;
  ticks: number;
  lastTickAt: number | null;
  lastGapMs: number | null;
  deaths: number;
  lastHeartbeatAt: number | null;
  lastHeartbeatOk: boolean | null;
  /** FR-034: silent longer than this and the family gets told. */
  silentAlertMs: number;
  agentSilent: boolean;
}

export function watchdogStatus(): WatchdogStatus {
  return {
    backgroundRegistered,
    foregroundTimerRunning: foregroundTimer !== null,
    persistent,
    intervalMs: CONFIG.watchdogIntervalMs,
    deathFactor: DEATH_FACTOR,
    ticks: tickCount,
    lastTickAt,
    lastGapMs: lastGap,
    deaths: deaths.length,
    lastHeartbeatAt,
    lastHeartbeatOk,
    silentAlertMs: CONFIG.agentSilentAlertMs,
    agentSilent:
      lastTickAt !== null && Date.now() - lastTickAt > CONFIG.agentSilentAlertMs,
  };
}
