/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CONSENT STATUS — the one rule that decides whether a location may be shown.
 * ★ P-008, F-14, ADR-010 — extracted from `app/(tabs)/map.tsx` (phase6-D-1) so the
 * Map tab and the Family Watch tab share one implementation instead of two that
 * can drift. A pin (or a card) is only ever entitled to show a live position when
 * a LIVE, UNREVOKED, UNEXPIRED `live_location` grant from that person exists.
 * P-066 is checked first: a paused agent is a choice, not a missing grant, and
 * reporting it as one would blame the consent system for a decision the person
 * made.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import type { ConsentGrant, Member, MemberPresence, UUID } from '../core/types';

export type ShareStatus =
  | { kind: 'self' }
  | { kind: 'paused' }
  | { kind: 'granted'; grant: ConsentGrant }
  | { kind: 'revoked'; grant: ConsentGrant }
  | { kind: 'expired'; grant: ConsentGrant }
  | { kind: 'none' };

export function shareStatusFor(
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
      (g) =>
        g.grantorMemberId === member.id &&
        g.granteeMemberId === meId &&
        g.scope === 'live_location',
    )
    .sort((a, b) => b.grantedAt - a.grantedAt);

  const grant = relevant[0];
  if (!grant) return { kind: 'none' };
  if (grant.revokedAt !== null) return { kind: 'revoked', grant };
  if (grant.expiresAt <= now) return { kind: 'expired', grant };
  return { kind: 'granted', grant };
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
