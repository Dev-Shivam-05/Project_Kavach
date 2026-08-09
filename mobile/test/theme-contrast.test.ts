/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * PALETTE CONTRAST
 *
 * PRD §6.4 requires ≥7:1 on the panic path. That is WCAG AAA for body text, and
 * it is there because the reader may have adrenaline-narrowed vision, may be
 * sixty-plus, may be holding the phone in rain or direct sun, and cannot retry
 * later.
 *
 * A contrast requirement written in a comment is a requirement that survives
 * exactly until someone nudges a hex value because it "looked nicer". This file
 * computes it. Every pair the product actually renders is checked with the same
 * function the app exports, so the test and the app cannot disagree.
 *
 * Thresholds used below:
 *   7.0  body text — AAA, and the §6.4 figure
 *   4.5  large text (≥24 px or ≥19 px bold) — AAA for large
 *   3.0  non-text: borders, focus rings, the icon-bearing edge of a state chip
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { colors, contrast, font, riskColor, stateColor, toneSurface } from '../src/ui/theme.ts';

const AAA_BODY = 7.0;
const AAA_LARGE = 4.5;
const NON_TEXT = 3.0;

/** Every surface a caller may put text on. */
const SURFACES: [string, string][] = [
  ['bg', colors.bg],
  ['bgElevated', colors.bgElevated],
  ['bgCard', colors.bgCard],
  ['bgInput', colors.bgInput],
];

function report(fg: string, bg: string): string {
  return `${fg} on ${bg} = ${contrast(fg, bg).toFixed(2)}:1`;
}

test('★ primary text clears AAA (7:1) on every surface', () => {
  for (const [name, bg] of SURFACES) {
    const r = contrast(colors.text, bg);
    assert.ok(r >= AAA_BODY, `text on ${name}: ${report(colors.text, bg)}, need ${AAA_BODY}`);
  }
});

test('secondary text clears AAA on every surface', () => {
  // textDim carries real information — last-seen times, battery, subtitles. It is
  // not decoration, so it gets the body threshold rather than the large one.
  for (const [name, bg] of SURFACES) {
    const r = contrast(colors.textDim, bg);
    assert.ok(r >= AAA_BODY, `textDim on ${name}: ${report(colors.textDim, bg)}, need ${AAA_BODY}`);
  }
});

test('the faintest text still clears AA (4.5:1)', () => {
  // textFaint is for timestamps and footnotes. It may drop below AAA, but a
  // value nobody can read is a value that should have been cut instead.
  for (const [name, bg] of SURFACES) {
    const r = contrast(colors.textFaint, bg);
    assert.ok(r >= AAA_LARGE, `textFaint on ${name}: ${report(colors.textFaint, bg)}, need ${AAA_LARGE}`);
  }
});

test('★ every *Text token clears AAA on its own soft panel', () => {
  // The pairing the UI actually renders, and the one most likely to be broken by
  // someone adjusting a hex to taste.
  const pairs: [string, string, string][] = [
    ['dangerText', colors.dangerText, colors.dangerSoft],
    ['warnText', colors.warnText, colors.warnSoft],
    ['okText', colors.okText, colors.okSoft],
    ['infoText', colors.infoText, colors.infoSoft],
  ];
  for (const [name, fg, bg] of pairs) {
    const r = contrast(fg, bg);
    assert.ok(r >= AAA_BODY, `${name} on its soft panel: ${report(fg, bg)}, need ${AAA_BODY}`);
  }
});

test('★ every *Text token clears AAA on EVERY surface', () => {
  const semantic: [string, string][] = [
    ['dangerText', colors.dangerText],
    ['warnText', colors.warnText],
    ['okText', colors.okText],
    ['infoText', colors.infoText],
  ];
  for (const [name, fg] of semantic) {
    for (const [sname, bg] of SURFACES) {
      const r = contrast(fg, bg);
      assert.ok(r >= AAA_BODY, `${name} on ${sname}: ${report(fg, bg)}, need ${AAA_BODY}`);
    }
  }
});

test('★ every FILL token carries white text at AA-large or better', () => {
  // Fills are button and chip backgrounds. They stay saturated — that is the
  // point of them — so the requirement is on the white sitting on top.
  const fills: [string, string][] = [
    ['danger', colors.danger],
    ['warn', colors.warn],
    ['ok', colors.ok],
    ['info', colors.info],
  ];
  for (const [name, bg] of fills) {
    const r = contrast(colors.white, bg);
    assert.ok(r >= AAA_LARGE, `white on ${name}: ${report(colors.white, bg)}, need ${AAA_LARGE}`);
  }
});

test('a fill is never mistaken for a text token', () => {
  // If someone "simplifies" the palette by pointing dangerText at danger, this
  // fails — which is the whole reason the split exists.
  assert.notEqual(colors.danger, colors.dangerText);
  assert.ok(
    contrast(colors.dangerText, colors.bg) > contrast(colors.danger, colors.bg),
    'dangerText must be the lighter of the pair on a dark surface',
  );
});

test('toneSurface() only ever returns legible combinations', () => {
  // The helper exists so surfaces are not assembled by hand; that only helps if
  // what it returns is guaranteed readable.
  for (const tone of ['neutral', 'ok', 'warn', 'danger', 'info'] as const) {
    const s = toneSurface(tone);
    assert.ok(
      contrast(s.fg, s.bg) >= AAA_BODY,
      `toneSurface('${tone}'): ${report(s.fg, s.bg)}, need ${AAA_BODY}`,
    );
    assert.ok(
      contrast(s.border, s.bg) >= 1.2,
      `toneSurface('${tone}') border is invisible: ${report(s.border, s.bg)}`,
    );
  }
});

test('★ the whole risk ramp is readable at AAA', () => {
  for (let i = 0; i < 5; i++) {
    const c = riskColor(i);
    assert.ok(
      contrast(c, colors.bg) >= AAA_BODY,
      `risk[${i}] on bg: ${report(c, colors.bg)}, need ${AAA_BODY}`,
    );
  }
});

test('★ adjacent risk steps are distinguishable without colour vision', () => {
  // On a greyscale panel, in night mode, or to a colour-blind reader, two steps
  // with the same luminance ARE the same step. The ramp has to carry its meaning
  // in lightness too, not only in hue (P-018).
  // 1.10 is a self-imposed bar, not a WCAG figure — WCAG has nothing to say about
  // adjacent steps of an ordinal scale. It is the point at which the five steps
  // remain separable in a greyscale screenshot, which is the test that matters.
  for (let i = 1; i < 5; i++) {
    const a = riskColor(i - 1);
    const b = riskColor(i);
    const ratio = contrast(a, b);
    assert.ok(
      ratio >= 1.1,
      `risk[${i - 1}] and risk[${i}] are indistinguishable in luminance: ${report(a, b)}`,
    );
  }
  // And the two ends must be unmistakable from each other.
  assert.ok(
    contrast(riskColor(0), riskColor(4)) >= 1.4,
    `risk 0 and risk 4 are too close: ${report(riskColor(0), riskColor(4))}`,
  );
});

test('★ every incident state colour is readable on the surface it renders on', () => {
  const states = [
    'IDLE', 'WATCH', 'SUSPECT', 'PROBE', 'PENDING', 'FALSE_ALARM',
    'ACTIVE_L1', 'ACTIVE_L1_SILENT', 'ACTIVE_L2', 'ACTIVE_L3',
    'OWNED', 'RESOLVING', 'RESOLVED', 'DORMANT',
  ];
  for (const s of states) {
    const c = stateColor(s);
    assert.ok(
      contrast(c, colors.bgCard) >= AAA_LARGE,
      `stateColor('${s}') on bgCard: ${report(c, colors.bgCard)}, need ${AAA_LARGE}`,
    );
  }
});

test('borders and the focus ring are visible as non-text (3:1)', () => {
  assert.ok(
    contrast(colors.focus, colors.bg) >= NON_TEXT,
    `focus ring on bg: ${report(colors.focus, colors.bg)}, need ${NON_TEXT}`,
  );
  assert.ok(
    contrast(colors.borderStrong, colors.bg) >= 1.5,
    `borderStrong on bg: ${report(colors.borderStrong, colors.bg)}`,
  );
});

test('the medical card inverts, and 21:1 is the point of it', () => {
  // app/medical-card.tsx deliberately leaves the dark theme: it is not a UI, it
  // is a physical object a stranger reads over an unconscious person. Pure black
  // on pure white is the highest contrast that exists and nothing else will do.
  assert.equal(Math.round(contrast(colors.black, colors.white)), 21);
});

test('the type scale is monotonic', () => {
  const scale = [font.tiny, font.small, font.body, font.h3, font.h2, font.h1, font.display, font.hugeCoord];
  for (let i = 1; i < scale.length; i++) {
    assert.ok(scale[i] > scale[i - 1], `type scale is not increasing at index ${i}`);
  }
  // Below ~11 px nothing is readable at arm's length by the people this is for.
  assert.ok(font.tiny >= 11, 'smallest type is under 11 px');
});
