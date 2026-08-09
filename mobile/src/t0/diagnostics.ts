/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * T0 · SELF-DIAGNOSTICS   (P-031, P-034, FR-014)
 *
 * "The app is installed, the family believes they are protected, and one
 *  permission has been silently revoked. The system is dead and looks alive."
 *
 * Seven checks, plus the two fields that describe whether T0 itself can run at
 * all. Any false surfaces a red banner AND is reported to the server, which
 * raises a family-visible alert if it is still failing after 48 h (§6.4).
 *
 * ★ HONESTY RULE ★
 * Most of these have NO JavaScript API. In Expo Go we cannot determine them.
 * The temptation is to default them to `true` so the screen looks green — that
 * is precisely the failure this feature exists to prevent, so we do the
 * opposite: an undeterminable check is reported FALSE and listed by
 * `unknownChecks()` as "unknown, treated as degraded". The remediation card then
 * says so in words. A green tick that means "we did not look" is a lie that
 * gets someone killed at 2 a.m.
 *
 * Platform note: several checks describe Android-only mechanisms. On iOS there
 * is no OEM battery manager, no exact-alarm permission and no auto-revoke, so
 * reporting those as satisfied is accurate rather than optimistic; they are
 * marked `notApplicable` so the UI can grey them out instead of ticking them.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { Platform } from 'react-native';
import * as Battery from 'expo-battery';
import * as Device from 'expo-device';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import type { DiagnosticKey, DiagnosticsReport } from '../core/types';
import { checkDbHealth } from '../db/index';
import { checkPermissions, isNativeAvailable } from './native';

export const DIAGNOSTIC_KEYS: readonly DiagnosticKey[] = [
  't0Running',
  'dbHealthy',
  'batteryOptimisationExempt',
  'notBackgroundRestricted',
  'exactAlarmsPermitted',
  'notificationsEnabled',
  'dndBypassGranted',
  'bgLocationGranted',
  'autoRevokeDisabled',
  't0SigningAvailablePredawn',
  'nativeT0Present',
];

const LABELS: Record<DiagnosticKey, string> = {
  t0Running: 'The alarm is running on this phone',
  dbHealthy: 'This phone’s own records are readable',
  batteryOptimisationExempt: 'Battery optimisation exempt',
  notBackgroundRestricted: 'Background activity allowed',
  exactAlarmsPermitted: 'Exact alarms permitted',
  notificationsEnabled: 'Notifications enabled',
  dndBypassGranted: 'Can bypass Do Not Disturb',
  bgLocationGranted: 'Background location granted',
  autoRevokeDisabled: 'Permission auto-reset disabled',
  t0SigningAvailablePredawn: 'Emergency key works before unlock',
  nativeT0Present: 'Native survival module installed',
};

export function checkLabel(key: DiagnosticKey): string {
  return LABELS[key];
}

// ── OEM profiles (PRD Appendix B + §6.5) ──────────────────────────────────────

export interface OemProfile {
  key: string;
  label: string;
  /**
   * Intent component or action from PRD Appendix B. These change between OS
   * versions and are often not exported, so `native.openOemSettings()` returns
   * false rather than throwing and the UI falls back to the written steps.
   */
  deepLink?: string;
  /** Exact menu names for this manufacturer's skin (§6.5). */
  steps: string[];
}

const UNIVERSAL_FALLBACK = 'android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS';

const OEM_PROFILES: OemProfile[] = [
  {
    key: 'xiaomi',
    label: 'Xiaomi / Redmi / POCO (MIUI, HyperOS)',
    deepLink: 'com.miui.securitycenter/com.miui.permcenter.autostart.AutoStartManagementActivity',
    steps: [
      'Security app → Permissions → Autostart → turn ON for Kavach.',
      'Settings → Battery → Battery saver → Kavach → No restrictions.',
      'Open Recents, pull the Kavach card down and tap the padlock to lock it.',
      'Re-check after every MIUI update: battery saver resets itself weekly.',
    ],
  },
  {
    key: 'oppo',
    label: 'Oppo / Realme (ColorOS)',
    deepLink: 'com.coloros.safecenter/.permission.startup.StartupAppListActivity',
    steps: [
      'Settings → Battery → Kavach → Allow background activity.',
      'Settings → Battery → More → turn OFF "Sleep standby optimisation".',
      'Recents → lock the Kavach card.',
    ],
  },
  {
    key: 'vivo',
    label: 'Vivo / iQOO (Funtouch, OriginOS)',
    deepLink: 'com.iqoo.secure/.ui.phoneoptimize.BgStartUpManager',
    steps: [
      'iManager → App manager → Autostart → turn ON for Kavach.',
      'Settings → Battery → Background power consumption management → Kavach → High.',
      'Recents → lock the Kavach card.',
    ],
  },
  {
    key: 'huawei',
    label: 'Huawei / Honor (EMUI)',
    deepLink: 'com.huawei.systemmanager/.startupmgr.ui.StartupNormalAppListActivity',
    steps: [
      'Phone Manager → Startup manager → Kavach → Manage manually, all three switches ON.',
      'Settings → Battery → App launch → Kavach → Manage manually.',
    ],
  },
  {
    key: 'oneplus',
    label: 'OnePlus (OxygenOS)',
    deepLink: 'com.oneplus.security/.chainlaunch.view.ChainLaunchAppListActivity',
    steps: [
      'Settings → Battery → Battery optimisation → Kavach → Don’t optimise.',
      'Settings → Apps → Kavach → Battery → Allow background activity.',
      'Recents → lock the Kavach card.',
    ],
  },
  {
    key: 'samsung',
    label: 'Samsung (One UI)',
    deepLink: 'android.settings.APPLICATION_DETAILS_SETTINGS',
    steps: [
      'Settings → Battery → Background usage limits → Never sleeping apps → add Kavach.',
      'Settings → Battery → Background usage limits → turn OFF "Put unused apps to sleep".',
      'Settings → Apps → Kavach → Battery → Unrestricted.',
    ],
  },
  {
    key: 'generic',
    label: 'Android',
    deepLink: UNIVERSAL_FALLBACK,
    steps: [
      'Settings → Apps → Kavach → Battery → Unrestricted.',
      'Settings → Apps → Kavach → turn OFF "Pause app activity if unused".',
    ],
  },
];

/**
 * Match on manufacturer AND brand: a POCO reports brand "POCO" with
 * manufacturer "Xiaomi", and a Realme reports manufacturer "realme" on some
 * builds and "OPPO" on others.
 */
export function oemProfile(): OemProfile {
  if (Platform.OS !== 'android') {
    return {
      key: 'ios',
      label: 'iOS',
      steps: [
        'Settings → Kavach → Location → Always.',
        'Settings → Notifications → Kavach → Allow Notifications, and enable Critical Alerts if offered.',
        'Settings → General → Background App Refresh → ON.',
      ],
    };
  }
  const id = `${Device.manufacturer ?? ''} ${Device.brand ?? ''}`.toLowerCase();
  const match = (...needles: string[]) => needles.some((n) => id.includes(n));
  if (match('xiaomi', 'redmi', 'poco')) return OEM_PROFILES[0];
  if (match('oppo', 'realme')) return OEM_PROFILES[1];
  if (match('vivo', 'iqoo')) return OEM_PROFILES[2];
  if (match('huawei', 'honor')) return OEM_PROFILES[3];
  if (match('oneplus')) return OEM_PROFILES[4];
  if (match('samsung')) return OEM_PROFILES[5];
  return OEM_PROFILES[6];
}

// ── The self-check ────────────────────────────────────────────────────────────

const ANDROID_ONLY: ReadonlySet<DiagnosticKey> = new Set<DiagnosticKey>([
  'batteryOptimisationExempt',
  'notBackgroundRestricted',
  'exactAlarmsPermitted',
  'autoRevokeDisabled',
]);

let unknown: DiagnosticKey[] = [];
let lastReport: DiagnosticsReport | null = null;

export function emptyReport(): DiagnosticsReport {
  return {
    t0Running: false,
    dbHealthy: false,
    batteryOptimisationExempt: false,
    notBackgroundRestricted: false,
    exactAlarmsPermitted: false,
    notificationsEnabled: false,
    dndBypassGranted: false,
    bgLocationGranted: false,
    autoRevokeDisabled: false,
    t0SigningAvailablePredawn: false,
    nativeT0Present: false,
    lastCheckedAt: 0,
  };
}

/**
 * Whether the T0 incident machine is running.
 *
 * Injected rather than imported: `t0/diagnostics` must not reach into
 * `t0/triggerRouter` (the router imports half of T0 and the self-check runs from
 * a settings screen), and the store is the only thing that knows whether
 * `initT0` actually resolved. Defaults to reporting NOT running, which is the
 * honest answer before anybody has said otherwise.
 */
let t0RunningProbe: (() => boolean) | null = null;

export function setT0RunningProbe(fn: (() => boolean) | null): void {
  t0RunningProbe = fn;
}

/**
 * Run all nine checks. Never throws and never leaves a spinner: every probe is
 * individually guarded, and a probe that fails contributes "unknown → false".
 */
export async function runSelfCheck(): Promise<DiagnosticsReport> {
  const report = emptyReport();
  const undetermined = new Set<DiagnosticKey>(DIAGNOSTIC_KEYS);
  const settle = (key: DiagnosticKey, value: boolean) => {
    report[key] = value;
    undetermined.delete(key);
  };

  settle('nativeT0Present', isNativeAvailable());

  // ★ The two checks that would have caught a dead panic button. Every other
  //   probe below asks the OS about a permission; these two ask whether OUR OWN
  //   safety chain came up, which is the failure the diagnostics screen was
  //   reporting as healthy.
  if (t0RunningProbe !== null) {
    try {
      settle('t0Running', t0RunningProbe());
    } catch {
      // Undetermined → reported false, which is the honest reading.
    }
  }

  try {
    const health = await checkDbHealth();
    settle(
      'dbHealthy',
      health.integrityOk &&
        health.missingTables.length === 0 &&
        health.userVersion >= health.expectedVersion,
    );
  } catch {
    // A database we cannot even interrogate is not a healthy one.
    settle('dbHealthy', false);
  }

  // Non-Android platforms genuinely do not have these mechanisms.
  if (Platform.OS !== 'android') {
    for (const key of ANDROID_ONLY) settle(key, true);
  }

  // 1. Notifications — the one check with a first-class JS API everywhere.
  try {
    const perms = await Notifications.getPermissionsAsync();
    settle(
      'notificationsEnabled',
      perms.granted ||
        perms.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL,
    );
    // 2. DND bypass. On iOS this is exactly the critical-alerts entitlement.
    if (Platform.OS === 'ios' && typeof perms.ios?.allowsCriticalAlerts === 'boolean') {
      settle('dndBypassGranted', perms.ios.allowsCriticalAlerts);
    }
  } catch {
    // Leave both undetermined.
  }

  // 3. Background location.
  try {
    const bg = await Location.getBackgroundPermissionsAsync();
    settle('bgLocationGranted', bg.granted);
  } catch {
    // Undetermined.
  }

  // 4. Battery optimisation — expo-battery answers this on Android without any
  //    native module of ours, which makes it the most valuable free check here.
  if (Platform.OS === 'android') {
    try {
      const optimised = await Battery.isBatteryOptimizationEnabledAsync();
      settle('batteryOptimisationExempt', optimised === false);
    } catch {
      // Undetermined.
    }
  }

  // 5–9. Everything else needs the native module. A partial answer is fine:
  //      keys it does not return stay undetermined rather than defaulting true.
  try {
    const nativeReport = await checkPermissions();
    for (const key of DIAGNOSTIC_KEYS) {
      const v = nativeReport[key];
      if (typeof v === 'boolean') settle(key, v);
    }
  } catch {
    // Undetermined.
  }

  // ★ The honesty step: anything still undetermined is reported as failing.
  unknown = DIAGNOSTIC_KEYS.filter((k) => undetermined.has(k));
  report.lastCheckedAt = Date.now();
  lastReport = report;
  return report;
}

/** Keys we could not actually determine on this build. Reported false. */
export function unknownChecks(): readonly DiagnosticKey[] {
  return unknown;
}

export function lastSelfCheck(): DiagnosticsReport | null {
  return lastReport;
}

/** Not applicable on this platform — render greyed out, not red. */
export function notApplicable(key: DiagnosticKey): boolean {
  return Platform.OS !== 'android' && ANDROID_ONLY.has(key);
}

export function failingChecks(report: DiagnosticsReport): DiagnosticKey[] {
  return DIAGNOSTIC_KEYS.filter((k) => report[k] !== true);
}

/** FR-014: the weekly cadence. True when the report is stale enough to re-run. */
export function isStale(report: DiagnosticsReport, now: number = Date.now()): boolean {
  return now - report.lastCheckedAt > 7 * 24 * 60 * 60_000;
}

// ── Remediation ───────────────────────────────────────────────────────────────

export interface Remediation {
  title: string;
  steps: string[];
  deepLink?: string;
}

const UNKNOWN_NOTE =
  'This build cannot read this setting, so it is shown as failing. Install the full Kavach build (not Expo Go) to see the real state.';

/**
 * What the user must actually do, in the exact words of their phone's menus.
 * §17.2's 3 a.m. runbook reads straight off this: "Read the failures → Appendix
 * B deep link for that OEM."
 */
export function remediationFor(key: DiagnosticKey): Remediation {
  const oem = oemProfile();
  const isUnknown = unknown.includes(key);
  const withNote = (steps: string[]): string[] => (isUnknown ? [...steps, UNKNOWN_NOTE] : steps);

  switch (key) {
    case 't0Running':
      return {
        title: 'The alarm is not running on this phone',
        steps: [
          'Kavach started, but the part that raises the alarm did not. The panic button will not call anyone.',
          'Close Kavach completely and open it again.',
          'If this row is still red after restarting, the phone is out of storage or its records are damaged — free some space, then reinstall Kavach.',
        ],
      };

    case 'dbHealthy':
      return {
        title: 'This phone’s own records cannot be read',
        steps: [
          'Kavach keeps your family’s incident history on this phone. Right now it cannot open or trust that store.',
          'The usual cause is a full disk. Free up space and restart Kavach.',
          'If it stays red, reinstall Kavach. You will lose this phone’s history, and the alarm will work again.',
        ],
        deepLink: 'android.settings.APPLICATION_DETAILS_SETTINGS',
      };

    case 'batteryOptimisationExempt':
      return {
        title: 'Battery optimisation is switched on',
        steps: withNote([
          `Your phone (${oem.label}) will kill Kavach in the background while this is on.`,
          ...oem.steps,
        ]),
        deepLink: oem.deepLink ?? UNIVERSAL_FALLBACK,
      };

    case 'notBackgroundRestricted':
      return {
        title: 'Background activity is restricted',
        steps: withNote([
          'Settings → Apps → Kavach → Battery → Unrestricted.',
          ...oem.steps,
        ]),
        deepLink: 'android.settings.APPLICATION_DETAILS_SETTINGS',
      };

    case 'exactAlarmsPermitted':
      return {
        title: 'Exact alarms are not permitted',
        steps: withNote([
          'Without this the 15-minute self-watchdog cannot fire through Doze, so a dead agent goes unnoticed.',
          'Settings → Apps → Special app access → Alarms & reminders → Kavach → Allow.',
        ]),
        deepLink: 'android.settings.REQUEST_SCHEDULE_EXACT_ALARM',
      };

    case 'notificationsEnabled':
      return {
        title: 'Notifications are switched off',
        steps: withNote([
          'You will not be told when someone in your family needs help.',
          'Settings → Apps → Kavach → Notifications → allow all categories.',
          'Make sure the "Emergency" channel is not set to Silent.',
        ]),
        deepLink: 'android.settings.APP_NOTIFICATION_SETTINGS',
      };

    case 'dndBypassGranted':
      return {
        title: 'Kavach cannot get through Do Not Disturb',
        steps: withNote([
          'At night your phone is on Do Not Disturb. Without this, an emergency alert is silent.',
          Platform.OS === 'ios'
            ? 'Settings → Notifications → Kavach → turn on Critical Alerts, and add Kavach to your Focus allow-list.'
            : 'Settings → Sound → Do Not Disturb → App notifications / Apps → add Kavach.',
        ]),
        deepLink:
          Platform.OS === 'ios'
            ? undefined
            : 'android.settings.NOTIFICATION_POLICY_ACCESS_SETTINGS',
      };

    case 'bgLocationGranted':
      return {
        title: 'Background location is not granted',
        steps: withNote([
          'Without "Allow all the time", your location stops being available the moment the screen locks.',
          'Settings → Apps → Kavach → Permissions → Location → Allow all the time.',
          'Android asks for this in two steps (P-040): grant "While using the app" first, then change it to "All the time".',
        ]),
        deepLink: 'android.settings.APPLICATION_DETAILS_SETTINGS',
      };

    case 'autoRevokeDisabled':
      return {
        title: 'Android will reset Kavach’s permissions if unused',
        steps: withNote([
          'A phone that is not opened for a few months loses every permission silently — this is P-034, and it is the reason a system can be dead for weeks.',
          'Settings → Apps → Kavach → turn OFF "Pause app activity if unused" / "Remove permissions if app is unused".',
        ]),
        deepLink: 'android.settings.APPLICATION_DETAILS_SETTINGS',
      };

    case 't0SigningAvailablePredawn':
      return {
        title: 'The emergency signing key needs an unlock first',
        steps: withNote([
          'After a reboot at 2 a.m., before anyone has unlocked the phone, Kavach must still be able to sign and send. That needs a key created without biometric or unlock requirements (F-17).',
          'This is fixed by installing the full Kavach build, which creates the emergency key in device-protected storage.',
          'Reboot the phone and re-run this check without unlocking to confirm.',
        ]),
      };

    case 'nativeT0Present':
      return {
        title: 'The native survival module is not installed',
        steps: [
          'You are running the JavaScript-only build (Expo Go or a web preview).',
          'Silent multi-SIM SMS, the torch, alarm-stream volume, Device Owner checks and the pre-unlock foreground service all require the native build.',
          'The alarm, the state machine, the black box and the HTTP transports still work.',
          'Install the development or production build to close this gap.',
        ],
      };
  }
}
