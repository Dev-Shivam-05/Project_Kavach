// ═══════════════════════════════════════════════════════════════════════════════
// CHARACTERIZATION + W10-d — responsibility transfer over BOTH channels (1.32)
//
// internal/escalation decides whether a human is woken and had ZERO direct tests
// (RISK.md §4). CLAIM is the transition the whole coordination design turns on:
// §2.6.4 calls it the conversion of "somebody should do something" into "Rohan is
// responding", and P-030 correction 1 says the other phones go siren → persistent
// quiet banner, never silence.
//
// ★ THE GAP THIS FILE OPENS AND CLOSES ★
// docs/02 §2.6.4: "Fan-out of CLAIM goes over BOTH channels simultaneously —
// WebSocket AND FCM/APNs data. Never rely on only one; a backgrounded device may
// have no WS." Claim() published to the bus and stopped there. So the one family
// member whose app was closed — the exact person the push transport exists for —
// kept hearing the siren for an incident somebody was already driving to, and had
// no way to learn otherwise until they opened the app.
//
// Everything above the "W10-d" divider pins behaviour that predates this session
// and must survive it. Everything below states the new requirement.
// ═══════════════════════════════════════════════════════════════════════════════
package escalation

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/kavach/backend/internal/incident"
	"github.com/kavach/backend/internal/notify"
	"github.com/kavach/backend/internal/store"
)

// ── fakes ────────────────────────────────────────────────────────────────────

type fakeStore struct {
	mu        sync.Mutex
	incidents map[string]store.Incident
	events    []store.Event
	timers    []store.Timer
}

func newFakeStore(inc store.Incident) *fakeStore {
	return &fakeStore{incidents: map[string]store.Incident{inc.ID: inc}}
}

func (f *fakeStore) Incident(id string) (store.Incident, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	inc, ok := f.incidents[id]
	return inc, ok
}

func (f *fakeStore) PutIncident(inc store.Incident) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.incidents[inc.ID] = inc
	return nil
}

func (f *fakeStore) AppendEvent(e store.Event) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.events = append(f.events, e)
	return nil
}

func (f *fakeStore) Events(incidentID string) []store.Event {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []store.Event
	for _, e := range f.events {
		if e.IncidentID == incidentID {
			out = append(out, e)
		}
	}
	return out
}

func (f *fakeStore) Timers() []store.Timer {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]store.Timer{}, f.timers...)
}

func (f *fakeStore) TimersForIncident(incidentID string) []store.Timer {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []store.Timer
	for _, t := range f.timers {
		if t.IncidentID == incidentID {
			out = append(out, t)
		}
	}
	return out
}

func (f *fakeStore) PutTimer(t store.Timer) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i, existing := range f.timers {
		if existing.ID == t.ID {
			f.timers[i] = t
			return nil
		}
	}
	f.timers = append(f.timers, t)
	return nil
}

// eventTypes lists the appended event log in order, which is the record every
// after-action report is folded from.
func (f *fakeStore) eventTypes() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, 0, len(f.events))
	for _, e := range f.events {
		out = append(out, e.EventType)
	}
	return out
}

type publishedFrame struct {
	subject string
	frame   notify.Frame
}

type fakeBus struct {
	mu     sync.Mutex
	frames []publishedFrame
}

func (b *fakeBus) Publish(subject string, data []byte) error {
	var f notify.Frame
	if err := json.Unmarshal(data, &f); err != nil {
		return err
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.frames = append(b.frames, publishedFrame{subject: subject, frame: f})
	return nil
}

// typed returns every frame of one type published to the family stream.
func (b *fakeBus) typed(familyID, kind string) []notify.Frame {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []notify.Frame
	for _, p := range b.frames {
		if p.subject == notify.StreamSubject(familyID) && p.frame.Type == kind {
			out = append(out, p.frame)
		}
	}
	return out
}

type fakeFanout struct {
	mu    sync.Mutex
	steps []notify.Step
}

func (f *fakeFanout) Fanout(_ context.Context, inc store.Incident, step notify.Step) (notify.Result, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.steps = append(f.steps, step)
	return notify.Result{
		NotificationID:  "note-1",
		Audience:        []string{"dev-guardian"},
		FirstNotifiedAt: inc.OpenedAt,
	}, nil
}

func (f *fakeFanout) recorded() []notify.Step {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]notify.Step{}, f.steps...)
}

const (
	famID   = "fam-1"
	subjID  = "mem-asha"
	ownerID = "mem-rohan"
)

// claimable is an incident sitting at L1 — the ladder is running and nobody has
// answered, which is the only state a CLAIM is interesting from.
func claimable() store.Incident {
	return store.Incident{
		ID: "inc-1", FamilyID: famID, SubjectMemberID: subjID,
		State: incident.StateActiveL1, Trigger: "MANUAL", PolicyVersion: 3,
		OpenedAt: 1_700_000_000_000,
	}
}

func harness(t *testing.T, inc store.Incident) (*Engine, *fakeStore, *fakeBus, *fakeFanout) {
	t.Helper()
	st := newFakeStore(inc)
	bus := &fakeBus{}
	fan := &fakeFanout{}
	seq := 0
	e, err := New(Deps{
		Store: st, Bus: bus, Notify: fan,
		Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Now: func() time.Time { return time.UnixMilli(1_700_000_060_000).UTC() },
		NewID: func() string {
			seq++
			return "timer-" + string(rune('a'+seq-1))
		},
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return e, st, bus, fan
}

// pending returns the still-armed timers for an incident.
func pending(st *fakeStore, incidentID string) map[string]store.Timer {
	out := map[string]store.Timer{}
	for _, tm := range st.TimersForIncident(incidentID) {
		if tm.State == TimerPending {
			out[tm.Action] = tm
		}
	}
	return out
}

// ── characterization: what CLAIM already did, and must keep doing ────────────

func TestClaimMovesToOwnedAndRecordsTheOwnerAndT4(t *testing.T) {
	e, st, _, _ := harness(t, claimable())

	next, err := e.Claim(context.Background(), "inc-1", ownerID)
	if err != nil {
		t.Fatalf("Claim: %v", err)
	}
	if next.State != incident.StateOwned {
		t.Fatalf("state = %s, want OWNED", next.State)
	}
	if next.OwnerMemberID != ownerID {
		t.Fatalf("owner = %q, want %q", next.OwnerMemberID, ownerID)
	}
	// t4 — first acknowledgement. The four clocks are the only evidence the
	// family has that the chain worked (§2.6.1).
	if next.FirstAckAt != 1_700_000_060_000 {
		t.Fatalf("firstAckAt = %d, want the claim's wall clock", next.FirstAckAt)
	}
	stored, _ := st.Incident("inc-1")
	if stored.OwnerMemberID != ownerID || stored.State != incident.StateOwned {
		t.Fatalf("stored incident = %+v, want an OWNED row naming the owner", stored)
	}
}

func TestClaimHaltsTheLadderButKeepsAutoQuiesceAndArmsTheWatchdog(t *testing.T) {
	inc := claimable()
	e, st, _, _ := harness(t, inc)
	// Arm the full ladder first, exactly as OnIncidentOpen would have.
	e.armLadder(inc, time.UnixMilli(1_700_000_000_000))
	e.arm(inc, ActionAutoQuiesce, 0, 1_700_021_600_000)

	if _, err := e.Claim(context.Background(), "inc-1", ownerID); err != nil {
		t.Fatalf("Claim: %v", err)
	}

	live := pending(st, "inc-1")
	for _, halted := range []string{ActionRepeatL1, ActionSMSTier, ActionEscalateL2, ActionEscalateL3} {
		if _, ok := live[halted]; ok {
			t.Fatalf("★ the ladder kept climbing after a CLAIM: %s is still pending", halted)
		}
	}
	// ★ F-02 ★ A claimed incident nobody ever resolves is the exact case
	// auto-quiesce exists for, so CLAIM must not cancel it.
	if _, ok := live[ActionAutoQuiesce]; !ok {
		t.Fatal("★ F-02 ★ auto-quiesce was cancelled by CLAIM; a forgotten incident would now run forever")
	}
	// P-030: one person claims, gets stuck in traffic, everybody else has stood
	// down permanently. The watchdog is what makes RECLAIMED reachable.
	wd, ok := live[ActionWatchdog]
	if !ok {
		t.Fatal("no progress watchdog armed; a stuck owner would never re-broadcast")
	}
	if want := int64(1_700_000_060_000 + int64(WatchdogAfterS())*1000); wd.FireAt != want {
		t.Fatalf("watchdog fires at %d, want %d", wd.FireAt, want)
	}
}

func TestClaimPublishesOwnershipOnTheFamilyStreamAsCritical(t *testing.T) {
	e, _, bus, _ := harness(t, claimable())

	if _, err := e.Claim(context.Background(), "inc-1", ownerID); err != nil {
		t.Fatalf("Claim: %v", err)
	}

	frames := bus.typed(famID, "incident.claimed")
	if len(frames) != 1 {
		t.Fatalf("incident.claimed frames = %d, want 1", len(frames))
	}
	f := frames[0]
	if f.Priority != notify.PriorityCritical {
		t.Fatalf("priority = %s, want CRITICAL", f.Priority)
	}
	if f.Data["ownerMemberId"] != ownerID {
		t.Fatalf("frame owner = %v, want %q", f.Data["ownerMemberId"], ownerID)
	}
	if f.Data["state"] != string(incident.StateOwned) {
		t.Fatalf("frame state = %v, want OWNED", f.Data["state"])
	}
}

func TestClaimFromAStateThatCannotBeClaimedIsRefusedAndChangesNothing(t *testing.T) {
	inc := claimable()
	inc.State = incident.StateResolved
	e, st, bus, fan := harness(t, inc)

	if _, err := e.Claim(context.Background(), "inc-1", ownerID); err == nil {
		t.Fatal("claiming a RESOLVED incident was allowed")
	}
	stored, _ := st.Incident("inc-1")
	if stored.OwnerMemberID != "" || stored.State != incident.StateResolved {
		t.Fatalf("a refused claim mutated the incident: %+v", stored)
	}
	if len(bus.typed(famID, "incident.claimed")) != 0 {
		t.Fatal("a refused claim was broadcast as ownership")
	}
	if len(fan.recorded()) != 0 {
		t.Fatal("a refused claim woke the family")
	}
}

func TestReleaseClearsTheOwnerAndRearmsL3(t *testing.T) {
	inc := claimable()
	inc.State = incident.StateOwned
	inc.OwnerMemberID = ownerID
	e, st, bus, _ := harness(t, inc)

	next, err := e.Release(context.Background(), "inc-1", ownerID)
	if err != nil {
		t.Fatalf("Release: %v", err)
	}
	if next.State != incident.StateActiveL2 {
		t.Fatalf("state = %s, want ACTIVE_L2", next.State)
	}
	if next.OwnerMemberID != "" {
		t.Fatalf("owner = %q, want cleared", next.OwnerMemberID)
	}
	if _, ok := pending(st, "inc-1")[ActionEscalateL3]; !ok {
		t.Fatal("L3 was not re-armed; a released incident would sit at L2 forever")
	}
	if len(bus.typed(famID, "incident.released")) != 1 {
		t.Fatal("release was not broadcast on the family stream")
	}
}

// ── W10-d · 1.32 — the requirement this session adds ─────────────────────────

// ★ docs/02 §2.6.4 ★ "Fan-out of CLAIM goes over BOTH channels simultaneously."
// The bus frame above reaches every socket that happens to be open. A phone whose
// app is killed has no socket, and that phone is precisely the one still ringing.
func TestClaimFansOutOverPushAndNotOnlyOverTheBus(t *testing.T) {
	e, _, _, fan := harness(t, claimable())

	if _, err := e.Claim(context.Background(), "inc-1", ownerID); err != nil {
		t.Fatalf("Claim: %v", err)
	}

	steps := fan.recorded()
	if len(steps) != 1 {
		t.Fatalf("fan-out steps = %d, want 1 — a CLAIM that never leaves the bus "+
			"leaves every backgrounded phone still sirening (§2.6.4)", len(steps))
	}
	step := steps[0]
	if step.Kind != notify.KindClaimed {
		t.Fatalf("step kind = %q, want %q — without it the receiving device "+
			"cannot tell a claim from a fresh alert and re-alarms the family",
			step.Kind, notify.KindClaimed)
	}
	for _, want := range []notify.Channel{notify.ChannelWS, notify.ChannelFCM} {
		if !hasChannel(step.Channels, want) {
			t.Fatalf("channels = %v, want both ws and fcm", step.Channels)
		}
	}
	// A claim is the ladder STOPPING. Sending it over SMS or voice would spend
	// the family's notify budget to announce that nothing more is needed.
	for _, forbidden := range []notify.Channel{notify.ChannelSMS, notify.ChannelVoice} {
		if hasChannel(step.Channels, forbidden) {
			t.Fatalf("a claim broadcast was billed to %s", forbidden)
		}
	}
}

// The claim rung must be recorded in the log like every other rung, or the
// notification matrix in the after-action report has a hole exactly where the
// most important transition is.
func TestClaimAppendsItsNotifyRowAfterTheClaimEvent(t *testing.T) {
	e, st, _, _ := harness(t, claimable())

	if _, err := e.Claim(context.Background(), "inc-1", ownerID); err != nil {
		t.Fatalf("Claim: %v", err)
	}

	types := st.eventTypes()
	if len(types) < 2 {
		t.Fatalf("event log = %v, want the CLAIM and its notify row", types)
	}
	if types[0] != string(incident.EventClaim) {
		t.Fatalf("first event = %q, want CLAIM", types[0])
	}
	if types[len(types)-1] != "NOTIFY_claim-broadcast" {
		t.Fatalf("last event = %q, want NOTIFY_claim-broadcast", types[len(types)-1])
	}
}

func TestReleaseRebroadcastIsMarkedAsARelease(t *testing.T) {
	inc := claimable()
	inc.State = incident.StateOwned
	inc.OwnerMemberID = ownerID
	e, _, _, fan := harness(t, inc)

	if _, err := e.Release(context.Background(), "inc-1", ownerID); err != nil {
		t.Fatalf("Release: %v", err)
	}

	steps := fan.recorded()
	if len(steps) != 1 {
		t.Fatalf("fan-out steps = %d, want 1", len(steps))
	}
	if steps[0].Kind != notify.KindReleased {
		t.Fatalf("step kind = %q, want %q", steps[0].Kind, notify.KindReleased)
	}
}

// The ladder rungs are alerts and must stay alerts: a zero-value Step means
// "ring", so an existing call site that never heard of Kind cannot accidentally
// present as a quiet banner.
func TestLadderRungsStayAlerts(t *testing.T) {
	e, _, _, fan := harness(t, claimable())

	if _, err := e.Reescalate(context.Background(), "inc-1"); err != nil {
		t.Fatalf("Reescalate: %v", err)
	}

	for _, step := range fan.recorded() {
		if step.Kind != notify.KindAlert && step.Kind != "" {
			t.Fatalf("ladder rung %q carried kind %q, want an alert", step.Label, step.Kind)
		}
	}
}

func hasChannel(list []notify.Channel, want notify.Channel) bool {
	for _, c := range list {
		if c == want {
			return true
		}
	}
	return false
}
