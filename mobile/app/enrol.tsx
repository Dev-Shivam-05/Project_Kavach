/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ENROL — a second phone joins the family (Phase 0 §3.3 item 0.15)
 *
 * Both halves of the exchange live on one screen because they are one
 * conversation between two people standing near each other, and because the two
 * phones have to show the SAME four groups of characters at the same moment for
 * the check in the middle to mean anything. Splitting them across two routes
 * would make that comparison a thing you navigate to.
 *
 * ★★★ THE STEP THAT IS NOT A FORMALITY ★★★
 * Everything the two phones exchange is confidential and none of it is
 * authenticated. Somebody who can rewrite the invitation — a forwarded
 * screenshot, a hostile network, a person who retyped it "helpfully" — swaps in
 * their own public key, receives the family key, and joins. Every byte still
 * verifies. The ONLY thing that catches it is the two people reading the four
 * groups aloud and finding them identical, which is why the fingerprint is the
 * largest thing on both screens and why the confirm button says what it is
 * confirming.
 *
 * ★★★ NO SERVER, NO SIGNAL, NO PROBLEM ★★★
 * Nothing here reaches the network. A code read across a kitchen table, or a QR
 * held up to a camera, is the whole transport. The reply is safe to send over
 * WhatsApp or dictate over a phone line precisely because it is sealed to one
 * device's key, and the screen says so rather than leaving people guessing.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import Svg, { Path, Rect } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  fingerprintGroups,
  normaliseCode,
  qrMatrix,
  secondsLeft,
} from '../src/domain/enrolment';
import {
  countdownLabel,
  useEnrol,
  type EnrolRole,
  type EnrolledDevice,
} from '../src/state/enrolStore';
import { useKavach } from '../src/state/store';
import { Button, Card, EmptyState, ListItem, Pill, Section } from '../src/ui/components';
import {
  MIN_TOUCH_TARGET,
  colors,
  font,
  leading,
  radius,
  space,
  tracking,
  weight,
} from '../src/ui/theme';

/** Which code the camera is pointed at, or null when it is not open. */
type Scanning = null | 'invite' | 'reply';

export default function EnrolScreen() {
  const insets = useSafeAreaInsets();

  const storeReady = useKavach((s) => s.ready);
  const deviceId = useKavach((s) => s.deviceId);
  const familyId = useKavach((s) => s.familyId);
  const myName = useKavach((s) => s.me?.displayName ?? '');

  const ready = useEnrol((s) => s.ready);
  const hydrate = useEnrol((s) => s.hydrate);
  const blocked = useEnrol((s) => s.blocked);
  const role = useEnrol((s) => s.role);
  const chooseRole = useEnrol((s) => s.chooseRole);
  const hasFamilyKey = useEnrol((s) => s.hasFamilyKey);
  const notice = useEnrol((s) => s.notice);
  const clearNotice = useEnrol((s) => s.clearNotice);

  useEffect(() => {
    if (storeReady) void hydrate();
  }, [storeReady, hydrate]);

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + space.xxl },
      ]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.titleRow}>
        <Text style={styles.title}>Add a phone</Text>
        <Button label="Close" variant="quiet" onPress={() => router.back()} />
      </View>
      <Text style={styles.lede}>
        Two phones, in the same room, with no internet needed. One shows a code, the other
        answers it.
      </Text>

      {blocked !== null ? (
        <Card tone="danger">
          <Text style={styles.h3}>Not yet</Text>
          <Text style={styles.body}>{blocked}</Text>
        </Card>
      ) : null}

      {notice !== null ? (
        <Card tone="warn">
          <Text style={styles.body}>{notice}</Text>
          <Button label="OK" variant="ghost" onPress={clearNotice} />
        </Card>
      ) : null}

      {/* Not silence. Between mount and hydrate this screen used to show the
          title, the lede and nothing at all — indistinguishable from a screen
          that had finished and had nothing to offer. */}
      {!ready && blocked === null ? (
        <Card>
          <Text style={styles.h3}>Getting this phone’s keys ready…</Text>
          <Text style={styles.body}>
            Reading the keys stored on this phone. Nothing is sent anywhere, and nothing here needs
            the internet.
          </Text>
        </Card>
      ) : null}

      {!ready || blocked !== null ? null : role === null ? (
        <RoleChoice hasFamilyKey={hasFamilyKey} onChoose={chooseRole} />
      ) : role === 'joining' ? (
        <JoiningPanel deviceId={deviceId} suggestedName={myName} />
      ) : (
        <InvitingPanel familyId={familyId} guardianName={myName} />
      )}
    </ScrollView>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════

function RoleChoice({
  hasFamilyKey,
  onChoose,
}: {
  hasFamilyKey: boolean;
  onChoose: (r: EnrolRole) => void;
}) {
  return (
    <Section title="Which phone is this?">
      <Card enter="rise">
        <Text style={styles.h3}>This one is new</Text>
        <Text style={styles.body}>
          It is not in the family yet. It will show a code for somebody already in the family to
          read.
        </Text>
        <Button label="This phone is joining" size="lg" onPress={() => onChoose('joining')} />
      </Card>

      <Card enter="rise">
        <Text style={styles.h3}>This one is already in</Text>
        <Text style={styles.body}>
          {hasFamilyKey
            ? 'It holds the family key, so it can let another phone in.'
            : 'This phone has no family key yet, so it cannot let anybody in. Set it up first, or join an existing family with the option above.'}
        </Text>
        <Button
          label="I am adding their phone"
          size="lg"
          variant="ghost"
          disabled={!hasFamilyKey}
          onPress={() => onChoose('inviting')}
        />
      </Card>
    </Section>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// The joining phone
// ═══════════════════════════════════════════════════════════════════════════════

function JoiningPanel({ deviceId, suggestedName }: { deviceId: string; suggestedName: string }) {
  const invite = useEnrol((s) => s.invite);
  const joined = useEnrol((s) => s.joined);
  const restartRequired = useEnrol((s) => s.restartRequired);
  const createInvite = useEnrol((s) => s.createInvite);
  const discardInvite = useEnrol((s) => s.discardInvite);
  const accept = useEnrol((s) => s.accept);
  /*
   * ★ D-033 (6-D-7c) — the line that turns a pairing into a family.
   * `enrolStore` is airgapped by design and stops at the group key; without
   * this call `store.ts`'s roster never learns that anyone joined, which is
   * exactly how POST /v1/members ended up with no caller in the whole app.
   * Idempotent, so calling it from all three completion paths is safe.
   */
  const syncEnrolment = useKavach((s) => s.syncEnrolment);
  const chooseRole = useEnrol((s) => s.chooseRole);

  const [name, setName] = useState(suggestedName);
  const [reply, setReply] = useState('');
  const [scanning, setScanning] = useState<Scanning>(null);
  const now = useTicker(invite !== null && joined === null);

  const onScanned = useCallback(
    (text: string) => {
      setScanning(null);
      setReply(text);
      void accept(text).then((ok) => (ok ? syncEnrolment() : undefined));
    },
    [accept],
  );

  if (joined !== null) {
    return (
      <Section title="Done">
        <Card tone="ok" enter="rise">
          <Text style={styles.h2}>This phone is in the family</Text>
          <Text style={styles.body}>
            {joined.guardianName.length > 0
              ? `${joined.guardianName} let this phone in. If that is not who you asked, say so now — this phone is using their key from here on.`
              : 'This phone now shares the family key.'}
          </Text>
          {restartRequired ? (
            <Text style={styles.emphasis}>
              Close Kavach completely and open it again. The safety agent reads the family key once,
              when it starts, so it is still using the old one until you do.
            </Text>
          ) : null}
          <Button label="Back to Kavach" size="lg" onPress={() => router.back()} />
        </Card>
      </Section>
    );
  }

  if (invite === null) {
    return (
      <Section title="Step 1 — say who you are">
        <Card>
          <Text style={styles.body}>
            The other phone will see this name. Use whatever the family calls you.
          </Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="Ananya"
            placeholderTextColor={colors.textFaint}
            autoCorrect={false}
            maxLength={24}
            accessibilityLabel="Your name, as the other phone will see it"
          />
          <Button
            label="Show my code"
            size="lg"
            disabled={name.trim().length === 0}
            onPress={() => void createInvite(deviceId, name)}
          />
          <Button label="Go back" variant="quiet" onPress={() => chooseRole(null)} />
        </Card>
      </Section>
    );
  }

  const left = secondsLeft(invite.expiresAt, now);

  return (
    <>
      <Section title="Step 2 — show them this" right={<Pill label={countdownLabel(left)} tone={left > 60 ? 'info' : 'warn'} />}>
        <CodeCard
          code={invite.code}
          caption="Hold the square up to their camera, or read the letters out five at a time."
          shareTitle="My Kavach code"
          expired={left === 0}
          onRenew={() => void createInvite(deviceId, name)}
        />
      </Section>

      <FingerprintCard
        groups={fingerprintGroups(invite.boxPublic)}
        heading="Check this together"
        body="Read these four groups out to them. Their phone must show exactly the same four. This is your phone's fingerprint — a short summary of its key — and two phones showing the same one is what proves the code went straight from here to there, with nobody in between."
      />

      <Section title="Step 3 — their reply">
        {scanning === 'reply' ? (
          <Scanner onText={onScanned} onCancel={() => setScanning(null)} />
        ) : (
          <Card>
            <Text style={styles.body}>
              They will send back a longer code. It is safe to read it aloud, photograph it or send
              it over WhatsApp — only this phone can open it.
            </Text>
            <Button label="Scan their reply" size="lg" onPress={() => setScanning('reply')} />
            <TextInput
              style={styles.codeInput}
              value={reply}
              onChangeText={setReply}
              placeholder="…or type their reply here"
              placeholderTextColor={colors.textFaint}
              autoCapitalize="characters"
              autoCorrect={false}
              multiline
              accessibilityLabel="The reply code from the other phone"
            />
            <Button
              label="Join the family"
              size="lg"
              disabled={normaliseCode(reply).length < 10}
              onPress={() => void accept(reply).then((ok) => (ok ? syncEnrolment() : undefined))}
            />
            <Button label="Start over" variant="quiet" onPress={() => void discardInvite()} />
          </Card>
        )}
      </Section>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// The phone that already holds the family key
// ═══════════════════════════════════════════════════════════════════════════════

function InvitingPanel({ familyId, guardianName }: { familyId: string; guardianName: string }) {
  const reviewing = useEnrol((s) => s.reviewing);
  const response = useEnrol((s) => s.response);
  const respondedTo = useEnrol((s) => s.respondedTo);
  const roster = useEnrol((s) => s.roster);
  const review = useEnrol((s) => s.review);
  const dropReview = useEnrol((s) => s.dropReview);
  const confirmAndSeal = useEnrol((s) => s.confirmAndSeal);
  /* ★ D-033 — see the twin call in JoiningPanel; the guardian is the side that
     can actually register the new member, because it is the side that knows the
     joiner's device id. */
  const syncEnrolment = useKavach((s) => s.syncEnrolment);
  const clearResponse = useEnrol((s) => s.clearResponse);
  const chooseRole = useEnrol((s) => s.chooseRole);

  const [typed, setTyped] = useState('');
  const [scanning, setScanning] = useState<Scanning>(null);
  const now = useTicker(response !== null);

  const onScanned = useCallback(
    (text: string) => {
      setScanning(null);
      setTyped(text);
      review(text);
    },
    [review],
  );

  if (response !== null) {
    const left = secondsLeft(response.expiresAt, now);
    return (
      <>
        <Section
          title={`Give this to ${respondedTo ?? 'them'}`}
          right={<Pill label={countdownLabel(left)} tone={left > 60 ? 'info' : 'warn'} />}
        >
          <CodeCard
            code={response.code}
            caption="Locked to their phone alone. Reading it out, photographing it or sending it over WhatsApp gives nothing away to anybody else."
            shareTitle="Kavach reply"
            expired={left === 0}
            onRenew={null}
          />
          <Button label="Done" size="lg" onPress={clearResponse} />
        </Section>
        <RosterSection roster={roster} />
      </>
    );
  }

  if (reviewing !== null) {
    return (
      <Section title="Is this really them?">
        <Card tone="warn" enter="rise">
          <Text style={styles.h2}>{reviewing.displayName}</Text>
          <Text style={styles.meta}>Phone {reviewing.deviceId.slice(0, 8)}</Text>
        </Card>

        <FingerprintCard
          groups={fingerprintGroups(reviewing.boxPublic)}
          heading="Read these four groups out loud"
          body={`Ask ${reviewing.displayName} what their phone shows. It must be exactly the same four groups. This is that phone's fingerprint — a short summary of its key — and comparing it out loud is the only thing that proves the code came from their phone and was not swapped on the way. If one character is different, stop.`}
        />

        <Card>
          <Text style={styles.body}>
            Saying yes gives that phone your family key. It will then see the family's alerts and
            locations, exactly as this phone does.
          </Text>
          <Button
            label="They match — add this phone"
            size="lg"
            onPress={() => void confirmAndSeal(familyId, guardianName).then(syncEnrolment)}
          />
          <Button label="They do not match" variant="danger" onPress={dropReview} />
        </Card>
      </Section>
    );
  }

  return (
    <>
      <Section title="Read their code">
        {scanning === 'invite' ? (
          <Scanner onText={onScanned} onCancel={() => setScanning(null)} />
        ) : (
          <Card>
            <Text style={styles.body}>
              Point this phone at the square on theirs, or type what they read out. Their code is
              public — nothing is given away by it.
            </Text>
            <Button label="Scan their code" size="lg" onPress={() => setScanning('invite')} />
            <TextInput
              style={styles.codeInput}
              value={typed}
              onChangeText={setTyped}
              placeholder="…or type their code here"
              placeholderTextColor={colors.textFaint}
              autoCapitalize="characters"
              autoCorrect={false}
              multiline
              accessibilityLabel="The code shown on the joining phone"
            />
            <Button
              label="Read the code"
              size="lg"
              disabled={normaliseCode(typed).length < 10}
              onPress={() => review(typed)}
            />
            <Button label="Go back" variant="quiet" onPress={() => chooseRole(null)} />
          </Card>
        )}
      </Section>
      <RosterSection roster={roster} />
    </>
  );
}

function RosterSection({ roster }: { roster: EnrolledDevice[] }) {
  return (
    <Section title="Phones you have added" right={roster.length === 0 ? undefined : `${roster.length}`}>
      {roster.length === 0 ? (
        <EmptyState
          glyph="◇"
          title="Nobody yet"
          body="Every phone you add here shares one family key. That is what lets an alarm on one reach all the others."
        />
      ) : (
        roster.map((d) => (
          <ListItem
            key={d.deviceId}
            glyph="✓"
            title={d.displayName}
            subtitle={`${d.fingerprint} · added ${new Date(d.enrolledAt).toLocaleDateString()}`}
          />
        ))
      )}
    </Section>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Pieces
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The fingerprint, at the largest size on the screen, in four groups of four.
 *
 * `allowFontScaling` stays on: someone reading this aloud across a room may well
 * be the family member who runs their phone at 200 % text. The groups wrap
 * rather than shrink for the same reason.
 */
function FingerprintCard({
  groups,
  heading,
  body,
}: {
  groups: string[];
  heading: string;
  body: string;
}) {
  return (
    <Card tone="info">
      <Text style={styles.h3}>{heading}</Text>
      <View
        style={styles.fingerprintRow}
        accessible
        accessibilityLabel={`Fingerprint: ${groups.join(', ')}`}
      >
        {groups.map((g) => (
          <Text key={g} style={styles.fingerprintGroup}>
            {g}
          </Text>
        ))}
      </View>
      <Text style={styles.body}>{body}</Text>
    </Card>
  );
}

/**
 * One code, two ways. The square is the fast path when both phones are present;
 * the letters are the only path when one of them has no working camera, and the
 * screen never offers just one.
 */
function CodeCard({
  code,
  caption,
  shareTitle,
  expired,
  onRenew,
}: {
  code: string;
  caption: string;
  shareTitle: string;
  expired: boolean;
  onRenew: (() => void) | null;
}) {
  const [showQr, setShowQr] = useState(true);

  if (expired) {
    return (
      <Card tone="danger">
        <Text style={styles.h3}>This code has run out</Text>
        <Text style={styles.body}>
          Codes last ten minutes, so one left on a screen or in a chat cannot be used later.
        </Text>
        {onRenew === null ? null : <Button label="Make a new one" size="lg" onPress={onRenew} />}
      </Card>
    );
  }

  return (
    <Card>
      {showQr ? <QrBlock text={normaliseCode(code)} /> : null}
      <Text style={styles.code} selectable>
        {code}
      </Text>
      <Text style={styles.meta}>{caption}</Text>
      <Button
        label={showQr ? 'Hide the square' : 'Show the square'}
        variant="ghost"
        onPress={() => setShowQr((v) => !v)}
      />
      <Button
        label="Send it another way"
        variant="quiet"
        onPress={() => {
          void Share.share({ message: code, title: shareTitle }).catch(() => {
            /* no share target on this device; the letters above are still readable */
          });
        }}
      />
    </Card>
  );
}

/** White quiet zone and white background — a dark card would not scan. */
function QrBlock({ text }: { text: string }) {
  const matrix = useMemo(() => qrMatrix(text), [text]);
  if (matrix === null) return null;

  const quiet = 4;
  const span = matrix.length + quiet * 2;
  let path = '';
  for (let y = 0; y < matrix.length; y++) {
    for (let x = 0; x < matrix.length; x++) {
      if (matrix[y][x]) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }
  }

  return (
    <View style={styles.qrFrame} accessible accessibilityLabel="A square code for the other phone's camera">
      <Svg width="100%" height="100%" viewBox={`0 0 ${span} ${span}`}>
        <Rect x={0} y={0} width={span} height={span} fill={colors.white} />
        <Path d={path} fill={colors.black} />
      </Svg>
    </View>
  );
}

/**
 * The camera, and a way out of it.
 *
 * A refused permission is never a dead end: the panel says so and the typed
 * field behind it still works, because a phone with a broken camera must still
 * be able to join a family.
 */
function Scanner({ onText, onCancel }: { onText: (text: string) => void; onCancel: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  // onBarcodeScanned fires on every frame that still contains the code; without
  // this the first scan would be handled thirty times a second.
  const done = useRef(false);

  useEffect(() => {
    if (permission !== null && !permission.granted && permission.canAskAgain) {
      void requestPermission();
    }
  }, [permission, requestPermission]);

  if (permission === null) {
    return (
      <Card>
        <Text style={styles.body}>Waiting for the camera…</Text>
        <Button label="Type it instead" variant="ghost" onPress={onCancel} />
      </Card>
    );
  }

  if (!permission.granted) {
    return (
      <Card tone="warn">
        <Text style={styles.h3}>No camera</Text>
        <Text style={styles.body}>
          Kavach cannot use the camera on this phone, so the square cannot be scanned. Typing the
          code works exactly as well — it is the same code.
        </Text>
        <Button label="Type it instead" size="lg" onPress={onCancel} />
      </Card>
    );
  }

  return (
    <Card>
      <View style={styles.cameraFrame}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => {
            if (done.current || data.length === 0) return;
            done.current = true;
            onText(data);
          }}
        />
      </View>
      <Text style={styles.meta}>Hold the other phone's square inside the frame.</Text>
      <Button label="Cancel" variant="ghost" onPress={onCancel} />
    </Card>
  );
}

/** A once-a-second clock, running only while something on screen counts down. */
function useTicker(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live]);
  return now;
}

// ═══════════════════════════════════════════════════════════════════════════════

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: space.lg, gap: space.xl },

  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    minHeight: MIN_TOUCH_TARGET,
  },
  title: {
    flexShrink: 1,
    color: colors.text,
    fontSize: font.h1,
    lineHeight: leading.h1,
    letterSpacing: tracking.h1,
    fontWeight: weight.bold,
  },
  lede: { color: colors.textDim, fontSize: font.body, lineHeight: leading.body },

  h2: { color: colors.text, fontSize: font.h2, lineHeight: leading.h2, fontWeight: weight.bold },
  h3: { color: colors.text, fontSize: font.h3, lineHeight: leading.h3, fontWeight: weight.semibold },
  body: { color: colors.textDim, fontSize: font.body, lineHeight: leading.body },
  meta: { color: colors.textFaint, fontSize: font.small, lineHeight: leading.small },
  emphasis: {
    color: colors.text,
    fontSize: font.body,
    lineHeight: leading.body,
    fontWeight: weight.semibold,
  },

  input: {
    minHeight: MIN_TOUCH_TARGET,
    backgroundColor: colors.bgInput,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: space.md,
    color: colors.text,
    fontSize: font.h3,
  },
  codeInput: {
    minHeight: 96,
    backgroundColor: colors.bgInput,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.md,
    color: colors.text,
    fontFamily: font.mono,
    fontSize: font.body,
    lineHeight: leading.body,
    textAlignVertical: 'top',
  },

  code: {
    color: colors.text,
    fontFamily: font.mono,
    fontSize: font.h3,
    lineHeight: leading.h2,
    letterSpacing: 1.4,
  },

  fingerprintRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.md,
  },
  fingerprintGroup: {
    color: colors.text,
    fontFamily: font.mono,
    fontSize: font.display,
    lineHeight: leading.display,
    fontWeight: weight.bold,
    letterSpacing: 2,
  },

  qrFrame: {
    aspectRatio: 1,
    width: '100%',
    backgroundColor: colors.white,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  cameraFrame: {
    aspectRatio: 1,
    width: '100%',
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: colors.black,
  },
});
