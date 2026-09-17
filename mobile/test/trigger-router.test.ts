/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * T0 · TRIGGER ROUTER — the orchestrator, driven end to end off-device
 *
 * The router is the 1000-line module that decides whether an SOS fires, whether
 * a PIN cancels or silently escalates, whether the ladder keeps climbing once
 * somebody has claimed, and what actually leaves the phone. Until now only the
 * generated state table under it was tested; everything the table does not say
 * (timers, legs, PIN handling, envelope sizing) could regress with `npm test`
 * green. These cases pin the rules named in the router's header: I-7 / T-213,
 * the cancel window, the PROBE path, F-01's fixed envelope, and — the one that
 * costs money and trust — that a claimed incident stops escalating.
 *
 * ★ HOW THE NATIVE PLANE IS KEPT OUT ★
 * The router imports six siblings that reach expo-audio, expo-sensors,
 * expo-modules-core, expo-sms and expo-background-task. None of those has a stub
 * in test/shim.mjs, so this file registers its OWN module hooks (they chain in
 * front of the shim's) and swaps exactly those siblings for recording stubs.
 * The dispatcher, envelope, SMS encoder, crypto, ids and policy are the REAL
 * modules — that is the point: what reaches `fetch`, `sendSmsDirect` and
 * `bleAdvertise` is what would reach the wire.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import test, { afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

interface Recorder {
  alarm: { op: 'start' | 'stop'; silent?: boolean }[];
  alarmActive: boolean;
  cues: string[];
  sms: { recipients: string[]; text: string }[];
  ble: string[];
  http: { url: string; body: string; headers: Record<string, string> }[];
  events: { incidentId: string; type: string; state: string; detail?: Record<string, unknown> }[];
  hangHttp: boolean;
  /** Fetches parked by `hangHttp`, settled at teardown so no abort timer lingers. */
  pendingHttp: ((r: Response) => void)[];
  /** What the native BLE advertiser answers. False = no native module. */
  bleOk: boolean;
}

const rec: Recorder = {
  alarm: [],
  alarmActive: false,
  cues: [],
  sms: [],
  ble: [],
  http: [],
  events: [],
  hangHttp: false,
  pendingHttp: [],
  bleOk: true,
};
(globalThis as unknown as { __kavachT0: Recorder }).__kavachT0 = rec;

const T0_DIR = new URL('../src/t0/', import.meta.url).href;

/** Sibling stubs, keyed by the specifier the router (or the dispatcher) uses. */
const SIBLING_STUBS: Record<string, string> = {
  './alarm': `
    const g = globalThis.__kavachT0;
    export function playCue(c) { g.cues.push(c); }
    export async function primeAlarm() {}
    export function releaseAlarm() {}
    export function startAlarm(o = {}) { g.alarm.push({ op: 'start', silent: o.silent === true }); g.alarmActive = true; }
    export function startCountdownHaptics() {}
    export function stopAlarm() { g.alarm.push({ op: 'stop' }); g.alarmActive = false; }
    export function stopCountdownHaptics() {}
    export function isAlarmActive() { return g.alarmActive; }
  `,
  './blackbox': `
    export function initBlackBox() {}
    export async function sealBlackBox() { return null; }
    export function pushSample() {}
  `,
  './fusion': `
    export const CONFIDENCE_MEDIUM = 0.5;
    export const CONFIDENCE_HIGH = 0.8;
    export function setFusionMode() {}
    export function startFusion() {}
    export function stopFusion() {}
    export function resetFusionContext() {}
  `,
  './pocketSuppressor': `
    export function pocketState() { return { luxAvg: null }; }
    export function shouldSuppress() { return { suppressed: false, reason: '' }; }
    export function startPocketWatch() {}
    export function stopPocketWatch() {}
  `,
  './watchdog': `export async function registerWatchdog() {}`,
  './native': `
    const g = globalThis.__kavachT0;
    export async function bleAdvertise(advert) { g.ble.push(advert); return g.bleOk; }
    export async function sendSmsDirect(recipients, text) { g.sms.push({ recipients, text }); return { sent: recipients, failed: [] }; }
  `,
};

registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL ?? '';
    if (parent.startsWith(T0_DIR)) {
      if (SIBLING_STUBS[specifier]) {
        return { url: `kavach-t0-stub:${specifier}`, shortCircuit: true, format: 'module' };
      }
      // `.generated` reads as an extension to a naive resolver; name the file.
      if (specifier === './stateMachine.generated') {
        return { url: `${T0_DIR}stateMachine.generated.ts`, shortCircuit: true, format: 'module-typescript' };
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('kavach-t0-stub:')) {
      const source = SIBLING_STUBS[url.slice('kavach-t0-stub:'.length)];
      return { format: 'module', shortCircuit: true, source };
    }
    return next(url, context);
  },
});

// The hot-path HTTP legs call the global fetch directly (not net/api).
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  rec.http.push({
    url: String(url),
    body: String(init?.body ?? ''),
    headers: (init?.headers ?? {}) as Record<string, string>,
  });
  if (rec.hangHttp) return new Promise<Response>((resolve) => rec.pendingHttp.push(resolve));
  return new Response('{"verified":true}', { status: 200 });
}) as typeof fetch;

const router = await import('../src/t0/triggerRouter.ts');
const dispatcher = await import('../src/t0/dispatcher.ts');
const { generateDeviceKeypair, incidentContentKey, openJson } = await import('../src/crypto/index.ts');
const { uuidv7, inc8 } = await import('../src/core/ids.ts');
const { DEFAULT_POLICY, effectiveCancelWindowS } = await import('../src/core/policy.ts');
const { DegradationLevel } = await import('../src/core/types.ts');
const { FIXED_ENVELOPE_SIZE, INCIDENT_APPEND_PATH, INCIDENT_OPEN_PATH } = await import('../src/t0/envelope.ts');
type T0Deps = import('../src/t0/triggerRouter.ts').T0Deps;
type MedicalCard = import('../src/core/types.ts').MedicalCard;

const GROUP = new Uint8Array(32).fill(7);
const KEYPAIR = generateDeviceKeypair();
const FAMILY = uuidv7();
const DEVICE = uuidv7();
const MEMBER = uuidv7();
const FIX = { lat: 20.945123, lon: 72.932011, accuracyM: 12, at: Date.now() - 5_000 };

/** A policy whose ladder steps are all due at t=0, so they fire on macrotasks. */
const FAST_LADDER = {
  version: 1,
  scenarios: {
    ...DEFAULT_POLICY.scenarios,
    MANUAL: { ...DEFAULT_POLICY.scenarios.MANUAL, repeatL1AfterS: 0, smsTierAfterS: 0 },
  },
};

function makeDeps(over: Partial<T0Deps> = {}): T0Deps {
  return {
    familyId: FAMILY,
    deviceId: DEVICE,
    memberId: MEMBER,
    asciiShortName: 'PRIYA',
    keypair: KEYPAIR,
    groupSecret: GROUP,
    cancelPin: '1234',
    duressPin: '9999',
    lastKnownLocation: () => FIX,
    batteryPct: () => 80,
    risk: () => 0,
    degradation: () => DegradationLevel.FULL,
    smsRecipients: () => ['+919999999999', '+918888888888'],
    medical: () => null,
    onEvent: (e) => rec.events.push({ incidentId: e.incidentId, type: e.type, state: e.state, detail: e.detail }),
    autoStart: false,
    ...over,
  };
}

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const bytes = (s: string) => new TextEncoder().encode(s).length;
const bodyOf = (h: Recorder['http'][number]) => JSON.parse(h.body) as Record<string, unknown>;

function reset(): void {
  rec.alarm = [];
  rec.alarmActive = false;
  rec.cues = [];
  rec.sms = [];
  rec.ble = [];
  rec.http = [];
  rec.events = [];
  rec.hangHttp = false;
  for (const settle of rec.pendingHttp) settle(new Response('', { status: 503 }));
  rec.pendingHttp = [];
  rec.bleOk = true;
}

afterEach(() => {
  router.resetT0();
  dispatcher.__resetDispatcherForTest();
  dispatcher.clearWarmSocket();
  reset();
});
after(() => {
  router.shutdownT0();
});

// ═══════════════════════════════════════════════════════════════════════════════
// The opening path — §2.3 budget, cancel window, what leaves the phone
// ═══════════════════════════════════════════════════════════════════════════════

test('a manual trigger opens PENDING, reads only the CACHED fix, and fires both HTTP legs at /open', async () => {
  let locationReads = 0;
  await router.initT0(makeDeps({ lastKnownLocation: () => (locationReads++, FIX) }));
  const before = locationReads;

  const result = router.onTrigger('MANUAL');
  assert.equal(result.suppressed, false);
  assert.equal(result.reason, 'opened');
  assert.ok(result.incidentId);
  assert.equal(router.currentState(), 'PENDING');
  // The location was read synchronously inside the call — never awaited (§2.3).
  assert.ok(locationReads > before, 'the cached fix must be read on the hot path');
  assert.ok(result.elapsedMs < 500, `t0→fanOut took ${result.elapsedMs} ms, budget is 500`);

  const snap = router.currentSnapshot();
  assert.equal(snap.cancelWindowS, effectiveCancelWindowS(DEFAULT_POLICY, 'MANUAL', 0, 0));
  assert.ok(snap.pendingUntil !== null && snap.pendingUntil > Date.now());

  const opens = rec.http.filter((h) => h.url.endsWith(INCIDENT_OPEN_PATH));
  assert.equal(opens.length, 2, 'F-05: both ingest endpoints, in parallel');
  for (const h of opens) {
    assert.equal(bytes(h.body), FIXED_ENVELOPE_SIZE, 'F-01: every envelope is exactly 1024 bytes');
    assert.equal(h.headers['X-Incident-Id'], result.incidentId);
  }
  await tick();
  assert.equal(rec.ble.length, 1, 'the BLE distress advert is one of the parallel legs');
});

test('★ t0-12 · the opening transition is logged under the NEW incident, not the previous one', async () => {
  await router.initT0(makeDeps());
  const first = router.onTrigger('MANUAL').incidentId as string;
  const firstRows = rec.events.filter((e) => e.type === 'MANUAL_TRIGGER');
  assert.equal(firstRows.length, 1, 'the first incident of a session must not drop its opening row');
  assert.equal(firstRows[0].incidentId, first);

  // Close it, then open another: its MANUAL_TRIGGER must not land on `first`.
  router.sendEvent('CANCEL_WINDOW_EXPIRED');
  router.sendEvent('CLAIM');
  router.sendEvent('ON_SCENE');
  router.sendEvent('TWO_PARTY_CONFIRM');
  assert.equal(router.currentState(), 'RESOLVED');
  rec.events = [];

  // A context change after RESOLVED belongs to no incident at all — and it is
  // not swallowed either: a closed incident leaves the machine usable.
  router.setContextElevated(true);
  assert.equal(router.currentState(), 'WATCH', 'a terminal state is idle for the next context change');
  assert.equal(rec.events.length, 0, 'IDLE→WATCH must not be appended to a resolved incident');

  const second = router.onTrigger('MANUAL').incidentId as string;
  assert.notEqual(second, first);
  const rows = rec.events.filter((e) => e.type === 'MANUAL_TRIGGER');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].incidentId, second, 'the opening transition must carry the id it opens');
  assert.ok(rec.events.every((e) => e.incidentId === second));
});

test('t0-11 · a second press inside the cancel window changes nothing and says so', async () => {
  await router.initT0(makeDeps());
  const id = router.onTrigger('MANUAL').incidentId;
  const again = router.onTrigger('MANUAL');
  assert.equal(again.incidentId, id, 'never a duplicate incident for one emergency');
  assert.equal(router.currentState(), 'PENDING');
  assert.match(again.reason, /no further escalation/);
  assert.doesNotMatch(again.reason, /; escalated$/);

  // From ACTIVE_L1 the spec (P-058) does define REESCALATE, and the reason says so.
  router.sendEvent('CANCEL_WINDOW_EXPIRED');
  const third = router.onTrigger('MANUAL');
  assert.equal(router.currentState(), 'ACTIVE_L2');
  assert.match(third.reason, /escalated$/);
});

test('t0-19 · a malformed caller-supplied incident id is replaced, never thrown on', async () => {
  await router.initT0(makeDeps());
  assert.equal(inc8(''), '00000000');
  assert.equal(inc8('not-a-uuid'), inc8('ad'), 'only hex survives; the rest is deterministic');
  const result = router.onTrigger('RELAY', { incidentId: '' as never });
  assert.equal(result.suppressed, false);
  assert.match(result.incidentId as string, /^[0-9a-f-]{36}$/);
  assert.equal(rec.http.length, 2, 'the fan-out still happened');
});

// ═══════════════════════════════════════════════════════════════════════════════
// ★ I-7 / T-213 · the PIN path
// ═══════════════════════════════════════════════════════════════════════════════

test('verifyPin · wrong, cancel and duress, with the identical-PIN rule reading as duress', async () => {
  await router.initT0(makeDeps());
  router.onTrigger('MANUAL');
  assert.equal(router.verifyPin('0000'), 'wrong');
  assert.equal(router.currentState(), 'PENDING', 'a wrong PIN touches nothing');
  assert.equal(router.verifyPin('1234'), 'cancel');
  assert.equal(router.currentState(), 'FALSE_ALARM');

  router.resetT0();
  reset();
  router.onTrigger('MANUAL');
  assert.equal(router.verifyPin('9999'), 'duress');
  assert.equal(router.currentState(), 'ACTIVE_L1_SILENT');
  assert.ok(!rec.alarm.some((a) => a.op === 'start' && !a.silent), 'duress sounds nothing');

  router.resetT0();
  reset();
  router.setPins('1111', '1111');
  router.onTrigger('MANUAL');
  assert.equal(router.verifyPin('1111'), 'duress', 'both PINs identical → the silent reading is the safe one');
});

test('★ t0-7 · an EMPTY entry never verifies, and an unset PIN never matches anything', async () => {
  // Mid-onboarding, or a restore that lost the SecureStore items: no PINs.
  await router.initT0(makeDeps({ cancelPin: '', duressPin: '' }));
  const snap = router.currentSnapshot();
  assert.equal(snap.cancelPinSet, false);
  assert.equal(snap.duressPinSet, false);

  router.onTrigger('MANUAL');
  assert.equal(router.verifyPin(''), 'wrong', 'a bare tap on Cancel must not read as the duress PIN');
  assert.equal(router.currentState(), 'PENDING');
  assert.ok(!rec.events.some((e) => e.type === 'PIN_DURESS'));
  assert.ok(!rec.events.some((e) => e.type === 'PIN_CORRECT'));

  // Configured PINs: the empty entry is still rejected.
  router.setPins('1234', '9999');
  assert.equal(router.currentSnapshot().cancelPinSet, true);
  assert.equal(router.verifyPin(''), 'wrong');
  assert.equal(router.currentState(), 'PENDING');

  // Only the cancel PIN set: duress cannot be produced by any entry.
  router.setPins('1234', '');
  assert.equal(router.currentSnapshot().duressPinSet, false);
  assert.equal(router.verifyPin(''), 'wrong');
  assert.equal(router.verifyPin('1234'), 'cancel');
});

test('★ t0-4 · the PIN record goes to /append, not /open, and never resets the open\'s bookkeeping', async () => {
  await router.initT0(makeDeps());
  const id = router.onTrigger('MANUAL').incidentId as string;
  await tick(); // let the open's HTTP legs resolve and stamp t2
  const openStats = dispatcher.dispatchStats();
  assert.equal(openStats.incidents.length, 1);
  const t2 = openStats.incidents[0].firstTransmitAt;
  assert.ok(t2 !== null, 'the open\'s HTTP ack stamps t2');
  const smsScheduled = openStats.incidents[0].smsScheduledFor;
  assert.ok(smsScheduled !== null, 'the open scheduled its SMS');
  rec.http = [];
  rec.ble = [];

  assert.equal(router.verifyPin('9999'), 'duress');
  await tick(300); // CANCEL_EVENT_DELAY_MS is 250

  const appends = rec.http.filter((h) => h.url.endsWith(INCIDENT_APPEND_PATH));
  assert.equal(appends.length, 2, 'the event goes to BOTH ingest endpoints at /append');
  assert.equal(rec.http.filter((h) => h.url.endsWith(INCIDENT_OPEN_PATH)).length, 0, 'never to /open');
  for (const h of appends) {
    const body = bodyOf(h);
    assert.equal(body.duress, true, 'the duress bit ARRIVES in the append body');
    assert.equal(body.incidentId, id);
    assert.equal(bytes(h.body), FIXED_ENVELOPE_SIZE);
  }
  assert.equal(rec.ble.length, 0, 'no second advert: BLE has no event field');
  assert.equal(rec.sms.length, 0, 'no SMS burst for the event; the open\'s is already scheduled');

  const after = dispatcher.dispatchStats();
  assert.equal(after.incidents.length, 1, 'the event does not replace the open\'s dispatch');
  assert.equal(after.incidents[0].firstTransmitAt, t2, 't2 still measures the SOS, not the PIN');
  assert.equal(after.incidents[0].smsScheduledFor, smsScheduled, 'duress keeps the open\'s SMS schedule');
  const eventRows = dispatcher.outboxItems().filter((o) => o.kind === 'incident_event');
  assert.equal(eventRows.length, 1, 'one durable incident_event row');
});

test('★ I-7 · cancel and duress produce byte-identical wire activity: same legs, same size, same schedule', async () => {
  const run = async (pin: string) => {
    await router.initT0(makeDeps());
    const id = router.onTrigger('MANUAL').incidentId as string;
    await tick();
    rec.http = [];
    rec.ble = [];
    rec.sms = [];
    router.verifyPin(pin);
    await tick(300);
    const out = {
      state: router.currentState(),
      urls: rec.http.map((h) => h.url.slice(h.url.lastIndexOf('/v1'))).sort(),
      sizes: rec.http.map((h) => bytes(h.body)),
      ble: rec.ble.length,
      sms: rec.sms.length,
      duressBits: rec.http.map((h) => bodyOf(h).duress),
      id,
    };
    router.resetT0();
    dispatcher.__resetDispatcherForTest();
    reset();
    return out;
  };
  const cancel = await run('1234');
  const duress = await run('9999');
  assert.equal(cancel.state, 'FALSE_ALARM');
  assert.equal(duress.state, 'ACTIVE_L1_SILENT');
  assert.deepEqual(cancel.urls, duress.urls);
  assert.deepEqual(cancel.sizes, duress.sizes);
  assert.equal(cancel.ble, duress.ble);
  assert.equal(cancel.sms, duress.sms);
  assert.deepEqual(cancel.duressBits, [false, false]);
  assert.deepEqual(duress.duressBits, [true, true]);
});

test('t0-21 · a correct PIN in a state with no PIN transition does nothing at all', async () => {
  await router.initT0(makeDeps());
  router.onTrigger('MANUAL');
  router.sendEvent('CANCEL_WINDOW_EXPIRED');
  assert.equal(router.currentState(), 'ACTIVE_L1');
  rec.alarm = [];
  rec.http = [];
  assert.equal(router.verifyPin('1234'), 'wrong');
  assert.equal(router.currentState(), 'ACTIVE_L1', 'the machine did not move');
  assert.equal(rec.alarm.length, 0, 'the siren was not silenced on a live incident');
  await tick(300);
  assert.equal(rec.http.length, 0, 'no PIN record was fanned out');
});

// ═══════════════════════════════════════════════════════════════════════════════
// ★ t0-2 · the ladder stops on CLAIM and ON_SCENE
// ═══════════════════════════════════════════════════════════════════════════════

test('★ t0-2 · after CLAIM no ladder step fires: no SMS tier, no siren restart', async () => {
  await router.initT0(makeDeps({ policy: FAST_LADDER }));
  router.onTrigger('MANUAL');
  router.sendEvent('CANCEL_WINDOW_EXPIRED');
  assert.equal(router.currentState(), 'ACTIVE_L1');
  assert.ok(rec.alarm.some((a) => a.op === 'start'), 'ACTIVE_L1 sounds the alarm');

  // Claimed within the same tick — before the ladder's first macrotask.
  assert.equal(router.sendEvent('CLAIM'), true);
  assert.equal(router.currentState(), 'OWNED');
  const alarmsAtClaim = rec.alarm.length;
  const smsAtClaim = rec.sms.length;
  const laddersAtClaim = rec.events.filter((e) => e.type === 'LADDER').length;

  await tick(20); // every FAST_LADDER step was due at t=0
  for (let i = 0; i < 5; i++) router.advanceLadder();
  await tick(20);

  assert.equal(rec.sms.length, smsAtClaim, 'no SMS tier to a claimed incident');
  assert.equal(rec.alarm.filter((a) => a.op === 'start').length,
    rec.alarm.slice(0, alarmsAtClaim).filter((a) => a.op === 'start').length,
    'no siren restart on a claimed incident');
  assert.equal(rec.events.filter((e) => e.type === 'LADDER').length, laddersAtClaim, 'no LADDER rows after CLAIM');

  // ON_SCENE stops the alarm; a queued step must not restart it.
  router.sendEvent('ON_SCENE');
  assert.equal(router.currentState(), 'RESOLVING');
  const startsBefore = rec.alarm.filter((a) => a.op === 'start').length;
  router.advanceLadder();
  await tick(20);
  assert.equal(rec.alarm.filter((a) => a.op === 'start').length, startsBefore, 'RESOLVING stays silent');
  assert.equal(rec.alarmActive, false);
});

test('t0-14 · one SMS burst per incident: the ladder does not repeat what already went out', async () => {
  await router.initT0(makeDeps({ policy: FAST_LADDER, degradation: () => DegradationLevel.SMS_ONLY }));
  router.onTrigger('MANUAL');
  await tick();
  assert.equal(rec.sms.length, 1, 'SMS_ONLY sends immediately');
  router.sendEvent('CANCEL_WINDOW_EXPIRED');
  await tick(20); // ladder steps 0..2 run, step 2 is "SMS to all"
  for (let i = 0; i < 3; i++) router.advanceLadder();
  await tick(20);
  assert.equal(rec.sms.length, 1, 'the same text to the same numbers on the same transport is noise');
  assert.ok(rec.events.some((e) => e.type === 'LADDER'), 'the ladder itself did run');
});

// ═══════════════════════════════════════════════════════════════════════════════
// ★ contract-3 · the warm-socket leg is an attempt, never a delivery
// ═══════════════════════════════════════════════════════════════════════════════

test('★ contract-3 · a "successful" WebSocket send neither marks the row delivered nor stamps t2', async () => {
  const frames: { kind: string; t: string }[] = [];
  dispatcher.registerWarmSocket((payload, kind) => {
    frames.push({ kind, t: (JSON.parse(payload) as { t: string }).t });
    return true;
  });
  rec.hangHttp = true; // the gateway is up, sos-ingest is not
  rec.bleOk = false; // and there is no native BLE advertiser either
  await router.initT0(makeDeps());
  router.onTrigger('MANUAL');
  await tick(20);

  assert.deepEqual(frames, [{ kind: 'open', t: 'incident_open' }]);
  const stats = dispatcher.dispatchStats();
  const ws = stats.byTransport.find((t) => t.transport === 'ws');
  assert.equal(ws?.attempts, 1);
  assert.equal(ws?.successes, 1, 'the attempt is counted');
  assert.equal(stats.lastFirstTransmitMs, null, 'no HTTP ack, no t2');
  assert.equal(stats.incidents[0].firstTransport, null);
  assert.equal(stats.undeliveredDepth, 1, 'the outbox row is still undelivered');
  assert.ok(dispatcher.outboxItems().every((o) => !o.delivered));
});

test('the HTTP ack is what delivers, and the event frame names its kind', async () => {
  const frames: string[] = [];
  dispatcher.registerWarmSocket((_payload, kind) => (frames.push(kind), true));
  await router.initT0(makeDeps());
  router.onTrigger('MANUAL');
  await tick();
  const stats = dispatcher.dispatchStats();
  assert.ok(stats.incidents[0].firstTransport === 'http' || stats.incidents[0].firstTransport === 'http_direct');
  assert.ok(dispatcher.outboxItems().some((o) => o.delivered));
  router.verifyPin('1234');
  await tick(300);
  assert.deepEqual(frames, ['open', 'event']);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ★ t0-3 · a full medical card must not cost the precise location
// ═══════════════════════════════════════════════════════════════════════════════

const FULL_CARD: MedicalCard = {
  bloodGroup: 'O negative',
  allergies: ['Penicillin', 'Sulfonamides', 'Peanuts and tree nuts'],
  medications: ['Metformin 500 mg twice daily', 'Amlodipine 5 mg', 'Atorvastatin 20 mg'],
  conditions: ['Type 2 diabetes', 'Hypertension'],
  iceContacts: [
    { name: 'Rajesh Patel', phone: '+919876543210' },
    { name: 'Meena Patel', phone: '+919876543211' },
  ],
  organDonor: true,
  notes: '',
};

test('★ t0-3 · a card at the documented capacity yields a 1024-byte envelope whose sealed payload still has lat/lon', async () => {
  await router.initT0(makeDeps({ medical: () => FULL_CARD }));
  const id = router.onTrigger('MANUAL').incidentId as string;
  const open = rec.events.find((e) => e.type === 'INCIDENT_OPEN');
  assert.ok(open);
  assert.equal(open.detail?.payloadTier, 'lean', 'the card did not fit; the tier says so');

  const body = bodyOf(rec.http[0]);
  assert.equal(bytes(rec.http[0].body), FIXED_ENVELOPE_SIZE);
  assert.notEqual(body.sealedPayload, '', 'NOT the minimal fallback');
  const sealed = openJson<{ lat: number; lon: number; accuracyM: number; medical?: unknown }>(
    incidentContentKey(GROUP, id),
    body.sealedPayload as string,
    id,
  );
  assert.ok(sealed);
  assert.equal(sealed.lat, FIX.lat);
  assert.equal(sealed.lon, FIX.lon);
  assert.equal(sealed.accuracyM, FIX.accuracyM);
  assert.equal(sealed.medical, undefined, 'the card was the thing dropped');
});

test('a small medical card still travels in full', async () => {
  const small: MedicalCard = { ...FULL_CARD, allergies: ['Penicillin'], medications: [], conditions: [], iceContacts: [] };
  await router.initT0(makeDeps({ medical: () => small }));
  const id = router.onTrigger('MANUAL').incidentId as string;
  assert.equal(rec.events.find((e) => e.type === 'INCIDENT_OPEN')?.detail?.payloadTier, 'full');
  const sealed = openJson<{ medical?: MedicalCard }>(
    incidentContentKey(GROUP, id),
    bodyOf(rec.http[0]).sealedPayload as string,
    id,
  );
  assert.deepEqual(sealed?.medical, small);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ★ t0-1 · the BLE advert carries no duress bit
// ═══════════════════════════════════════════════════════════════════════════════

test('★ t0-1 · the 26-byte BLE distress advert carries a constant zero where the duress bit used to be', async () => {
  await router.initT0(makeDeps());
  const id = uuidv7();
  const advert = router.buildBleAdvert(id, 'MANUAL');
  assert.ok(advert);
  const raw = Uint8Array.from(atob(advert), (c) => c.charCodeAt(0));
  // pseudonym(8) ‖ inc8(8) ‖ meta(2) ‖ tag(8)
  assert.equal(raw.length, 26);
  assert.equal(String.fromCharCode(...raw.slice(8, 16)), inc8(id), 'the incident prefix, for F-09 dedupe');
  assert.equal(raw[16], 'S'.charCodeAt(0), 'trigger code byte');
  assert.equal(raw[17], 0, 'the duress slot is a constant 0 — the bit travels only inside the sealed payload');
  // And the router has no way to build it any other way: the signature takes no duress input.
  assert.equal(router.buildBleAdvert.length, 2);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Sensor candidates · SUSPECT → PROBE → PENDING, and the PROBE answer
// ═══════════════════════════════════════════════════════════════════════════════

function candidate(confidence: number) {
  return {
    confidence,
    trigger: 'FALL' as const,
    scores: { fall: confidence, crash: 0, noMotion: 0 },
    reasons: ['test'],
    window: {} as never,
    at: Date.now(),
  };
}

test('a medium-confidence fall goes to PROBE; "I\'m fine" returns to IDLE with the PROBE timer cleared', async () => {
  await router.initT0(makeDeps());
  router.noteSensorCandidate(candidate(0.6));
  assert.equal(router.currentState(), 'PROBE');
  assert.ok(rec.cues.includes('probe'));
  const suspectRows = rec.events.filter((e) => e.type === 'SENSOR_ANOMALY' || e.type === 'CONFIDENCE');
  assert.equal(suspectRows.length, 2, 'the suspicion is logged under the id it may become');
  const suspectId = suspectRows[0].incidentId;
  assert.ok(suspectRows.every((e) => e.incidentId === suspectId));

  router.probeRespond(true);
  assert.equal(router.currentState(), 'IDLE');
  assert.equal(rec.http.length, 0, 'nothing left the phone');
  rec.events = [];
  router.setContextElevated(true);
  assert.equal(rec.events.length, 0, 'a suspicion that resolved itself labels nothing afterwards');
});

test('a PROBE nobody answered opens PENDING under the same id and fans out', async () => {
  await router.initT0(makeDeps());
  router.noteSensorCandidate(candidate(0.6));
  const suspectId = rec.events[0].incidentId;
  router.probeRespond(false);
  assert.equal(router.currentState(), 'PENDING');
  const open = rec.events.find((e) => e.type === 'INCIDENT_OPEN');
  assert.ok(open);
  assert.equal(open.incidentId, suspectId, 'the incident keeps the id its SENSOR_ANOMALY row carried');
  assert.equal(rec.http.length, 2);
  assert.equal(bodyOf(rec.http[0]).trigger, 'FALL');
  // FALL's cancel window is loud (policy.loudCancel): the alarm sounds in PENDING.
  assert.ok(rec.alarm.some((a) => a.op === 'start'));
});

test('a high-confidence fall skips PROBE and opens PENDING directly', async () => {
  await router.initT0(makeDeps());
  router.noteSensorCandidate(candidate(0.95));
  assert.equal(router.currentState(), 'PENDING');
  assert.equal(rec.http.length, 2);
});
