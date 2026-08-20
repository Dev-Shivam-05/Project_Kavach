// ═══════════════════════════════════════════════════════════════════════════════
// CHARACTERIZATION — the bus is in-process, and the deployment assumes it is not
// (ADR-002 · §2.5.1 · docs/DECISIONS.md D-026, D-027)
//
// internal/bus had zero tests (docs/RISK.md item 4). This is its first, and it
// exists because D-026 asked "why does no escalation rung fire for an SOS" and
// the answer turned out to be one layer below the one D-026 named.
//
// ops/docker-compose.yml:60 says, in a comment, that the file-backed bus "stands
// in for NATS JetStream" and that "all four processes read and write ONE
// directory — that shared directory IS the seam between sos-ingest and
// everything downstream". Every line of that is load-bearing for the topology:
// sos-ingest publishes an incident, the control plane climbs the ladder, the
// gateway pushes the frame, the canary watches. None of it is true.
//
// Open() reads stream.wal ONCE, into b.msgs (bus.go:113). publish() appends to
// this instance's file handle and to this instance's slice (bus.go:190). drain()
// walks that slice and nothing else (bus.go:425). No code path re-reads the file
// after boot, so a second process pointed at the same directory is not a peer —
// it is a separate stream that happens to share a filename.
//
// ★ Nothing here is a new requirement. ★ These assertions state what the code at
// HEAD does. They are written so that the day somebody makes the bus real —
// NATS, a tailing reader, or a single-writer broker — these tests fail and say
// exactly which sentence stopped being true.
// ═══════════════════════════════════════════════════════════════════════════════

package bus

import (
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
	return b
}

func incidentMsg(id, who string) Msg {
	return Msg{
		Subject: "fam.f-test.incident", Kind: KindIncidentOpen,
		IncidentID: id, HLC: "hlc-" + id, Data: []byte(`{"published_by":"` + who + `"}`),
	}
}

// ── the control: one instance delivers to its own subscribers ────────────────

// TestOneInstanceDeliversToItsOwnSubscriber is here so that the failure in the
// next test cannot be read as "the harness never worked". Same directory, same
// subject, same handler — the only difference is which *Bus published.
func TestOneInstanceDeliversToItsOwnSubscriber(t *testing.T) {
	b := openAt(t, t.TempDir())
	defer b.Close()

	got := make(chan Msg, 1)
	if _, err := b.SubscribeDurable("reader", "fam.*.incident", StartAll, func(m Msg) error {
		got <- m
		return nil
	}); err != nil {
		t.Fatal(err)
	}
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

// ── D-027 · the seam is not a seam ───────────────────────────────────────────

// TestASecondInstanceOnTheSameDirectoryNeverSeesTheFirst is the compose
// topology in miniature: sos-ingest and control-plane, KAVACH_BUS_DIR pointed at
// one directory, one publishing an incident and the other subscribed to
// fam.*.incident and waiting for it.
//
// It never arrives. This is the transport half of D-026: even after
// cmd/control-plane grows a subscriber, an incident published by the other
// binary cannot reach it, because nothing tails the file.
func TestASecondInstanceOnTheSameDirectoryNeverSeesTheFirst(t *testing.T) {
	dir := t.TempDir()
	ingest := openAt(t, dir) // stands in for cmd/sos-ingest
	defer ingest.Close()
	plane := openAt(t, dir) // stands in for cmd/control-plane
	defer plane.Close()

	got := make(chan Msg, 1)
	if _, err := plane.SubscribeDurable("control-plane.incidents", "fam.*.incident", StartAll, func(m Msg) error {
		got <- m
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := ingest.PublishMsg(incidentMsg("i-sos", "sos-ingest")); err != nil {
		t.Fatal(err)
	}

	select {
	case m := <-got:
		t.Fatalf("the second instance received %q — the bus has become cross-process, "+
			"which is what D-026's fix needs; delete this test and re-read D-027", m.IncidentID)
	case <-time.After(settle):
		// The characterized behaviour: nothing, ever.
	}
	if plane.LastSeq() != 0 {
		t.Fatalf("plane.LastSeq() = %d, want 0 — it has not learned of any message", plane.LastSeq())
	}
	if ingest.LastSeq() != 1 {
		t.Fatalf("ingest.LastSeq() = %d, want 1 — it published one", ingest.LastSeq())
	}
}

// TestTwoInstancesOverwriteEachOthersRecords is the part that makes D-027 an S1
// rather than a wiring gap.
//
// The write offset is decided at Open (wal.go:75, w.size = st.Size()) and then
// advanced only by this instance's own appends (wal.go:180). Two instances that
// opened before either wrote therefore hold the SAME offset, and WriteAt puts
// both records there. w.mu is an in-process mutex and does not know the other
// exists; there is no O_APPEND and no file lock.
//
// So the second publisher does not append after the first — it lands on top of
// it. In the deployed topology the record that gets overwritten is the incident
// sos-ingest fsynced and acked to a frightened person's phone.
func TestTwoInstancesOverwriteEachOthersRecords(t *testing.T) {
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
	if seqIngest != seqPlane {
		t.Fatalf("seq %d and %d — the two instances no longer collide on sequence numbers", seqIngest, seqPlane)
	}
	if err := ingest.Close(); err != nil {
		t.Fatal(err)
	}
	if err := plane.Close(); err != nil {
		t.Fatal(err)
	}

	// Reopen the directory the way a restarted process would.
	after := openAt(t, dir)
	defer after.Close()

	var survivors []string
	if err := after.Replay("fam.>", 0, func(m Msg) error {
		survivors = append(survivors, m.IncidentID)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(survivors) != 1 || survivors[0] != "i-cp" {
		t.Fatalf("survivors = %v, want exactly [i-cp]: two records were written and one of them "+
			"was the SOS", survivors)
	}
}
