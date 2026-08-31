/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CONSENT STATUS — grantStatusFor's camera/audio generalisation (Spec F1/F4),
 * and the family_membership grant's build/renew/expiry lifecycle (Spec F2/F3).
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFamilyMembershipGrant,
  disabledReasonFor,
  dueForRenewal,
  FAMILY_MEMBERSHIP_GRANT_WINDOW_MS,
  FAMILY_MEMBERSHIP_SCOPES,
  grantStatusFor,
  renewed,
  shareStatusFor,
} from '../src/domain/consentStatus.ts';
import type { ConsentGrant, Member } from '../src/core/types.ts';

const NOW = 1_700_000_000_000;

const A: Member = {
  id: 'member-a',
  familyId: 'fam-1',
  displayName: 'A',
  asciiShortName: 'A',
  role: 'adult',
  dob: null,
  locale: 'en',
  identityPubkey: '',
  phoneE164: null,
  membershipExpiresAt: null,
  createdAt: NOW,
  avatarColor: '#000',
};

const B_ID = 'member-b';

function grant(overrides: Partial<ConsentGrant> = {}): ConsentGrant {
  return {
    id: 'grant-1',
    familyId: 'fam-1',
    grantorMemberId: A.id,
    granteeMemberId: B_ID,
    scope: 'camera',
    purpose: 'safety',
    grantedAt: NOW - 1000,
    expiresAt: NOW + 1000,
    revokedAt: null,
    grantedVia: 'family_membership',
    keyRotationPending: false,
    ...overrides,
  };
}

test('grantStatusFor is scope-specific — a camera grant does not satisfy an audio check', () => {
  const g = grant({ scope: 'camera' });
  const status = grantStatusFor('audio', A, B_ID, undefined, [g], NOW);
  assert.equal(status.kind, 'none');
});

test('grantStatusFor finds a live camera grant', () => {
  const g = grant({ scope: 'camera' });
  const status = grantStatusFor('camera', A, B_ID, undefined, [g], NOW);
  assert.equal(status.kind, 'granted');
});

test('grantStatusFor reports revoked over expired when both are true', () => {
  const g = grant({ revokedAt: NOW - 500, expiresAt: NOW - 500 });
  const status = grantStatusFor('camera', A, B_ID, undefined, [g], NOW);
  assert.equal(status.kind, 'revoked');
});

test('shareStatusFor is unchanged — still live_location only, camera grants do not leak into it', () => {
  const g = grant({ scope: 'camera' });
  const status = shareStatusFor(A, B_ID, undefined, [g], NOW);
  assert.equal(status.kind, 'none');
});

test('★ Spec F2 — buildFamilyMembershipGrant produces a 90-day window from `now`, never null', () => {
  const g = buildFamilyMembershipGrant({
    id: 'g1',
    familyId: 'fam-1',
    grantorMemberId: A.id,
    granteeMemberId: B_ID,
    scope: 'camera',
    now: NOW,
  });
  assert.equal(g.grantedVia, 'family_membership');
  assert.equal(g.revokedAt, null);
  assert.equal(g.expiresAt, NOW + FAMILY_MEMBERSHIP_GRANT_WINDOW_MS);
  assert.equal(g.expiresAt > g.grantedAt, true);
});

test('★ Spec F2 — the two scopes a family membership grants are exactly camera and audio', () => {
  assert.deepEqual([...FAMILY_MEMBERSHIP_SCOPES].sort(), ['audio', 'camera']);
});

test('★ Spec F3 — a live family_membership grant is not due for renewal before it expires', () => {
  const g = grant({ expiresAt: NOW + 1 });
  assert.equal(dueForRenewal(g, NOW), false);
});

test('★ Spec F3 — an expired, unrevoked family_membership grant IS due for renewal', () => {
  const g = grant({ expiresAt: NOW - 1 });
  assert.equal(dueForRenewal(g, NOW), true);
});

test('★ Spec F3/F4 — a revoked grant is NEVER due for renewal, even past its expiry', () => {
  const g = grant({ expiresAt: NOW - 1, revokedAt: NOW - 500 });
  assert.equal(dueForRenewal(g, NOW), false);
});

test('★ Spec F3 — a manually granted (self) scope is never silently renewed', () => {
  const g = grant({ expiresAt: NOW - 1, grantedVia: 'self' });
  assert.equal(dueForRenewal(g, NOW), false);
});

test('★ Spec F3 — renewed() pushes expiresAt another 90-day window out and changes nothing else', () => {
  const g = grant({ expiresAt: NOW - 1 });
  const r = renewed(g, NOW);
  assert.equal(r.expiresAt, NOW + FAMILY_MEMBERSHIP_GRANT_WINDOW_MS);
  assert.equal(r.id, g.id);
  assert.equal(r.grantedAt, g.grantedAt);
  assert.equal(r.revokedAt, g.revokedAt);
});

test('★ Spec B3 (6-D-5) — disabledReasonFor uses the exact "not sharing yet" copy for kind: none', () => {
  const status = grantStatusFor('camera', A, B_ID, undefined, [], NOW);
  assert.equal(
    disabledReasonFor(status, A),
    'Not sharing location/camera/mic yet — ask them to finish joining.',
  );
});

test('★ Spec F4 (6-D-5) — disabledReasonFor uses the exact "turned this off" copy for kind: revoked', () => {
  const g = grant({ revokedAt: NOW - 500 });
  const status = grantStatusFor('camera', A, B_ID, undefined, [g], NOW);
  assert.equal(disabledReasonFor(status, A), 'A has turned this off.');
});

test('disabledReasonFor is null (button enabled) for a live granted scope', () => {
  const g = grant({ scope: 'audio' });
  const status = grantStatusFor('audio', A, B_ID, undefined, [g], NOW);
  assert.equal(disabledReasonFor(status, A), null);
});

test('disabledReasonFor names an expired scope distinctly from a revoked one', () => {
  const g = grant({ expiresAt: NOW - 1 });
  const status = grantStatusFor('camera', A, B_ID, undefined, [g], NOW);
  const reason = disabledReasonFor(status, A);
  assert.match(reason ?? '', /expired/);
});
