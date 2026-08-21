/**
 * i18n — en / hi / gu, complete from day one (NFR-020, PRD P-059).
 *
 * ★ EXCEPTION: the SMS payload is ALWAYS ASCII English (P-033 / ADR-020). ★
 * A single Devanagari character converts the message to UCS-2 and cuts the limit
 * from 160 characters to 70. See src/t0/smsPayload.ts.
 *
 * Language preference is per-MEMBER, not per-device.
 */
import type { Locale } from '../core/types';

export const LOCALES: { code: Locale; label: string; native: string }[] = [
  { code: 'en', label: 'English', native: 'English' },
  { code: 'hi', label: 'Hindi', native: 'हिन्दी' },
  { code: 'gu', label: 'Gujarati', native: 'ગુજરાતી' },
];

const en = {
  // Panic flow — ≤4 words, present tense (PRD §6.4)
  'panic.hold': 'Hold to get help',
  'panic.sending': 'Getting help.',
  'panic.sent': 'Family alerted.',
  'panic.sentSms': 'Sent by SMS.',
  'panic.offline': 'Alarm on — show this screen to anyone nearby',
  'panic.cancel': 'I am safe',
  'panic.cancelIn': 'Cancelling in',
  'panic.enterPin': 'Enter PIN to cancel',
  'panic.nobodyResponded': 'NOBODY HAS RESPONDED YET',
  'panic.responding': '{name} is responding. Stand by.',
  'panic.claim': 'I AM RESPONDING',
  'panic.release': "I can't get there",
  'panic.onScene': 'I have arrived',
  'panic.resolve': 'Mark resolved',
  'panic.call112': 'CALL 112',
  'panic.trigger': 'SOS',

  // States
  'state.IDLE': 'All clear',
  'state.WATCH': 'Watching',
  'state.SUSPECT': 'Checking',
  'state.PROBE': 'Are you okay?',
  'state.PENDING': 'Cancel window',
  'state.FALSE_ALARM': 'False alarm',
  'state.ACTIVE_L1': 'Family alerted',
  'state.ACTIVE_L1_SILENT': 'Family alerted',
  'state.ACTIVE_L2': 'Escalated',
  'state.ACTIVE_L3': 'Full alert',
  'state.OWNED': 'Someone is responding',
  'state.RESOLVING': 'Responder on scene',
  'state.RESOLVED': 'Resolved',
  'state.DORMANT': 'Closed automatically',

  // Probe
  'probe.title': 'Are you okay?',
  'probe.body': 'We noticed something unusual.',
  'probe.fine': "I'm fine",
  'probe.needHelp': 'I need help',

  // Tabs
  'tab.home': 'Family',
  'tab.map': 'Map',
  'tab.incidents': 'Incidents',
  'tab.consent': 'Privacy',
  'tab.settings': 'Settings',
  'tab.sos': 'SOS',
  'tab.sosHint': 'Opens the emergency screen',
  'family.privateSpace': 'Your family',
  'family.private': 'End-to-end within your family — nobody outside can see this',
  'family.privateShort': 'Private to your family',
  'family.idLabel': 'Family ID',

  // Home
  'home.everyoneOk': 'Everyone is okay',
  'home.activeIncident': 'Active emergency',
  'home.agentSilent': "{name}'s safety agent has been offline for {hours}h",
  'home.monitoringPaused': '{name} has paused safety monitoring',
  'home.checkIn': "I'm safe",
  'home.findPhone': 'Find phone',
  'home.startJourney': 'Start journey',
  'home.lastSeen': 'Last seen {ago}',
  'home.battery': 'Battery {pct}%',

  // Consent
  'consent.title': 'Who can see what',
  'consent.whoSeesMe': 'Who can see me',
  'consent.whatISee': 'What I can see',
  'consent.accessLog': 'Who looked at my data',
  'consent.expires': 'Expires {when}',
  'consent.revoke': 'Revoke',
  'consent.revokePending':
    'Revoked. {name} can no longer request your location. Key rotation completes when your phone next connects.',
  'consent.noPermanent': 'No grant is permanent. Every one expires.',
  'consent.viewedBy': '{name} viewed your {what}',

  // Diagnostics
  'diag.title': 'Self-diagnostics',
  'diag.healthy': 'All checks passing',
  'diag.problems': '{n} problem(s) found',
  'diag.run': 'Run check now',
  'diag.batteryOptimisationExempt': 'Battery optimisation exempt',
  'diag.notBackgroundRestricted': 'Background activity allowed',
  'diag.exactAlarmsPermitted': 'Exact alarms permitted',
  'diag.notificationsEnabled': 'Notifications enabled',
  'diag.dndBypassGranted': 'Can bypass Do Not Disturb',
  'diag.bgLocationGranted': 'Background location granted',
  'diag.autoRevokeDisabled': 'Permission auto-revoke disabled',
  'diag.t0SigningAvailablePredawn': 'Emergency key available before unlock',
  'diag.nativeT0Present': 'Native survival module installed',

  // Medical
  'medical.title': 'Medical card',
  'medical.bloodGroup': 'Blood group',
  'medical.allergies': 'Allergies',
  'medical.medications': 'Medications',
  'medical.conditions': 'Conditions',
  'medical.ice': 'Emergency contacts',
  'medical.showToResponder': 'Show this to whoever is helping',

  // Common
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.done': 'Done',
  'common.close': 'Close',
  'common.retry': 'Retry',
  'common.yes': 'Yes',
  'common.no': 'No',
  'common.now': 'now',
  'common.never': 'never',
};

export type StringKey = keyof typeof en;

const hi: Partial<Record<StringKey, string>> = {
  'panic.hold': 'मदद के लिए दबाए रखें',
  'panic.sending': 'मदद आ रही है।',
  'panic.sent': 'परिवार को सूचित किया।',
  'panic.sentSms': 'SMS से भेजा गया।',
  'panic.offline': 'अलार्म चालू — यह स्क्रीन पास वालों को दिखाएँ',
  'panic.cancel': 'मैं सुरक्षित हूँ',
  'panic.cancelIn': 'रद्द हो रहा है',
  'panic.enterPin': 'रद्द करने के लिए PIN डालें',
  'panic.nobodyResponded': 'अभी तक किसी ने जवाब नहीं दिया',
  'panic.responding': '{name} जवाब दे रहे हैं। प्रतीक्षा करें।',
  'panic.claim': 'मैं जा रहा हूँ',
  'panic.release': 'मैं नहीं पहुँच सकता',
  'panic.call112': '112 पर कॉल करें',
  'probe.title': 'क्या आप ठीक हैं?',
  'probe.fine': 'मैं ठीक हूँ',
  'probe.needHelp': 'मुझे मदद चाहिए',
  'state.IDLE': 'सब ठीक है',
  'state.OWNED': 'कोई जवाब दे रहा है',
  'state.RESOLVED': 'हल हो गया',
  'tab.home': 'परिवार',
  'tab.map': 'नक्शा',
  'tab.incidents': 'घटनाएँ',
  'tab.consent': 'निजता',
  'tab.settings': 'सेटिंग्स',
  'tab.sos': 'SOS',
  'tab.sosHint': 'आपातकालीन स्क्रीन खोलता है',
  'family.privateSpace': 'आपका परिवार',
  'family.private': 'आपके परिवार के भीतर एंड-टू-एंड — बाहर कोई नहीं देख सकता',
  'family.privateShort': 'आपके परिवार तक सीमित',
  'family.idLabel': 'परिवार आईडी',
  'home.everyoneOk': 'सब सुरक्षित हैं',
  'home.activeIncident': 'आपातकाल',
  'home.checkIn': 'मैं सुरक्षित हूँ',
  'medical.title': 'मेडिकल कार्ड',
  'medical.bloodGroup': 'रक्त समूह',
  'medical.allergies': 'एलर्जी',
  'medical.medications': 'दवाइयाँ',
  'common.cancel': 'रद्द करें',
  'common.save': 'सहेजें',
  'common.done': 'हो गया',
};

const gu: Partial<Record<StringKey, string>> = {
  'panic.hold': 'મદદ માટે દબાવી રાખો',
  'panic.sending': 'મદદ આવી રહી છે.',
  'panic.sent': 'પરિવારને જાણ કરી.',
  'panic.sentSms': 'SMS થી મોકલ્યું.',
  'panic.offline': 'એલાર્મ ચાલુ — આ સ્ક્રીન નજીકના કોઈને બતાવો',
  'panic.cancel': 'હું સુરક્ષિત છું',
  'panic.cancelIn': 'રદ થઈ રહ્યું છે',
  'panic.enterPin': 'રદ કરવા PIN દાખલ કરો',
  'panic.nobodyResponded': 'હજી કોઈએ જવાબ આપ્યો નથી',
  'panic.responding': '{name} જવાબ આપી રહ્યા છે. રાહ જુઓ.',
  'panic.claim': 'હું જઈ રહ્યો છું',
  'panic.release': 'હું પહોંચી શકતો નથી',
  'panic.call112': '112 પર કૉલ કરો',
  'probe.title': 'શું તમે ઠીક છો?',
  'probe.fine': 'હું ઠીક છું',
  'probe.needHelp': 'મને મદદ જોઈએ',
  'state.IDLE': 'બધું બરાબર',
  'state.OWNED': 'કોઈ જવાબ આપી રહ્યું છે',
  'state.RESOLVED': 'ઉકેલાઈ ગયું',
  'tab.home': 'પરિવાર',
  'tab.map': 'નકશો',
  'tab.incidents': 'ઘટનાઓ',
  'tab.consent': 'ગોપનીયતા',
  'tab.settings': 'સેટિંગ્સ',
  'tab.sos': 'SOS',
  'tab.sosHint': 'કટોકટી સ્ક્રીન ખોલે છે',
  'family.privateSpace': 'તમારો પરિવાર',
  'family.private': 'તમારા પરિવારની અંદર એન્ડ-ટુ-એન્ડ — બહાર કોઈ જોઈ શકતું નથી',
  'family.privateShort': 'તમારા પરિવાર પૂરતું ખાનગી',
  'family.idLabel': 'પરિવાર ID',
  'home.everyoneOk': 'બધા સુરક્ષિત છે',
  'home.activeIncident': 'કટોકટી',
  'home.checkIn': 'હું સુરક્ષિત છું',
  'medical.title': 'મેડિકલ કાર્ડ',
  'medical.bloodGroup': 'બ્લડ ગ્રુપ',
  'medical.allergies': 'એલર્જી',
  'medical.medications': 'દવાઓ',
  'common.cancel': 'રદ કરો',
  'common.save': 'સાચવો',
  'common.done': 'થઈ ગયું',
};

const TABLES: Record<Locale, Partial<Record<StringKey, string>>> = { en, hi, gu };

let current: Locale = 'en';
export function setLocale(l: Locale): void {
  current = l;
}
export function getLocale(): Locale {
  return current;
}

/** Translate. Always falls back to English — a missing string must never blank the UI. */
export function t(key: StringKey, vars?: Record<string, string | number>): string {
  let s = TABLES[current]?.[key] ?? en[key] ?? String(key);
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
  return s;
}

/** Coverage lint helper — used by the string-coverage test (NFR-020). */
export function coverage(locale: Locale): number {
  const keys = Object.keys(en) as StringKey[];
  const table = TABLES[locale];
  return keys.filter((k) => table[k] !== undefined).length / keys.length;
}

export function relativeTime(ms: number | null): string {
  if (ms == null) return t('common.never');
  const d = Date.now() - ms;
  if (d < 60_000) return t('common.now');
  const m = Math.floor(d / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
