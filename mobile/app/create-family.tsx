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

  /**
   * One save at a time, and the outcome on screen. Two taps during the await
   * used to run `createFamily` twice and `router.back()` twice — straight out
   * of Settings. And a save that did not complete used to look exactly like
   * one that did: the store's `createFamily` is fail-soft on the network, so
   * the only way this screen learns of a failure is a rejection or, once the
   * store reports it, a `false` return — both are read as failure here.
   */
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  async function save() {
    if (!trimmed || saving) return;
    setSaving(true);
    setSaveFailed(false);
    try {
      const result = (await createFamily(trimmed, size)) as unknown;
      if (result === false) {
        setSaveFailed(true);
        return;
      }
      router.back();
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
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

      {saveFailed ? (
        <Text style={styles.failed} accessibilityLiveRegion="assertive">
          Saving did not complete. Nothing you typed was lost — it is still here. Try again; until
          it succeeds the family is not registered with the server.
        </Text>
      ) : null}

      <Button
        label={saving ? 'Saving…' : t('family.save')}
        size="lg"
        onPress={() => void save()}
        disabled={!trimmed || saving}
        accessibilityLabel={saving ? 'Saving' : t('family.save')}
      />
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
  // warnText, not warn: the fill token is under 3:1 on this background and the
  // one sentence saying the save did not happen must not be the faintest one.
  failed: { color: colors.warnText, fontSize: font.small, lineHeight: leading.small },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: space.xl },
  sizeValue: {
    minWidth: 40,
    textAlign: 'center',
    color: colors.text,
    fontSize: font.h1,
    fontWeight: weight.bold,
  },
});
