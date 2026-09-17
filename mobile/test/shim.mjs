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
  'expo-task-manager',
  'expo-location',
  'expo-network',
  'expo-cellular',
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
    export const __state = { token: null, listeners: [], presented: [], channels: [], dismissed: [] };
    export function __setDevicePushToken(v) { __state.token = v; }
    export function __emitPushToken(v) { for (const l of __state.listeners) l(v); }
    export function __listenerCount() { return __state.listeners.length; }
    /** What reached the OS, in order — the assertion surface for the push receive path. */
    export function __presented() { return __state.presented; }
    export function __channelIds() { return __state.channels; }
    /** What was taken DOWN, in order. "Siren off, banner on" (P-030) is an
     *  ordering claim, and an ordering claim needs both halves recorded. */
    export function __dismissed() { return __state.dismissed; }
    export function __resetPresented() { __state.presented = []; __state.channels = []; __state.dismissed = []; }
    export async function getDevicePushTokenAsync() {
      if (__state.token instanceof Error) throw __state.token;
      return __state.token;
    }
    export function addPushTokenListener(listener) {
      __state.listeners.push(listener);
      return { remove() { __state.listeners = __state.listeners.filter((l) => l !== listener); } };
    }
    export function setNotificationHandler() {}
    export async function setNotificationChannelAsync(id) { __state.channels.push(id); }
    export async function setNotificationCategoryAsync() {}
    /**
     * Permission outcomes are controllable too. initNotifications() is the one
     * function that decides whether a family phone can ring at all, and its
     * honest-failure branches (denied, cannot-ask-again, iOS provisional) were
     * unreachable while this stub always granted. __setPermissions drives what
     * getPermissionsAsync() reports; __setRequestResult drives the answer to the
     * prompt; __requestCount says whether the prompt was shown at all.
     */
    export function __setPermissions(p) { __state.permissions = p; }
    export function __setRequestResult(r) { __state.requestResult = r; }
    export function __requestCount() { return __state.requests; }
    export function __resetPermissions() {
      __state.permissions = { granted: true, canAskAgain: true };
      __state.requestResult = { granted: true };
      __state.requests = 0;
    }
    __resetPermissions();
    export async function getPermissionsAsync() { return __state.permissions; }
    export async function requestPermissionsAsync() {
      __state.requests++;
      if (__state.requestResult instanceof Error) throw __state.requestResult;
      return __state.requestResult;
    }
    /** The real API resolves to the notification's identifier string. */
    export async function scheduleNotificationAsync(req) { __state.presented.push(req); return req?.identifier ?? String(__state.presented.length); }
    export async function dismissNotificationAsync(id) { __state.dismissed.push(id); }
    export async function cancelScheduledNotificationAsync() {}
    export async function getLastNotificationResponseAsync() { return null; }
    export function addNotificationResponseReceivedListener() { return { remove() {} }; }
    export async function registerTaskAsync() { return null; }
    export async function unregisterTaskAsync() { return null; }
    export const BackgroundNotificationTaskResult = { NewData: 0, NoData: 1, Failed: 2 };
    export const AndroidAudioContentType = { SONIFICATION: 4 };
    export const AndroidAudioUsage = { ALARM: 4 };
    export const AndroidImportance = { MAX: 5, DEFAULT: 3, LOW: 2 };
    export const AndroidNotificationVisibility = { PUBLIC: 1, PRIVATE: 0 };
  `,
  'expo-router': `
    export const router = { push() {}, replace() {}, back() {} };
  `,
  /**
   * Controllable, because the thing worth testing about the background push task
   * is that it is DEFINED — under the expected name, at module scope, before
   * anything renders. __runTask invokes the registered executor exactly the way
   * expo-task-manager does, so the receive path can be driven end to end without
   * a device.
   */
  'expo-task-manager': `
    const tasks = new Map();
    export function defineTask(name, executor) { tasks.set(name, executor); }
    export function __definedTasks() { return [...tasks.keys()]; }
    export function __runTask(name, body) {
      const executor = tasks.get(name);
      if (!executor) throw new Error('no task defined named ' + name);
      return executor(body);
    }
    export async function isTaskRegisteredAsync(name) { return tasks.has(name); }
    export async function unregisterTaskAsync(name) { tasks.delete(name); }
  `,
  /**
   * Controllable the same way expo-notifications is: __setNextFix/__setNextError
   * drive what the next getCurrentPositionAsync() call does, and __setHang makes
   * it never resolve at all — the only way to test locationRefresh.ts's own
   * Promise.race timeout off-device, since getCurrentPositionAsync has no
   * built-in timeout option (Expo SDK 57 docs) and the caller must build one.
   */
  'expo-location': `
    export const Accuracy = { Lowest: 1, Low: 2, Balanced: 3, High: 4, Highest: 5, BestForNavigation: 6 };
    export const __state = { nextFix: null, nextError: null, hang: false, calls: 0 };
    export function __setNextFix(fix) { __state.nextFix = fix; __state.nextError = null; __state.hang = false; }
    export function __setNextError(err) { __state.nextError = err; __state.nextFix = null; __state.hang = false; }
    export function __setHang() { __state.hang = true; __state.nextFix = null; __state.nextError = null; }
    export async function getCurrentPositionAsync(_opts) {
      __state.calls++;
      if (__state.hang) return new Promise(() => {});
      if (__state.nextError) throw __state.nextError;
      if (__state.nextFix) return __state.nextFix;
      throw new Error('expo-location stub: no fix configured for this test');
    }
  `,
  /**
   * `net/connectivity.ts` (and through it `net/outboxDrain.ts`) reads the link
   * state from these two. Without stubs Node resolves the real packages, which
   * import `expo` itself and fail under type stripping — so the whole T1 outbox
   * plane was unimportable. __setNetworkState drives what the next read reports;
   * the default is "connected over wifi", the least interesting state.
   */
  'expo-network': `
    export const NetworkStateType = { NONE: 'NONE', UNKNOWN: 'UNKNOWN', CELLULAR: 'CELLULAR', WIFI: 'WIFI', BLUETOOTH: 'BLUETOOTH', ETHERNET: 'ETHERNET', WIMAX: 'WIMAX', VPN: 'VPN', OTHER: 'OTHER' };
    export const __state = { network: { type: 'WIFI', isConnected: true, isInternetReachable: true }, airplane: false, listeners: [] };
    export function __setNetworkState(s) { __state.network = s; }
    export function __setAirplaneMode(on) { __state.airplane = on; }
    export function __emitNetworkState(s) { __state.network = s; for (const l of __state.listeners) l(s); }
    export async function getNetworkStateAsync() { return __state.network; }
    export async function isAirplaneModeEnabledAsync() { return __state.airplane; }
    export function addNetworkStateListener(listener) {
      __state.listeners.push(listener);
      return { remove() { __state.listeners = __state.listeners.filter((l) => l !== listener); } };
    }
  `,
  'expo-cellular': `
    export const __state = { mcc: null };
    export function __setMobileCountryCode(mcc) { __state.mcc = mcc; }
    export async function getMobileCountryCodeAsync() { return __state.mcc; }
  `,
};

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

/**
 * Extensions Node (or Metro) resolves by itself. Only these mean "the specifier
 * already names a file"; any other dot in the last segment is part of the NAME.
 * `'../t0/stateMachine.generated'` has `path.extname() === '.generated'`, and
 * treating that as an extension left `db/repos.ts` — and everything that imports
 * it: `net/ws.ts`, `net/outboxDrain.ts`, `state/store.ts` — unimportable from any
 * test with `ERR_MODULE_NOT_FOUND` (CLAUDE.md convention 7, now closed).
 */
const REAL_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json']);

/**
 * The app source uses bundler-style extensionless relative imports (`./foo`),
 * which Metro resolves but Node ESM does not. Re-add the extension here so the
 * same source runs unmodified under both.
 */
function resolveExtensionless(specifier, parentURL) {
  if (!specifier.startsWith('.') || REAL_EXTENSIONS.has(path.extname(specifier))) return null;
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
