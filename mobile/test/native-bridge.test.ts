/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * NATIVE BRIDGE NAME PARITY
 *
 * The JS side calls into Kotlin BY NAME through the Expo modules bridge. A name
 * that exists on one side and not the other is invisible to both compilers:
 * TypeScript is satisfied by the declared interface, Kotlin is satisfied because
 * nothing references it, and Gradle builds cleanly. The failure appears only at
 * runtime, on a real device, in the APK — and for most of these functions, only
 * during an actual emergency.
 *
 * `sendSmsDirect` is the one that matters: if that name drifts, the SMS
 * transport throws inside the T0 dispatcher at the exact moment data has already
 * failed. Every other transport has a peer; SMS is the floor.
 *
 * This test reads both files as text rather than importing them — the Kotlin
 * cannot be imported, and the whole point is to compare the two sources of truth
 * directly.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KOTLIN = resolve(
  ROOT,
  'modules/kavach-t0/android/src/main/java/expo/modules/kavacht0/KavachT0Module.kt',
);
const TYPES = resolve(ROOT, 'modules/kavach-t0/src/KavachT0.types.ts');
const BRIDGE = resolve(ROOT, 'src/t0/native.ts');

/** Function names the Kotlin module actually exposes to JS. */
function kotlinExports(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/(?:Async)?Function\(\s*"([A-Za-z0-9_]+)"/g)) out.add(m[1]);
  return out;
}

/** Method names declared on the TypeScript-side module interface. */
function declaredMethods(src: string): Set<string> {
  const out = new Set<string>();
  // e.g. `  sendSmsDirect(numbers: string[], body: string): Promise<...>;`
  //      `  getProximityCm?(): Promise<number>;`
  for (const m of src.matchAll(/^\s{2}([a-zA-Z][A-Za-z0-9_]*)\??\s*\(/gm)) out.add(m[1]);
  return out;
}

test('the Kotlin module registers under the name the JS bridge looks up', () => {
  const kt = readFileSync(KOTLIN, 'utf8');
  const bridge = readFileSync(BRIDGE, 'utf8');

  const nameMatch = kt.match(/Name\(\s*"([A-Za-z0-9_]+)"\s*\)/);
  assert.ok(nameMatch, 'KavachT0Module.kt must declare Name("…")');
  const registered = nameMatch![1];

  const lookup = bridge.match(/requireOptionalNativeModule<[^>]*>\(\s*'([A-Za-z0-9_]+)'\s*\)/);
  assert.ok(lookup, 'native.ts must call requireOptionalNativeModule');
  assert.equal(
    lookup![1],
    registered,
    'the module name JS looks up does not match the one Kotlin registers — ' +
      'requireOptionalNativeModule would return null and the APK would silently ' +
      'behave exactly like Expo Go',
  );
});

test('every method the TypeScript interface declares exists in Kotlin', () => {
  if (!existsSync(KOTLIN) || !existsSync(TYPES)) {
    assert.fail('native module sources are missing — is modules/ gitignored again?');
  }
  const declared = declaredMethods(readFileSync(TYPES, 'utf8'));
  const exported = kotlinExports(readFileSync(KOTLIN, 'utf8'));

  assert.ok(declared.size >= 10, `expected the full T0 surface, found ${declared.size}`);

  const missing = [...declared].filter((n) => !exported.has(n));
  assert.deepEqual(
    missing,
    [],
    `declared in TypeScript but NOT implemented in Kotlin: ${missing.join(', ')} — ` +
      'these throw at runtime on a real device, not at build time',
  );
});

test('Kotlin exposes nothing the TypeScript interface has not declared', () => {
  // Not a correctness failure, but an undeclared export is native capability the
  // app can never reach — usually a rename that was only half applied.
  const declared = declaredMethods(readFileSync(TYPES, 'utf8'));
  const exported = kotlinExports(readFileSync(KOTLIN, 'utf8'));
  const orphaned = [...exported].filter((n) => !declared.has(n));
  assert.deepEqual(
    orphaned,
    [],
    `implemented in Kotlin but undeclared in TypeScript: ${orphaned.join(', ')}`,
  );
});

test('★ the SMS transport name is present on both sides', () => {
  // Called out separately because it is the floor of the degradation ladder: it
  // fires when every data path has already failed, so a drift here is only ever
  // discovered during a real emergency.
  const exported = kotlinExports(readFileSync(KOTLIN, 'utf8'));
  const bridge = readFileSync(BRIDGE, 'utf8');
  assert.ok(exported.has('sendSmsDirect'), 'Kotlin must implement sendSmsDirect');
  assert.match(bridge, /\bsendSmsDirect\b/, 'native.ts must route SMS through sendSmsDirect');
});

test('the native module declares the android platform and its module class', () => {
  const cfg = JSON.parse(
    readFileSync(resolve(ROOT, 'modules/kavach-t0/expo-module.config.json'), 'utf8'),
  );
  assert.ok(cfg.platforms?.includes('android'), 'expo-module.config.json must list android');
  assert.ok(
    (cfg.android?.modules ?? []).some((m: string) => m.endsWith('KavachT0Module')),
    'expo-module.config.json must point at KavachT0Module, or autolinking skips it entirely',
  );
});

test('the Android manifest declares the Direct Boot entry points (P-035)', () => {
  const manifest = readFileSync(
    resolve(ROOT, 'modules/kavach-t0/android/src/main/AndroidManifest.xml'),
    'utf8',
  );
  // Without directBootAware the agent is dead from a 2 a.m. reboot until someone
  // unlocks the phone — a silent multi-hour outage most implementations ship.
  assert.match(manifest, /directBootAware="true"/, 'Direct Boot awareness missing');
  assert.match(manifest, /LOCKED_BOOT_COMPLETED/, 'LOCKED_BOOT_COMPLETED receiver missing');
  assert.match(manifest, /ACTION_SHUTDOWN/, 'Final Breath receiver missing (P-022)');
});
