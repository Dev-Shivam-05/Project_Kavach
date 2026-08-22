/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * NODE STORE — spare-phone camera nodes (PRD P-024 / FR-046)
 *
 * A separate zustand slice from `store.ts` on purpose. The main store is the T0
 * safety plane; a Phase 2 monitoring feature must not be able to wedge it, and
 * nothing in here is on the emergency path. The seam is the same one ADR-018
 * draws between the store and T0: this module reads the main store when it needs
 * family presence, and never writes to it.
 *
 * ★★★ WHAT IS PERSISTED, AND WHY IT IS SEALED ★★★
 * The snapshot bytes are Class-A of the highest sensitivity (§10.2) and are
 * sealed with `sealJson` before they touch the disk — but so is the index. A
 * plaintext list of "motion at 02:14, motion at 02:51, nothing for six days"
 * IS the occupancy pattern of a home; it tells a thief when the house is empty
 * just as reliably as the pictures do. Both get the same treatment.
 *
 * ★★★ NO KEY, NO CAMERA ★★★
 * If the family group secret cannot be read, sealing is impossible, and a node
 * that cannot seal is a node that would have to write plaintext frames of a
 * living room to disk. It refuses to arm instead. Failing closed on privacy is
 * the opposite of the T0 rule (fail OPEN on the safety path) and that asymmetry
 * is deliberate: a missed alarm risks one life, a leaked home camera archive
 * harms every person who lives there.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { create, type StoreApi } from 'zustand';
import { Directory, File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import * as Battery from 'expo-battery';

import { CONFIG, STORAGE_KEYS } from '../core/config';
import type { UUID } from '../core/types';
import { base64ToBytes, bytesToBase64, uuidv7 } from '../core/ids';
import { deriveKey, openJson, sealJson } from '../crypto';
import { nativeModule } from '../t0/native';
import { notifyDegraded } from './notifications';
import {
  GREY_H,
  GREY_W,
  type ThermalSample,
  type ThermalTier,
  snapshotFileName,
  snapshotsToDelete,
} from '../domain/cctv';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export type NodeRuntime =
  | 'off'
  /** Armed, but not yet capturing — the installer is walking out (P-024). */
  | 'exit-delay'
  | 'live'
  /** ★ Auto-disabled because somebody is home. The headline privacy rule. */
  | 'paused-family-home'
  /** ★ P-032 — the battery is too hot to keep the camera running. */
  | 'suspended-thermal'
  /** ★ A family member pulled the kill switch. Only the node's phone can undo it. */
  | 'disabled-by-family'
  /** No home geofence exists, so auto-disable cannot be evaluated. Hard block. */
  | 'no-home-fence'
  /** No group secret, so snapshots cannot be sealed. Hard block. */
  | 'no-seal-key';

export interface NodeDisabler {
  memberId: UUID;
  name: string;
  at: number;
}

export interface NodeStatus {
  id: string;
  /** Where it points. Vetted against IT Act s.66E at setup (`checkPlacement`). */
  placement: string;
  ownerName: string;
  ownerMemberId: UUID | null;
  /** True for the node running on THIS phone. */
  isSelf: boolean;
  runtime: NodeRuntime;
  lastHeardAt: number;
  armedAt: number | null;
  lastMotionAt: number | null;
  lastMotionBlocks: number;
  motionEvents24h: number;
  framesAnalysed: number;
  thermalTier: ThermalTier;
  temperatureC: number | null;
  batteryPct: number | null;
  charging: boolean;
  snapshotCount: number;
  maintenance: string | null;
  disabledBy: NodeDisabler | null;
  /** Set by the viewer for a node that is not this phone; honoured on check-in. */
  purgeRequestedAt: number | null;
}

export interface MotionEvent {
  id: string;
  nodeId: string;
  at: number;
  hotBlocks: number;
  peakMad: number;
  /** Sealed snapshot filename, or null when the seal or the write failed. */
  snapshot: string | null;
}

interface Persisted {
  v: 1;
  consentAcceptedAt: number | null;
  placement: string;
  selfNodeId: string;
  nodes: NodeStatus[];
  events: MotionEvent[];
}

export interface NodeState {
  ready: boolean;
  /** Null until the setup flow has been read and accepted on this phone. */
  consentAcceptedAt: number | null;
  placement: string;
  selfNodeId: string;
  nodes: NodeStatus[];
  events: MotionEvent[];
  /** Non-null when sealing is impossible — the node must not arm. */
  sealBlocked: string | null;

  hydrate(): Promise<void>;
  acceptPlacement(text: string, ownerName: string, ownerMemberId: UUID | null): Promise<void>;
  revokeSetup(): Promise<void>;
  publishSelf(patch: Partial<NodeStatus>): void;
  setSelfRuntime(runtime: NodeRuntime, maintenance?: string | null): Promise<void>;
  recordMotion(at: number, hotBlocks: number, peakMad: number, frame: Uint8Array): Promise<void>;
  /** ★ The kill switch. Any member, no role check, takes effect immediately. */
  disableNode(nodeId: string, by: NodeDisabler): Promise<void>;
  /** Undoing a kill is deliberately LOCAL-ONLY — see the action for why. */
  resumeSelf(): Promise<void>;
  purgeSnapshots(nodeId: string): Promise<number>;
  pruneRetention(): Promise<number>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Storage
// ═══════════════════════════════════════════════════════════════════════════════

const ROOT_DIR = 'kavach-nodes';
const SNAP_DIR = 'snapshots';
const INDEX_FILE = 'index.sealed';

/** Module scope, never React state — same rule the main store follows for keys. */
let groupSecret: Uint8Array | null = null;
let lastNotifiedMaintenance: string | null = null;
/**
 * Both screens call `hydrate()` on mount and the viewer can be pushed on top of
 * the node screen. Without this, two overlapping hydrations both pass the
 * `ready` check, both mint a `selfNodeId`, and the second overwrites the first —
 * which orphans every snapshot already written under the first id.
 */
let hydratePromise: Promise<void> | null = null;

function rootDir(): Directory | null {
  try {
    const dir = new Directory(Paths.document, ROOT_DIR);
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    return dir;
  } catch {
    return null;
  }
}

function snapDir(): Directory | null {
  const root = rootDir();
  if (root === null) return null;
  try {
    const dir = new Directory(root, SNAP_DIR);
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    return dir;
  } catch {
    return null;
  }
}

async function loadGroupSecret(): Promise<Uint8Array | null> {
  if (groupSecret !== null) return groupSecret;
  try {
    const raw = await SecureStore.getItemAsync(STORAGE_KEYS.groupSecret);
    if (raw === null) return null;
    const bytes = base64ToBytes(raw);
    if (bytes.length !== 32) return null;
    groupSecret = bytes;
    return groupSecret;
  } catch {
    return null;
  }
}

/**
 * A key per node, derived from the family group secret. Compromise of one node's
 * archive does not open another's, and the label keeps this scope disjoint from
 * the incident and location scopes in crypto/index.ts.
 */
function nodeKey(secret: Uint8Array, nodeId: string): Uint8Array {
  return deriveKey(secret, 'node', nodeId);
}

function listSnapshotNames(): string[] {
  const dir = snapDir();
  if (dir === null) return [];
  try {
    return dir
      .list()
      .filter((e): e is File => e instanceof File)
      .map((f) => f.name);
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Thermal sampling (the impure half of P-032 — the policy itself is pure)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Optional native capability. `KavachT0` is the only route to Android's
 * ACTION_BATTERY_CHANGED EXTRA_TEMPERATURE — Expo surfaces no thermal API at
 * all in SDK 57. Declared here rather than in t0/native.ts because it belongs to
 * this Phase 2 feature; the escape hatch `nativeModule()` exists exactly so a
 * feature can probe for a method without widening the T0 bridge.
 */
interface ThermalCapableModule {
  getBatteryTempC?: () => Promise<number>;
}

export async function readThermalSample(): Promise<ThermalSample> {
  const at = Date.now();
  let celsius: number | null = null;

  const mod = nativeModule() as unknown as ThermalCapableModule | null;
  if (mod !== null && typeof mod.getBatteryTempC === 'function') {
    try {
      const v = await mod.getBatteryTempC();
      // A sensor that reports -273 or 900 is a broken sensor, not a cold phone.
      if (Number.isFinite(v) && v > -30 && v < 120) celsius = v;
    } catch {
      celsius = null;
    }
  }

  let batteryPct: number | null = null;
  let charging = false;
  try {
    const power = await Battery.getPowerStateAsync();
    if (Number.isFinite(power.batteryLevel) && power.batteryLevel >= 0) {
      batteryPct = Math.round(power.batteryLevel * 100);
    }
    charging =
      power.batteryState === Battery.BatteryState.CHARGING ||
      power.batteryState === Battery.BatteryState.FULL;
  } catch {
    /* an emulator with no battery service still runs the node */
  }

  return { celsius, batteryPct, charging, at };
}

/**
 * Fail-soft maintenance alert (P-032). Never the same message twice running, and
 * never at all for a node that is not running — a phone sitting idle in a drawer
 * must not push "battery temperature unreadable" at anybody. The text is still
 * shown on both screens; only the notification is gated.
 */
const ALERTING_RUNTIMES: ReadonlySet<NodeRuntime> = new Set<NodeRuntime>([
  'live',
  'exit-delay',
  'suspended-thermal',
]);

/** Runtimes in which the node is not watching at all, so nothing is "armed". */
const STOPPED_RUNTIMES: ReadonlySet<NodeRuntime> = new Set<NodeRuntime>([
  'off',
  'disabled-by-family',
  'no-home-fence',
  'no-seal-key',
]);

async function raiseMaintenance(runtime: NodeRuntime, message: string | null): Promise<void> {
  if (message === null || !ALERTING_RUNTIMES.has(runtime)) {
    lastNotifiedMaintenance = null;
    return;
  }
  if (message === lastNotifiedMaintenance) return;
  lastNotifiedMaintenance = message;
  try {
    await notifyDegraded(`${CONFIG.appName} camera node: ${message}`);
  } catch {
    /* notifications are a courtesy here; the screens show the same text */
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Seeds
// ═══════════════════════════════════════════════════════════════════════════════

function blankSelf(id: string, placement: string, ownerName: string, ownerMemberId: UUID | null): NodeStatus {
  return {
    id,
    placement,
    ownerName,
    ownerMemberId,
    isSelf: true,
    runtime: 'off',
    lastHeardAt: Date.now(),
    armedAt: null,
    lastMotionAt: null,
    lastMotionBlocks: 0,
    motionEvents24h: 0,
    framesAnalysed: 0,
    thermalTier: 'unknown',
    temperatureC: null,
    batteryPct: null,
    charging: false,
    snapshotCount: 0,
    maintenance: null,
    disabledBy: null,
    purgeRequestedAt: null,
  };
}


// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ★ `ready` FLIPS ON EVERY PATH, INCLUDING THE BROKEN ONES ★
 *
 * `pruneRetention()` was awaited outside any try/catch and the `set()` above it
 * can throw if a subscriber throws. Either one left `hydratePromise` rejected,
 * `ready` false forever, and `app/camera-node.tsx` sitting on
 * "Loading camera settings…" with no way out but the back gesture — plus an
 * unhandled rejection nobody sees. The same discipline `doBootstrap`'s finally
 * uses: whatever happens, the screen gets a state it can render and a sentence
 * saying what went wrong.
 */
async function doHydrate(
  set: StoreApi<NodeState>['setState'],
  get: StoreApi<NodeState>['getState'],
): Promise<void> {
  let sealBlocked: string | null = null;
  try {
    const secret = await loadGroupSecret();
    sealBlocked =
      secret === null
        ? 'This device has no family group key yet, so camera snapshots could not be encrypted. Finish setting up Kavach first — a node that cannot seal what it captures will not run.'
        : null;

    let loaded: Persisted | null = null;
    if (secret !== null) {
      try {
        const root = rootDir();
        if (root !== null) {
          const file = new File(root, INDEX_FILE);
          if (file.exists) {
            loaded = openJson<Persisted>(nodeKey(secret, 'index'), await file.text(), 'index');
          }
        }
      } catch {
        loaded = null;
      }
    }

    const now = Date.now();
    const nodes = loaded?.nodes ?? [];
    const merged = nodes;

    // The snapshot FILES are the source of truth for the count — the index can be
    // stale if a purge or an OS cache sweep happened while the app was closed.
    const snapshotCount = listSnapshotNames().length;

    set({
      consentAcceptedAt: loaded?.consentAcceptedAt ?? null,
      placement: loaded?.placement ?? '',
      selfNodeId: loaded?.selfNodeId ?? uuidv7(now),
      nodes: merged.map((n) => (n.isSelf ? { ...n, snapshotCount, runtime: coldStart(n) } : n)),
      events: loaded?.events ?? [],
    });

    // Retention is a 7-day sweep, not a startup dependency. Off the awaited path
    // so a slow or failing directory listing cannot hold the screen.
    lastPruneAt = Date.now();
    void get()
      .pruneRetention()
      .catch(() => {});
  } catch (e) {
    sealBlocked =
      sealBlocked ??
      `This phone could not read its camera settings (${e instanceof Error ? e.message : 'unknown error'}). The camera will not run until that is fixed.`;
  } finally {
    set({ ready: true, sealBlocked });
  }
}

export const useNodes = create<NodeState>()((set, get) => ({
  ready: false,
  consentAcceptedAt: null,
  placement: '',
  selfNodeId: '',
  nodes: [],
  events: [],
  sealBlocked: null,

  async hydrate(): Promise<void> {
    if (get().ready) return;
    if (hydratePromise !== null) return hydratePromise;
    // doHydrate cannot reject, but `void hydrate()` at both call sites means a
    // future one that could would become an unhandled rejection. Belt and braces.
    hydratePromise = doHydrate(set, get)
      .catch(() => {})
      .finally(() => {
        hydratePromise = null;
      });
    return hydratePromise;
  },

  async acceptPlacement(text, ownerName, ownerMemberId): Promise<void> {
    const placement = text.trim();
    const id = get().selfNodeId === '' ? uuidv7() : get().selfNodeId;
    const existing = get().nodes.find((n) => n.isSelf);
    const self: NodeStatus = existing
      ? { ...existing, placement, ownerName, ownerMemberId }
      : blankSelf(id, placement, ownerName, ownerMemberId);
    set((s) => ({
      consentAcceptedAt: Date.now(),
      placement,
      selfNodeId: id,
      nodes: [self, ...s.nodes.filter((n) => !n.isSelf)],
    }));
    await persist(get());
  },

  /**
   * Tear the whole thing down: consent withdrawn, snapshots destroyed, node
   * removed. Withdrawing consent that leaves the archive behind is not
   * withdrawing consent.
   */
  async revokeSetup(): Promise<void> {
    await get().purgeSnapshots(get().selfNodeId);
    set((s) => ({
      consentAcceptedAt: null,
      placement: '',
      nodes: s.nodes.filter((n) => !n.isSelf),
      events: s.events.filter((e) => e.nodeId !== s.selfNodeId),
    }));
    await persist(get());
  },

  /**
   * In-memory only. Called several times a second by the capture loop with frame
   * counters and temperatures; writing the sealed index on every frame would be
   * an encrypt-and-fsync at 3 Hz on a phone whose temperature is the thing we
   * are trying to keep down (P-032).
   */
  publishSelf(patch): void {
    set((s) => ({
      nodes: s.nodes.map((n) => (n.isSelf ? { ...n, ...patch, lastHeardAt: Date.now() } : n)),
    }));
  },

  async setSelfRuntime(runtime, maintenance = null): Promise<void> {
    const before = get().nodes.find((n) => n.isSelf);
    if (before === undefined) return;
    if (before.runtime === runtime && before.maintenance === maintenance) return;

    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.isSelf
          ? {
              ...n,
              runtime,
              maintenance,
              lastHeardAt: Date.now(),
              // Armed spans the whole watch including the pauses inside it, so a
              // thermal suspension or a family arrival does not restart the
              // clock — but stopping the node genuinely does end it.
              armedAt: STOPPED_RUNTIMES.has(runtime) ? null : (n.armedAt ?? Date.now()),
            }
          : n,
      ),
    }));
    await raiseMaintenance(runtime, maintenance);
    await persist(get());
  },

  async recordMotion(at, hotBlocks, peakMad, frame): Promise<void> {
    const s = get();
    const secret = await loadGroupSecret();
    let snapshot: string | null = null;

    if (secret !== null) {
      try {
        const dir = snapDir();
        if (dir !== null) {
          const name = snapshotFileName(at, s.selfNodeId.replace(/-/g, ''));
          /**
           * ★ WHAT IS AND IS NOT STORED ★
           * The 160×120 greyscale working frame, and nothing else. The
           * full-resolution colour capture is discarded the instant it has been
           * analysed — it was never even fully decoded (only the JPEG DC plane
           * was). Seven days of recognisable interior photographs on a phone
           * behind a bookshelf is a far larger breach when that phone is stolen
           * than seven days of thumbnails that show a person crossed the room,
           * and §10.2 requires the smallest sufficient record.
           */
          const sealed = sealJson(
            nodeKey(secret, s.selfNodeId),
            {
              v: 1,
              nodeId: s.selfNodeId,
              at,
              w: GREY_W,
              h: GREY_H,
              hotBlocks,
              peakMad: Math.round(peakMad * 100) / 100,
              grey: bytesToBase64(frame),
            },
            s.selfNodeId,
          );
          const file = new File(dir, name);
          if (!file.exists) file.create({ intermediates: true, overwrite: true });
          file.write(sealed);
          snapshot = name;
        }
      } catch {
        // Out of space, or the directory vanished. The EVENT is still recorded —
        // "something moved and we could not keep the picture" is information the
        // family needs, and swallowing it would be the dishonest option.
        snapshot = null;
      }
    }

    const event: MotionEvent = {
      id: uuidv7(at),
      nodeId: s.selfNodeId,
      at,
      hotBlocks,
      peakMad: Math.round(peakMad * 100) / 100,
      snapshot,
    };

    const dayAgo = at - 24 * 60 * 60_000;
    // The count is incremented from what we just did rather than re-listing the
    // directory: a synchronous readdir per motion event is a stall in the render
    // path, and hydrate + pruneRetention both re-derive the true count from the
    // files, which is where a drift would be corrected anyway.
    set((prev) => {
      const events = [event, ...prev.events].slice(0, 500);
      const recent = events.filter((e) => e.nodeId === prev.selfNodeId && e.at >= dayAgo).length;
      return {
        events,
        nodes: prev.nodes.map((n) =>
          n.isSelf
            ? {
                ...n,
                lastMotionAt: at,
                lastMotionBlocks: hotBlocks,
                motionEvents24h: recent,
                snapshotCount: n.snapshotCount + (snapshot === null ? 0 : 1),
                lastHeardAt: at,
              }
            : n,
        ),
      };
    });

    // ★ NOT three fsyncs per motion event. ★
    // The snapshot above is already one encrypt-and-write; re-sealing the ENTIRE
    // index (up to 500 events plus every node) and then listing the snapshot
    // directory again on top of it made three synchronous disk operations per
    // event — and a motion burst is precisely when they land back to back. The
    // comment on `publishSelf` says an encrypt-and-fsync at 3 Hz would be wrong;
    // the same reasoning applies here and was not followed. Retention moves off
    // this path entirely: it is a 7-day sweep, not a per-event duty.
    schedulePersist(get);
  },

  /**
   * ★★★ THE KILL SWITCH (P-024) ★★★
   * Note what is NOT here: no check that `by` is a guardian, no check that they
   * own the node, no check that they set it up, no confirmation from anybody
   * else. Every family member can switch off every camera in the house,
   * unilaterally, and that is the whole design. A camera that only its installer
   * can stop is a camera the rest of the household lives under.
   */
  async disableNode(nodeId, by): Promise<void> {
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === nodeId
          ? { ...n, runtime: 'disabled-by-family', disabledBy: by, maintenance: null }
          : n,
      ),
    }));
    await persist(get());
  },

  /**
   * ★ Asymmetric on purpose. Disabling is remote and instant; re-enabling is
   *   possible only from the phone that IS the node — you have to walk to it.
   *   That means somebody who objects to being filmed cannot be overruled from
   *   another room, and re-arming is always a physical, visible act.
   */
  async resumeSelf(): Promise<void> {
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.isSelf ? { ...n, runtime: 'off', disabledBy: null, armedAt: null } : n,
      ),
    }));
    await persist(get());
  },

  async purgeSnapshots(nodeId): Promise<number> {
    const s = get();
    let removed = 0;

    if (nodeId === s.selfNodeId) {
      const dir = snapDir();
      if (dir !== null) {
        for (const name of listSnapshotNames()) {
          try {
            new File(dir, name).delete();
            removed++;
          } catch {
            /* already gone */
          }
        }
      }
      set((prev) => ({
        events: prev.events.filter((e) => e.nodeId !== nodeId),
        nodes: prev.nodes.map((n) =>
          n.id === nodeId ? { ...n, snapshotCount: 0, purgeRequestedAt: null } : n,
        ),
      }));
    } else {
      // Another phone holds those files. We record the instruction rather than
      // pretending to have deleted something we cannot reach — the node applies
      // it the next time it is opened.
      set((prev) => ({
        nodes: prev.nodes.map((n) =>
          n.id === nodeId ? { ...n, purgeRequestedAt: Date.now() } : n,
        ),
      }));
    }

    await persist(get());
    return removed;
  },

  /** 7-day retention plus the object cap (P-024). Runs on every hydrate. */
  async pruneRetention(): Promise<number> {
    const dir = snapDir();
    if (dir === null) return 0;
    const names = listSnapshotNames();
    const doomed = snapshotsToDelete(names, Date.now());
    let removed = 0;
    for (const name of doomed) {
      try {
        new File(dir, name).delete();
        removed++;
      } catch {
        /* already gone */
      }
    }

    const alive = new Set(names.filter((n) => !doomed.includes(n)));
    set((s) => ({
      // An event whose snapshot expired keeps its timestamp: the family is still
      // entitled to know the node fired, they just no longer have the picture.
      events: s.events.map((e) =>
        e.snapshot !== null && !alive.has(e.snapshot) ? { ...e, snapshot: null } : e,
      ),
      nodes: s.nodes.map((n) => (n.isSelf ? { ...n, snapshotCount: alive.size } : n)),
    }));
    if (removed > 0) await persist(get());
    return removed;
  },
}));

/**
 * A node whose phone was rebooted comes back OFF, never LIVE.
 *
 * Resuming capture unattended after a restart would mean a camera that switched
 * itself back on in a house where somebody may have deliberately stopped it. The
 * one state that survives a restart is a kill: that one is meant to stick.
 */
function coldStart(n: NodeStatus): NodeRuntime {
  return n.runtime === 'disabled-by-family' ? 'disabled-by-family' : 'off';
}

/**
 * Coalesced index write.
 *
 * Every deliberate action (accept, disable, resume, purge) still persists
 * immediately — those are decisions a user made and expects to survive a kill.
 * The motion path does not: it fires several times a second during a burst, and
 * the worst case of a coalesced write is that the last few seconds of the event
 * INDEX are lost on a hard kill. The snapshot files themselves are already on
 * disk, and `pruneRetention` rebuilds the count from them on the next hydrate.
 */
const PERSIST_DEBOUNCE_MS = 4_000;
/**
 * Retention runs on activity, not on a wall clock: a phone sitting in a drawer
 * has nothing to prune, and a timer ticking for nobody is a straight subtraction
 * from the power budget. Hydrate does the first sweep; this does the rest.
 */
const PRUNE_INTERVAL_MS = 60 * 60_000;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let lastPruneAt = 0;

function schedulePersist(get: () => NodeState): void {
  if (persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void (async () => {
      await persist(get());
      if (Date.now() - lastPruneAt > PRUNE_INTERVAL_MS) {
        lastPruneAt = Date.now();
        await get()
          .pruneRetention()
          .catch(() => {});
      }
    })();
  }, PERSIST_DEBOUNCE_MS);
}

async function persist(s: NodeState): Promise<void> {
  // A pending coalesced write is redundant once an immediate one runs.
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const secret = await loadGroupSecret();
  if (secret === null) return;
  try {
    const root = rootDir();
    if (root === null) return;
    const payload: Persisted = {
      v: 1,
      consentAcceptedAt: s.consentAcceptedAt,
      placement: s.placement,
      selfNodeId: s.selfNodeId,
      nodes: s.nodes,
      events: s.events,
    };
    const file = new File(root, INDEX_FILE);
    if (!file.exists) file.create({ intermediates: true, overwrite: true });
    file.write(sealJson(nodeKey(secret, 'index'), payload, 'index'));
  } catch {
    /* the node keeps working from memory; the index rebuilds on the next write */
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Selectors & presentation helpers (kept here so both screens agree)
// ═══════════════════════════════════════════════════════════════════════════════

export function selfNode(s: NodeState): NodeStatus | null {
  return s.nodes.find((n) => n.isSelf) ?? null;
}

export function nodeEvents(s: NodeState, nodeId: string): MotionEvent[] {
  return s.events.filter((e) => e.nodeId === nodeId);
}

export interface RuntimeLabel {
  label: string;
  tone: 'ok' | 'warn' | 'danger' | 'info' | 'neutral';
  /** Longer sentence; the pill label alone is ≤4 words per PRD §6.4. */
  detail: string;
}

export function describeRuntime(n: NodeStatus): RuntimeLabel {
  switch (n.runtime) {
    case 'live':
      return { label: 'Camera on', tone: 'danger', detail: 'This camera is capturing now.' };
    case 'exit-delay':
      return {
        label: 'Starting',
        tone: 'warn',
        detail: 'Armed, not yet capturing — waiting for the room to be empty.',
      };
    case 'paused-family-home':
      return {
        label: 'Off, family home',
        tone: 'ok',
        detail: 'Someone is home, so this camera switched itself off.',
      };
    case 'suspended-thermal':
      return {
        label: 'Off, too hot',
        tone: 'warn',
        detail: 'Suspended because the battery is too hot to keep the camera running.',
      };
    case 'disabled-by-family':
      return {
        label: 'Switched off',
        tone: 'info',
        detail:
          n.disabledBy === null
            ? 'A family member switched this camera off.'
            : `${n.disabledBy.name} switched this camera off. Only the phone itself can turn it back on.`,
      };
    case 'no-home-fence':
      return {
        label: 'Blocked',
        tone: 'danger',
        detail: 'No home area is set, so this camera cannot know when someone comes home.',
      };
    case 'no-seal-key':
      return {
        label: 'Blocked',
        tone: 'danger',
        detail: 'Snapshots cannot be encrypted on this device, so the camera will not run.',
      };
    case 'off':
    default:
      return { label: 'Off', tone: 'neutral', detail: 'This camera is not running.' };
  }
}

/** "4 min ago" / "just now" — never a bare epoch on a family-facing screen. */
export function sinceLabel(at: number | null, now: number): string {
  if (at === null) return 'never';
  const ms = now - at;
  if (ms < 45_000) return 'just now';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min ago`;
  const hrs = Math.round(min / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} d ago`;
}
