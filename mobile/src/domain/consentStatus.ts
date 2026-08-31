/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CONSENT STATUS — the one rule that decides whether a location, camera or mic
 * may be shown.
 * ★ P-008, F-14, ADR-010 — extracted from `app/(tabs)/map.tsx` (phase6-D-1) so the
 * Map tab and the Family Watch tab share one implementation instead of two that
 * can drift. A pin (or a card) is only ever entitled to show a live position when
 * a LIVE, UNREVOKED, UNEXPIRED `live_location` grant from that person exists.
 * P-066 is checked first: a paused agent is a choice, not a missing grant, and
 * reporting it as one would blame the consent system for a decision the person
 * made.
 *
 * ★ Spec F1/F4 (phase6b-redesign-and-family-watch) — `grantStatusFor` below
 * generalises the same rule to `camera`/`audio` for the Family Watch tab's
 * Camera/Listen buttons (6-D-5). `shareStatusFor` is unchanged — a thin
 * `live_location`-scoped wrapper over it — so `map.tsx`'s existing behaviour is
 * untouched.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import type { ConsentGrant, ConsentScope, Member, MemberPresence, UUID } from '../core/types';

export type ShareStatus =
  | { kind: 'self' }
  | { kind: 'paused' }
  | { kind: 'granted'; grant: ConsentGrant }
  | { kind: 'revoked'; grant: ConsentGrant }
  | { kind: 'expired'; grant: ConsentGrant }
  | { kind: 'none' };

/** The most recent grant of `scope` from `member` to `meId`, live/revoked/expired/absent. */
export function grantStatusFor(
  scope: ConsentScope,
  member: Member,
  meId: UUID | null,
  presence: MemberPresence | undefined,
  grants: ConsentGrant[],
  now: number,
): ShareStatus {
  if (meId !== null && member.id === meId) return { kind: 'self' };
  if (presence && presence.monitoringPaused) return { kind: 'paused' };

  const relevant = grants
    .filter(
      (g) => g.grantorMemberId === member.id && g.granteeMemberId === meId && g.scope === scope,
    )
    .sort((a, b) => b.grantedAt - a.grantedAt);

  const grant = relevant[0];
  if (!grant) return { kind: 'none' };
  if (grant.revokedAt !== null) return { kind: 'revoked', grant };
  if (grant.expiresAt <= now) return { kind: 'expired', grant };
  return { kind: 'granted', grant };
}

export function shareStatusFor(
  member: Member,
  meId: UUID | null,
  presence: MemberPresence | undefined,
  grants: ConsentGrant[],
  now: number,
): ShareStatus {
  return grantStatusFor('live_location', member, meId, presence, grants, now);
}

export function mayDrawPin(status: ShareStatus): boolean {
  return status.kind === 'self' || status.kind === 'granted';
}

/** The short label shown next to a member's name — same wording everywhere this
 *  status is surfaced, so "sharing location" never means something different on
 *  one screen than another. */
export function statusShort(status: ShareStatus): string {
  switch (status.kind) {
    case 'self':
      return 'this phone';
    case 'paused':
      return 'monitoring paused';
    case 'granted':
      return 'sharing location';
    case 'revoked':
      return 'sharing revoked';
    case 'expired':
      return 'grant expired';
    default:
      return 'location not shared';
  }
}

/** Forward-looking counterpart to `relativeTime()`, for grant expiry. */
export function untilText(at: number, now: number): string {
  const ms = at - now;
  if (ms <= 0) return 'already';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ★ Spec F2/F3 — the frictionless `family_membership` grant, its 90-day window
// and its silent self-renewal. Pure builders/predicates only: no id generation,
// no clock reads, no I/O — `store.ts` supplies `id`/`now` and does the
// persistence, same split as every other domain module in this codebase.
// ═══════════════════════════════════════════════════════════════════════════════

/** F3: "expire 90 days from grantedAt and silently self-renew unless revoked." */
export const FAMILY_MEMBERSHIP_GRANT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/** F2: the two scopes a family membership grants each other member, per direction. */
export const FAMILY_MEMBERSHIP_SCOPES: readonly ConsentScope[] = ['camera', 'audio'];

/**
 * F2's grant shape. `purpose: 'safety'` is an implementation choice, not a
 * spec-locked value — F2 does not name one, and `'safety'` is this codebase's
 * least-restrictive purpose category, matching a baseline "you're family"
 * grant rather than an incident- or care-specific one.
 */
export function buildFamilyMembershipGrant(params: {
  id: UUID;
  familyId: UUID;
  grantorMemberId: UUID;
  granteeMemberId: UUID;
  scope: ConsentScope;
  now: number;
}): ConsentGrant {
  return {
    id: params.id,
    familyId: params.familyId,
    grantorMemberId: params.grantorMemberId,
    granteeMemberId: params.granteeMemberId,
    scope: params.scope,
    purpose: 'safety',
    grantedAt: params.now,
    expiresAt: params.now + FAMILY_MEMBERSHIP_GRANT_WINDOW_MS,
    revokedAt: null,
    grantedVia: 'family_membership',
    keyRotationPending: false,
  };
}

/**
 * F3: due for silent renewal — reached its expiry without being revoked.
 * A revoked grant is NEVER renewed; that would defeat the one control F4 gives
 * the grantor (revoking is instant AND permanent until they re-grant it).
 */
export function dueForRenewal(grant: ConsentGrant, now: number): boolean {
  return (
    grant.grantedVia === 'family_membership' && grant.revokedAt === null && grant.expiresAt <= now
  );
}

/** F3: pushes `expiresAt` another 90-day window out from `now`. Nothing else changes. */
export function renewed(grant: ConsentGrant, now: number): ConsentGrant {
  return { ...grant, expiresAt: now + FAMILY_MEMBERSHIP_GRANT_WINDOW_MS };
}
