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
// The test below is the characterization: before W10-j nothing here consumed an
// enrolment record, so a family created through the control plane's brand-new
// POST /v1/family reached this binary not at all.
package main

import (
	"encoding/json"
	"testing"

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

// TestAnEnrolmentRecordDoesNotReachTheStore runs on an UNSEEDED server, which is
// what a freshly deployed container is: no family, no member, no device, and no
// way to acquire one. project() dispatches on rec.Kind and enrolment_upsert
// falls through to the default arm, which returns nil — consumed, ignored.
func TestAnEnrolmentRecordDoesNotReachTheStore(t *testing.T) {
	srv := newTestServer(t, t.TempDir())

	if _, err := srv.bus.PublishMsg(enrolmentMsg(t, store.EnrolmentUpsert{
		Family: &store.Family{ID: testFamily, DisplayName: "Sharma", CreatedAt: 1},
	})); err != nil {
		t.Fatal(err)
	}
	drainProjector(t, srv)

	if _, ok := srv.st.Family(testFamily); ok {
		t.Fatal("the family row arrived; RISK item 18 says nothing here consumes an enrolment record")
	}
}
