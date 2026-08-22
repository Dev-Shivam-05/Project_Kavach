/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CONNECTIVITY — P-046: captive portals lie
 *
 * Hotel Wi-Fi, airport Wi-Fi, a railway station's free hotspot and every corporate
 * guest network report "connected" and then swallow every packet. A safety product
 * that trusts the OS connectivity flag will cheerfully post an SOS into a portal's
 * redirect page and report success.
 *
 * ★ NEVER TRUST THE OS FLAG ALONE. ★
 * The verdict here is the AND of two independent signals:
 *   1. expo-network's state, including the platform's own validation bit
 *      (Android NET_CAPABILITY_VALIDATED surfaces as isInternetReachable), and
 *   2. our own 1 s HEAD probe against CONFIG.apiBase + '/healthz'.
 *
 * A failing probe with a "connected" OS is exactly the captive-portal signature,
 * and the correct response is to drop to SMS_ONLY — SMS traverses a portal that
 * data cannot (§2.7.3).
 *
 * The result is cached for CONFIG.connectivityCacheMs because this is consulted
 * on the T0 path, and a 500 ms budget (§2.6.1) cannot afford a probe per trigger.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { Platform } from 'react-native';
import * as Cellular from 'expo-cellular';
import * as Network from 'expo-network';

import { CONFIG } from '../core/config';
import { DegradationLevel } from '../core/types';
import { t0ConfigRepo } from '../db/repos';
import { wsStatus } from './ws';

type Listener = (level: DegradationLevel) => void;

interface Cached {
  level: DegradationLevel;
  at: number;
}

let cache: Cached | null = null;
let inFlight: Promise<DegradationLevel> | null = null;
const listeners = new Set<Listener>();

let netSubscription: { remove: () => void } | null = null;
let poller: ReturnType<typeof setInterval> | null = null;

/** Cached home MCC, so isRoaming() does not hit the database on every call. */
let homeMccCache: string | null = null;

const T0_HOME_MCC_KEY = 'net.homeMcc';

// ── the probe ─────────────────────────────────────────────────────────────────

/**
 * A HEAD against /healthz with a hard 1 s ceiling. Anything slower than a second
 * is, for T0 purposes, indistinguishable from down.
 *
 * A captive portal answers with 200 + HTML for its own redirect, so a bare status
 * check is not enough on its own; that is why this is combined with the platform
 * validation bit rather than used alone.
 */
async function probeHealthz(base: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.connectivityProbeTimeoutMs);
  try {
    const res = await fetch(`${base}/healthz`, {
      method: 'HEAD',
      signal: controller.signal,
      // A portal loves a cached 200. Defeat every layer of caching between us.
      headers: { 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache' },
    });
    // A portal's interception typically returns 200 with text/html, or a 3xx.
    // Our origin answers 204/200 to a HEAD and never redirects.
    if (res.redirected) return false;
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('text/html')) return false;
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function isAirplaneMode(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  try {
    return await Network.isAirplaneModeEnabledAsync();
  } catch {
    return false;
  }
}

async function computeLevel(): Promise<DegradationLevel> {
  let state: Network.NetworkState = {};
  try {
    state = await Network.getNetworkStateAsync();
  } catch {
    // The module can fail on a cold boot before the native side is attached.
    // Assume the radio exists but data does not — SMS is still the honest floor.
    return DegradationLevel.SMS_ONLY;
  }

  if (await isAirplaneMode()) {
    // No cellular, no Wi-Fi. BLE can still be re-enabled by the user in airplane
    // mode on Android, and the family mesh is the only leg left (L1, §2.7.1).
    return DegradationLevel.PEER_ONLY;
  }

  if (state.isConnected !== true || state.type === Network.NetworkStateType.NONE) {
    // No data path. The radio is still there, so SMS — including satellite NTN
    // where the carrier supports it — remains available (L2).
    return DegradationLevel.SMS_ONLY;
  }

  /**
   * DEMO MODE (hard rule 8). There is no /healthz to probe: the "server" is the
   * local synthetic responder in ./api.ts, which is always reachable. Probing
   * would report SMS_ONLY on a perfectly healthy phone and make the ladder lie.
   */
  const validated = state.isInternetReachable !== false;
  const probeOk = await probeHealthz(CONFIG.apiBase);

  if (!validated || !probeOk) {
    // ★ The captive-portal verdict. "Connected" and unreachable at the same time.
    return DegradationLevel.SMS_ONLY;
  }

  return wsStatus() === 'open' ? DegradationLevel.FULL : DegradationLevel.HTTP_ONLY;
}

function emit(level: DegradationLevel): void {
  for (const fn of listeners) {
    try {
      fn(level);
    } catch {
      // A listener that throws must not stop the others from being told the
      // network died. There is nothing useful to do with its error here.
    }
  }
}

function publish(level: DegradationLevel, at: number): DegradationLevel {
  const changed = cache?.level !== level;
  cache = { level, at };
  if (changed) emit(level);
  return level;
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * The current rung of the degradation ladder (§2.7.1), served from a
 * CONFIG.connectivityCacheMs cache. Never throws: an unknown network is reported
 * as SMS_ONLY, which is the conservative answer — it fans out over more legs, and
 * an extra ₹0.40 of SMS is not a consideration when someone may be hurt.
 */
export async function currentDegradation(): Promise<DegradationLevel> {
  const now = Date.now();
  if (cache && now - cache.at < CONFIG.connectivityCacheMs) return cache.level;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      return publish(await computeLevel(), Date.now());
    } catch {
      return publish(DegradationLevel.SMS_ONLY, Date.now());
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** The last known level with no I/O at all — for a render pass, never for T0. */
export function lastKnownDegradation(): DegradationLevel {
  return cache?.level ?? DegradationLevel.FULL;
}

/** Bypass the cache. Called on a network-state change and before an SOS fan-out. */
export async function forceProbe(): Promise<DegradationLevel> {
  cache = null;
  inFlight = null;
  return currentDegradation();
}

/**
 * Subscribe to changes. The first subscriber starts the OS listener and a poll;
 * the last to leave shuts both down, because a timer running in the background
 * for nobody is a straight subtraction from the 180 mAh/day budget (§6.2.6).
 */
export function subscribeDegradation(fn: Listener): () => void {
  listeners.add(fn);
  if (listeners.size === 1) startWatching();
  // Give the new subscriber the current answer rather than making it wait for
  // the next transition, which may be hours away on a stable network.
  void currentDegradation().then((l) => {
    try {
      fn(l);
    } catch {
      /* see emit() */
    }
  });
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) stopWatching();
  };
}

function startWatching(): void {
  if (!netSubscription) {
    try {
      netSubscription = Network.addNetworkStateListener(() => {
        // The OS says something changed. It may well be lying about what — so
        // re-run the whole verdict rather than trusting the event's contents.
        void forceProbe();
      });
    } catch {
      netSubscription = null;
    }
  }
  if (!poller) {
    // A captive portal's session expiring produces no OS event whatsoever, so a
    // slow poll is the only way to notice we silently lost the network.
    poller = setInterval(() => {
      void forceProbe();
    }, Math.max(CONFIG.connectivityCacheMs, 15_000));
  }
}

function stopWatching(): void {
  netSubscription?.remove();
  netSubscription = null;
  if (poller) clearInterval(poller);
  poller = null;
}

/**
 * P-054: roaming. expo-cellular exposes no roaming flag, so we derive it — the
 * SIM's home MCC is recorded on first sight and compared against the MCC of the
 * network currently serving us.
 *
 * This matters because on a roaming SIM the SMS leg costs real money and, more
 * importantly, can be silently barred by the visited network. Knowing we are
 * roaming lets the dispatcher weight data legs higher and warn the user honestly
 * instead of assuming an SMS that never left.
 */
export async function isRoaming(): Promise<boolean> {
  try {
    const state = await Network.getNetworkStateAsync();
    if (state.type !== Network.NetworkStateType.CELLULAR) return false;

    const current = await Cellular.getMobileCountryCodeAsync();
    if (!current) return false;

    if (homeMccCache === null) {
      homeMccCache = await readHomeMcc();
    }
    if (!homeMccCache) {
      // First observation on this device becomes the baseline. Recording it while
      // the SIM is in its home network is the common case; if the app is first
      // installed abroad the baseline is wrong until the user comes home, which is
      // strictly better than reporting a roaming state we cannot substantiate.
      homeMccCache = current;
      await writeHomeMcc(current);
      return false;
    }
    return current !== homeMccCache;
  } catch {
    return false;
  }
}

async function readHomeMcc(): Promise<string | null> {
  try {
    return await t0ConfigRepo.get(T0_HOME_MCC_KEY);
  } catch {
    // The database may not be open yet on a cold T0 path. Roaming is an
    // optimisation hint, never a gate — degrade to "not roaming".
    return null;
  }
}

async function writeHomeMcc(mcc: string): Promise<void> {
  try {
    await t0ConfigRepo.set(T0_HOME_MCC_KEY, mcc);
  } catch {
    /* see readHomeMcc */
  }
}

/** Human-readable detail for the diagnostics screen (P-031). */
export interface ConnectivitySnapshot {
  level: DegradationLevel;
  osConnected: boolean;
  osInternetReachable: boolean;
  networkType: string;
  probeOk: boolean;
  roaming: boolean;
  checkedAt: number;
}

export async function connectivitySnapshot(): Promise<ConnectivitySnapshot> {
  let state: Network.NetworkState = {};
  try {
    state = await Network.getNetworkStateAsync();
  } catch {
    /* reported as disconnected below */
  }
  const probeOk = await probeHealthz(CONFIG.apiBase);
  return {
    level: await currentDegradation(),
    osConnected: state.isConnected === true,
    osInternetReachable: state.isInternetReachable === true,
    networkType: state.type ?? 'UNKNOWN',
    probeOk,
    roaming: await isRoaming(),
    checkedAt: Date.now(),
  };
}
