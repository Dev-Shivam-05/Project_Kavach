/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Config plugin · the release switch, audited at build time (F-05 · RISK §1 · D-004)
 *
 * `app.json`'s `extra` block is static — the same in every EAS profile — and it
 * carries the Android EMULATOR's alias for the host machine, `10.0.2.2`, as the
 * default for every transport base (`src/core/config.ts`). On a real handset
 * that host resolves to nothing, so a `preview` or `production` build that
 * still carries it has no reachable sos-ingest, control-plane or realtime-gw,
 * and the app degrades to SMS/BLE with nothing failing loudly anywhere.
 *
 * ★ HOW A REAL BUILD IS POINTED AT A REAL SERVER ★
 * `config.ts` reads these at bundle time, env first, `extra` second, emulator
 * default last:
 *
 *   EXPO_PUBLIC_KAVACH_API         sos-ingest, primary (behind the CDN)
 *   EXPO_PUBLIC_KAVACH_API_DIRECT  sos-ingest, straight to origin (F-05)
 *   EXPO_PUBLIC_KAVACH_CONTROL     control-plane
 *   EXPO_PUBLIC_KAVACH_WS          realtime-gw (wss://)
 *   EXPO_PUBLIC_KAVACH_TURN_URL / _TURN_USER / _TURN_PASS   optional relay (D1)
 *
 * They are NOT written into `eas.json` — no host name exists in this repository
 * to write, and a placeholder would be a lie that builds green. Each profile in
 * `eas.json` names an EAS `environment` (`development` / `preview` /
 * `production`); the values live in EAS environment variables for that
 * environment (`eas env:create --environment preview --name EXPO_PUBLIC_KAVACH_API
 * --value https://…`, or the project's Environment variables page) and EAS
 * exports them into the build job before prebuild and bundling run.
 *
 * ★ WHAT THIS PLUGIN DOES ★
 * Nothing to the app. It runs during `expo prebuild` on the build server, where
 * `EAS_BUILD_PROFILE` names the profile, resolves each base exactly the way
 * `config.ts` will, and writes a WARNING into the build log when a
 * non-development profile is about to bake the emulator host — or an `http://`
 * / `ws://` base, which `withKavachNetworkSecurity` blocks in release variants.
 * It warns rather than refuses because there is, today, no server for it to
 * insist on; the decision to make it refuse is recorded in the handoff, not
 * taken here. `CONFIG.serverConfigured` (config.ts) is the same fact surfaced
 * inside the app.
 *
 * `auditReleaseConfig` is exported and pure so `test/release-guard.test.ts`
 * can drive it without a build.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

/** The Android emulator's alias for the host — `src/core/config.ts`'s default. */
const EMULATOR_HOST = '10.0.2.2';

/** The profile whose job is to run against the emulator/LAN backend. */
const DEVELOPMENT_PROFILE = 'development';

/**
 * One row per transport base, in `config.ts` order. `extra` is the `app.json`
 * key `config.ts` falls back to when the env var is unset — note controlBase
 * genuinely falls back to `apiBase` there (PROJECT_MAP "Known broken").
 */
const BASES = [
  { env: 'EXPO_PUBLIC_KAVACH_API', extra: 'apiBase', label: 'apiBase (sos-ingest, via CDN)' },
  { env: 'EXPO_PUBLIC_KAVACH_API_DIRECT', extra: 'apiDirect', label: 'apiDirect (sos-ingest, origin)' },
  { env: 'EXPO_PUBLIC_KAVACH_CONTROL', extra: 'apiBase', label: 'controlBase (control-plane)' },
  { env: 'EXPO_PUBLIC_KAVACH_WS', extra: 'wsBase', label: 'wsBase (realtime-gw)' },
];

const CLEARTEXT_SCHEME = /^(http|ws):\/\//i;

/**
 * Resolve every base the way `config.ts` does — a non-empty env var wins, then
 * the `extra` key, then "unset" (which means the emulator default at runtime).
 */
function resolveBases(env, extra) {
  return BASES.map((base) => {
    const fromEnv = typeof env[base.env] === 'string' && env[base.env].length > 0 ? env[base.env] : undefined;
    const fromExtra =
      typeof extra[base.extra] === 'string' && extra[base.extra].length > 0 ? extra[base.extra] : undefined;
    if (fromEnv !== undefined) return { ...base, value: fromEnv, source: 'env' };
    if (fromExtra !== undefined) return { ...base, value: fromExtra, source: 'extra' };
    return { ...base, value: undefined, source: 'default' };
  });
}

/**
 * Pure. Returns the warnings a build with this profile/env/extra deserves.
 * An empty `warnings` array means the build is pointed somewhere real.
 *
 * @param {{ profile?: string, env: Record<string, string | undefined>, extra: Record<string, unknown> }} input
 * @returns {{ audited: boolean, profile?: string, bases: object[], warnings: string[] }}
 */
function auditReleaseConfig({ profile, env, extra }) {
  const bases = resolveBases(env ?? {}, extra ?? {});
  // No EAS_BUILD_PROFILE means a local `expo prebuild` / `expo run:android`,
  // which is the emulator/LAN path by definition. Same for the dev client.
  if (!profile || profile === DEVELOPMENT_PROFILE) {
    return { audited: false, profile, bases, warnings: [] };
  }

  const warnings = [];
  for (const base of bases) {
    if (base.value === undefined) {
      warnings.push(
        `${base.label}: ${base.env} is unset and app.json extra.${base.extra} is empty — ` +
          `the app will use its emulator default (${EMULATOR_HOST}), which no real phone can reach.`,
      );
      continue;
    }
    if (base.value.includes(EMULATOR_HOST)) {
      warnings.push(
        `${base.label}: resolves to "${base.value}" (from ${base.source}) — ${EMULATOR_HOST} is the ` +
          `Android emulator's alias for the host machine and no real phone can reach it.`,
      );
      continue;
    }
    if (CLEARTEXT_SCHEME.test(base.value)) {
      warnings.push(
        `${base.label}: resolves to "${base.value}" (from ${base.source}) — a cleartext scheme. ` +
          `Release variants block cleartext (plugins/withKavachNetworkSecurity.js); use https:// / wss://.`,
      );
    }
  }
  return { audited: true, profile, bases, warnings };
}

/** The lines written to the build log. Exported for the test. */
function formatWarnings(profile, warnings) {
  if (warnings.length === 0) return [];
  return [
    '',
    '★★★ KAVACH RELEASE GUARD ★★★',
    `EAS profile "${profile}" is being built against the emulator/default configuration:`,
    ...warnings.map((w) => `  - ${w}`),
    'Set EXPO_PUBLIC_KAVACH_API / _API_DIRECT / _CONTROL / _WS as EAS environment variables',
    `for the "${profile}" environment (see plugins/withKavachReleaseGuard.js). This build will`,
    'install and run, and every network leg of an SOS will fail on a real handset.',
    '',
  ];
}

module.exports = function withKavachReleaseGuard(config) {
  const result = auditReleaseConfig({
    profile: process.env.EAS_BUILD_PROFILE,
    env: process.env,
    extra: (config.extra ?? {}),
  });
  for (const line of formatWarnings(result.profile, result.warnings)) {
    // console.warn, not a throw: see the header. The build log is the record.
    console.warn(line);
  }
  return config;
};

module.exports.auditReleaseConfig = auditReleaseConfig;
module.exports.resolveBases = resolveBases;
module.exports.formatWarnings = formatWarnings;
module.exports.EMULATOR_HOST = EMULATOR_HOST;
module.exports.BASES = BASES;
