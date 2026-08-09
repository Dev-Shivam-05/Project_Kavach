/**
 * ESCALATION POLICY — data, never code (ADR-013).
 *
 * The policy is server-authoritative and versioned; devices cache it and NEVER
 * write it. Two divergent escalation policies is an unrecoverable bug class.
 * Every incident and every state transition is stamped with `policy_version` so
 * an after-action report renders under the rules that were in force at the time
 * (PRD P-069).
 *
 * Per-scenario table from PRD §7.5.
 */
import type { EscalationPolicy, RiskLevel, TriggerType, ScenarioPolicy } from './types';

export const DEFAULT_POLICY_VERSION = 1;

const S = (p: Partial<ScenarioPolicy> & { label: string }): ScenarioPolicy => ({
  cancelWindowS: 30,
  l1AudienceRoles: ['guardian', 'adult', 'minor', 'elder'],
  l2AfterS: 90,
  l3AfterS: 180,
  repeatL1AfterS: 30,
  smsTierAfterS: 60,
  allowNeighbours: true,
  audioByDefault: false,
  loudCancel: false,
  ...p,
});

export const DEFAULT_POLICY: EscalationPolicy = {
  version: DEFAULT_POLICY_VERSION,
  scenarios: {
    MANUAL: S({ label: 'Manual panic', cancelWindowS: 20, audioByDefault: true }),
    CRASH: S({
      label: 'Two-wheeler crash',
      cancelWindowS: 20,
      loudCancel: true,
      l2AfterS: 60,
      audioByDefault: true,
    }),
    FALL: S({
      label: 'Fall',
      cancelWindowS: 45,
      loudCancel: true,
      l2AfterS: 120,
      // Voice-call the elder BEFORE the family; check for confusion.
      l1AudienceRoles: ['guardian'],
    }),
    NO_MOTION: S({ label: 'No motion after impact', cancelWindowS: 45, loudCancel: true }),
    DEADMAN: S({
      label: 'Missed check-in',
      cancelWindowS: 0,
      l2AfterS: 900,
      l3AfterS: 1800,
      smsTierAfterS: 900,
      allowNeighbours: false,
      l1AudienceRoles: ['guardian'],
    }),
    GEOFENCE: S({
      label: 'Left safe area',
      // ★ Deliberately the slowest, quietest policy in the system. A child
      //   geofence breach NEVER reaches neighbours (PRD §7.5).
      cancelWindowS: 300,
      l2AfterS: 1800,
      l3AfterS: 3600,
      smsTierAfterS: 1800,
      allowNeighbours: false,
      l1AudienceRoles: ['guardian'],
    }),
    SENSOR_HOME: S({
      label: 'Home emergency',
      cancelWindowS: 60, // high false-positive rate on smoke/gas sensors
      l2AfterS: 180,
    }),
    DEVICE_SILENCED: S({
      label: 'Phone switched off during an incident',
      cancelWindowS: 0,
      l2AfterS: 60,
    }),
    BLE_FOB: S({ label: 'Panic button', cancelWindowS: 15, audioByDefault: true }),
    VOICE_PHRASE: S({ label: 'Voice trigger', cancelWindowS: 20, audioByDefault: true }),
    RELAY: S({ label: 'Relayed from a family device', cancelWindowS: 0 }),
    DRILL: S({
      label: 'Drill',
      cancelWindowS: 10,
      l2AfterS: 60,
      l3AfterS: 120,
      allowNeighbours: false,
    }),
  },
};

/**
 * Risk context shortens the cancel window (PRD §13.5 worked example: sister
 * walking home at 21:40, unknown area, no peers nearby, monsoon rain, HR 15%
 * above baseline → cancel window 60 s → 10 s. She did nothing and noticed
 * nothing; if her phone hits the ground the family knows in eight seconds
 * instead of never).
 */
export function effectiveCancelWindowS(
  policy: EscalationPolicy,
  trigger: TriggerType,
  risk: RiskLevel,
  /** P-017: adaptive lengthening after repeated false positives from one device. */
  falsePositiveStreak = 0,
): number {
  const base = policy.scenarios[trigger]?.cancelWindowS ?? 30;
  if (base === 0) return 0;
  const riskFactor = [1.0, 0.85, 0.7, 0.55, 0.4][risk] ?? 1;
  const fpFactor = 1 + Math.min(3, falsePositiveStreak) * 0.5;
  return Math.max(5, Math.round(base * riskFactor * fpFactor));
}

/** The ladder rendered for the UI timeline (PRD §12.1). */
export function ladderFor(policy: EscalationPolicy, trigger: TriggerType) {
  const p = policy.scenarios[trigger] ?? DEFAULT_POLICY.scenarios.MANUAL;
  return [
    { atS: 0, tier: 1 as const, label: 'Family alerted', channels: ['push', 'callkit', 'ws'] },
    { atS: p.repeatL1AfterS, tier: 1 as const, label: 'Repeat, louder', channels: ['push'] },
    { atS: p.smsTierAfterS, tier: 1 as const, label: 'SMS to all', channels: ['sms'] },
    {
      atS: p.l2AfterS,
      tier: 2 as const,
      label: p.allowNeighbours ? 'Neighbours + relatives' : 'Extended family',
      channels: ['push', 'sms', 'voice'],
    },
    { atS: p.l3AfterS, tier: 3 as const, label: 'Everyone + CALL 112', channels: ['voice', 'push'] },
  ];
}
