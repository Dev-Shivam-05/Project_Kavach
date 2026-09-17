/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * RELEASE GUARD · the emulator default must not reach a real phone in silence
 * (F-05 · RISK §1 · D-004)
 *
 * `plugins/withKavachReleaseGuard.js` resolves every transport base the way
 * `src/core/config.ts` does and writes a warning into the EAS build log when a
 * non-development profile is about to bake `10.0.2.2` — the Android emulator's
 * alias for the host, which resolves to nothing on a handset. The plugin runs
 * only on the build server; this test drives its pure audit function so the
 * rule is checked here in a second rather than discovered in a 15-minute build.
 *
 * No host name in this file is real: `.invalid` is the RFC 2606 reserved TLD.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface Audit {
  audited: boolean;
  profile?: string;
  warnings: string[];
}

const guard = require_(resolve(ROOT, 'plugins/withKavachReleaseGuard.js')) as {
  auditReleaseConfig(input: {
    profile?: string;
    env: Record<string, string | undefined>;
    extra: Record<string, unknown>;
  }): Audit;
  formatWarnings(profile: string | undefined, warnings: string[]): string[];
  EMULATOR_HOST: string;
  BASES: { env: string; extra: string; label: string }[];
};

/** What app.json carries today, verbatim in shape. */
const EMULATOR_EXTRA = {
  apiBase: 'http://10.0.2.2:8081',
  apiDirect: 'http://10.0.2.2:8081',
  wsBase: 'ws://10.0.2.2:8082',
};

const REAL_ENV = {
  EXPO_PUBLIC_KAVACH_API: 'https://ingest.invalid',
  EXPO_PUBLIC_KAVACH_API_DIRECT: 'https://origin.invalid',
  EXPO_PUBLIC_KAVACH_CONTROL: 'https://control.invalid',
  EXPO_PUBLIC_KAVACH_WS: 'wss://rt.invalid',
};

test('the development profile is never audited — the emulator default is its job', () => {
  const r = guard.auditReleaseConfig({ profile: 'development', env: {}, extra: EMULATOR_EXTRA });
  assert.equal(r.audited, false);
  assert.deepEqual(r.warnings, []);
});

test('a local prebuild (no EAS_BUILD_PROFILE) is not audited either', () => {
  const r = guard.auditReleaseConfig({ profile: undefined, env: {}, extra: EMULATOR_EXTRA });
  assert.equal(r.audited, false);
  assert.deepEqual(r.warnings, []);
});

test('★ preview with no env and the app.json defaults warns once per base, naming 10.0.2.2', () => {
  const r = guard.auditReleaseConfig({ profile: 'preview', env: {}, extra: EMULATOR_EXTRA });
  assert.equal(r.audited, true);
  assert.equal(r.warnings.length, guard.BASES.length, r.warnings.join('\n'));
  for (const w of r.warnings) assert.match(w, /10\.0\.2\.2/);
  for (const base of guard.BASES) {
    assert.ok(
      r.warnings.some((w) => w.startsWith(base.label)),
      `no warning for ${base.label}`,
    );
  }
});

test('production with nothing set at all warns that every base is unset', () => {
  const r = guard.auditReleaseConfig({ profile: 'production', env: {}, extra: {} });
  assert.equal(r.warnings.length, guard.BASES.length);
  for (const w of r.warnings) assert.match(w, /is unset/);
});

test('env wins over extra, exactly as config.ts resolves it', () => {
  const r = guard.auditReleaseConfig({ profile: 'preview', env: REAL_ENV, extra: EMULATOR_EXTRA });
  assert.deepEqual(r.warnings, []);
});

test('an empty env var does not count as set (config.ts treats "" as unset)', () => {
  const r = guard.auditReleaseConfig({
    profile: 'preview',
    env: { ...REAL_ENV, EXPO_PUBLIC_KAVACH_WS: '' },
    extra: {},
  });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /^wsBase/);
  assert.match(r.warnings[0], /is unset/);
});

test('a partial env warns only for the legs still on the default', () => {
  const r = guard.auditReleaseConfig({
    profile: 'production',
    env: { EXPO_PUBLIC_KAVACH_API: REAL_ENV.EXPO_PUBLIC_KAVACH_API },
    extra: EMULATOR_EXTRA,
  });
  // apiDirect, controlBase and wsBase still resolve to the emulator.
  assert.equal(r.warnings.length, 3, r.warnings.join('\n'));
  assert.ok(r.warnings.every((w) => !w.startsWith('apiBase (')));
});

test('a real host over http:// / ws:// is called out as cleartext, which release blocks', () => {
  const r = guard.auditReleaseConfig({
    profile: 'preview',
    env: { ...REAL_ENV, EXPO_PUBLIC_KAVACH_API: 'http://ingest.invalid', EXPO_PUBLIC_KAVACH_WS: 'ws://rt.invalid' },
    extra: {},
  });
  assert.equal(r.warnings.length, 2, r.warnings.join('\n'));
  for (const w of r.warnings) assert.match(w, /cleartext/);
});

test('formatWarnings is silent when there is nothing to say, loud otherwise', () => {
  assert.deepEqual(guard.formatWarnings('preview', []), []);
  const lines = guard.formatWarnings('preview', ['apiBase: bad']);
  assert.ok(lines.some((l) => l.includes('KAVACH RELEASE GUARD')));
  assert.ok(lines.some((l) => l.includes('"preview"')));
  assert.ok(lines.some((l) => l.includes('apiBase: bad')));
  assert.ok(lines.some((l) => l.includes('EXPO_PUBLIC_KAVACH_API')));
});

test('the guard and config.ts agree on what the emulator default is', () => {
  // The plugin never duplicates config.ts's default URLs — it only knows the
  // host. If config.ts stops falling back to it, this pin says the guard is stale.
  const config = readFileSync(resolve(ROOT, 'src/core/config.ts'), 'utf8');
  assert.ok(config.includes(guard.EMULATOR_HOST), 'config.ts no longer mentions the emulator host');
  for (const base of guard.BASES) {
    assert.ok(config.includes(`'${base.env}'`), `config.ts does not read ${base.env}`);
  }
});

test('the plugin is registered in app.json', () => {
  const appJson = require_(resolve(ROOT, 'app.json')) as { expo: { plugins: (string | unknown[])[] } };
  const names = appJson.expo.plugins.map((p) => (typeof p === 'string' ? p : String((p as unknown[])[0])));
  assert.ok(names.some((n) => n.includes('withKavachReleaseGuard')), 'withKavachReleaseGuard is not in app.json');
});

test('★ every eas.json profile names the EAS environment its variables come from', () => {
  // No host lives in eas.json on purpose (none exists to write). What must be
  // there is the pointer to where they DO live: the EAS environment of the same
  // name. A profile without it silently builds against whatever EAS infers.
  const eas = require_(resolve(ROOT, 'eas.json')) as {
    build: Record<string, { environment?: string; developmentClient?: boolean }>;
  };
  for (const name of ['development', 'preview', 'production']) {
    const profile = eas.build[name];
    assert.ok(profile, `eas.json has no "${name}" profile`);
    assert.equal(profile.environment, name, `profile "${name}" must declare environment "${name}"`);
  }
  assert.equal(eas.build.development.developmentClient, true);
});
