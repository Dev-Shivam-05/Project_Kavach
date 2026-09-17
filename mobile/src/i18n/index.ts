/**
 * i18n — en / hi / gu, complete from day one (NFR-020, PRD P-059).
 *
 * ★ EXCEPTION: the SMS payload is ALWAYS ASCII English (P-033 / ADR-020). ★
 * A single Devanagari character converts the message to UCS-2 and cuts the limit
 * from 160 characters to 70. See src/t0/smsPayload.ts.
 *
 * Language preference is per-MEMBER, not per-device.
 *
 * ★ "COMPLETE" IS ENFORCED, NOT CLAIMED ★
 * `test/i18n-coverage.test.ts` fails `npm test` the moment a key exists in `en`
 * and not in `hi` or `gu`, or a hi/gu value is left as the English string. The
 * header above used to say "complete from day one" while 53 of 101 keys were
 * missing from both tables and `t()` hid it behind its English fallback; the
 * fallback is still there — a missing string must never blank a screen — but
 * it no longer gets to be silent.
 */
import { DegradationLevel, type Locale } from '../core/types';

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
  'tab.watch': 'Watch',
  'tab.map': 'Map',
  'tab.incidents': 'Incidents',
  'tab.consent': 'Privacy',
  'tab.settings': 'Settings',
  'tab.sos': 'SOS',
  'tab.sosHint': 'Opens the emergency screen',
  /** Spoken after the Incidents tab label when the badge is showing. A count, not a headline. */
  'tab.unacked': '{n} with no response yet',
  'watch.subtitle': 'Where everyone is, at a glance — the same rule as Map: no grant, no position.',
  'family.privateSpace': 'Your family',
  'family.private': 'End-to-end within your family — nobody outside can see this',
  'family.privateShort': 'Private to your family',
  'family.idLabel': 'Family ID',
  'family.createTitle': 'Name your family',
  'family.createSubtitle': 'Give your family a name and set how many people can join. This space is private to your family.',
  'family.name': 'Family name',
  'family.namePlaceholder': 'e.g. Sharma family',
  'family.size': 'Family size',
  'family.sizeHint': 'How many people can be in this family (2 to 20).',
  'family.save': 'Save',

  // Home
  'home.everyoneOk': 'Everyone is okay',
  'home.activeIncident': 'Active emergency',
  'home.agentSilent': "{name}'s safety agent has been offline for {hours}h",
  'home.monitoringPaused': '{name} has paused safety monitoring',
  'home.checkIn': "I'm safe",
  'home.checkedIn': 'Checked in {ago}',
  'home.findPhone': 'Find phone',
  'home.startJourney': 'Start journey',
  'home.lastSeen': 'Last seen {ago}',
  'home.battery': 'Battery {pct}%',
  'home.noMembersTitle': 'No family members yet',
  'home.noMembersBody': 'Nobody has been enrolled on this device. Add a phone to start looking after each other.',
  'home.addPhone': 'Add a phone to this family',
  'home.opensTimeline': 'Opens the responder timeline',

  // Family Watch — the WATCHED person's indicator (D2/D3/E3) and the viewer's tab
  'watch.someone': 'Someone in your family',
  'watch.viewingCamera': '{name} is viewing your camera',
  'watch.listening': '{name} is listening',
  'watch.stop': 'Stop',
  'watch.stopHint': 'Stop this now',
  'watch.noConnectionTitle': 'No connection',
  'watch.noConnectionBody':
    'This phone is not connected right now, so the request cannot reach their phone. Nothing was sent.',
  'watch.refreshFailed': 'Could not send the request — check the connection.',
  'watch.nobodyElseTitle': 'Nobody else has joined yet',
  'watch.nobodyElseBody': 'Add a phone to this family and it appears here.',

  // Member rows
  'member.noData': 'No data',
  'member.agentOffline': 'Agent offline',
  'member.opensDetails': "Opens this person's details",

  // Degradation ladder (§4.4) — the rung's name, and what it costs the user
  'net.zeroInfra': 'Offline — alarm only',
  'net.peerOnly': 'Peer only',
  'net.smsOnly': 'SMS only',
  'net.pushOnly': 'Push only',
  'net.limited': 'Limited connection',
  'net.full': 'Fully connected',
  'net.zeroInfraDetail': 'No network at all. The alarm still sounds on this phone.',
  'net.peerOnlyDetail': 'No network. Family devices nearby can still relay.',
  'net.smsOnlyDetail': 'Data is down. Emergencies will go out by SMS.',
  'net.limitedDetail': 'Connection limited.',

  // Map
  'map.paused': 'Monitoring paused',
  'map.notShared': 'Location not shared',
  'map.nothingToMap': 'Nothing to map',
  'map.noMembers': 'No family members yet.',
  'map.nobodySharing': 'Nobody is sharing a live location right now.',
  'map.notOnMap': 'Not on the map',
  'map.pinLabel': '{name}, last fix {ago}, accurate to about {m} metres',
  'map.addFence': 'Add a fence',
  'map.addFenceHint': 'Add a fence around where you are, or around a location you type',
  'map.noFencesTitle': 'No fences yet',
  'map.noFencesBody': 'Add one around where you are standing, or type a location. It stays on this phone.',
  'map.modeHere': 'Where I am now',
  'map.modeTyped': 'Type a location',
  'map.fenceNotSavedTitle': 'Fence not saved',
  'map.fenceNoProfile': 'This phone has no profile yet, so there is nobody to attach a fence to.',
  'map.fenceNoFix': 'This phone has no position fix. Choose “Type a location” instead.',

  // Coordinates (the L0 floor)
  'coords.noMapsApp': 'No maps app on this phone. Read the numbers aloud.',
  'coords.copied': 'Coordinates copied.',
  'coords.accuracy': 'Accurate to about {m} m',
  'coords.latitude': 'Latitude {value}',
  'coords.longitude': 'Longitude {value}',
  'coords.openInMaps': 'Open in maps',
  'coords.openInMapsHint': 'Open these coordinates in a maps app',
  'coords.copy': 'Copy',
  'coords.copyHint': 'Copy coordinates as text',

  // 112 hand-off (ADR-019)
  'call112.hint': 'Opens the phone dialler with 112 entered. You press call.',
  'call112.failed': 'Dialler did not open. Dial 112 by hand.',

  // The cancel countdown
  'countdown.secondsLeftToCancel': '{n} seconds left to cancel',

  // Relative time
  'time.minutesAgo': '{n}m ago',
  'time.hoursAgo': '{n}h ago',
  'time.daysAgo': '{n}d ago',

  // Native header titles for root-Stack screens
  'screen.incident': 'Incident',
  'screen.documents': 'Documents',
  'screen.screenTime': 'Screen time',
  'screen.journeys': 'Journeys',
  'screen.drills': 'Drills',

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

/**
 * Keys whose value is legitimately identical in every language — "SOS" is the
 * international distress token and is not translated. The coverage test reads
 * this list; anything else that matches English in hi/gu fails the build.
 */
export const UNTRANSLATED_KEYS: readonly StringKey[] = ['panic.trigger', 'tab.sos'];

// Full tables, not Partial: a key missing from either one is a compile error,
// which is the cheapest possible coverage lint. `satisfies` keeps the literal
// key set checked without widening the values.
const hi = {
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
  'panic.onScene': 'मैं पहुँच गया हूँ',
  'panic.resolve': 'हल हुआ चिह्नित करें',
  'panic.call112': '112 पर कॉल करें',
  'panic.trigger': 'SOS',

  'state.IDLE': 'सब ठीक है',
  'state.WATCH': 'निगरानी में',
  'state.SUSPECT': 'जाँच हो रही है',
  'state.PROBE': 'क्या आप ठीक हैं?',
  'state.PENDING': 'रद्द करने का समय',
  'state.FALSE_ALARM': 'झूठा अलार्म',
  'state.ACTIVE_L1': 'परिवार को सूचित किया',
  // F-01: identical to ACTIVE_L1 in every language — the duress path must not
  // be distinguishable on screen.
  'state.ACTIVE_L1_SILENT': 'परिवार को सूचित किया',
  'state.ACTIVE_L2': 'आगे बढ़ाया गया',
  'state.ACTIVE_L3': 'पूर्ण अलर्ट',
  'state.OWNED': 'कोई जवाब दे रहा है',
  'state.RESOLVING': 'मददगार पहुँच गया',
  'state.RESOLVED': 'हल हो गया',
  'state.DORMANT': 'अपने आप बंद हुआ',

  'probe.title': 'क्या आप ठीक हैं?',
  'probe.body': 'हमें कुछ असामान्य दिखा।',
  'probe.fine': 'मैं ठीक हूँ',
  'probe.needHelp': 'मुझे मदद चाहिए',

  'tab.home': 'परिवार',
  'tab.watch': 'नज़र',
  'tab.map': 'नक्शा',
  'tab.incidents': 'घटनाएँ',
  'tab.consent': 'निजता',
  'tab.settings': 'सेटिंग्स',
  'tab.sos': 'SOS',
  'tab.sosHint': 'आपातकालीन स्क्रीन खोलता है',
  'tab.unacked': '{n} का अभी तक कोई जवाब नहीं',
  'watch.subtitle': 'सब कहाँ हैं, एक नज़र में — नक्शे वाला ही नियम: अनुमति नहीं, तो स्थान नहीं।',
  'family.privateSpace': 'आपका परिवार',
  'family.private': 'आपके परिवार के भीतर एंड-टू-एंड — बाहर कोई नहीं देख सकता',
  'family.privateShort': 'आपके परिवार तक सीमित',
  'family.idLabel': 'परिवार आईडी',
  'family.createTitle': 'अपने परिवार को नाम दें',
  'family.createSubtitle': 'अपने परिवार को एक नाम दें और तय करें कितने लोग जुड़ सकते हैं। यह स्थान केवल आपके परिवार के लिए निजी है।',
  'family.name': 'परिवार का नाम',
  'family.namePlaceholder': 'जैसे शर्मा परिवार',
  'family.size': 'परिवार का आकार',
  'family.sizeHint': 'इस परिवार में कितने लोग हो सकते हैं (2 से 20)।',
  'family.save': 'सहेजें',

  'home.everyoneOk': 'सब सुरक्षित हैं',
  'home.activeIncident': 'आपातकाल',
  'home.agentSilent': '{name} का सुरक्षा एजेंट {hours} घंटे से ऑफ़लाइन है',
  'home.monitoringPaused': '{name} ने सुरक्षा निगरानी रोक दी है',
  'home.checkIn': 'मैं सुरक्षित हूँ',
  'home.checkedIn': 'चेक-इन किया {ago}',
  'home.findPhone': 'फ़ोन ढूँढें',
  'home.startJourney': 'यात्रा शुरू करें',
  'home.lastSeen': 'आखिरी बार देखा {ago}',
  'home.battery': 'बैटरी {pct}%',
  'home.noMembersTitle': 'अभी कोई परिवार सदस्य नहीं',
  'home.noMembersBody': 'इस फ़ोन पर अभी कोई नहीं जुड़ा है। एक-दूसरे का ध्यान रखने के लिए एक फ़ोन जोड़ें।',
  'home.addPhone': 'इस परिवार में एक फ़ोन जोड़ें',
  'home.opensTimeline': 'मददगारों की समय-रेखा खोलता है',

  'watch.someone': 'आपके परिवार का कोई सदस्य',
  'watch.viewingCamera': '{name} आपका कैमरा देख रहे हैं',
  'watch.listening': '{name} सुन रहे हैं',
  'watch.stop': 'रोकें',
  'watch.stopHint': 'इसे अभी रोकें',
  'watch.noConnectionTitle': 'कनेक्शन नहीं',
  'watch.noConnectionBody': 'यह फ़ोन अभी जुड़ा नहीं है, इसलिए अनुरोध उनके फ़ोन तक नहीं पहुँच सकता। कुछ नहीं भेजा गया।',
  'watch.refreshFailed': 'अनुरोध नहीं भेजा जा सका — कनेक्शन जाँचें।',
  'watch.nobodyElseTitle': 'अभी कोई और नहीं जुड़ा',
  'watch.nobodyElseBody': 'इस परिवार में एक फ़ोन जोड़ें, वह यहाँ दिखेगा।',

  'member.noData': 'कोई डेटा नहीं',
  'member.agentOffline': 'एजेंट ऑफ़लाइन',
  'member.opensDetails': 'इस व्यक्ति का विवरण खोलता है',

  'net.zeroInfra': 'ऑफ़लाइन — केवल अलार्म',
  'net.peerOnly': 'केवल पास के फ़ोन',
  'net.smsOnly': 'केवल SMS',
  'net.pushOnly': 'केवल पुश',
  'net.limited': 'सीमित कनेक्शन',
  'net.full': 'पूरी तरह जुड़ा',
  'net.zeroInfraDetail': 'कोई नेटवर्क नहीं। अलार्म फिर भी इस फ़ोन पर बजेगा।',
  'net.peerOnlyDetail': 'नेटवर्क नहीं। पास के परिवार के फ़ोन फिर भी संदेश आगे भेज सकते हैं।',
  'net.smsOnlyDetail': 'डेटा बंद है। आपातकाल SMS से भेजे जाएँगे।',
  'net.limitedDetail': 'कनेक्शन सीमित है।',

  'map.paused': 'निगरानी रुकी हुई',
  'map.notShared': 'स्थान साझा नहीं',
  'map.nothingToMap': 'नक्शे पर कुछ नहीं',
  'map.noMembers': 'अभी कोई परिवार सदस्य नहीं।',
  'map.nobodySharing': 'अभी कोई लाइव स्थान साझा नहीं कर रहा।',
  'map.notOnMap': 'नक्शे पर नहीं',
  'map.pinLabel': '{name}, आखिरी स्थान {ago}, लगभग {m} मीटर तक सटीक',
  'map.addFence': 'घेरा जोड़ें',
  'map.addFenceHint': 'जहाँ आप हैं वहाँ, या टाइप किए गए स्थान के चारों ओर घेरा जोड़ें',
  'map.noFencesTitle': 'अभी कोई घेरा नहीं',
  'map.noFencesBody': 'जहाँ आप खड़े हैं वहाँ एक जोड़ें, या कोई स्थान टाइप करें। यह इसी फ़ोन पर रहता है।',
  'map.modeHere': 'जहाँ मैं अभी हूँ',
  'map.modeTyped': 'स्थान टाइप करें',
  'map.fenceNotSavedTitle': 'घेरा सहेजा नहीं गया',
  'map.fenceNoProfile': 'इस फ़ोन पर अभी कोई प्रोफ़ाइल नहीं है, इसलिए घेरा किसी से जोड़ा नहीं जा सकता।',
  'map.fenceNoFix': 'इस फ़ोन के पास स्थान नहीं है। इसके बजाय “स्थान टाइप करें” चुनें।',

  'coords.noMapsApp': 'इस फ़ोन पर नक्शे का ऐप नहीं है। अंक ज़ोर से पढ़ें।',
  'coords.copied': 'निर्देशांक कॉपी हुए।',
  'coords.accuracy': 'लगभग {m} मीटर तक सटीक',
  'coords.latitude': 'अक्षांश {value}',
  'coords.longitude': 'देशांतर {value}',
  'coords.openInMaps': 'नक्शे में खोलें',
  'coords.openInMapsHint': 'ये निर्देशांक नक्शे के ऐप में खोलें',
  'coords.copy': 'कॉपी करें',
  'coords.copyHint': 'निर्देशांक टेक्स्ट के रूप में कॉपी करें',

  'call112.hint': 'फ़ोन का डायलर 112 के साथ खोलता है। कॉल आप दबाएँ।',
  'call112.failed': 'डायलर नहीं खुला। 112 खुद डायल करें।',

  'countdown.secondsLeftToCancel': 'रद्द करने के लिए {n} सेकंड बाकी',

  'time.minutesAgo': '{n} मिनट पहले',
  'time.hoursAgo': '{n} घंटे पहले',
  'time.daysAgo': '{n} दिन पहले',

  'screen.incident': 'घटना',
  'screen.documents': 'दस्तावेज़',
  'screen.screenTime': 'स्क्रीन समय',
  'screen.journeys': 'यात्राएँ',
  'screen.drills': 'अभ्यास',

  'consent.title': 'कौन क्या देख सकता है',
  'consent.whoSeesMe': 'मुझे कौन देख सकता है',
  'consent.whatISee': 'मैं क्या देख सकता हूँ',
  'consent.accessLog': 'मेरा डेटा किसने देखा',
  'consent.expires': 'समाप्त होगा {when}',
  'consent.revoke': 'वापस लें',
  'consent.revokePending':
    'वापस लिया गया। {name} अब आपका स्थान नहीं माँग सकते। आपका फ़ोन अगली बार जुड़ने पर कुंजी बदलना पूरा होगा।',
  'consent.noPermanent': 'कोई अनुमति स्थायी नहीं है। हर अनुमति समाप्त होती है।',
  'consent.viewedBy': '{name} ने आपका {what} देखा',

  'diag.title': 'स्व-जाँच',
  'diag.healthy': 'सभी जाँच सफल',
  'diag.problems': '{n} समस्या मिली',
  'diag.run': 'अभी जाँच करें',
  'diag.batteryOptimisationExempt': 'बैटरी अनुकूलन से छूट',
  'diag.notBackgroundRestricted': 'पृष्ठभूमि गतिविधि की अनुमति',
  'diag.exactAlarmsPermitted': 'सटीक अलार्म की अनुमति',
  'diag.notificationsEnabled': 'सूचनाएँ चालू',
  'diag.dndBypassGranted': '“परेशान न करें” को पार कर सकता है',
  'diag.bgLocationGranted': 'पृष्ठभूमि स्थान की अनुमति',
  'diag.autoRevokeDisabled': 'अनुमति स्वतः हटना बंद',
  'diag.t0SigningAvailablePredawn': 'अनलॉक से पहले आपातकालीन कुंजी उपलब्ध',
  'diag.nativeT0Present': 'मूल सुरक्षा मॉड्यूल स्थापित',

  'medical.title': 'मेडिकल कार्ड',
  'medical.bloodGroup': 'रक्त समूह',
  'medical.allergies': 'एलर्जी',
  'medical.medications': 'दवाइयाँ',
  'medical.conditions': 'बीमारियाँ',
  'medical.ice': 'आपातकालीन संपर्क',
  'medical.showToResponder': 'जो मदद कर रहा है उसे यह दिखाएँ',

  'common.cancel': 'रद्द करें',
  'common.save': 'सहेजें',
  'common.done': 'हो गया',
  'common.close': 'बंद करें',
  'common.retry': 'फिर कोशिश करें',
  'common.yes': 'हाँ',
  'common.no': 'नहीं',
  'common.now': 'अभी',
  'common.never': 'कभी नहीं',
} satisfies Record<StringKey, string>;

const gu = {
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
  'panic.onScene': 'હું પહોંચી ગયો છું',
  'panic.resolve': 'ઉકેલાયું ચિહ્નિત કરો',
  'panic.call112': '112 પર કૉલ કરો',
  'panic.trigger': 'SOS',

  'state.IDLE': 'બધું બરાબર',
  'state.WATCH': 'નજર હેઠળ',
  'state.SUSPECT': 'તપાસ ચાલુ છે',
  'state.PROBE': 'શું તમે ઠીક છો?',
  'state.PENDING': 'રદ કરવાનો સમય',
  'state.FALSE_ALARM': 'ખોટો એલાર્મ',
  'state.ACTIVE_L1': 'પરિવારને જાણ કરી',
  // F-01: identical to ACTIVE_L1, see the Hindi table.
  'state.ACTIVE_L1_SILENT': 'પરિવારને જાણ કરી',
  'state.ACTIVE_L2': 'આગળ વધારાયું',
  'state.ACTIVE_L3': 'સંપૂર્ણ એલર્ટ',
  'state.OWNED': 'કોઈ જવાબ આપી રહ્યું છે',
  'state.RESOLVING': 'મદદગાર પહોંચી ગયા',
  'state.RESOLVED': 'ઉકેલાઈ ગયું',
  'state.DORMANT': 'આપમેળે બંધ થયું',

  'probe.title': 'શું તમે ઠીક છો?',
  'probe.body': 'અમને કંઈક અસામાન્ય જણાયું.',
  'probe.fine': 'હું ઠીક છું',
  'probe.needHelp': 'મને મદદ જોઈએ',

  'tab.home': 'પરિવાર',
  'tab.watch': 'નજર',
  'tab.map': 'નકશો',
  'tab.incidents': 'ઘટનાઓ',
  'tab.consent': 'ગોપનીયતા',
  'tab.settings': 'સેટિંગ્સ',
  'tab.sos': 'SOS',
  'tab.sosHint': 'કટોકટી સ્ક્રીન ખોલે છે',
  'tab.unacked': '{n} નો હજી કોઈ જવાબ નથી',
  'watch.subtitle': 'બધા ક્યાં છે, એક નજરમાં — નકશા જેવો જ નિયમ: પરવાનગી નહીં, તો સ્થાન નહીં.',
  'family.privateSpace': 'તમારો પરિવાર',
  'family.private': 'તમારા પરિવારની અંદર એન્ડ-ટુ-એન્ડ — બહાર કોઈ જોઈ શકતું નથી',
  'family.privateShort': 'તમારા પરિવાર પૂરતું ખાનગી',
  'family.idLabel': 'પરિવાર ID',
  'family.createTitle': 'તમારા પરિવારને નામ આપો',
  'family.createSubtitle': 'તમારા પરિવારને નામ આપો અને નક્કી કરો કેટલા લોકો જોડાઈ શકે. આ જગ્યા તમારા પરિવાર માટે ખાનગી છે.',
  'family.name': 'પરિવારનું નામ',
  'family.namePlaceholder': 'દા.ત. શર્મા પરિવાર',
  'family.size': 'પરિવારનું કદ',
  'family.sizeHint': 'આ પરિવારમાં કેટલા લોકો હોઈ શકે (2 થી 20).',
  'family.save': 'સાચવો',

  'home.everyoneOk': 'બધા સુરક્ષિત છે',
  'home.activeIncident': 'કટોકટી',
  'home.agentSilent': '{name} નો સુરક્ષા એજન્ટ {hours} કલાકથી ઑફલાઇન છે',
  'home.monitoringPaused': '{name} એ સુરક્ષા દેખરેખ થોભાવી છે',
  'home.checkIn': 'હું સુરક્ષિત છું',
  'home.checkedIn': 'ચેક-ઇન કર્યું {ago}',
  'home.findPhone': 'ફોન શોધો',
  'home.startJourney': 'મુસાફરી શરૂ કરો',
  'home.lastSeen': 'છેલ્લે જોયા {ago}',
  'home.battery': 'બેટરી {pct}%',
  'home.noMembersTitle': 'હજી કોઈ પરિવાર સભ્ય નથી',
  'home.noMembersBody': 'આ ફોન પર હજી કોઈ જોડાયું નથી. એકબીજાનું ધ્યાન રાખવા એક ફોન ઉમેરો.',
  'home.addPhone': 'આ પરિવારમાં એક ફોન ઉમેરો',
  'home.opensTimeline': 'મદદગારોની સમયરેખા ખોલે છે',

  'watch.someone': 'તમારા પરિવારનું કોઈ સભ્ય',
  'watch.viewingCamera': '{name} તમારો કૅમેરો જોઈ રહ્યા છે',
  'watch.listening': '{name} સાંભળી રહ્યા છે',
  'watch.stop': 'રોકો',
  'watch.stopHint': 'આ હમણાં રોકો',
  'watch.noConnectionTitle': 'કનેક્શન નથી',
  'watch.noConnectionBody': 'આ ફોન હમણાં જોડાયેલો નથી, તેથી વિનંતી તેમના ફોન સુધી પહોંચી શકે નહીં. કંઈ મોકલાયું નથી.',
  'watch.refreshFailed': 'વિનંતી મોકલી શકાઈ નહીં — કનેક્શન તપાસો.',
  'watch.nobodyElseTitle': 'હજી બીજું કોઈ જોડાયું નથી',
  'watch.nobodyElseBody': 'આ પરિવારમાં એક ફોન ઉમેરો, તે અહીં દેખાશે.',

  'member.noData': 'કોઈ ડેટા નથી',
  'member.agentOffline': 'એજન્ટ ઑફલાઇન',
  'member.opensDetails': 'આ વ્યક્તિની વિગતો ખોલે છે',

  'net.zeroInfra': 'ઑફલાઇન — ફક્ત એલાર્મ',
  'net.peerOnly': 'ફક્ત નજીકના ફોન',
  'net.smsOnly': 'ફક્ત SMS',
  'net.pushOnly': 'ફક્ત પુશ',
  'net.limited': 'મર્યાદિત કનેક્શન',
  'net.full': 'સંપૂર્ણ જોડાયેલ',
  'net.zeroInfraDetail': 'કોઈ નેટવર્ક નથી. એલાર્મ તો પણ આ ફોન પર વાગશે.',
  'net.peerOnlyDetail': 'નેટવર્ક નથી. નજીકના પરિવારના ફોન તો પણ સંદેશ આગળ મોકલી શકે છે.',
  'net.smsOnlyDetail': 'ડેટા બંધ છે. કટોકટી SMS થી મોકલાશે.',
  'net.limitedDetail': 'કનેક્શન મર્યાદિત છે.',

  'map.paused': 'દેખરેખ થોભાવેલી',
  'map.notShared': 'સ્થાન શેર કરેલું નથી',
  'map.nothingToMap': 'નકશા પર કંઈ નથી',
  'map.noMembers': 'હજી કોઈ પરિવાર સભ્ય નથી.',
  'map.nobodySharing': 'હમણાં કોઈ લાઇવ સ્થાન શેર કરતું નથી.',
  'map.notOnMap': 'નકશા પર નથી',
  'map.pinLabel': '{name}, છેલ્લું સ્થાન {ago}, આશરે {m} મીટર સુધી ચોક્કસ',
  'map.addFence': 'સીમા ઉમેરો',
  'map.addFenceHint': 'તમે જ્યાં છો ત્યાં, અથવા ટાઇપ કરેલા સ્થાનની આસપાસ સીમા ઉમેરો',
  'map.noFencesTitle': 'હજી કોઈ સીમા નથી',
  'map.noFencesBody': 'તમે જ્યાં ઊભા છો ત્યાં એક ઉમેરો, અથવા સ્થાન ટાઇપ કરો. તે આ ફોન પર જ રહે છે.',
  'map.modeHere': 'હું હમણાં જ્યાં છું',
  'map.modeTyped': 'સ્થાન ટાઇપ કરો',
  'map.fenceNotSavedTitle': 'સીમા સાચવાઈ નથી',
  'map.fenceNoProfile': 'આ ફોન પર હજી કોઈ પ્રોફાઇલ નથી, તેથી સીમા કોઈ સાથે જોડી શકાય નહીં.',
  'map.fenceNoFix': 'આ ફોન પાસે સ્થાન નથી. તેના બદલે “સ્થાન ટાઇપ કરો” પસંદ કરો.',

  'coords.noMapsApp': 'આ ફોન પર નકશાની ઍપ નથી. આંકડા મોટેથી વાંચો.',
  'coords.copied': 'નિર્દેશાંક કૉપિ થયા.',
  'coords.accuracy': 'આશરે {m} મીટર સુધી ચોક્કસ',
  'coords.latitude': 'અક્ષાંશ {value}',
  'coords.longitude': 'રેખાંશ {value}',
  'coords.openInMaps': 'નકશામાં ખોલો',
  'coords.openInMapsHint': 'આ નિર્દેશાંક નકશાની ઍપમાં ખોલો',
  'coords.copy': 'કૉપિ કરો',
  'coords.copyHint': 'નિર્દેશાંક ટેક્સ્ટ તરીકે કૉપિ કરો',

  'call112.hint': 'ફોનનું ડાયલર 112 સાથે ખોલે છે. કૉલ તમે દબાવો.',
  'call112.failed': 'ડાયલર ખૂલ્યું નહીં. 112 જાતે ડાયલ કરો.',

  'countdown.secondsLeftToCancel': 'રદ કરવા {n} સેકન્ડ બાકી',

  'time.minutesAgo': '{n} મિનિટ પહેલાં',
  'time.hoursAgo': '{n} કલાક પહેલાં',
  'time.daysAgo': '{n} દિવસ પહેલાં',

  'screen.incident': 'ઘટના',
  'screen.documents': 'દસ્તાવેજો',
  'screen.screenTime': 'સ્ક્રીન સમય',
  'screen.journeys': 'મુસાફરીઓ',
  'screen.drills': 'અભ્યાસ',

  'consent.title': 'કોણ શું જોઈ શકે',
  'consent.whoSeesMe': 'મને કોણ જોઈ શકે',
  'consent.whatISee': 'હું શું જોઈ શકું',
  'consent.accessLog': 'મારો ડેટા કોણે જોયો',
  'consent.expires': 'સમાપ્ત થશે {when}',
  'consent.revoke': 'પાછું લો',
  'consent.revokePending':
    'પાછું લીધું. {name} હવે તમારું સ્થાન માગી શકશે નહીં. તમારો ફોન આગલી વખતે જોડાય ત્યારે કી બદલવાનું પૂરું થશે.',
  'consent.noPermanent': 'કોઈ પરવાનગી કાયમી નથી. દરેક સમાપ્ત થાય છે.',
  'consent.viewedBy': '{name} એ તમારું {what} જોયું',

  'diag.title': 'સ્વ-તપાસ',
  'diag.healthy': 'બધી તપાસ સફળ',
  'diag.problems': '{n} સમસ્યા મળી',
  'diag.run': 'હમણાં તપાસ કરો',
  'diag.batteryOptimisationExempt': 'બેટરી ઑપ્ટિમાઇઝેશનમાંથી મુક્તિ',
  'diag.notBackgroundRestricted': 'બેકગ્રાઉન્ડ પ્રવૃત્તિની પરવાનગી',
  'diag.exactAlarmsPermitted': 'ચોક્કસ એલાર્મની પરવાનગી',
  'diag.notificationsEnabled': 'સૂચનાઓ ચાલુ',
  'diag.dndBypassGranted': '“ખલેલ ન પહોંચાડો” ને ઓળંગી શકે છે',
  'diag.bgLocationGranted': 'બેકગ્રાઉન્ડ સ્થાનની પરવાનગી',
  'diag.autoRevokeDisabled': 'પરવાનગી આપમેળે હટવી બંધ',
  'diag.t0SigningAvailablePredawn': 'અનલૉક પહેલાં કટોકટી કી ઉપલબ્ધ',
  'diag.nativeT0Present': 'મૂળ સુરક્ષા મૉડ્યુલ સ્થાપિત',

  'medical.title': 'મેડિકલ કાર્ડ',
  'medical.bloodGroup': 'બ્લડ ગ્રુપ',
  'medical.allergies': 'એલર્જી',
  'medical.medications': 'દવાઓ',
  'medical.conditions': 'બીમારીઓ',
  'medical.ice': 'કટોકટી સંપર્કો',
  'medical.showToResponder': 'જે મદદ કરે છે તેને આ બતાવો',

  'common.cancel': 'રદ કરો',
  'common.save': 'સાચવો',
  'common.done': 'થઈ ગયું',
  'common.close': 'બંધ કરો',
  'common.retry': 'ફરી પ્રયાસ કરો',
  'common.yes': 'હા',
  'common.no': 'ના',
  'common.now': 'હમણાં',
  'common.never': 'ક્યારેય નહીં',
} satisfies Record<StringKey, string>;

const TABLES: Record<Locale, Partial<Record<StringKey, string>>> = { en, hi, gu };

let current: Locale = 'en';
export function setLocale(l: Locale): void {
  current = l;
}
export function getLocale(): Locale {
  return current;
}

/** `{name}`, `{n}` … — the placeholder shape every table uses. */
const PLACEHOLDER_RE = /\{([a-zA-Z]+)\}/g;

/**
 * Translate. Always falls back to English — a missing string must never blank the UI.
 *
 * Interpolation is ONE pass with a replacer FUNCTION, never `String.replace`
 * with a string: that form interprets `$&`, `$'`, `$1` and `$$` inside the
 * REPLACEMENT, and the replacement here is a member's display name — user
 * input, on the panic screen. "Raj $'" used to render "Raj  is responding. is
 * responding." on the line that answers "who is coming?". One pass also means a
 * value is never re-scanned for the next placeholder, so a name that happens
 * to contain `{what}` is inserted verbatim. An unknown placeholder is left as
 * written rather than blanked — a visible `{n}` is a bug report; an empty
 * string is a lie.
 */
export function t(key: StringKey, vars?: Record<string, string | number>): string {
  const s = TABLES[current]?.[key] ?? en[key] ?? String(key);
  if (!vars) return s;
  return s.replace(PLACEHOLDER_RE, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

/** Coverage lint helper — used by `test/i18n-coverage.test.ts` (NFR-020). */
export function coverage(locale: Locale): number {
  const keys = Object.keys(en) as StringKey[];
  const table = TABLES[locale];
  return keys.filter((k) => table[k] !== undefined).length / keys.length;
}

/** The raw tables, exported for the coverage test only — screens go through `t()`. */
export function tableFor(locale: Locale): Readonly<Partial<Record<StringKey, string>>> {
  return TABLES[locale];
}

export function relativeTime(ms: number | null): string {
  if (ms == null) return t('common.never');
  const d = Date.now() - ms;
  if (d < 60_000) return t('common.now');
  const m = Math.floor(d / 60_000);
  if (m < 60) return t('time.minutesAgo', { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('time.hoursAgo', { n: h });
  return t('time.daysAgo', { n: Math.floor(h / 24) });
}

/**
 * The §4.4 rung, named in the member's language. `core/types.ts`'s
 * `DEGRADATION_LABELS` is the English source of truth for code that must not
 * depend on the locale (the SMS builder, logs); every SCREEN reads this one.
 */
export function degradationLabel(level: DegradationLevel): string {
  switch (level) {
    case DegradationLevel.ZERO_INFRA:
      return t('net.zeroInfra');
    case DegradationLevel.PEER_ONLY:
      return t('net.peerOnly');
    case DegradationLevel.SMS_ONLY:
      return t('net.smsOnly');
    case DegradationLevel.PUSH_ONLY:
      return t('net.pushOnly');
    case DegradationLevel.HTTP_ONLY:
      return t('net.limited');
    default:
      return t('net.full');
  }
}

/**
 * What the rung actually costs the user, in a sentence. A name alone ("Peer
 * only") tells a parent nothing about whether their child's phone can still
 * reach them.
 */
export function degradationDetail(level: DegradationLevel): string {
  switch (level) {
    case DegradationLevel.ZERO_INFRA:
      return t('net.zeroInfraDetail');
    case DegradationLevel.PEER_ONLY:
      return t('net.peerOnlyDetail');
    case DegradationLevel.SMS_ONLY:
      return t('net.smsOnlyDetail');
    default:
      return t('net.limitedDetail');
  }
}
