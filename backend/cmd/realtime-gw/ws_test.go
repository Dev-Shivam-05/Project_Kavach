// ═══════════════════════════════════════════════════════════════════════════════
// The socket itself — handshake, RFC 6455 codec, the ticket ledger, replay
// from a cursor, and the order the writer puts frames on the wire
// (§2.5.2 · F-16 · I-6 · RISK.md S2 item 4).
//
// Until this file the hand-written WebSocket had no test at all: report_test
// and signal_test drive handlers, not bytes. Everything here goes through a
// real listener and a real TCP dial with a minimal client-side encoder, so a
// masking bug, a length-field bug, a burned ticket or a mis-stamped cursor
// fails HERE rather than on a phone. The one thing it cannot do is prove the
// four-container topology (D-027): it is one process, one *Bus.
// ═══════════════════════════════════════════════════════════════════════════════
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/kavach/backend/internal/bus"
	"github.com/kavach/backend/internal/notify"
)

const wsFamID = "fam-ws"

// newTestServer is main()'s mux over newTestGateway's graph.
func newTestServer(t *testing.T) (*gateway, *httptest.Server) {
	t.Helper()
	gw := newTestGateway(t)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/stream", gw.stream)
	mux.HandleFunc("POST /v1/location-report", gw.reportLocation)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return gw, srv
}

func liveTicket(raw string) ticket {
	return ticket{
		Ticket: raw, FamilyID: wsFamID, DeviceID: "dev-ws", MemberID: "mem-ws",
		ExpiresAt: time.Now().Add(time.Minute).UnixMilli(),
	}
}

// wsClient is the smallest RFC 6455 client that can drive this gateway: a
// raw TCP connection, a hand-written handshake, masked frames out, unmasked
// frames in.
type wsClient struct {
	conn net.Conn
	br   *bufio.Reader
}

// dialWS performs the handshake and returns the HTTP response. On 101 the
// client is live; on anything else the connection is closed and only the
// response is meaningful.
func dialWS(t *testing.T, srv *httptest.Server, headers map[string]string, query string) (*wsClient, *http.Response) {
	t.Helper()
	conn, err := net.Dial("tcp", strings.TrimPrefix(srv.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))

	var key [16]byte
	_, _ = rand.Read(key[:])
	h := map[string]string{
		"Connection":            "Upgrade",
		"Upgrade":               "websocket",
		"Sec-WebSocket-Version": "13",
		"Sec-WebSocket-Key":     base64.StdEncoding.EncodeToString(key[:]),
	}
	for k, v := range headers {
		if v == "" {
			delete(h, k)
		} else {
			h[k] = v
		}
	}
	var req bytes.Buffer
	req.WriteString("GET /v1/stream" + query + " HTTP/1.1\r\nHost: " + conn.RemoteAddr().String() + "\r\n")
	for k, v := range h {
		req.WriteString(k + ": " + v + "\r\n")
	}
	req.WriteString("\r\n")
	if _, err := conn.Write(req.Bytes()); err != nil {
		t.Fatal(err)
	}
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodGet})
	if err != nil {
		t.Fatalf("no HTTP response to the handshake: %v", err)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		_, _ = io.ReadAll(resp.Body)
		_ = conn.Close()
		return nil, resp
	}
	c := &wsClient{conn: conn, br: br}
	t.Cleanup(func() { _ = conn.Close() })
	return c, resp
}

// send writes one masked client frame (RFC 6455 §5.3).
func (c *wsClient) send(t *testing.T, opcode byte, payload []byte) {
	t.Helper()
	var head []byte
	n := len(payload)
	switch {
	case n <= 125:
		head = []byte{0x80 | opcode, 0x80 | byte(n)}
	case n <= 0xffff:
		head = []byte{0x80 | opcode, 0x80 | 126, byte(n >> 8), byte(n)}
	default:
		head = make([]byte, 10)
		head[0], head[1] = 0x80|opcode, 0x80|127
		binary.BigEndian.PutUint64(head[2:], uint64(n))
	}
	var mask [4]byte
	_, _ = rand.Read(mask[:])
	out := append(head, mask[:]...)
	for i, b := range payload {
		out = append(out, b^mask[i%4])
	}
	if _, err := c.conn.Write(out); err != nil {
		t.Fatal(err)
	}
}

// recv reads one server frame. Server frames are never masked.
func (c *wsClient) recv(t *testing.T) (byte, []byte) {
	t.Helper()
	var head [2]byte
	if _, err := io.ReadFull(c.br, head[:]); err != nil {
		t.Fatalf("read frame head: %v", err)
	}
	if head[1]&0x80 != 0 {
		t.Fatal("server frame is masked (RFC 6455 §5.1 forbids it)")
	}
	n := uint64(head[1] & 0x7f)
	switch n {
	case 126:
		var ext [2]byte
		_, _ = io.ReadFull(c.br, ext[:])
		n = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		_, _ = io.ReadFull(c.br, ext[:])
		n = binary.BigEndian.Uint64(ext[:])
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(c.br, buf); err != nil {
		t.Fatalf("read frame body: %v", err)
	}
	return head[0] & 0x0f, buf
}

// next returns the next application frame, answering pings on the way.
func (c *wsClient) next(t *testing.T) wireFrame {
	t.Helper()
	for {
		op, body := c.recv(t)
		switch op {
		case opPing:
			c.send(t, opPong, body)
		case opText:
			var wf wireFrame
			if err := json.Unmarshal(body, &wf); err != nil {
				t.Fatalf("server frame is not a wireFrame: %v (%s)", err, body)
			}
			return wf
		case opClose:
			code := int(binary.BigEndian.Uint16(body[:2]))
			t.Fatalf("server closed the socket: %d %s", code, body[2:])
		}
	}
}

func publishStream(t *testing.T, b *bus.Bus, f notify.Frame) uint64 {
	t.Helper()
	seq, err := b.PublishMsg(bus.Msg{Subject: notify.StreamSubject(wsFamID), FamilyID: wsFamID, Data: f.Encode()})
	if err != nil {
		t.Fatal(err)
	}
	return seq
}

func frame(typ string, prio notify.Priority, key string, data map[string]any) notify.Frame {
	return notify.Frame{V: notify.FrameVersion, Type: typ, Priority: prio, Key: key,
		FamilyID: wsFamID, At: 1_700_000_000_000, Data: data}
}

// ── Handshake ────────────────────────────────────────────────────────────────

// TestHandshake_RefusalsDoNotBurnTheTicket: every precondition is checked
// before the single-use ticket is consumed, so a proxy that strips Upgrade or
// a client with a broken handshake can retry with the ticket it already has
// instead of minting another during exactly the outage it is riding out.
func TestHandshake_RefusalsDoNotBurnTheTicket(t *testing.T) {
	cases := []struct {
		name    string
		headers map[string]string
		status  int
	}{
		{"wrong version", map[string]string{"Sec-WebSocket-Version": "8"}, http.StatusUpgradeRequired},
		{"missing key", map[string]string{"Sec-WebSocket-Key": ""}, http.StatusBadRequest},
		{"malformed key", map[string]string{"Sec-WebSocket-Key": "not-sixteen-bytes"}, http.StatusBadRequest},
		{"no upgrade", map[string]string{"Upgrade": "", "Connection": "keep-alive"}, http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gw, srv := newTestServer(t)
			seedTicket(gw, liveTicket("tk-keep"))
			tc.headers["Sec-WebSocket-Protocol"] = "kavach.v1, ticket.tk-keep"

			_, resp := dialWS(t, srv, tc.headers, "")
			if resp.StatusCode != tc.status {
				t.Fatalf("status = %d, want %d", resp.StatusCode, tc.status)
			}
			if tc.status == http.StatusUpgradeRequired && resp.Header.Get("Sec-WebSocket-Version") != "13" {
				t.Error("a 426 must advertise the version it does speak")
			}
			if gw.tickets.size() != 1 {
				t.Fatal("a refused handshake burned the ticket")
			}
		})
	}
}

func TestHandshake_MissingTicketIs401(t *testing.T) {
	_, srv := newTestServer(t)
	_, resp := dialWS(t, srv, map[string]string{"Sec-WebSocket-Protocol": "kavach.v1"}, "")
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", resp.StatusCode)
	}
}

func TestHandshake_NonGetIs405(t *testing.T) {
	_, srv := newTestServer(t)
	resp, err := http.Post(srv.URL+"/v1/stream", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", resp.StatusCode)
	}
}

// TestHandshake_AcceptAndSubprotocol pins the one piece of the RFC a browser
// or React Native's WebSocket checks itself: the Sec-WebSocket-Accept hash and
// the echoed subprotocol. A wrong hash is a socket that never opens on any
// client, with no server-side symptom.
func TestHandshake_AcceptAndSubprotocol(t *testing.T) {
	gw, srv := newTestServer(t)
	seedTicket(gw, liveTicket("tk-ok"))

	c, resp := dialWS(t, srv, map[string]string{"Sec-WebSocket-Protocol": "kavach.v1, ticket.tk-ok"}, "")
	if c == nil {
		t.Fatalf("status = %d, want 101", resp.StatusCode)
	}
	if resp.Header.Get("Sec-WebSocket-Protocol") != subprotocol {
		t.Errorf("subprotocol = %q, want %q", resp.Header.Get("Sec-WebSocket-Protocol"), subprotocol)
	}
	if resp.Header.Get("Sec-WebSocket-Accept") == "" {
		t.Error("no Sec-WebSocket-Accept")
	}
	if gw.tickets.size() != 0 {
		t.Error("the ticket was not consumed by a successful upgrade")
	}
	// An empty stream: the first and only frame is sync.complete at cursor 0.
	wf := c.next(t)
	if wf.Type != "sync.complete" || wf.Cursor != "0" {
		t.Fatalf("first frame = %s cursor=%q, want sync.complete at cursor 0", wf.Type, wf.Cursor)
	}
	var p struct {
		Truncated bool `json:"truncated"`
	}
	if err := json.Unmarshal(wf.Payload, &p); err != nil || p.Truncated {
		t.Fatalf("sync.complete payload = %s, want {\"truncated\":false}", wf.Payload)
	}
}

// ── Codec ────────────────────────────────────────────────────────────────────

func TestCodec_MaskedRoundTripAllLengthForms(t *testing.T) {
	for _, n := range []int{0, 1, 125, 126, 300, 0xffff, maxPayload} {
		payload := bytes.Repeat([]byte{0xA5}, n)
		var buf bytes.Buffer
		// A masked client frame, encoded by hand into a buffer.
		var head []byte
		switch {
		case n <= 125:
			head = []byte{0x80 | opText, 0x80 | byte(n)}
		case n <= 0xffff:
			head = []byte{0x80 | opText, 0x80 | 126, byte(n >> 8), byte(n)}
		default:
			head = make([]byte, 10)
			head[0], head[1] = 0x80|opText, 0x80|127
			binary.BigEndian.PutUint64(head[2:], uint64(n))
		}
		mask := [4]byte{1, 2, 3, 4}
		buf.Write(head)
		buf.Write(mask[:])
		for i, b := range payload {
			buf.WriteByte(b ^ mask[i%4])
		}
		f, err := readFrame(bufio.NewReader(&buf))
		if err != nil {
			t.Fatalf("n=%d: %v", n, err)
		}
		if !f.fin || f.opcode != opText || !bytes.Equal(f.payload, payload) {
			t.Fatalf("n=%d: frame did not round-trip", n)
		}

		// And the server direction: writeFrame's output must decode as an
		// unmasked frame of the same length form.
		var out bytes.Buffer
		bw := bufio.NewWriter(&out)
		if err := writeFrame(bw, opText, payload); err != nil {
			t.Fatal(err)
		}
		cl := &wsClient{br: bufio.NewReader(&out)}
		op, body := cl.recv(t)
		if op != opText || !bytes.Equal(body, payload) {
			t.Fatalf("n=%d: server frame did not round-trip", n)
		}
	}
}

func TestCodec_ProtocolErrors(t *testing.T) {
	cases := []struct {
		name string
		raw  []byte
		code int
	}{
		{"unmasked client frame", []byte{0x81, 0x01, 'x'}, closeProtocol},
		{"reserved bits", []byte{0xF1, 0x81, 1, 2, 3, 4, 'x'}, closeProtocol},
		{"fragmented control frame", []byte{0x09, 0x80, 1, 2, 3, 4}, closeProtocol},
		{"control frame over 125", []byte{0x89, 0x80 | 126, 0x00, 0x7e, 1, 2, 3, 4}, closeProtocol},
		{"payload over the cap", func() []byte {
			b := []byte{0x81, 0x80 | 127}
			var ext [8]byte
			binary.BigEndian.PutUint64(ext[:], uint64(maxPayload)+1)
			return append(b, ext[:]...)
		}(), closeTooBig},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := readFrame(bufio.NewReader(bytes.NewReader(tc.raw)))
			var we wsError
			if err == nil || !asWsError(err, &we) || we.code != tc.code {
				t.Fatalf("err = %v, want close code %d", err, tc.code)
			}
		})
	}
}

func asWsError(err error, we *wsError) bool {
	e, ok := err.(wsError)
	if ok {
		*we = e
	}
	return ok
}

// ── Ping / pong and the C→S path over real bytes ─────────────────────────────

func TestSocket_PingIsAnsweredWithPong(t *testing.T) {
	gw, srv := newTestServer(t)
	seedTicket(gw, liveTicket("tk-ping"))
	c, _ := dialWS(t, srv, map[string]string{"Sec-WebSocket-Protocol": "kavach.v1, ticket.tk-ping"}, "")
	if c == nil {
		t.Fatal("upgrade failed")
	}
	if wf := c.next(t); wf.Type != "sync.complete" {
		t.Fatalf("first frame = %s", wf.Type)
	}
	// Exactly what ws.ts's startHeartbeat sends.
	c.send(t, opText, []byte(`{"type":"ping","priority":"LOW","payload":{"at":1700000000000}}`))
	wf := c.next(t)
	if wf.Type != "pong" {
		t.Fatalf("got %s, want pong", wf.Type)
	}
	if wf.Cursor != "0" {
		t.Errorf("pong cursor = %q, want the unchanged watermark 0", wf.Cursor)
	}

	// A control-frame ping from the client is answered at the codec level.
	c.send(t, opPing, []byte("hi"))
	op, body := c.recv(t)
	if op != opPong || string(body) != "hi" {
		t.Fatalf("got opcode %d %q, want pong echoing the payload", op, body)
	}
}

// ── Replay, cursor and the writer's order ────────────────────────────────────

// TestReplay_FromCursorDeliversOnlyLaterFramesAsPayload is cpgw-2 and D-037's
// mirror in one: the client echoes the cursor it was given, gets only what it
// has not seen, and every frame's body arrives under `payload`.
func TestReplay_FromCursorDeliversOnlyLaterFramesAsPayload(t *testing.T) {
	gw, srv := newTestServer(t)
	seq1 := publishStream(t, gw.bus, frame("incident.state_changed", notify.PriorityCritical, "", map[string]any{"to": "ACTIVE_L1", "n": 1}))
	publishStream(t, gw.bus, frame("incident.state_changed", notify.PriorityCritical, "", map[string]any{"to": "ACTIVE_L2", "n": 2}))
	seq3 := publishStream(t, gw.bus, frame("incident.claimed", notify.PriorityCritical, "", map[string]any{"ownerMemberId": "mem-2", "n": 3}))

	seedTicket(gw, liveTicket("tk-resume"))
	c, _ := dialWS(t, srv, map[string]string{"Sec-WebSocket-Protocol": "kavach.v1, ticket.tk-resume"},
		"?cursor="+itoa(seq1))
	if c == nil {
		t.Fatal("upgrade failed")
	}

	var got []wireFrame
	for {
		wf := c.next(t)
		got = append(got, wf)
		if wf.Type == "sync.complete" {
			break
		}
	}
	if len(got) != 3 {
		t.Fatalf("received %d frames, want 2 replayed + sync.complete: %+v", len(got), got)
	}
	for i, want := range []int{2, 3} {
		var p struct {
			N int `json:"n"`
		}
		if err := json.Unmarshal(got[i].Payload, &p); err != nil || p.N != want {
			t.Fatalf("frame %d payload = %s, want n=%d — the body must arrive under `payload`", i, got[i].Payload, want)
		}
		if got[i].FamilyID != wsFamID || got[i].Priority != notify.PriorityCritical {
			t.Errorf("frame %d lost its top-level fields: %+v", i, got[i])
		}
	}
	// The cursor after the last replayed frame, and on sync.complete, is the
	// last position written — everything owed is on the wire.
	if got[1].Cursor != itoa(seq3) || got[2].Cursor != itoa(seq3) {
		t.Errorf("cursors = %q,%q, want %d on both the last frame and sync.complete", got[1].Cursor, got[2].Cursor, seq3)
	}
	if got[0].Cursor != itoa(seq1+1) {
		t.Errorf("first replayed frame cursor = %q, want its own position %d", got[0].Cursor, seq1+1)
	}
}

// TestReplay_UnparseableCursorStartsFromTheSnapshot: a cursor from before the
// cursor was a Seq (the client used to persist an HLC string) must not lock a
// phone out — it replays as if none was sent, and says so in the log.
func TestReplay_UnparseableCursorStartsFromTheSnapshot(t *testing.T) {
	gw, srv := newTestServer(t)
	publishStream(t, gw.bus, frame("incident.claimed", notify.PriorityCritical, "", map[string]any{"n": 1}))
	seedTicket(gw, liveTicket("tk-hlc"))
	c, _ := dialWS(t, srv, map[string]string{"Sec-WebSocket-Protocol": "kavach.v1, ticket.tk-hlc"},
		"?cursor=0000018bcfe0000100aabbccdd")
	if c == nil {
		t.Fatal("upgrade failed")
	}
	if wf := c.next(t); wf.Type != "incident.claimed" {
		t.Fatalf("first frame = %s, want the replayed incident.claimed", wf.Type)
	}
}

// TestWriter_StrictPriorityWithHonestCursors is the backpressure rule and the
// watermark together. Four records are on the stream when the client
// connects: two LOW on one key, one HIGH, one CRITICAL. The wire order must be
// CRITICAL, sync.complete, HIGH, then ONE LOW (the newer) — and the cursor on
// the CRITICAL frame must NOT claim the HIGH one that was queued earlier and
// written later.
func TestWriter_StrictPriorityWithHonestCursors(t *testing.T) {
	gw, srv := newTestServer(t)
	publishStream(t, gw.bus, frame("location.update", notify.PriorityLow, "loc:m1", map[string]any{"v": 1}))
	seqLow2 := publishStream(t, gw.bus, frame("location.update", notify.PriorityLow, "loc:m1", map[string]any{"v": 2}))
	seqHigh := publishStream(t, gw.bus, frame("journey.updated", notify.PriorityHigh, "journey:j1", map[string]any{"state": "arrived"}))
	seqCrit := publishStream(t, gw.bus, frame("incident.claimed", notify.PriorityCritical, "", map[string]any{"ownerMemberId": "m2"}))

	seedTicket(gw, liveTicket("tk-order"))
	c, _ := dialWS(t, srv, map[string]string{"Sec-WebSocket-Protocol": "kavach.v1, ticket.tk-order"}, "")
	if c == nil {
		t.Fatal("upgrade failed")
	}
	var got []wireFrame
	for len(got) < 4 {
		got = append(got, c.next(t))
	}
	types := []string{got[0].Type, got[1].Type, got[2].Type, got[3].Type}
	want := []string{"incident.claimed", "sync.complete", "journey.updated", "location.update"}
	for i := range want {
		if types[i] != want[i] {
			t.Fatalf("wire order = %v, want %v", types, want)
		}
	}
	var v struct {
		V int `json:"v"`
	}
	if err := json.Unmarshal(got[3].Payload, &v); err != nil || v.V != 2 {
		t.Errorf("LOW frame payload = %s, want only the newer v=2 (coalesced by key)", got[3].Payload)
	}
	// The CRITICAL frame jumped the queue; its cursor must stop short of the
	// HIGH and LOW positions still owed.
	if got[0].Cursor != itoa(seqLow2-1) {
		t.Errorf("CRITICAL cursor = %q, want %d (one before the oldest still-queued position)", got[0].Cursor, seqLow2-1)
	}
	if got[1].Cursor != itoa(seqLow2-1) {
		t.Errorf("sync.complete cursor = %q, want %d — it must not claim delivery of frames not yet written", got[1].Cursor, seqLow2-1)
	}
	if got[2].Cursor != itoa(seqLow2-1) {
		t.Errorf("HIGH cursor = %q, want %d (the LOW is still owed)", got[2].Cursor, seqLow2-1)
	}
	if got[3].Cursor != itoa(seqCrit) {
		t.Errorf("last cursor = %q, want %d — everything is written now", got[3].Cursor, seqCrit)
	}
	_ = seqHigh
}

// TestReplay_SkipsDurableWatchSignalRecords: a watch.signal an older build
// left on the durable stream is not re-delivered on reconnect (D-029), and the
// cursor still moves past it so the client does not replay it for ever.
func TestReplay_SkipsDurableWatchSignalRecords(t *testing.T) {
	gw, srv := newTestServer(t)
	publishStream(t, gw.bus, frame("watch.signal", notify.PriorityHigh, "", map[string]any{"sessionId": "old", "toMemberId": "mem-ws"}))
	seqLast := publishStream(t, gw.bus, frame("watch.signal", notify.PriorityHigh, "", map[string]any{"sessionId": "old2", "toMemberId": "mem-ws"}))

	seedTicket(gw, liveTicket("tk-skip"))
	c, _ := dialWS(t, srv, map[string]string{"Sec-WebSocket-Protocol": "kavach.v1, ticket.tk-skip"}, "")
	if c == nil {
		t.Fatal("upgrade failed")
	}
	wf := c.next(t)
	if wf.Type != "sync.complete" {
		t.Fatalf("a durable watch.signal was replayed: %s", wf.Type)
	}
	if wf.Cursor != itoa(seqLast) {
		t.Errorf("cursor = %q, want %d — skipped records still advance the cursor", wf.Cursor, seqLast)
	}
}

// TestLiveRelay_ReachesASocketOverRealBytes closes the loop on the ephemeral
// path: a watch.signal sent by one socket arrives on another, under
// `payload`, with no cursor movement.
func TestLiveRelay_ReachesASocketOverRealBytes(t *testing.T) {
	gw, srv := newTestServer(t)
	seedTicket(gw, liveTicket("tk-a"))
	seedTicket(gw, ticket{Ticket: "tk-b", FamilyID: wsFamID, DeviceID: "dev-b", MemberID: "mem-b",
		ExpiresAt: time.Now().Add(time.Minute).UnixMilli()})
	a, _ := dialWS(t, srv, map[string]string{"Sec-WebSocket-Protocol": "kavach.v1, ticket.tk-a"}, "")
	b, _ := dialWS(t, srv, map[string]string{"Sec-WebSocket-Protocol": "kavach.v1, ticket.tk-b"}, "")
	if a == nil || b == nil {
		t.Fatal("upgrade failed")
	}
	a.next(t) // sync.complete
	b.next(t)

	// Two consumed tickets have already written two spend records; the
	// signal itself must add nothing.
	before := gw.bus.LastSeq()
	a.send(t, opText, []byte(`{"type":"watch.signal","priority":"HIGH","payload":{"sessionId":"s1","toMemberId":"mem-b","sealed":"AQID"}}`))
	wf := b.next(t)
	if wf.Type != "watch.signal" {
		t.Fatalf("b got %s, want watch.signal", wf.Type)
	}
	var p struct {
		From, To, Sealed string
	}
	_ = json.Unmarshal(wf.Payload, &struct {
		From   *string `json:"fromMemberId"`
		To     *string `json:"toMemberId"`
		Sealed *string `json:"sealed"`
	}{&p.From, &p.To, &p.Sealed})
	if p.From != "mem-ws" || p.To != "mem-b" || p.Sealed != "AQID" {
		t.Errorf("payload = %s", wf.Payload)
	}
	if wf.Cursor != "0" {
		t.Errorf("cursor = %q, want 0 — a live relay moves no cursor", wf.Cursor)
	}
	if after := gw.bus.LastSeq(); after != before {
		t.Errorf("the signal was written to the durable stream (%d → %d)", before, after)
	}
}

// ── Ticket ledger ────────────────────────────────────────────────────────────

func publishMint(t *testing.T, b *bus.Bus, tk ticket) {
	t.Helper()
	data, _ := json.Marshal(tk)
	if err := b.Publish(notify.TicketSubject, data); err != nil {
		t.Fatal(err)
	}
}

func waitTicket(t *testing.T, tc *ticketCache, raw string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		tc.mu.Lock()
		_, ok := tc.rows[raw]
		tc.mu.Unlock()
		if ok {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("ticket %s never arrived through follow()", raw)
}

// TestTicket_SpendSurvivesARestart is F-16's "single use" across the one
// thing that used to reset it: a gateway restart inside the 60 s window. The
// second cache replays the same log the first one wrote to, sees the mint AND
// the spend, and refuses the replayed credential.
func TestTicket_SpendSurvivesARestart(t *testing.T) {
	gw := newTestGateway(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	first := newTicketCache(gw.log, gw.bus)
	go first.follow(ctx)
	publishMint(t, gw.bus, liveTicket("tk-once"))
	waitTicket(t, first, "tk-once")

	if _, ok := first.consume("tk-once"); !ok {
		t.Fatal("a freshly minted ticket was refused")
	}
	if _, ok := first.consume("tk-once"); ok {
		t.Fatal("the same ticket was accepted twice by one process")
	}

	// "Restart": a new cache over the same bus directory, replaying from 0.
	second := newTicketCache(gw.log, gw.bus)
	go second.follow(ctx)
	// Records are applied in log order, so once this sentinel (minted after
	// the spend) is visible, the spend has been applied too.
	publishMint(t, gw.bus, liveTicket("tk-sentinel"))
	waitTicket(t, second, "tk-sentinel")

	if _, ok := second.consume("tk-once"); ok {
		t.Fatal("a burned ticket came back to life after a restart")
	}
}

// TestTicket_ExpiredMintsAreNotCached keeps boot memory bounded by LIVE
// tickets: the replay of every ticket ever minted inserts nothing whose window
// has already closed.
func TestTicket_ExpiredMintsAreNotCached(t *testing.T) {
	gw := newTestGateway(t)
	tc := newTicketCache(gw.log, gw.bus)
	tc.apply(bus.Msg{Subject: notify.TicketSubject, Data: mustJSON(ticket{Ticket: "tk-old", ExpiresAt: time.Now().Add(-time.Second).UnixMilli()})})
	tc.apply(bus.Msg{Subject: notify.TicketSubject, Data: mustJSON(liveTicket("tk-live"))})
	if tc.size() != 1 {
		t.Fatalf("cache holds %d tickets, want only the live one", tc.size())
	}
	tc.apply(bus.Msg{Subject: ticketSpentSubject, Data: mustJSON(map[string]any{"ticket": "tk-live"})})
	if tc.size() != 0 {
		t.Fatal("a spend record did not remove the ticket")
	}
}

// ── Cursor bookkeeping (unit) ────────────────────────────────────────────────

func TestWatermark_NeverAdvancesPastAnOwedPosition(t *testing.T) {
	c := newConn(&gateway{log: testLogger()}, liveTicket("x"), "s", 4)
	if c.watermark() != 4 {
		t.Fatalf("fresh watermark = %d, want the connect cursor 4", c.watermark())
	}
	c.track(5)
	c.track(7)
	c.track(9)
	if c.watermark() != 4 {
		t.Fatalf("watermark = %d with 5,7,9 owed, want 4", c.watermark())
	}
	c.done(7) // written out of order (CRITICAL jumped the queue)
	if c.watermark() != 4 {
		t.Fatalf("watermark = %d after 7, want 4 — 5 is still owed", c.watermark())
	}
	c.done(5)
	if c.watermark() != 8 {
		t.Fatalf("watermark = %d after 5, want 8", c.watermark())
	}
	c.done(9)
	if c.watermark() != 9 {
		t.Fatalf("watermark = %d with nothing owed, want the newest seen 9", c.watermark())
	}
	c.done(9) // idempotent
	if c.watermark() != 9 {
		t.Fatal("a repeated done changed the watermark")
	}
}

func TestQueues_SupersededAndDroppedFramesReleaseTheirPositions(t *testing.T) {
	c := newConn(&gateway{log: testLogger()}, liveTicket("x"), "s", 0)
	c.track(1)
	c.track(2)
	c.pushLow("k", &outFrame{seq: 1})
	c.pushLow("k", &outFrame{seq: 2}) // supersedes 1
	if c.watermark() != 1 {
		t.Fatalf("watermark = %d, want 1 — the superseded frame is no longer owed", c.watermark())
	}
	for i := uint64(3); i < 3+overflowCap+1; i++ {
		c.track(i)
		c.pushHigh(&outFrame{seq: i})
	}
	// Position 3 was the oldest HIGH and was dropped by the bounded queue.
	if c.watermark() != 1 {
		t.Fatalf("watermark = %d, want 1 (2 is still owed)", c.watermark())
	}
	if c.overflowDrops != 1 {
		t.Fatalf("overflowDrops = %d, want 1", c.overflowDrops)
	}
	c.done(2)
	if c.watermark() != 3 {
		t.Fatalf("watermark = %d, want 3 — the dropped position was released", c.watermark())
	}
}

func itoa(n uint64) string { return strconv.FormatUint(n, 10) }

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}
