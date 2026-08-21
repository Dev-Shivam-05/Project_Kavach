/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * FAMILY IDENTITY — "this is your family's private space"
 * ★ Spec E5 (phase6-pull-forward) · P-008 · §6.4
 *
 * A family in this app is a UUID, not a name — only members have names. So the
 * family's identity is a CREST derived deterministically from `familyId`: a stable
 * hue and a two-letter monogram, drawn the same on every phone in the family and
 * every time the app opens, with no stored colour and nothing on the wire. When a
 * family display name exists (Spec E1) it becomes the monogram; until then the
 * monogram is two letters hashed from the id — still stable, still recognisable.
 *
 * The surface exists to make one thing unmistakable to the person holding the
 * phone: this space belongs to THIS family and nobody outside it can see in
 * (P-008). The crest is the glance; the shield line says it in words.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { t } from '../../i18n';
import { colors, font, leading, radius, space, tracking, weight } from '../theme';
import { crestFor } from '../crest';

export function FamilyCrest({
  familyId,
  name,
  size = 44,
}: {
  familyId: string;
  name?: string;
  size?: number;
}): React.ReactElement {
  const { bg, fg, monogram } = crestFor(familyId, name);
  return (
    <View
      // The monogram is decorative next to the words beside it; the crest must not
      // be read aloud as if it were a letter pair.
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[styles.crest, { width: size, height: size, borderRadius: size / 3, backgroundColor: bg }]}
    >
      <Text allowFontScaling={false} style={[styles.monogram, { color: fg, fontSize: Math.round(size * 0.4) }]}>
        {monogram}
      </Text>
    </View>
  );
}

export interface FamilyIdentityProps {
  familyId: string;
  /** The family display name (Spec E1). Absent today; the crest falls back to a
   *  hashed monogram and the title falls back to the shield line alone. */
  name?: string;
  /** Home wants a single quiet row; Settings wants the full card. */
  compact?: boolean;
}

/**
 * The identity surface. Home renders it compact (a crest and one line); Settings
 * renders the full card above the profile, because "the family" precedes "me".
 */
export function FamilyIdentity({ familyId, name, compact }: FamilyIdentityProps): React.ReactElement {
  const shortId = (familyId || '').slice(0, 8) || 'unknown';
  const title = name?.trim() || t('family.privateSpace');

  if (compact) {
    return (
      <View accessible accessibilityLabel={`${title}. ${t('family.privateShort')}`} style={styles.compactRow}>
        <FamilyCrest familyId={familyId} name={name} size={34} />
        <View style={styles.compactText}>
          <Text numberOfLines={1} style={styles.compactTitle}>
            {title}
          </Text>
          <Text numberOfLines={1} style={styles.compactSub}>
            {t('family.privateShort')}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View
      accessible
      accessibilityLabel={`${title}. ${t('family.private')}. ${t('family.idLabel')} ${shortId}`}
      style={styles.card}
    >
      <FamilyCrest familyId={familyId} name={name} size={56} />
      <View style={styles.cardText}>
        <Text style={styles.cardTitle}>{title}</Text>
        <Text style={styles.cardShield}>{t('family.private')}</Text>
        <Text style={styles.cardId}>
          {t('family.idLabel')} {shortId}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  crest: { alignItems: 'center', justifyContent: 'center' },
  monogram: { fontWeight: weight.heavy, includeFontPadding: false, letterSpacing: 0.4 },

  compactRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  compactText: { flex: 1 },
  compactTitle: { color: colors.text, fontSize: font.small, fontWeight: weight.bold },
  compactSub: { color: colors.textFaint, fontSize: font.tiny, marginTop: 1 },

  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: space.lg,
  },
  cardText: { flex: 1 },
  cardTitle: { color: colors.text, fontSize: font.h3, fontWeight: weight.bold },
  cardShield: {
    color: colors.accentText,
    fontSize: font.small,
    lineHeight: leading.small,
    marginTop: 2,
  },
  cardId: {
    color: colors.textFaint,
    fontSize: font.tiny,
    letterSpacing: tracking.tiny,
    marginTop: space.xs,
  },
});

export default FamilyIdentity;
