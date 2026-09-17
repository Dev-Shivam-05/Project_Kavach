/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * :t0 PROCESS GUARD · the name must come from somewhere that cannot be null
 *
 * The guard `plugins/withKavachT0Process.js` injects into MainApplication used
 * to read the process name from `ActivityManager.runningAppProcesses`, which is
 * null on some OEM builds and omits the caller on others — and a null there was
 * read as "main". In that case React Native booted inside `:t0`, the ~15 MB
 * survival process became the whole runtime, and nothing logged it.
 *
 * `Application.getProcessName()` (API 28+) is authoritative; `/proc/self/cmdline`
 * covers 26–27; the ActivityManager list is the last resort, and an unknown
 * name is logged. `test/config-plugin.test.ts` covers injection; this pins the
 * lookup order.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { applyGuard } = require_(resolve(ROOT, 'plugins/withKavachT0Process.js')) as {
  applyGuard: (contents: string, language: 'kt' | 'java') => string;
};

const KOTLIN = 'class MainApplication : Application() {\n  override fun onCreate() {\n    super.onCreate()\n  }\n}\n';
const JAVA = 'public class MainApplication extends Application {\n  public void onCreate() {\n    super.onCreate();\n  }\n}\n';

for (const [language, template] of [
  ['kt', KOTLIN],
  ['java', JAVA],
] as const) {
  test(`${language}: getProcessName first, /proc/self/cmdline second, ActivityManager last`, () => {
    const out = applyGuard(template, language);
    const direct = out.indexOf('Application.getProcessName()');
    const cmdline = out.indexOf('/proc/self/cmdline');
    // Kotlin reads the `runningAppProcesses` property; Java calls `getRunningAppProcesses()`.
    const am = out.search(/runningAppProcesses/i);
    assert.ok(direct > -1, 'Application.getProcessName() missing');
    assert.ok(cmdline > -1, '/proc/self/cmdline fallback missing');
    assert.ok(am > -1, 'ActivityManager fallback missing');
    assert.ok(direct < cmdline && cmdline < am, 'lookup order is wrong');
    // getProcessName is API 28; the module ships to 26.
    assert.match(out, /SDK_INT >= 28/);
  });

  test(`${language}: an unknown name is logged, never silently "main"`, () => {
    const out = applyGuard(template, language);
    assert.match(out, /process name unknown/);
    assert.match(out, /Log\.w\("KavachT0"/);
  });

  test(`${language}: the decision is still "ends with :t0"`, () => {
    const out = applyGuard(template, language);
    assert.match(out, /endsWith\(":t0"\)/);
  });
}
