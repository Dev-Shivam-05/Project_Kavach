/**
 * KAVACH DESIGN SYSTEM
 *
 * The panic screen gets used by someone with adrenaline-narrowed vision and
 * shaking hands, possibly in the rain, possibly in the dark, one-handed. PRD §6.4
 * lives here as tokens so it cannot drift:
 *   · primary action ≥ 88 dp tall, full width, bottom third only
 *   · contrast ≥ 7:1, never colour alone
 *   · ≤ 4 words per element, present tense
 *   · no animation except the cancel countdown ring
 *
 * ★ The contrast figures below are COMPUTED, not claimed. ★
 * `test/theme-contrast.test.ts` runs the WCAG 2.1 relative-luminance formula over
 * every foreground/background pair this file exports and fails the build under
 * 7:1 for body text. A palette whose accessibility lives in a comment is a
 * palette that drifts the first time someone nudges a hex value to taste.
 */
import { Platform } from 'react-native';

// ── Surfaces ──────────────────────────────────────────────────────────────────
// Five steps, each a real elevation rather than a decorative tint. The whole
// scale is cool-neutral (hue ≈ 213°) so nothing on screen competes with the one
// saturated colour in the product, which is the alarm.

export const colors = {
  bg: '#0B0F14',
  bgElevated: '#141A22',
  bgCard: '#1A222C',
  bgInput: '#212B37',
  bgOverlay: 'rgba(4,7,10,0.82)',

  border: '#2C3846',
  borderStrong: '#3E4C5E',
  /** Focus ring. Must clear 3:1 against every surface above (WCAG 2.1 non-text). */
  focus: '#7FB3E8',

  // Text. Four steps and no more — a fifth is always someone hiding information
  // they were unwilling to cut.
  text: '#F2F6FA',
  textDim: '#B6C2CF',
  textFaint: '#8494A5',
  textInverse: '#0B0F14',

  // ── Semantic ────────────────────────────────────────────────────────────────
  // ★ Each family is TWO colours, and the split is not cosmetic. ★
  //
  // A saturated alarm red has a relative luminance around 0.27. Against ANY
  // background its contrast ceiling is about 6.3:1 — it cannot reach the 7:1
  // §6.4 demands, on black or anything else. The previous palette declared 7:1
  // in a comment and shipped 5.3:1; the test in test/theme-contrast.test.ts is
  // what caught that.
  //
  //   `danger`      FILL. A button or chip background, always with white on it.
  //                 Stays a real alarm red because that is its whole job.
  //   `dangerText`  TEXT on a dark surface. Lightened until it clears 7:1 on
  //                 every surface this file exports — computed, not chosen.
  //
  // Every one is paired with a glyph or a word; none carries meaning alone
  // (P-018 — a colour-blind or low-vision family member reads the same state
  // everyone else does).
  danger: '#C4241F',
  dangerText: '#F3A19F',
  dangerDark: '#8C1512',
  dangerSoft: '#2A1112',
  dangerBorder: '#5E1F1C',

  warn: '#8A5A0F',
  warnText: '#EAA94B',
  warnSoft: '#2A2113',
  warnBorder: '#5A431A',

  ok: '#0E6B3A',
  okText: '#6AC990',
  okSoft: '#12241A',
  okBorder: '#1D5136',

  info: '#12507F',
  infoText: '#84BBEF',
  infoSoft: '#101F2E',
  infoBorder: '#1D3E5E',

  // ── Brand accent ──────────────────────────────────────────────────────────
  // ★ phase6-pull-forward A2 — the ONE non-semantic brand colour, added in the
  // Phase-6 rebuild for nav / active / "you" (the primary-safe, non-alarm action).
  // Teal sits clear of every reserved hue (red=alarm, blue=info/focus, violet=
  // duress, green=ok, amber=warn), so it can carry "primary" without colliding.
  // It is a LIGHT fill: white on it is 1.86:1, so — UNLIKE danger/warn/ok/info —
  // it carries `textInverse` (near-black) text, not white (11.28:1). It never sits
  // on an SOS or an active incident; alarm red stays the one loud colour (A3, §6.4).
  accent: '#2DD4BF',
  accentText: '#5EEAD4',
  accentSoft: '#0C2622',
  accentBorder: '#155E56',

  /** Duress never appears in the UI. Reserved so nothing else claims the hue. */
  duress: '#7A4BC4',

  /**
   * Risk 0..4. These render as TEXT and small chips on dark surfaces, so they use
   * the light end of each family. Deliberately NOT monotonic in luminance — a
   * ramp that only darkens is a ramp a colour-blind reader cannot rank, so the
   * ends are pulled apart in lightness as well as hue.
   */
  risk: ['#3AB86F', '#84BC37', '#E1AF19', '#F5B384', '#FBBCB6'] as const,

  white: '#FFFFFF',
  black: '#000000',
  transparent: 'transparent',
} as const;

/**
 * ★ Spec E5 — family crest hues. A family has no name of its own (only members
 * do), so its identity is a stable colour+monogram derived from `familyId`. These
 * are the fills a crest hashes into; `crestFor` picks the monogram colour by
 * contrast so it clears §6.4 on whichever hue it lands on. Distinct from `risk`
 * (danger) and from the alarm — a crest is identity, never status.
 */
export const crestHues = [
  '#3B5BDB',
  '#1F7A5A',
  '#B5462B',
  '#7048E8',
  '#0E7490',
  '#B02A6F',
] as const;

// ── Spacing: a strict 4 pt grid ───────────────────────────────────────────────
// Every gap in the product is one of these. Arbitrary numbers are how a layout
// stops looking like one system and starts looking like six people's opinions.

export const space = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
  /** Section break. Big enough that a scroll boundary reads as a new subject. */
  section: 40,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 16,
  xl: 24,
  pill: 999,
} as const;

// ── Type: a 1.22 modular scale ────────────────────────────────────────────────
// Ratios, not guesses. Line heights are ~1.45 on body copy because this app is
// read under stress by people over sixty, and generous leading is the cheapest
// legibility win available. Display sizes tighten toward 1.15 where the text is
// two words long and leading would only add slack.

export const font = {
  /** Coordinates on the L0 medical card. Read aloud by a stranger, from arm's length. */
  hugeCoord: 44,
  display: 34,
  h1: 26,
  h2: 20,
  h3: 17,
  body: 15,
  small: 13,
  tiny: 11,
  mono: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
} as const;

/** Line heights, paired with `font`. Using these instead of RN's default fixes the cramped multi-line body copy. */
export const leading = {
  hugeCoord: 50,
  display: 40,
  h1: 32,
  h2: 26,
  h3: 24,
  body: 22,
  small: 19,
  tiny: 16,
} as const;

/**
 * Letter spacing. Negative on display sizes (large type looks loose at 0),
 * positive on the smallest sizes and on all-caps labels, where tight tracking
 * is what makes 11 pt unreadable.
 *
 * `caps` is the answer for EVERY uppercase label in the product. It exists
 * because the alternative — each screen author picking a number that looked
 * right on the block they were writing — produced ten different values, and a
 * section header tracked at 1.1 sitting directly above a field label tracked at
 * 0.6 is visible as a wobble even to someone who could not name what is wrong.
 *
 * `capsWide` is the deliberate exception, not a second opinion: a label of three
 * characters or fewer (LAT, LON, the medical card's floor labels) has too few
 * letter gaps for `caps` to register at all, and those labels are read at arm's
 * length by a stranger. Reach for it only there.
 */
export const tracking = {
  display: -0.6,
  h1: -0.4,
  h2: -0.2,
  body: 0,
  small: 0.1,
  tiny: 0.3,
  caps: 0.8,
  capsWide: 2,
} as const;

export const weight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
  heavy: '800',
} as const;

/** ★ PRD §6.4. Load-bearing — these are safety constraints wearing the costume of design tokens. */
export const PANIC_BUTTON_HEIGHT = 96;
export const MIN_TOUCH_TARGET = 48;
export const CALL_112_HEIGHT = 88;
/** ★ Spec B2 - the centre SOS button in the tab bar. Raised above the bar so a
 * thumb finds it without looking. Alarm red (never the teal accent): it is the
 * one loud control in the whole navigation surface. */
export const SOS_FAB_DIAMETER = 66;

/**
 * Elevation. Shadow alone is nearly invisible on a near-black surface, so each
 * level pairs a shadow with a lighter surface — the border does the work the
 * shadow cannot.
 */
export const shadow = {
  card: {
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  raised: {
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  /** Sheets and the active-incident bar, which must separate from anything under them. */
  overlay: {
    shadowColor: '#000',
    shadowOpacity: 0.6,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: -4 },
    elevation: 20,
  },
} as const;

// ── Tone helpers ──────────────────────────────────────────────────────────────

export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info';

/** Fill / border / text for a tone, so a surface is never assembled by hand twice. */
export function toneSurface(tone: Tone): { bg: string; border: string; fg: string } {
  // `fg` is always the *Text* variant: this returns a text colour for a tinted
  // panel, which is the one pairing that cannot use the saturated fill.
  switch (tone) {
    case 'ok':
      return { bg: colors.okSoft, border: colors.okBorder, fg: colors.okText };
    case 'warn':
      return { bg: colors.warnSoft, border: colors.warnBorder, fg: colors.warnText };
    case 'danger':
      return { bg: colors.dangerSoft, border: colors.dangerBorder, fg: colors.dangerText };
    case 'info':
      return { bg: colors.infoSoft, border: colors.infoBorder, fg: colors.infoText };
    default:
      return { bg: colors.bgCard, border: colors.border, fg: colors.text };
  }
}

/**
 * Colour for an incident state, as TEXT on a dark surface — which is how every
 * caller uses it. Always rendered beside its written label, never alone.
 */
export function stateColor(state: string): string {
  if (state === 'RESOLVED' || state === 'FALSE_ALARM') return colors.okText;
  if (state === 'DORMANT') return colors.textFaint;
  if (state === 'OWNED' || state === 'RESOLVING') return colors.infoText;
  if (state.startsWith('ACTIVE')) return colors.dangerText;
  if (state === 'PENDING') return colors.warnText;
  if (state === 'PROBE' || state === 'SUSPECT') return colors.warnText;
  if (state === 'WATCH') return colors.infoText;
  return colors.textDim;
}

export function riskColor(level: number): string {
  return colors.risk[Math.max(0, Math.min(4, level))];
}

// ── Contrast, computed ────────────────────────────────────────────────────────
// Exported so the test can assert against the same implementation the app would
// use, rather than a second copy that can disagree with it.

/** WCAG 2.1 relative luminance. Accepts #rgb, #rrggbb. */
export function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const srgb = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const lin = srgb.map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** WCAG contrast ratio, 1..21. */
export function contrast(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
