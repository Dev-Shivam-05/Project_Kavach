// ═══════════════════════════════════════════════════════════════════════════════
// watch.signal — 6-D-7 · spec D1/E1's signalling relay.
//
// This is the first test in this binary to drive handleMessage (the C→S frame
// path) rather than a plain HTTP handler. It needs no hijacked socket and no
// RFC 6455 handshake: a conn's queues are ordinary channels and slices, so a
// conn built the same way stream() builds one — minus raw/br/bw, which
// handleMessage never touches — exercises the real production function.
//
// What is being pinned here is a privacy property as much as a routing one:
// the gateway must relay the sealed blob byte-for-byte and must take the
// sender's identity from the TICKET, never from the request body. A relay that
// trusts a client-supplied `fromMemberId` would let any family member forge a
// watch session invite from any other.
// ═══════════════════════════════════════════════════════════════════════════════
package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"testing"
	"time"

	"github.com/kavach/backend/internal/bus"
	"github.com/kavach/backend/internal/notify"
)

const signalFamID = "fam-signal"

// newTestConn mirrors stream()'s own construction of a conn, minus the three
// socket fields (raw/br/bw). handleMessage, emit, publish and the push* queues
// touch none of them, so nothing is stubbed out that production would use.
func newTestConn(t *testing.T, gw *gateway, tk ticket) *conn {
	t.Helper()
	return &conn{
		gw: gw, log: slog.Default(),
		ticket: tk, subject: notify.StreamSubject(tk.FamilyID),
		critical: make(chan []byte, criticalCap),
		wake:     make(chan struct{}, 1),
		room:     make(chan struct{}, 1),
		coalesce: map[string][]byte{},
	}
}

func signalTicket() ticket {
	return ticket{
		Ticket: "tk-sig", FamilyID: signalFamID, DeviceID: "dev-viewer", MemberID: "mem-viewer",
		ExpiresAt: time.Now().Add(time.Minute).UnixMilli(),
	}
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

func TestWatchSignal_RelaysSealedBlobAndTicketIdentity(t *testing.T) {
	gw := newTestGateway(t)
	c := newTestConn(t, gw, signalTicket())

	ch, cancel := gw.bus.Subscribe(notify.StreamSubject(signalFamID), 0)
	defer cancel()

	// `fromMemberId` in the body is the forgery attempt: the relay must ignore
	// it entirely and stamp the ticket's member instead.
	c.handleMessage(context.Background(), []byte(`{"type":"watch.signal","data":{
		"sessionId":"sess-1","toMemberId":"mem-watched","fromMemberId":"mem-someone-else",
		"sealed":"AQIDc2VhbGVk"}}`))

	f := awaitFrame(t, ch)
	if f.Type != "watch.signal" {
		t.Fatalf("frame.Type = %q, want watch.signal", f.Type)
	}
	if f.Priority != notify.PriorityHigh {
		t.Errorf("priority = %v, want HIGH — LOW would coalesce the ICE candidate stream down to its last candidate", f.Priority)
	}
	if got, _ := f.Data["fromMemberId"].(string); got != "mem-viewer" {
		t.Errorf("data.fromMemberId = %q, want the ticket's member — a body-supplied sender would let anyone forge an invite", got)
	}
	if got, _ := f.Data["fromDeviceId"].(string); got != "dev-viewer" {
		t.Errorf("data.fromDeviceId = %q, want the ticket's device", got)
	}
	if got, _ := f.Data["toMemberId"].(string); got != "mem-watched" {
		t.Errorf("data.toMemberId = %q, want the body's routing field", got)
	}
	if got, _ := f.Data["sessionId"].(string); got != "sess-1" {
		t.Errorf("data.sessionId = %q, want sess-1", got)
	}
	if got, _ := f.Data["sealed"].(string); got != "AQIDc2VhbGVk" {
		t.Errorf("data.sealed = %q, want the ciphertext relayed byte-for-byte", got)
	}
}

func TestWatchSignal_MalformedIsRejectedWithoutPublishing(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"no data at all", `{"type":"watch.signal"}`},
		{"missing sessionId", `{"type":"watch.signal","data":{"toMemberId":"m","sealed":"x"}}`},
		{"missing toMemberId", `{"type":"watch.signal","data":{"sessionId":"s","sealed":"x"}}`},
		{"missing sealed", `{"type":"watch.signal","data":{"sessionId":"s","toMemberId":"m"}}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gw := newTestGateway(t)
			c := newTestConn(t, gw, signalTicket())

			ch, cancel := gw.bus.Subscribe(notify.StreamSubject(signalFamID), 0)
			defer cancel()

			c.handleMessage(context.Background(), []byte(tc.body))

			select {
			case m := <-ch:
				t.Fatalf("a malformed watch.signal was relayed anyway: %s", m.Data)
			case <-time.After(200 * time.Millisecond):
			}

			// The sender is told, on its own socket, rather than left waiting
			// for a session that will never open.
			select {
			case raw := <-c.critical:
				var f notify.Frame
				if err := json.Unmarshal(raw, &f); err != nil {
					t.Fatalf("error frame did not decode: %v", err)
				}
				if f.Type != "error" {
					t.Errorf("emitted frame.Type = %q, want error", f.Type)
				}
				if code, _ := f.Data["code"].(string); code != "KV-1001" {
					t.Errorf("error code = %q, want KV-1001", code)
				}
			default:
				t.Error("nothing was emitted back to the sender")
			}
		})
	}
}

// F-20: a neighbour (reduced) session is attached to the neighbour feed and is
// not a cryptographic member of the family. It may acknowledge an alert; it may
// not open a camera or a microphone on somebody's phone. The guard that stops
// it already existed for location.report — this pins that watch.signal is
// inside it too, because a new C→S type that forgot to be is invisible
// otherwise: every other test on the main path still passes.
func TestWatchSignal_ReducedSessionMayNotPublish(t *testing.T) {
	gw := newTestGateway(t)
	tk := signalTicket()
	tk.Reduced = true
	c := newTestConn(t, gw, tk)

	ch, cancel := gw.bus.Subscribe(notify.StreamSubject(signalFamID), 0)
	defer cancel()

	c.handleMessage(context.Background(), []byte(`{"type":"watch.signal","data":{
		"sessionId":"sess-1","toMemberId":"mem-watched","sealed":"AQIDc2VhbGVk"}}`))

	select {
	case m := <-ch:
		t.Fatalf("a reduced session opened a watch session: %s", m.Data)
	case <-time.After(200 * time.Millisecond):
	}

	select {
	case raw := <-c.critical:
		var f notify.Frame
		if err := json.Unmarshal(raw, &f); err != nil {
			t.Fatalf("error frame did not decode: %v", err)
		}
		if code, _ := f.Data["code"].(string); code != "KV-2001" {
			t.Errorf("error code = %q, want KV-2001 (reduced session may not publish)", code)
		}
	default:
		t.Error("the reduced sender was told nothing")
	}
}
