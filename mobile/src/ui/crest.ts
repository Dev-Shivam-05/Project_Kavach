/**
 * ★ Spec E5 · §6.4 — the pure family-crest derivation, kept free of react-native
 * so it is testable without a renderer. A family is a UUID, not a name (only
 * members have names), so its visual identity is derived deterministically from
 * `familyId`: a stable hue from `crestHues` and a two-letter monogram, drawn the
 * same on every phone in the family and every launch, with no stored colour.
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

/** Two A–Z letters from a name's words, else the first two letters of one word. */
function initialsFromName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** Two A–Z letters from the id's hash — a stable monogram for a nameless family. */
function lettersFromHash(h: number): string {
  const a = String.fromCharCode(65 + (h % 26));
  const b = String.fromCharCode(65 + (Math.floor(h / 26) % 26));
  return a + b;
}

/**
 * Same familyId → same crest, forever. The monogram colour is whichever of
 * textInverse / text clears the better contrast on the chosen hue, so it stays
 * legible (§6.4) on every hue an id can land on.
 */
export function crestFor(familyId: string, name?: string): { bg: string; fg: string; monogram: string } {
  const h = hash(familyId || '');
  const bg = crestHues[h % crestHues.length];
  const fg = contrast(colors.textInverse, bg) >= contrast(colors.text, bg) ? colors.textInverse : colors.text;
  const monogram = name && name.trim() ? initialsFromName(name) : lettersFromHash(h);
  return { bg, fg, monogram };
}
