/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ON-DEMAND LOCATION REFRESH — the response leg (6-D-6 · spec C1)
 *
 * ★ THIS RUNS HEADLESS. TREAT THE STORE AS IF IT DOES NOT EXIST. ★
 * pushReceive.ts's own header explains why its task is defined in module scope:
 * on a killed app, `expo-task-manager` spins up the JS bundle, runs the task,
 * and shuts down — "no views are mounted in this scenario" (Expo SDK 57 docs).
 * `app/_layout.tsx`'s `useEffect(() => { bootstrap() })` therefore never runs,
 * and `store.ts`'s module-level `groupSecret`/`authToken` stay unset. This file
 * reads what it needs (the family group secret, the control-plane session
 * token) straight out of SecureStore instead of depending on the store having
 * booted — the same reasoning D-020 already used to keep `t0ConfigRepo` (SQLite)
 * OFF the wake path entirely: this file never opens it, which is why the
 * request's push payload carries this device's OWN id (`deviceId`) rather than
 * making this file look it up.
 *
 * ★ WHY REALTIME-GW, NOT A NEW CONTROL-PLANE ENDPOINT ★
 * `net/api.ts`'s `stripClassA` exists because "no control-plane body has any
 * business carrying location, sealed or not" (ADR-010 defence in depth). The
 * fix is sealed with the family's existing Location Stream Key
 * (`crypto.locationStreamKey`, `docs/02-System-Architecture.md` §"content keys")
 * and reported straight to `realtime-gw`'s `/v1/location-report` — the exact
 * frame shape a live WS `location.report` already produces, spending the same
 * single-use connect ticket (F-16). No new auth scheme, no control-plane body
 * ever carries a coordinate.
 *
 * ★ WHY NOT A LIVE WEBSOCKET ★
 * `net/ws.ts` is a stateful, SQLite-cursor-backed singleton built for a
 * long-lived connection with reconnect/backoff/heartbeat — the wrong shape for
 * a fire-and-forget report from a task that may have seconds of budget left.
 * A single POST is what that budget affords.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import * as Location from 'expo-location';
import * as SecureStore from 'expo-secure-store';

import { STORAGE_KEYS } from '../core/config';
import { base64ToBytes, locationStreamKey, locationWindowId, sealJson } from '../crypto';
import { postLocationReport, postRtTicket, setAuthToken, setIdentity } from '../net/api';
import type { LocationRefreshPushFields } from './pushReceive';

/** C2: "up to 8s" — the budget belongs to acquiring the fix, not the report round-trip. */
const FIX_TIMEOUT_MS = 8_000;

interface OneShotFix {
  lat: number;
  lon: number;
  accuracyM: number;
  at: number;
}

/**
 * Exported for the same reason readPushFields is: getCurrentPositionAsync has
 * no built-in timeout (Expo SDK 57 docs say so explicitly), so this Promise.race
 * IS the 8s budget C2 promises, and belongs under test off-device rather than
 * trusted by reading it.
 */
export async function acquireOneShotFix(timeoutMs: number = FIX_TIMEOUT_MS): Promise<OneShotFix | null> {
  try {
    const timeout = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), timeoutMs);
    });
    const race = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      timeout,
    ]);
    if (race === null) return null; // no built-in timeout on this call — see file header
    return {
      lat: race.coords.latitude,
      lon: race.coords.longitude,
      accuracyM: race.coords.accuracy ?? 9999,
      at: race.timestamp,
    };
  } catch {
    // No permission, location services off, or the OS refused a background
    // fix outright. All are legitimate device states, not bugs — the caller
    // falls back to the last-known fix's honest age either way (C2).
    return null;
  }
}

async function readGroupSecret(): Promise<Uint8Array | null> {
  try {
    const raw = await SecureStore.getItemAsync(STORAGE_KEYS.groupSecret);
    if (!raw) return null;
    const bytes = base64ToBytes(raw);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

/** Mirrors store.ts's restoreSession() parsing exactly, without depending on it having run. */
async function readSessionToken(): Promise<string | null> {
  try {
    const raw = await SecureStore.getItemAsync(STORAGE_KEYS.session);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { token?: unknown };
      if (typeof parsed.token === 'string' && parsed.token.length > 0) return parsed.token;
    } catch {
      /* a v0 session blob was the bare token */
    }
    return raw;
  } catch {
    return null;
  }
}

/**
 * Acquire, seal, mint a ticket, report. Returns whether the fix reached
 * realtime-gw — the task's only signal back to the OS, per pushReceive.ts's
 * fail-soft convention. Nothing here throws.
 */
export async function handleLocationRefreshPush(fields: LocationRefreshPushFields): Promise<boolean> {
  try {
    const fix = await acquireOneShotFix();
    if (fix === null) return false;

    const groupSecret = await readGroupSecret();
    const session = await readSessionToken();
    if (groupSecret === null || session === null) return false;

    setAuthToken(session);
    setIdentity({ deviceId: fields.deviceId, familyId: '' });

    const ticketRes = await postRtTicket();
    if (!ticketRes.ok || !ticketRes.data) return false;

    const sealed = sealJson(locationStreamKey(groupSecret, locationWindowId(fix.at)), fix);
    const reportRes = await postLocationReport(ticketRes.data.ticket, sealed);
    return reportRes.ok;
  } catch {
    return false;
  }
}
