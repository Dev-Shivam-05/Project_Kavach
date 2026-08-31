// ═══════════════════════════════════════════════════════════════════════════════
// POST /v1/members/{id}/location-refresh — 6-D-6 · spec C1
//
// This is a routing + status-mapping test: does the handler reach a real
// member row, and does an honest notify.RequestLocationRefresh failure surface
// as a real HTTP status rather than a silent 202. internal/notify's own
// location_refresh_test.go already covers the send-selection logic (Android
// only, revoked skipped, multi-device) — duplicating that here would test the
// fake, not the wiring.
// ═══════════════════════════════════════════════════════════════════════════════
package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/kavach/backend/internal/store"
)

func TestRequestLocationRefresh_UnknownMemberIs404(t *testing.T) {
	srv := newPlane(t)

	req := httptest.NewRequest(http.MethodPost, "/v1/members/no-such-member/location-refresh", strings.NewReader("{}"))
	req.Header.Set("X-Family-Id", testFamily)
	rec := httptest.NewRecorder()
	srv.routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

// TestRequestLocationRefresh_KnownMemberButNoPushConfigured pins the honest
// failure this deployment actually produces: no KAVACH_FCM_CREDENTIALS is set
// in this test environment (or on this machine at all — see PROJECT_MAP.md),
// so a real device with a real FCM token still cannot be reached, and the
// endpoint must say so with a real status code rather than reporting 202 for a
// push nobody sent — the same principle W10's fcm_test.go pins for the
// incident leg.
func TestRequestLocationRefresh_KnownMemberButNoPushConfigured(t *testing.T) {
	srv := newPlane(t)
	if err := srv.st.PutDevice(store.Device{
		ID: testDevice, FamilyID: testFamily, MemberID: testMember,
		Platform: "android", PushTokenFCM: "tok-test",
	}); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/members/"+testMember+"/location-refresh", strings.NewReader("{}"))
	req.Header.Set("X-Family-Id", testFamily)
	rec := httptest.NewRecorder()
	srv.routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (KV-5001, honest push-not-configured) — got body %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "KV-5001") {
		t.Fatalf("body = %s, want KV-5001", rec.Body.String())
	}
}
