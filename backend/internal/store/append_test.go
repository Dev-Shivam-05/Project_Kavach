// ═══════════════════════════════════════════════════════════════════════════════
// CHARACTERIZATION — the two append-only tables under a failed persist (I-4)
//
// AppendEvent and AppendAccess are the accountability record. Both used to mark
// the row in memory BEFORE persisting it, so a persist that failed returned the
// error to the caller — and then answered every retry with "duplicate", because
// the dedupe key was already set. The bus cursor advanced past a row that lived
// only in this process's heap. This file pins the corrected contract: an append
// whose persist fails leaves NO trace, and the very next append of the same row
// writes it.
//
// The failure is induced by putting a DIRECTORY where the table file goes, so
// the atomic rename at the end of persist() fails on every platform this repo
// is tested on. It is the same mechanism as an unwritable volume without the
// chmod games that do not work on Windows.
// ═══════════════════════════════════════════════════════════════════════════════
package store

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// breakTable makes persist(name) fail until fixTable is called.
func breakTable(t *testing.T, dir, name string) {
	t.Helper()
	path := filepath.Join(dir, name+".json")
	_ = os.Remove(path)
	if err := os.Mkdir(path, 0o755); err != nil {
		t.Fatal(err)
	}
}

func fixTable(t *testing.T, dir, name string) {
	t.Helper()
	if err := os.Remove(filepath.Join(dir, name+".json")); err != nil {
		t.Fatal(err)
	}
}

func TestAppendEventRollsBackWhenPersistFailsSoTheRetryIsNotADuplicate(t *testing.T) {
	s, famID := openWithFamily(t)
	dir := s.Dir()
	ev := Event{IncidentID: "inc-1", FamilyID: famID, HLC: "0000000000010000aabbccdd", EventType: "MANUAL_TRIGGER"}

	breakTable(t, dir, tIncidentEvent)
	if err := s.AppendEvent(ev); err == nil {
		t.Fatal("AppendEvent reported success while the table could not be written")
	}
	if s.HasEvent(ev.IncidentID, ev.HLC) {
		t.Fatal("the dedupe key survived a failed persist — every retry would now be a silent 'dup'")
	}
	if n := len(s.Events(ev.IncidentID)); n != 0 {
		t.Fatalf("%d event rows in memory after a failed persist, want 0", n)
	}

	fixTable(t, dir, tIncidentEvent)
	if err := s.AppendEvent(ev); err != nil {
		t.Fatalf("the retry did not write the row: %v", err)
	}
	rows := s.Events(ev.IncidentID)
	if len(rows) != 1 || rows[0].ID != 1 {
		t.Fatalf("rows after retry = %+v, want exactly one with id 1", rows)
	}
	// And it is on disk, not just in memory: a reopen sees it.
	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !reopened.HasEvent(ev.IncidentID, ev.HLC) {
		t.Fatal("the retried row did not reach disk")
	}
}

func TestAppendAccessRollsBackWhenPersistFails(t *testing.T) {
	s, famID := openWithFamily(t)
	dir := s.Dir()
	a := Access{FamilyID: famID, AccessorMemberID: "m-a", SubjectMemberID: "m-b", What: "read live_location", At: 1}

	breakTable(t, dir, tAccessLog)
	if _, err := s.AppendAccessID(a); err == nil {
		t.Fatal("AppendAccessID reported success while the table could not be written")
	}
	if n := len(s.AccessLog(famID)); n != 0 {
		t.Fatalf("%d access rows in memory after a failed persist, want 0", n)
	}
	fixTable(t, dir, tAccessLog)
	id, err := s.AppendAccessID(a)
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	if id != 1 {
		t.Fatalf("id after a rolled-back attempt = %d, want 1 (the failed attempt must not burn an id)", id)
	}
}

func TestAppendAccessIDReturnsTheRowItWrote(t *testing.T) {
	s, famID := openWithFamily(t)
	first, err := s.AppendAccessID(Access{FamilyID: famID, AccessorMemberID: "m-a", SubjectMemberID: "m-b", At: 1})
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.AppendAccessID(Access{FamilyID: famID, AccessorMemberID: "m-c", SubjectMemberID: "m-b", At: 2})
	if err != nil {
		t.Fatal(err)
	}
	if first != 1 || second != 2 {
		t.Fatalf("ids = %d, %d; want 1, 2", first, second)
	}
	for _, row := range s.AccessLog(famID) {
		if row.ID == second && row.AccessorMemberID != "m-c" {
			t.Fatalf("id %d names the wrong row: %+v", second, row)
		}
	}
}

func TestMarkAccessSurfacedFlipsOnlyTheNamedRowsAndPersists(t *testing.T) {
	s, famID := openWithFamily(t)
	var ids []int64
	for i := 0; i < 3; i++ {
		id, err := s.AppendAccessID(Access{FamilyID: famID, AccessorMemberID: "m-a", SubjectMemberID: "m-b", At: int64(i)})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	if err := s.MarkAccessSurfaced(famID, ids[:2]); err != nil {
		t.Fatal(err)
	}
	// Idempotent: a redelivery of the same ids changes nothing and fails nothing.
	if err := s.MarkAccessSurfaced(famID, ids[:2]); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(s.Dir())
	if err != nil {
		t.Fatal(err)
	}
	surfaced := map[int64]bool{}
	for _, row := range reopened.AccessLog(famID) {
		surfaced[row.ID] = row.SurfacedToSubject
	}
	if !surfaced[ids[0]] || !surfaced[ids[1]] || surfaced[ids[2]] {
		t.Fatalf("surfaced_to_subject after reopen = %v, want first two true and the third false", surfaced)
	}
}

func TestUpdateIncidentRunsOnTheCurrentRowAndRefusesWhenTheMutatorDoes(t *testing.T) {
	s, famID := openWithFamily(t)
	if err := s.PutIncident(Incident{ID: "inc-1", FamilyID: famID, State: "ACTIVE_L1", Inc8: "abc"}); err != nil {
		t.Fatal(err)
	}
	stale := errors.New("row moved")
	got, err := s.UpdateIncident("inc-1", func(row *Incident) error {
		if row.State != "OWNED" {
			return stale
		}
		return nil
	})
	if !errors.Is(err, stale) {
		t.Fatalf("err = %v, want the mutator's refusal", err)
	}
	if got.State != "ACTIVE_L1" {
		t.Fatalf("a refused update returned %q, want the row as found", got.State)
	}

	got, err = s.UpdateIncident("inc-1", func(row *Incident) error {
		row.State = "OWNED"
		row.OwnerMemberID = "m-rohan"
		row.Inc8 = "xyz"
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.State != "OWNED" || got.OwnerMemberID != "m-rohan" {
		t.Fatalf("returned row = %+v, want the mutated one", got)
	}
	// The inc8 index follows the row, exactly as PutIncident keeps it.
	if _, ok := s.IncidentByInc8(famID, "abc"); ok {
		t.Fatal("the old inc8 still resolves after the row moved off it")
	}
	if inc, ok := s.IncidentByInc8(famID, "xyz"); !ok || inc.ID != "inc-1" {
		t.Fatal("the new inc8 does not resolve")
	}
	if _, err := s.UpdateIncident("nope", func(*Incident) error { return nil }); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown id: err = %v, want ErrNotFound", err)
	}
	reopened, err := Open(s.Dir())
	if err != nil {
		t.Fatal(err)
	}
	if inc, _ := reopened.Incident("inc-1"); inc.State != "OWNED" {
		t.Fatalf("state after reopen = %q, want OWNED", inc.State)
	}
}
