/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * FAMILY CREST — the derivation is pure, deterministic, and legible
 * ★ Spec E5 · §6.4
 *
 * The crest is the family's only visual identity (a family has no name of its
 * own), and it is derived on every phone independently from `familyId`. So two
 * things must hold and are pinned here: the SAME id always yields the SAME crest
 * (or two phones in one family draw different badges), and the monogram clears
 * §6.4 contrast on WHATEVER hue the id lands on (or the badge is a smear on some
 * families and not others, invisibly).
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { crestFor } from '../src/ui/crest.ts';
import { colors, contrast, crestHues } from '../src/ui/theme.ts';

const AAA_LARGE = 4.5;

test('★ the crest is deterministic — same id, same crest', () => {
  const id = '01a02559-7edf-74d8-9055-5880ccac9e00';
  const a = crestFor(id);
  const b = crestFor(id);
  assert.deepEqual(a, b);
  // and it is stable across a name being absent vs a whitespace name
  assert.deepEqual(crestFor(id, '   '), a);
});

test('★ every crest hue carries a monogram that clears §6.4 (AAA-large)', () => {
  // crestFor picks the higher-contrast of textInverse/text; the guarantee is that
  // the WINNER clears 4.5 on every hue in the palette, whichever one an id hits.
  for (const bg of crestHues) {
    const fg =
      contrast(colors.textInverse, bg) >= contrast(colors.text, bg) ? colors.textInverse : colors.text;
    const r = contrast(fg, bg);
    assert.ok(r >= AAA_LARGE, `crest monogram on ${bg} = ${r.toFixed(2)}:1, need ${AAA_LARGE}`);
  }
});

test('the monogram is two A–Z letters when there is no name', () => {
  for (const id of ['a', 'family-42', '01a02559-7edf-74d8', '', 'x'.repeat(50)]) {
    const { monogram } = crestFor(id);
    assert.match(monogram, /^[A-Z]{2}$/, `monogram for ${JSON.stringify(id)} was ${monogram}`);
  }
});

test('a family display name becomes the monogram (Spec E1 forward-compat)', () => {
  const id = '01a02559-7edf-74d8-9055-5880ccac9e00';
  assert.equal(crestFor(id, 'Sharma').monogram, 'SH');
  assert.equal(crestFor(id, 'Amit Sharma').monogram, 'AS');
  // the hue does not move when a name is added — the family keeps its colour
  assert.equal(crestFor(id, 'Sharma').bg, crestFor(id).bg);
});

test('ids spread across more than one hue', () => {
  const hues = new Set<string>();
  for (let i = 0; i < 60; i++) hues.add(crestFor(`fam-${i}-01a02559`).bg);
  assert.ok(hues.size >= 4, `60 ids used only ${hues.size} of ${crestHues.length} hues`);
});
