/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * parseLatLon — placing a fence somewhere you are not standing (6-D-8 · spec G)
 *
 * Until this existed a geofence could only be centred on this phone's current
 * position, so a fence around a child's school could only be created by standing
 * at the school. The parser is the whole feature, and its refusals matter more
 * than its successes: a coordinate read half-right does not fail loudly, it puts
 * the fence somewhere else and then never fires — or fires all day.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseLatLon } from '../src/domain/geofence';

test('the ordinary form people type', () => {
  assert.deepEqual(parseLatLon('19.076, 72.8777'), { lat: 19.076, lon: 72.8777 });
});

test('separators people actually use: spaces, semicolons, degree signs', () => {
  const want = { lat: 19.076, lon: 72.8777 };
  assert.deepEqual(parseLatLon('19.076 72.8777'), want);
  assert.deepEqual(parseLatLon('19.076;72.8777'), want);
  assert.deepEqual(parseLatLon('19.076° , 72.8777°'), want);
  assert.deepEqual(parseLatLon('  19.076 ,  72.8777  '), want);
});

test('negatives, for the southern and western hemispheres', () => {
  assert.deepEqual(parseLatLon('-33.8688, 151.2093'), { lat: -33.8688, lon: 151.2093 });
  assert.deepEqual(parseLatLon('40.7128, -74.0060'), { lat: 40.7128, lon: -74.006 });
});

test('a pasted Google Maps link, because that is what a link looks like', () => {
  assert.deepEqual(parseLatLon('https://www.google.com/maps/@19.076,72.8777,15z'), {
    lat: 19.076,
    lon: 72.8777,
  });
});

test('out-of-range values are refused, never clamped', () => {
  // Clamping 91 to 90 would silently put the fence at the North Pole rather
  // than telling somebody they mistyped.
  assert.equal(parseLatLon('91, 10'), null);
  assert.equal(parseLatLon('-91, 10'), null);
  assert.equal(parseLatLon('45, 181'), null);
  assert.equal(parseLatLon('45, -181'), null);
});

test('degrees-minutes-seconds is refused rather than half-read', () => {
  // Reading "19° 4' 33\" N" as 19.4 puts the fence ~40 km away and nothing
  // says so. A refusal the person can act on is the better outcome.
  assert.equal(parseLatLon(`19° 4' 33" N, 72° 52' 40" E`), null);
  assert.equal(parseLatLon('19.076 N, 72.8777 E'), null);
});

test('null island is refused — it is a half-typed field, not a destination', () => {
  assert.equal(parseLatLon('0, 0'), null);
  assert.equal(parseLatLon('0,0'), null);
});

test('garbage, partial input and empty strings return null rather than throwing', () => {
  for (const bad of ['', '   ', '19.076', 'home', 'lat lon', ',', 'abc, def', '19.076, abc']) {
    assert.equal(parseLatLon(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('a legitimate zero on one axis still parses', () => {
  // The equator and the prime meridian are real places; only 0,0 together is
  // treated as a non-answer.
  assert.deepEqual(parseLatLon('0, 72.8777'), { lat: 0, lon: 72.8777 });
  assert.deepEqual(parseLatLon('51.4779, 0'), { lat: 51.4779, lon: 0 });
});
