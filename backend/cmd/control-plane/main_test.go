// ═══════════════════════════════════════════════════════════════════════════════
// What this binary listens to, and what happens when it hears it
// (ADR-002 · §2.5.1 · §9.2 · docs/DECISIONS.md D-026, D-027)
//
// cmd/control-plane is 1,700 lines that own the escalation engine, and it had no
// test at all (docs/RISK.md item 4). D-026 needed one, because the question it
// asks — "does anything here consume the incident sos-ingest publishes" — is a
// question about wiring, and wiring is what a handler test never touches.
//
// This file started as the characterization: the first test opened an incident
// through this binary's OWN front door and watched the ladder get armed, the
// second published the same incident on the bus and watched nothing happen. The
// second one now asserts the opposite, and the commit that flipped it shows the
// red first (W10-h).
//
// ⛔ Read the block above the D-026 section before quoting any of this as
// end-to-end. Every test here runs in one process on one *Bus instance, and
// internal/bus does not cross a process boundary (D-027).
// ═══════════════════════════════════════════════════════════════════════════════

package main

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kavach/backend/internal/bus"
	"github.com/kavach/backend/internal/envelope"
	"github.com/kavach/backend/internal/incident"
	"github.com/kavach/backend/internal/logx"
	"github.com/kavach/backend/internal/notify"
	"github.com/kavach/backend/internal/store"
)

const (
	testFamily   = "11111111-1111-7111-8111-111111111111"
	testMember   = "22222222-2222-7222-8222-222222222222"
	testDevice   = "33333333-3333-7333-8333-333333333333"
	testIncident = "44444444-4444-7444-8444-444444444444"
)

// settle is six bus poll intervals (internal/bus drains on a 250 ms ticker). A
// message that has not been consumed by now has not been consumed.
const settle = 1500 * time.Millisecond

// newPlane seeds a family and builds the server through newServer — the same
// call main() makes — so that what is under test is the wiring, not a struct
// literal a test author assembled to suit itself.
func newPlane(t *testing.T) *server {
	t.Helper()
	dir := t.TempDir()

	seed, err := store.Open(filepath.Join(dir, "cp"))
	if err != nil {
		t.Fatal(err)
	}
	if err := seed.PutFamily(store.Family{ID: testFamily, DisplayName: "Test", CreatedAt: 1}); err != nil {
		t.Fatal(err)
	}
	if err := seed.PutMember(store.Member{
		ID: testMember, FamilyID: testFamily, DisplayName: "Priya",
		ASCIIShortName: "PRIYA", Role: "adult", PhoneE164: "+919812345678",
	}); err != nil {
		t.Fatal(err)
	}
	if err := seed.Flush(); err != nil {
		t.Fatal(err)
	}

	srv, err := newServer(serverConfig{
		DataDir: filepath.Join(dir, "cp"),
		BusDir:  filepath.Join(dir, "bus"),
		Workers: 1,
		Log:     logx.NewTo(os.Stderr, slog.LevelError, true),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = srv.bus.Close() })
	return srv
}

// ── the control: this binary's own front door arms the ladder ────────────────

// TestOpeningAnIncidentOverHTTPArmsTheLadder exists so the next test cannot be
// read as "the engine is broken" or "the harness never worked". POST
// /v1/incidents is the one caller escalation.OnIncidentOpen has, and through it
// everything downstream of D-026 is in working order.
func TestOpeningAnIncidentOverHTTPArmsTheLadder(t *testing.T) {
	srv := newPlane(t)

	body, err := json.Marshal(map[string]any{
		"id": testIncident, "trigger": "MANUAL", "duress": true,
		"subjectMemberId": testMember, "policyVersion": 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/incidents", strings.NewReader(string(body)))
	req.Header.Set("X-Family-Id", testFamily)
	rec := httptest.NewRecorder()
	srv.routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST /v1/incidents = %d, want 201: %s", rec.Code, rec.Body.String())
	}

	if _, ok := srv.st.Incident(testIncident); !ok {
		t.Fatal("the incident is not in the store")
	}
	// DURESS opens at ACTIVE_L1_SILENT, so OnIncidentOpen lays the whole ladder
	// down at once: the F-02 backstop plus the four rungs of §2.6.2.
	byAction := map[string]bool{}
	for _, tm := range srv.st.TimersForIncident(testIncident) {
		byAction[tm.Action] = true
	}
	for _, want := range []string{"AUTO_QUIESCE", "REPEAT_L1", "SMS_TIER", "ESCALATE_L2", "ESCALATE_L3"} {
		if !byAction[want] {
			t.Errorf("no %s rung armed; armed = %v", want, byAction)
		}
	}
}

// ── D-026 · the bus leg ──────────────────────────────────────────────────────
//
// Until W10-h these tests asserted that NOTHING happened — that was D-026's
// second break, measured rather than read, and the assertions below are the
// same ones inverted. What has not changed is the setup: the message is shaped
// like the one cmd/sos-ingest.commit() publishes, and it is published on the
// server's OWN bus instance.
//
// ⛔ That last part is not a shortcut, it is the limit of what this file can
// prove. In the deployed topology the two binaries are separate processes with
// separate *Bus instances, and internal/bus does not cross a process boundary
// (D-027, internal/bus/crossprocess_test.go). Everything below is true and none
// of it reaches a container.

// TestAnIncidentPublishedOnTheFamilyStreamArmsTheLadder is the arrow D-026
// found missing: an SOS that cmd/sos-ingest accepted now reaches the only thing
// in this system that climbs L1 → L2 → L3.
func TestAnIncidentPublishedOnTheFamilyStreamArmsTheLadder(t *testing.T) {
	srv := newPlane(t)

	if _, err := srv.bus.PublishMsg(sosIngestOpen(t, testIncident, true)); err != nil {
		t.Fatal(err)
	}
	waitForRungs(t, srv, testIncident, 5)

	inc, ok := srv.st.Incident(testIncident)
	if !ok {
		t.Fatal("the incident was not projected into the control plane's store")
	}
	// Duress opens silent (§7.5) and skips the cancel window outright, so the
	// whole ladder is laid down at once — the same five rungs the HTTP front
	// door produces for the same incident.
	if inc.State != incident.StateActiveL1Silent {
		t.Errorf("state = %s, want ACTIVE_L1_SILENT", inc.State)
	}
	if !inc.Duress {
		t.Error("the duress bit did not survive the bus")
	}
	if inc.Inc8 == "" {
		t.Error("Inc8 was not derived")
	}
	byAction := armedActions(srv, testIncident)
	for _, want := range []string{"AUTO_QUIESCE", "REPEAT_L1", "SMS_TIER", "ESCALATE_L2", "ESCALATE_L3"} {
		if !byAction[want] {
			t.Errorf("no %s rung armed; armed = %v", want, byAction)
		}
	}
	// ★ The action names are the engine's, not the generated machine's. This is
	// the third break of D-026: sos-ingest.armTimers derives NO_ACK from the
	// state machine and escalation.execute has no case for it
	// (internal/escalation/action_routing_test.go). Arming through the engine is
	// what makes the rung executable.
	if byAction["NO_ACK"] {
		t.Error("a NO_ACK rung was armed — escalation.execute has no case for it")
	}
}

// TestANonDuressIncidentOpensIntoTheServersOwnCancelWindow pins the other half
// of initialState. §2.5.6: the device runs its own copy of the window, and the
// server arms it too because the device may be underwater by the time it would
// have expired.
func TestANonDuressIncidentOpensIntoTheServersOwnCancelWindow(t *testing.T) {
	srv := newPlane(t)

	if _, err := srv.bus.PublishMsg(sosIngestOpen(t, testIncident, false)); err != nil {
		t.Fatal(err)
	}
	waitForRungs(t, srv, testIncident, 2)

	inc, _ := srv.st.Incident(testIncident)
	if inc.State != incident.StatePending {
		t.Errorf("state = %s, want PENDING", inc.State)
	}
	byAction := armedActions(srv, testIncident)
	if !byAction["CANCEL_WINDOW"] || !byAction["AUTO_QUIESCE"] {
		t.Errorf("armed = %v, want the cancel window and the F-02 backstop", byAction)
	}
	if byAction["ESCALATE_L2"] {
		t.Error("the ladder was laid before the cancel window expired")
	}
}

// TestARedeliveredIncidentDoesNotLayASecondLadder is D-025's mirror image.
//
// sos-ingest derives its rung ids, so a redelivery there OVERWROTE a rung a
// worker was holding. escalation.arm mints a fresh uuid per rung, so the same
// redelivery here would append a whole second ladder — five more rungs, every
// one of them due, every one of them able to wake a family twice.
//
// StartAll makes this the ordinary case, not the exotic one: every boot replays
// the whole retained stream.
func TestARedeliveredIncidentDoesNotLayASecondLadder(t *testing.T) {
	srv := newPlane(t)

	msg := sosIngestOpen(t, testIncident, true)
	if _, err := srv.bus.PublishMsg(msg); err != nil {
		t.Fatal(err)
	}
	waitForRungs(t, srv, testIncident, 5)
	first := len(srv.st.TimersForIncident(testIncident))

	if _, err := srv.bus.PublishMsg(msg); err != nil {
		t.Fatal(err)
	}
	time.Sleep(settle)

	if got := len(srv.st.TimersForIncident(testIncident)); got != first {
		t.Fatalf("%d rungs after redelivery, %d before — a second ladder was armed", got, first)
	}
}

// TestAnIncidentRecordedButUnarmedIsArmedOnRedelivery is why the guard above is
// "has rungs" and not "exists".
//
// A pass that dies between PutIncident and OnIncidentOpen leaves an incident on
// disk with no ladder. Treating that as already-done would strand exactly the
// incident whose projection has already gone wrong once — which is the mistake
// D-025's fix in sos-ingest was written to avoid, one layer down.
func TestAnIncidentRecordedButUnarmedIsArmedOnRedelivery(t *testing.T) {
	srv := newPlane(t)

	// The state deliberately is NOT the one a fresh projection would compute:
	// re-arming must not rewind an incident the engine has already climbed.
	if err := srv.st.PutIncident(store.Incident{
		ID: testIncident, FamilyID: testFamily, SubjectMemberID: testMember,
		State: incident.StateActiveL2, Trigger: "MANUAL", PolicyVersion: 1,
		OpenedAt: 1_700_000_000_000, ServerReceivedAt: 1_700_000_000_000,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := srv.bus.PublishMsg(sosIngestOpen(t, testIncident, true)); err != nil {
		t.Fatal(err)
	}
	waitForRungs(t, srv, testIncident, 1)

	inc, _ := srv.st.Incident(testIncident)
	if inc.State != incident.StateActiveL2 {
		t.Fatalf("state = %s, want ACTIVE_L2 — the redelivery rewound a climbing incident", inc.State)
	}
	if !armedActions(srv, testIncident)["AUTO_QUIESCE"] {
		t.Error("no F-02 backstop armed for an incident that had none")
	}
}

// TestAnIncidentForAnUnknownFamilyIsDroppedNotRetried matches the call
// cmd/sos-ingest's projector makes on the same question. There is nobody to
// escalate to, and returning an error would retry five times and then park the
// record in front of every other family's incidents.
func TestAnIncidentForAnUnknownFamilyIsDroppedNotRetried(t *testing.T) {
	srv := newPlane(t)

	msg := sosIngestOpen(t, testIncident, true)
	msg.Subject = bus.Subject("99999999-9999-7999-8999-999999999999", "incident")
	msg.FamilyID = "99999999-9999-7999-8999-999999999999"
	var rec map[string]any
	if err := json.Unmarshal(msg.Data, &rec); err != nil {
		t.Fatal(err)
	}
	rec["family_id"] = msg.FamilyID
	blob, err := json.Marshal(rec)
	if err != nil {
		t.Fatal(err)
	}
	msg.Data = blob

	if _, err := srv.bus.PublishMsg(msg); err != nil {
		t.Fatal(err)
	}
	time.Sleep(settle)

	if _, ok := srv.st.Incident(testIncident); ok {
		t.Fatal("an incident was projected for a family this binary has never heard of")
	}
	if n := len(srv.incidents.DeadLetters()); n != 0 {
		t.Fatalf("%d dead letters — the record was retried instead of dropped", n)
	}
	if srv.incidents.Cursor() == 0 {
		t.Fatal("the cursor did not advance past the dropped record")
	}
}

// TestAFrameOnTheStreamSubjectIsNotAnIncident guards the subject filter. This
// binary and the engine both publish notify frames on fam.{id}.stream and
// fam.{id}.reduced; only cmd/sos-ingest publishes on fam.{id}.incident, and a
// pattern that caught the others would feed this handler its own output.
func TestAFrameOnTheStreamSubjectIsNotAnIncident(t *testing.T) {
	srv := newPlane(t)

	msg := sosIngestOpen(t, testIncident, true)
	msg.Subject = notify.StreamSubject(testFamily)
	if _, err := srv.bus.PublishMsg(msg); err != nil {
		t.Fatal(err)
	}
	time.Sleep(settle)

	if _, ok := srv.st.Incident(testIncident); ok {
		t.Fatal("a message on the stream subject was projected as an incident")
	}
}

// armedActions is the set of rung actions on disk for an incident.
func armedActions(srv *server, incidentID string) map[string]bool {
	out := map[string]bool{}
	for _, tm := range srv.st.TimersForIncident(incidentID) {
		out[tm.Action] = true
	}
	return out
}

// waitForRungs polls instead of sleeping so a passing test is fast and a failing
// one still waits the full settle before it says so.
func waitForRungs(t *testing.T, srv *server, incidentID string, want int) {
	t.Helper()
	deadline := time.Now().Add(settle)
	for time.Now().Before(deadline) {
		if len(srv.st.TimersForIncident(incidentID)) >= want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("only %d rungs armed after %s, want %d",
		len(srv.st.TimersForIncident(incidentID)), settle, want)
}

// sosIngestOpen builds the bus message cmd/sos-ingest publishes for an incident
// open. The record type is private to that binary and this one may not import it
// (archlint: no cmd → cmd edge), so the shape is duplicated here and pinned
// against the original by TestTheRecordShapeThisFileAssumesStillMatchesIngest.
func sosIngestOpen(t *testing.T, incidentID string, duress bool) bus.Msg {
	t.Helper()
	e := envelope.Envelope{
		V: 1, IncidentID: incidentID, FamilyID: testFamily, DeviceID: testDevice,
		MemberID: testMember, ClientTsMs: 1_700_000_000_000, HLC: "0000018bcfe0000100aabbccdd",
		Trigger: "MANUAL", ConfidencePct: 100, RiskContext: 2, Duress: duress,
		PolicyVersion: 1, CoarseCell: "c7:23.02:72.57", BatteryPct: 61,
		SealedPayload: "AZ+sealed+ciphertext+placeholder",
	}
	blob, err := json.Marshal(map[string]any{
		"kind":        bus.KindIncidentOpen,
		"at":          e.ClientTsMs,
		"family_id":   testFamily,
		"incident_id": incidentID,
		"device_id":   testDevice,
		"hlc":         e.HLC,
		"transport":   "https",
		"event_type":  "MANUAL_TRIGGER",
		"flags":       0,
		"verified":    true,
		"body":        string(envelope.Canonical(&e)),
	})
	if err != nil {
		t.Fatal(err)
	}
	return bus.Msg{
		Subject: bus.Subject(testFamily, "incident"), Kind: bus.KindIncidentOpen,
		IncidentID: incidentID, FamilyID: testFamily, HLC: e.HLC,
		At: e.ClientTsMs, Data: blob,
	}
}

// TestTheRecordShapeThisFileAssumesStillMatchesIngest keeps the duplication
// above honest. Go cannot express this as a shared type — cmd/sos-ingest owns
// record, archlint forbids the import, and moving it into the kernel would
// change the WAL format of the sacred binary — so the contract is checked
// against the source text instead, the way TestLOCBudget checks its own file.
//
// If a json tag on record is renamed, this fails here rather than as a rung that
// silently never gets armed.
func TestTheRecordShapeThisFileAssumesStillMatchesIngest(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "sos-ingest", "main.go"))
	if err != nil {
		t.Fatal(err)
	}
	src := string(raw)
	start := strings.Index(src, "type record struct {")
	if start < 0 {
		t.Fatal("cmd/sos-ingest/main.go no longer declares type record struct")
	}
	end := strings.Index(src[start:], "\n}")
	if end < 0 {
		t.Fatal("unterminated record struct")
	}
	decl := src[start : start+end]

	for _, tag := range []string{
		"json:\"kind\"", "json:\"at\"", "json:\"family_id\"", "json:\"incident_id\"",
		"json:\"device_id\"", "json:\"hlc\"", "json:\"transport\"",
		"json:\"event_type,omitempty\"", "json:\"flags\"", "json:\"verified\"", "json:\"body\"",
	} {
		if !strings.Contains(decl, tag) {
			t.Errorf("cmd/sos-ingest's record no longer carries %s — the bus payload this "+
				"package decodes has changed shape", tag)
		}
	}
	if !strings.Contains(src, "bus.Subject(rec.FamilyID, strings.Split(subjectLeaf, \".\")...)") {
		t.Error("cmd/sos-ingest no longer publishes on bus.Subject(familyID, leaf...) — " +
			"check the subject this package matches on")
	}
}

// TestSeedIsNotSilentlyEmpty guards the two tests above: both are assertions
// about a family that must exist, and a store that quietly seeded nothing would
// make the second one pass for the wrong reason.
func TestSeedIsNotSilentlyEmpty(t *testing.T) {
	srv := newPlane(t)
	fams := srv.st.Families()
	if len(fams) != 1 || fams[0].ID != testFamily {
		t.Fatalf("families = %v, want exactly the seeded one", fams)
	}
	if got := srv.st.Members(testFamily); len(got) != 1 {
		t.Fatalf("%d members, want 1", len(got))
	}
}
