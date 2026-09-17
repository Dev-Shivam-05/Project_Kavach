/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * MEMBER IDENTITY DERIVATIONS — colour and initials, pure and legible
 * ★ Spec E5 · §6.4 · NFR-020 · P-018
 *
 * Two things every phone in a family must agree on without talking to each
 * other, pinned here the same way `family-crest.test.ts` pins the crest:
 *
 *   · a member's avatar colour is DERIVED from their id (nothing ever assigned
 *     `avatarColor`, so every avatar was one colour and every pin was blue), and
 *     the foreground chosen for it clears §6.4's large-text floor on every hue;
 *   · initials are grapheme clusters, so a Devanagari or Gujarati name keeps its
 *     vowel sign instead of showing the bare consonant (hi/gu are first-class
 *     locales), and an astral character is never split into a lone surrogate.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  avatarColorFor,
  firstGrapheme,
  graphemes,
  initialsFromName,
  legibleForegroundOn,
} from '../src/ui/crest.ts';
import { colors, contrast, crestHues } from '../src/ui/theme.ts';

const AAA_LARGE = 4.5;

test('★ a member id always derives the same colour, from the crest palette', () => {
  const id = '3c1a2f8e-9b6d-5a41-8e2f-0d7c4b9a1e55';
  assert.equal(avatarColorFor(id), avatarColorFor(id));
  assert.ok((crestHues as readonly string[]).includes(avatarColorFor(id)));
  assert.ok((crestHues as readonly string[]).includes(avatarColorFor('')));
});

test('ids spread across more than one hue', () => {
  const hues = new Set<string>();
  for (let i = 0; i < 60; i++) hues.add(avatarColorFor(`member-${i}-3c1a2f8e`));
  assert.ok(hues.size >= 4, `60 ids used only ${hues.size} of ${crestHues.length} hues`);
});

test('★ the chosen foreground clears AAA-large on every hue an id can land on', () => {
  for (const bg of crestHues) {
    const fg = legibleForegroundOn(bg);
    const r = contrast(fg, bg);
    assert.ok(r >= AAA_LARGE, `initials on ${bg} = ${r.toFixed(2)}:1, need ${AAA_LARGE}`);
  }
});

test('★ the foreground is the MORE legible of the two, not a fixed-threshold guess', () => {
  // The old `lum > 0.28` test picked `text` here: 3.2:1 against the 5.3:1 it rejected.
  for (const bg of ['#888888', '#7A4BC4', '#2DD4BF', '#0B0F14', '#FFFFFF', '#abc']) {
    const fg = legibleForegroundOn(bg);
    const best = Math.max(contrast(colors.text, bg), contrast(colors.textInverse, bg));
    assert.equal(contrast(fg, bg), best, `on ${bg}`);
  }
  // A colour that is not a hex triplet falls back to the safe choice on dark surfaces.
  assert.equal(legibleForegroundOn('red'), colors.text);
  assert.equal(legibleForegroundOn(''), colors.text);
});

test('★ initials keep the vowel sign of a Devanagari or Gujarati name', () => {
  // 'कि' is क + the dependent vowel ि — two code units, one user-perceived letter.
  assert.equal(initialsFromName('किरण शर्मा'), 'किश');
  assert.equal(initialsFromName('કિરણ પટેલ'), 'કિપ');
  // One word: its first TWO graphemes, not its first two code units.
  assert.equal(initialsFromName('किरण'), 'किर');
  assert.equal(initialsFromName('કિરણ'), 'કિર');
});

test('initials are upper-cased Latin letters for a Latin name, as before', () => {
  assert.equal(initialsFromName('Amit Sharma'), 'AS');
  assert.equal(initialsFromName('sharma'), 'SH');
  assert.equal(initialsFromName('  Priya   Nair  '), 'PN');
  assert.equal(initialsFromName(''), '');
  assert.equal(initialsFromName('   '), '');
});

test('an astral character is one initial, never a lone surrogate', () => {
  const smile = '\u{1F600}';
  assert.equal(firstGrapheme(`${smile}abc`), smile);
  assert.equal(initialsFromName(`${smile} Kumar`), `${smile}K`);
  assert.equal(initialsFromName(smile), smile);
});

test('the code-point fallback (no Intl.Segmenter) agrees on the cases that matter', () => {
  // Hermes may lack Intl.Segmenter; the fallback is what a real phone might run.
  const split = (s: string) => graphemes(s, null);
  assert.deepEqual(split('किरण'), ['कि', 'र', 'ण']);
  assert.deepEqual(split('કિરણ'), ['કિ', 'ર', 'ણ']);
  // A conjunct via virama stays one cluster rather than a dangling half-form.
  assert.deepEqual(split('क्षमा'), ['क्ष', 'मा']);
  assert.deepEqual(split('\u{1F600}a'), ['\u{1F600}', 'a']);
  assert.deepEqual(split('éx'), ['é', 'x']);
  assert.deepEqual(split(''), []);
});
