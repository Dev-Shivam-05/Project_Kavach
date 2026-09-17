// ═══════════════════════════════════════════════════════════════════════════════
// The C→S catalogue — 6-D-7 · spec D1/E1's signalling relay, presence, and
// the frame types this gateway refuses (§9.2, F-20, D-029, D-037).
//
// These tests drive handleMessage (the C→S frame path) without a hijacked
// socket: a conn's queues are ordinary channels and slices, so a conn built by
// newConn — the same constructor stream() uses, minus raw/br/bw, which
// handleMessage never touches — exercises the real production function.
//
// What is being pinned here is a privacy property as much as a routing one:
// the gateway must relay the sealed blob byte-for-byte and must take the
// sender's identity from the TICKET, never from the request body. A relay that
// trusts a client-supplied `fromMemberId` would let any family member forge a
// watch session invite from any other. And signalling must never touch the
// durable stream: an invite replayed on reconnect is a camera opened for a
// viewer who left an hour ago.
// ═══════════════════════════════════════════════════════════════════════════════
package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/kavach/backend/internal/notify"
)

const signalFamID = "fam-signal"

// newTestConn mirrors stream()'s own construction of a conn, minus the three
// socket fields (raw/br/bw). handleMessage, emit, publish and the push* queues
// touch none of them, so nothing is stubbed out that production would use.
// The conn is tracked on the gateway so the live relay can reach it.
func newTestConn(t *testing.T, gw *gateway, tk ticket) *conn {
	t.Helper()
	subject := notify.StreamSubject(tk.FamilyID)
	if tk.Reduced {
		subject = notify.ReducedSubject(tk.FamilyID)
	}
	c := newConn(gw, tk, subject, 0)
	gw.track(c)
	t.Cleanup(func() { gw.untrack(c) })
	return c
}

func signalTicket() ticket {
	return ticket{
		Ticket: "tk-sig", FamilyID: signalFamID, DeviceID: "dev-viewer", MemberID: "mem-viewer",
		ExpiresAt: time.Now().Add(time.Minute).UnixMilli(),
	}
}

func watchedTicket() ticket {
	return ticket{
		Ticket: "tk-watched", FamilyID: signalFamID, DeviceID: "dev-watched", MemberID: "mem-watched",
		ExpiresAt: time.Now().Add(time.Minute).UnixMilli(),
	}
}

// payloadOf decodes a queued frame's body the way a phone would.
func payloadOf(t *testing.T, of *outFrame) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(of.wf.Payload, &m); err != nil {
		t.Fatalf("payload is not a JSON object: %v (%s)", err, of.wf.Payload)
	}
	return m
}

// awaitHigh waits for the live relay (which runs on the bus's own goroutine)
// to land a frame on a conn's HIGH queue.
func awaitHigh(t *testing.T, c *conn) *outFrame {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if of, ok := c.popHigh(); ok {
			return of
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("no frame reached the receiving socket within 2s")
	return nil
}

func awaitLow(t *testing.T, c *conn) *outFrame {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if of, ok := c.popLow(); ok {
			return of
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("no frame reached the receiving socket within 2s")
	return nil
}

// takeCritical reads what the sender was told on its own socket.
func takeCritical(t *testing.T, c *conn) *outFrame {
	t.Helper()
	select {
	case of := <-c.critical:
		return of
	default:
		t.Fatal("nothing was emitted back to the sender")
		return nil
	}
}

func TestWatchSignal_RelaysSealedBlobAndTicketIdentity(t *testing.T) {
	gw := newTestGateway(t)
	viewer := newTestConn(t, gw, signalTicket())
	watched := newTestConn(t, gw, watchedTicket())

	// `fromMemberId` in the body is the forgery attempt: the relay must ignore
	// it entirely and stamp the ticket's member instead.
	viewer.handleMessage(context.Background(), []byte(`{"type":"watch.signal","data":{
		"sessionId":"sess-1","toMemberId":"mem-watched","fromMemberId":"mem-someone-else",
		"sealed":"AQIDc2VhbGVk"}}`))

	of := awaitHigh(t, watched)
	if of.wf.Type != "watch.signal" {
		t.Fatalf("frame.Type = %q, want watch.signal", of.wf.Type)
	}
	if of.wf.Priority != notify.PriorityHigh {
		t.Errorf("priority = %v, want HIGH — LOW would coalesce the ICE candidate stream down to its last candidate", of.wf.Priority)
	}
	if of.seq != 0 {
		t.Errorf("seq = %d, want 0 — a live relay carries no durable position", of.seq)
	}
	p := payloadOf(t, of)
	if got, _ := p["fromMemberId"].(string); got != "mem-viewer" {
		t.Errorf("payload.fromMemberId = %q, want the ticket's member — a body-supplied sender would let anyone forge an invite", got)
	}
	if got, _ := p["fromDeviceId"].(string); got != "dev-viewer" {
		t.Errorf("payload.fromDeviceId = %q, want the ticket's device", got)
	}
	if got, _ := p["toMemberId"].(string); got != "mem-watched" {
		t.Errorf("payload.toMemberId = %q, want the body's routing field", got)
	}
	if got, _ := p["sessionId"].(string); got != "sess-1" {
		t.Errorf("payload.sessionId = %q, want sess-1", got)
	}
	if got, _ := p["sealed"].(string); got != "AQIDc2VhbGVk" {
		t.Errorf("payload.sealed = %q, want the ciphertext relayed byte-for-byte", got)
	}
}

// TestWatchSignal_IsNeverWrittenToTheDurableStream is D-029 at the transport:
// an invite that survives on disk is re-applied by every reconnect's replay,
// and the watched phone's camera opens for a viewer who is not there.
func TestWatchSignal_IsNeverWrittenToTheDurableStream(t *testing.T) {
	gw := newTestGateway(t)
	viewer := newTestConn(t, gw, signalTicket())
	watched := newTestConn(t, gw, watchedTicket())

	before := gw.bus.LastSeq()
	viewer.handleMessage(context.Background(), []byte(`{"type":"watch.signal","payload":{
		"sessionId":"sess-1","toMemberId":"mem-watched","sealed":"AQIDc2VhbGVk"}}`))
	awaitHigh(t, watched) // it did arrive live…

	if after := gw.bus.LastSeq(); after != before {
		t.Fatalf("the durable stream grew from %d to %d — signalling was persisted", before, after)
	}
	// …and the sender is a socket on the same subject, so it hears its own
	// relay too (the client filters on toMemberId). What it must NOT have is a
	// durable position it could resume from.
	if of, ok := viewer.popHigh(); ok && of.seq != 0 {
		t.Fatalf("relayed signal carries durable seq %d", of.seq)
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
			viewer := newTestConn(t, gw, signalTicket())
			watched := newTestConn(t, gw, watchedTicket())

			viewer.handleMessage(context.Background(), []byte(tc.body))

			time.Sleep(100 * time.Millisecond)
			if of, ok := watched.popHigh(); ok {
				t.Fatalf("a malformed watch.signal was relayed anyway: %s", of.wf.Payload)
			}

			// The sender is told, on its own socket, rather than left waiting
			// for a session that will never open.
			of := takeCritical(t, viewer)
			if of.wf.Type != "error" {
				t.Errorf("emitted frame.Type = %q, want error", of.wf.Type)
			}
			if code, _ := payloadOf(t, of)["code"].(string); code != "KV-1001" {
				t.Errorf("error code = %q, want KV-1001", code)
			}
		})
	}
}

// F-20: a neighbour (reduced) session is attached to the neighbour feed and is
// not a cryptographic member of the family. It may keep its socket alive; it
// may not open a camera or a microphone on somebody's phone, or inject
// presence. The guard is one `if` for every type but ping, because a new C→S
// type that forgot to be inside it would be invisible: every other test on the
// main path still passes.
func TestReducedSession_MayOnlyPing(t *testing.T) {
	for _, body := range []string{
		`{"type":"watch.signal","data":{"sessionId":"sess-1","toMemberId":"mem-watched","sealed":"AQIDc2VhbGVk"}}`,
		`{"type":"location.report","payload":"AQIDc2VhbGVk"}`,
		`{"type":"heartbeat","payload":{}}`,
	} {
		t.Run(body[9:20], func(t *testing.T) {
			gw := newTestGateway(t)
			tk := signalTicket()
			tk.Reduced = true
			c := newTestConn(t, gw, tk)
			ch, cancel := gw.bus.Subscribe(notify.StreamSubject(signalFamID), 0)
			defer cancel()

			c.handleMessage(context.Background(), []byte(body))

			select {
			case m := <-ch:
				t.Fatalf("a reduced session published onto the sealed stream: %s", m.Data)
			case <-time.After(100 * time.Millisecond):
			}
			of := takeCritical(t, c)
			if code, _ := payloadOf(t, of)["code"].(string); code != "KV-2001" {
				t.Errorf("error code = %q, want KV-2001 (reduced session may not publish)", code)
			}
		})
	}

	t.Run("ping is still answered", func(t *testing.T) {
		gw := newTestGateway(t)
		tk := signalTicket()
		tk.Reduced = true
		c := newTestConn(t, gw, tk)
		c.handleMessage(context.Background(), []byte(`{"type":"ping","payload":{"at":1}}`))
		if of := takeCritical(t, c); of.wf.Type != "pong" {
			t.Fatalf("a reduced session's ping was answered with %q, want pong", of.wf.Type)
		}
	})
}

// ── the payload/data alias (6-D-7d) ──────────────────────────────────────────

// `mobile/src/net/ws.ts`'s WsFrame is `{type, hlc, key, payload, priority}` — it
// has no `data` field and never has. This handler read only `data`, so every
// C→S frame the app ever sent arrived with a nil body and was relayed as
// `"sealed": null`, which the receiving client then dropped for being empty.
// Nothing failed anywhere: a nil json.RawMessage marshals to `null`. These two
// tests are the only thing standing between that and happening again.
func TestClientFrame_PayloadIsAcceptedAsDataAlias(t *testing.T) {
	gw := newTestGateway(t)
	c := newTestConn(t, gw, signalTicket())

	ch, cancel := gw.bus.Subscribe(notify.StreamSubject(signalFamID), 0)
	defer cancel()

	// Exactly the shape sendFrame() puts on the wire for an ambient fix.
	c.handleMessage(context.Background(),
		[]byte(`{"type":"location.report","key":"loc","priority":"LOW","payload":"AQIDc2VhbGVk"}`))

	f := awaitFrame(t, ch)
	if f.Type != "location.update" {
		t.Fatalf("frame.Type = %q, want location.update", f.Type)
	}
	sealed, _ := f.Data["sealed"].(string)
	if sealed != "AQIDc2VhbGVk" {
		t.Errorf("data.sealed = %#v, want the ciphertext — a null here is the silent drop this test exists for", f.Data["sealed"])
	}
}

func TestClientFrame_DataStillWinsOverPayload(t *testing.T) {
	gw := newTestGateway(t)
	c := newTestConn(t, gw, signalTicket())

	ch, cancel := gw.bus.Subscribe(notify.StreamSubject(signalFamID), 0)
	defer cancel()

	c.handleMessage(context.Background(),
		[]byte(`{"type":"location.report","data":"REAL","payload":"ALIAS"}`))

	f := awaitFrame(t, ch)
	if sealed, _ := f.Data["sealed"].(string); sealed != "REAL" {
		t.Errorf("data.sealed = %q, want REAL — the alias must not shadow a client that does send data", sealed)
	}
}

// ── presence and the refused types ───────────────────────────────────────────

// TestHeartbeat_IsLiveOnlyAndDoesNotEchoTheBody: presence is a 45 s TTL
// (§2.5.2), not history. Before this it was appended to the durable stream with
// the client's whole body inside it — up to a megabyte per frame, replayed to
// every reconnecting socket for the life of the deployment.
func TestHeartbeat_IsLiveOnlyAndDoesNotEchoTheBody(t *testing.T) {
	gw := newTestGateway(t)
	sender := newTestConn(t, gw, signalTicket())
	other := newTestConn(t, gw, watchedTicket())

	before := gw.bus.LastSeq()
	sender.handleMessage(context.Background(),
		[]byte(`{"type":"heartbeat","payload":{"junk":"`+strings.Repeat("x", 4096)+`"}}`))

	of := awaitLow(t, other)
	if of.wf.Type != "presence.changed" || of.wf.Priority != notify.PriorityLow {
		t.Fatalf("got %s/%s, want presence.changed/LOW", of.wf.Type, of.wf.Priority)
	}
	if of.wf.Key != "presence:mem-viewer" {
		t.Errorf("key = %q, want presence:<memberId> so a backlog coalesces to the newest tick", of.wf.Key)
	}
	p := payloadOf(t, of)
	if _, echoed := p["raw"]; echoed {
		t.Error("the client's body was echoed into the relay")
	}
	if got, _ := p["memberId"].(string); got != "mem-viewer" {
		t.Errorf("payload.memberId = %q, want the ticket's member", got)
	}
	if after := gw.bus.LastSeq(); after != before {
		t.Fatalf("presence was written to the durable stream (%d → %d)", before, after)
	}
}

// TestRefusedTypes_AreAnsweredAndPublishedNowhere pins the negative half of the
// catalogue. `ack` used to publish an `incident.acked` frame that no engine
// ever acted on — a t4 that was never recorded, presented as if it were.
// `incident.open` was silently credited by the client's dispatcher as a
// transmitted leg while the gateway dropped it as unknown.
func TestRefusedTypes_AreAnsweredAndPublishedNowhere(t *testing.T) {
	for _, body := range []string{
		`{"type":"ack","payload":{"incidentId":"inc-1"}}`,
		`{"type":"incident.open","priority":"CRITICAL","payload":"{\"t\":\"incident_open\"}"}`,
		`{"type":"no.such.type","payload":{}}`,
	} {
		t.Run(body[9:20], func(t *testing.T) {
			gw := newTestGateway(t)
			c := newTestConn(t, gw, signalTicket())
			other := newTestConn(t, gw, watchedTicket())
			before := gw.bus.LastSeq()

			c.handleMessage(context.Background(), []byte(body))

			of := takeCritical(t, c)
			if of.wf.Type != "error" {
				t.Fatalf("answered with %q, want error", of.wf.Type)
			}
			if code, _ := payloadOf(t, of)["code"].(string); code != "KV-1001" {
				t.Errorf("code = %q, want KV-1001", code)
			}
			if after := gw.bus.LastSeq(); after != before {
				t.Errorf("a refused frame reached the durable stream (%d → %d)", before, after)
			}
			time.Sleep(50 * time.Millisecond)
			if _, ok := other.popHigh(); ok {
				t.Error("a refused frame was relayed live")
			}
		})
	}
}
