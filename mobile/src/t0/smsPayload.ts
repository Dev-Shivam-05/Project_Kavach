/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * T0 · SMS PAYLOAD ENCODER
 *
 * ★ INVARIANT I-2: the payload is PURE ASCII and ≤160 characters. ★
 *
 * PRD P-033: a GSM-7 SMS holds 160 characters. The moment the payload contains a
 * single Devanagari or Gujarati character it becomes UCS-2 and the limit drops to
 * SEVENTY. Names are therefore transliterated (`Priya`, not `प्रिया`) and this
 * module is guarded by a lint test that asserts every byte is in 32..126.
 *
 * Budget (PRD §6.2.5), verified in docs/02 §2.7.5:
 *   K1 2 · inc8 8 · name8 8 · type 3 · lat,lon 21 · acc 4 · bat 3 · ts 7 · sig8 8
 *   + separators ~20 = ~84, leaving ~70 for a human-readable tail = ~154 ≤ 160 ✅
 *
 * P-051: carriers strip and filter links, so the tail REPEATS the coordinates as
 * plain text. The raw lat,lon pair is the payload; a link is only a convenience.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import type { TriggerType } from '../core/types';
import { inc8 as toInc8 } from '../core/ids';
import { smsTag } from '../crypto';

export const SMS_MAX = 160;
export const SMS_PROTOCOL = 'K1';

/** 3-character trigger codes, as budgeted. */
export const TRIGGER_CODE: Record<TriggerType, string> = {
  MANUAL: 'SOS',
  CRASH: 'CRA',
  FALL: 'FAL',
  NO_MOTION: 'NOM',
  DEADMAN: 'DED',
  GEOFENCE: 'GEO',
  SENSOR_HOME: 'HOM',
  DEVICE_SILENCED: 'SIL',
  BLE_FOB: 'FOB',
  VOICE_PHRASE: 'VOI',
  RELAY: 'REL',
  DRILL: 'DRL',
};

const TRIGGER_PHRASE: Record<TriggerType, string> = {
  MANUAL: 'NEEDS HELP',
  CRASH: 'CRASH DETECTED',
  FALL: 'FALL DETECTED',
  NO_MOTION: 'NOT MOVING',
  DEADMAN: 'MISSED CHECK-IN',
  GEOFENCE: 'LEFT SAFE AREA',
  SENSOR_HOME: 'HOME ALARM',
  DEVICE_SILENCED: 'PHONE SWITCHED OFF',
  BLE_FOB: 'PRESSED PANIC BUTTON',
  VOICE_PHRASE: 'CALLED FOR HELP',
  RELAY: 'NEEDS HELP',
  DRILL: 'DRILL ONLY',
};

/**
 * Transliterate to the 8-char ASCII short name. Handles the common Devanagari
 * and Gujarati vowel/consonant set so an unconfigured member still degrades to
 * something readable rather than to '?'.
 */
const TRANSLIT: Record<string, string> = {
  अ: 'A', आ: 'A', इ: 'I', ई: 'I', उ: 'U', ऊ: 'U', ए: 'E', ऐ: 'AI', ओ: 'O', औ: 'AU',
  क: 'K', ख: 'KH', ग: 'G', घ: 'GH', च: 'CH', छ: 'CHH', ज: 'J', झ: 'JH',
  ट: 'T', ठ: 'TH', ड: 'D', ढ: 'DH', ण: 'N', त: 'T', थ: 'TH', द: 'D', ध: 'DH', न: 'N',
  प: 'P', फ: 'PH', ब: 'B', भ: 'BH', म: 'M', य: 'Y', र: 'R', ल: 'L', व: 'V',
  श: 'SH', ष: 'SH', स: 'S', ह: 'H',
  અ: 'A', આ: 'A', ઇ: 'I', ઈ: 'I', ઉ: 'U', ઊ: 'U', એ: 'E', ઓ: 'O',
  ક: 'K', ખ: 'KH', ગ: 'G', ઘ: 'GH', ચ: 'CH', જ: 'J', ટ: 'T', ડ: 'D', ણ: 'N',
  ત: 'T', થ: 'TH', દ: 'D', ધ: 'DH', ન: 'N', પ: 'P', ફ: 'PH', બ: 'B', ભ: 'BH',
  મ: 'M', ય: 'Y', ર: 'R', લ: 'L', વ: 'V', શ: 'SH', ષ: 'SH', સ: 'S', હ: 'H',
};

export function toAsciiShortName(name: string): string {
  let out = '';
  for (const ch of name.normalize('NFD')) {
    if (/[A-Za-z]/.test(ch)) out += ch;
    else if (TRANSLIT[ch]) out += TRANSLIT[ch];
    if (out.length >= 8) break;
  }
  out = out.slice(0, 8);
  return out.length > 0 ? out : 'FAMILY';
}

export interface SmsPayloadInput {
  incidentId: string;
  asciiShortName: string;
  trigger: TriggerType;
  lat: number;
  lon: number;
  accuracyM: number;
  batteryPct: number;
  atMs: number;
  groupSecret: Uint8Array;
}

export interface EncodedSms {
  text: string;
  length: number;
  isAscii: boolean;
}

function base36(n: number): string {
  return Math.max(0, Math.floor(n)).toString(36);
}

/** Strip anything outside printable ASCII. The last line of defence for I-2. */
export function forceAscii(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 32 && c <= 126) out += s[i];
  }
  return out;
}

export function encodeSms(input: SmsPayloadInput): EncodedSms {
  const name = forceAscii(input.asciiShortName.toUpperCase()).slice(0, 8) || 'FAMILY';
  const type = TRIGGER_CODE[input.trigger] ?? 'SOS';
  const lat = input.lat.toFixed(6);
  const lon = input.lon.toFixed(6);
  const acc = String(Math.min(9999, Math.max(0, Math.round(input.accuracyM))));
  const bat = String(Math.min(100, Math.max(0, Math.round(input.batteryPct))));
  const ts = base36(Math.floor(input.atMs / 1000));

  // Body without the tag, then tag over the body — the receiver recomputes it.
  const body = [SMS_PROTOCOL, toInc8(input.incidentId), name, type, `${lat},${lon}`, acc, bat, ts].join('|');
  const sig = smsTag(input.groupSecret, body);
  const machine = `${body}|${sig}`;

  // Human-readable tail — what a family member's stock SMS app actually shows.
  const phrase = TRIGGER_PHRASE[input.trigger] ?? 'NEEDS HELP';
  const tail = ` ${name} ${phrase}. ${lat},${lon}`;

  let text = machine + tail;
  if (text.length > SMS_MAX) text = text.slice(0, SMS_MAX);
  text = forceAscii(text);

  return { text, length: text.length, isAscii: isPureAscii(text) };
}

export function isPureAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c > 126) return false;
  }
  return true;
}

export interface DecodedSms {
  protocol: string;
  inc8: string;
  name: string;
  type: string;
  lat: number;
  lon: number;
  accuracyM: number;
  batteryPct: number;
  atMs: number;
  sig: string;
  /** True when the HMAC verifies. NOTE: a false tag is FLAGGED, never dropped (ADR-018). */
  verified: boolean;
}

/**
 * Parse an inbound Kavach SMS. Used by the peer-receive path and by the
 * aggregator webhook simulator.
 *
 * ★ Fail open: an unverifiable payload still yields a decoded incident. ★
 */
export function decodeSms(text: string, groupSecret?: Uint8Array): DecodedSms | null {
  const machine = text.split(' ')[0];
  const parts = machine.split('|');
  if (parts.length < 9 || parts[0] !== SMS_PROTOCOL) return null;
  const [protocol, i8, name, type, coords, acc, bat, ts, sig] = parts;
  const [latS, lonS] = coords.split(',');
  const lat = Number(latS);
  const lon = Number(lonS);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  let verified = false;
  if (groupSecret) {
    const body = [protocol, i8, name, type, coords, acc, bat, ts].join('|');
    verified = smsTag(groupSecret, body) === sig;
  }

  return {
    protocol,
    inc8: i8,
    name,
    type,
    lat,
    lon,
    accuracyM: Number(acc) || 0,
    batteryPct: Number(bat) || 0,
    atMs: parseInt(ts, 36) * 1000,
    sig,
    verified,
  };
}
