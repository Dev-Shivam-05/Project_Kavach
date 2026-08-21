// ★ RISK item 18 · D-027 · ADR-018 — what this binary knows about a family, and
// how it can possibly know it.
//
// cmd/sos-ingest gates every incident on a family row (projectOpen) and verifies
// every envelope against a device key (refreshCache), and it holds both in its
// OWN store directory: in ops/docker-compose.yml that is /var/lib/kavach/store,
// while the control plane's is /var/lib/kavach/control-plane/store. Two
// processes rewriting one whole JSON table is the D-027 failure mode in the
// table that decides whether a signature verifies, so the two directories stay
// separate and the ROW crosses the bus instead of the file.
//
// This file opened with the characterization — an enrolment record published on
// fam.<id>.enrolment reached the store not at all, because project() dispatched
// on rec.Kind and the payload is a row, not a record. That test is now its own
// inversion, and the commit that added projectEnrolment shows it red.
//
// Every server below is UNSEEDED on purpose. seed() in main_test.go is the
// fixture that has been hiding item 18 for as long as it has existed: a
// freshly deployed container has no family, no member and no device, and until
// W10-j it had no way to acquire one.
package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/kavach/backend/internal/bus"
	"github.com/kavach/backend/internal/store"
)

// enrolmentMsg is exactly what cmd/control-plane.publishEnrolment puts on the
// wire. The shared store.EnrolmentUpsert is the point: a field added on the
// writing side and forgotten here would otherwise be invisible.
func enrolmentMsg(t *testing.T, up store.EnrolmentUpsert) bus.Msg {
	t.Helper()
	blob, err := json.Marshal(up)
	if err != nil {
		t.Fatal(err)
	}
	return bus.Msg{
		Subject: bus.Subject(testFamily, "enrolment"), Kind: bus.KindEnrolmentUpsert,
		FamilyID: testFamily, At: 1, Data: blob,
	}
}

func publishEnrolment(t *testing.T, srv *Server, up store.EnrolmentUpsert) {
	t.Helper()
	if _, err := srv.bus.PublishMsg(enrolmentMsg(t, up)); err != nil {
		t.Fatal(err)
	}
	drainProjector(t, srv)
}

// TestAnEnrolmentRecordCreatesTheFamilyThisBinaryGatesOn is the inversion of
// this file's first test.
func TestAnEnrolmentRecordCreatesTheFamilyThisBinaryGatesOn(t *testing.T) {
	srv := newTestServer(t, t.TempDir())

	publishEnrolment(t, srv, store.EnrolmentUpsert{
		Family: &store.Family{ID: testFamily, DisplayName: "Sharma", CreatedAt: 1},
	})

	fam, ok := srv.st.Family(testFamily)
	if !ok {
		t.Fatal("the family row did not arrive")
	}
	if fam.DisplayName != "Sharma" {
		t.Fatalf("the row arrived changed: %+v", fam)
	}
}

// TestEnrolmentTurnsARejectedSOSIntoAProjectedOne is the cost of item 18 and its
// repair in one run: the same family, the same key, one enrolment record apart.
//
// ⛔ It also measures item 18's real cost, which item 18 understates. The entry
// says both projectors "drop an incident whose family row is missing — silently,
// at WARN". They do, but the request never gets that far: ingestEnvelope
// resolves the family from the in-memory cache and answers **404 unknown
// family** (F-04, "an unknown family is nobody to help"). On a freshly deployed
// stack the phone does not get a flagged ack, it gets an error. That is the
// deliberate design and this test pins it — it is only survivable because
// enrolment now exists.
func TestEnrolmentTurnsARejectedSOSIntoAProjectedOne(t *testing.T) {
	const before = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa"
	const after = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb"

	srv := newTestServer(t, t.TempDir())
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}

	code, _ := post(t, srv, "/v1/incident/open", sealed(t, priv, envFor(before, time.Now().UnixMilli())))
	if code != http.StatusNotFound {
		t.Fatalf("open before enrolment: status %d, want 404 — F-04 bounds the fail-open", code)
	}
	drainProjector(t, srv)
	if _, ok := srv.st.Incident(before); ok {
		t.Fatal("an incident was projected for a family this binary does not know")
	}

	publishEnrolment(t, srv, store.EnrolmentUpsert{
		Family: &store.Family{ID: testFamily, DisplayName: "Sharma", CreatedAt: 1},
		Member: &store.Member{
			ID: testMember, FamilyID: testFamily, DisplayName: "Priya",
			ASCIIShortName: "PRIYA", Role: "adult", PhoneE164: testPhone,
		},
		Device: &store.Device{
			ID: testDevice, FamilyID: testFamily, MemberID: testMember, Platform: "android",
			SigningPubkey: base64.StdEncoding.EncodeToString(pub), AgentHealthy: true,
		},
	})

	code, a := post(t, srv, "/v1/incident/open", sealed(t, priv, envFor(after, time.Now().UnixMilli())))
	if code != http.StatusOK {
		t.Fatalf("open after enrolment: status %d", code)
	}
	if !a.Verified {
		t.Fatal("the signature still does not verify; the device key did not reach the cache")
	}
	drainProjector(t, srv)
	inc, ok := srv.st.Incident(after)
	if !ok {
		t.Fatal("the incident was still dropped after the family row arrived")
	}
	if inc.FamilyID != testFamily {
		t.Fatalf("incident landed on the wrong tenant: %+v", inc)
	}
}

// TestAnEnrolmentRecordDeliveredTwiceIsNotTwoRows guards the one thing an
// at-least-once stream guarantees will happen. Every Put* in the store is a
// blind upsert (*old = row), so the second delivery is a no-op by construction
// — and ordering is the log's, not this handler's: a cursor that rewinds
// replays everything after it in the same order, so the newest row still wins.
func TestAnEnrolmentRecordDeliveredTwiceIsNotTwoRows(t *testing.T) {
	srv := newTestServer(t, t.TempDir())
	up := store.EnrolmentUpsert{
		Family: &store.Family{ID: testFamily, DisplayName: "Sharma", CreatedAt: 1},
		Member: &store.Member{
			ID: testMember, FamilyID: testFamily, DisplayName: "Priya",
			ASCIIShortName: "PRIYA", Role: "adult",
		},
	}

	publishEnrolment(t, srv, up)
	publishEnrolment(t, srv, up)

	if n := len(srv.st.Families()); n != 1 {
		t.Fatalf("two deliveries produced %d families", n)
	}
	if n := len(srv.st.Members(testFamily)); n != 1 {
		t.Fatalf("two deliveries produced %d members", n)
	}
	if n := srv.projector.DeadLetters(); len(n) != 0 {
		t.Fatalf("a redelivery was dead-lettered: %+v", n)
	}
}

// TestAMemberForAnUnknownFamilyIsRetriedNotSwallowed pins the failure direction.
// PutMember calls requireFamily, so a member that arrives without its family is
// an error — and returning it holds the cursor, retries, and finally dead-letters
// onto /healthz. Losing it silently would leave a family half-enrolled with
// nothing anywhere saying so.
func TestAMemberForAnUnknownFamilyIsRetriedNotSwallowed(t *testing.T) {
	srv := newTestServer(t, t.TempDir())

	publishEnrolment(t, srv, store.EnrolmentUpsert{
		Member: &store.Member{
			ID: testMember, FamilyID: testFamily, DisplayName: "Priya",
			ASCIIShortName: "PRIYA", Role: "adult",
		},
	})

	if len(srv.st.Members(testFamily)) != 0 {
		t.Fatal("a member was stored for a family this binary does not have")
	}
	if len(srv.projector.DeadLetters()) != 1 {
		t.Fatalf("want the record dead-lettered onto /healthz, got %d", len(srv.projector.DeadLetters()))
	}
}
