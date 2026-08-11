// ═══════════════════════════════════════════════════════════════════════════════
// CHARACTERIZATION — the escalation ladder (1.29 · 1.31 · §2.6.2, ADR-014)
//
// internal/escalation is 1,140 lines that decide whether a human is woken, and
// until W10-d it had no tests at all (RISK.md §4). claim_test.go pinned CLAIM and
// RELEASE — two transitions out of the whole engine. This file pins the ladder
// itself: what OnIncidentOpen arms, what each rung does when its timer fires, and
// what a rung does when the incident has moved on underneath it.
//
// ★ Nothing in this file is a new requirement. ★ Every assertion states what the
// code at HEAD already does, so that the next change to engine.go has to say out
// loud which of these it is breaking. Where the behaviour is load-bearing the
// comment names the requirement that makes it so.
//
// The wheel that fires these timers — claiming, ordering, batch limits, the P0
// overdue page, re-arming — is pinned separately in timer_test.go. Shared test
// scaffolding (fakeStore, fakeBus, fakeFanout, pending, hasChannel) lives in
// claim_test.go; the movable clock and rig below are shared with timer_test.go.
// ═══════════════════════════════════════════════════════════════════════════════
package escalation

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/kavach/backend/internal/incident"
	"github.com/kavach/backend/internal/notify"
	"github.com/kavach/backend/internal/store"
)

// l1EntryMs is the moment the ladder starts in every test in this file. Rungs are
// asserted as absolute offsets from it, because §2.6.2 states the ladder in
// absolute time from the blast and a responder reading the timeline needs those
// numbers to mean what the policy document says.
const l1EntryMs = int64(1_700_000_000_000)

// ── a clock you can move ─────────────────────────────────────────────────────

type testClock struct {
	mu sync.Mutex
	ms int64
}

func newTestClock(ms int64) *testClock { return &testClock{ms: ms} }

func (c *testClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return time.UnixMilli(c.ms).UTC()
}

func (c *testClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.ms += d.Milliseconds()
}

func (c *testClock) ms64() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ms
}

// ── rig ──────────────────────────────────────────────────────────────────────

func rigWith(t *testing.T, inc store.Incident, cfg Config, fan Fanouter) (*Engine, *fakeStore, *fakeBus, *testClock) {
	t.Helper()
	st := newFakeStore(inc)
	bus := &fakeBus{}
	clk := newTestClock(l1EntryMs)
	seq := 0
	e, err := New(Deps{
		Store: st, Bus: bus, Notify: fan,
		Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Now: clk.Now,
		NewID: func() string {
			seq++
			return fmt.Sprintf("tm-%d", seq)
		},
		Config: cfg,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return e, st, bus, clk
}

func rig(t *testing.T, inc store.Incident, cfg Config) (*Engine, *fakeStore, *fakeBus, *fakeFanout, *testClock) {
	t.Helper()
	fan := &fakeFanout{}
	e, st, bus, clk := rigWith(t, inc, cfg, fan)
	return e, st, bus, fan, clk
}

// atState is the incident every test starts from: one family, one subject, a
// manual trigger, opened at the ladder's zero.
func atState(s incident.State) store.Incident {
	return store.Incident{
		ID: "inc-1", FamilyID: famID, SubjectMemberID: subjID,
		State: s, Trigger: "MANUAL", PolicyVersion: 3,
		OpenedAt: l1EntryMs,
	}
}

// fire executes one rung directly, the way the worker would once it holds the
// claim. The claim itself is timer_test.go's subject.
func fire(t *testing.T, e *Engine, action string) error {
	t.Helper()
	return e.execute(context.Background(), store.Timer{
		ID: "fired-" + action, FamilyID: famID, IncidentID: "inc-1",
		Action: action, State: TimerPending, FireAt: e.now().UnixMilli(),
	})
}

// offsetS reports a timer's fire time as whole seconds after an anchor.
func offsetS(tm store.Timer, anchorMs int64) int { return int((tm.FireAt - anchorMs) / 1000) }

func sameChannels(got []notify.Channel, want ...notify.Channel) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

func onlyStep(t *testing.T, fan *fakeFanout) notify.Step {
	t.Helper()
	steps := fan.recorded()
	if len(steps) != 1 {
		t.Fatalf("fan-out steps = %d, want exactly 1", len(steps))
	}
	return steps[0]
}

func eventWithType(st *fakeStore, kind string) (store.Event, bool) {
	for _, ev := range st.Events("inc-1") {
		if ev.EventType == kind {
			return ev, true
		}
	}
	return store.Event{}, false
}

// ── the ladder's timing is the machine's timing ──────────────────────────────

// ★ §2.5.5 ★ Divergence between spec/state-machine.yaml and the server's idea of
// the ladder is the one class of bug this codebase cannot afford: the phone
// escalates on the cached YAML and the server escalates on whatever it compiled.
// afterSFor exists to stop that, and this test is what proves it is still wired —
// a hardcoded 90 here would pass every other test in the file.
func TestLadderTimingIsReadFromTheGeneratedMachineNotFromConstantsHere(t *testing.T) {
	cases := []struct {
		name string
		from incident.State
		on   incident.Event
		got  int
	}{
		{"L2", incident.StateActiveL1, incident.EventNoAck, L2AfterS()},
		{"L3", incident.StateActiveL2, incident.EventNoAck, L3AfterS()},
		{"watchdog", incident.StateOwned, incident.EventProgressWatchdog, WatchdogAfterS()},
		{"auto-quiesce", incident.StateActiveL1, incident.EventAutoQuiesce, AutoQuiesceAfterS()},
	}
	for _, c := range cases {
		want := 0
		for _, tr := range incident.Transitions {
			if tr.From == c.from && tr.On == c.on && tr.AfterS > 0 {
				want = tr.AfterS
				break
			}
		}
		if want == 0 {
			t.Fatalf("%s: no %s→%s transition with afterS in the generated machine", c.name, c.from, c.on)
		}
		if c.got != want {
			t.Errorf("%s = %ds, but the machine says %ds — the server and the phone "+
				"would escalate on different schedules", c.name, c.got, want)
		}
	}
	// The two extra notification rungs are local constants on purpose: they have
	// no state transition of their own, so the machine has nothing to say about
	// them. Pin the published numbers anyway (§2.6.2).
	if RepeatL1AfterS != 30 || SMSTierAfterS != 60 {
		t.Fatalf("repeat=%ds sms=%ds, want 30s and 60s", RepeatL1AfterS, SMSTierAfterS)
	}
}

// Ladder() is what devices cache so an offline phone escalates on the same
// schedule the server would have used. If the published shape and the armed
// timers disagree, the two planes silently diverge at the worst moment.
func TestPublishedLadderMatchesTheTimersTheServerActuallyArms(t *testing.T) {
	inc := atState(incident.StateActiveL1)
	e, st, _, _, _ := rig(t, inc, Config{})
	e.armLadder(inc, time.UnixMilli(l1EntryMs))

	published := Ladder()
	if len(published) != 5 {
		t.Fatalf("published ladder has %d rungs, want 5", len(published))
	}
	wantShape := []struct {
		atS      int
		tier     int
		channels []string
	}{
		{0, 1, []string{"ws", "fcm", "apns", "pushkit"}},
		{30, 1, []string{"ws", "fcm", "apns", "pushkit"}},
		{60, 1, []string{"sms"}},
		{90, 2, []string{"ws", "fcm", "apns", "pushkit", "voice"}},
		{180, 3, []string{"ws", "fcm", "apns", "pushkit", "sms", "voice"}},
	}
	for i, w := range wantShape {
		got := published[i]
		if got.AtS != w.atS || got.Tier != w.tier {
			t.Errorf("rung %d = T+%ds tier %d, want T+%ds tier %d", i, got.AtS, got.Tier, w.atS, w.tier)
		}
		if len(got.Channels) != len(w.channels) {
			t.Errorf("rung %d channels = %v, want %v", i, got.Channels, w.channels)
			continue
		}
		for j := range w.channels {
			if got.Channels[j] != w.channels[j] {
				t.Errorf("rung %d channels = %v, want %v", i, got.Channels, w.channels)
				break
			}
		}
	}

	armed := pending(st, "inc-1")
	for action, atS := range map[string]int{
		ActionRepeatL1:   published[1].AtS,
		ActionSMSTier:    published[2].AtS,
		ActionEscalateL2: published[3].AtS,
		ActionEscalateL3: published[4].AtS,
	} {
		tm, ok := armed[action]
		if !ok {
			t.Fatalf("%s was never armed", action)
		}
		if got := offsetS(tm, l1EntryMs); got != atS {
			t.Errorf("★ the phone was told %s fires at T+%ds; the server armed it at T+%ds",
				action, atS, got)
		}
	}
}

// L3 is anchored at L1 entry, not at L2 entry — T+180 absolute from the blast,
// which is only 90 s after L2. Anchoring it at L2 would silently double the wait
// for the tier that calls 112.
func TestL3IsAnchoredAtL1EntryNotAtL2Entry(t *testing.T) {
	inc := atState(incident.StateActiveL1)
	e, st, _, _, _ := rig(t, inc, Config{})
	e.armLadder(inc, time.UnixMilli(l1EntryMs))

	armed := pending(st, "inc-1")
	l2, l3 := armed[ActionEscalateL2], armed[ActionEscalateL3]
	if offsetS(l3, l1EntryMs) != L3AfterS() {
		t.Fatalf("L3 at T+%ds, want T+%ds from L1 entry", offsetS(l3, l1EntryMs), L3AfterS())
	}
	if gap := offsetS(l3, l2.FireAt); gap != L3AfterS()-L2AfterS() {
		t.Fatalf("L3 fires %ds after L2, want %ds", gap, L3AfterS()-L2AfterS())
	}
}

// ── arming ───────────────────────────────────────────────────────────────────

// ★ F-02 ★ Every incident gets a death date at birth. An incident that is never
// resolved otherwise freezes deploys and keeps timers armed against a phone that
// stopped caring hours ago.
func TestOnIncidentOpenGivesEveryIncidentADeathDateAndACancelWindow(t *testing.T) {
	e, st, _, fan, clk := rig(t, atState(incident.StatePending), Config{})

	inc, err := e.OnIncidentOpen(context.Background(), atState(incident.StatePending))
	if err != nil {
		t.Fatalf("OnIncidentOpen: %v", err)
	}

	wantQuiesce := clk.ms64() + int64(AutoQuiesceAfterS())*1000
	if inc.AutoQuiesceAt != wantQuiesce {
		t.Fatalf("autoQuiesceAt = %d, want %d", inc.AutoQuiesceAt, wantQuiesce)
	}
	stored, _ := st.Incident("inc-1")
	if stored.AutoQuiesceAt != wantQuiesce {
		t.Fatalf("★ F-02 ★ the death date was not persisted: %+v", stored)
	}

	armed := pending(st, "inc-1")
	if len(armed) != 2 {
		t.Fatalf("armed %v, want exactly AUTO_QUIESCE and CANCEL_WINDOW", keysOf(armed))
	}
	if armed[ActionAutoQuiesce].FireAt != wantQuiesce {
		t.Errorf("auto-quiesce timer at %d, want %d", armed[ActionAutoQuiesce].FireAt, wantQuiesce)
	}
	if got := offsetS(armed[ActionCancelWindow], clk.ms64()); got != 20 {
		t.Errorf("MANUAL cancel window armed at T+%ds, want 20s (§2.5.6)", got)
	}
	// ≤20 ms on the control-plane request path (§2.6.1): OnIncidentOpen writes
	// rows and returns, it never waits on a notification.
	if len(fan.recorded()) != 0 {
		t.Fatal("OnIncidentOpen notified from inside the cancel window — the subject can still cancel")
	}
}

// §2.5.6. The device runs its own copy of this table from policy_cache so T0
// works with no network; the server arms it too, because the device may be
// underwater. Both must read the same numbers.
func TestCancelWindowIsPerTriggerAndAnUnknownTriggerFallsBackToTwenty(t *testing.T) {
	e, _, _, _, _ := rig(t, atState(incident.StatePending), Config{})

	for trigger, want := range map[string]int{
		"MANUAL":          20,
		"CRASH":           20,
		"FALL":            45,
		"NO_MOTION":       45,
		"SENSOR_HOME":     60,
		"GEOFENCE":        300,
		"DEADMAN":         900,
		"DEVICE_SILENCED": 0,
		"BLE_FOB":         10,
		"VOICE_PHRASE":    10,
		"RELAY":           0,
		"DRILL":           0,
		// A trigger this build has never heard of still gets a window rather
		// than an instant blast — fail-safe, not fail-fast.
		"TRIGGER_FROM_A_NEWER_APP": 20,
	} {
		if got := e.CancelWindow(trigger); got != want {
			t.Errorf("cancel window for %s = %ds, want %ds", trigger, got, want)
		}
	}

	if got := len(KnownTriggers()); got != 12 {
		t.Errorf("KnownTriggers() = %d entries, want the 12 in the §2.5.6 table", got)
	}
	for i, tr := range KnownTriggers() {
		if i > 0 && KnownTriggers()[i-1] > tr {
			t.Fatalf("KnownTriggers() is not sorted: %v", KnownTriggers())
		}
	}

	over, _, _, _, _ := rig(t, atState(incident.StatePending), Config{
		CancelWindowS: map[string]int{"FALL": 5},
	})
	if got := over.CancelWindow("FALL"); got != 5 {
		t.Errorf("configured override for FALL = %ds, want 5s", got)
	}
	if got := over.CancelWindow("GEOFENCE"); got != 300 {
		t.Errorf("an override for one trigger changed another: GEOFENCE = %ds", got)
	}
}

func TestOnIncidentOpenAtProbeArmsTheProbeTimeoutAndNoLadder(t *testing.T) {
	e, st, _, fan, clk := rig(t, atState(incident.StateProbe), Config{})

	if _, err := e.OnIncidentOpen(context.Background(), atState(incident.StateProbe)); err != nil {
		t.Fatalf("OnIncidentOpen: %v", err)
	}

	armed := pending(st, "inc-1")
	if len(armed) != 2 {
		t.Fatalf("armed %v, want AUTO_QUIESCE and PROBE_TIMEOUT only", keysOf(armed))
	}
	want := afterSFor(incident.StateProbe, incident.EventProbeTimeout, 45)
	if got := offsetS(armed[ActionProbeTimeout], clk.ms64()); got != want {
		t.Errorf("probe timeout at T+%ds, want T+%ds", got, want)
	}
	// ★ P-002 ★ PROBE is the cheapest possible intervention. Asking "are you
	// okay?" must not wake the family.
	if len(fan.recorded()) != 0 {
		t.Fatal("PROBE notified the family before anyone was asked anything")
	}
}

// The device's own cancel window already expired offline, so the ladder starts
// now and the simultaneous blast goes out at T+0 (§2.6.2).
func TestOnIncidentOpenAlreadyAtL1ArmsTheWholeLadderAndBlastsImmediately(t *testing.T) {
	e, st, _, fan, clk := rig(t, atState(incident.StateActiveL1), Config{})

	if _, err := e.OnIncidentOpen(context.Background(), atState(incident.StateActiveL1)); err != nil {
		t.Fatalf("OnIncidentOpen: %v", err)
	}

	armed := pending(st, "inc-1")
	for action, atS := range map[string]int{
		ActionRepeatL1:   RepeatL1AfterS,
		ActionSMSTier:    SMSTierAfterS,
		ActionEscalateL2: L2AfterS(),
		ActionEscalateL3: L3AfterS(),
	} {
		tm, ok := armed[action]
		if !ok {
			t.Fatalf("%s was not armed; the ladder would stop after the blast", action)
		}
		if got := offsetS(tm, clk.ms64()); got != atS {
			t.Errorf("%s at T+%ds, want T+%ds", action, got, atS)
		}
	}
	if _, ok := armed[ActionAutoQuiesce]; !ok {
		t.Error("★ F-02 ★ no auto-quiesce backstop")
	}

	step := onlyStep(t, fan)
	if step.Tier != 1 || step.Label != "L1" {
		t.Fatalf("blast = tier %d %q, want tier 1 \"L1\"", step.Tier, step.Label)
	}
	// Simultaneous, not sequential: the socket and all three push transports go
	// out together, because whichever one is alive is the one that matters.
	if !sameChannels(step.Channels, notify.ChannelWS, notify.ChannelFCM, notify.ChannelAPNs, notify.ChannelPushKit) {
		t.Fatalf("blast channels = %v, want ws+fcm+apns+pushkit", step.Channels)
	}
}

// A duress alarm is loud on every phone except the subject's own. The silent
// state changes who hears it, never whether the ladder runs.
func TestL1SilentRunsTheIdenticalLadderAndIsLabelledSilent(t *testing.T) {
	e, st, _, fan, clk := rig(t, atState(incident.StateActiveL1Silent), Config{})

	if _, err := e.OnIncidentOpen(context.Background(), atState(incident.StateActiveL1Silent)); err != nil {
		t.Fatalf("OnIncidentOpen: %v", err)
	}

	armed := pending(st, "inc-1")
	for _, action := range []string{ActionRepeatL1, ActionSMSTier, ActionEscalateL2, ActionEscalateL3} {
		if _, ok := armed[action]; !ok {
			t.Fatalf("★ a duress incident skipped %s — the silent path must climb like any other", action)
		}
	}
	if got := offsetS(armed[ActionEscalateL2], clk.ms64()); got != L2AfterS() {
		t.Errorf("silent L2 at T+%ds, want T+%ds", got, L2AfterS())
	}

	step := onlyStep(t, fan)
	if step.Label != "L1-silent" {
		t.Fatalf("label = %q, want \"L1-silent\"", step.Label)
	}
	if step.Tier != 1 {
		t.Fatalf("tier = %d, want 1", step.Tier)
	}
	if !sameChannels(step.Channels, notify.ChannelWS, notify.ChannelFCM, notify.ChannelAPNs, notify.ChannelPushKit) {
		t.Fatalf("silent blast channels = %v, want the same four as a loud one", step.Channels)
	}
}

func TestBlastL1DoesNothingFromAStateThatIsNotL1(t *testing.T) {
	inc := atState(incident.StateOwned)
	e, _, _, fan, _ := rig(t, inc, Config{})

	if err := e.BlastL1(context.Background(), inc); err != nil {
		t.Fatalf("BlastL1: %v", err)
	}
	if len(fan.recorded()) != 0 {
		t.Fatal("an L1 blast went out for an incident somebody already owns")
	}
}

// ── the rungs ────────────────────────────────────────────────────────────────

// The cancel window expiring is the hinge of the whole system: it is where a
// silent countdown becomes an emergency.
func TestCancelWindowExpiryStartsTheLadderAndBlastsL1(t *testing.T) {
	e, st, bus, fan, clk := rig(t, atState(incident.StatePending), Config{})
	if _, err := e.OnIncidentOpen(context.Background(), atState(incident.StatePending)); err != nil {
		t.Fatalf("OnIncidentOpen: %v", err)
	}
	clk.advance(20 * time.Second)

	if err := fire(t, e, ActionCancelWindow); err != nil {
		t.Fatalf("cancel-window rung: %v", err)
	}

	stored, _ := st.Incident("inc-1")
	if stored.State != incident.StateActiveL1 {
		t.Fatalf("state = %s, want ACTIVE_L1", stored.State)
	}
	armed := pending(st, "inc-1")
	for _, action := range []string{ActionRepeatL1, ActionSMSTier, ActionEscalateL2, ActionEscalateL3} {
		if _, ok := armed[action]; !ok {
			t.Fatalf("%s was not armed when the window expired", action)
		}
	}
	if got := offsetS(armed[ActionEscalateL2], clk.ms64()); got != L2AfterS() {
		t.Errorf("★ the ladder is anchored at L1 entry, not at open: L2 at T+%ds after expiry, want T+%ds",
			got, L2AfterS())
	}
	if step := onlyStep(t, fan); step.Label != "L1" {
		t.Fatalf("fan-out label = %q, want \"L1\"", step.Label)
	}
	if len(bus.typed(famID, "incident.state_changed")) != 1 {
		t.Fatal("the transition was not published on the family stream")
	}
	// The rung that fired is server-sourced, and the after-action report says so.
	ev, ok := eventWithType(st, string(incident.EventCancelWindowExpired))
	if !ok {
		t.Fatal("no CANCEL_WINDOW_EXPIRED row in the append-only log")
	}
	if ev.Detail["source"] != "server_timer" {
		t.Errorf("detail source = %v, want server_timer", ev.Detail["source"])
	}
	if ev.PolicyVersion != 3 {
		t.Errorf("★ P-069 ★ event policyVersion = %d, want the incident's 3", ev.PolicyVersion)
	}
}

// The 30 s re-blast is an extra notification on the same state — humans
// genuinely miss the first push (§2.6.2). It must not move the machine.
func TestRepeatL1IsALouderRungAndNotATransition(t *testing.T) {
	e, st, _, fan, _ := rig(t, atState(incident.StateActiveL1), Config{})

	if err := fire(t, e, ActionRepeatL1); err != nil {
		t.Fatalf("repeat rung: %v", err)
	}

	stored, _ := st.Incident("inc-1")
	if stored.State != incident.StateActiveL1 {
		t.Fatalf("state = %s, want ACTIVE_L1 — a repeat is not an escalation", stored.State)
	}
	step := onlyStep(t, fan)
	if !step.Repeat {
		t.Error("step.Repeat = false; the device cannot tell the re-blast from the first one")
	}
	if step.Tier != 1 {
		t.Errorf("tier = %d, want 1", step.Tier)
	}
	if hasChannel(step.Channels, notify.ChannelSMS) || hasChannel(step.Channels, notify.ChannelVoice) {
		t.Errorf("the 30 s repeat was billed to SMS/voice: %v", step.Channels)
	}
	if _, ok := eventWithType(st, "NOTIFY_repeat-L1"); !ok {
		t.Error("the repeat rung left no row in the notification matrix")
	}
}

// The SMS rung is independent of both our infrastructure and Google's/Apple's,
// which is the whole reason it exists.
func TestSMSTierGoesOutOverSMSAlone(t *testing.T) {
	e, _, _, fan, _ := rig(t, atState(incident.StateActiveL1), Config{})

	if err := fire(t, e, ActionSMSTier); err != nil {
		t.Fatalf("sms rung: %v", err)
	}

	step := onlyStep(t, fan)
	if !sameChannels(step.Channels, notify.ChannelSMS) {
		t.Fatalf("channels = %v, want sms only", step.Channels)
	}
	if step.Tier != 1 {
		t.Errorf("tier = %d, want 1 — the SMS rung is a retry of L1, not an escalation", step.Tier)
	}
}

// A billable rung must not fire once the question it asks has been answered.
func TestSMSTierIsSkippedWhileStillPendingAndOnceSomebodyOwnsIt(t *testing.T) {
	for _, state := range []incident.State{incident.StatePending, incident.StateOwned} {
		t.Run(string(state), func(t *testing.T) {
			e, st, _, fan, _ := rig(t, atState(state), Config{})

			if err := fire(t, e, ActionSMSTier); err != nil {
				t.Fatalf("sms rung from %s: %v", state, err)
			}

			if len(fan.recorded()) != 0 {
				t.Fatalf("★ an SMS was billed from %s", state)
			}
			if stored, _ := st.Incident("inc-1"); stored.State != state {
				t.Fatalf("state moved to %s", stored.State)
			}
		})
	}
}

func TestEscalateL2MovesTheStateAndAddsVoice(t *testing.T) {
	for _, from := range []incident.State{incident.StateActiveL1, incident.StateActiveL1Silent} {
		t.Run(string(from), func(t *testing.T) {
			e, st, _, fan, _ := rig(t, atState(from), Config{})

			if err := fire(t, e, ActionEscalateL2); err != nil {
				t.Fatalf("L2 rung: %v", err)
			}

			stored, _ := st.Incident("inc-1")
			if stored.State != incident.StateActiveL2 {
				t.Fatalf("state = %s, want ACTIVE_L2", stored.State)
			}
			step := onlyStep(t, fan)
			if step.Tier != 2 || step.Label != "L2" {
				t.Fatalf("step = tier %d %q, want tier 2 \"L2\"", step.Tier, step.Label)
			}
			if !hasChannel(step.Channels, notify.ChannelVoice) {
				t.Errorf("L2 has no voice leg: %v", step.Channels)
			}
			if hasChannel(step.Channels, notify.ChannelSMS) {
				t.Errorf("L2 sent SMS; the SMS rung already ran at T+%ds: %v", SMSTierAfterS, step.Channels)
			}
		})
	}
}

func TestEscalateL3IsEveryChannelAtTierThree(t *testing.T) {
	e, st, _, fan, _ := rig(t, atState(incident.StateActiveL2), Config{})

	if err := fire(t, e, ActionEscalateL3); err != nil {
		t.Fatalf("L3 rung: %v", err)
	}

	stored, _ := st.Incident("inc-1")
	if stored.State != incident.StateActiveL3 {
		t.Fatalf("state = %s, want ACTIVE_L3", stored.State)
	}
	step := onlyStep(t, fan)
	if step.Tier != 3 {
		t.Fatalf("tier = %d, want 3", step.Tier)
	}
	if !sameChannels(step.Channels,
		notify.ChannelWS, notify.ChannelFCM, notify.ChannelAPNs,
		notify.ChannelPushKit, notify.ChannelSMS, notify.ChannelVoice) {
		t.Fatalf("L3 channels = %v, want every transport", step.Channels)
	}
}

// ★ The safety property the whole ladder rests on. ★ CLAIM cancels the pending
// rungs, but a worker may already be holding a claimed L2 timer at that instant.
// The state guard is the second line of defence, and without it "Rohan is
// responding" is followed thirty seconds later by a tier-2 siren.
func TestARungWhoseStateHasMovedOnIsASilentNoOp(t *testing.T) {
	cases := []struct {
		action string
		state  incident.State
	}{
		{ActionEscalateL2, incident.StateOwned},
		{ActionEscalateL2, incident.StateActiveL2},
		{ActionEscalateL3, incident.StateActiveL1},
		{ActionRepeatL1, incident.StateActiveL2},
		{ActionCancelWindow, incident.StateActiveL1},
		{ActionProbeTimeout, incident.StatePending},
		{ActionWatchdog, incident.StateActiveL2},
	}
	for _, c := range cases {
		t.Run(c.action+"/"+string(c.state), func(t *testing.T) {
			e, st, bus, fan, _ := rig(t, atState(c.state), Config{})

			if err := fire(t, e, c.action); err != nil {
				t.Fatalf("%s from %s returned an error: %v — a stale rung must be a "+
					"no-op, not a failure that re-arms itself", c.action, c.state, err)
			}

			if stored, _ := st.Incident("inc-1"); stored.State != c.state {
				t.Fatalf("state moved from %s to %s", c.state, stored.State)
			}
			if len(fan.recorded()) != 0 {
				t.Fatalf("★ a stale %s rung woke the family from %s", c.action, c.state)
			}
			if len(st.eventTypes()) != 0 {
				t.Fatalf("a stale rung wrote %v to the append-only log", st.eventTypes())
			}
			if len(bus.typed(famID, "incident.state_changed")) != 0 {
				t.Fatal("a stale rung published a state change")
			}
		})
	}
}

func TestProbeTimeoutEscalatesProbeToPending(t *testing.T) {
	e, st, _, fan, _ := rig(t, atState(incident.StateProbe), Config{})

	if err := fire(t, e, ActionProbeTimeout); err != nil {
		t.Fatalf("probe rung: %v", err)
	}

	stored, _ := st.Incident("inc-1")
	if stored.State != incident.StatePending {
		t.Fatalf("state = %s, want PENDING — an unanswered probe must not stop here", stored.State)
	}
	// PENDING starts the cancel window on the device; the server does not blast
	// from this rung.
	if len(fan.recorded()) != 0 {
		t.Fatal("the probe timeout notified the family directly, skipping the cancel window")
	}
}

// The incident finished (or was merged, F-09) while this timer sat in the queue.
func TestATerminalOrMergedIncidentCancelsTheRestOfItsLadder(t *testing.T) {
	cases := []struct {
		name     string
		state    incident.State
		mergedTo string
	}{
		{"resolved", incident.StateResolved, ""},
		{"false alarm", incident.StateFalseAlarm, ""},
		{"dormant", incident.StateDormant, ""},
		{"merged into another incident", incident.StateActiveL1, "inc-parent"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			inc := atState(c.state)
			inc.MergedIntoID = c.mergedTo
			e, st, _, fan, _ := rig(t, inc, Config{})
			e.armLadder(inc, time.UnixMilli(l1EntryMs))
			e.arm(inc, ActionAutoQuiesce, 0, l1EntryMs+int64(AutoQuiesceAfterS())*1000)

			if err := fire(t, e, ActionEscalateL2); err != nil {
				t.Fatalf("rung on a finished incident: %v", err)
			}

			if live := pending(st, "inc-1"); len(live) != 0 {
				t.Fatalf("★ %v are still armed against a finished incident", keysOf(live))
			}
			if len(fan.recorded()) != 0 {
				t.Fatal("a finished incident woke the family")
			}
		})
	}
}

// ★ F-02 ★ Six hours in, this is not an emergency any more; it is a stuck row.
func TestAutoQuiesceEndsAForgottenIncidentAndDisarmsEverything(t *testing.T) {
	inc := atState(incident.StateActiveL1)
	e, st, bus, fan, clk := rig(t, inc, Config{})
	e.armLadder(inc, time.UnixMilli(l1EntryMs))
	clk.advance(time.Duration(AutoQuiesceAfterS()) * time.Second)

	if err := fire(t, e, ActionAutoQuiesce); err != nil {
		t.Fatalf("auto-quiesce rung: %v", err)
	}

	stored, _ := st.Incident("inc-1")
	if stored.State != incident.StateDormant {
		t.Fatalf("state = %s, want DORMANT", stored.State)
	}
	if stored.ResolvedAt != clk.ms64() {
		t.Errorf("resolvedAt = %d, want the quiesce time %d", stored.ResolvedAt, clk.ms64())
	}
	if live := pending(st, "inc-1"); len(live) != 0 {
		t.Fatalf("★ %v survived auto-quiesce and would fire against a dead incident", keysOf(live))
	}
	if len(fan.recorded()) != 0 {
		t.Fatal("auto-quiesce woke the family to announce that nothing is happening")
	}
	// The family sees the banner in the timeline, not a silent disappearance.
	ev, ok := eventWithType(st, string(incident.EventAutoQuiesce))
	if !ok {
		t.Fatal("no AUTO_QUIESCE row in the append-only log")
	}
	if ev.Detail["banner"] != "This incident was closed automatically after 6 hours." {
		t.Errorf("banner = %v", ev.Detail["banner"])
	}
	if len(bus.typed(famID, "incident.state_changed")) != 1 {
		t.Error("the quiesce was not published on the family stream")
	}
}

// ★ P-030 ★ One person claims, gets stuck in traffic, and everybody else has
// stood down permanently. The watchdog is the only path back out of that.
func TestTheProgressWatchdogTakesOwnershipBackAndRearmsL3(t *testing.T) {
	inc := atState(incident.StateOwned)
	inc.OwnerMemberID = ownerID
	e, st, _, fan, clk := rig(t, inc, Config{})
	clk.advance(time.Duration(WatchdogAfterS()) * time.Second)

	if err := fire(t, e, ActionWatchdog); err != nil {
		t.Fatalf("watchdog rung: %v", err)
	}

	stored, _ := st.Incident("inc-1")
	if stored.State != incident.StateActiveL2 {
		t.Fatalf("state = %s, want ACTIVE_L2", stored.State)
	}
	if stored.OwnerMemberID != "" {
		t.Fatalf("owner = %q, want cleared — the incident is unowned again", stored.OwnerMemberID)
	}
	l3, ok := pending(st, "inc-1")[ActionEscalateL3]
	if !ok {
		t.Fatal("L3 was not re-armed; a reclaimed incident would sit at L2 forever")
	}
	if got := offsetS(l3, clk.ms64()); got != L3AfterS() {
		t.Errorf("re-armed L3 at T+%ds, want T+%ds from the reclaim", got, L3AfterS())
	}

	step := onlyStep(t, fan)
	if step.Tier != 2 || step.Label != "reclaimed-watchdog" {
		t.Fatalf("step = tier %d %q, want tier 2 \"reclaimed-watchdog\"", step.Tier, step.Label)
	}
	if hasChannel(step.Channels, notify.ChannelSMS) || hasChannel(step.Channels, notify.ChannelVoice) {
		t.Errorf("the reclaim was billed to SMS/voice: %v", step.Channels)
	}
	// Who dropped it is in the log, because the after-action report has to be
	// able to answer "who had this and for how long".
	ev, ok := eventWithType(st, string(incident.EventProgressWatchdog))
	if !ok {
		t.Fatal("no PROGRESS_WATCHDOG row in the append-only log")
	}
	if ev.Detail["previousOwner"] != ownerID {
		t.Errorf("previousOwner = %v, want %q", ev.Detail["previousOwner"], ownerID)
	}
}

// An unknown action is the one case that must fail loudly: it means a timer row
// was written by a build that knows something this one does not.
func TestAnUnknownTimerActionIsAnError(t *testing.T) {
	e, _, _, fan, _ := rig(t, atState(incident.StateActiveL1), Config{})

	if err := fire(t, e, "ESCALATE_L4"); err == nil {
		t.Fatal("an unknown timer action was silently ignored")
	}
	if len(fan.recorded()) != 0 {
		t.Fatal("an unknown action still notified somebody")
	}
}

func TestARungForAnIncidentThatDoesNotExistIsAnError(t *testing.T) {
	e, _, _, _, _ := rig(t, atState(incident.StateActiveL1), Config{})

	err := e.execute(context.Background(), store.Timer{
		ID: "ghost", FamilyID: famID, IncidentID: "inc-does-not-exist",
		Action: ActionEscalateL2, State: TimerPending,
	})
	if err != ErrIncidentNotFound {
		t.Fatalf("err = %v, want ErrIncidentNotFound", err)
	}
}

// ── t3 ───────────────────────────────────────────────────────────────────────

// stampingFanout reports a different FirstNotifiedAt on every rung, so "recorded
// once, on the first rung that reached somebody" is distinguishable from
// "overwritten by the latest rung".
type stampingFanout struct {
	mu    sync.Mutex
	calls int
}

func (f *stampingFanout) Fanout(_ context.Context, _ store.Incident, _ notify.Step) (notify.Result, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	return notify.Result{
		NotificationID:  "note",
		Audience:        []string{"dev-guardian"},
		FirstNotifiedAt: l1EntryMs + int64(f.calls)*1000,
	}, nil
}

// t3 is one of the four clocks the family reads after an incident. "First
// notified" means first, not latest.
func TestFirstNotifiedAtIsStampedByTheFirstRungAndNeverOverwritten(t *testing.T) {
	fan := &stampingFanout{}
	e, st, _, _ := rigWith(t, atState(incident.StateActiveL1), Config{}, fan)

	if err := fire(t, e, ActionRepeatL1); err != nil {
		t.Fatalf("first rung: %v", err)
	}
	first, _ := st.Incident("inc-1")
	if first.FirstNotifiedAt != l1EntryMs+1000 {
		t.Fatalf("firstNotifiedAt = %d, want %d", first.FirstNotifiedAt, l1EntryMs+1000)
	}

	if err := fire(t, e, ActionRepeatL1); err != nil {
		t.Fatalf("second rung: %v", err)
	}
	second, _ := st.Incident("inc-1")
	if second.FirstNotifiedAt != l1EntryMs+1000 {
		t.Fatalf("★ t3 was overwritten by a later rung: %d, want %d",
			second.FirstNotifiedAt, l1EntryMs+1000)
	}
}

// ── the one gap the characterization above found ─────────────────────────────

// ★ The SMS rung's guard skips PENDING and OWNED — and RESOLVING slips through. ★
// RESOLVING means the owner has physically arrived and only the second party's
// confirmation is outstanding: further along than OWNED, which the guard does
// cover. The window is narrow — ON_SCENE cancels the pending ladder, so the rung
// must already have been claimed when the owner arrived — and it is exactly the
// window a state guard exists for, because cancelTimers only touches rows still
// marked pending and a timer a worker is already holding is not one of them.
//
// The cost is the one claim_test.go already refuses for the claim broadcast: a
// billable A2P message spent escalating an incident somebody is standing over,
// out of a per-family budget that has to still be there for the next incident
// (1.49 · DefaultSMSCeiling).
func TestAnInFlightSMSRungIsNotBilledOnceTheOwnerIsOnScene(t *testing.T) {
	e, st, _, fan, _ := rig(t, atState(incident.StateResolving), Config{})

	if err := fire(t, e, ActionSMSTier); err != nil {
		t.Fatalf("sms rung from RESOLVING: %v", err)
	}

	if len(fan.recorded()) != 0 {
		t.Fatal("★ an SMS was billed while the owner was already standing over the subject")
	}
	if stored, _ := st.Incident("inc-1"); stored.State != incident.StateResolving {
		t.Fatalf("state moved to %s", stored.State)
	}
}

func keysOf(m map[string]store.Timer) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
