// ═══════════════════════════════════════════════════════════════════════════════
// CHARACTERIZATION — the timer wheel (1.29 · F-13 · ADR-014 §2.5.4 · §2.11.5)
//
// Every timer in this package is a row the store owns; a worker claims it
// atomically, executes it, and the claim is what makes execution at-most-once.
// There is deliberately NO leader election (F-13): N stateless workers race for
// the same rows, and killing any of them at any moment must not stall a ladder.
//
// That design has exactly two failure modes worth having tests for, and both are
// silent: the same rung fired twice (two sirens, two SMS bills, a family told
// twice that nobody has answered), and a rung not fired at all (nobody's phone
// rings). ladder_test.go pins what each rung DOES; this file pins the machinery
// that decides whether and when it runs at all.
//
// ★ Characterization, not new requirements. ★ The rig, testClock and atState
// helpers live in ladder_test.go; the fakes live in claim_test.go.
// ═══════════════════════════════════════════════════════════════════════════════
package escalation

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/kavach/backend/internal/incident"
	"github.com/kavach/backend/internal/notify"
	"github.com/kavach/backend/internal/store"
)

// ── extra fakes ──────────────────────────────────────────────────────────────

// claimingStore is a store that offers the transactional claim, i.e. the real
// store.FireTimer. The engine must prefer it over the optimistic fallback: only
// this path is exact across processes.
type claimingStore struct{ *fakeStore }

func (c *claimingStore) FireTimer(id string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i, t := range c.timers {
		if t.ID != id {
			continue
		}
		if t.State != TimerPending || t.FiredAt != 0 {
			return errors.New("store: timer already claimed: " + id)
		}
		t.State = TimerFired
		t.FiredAt = 1
		t.Attempts++
		c.timers[i] = t
		return nil
	}
	return errors.New("store: no such timer")
}

// failingFanout is a notification leg that cannot be attempted at all — the
// whole transport is down, not one recipient.
type failingFanout struct {
	mu    sync.Mutex
	calls int
}

func (f *failingFanout) Fanout(_ context.Context, _ store.Incident, _ notify.Step) (notify.Result, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	return notify.Result{}, errors.New("fanout: transport unavailable")
}

func (f *failingFanout) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

// ops returns the frames published to the operator subject, which is
// deliberately not family-scoped.
func (b *fakeBus) ops() []notify.Frame {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []notify.Frame
	for _, p := range b.frames {
		if p.subject == notify.OpsSubject {
			out = append(out, p.frame)
		}
	}
	return out
}

// armAt writes a pending timer directly, the way arm() would have.
func armAt(t *testing.T, st *fakeStore, id, action string, fireAt int64) store.Timer {
	t.Helper()
	tm := store.Timer{
		ID: id, FamilyID: famID, IncidentID: "inc-1", Action: action,
		FireAt: fireAt, State: TimerPending, CreatedAt: l1EntryMs,
	}
	if err := st.PutTimer(tm); err != nil {
		t.Fatalf("PutTimer: %v", err)
	}
	return tm
}

func timerByID(st *fakeStore, id string) (store.Timer, bool) {
	for _, tm := range st.Timers() {
		if tm.ID == id {
			return tm, true
		}
	}
	return store.Timer{}, false
}

func labelsOf(steps []notify.Step) []string {
	out := make([]string, 0, len(steps))
	for _, s := range steps {
		out = append(out, s.Label)
	}
	return out
}

// ── what a poll picks up ─────────────────────────────────────────────────────

func TestPollFiresWhatIsDueAndLeavesTheRestArmed(t *testing.T) {
	e, st, _, fan, clk := rig(t, atState(incident.StateActiveL1), Config{})
	armAt(t, st, "due", ActionRepeatL1, l1EntryMs+30_000)
	armAt(t, st, "later", ActionEscalateL2, l1EntryMs+90_000)
	clk.advance(40 * time.Second)

	e.pollOnce(context.Background(), "w0")

	if got, _ := timerByID(st, "due"); got.State != TimerFired {
		t.Fatalf("the due timer is %s, want fired", got.State)
	}
	if got, _ := timerByID(st, "later"); got.State != TimerPending {
		t.Fatalf("a timer 50 s in the future was consumed early (%s)", got.State)
	}
	if labels := labelsOf(fan.recorded()); len(labels) != 1 || labels[0] != "repeat-L1" {
		t.Fatalf("fan-outs = %v, want just the repeat rung", labels)
	}
}

// The ladder is an ordered thing. Firing L2 before the 30 s repeat would eat the
// repeat entirely — its state guard would find ACTIVE_L2 and skip.
func TestDueTimersFireOldestFirstEvenWhenTheStoreReturnsThemScrambled(t *testing.T) {
	e, st, _, fan, clk := rig(t, atState(incident.StateActiveL1), Config{})
	armAt(t, st, "l2", ActionEscalateL2, l1EntryMs+90_000)
	armAt(t, st, "sms", ActionSMSTier, l1EntryMs+60_000)
	armAt(t, st, "repeat", ActionRepeatL1, l1EntryMs+30_000)
	clk.advance(100 * time.Second)

	e.pollOnce(context.Background(), "w0")

	want := []string{"repeat-L1", "sms-tier", "L2"}
	got := labelsOf(fan.recorded())
	if len(got) != len(want) {
		t.Fatalf("fan-outs = %v, want %v — a rung was skipped because the ladder ran out of order", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("ladder order = %v, want %v", got, want)
		}
	}
}

// A backlog must not become an unbounded burst of notifications in one tick.
func TestBatchLimitCapsOnePollAndTheRestSurviveToTheNext(t *testing.T) {
	e, st, _, fan, clk := rig(t, atState(incident.StateActiveL1), Config{BatchLimit: 2})
	for _, id := range []string{"a", "b", "c", "d", "e"} {
		armAt(t, st, id, ActionRepeatL1, l1EntryMs+1_000)
	}
	clk.advance(10 * time.Second)

	e.pollOnce(context.Background(), "w0")
	if n := len(fan.recorded()); n != 2 {
		t.Fatalf("fired %d rungs in one poll, want the configured limit of 2", n)
	}
	stillPending := 0
	for _, tm := range st.Timers() {
		if tm.State == TimerPending {
			stillPending++
		}
	}
	if stillPending != 3 {
		t.Fatalf("%d timers still pending, want 3 — the overflow was dropped, not deferred", stillPending)
	}

	e.pollOnce(context.Background(), "w0")
	if n := len(fan.recorded()); n != 4 {
		t.Fatalf("after two polls %d rungs fired, want 4", n)
	}
}

func TestCancelledAndAlreadyFiredTimersAreNeverPickedUp(t *testing.T) {
	e, st, _, fan, clk := rig(t, atState(incident.StateActiveL1), Config{})
	dead := armAt(t, st, "cancelled", ActionEscalateL2, l1EntryMs+10_000)
	dead.State = TimerCancelled
	if err := st.PutTimer(dead); err != nil {
		t.Fatalf("PutTimer: %v", err)
	}
	done := armAt(t, st, "fired", ActionEscalateL2, l1EntryMs+10_000)
	done.State = TimerFired
	done.FiredAt = l1EntryMs + 10_001
	if err := st.PutTimer(done); err != nil {
		t.Fatalf("PutTimer: %v", err)
	}
	clk.advance(time.Minute)

	wait := e.pollOnce(context.Background(), "w0")

	if len(fan.recorded()) != 0 {
		t.Fatal("a cancelled or already-fired timer was executed")
	}
	if wait != e.cfg.PollSlow {
		t.Fatalf("wait = %s, want the slow poll: nothing is armed", wait)
	}
}

// ── the claim (F-13) ─────────────────────────────────────────────────────────

// ★ The store's transactional claim is SELECT … FOR UPDATE SKIP LOCKED. ★ It is
// the only path that is exact across processes, so the engine must take it
// whenever the store offers it — the optimistic fallback is process-local and
// two machines can both win it.
func TestAStoreWithAnAtomicClaimIsUsedInsteadOfTheOptimisticFallback(t *testing.T) {
	base := newFakeStore(atState(incident.StateActiveL1))
	st := &claimingStore{fakeStore: base}
	tm := armAt(t, base, "t1", ActionRepeatL1, l1EntryMs)

	e1, err := New(Deps{Store: st, Bus: &fakeBus{}, Now: func() time.Time { return time.UnixMilli(l1EntryMs) }})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	e2, err := New(Deps{Store: st, Bus: &fakeBus{}, Now: func() time.Time { return time.UnixMilli(l1EntryMs) }})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if !e1.claim(tm) {
		t.Fatal("the first worker could not claim a pending timer")
	}
	// A second process, with its own empty in-flight map, must still lose.
	if e2.claim(tm) {
		t.Fatal("★ two processes both claimed the same rung: the family would be notified twice")
	}
	got, _ := timerByID(base, "t1")
	if got.Attempts != 1 {
		t.Fatalf("attempts = %d, want 1 — FireTimer was never called, so the engine "+
			"fell back to the process-local claim", got.Attempts)
	}
	if got.State != TimerFired {
		t.Fatalf("timer state = %s, want fired", got.State)
	}
}

// The fallback for a store with no transactional claim: an in-flight marker, a
// re-read, and a write only if the row is still pending.
func TestTheOptimisticClaimRefusesARowItAlreadyHolds(t *testing.T) {
	e, st, _, _, _ := rig(t, atState(incident.StateActiveL1), Config{})
	tm := armAt(t, st, "t1", ActionRepeatL1, l1EntryMs)

	if !e.claim(tm) {
		t.Fatal("first claim failed")
	}
	// Still in flight: the marker alone refuses it.
	if e.claim(tm) {
		t.Fatal("a timer already in flight was claimed a second time")
	}
	// Released, but the row is now fired: the re-read refuses it.
	e.releaseClaim(tm.ID)
	if e.claim(tm) {
		t.Fatal("a timer already fired was claimed again after release")
	}
}

// N stateless workers racing for the same rows is the whole design (F-13). The
// property that makes it safe is at-most-once execution, and it has to hold
// under a genuine race, not just when the calls happen to be sequential.
func TestConcurrentPollsFireOneTimerExactlyOnce(t *testing.T) {
	e, st, _, fan, clk := rig(t, atState(incident.StateActiveL1), Config{})
	armAt(t, st, "t1", ActionRepeatL1, l1EntryMs+30_000)
	clk.advance(31 * time.Second)

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			e.pollOnce(context.Background(), "w")
		}()
	}
	wg.Wait()

	if n := len(fan.recorded()); n != 1 {
		t.Fatalf("★ eight workers fired the same rung %d times", n)
	}
	if fired, _, _, _, _ := e.Stats(); fired != 1 {
		t.Fatalf("fired stat = %d, want 1", fired)
	}
}

// F-13 again, from the other end: no coordinator to lose. Start the real worker
// pool and let it find the row on its own.
func TestTheWorkerPoolFiresADueRungWithNoLeaderAndStopsWithItsContext(t *testing.T) {
	e, st, _, fan, clk := rig(t, atState(incident.StateActiveL1), Config{
		Workers: 4, PollFast: 5 * time.Millisecond, PollSlow: 5 * time.Millisecond,
	})
	armAt(t, st, "t1", ActionRepeatL1, l1EntryMs+30_000)
	clk.advance(31 * time.Second)

	ctx, cancel := context.WithCancel(context.Background())
	stopped := make(chan struct{})
	go func() {
		e.Run(ctx)
		close(stopped)
	}()

	deadline := time.Now().Add(2 * time.Second)
	for len(fan.recorded()) == 0 && time.Now().Before(deadline) {
		time.Sleep(2 * time.Millisecond)
	}
	cancel()
	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return after its context was cancelled")
	}

	if n := len(fan.recorded()); n != 1 {
		t.Fatalf("four workers fired the rung %d times, want exactly 1", n)
	}
}

func TestAClaimLostToAnotherWorkerIsCountedAsSkippedNotFired(t *testing.T) {
	e, st, _, fan, clk := rig(t, atState(incident.StateActiveL1), Config{})
	armAt(t, st, "t1", ActionRepeatL1, l1EntryMs+30_000)
	clk.advance(31 * time.Second)
	// Somebody else is already holding it.
	e.claimMu.Lock()
	e.inflight["t1"] = true
	e.claimMu.Unlock()

	e.pollOnce(context.Background(), "w0")

	fired, skipped, _, _, lastPoll := e.Stats()
	if fired != 0 || skipped != 1 {
		t.Fatalf("fired=%d skipped=%d, want 0 and 1", fired, skipped)
	}
	if len(fan.recorded()) != 0 {
		t.Fatal("a rung claimed by another worker was executed anyway")
	}
	if lastPoll != clk.ms64() {
		t.Errorf("lastPoll = %d, want %d — the dashboard cannot tell a stalled poller "+
			"from an idle one without it", lastPoll, clk.ms64())
	}
}

// ── overdue is a page, not a log line (§2.11.5) ──────────────────────────────

func TestATimerMoreThanSixtySecondsLateRaisesAP0(t *testing.T) {
	e, st, bus, _, clk := rig(t, atState(incident.StateActiveL1), Config{})
	armAt(t, st, "late", ActionRepeatL1, l1EntryMs)
	clk.advance(61 * time.Second)

	e.pollOnce(context.Background(), "w0")

	frames := bus.ops()
	if len(frames) != 1 {
		t.Fatalf("ops frames = %d, want 1 — a 61 s late escalation timer is a P0 page", len(frames))
	}
	f := frames[0]
	if f.Type != "ops.timer_overdue" {
		t.Fatalf("type = %q, want ops.timer_overdue", f.Type)
	}
	if f.Priority != notify.PriorityCritical {
		t.Fatalf("priority = %s, want CRITICAL", f.Priority)
	}
	if f.Data["severity"] != "P0" {
		t.Fatalf("severity = %v, want P0", f.Data["severity"])
	}
	if f.Data["timerId"] != "late" || f.Data["incidentId"] != "inc-1" {
		t.Fatalf("frame does not identify the timer: %v", f.Data)
	}
	if late, _ := f.Data["lateMs"].(float64); int64(late) != 61_000 {
		t.Fatalf("lateMs = %v, want 61000", f.Data["lateMs"])
	}
	if _, _, overdue, _, _ := e.Stats(); overdue != 1 {
		t.Fatalf("overdue stat = %d, want 1", overdue)
	}
	// Late is not the same as lost: the rung still runs.
	if got, _ := timerByID(st, "late"); got.State != TimerFired {
		t.Fatalf("the overdue timer was paged about but not fired (%s)", got.State)
	}
}

func TestATimerLateByLessThanTheBudgetIsNotAPage(t *testing.T) {
	e, st, bus, _, clk := rig(t, atState(incident.StateActiveL1), Config{})
	armAt(t, st, "nearly", ActionRepeatL1, l1EntryMs)
	clk.advance(59 * time.Second)

	e.pollOnce(context.Background(), "w0")

	if n := len(bus.ops()); n != 0 {
		t.Fatalf("ops frames = %d, want 0 — paging on ordinary lateness trains "+
			"the operator to ignore the page that matters", n)
	}
}

// ── a rung that failed must not be a rung that vanished ──────────────────────

func TestAFailedRungIsRearmedAFewSecondsOut(t *testing.T) {
	fan := &failingFanout{}
	e, st, _, clk := rigWith(t, atState(incident.StateActiveL1), Config{}, fan)
	armAt(t, st, "t1", ActionRepeatL1, l1EntryMs+30_000)
	clk.advance(31 * time.Second)

	e.pollOnce(context.Background(), "w0")

	if fan.count() != 1 {
		t.Fatalf("fan-out attempts = %d, want 1", fan.count())
	}
	if _, _, _, failed, _ := e.Stats(); failed != 1 {
		t.Fatalf("failed stat = %d, want 1", failed)
	}
	var retry store.Timer
	found := 0
	for _, tm := range st.Timers() {
		if tm.State == TimerPending {
			retry, found = tm, found+1
		}
	}
	if found != 1 {
		t.Fatalf("%d pending timers after a failed rung, want exactly the retry — "+
			"a consumed timer whose work failed silently drops a rung of the ladder", found)
	}
	if retry.ID == "t1" {
		t.Fatal("the retry reused the consumed timer's id")
	}
	if retry.Action != ActionRepeatL1 || retry.Attempts != 1 {
		t.Fatalf("retry = %s attempts %d, want REPEAT_L1 attempt 1", retry.Action, retry.Attempts)
	}
	if want := clk.ms64() + 5_000; retry.FireAt != want {
		t.Fatalf("retry fires at %d, want %d (5 s out)", retry.FireAt, want)
	}
}

// A rung that has failed three times is a rung that is not going to work, and
// re-arming it forever would keep one broken transport hot at 250 ms.
func TestARungThatHasFailedThreeTimesIsAbandoned(t *testing.T) {
	fan := &failingFanout{}
	e, st, _, clk := rigWith(t, atState(incident.StateActiveL1), Config{}, fan)
	spent := armAt(t, st, "t1", ActionRepeatL1, l1EntryMs+30_000)
	spent.Attempts = 3
	if err := st.PutTimer(spent); err != nil {
		t.Fatalf("PutTimer: %v", err)
	}
	clk.advance(31 * time.Second)

	e.pollOnce(context.Background(), "w0")

	for _, tm := range st.Timers() {
		if tm.State == TimerPending {
			t.Fatalf("a fourth attempt was armed: %+v", tm)
		}
	}
	if len(st.Timers()) != 1 {
		t.Fatalf("%d timer rows, want just the abandoned one", len(st.Timers()))
	}
}

// ── the adaptive poll (F-13) ─────────────────────────────────────────────────

// 250 ms when something is about to fire, 2 s otherwise: identical latency at the
// moment it matters, ~90% fewer reads the rest of the day.
func TestPollIntervalTightensOnlyWhenSomethingIsAboutToFire(t *testing.T) {
	cases := []struct {
		name   string
		fireAt func(now int64) int64
		want   func(e *Engine) time.Duration
	}{
		{"nothing armed", nil, func(e *Engine) time.Duration { return e.cfg.PollSlow }},
		{"armed ten minutes out", func(now int64) int64 { return now + 600_000 },
			func(e *Engine) time.Duration { return e.cfg.PollSlow }},
		{"armed inside the due-soon window", func(now int64) int64 { return now + 3_000 },
			func(e *Engine) time.Duration { return e.cfg.PollFast }},
		{"due right now", func(now int64) int64 { return now },
			func(e *Engine) time.Duration { return e.cfg.PollFast }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e, st, _, _, clk := rig(t, atState(incident.StateActiveL1), Config{})
			if c.fireAt != nil {
				armAt(t, st, "t1", ActionRepeatL1, c.fireAt(clk.ms64()))
			}

			if got := e.pollOnce(context.Background(), "w0"); got != c.want(e) {
				t.Fatalf("next poll in %s, want %s", got, c.want(e))
			}
		})
	}
}

func TestPollDefaultsAreTheOnesTheHeaderPromises(t *testing.T) {
	e, _, _, _, _ := rig(t, atState(incident.StateActiveL1), Config{})

	if e.cfg.Workers != 3 {
		t.Errorf("workers = %d, want 3", e.cfg.Workers)
	}
	if e.cfg.PollFast != 250*time.Millisecond {
		t.Errorf("pollFast = %s, want 250ms", e.cfg.PollFast)
	}
	if e.cfg.PollSlow != 2*time.Second {
		t.Errorf("pollSlow = %s, want 2s", e.cfg.PollSlow)
	}
	if e.cfg.DueSoon != 5*time.Second {
		t.Errorf("dueSoon = %s, want 5s", e.cfg.DueSoon)
	}
	if e.cfg.BatchLimit != 100 {
		t.Errorf("batchLimit = %d, want 100", e.cfg.BatchLimit)
	}
}

func TestNewRefusesToRunWithoutAStoreOrABus(t *testing.T) {
	if _, err := New(Deps{Bus: &fakeBus{}}); err == nil {
		t.Error("an engine with no store was constructed")
	}
	if _, err := New(Deps{Store: newFakeStore(atState(incident.StateActiveL1))}); err == nil {
		t.Error("an engine with no bus was constructed")
	}
}
