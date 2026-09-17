/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * STRING COVERAGE — en / hi / gu really are complete (NFR-020, PRD P-059)
 *
 * ★ WHY THIS TEST EXISTS ★
 * `src/i18n/index.ts` said "complete from day one" in its header while 53 of
 * its 101 keys were missing from BOTH the Hindi and the Gujarati table, and
 * `t()`'s English fallback made that invisible: every StateBadge but three,
 * every Consent and Diagnostics string, and both responder actions rendered in
 * English for a hi/gu member, with nothing failing anywhere. The `coverage()`
 * helper that would have caught it was exported and never called.
 *
 * So this file is the lint: a key added to `en` without its two translations,
 * or a translation that is really the English string pasted across, fails
 * `npm test`. It also pins the two `t()` behaviours a screen depends on —
 * placeholder interpolation being replacement-safe on user input, and the
 * fallback never blanking a string.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEGRADATION_LABELS, DegradationLevel } from '../src/core/types.ts';
import {
  coverage,
  degradationLabel,
  getLocale,
  relativeTime,
  setLocale,
  t,
  tableFor,
  UNTRANSLATED_KEYS,
  type StringKey,
} from '../src/i18n/index.ts';

const en = tableFor('en') as Record<StringKey, string>;
const keys = Object.keys(en) as StringKey[];

/** `{name}`, `{n}`, … — the set a translation must carry verbatim. */
function placeholders(s: string): string[] {
  return (s.match(/\{[a-zA-Z]+\}/g) ?? []).sort();
}

const DEVANAGARI = /[ऀ-ॿ]/;
const GUJARATI = /[઀-૿]/;

test('★ every English key exists in Hindi and Gujarati (coverage is 1.0)', () => {
  assert.equal(coverage('en'), 1);
  for (const locale of ['hi', 'gu'] as const) {
    const table = tableFor(locale);
    const missing = keys.filter((k) => table[k] === undefined);
    assert.deepEqual(missing, [], `${locale} is missing: ${missing.join(', ')}`);
    assert.equal(coverage(locale), 1, `coverage('${locale}') = ${coverage(locale)}`);
  }
});

test('★ no Hindi or Gujarati value is the English string in disguise', () => {
  const allowed = new Set<StringKey>(UNTRANSLATED_KEYS);
  for (const [locale, script] of [
    ['hi', DEVANAGARI],
    ['gu', GUJARATI],
  ] as const) {
    const table = tableFor(locale);
    const offenders: string[] = [];
    for (const k of keys) {
      if (allowed.has(k)) continue;
      const v = table[k] ?? '';
      if (v === en[k] || !script.test(v)) offenders.push(`${k} = ${JSON.stringify(v)}`);
    }
    assert.deepEqual(offenders, [], `${locale} carries English:\n  ${offenders.join('\n  ')}`);
  }
});

test('★ every placeholder in an English string survives translation', () => {
  for (const locale of ['hi', 'gu'] as const) {
    const table = tableFor(locale);
    for (const k of keys) {
      assert.deepEqual(
        placeholders(table[k] ?? ''),
        placeholders(en[k]),
        `${locale}.${k}: placeholders differ from English`,
      );
    }
  }
});

test('★ the duress state label is identical to the ordinary one in every language (F-01)', () => {
  for (const locale of ['en', 'hi', 'gu'] as const) {
    const table = tableFor(locale);
    assert.equal(table['state.ACTIVE_L1_SILENT'], table['state.ACTIVE_L1'], locale);
  }
});

test('★ interpolation is replacement-safe on user-typed names', () => {
  setLocale('en');
  try {
    // String.replace would have read these as back-references into the match.
    assert.equal(t('panic.responding', { name: "Raj $'" }), "Raj $' is responding. Stand by.");
    assert.equal(t('panic.responding', { name: 'Raj $&' }), 'Raj $& is responding. Stand by.');
    assert.equal(t('panic.responding', { name: 'Raj $1' }), 'Raj $1 is responding. Stand by.');
    assert.equal(t('panic.responding', { name: 'Raj $$' }), 'Raj $$ is responding. Stand by.');
    // Every occurrence, not just the first, and a value that contains the placeholder itself.
    assert.equal(t('consent.viewedBy', { name: '{what}', what: 'location' }), '{what} viewed your location');
    assert.equal(t('home.battery', { pct: 42 }), 'Battery 42%');
  } finally {
    setLocale('en');
  }
});

test('the fallback never blanks a string, and the active table wins when it has one', () => {
  setLocale('hi');
  try {
    assert.equal(getLocale(), 'hi');
    assert.equal(t('tab.home'), 'परिवार');
    assert.equal(t('home.battery', { pct: 7 }), 'बैटरी 7%');
    assert.equal(relativeTime(Date.now() - 5 * 60_000), '5 मिनट पहले');
    assert.equal(relativeTime(null), 'कभी नहीं');
  } finally {
    setLocale('en');
  }
  assert.equal(relativeTime(Date.now() - 3 * 3_600_000), '3h ago');
});

test('the localised rung names agree with DEGRADATION_LABELS in English', () => {
  // core/types keeps the English constants for the locale-independent paths
  // (SMS, logs); the screens read i18n. The two must not drift apart.
  setLocale('en');
  for (const level of [
    DegradationLevel.ZERO_INFRA,
    DegradationLevel.PEER_ONLY,
    DegradationLevel.SMS_ONLY,
    DegradationLevel.PUSH_ONLY,
    DegradationLevel.HTTP_ONLY,
    DegradationLevel.FULL,
  ]) {
    assert.equal(degradationLabel(level), DEGRADATION_LABELS[level], `level ${level}`);
  }
});
