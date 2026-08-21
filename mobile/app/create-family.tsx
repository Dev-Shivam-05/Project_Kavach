/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CREATE / NAME A FAMILY — ★ Spec E1 (phase6-pull-forward) · F-18 · P-008
 *
 * The founding phone already minted `familyId` on first launch; this screen gives
 * that family a NAME and a SIZE cap (2–20) and registers the row server-side under
 * the same id. It does NOT admit devices — a phone still joins by SAS pairing
 * (E6, app/enrol.tsx). The size cap is enforced on the server (KV-1012); this
 * screen only sets the number.
 *
 * The crest preview updates live from the name, so the person naming the family
 * sees the private-space badge (E5) they are about to carry on Home.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { t } from '../src/i18n';
import { useKavach } from '../src/state/store';
import { Button, Card, FamilyIdentity } from '../src/ui/components';
import { colors, font, leading, MIN_TOUCH_TARGET, radius, space, weight } from '../src/ui/theme';

const MIN_SIZE = 2;
const MAX_SIZE = 20;

export default function CreateFamilyScreen() {
  const insets = useSafeAreaInsets();
  const familyId = useKavach((s) => s.familyId);
  const currentName = useKavach((s) => s.familyName);
  const currentSize = useKavach((s) => s.familyMaxMembers);
  const createFamily = useKavach((s) => s.createFamily);

  const [name, setName] = useState(currentName);
  const [size, setSize] = useState(currentSize || 6);
  const trimmed = name.trim();

  const dec = () => setSize((n) => Math.max(MIN_SIZE, n - 1));
  const inc = () => setSize((n) => Math.min(MAX_SIZE, n + 1));

  async function save() {
    if (!trimmed) return;
    await createFamily(trimmed, size);
    router.back();
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xxl }]}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>{t('family.createTitle')}</Text>
      <Text style={styles.subtitle}>{t('family.createSubtitle')}</Text>

      <Card>
        <View style={styles.preview}>
          <FamilyIdentity familyId={familyId} name={trimmed || undefined} />
        </View>
      </Card>

      <View style={styles.field}>
        <Text style={styles.label}>{t('family.name')}</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder={t('family.namePlaceholder')}
          placeholderTextColor={colors.textFaint}
          style={styles.input}
          maxLength={40}
          autoCapitalize="words"
          returnKeyType="done"
          accessibilityLabel={t('family.name')}
        />
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>{t('family.size')}</Text>
        <Text style={styles.hint}>{t('family.sizeHint')}</Text>
        <View style={styles.stepper}>
          <Button
            label="−"
            variant="quiet"
            onPress={dec}
            disabled={size <= MIN_SIZE}
            accessibilityLabel={`${t('family.size')} minus`}
          />
          <Text style={styles.sizeValue} accessibilityLabel={`${size}`}>
            {size}
          </Text>
          <Button
            label="+"
            variant="quiet"
            onPress={inc}
            disabled={size >= MAX_SIZE}
            accessibilityLabel={`${t('family.size')} plus`}
          />
        </View>
      </View>

      <Button label={t('family.save')} size="lg" onPress={save} disabled={!trimmed} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg, gap: space.lg },
  title: { color: colors.text, fontSize: font.h2, fontWeight: weight.bold },
  subtitle: { color: colors.textDim, fontSize: font.body, lineHeight: leading.body },
  preview: { paddingVertical: space.xs },
  field: { gap: space.xs },
  label: { color: colors.text, fontSize: font.small, fontWeight: weight.semibold },
  hint: { color: colors.textFaint, fontSize: font.tiny, lineHeight: leading.tiny },
  input: {
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.bgInput,
    color: colors.text,
    fontSize: font.body,
  },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: space.xl },
  sizeValue: {
    minWidth: 40,
    textAlign: 'center',
    color: colors.text,
    fontSize: font.h1,
    fontWeight: weight.bold,
  },
});
