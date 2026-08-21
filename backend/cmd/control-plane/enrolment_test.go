// ═══════════════════════════════════════════════════════════════════════════════
// Enrolment — how a family, a member and a device come into existence
// (★ RISK item 18 · §W4 · F-18 · ADR-006 · docs/spec/w10-j-enrolment.md)
//
// This file opens as the characterization RISK item 18 was written from: item 18
// says no running binary can create a family, and the three tests below are that
// sentence executed rather than argued. They pass against the code as it stood
// before W10-j, and the commit that adds the routes flips the first two and
// leaves the third — the device route was always correct, it just had nothing to
// attach to.
// ═══════════════════════════════════════════════════════════════════════════════

package main

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kavach/backend/internal/logx"
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

// TestPostFamilyIsNotARoute is RISK item 18's first clause. GET /v1/family has
// been served since the binary existed; nothing has ever created what it reads.
func TestPostFamilyIsNotARoute(t *testing.T) {
	srv := newEmptyPlane(t)
	rec := post(t, srv, "/v1/family", "", `{"displayName":"Sharma"}`)
	if rec.Code == http.StatusCreated {
		t.Fatalf("POST /v1/family = 201; RISK item 18 says this route does not exist")
	}
	t.Logf("POST /v1/family = %d (%s)", rec.Code, strings.TrimSpace(rec.Body.String()))
	if len(srv.st.Families()) != 0 {
		t.Fatalf("a family exists after a request that cannot create one")
	}
}

// TestPostMembersIsNotARoute is the clause item 18 does not say out loud:
// enrolDevice requires a memberId, and store.PutMember has no non-test caller
// either, so a family route on its own still cannot produce an enrollable phone.
func TestPostMembersIsNotARoute(t *testing.T) {
	srv := newEmptyPlane(t)
	rec := post(t, srv, "/v1/members", "", `{"displayName":"Priya","asciiShortName":"PRIYA","role":"adult"}`)
	if rec.Code == http.StatusCreated {
		t.Fatalf("POST /v1/members = 201; no such route is registered")
	}
	t.Logf("POST /v1/members = %d (%s)", rec.Code, strings.TrimSpace(rec.Body.String()))
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
