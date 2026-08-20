// ═══════════════════════════════════════════════════════════════════════════════
// THE SEAM — one directory, many processes (D-027 · ADR-007 · docs/RISK.md 17)
//
// This file used to characterize the opposite. Written in W10-h, it pinned the
// bus as in-process: a second *Bus on the same directory received nothing, and
// two instances wrote every record at the same offset and overwrote each other.
// Its own comment said the day somebody made the bus real, these tests should
// fail and say which sentence stopped being true. They did, both of them:
//
//	crossprocess_test.go:116: the second instance received "i-sos" — the bus has
//	  become cross-process, which is what D-026's fix needs
//	crossprocess_test.go:155: seq 1 and 2 — the two instances no longer collide
//	  on sequence numbers
//
// So this is the same file, inverted, with the control test unchanged.
//
// TestTwoRealProcessesOnOneBusDirectory is new and is the one that matters.
// D-027 was measured with two *Bus values inside one test binary, and recorded
// honestly that containers behaving the same way was an inference. It is not an
// inference any more: that test re-executes this binary as a second OS process,
// publishes an incident from it, and waits for a durable subscriber in THIS
// process to be handed it.
// ═══════════════════════════════════════════════════════════════════════════════

package bus

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// settle is six poll intervals. drain() runs on a 250 ms ticker, so a message
// that has not arrived by now is not late, it is absent.
const settle = 6 * pollInterval

func openAt(t *testing.T, dir string) *Bus {
	t.Helper()
	b, err := Open(dir)
	if err != nil {
		t.Fatalf("open %s: %v", dir, err)
	}
	// Registered rather than deferred by each test: a t.Fatalf must not leave the
	// stream file open, or TempDir cleanup fails on Windows and hides the real
	// failure behind an unlink error.
	t.Cleanup(func() { _ = b.Close() })
	return b
}

func incidentMsg(id, who string) Msg {
	return Msg{
		Subject: "fam.f-test.incident", Kind: KindIncidentOpen,
		IncidentID: id, HLC: "hlc-" + id, Data: []byte(`{"published_by":"` + who + `"}`),
	}
}

// subscribeInto returns a channel fed by a durable subscription.
func subscribeInto(t *testing.T, b *Bus, durable string) chan Msg {
	t.Helper()
	got := make(chan Msg, 8)
	if _, err := b.SubscribeDurable(durable, "fam.*.incident", StartAll, func(m Msg) error {
		got <- m
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return got
}

// ── the control: one instance delivers to its own subscribers ────────────────

// TestOneInstanceDeliversToItsOwnSubscriber is here so that a failure in the
// next test cannot be read as "the harness never worked". Same directory, same
// subject, same handler — the only difference is which *Bus published.
//
// It also pins something the D-027 work could have quietly broken: a publisher
// reads its own record back inside publish, so an in-process subscriber is
// still woken immediately rather than on the next 250 ms tick.
func TestOneInstanceDeliversToItsOwnSubscriber(t *testing.T) {
	b := openAt(t, t.TempDir())
	got := subscribeInto(t, b, "reader")

	if _, err := b.PublishMsg(incidentMsg("i-same", "self")); err != nil {
		t.Fatal(err)
	}

	select {
	case m := <-got:
		if m.IncidentID != "i-same" {
			t.Fatalf("delivered %q, want i-same", m.IncidentID)
		}
	case <-time.After(settle):
		t.Fatal("a subscriber did not receive a message published on its own bus")
	}
}

// ── D-027 · the seam is a seam ───────────────────────────────────────────────

// TestASecondInstanceOnTheSameDirectoryReceivesTheFirsts is the compose
// topology in miniature: sos-ingest and control-plane, KAVACH_BUS_DIR pointed at
// one directory, one publishing an incident and the other subscribed to
// fam.*.incident and waiting for it.
//
// Before OpenShared it never arrived — not late, absent — and that was the
// transport half of D-026: even after cmd/control-plane grew a subscriber, an
// incident published by the other binary could not reach it.
func TestASecondInstanceOnTheSameDirectoryReceivesTheFirsts(t *testing.T) {
	dir := t.TempDir()
	ingest := openAt(t, dir) // stands in for cmd/sos-ingest
	plane := openAt(t, dir)  // stands in for cmd/control-plane

	got := subscribeInto(t, plane, "control-plane.incidents")

	if _, err := ingest.PublishMsg(incidentMsg("i-sos", "sos-ingest")); err != nil {
		t.Fatal(err)
	}

	select {
	case m := <-got:
		if m.IncidentID != "i-sos" {
			t.Fatalf("delivered %q, want i-sos", m.IncidentID)
		}
		if m.Kind != KindIncidentOpen {
			t.Fatalf("kind %q, want %q", m.Kind, KindIncidentOpen)
		}
	case <-time.After(settle):
		t.Fatal("the second instance never received the incident the first published")
	}
}

// TestTwoInstancesDoNotOverwriteEachOthersRecords is the part that made D-027
// an S1 rather than a wiring gap.
//
// The write offset used to be decided at Open and advanced only by that
// instance's own appends, so two instances that opened before either wrote held
// the SAME offset and WriteAt put both records there. In the deployed topology
// the record that got erased was the incident sos-ingest fsynced and acked to a
// frightened person's phone.
func TestTwoInstancesDoNotOverwriteEachOthersRecords(t *testing.T) {
	dir := t.TempDir()
	ingest := openAt(t, dir)
	plane := openAt(t, dir)

	seqIngest, err := ingest.PublishMsg(incidentMsg("i-sos", "sos-ingest"))
	if err != nil {
		t.Fatal(err)
	}
	seqPlane, err := plane.PublishMsg(incidentMsg("i-cp", "control-plane"))
	if err != nil {
		t.Fatal(err)
	}
	if seqIngest == 0 || seqPlane == 0 {
		t.Fatalf("seq %d and %d — a publisher could not find its own record in the file", seqIngest, seqPlane)
	}
	if seqIngest == seqPlane {
		t.Fatalf("both records were given seq %d — two writers are colliding again", seqIngest)
	}

	// Reopen the directory the way a restarted process would.
	after := openAt(t, dir)
	var survivors []string
	if err := after.Replay("fam.>", 0, func(m Msg) error {
		survivors = append(survivors, m.IncidentID)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(survivors) != 2 || survivors[0] != "i-sos" || survivors[1] != "i-cp" {
		t.Fatalf("survivors = %v, want [i-sos i-cp]: both records were written and both must be there",
			survivors)
	}
}

// TestSeqIsThePositionInTheFileNotAPerInstanceCounter — Seq is a shared name for
// a record, because a cursor is a Seq and cursors are compared across restarts
// and across processes. Two instances must not have two names for one record.
func TestSeqIsThePositionInTheFileNotAPerInstanceCounter(t *testing.T) {
	dir := t.TempDir()
	first := openAt(t, dir)
	second := openAt(t, dir)

	for i := 0; i < 3; i++ {
		src, tag := first, "first"
		if i%2 == 1 {
			src, tag = second, "second"
		}
		if _, err := src.PublishSync(incidentMsg(fmt.Sprintf("i-%d", i), tag)); err != nil {
			t.Fatal(err)
		}
	}

	seqs := func(b *Bus) map[string]uint64 {
		out := map[string]uint64{}
		if err := b.Replay("fam.>", 0, func(m Msg) error {
			out[m.IncidentID] = m.Seq
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		return out
	}
	a, c := seqs(first), seqs(second)
	if len(a) != 3 {
		t.Fatalf("first sees %v, want three records", a)
	}
	for id, seq := range a {
		if c[id] != seq {
			t.Fatalf("%s is seq %d to one instance and %d to the other", id, seq, c[id])
		}
	}
}

// TestADurableCursorIsNotErasedByAnotherProcess — cursors.json is shared. Each
// process holds a copy loaded at Open, so writing that whole copy back resets
// every durable it does not own to where it stood at boot. For control-plane's
// incidents durable that means replaying a resolved incident and re-arming a
// ladder somebody already climbed.
func TestADurableCursorIsNotErasedByAnotherProcess(t *testing.T) {
	dir := t.TempDir()
	ingest := openAt(t, dir)
	plane := openAt(t, dir)

	ingestSub := subscribeInto(t, ingest, "sos-ingest.projector")
	planeSub := subscribeInto(t, plane, "control-plane.incidents")

	if _, err := ingest.PublishSync(incidentMsg("i-1", "sos-ingest")); err != nil {
		t.Fatal(err)
	}
	for _, ch := range []chan Msg{ingestSub, planeSub} {
		select {
		case <-ch:
		case <-time.After(settle):
			t.Fatal("an incident was not delivered to both processes' durables")
		}
	}
	if !plane.subs[0].Drain(settle) || !ingest.subs[0].Drain(settle) {
		t.Fatal("a durable did not catch up with the stream")
	}
	plane.writeCursors()
	ingest.writeCursors()

	raw, err := os.ReadFile(filepath.Join(dir, "cursors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var saved map[string]uint64
	if err := json.Unmarshal(raw, &saved); err != nil {
		t.Fatal(err)
	}
	if saved["control-plane.incidents"] == 0 || saved["sos-ingest.projector"] == 0 {
		t.Fatalf("cursors.json = %v, want both durables recorded: the last writer erased the other", saved)
	}
}

// TestClassAPrimeNeverReachesTheFile guards §2.4.6 across the D-027 rewrite. The
// write path changed; the rule that precise coordinates are never written did
// not, and a durable subscriber must not be able to receive one even by mistake.
func TestClassAPrimeNeverReachesTheFile(t *testing.T) {
	dir := t.TempDir()
	b := openAt(t, dir)
	got := subscribeInto(t, b, "durable")

	precise := Msg{Subject: "fam.f-test.incident", Kind: KindLocationPrecise, IncidentID: "i-1", HLC: "h1"}
	if _, err := b.PublishMsg(precise); err != ErrClassAPrime {
		t.Fatalf("PublishMsg(location_precise) = %v, want ErrClassAPrime", err)
	}
	if n := b.PublishEphemeral(precise); n != 0 {
		t.Fatalf("PublishEphemeral delivered to %d durable-only subscribers", n)
	}

	select {
	case m := <-got:
		t.Fatalf("a durable subscriber received %q", m.Kind)
	case <-time.After(2 * pollInterval):
	}

	st, err := os.Stat(filepath.Join(dir, "stream.wal"))
	if err != nil {
		t.Fatal(err)
	}
	if st.Size() != 8 {
		t.Fatalf("stream.wal is %d bytes, want 8 (header only): a Class A′ record was written", st.Size())
	}
}

// ── two real OS processes ───────────────────────────────────────────────────

const helperEnv = "KAVACH_BUS_PUBLISH_HELPER"

// TestBusPublishHelperProcess is not a test. It is the other container: go test
// re-executes this binary with -test.run pointing here, and the env var carries
// the bus directory. Without it, it skips.
func TestBusPublishHelperProcess(t *testing.T) {
	dir := os.Getenv(helperEnv)
	if dir == "" {
		t.Skip("helper process for TestTwoRealProcessesOnOneBusDirectory")
	}
	b, err := Open(dir)
	if err != nil {
		t.Fatalf("helper open: %v", err)
	}
	if _, err := b.PublishSync(incidentMsg("i-from-another-process", "helper")); err != nil {
		t.Fatalf("helper publish: %v", err)
	}
	if err := b.Close(); err != nil {
		t.Fatalf("helper close: %v", err)
	}
}

// TestTwoRealProcessesOnOneBusDirectory is ops/docker-compose.yml, with the
// container boundary replaced by a process boundary rather than by an argument.
// A second OS process opens the same KAVACH_BUS_DIR, publishes one incident and
// exits; a durable subscriber in this process must be handed it.
//
// This is the claim D-027 could not make, and the reason RISK 17 could not be
// closed on the strength of the tests that were there.
func TestTwoRealProcessesOnOneBusDirectory(t *testing.T) {
	dir := t.TempDir()
	plane := openAt(t, dir) // stands in for cmd/control-plane
	got := subscribeInto(t, plane, "control-plane.incidents")

	helper := exec.Command(os.Args[0], "-test.run=^TestBusPublishHelperProcess$")
	helper.Env = append(os.Environ(), helperEnv+"="+dir)
	var out strings.Builder
	helper.Stdout, helper.Stderr = &out, &out
	if err := helper.Run(); err != nil {
		// Windows Application Control refuses to launch a binary out of the
		// go-build temp tree (CLAUDE.md). That is the OS, not this code:
		//
		//	go test -c -o .gotmp/bus.test.exe ./internal/bus/
		//	./.gotmp/bus.test.exe -test.run=TestTwoRealProcessesOnOneBusDirectory
		//
		// Skipped only for that one refusal. On Linux, and so in CI, it runs.
		if strings.Contains(err.Error(), "Application Control policy") {
			t.Skipf("cannot re-exec the test binary on this machine: %v", err)
		}
		t.Fatalf("helper process failed: %v\n%s", err, out.String())
	}

	select {
	case m := <-got:
		if m.IncidentID != "i-from-another-process" {
			t.Fatalf("delivered %q, want the helper's incident", m.IncidentID)
		}
	case <-time.After(4 * settle):
		t.Fatal("an incident published by another OS process was never delivered")
	}
}
