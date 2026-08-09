/**
 * ★★★ ADR-019 — HAND OFF TO THE DIALLER. NEVER WRAP THE CALL. ★★★
 *
 * This button does exactly one thing: `Linking.openURL('tel:112')`. It does not
 * place the call, does not auto-dial, does not use a call API, does not record,
 * does not proxy through a VoIP leg, and does not "helpfully" attach anything.
 *
 * WHY THAT IS NOT NEGOTIABLE:
 * The value of a 112 call in India is Advanced Mobile Location. AML fires from
 * the platform's own emergency-call path and pushes a precise fix to the PSAP out
 * of band — it is strictly better than anything this app can transmit, and it
 * works even when our servers are gone. Any wrapper, interception, or
 * programmatic placement risks the OS not classifying the call as an emergency
 * call, which silently kills AML. We would then have "improved" the one call that
 * mattered into a worse call. So: hand the user to the dialler with the number
 * pre-filled, and get out of the way. The final press is theirs.
 *
 * The literal digits stay on screen even after a failure, because the true floor
 * is a human reading "112" and dialling it by hand.
 */
import React, { useCallback, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';

import { t } from '../../i18n';
import { NO_MOTION } from '../motion';
import {
  CALL_112_HEIGHT,
  colors,
  font,
  leading,
  MIN_TOUCH_TARGET,
  radius,
  space,
  weight,
} from '../theme';
import { PressableScale } from './PressableScale';

export interface Call112ButtonProps {
  /** Inline placement (a card footer, a responder row) rather than the panic screen. */
  compact?: boolean;
}

const COMPACT_HEIGHT = MIN_TOUCH_TARGET + space.sm;

export function Call112Button({ compact = false }: Call112ButtonProps): React.ReactElement {
  const [failed, setFailed] = useState(false);

  const open = useCallback(() => {
    // No await, no state machine, no telemetry hop before the dialler opens.
    Linking.openURL('tel:112').catch(() => setFailed(true));
  }, []);

  const label = t('panic.call112');

  return (
    <View>
      <PressableScale
        onPress={open}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint="Opens the phone dialler with 112 entered. You press call."
        // ★ §6.4: nothing on the panic path moves except the countdown ring.
        // NO_MOTION keeps the haptic — the confirmation that a shaking hand
        // actually landed — and drops the travel.
        motion={NO_MOTION}
        // A white edge while held, rather than a dim: this button must never
        // fade under a finger. Fading is what "unavailable" looks like, and the
        // one moment it would happen is the moment someone is pressing it.
        highlightColor={colors.white}
        highlightRadius={radius.lg}
        style={[styles.button, { height: compact ? COMPACT_HEIGHT : CALL_112_HEIGHT }]}
      >
        <Text
          style={[styles.label, { fontSize: compact ? font.h3 : font.h1 }]}
          allowFontScaling={false}
          numberOfLines={1}
        >
          {label}
        </Text>
      </PressableScale>

      {failed ? (
        // The instruction for what to do when the hand-off fails, on the panic
        // screen, at body size in warnText (9.40:1 on bg). It was font.small in
        // the warn FILL colour, 3.25:1 — the least legible string in the product
        // sitting at the one moment nothing else on screen can help.
        <Text style={styles.fallback} accessibilityLiveRegion="polite">
          Dialler did not open. Dial 112 by hand.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    // Full width, ≥88 dp, bottom-third reachable — PRD §6.4.
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.danger,
    borderRadius: radius.lg,
    borderWidth: 2,
    borderColor: colors.dangerDark,
    paddingHorizontal: space.lg,
  },
  label: {
    color: colors.white,
    fontWeight: weight.heavy,
    letterSpacing: 1.5,
    includeFontPadding: false,
  },
  fallback: {
    color: colors.warnText,
    fontSize: font.body,
    lineHeight: leading.body,
    fontWeight: weight.semibold,
    marginTop: space.sm,
    textAlign: 'center',
  },
});

export default Call112Button;
