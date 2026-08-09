/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE VAULT — documents, medical, and the 2-of-3 quorum (PRD §10.3, P-029)
 *
 * ★★★ WHY THE VAULT KEY IS NOT THE FAMILY GROUP SECRET ★★★
 * crypto/index.ts states it plainly: the vault must survive total loss of every
 * device. The group secret does not — it lives on the phones. So the vault gets
 * its own key, split with Shamir over GF(256) into three shares, any two of
 * which rebuild it.
 *
 * ★★★ THE SHARES NEVER MEET ON A SERVER ★★★
 * That is the entire point of the scheme and it is a property of WHERE the
 * combine runs, not of who promises what. `shamirCombine` is called on this
 * device, from this screen, against shares that were held by guardians. A server
 * that could see two shares would be a server that could open the vault, and
 * then the split would be decoration.
 *
 * ★★★ WHY THIS SCREEN NAGS ABOUT A DRILL ★★★
 * A recovery scheme that has never been rehearsed is a recovery scheme that does
 * not work — you find out during the emergency, which is the one moment it may
 * not fail. Twenty minutes a year, calendared, with the failure surfaced.
 *
 * ★★★ IMEI (P-029) ★★★
 * The register exists so the numbers are recorded TODAY. An IMEI is trivially
 * available while the phone is in your hand and nearly impossible to obtain
 * afterwards — and "afterwards" is a police station, at night, with a stolen
 * phone and no serial number.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import React, { useMemo, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Device, DrillRun, Member, UUID, VaultObject } from '../src/core/types';
import {
  fingerprint,
  randomBytes,
  shamirCombine,
  shamirSplit,
  timingSafeEqual,
  type ShamirShare,
} from '../src/crypto';
import { deviceRepo } from '../src/db/repos';
import { relativeTime, t } from '../src/i18n';
import { useKavach } from '../src/state/store';
import { Button, Card, EmptyState, ListItem, Pill, PressableScale, Section } from '../src/ui/components';
import { MIN_TOUCH_TARGET, colors, font, radius, space, tracking, weight } from '../src/ui/theme';

/** 2-of-3. Two guardians can open it; one guardian alone never can (PRD §10.3). */
const QUORUM_SHARES = 3;
const QUORUM_THRESHOLD = 2;
/** A year. The prompt turns red past this — see the drill card. */
const RECOVERY_DRILL_INTERVAL_MS = 365 * 24 * 3_600_000;

const KIND_GLYPH: Record<VaultObject['kind'], string> = {
  document: '▤',
  medical: '✚',
  identity: '☰',
  insurance: '▦',
  credential: '⚿',
};

function fileSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Grouped so two people can read a fingerprint to each other over a phone call. */
function groupedFingerprint(bytes: Uint8Array): string {
  const hex = fingerprint(bytes);
  return (hex.match(/.{1,4}/g) ?? [hex]).join(' ').toUpperCase();
}

/**
 * The IMEI check digit, Luhn over 15 digits. Validating it here means a mistyped
 * number is caught while the phone is still in your hand rather than at the
 * police station — which is the whole reason P-029 says "record it today".
 */
function imeiValid(raw: string): boolean {
  if (!/^\d{15}$/.test(raw)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let d = raw.charCodeAt(i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// The quorum session — lives only in this component's memory, never persisted
// ═══════════════════════════════════════════════════════════════════════════════

interface QuorumSession {
  objectId: UUID;
  objectTitle: string;
  requestedAt: number;
  /** The key being rebuilt. Held here only so the rebuild can be VERIFIED. */
  secret: Uint8Array;
  shares: ShamirShare[];
  /** Index-aligned with `shares`: which guardian holds which share. */
  holders: Member[];
  approvedIdx: number[];
  reconstructed: Uint8Array | null;
  verified: boolean;
}

/**
 * Above this system font scale a label column and a value column stop fitting
 * side by side and the table reads as broken. 1.3 is where "Emergency contacts"
 * stops fitting a sane label width on a 360 dp phone; past it the row stacks.
 */
const STACK_AT_FONT_SCALE = 1.3;

export default function VaultScreen(): React.ReactElement {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  /**
   * ★ The medical summary is a two-column table, and text scales. ★
   * `medKey` used to be a hard `width: 118`. At 150 % system font "Emergency
   * contacts" and "Medications" wrapped to three lines inside that 118 pt while
   * the value beside them stayed on one, which looks like a rendering bug
   * rather than a preference being honoured. React Native has no container
   * query, but the system font scale is exactly the signal that matters here,
   * and `useWindowDimensions` republishes it when the user changes it.
   */
  const { fontScale } = useWindowDimensions();
  const stacked = fontScale >= STACK_AT_FONT_SCALE;

  const ready = useKavach((s) => s.ready);
  const vault = useKavach((s) => s.vault);
  const members = useKavach((s) => s.members);
  const devices = useKavach((s) => s.devices);
  const medical = useKavach((s) => s.medical);
  const drills = useKavach((s) => s.drills);
  const startDrill = useKavach((s) => s.startDrill);

  const [session, setSession] = useState<QuorumSession | null>(null);
  const [imeiTarget, setImeiTarget] = useState<UUID | null>(null);
  const [imeiDraft, setImeiDraft] = useState('');
  const [imeiSaving, setImeiSaving] = useState(false);
  const [drillLogged, setDrillLogged] = useState(false);

  /**
   * Who can hold a share. Guardians first, then the other adults — a minor is
   * never a share holder, because the scheme's job is to survive the loss of the
   * adults, not to hand a child the family's identity documents.
   */
  const shareHolders = useMemo(() => {
    const rank = (m: Member) => (m.role === 'guardian' ? 0 : m.role === 'adult' ? 1 : m.role === 'elder' ? 2 : 9);
    return members
      .filter((m) => m.role === 'guardian' || m.role === 'adult' || m.role === 'elder')
      .sort((a, b) => rank(a) - rank(b))
      .slice(0, QUORUM_SHARES);
  }, [members]);

  const lastRecoveryDrill: DrillRun | null = useMemo(() => {
    let best: DrillRun | null = null;
    for (const d of drills) {
      if (d.kind !== 'annual_full') continue;
      if (best === null || d.startedAt > best.startedAt) best = d;
    }
    return best;
  }, [drills]);

  const recoveryOverdue =
    lastRecoveryDrill === null || Date.now() - lastRecoveryDrill.startedAt > RECOVERY_DRILL_INTERVAL_MS;

  /**
   * ★ REAL SHA-256, OUT OF THE RENDER BODY ★
   *
   * `groupedFingerprint` is `fingerprint()` → `sha256()`. It was being called
   * once per share inside the holders map, plus twice more for the rebuilt and
   * expected keys — five hashes on every render of this card, and this card
   * re-renders on every approve, every withdraw and every keystroke anywhere
   * else on the screen. The inputs only change when the session does.
   */
  const shareFingerprints = useMemo(
    () => session?.shares.map((s) => groupedFingerprint(s.data)) ?? [],
    [session?.shares],
  );
  const rebuiltFingerprint = useMemo(
    () => (session?.reconstructed == null ? null : groupedFingerprint(session.reconstructed)),
    [session?.reconstructed],
  );
  const expectedFingerprint = useMemo(
    () => (session === null ? null : groupedFingerprint(session.secret)),
    [session?.secret],
  );

  /**
   * Luhn over the draft, once per keystroke rather than once per device card.
   * It sat inside `phoneDevices.map`, so a family with six phones ran the check
   * six times for every digit typed into one field.
   */
  const draftOk = useMemo(() => imeiValid(imeiDraft.trim()), [imeiDraft]);

  const quorumObjects = vault.filter((v) => v.quorumRequired);
  const ownKeyObjects = vault.filter((v) => !v.quorumRequired);

  const enoughHolders = shareHolders.length >= QUORUM_SHARES;

  // ── quorum actions ──────────────────────────────────────────────────────────

  function requestUnlock(object: VaultObject): void {
    if (!enoughHolders) return;
    // A fresh key per rehearsal. The real vault key is never handled by a drill —
    // rehearsing must not be a reason to take the live key out of storage.
    const secret = randomBytes(32);
    setSession({
      objectId: object.id,
      objectTitle: object.title,
      requestedAt: Date.now(),
      secret,
      shares: shamirSplit(secret, QUORUM_SHARES, QUORUM_THRESHOLD),
      holders: shareHolders,
      approvedIdx: [],
      reconstructed: null,
      verified: false,
    });
  }

  function approve(idx: number): void {
    setSession((prev) => {
      if (prev === null || prev.approvedIdx.includes(idx)) return prev;
      const approvedIdx = [...prev.approvedIdx, idx];
      if (approvedIdx.length < QUORUM_THRESHOLD) {
        return { ...prev, approvedIdx };
      }
      // ★ THE COMBINE. Here, on this device, in this function. Lagrange
      //   interpolation at x=0 over the shares that were approved — nothing was
      //   sent anywhere to make this happen.
      const rebuilt = shamirCombine(approvedIdx.map((i) => prev.shares[i]));
      return {
        ...prev,
        approvedIdx,
        reconstructed: rebuilt,
        verified: timingSafeEqual(rebuilt, prev.secret),
      };
    });
  }

  function withdraw(idx: number): void {
    setSession((prev) => {
      if (prev === null) return prev;
      const approvedIdx = prev.approvedIdx.filter((i) => i !== idx);
      // Falling back below the threshold must actually re-lock it. A key that
      // survives the withdrawal of the approval that produced it is not a quorum.
      return approvedIdx.length >= QUORUM_THRESHOLD
        ? { ...prev, approvedIdx }
        : { ...prev, approvedIdx, reconstructed: null, verified: false };
    });
  }

  function lockAgain(): void {
    setSession(null);
  }

  async function logAnnualDrill(): Promise<void> {
    // A rehearsal nobody recorded is a rehearsal that will be argued about next
    // year. startDrill('annual_full') alerts the family — it is a real drill.
    await startDrill('annual_full');
    setDrillLogged(true);
  }

  // ── IMEI actions ────────────────────────────────────────────────────────────

  function beginImei(device: Device): void {
    setImeiTarget(device.id);
    setImeiDraft(device.imei ?? '');
  }

  /**
   * There is no store action for this — the store owns incidents, consent and
   * presence, and a device's IMEI is none of those. So the write goes to the
   * same repository the store itself writes through, and the store's projection
   * is updated in the same breath, which is exactly what its own actions do.
   */
  async function saveImei(device: Device): Promise<void> {
    const value = imeiDraft.trim();
    if (!imeiValid(value)) return;
    setImeiSaving(true);
    try {
      const updated: Device = { ...device, imei: value };
      try {
        await deviceRepo.upsert(updated);
      } catch {
        // A failed disk write must not lose what the user just typed from the
        // back of a phone; the projection still shows it and the next save retries.
      }
      useKavach.setState((prev) => ({
        devices: prev.devices.map((d) => (d.id === device.id ? updated : d)),
      }));
      setImeiTarget(null);
      setImeiDraft('');
    } finally {
      setImeiSaving(false);
    }
  }

  const recordedImeis = devices.filter((d) => d.imei !== null && d.imei.length > 0).length;
  const phoneDevices = devices.filter((d) => d.platform !== 'ha');

  return (
    <ScrollView
      style={styles.screen}
      // This route no longer carries a native header (it always drew its own),
      // so the status-bar inset is this file's job.
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + space.xxxl },
      ]}
    >
      <View style={styles.header}>
        <PressableScale
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          accessibilityLabel="Back"
          hitSlop={space.sm}
          highlightColor={colors.borderStrong}
          highlightRadius={radius.md}
          style={styles.back}
        >
          <Text style={styles.backGlyph}>‹</Text>
        </PressableScale>
        <View style={styles.headerText}>
          <Text style={styles.title}>Vault</Text>
          <Text style={styles.subtitle}>
            Encrypted on this device. Two guardians of three can open the sealed items.
          </Text>
        </View>
      </View>

      {/* ★★ THE ANNUAL KEY-RECOVERY DRILL ★★ */}
      <Card tone={recoveryOverdue ? 'warn' : 'ok'}>
        <View style={styles.cardHead}>
          <Text style={styles.cardTitle}>Key-recovery drill</Text>
          <Pill
            label={
              lastRecoveryDrill === null
                ? 'Never rehearsed'
                : recoveryOverdue
                  ? 'Overdue'
                  : `Done ${relativeTime(lastRecoveryDrill.startedAt)}`
            }
            tone={recoveryOverdue ? 'warn' : 'ok'}
          />
        </View>
        <Text style={styles.quote}>
          20 minutes. The difference between an inconvenience and losing your family&apos;s medical
          history forever.
        </Text>
        <Text style={styles.help}>
          Once a year, two guardians rebuild the vault key from their shares while everyone is calm
          and reachable. If a share has been lost, this is when you find out — not on the day the
          documents are needed.
        </Text>
        <View style={styles.actions}>
          <Button
            label="Rehearse now"
            onPress={() => {
              const target = quorumObjects[0];
              if (target) requestUnlock(target);
            }}
            variant="primary"
            size="lg"
            disabled={quorumObjects.length === 0 || !enoughHolders}
            style={styles.grow}
            accessibilityLabel="Start the two-of-three key recovery rehearsal"
          />
          <Button
            label={drillLogged ? 'Logged' : 'Log as annual drill'}
            onPress={() => void logAnnualDrill()}
            variant="ghost"
            size="lg"
            disabled={drillLogged}
            style={styles.grow}
            accessibilityLabel="Record this as the annual full drill — this alerts the family"
          />
        </View>
        <Text style={styles.footnote}>
          Logging it runs the real annual drill, so the family is alerted. That is deliberate: an
          annual drill nobody notices proves nothing.
        </Text>
      </Card>

      {/* ★★ THE QUORUM ★★ */}
      <Section title="Sealed — needs 2 of 3">
        {!enoughHolders ? (
          <Card tone="warn">
            <Text style={styles.help}>
              Only {shareHolders.length} adult
              {shareHolders.length === 1 ? '' : 's'} in this family can hold a share. A 2-of-3 split
              needs three holders, so quorum recovery is not armed yet.
            </Text>
          </Card>
        ) : null}

        {quorumObjects.length === 0 ? (
          /* ★ "Nothing sealed" is a claim about the database. Making it before
             the database has been read is the same lie as a green tick that
             means "we did not look" — so until `ready` this says what is
             actually true, which is that it does not know yet. */
          <EmptyState
            glyph={ready ? '⚿' : '·'}
            title={ready ? 'Nothing sealed' : 'Opening the vault…'}
            body={
              ready
                ? 'No document currently requires a quorum.'
                : 'Reading this phone’s encrypted index. Nothing is fetched from a server.'
            }
          />
        ) : (
          quorumObjects.map((v) => (
            <Card key={v.id}>
              <View style={styles.cardHead}>
                <Text style={styles.glyph}>{KIND_GLYPH[v.kind]}</Text>
                <View style={styles.cardHeadText}>
                  <Text style={styles.cardTitle} numberOfLines={2}>
                    {v.title}
                  </Text>
                  <Text style={styles.cardSub}>
                    {v.kind} · {fileSize(v.sizeBytes)} · added {relativeTime(v.createdAt)}
                  </Text>
                </View>
              </View>
              {session !== null && session.objectId === v.id ? null : (
                <Button
                  label="Request 2-of-3 unlock"
                  onPress={() => requestUnlock(v)}
                  variant="ghost"
                  size="lg"
                  disabled={!enoughHolders || session !== null}
                  accessibilityLabel={`Request a two of three guardian unlock for ${v.title}`}
                />
              )}
              {session !== null && session.objectId !== v.id ? (
                <Text style={styles.footnote}>
                  Another unlock is in progress. One at a time — a queue of open requests is how a
                  quorum gets rubber-stamped.
                </Text>
              ) : null}
            </Card>
          ))
        )}

        {session === null ? null : (
          <Card tone={session.verified ? 'ok' : 'info'}>
            <Text style={styles.cardTitle}>{session.objectTitle}</Text>
            <Text style={styles.cardSub}>
              Requested {relativeTime(session.requestedAt)} · {session.approvedIdx.length} of{' '}
              {QUORUM_THRESHOLD} approvals
            </Text>

            {session.holders.map((holder, idx) => {
              const approved = session.approvedIdx.includes(idx);
              const share = session.shares[idx];
              return (
                <View key={holder.id} style={[styles.shareRow, approved ? styles.shareRowOn : null]}>
                  <View style={styles.shareText}>
                    <Text style={styles.shareName}>{holder.displayName}</Text>
                    <Text style={styles.shareMeta}>
                      Share {share.index} · {shareFingerprints[idx]}
                    </Text>
                  </View>
                  <PressableScale
                    onPress={() => (approved ? withdraw(idx) : approve(idx))}
                    accessibilityLabel={
                      approved
                        ? `Withdraw ${holder.displayName}'s approval`
                        : `Approve as ${holder.displayName}`
                    }
                    accessibilityState={{ selected: approved }}
                    highlightColor={colors.focus}
                    highlightRadius={radius.pill}
                    style={[styles.shareButton, approved ? styles.shareButtonOn : null]}
                  >
                    <Text style={[styles.shareButtonText, approved ? styles.shareButtonTextOn : null]}>
                      {approved ? '✓ approved' : 'approve'}
                    </Text>
                  </PressableScale>
                </View>
              );
            })}

            {session.reconstructed === null ? (
              <Text style={styles.help}>
                One approval is not enough and never will be. Each share on its own is
                indistinguishable from random bytes — that is the arithmetic, not a policy.
              </Text>
            ) : (
              <View style={styles.unlocked}>
                <Pill
                  label={session.verified ? 'Key rebuilt and verified' : 'Rebuild did not match'}
                  tone={session.verified ? 'ok' : 'danger'}
                />
                <Text style={styles.keyLabel}>Reconstructed key fingerprint</Text>
                <Text style={styles.keyValue}>{rebuiltFingerprint}</Text>
                <Text style={styles.keyLabel}>Expected</Text>
                <Text style={styles.keyValue}>{expectedFingerprint}</Text>
                <Text style={styles.help}>
                  Rebuilt from shares {session.approvedIdx.map((i) => session.shares[i].index).join(' and ')}{' '}
                  by Lagrange interpolation over GF(256), in this process, on this phone. No share was
                  transmitted, and any two of the three would have produced the same key.
                </Text>
              </View>
            )}

            <Button
              label={session.reconstructed === null ? t('common.cancel') : 'Lock again'}
              onPress={lockAgain}
              variant="ghost"
              size="lg"
              accessibilityLabel={
                session.reconstructed === null ? 'Cancel the unlock request' : 'Discard the rebuilt key'
              }
            />
            <Text style={styles.footnote}>
              In a real recovery each share sits on a different guardian&apos;s phone and is approved
              there. Here all three are generated on this device so the rebuild is inspectable. What is
              identical in both cases: the combine runs on a phone, never on a server.
            </Text>
          </Card>
        )}
      </Section>

      {/* ── Everything else in the vault ─────────────────────────────────────── */}
      {ownKeyObjects.length > 0 ? (
        <Section title="Opens with this device's key">
          {ownKeyObjects.map((v) => (
            <ListItem
              key={v.id}
              glyph={KIND_GLYPH[v.kind]}
              title={v.title}
              subtitle={`${v.kind} · ${fileSize(v.sizeBytes)} · added ${relativeTime(v.createdAt)}`}
              right={<Pill label="No quorum" tone="neutral" />}
            />
          ))}
        </Section>
      ) : null}

      {/* ── The medical card, which is vault content with a hot path ─────────── */}
      <Section title={t('medical.title')} right={<Pill label="Sealed into every incident" tone="info" />}>
        <Card>
          <MedRow stacked={stacked} label={t('medical.bloodGroup')}>
            <Text style={styles.medBig}>{medical.bloodGroup || '—'}</Text>
          </MedRow>
          <MedRow stacked={stacked} label={t('medical.allergies')}>
            <Text style={styles.medValue}>{medical.allergies.join(', ') || 'None recorded'}</Text>
          </MedRow>
          <MedRow stacked={stacked} label={t('medical.medications')}>
            <Text style={styles.medValue}>{medical.medications.join(', ') || 'None recorded'}</Text>
          </MedRow>
          <MedRow stacked={stacked} label={t('medical.conditions')}>
            <Text style={styles.medValue}>{medical.conditions.join(', ') || 'None recorded'}</Text>
          </MedRow>
          <MedRow stacked={stacked} label={t('medical.ice')}>
            <Text style={styles.medValue}>
              {medical.iceContacts.length === 0
                ? 'None recorded'
                : medical.iceContacts.map((c) => `${c.name} ${c.phone}`).join('\n')}
            </Text>
          </MedRow>
          <MedRow stacked={stacked} label="Organ donor">
            <Text style={styles.medValue}>{medical.organDonor ? t('common.yes') : t('common.no')}</Text>
          </MedRow>
          {medical.notes.length > 0 ? <Text style={styles.help}>{medical.notes}</Text> : null}
          <Text style={styles.footnote}>
            This card is sealed into the incident payload at the moment a trigger fires, so a responder
            has it without anyone needing to fetch anything. It never needs a quorum, because the
            fifteen seconds a quorum costs are fifteen seconds a paramedic does not have.
          </Text>
        </Card>
      </Section>

      {/* ★★ IMEI REGISTER (P-029) ★★ */}
      <Section
        title="IMEI register"
        right={
          <Pill
            label={`${recordedImeis} of ${phoneDevices.length}`}
            tone={recordedImeis === phoneDevices.length ? 'ok' : 'warn'}
          />
        }
      >
        <Card tone={recordedImeis === phoneDevices.length ? 'ok' : 'warn'}>
          <Text style={styles.help}>
            Record every phone&apos;s IMEI today, while the phones are in the house. Dial *#06# on each
            one. After a theft the number is what a police complaint and a network block are built on,
            and by then it is unobtainable.
          </Text>
        </Card>

        {phoneDevices.length === 0 ? (
          <EmptyState
            glyph="▯"
            title={ready ? 'No phones registered yet' : 'Reading your devices…'}
            body={
              ready
                ? 'Add a phone to the family and its IMEI can be recorded here.'
                : 'This list comes off this phone’s own database. It takes a moment.'
            }
          />
        ) : null}

        {phoneDevices.map((d) => {
          const owner = members.find((m) => m.id === d.memberId);
          const editing = imeiTarget === d.id;
          return (
            <Card key={d.id}>
              <View style={styles.cardHead}>
                <View style={styles.cardHeadText}>
                  <Text style={styles.cardTitle} numberOfLines={1}>
                    {d.model ?? d.platform}
                  </Text>
                  <Text style={styles.cardSub}>
                    {owner?.displayName ?? 'Unassigned'} · {d.manufacturer ?? 'unknown make'}
                  </Text>
                </View>
                <Pill
                  label={d.imei ? 'Recorded' : 'Missing'}
                  tone={d.imei ? 'ok' : 'warn'}
                />
              </View>

              {editing ? (
                <>
                  <TextInput
                    value={imeiDraft}
                    onChangeText={(v) => setImeiDraft(v.replace(/[^0-9]/g, '').slice(0, 15))}
                    keyboardType="number-pad"
                    placeholder="15 digits"
                    placeholderTextColor={colors.textFaint}
                    style={styles.input}
                    accessibilityLabel={`IMEI for ${d.model ?? d.platform}`}
                  />
                  {imeiDraft.length === 0 || draftOk ? null : (
                    <Text style={styles.warnText}>
                      {imeiDraft.length < 15
                        ? `${15 - imeiDraft.length} more digit${15 - imeiDraft.length === 1 ? '' : 's'}.`
                        : 'That is 15 digits but the check digit does not match — a digit is wrong.'}
                    </Text>
                  )}
                  <View style={styles.actions}>
                    <Button
                      label={t('common.save')}
                      onPress={() => void saveImei(d)}
                      variant="primary"
                      size="md"
                      disabled={!draftOk || imeiSaving}
                      style={styles.grow}
                      accessibilityLabel={`Save IMEI for ${d.model ?? d.platform}`}
                    />
                    <Button
                      label={t('common.cancel')}
                      onPress={() => {
                        setImeiTarget(null);
                        setImeiDraft('');
                      }}
                      variant="ghost"
                      size="md"
                      style={styles.grow}
                      accessibilityLabel="Cancel editing this IMEI"
                    />
                  </View>
                </>
              ) : (
                <>
                  <Text style={styles.imei}>{d.imei ?? 'Not recorded'}</Text>
                  <Button
                    label={d.imei ? 'Change' : 'Record IMEI'}
                    onPress={() => beginImei(d)}
                    variant="ghost"
                    size="md"
                    accessibilityLabel={`${d.imei ? 'Change' : 'Record'} the IMEI for ${
                      d.model ?? d.platform
                    }`}
                  />
                </>
              )}
            </Card>
          );
        })}
      </Section>
    </ScrollView>
  );
}

/**
 * One row of the medical summary. Side by side at normal text size, label above
 * value once the system font is large enough that two columns stop fitting —
 * the same information either way, never a 118 pt column with three wrapped
 * lines in it.
 */
function MedRow({
  label,
  stacked,
  children,
}: {
  label: string;
  stacked: boolean;
  children: React.ReactNode;
}) {
  return (
    <View style={[styles.medRow, stacked ? styles.medRowStacked : null]}>
      <Text style={[styles.medKey, stacked ? styles.medKeyStacked : null]} numberOfLines={2}>
        {label}
      </Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg, paddingBottom: space.xxxl, gap: space.xl },

  header: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  back: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
  },
  backGlyph: { color: colors.text, fontSize: font.h1, fontWeight: weight.bold, lineHeight: font.h1 + 4 },
  headerText: { flex: 1, gap: space.xxs },
  title: { color: colors.text, fontSize: font.h1, fontWeight: weight.bold },
  subtitle: { color: colors.textDim, fontSize: font.small, lineHeight: font.small + 5 },

  cardHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.sm },
  cardHeadText: { flex: 1, gap: space.xxs },
  cardTitle: { flex: 1, color: colors.text, fontSize: font.h3, fontWeight: weight.bold },
  cardSub: { color: colors.textDim, fontSize: font.small },
  glyph: { color: colors.textDim, fontSize: font.h2, width: 28, textAlign: 'center' },

  quote: {
    color: colors.text,
    fontSize: font.h3,
    fontWeight: weight.semibold,
    lineHeight: font.h3 + 8,
    marginBottom: space.sm,
  },
  help: { color: colors.textDim, fontSize: font.small, lineHeight: font.small + 6 },
  footnote: { color: colors.textFaint, fontSize: font.tiny, lineHeight: font.tiny + 6, marginTop: space.sm },
  warnText: { color: colors.warn, fontSize: font.small, marginBottom: space.sm },

  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.md },
  grow: { flex: 1 },

  shareRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: MIN_TOUCH_TARGET + 8,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    marginTop: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  shareRowOn: { borderColor: colors.ok, backgroundColor: colors.okSoft },
  shareText: { flex: 1, gap: space.xxs },
  shareName: { color: colors.text, fontSize: font.body, fontWeight: weight.semibold },
  shareMeta: { color: colors.textFaint, fontSize: font.tiny, fontFamily: font.mono },
  shareButton: {
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
  },
  shareButtonOn: { borderColor: colors.ok },
  shareButtonText: { color: colors.text, fontSize: font.small, fontWeight: weight.semibold },
  shareButtonTextOn: { color: colors.ok },

  unlocked: { marginTop: space.md, gap: space.xs },
  keyLabel: {
    color: colors.textFaint,
    fontSize: font.tiny,
    fontWeight: weight.bold,
    letterSpacing: tracking.caps,
    textTransform: 'uppercase',
    marginTop: space.xs,
  },
  keyValue: { color: colors.text, fontSize: font.body, fontFamily: font.mono, letterSpacing: 1 },

  medRow: { flexDirection: 'row', gap: space.md, paddingVertical: space.xs, alignItems: 'flex-start' },
  medRowStacked: { flexDirection: 'column', gap: space.xxs },
  // minWidth rather than width: the column holds its shape when the label is
  // short and grows instead of wrapping when it is not. flexShrink 0 stops the
  // value column squeezing it back down into the same three-line mess.
  medKey: {
    minWidth: 118,
    flexShrink: 0,
    color: colors.textFaint,
    fontSize: font.small,
    fontWeight: weight.semibold,
  },
  medKeyStacked: { minWidth: 0 },
  medValue: { flex: 1, color: colors.text, fontSize: font.body, lineHeight: font.body + 6 },
  medBig: { flex: 1, color: colors.text, fontSize: font.h2, fontWeight: weight.heavy },

  input: {
    minHeight: MIN_TOUCH_TARGET,
    backgroundColor: colors.bgInput,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: space.md,
    color: colors.text,
    fontSize: font.h3,
    fontFamily: font.mono,
    letterSpacing: 2,
    marginBottom: space.sm,
  },
  imei: {
    color: colors.text,
    fontSize: font.h3,
    fontFamily: font.mono,
    letterSpacing: 2,
    marginBottom: space.md,
  },
});
