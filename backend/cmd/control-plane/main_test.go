// ═══════════════════════════════════════════════════════════════════════════════
// CHARACTERIZATION — what this binary is, and is not, listening to
// (ADR-002 · §2.5.1 · §9.2 · docs/DECISIONS.md D-026)
//
// cmd/control-plane is 1,700 lines that own the escalation engine, and it had no
// test at all (docs/RISK.md item 4). D-026 needs one, because the question it
// asks — "does anything here consume the incident sos-ingest publishes" — is a
// question about wiring, and wiring is what a handler test never touches.
//
// The two tests below are deliberately a matched pair. The first opens an
// incident through this binary's OWN front door and watches the ladder get
// armed: the engine works, the store works, the rungs are real. The second puts
// the same incident on the bus, in the shape cmd/sos-ingest publishes it, in the
// most generous configuration that exists — one process, one *Bus instance, no
// container boundary — and watches nothing happen at all.
//
// ★ Nothing here is a new requirement. ★ Both assertions state what HEAD does.
// The second one is the one that should stop being true.
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
	"github.com/kavach/backend/internal/logx"
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

// TestAnIncidentPublishedOnTheFamilyStreamArmsNothing is D-026's second break,
// measured instead of read.
//
// The message is shaped like the one cmd/sos-ingest.commit() publishes: subject
// fam.{family}.incident, kind incident_open, data a record whose Body is a
// canonical envelope. It is published on the server's OWN bus instance, so the
// cross-process problem of D-027 cannot be what fails here — delivery is
// possible and there is simply no consumer.
//
// engine.OnIncidentOpen has exactly one caller and it is the HTTP handler above.
func TestAnIncidentPublishedOnTheFamilyStreamArmsNothing(t *testing.T) {
	srv := newPlane(t)

	if _, err := srv.bus.PublishMsg(sosIngestOpen(t, testIncident)); err != nil {
		t.Fatal(err)
	}
	time.Sleep(settle)

	if _, ok := srv.st.Incident(testIncident); ok {
		t.Fatal("the control plane projected the incident — D-026's bus leg is closed; " +
			"update this test to assert the rungs instead of their absence")
	}
	if got := srv.st.TimersForIncident(testIncident); len(got) != 0 {
		t.Fatalf("%d rungs armed from the bus, want 0 at HEAD", len(got))
	}
}

// sosIngestOpen builds the bus message cmd/sos-ingest publishes for an incident
// open. The record type is private to that binary and this one may not import it
// (archlint: no cmd → cmd edge), so the shape is duplicated here and pinned
// against the original by TestTheRecordShapeThisFileAssumesStillMatchesIngest.
func sosIngestOpen(t *testing.T, incidentID string) bus.Msg {
	t.Helper()
	e := envelope.Envelope{
		V: 1, IncidentID: incidentID, FamilyID: testFamily, DeviceID: testDevice,
		MemberID: testMember, ClientTsMs: 1_700_000_000_000, HLC: "0000018bcfe0000100aabbccdd",
		Trigger: "MANUAL", ConfidencePct: 100, RiskContext: 2, Duress: true,
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
