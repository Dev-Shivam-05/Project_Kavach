// ═══════════════════════════════════════════════════════════════════════════════
// CHARACTERIZATION — the lost update between a worker and a human (P-003 · P-030)
//
// Every transition in this engine used to be read-modify-write on a snapshot:
// execute() reads the incident, does its work, and applyEvent writes the copy
// back with `PutIncident`, which is a blind `*row = i`. Three workers and every
// HTTP handler follow the same shape, so the responder's CLAIM landing between an
// ESCALATE_L2 worker's read and its write was erased — state back to ACTIVE_L2,
// owner back to "", the watchdog a no-op, and a billable voice tier fanned out
// for an incident somebody was already driving to. T+90 s is exactly when humans
// claim.
//
// Both tests inject the competing transition at the narrowest point the fakes
// allow — inside the worker's own AppendEvent / Fanout call — which is later
// than any real interleaving, so a fix that closes these closes the real ones.
// ═══════════════════════════════════════════════════════════════════════════════
package escalation

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kavach/backend/internal/incident"
	"github.com/kavach/backend/internal/notify"
	"github.com/kavach/backend/internal/store"
)

// raceStore runs inject exactly once, at the moment a worker has read its
// snapshot and is about to append the transition it decided on. The guard is a
// CAS rather than sync.Once because the injected transition re-enters
// AppendEvent, and Once.Do is not reentrant.
type raceStore struct {
	*fakeStore
	fired  atomic.Bool
	inject func()
}

func (r *raceStore) AppendEvent(ev store.Event) error {
	if r.inject != nil && r.fired.CompareAndSwap(false, true) {
		r.inject()
	}
	return r.fakeStore.AppendEvent(ev)
}

// raceFanout does the same from inside Fanout — the widest window in the engine,
// because a fan-out performs dozens of fsynced delivery writes before returning.
type raceFanout struct {
	fakeFanout
	fired  atomic.Bool
	inject func()
}

func (r *raceFanout) Fanout(ctx context.Context, inc store.Incident, step notify.Step) (notify.Result, error) {
	if r.inject != nil && r.fired.CompareAndSwap(false, true) {
		r.inject()
	}
	return r.fakeFanout.Fanout(ctx, inc, step)
}

func engineOn(t *testing.T, st Store, fan Fanouter) *Engine {
	t.Helper()
	seq := 0
	e, err := New(Deps{
		Store: st, Bus: &fakeBus{}, Notify: fan,
		Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Now: func() time.Time { return time.UnixMilli(l1EntryMs + 90_000).UTC() },
		NewID: func() string {
			seq++
			return fmt.Sprintf("tm-%d", seq)
		},
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return e
}

func labels(steps []notify.Step) string {
	var out []string
	for _, s := range steps {
		out = append(out, s.Label)
	}
	return strings.Join(out, ",")
}

func TestAnEscalationWorkerCannotOverwriteAClaimThatLandedUnderIt(t *testing.T) {
	inc := atState(incident.StateActiveL1)
	st := &raceStore{fakeStore: newFakeStore(inc)}
	fan := &fakeFanout{}
	e := engineOn(t, st, fan)

	// The worker has read ACTIVE_L1 and decided on NO_ACK → ACTIVE_L2. Before it
	// can write, Rohan claims.
	st.inject = func() {
		if _, err := e.Claim(context.Background(), "inc-1", ownerID); err != nil {
			t.Fatalf("Claim: %v", err)
		}
	}
	err := fire(t, e, ActionEscalateL2)

	got, _ := st.Incident("inc-1")
	if got.State != incident.StateOwned || got.OwnerMemberID != ownerID {
		t.Fatalf("the worker overwrote the claim: state=%s owner=%q, want OWNED/%s", got.State, got.OwnerMemberID, ownerID)
	}
	if !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("execute err = %v, want ErrInvalidTransition (the row moved underneath)", err)
	}
	// No L2 fan-out for an incident somebody owns: the only step is the claim's
	// own broadcast.
	if got := labels(fan.recorded()); got != "claim-broadcast" {
		t.Fatalf("fan-out steps = %q, want only the claim broadcast", got)
	}
}

func TestNotifyStepWritesOnlyT3AndNotAStaleCopyOfTheRow(t *testing.T) {
	inc := atState(incident.StateActiveL1)
	st := newFakeStore(inc)
	fan := &raceFanout{}
	e := engineOn(t, st, fan)

	// The L1 blast's fan-out is in progress — the widest window there is — and
	// Rohan claims while it runs.
	fan.inject = func() {
		if _, err := e.Claim(context.Background(), "inc-1", ownerID); err != nil {
			t.Fatalf("Claim: %v", err)
		}
	}
	if err := e.BlastL1(context.Background(), inc); err != nil {
		t.Fatalf("BlastL1: %v", err)
	}

	got, _ := st.Incident("inc-1")
	if got.State != incident.StateOwned || got.OwnerMemberID != ownerID {
		t.Fatalf("notifyStep wrote its stale snapshot back: state=%s owner=%q", got.State, got.OwnerMemberID)
	}
	if got.FirstNotifiedAt == 0 {
		t.Fatal("t3 was not recorded")
	}
	if got.FirstAckAt == 0 {
		t.Fatal("t4 from the claim was erased by the fan-out's write-back")
	}
}

// ── HLC receive rule (§2.10.5 · P-052) ───────────────────────────────────────

// hlcHex renders a device-style stamp: 48-bit physical ms, 16-bit logical,
// 32-bit node — the layout ids.ts and hlcClock.next agree on.
func hlcHex(physicalMs int64, logical uint16) string {
	var b [12]byte
	p := uint64(physicalMs)
	b[0], b[1], b[2], b[3], b[4], b[5] = byte(p>>40), byte(p>>32), byte(p>>24), byte(p>>16), byte(p>>8), byte(p)
	b[6], b[7] = byte(logical>>8), byte(logical)
	copy(b[8:], []byte{0xde, 0xad, 0xbe, 0xef})
	return fmt.Sprintf("%x", b)
}

func TestServerHLCSortsAfterADeviceStampFromTheFuture(t *testing.T) {
	var h hlcClock
	now := time.UnixMilli(l1EntryMs)
	// A phone three minutes fast opened the incident.
	device := hlcHex(l1EntryMs+180_000, 5)

	before := h.next(now)
	if before > device {
		t.Fatalf("test premise broken: a fresh server stamp %s already sorts after %s", before, device)
	}
	h.observe(device)
	after := h.next(now)
	if after <= device {
		t.Fatalf("server stamp %s sorts before the device's %s: the timeline would show the "+
			"cancel window expiring before the SOS was sent", after, device)
	}
	// It advanced the logical counter past the device's, not the wall clock.
	if after[:12] != device[:12] || after[12:16] != "0006" {
		t.Fatalf("stamp %s: want the device's physical %s with logical 0006", after, device[:12])
	}
}

func TestObservingAnOlderOrMalformedStampNeverRewindsTheClock(t *testing.T) {
	var h hlcClock
	now := time.UnixMilli(l1EntryMs)
	first := h.next(now)
	h.observe(hlcHex(l1EntryMs-60_000, 9)) // a phone a minute slow
	h.observe("not-hex")
	h.observe("")
	second := h.next(now)
	if second <= first {
		t.Fatalf("clock rewound: %s then %s", first, second)
	}
	if second[:12] != first[:12] {
		t.Fatalf("an older stamp moved the physical component: %s → %s", first, second)
	}
}
