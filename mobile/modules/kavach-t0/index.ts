/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * KavachT0 · local expo-module entry point
 *
 * `mobile/src/t0/native.ts` deliberately does NOT import this file — it calls
 * `requireOptionalNativeModule('KavachT0')` directly so that the T0 bridge has
 * zero dependency on this package existing. That is the ADR-018 "fail OPEN"
 * rule applied to the build system itself: deleting this module must degrade
 * Kavach, never break its bundle.
 *
 * This entry point therefore exists for the two callers that are NOT on the
 * emergency path and want the wider surface: the provisioning flow and the
 * guardian-authenticated Device Owner release.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

import type { KavachT0NativeModule } from './src/KavachT0.types';

export * from './src/KavachT0.types';

/**
 * `null` in Expo Go, on iOS, and in any build where the Kotlin module failed to
 * link. Never throws — a throwing import would take the whole app down at
 * bundle-evaluation time, before a single safety feature could run.
 */
const KavachT0: KavachT0NativeModule | null =
  requireOptionalNativeModule<KavachT0NativeModule>('KavachT0');

export default KavachT0;

/** True only in an EAS build that actually contains the Kotlin T0 plane. */
export function isKavachT0Available(): boolean {
  return KavachT0 !== null;
}

/**
 * Throwing accessor for the provisioning / Device Owner screens. Those flows are
 * NOT on the panic path, so surfacing a hard error is correct there: silently
 * pretending to have locked a phone down is worse than an error dialog.
 */
export function requireKavachT0(): KavachT0NativeModule {
  if (KavachT0 === null) {
    throw new Error(
      'KavachT0 native module is unavailable. Device Owner and Direct Boot ' +
        'capabilities require a development or EAS build, not Expo Go.',
    );
  }
  return KavachT0;
}
