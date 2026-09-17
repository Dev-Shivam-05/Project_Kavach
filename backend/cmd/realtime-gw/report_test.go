// ═══════════════════════════════════════════════════════════════════════════════
// POST /v1/location-report — 6-D-6 · spec C1's response leg (F-16, F-20).
//
// This was the first test in realtime-gw (RISK.md, PROJECT_MAP.md danger
// zones): a direct test of the one plain HTTP handler this binary carries,
// which needs no hijacked connection and no WS handshake to exercise. The
// shared harness below (newTestGateway, seedTicket, awaitFrame) is what
// signal_test.go and ws_test.go build on.
// ═══════════════════════════════════════════════════════════════════════════════
package main

import (
	"context"
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

// newTestGateway builds a gateway on its own bus directory with the live
// relay running — the same graph main() assembles, minus the listener.
func newTestGateway(t *testing.T) *gateway {
	t.Helper()
	b, err := bus.Open(filepath.Join(t.TempDir(), "bus"))
	if err != nil {
		t.Fatal(err)
	}
	log := testLogger()
	gw := &gateway{log: log, bus: b, tickets: newTicketCache(log, b)}
	ctx, cancel := context.WithCancel(context.Background())
	if err := gw.startLiveRelay(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		gw.closeAll(closeNormal, "test over")
		cancel()
		_ = b.Close()
	})
	return gw
}

type discard struct{}

func (discard) Write(p []byte) (int, error) { return len(p), nil }

// testLogger keeps the package's output to failures only.
func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(discard{}, &slog.HandlerOptions{Level: slog.LevelError}))
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

// awaitFrame reads one bus message and decodes it, so a test never blocks for
// the whole package timeout when nothing is published.
func awaitFrame(t *testing.T, ch <-chan bus.Msg) notify.Frame {
	t.Helper()
	select {
	case m := <-ch:
		var f notify.Frame
		if err := json.Unmarshal(m.Data, &f); err != nil {
			t.Fatalf("frame did not decode: %v", err)
		}
		return f
	case <-time.After(2 * time.Second):
		t.Fatal("no frame published within 2s")
		return notify.Frame{}
	}
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

	f := awaitFrame(t, ch)
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

// TestReportLocation_ReducedTicketIs403 is F-20's second door. The socket path
// has always refused a reduced session that tries to publish; this POST spends
// the same ticket and must refuse the same session, or a neighbour injects
// location.update frames into the family's sealed stream over plain HTTP.
// Written red: before the guard this was a 204 and a published frame.
func TestReportLocation_ReducedTicketIs403(t *testing.T) {
	gw := newTestGateway(t)
	seedTicket(gw, ticket{
		Ticket: "tk-neighbour", FamilyID: reportFamID, DeviceID: "dev-n", MemberID: "mem-n", Reduced: true,
		ExpiresAt: time.Now().Add(time.Minute).UnixMilli(),
	})
	ch, cancel := gw.bus.Subscribe(notify.StreamSubject(reportFamID), 0)
	defer cancel()

	req := httptest.NewRequest(http.MethodPost, "/v1/location-report", strings.NewReader(`{"sealed":"AQID"}`))
	req.Header.Set("Kavach-Ticket", "tk-neighbour")
	rec := httptest.NewRecorder()
	gw.reportLocation(rec, req)

	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "KV-2001") {
		t.Fatalf("status = %d %s, want 403 KV-2001", rec.Code, rec.Body.String())
	}
	select {
	case m := <-ch:
		t.Fatalf("a reduced ticket published onto the sealed stream: %s", m.Data)
	case <-time.After(150 * time.Millisecond):
	}
}
