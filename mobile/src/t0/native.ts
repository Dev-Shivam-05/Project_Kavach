/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * T0 · NATIVE BRIDGE
 *
 * The Kotlin module `KavachT0` owns everything the JS runtime physically cannot
 * do: silent multi-SIM SMS (P-033), the torch, STREAM_ALARM volume, Device Owner
 * queries (ADR-015), the real permission/exemption state (P-031), and the
 * directBootAware foreground service (P-035).
 *
 * ★ IT IS OPTIONAL ON PURPOSE. ★
 * PRD §0.4 requires the whole T0 plane to be testable and demonstrable. In Expo
 * Go the module is absent, and every method here degrades to the best honest
 * approximation rather than throwing. A `throw` inside T0 is fatal (ADR-018:
 * fail OPEN on the safety path), so nothing in this file ever rejects.
 *
 * Where a fallback is materially worse than the native path we say so in
 * `lastSmsMode()` / `nativeStatus()` and the diagnostics screen reports it
 * (P-031). We never pretend a degraded capability is the real one.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';
import * as SMS from 'expo-sms';
import type { DiagnosticsReport } from '../core/types';
import type { HardwareKeyBackend, NativeKeyInfo } from '../crypto/hardware';

/**
 * The surface the Kotlin module is expected to expose. Everything past
 * `stopForegroundAgent` is optional: a partially-implemented native module is a
 * normal intermediate state during Phase 0 and must not break the JS side.
 */
export interface KavachT0Module {
  sendSmsDirect(numbers: string[], body: string): Promise<{ sent: string[]; failed: string[] }>;
  setTorch(on: boolean): Promise<void>;
  getAlarmVolume(): Promise<{ current: number; max: number }>;
  setAlarmVolume(level: number): Promise<void>;
  isDeviceOwner(): Promise<boolean>;
  checkPermissions(): Promise<Record<string, boolean>>;
  startForegroundAgent(options: ForegroundAgentOptions): Promise<void>;
  stopForegroundAgent(): Promise<void>;
  /** Proximity in cm. Android exposes no proximity sensor through expo-sensors (P-056). */
  getProximityCm?(): Promise<number>;
  /** BLE distress advertisement — degradation level PEER_ONLY (§4.4 L1). */
  bleAdvertise?(payloadBase64: string, ttlMs: number): Promise<boolean>;
  bleStopAdvertise?(): Promise<void>;
  /** Fires an OEM battery-settings intent from PRD Appendix B; false if unresolvable. */
  openOemSettings?(intent: string): Promise<boolean>;
  /** F-17 key vault. Absent on any APK built before KeyVault.kt landed. */
  keyVaultEnsure?(alias: string): Promise<unknown>;
  keyVaultInfo?(alias: string): Promise<unknown>;
  keyVaultSign?(alias: string, payloadBase64: string): Promise<string>;
  keyVaultPublicKey?(alias: string): Promise<string>;
}

export interface ForegroundAgentOptions {
  /** Shown in the persistent notification. Honest, never alarming (P-066). */
  title: string;
  body: string;
  /** Raises sensor sampling and pre-warms transports while an incident is live. */
  incidentActive: boolean;
}

export type SmsMode = 'native_multi_sim' | 'composer_needs_tap' | 'unavailable' | 'none';

let native: KavachT0Module | null = null;
try {
  // requireOptionalNativeModule returns null in Expo Go rather than throwing,
  // but a broken installation can still throw from the proxy — belt and braces.
  native = requireOptionalNativeModule<KavachT0Module>('KavachT0');
} catch {
  native = null;
}

export function isNativeAvailable(): boolean {
  return native !== null;
}

/** Escape hatch for modules that need an optional method (BLE, proximity). */
export function nativeModule(): KavachT0Module | null {
  return native;
}

// ── SMS ───────────────────────────────────────────────────────────────────────

let lastMode: SmsMode = 'none';

export function lastSmsMode(): SmsMode {
  return lastMode;
}

/**
 * Send the ≤160-char ASCII payload to every recipient.
 *
 * Native: SmsManager on EVERY active SIM simultaneously, no user interaction,
 * screen locked, app force-stopped. That is the transport that actually works
 * at 2 a.m. (P-033).
 *
 * ★ Fallback honesty: expo-sms `sendSMSAsync` opens the system composer and
 * REQUIRES A USER TAP. An unconscious person cannot tap. In Expo Go this leg is
 * therefore a demonstration of the payload, not a working emergency transport —
 * which is exactly why the diagnostics screen reports `nativeT0Present: false`
 * as a failing check (P-031) instead of quietly counting the SMS as sent.
 */
export async function sendSmsDirect(
  numbers: string[],
  body: string,
): Promise<{ sent: string[]; failed: string[] }> {
  const targets = numbers.filter((n) => typeof n === 'string' && n.trim().length > 0);
  if (targets.length === 0) {
    lastMode = 'none';
    return { sent: [], failed: [] };
  }

  if (native) {
    try {
      const r = await native.sendSmsDirect(targets, body);
      lastMode = 'native_multi_sim';
      return { sent: r?.sent ?? [], failed: r?.failed ?? targets };
    } catch {
      lastMode = 'native_multi_sim';
      return { sent: [], failed: targets };
    }
  }

  try {
    const available = await SMS.isAvailableAsync();
    if (!available) {
      lastMode = 'unavailable';
      return { sent: [], failed: targets };
    }
    const res = await SMS.sendSMSAsync(targets, body);
    lastMode = 'composer_needs_tap';
    // Android never reports delivery through this API, so 'unknown' is the
    // common case; treating it as failed would suppress a message that did go.
    const delivered = res.result === 'sent' || res.result === 'unknown';
    return delivered ? { sent: targets, failed: [] } : { sent: [], failed: targets };
  } catch {
    lastMode = 'unavailable';
    return { sent: [], failed: targets };
  }
}

// ── Torch ─────────────────────────────────────────────────────────────────────

type TorchListener = (on: boolean) => void;
const torchListeners = new Set<TorchListener>();
let torchWanted = false;

/**
 * expo-camera exposes the torch ONLY as the `enableTorch` prop of a mounted
 * `CameraView` — there is no imperative API. So without the native module we
 * publish the desired torch state and let a hidden CameraView in the panic
 * screen mirror it. With nothing subscribed this is a genuine no-op, and
 * `torchBacking()` reports which of the three states we are in.
 */
export function subscribeTorch(fn: TorchListener): () => void {
  torchListeners.add(fn);
  fn(torchWanted);
  return () => {
    torchListeners.delete(fn);
  };
}

export function torchWantedState(): boolean {
  return torchWanted;
}

export function torchBacking(): 'native' | 'camera_view' | 'none' {
  if (native) return 'native';
  return torchListeners.size > 0 ? 'camera_view' : 'none';
}

export async function setTorch(on: boolean): Promise<void> {
  torchWanted = on;
  for (const fn of torchListeners) {
    try {
      fn(on);
    } catch {
      // A crashing UI subscriber must never take down the strobe loop.
    }
  }
  if (!native) return;
  try {
    await native.setTorch(on);
  } catch {
    // Torch is a comfort signal, not a transport. Losing it changes nothing.
  }
}

// ── Alarm volume ──────────────────────────────────────────────────────────────

/**
 * Raise STREAM_ALARM to maximum and return a restore function.
 *
 * P-021 courtesy: we borrowed the user's alarm volume to be heard from another
 * room; we give it back when the incident ends. Leaving a phone permanently at
 * 100% alarm volume is exactly the kind of rudeness that gets a safety app
 * uninstalled (P-006 by another route).
 */
export async function maxAlarmVolume(): Promise<() => Promise<void>> {
  if (!native) return async () => {};
  try {
    const { current, max } = await native.getAlarmVolume();
    await native.setAlarmVolume(max);
    let restored = false;
    return async () => {
      if (restored) return;
      restored = true;
      try {
        await native.setAlarmVolume(current);
      } catch {
        // Nothing to do; the user can turn it down themselves.
      }
    };
  } catch {
    return async () => {};
  }
}

// ── Device Owner ──────────────────────────────────────────────────────────────

/** ADR-015. True means OEM battery managers, force-stop and uninstall are off the table. */
export async function isDeviceOwner(): Promise<boolean> {
  if (!native) return false;
  try {
    return (await native.isDeviceOwner()) === true;
  } catch {
    return false;
  }
}

// ── Permission / exemption state ──────────────────────────────────────────────

const DIAGNOSTIC_BOOL_KEYS = [
  'batteryOptimisationExempt',
  'notBackgroundRestricted',
  'exactAlarmsPermitted',
  'notificationsEnabled',
  'dndBypassGranted',
  'bgLocationGranted',
  'autoRevokeDisabled',
  't0SigningAvailablePredawn',
] as const;

/**
 * The only source of truth for the seven checks that have no JS API at all
 * (P-031). Returns a PARTIAL report: keys we could not determine are simply
 * absent, so `diagnostics.ts` can tell "false" apart from "unknown" and report
 * the latter honestly rather than optimistically.
 */
export async function checkPermissions(): Promise<Partial<DiagnosticsReport>> {
  const out: Partial<DiagnosticsReport> = { nativeT0Present: native !== null };
  if (!native) return out;
  try {
    const raw = await native.checkPermissions();
    if (!raw || typeof raw !== 'object') return out;
    for (const key of DIAGNOSTIC_BOOL_KEYS) {
      const v = raw[key];
      if (typeof v === 'boolean') out[key] = v;
    }
  } catch {
    // A native module that cannot answer is indistinguishable from no module,
    // and reporting "unknown" is the honest outcome (P-031).
  }
  return out;
}

// ── Foreground agent ──────────────────────────────────────────────────────────

let agentRunning = false;

export async function startForegroundAgent(options: ForegroundAgentOptions): Promise<void> {
  if (!native) {
    // Expo Go keeps the JS runtime alive only while the app is foregrounded.
    // Recording the intent lets diagnostics tell the user the truth (P-031).
    agentRunning = false;
    return;
  }
  try {
    await native.startForegroundAgent(options);
    agentRunning = true;
  } catch {
    agentRunning = false;
  }
}

export async function stopForegroundAgent(): Promise<void> {
  agentRunning = false;
  if (!native) return;
  try {
    await native.stopForegroundAgent();
  } catch {
    // Already gone, or never started.
  }
}

export function isForegroundAgentRunning(): boolean {
  return agentRunning;
}

// ── Optional capabilities ─────────────────────────────────────────────────────

/** Centimetres to the nearest object, or null when the platform will not say. */
export async function proximityCm(): Promise<number | null> {
  if (!native?.getProximityCm) return null;
  try {
    const v = await native.getProximityCm();
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** §4.4 L1. Returns false when BLE advertising is unavailable — never throws. */
export async function bleAdvertise(payloadBase64: string, ttlMs: number): Promise<boolean> {
  if (!native?.bleAdvertise) return false;
  try {
    return (await native.bleAdvertise(payloadBase64, ttlMs)) === true;
  } catch {
    return false;
  }
}

export async function bleStopAdvertise(): Promise<void> {
  if (!native?.bleStopAdvertise) return;
  try {
    await native.bleStopAdvertise();
  } catch {
    // Advertising expires on its own TTL anyway.
  }
}

/** PRD Appendix B intents are unexported on many builds — false means "show the guide". */
export async function openOemSettings(intent: string): Promise<boolean> {
  if (!native?.openOemSettings) return false;
  try {
    return (await native.openOemSettings(intent)) === true;
  } catch {
    return false;
  }
}

// ── Hardware key vault (F-17) ─────────────────────────────────────────────────

/**
 * Turn whatever the native module returned into a `NativeKeyInfo`, or into
 * null.
 *
 * ★ It never upgrades a claim. ★ `strongBox` requires the flag AND the security
 * level to agree, so a half-written or half-upgraded native module cannot
 * produce a StrongBox claim out of a missing field — which is the specific way
 * a hardware assurance turns into a lie (P-031).
 */
function normaliseKeyInfo(raw: unknown): NativeKeyInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const alias = typeof r.alias === 'string' ? r.alias : '';
  if (!alias) return null;
  const level = r.securityLevel;
  const secure = level === 'strongbox' || level === 'tee' || level === 'software';
  return {
    alias,
    present: r.present === true,
    strongBox: r.strongBox === true && level === 'strongbox',
    tee: r.tee === true && level === 'tee',
    userAuthRequired: r.userAuthRequired === true,
    unlockedDeviceRequired: r.unlockedDeviceRequired === true,
    unlockedDeviceRequiredMeasured: r.unlockedDeviceRequiredMeasured === true,
    securityLevel: secure ? level : 'unknown',
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
  };
}

/**
 * The KeyVault leg, shaped for `crypto/hardware.ts` to consume.
 *
 * Unlike the rest of this file it reports failure by returning null rather than
 * by silently degrading, because the caller has to be able to tell "no hardware
 * key" from "a hardware key that signed" — that difference is what the
 * diagnostics screen prints.
 *
 * Wire it up with `setHardwareKeyBackend(keyVault)`; the header of
 * `src/crypto/hardware.ts` names where.
 */
export const keyVault: HardwareKeyBackend = {
  async ensure(alias: string): Promise<NativeKeyInfo | null> {
    if (!native?.keyVaultEnsure) return null;
    try {
      return normaliseKeyInfo(await native.keyVaultEnsure(alias));
    } catch {
      return null;
    }
  },

  async info(alias: string): Promise<NativeKeyInfo | null> {
    if (!native?.keyVaultInfo) return null;
    try {
      return normaliseKeyInfo(await native.keyVaultInfo(alias));
    } catch {
      return null;
    }
  },

  async sign(alias: string, payloadBase64: string): Promise<string | null> {
    if (!native?.keyVaultSign) return null;
    try {
      const sig = await native.keyVaultSign(alias, payloadBase64);
      return typeof sig === 'string' && sig.length > 0 ? sig : null;
    } catch {
      return null;
    }
  },

  async publicKey(alias: string): Promise<string | null> {
    if (!native?.keyVaultPublicKey) return null;
    try {
      const pub = await native.keyVaultPublicKey(alias);
      return typeof pub === 'string' && pub.length > 0 ? pub : null;
    } catch {
      return null;
    }
  },
};

export interface NativeStatus {
  present: boolean;
  platform: typeof Platform.OS;
  smsMode: SmsMode;
  torch: 'native' | 'camera_view' | 'none';
  foregroundAgent: boolean;
  ble: boolean;
  proximity: boolean;
}

export function nativeStatus(): NativeStatus {
  return {
    present: native !== null,
    platform: Platform.OS,
    smsMode: lastMode,
    torch: torchBacking(),
    foregroundAgent: agentRunning,
    ble: typeof native?.bleAdvertise === 'function',
    proximity: typeof native?.getProximityCm === 'function',
  };
}
