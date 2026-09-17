/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * NETWORK SECURITY CONFIG · cleartext is a per-variant decision, written down
 * (F-01 · F-05)
 *
 * `plugins/withKavachNetworkSecurity.js` writes one `network_security_config`
 * resource into two source sets — main forbids cleartext, debug permits it —
 * and points `<application>` at it. Release variants (`preview`, `production`)
 * therefore refuse an `http://` base, which is correct for an envelope that
 * carries the duress bit in the clear; the dev client keeps the LAN path.
 * The plugin runs only at prebuild; these tests drive its pure halves.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

type ManifestApplication = { $: Record<string, string> };
type AndroidManifest = { manifest: { application?: ManifestApplication[] } };

const plugin = require_(resolve(ROOT, 'plugins/withKavachNetworkSecurity.js')) as {
  RESOURCE_NAME: string;
  renderXml(cleartextPermitted: boolean): string;
  filesFor(platformProjectRoot: string): { path: string; contents: string }[];
  setNetworkSecurityConfig(manifest: AndroidManifest): AndroidManifest;
};

test('★ the release resource forbids cleartext; the debug resource permits it', () => {
  assert.match(plugin.renderXml(false), /cleartextTrafficPermitted="false"/);
  assert.match(plugin.renderXml(true), /cleartextTrafficPermitted="true"/);
});

test('the resource decides cleartext only — no trust-anchors, so system CAs stay the default', () => {
  for (const permitted of [true, false]) {
    const xml = plugin.renderXml(permitted);
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>'));
    assert.match(xml, /<network-security-config>/);
    assert.doesNotMatch(xml, /trust-anchors/);
    assert.doesNotMatch(xml, /pin-set/, 'no origin exists to pin; an invented pin bricks every request');
  }
});

test('one resource name, two source sets, debug outranking main', () => {
  const root = join(sep, 'build', 'android');
  const files = plugin.filesFor(root);
  assert.equal(files.length, 2);

  const main = files.find((f) => f.path.includes(join('src', 'main', 'res', 'xml')));
  const debug = files.find((f) => f.path.includes(join('src', 'debug', 'res', 'xml')));
  assert.ok(main, 'no main-source-set file');
  assert.ok(debug, 'no debug-source-set file');
  assert.ok(main!.path.endsWith(`${plugin.RESOURCE_NAME}.xml`));
  assert.ok(debug!.path.endsWith(`${plugin.RESOURCE_NAME}.xml`));
  assert.ok(main!.path.startsWith(join(root, 'app')));
  assert.match(main!.contents, /cleartextTrafficPermitted="false"/);
  assert.match(debug!.contents, /cleartextTrafficPermitted="true"/);
});

test('the manifest is pointed at the resource', () => {
  const manifest: AndroidManifest = {
    manifest: { application: [{ $: { 'android:name': '.MainApplication' } }] },
  };
  const out = plugin.setNetworkSecurityConfig(manifest);
  assert.equal(
    out.manifest.application![0].$['android:networkSecurityConfig'],
    `@xml/${plugin.RESOURCE_NAME}`,
  );
});

test('applying the manifest step twice is a no-op', () => {
  const manifest: AndroidManifest = {
    manifest: { application: [{ $: { 'android:name': '.MainApplication' } }] },
  };
  const once = JSON.stringify(plugin.setNetworkSecurityConfig(manifest));
  const twice = JSON.stringify(plugin.setNetworkSecurityConfig(JSON.parse(once)));
  assert.equal(twice, once);
});

test('the plugin is registered in app.json, and app.json does not also set usesCleartextTraffic', () => {
  const appJson = require_(resolve(ROOT, 'app.json')) as {
    expo: { plugins: (string | [string, Record<string, unknown>])[] };
  };
  const names = appJson.expo.plugins.map((p) => (typeof p === 'string' ? p : p[0]));
  assert.ok(names.some((n) => n.includes('withKavachNetworkSecurity')));

  // A network security config overrides android:usesCleartextTraffic; setting
  // both would leave two places that look like the policy and one that is.
  const buildProps = appJson.expo.plugins.find(
    (p): p is [string, Record<string, unknown>] => Array.isArray(p) && p[0] === 'expo-build-properties',
  );
  assert.ok(buildProps, 'expo-build-properties block missing');
  const android = (buildProps![1] as { android?: Record<string, unknown> }).android ?? {};
  assert.equal(android.usesCleartextTraffic, undefined);
});
