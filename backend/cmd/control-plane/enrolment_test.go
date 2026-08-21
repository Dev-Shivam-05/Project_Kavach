// ═══════════════════════════════════════════════════════════════════════════════
// Enrolment — how a family, a member and a device come into existence
// (★ RISK item 18 · §W4 · F-18 · ADR-006 · docs/spec/w10-j-enrolment.md)
//
// This file opened as the characterization RISK item 18 was written from: item
// 18 says no running binary can create a family, and the first two tests were
// that sentence executed rather than argued — POST /v1/family and POST
// /v1/members both 405, green, in their own commit. The commit that added the
// routes shows them red and replaces them with their inversion.
//
// The third one did not flip and is still here:
// TestADeviceCannotBeEnrolledWithoutAFamilyRow. POST /v1/devices was always
// correct — it just had nothing to attach to, which is what item 18 actually
// cost on this path.
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

	"github.com/kavach/backend/internal/bus"
	"github.com/kavach/backend/internal/logx"
	"github.com/kavach/backend/internal/store"
)

// newEmptyPlane is newPlane with the seed removed: a server whose store has no
// family, no member and no device, which is what every freshly deployed stack
// looks like the moment `docker compose up` returns.
func newEmptyPlane(t *testing.T) *server {
	t.Helper()
	dir := t.TempDir()
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

func post(t *testing.T, srv *server, path, familyID, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	if familyID != "" {
		req.Header.Set("X-Family-Id", familyID)
	}
	rec := httptest.NewRecorder()
	srv.routes().ServeHTTP(rec, req)
	return rec
}

// TestEnrolmentRoutesAreBehindAuthAndIdempotency is the inversion of the two
// tests this file opened with. They asserted that POST /v1/family and POST
// /v1/members were 405s — RISK item 18's first clause, and the clause it does
// not say out loud: enrolDevice needs a memberId, and nothing could mint one
// either. Both were true, and the run that turned them red is in the commit
// that added the routes.
//
// What replaces them is the wiring, because a route that exists is not the same
// as a route that is bound the way the others are: §2.9.2 puts an
// Idempotency-Key on every mutating endpoint, since a client that retried over a
// second transport must not create the family twice.
func TestEnrolmentRoutesAreBehindAuthAndIdempotency(t *testing.T) {
	t.Run("auth", func(t *testing.T) {
		srv := newEmptyPlane(t)
		srv.token = "shared-secret" // as a deployment exposed beyond localhost runs
		for _, path := range []string{"/v1/family", "/v1/members"} {
			rec := post(t, srv, path, "", `{"displayName":"Sharma"}`)
			if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "KV-1002") {
				t.Fatalf("POST %s unauthenticated = %d %s, want 401 KV-1002", path, rec.Code, rec.Body.String())
			}
		}
		if len(srv.st.Families()) != 0 {
			t.Fatal("an unauthenticated request created a family")
		}
	})

	t.Run("idempotency", func(t *testing.T) {
		srv := newEmptyPlane(t)
		var first store.Family
		for i := 0; i < 2; i++ {
			req := httptest.NewRequest(http.MethodPost, "/v1/family", strings.NewReader(`{"displayName":"Sharma"}`))
			req.Header.Set("Idempotency-Key", "one-retried-request")
			rec := httptest.NewRecorder()
			srv.routes().ServeHTTP(rec, req)
			if rec.Code != http.StatusCreated {
				t.Fatalf("attempt %d = %d %s", i, rec.Code, rec.Body.String())
			}
			var fam store.Family
			decode(t, rec, &fam)
			if i == 0 {
				first = fam
			} else if fam.ID != first.ID {
				t.Fatalf("a replayed Idempotency-Key minted a second family: %s then %s", first.ID, fam.ID)
			}
		}
		if n := len(srv.st.Families()); n != 1 {
			t.Fatalf("one retried request created %d families", n)
		}
	})
}

// TestADeviceCannotBeEnrolledWithoutAFamilyRow is what item 18 actually costs on
// the enrolment path: POST /v1/devices is complete and correct, and it fails
// closed because store.PutDevice calls requireFamily and there is no family.
// This test does NOT flip in W10-j. It is the reason the other two must.
func TestADeviceCannotBeEnrolledWithoutAFamilyRow(t *testing.T) {
	srv := newEmptyPlane(t)
	rec := post(t, srv, "/v1/devices", "", `{"memberId":"`+testMember+`","signingPubkey":"AAAA"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("POST /v1/devices = %d, want 400 on a store with no family: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "KV-1006") {
		t.Fatalf("want the unknown-family problem code KV-1006, got %s", rec.Body.String())
	}
	if len(srv.st.AllDevices()) != 0 {
		t.Fatalf("a device was stored for a family that does not exist")
	}
}

// ── W10-j · the routes ───────────────────────────────────────────────────────
//
// Everything below asserts the opposite of the first two tests in this file.
// They were red when they were written, and the commit that turns them green is
// the one that adds the routes.

const testResponder = "55555555-5555-7555-8555-555555555555"

func decode(t *testing.T, rec *httptest.ResponseRecorder, into any) {
	t.Helper()
	if err := json.Unmarshal(rec.Body.Bytes(), into); err != nil {
		t.Fatalf("response is not JSON: %v (%s)", err, rec.Body.String())
	}
}

// TestPostFamilyCreatesAFamilyThatOutlivesTheProcess is RISK item 18 closed. The
// reopen matters more than the 201: a family that exists only in the running
// server's memory is the same outage one restart later.
func TestPostFamilyCreatesAFamilyThatOutlivesTheProcess(t *testing.T) {
	srv := newEmptyPlane(t)

	rec := post(t, srv, "/v1/family", "", `{"displayName":"Sharma"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST /v1/family = %d, want 201: %s", rec.Code, rec.Body.String())
	}
	var fam store.Family
	decode(t, rec, &fam)
	if fam.ID == "" {
		t.Fatal("no id was minted for a family created without one")
	}
	// ADR-006: migrations/0001_init.sql is the naming authority, and these are
	// its defaults — sms_ceiling 2000, policy_version 1, current_epoch 0, and
	// max_members 6 (phase6-pull-forward E2).
	if fam.SMSCeiling != 2000 || fam.PolicyVersion != 1 || fam.CurrentEpoch != 0 || fam.MaxMembers != 6 {
		t.Fatalf("defaults do not match the migration: %+v", fam)
	}
	if fam.CreatedAt == 0 {
		t.Fatal("created_at was not stamped")
	}

	reopened, err := store.Open(srv.st.Dir())
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := reopened.Family(fam.ID); !ok {
		t.Fatal("the family is gone after the store was reopened")
	}
}

func TestPostFamilyRejectsAnEmptyDisplayName(t *testing.T) {
	srv := newEmptyPlane(t)
	rec := post(t, srv, "/v1/family", "", `{"displayName":"  "}`)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "KV-1001") {
		t.Fatalf("want 400 KV-1001, got %d %s", rec.Code, rec.Body.String())
	}
	if len(srv.st.Families()) != 0 {
		t.Fatal("a family was stored for a rejected request")
	}
}

// TestPostMemberCreatesAMemberOnTheNamedFamily is the second half of item 18:
// enrolDevice takes a memberId, and until now nothing could mint one.
func TestPostMemberCreatesAMemberOnTheNamedFamily(t *testing.T) {
	srv := newPlane(t)
	rec := post(t, srv, "/v1/members", testFamily,
		`{"displayName":"Amit Sharma","asciiShortName":"AMIT","role":"guardian","phoneE164":"+919800000001"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST /v1/members = %d, want 201: %s", rec.Code, rec.Body.String())
	}
	var m store.Member
	decode(t, rec, &m)
	if m.ID == "" || m.FamilyID != testFamily || m.Role != "guardian" {
		t.Fatalf("member did not land on the named family: %+v", m)
	}
	if m.Locale != "en" {
		t.Fatalf("the migration defaults locale to en, got %q", m.Locale)
	}
	if _, ok := srv.st.Member(m.ID); !ok {
		t.Fatal("the member is not in the store")
	}
}

// TestPostMemberEnforcesTheSMSShapeOfAShortName is P-033 and the migration's
// CHECK, not a preference: one non-ASCII character flips the whole SMS to UCS-2
// and cuts it from 160 characters to 70, which does not fit.
func TestPostMemberEnforcesTheSMSShapeOfAShortName(t *testing.T) {
	for _, tc := range []struct{ name, body string }{
		{"a space", `{"displayName":"Amit","asciiShortName":"AMIT KUMAR","role":"adult"}`},
		{"nine letters", `{"displayName":"Amit","asciiShortName":"AMITKUMAR","role":"adult"}`},
		{"devanagari", `{"displayName":"Amit","asciiShortName":"अमित","role":"adult"}`},
		{"empty", `{"displayName":"Amit","asciiShortName":"","role":"adult"}`},
		{"a role outside the enum", `{"displayName":"Amit","asciiShortName":"AMIT","role":"cousin"}`},
		{"no display name", `{"displayName":"","asciiShortName":"AMIT","role":"adult"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := newPlane(t)
			rec := post(t, srv, "/v1/members", testFamily, tc.body)
			if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "KV-1001") {
				t.Fatalf("want 400 KV-1001, got %d %s", rec.Code, rec.Body.String())
			}
			if len(srv.st.Members(testFamily)) != 1 { // the seeded PRIYA and nobody else
				t.Fatalf("a rejected member was stored: %+v", srv.st.Members(testFamily))
			}
		})
	}
}

// TestTwoMembersCannotShareAShortName is F-18. Two members called PRIYA produce
// two identical SMS alerts, and the person reading one at 2 a.m. cannot tell
// which of them is in trouble. Case-insensitively, because PRIYA and Priya are
// the same name to a human under stress.
func TestTwoMembersCannotShareAShortName(t *testing.T) {
	srv := newPlane(t) // newPlane already seeds the short name PRIYA
	rec := post(t, srv, "/v1/members", testFamily,
		`{"displayName":"Priya Two","asciiShortName":"priya","role":"adult"}`)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "KV-1008") {
		t.Fatalf("want 409 KV-1008 for a case-insensitive duplicate, got %d %s", rec.Code, rec.Body.String())
	}
	if len(srv.st.Members(testFamily)) != 1 {
		t.Fatal("the duplicate was stored anyway")
	}
}

// TestTheWholeEnrolmentPathRunsThroughTheAPI is the acceptance criterion: three
// requests, no fixture, a device row at the end of it. Before W10-j the third
// request was a 400 no matter what the first two did, because nothing could
// create what PutDevice.requireFamily looks for.
func TestTheWholeEnrolmentPathRunsThroughTheAPI(t *testing.T) {
	srv := newEmptyPlane(t)

	rec := post(t, srv, "/v1/family", "", `{"displayName":"Sharma"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("family: %d %s", rec.Code, rec.Body.String())
	}
	var fam store.Family
	decode(t, rec, &fam)

	rec = post(t, srv, "/v1/members", fam.ID,
		`{"id":"`+testResponder+`","displayName":"Amit","asciiShortName":"AMIT","role":"guardian"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("member: %d %s", rec.Code, rec.Body.String())
	}

	rec = post(t, srv, "/v1/devices", fam.ID,
		`{"id":"`+testDevice+`","memberId":"`+testResponder+`","platform":"android","signingPubkey":"AAAA"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("device: %d %s", rec.Code, rec.Body.String())
	}
	devices := srv.st.Devices(fam.ID)
	if len(devices) != 1 || devices[0].MemberID != testResponder {
		t.Fatalf("want one device on the responder, got %+v", devices)
	}
}

// TestEnrolmentIsPublishedOnTheFamilySubject is the leg that makes any of this
// reach the other binary. cmd/sos-ingest keeps its OWN store — separate
// directory, separate process — and gates every incident on a family row it can
// only learn about from here. D-027 made the bus a real seam; this is the second
// kind of record to cross it.
func TestEnrolmentIsPublishedOnTheFamilySubject(t *testing.T) {
	srv := newEmptyPlane(t)

	rec := post(t, srv, "/v1/family", "", `{"displayName":"Sharma"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("family: %d %s", rec.Code, rec.Body.String())
	}
	var fam store.Family
	decode(t, rec, &fam)
	if rec = post(t, srv, "/v1/members", fam.ID,
		`{"id":"`+testResponder+`","displayName":"Amit","asciiShortName":"AMIT","role":"guardian"}`); rec.Code != http.StatusCreated {
		t.Fatalf("member: %d %s", rec.Code, rec.Body.String())
	}
	if rec = post(t, srv, "/v1/devices", fam.ID,
		`{"id":"`+testDevice+`","memberId":"`+testResponder+`","signingPubkey":"AAAA"}`); rec.Code != http.StatusCreated {
		t.Fatalf("device: %d %s", rec.Code, rec.Body.String())
	}

	var kinds []string
	seen := map[string]bool{}
	if err := srv.bus.Replay(bus.Subject(fam.ID, "enrolment"), 0, func(m bus.Msg) error {
		kinds = append(kinds, m.Kind)
		var up store.EnrolmentUpsert
		if err := json.Unmarshal(m.Data, &up); err != nil {
			t.Errorf("enrolment record is not readable: %v", err)
			return nil
		}
		if up.Family != nil {
			seen["family"] = true
		}
		if up.Member != nil {
			seen["member"] = true
		}
		if up.Device != nil {
			seen["device"] = true
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(kinds) != 3 {
		t.Fatalf("want three enrolment records on %s, got %v", bus.Subject(fam.ID, "enrolment"), kinds)
	}
	for _, k := range kinds {
		if k != bus.KindEnrolmentUpsert {
			t.Fatalf("kind = %q, want %q", k, bus.KindEnrolmentUpsert)
		}
	}
	for _, want := range []string{"family", "member", "device"} {
		if !seen[want] {
			t.Fatalf("no %s row travelled; seen = %v", want, seen)
		}
	}
}

// TestPostMemberEnforcesTheFamilySizeCap is phase6-pull-forward E3. A family is
// created with room for two; the third member is refused with 409 KV-1012. The
// cap is counted on the writer because cmd/control-plane is the only place all of
// a family's members are visible at once (the migration's CHECK never runs,
// ADR-006/D-003). Written red: before the guard the third POST returned 201.
func TestPostMemberEnforcesTheFamilySizeCap(t *testing.T) {
	srv := newEmptyPlane(t)

	rec := post(t, srv, "/v1/family", "", `{"displayName":"Sharma","maxMembers":2}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST /v1/family = %d: %s", rec.Code, rec.Body.String())
	}
	var fam store.Family
	decode(t, rec, &fam)
	if fam.MaxMembers != 2 {
		t.Fatalf("maxMembers was not stored: %+v", fam)
	}

	for i, body := range []string{
		`{"displayName":"Amit","asciiShortName":"AMIT","role":"guardian"}`,
		`{"displayName":"Bina","asciiShortName":"BINA","role":"adult"}`,
	} {
		r := post(t, srv, "/v1/members", fam.ID, body)
		if r.Code != http.StatusCreated {
			t.Fatalf("member %d = %d, want 201: %s", i+1, r.Code, r.Body.String())
		}
	}

	r := post(t, srv, "/v1/members", fam.ID,
		`{"displayName":"Chaya","asciiShortName":"CHAYA","role":"adult"}`)
	if r.Code != http.StatusConflict || !strings.Contains(r.Body.String(), "KV-1012") {
		t.Fatalf("the third member of a max-2 family = %d %s, want 409 KV-1012", r.Code, r.Body.String())
	}
	if n := len(srv.st.Members(fam.ID)); n != 2 {
		t.Fatalf("a refused member was still stored: family has %d members", n)
	}
}
