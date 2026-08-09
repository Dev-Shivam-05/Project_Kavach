/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ENROLMENT STORE — the state either side of the exchange has to keep
 *
 * Its own zustand slice, for the reason `nodeStore.ts` gives: the main store is
 * the T0 safety plane and a setup flow must not be able to wedge it. This module
 * reads SecureStore and the filesystem, and it never touches `store.ts`.
 *
 * ★★★ IT NEVER TALKS TO A SERVER ★★★
 * There is no import from `src/net` in this file and there must not be one. Two
 * phones on a kitchen table with no SIM, no Wi-Fi and no backend are the target
 * case, not a degraded one — the whole exchange is a code read across a table.
 *
 * ★★★ WHY JOINING ASKS FOR A RESTART ★★★
 * `store.ts` reads the group secret once, at boot, into a module variable that
 * nothing re-reads. Writing a new secret to SecureStore therefore does not reach
 * the running safety plane. The alternatives are to tear down and re-bootstrap
 * the store — which restarts T0, the watchdog and the subscriptions in the
 * middle of a setup step — or to say so. Restarting the safety agent to finish
 * a setup step is the worse trade, so `restartRequired` is set and the screen
 * asks. It is one sentence, and it is true.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { create } from 'zustand';
import { Directory, File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';

import { STORAGE_KEYS } from '../core/config';
import type { UUID } from '../core/types';
import { base64ToBytes, bytesToBase64 } from '../core/ids';
import { deriveKey, openJson, sealJson, type DeviceKeypair } from '../crypto';
import {
  INVITE_TTL_MS,
  bindingOf,
  buildInvite,
  fingerprintOf,
  readInvite,
  readResponse,
  sealResponse,
  type EnrolResponse,
  type Invite,
} from '../domain/enrolment';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

/** Null until a human says which phone they are holding. */
export type EnrolRole = null | 'joining' | 'inviting';

export interface EnrolledDevice {
  deviceId: UUID;
  displayName: string;
  /** base64 X25519 public key — what the next re-seal has to address. */
  boxPublic: string;
  fingerprint: string;
  enrolledAt: number;
}

export interface JoinedFamily {
  familyId: UUID;
  guardianName: string;
  at: number;
}

export interface EnrolState {
  ready: boolean;
  role: EnrolRole;
  /** Non-null when this phone cannot take part at all, with the reason in words. */
  blocked: string | null;
  /** True once a group secret exists here, i.e. this phone can invite. */
  hasFamilyKey: boolean;
  myFingerprint: string;

  /** Joiner: the outstanding invitation. */
  invite: Invite | null;
  joined: JoinedFamily | null;
  restartRequired: boolean;

  /** Guardian: the invitation on screen, awaiting the spoken fingerprint check. */
  reviewing: Invite | null;
  response: EnrolResponse | null;
  respondedTo: string | null;
  roster: EnrolledDevice[];

  /** The last refusal, phrased for the person holding the phone. */
  notice: string | null;

  hydrate(): Promise<void>;
  chooseRole(role: EnrolRole): void;
  clearNotice(): void;

  createInvite(deviceId: UUID, displayName: string): Promise<void>;
  discardInvite(): Promise<void>;
  accept(text: string): Promise<boolean>;

  review(text: string): void;
  dropReview(): void;
  confirmAndSeal(familyId: UUID, guardianName: string): Promise<void>;
  clearResponse(): void;
}

interface Persisted {
  v: 1;
  roster: EnrolledDevice[];
  /** Invitations already answered. See `spend()` for why this expires. */
  spent: { binding: string; at: number }[];
  inviteCode: string | null;
  joined: JoinedFamily | null;
}

/** The shape `store.ts` writes under STORAGE_KEYS.deviceKeypair. */
interface StoredKeypair {
  identitySecret: string;
  identityPublic: string;
  emergencySecret: string;
  emergencyPublic: string;
  boxSecret: string;
  boxPublic: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Key material and storage
// ═══════════════════════════════════════════════════════════════════════════════

const ROOT_DIR = 'kavach-enrol';
const INDEX_FILE = 'roster.sealed';

const NO_KEYPAIR =
  'This phone has no keys yet. Open Kavach, let it finish starting, and come back to this screen.';

/** Module scope, never React state — the same rule the main store follows. */
let keypair: DeviceKeypair | null = null;
let groupSecret: Uint8Array | null = null;
let spent: { binding: string; at: number }[] = [];
let hydratePromise: Promise<void> | null = null;

async function loadKeypair(): Promise<DeviceKeypair | null> {
  if (keypair !== null) return keypair;
  try {
    const raw = await SecureStore.getItemAsync(STORAGE_KEYS.deviceKeypair);
    if (raw === null) return null;
    const s = JSON.parse(raw) as StoredKeypair;
    keypair = {
      identitySecret: base64ToBytes(s.identitySecret),
      identityPublic: base64ToBytes(s.identityPublic),
      emergencySecret: base64ToBytes(s.emergencySecret),
      emergencyPublic: base64ToBytes(s.emergencyPublic),
      boxSecret: base64ToBytes(s.boxSecret),
      boxPublic: base64ToBytes(s.boxPublic),
    };
    return keypair;
  } catch {
    // A corrupt blob is store.ts's to regenerate at the next boot. Enrolment
    // must not mint a second keypair behind its back — that would strand every
    // sealed record already written under the first one.
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

function rootDir(): Directory | null {
  try {
    const dir = new Directory(Paths.document, ROOT_DIR);
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    return dir;
  } catch {
    return null;
  }
}

/**
 * Sealed, like the camera index in nodeStore. A plaintext roster is a list of
 * every device in a household with the public key each one answers to — enough
 * for someone holding a stolen phone to know exactly who else to look for.
 */
function rosterKey(secret: Uint8Array): Uint8Array {
  return deriveKey(secret, 'enrol', 'roster');
}

async function persist(state: EnrolState): Promise<void> {
  const secret = await loadGroupSecret();
  if (secret === null) return;
  try {
    const root = rootDir();
    if (root === null) return;
    const payload: Persisted = {
      v: 1,
      roster: state.roster,
      spent,
      inviteCode: state.invite?.code ?? null,
      joined: state.joined,
    };
    const file = new File(root, INDEX_FILE);
    if (!file.exists) file.create({ intermediates: true, overwrite: true });
    file.write(sealJson(rosterKey(secret), payload, 'roster'));
  } catch {
    /* the exchange still completes from memory; the roster rebuilds on the next write */
  }
}

/**
 * Single use. An invitation older than `INVITE_TTL_MS` is refused by
 * `readInvite` on its own, so a ledger entry past that point can never be
 * consulted again and is dropped rather than accumulated forever.
 */
function spend(binding: string, at: number): void {
  spent = [...spent.filter((e) => at - e.at < INVITE_TTL_MS), { binding, at }];
}

function alreadySpent(binding: string, at: number): boolean {
  return spent.some((e) => e.binding === binding && at - e.at < INVITE_TTL_MS);
}

// ═══════════════════════════════════════════════════════════════════════════════

export const useEnrol = create<EnrolState>()((set, get) => ({
  ready: false,
  role: null,
  blocked: null,
  hasFamilyKey: false,
  myFingerprint: '',
  invite: null,
  joined: null,
  restartRequired: false,
  reviewing: null,
  response: null,
  respondedTo: null,
  roster: [],
  notice: null,

  async hydrate(): Promise<void> {
    if (get().ready) return;
    if (hydratePromise !== null) return hydratePromise;
    // doHydrate cannot reject, but both call sites are `void hydrate()`, so a
    // future one that could would become an unhandled rejection. Belt and braces.
    hydratePromise = doHydrate(set)
      .catch(() => {})
      .finally(() => {
        hydratePromise = null;
      });
    return hydratePromise;
  },

  chooseRole(role): void {
    set({ role, notice: null });
  },

  clearNotice(): void {
    set({ notice: null });
  },

  // ── the joining phone ───────────────────────────────────────────────────────

  async createInvite(deviceId, displayName): Promise<void> {
    const kp = await loadKeypair();
    if (kp === null) {
      set({ blocked: NO_KEYPAIR });
      return;
    }
    // buildInvite is handed the PUBLIC half and nothing else — the private key
    // is not reachable from anything the code carries.
    set({
      invite: buildInvite({ deviceId, boxPublic: kp.boxPublic, displayName }),
      notice: null,
    });
    await persist(get());
  },

  async discardInvite(): Promise<void> {
    set({ invite: null, notice: null });
    await persist(get());
  },

  async accept(text): Promise<boolean> {
    const kp = await loadKeypair();
    const invite = get().invite;
    if (kp === null) {
      set({ blocked: NO_KEYPAIR });
      return false;
    }
    if (invite === null) {
      set({ notice: 'Show your code first — the reply is an answer to it.' });
      return false;
    }

    const opened = readResponse(text, kp, invite);
    if (!opened.ok) {
      set({ notice: opened.message });
      return false;
    }

    const joined: JoinedFamily = {
      familyId: opened.value.familyId,
      guardianName: opened.value.guardianName,
      at: Date.now(),
    };

    try {
      await SecureStore.setItemAsync(
        STORAGE_KEYS.groupSecret,
        bytesToBase64(opened.value.groupSecret),
        // Matches store.ts secureSet: the emergency path must never sit behind a
        // biometric prompt (F-17).
        { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
      );
    } catch {
      set({
        notice:
          'This phone would not save the family key. Check that its screen lock is set up, then try again.',
      });
      return false;
    }

    // Everything below was sealed under the key this phone founded on its own.
    // That family had one member and no longer exists; carrying its roster
    // forward would list devices that were never in the family just joined.
    groupSecret = opened.value.groupSecret;
    spent = [];
    set({
      invite: null,
      joined,
      roster: [],
      restartRequired: true,
      hasFamilyKey: true,
      notice: null,
    });
    await persist(get());
    return true;
  },

  // ── the guardian's phone ────────────────────────────────────────────────────

  /**
   * Decode and HOLD. Nothing is sealed here, deliberately: the guardian has to
   * see the name and the fingerprint and confirm them with the other person out
   * loud first. Skipping that step makes this trust-on-first-use, and a man in
   * the middle who swapped the public key would simply join the family.
   */
  review(text): void {
    const read = readInvite(text);
    if (!read.ok) {
      set({ notice: read.message, reviewing: null });
      return;
    }
    const invite = read.value;

    const mine = get().myFingerprint;
    if (mine.length > 0 && fingerprintOf(invite.boxPublic) === mine) {
      set({ notice: 'That is this phone’s own invitation.', reviewing: null });
      return;
    }
    if (alreadySpent(bindingOf(invite.payload), Date.now())) {
      set({
        notice: 'That invitation has already been answered. Ask for a fresh code.',
        reviewing: null,
      });
      return;
    }
    set({ reviewing: invite, notice: null });
  },

  dropReview(): void {
    set({ reviewing: null, notice: null });
  },

  async confirmAndSeal(familyId, guardianName): Promise<void> {
    const invite = get().reviewing;
    if (invite === null) return;
    const secret = await loadGroupSecret();
    if (secret === null) {
      set({
        notice: 'This phone has no family key to share yet, so it cannot add anybody.',
        reviewing: null,
      });
      return;
    }

    const at = Date.now();
    const binding = bindingOf(invite.payload);
    if (alreadySpent(binding, at)) {
      set({ notice: 'That invitation has already been answered.', reviewing: null });
      return;
    }

    // sealTo binds the group secret to this one X25519 public key. The reply can
    // be dictated, photographed or forwarded and still opens on exactly one phone.
    const response = sealResponse({ invite, groupSecret: secret, familyId, guardianName });
    spend(binding, at);

    const entry: EnrolledDevice = {
      deviceId: invite.deviceId,
      displayName: invite.displayName,
      boxPublic: bytesToBase64(invite.boxPublic),
      fingerprint: invite.fingerprint,
      enrolledAt: at,
    };

    set((s) => ({
      roster: [entry, ...s.roster.filter((d) => d.deviceId !== entry.deviceId)],
      response,
      respondedTo: invite.displayName,
      reviewing: null,
      notice: null,
    }));
    await persist(get());
  },

  clearResponse(): void {
    set({ response: null, respondedTo: null });
  },
}));

/**
 * ★ `ready` FLIPS ON EVERY PATH, INCLUDING THE BROKEN ONES ★
 *
 * A reject anywhere in here left `hydratePromise` rejected and `ready` false
 * forever, so the enrolment screen sat on its loading state with no way out but
 * the back gesture — and the rejection was unhandled because both call sites use
 * `void hydrate()`. The screen must always end up with something to render and,
 * when it went wrong, a sentence saying so.
 */
async function doHydrate(set: (partial: Partial<EnrolState>) => void): Promise<void> {
  let blocked: string | null = null;
  try {
    const kp = await loadKeypair();
    const secret = await loadGroupSecret();

    let loaded: Persisted | null = null;
    if (secret !== null) {
      try {
        const root = rootDir();
        if (root !== null) {
          const file = new File(root, INDEX_FILE);
          if (file.exists) loaded = openJson<Persisted>(rosterKey(secret), await file.text(), 'roster');
        }
      } catch {
        loaded = null;
      }
    }

    spent = loaded?.spent ?? [];

    // An invitation that outlived its ten minutes is dropped rather than shown
    // with a dead countdown; the screen offers a fresh one instead.
    const restored = loaded?.inviteCode == null ? null : readInvite(loaded.inviteCode);

    blocked = kp === null ? NO_KEYPAIR : null;
    set({
      hasFamilyKey: secret !== null,
      myFingerprint: kp === null ? '' : fingerprintOf(kp.boxPublic),
      invite: restored !== null && restored.ok ? restored.value : null,
      joined: loaded?.joined ?? null,
      roster: loaded?.roster ?? [],
    });
  } catch (e) {
    blocked =
      blocked ??
      `This phone could not read its enrolment records (${e instanceof Error ? e.message : 'unknown error'}). Close Kavach and open it again.`;
  } finally {
    set({ ready: true, blocked });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Selectors
// ═══════════════════════════════════════════════════════════════════════════════

/** "9:58" — the countdown both screens print next to a live code. */
export function countdownLabel(secondsRemaining: number): string {
  const m = Math.floor(secondsRemaining / 60);
  const s = secondsRemaining % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}
