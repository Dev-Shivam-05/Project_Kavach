// ═══════════════════════════════════════════════════════════════════════════════
// CHARACTERIZATION — the escalation_timer row and the atomic claim (1.29, §2.8)
//
// `Store.FireTimer` is the primitive the entire no-leader escalation design rests
// on. `engine.claim()` is one line — `c.FireTimer(t.ID) == nil` — and everything
// that stops N workers fanning out the same tier N times lives on the other side
// of it. Until this file, that side was exercised by nothing: W10-e's
// `escalation/timer_test.go` proves the ENGINE prefers the transactional path and
// that the path is exclusive, but it does so against `claimingStore`, a
// hand-written double in the escalation package. The production implementation
// (store.go:918) had no test at all.
//
// So this file pins four things, in the order they can hurt:
//
//  1. The claim is exclusive and it is DURABLE. A claim that is not on disk before
//     the rung fires is not a claim — a crash between the two re-fires the rung,
//     and §2.11.5 makes the recovery of a lost rung a P0 page.
//  2. The persisted key set is the column set of migrations/0001_init.sql
//     (ADR-006, D-003). Same rule as the device table, same reason: drift is
//     invisible until migration day.
//  3. The read paths the engine's ordering depends on — Timers() sorted by
//     fire_at, TimersDue()'s three-part predicate, TimersForIncident()'s scope.
//  4. Where this store and the migration DISAGREE, on purpose or otherwise. Two
//     are recorded below: PutTimer has no state guard, and FireTimer has no
//     tenancy check. Both are pinned as they are, not fixed here.
//
// House rule for this package (RISK.md §4): assert what it does today, THEN
// change it, and let the assertion decide whether the change was compatible.
// ═══════════════════════════════════════════════════════════════════════════════
package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"testing"
)

// timerClaimer is escalation.TimerClaimer, restated. The escalation package
// imports this one, so this file cannot import it back to assert the real
// interface — but the signature is a contract either way, and `engine.claim()`
// silently falls through to the optimistic fallback if *Store stops satisfying
// it. A rename here would not fail to compile anywhere; it would just quietly
// downgrade the claim. This line is the guard.
type timerClaimer interface{ FireTimer(id string) error }

var _ timerClaimer = (*Store)(nil)

const (
	testNow  = int64(1_700_000_000_000)
	testFam  = "fam-1"
	testInc  = "inc-1"
	testWhen = testNow - 1000 // due one second ago
)

// openWithTimers is openWithFamily plus a fixed clock, so FiredAt is an
// assertable number rather than "roughly now".
func openWithTimers(t *testing.T) *Store {
	t.Helper()
	s, _ := openWithFamily(t)
	s.now = func() int64 { return testNow }
	return s
}

func sampleTimer(id string) Timer {
	return Timer{
		ID: id, FamilyID: testFam, IncidentID: testInc,
		Action: "escalate_l2", TargetTier: 2, PolicyVersion: 7,
		FireAt: testWhen, State: TimerPending, CreatedAt: testNow - 90_000,
	}
}

func mustPut(t *testing.T, s *Store, tm Timer) {
	t.Helper()
	if err := s.PutTimer(tm); err != nil {
		t.Fatalf("PutTimer(%s): %v", tm.ID, err)
	}
}

func getTimer(t *testing.T, s *Store, id string) Timer {
	t.Helper()
	for _, tm := range s.Timers() {
		if tm.ID == id {
			return tm
		}
	}
	t.Fatalf("timer %q is not in the store", id)
	return Timer{}
}

// ── the disk contract ────────────────────────────────────────────────────────

// TestEscalationTimerJSONKeysMatchTheMigration pins every persisted key of
// EscalationTimer against the column names of `CREATE TABLE escalation_timer` in
// migrations/0001_init.sql:194. Nothing else checks this pair.
//
// A NEW COLUMN IS EXPECTED TO FAIL THIS TEST — adding the entry here is the
// reviewable act, and the entry must name a column that really exists in the
// migration.
func TestEscalationTimerJSONKeysMatchTheMigration(t *testing.T) {
	want := []string{
		"action",
		"attempts",
		"created_at",
		"family_id",
		"fire_at",
		"fired_at",
		"id",
		"incident_id",
		"policy_version",
		"state",
		"target_tier",
	}

	raw, err := json.Marshal(sampleTimer("t-1"))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	got := make([]string, 0, len(decoded))
	for k := range decoded {
		got = append(got, k)
	}
	sort.Strings(got)

	if len(got) != len(want) {
		t.Fatalf("escalation_timer has %d persisted keys, expected %d — every key here\n"+
			"must be a column in migrations/0001_init.sql (RISK.md §8)\n got: %v\nwant: %v",
			len(got), len(want), got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("persisted key %d is %q, expected %q\n got: %v\nwant: %v",
				i, got[i], want[i], got, want)
		}
	}
}

// TestTimerStateValuesMatchTheMigrationCheckConstraint pins the three literals
// against `CHECK (state IN ('pending','fired','cancelled'))`. The escalation
// engine keeps its own copies of these (engine.go), so the strings are a
// three-way contract, not a two-way one.
func TestTimerStateValuesMatchTheMigrationCheckConstraint(t *testing.T) {
	for _, c := range []struct{ got, want string }{
		{TimerPending, "pending"},
		{TimerFired, "fired"},
		{TimerCancelled, "cancelled"},
	} {
		if c.got != c.want {
			t.Fatalf("timer state literal is %q, migration CHECK allows %q", c.got, c.want)
		}
	}
}

func TestPutTimerSurvivesAReopen(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := s.PutFamily(Family{ID: testFam, DisplayName: "Test"}); err != nil {
		t.Fatalf("PutFamily: %v", err)
	}
	want := sampleTimer("t-1")
	mustPut(t, s, want)

	if _, err := os.Stat(filepath.Join(dir, "escalation_timer.json")); err != nil {
		t.Fatalf("escalation_timer.json was not written: %v", err)
	}

	reopened, err := Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	rows := reopened.Timers()
	if len(rows) != 1 || rows[0] != want {
		t.Fatalf("round-trip changed the row\n got: %+v\nwant: %+v", rows, want)
	}
	// reindex() must have rebuilt timerByID, or FireTimer cannot find the row
	// after a restart — and a restart is exactly when unclaimed rungs are read.
	if err := reopened.FireTimer("t-1"); err != nil {
		t.Fatalf("FireTimer after reopen: %v — reindex did not rebuild timerByID", err)
	}
}

// ── tenancy on write ─────────────────────────────────────────────────────────

func TestPutTimerRequiresAKnownFamily(t *testing.T) {
	s := openWithTimers(t)

	noFam := sampleTimer("t-x")
	noFam.FamilyID = ""
	if err := s.PutTimer(noFam); err != ErrNoFamilyID {
		t.Fatalf("no family_id: got %v, want ErrNoFamilyID", err)
	}
	badFam := sampleTimer("t-x")
	badFam.FamilyID = "fam-nope"
	if err := s.PutTimer(badFam); err != ErrUnknownFamily {
		t.Fatalf("unknown family_id: got %v, want ErrUnknownFamily", err)
	}
	noID := sampleTimer("")
	if err := s.PutTimer(noID); err != ErrNotFound {
		t.Fatalf("no id: got %v, want ErrNotFound", err)
	}
	if got := s.Timers(); len(got) != 0 {
		t.Fatalf("a rejected write left %d rows behind", len(got))
	}
}

// TestPutTimerDefaultsStateToPending pins the defaulting that makes a row
// visible to TimersDue. `escalation.arm()` sets State explicitly, but
// `sos-ingest` and any future caller that forgets would otherwise write a row
// with state "" — which TimersDue would never return, so the rung would sit on
// disk forever and never fire. The migration says DEFAULT 'pending'; so does
// this.
func TestPutTimerDefaultsStateToPending(t *testing.T) {
	s := openWithTimers(t)
	blank := sampleTimer("t-1")
	blank.State = ""
	mustPut(t, s, blank)

	if got := getTimer(t, s, "t-1"); got.State != TimerPending {
		t.Fatalf("state defaulted to %q, want %q", got.State, TimerPending)
	}
	if due := s.TimersDue(testNow); len(due) != 1 {
		t.Fatalf("a state-less row is invisible to TimersDue: %+v", due)
	}
}

// ── the claim ────────────────────────────────────────────────────────────────

// TestFireTimerClaimsOnceAndStampsTheRow is the core of 1.29: pending → fired,
// once. The second caller must be told no, and the row it was told no about must
// be untouched by the refusal.
func TestFireTimerClaimsOnceAndStampsTheRow(t *testing.T) {
	s := openWithTimers(t)
	mustPut(t, s, sampleTimer("t-1"))

	if err := s.FireTimer("t-1"); err != nil {
		t.Fatalf("first claim: got %v, want nil", err)
	}
	got := getTimer(t, s, "t-1")
	if got.State != TimerFired {
		t.Fatalf("state = %q, want %q", got.State, TimerFired)
	}
	if got.FiredAt != testNow {
		t.Fatalf("fired_at = %d, want the store clock %d", got.FiredAt, testNow)
	}
	// Attempts is what `engine.rearm()` counts down from — it abandons a rung at
	// 3. The transactional claim is where the count comes from.
	if got.Attempts != 1 {
		t.Fatalf("attempts = %d after one claim, want 1", got.Attempts)
	}

	err := s.FireTimer("t-1")
	if err == nil {
		t.Fatal("second claim succeeded — two workers would fan out the same tier twice")
	}
	after := getTimer(t, s, "t-1")
	if after != got {
		t.Fatalf("the refused claim still mutated the row\n got: %+v\nwant: %+v", after, got)
	}
}

// TestFireTimerRefusesEveryNonPendingShape. The engine treats any non-nil error
// as "somebody else has it" and moves on, so each of these is a rung that does
// NOT fire twice.
func TestFireTimerRefusesEveryNonPendingShape(t *testing.T) {
	s := openWithTimers(t)

	cancelled := sampleTimer("t-cancelled")
	cancelled.State = TimerCancelled
	mustPut(t, s, cancelled)

	fired := sampleTimer("t-fired")
	fired.State = TimerFired
	fired.FiredAt = testNow - 5000
	mustPut(t, s, fired)

	// A row that says pending but carries a fired_at is a torn write — the two
	// columns disagree, and FireTimer refuses rather than picking the optimistic
	// reading. `TimersDue` applies the same two-part predicate.
	torn := sampleTimer("t-torn")
	torn.FiredAt = testNow - 5000
	mustPut(t, s, torn)

	for _, id := range []string{"t-cancelled", "t-fired", "t-torn"} {
		before := getTimer(t, s, id)
		if err := s.FireTimer(id); err == nil {
			t.Fatalf("FireTimer(%s) succeeded on a non-claimable row", id)
		}
		if after := getTimer(t, s, id); after != before {
			t.Fatalf("refused FireTimer(%s) mutated the row\n got: %+v\nwas: %+v", id, after, before)
		}
	}

	if err := s.FireTimer("t-nope"); err != ErrNotFound {
		t.Fatalf("unknown id: got %v, want ErrNotFound", err)
	}
}

// TestFireTimerIsExclusiveUnderConcurrency is the property the whole design
// buys: N workers, one row, one winner, nobody blocked into a queue behind the
// winner. Note this passes WITHOUT the race detector on this machine (no gcc);
// exclusivity is proven here, race-freedom is CI gate 3's job.
func TestFireTimerIsExclusiveUnderConcurrency(t *testing.T) {
	s := openWithTimers(t)
	mustPut(t, s, sampleTimer("t-1"))

	const workers = 16
	var (
		wg   sync.WaitGroup
		mu   sync.Mutex
		wins int
	)
	start := make(chan struct{})
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if err := s.FireTimer("t-1"); err == nil {
				mu.Lock()
				wins++
				mu.Unlock()
			}
		}()
	}
	close(start)
	wg.Wait()

	if wins != 1 {
		t.Fatalf("%d of %d workers claimed the same timer, want exactly 1", wins, workers)
	}
	if got := getTimer(t, s, "t-1"); got.Attempts != 1 {
		t.Fatalf("attempts = %d after %d racing claims, want 1", got.Attempts, workers)
	}
}

// TestFireTimerPersistsTheClaimBeforeItReturns. The claim is durable or it is
// not a claim. If FireTimer returned nil with the row still only in memory, a
// crash between the claim and the fan-out would leave a pending rung on disk
// that a restarted worker fires again — the family woken twice for one
// incident, and §2.11.5's overdue-timer page firing for a rung that did run.
func TestFireTimerPersistsTheClaimBeforeItReturns(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := s.PutFamily(Family{ID: testFam, DisplayName: "Test"}); err != nil {
		t.Fatalf("PutFamily: %v", err)
	}
	s.now = func() int64 { return testNow }
	mustPut(t, s, sampleTimer("t-1"))
	if err := s.FireTimer("t-1"); err != nil {
		t.Fatalf("claim: %v", err)
	}

	// Reopen from the same directory: this is the crashed-worker's successor.
	reopened, err := Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	got := getTimer(t, reopened, "t-1")
	if got.State != TimerFired || got.FiredAt != testNow || got.Attempts != 1 {
		t.Fatalf("the claim did not reach disk: %+v", got)
	}
	if due := reopened.TimersDue(testNow); len(due) != 0 {
		t.Fatalf("a restarted worker would re-fire %d claimed rung(s): %+v", len(due), due)
	}
	if err := reopened.FireTimer("t-1"); err == nil {
		t.Fatal("a restarted worker re-claimed an already-fired rung")
	}
}

// ── the read paths the engine's ordering depends on ──────────────────────────

// TestTimersAreSortedByFireAtOldestFirst. `engine.pollOnce` fires the batch in
// the order this returns it, and the batch limit DEFERS the tail rather than
// dropping it — both of which are only correct if the oldest rung is first.
func TestTimersAreSortedByFireAtOldestFirst(t *testing.T) {
	s := openWithTimers(t)
	for _, spec := range []struct {
		id string
		at int64
	}{
		{"t-late", testNow + 60_000},
		{"t-early", testNow - 60_000},
		{"t-mid", testNow - 1_000},
	} {
		tm := sampleTimer(spec.id)
		tm.FireAt = spec.at
		mustPut(t, s, tm)
	}

	want := []string{"t-early", "t-mid", "t-late"}
	got := s.Timers()
	if len(got) != len(want) {
		t.Fatalf("Timers() returned %d rows, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i].ID != want[i] {
			t.Fatalf("Timers()[%d] = %q, want %q (fire_at order)", i, got[i].ID, want[i])
		}
	}

	// TimersDue inherits the order and cuts the future off.
	due := s.TimersDue(testNow)
	if len(due) != 2 || due[0].ID != "t-early" || due[1].ID != "t-mid" {
		t.Fatalf("TimersDue(now) = %+v, want t-early then t-mid", due)
	}
}

// TestTimersDueRequiresAllThreeConditions pins the predicate literally: pending,
// unfired, and at or before `at`. Each of the three is a rung that must not fire.
func TestTimersDueRequiresAllThreeConditions(t *testing.T) {
	s := openWithTimers(t)

	mustPut(t, s, sampleTimer("t-due"))

	future := sampleTimer("t-future")
	future.FireAt = testNow + 1
	mustPut(t, s, future)

	cancelled := sampleTimer("t-cancelled")
	cancelled.State = TimerCancelled
	mustPut(t, s, cancelled)

	fired := sampleTimer("t-fired")
	fired.State = TimerFired
	fired.FiredAt = testNow - 1
	mustPut(t, s, fired)

	due := s.TimersDue(testNow)
	if len(due) != 1 || due[0].ID != "t-due" {
		t.Fatalf("TimersDue(now) = %+v, want only t-due", due)
	}
	// The boundary is inclusive: a rung due exactly now is due now, not next tick.
	if due := s.TimersDue(testNow + 1); len(due) != 2 {
		t.Fatalf("fire_at == at is not due — TimersDue(%d) = %+v", testNow+1, due)
	}
}

// TestTimersForIncidentIsScopedAndReturnsEveryState. `cancelTimers` reads
// through this and filters on state itself; if the store filtered here too, the
// check would happen twice in one place and nowhere in the other. Same division
// of labour as Devices() and RevokedAt.
func TestTimersForIncidentIsScopedAndReturnsEveryState(t *testing.T) {
	s := openWithTimers(t)

	mine := sampleTimer("t-mine")
	mustPut(t, s, mine)

	claimed := sampleTimer("t-claimed")
	claimed.State = TimerFired
	claimed.FiredAt = testNow - 1
	mustPut(t, s, claimed)

	other := sampleTimer("t-other")
	other.IncidentID = "inc-2"
	mustPut(t, s, other)

	rows := s.TimersForIncident(testInc)
	if len(rows) != 2 {
		t.Fatalf("TimersForIncident(%q) = %+v, want the 2 rows of that incident", testInc, rows)
	}
	var sawFired bool
	for _, r := range rows {
		if r.IncidentID != testInc {
			t.Fatalf("TimersForIncident leaked a row from %q", r.IncidentID)
		}
		if r.State == TimerFired {
			sawFired = true
		}
	}
	if !sawFired {
		t.Fatal("TimersForIncident hid the claimed row — cancelTimers reads through this")
	}
	if none := s.TimersForIncident("inc-nope"); len(none) != 0 {
		t.Fatalf("TimersForIncident on an unknown incident returned %+v", none)
	}
}

// ── the mutex is not decorative ──────────────────────────────────────────────

func TestTimerRowsCrossTheBoundaryByValue(t *testing.T) {
	s := openWithTimers(t)
	mustPut(t, s, sampleTimer("t-1"))

	for _, read := range []struct {
		name string
		rows func() []Timer
	}{
		{"Timers", func() []Timer { return s.Timers() }},
		{"TimersDue", func() []Timer { return s.TimersDue(testNow) }},
		{"TimersForIncident", func() []Timer { return s.TimersForIncident(testInc) }},
	} {
		rows := read.rows()
		if len(rows) == 0 {
			t.Fatalf("%s() returned nothing", read.name)
		}
		rows[0].State = TimerCancelled
		rows[0].FiredAt = 42

		fresh := getTimer(t, s, "t-1")
		if fresh.State != TimerPending || fresh.FiredAt != 0 {
			t.Fatalf("mutating a row from %s() reached the stored row: %+v", read.name, fresh)
		}
	}
}

// ── where this store and the migration disagree ──────────────────────────────

// TestPutTimerHasNoStateGuardAndOverwritesAClaimedRow.
//
// CHARACTERIZATION OF A HAZARD, NOT AN ENDORSEMENT. PutTimer is a blind upsert:
// `*old = t`, every column, no guard on the current state. Re-putting a row that
// has already fired resets it to pending, zeroes fired_at AND zeroes attempts —
// and if fire_at is in the past, the row is immediately due again.
//
// That is load-bearing in one direction: `engine.cancelTimers` reads the row,
// flips pending → cancelled and writes it straight back, so a guard here would
// have to allow that edge. And it is dangerous in the other: `sos-ingest`'s
// `armTimers` (main.go:1019) builds its IDs deterministically as
// `incident|state|action`, and `projectOpen` calls it for an incident that
// ALREADY EXISTS without advancing its state. Bus redelivery is not the way in —
// `project()` dedupes on (incident, hlc) at main.go:882 — but F-04 coalescing
// is: the 4th unverified open from a family inside 60 s is rewritten onto the
// FIRST incident's id carrying its own fresh hlc, so it passes both dedupes and
// re-arms that incident's current rungs, with `base` taken from a
// `ServerReceivedAt` that line 942 has just moved forward.
//
// This test does not claim that path fires; it pins the store half that would
// let it, so the day somebody guards PutTimer they find out here which caller
// they broke. The sos-ingest half is read, not proven, and belongs in a test of
// its own (cmd/sos-ingest has zero tests, RISK.md §4).
func TestPutTimerHasNoStateGuardAndOverwritesAClaimedRow(t *testing.T) {
	s := openWithTimers(t)
	mustPut(t, s, sampleTimer("t-1"))
	if err := s.FireTimer("t-1"); err != nil {
		t.Fatalf("claim: %v", err)
	}
	if due := s.TimersDue(testNow); len(due) != 0 {
		t.Fatalf("claimed rung is still due: %+v", due)
	}

	// The same row an armTimers re-run would write: same ID, same past fire_at,
	// pending, attempts 0.
	mustPut(t, s, sampleTimer("t-1"))

	got := getTimer(t, s, "t-1")
	if got.State != TimerPending || got.FiredAt != 0 || got.Attempts != 0 {
		t.Fatalf("PutTimer grew a state guard: %+v\n"+
			"If that was deliberate, check engine.cancelTimers and sos-ingest.armTimers "+
			"before deleting this test", got)
	}
	if due := s.TimersDue(testNow); len(due) != 1 {
		t.Fatalf("expected the resurrected rung to be due again, got %+v", due)
	}
	if err := s.FireTimer("t-1"); err != nil {
		t.Fatalf("a claimed-then-overwritten rung refused a second claim: %v", err)
	}

	// And the one direction that MUST keep working: cancelTimers' read-flip-write.
	cancel := getTimer(t, s, "t-1")
	cancel.State = TimerCancelled
	mustPut(t, s, cancel)
	if got := getTimer(t, s, "t-1"); got.State != TimerCancelled {
		t.Fatalf("cancelTimers' write no longer lands: %+v", got)
	}
}

// TestFireTimerDoesNotCheckTenancy. The migration puts escalation_timer behind
// `CREATE POLICY family_isolation ... USING (family_id = app.family_id)`
// (0001_init.sql:433), so on Postgres this claim is tenant-scoped by the
// database. Here it is keyed by id alone: hold the id, claim the row, whatever
// family it belongs to. Not reachable today — the engine only ever passes ids it
// just read from this same store — but it is a real difference between the two
// backends, and migration day is the wrong time to discover it.
func TestFireTimerDoesNotCheckTenancy(t *testing.T) {
	s := openWithTimers(t)
	if err := s.PutFamily(Family{ID: "fam-2", DisplayName: "Other"}); err != nil {
		t.Fatalf("PutFamily: %v", err)
	}
	theirs := sampleTimer("t-theirs")
	theirs.FamilyID = "fam-2"
	mustPut(t, s, theirs)

	if err := s.FireTimer("t-theirs"); err != nil {
		t.Fatalf("FireTimer grew a tenancy check: %v — that is an improvement, but "+
			"engine.claim() reports it as 'somebody else has it' and skips the rung "+
			"silently. Give it a distinguishable error before you keep it", err)
	}
}
