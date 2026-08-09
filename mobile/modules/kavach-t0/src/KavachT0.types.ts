/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * KavachT0 · NATIVE TYPE SURFACE
 *
 * These types are the contract that `mobile/src/t0/native.ts` consumes through
 * `requireOptionalNativeModule('KavachT0')`. Every member below is either
 * structurally identical to the interface declared there, or a strict superset
 * (extra diagnostic fields the JS bridge is free to ignore).
 *
 * ★ ANDROID ONLY ON PURPOSE. ★
 * ADR-015 puts the whole T0 plane on Android because iOS forbids all four of the
 * capabilities T0 depends on: SMS without a user tap, a service that survives the
 * app being killed, Direct Boot, and Device Owner. Shipping an iOS stub would let
 * the diagnostics screen (P-031) report a capability that cannot exist, which is
 * exactly the dishonesty T0 is built to avoid.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

/**
 * Per-SIM outcome of one dispatch.
 * `pending` is NOT a synonym for failure: the radio accepted the SMS-SUBMIT and
 * the network simply had not acked it before our wait window closed. Reporting
 * it as `error` would make the diagnostics screen lie in the common rural case.
 */
export type SimSendStatus = 'ok' | 'error' | 'pending' | 'skipped';

export interface SimAttempt {
  /** `SubscriptionManager` id, or -1 when the device exposed no subscription. */
  subscriptionId: number;
  /** Physical SIM slot, -1 when unknown. */
  slotIndex: number;
  /** Carrier display name; empty when READ_PHONE_STATE was refused. */
  carrier: string;
  /** The recipient this attempt targeted. */
  recipient: string;
  status: SimSendStatus;
  /** Human-readable reason — surfaced verbatim in the diagnostics screen. */
  detail: string;
}

/**
 * P-033. `sent` / `failed` are the two keys `native.ts` reads; everything else is
 * evidence for the diagnostics screen and the incident event log.
 */
export interface SmsDispatchResult {
  sent: string[];
  failed: string[];
  perSim: SimAttempt[];
  /** The attempt order actually used: user preferred → system default → others. */
  attemptOrder: number[];
  /** True when the ≤160-char body still had to be split into concatenated parts. */
  multipart: boolean;
}

/**
 * Options for the Direct-Boot-aware foreground agent.
 *
 * `title` / `body` / `incidentActive` are what `native.ts` sends today. Every
 * other field is optional provisioning data for P-035: the T0 process runs in
 * its own OS process and, after LOCKED_BOOT_COMPLETED, cannot read anything the
 * JS layer stored in credential-protected storage. Whatever is passed here is
 * copied into device-protected storage so the agent can act before first unlock.
 */
export interface ForegroundAgentOptions {
  /** Persistent-notification title. Honest, never alarming (P-066). */
  title: string;
  body: string;
  /** Raises sampling, pins a wake lock and keeps a location fix warm. */
  incidentActive: boolean;
  /** F-09 base36 incident prefix, for the Final Breath packet (P-022). */
  incidentId8?: string;
  /** E.164 numbers reachable before first unlock. */
  emergencyNumbers?: string[];
  /** Opaque policy snapshot; native never parses it, it only re-emits it. */
  policySnapshotJson?: string;
  /** AndroidKeyStore alias of the T0 signing key (F-17). */
  signingKeyAlias?: string;
  /** BLE peer identity fingerprints for degradation level PEER_ONLY. */
  peerFingerprints?: string[];
  /** SIM the guardian chose as the preferred emergency sender (P-033). */
  preferredSubscriptionId?: number;
  /** SHA-256 (hex) of the guardian secret that authorises Device Owner release. */
  guardianReleaseTokenSha256?: string;
  /** Accounts allowed to pass Factory Reset Protection (PRD §5.3 wave 1). */
  guardianFrpAccounts?: string[];
  lastKnownLat?: number;
  lastKnownLon?: number;
  lastKnownAccuracyM?: number;
  lastKnownAt?: number;
}

export interface AlarmVolume {
  current: number;
  max: number;
}

/** The seven device checks of P-031 that have no JS API at all, plus F-17. */
export type PermissionKey =
  | 'batteryOptimisationExempt'
  | 'notBackgroundRestricted'
  | 'exactAlarmsPermitted'
  | 'notificationsEnabled'
  | 'dndBypassGranted'
  | 'bgLocationGranted'
  | 'autoRevokeDisabled'
  | 't0SigningAvailablePredawn';

/**
 * Partial by construction. A key the platform will not answer for is OMITTED,
 * never defaulted to `false` — `native.ts` distinguishes "denied" from "unknown"
 * and the diagnostics screen reports the difference (P-031).
 */
export type PermissionReport = Partial<Record<PermissionKey, boolean>>;

/** PRD §5.3 rolls the Device Owner lockdown out in two waves, never one. */
export type DeviceOwnerWave = 1 | 2;

export interface DeviceOwnerPolicyResult {
  wave: DeviceOwnerWave;
  /** Restrictions/policies that took effect on this call. */
  applied: string[];
  /** Deliberately not attempted, with the reason (e.g. wave 2 gate not open). */
  skipped: string[];
  /** Attempted and rejected by the platform. */
  failed: string[];
  /** False when the app is not Device Owner — everything above will be empty. */
  isDeviceOwner: boolean;
}

/**
 * The two aliases `KeyVault.kt` will answer to. It rejects every other string,
 * so the module cannot be pointed at a key of the caller's choosing.
 */
export type KeyVaultAlias = 'kavach_emergency_sign_v1' | 'kavach_identity_sign_v1';

/** How the platform is holding the private half. `unknown` means unreadable. */
export type KeyVaultSecurityLevel = 'strongbox' | 'tee' | 'software' | 'unknown';

/**
 * What the keystore gave us, read back off the key rather than repeated from
 * the generation request.
 *
 * `unlockedDeviceRequiredMeasured` is the one honesty flag that has to be here:
 * KeyInfo exposes no getter for that property on every supported API level, so
 * when it is false the value beside it is what we ASKED for, not what we read.
 */
export interface KeyVaultInfo {
  alias: string;
  present: boolean;
  strongBox: boolean;
  tee: boolean;
  /** ★ F-17: false on the emergency alias, always. */
  userAuthRequired: boolean;
  /** ★ P-035: false on the emergency alias, or Direct Boot signing is dead. */
  unlockedDeviceRequired: boolean;
  unlockedDeviceRequiredMeasured: boolean;
  securityLevel: KeyVaultSecurityLevel;
  /** Epoch ms of generation, 0 when the record predates this field. */
  createdAt: number;
}

/**
 * The full Kotlin surface. `native.ts` declares a narrower interface and only
 * ever calls the members it declares; the extras exist so the provisioning and
 * Device-Owner-release flows have a real, callable path rather than a TODO.
 */
export interface KavachT0NativeModule {
  sendSmsDirect(numbers: string[], body: string): Promise<SmsDispatchResult>;
  setTorch(on: boolean): Promise<void>;
  getAlarmVolume(): Promise<AlarmVolume>;
  setAlarmVolume(level: number): Promise<void>;
  isDeviceOwner(): Promise<boolean>;
  checkPermissions(): Promise<PermissionReport>;
  startForegroundAgent(options: ForegroundAgentOptions): Promise<void>;
  stopForegroundAgent(): Promise<void>;
  getProximityCm(): Promise<number>;
  bleAdvertise(payloadBase64: string, ttlMs: number): Promise<boolean>;
  bleStopAdvertise(): Promise<void>;
  openOemSettings(intent: string): Promise<boolean>;
  applyDeviceOwnerPolicy(wave: DeviceOwnerWave): Promise<DeviceOwnerPolicyResult>;
  /**
   * ★ Ships BEFORE either lockdown wave (PRD §5.3). A fleet that can be locked
   * down but not released is a fleet of bricks the moment the DPC has a bug.
   */
  releaseDeviceOwner(guardianToken: string): Promise<boolean>;
  /**
   * ★ F-17. Creates the key on first call and never regenerates an existing
   * alias — rotating the emergency key would invalidate the public key the
   * server holds for this device, and the first sign of it would be a rejected
   * SOS.
   */
  keyVaultEnsure(alias: KeyVaultAlias): Promise<KeyVaultInfo>;
  keyVaultInfo(alias: KeyVaultAlias): Promise<KeyVaultInfo>;
  /** Base64 payload in, base64 DER ECDSA-P256 signature out. */
  keyVaultSign(alias: KeyVaultAlias, payloadBase64: string): Promise<string>;
  /**
   * Base64 X.509 SubjectPublicKeyInfo. The only key material that ever crosses
   * the bridge — there is no counterpart returning the private half, by design.
   */
  keyVaultPublicKey(alias: KeyVaultAlias): Promise<string>;
}
