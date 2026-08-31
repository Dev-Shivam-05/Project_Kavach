// ═══════════════════════════════════════════════════════════════════════════════
// POST /v1/location-report — 6-D-6 · spec C1's response leg.
//
// realtime-gw had zero tests before this (RISK.md, PROJECT_MAP.md danger
// zones). This is not an attempt to fix that in general — the WS framing and
// backpressure logic still has none — it is a direct test of the one plain
// HTTP handler this binary now carries, which needs no hijacked connection and
// no WS handshake to exercise.
// ═══════════════════════════════════════════════════════════════════════════════
package main

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kavach/backend/internal/bus"
	"github.com/kavach/backend/internal/notify"
)

const reportFamID = "fam-report"

func newTestGateway(t *testing.T) *gateway {
	t.Helper()
	b, err := bus.Open(filepath.Join(t.TempDir(), "bus"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = b.Close() })
	return &gateway{log: slog.Default(), bus: b, tickets: newTicketCache(slog.Default())}
}

// seedTicket bypasses ticketCache.follow (which needs a live bus subscriber
// loop) and writes the row directly — same package, same struct, no
// production code path skipped: consume() is exactly what authorise() and
// reportLocation() both call.
func seedTicket(gw *gateway, tk ticket) {
	gw.tickets.mu.Lock()
	gw.tickets.rows[tk.Ticket] = tk
	gw.tickets.mu.Unlock()
}

func TestReportLocation_ValidTicketPublishesLocationUpdate(t *testing.T) {
	gw := newTestGateway(t)
	seedTicket(gw, ticket{
		Ticket: "tk-1", FamilyID: reportFamID, DeviceID: "dev-1", MemberID: "mem-1",
		ExpiresAt: time.Now().Add(time.Minute).UnixMilli(),
	})

	ch, cancel := gw.bus.Subscribe(notify.StreamSubject(reportFamID), 0)
	defer cancel()

	req := httptest.NewRequest(http.MethodPost, "/v1/location-report", strings.NewReader(`{"sealed":"AQIDeGVhbGVk"}`))
	req.Header.Set("Kavach-Ticket", "tk-1")
	rec := httptest.NewRecorder()
	gw.reportLocation(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 — body %s", rec.Code, rec.Body.String())
	}

	select {
	case m := <-ch:
		if m.Subject != notify.StreamSubject(reportFamID) {
			t.Errorf("subject = %q, want the family's sealed stream", m.Subject)
		}
		var f notify.Frame
		if err := json.Unmarshal(m.Data, &f); err != nil {
			t.Fatalf("frame did not decode: %v", err)
		}
		if f.Type != "location.update" {
			t.Errorf("frame.Type = %q, want location.update — a receiver must not be able to tell this apart from a live WS report", f.Type)
		}
		data, _ := f.Data["memberId"].(string)
		if data != "mem-1" {
			t.Errorf("data.memberId = %q, want the ticket's bound member (attribution must come from the ticket, never the request body)", data)
		}
		sealed, _ := f.Data["sealed"].(string)
		if sealed != "AQIDeGVhbGVk" {
			t.Errorf("data.sealed = %q, want the ciphertext relayed opaquely", sealed)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no frame published within 2s")
	}
}

func TestReportLocation_MissingTicketIs401(t *testing.T) {
	gw := newTestGateway(t)

	req := httptest.NewRequest(http.MethodPost, "/v1/location-report", strings.NewReader(`{"sealed":"x"}`))
	rec := httptest.NewRecorder()
	gw.reportLocation(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestReportLocation_TicketIsSingleUse(t *testing.T) {
	gw := newTestGateway(t)
	seedTicket(gw, ticket{
		Ticket: "tk-once", FamilyID: reportFamID, DeviceID: "dev-1", MemberID: "mem-1",
		ExpiresAt: time.Now().Add(time.Minute).UnixMilli(),
	})

	first := httptest.NewRequest(http.MethodPost, "/v1/location-report", strings.NewReader(`{"sealed":"x"}`))
	first.Header.Set("Kavach-Ticket", "tk-once")
	rec1 := httptest.NewRecorder()
	gw.reportLocation(rec1, first)
	if rec1.Code != http.StatusNoContent {
		t.Fatalf("first attempt status = %d, want 204", rec1.Code)
	}

	second := httptest.NewRequest(http.MethodPost, "/v1/location-report", strings.NewReader(`{"sealed":"x"}`))
	second.Header.Set("Kavach-Ticket", "tk-once")
	rec2 := httptest.NewRecorder()
	gw.reportLocation(rec2, second)
	if rec2.Code != http.StatusUnauthorized {
		t.Fatalf("replayed-ticket status = %d, want 401 — a burned ticket must not work twice", rec2.Code)
	}
}

func TestReportLocation_MalformedBodyIs400(t *testing.T) {
	gw := newTestGateway(t)
	seedTicket(gw, ticket{
		Ticket: "tk-bad-body", FamilyID: reportFamID, DeviceID: "dev-1", MemberID: "mem-1",
		ExpiresAt: time.Now().Add(time.Minute).UnixMilli(),
	})

	req := httptest.NewRequest(http.MethodPost, "/v1/location-report", strings.NewReader(`{}`))
	req.Header.Set("Kavach-Ticket", "tk-bad-body")
	rec := httptest.NewRecorder()
	gw.reportLocation(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (empty sealed field)", rec.Code)
	}
}
