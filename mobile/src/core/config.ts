/**
 * Runtime configuration.
 *
 * F-05: the client pins TWO ingest endpoints and fires BOTH in parallel during
 * an incident. The whole architecture survives failure of the control plane,
 * Postgres, NATS, the region and the provider — but not of the CDN in front of
 * it. One duplicate request per incident costs nothing; the server deduplicates
 * on incident_id (P-053).
 */
import Constants from 'expo-constants';

type Extra = {
  apiBase?: string;
  apiDirect?: string;
  wsBase?: string;
  familyId?: string;
  /** ★ Spec D1 (6-D-7b) — STUN URLs; the TURN relay is the three fields below. */
  iceServers?: string[];
  turnUrl?: string;
  turnUsername?: string;
  turnCredential?: string;
};

const extra = (Constants.expoConfig?.extra ?? {}) as Extra;

/**
 * ★ THE RELEASE SWITCH ★
 *
 * `app.json` is static, so its `extra` block is the SAME in every profile — which
 * means the preview APK ships whatever the emulator needs. `EXPO_PUBLIC_*` is
 * inlined by babel-preset-expo at bundle time, so an EAS build profile can point
 * a real build at the real ingest and switch demo mode off without editing
 * app.json and without a second config file. Env wins; app.json is the default.
 *
 * ★ THIS IS NOT DONE UNTIL eas.json SETS THEM. ★ Until a build profile provides
 * `EXPO_PUBLIC_KAVACH_DEMO=false` plus real host names, a release build still
 * runs in demo mode against 10.0.2.2 — i.e. an SOS that resolves locally and
 * never leaves the device, which is the exact failure this product exists to
 * prevent. The mechanism is here; the values are a deployment decision.
 */
const env = (name: string): string | undefined => {
  const v = process.env[name];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
};

const apiBase = env('EXPO_PUBLIC_KAVACH_API') ?? extra.apiBase ?? 'http://10.0.2.2:8081';

export const CONFIG = {
  /** Primary ingest, behind the CDN. */
  apiBase,
  /** ★ Cloudflare bypass. Straight to origin, own TLS chain, own pin (F-05). */
  apiDirect: env('EXPO_PUBLIC_KAVACH_API_DIRECT') ?? extra.apiDirect ?? 'http://10.0.2.2:8081',
  /** Control plane + realtime. */
  controlBase: env('EXPO_PUBLIC_KAVACH_CONTROL') ?? extra.apiBase ?? 'http://10.0.2.2:8080',
  wsBase: env('EXPO_PUBLIC_KAVACH_WS') ?? extra.wsBase ?? 'ws://10.0.2.2:8082',

  /**
   * ★ Spec D1 (6-D-7b) — ICE for Family Watch.
   *
   * STUN alone gets two phones connected on most home and mobile networks. It
   * does NOT get them connected across carrier-grade NAT, which is exactly the
   * across-city case D1 names (Kabilpore→Surat) — that needs a TURN relay, and
   * a TURN relay is infrastructure somebody has to run and pay for. So the
   * fields exist, default to empty, and `iceServers()` simply omits the relay
   * when they are unset: a session that cannot traverse then fails to connect
   * honestly rather than appearing to work everywhere it was tested.
   */
  iceServers: (extra.iceServers ?? []).filter((u) => typeof u === 'string' && u.length > 0),
  turnUrl: env('EXPO_PUBLIC_KAVACH_TURN_URL') ?? extra.turnUrl ?? '',
  turnUsername: env('EXPO_PUBLIC_KAVACH_TURN_USER') ?? extra.turnUsername ?? '',
  turnCredential: env('EXPO_PUBLIC_KAVACH_TURN_PASS') ?? extra.turnCredential ?? '',

  /** Timing budgets from the PRD, enforced in code. */
  t2BudgetMs: 500,
  ackWaitBeforeSmsMs: 15_000,
  heartbeatIntervalMs: 15 * 60_000,
  watchdogIntervalMs: 15 * 60_000,
  diagnosticsIntervalMs: 7 * 24 * 60 * 60_000,
  presenceTtlMs: 45_000,
  connectivityProbeTimeoutMs: 1000,
  connectivityCacheMs: 30_000,

  /** Power budget (PRD §6.2.6): 4% of a 4500 mAh battery = 180 mAh/day. */
  idleLocationIntervalMs: 15 * 60_000,
  watchLocationIntervalMs: 5_000,
  incidentLocationIntervalMs: 3_000,
  sensorBatchLatencyUs: 30_000_000,

  /** Black box: 60 s rolling window at 50 Hz (PRD FR-007). */
  blackBoxWindowMs: 60_000,
  blackBoxHz: 50,

  /** F-02: auto-quiesce a forgotten incident. */
  autoQuiesceMs: 6 * 60 * 60_000,

  /** Agent-silent threshold that becomes a family-visible alert (FR-034). */
  agentSilentAlertMs: 6 * 60 * 60_000,

  emergencyNumber: '112',
  appName: 'Kavach',
} as const;

export const STORAGE_KEYS = {
  deviceKeypair: 'kavach.device.keypair',
  groupSecret: 'kavach.family.groupSecret',
  duressPin: 'kavach.duress.pin',
  cancelPin: 'kavach.cancel.pin',
  session: 'kavach.session',
  onboarded: 'kavach.onboarded',
} as const;
