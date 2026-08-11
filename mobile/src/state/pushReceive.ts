/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * REMOTE PUSH — THE RECEIVE HALF (W10-b · 1.35e)
 *
 * ★ THIS IS THE FILE THAT MAKES A CLOSED PHONE RING. ★
 *
 * W10-a gave the server an address for every family handset and a real FCM
 * send. Nothing on the device consumed the message, so the server was sending
 * into the void: with the app killed the only working leg to another human was
 * still SMS. This module is the other end of that wire.
 *
 * ★ WHY THE TASK IS DEFINED IN MODULE SCOPE AND REGISTERED FROM `index.ts` ★
 * `expo-task-manager` loads the JS bundle in the background and immediately
 * looks up the task by name. If `defineTask` has not already run by then the
 * lookup misses and the message is dropped — silently, with no error and no
 * notification. Registering from a React component or an effect therefore
 * "works" in every state except the only one that matters (app killed), which
 * is the most expensive kind of bug this project can ship. Hence: module scope,
 * imported by `index.ts` BEFORE `expo-router/entry`.
 *
 * ★ F-21 / F-01 — WHAT WE ARE WILLING TO BELIEVE ★
 * The payload transited Google. `notifications.ts` explains why the server may
 * only send the lock-screen-safe set; this file is where the client refuses to
 * act on anything else. `readPushFields` is an ALLOWLIST reader, not a cast: it
 * takes the permitted values by name, validates and sanitises each, and drops the
 * rest on the floor. So even a compromised or buggy sender that puts `duress` in
 * the payload cannot get that bit onto a lock screen, into the notification's
 * `data` bag, or into the app — the client half of F-01 does not depend on the
 * server half being correct.
 *
 * `subjectShortName` gets the strictest treatment because it is the one
 * attacker-influencable string that renders as text on a LOCKED screen: ASCII
 * printable only, ≤8 characters (F-18).
 *
 * ★ FAIL-SOFT, IN BOTH DIRECTIONS ★
 * A malformed payload presents nothing — an alert with no incident id is a
 * notification the responder cannot act on and a false alarm we cannot explain.
 * A payload that is merely UNRECOGNISED (a trigger this build has never heard
 * of, an unparseable tier) still rings, degraded to the generic label: the cost
 * of a vague alarm is confusion, the cost of a dropped one is the product.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { DEFAULT_POLICY } from '../core/policy';
import {
  ensureNotificationChannels,
  notifyIncidentFromPush,
  notifyOwnershipFromPush,
} from './notifications';
import type { IncidentAlertFields } from './notifications';
import type { TriggerType, UUID } from '../core/types';

/**
 * The name is a stable contract with the OS: `TaskManager` persists the
 * registration across launches and reboots, so renaming this leaves a dangling
 * registration pointing at a task that no longer exists.
 */
export const PUSH_INCIDENT_TASK = 'kavach.push.incident';

/**
 * What a push may say it is about (W10-d · 1.32). `alert` is the default for a
 * payload that does not say — including one from a server older than this build.
 */
export type PushKind = 'alert' | 'claimed' | 'released';

const KNOWN_KINDS = new Set<PushKind>(['alert', 'claimed', 'released']);

/**
 * The wire fields, minus the drill flag the server does not send. `kind` and
 * `ownerShortName` arrived with W10-d: a CLAIM now fans out over push as well as
 * the socket (§2.6.4), and without these two a claim would be indistinguishable
 * from a fresh emergency — the receiving phone would ring the alarm stream at the
 * exact moment the design says to stop ringing.
 */
export type PushIncidentFields = Omit<IncidentAlertFields, 'isDrill'> & {
  kind: PushKind;
  ownerShortName: string;
};

/**
 * Ids reach two places that deserve care: a notification identifier and the
 * `/incident/<id>` route. Restricting to URL-unreserved characters — no dot, no
 * slash — means a hostile id cannot become a path of its own. UUIDv7 (P-053)
 * passes unchanged.
 */
const ID_PATTERN = /^[A-Za-z0-9_~-]{8,64}$/;

/** Runtime view of `TriggerType`; the policy table is the only enumeration of it. */
const KNOWN_TRIGGERS = new Set(Object.keys(DEFAULT_POLICY.scenarios));

function asId(value: unknown): UUID | null {
  return typeof value === 'string' && ID_PATTERN.test(value) ? (value as UUID) : null;
}

/**
 * An unknown trigger is a newer server, not an attack, and it is still an
 * emergency. MANUAL is the same fallback `ladderFor()` uses in policy.ts, and
 * it renders as "Manual panic" rather than as whatever string arrived.
 */
function asTrigger(value: unknown): TriggerType {
  return typeof value === 'string' && KNOWN_TRIGGERS.has(value)
    ? (value as TriggerType)
    : 'MANUAL';
}

/**
 * The wire carries `strconv.Itoa(tier)` — "1", "2" or "3". Anything else means
 * a sender we do not understand; tier only selects the WORDING, and every tier
 * rings on the same MAX/bypassDnd alarm channel, so defaulting to 1 loses
 * urgency in the text and loses nothing in audibility.
 */
function asTier(value: unknown): 1 | 2 | 3 {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return n === 3 ? 3 : n === 2 ? 2 : 1;
}

/**
 * ★ FAIL-SAFE IN ONE DIRECTION ONLY. ★ An unrecognised kind — a newer server, a
 * corrupted field, a hostile sender — becomes `alert`, so the phone rings. The
 * asymmetry is the point: a claim mistakenly presented as an alert costs one
 * wasted siren, an alert mistakenly presented as a quiet banner costs the alert.
 */
function asKind(value: unknown): PushKind {
  return typeof value === 'string' && KNOWN_KINDS.has(value as PushKind)
    ? (value as PushKind)
    : 'alert';
}

/**
 * F-18 / I-2: ASCII printable (32..126), ≤8 characters. This is the only piece
 * of server-supplied text that reaches a locked screen, so it is clamped rather
 * than trusted — control characters, RTL overrides and emoji all leave here as
 * nothing. An empty result is fine: the alert falls back to "Family".
 *
 * Both names on the wire go through this — the subject's and, since W10-d, the
 * responding owner's.
 */
function asShortName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .split('')
    .filter((c) => {
      const code = c.charCodeAt(0);
      return code >= 32 && code <= 126;
    })
    .join('')
    .trim()
    .slice(0, 8);
}

/**
 * Android puts every FCM data key FLAT on the bundle (`RemoteMessageSerializer`
 * copies the map entry by entry) and only fills `dataString` from a key named
 * `body`, which the F-21 allowlist forbids — so on the platform this app ships
 * to, `dataString` is null and the five arrive as siblings of it. The
 * `dataString` branch is kept because it is the documented cross-platform shape
 * and costs one JSON.parse; reading only one of the two would work on a device
 * and fail on the next SDK that normalises them.
 */
function payloadBag(payload: unknown): Record<string, unknown> | null {
  if (payload === null || typeof payload !== 'object') return null;
  const bag = (payload as { data?: unknown }).data;
  if (bag === null || bag === undefined || typeof bag !== 'object') return null;

  const flat = bag as Record<string, unknown>;
  const encoded = flat.dataString;
  if (typeof encoded === 'string' && encoded.length > 0) {
    try {
      const parsed: unknown = JSON.parse(encoded);
      if (parsed !== null && typeof parsed === 'object') {
        return { ...flat, ...(parsed as Record<string, unknown>) };
      }
    } catch {
      // Not JSON. The flat keys are still authoritative on Android.
    }
  }
  return flat;
}

/**
 * ★ THE ALLOWLIST READER. ★ Five values by name, or null. Exported because the
 * decision "is this a payload we are willing to wake a family for" is the whole
 * of this module's logic and belongs under test off-device.
 */
export function readPushFields(payload: unknown): PushIncidentFields | null {
  // On Android the same task receives notification-action taps when the app is
  // backgrounded or terminated. That is a RESPONSE, not an incoming alert, and
  // presenting it again would re-alarm a family for an incident they are
  // already answering.
  if (payload !== null && typeof payload === 'object' && 'actionIdentifier' in payload) {
    return null;
  }

  const bag = payloadBag(payload);
  if (bag === null) return null;

  const incidentId = asId(bag.incidentId);
  const familyId = asId(bag.familyId);
  // Both ids are mandatory: without the incident id the responder has nothing
  // to open, and without the family id we cannot tell a misrouted push from
  // ours. Neither is a field worth guessing.
  if (incidentId === null || familyId === null) return null;

  return {
    incidentId,
    familyId,
    trigger: asTrigger(bag.trigger),
    tier: asTier(bag.tier),
    subjectShortName: asShortName(bag.subjectShortName),
    kind: asKind(bag.kind),
    ownerShortName: asShortName(bag.ownerShortName),
  };
}

/**
 * Parse, then present. Returns whether something reached the OS, which is what
 * the task reports back as its result.
 *
 * ★ W10-d · 1.32 — two outcomes, one task. ★ `claimed` is the ladder STOPPING:
 * the siren comes down and a quiet banner naming the responder goes up. Anything
 * else — including `released`, which is the ladder resuming at L2 — rings.
 *
 * Nothing here throws. A background task that rejects is retried and rate
 * limited by the platform, and an exception on this path costs the alert.
 */
export async function handleIncidentPush(payload: unknown): Promise<boolean> {
  const fields = readPushFields(payload);
  if (fields === null) return false;
  try {
    await ensureNotificationChannels();
    if (fields.kind === 'claimed') {
      await notifyOwnershipFromPush({
        incidentId: fields.incidentId,
        familyId: fields.familyId,
        trigger: fields.trigger,
        subjectShortName: fields.subjectShortName,
        ownerShortName: fields.ownerShortName,
      });
      return true;
    }
    await notifyIncidentFromPush({
      incidentId: fields.incidentId,
      familyId: fields.familyId,
      trigger: fields.trigger,
      tier: fields.tier,
      subjectShortName: fields.subjectShortName,
    });
    return true;
  } catch {
    // `present()` already fails soft; this is the belt for its braces.
    return false;
  }
}

TaskManager.defineTask<Notifications.NotificationTaskPayload>(
  PUSH_INCIDENT_TASK,
  async ({ data, error }) => {
    if (error) return Notifications.BackgroundNotificationTaskResult.Failed;
    const presented = await handleIncidentPush(data);
    return presented
      ? Notifications.BackgroundNotificationTaskResult.NewData
      : Notifications.BackgroundNotificationTaskResult.NoData;
  },
);

/**
 * Registration is idempotent and persists in native state, so running it on
 * every bundle load — including the headless one — is both harmless and the
 * documented pattern. It is fire-and-forget for the usual reason: a device
 * without Play Services or a build without Firebase config must degrade to
 * "no push", never to "no app".
 */
void Notifications.registerTaskAsync(PUSH_INCIDENT_TASK).catch(() => {
  /* no push transport on this device; SMS and the socket are unaffected */
});
