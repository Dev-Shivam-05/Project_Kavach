/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * T0 MANIFEST AND PERMISSION LIST · declare what a component actually uses
 * (P-022 · P-031 · P-035 · P-042)
 *
 * Three things here are invisible to every compiler and only ever fail on a
 * phone, so they are pinned as text:
 *
 *  · ShutdownReceiver honours two OEM QUICKBOOT actions that are NOT protected
 *    broadcasts. Without a sender permission any installed app can fire a fake
 *    Final Breath — location over SMS, to every emergency number — during an
 *    incident. `android.permission.SHUTDOWN` is signature|privileged; the
 *    system_server that really powers the phone off always passes.
 *  · A FOREGROUND_SERVICE_<TYPE> permission with no service of that type is a
 *    Play-review question with no answer and a capability that cannot exist.
 *  · The pre-unlock config is shared by two processes; the flag and the
 *    re-apply that make that work are one word each and easy to "tidy" away.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = resolve(ROOT, 'modules/kavach-t0/android/src/main');
const manifest = readFileSync(resolve(MODULE, 'AndroidManifest.xml'), 'utf8');
const service = readFileSync(resolve(MODULE, 'java/expo/modules/kavacht0/KavachForegroundService.kt'), 'utf8');
const module_ = readFileSync(resolve(MODULE, 'java/expo/modules/kavacht0/KavachT0Module.kt'), 'utf8');
const appJson = JSON.parse(readFileSync(resolve(ROOT, 'app.json'), 'utf8')) as {
  expo: { android: { versionCode: number; permissions: string[] } };
};
const permissions = new Set(appJson.expo.android.permissions);

/** The `<receiver …>` opening tag for one class, attributes included. */
function receiverTag(className: string): string {
  const re = new RegExp(`<receiver[^>]*android:name="expo\\.modules\\.kavacht0\\.${className}"[^>]*>`);
  const m = manifest.match(re);
  assert.ok(m, `no <receiver> for ${className}`);
  return m![0];
}

test('★ ShutdownReceiver requires the sender to hold android.permission.SHUTDOWN (P-022)', () => {
  const tag = receiverTag('ShutdownReceiver');
  assert.match(tag, /android:exported="true"/);
  assert.match(
    tag,
    /android:permission="android\.permission\.SHUTDOWN"/,
    'the QUICKBOOT_POWEROFF actions are unprotected; without a sender permission any app can fake a Final Breath',
  );
  // The gate must not have been "fixed" by dropping the OEM actions instead.
  assert.match(manifest, /android\.intent\.action\.QUICKBOOT_POWEROFF/);
  assert.match(manifest, /com\.htc\.intent\.action\.QUICKBOOT_POWEROFF/);
});

test('BootReceiver stays open: its three actions are all protected broadcasts', () => {
  const tag = receiverTag('BootReceiver');
  assert.doesNotMatch(tag, /android:permission=/);
});

test('★ every FOREGROUND_SERVICE_<TYPE> permission is backed by a service that declares that type', () => {
  // Types the merged manifest actually declares: the T0 agent's, plus
  // expo-location's LocationTaskService (`location`, enabled in app.json via
  // isAndroidForegroundServiceEnabled).
  const declaredTypes = new Set<string>(['location']);
  for (const m of manifest.matchAll(/foregroundServiceType="([^"]+)"/g)) {
    for (const t of m[1].split('|')) declaredTypes.add(t.trim());
  }
  const typeForPermission: Record<string, string> = {
    FOREGROUND_SERVICE_LOCATION: 'location',
    FOREGROUND_SERVICE_CONNECTED_DEVICE: 'connectedDevice',
    FOREGROUND_SERVICE_CAMERA: 'camera',
    FOREGROUND_SERVICE_MICROPHONE: 'microphone',
    FOREGROUND_SERVICE_MEDIA_PLAYBACK: 'mediaPlayback',
    FOREGROUND_SERVICE_DATA_SYNC: 'dataSync',
    FOREGROUND_SERVICE_MEDIA_PROJECTION: 'mediaProjection',
  };
  for (const p of permissions) {
    const short = p.replace('android.permission.', '');
    if (!short.startsWith('FOREGROUND_SERVICE_')) continue;
    const type = typeForPermission[short];
    assert.ok(type, `unknown foreground-service permission ${short}; extend the map`);
    assert.ok(
      declaredTypes.has(type),
      `${short} is declared in app.json but no <service> declares foregroundServiceType "${type}" — ` +
        'add the service (and its Kotlin) in the same change, or drop the permission',
    );
  }
  assert.ok(permissions.has('android.permission.FOREGROUND_SERVICE_LOCATION'));
  assert.ok(permissions.has('android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE'));
});

test('permissions with no code path are gone; the ones a planned row needs are kept and commented', () => {
  for (const gone of [
    'android.permission.USE_EXACT_ALARM', // makes canScheduleExactAlarms() always true; Play restricts it to alarm/calendar apps
    'android.permission.BODY_SENSORS', // no heart-rate code, no PHASES row
  ]) {
    assert.ok(!permissions.has(gone), `${gone} is declared and nothing uses it`);
  }
  // SCHEDULE_EXACT_ALARM is what the diagnostics row (REQUEST_SCHEDULE_EXACT_ALARM)
  // and the planned 1.13 watchdog are built around.
  assert.ok(permissions.has('android.permission.SCHEDULE_EXACT_ALARM'));

  // BLUETOOTH_SCAN moved to the module manifest, where its reservation for the
  // planned FIND_ME scanner / mesh relay can carry a comment.
  assert.ok(!permissions.has('android.permission.BLUETOOTH_SCAN'));
  assert.match(manifest, /android\.permission\.BLUETOOTH_SCAN/);
  assert.match(manifest, /RESERVED/);
  assert.match(manifest, /PHASES\.md/);

  // READ_PHONE_NUMBERS only unlocks SubscriptionInfo.getNumber(), which T0Sms never reads.
  // `plan.number` is SmsPlan's RECIPIENT, not a SIM's own number, so it is exempt.
  assert.doesNotMatch(manifest, /READ_PHONE_NUMBERS"/);
  assert.doesNotMatch(module_, /getNumber\(|(?<!plan)\.number\b/);
});

test('versionCode moved past the 28 Jul preview build', () => {
  assert.ok(Number.isInteger(appJson.expo.android.versionCode));
  assert.ok(appJson.expo.android.versionCode >= 3, 'the shipped preview build was versionCode 2');
});

test('★ the pre-unlock config survives being written from two processes (P-035)', () => {
  // T0Config is written from the main process (JS provisioning, KeyVault) and
  // from :t0 (heartbeats). Without MODE_MULTI_PROCESS each process serves reads
  // from a copy it loaded once, and the agent never sees incidentActive change.
  assert.match(service, /MODE_PRIVATE or Context\.MODE_MULTI_PROCESS/);
  // …and the fields the agent acts on are re-applied inside :t0 before its first read.
  const start = service.indexOf('override fun onStartCommand');
  const reapply = service.indexOf('T0Config.provisioningFromExtras(intent?.extras)', start);
  const firstRead = service.indexOf('T0Config.snapshot(dps)', start);
  assert.ok(start > -1 && reapply > -1 && firstRead > -1);
  assert.ok(reapply < firstRead, 'the extras must be applied BEFORE the snapshot is read');
  // …and the main-process write is on disk before the START intent is sent.
  const writeProvisioning = service.slice(service.indexOf('fun writeProvisioning'));
  assert.match(writeProvisioning.slice(0, writeProvisioning.indexOf('\n  }')), /e\.commit\(\)/);
});

test('a refused foreground-service start rejects instead of resolving (P-031)', () => {
  assert.match(service, /fun start\(context: Context, options: ForegroundAgentOptions\? = null\): Boolean/);
  assert.match(module_, /if \(!KavachForegroundService\.start\(context, options\)\)/);
  assert.match(module_, /throw AgentStartRefusedException\(\)/);
});

test('checkPermissions omits a probe the platform would not answer, and carries agent health', () => {
  for (const probe of [
    'batteryOptimisationExempt',
    'notBackgroundRestricted',
    'exactAlarmsPermitted',
    'notificationsEnabled',
    'dndBypassGranted',
    'autoRevokeDisabled',
  ]) {
    assert.match(module_, new RegExp(`putIfKnown\\("${probe}"`), `${probe} must be omitted when unknown, not defaulted`);
    assert.match(module_, new RegExp(`private fun ${probe}\\(ctx: Context\\): Boolean\\?`));
  }
  // The documented pessimist stays a plain boolean.
  assert.match(module_, /putBoolean\("t0SigningAvailablePredawn"/);
  assert.match(module_, /putString\("agentBlockedReason"/);
  assert.match(module_, /putDouble\("lastHeartbeatAt"/);
});

test('the notifications deep link carries EXTRA_APP_PACKAGE, not a package: URI', () => {
  assert.match(module_, /Settings\.ACTION_APP_NOTIFICATION_SETTINGS ->\s*putExtra\(Settings\.EXTRA_APP_PACKAGE, context\.packageName\)/);
  const scoped = module_.slice(module_.indexOf('val PACKAGE_SCOPED_ACTIONS'));
  assert.doesNotMatch(scoped.slice(0, scoped.indexOf(')')), /APP_NOTIFICATION_SETTINGS/);
});

test('the BLE TTL runnable is tracked and cancelled by the next call', () => {
  assert.match(module_, /private var advertiseStop: Runnable\? = null/);
  const stop = module_.slice(module_.indexOf('private fun stopAdvertising()'));
  assert.match(stop.slice(0, 600), /advertiseStop\?\.let \{ auxHandler\?\.removeCallbacks\(it\) \}/);
});
