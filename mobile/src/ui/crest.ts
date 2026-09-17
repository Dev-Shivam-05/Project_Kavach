/**
 * ★ Spec E5 · §6.4 · NFR-020 — the pure identity derivations, kept free of
 * react-native so they are testable without a renderer.
 *
 * A family is a UUID, not a name (only members have names), so its visual
 * identity is derived deterministically from `familyId`: a stable hue from
 * `crestHues` and a two-letter monogram, drawn the same on every phone in the
 * family and every launch, with no stored colour.
 *
 * ★ A MEMBER'S COLOUR IS DERIVED THE SAME WAY ★
 * `Member.avatarColor` is a persisted column that NOTHING ever assigned
 * (`store.syncEnrolment` writes `''`, `postMember` omits it), so every avatar
 * was `bgCard` and every map pin was `info` blue — two members with the same
 * initials were indistinguishable on the one screen built around telling them
 * apart. `avatarColorFor(memberId)` hashes the id into the same palette the
 * crest uses, so the colour is stable across phones and launches without a
 * write anywhere; a server-supplied `avatarColor`, if one ever arrives, still
 * wins (see `MemberAvatar`).
 *
 * ★ INITIALS ARE GRAPHEMES, NOT CODE UNITS ★
 * `'किरण'[0]` is 'क' — the vowel sign 'ि' is a separate combining code unit,
 * so a UTF-16 slice showed the wrong syllable for every Devanagari and
 * Gujarati name, and split an astral character into a lone surrogate. hi/gu
 * are first-class locales here (NFR-020). `firstGrapheme` uses
 * `Intl.Segmenter` where the runtime has it and otherwise walks code points,
 * keeping combining marks (and the consonant after a virama) with their base.
 */
import { colors, contrast, crestHues } from './theme';

/** FNV-1a over the id — deterministic, dependency-free, spreads a handful of ids
 *  across the six-hue palette. */
function hash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ── graphemes ──────────────────────────────────────────────────────────────────

/** Built once. Null on a runtime without Intl.Segmenter (older Hermes). */
const SEGMENTER: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/** `\p{M}` needs Unicode property escapes; a runtime without them gets the range check. */
const MARK_RE: RegExp | null = (() => {
  try {
    return new RegExp('^\\p{M}$', 'u');
  } catch {
    return null;
  }
})();

/** Devanagari and Gujarati virama — the sign that glues two consonants into one conjunct. */
const VIRAMA = new Set([0x094d, 0x0acd]);

/** Combining mark? Unicode category M, or — without property escapes — the
 *  blocks this app's three scripts actually use (Latin diacritics, Devanagari,
 *  Gujarati dependent signs). */
function isMark(cp: string): boolean {
  if (MARK_RE !== null) return MARK_RE.test(cp);
  const c = cp.codePointAt(0) ?? 0;
  return (
    (c >= 0x0300 && c <= 0x036f) ||
    (c >= 0x0900 && c <= 0x0903) ||
    (c >= 0x093a && c <= 0x094f) ||
    (c >= 0x0951 && c <= 0x0957) ||
    (c >= 0x0962 && c <= 0x0963) ||
    (c >= 0x0a81 && c <= 0x0a83) ||
    c === 0x0abc ||
    (c >= 0x0abe && c <= 0x0acd) ||
    (c >= 0x0ae2 && c <= 0x0ae3)
  );
}

/**
 * The user-perceived characters of a string, in order. `segmenter` is a
 * parameter only so the test can exercise the code-point fallback on a
 * runtime that HAS Intl.Segmenter; callers never pass it.
 */
export function graphemes(text: string, segmenter: Intl.Segmenter | null = SEGMENTER): string[] {
  if (text.length === 0) return [];
  if (segmenter !== null) return Array.from(segmenter.segment(text), (s) => s.segment);

  const cps = Array.from(text);
  const out: string[] = [];
  let i = 0;
  while (i < cps.length) {
    let cluster = cps[i++];
    // Absorb combining marks; after a virama, absorb the consonant it joins
    // to as well, so a conjunct like क्ष stays one cluster instead of a
    // dangling half-form.
    while (i < cps.length) {
      if (isMark(cps[i])) {
        const wasVirama = VIRAMA.has(cps[i].codePointAt(0) ?? 0);
        cluster += cps[i++];
        if (wasVirama && i < cps.length && !isMark(cps[i]) && !/\s/.test(cps[i])) cluster += cps[i++];
        continue;
      }
      break;
    }
    out.push(cluster);
  }
  return out;
}

/** First user-perceived character of a word, or '' for an empty one. */
export function firstGrapheme(word: string): string {
  return graphemes(word)[0] ?? '';
}

/**
 * Two letters from a name's words, else the first two graphemes of one word.
 * Upper-cased where the script has case; a no-op elsewhere.
 */
export function initialsFromName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return graphemes(words[0]).slice(0, 2).join('').toUpperCase();
  return (firstGrapheme(words[0]) + firstGrapheme(words[words.length - 1])).toUpperCase();
}

/** Two A–Z letters from the id's hash — a stable monogram for a nameless family. */
function lettersFromHash(h: number): string {
  const a = String.fromCharCode(65 + (h % 26));
  const b = String.fromCharCode(65 + (Math.floor(h / 26) % 26));
  return a + b;
}

// ── colour ─────────────────────────────────────────────────────────────────────

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Whichever of textInverse / text clears the better contrast on `bg`, so a
 * monogram or initial stays legible (§6.4) on every hue an id can land on. A
 * malformed colour gets `text`, the safe choice on this app's dark surfaces.
 *
 * This replaces a fixed-threshold luminance test (`lum > 0.28`): the black/
 * white crossover is L≈0.179, so for L in (0.179, 0.28) that test chose the
 * LESS legible foreground — e.g. the schema's default '#888888' rendered
 * initials at 3.2:1 when the other choice measured 5.3:1.
 */
export function legibleForegroundOn(bg: string): string {
  const hex = bg.trim();
  if (!HEX_RE.test(hex)) return colors.text;
  return contrast(colors.textInverse, hex) >= contrast(colors.text, hex) ? colors.textInverse : colors.text;
}

/** Same memberId → same colour, on every phone, with nothing stored or sent. */
export function avatarColorFor(memberId: string): string {
  return crestHues[hash(memberId || '') % crestHues.length];
}

/**
 * Same familyId → same crest, forever. The monogram colour is whichever of
 * textInverse / text clears the better contrast on the chosen hue, so it stays
 * legible (§6.4) on every hue an id can land on.
 */
export function crestFor(familyId: string, name?: string): { bg: string; fg: string; monogram: string } {
  const h = hash(familyId || '');
  const bg = crestHues[h % crestHues.length];
  const fg = legibleForegroundOn(bg);
  const monogram = name && name.trim() ? initialsFromName(name) : lettersFromHash(h);
  return { bg, fg, monogram };
}
