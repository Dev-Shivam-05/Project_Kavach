/**
 * Node test shim.
 *
 * The pure-logic layers of Kavach (state machine, crypto, SMS encoder, envelope,
 * HLC/ids, risk context, geofence) are deliberately free of React Native
 * dependencies so they can be tested — and reasoned about — outside a device.
 * The only exception is `react-native-get-random-values`, a polyfill that exists
 * solely because Hermes lacks a CSPRNG. Node has one natively, so we redirect
 * that specifier to a no-op here.
 *
 * Run with:
 *   node --experimental-transform-types --import ./test/shim.mjs --test test/
 */
import { registerHooks } from 'node:module';

const STUBS = new Set([
  'react-native-get-random-values',
  'expo-constants',
  'react-native',
  'expo-secure-store',
  'expo-file-system',
  'expo-sqlite',
  'expo-notifications',
  'expo-router',
]);

const STUB_SOURCE = {
  'react-native-get-random-values': 'export default {};',
  'expo-constants': 'export default { expoConfig: { extra: {} } };',
  'react-native': `
    export const Platform = { OS: 'android', select: (o) => o.android ?? o.default };
    export const StyleSheet = { create: (s) => s, hairlineWidth: 1 };
    export default { Platform, StyleSheet };
  `,
  'expo-secure-store': `
    const mem = new Map();
    export async function getItemAsync(k) { return mem.has(k) ? mem.get(k) : null; }
    export async function setItemAsync(k, v) { mem.set(k, v); }
    export async function deleteItemAsync(k) { mem.delete(k); }
  `,
  'expo-file-system': `
    export class File { constructor() { this.exists = false; } create() {} write() {} textSync() { return ''; } delete() {} }
    export class Directory { constructor() {} create() {} }
    export const Paths = { cache: '/tmp', document: '/tmp', bundle: '/tmp' };
  `,
  'expo-sqlite': `
    export async function openDatabaseAsync() {
      return {
        execAsync: async () => {}, runAsync: async () => ({ lastInsertRowId: 1, changes: 1 }),
        getAllAsync: async () => [], getFirstAsync: async () => null,
        withTransactionAsync: async (fn) => fn(),
      };
    }
  `,
  /**
   * The push-token half of notifications.ts is pure decision logic — which
   * shapes count as a usable FCM token and which are treated as "no token" —
   * and that logic is what stands between a family phone being addressable and
   * silently not. It is worth testing off-device, so the stub is CONTROLLABLE:
   * __pushToken sets what the next getDevicePushTokenAsync() resolves to, and an
   * Error value is thrown instead (the missing-Firebase-config case).
   */
  'expo-notifications': `
    export const __state = { token: null, listeners: [] };
    export function __setDevicePushToken(v) { __state.token = v; }
    export function __emitPushToken(v) { for (const l of __state.listeners) l(v); }
    export function __listenerCount() { return __state.listeners.length; }
    export async function getDevicePushTokenAsync() {
      if (__state.token instanceof Error) throw __state.token;
      return __state.token;
    }
    export function addPushTokenListener(listener) {
      __state.listeners.push(listener);
      return { remove() { __state.listeners = __state.listeners.filter((l) => l !== listener); } };
    }
    export function setNotificationHandler() {}
    export async function setNotificationChannelAsync() {}
    export async function setNotificationCategoryAsync() {}
    export async function getPermissionsAsync() { return { granted: true, canAskAgain: true }; }
    export async function requestPermissionsAsync() { return { granted: true }; }
    export async function scheduleNotificationAsync() {}
    export async function dismissNotificationAsync() {}
    export async function cancelScheduledNotificationAsync() {}
    export async function getLastNotificationResponseAsync() { return null; }
    export function addNotificationResponseReceivedListener() { return { remove() {} }; }
    export const AndroidAudioContentType = { SONIFICATION: 4 };
    export const AndroidAudioUsage = { ALARM: 4 };
    export const AndroidImportance = { MAX: 5, DEFAULT: 3, LOW: 2 };
    export const AndroidNotificationVisibility = { PUBLIC: 1, PRIVATE: 0 };
  `,
  'expo-router': `
    export const router = { push() {}, replace() {}, back() {} };
  `,
};

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

/**
 * The app source uses bundler-style extensionless relative imports (`./foo`),
 * which Metro resolves but Node ESM does not. Re-add the extension here so the
 * same source runs unmodified under both.
 */
function resolveExtensionless(specifier, parentURL) {
  if (!specifier.startsWith('.') || path.extname(specifier)) return null;
  const base = path.resolve(path.dirname(fileURLToPath(parentURL)), specifier);
  for (const cand of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (existsSync(cand)) return pathToFileURL(cand).href;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (STUBS.has(specifier)) {
      return { url: `kavach-stub:${specifier}`, shortCircuit: true, format: 'module' };
    }
    if (context.parentURL) {
      const hit = resolveExtensionless(specifier, context.parentURL);
      if (hit) return { url: hit, shortCircuit: true, format: 'module-typescript' };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('kavach-stub:')) {
      const name = url.slice('kavach-stub:'.length);
      return {
        format: 'module',
        shortCircuit: true,
        source: STUB_SOURCE[name] ?? 'export default {};',
      };
    }
    return nextLoad(url, context);
  },
});
