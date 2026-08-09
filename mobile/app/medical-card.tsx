/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ★★★ THE L0 FLOOR ★★★
 *
 * Assume everything above this screen is gone: no server, no data, no SMS, a
 * dead background agent, a battery at four percent. Assume the person holding
 * the phone is a stranger who has never seen this app, does not read English
 * well, and is standing over someone who is unconscious.
 *
 * This screen is what still works. It is not a "medical info" page — it is a
 * physical object, like a MedicAlert bracelet, that happens to be rendered on
 * glass. Every decision below follows from that (PRD §4.4 ZERO_INFRA, §10.4):
 *
 *   · ★ BLACK INK ON A WHITE SHEET — 21:1, and the direction is load-bearing. ★
 *     This card used to be white-on-black and the header used to argue for it
 *     with the daylight case, which is the exact case that argument loses. A
 *     phone screen emits light; it does not reflect it. A black background emits
 *     almost nothing, so in direct sun the glass reflection is most of what
 *     reaches the eye and the ratio on the retina collapses towards 1:1 — the
 *     computed 21:1 is real only in a dark room. A white sheet driven to
 *     Brightness.setBrightnessAsync(1) puts several hundred nits behind every
 *     letter and swamps that reflection, which is the whole reason the brightness
 *     call below exists. It is also what a printed emergency card looks like, and
 *     a stranger has seen one of those before.
 *     (theme.colors.bg is a *deep neutral* tuned for a UI. This is not a UI.)
 *   · Blood group at more than twice display size, because it is the single
 *     datum a paramedic needs first and from the furthest away.
 *   · Top three allergies and medications ONLY. A stranger under stress reads
 *     three things. A list of eleven is a list of zero (PRD §6.4, ≤4 words).
 *   · ICE contacts are TAP-TO-CALL, not text. The stranger should not have to
 *     retype a number they cannot pronounce.
 *   · BigCoordinates, because "where are we" is the question the 112 operator
 *     asks and the stranger cannot answer.
 *   · The screen is held awake and driven to full brightness for as long as it
 *     is shown, and BOTH are given back on unmount. A card that sleeps after
 *     thirty seconds is a card that is not there when the ambulance arrives.
 *   · No network call, no loading state, no spinner. Everything here was already
 *     on the device before the emergency started. An EMPTY card still says so
 *     out loud rather than rendering a page of dashes.
 *
 * The edit mode exists on this same route deliberately: the only card that ever
 * gets filled in is the one you can reach from the thing you already opened.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  Linking,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import * as Brightness from 'expo-brightness';
import { useKeepAwake } from 'expo-keep-awake';

import type { MedicalCard } from '../src/core/types';
import { t } from '../src/i18n';
import { lastKnownFix, useKavach } from '../src/state/store';
import { BigCoordinates, Call112Button, Toggle } from '../src/ui/components';
import { colors, font, MIN_TOUCH_TARGET, radius, space, weight } from '../src/ui/theme';

/** ★ The one datum read from furthest away. `font.hugeCoord` is the coordinate
 *  size; the blood group has to beat it, so it is doubled. */
const BLOOD_GROUP_SIZE = font.hugeCoord * 2;

/** Three, and only three. See the header. */
const VISIBLE_ITEMS = 3;
const ICE_SLOTS = 2;

// ═══════════════════════════════════════════════════════════════════════════════

export default function MedicalCardScreen(): ReactElement {
  const medical = useKavach((s) => s.medical);
  const saveMedical = useKavach((s) => s.saveMedical);
  const me = useKavach((s) => s.me);
  const activeIncident = useKavach((s) => s.activeIncident);

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  /**
   * ★ The save used to be fire-and-forget: `void saveMedical(next)` followed
   * immediately by closing the editor. A phone that could not write to
   * SecureStore therefore showed a blank card and a person who believed their
   * allergies were on it. That is the exact failure this screen exists to
   * prevent, told about itself.
   */
  const [saveFailed, setSaveFailed] = useState(false);

  // ★ The screen must not sleep. An unconscious patient cannot tap it awake.
  useKeepAwake();

  useEffect(() => {
    // ★ Full brightness, then GIVE IT BACK. Leaving a phone pinned at 100 % nits
    //   after the emergency drains the battery that the next emergency needs.
    let cancelled = false;
    let previous: number | null = null;

    void (async () => {
      try {
        const level = await Brightness.getBrightnessAsync();
        if (cancelled) return;
        previous = level;
        await Brightness.setBrightnessAsync(1);
      } catch {
        // A device that refuses brightness control still shows the card. This is
        // an enhancement, never a precondition (hard rule 8).
      }
    })();

    return () => {
      cancelled = true;
      if (previous === null) return;
      void Brightness.setBrightnessAsync(previous).catch(() => {
        /* nothing left to do; the OS restores on next unlock anyway */
      });
    };
  }, []);

  const close = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, []);

  const handleSave = useCallback(
    async (next: MedicalCard): Promise<void> => {
      setSaving(true);
      setSaveFailed(false);
      try {
        await saveMedical(next);
        setEditing(false);
      } catch {
        // Stay in the editor with the typed values intact. Closing on a failed
        // write is what turned a storage error into a card nobody knew was empty.
        setSaveFailed(true);
      } finally {
        setSaving(false);
      }
    },
    [saveMedical],
  );

  if (editing) {
    return (
      <MedicalEditor
        initial={medical}
        saving={saving}
        saveFailed={saveFailed}
        onCancel={() => {
          setSaveFailed(false);
          setEditing(false);
        }}
        onSave={(next) => void handleSave(next)}
      />
    );
  }

  return (
    <ResponderCard
      medical={medical}
      ownerName={me?.displayName ?? null}
      incidentInc8={activeIncident?.inc8 ?? null}
      sealedFix={
        activeIncident?.sealed
          ? {
              lat: activeIncident.sealed.lat,
              lon: activeIncident.sealed.lon,
              accuracyM: activeIncident.sealed.accuracyM,
            }
          : null
      }
      onEdit={() => setEditing(true)}
      onClose={close}
    />
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// The card itself — the part a stranger sees
// ═══════════════════════════════════════════════════════════════════════════════

interface Fix {
  lat: number;
  lon: number;
  accuracyM: number;
}

function ResponderCard({
  medical,
  ownerName,
  incidentInc8,
  sealedFix,
  onEdit,
  onClose,
}: {
  medical: MedicalCard;
  ownerName: string | null;
  incidentInc8: string | null;
  sealedFix: Fix | null;
  onEdit: () => void;
  onClose: () => void;
}): ReactElement {
  // The incident's sealed position is authoritative when there is one — it is
  // where the trigger happened. Otherwise the last cached fix, which is what T0
  // itself would seal if the button were pressed right now.
  // The native header already handles the top; the bottom is ours, and without
  // it the last control on the card sits under the gesture bar on every
  // edge-to-edge Android and every Face ID iPhone.
  const insets = useSafeAreaInsets();
  const [liveFix, setLiveFix] = useState<Fix | null>(() => toFix(lastKnownFix()));
  const haveSealed = sealedFix !== null;

  useEffect(() => {
    if (haveSealed) return;
    // Polled rather than subscribed because the store deliberately keeps the
    // cached fix out of React state: T0 reads it synchronously on the hot path
    // and a re-render per GPS tick would be a cost paid for nothing.
    const handle = setInterval(() => {
      const next = toFix(lastKnownFix());
      setLiveFix((prev) =>
        prev !== null && next !== null && prev.lat === next.lat && prev.lon === next.lon
          ? prev
          : next,
      );
    }, 15_000);
    return () => clearInterval(handle);
  }, [haveSealed]);

  const fix = sealedFix ?? liveFix;

  const [dialFailed, setDialFailed] = useState(false);
  const call = useCallback((phone: string) => {
    // Cleared on every attempt: a warning left over from a failure ten seconds
    // ago, sitting above a number that has just dialled fine, is a lie.
    setDialFailed(false);
    // ADR-019 reasoning applies to every emergency number, not just 112: hand
    // the dialler the digits and let the human press call.
    const digits = phone.replace(/[^+0-9]/g, '');
    Linking.openURL(`tel:${digits}`).catch(() => setDialFailed(true));
  }, []);

  const allergies = medical.allergies.filter(nonEmpty).slice(0, VISIBLE_ITEMS);
  const medications = medical.medications.filter(nonEmpty).slice(0, VISIBLE_ITEMS);
  const conditions = medical.conditions.filter(nonEmpty).slice(0, VISIBLE_ITEMS);
  const contacts = medical.iceContacts.filter((c) => nonEmpty(c.phone)).slice(0, ICE_SLOTS);

  /**
   * ★ The honest empty state. ★
   * A card nobody ever filled in used to render as a page of dashes and six
   * "None recorded" lines, which reads to a stranger as "the app is broken" and
   * to the owner as "this is done". One sentence at the top says which it is —
   * and the sentence is aimed at the owner, because the stranger can do nothing
   * about it and must not be sent hunting for information that is not there.
   */
  const cardIsEmpty =
    !nonEmpty(medical.bloodGroup) &&
    allergies.length === 0 &&
    medications.length === 0 &&
    conditions.length === 0 &&
    contacts.length === 0 &&
    !nonEmpty(medical.notes);

  return (
    <View style={styles.floor}>
      {/* ★ Light glyphs, even though the sheet is white. The status bar does not
          sit on the sheet: `_layout.tsx` gives this route a native header filled
          with `bgElevated`, and that dark bar is what the glyphs land on.
          Switching to dark-content here would hide the clock and the battery. */}
      <StatusBar barStyle="light-content" backgroundColor={colors.bgElevated} />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.floorContent}>
        {/* Instruction first, in plain words, because the person holding this
            phone does not know what they are looking at (PRD §10.4). */}
        <Text style={styles.instruction} allowFontScaling={false}>
          {t('medical.showToResponder')}
        </Text>

        {cardIsEmpty ? (
          <View style={styles.emptyCard} accessibilityRole="alert">
            <Text style={styles.emptyTitle}>This card is empty.</Text>
            <Text style={styles.emptyBody}>
              Nothing has been filled in yet. Tap “Edit card” at the bottom and put in a blood
              group, one allergy, and one number to ring.
            </Text>
          </View>
        ) : null}

        <Text style={styles.owner} numberOfLines={2}>
          {ownerName === null ? t('medical.title') : ownerName}
        </Text>
        {incidentInc8 === null ? null : (
          <Text style={styles.incidentRef} allowFontScaling={false} selectable>
            {`Incident #${incidentInc8}`}
          </Text>
        )}

        {/* ── blood group ─────────────────────────────────────────────────── */}
        <View
          style={styles.bloodBlock}
          accessible
          accessibilityRole="text"
          accessibilityLabel={`${t('medical.bloodGroup')} ${
            nonEmpty(medical.bloodGroup) ? medical.bloodGroup : 'not recorded'
          }`}
        >
          <Text style={styles.floorLabel} allowFontScaling={false}>
            {t('medical.bloodGroup').toUpperCase()}
          </Text>
          <Text style={styles.bloodGroup} allowFontScaling={false} selectable numberOfLines={1}>
            {nonEmpty(medical.bloodGroup) ? medical.bloodGroup : '—'}
          </Text>
          {medical.organDonor ? (
            <Text style={styles.organDonor} allowFontScaling={false}>
              REGISTERED ORGAN DONOR
            </Text>
          ) : null}
        </View>

        <FloorList title={t('medical.allergies')} items={allergies} urgent />
        <FloorList title={t('medical.medications')} items={medications} />
        <FloorList title={t('medical.conditions')} items={conditions} />

        {/* ── ICE contacts, tap to call ───────────────────────────────────── */}
        <View style={styles.section}>
          <Text style={styles.floorLabel} allowFontScaling={false}>
            {t('medical.ice').toUpperCase()}
          </Text>
          {contacts.length === 0 ? (
            <Text style={styles.floorEmpty} allowFontScaling={false}>
              None recorded
            </Text>
          ) : (
            contacts.map((c) => (
              <Pressable
                key={`${c.name}-${c.phone}`}
                onPress={() => call(c.phone)}
                accessibilityRole="button"
                accessibilityLabel={`Call ${nonEmpty(c.name) ? c.name : c.phone} on ${c.phone}`}
                accessibilityHint="Opens the phone dialler with this number entered."
                android_ripple={{ color: colors.borderStrong }}
                style={({ pressed }) => [styles.iceButton, pressed ? styles.icePressed : null]}
              >
                <View style={styles.iceText}>
                  <Text style={styles.iceName} numberOfLines={1}>
                    {nonEmpty(c.name) ? c.name : 'Emergency contact'}
                  </Text>
                  <Text style={styles.icePhone} allowFontScaling={false} numberOfLines={1}>
                    {c.phone}
                  </Text>
                </View>
                <Text style={styles.iceGlyph} allowFontScaling={false}>
                  ☎
                </Text>
              </Pressable>
            ))
          )}
          {dialFailed ? (
            <Text style={styles.dialFailed} accessibilityLiveRegion="polite">
              Dialler did not open. Read the number aloud and dial it by hand.
            </Text>
          ) : null}
        </View>

        {nonEmpty(medical.notes) ? (
          <View style={styles.section}>
            <Text style={styles.floorLabel} allowFontScaling={false}>
              NOTES
            </Text>
            <Text style={styles.notes} selectable>
              {medical.notes}
            </Text>
          </View>
        ) : null}

        {/* ── where ───────────────────────────────────────────────────────── */}
        <View style={styles.section}>
          <Text style={styles.floorLabel} allowFontScaling={false}>
            LOCATION
          </Text>
          {fix === null ? (
            <Text style={styles.floorEmpty}>
              No position on this phone. Describe the surroundings to the operator.
            </Text>
          ) : (
            // ★ KNOWN SEAM: BigCoordinates paints its own dark panel, so on this
            //   white sheet it lands as an inset block of light-on-dark — 17:1
            //   internally, but not the sunlight-readable direction the rest of
            //   the card now uses. It needs a light variant from the component
            //   owner; it is not this file's to change, and reimplementing the
            //   digits here would fork the P-059 Latin-digit guarantee.
            <BigCoordinates lat={fix.lat} lon={fix.lon} accuracyM={fix.accuracyM} />
          )}
        </View>

        {/* ADR-019 — never wrap the call; AML fires from the platform's own path.

            ★ On a black band, on purpose. Call112Button renders its own failure
            line ("Dialler did not open. Dial 112 by hand.") in `warnText`, which
            is 2.04:1 on white and would be the least readable string on the card
            at the exact moment it is the only useful one. On black it is its
            designed 9.40:1. This also groups the two things that are *done*
            rather than *read* — the coordinates panel above it is a dark block
            for the same reason. */}
        <View style={styles.callBand}>
          <Call112Button />
        </View>

        {/* The route has a native header with a back arrow, so this Close is a
            second way out. It stays: the person who eventually puts this phone
            down is often not the person who opened it, and a stranger who has
            never seen this app can be sure of a labelled word in a way they
            cannot be sure of a chevron. */}
        <View style={[styles.floorFooter, { marginBottom: insets.bottom }]}>
          <Pressable
            onPress={onEdit}
            accessibilityRole="button"
            accessibilityLabel="Edit this medical card"
            style={({ pressed }) => [styles.footerButton, pressed ? styles.footerPressed : null]}
          >
            <Text style={styles.footerButtonText}>Edit card</Text>
          </Pressable>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
            style={({ pressed }) => [styles.footerButton, pressed ? styles.footerPressed : null]}
          >
            <Text style={styles.footerButtonText}>{t('common.close')}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

function FloorList({
  title,
  items,
  urgent,
}: {
  title: string;
  items: string[];
  urgent?: boolean;
}): ReactElement {
  return (
    <View style={styles.section}>
      <Text style={styles.floorLabel} allowFontScaling={false}>
        {title.toUpperCase()}
      </Text>
      {items.length === 0 ? (
        <Text style={styles.floorEmpty} allowFontScaling={false}>
          None recorded
        </Text>
      ) : (
        items.map((item) => (
          // A bullet AND a colour: never colour alone (PRD §6.4).
          <Text
            key={item}
            style={[styles.floorItem, urgent === true ? styles.floorItemUrgent : null]}
            selectable
          >
            {`• ${item}`}
          </Text>
        ))
      )}
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Edit mode
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The editor is a normal Kavach surface — dark theme, standard tokens — because
 * it is used calmly, months before it matters. Only the card itself is the L0
 * object. The field count is capped at what the card can render: an input the
 * card would silently drop is a lie told to the person filling it in.
 */
function MedicalEditor({
  initial,
  saving,
  saveFailed,
  onSave,
  onCancel,
}: {
  initial: MedicalCard;
  saving: boolean;
  saveFailed: boolean;
  onSave: (next: MedicalCard) => void;
  onCancel: () => void;
}): ReactElement {
  const [bloodGroup, setBloodGroup] = useState(initial.bloodGroup);
  const [allergies, setAllergies] = useState(() => padTo(initial.allergies, VISIBLE_ITEMS));
  const [medications, setMedications] = useState(() => padTo(initial.medications, VISIBLE_ITEMS));
  const [conditions, setConditions] = useState(() => padTo(initial.conditions, VISIBLE_ITEMS));
  const [iceNames, setIceNames] = useState(() =>
    padTo(initial.iceContacts.map((c) => c.name), ICE_SLOTS),
  );
  const [icePhones, setIcePhones] = useState(() =>
    padTo(initial.iceContacts.map((c) => c.phone), ICE_SLOTS),
  );
  const [organDonor, setOrganDonor] = useState(initial.organDonor);
  const [notes, setNotes] = useState(initial.notes);

  const next = useMemo<MedicalCard>(
    () => ({
      bloodGroup: bloodGroup.trim(),
      allergies: allergies.map((a) => a.trim()).filter(nonEmpty),
      medications: medications.map((m) => m.trim()).filter(nonEmpty),
      conditions: conditions.map((c) => c.trim()).filter(nonEmpty),
      iceContacts: iceNames
        .map((name, i) => ({ name: name.trim(), phone: (icePhones[i] ?? '').trim() }))
        // A contact with no number is not a contact. Dropping it here keeps the
        // card honest rather than rendering a name nobody can ring.
        .filter((c) => nonEmpty(c.phone)),
      organDonor,
      notes: notes.trim(),
    }),
    [bloodGroup, allergies, medications, conditions, iceNames, icePhones, organDonor, notes],
  );

  const setAt = useCallback(
    (setter: (fn: (prev: string[]) => string[]) => void, index: number, value: string) => {
      setter((prev) => prev.map((v, i) => (i === index ? value : v)));
    },
    [],
  );

  return (
    <View style={styles.screen}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.editContent}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.editTitle} accessibilityRole="header">
          {t('medical.title')}
        </Text>
        <Text style={styles.editHint}>
          Three allergies and three medicines is what a stranger can read under stress. Put the
          most dangerous one first.
        </Text>

        <Field
          label={t('medical.bloodGroup')}
          value={bloodGroup}
          onChangeText={setBloodGroup}
          placeholder="B+"
          autoCapitalize="characters"
          maxLength={8}
        />

        {allergies.map((value, i) => (
          <Field
            key={`allergy-${i}`}
            label={`${t('medical.allergies')} ${i + 1}`}
            value={value}
            onChangeText={(v) => setAt(setAllergies, i, v)}
            placeholder={i === 0 ? 'Penicillin' : ''}
            maxLength={48}
          />
        ))}

        {medications.map((value, i) => (
          <Field
            key={`medication-${i}`}
            label={`${t('medical.medications')} ${i + 1}`}
            value={value}
            onChangeText={(v) => setAt(setMedications, i, v)}
            placeholder={i === 0 ? 'Salbutamol inhaler' : ''}
            maxLength={48}
          />
        ))}

        {conditions.map((value, i) => (
          <Field
            key={`condition-${i}`}
            label={`${t('medical.conditions')} ${i + 1}`}
            value={value}
            onChangeText={(v) => setAt(setConditions, i, v)}
            placeholder={i === 0 ? 'Asthma' : ''}
            maxLength={48}
          />
        ))}

        {iceNames.map((value, i) => (
          <View key={`ice-${i}`} style={styles.iceEditRow}>
            <Field
              label={`${t('medical.ice')} ${i + 1}`}
              value={value}
              onChangeText={(v) => setAt(setIceNames, i, v)}
              placeholder="Name"
              maxLength={40}
              style={styles.iceEditName}
            />
            <Field
              label="Number"
              value={icePhones[i] ?? ''}
              onChangeText={(v) => setAt(setIcePhones, i, v)}
              placeholder="+9198…"
              keyboardType="phone-pad"
              maxLength={20}
              style={styles.iceEditPhone}
            />
          </View>
        ))}

        <Toggle
          value={organDonor}
          onChange={setOrganDonor}
          label="Registered organ donor"
          hint="Shown in capitals on the card. Time-critical for transplant teams."
        />

        <Field
          label="Notes"
          value={notes}
          onChangeText={setNotes}
          placeholder="Inhaler is in the left jacket pocket."
          multiline
          maxLength={240}
          style={styles.notesField}
        />

        {saveFailed ? (
          <Text style={styles.saveFailed} accessibilityLiveRegion="assertive">
            This phone would not store the card. Nothing was saved and nothing was lost — what you
            typed is still here. Press Save again.
          </Text>
        ) : null}

        <View style={styles.editActions}>
          <Pressable
            onPress={() => onSave(next)}
            disabled={saving}
            accessibilityRole="button"
            accessibilityState={{ disabled: saving }}
            accessibilityLabel={`${t('common.save')} medical card`}
            style={({ pressed }) => [
              styles.editButton,
              styles.editButtonPrimary,
              pressed ? styles.editPressed : null,
            ]}
          >
            <Text style={styles.editButtonPrimaryText}>
              {saving ? 'Saving…' : t('common.save')}
            </Text>
          </Pressable>
          <Pressable
            onPress={onCancel}
            accessibilityRole="button"
            accessibilityLabel={`${t('common.cancel')} editing`}
            style={({ pressed }) => [styles.editButton, pressed ? styles.editPressed : null]}
          >
            <Text style={styles.editButtonText}>{t('common.cancel')}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  autoCapitalize,
  keyboardType,
  maxLength,
  multiline,
  style,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  keyboardType?: 'default' | 'phone-pad';
  maxLength?: number;
  multiline?: boolean;
  style?: StyleProp<ViewStyle>;
}): ReactElement {
  return (
    <View style={[styles.field, style]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        autoCapitalize={autoCapitalize ?? 'sentences'}
        keyboardType={keyboardType ?? 'default'}
        maxLength={maxLength}
        multiline={multiline}
        accessibilityLabel={label}
        style={[styles.input, multiline === true ? styles.inputMultiline : null]}
      />
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════

function nonEmpty(s: string): boolean {
  return s.trim().length > 0;
}

function padTo(list: string[], n: number): string[] {
  const out = list.slice(0, n);
  while (out.length < n) out.push('');
  return out;
}

function toFix(raw: { lat: number; lon: number; accuracyM: number } | null): Fix | null {
  return raw === null ? null : { lat: raw.lat, lon: raw.lon, accuracyM: raw.accuracyM };
}

// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ★ THE ONE SURFACE IN KAVACH THAT IS NOT DARK. ★
 *
 * `colors.black` on `colors.white` is 21:1 — the highest ratio that exists — and
 * the direction of it is the point. See the file header for why a black sheet
 * loses the daylight argument it was written to win.
 *
 * ★ A GAP IN THE PALETTE, STATED RATHER THAN PAPERED OVER ★
 * Every text token in theme.ts (`textDim`, `textFaint`) is tuned for a dark
 * surface and measures 1.8:1 / 3.1:1 on white — unusable here. The card's
 * secondary ink is therefore `colors.borderStrong` (#3E4C5E), which happens to
 * be a dark slate and lands at 8.75:1 on white. It is used as INK on purpose and
 * not by accident; the palette needs a `textDimInverse` and does not have one.
 */
const CARD_INK = colors.black;
const CARD_INK_DIM = colors.borderStrong;

const styles = StyleSheet.create({
  floor: { flex: 1, backgroundColor: colors.white },
  screen: { flex: 1, backgroundColor: colors.bg },
  scroll: { flex: 1 },
  floorContent: { padding: space.lg, paddingBottom: space.xxxl, gap: space.lg },
  editContent: { padding: space.lg, paddingBottom: space.xxxl, gap: space.md },

  instruction: {
    color: colors.white,
    fontSize: font.h3,
    fontWeight: weight.bold,
    // White on dangerDark is 9.41:1, and a solid red band is the one thing on a
    // white sheet that a stranger's eye lands on before they read a word.
    backgroundColor: colors.dangerDark,
    borderRadius: radius.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    textAlign: 'center',
  },

  emptyCard: {
    borderWidth: 2,
    borderColor: CARD_INK,
    borderRadius: radius.md,
    padding: space.lg,
    gap: space.xs,
  },
  emptyTitle: { color: CARD_INK, fontSize: font.h2, fontWeight: weight.heavy },
  emptyBody: { color: CARD_INK, fontSize: font.body, lineHeight: font.body + 8 },

  owner: { color: CARD_INK, fontSize: font.h1, fontWeight: weight.heavy },
  incidentRef: {
    color: CARD_INK_DIM,
    fontSize: font.small,
    fontFamily: font.mono,
    marginTop: -space.md,
  },

  bloodBlock: { gap: space.xs },
  floorLabel: {
    color: CARD_INK_DIM,
    fontSize: font.small,
    fontWeight: weight.heavy,
    letterSpacing: 2.5,
  },
  bloodGroup: {
    color: CARD_INK,
    fontSize: BLOOD_GROUP_SIZE,
    lineHeight: BLOOD_GROUP_SIZE + 8,
    fontWeight: weight.heavy,
    includeFontPadding: false,
    letterSpacing: -2,
  },
  organDonor: {
    color: CARD_INK,
    fontSize: font.body,
    fontWeight: weight.heavy,
    letterSpacing: 1,
  },

  section: { gap: space.sm },
  floorItem: { color: CARD_INK, fontSize: font.h2, fontWeight: weight.semibold },
  // Allergies kill people. They get the only non-black ink on the card, and it
  // is `dangerDark` — 9.41:1 on white, and the colour a printed medical card
  // uses for exactly this line. (`warnText` is 2.04:1 here; `warn` is 5.92:1.)
  floorItemUrgent: { color: colors.dangerDark, fontWeight: weight.heavy },
  floorEmpty: { color: CARD_INK_DIM, fontSize: font.body, fontWeight: weight.medium },
  notes: { color: CARD_INK, fontSize: font.body, lineHeight: font.body + 8 },

  iceButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    minHeight: MIN_TOUCH_TARGET + space.lg,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: CARD_INK,
  },
  // A grey wash rather than a fade: on a white sheet, dimming a control reads as
  // "unavailable", and this is the control a stranger presses under stress.
  // `textDim` is the palette's only light neutral; it is a text token being used
  // as a fill here because theme.ts has no light-surface press step, and black on
  // it still measures 11.61:1.
  icePressed: { backgroundColor: colors.textDim },
  iceText: { flex: 1, gap: space.xxs },
  iceName: { color: CARD_INK, fontSize: font.h3, fontWeight: weight.bold },
  icePhone: { color: CARD_INK, fontSize: font.h3, fontFamily: font.mono },
  iceGlyph: { color: CARD_INK, fontSize: font.h1 },
  dialFailed: { color: colors.dangerDark, fontSize: font.body, fontWeight: weight.bold },

  callBand: {
    backgroundColor: colors.bg,
    borderRadius: radius.lg,
    padding: space.md,
  },

  floorFooter: { flexDirection: 'row', gap: space.sm },
  footerButton: {
    flex: 1,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: CARD_INK,
  },
  footerPressed: { backgroundColor: colors.textDim },
  footerButtonText: { color: CARD_INK, fontSize: font.body, fontWeight: weight.semibold },

  // editor
  editTitle: { color: colors.text, fontSize: font.h1, fontWeight: weight.bold },
  editHint: { color: colors.textDim, fontSize: font.small, lineHeight: font.small + 6 },
  saveFailed: {
    color: colors.warnText,
    fontSize: font.body,
    lineHeight: font.body + 6,
    fontWeight: weight.semibold,
    marginTop: space.sm,
  },
  field: { gap: space.xs },
  fieldLabel: { color: colors.textDim, fontSize: font.small, fontWeight: weight.semibold },
  input: {
    minHeight: MIN_TOUCH_TARGET,
    backgroundColor: colors.bgInput,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    color: colors.text,
    fontSize: font.body,
  },
  inputMultiline: { minHeight: MIN_TOUCH_TARGET * 2, textAlignVertical: 'top' },
  notesField: { marginTop: space.xs },
  iceEditRow: { flexDirection: 'row', gap: space.sm },
  iceEditName: { flex: 3 },
  iceEditPhone: { flex: 2 },
  editActions: { flexDirection: 'row', gap: space.sm, marginTop: space.md },
  editButton: {
    flex: 1,
    minHeight: MIN_TOUCH_TARGET + space.sm,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.bgElevated,
  },
  // The editor is a dark surface, so its press step darkens rather than washes.
  editPressed: { backgroundColor: colors.bgInput },
  editButtonPrimary: { backgroundColor: colors.info, borderColor: colors.info },
  // ★ White, not black. The comment that used to sit here claimed "black on
  //   #4A9BE8 measures 7.14:1" — but `colors.info` is #12507F and black on it is
  //   2.48:1, so the Save label was the least readable string in this file.
  //   White on #12507F is 8.47:1. src/ui/components/Button.tsx carries the same
  //   stale comment and the same defect on its `primary` skin; that file is not
  //   this agent's to edit.
  editButtonPrimaryText: { color: colors.white, fontSize: font.h3, fontWeight: weight.bold },
  editButtonText: { color: colors.text, fontSize: font.h3, fontWeight: weight.semibold },
});
