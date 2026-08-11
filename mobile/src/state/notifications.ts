/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * NOTIFICATIONS — channels, categories, and locally-composed text
 *
 * ★★★ FINDING F-21 — THE CONTENT POLICY ★★★
 * FCM and APNs payloads transit Google and Apple, and land on a LOCKED SCREEN.
 * Any human-readable alert body written by the server is, by definition, visible
 * to both companies and to anyone standing near the phone. So the remote push
 * this app expects is DATA-ONLY, Class B/C exclusively:
 *
 *     { incidentId, familyId, trigger, tier, subjectShortName,
 *       kind, ownerShortName }
 *
 * Nothing else. No location, no note, no medical detail, no name beyond the
 * ASCII short names, and — deliberately — NO DURESS FLAG (F-01: the duress bit
 * must not be inferable from anything that leaves the device, and a push payload
 * is a side channel like any other).
 *
 * The last two arrived with W10-d · 1.32, when CLAIM began fanning out over push
 * as §2.6.4 requires. They are what "Rohan is responding. Stand by." is made of,
 * and without them a claim would be indistinguishable from a fresh emergency —
 * the receiving phone would ring at the exact moment the design says to stop.
 * A claim is not inferable from duress either: it happens identically on both.
 *
 * ★ THIS FILE IS WHERE THE HUMAN-READABLE TEXT IS BORN. ★ Every string below is
 * composed on-device from group-decrypted state and presented as a LOCAL
 * notification. The lock screen therefore shows short name + trigger class and
 * nothing more; detail requires unlocking and opening the app. That is both the
 * privacy control and the UX decision, written down (docs/02 §2.6, F-21).
 *
 * ★ PRD §12.2 — WHY THE ALARM CHANNEL USES STREAM_ALARM ★
 * `usage: ALARM` is the underused Android affordance that matters here: an alarm
 * stream plays regardless of ringer state, and combined with `bypassDnd` it
 * survives Do Not Disturb and a silenced phone. A safety alert that a silent
 * switch can mute is not a safety alert. `enforceAudibility` completes it.
 *
 * Everything in this module fails soft (rule 8 / L0 floor): a denied permission,
 * an Expo Go limitation or a missing channel must degrade the alert, never throw
 * into the incident path. The siren and the on-screen alarm do not depend on it.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { Platform } from 'react-native';
import { router } from 'expo-router';
import * as Notifications from 'expo-notifications';
import {
  AndroidAudioContentType,
  AndroidAudioUsage,
  AndroidImportance,
  AndroidNotificationVisibility,
} from 'expo-notifications';
import { CONFIG } from '../core/config';
import { DEFAULT_POLICY } from '../core/policy';
import { t } from '../i18n';
import type { Incident, Member, TriggerType, UUID } from '../core/types';

export const CHANNEL_EMERGENCY = 'kavach-emergency';
export const CHANNEL_PROBE = 'kavach-probe';
export const CHANNEL_HEALTH = 'kavach-health';
/**
 * ★ W10-d · 1.32 — the channel a CLAIM lands on. ★
 * P-030 correction 1: when somebody claims, every other phone goes siren →
 * *persistent quiet banner*, and explicitly NOT silence. That is three
 * requirements no existing channel meets at once — the emergency channel would
 * ring (it is MAX + bypassDnd + alarm stream, which is its whole point), and the
 * health channel is PRIVATE on a lock screen, so "Rohan is responding" would
 * render as "Notification" to the person deciding whether to grab their keys.
 * On Android an existing channel's importance and visibility cannot be edited
 * after creation, so this has to be its own id.
 */
export const CHANNEL_OWNERSHIP = 'kavach-ownership';

export const CATEGORY_INCIDENT = 'kavach.incident';
export const CATEGORY_PROBE = 'kavach.probe';

/** Action identifiers surfaced back through the response listener. */
export const ACTION_CLAIM = 'KAVACH_CLAIM';
export const ACTION_PROBE_FINE = 'KAVACH_PROBE_FINE';
export const ACTION_PROBE_HELP = 'KAVACH_PROBE_HELP';

/** Stable, derivable identifiers so a notification can be cleared without a map. */
const incidentNotificationId = (id: UUID) => `kavach.incident.${id}`;
const probeNotificationId = (id: UUID) => `kavach.probe.${id}`;
const ownershipNotificationId = (id: UUID) => `kavach.ownership.${id}`;
const agentSilentNotificationId = (memberId: UUID) => `kavach.health.agent.${memberId}`;
const DEGRADED_NOTIFICATION_ID = 'kavach.health.degraded';

/**
 * ★ RULE 4 — the CURRENT behaviour field set. `shouldShowAlert` was removed;
 * banner and list are now separate decisions.
 *
 * An incident notification is shown even while the app is in the foreground: the
 * app may be sitting on an unrelated screen, and suppressing the banner would
 * hide an emergency behind whatever the user happened to be doing.
 */
export function installNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const id = notification.request.identifier ?? '';
      // Health notices are informational; an ownership banner is the sound
      // STOPPING (P-030). Neither may make a noise of its own.
      const isQuiet =
        id.startsWith('kavach.health.') || id.startsWith('kavach.ownership.');
      return {
        shouldPlaySound: !isQuiet,
        shouldSetBadge: false, // badges imply an inbox; this is not one
        shouldShowBanner: true,
        shouldShowList: true,
      };
    },
  });
}

/**
 * ★ Exported for the background push task (W10-b · 1.35e). ★
 *
 * A headless wake has NOT run `initNotifications()` — the app was killed, and
 * `TaskManager` loads the bundle to run one function. On API 26+ a notification
 * posted to a channel id that does not exist on the device is DROPPED by the OS:
 * no error, no fallback channel, nothing on screen. Channels survive app
 * restarts, so in practice they are already there — but "in practice" is not the
 * standard for the one code path whose entire job is to make a phone ring.
 * Idempotent, three cheap native calls, and it removes the failure mode.
 */
export async function ensureNotificationChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;

  await Notifications.setNotificationChannelAsync(CHANNEL_EMERGENCY, {
    name: 'Emergency alerts',
    description: 'Family emergencies. Plays on the alarm stream and bypasses Do Not Disturb.',
    importance: AndroidImportance.MAX,
    // ★ P-030 / §12.2: this is the whole point of the channel.
    bypassDnd: true,
    sound: 'default',
    audioAttributes: {
      usage: AndroidAudioUsage.ALARM,
      contentType: AndroidAudioContentType.SONIFICATION,
      flags: { enforceAudibility: true, requestHardwareAudioVideoSynchronization: false },
    },
    // PUBLIC, deliberately. The content is already lock-screen-safe by F-21
    // (short name + trigger class), and hiding it behind "Notification" on a
    // locked screen would cost seconds at the only moment they matter.
    lockscreenVisibility: AndroidNotificationVisibility.PUBLIC,
    vibrationPattern: [0, 400, 200, 400, 200, 800],
    enableVibrate: true,
    enableLights: true,
    lightColor: '#FF3B30',
    showBadge: false,
  });

  await Notifications.setNotificationChannelAsync(CHANNEL_PROBE, {
    name: 'Are you okay? checks',
    description: 'Quiet check-ins when something looks unusual. Never an alarm.',
    // LOW: a PROBE is a question, not an emergency. Escalating its importance is
    // how a system trains a family to ignore it (P-002, false-positive budget).
    importance: AndroidImportance.LOW,
    bypassDnd: false,
    sound: null,
    lockscreenVisibility: AndroidNotificationVisibility.PRIVATE,
    enableVibrate: true,
    vibrationPattern: [0, 120],
    showBadge: false,
  });

  await Notifications.setNotificationChannelAsync(CHANNEL_OWNERSHIP, {
    name: 'Someone is responding',
    description: 'Quiet updates when a family member takes charge of an emergency.',
    // DEFAULT, not HIGH: this must appear on the lock screen and in the shade
    // without taking over the screen. The alert it replaces already did that.
    importance: AndroidImportance.DEFAULT,
    bypassDnd: false,
    sound: null,
    // PUBLIC for the same reason the emergency channel is: the content is
    // lock-screen-safe by F-21 (a short name and a trigger class), and the whole
    // value of this banner is being readable by someone who is deciding right
    // now whether to pick up their keys.
    lockscreenVisibility: AndroidNotificationVisibility.PUBLIC,
    // No vibration. The siren has just stopped; buzzing undoes the message.
    enableVibrate: false,
    showBadge: false,
  });

  await Notifications.setNotificationChannelAsync(CHANNEL_HEALTH, {
    name: 'Safety chain health',
    description: 'Agent offline, degraded connectivity, and other honest status news.',
    importance: AndroidImportance.DEFAULT,
    bypassDnd: false,
    sound: null,
    lockscreenVisibility: AndroidNotificationVisibility.PRIVATE,
    enableVibrate: false,
    showBadge: false,
  });
}

async function ensureCategories(): Promise<void> {
  await Notifications.setNotificationCategoryAsync(CATEGORY_INCIDENT, [
    {
      identifier: ACTION_CLAIM,
      buttonTitle: t('panic.claim'),
      // Claiming is a commitment to go; it opens the app so the responder sees
      // the map and the medical card rather than firing blind from the shade.
      options: { opensAppToForeground: true },
    },
  ]);

  await Notifications.setNotificationCategoryAsync(CATEGORY_PROBE, [
    {
      identifier: ACTION_PROBE_FINE,
      buttonTitle: t('probe.fine'),
      // Answering "I'm fine" must cost one tap from the lock screen. Making the
      // user unlock to say nothing is wrong is how PROBE gets ignored.
      options: { opensAppToForeground: false },
    },
    {
      identifier: ACTION_PROBE_HELP,
      buttonTitle: t('probe.needHelp'),
      options: { opensAppToForeground: true },
    },
  ]);
}

let initialised = false;

/**
 * Idempotent. Returns whether we may actually post notifications — the caller
 * records it in the diagnostics report (P-031: `notificationsEnabled`), because
 * a safety app that cannot notify must say so out loud instead of assuming.
 */
export async function initNotifications(): Promise<boolean> {
  try {
    installNotificationHandler();

    const existing = await Notifications.getPermissionsAsync();
    let granted = existing.granted || existing.ios?.status === 2; // 2 = PROVISIONAL
    if (!granted && existing.canAskAgain !== false) {
      const asked = await Notifications.requestPermissionsAsync({
        ios: {
          allowAlert: true,
          allowBadge: false,
          allowSound: true,
          // Critical alerts are the iOS equivalent of STREAM_ALARM + bypassDnd.
          // The entitlement may not be granted; asking costs nothing and the
          // request degrades to a normal alert rather than failing.
          allowCriticalAlerts: true,
        },
      });
      granted = asked.granted;
    }

    if (!initialised) {
      await ensureNotificationChannels();
      await ensureCategories();
      initialised = true;
    }
    return granted;
  } catch {
    // Expo Go, a denied permission, or a device with notifications disabled.
    // The alarm, the screen and the SMS legs are all unaffected.
    return false;
  }
}

// ── Remote push registration (W10 · 1.35) ────────────────────────────────────

/**
 * ★ THE ADDRESS THAT LETS A CLOSED PHONE RING. ★
 *
 * Everything above this line is LOCAL presentation — it composes and shows text
 * on a phone that already knows about the incident. Learning about the incident
 * at all, with the app killed and the socket gone, requires the server to hold
 * this token. Until it did, the only leg left to another human was SMS.
 *
 * `getDevicePushTokenAsync` returns the NATIVE FCM token, deliberately not
 * `getExpoPushTokenAsync`. The Expo push service is a relay: it would put a
 * third party between an emergency and a family phone, and it needs network to
 * this app's Expo project at the exact moment the alert matters. The native
 * token addresses Google's fabric directly with our own credentials (ADR-015
 * scopes this to Android; iOS is not in scope, and this returns null there
 * rather than pretending).
 *
 * Fails soft, like everything else in this module: no permission, no Play
 * Services, no google-services.json in the build, or Expo Go — all return null.
 * A null is reported honestly up the chain and the alarm, the screen and the SMS
 * legs are unaffected.
 */
export async function acquireDevicePushToken(): Promise<string | null> {
  if (Platform.OS !== 'android') return null;
  try {
    const token = await Notifications.getDevicePushTokenAsync();
    if (token?.type !== 'android') return null;
    const data = token.data;
    return typeof data === 'string' && data.length > 0 ? data : null;
  } catch {
    // Missing Firebase config is the expected failure here, and it is the
    // deployment's problem to fix, not this call's to survive loudly.
    return null;
  }
}

/**
 * FCM rolls a token on reinstall, on restore-from-backup, and occasionally at
 * runtime with the app in the foreground. A rolled token is not an error and
 * produces no symptom — the old address simply stops delivering — so the only
 * defence is to notice the change and re-register immediately.
 */
export function subscribePushTokenChanges(onToken: (token: string) => void): () => void {
  if (Platform.OS !== 'android') return () => {};
  try {
    const sub = Notifications.addPushTokenListener((token) => {
      if (token?.type === 'android' && typeof token.data === 'string' && token.data.length > 0) {
        onToken(token.data);
      }
    });
    return () => {
      try {
        sub.remove();
      } catch {
        /* already removed */
      }
    };
  } catch {
    return () => {};
  }
}

// ── Responses (the half that makes the buttons real) ─────────────────────────

/**
 * ★ WITHOUT THIS, EVERY ACTION BUTTON ABOVE IS DECORATION. ★
 *
 * `ensureCategories()` registers three actions and nothing was listening for the
 * answers, which failed in three silent ways:
 *   · tapping the emergency alert did not open the incident — the responder
 *     landed on whatever screen was last shown;
 *   · "I AM RESPONDING" never called `claim()`, so the subject's screen kept
 *     saying nobody had responded while somebody demonstrably had;
 *   · worst, ACTION_PROBE_FINE is declared `opensAppToForeground: false` PRECISELY
 *     so "I'm fine" costs one tap from the lock screen. The notification
 *     dismissed, nothing was recorded, and 45 s later the PROBE timed out into a
 *     full family alarm for someone who had already answered. That is the exact
 *     false-positive spiral P-002 exists to prevent.
 *
 * The cold-start case matters as much as the warm one: a tap that LAUNCHES the
 * app delivers its response through `getLastNotificationResponseAsync`, not
 * through the listener, and dropping it means the responder opens Kavach to the
 * home screen with no idea why.
 */
export interface NotificationActions {
  claim(incidentId: UUID): void;
  probeRespond(incidentId: UUID, ok: boolean): void;
}

/**
 * Navigation lives here rather than in the store because this module is the one
 * that registered the categories, and honouring a response IS its job. The store
 * has no navigator and must not grow one.
 */
function openIncident(incidentId: UUID): void {
  try {
    router.push(`/incident/${incidentId}`);
  } catch {
    // The navigator may not be mounted yet on a cold launch. The claim or the
    // probe answer has already been applied, which is the part that matters.
  }
}

function incidentIdOf(response: Notifications.NotificationResponse): UUID | null {
  const data = response.notification.request.content.data as
    | { incidentId?: unknown }
    | null
    | undefined;
  const id = data?.incidentId;
  return typeof id === 'string' && id.length > 0 ? (id as UUID) : null;
}

function applyResponse(
  response: Notifications.NotificationResponse,
  actions: NotificationActions,
): void {
  const incidentId = incidentIdOf(response);
  if (incidentId === null) return;
  try {
    switch (response.actionIdentifier) {
      case ACTION_CLAIM:
        actions.claim(incidentId);
        openIncident(incidentId);
        break;
      case ACTION_PROBE_FINE:
        // ★ Deliberately no navigation. This is the one-tap-from-the-lock-screen
        //   answer; opening the app would defeat the whole reason the action is
        //   declared `opensAppToForeground: false`.
        actions.probeRespond(incidentId, true);
        break;
      case ACTION_PROBE_HELP:
        // "I need help" is not a timeout — the incident opens immediately, and
        // the subject should be looking at it, not at the shade.
        actions.probeRespond(incidentId, false);
        openIncident(incidentId);
        break;
      default:
        // Notifications.DEFAULT_ACTION_IDENTIFIER — the body was tapped.
        openIncident(incidentId);
    }
  } catch {
    // A failing action must not stop the next notification being handled.
  }
}

export function subscribeNotificationResponses(actions: NotificationActions): () => void {
  let live = true;

  // The launch-from-notification case. Resolved once, and only applied if the
  // subscription is still live by the time it comes back.
  void Notifications.getLastNotificationResponseAsync()
    .then((response) => {
      if (live && response) applyResponse(response, actions);
    })
    .catch(() => {
      /* Expo Go, or no launch response */
    });

  try {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      applyResponse(response, actions);
    });
    return () => {
      live = false;
      try {
        sub.remove();
      } catch {
        /* already removed */
      }
    };
  } catch {
    return () => {
      live = false;
    };
  }
}

/** Trigger class, in the family's language. Never the sealed detail. */
function scenarioLabel(trigger: TriggerType): string {
  // Same fallback as `ladderFor()` in policy.ts: an unrecognised trigger is
  // still an emergency, it is just an unlabelled one.
  return DEFAULT_POLICY.scenarios[trigger]?.label ?? trigger;
}

/**
 * ★ THE ALERT CONTRACT — the lock-screen-safe fields and nothing else. ★
 *
 * The subset of the F-21 payload an ALERT is composed from, which is why both
 * paths into `presentIncidentAlert` below take THIS and not an `Incident`: the
 * socket path holds a full decrypted incident and the push path holds a handful
 * of strings, and the alert a family sees must not depend on which one woke the
 * phone. Anything the push cannot carry is therefore something the alert must
 * not use. (`OwnershipAlertFields` is the same arrangement for a CLAIM.)
 *
 * Note what is absent and stays absent: location, the sealed note, the medical
 * card, and the duress flag (F-01).
 */
export interface IncidentAlertFields {
  incidentId: UUID;
  familyId: UUID;
  trigger: TriggerType;
  tier: 1 | 2 | 3;
  subjectShortName: string;
  /**
   * Known on the socket path, unknowable on the push path — the server does not
   * put it in the payload. `notifyIncidentFromPush` passes false, which is the
   * fail-SAFE direction: a drill shown as real costs one apology, a real
   * incident shown as "DRILL —" costs the thing this app exists to prevent.
   * In practice a drill usually carries `trigger: 'DRILL'`, which the title
   * renders as "Drill" anyway.
   */
  isDrill: boolean;
}

/**
 * ★ THE ONE PLACE AN INCIDENT BECOMES WORDS. ★ Both `notifyIncident` (socket,
 * app alive) and `notifyIncidentFromPush` (FCM, app killed) land here, so the
 * two paths cannot drift into telling the family two different stories.
 */
async function presentIncidentAlert(f: IncidentAlertFields): Promise<void> {
  const short = f.subjectShortName || 'Family';
  const drill = f.isDrill ? 'DRILL — ' : '';
  const title = `${drill}${short}: ${scenarioLabel(f.trigger)}`;

  // Escalating urgency, composed locally. Tier 3 says the quiet part out loud.
  const body =
    f.tier === 3
      ? `${t('state.ACTIVE_L3')} · ${t('panic.call112')}`
      : f.tier === 2
        ? `${t('state.ACTIVE_L2')} · ${t('panic.nobodyResponded')}`
        : t('panic.nobodyResponded');

  await present(incidentNotificationId(f.incidentId), CHANNEL_EMERGENCY, {
    title,
    body,
    data: {
      incidentId: f.incidentId,
      familyId: f.familyId,
      trigger: f.trigger,
      tier: f.tier,
      subjectShortName: short,
    },
    categoryIdentifier: CATEGORY_INCIDENT,
    sound: 'defaultCritical',
    // iOS: 'critical' breaks through the mute switch and Focus, matching the
    // Android alarm channel. Downgrades to 'timeSensitive' without the
    // entitlement rather than failing to deliver.
    interruptionLevel: f.isDrill ? 'timeSensitive' : 'critical',
    priority: 'max',
    color: '#FF3B30',
    // The family must dismiss it deliberately; an emergency should not be
    // swiped away by accident while the phone is in a pocket.
    sticky: !f.isDrill,
    autoDismiss: false,
    vibrate: [0, 400, 200, 400, 200, 800],
  });
}

async function present(
  identifier: string,
  channelId: string,
  content: Notifications.NotificationContentInput,
): Promise<void> {
  try {
    await Notifications.scheduleNotificationAsync({
      identifier,
      content,
      // A null trigger delivers immediately. Nothing about an emergency is
      // schedulable; `channelId` rides on the trigger on Android.
      trigger: Platform.OS === 'android' ? { channelId } : null,
    });
  } catch {
    // Fail soft — see the module header.
  }
}

/**
 * The L1/L2/L3 family alert.
 *
 * `subject` is the already-decrypted member record; pass null and the short name
 * falls back to whatever the incident itself carries. Note what is NOT here:
 * location, the sealed note, the medical card, and the duress flag.
 */
export async function notifyIncident(
  incident: Incident,
  tier: 1 | 2 | 3,
  subject?: Member | null,
): Promise<void> {
  await presentIncidentAlert({
    incidentId: incident.id,
    familyId: incident.familyId,
    trigger: incident.trigger,
    tier,
    subjectShortName: subject?.asciiShortName ?? 'Family',
    isDrill: incident.isDrill,
  });
}

/**
 * ★ W10-d · 1.32 — THE OTHER HALF OF THE LADDER: SOMEBODY IS GOING. ★
 *
 * §2.6.4 / P-030 correction 1. A CLAIM is the transition this whole coordination
 * design exists for — it converts "somebody should do something", which is how a
 * group of people all do nothing, into "Rohan is responding". On every phone
 * except the owner's it means: stop the siren, and say who.
 *
 * ★ Why this DISMISSES the alert instead of re-posting over it. ★ Replacing a
 * notification with one on a different Android channel is not a behaviour worth
 * betting a siren on — it cannot be verified from this checkout, and the failure
 * mode is a phone that keeps screaming. Dismiss, then post: two calls, no
 * assumptions, and the shade never holds both at once.
 *
 * `ownerShortName` empty is a real case, not a bug — a claim can arrive from a
 * member this device has no name for. `state.OWNED` covers it. It is weaker
 * copy on purpose rather than a guess at a name.
 */
export async function presentOwnershipBanner(f: OwnershipAlertFields): Promise<void> {
  const short = f.subjectShortName || 'Family';
  await clearIncident(f.incidentId);
  await present(ownershipNotificationId(f.incidentId), CHANNEL_OWNERSHIP, {
    title: `${short}: ${scenarioLabel(f.trigger)}`,
    body: f.ownerShortName
      ? t('panic.responding', { name: f.ownerShortName })
      : t('state.OWNED'),
    data: {
      incidentId: f.incidentId,
      familyId: f.familyId,
      trigger: f.trigger,
      // Tapping the banner opens the incident; there is no "I am responding"
      // action on it, because somebody already is.
      ownerShortName: f.ownerShortName,
    },
    sound: false,
    interruptionLevel: 'passive',
    color: '#FF3B30',
    // Persistent, NOT silence. It stays until the incident resolves and
    // `clearIncident` takes it down.
    sticky: true,
    autoDismiss: false,
  });
}

/**
 * The fields an ownership banner is composed from: the incident's own identity
 * plus the one name that matters. Same F-21 class as `IncidentAlertFields` —
 * everything here survives a lock screen.
 */
export interface OwnershipAlertFields {
  incidentId: UUID;
  familyId: UUID;
  trigger: TriggerType;
  subjectShortName: string;
  ownerShortName: string;
}

/**
 * The socket path's ownership banner. Takes the decrypted incident and the two
 * members, and lands in the same composer the push path uses.
 */
export async function notifyOwnership(
  incident: Incident,
  subject?: Member | null,
  owner?: Member | null,
): Promise<void> {
  await presentOwnershipBanner({
    incidentId: incident.id,
    familyId: incident.familyId,
    trigger: incident.trigger,
    subjectShortName: subject?.asciiShortName ?? 'Family',
    ownerShortName: owner?.asciiShortName ?? '',
  });
}

/**
 * ★ W10-b · 1.35e — THE SAME ALERT, WOKEN BY A PUSH INSTEAD OF A SOCKET. ★
 *
 * Called from the headless background task in `pushReceive.ts` when a data-only
 * FCM message arrives on a phone whose app is backgrounded or killed. The
 * fields have already been parsed and sanitised there; this function's only job
 * is to make the remote path and the local path produce byte-identical text,
 * because a family that learns to recognise one alert must not meet a second,
 * differently-worded one on the night the app happened to be closed.
 *
 * The identifier is derived from the incident id, so if the app later opens and
 * `notifyIncident` runs for the same incident, the OS REPLACES this notification
 * rather than stacking a duplicate.
 */
export async function notifyIncidentFromPush(
  fields: Omit<IncidentAlertFields, 'isDrill'>,
): Promise<void> {
  await presentIncidentAlert({ ...fields, isDrill: false });
}

/**
 * ★ W10-d · 1.32 — a CLAIM that arrived over FCM on a phone with no socket. ★
 *
 * This is the case the whole push transport exists for. The device that most
 * needs to hear "somebody is going" is the one whose app is closed, because it
 * is the one that cannot be told any other way — and until W10-d the server had
 * no way to say it, so that phone kept ringing.
 */
export async function notifyOwnershipFromPush(f: OwnershipAlertFields): Promise<void> {
  await presentOwnershipBanner(f);
}

/**
 * The PROBE prompt — "Are you okay?" — sent to the SUBJECT, not the family.
 * Quiet by construction: this is the low-confidence path whose entire purpose is
 * to resolve a suspicion without waking anybody (PRD §3.3, state PROBE).
 */
export async function notifyProbe(incident: Incident): Promise<void> {
  await present(probeNotificationId(incident.id), CHANNEL_PROBE, {
    title: t('probe.title'),
    body: t('probe.body'),
    data: {
      incidentId: incident.id,
      familyId: incident.familyId,
      trigger: incident.trigger,
      tier: 0,
      subjectShortName: '',
    },
    categoryIdentifier: CATEGORY_PROBE,
    sound: false,
    interruptionLevel: 'active',
    autoDismiss: true,
  });
}

/**
 * ★ FR-034 / PRD §16.3 — the single highest-value reliability feature.
 * A device that has stopped reporting is a silent failure; this is what converts
 * it into a visible one. It is NOT an alarm — nobody is in danger — so it rides
 * the health channel at default importance and says exactly what is wrong.
 */
export async function notifyAgentSilent(member: Member, hours: number): Promise<void> {
  const h = Math.max(1, Math.round(hours));
  await present(agentSilentNotificationId(member.id), CHANNEL_HEALTH, {
    title: `${CONFIG.appName}: ${member.asciiShortName}`,
    body: t('home.agentSilent', { name: member.displayName, hours: h }),
    data: { kind: 'agent_silent', memberId: member.id, hours: h },
    sound: false,
    interruptionLevel: 'active',
    autoDismiss: false,
  });
}

/**
 * P-046 / §4.4: tell the family the truth about which rung of the ladder they
 * are on. "SMS only" is a usable state; silently pretending to be fully
 * connected is not.
 */
export async function notifyDegraded(reason: string): Promise<void> {
  await present(DEGRADED_NOTIFICATION_ID, CHANNEL_HEALTH, {
    title: CONFIG.appName,
    body: reason,
    data: { kind: 'degraded', reason },
    sound: false,
    interruptionLevel: 'passive',
    autoDismiss: true,
  });
}

/**
 * Clear everything posted for an incident — the alert, any PROBE that preceded
 * it, and the ownership banner. Called when the incident resolves, is cancelled,
 * or turns out to be a false alarm; a stale emergency banner is its own small
 * betrayal of trust, and "Rohan is responding" left up after Rohan got there is
 * the same betrayal in a quieter voice.
 *
 * Note that `presentOwnershipBanner` calls this too, to take the siren down
 * before it posts. Clearing an id that is not presented is a no-op, so the
 * banner's own id being in this list costs nothing on that path.
 */
export async function clearIncident(id: UUID): Promise<void> {
  const ids = [
    incidentNotificationId(id),
    probeNotificationId(id),
    ownershipNotificationId(id),
  ];
  for (const identifier of ids) {
    try {
      await Notifications.dismissNotificationAsync(identifier);
    } catch {
      /* not currently presented */
    }
    try {
      await Notifications.cancelScheduledNotificationAsync(identifier);
    } catch {
      /* nothing scheduled */
    }
  }
}

/** Clear a health notice once the device comes back (FR-034's happy path). */
export async function clearAgentSilent(memberId: UUID): Promise<void> {
  try {
    await Notifications.dismissNotificationAsync(agentSilentNotificationId(memberId));
  } catch {
    /* not presented */
  }
}
