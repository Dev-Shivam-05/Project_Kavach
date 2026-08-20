// ★ D-025 · RISK 15 · F-04 · ADR-018 — the projector's arming path, pinned.
//
// This is the first test in cmd/sos-ingest that exercises what happens AFTER
// the ack: main_test.go proves the request path (verify, fsync, publish, answer)
// and TestLOCBudget guards the ceiling, but nothing until now has read a rung
// off the store and asserted its shape.
//
// D-025 says the ladder can be re-armed after it has already climbed, and says
// so from four call sites read by eye, not from a run. These tests execute it.
// The order below is deliberate: pin what PENDING arms (nothing), pin what a
// duress open arms (two rungs, deterministic ids), and only then drive the
// F-04 coalescing path that rewrites them.
package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/kavach/backend/internal/envelope"
	sm "github.com/kavach/backend/internal/incident"
	"github.com/kavach/backend/internal/logx"
	"github.com/kavach/backend/internal/store"
)

// projT0 is the fixed instant every test below starts at. 2024-05-31T16:08:37Z.
const projT0 = 1717171717000

// projClock is a settable clock. The arming path is a function of s.now() twice
// over — the F-04 flood window decides whether a report coalesces, and every
// rung's fire_at is measured from it — so owning time is the only way to tell
// "the deadline moved" apart from "the test machine was slow".
type projClock struct {
	mu sync.Mutex
	at time.Time
}

func newProjClock(ms int64) *projClock { return &projClock{at: time.UnixMilli(ms)} }

func (c *projClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.at
}

func (c *projClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.at = c.at.Add(d)
}

func (c *projClock) ms() int64 { return c.now().UnixMilli() }

// newClockedServer is newTestServer with the clock injected. It is a separate
// helper rather than a variadic on that one because every test here needs the
// clock and no test there does.
func newClockedServer(t *testing.T, dir string, clk *projClock) *Server {
	t.Helper()
	srv, err := New(Config{
		DataDir: dir,
		Logger:  logx.NewTo(os.Stderr, slog.LevelError, true),
		Now:     clk.now,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = srv.Close() })
	return srv
}

// openUnverified posts an open whose signature does not verify. Unverified is
// not the exotic case here: ADR-018 makes a stale key cache flag rather than
// reject, and F-04 coalescing — the only way a second open record lands on an
// existing incident's id — exists solely on the unverified path.
func openUnverified(t *testing.T, srv *Server, priv ed25519.PrivateKey, e envelope.Envelope) ack {
	t.Helper()
	sg := sealed(t, priv, e)
	sg.Signature = base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))
	code, a := post(t, srv, "/v1/incident/open", sg)
	if code != http.StatusOK {
		t.Fatalf("open %s: status %d — a flood must never be dropped", e.IncidentID, code)
	}
	return a
}

func duressEnv(incidentID string, tsMs int64) envelope.Envelope {
	e := envFor(incidentID, tsMs)
	e.Duress = true
	return e
}

func drainProjector(t *testing.T, srv *Server) {
	t.Helper()
	if !srv.projector.Drain(3 * time.Second) {
		t.Fatal("projector did not catch up")
	}
}

// rungsFor keys an incident's timers by action. armTimers derives one rung per
// scheduled transition out of the current state, so action is unique per state.
func rungsFor(srv *Server, incidentID string) map[string]store.Timer {
	out := map[string]store.Timer{}
	for _, tm := range srv.st.TimersForIncident(incidentID) {
		out[tm.Action] = tm
	}
	return out
}

// rungByID reads one rung back by its derived id. The store exposes no
// single-timer getter and this test is not the place to add one to it.
func rungByID(t *testing.T, srv *Server, incidentID, id string) store.Timer {
	t.Helper()
	for _, tm := range srv.st.TimersForIncident(incidentID) {
		if tm.ID == id {
			return tm
		}
	}
	t.Fatalf("rung %q is not in the store", id)
	return store.Timer{}
}

// ── what an ordinary open arms ───────────────────────────────────────────────

// TestOpenAtPendingArmsNoRungs bounds D-025 before it is reproduced. PENDING has
// no scheduled transition in the generated machine — the cancel window is the
// device's, and it reaches the server as an append — so armTimers writes nothing
// for the overwhelmingly common case. A ladder that was never armed cannot be
// reset, which is why the reproduction below has to go through duress.
func TestOpenAtPendingArmsNoRungs(t *testing.T) {
	dir := t.TempDir()
	priv := seed(t, dir)
	clk := newProjClock(projT0)
	srv := newClockedServer(t, dir, clk)

	id := "d0000000-0000-7000-8000-000000000001"
	code, _ := post(t, srv, "/v1/incident/open", sealed(t, priv, envFor(id, projT0)))
	if code != http.StatusOK {
		t.Fatalf("open: status %d", code)
	}
	drainProjector(t, srv)

	inc, ok := srv.st.Incident(id)
	if !ok {
		t.Fatal("incident was never projected")
	}
	if inc.State != sm.StatePending {
		t.Fatalf("state %q, want %q", inc.State, sm.StatePending)
	}
	if n := len(sm.TimeoutsFor(sm.StatePending)); n != 0 {
		t.Fatalf("the machine now schedules %d transitions out of PENDING; this test and "+
			"D-025's blast radius both assumed 0", n)
	}
	if n := len(srv.st.TimersForIncident(id)); n != 0 {
		t.Fatalf("%d rungs armed at PENDING, want 0", n)
	}
	// The F-02 backstop is on the incident, not on a timer, and it IS set here.
	if want := int64(projT0) + int64(quiesceAfterS())*1000; inc.AutoQuiesceAt != want {
		t.Fatalf("auto_quiesce_at %d, want %d", inc.AutoQuiesceAt, want)
	}
}

// TestDuressOpenArmsTheSilentLadder pins the rung shape D-025 rests on: the id
// is derived, not minted, so two opens for one incident in one state collide by
// construction. (escalation.arm mints a UUID per rung and cannot collide; only
// this binary derives.)
func TestDuressOpenArmsTheSilentLadder(t *testing.T) {
	dir := t.TempDir()
	priv := seed(t, dir)
	clk := newProjClock(projT0)
	srv := newClockedServer(t, dir, clk)

	id := "d0000000-0000-7000-8000-000000000002"
	code, _ := post(t, srv, "/v1/incident/open", sealed(t, priv, duressEnv(id, projT0)))
	if code != http.StatusOK {
		t.Fatalf("open: status %d", code)
	}
	drainProjector(t, srv)

	inc, ok := srv.st.Incident(id)
	if !ok {
		t.Fatal("incident was never projected")
	}
	// A duress PIN skips the cancel window entirely: PENDING --PIN_DURESS-->
	// ACTIVE_L1_SILENT, decided in the projector, not on the device (§7.5).
	if inc.State != sm.StateActiveL1Silent {
		t.Fatalf("state %q, want %q", inc.State, sm.StateActiveL1Silent)
	}
	if !inc.Duress {
		t.Fatal("duress was not carried onto the incident row")
	}

	got := rungsFor(srv, id)
	if len(got) != 2 {
		t.Fatalf("%d rungs armed, want 2 (NO_ACK, AUTO_QUIESCE): %+v", len(got), got)
	}
	for _, want := range []struct {
		action string
		tier   int
		afterS int64
	}{
		{"NO_ACK", 2, 90},
		{"AUTO_QUIESCE", 0, 21600},
	} {
		tm, ok := got[want.action]
		if !ok {
			t.Fatalf("no %s rung", want.action)
		}
		// The id is the whole point: incident|state|action, byte for byte.
		if wantID := id + "|ACTIVE_L1_SILENT|" + want.action; tm.ID != wantID {
			t.Fatalf("%s id %q, want %q", want.action, tm.ID, wantID)
		}
		if tm.TargetTier != want.tier {
			t.Fatalf("%s target_tier %d, want %d", want.action, tm.TargetTier, want.tier)
		}
		// Measured from ServerReceivedAt, not from the client's clock.
		if wantAt := int64(projT0) + want.afterS*1000; tm.FireAt != wantAt {
			t.Fatalf("%s fire_at %d, want %d", want.action, tm.FireAt, wantAt)
		}
		if tm.State != store.TimerPending || tm.FiredAt != 0 || tm.Attempts != 0 {
			t.Fatalf("%s armed as %+v, want a clean pending row", want.action, tm)
		}
		if tm.FamilyID != testFamily || tm.IncidentID != id {
			t.Fatalf("%s scoped to family %q incident %q", want.action, tm.FamilyID, tm.IncidentID)
		}
		if tm.CreatedAt != projT0 {
			t.Fatalf("%s created_at %d, want the server clock %d", want.action, tm.CreatedAt, projT0)
		}
	}
}

// ── D-025, executed ──────────────────────────────────────────────────────────

// TestCoalescedSecondOpenRewritesRungsAlreadyArmed is the reproduction D-025
// asked for. Everything below goes through the real front door: HTTP, the
// signature check, the F-04 flood guard, the WAL, the bus, and the projector.
//
// The story is the one D-025 describes. A duress SOS arrives from a phone whose
// key the cache has not caught up with, so it is flagged and accepted. The
// ladder arms. An escalation worker claims the NO_ACK rung — that claim is the
// atomic primitive W10-f pinned, and it is what stops a second worker firing the
// same rung. Then the frightened person keeps pressing SOS. Past the F-04
// threshold those reports coalesce onto the FIRST incident's id while carrying
// their own HLC, so they pass markSeen and projSeen both, and land in
// projectOpen with exists == true.
//
// What this test asserts is what the code does today, not what it should do.
func TestCoalescedSecondOpenRewritesRungsAlreadyArmed(t *testing.T) {
	dir := t.TempDir()
	priv := seed(t, dir)
	clk := newProjClock(projT0)
	srv := newClockedServer(t, dir, clk)

	first := "d0000000-0000-7000-8000-00000000000a"
	rest := []string{
		"d0000000-0000-7000-8000-00000000000b",
		"d0000000-0000-7000-8000-00000000000c",
		"d0000000-0000-7000-8000-00000000000d",
	}

	// 1. The duress SOS that arms the ladder. Unverified, so it is also the
	//    window's flood target — the id every later report coalesces into.
	if a := openUnverified(t, srv, priv, duressEnv(first, clk.ms())); a.CoalescedInto != "" {
		t.Fatalf("the first report coalesced into %q", a.CoalescedInto)
	}
	drainProjector(t, srv)

	armed := rungsFor(srv, first)
	noAckID := first + "|ACTIVE_L1_SILENT|NO_ACK"
	if armed["NO_ACK"].ID != noAckID {
		t.Fatalf("the ladder did not arm: %+v", armed)
	}
	if want := int64(projT0) + 90_000; armed["NO_ACK"].FireAt != want {
		t.Fatalf("NO_ACK fire_at %d, want %d", armed["NO_ACK"].FireAt, want)
	}

	// 2. An escalation worker claims the rung. FireTimer is the one-line
	//    primitive engine.claim() is built on (W10-f): pending → fired, once.
	if err := srv.st.FireTimer(noAckID); err != nil {
		t.Fatalf("FireTimer: %v", err)
	}
	claimed := rungByID(t, srv, first, noAckID)
	if claimed.State != store.TimerFired || claimed.FiredAt == 0 || claimed.Attempts != 1 {
		t.Fatalf("the claim did not stick: %+v", claimed)
	}
	if n := len(srv.st.TimersDue(claimed.FireAt)); n != 0 {
		t.Fatalf("%d rungs still due after the claim, want 0", n)
	}

	// 3. Three more reports inside the 60 s window. The 4th crosses the F-04
	//    threshold and is rewritten onto the first incident's id.
	var last ack
	for i, id := range rest {
		clk.advance(5 * time.Second)
		last = openUnverified(t, srv, priv, duressEnv(id, clk.ms()))
		if i < len(rest)-1 && last.CoalescedInto != "" {
			t.Fatalf("report %d coalesced below the threshold, into %q", i+2, last.CoalescedInto)
		}
	}
	if last.CoalescedInto != first {
		t.Fatalf("the last report coalesced into %q, want %q — the flood guard did not "+
			"put a second open record on the first incident", last.CoalescedInto, first)
	}
	if last.Flags&envelope.FlagUnverifiedFlood == 0 {
		t.Fatal("the coalesced report was not flagged UNVERIFIED_FLOOD")
	}
	drainProjector(t, srv)

	// 4. What that second open record did to the rung a worker was holding.
	reArmed := rungByID(t, srv, first, noAckID)
	if reArmed.State != store.TimerPending {
		t.Fatalf("state %q — expected the blind upsert to put the claimed rung back to "+
			"%q. If this now fails, D-025 has been fixed; update the decision.",
			reArmed.State, store.TimerPending)
	}
	if reArmed.FiredAt != 0 {
		t.Fatalf("fired_at %d, want 0 — the claim's evidence survived the rewrite", reArmed.FiredAt)
	}
	if reArmed.Attempts != 0 {
		t.Fatalf("attempts %d, want 0", reArmed.Attempts)
	}

	// The deadline moved out by exactly the wall time between the two reports:
	// fire_at is recomputed from the ServerReceivedAt the second record carried.
	movedTo := int64(projT0) + 15_000 + 90_000
	if reArmed.FireAt != movedTo {
		t.Fatalf("fire_at %d, want %d (base moved from %d to %d)",
			reArmed.FireAt, movedTo, projT0, projT0+15_000)
	}
	if reArmed.FireAt <= armed["NO_ACK"].FireAt {
		t.Fatal("the deadline did not move; a repeated SOS is meant to be the bug here")
	}

	// And it is due again. A rung a worker already fired is back in the queue:
	// the exclusivity FireTimer buys is exclusivity per claim, not per rung.
	due := srv.st.TimersDue(movedTo)
	found := false
	for _, tm := range due {
		if tm.ID == noAckID {
			found = true
		}
	}
	if !found {
		t.Fatalf("the re-armed rung is not due at %d: %+v", movedTo, due)
	}

	// The AUTO_QUIESCE backstop moved with it — F-02's six-hour ceiling is now
	// six hours from the LAST report, not from the first.
	if want := int64(projT0) + 15_000 + 21_600_000; rungsFor(srv, first)["AUTO_QUIESCE"].FireAt != want {
		t.Fatalf("AUTO_QUIESCE fire_at %d, want %d",
			rungsFor(srv, first)["AUTO_QUIESCE"].FireAt, want)
	}

	// The incident itself is untouched in state, which is why armTimers derived
	// the same three ids the second time: the id is a function of (incident,
	// state) and the state did not move.
	inc, _ := srv.st.Incident(first)
	if inc.State != sm.StateActiveL1Silent {
		t.Fatalf("incident state %q, want %q", inc.State, sm.StateActiveL1Silent)
	}
	if inc.ServerReceivedAt != int64(projT0)+15_000 {
		t.Fatalf("server_received_at %d, want %d", inc.ServerReceivedAt, projT0+15_000)
	}
	// The blast radius is still capped at the F-04 threshold.
	if n := len(srv.st.Incidents(testFamily)); n != floodThreshold {
		t.Fatalf("%d incidents, want %d", n, floodThreshold)
	}
}
