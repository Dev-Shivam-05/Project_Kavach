// Command realtime-gw is the WebSocket gateway.
//
// The RFC 6455 handshake and frame codec are written out by hand over
// net/http's Hijack, because this module honours the same rule as the rest of
// the backend: standard library only. A WebSocket frame is a byte, a length,
// a mask and a payload; that is roughly two hundred lines and it will still
// compile in 2035, which is more than can be said for a transitive dependency
// tree.
//
// ★ The backpressure policy here is a CORRECTNESS rule, not a performance
// tuning knob. ★ A dropped state transition means a responder's phone still
// believes the incident is unclaimed, and two people either both stand down or
// both drive across town. See §2.5.2.
//
// ★ This binary is the ONLY place the server→client wire shape is decided. ★
// internal/notify.Frame is the bus record (its body is `data`); the socket
// carries wireFrame (its body is `payload`, plus `cursor`). The translation
// lives in toWire and nowhere else, and testdata/s2c_frames.golden.json pins
// the bytes a phone sees — the mirror of D-037, where the C→S body name was
// wrong for months with nothing failing (§2.5.2, F-16, F-20).
package main

import (
	"bufio"
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/kavach/backend/internal/bus"
	"github.com/kavach/backend/internal/logx"
	"github.com/kavach/backend/internal/notify"
)

// wsGUID is the RFC 6455 §1.3 magic value.
const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

const (
	opContinuation = 0x0
	opText         = 0x1
	opBinary       = 0x2
	opClose        = 0x8
	opPing         = 0x9
	opPong         = 0xA
)

const (
	closeNormal       = 1000
	closeProtocol     = 1002
	closePolicy       = 1008
	closeTooBig       = 1009
	closeInternal     = 1011
	closeResyncNeeded = 4000 // application code: reconnect with your cursor
)

const (
	// maxPayload bounds one C→S message. It is the same 64 KiB the POST twin
	// (reportLocation) has always enforced: a sealed location fix is a few
	// hundred bytes and a sealed SDP offer a few kilobytes, and everything a
	// client publishes here is appended to a family stream that is never
	// compacted and relayed to every family socket, so the cap is a storage and
	// fan-out bound, not a protocol nicety.
	maxPayload       = 1 << 16
	criticalCap      = 256
	overflowCap      = 200 // HIGH: bounded overflow queue
	criticalBlockFor = 5 * time.Second
	maxReplayFrames  = 500
	replayIdle       = 150 * time.Millisecond
	pingEvery        = 20 * time.Second
	pongDeadline     = 30 * time.Second
	subprotocol      = "kavach.v1"

	// ticketSpentSubject records a consumed ticket beside the mint on the same
	// durable log, so a gateway that restarts inside a ticket's 60 s window (or
	// a second gateway instance) replays the mint AND the spend and does not
	// resurrect a burned credential (F-16: single use means single use).
	ticketSpentSubject = notify.TicketSubject + ".spent"
)

func main() {
	var (
		addr   = flag.String("addr", env("KAVACH_RT_ADDR", ":8082"), "listen address")
		busDir = flag.String("bus", env("KAVACH_BUS_DIR", "./data/bus"), "bus directory")
		// Both knobs are honoured, in the safe direction: KAVACH_ENV=production
		// (the switch cmd/control-plane reads via logx.Dev) OR KAVACH_DEV=0 (the
		// switch ops/README.md documents) turns developer logging off. Two
		// binaries in one deployment reading two different switches is how a
		// production gateway ends up logging device ids unredacted.
		dev     = flag.Bool("dev", logx.Dev() && env("KAVACH_DEV", "1") == "1", "developer logging")
		allowNT = flag.Bool("allow-no-ticket", env("KAVACH_RT_ALLOW_NO_TICKET", "0") == "1",
			"accept connections without a ticket (local development only)")
	)
	flag.Parse()

	log := logx.New(*dev)
	b, err := bus.Open(*busDir)
	if err != nil {
		log.Error("bus_open_failed", "dir", *busDir, "err", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	tickets := newTicketCache(log, b)
	go tickets.follow(ctx)

	gw := &gateway{log: log, bus: b, tickets: tickets, allowNoTicket: *allowNT}
	if err := gw.startLiveRelay(ctx); err != nil {
		log.Error("live_relay_subscribe_failed", "err", err)
		os.Exit(1)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/stream", gw.stream)
	mux.HandleFunc("POST /v1/location-report", gw.reportLocation)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status": "ok", "service": "realtime-gw",
			"connections": gw.count(), "tickets": tickets.size(),
		})
	})

	srv := &http.Server{
		Addr:              *addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		// No WriteTimeout: a hijacked connection manages its own deadlines, and
		// a server-level write timeout would kill every long-lived socket.
		IdleTimeout: 0,
	}

	go func() {
		log.Info("realtime_gw_listening", "addr", *addr, "bus", *busDir)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("listen_failed", "err", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	log.Info("shutting_down", "connections", gw.count())
	// Tell every socket why it is going away so clients reconnect with their
	// cursor instead of treating it as an error and backing off.
	gw.closeAll(closeNormal, "server shutting down")
	shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutCtx)
	log.Info("stopped")
}

// ── Tickets (F-16) ───────────────────────────────────────────────────────────

type ticket struct {
	Ticket    string `json:"ticket"`
	FamilyID  string `json:"familyId"`
	DeviceID  string `json:"deviceId"`
	MemberID  string `json:"memberId"`
	Reduced   bool   `json:"reduced"`
	IssuedAt  int64  `json:"issuedAt"`
	ExpiresAt int64  `json:"expiresAt"`
}

// ticketCache holds unspent connect tickets. They are minted by the control
// plane and delivered over the bus, so the gateway needs no database and no
// shared secret with the control plane beyond the bus itself.
type ticketCache struct {
	mu   sync.Mutex
	log  *slog.Logger
	bus  *bus.Bus
	rows map[string]ticket
	now  func() time.Time
}

func newTicketCache(log *slog.Logger, b *bus.Bus) *ticketCache {
	return &ticketCache{log: log, bus: b, rows: map[string]ticket{}, now: time.Now}
}

// follow tails both the mint subject and the spend subject. The pattern is
// rt.> rather than two subscriptions so that a mint and its spend arrive in
// log order — a spend replayed before its mint would be a no-op and the ticket
// would come back to life.
func (c *ticketCache) follow(ctx context.Context) {
	ch, cancel := c.bus.Subscribe("rt.>", 0)
	defer cancel()
	sweep := time.NewTicker(30 * time.Second)
	defer sweep.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case m, ok := <-ch:
			if !ok {
				return
			}
			c.apply(m)
		case <-sweep.C:
			c.sweep()
		}
	}
}

// apply is one record from rt.> — a mint or a spend.
func (c *ticketCache) apply(m bus.Msg) {
	var t ticket
	if err := json.Unmarshal(m.Data, &t); err != nil || t.Ticket == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	switch m.Subject {
	case ticketSpentSubject:
		delete(c.rows, t.Ticket)
	case notify.TicketSubject:
		// The boot replay walks every ticket ever minted. A ticket whose window
		// has already closed is never usable, so it is not worth a map entry —
		// this is what keeps memory bounded by LIVE tickets rather than by the
		// lifetime count of socket connects.
		if t.ExpiresAt <= c.now().UnixMilli() {
			return
		}
		c.rows[t.Ticket] = t
	}
}

func (c *ticketCache) sweep() {
	now := c.now().UnixMilli()
	c.mu.Lock()
	for k, v := range c.rows {
		if v.ExpiresAt <= now {
			delete(c.rows, k)
		}
	}
	c.mu.Unlock()
}

// consume validates and burns a ticket. Single use: a replayed ticket is a
// replayed credential, and the whole point of a 60-second single-use token is
// that observing it once buys nothing. The spend is published so that "once"
// survives a restart of this process and holds across instances.
func (c *ticketCache) consume(raw string) (ticket, bool) {
	c.mu.Lock()
	t, ok := c.rows[raw]
	if !ok {
		c.mu.Unlock()
		return ticket{}, false
	}
	delete(c.rows, raw)
	c.mu.Unlock()
	if t.ExpiresAt <= c.now().UnixMilli() {
		return ticket{}, false
	}
	if c.bus != nil {
		// Best effort: the local delete already happened. Only the ticket
		// string travels; the identity it was bound to is already in the mint
		// record beside it.
		spent, _ := json.Marshal(map[string]any{"ticket": t.Ticket, "spentAt": c.now().UnixMilli()})
		if err := c.bus.Publish(ticketSpentSubject, spent); err != nil {
			c.log.Warn("ticket_spend_publish_failed", "err", err)
		}
	}
	return t, true
}

func (c *ticketCache) size() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.rows)
}

// ── Gateway ──────────────────────────────────────────────────────────────────

type gateway struct {
	log           *slog.Logger
	bus           *bus.Bus
	tickets       *ticketCache
	allowNoTicket bool

	mu    sync.Mutex
	conns map[*conn]struct{}
}

func (g *gateway) track(c *conn) {
	g.mu.Lock()
	if g.conns == nil {
		g.conns = map[*conn]struct{}{}
	}
	g.conns[c] = struct{}{}
	g.mu.Unlock()
}

func (g *gateway) untrack(c *conn) {
	g.mu.Lock()
	delete(g.conns, c)
	g.mu.Unlock()
}

func (g *gateway) count() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.conns)
}

func (g *gateway) closeAll(code int, reason string) {
	g.mu.Lock()
	list := make([]*conn, 0, len(g.conns))
	for c := range g.conns {
		list = append(list, c)
	}
	g.mu.Unlock()
	for _, c := range list {
		c.shutdown(code, reason)
	}
}

// startLiveRelay is the ephemeral half of delivery: frames that are never
// written to disk (Family Watch signalling, presence) reach the live sockets
// of their family through here. ONE subscription per subject kind for the
// whole process, fanned out by subject, rather than one per connection —
// internal/bus never prunes a closed EphSub from its list, so a per-socket
// subscription would leak a 256-slot channel on every reconnect.
//
// Exactly the two subjects a socket can be attached to, and not fam.>: the
// Class A′ precise-location fan-out cmd/sos-ingest runs is ephemeral too, on a
// different leaf, and this binary must never be a subscriber of it (F-20).
func (g *gateway) startLiveRelay(ctx context.Context) error {
	var subs []*bus.EphSub
	for _, pattern := range []string{"fam.*.stream", "fam.*.reduced"} {
		e, err := g.bus.SubscribeEphemeral(pattern, g.relayLive)
		if err != nil {
			for _, s := range subs {
				s.Close()
			}
			return err
		}
		subs = append(subs, e)
	}
	go func() {
		<-ctx.Done()
		for _, s := range subs {
			s.Close()
		}
	}()
	return nil
}

// relayLive hands one ephemeral record to every socket on its subject. It
// runs on the bus's single fan-out goroutine, so it must not block: a live
// frame is HIGH or LOW by construction, and anything else is queued as HIGH
// rather than parked on one slow socket's CRITICAL backpressure.
func (g *gateway) relayLive(m bus.Msg) error {
	of := toWire(0, m.Data)
	g.mu.Lock()
	targets := make([]*conn, 0, len(g.conns))
	for c := range g.conns {
		if c.subject == m.Subject {
			targets = append(targets, c)
		}
	}
	g.mu.Unlock()
	for _, c := range targets {
		if of.wf.Priority == notify.PriorityLow {
			c.pushLow(of.wf.Key+"|"+of.wf.Type, of)
		} else {
			c.pushHigh(of)
		}
	}
	return nil
}

// stream is the only endpoint. GET /v1/stream?cursor=<opaque>
//
// Order matters: the handshake is checked BEFORE the ticket is consumed. Every
// check in checkUpgrade is stateless, so a proxy that strips `Upgrade` or a
// client with a broken handshake gets its 400 without having burned the
// single-use ticket it will need for the retry.
func (g *gateway) stream(w http.ResponseWriter, r *http.Request) {
	if err := checkUpgrade(r); err != nil {
		writeUpgradeError(w, err)
		g.log.Warn("upgrade_refused", "err", err, "remote", r.RemoteAddr)
		return
	}

	proto := r.Header.Get("Sec-WebSocket-Protocol")
	tk, ok := g.authorise(proto)
	if !ok {
		// Refuse before the upgrade so the client gets a readable HTTP error
		// rather than an immediate close frame it has to decode.
		http.Error(w, `{"code":"KV-1002","detail":"missing or invalid connect ticket"}`,
			http.StatusUnauthorized)
		return
	}

	netConn, brw, err := hijack(w, r)
	if err != nil {
		g.log.Warn("upgrade_failed", "err", err, "remote", r.RemoteAddr)
		return
	}

	// F-20: the subject is chosen once, here. A reduced connection is attached
	// to the neighbour feed and is never subscribed to the sealed family
	// subject, so no downstream bug can leak Class A to it.
	subject := notify.StreamSubject(tk.FamilyID)
	if tk.Reduced {
		subject = notify.ReducedSubject(tk.FamilyID)
	}

	cursor := g.resumeCursor(r.URL.Query().Get("cursor"))

	c := newConn(g, tk, subject, cursor)
	c.raw, c.br, c.bw = netConn, brw.Reader, brw.Writer
	g.track(c)
	c.run(r.Context())
	g.untrack(c)
}

// newConn is the one place a conn's queues are sized, shared with the tests
// that drive handleMessage without a socket.
func newConn(g *gateway, tk ticket, subject string, cursor uint64) *conn {
	return &conn{
		gw: g, log: g.log.With("device", tk.DeviceID, "family", tk.FamilyID),
		ticket: tk, subject: subject, cursor: cursor,
		critical: make(chan *outFrame, criticalCap),
		wake:     make(chan struct{}, 1),
		room:     make(chan struct{}, 1),
		coalesce: map[string]*outFrame{},
	}
}

// resumeCursor turns the client's echoed cursor back into a bus position. The
// cursor is opaque to the client (it stores and returns the string verbatim),
// so anything that is not a position this bus could have issued — an old
// HLC-shaped value from before the cursor was a Seq, or a position past the
// end of a stream that has since been wiped — means "start from the current
// snapshot" rather than "stay silent for ever".
func (g *gateway) resumeCursor(raw string) uint64 {
	if raw == "" {
		return 0
	}
	n, err := strconv.ParseUint(raw, 10, 64)
	if err != nil {
		g.log.Warn("resume_cursor_unparseable", "len", len(raw))
		return 0
	}
	if last := g.bus.LastSeq(); n > last {
		g.log.Warn("resume_cursor_past_end", "cursor", n, "last", last)
		return last
	}
	return n
}

// reportLocation is 6-D-6 · spec C1's response leg: a fire-and-forget sealed
// presence report over a plain POST, for a caller that cannot hold a socket
// open — a push-triggered background fix report chief among them (the target
// device may be headless, per D-020's precedent nothing on that path may open
// the local database, and a WebSocket handshake plus its whole reconnect/
// cursor/heartbeat machinery is not a one-shot fire-and-forget primitive).
// It spends the exact same single-use connect ticket as the WS upgrade (F-16:
// no second auth scheme in this binary) and publishes the identical frame
// shape handleMessage's "location.report" case builds from a live socket, so
// a receiver cannot tell a headless refresh from a foregrounded watch-position
// tick apart.
func (g *gateway) reportLocation(w http.ResponseWriter, r *http.Request) {
	tk, ok := g.tickets.consume(r.Header.Get("Kavach-Ticket"))
	if !ok {
		http.Error(w, `{"code":"KV-1002","detail":"missing or invalid connect ticket"}`,
			http.StatusUnauthorized)
		return
	}
	// F-20, the second door: the socket path refuses a reduced session that
	// tries to publish, and a plain POST with the same ticket is the same
	// session. A neighbour is not a cryptographic member of the family and may
	// not inject presence into its sealed stream over either transport.
	if tk.Reduced {
		http.Error(w, `{"code":"KV-2001","detail":"reduced session may not publish location.report"}`,
			http.StatusForbidden)
		return
	}
	defer r.Body.Close()
	var in struct {
		Sealed json.RawMessage `json:"sealed"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, maxPayload)).Decode(&in); err != nil || len(in.Sealed) == 0 {
		http.Error(w, `{"code":"KV-1001","detail":"malformed body"}`, http.StatusBadRequest)
		return
	}
	now := time.Now().UnixMilli()
	f := notify.Frame{
		V: notify.FrameVersion, Type: "location.update", Priority: notify.PriorityLow,
		Key: "loc:" + tk.MemberID, FamilyID: tk.FamilyID, At: now,
		Data: map[string]any{
			"memberId": tk.MemberID, "deviceId": tk.DeviceID,
			"sealed": in.Sealed, "at": now,
		},
	}
	if err := g.bus.Publish(notify.StreamSubject(tk.FamilyID), f.Encode()); err != nil {
		http.Error(w, `{"code":"KV-5001","detail":"publish failed"}`, http.StatusServiceUnavailable)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// authorise pulls the ticket out of Sec-WebSocket-Protocol: "kavach.v1,
// ticket.<opaque>". Nothing sensitive ever appears in the URL (I-6) — query
// strings end up in access logs, browser history and referrer headers.
func (g *gateway) authorise(proto string) (ticket, bool) {
	var raw string
	for _, p := range strings.Split(proto, ",") {
		p = strings.TrimSpace(p)
		if strings.HasPrefix(p, "ticket.") {
			raw = strings.TrimPrefix(p, "ticket.")
		}
	}
	if raw == "" {
		if g.allowNoTicket {
			return ticket{FamilyID: os.Getenv("KAVACH_RT_DEV_FAMILY"), DeviceID: "dev", MemberID: "dev"}, true
		}
		return ticket{}, false
	}
	return g.tickets.consume(raw)
}

// ── Handshake ────────────────────────────────────────────────────────────────

// upgradeError carries the HTTP status a refused handshake is answered with.
type upgradeError struct {
	status int
	msg    string
}

func (e upgradeError) Error() string { return e.msg }

// checkUpgrade is every RFC 6455 §4.2.1 precondition, and nothing with a side
// effect: it can run before the ticket is spent.
func checkUpgrade(r *http.Request) error {
	if r.Method != http.MethodGet {
		return upgradeError{http.StatusMethodNotAllowed, "ws: not a GET"}
	}
	if !headerContainsToken(r.Header.Get("Connection"), "upgrade") ||
		!strings.EqualFold(strings.TrimSpace(r.Header.Get("Upgrade")), "websocket") {
		return upgradeError{http.StatusBadRequest, "ws: not an upgrade"}
	}
	if r.Header.Get("Sec-WebSocket-Version") != "13" {
		return upgradeError{http.StatusUpgradeRequired, "ws: bad version"}
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		return upgradeError{http.StatusBadRequest, "ws: missing key"}
	}
	if raw, err := base64.StdEncoding.DecodeString(key); err != nil || len(raw) != 16 {
		return upgradeError{http.StatusBadRequest, "ws: malformed key"}
	}
	return nil
}

func writeUpgradeError(w http.ResponseWriter, err error) {
	var ue upgradeError
	if !errors.As(err, &ue) {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if ue.status == http.StatusUpgradeRequired {
		w.Header().Set("Sec-WebSocket-Version", "13")
	}
	http.Error(w, ue.msg, ue.status)
}

// hijack completes a handshake checkUpgrade has already approved.
func hijack(w http.ResponseWriter, r *http.Request) (net.Conn, *bufio.ReadWriter, error) {
	key := r.Header.Get("Sec-WebSocket-Key")
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return nil, nil, errors.New("ws: not hijackable")
	}
	netConn, brw, err := hj.Hijack()
	if err != nil {
		return nil, nil, fmt.Errorf("ws: hijack: %w", err)
	}

	sum := sha1.Sum([]byte(key + wsGUID))
	accept := base64.StdEncoding.EncodeToString(sum[:])

	resp := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + accept + "\r\n" +
		"Sec-WebSocket-Protocol: " + subprotocol + "\r\n\r\n"
	if err := netConn.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
		_ = netConn.Close()
		return nil, nil, err
	}
	if _, err := brw.WriteString(resp); err != nil {
		_ = netConn.Close()
		return nil, nil, err
	}
	if err := brw.Flush(); err != nil {
		_ = netConn.Close()
		return nil, nil, err
	}
	_ = netConn.SetWriteDeadline(time.Time{})
	return netConn, brw, nil
}

func headerContainsToken(header, token string) bool {
	for _, part := range strings.Split(header, ",") {
		if strings.EqualFold(strings.TrimSpace(part), token) {
			return true
		}
	}
	return false
}

// ── Frame codec ──────────────────────────────────────────────────────────────

type wsFrame struct {
	fin     bool
	opcode  byte
	payload []byte
}

// readFrame decodes one frame. Client→server frames MUST be masked (RFC 6455
// §5.1); an unmasked one is a protocol error, not something to be lenient about.
func readFrame(br *bufio.Reader) (wsFrame, error) {
	var head [2]byte
	if _, err := io.ReadFull(br, head[:]); err != nil {
		return wsFrame{}, err
	}
	f := wsFrame{
		fin:    head[0]&0x80 != 0,
		opcode: head[0] & 0x0f,
	}
	if head[0]&0x70 != 0 {
		return wsFrame{}, protoErr("reserved bits set")
	}
	masked := head[1]&0x80 != 0
	if !masked {
		return wsFrame{}, protoErr("client frame not masked")
	}
	length := int64(head[1] & 0x7f)
	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(br, ext[:]); err != nil {
			return wsFrame{}, err
		}
		length = int64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(br, ext[:]); err != nil {
			return wsFrame{}, err
		}
		v := binary.BigEndian.Uint64(ext[:])
		if v > uint64(maxPayload) {
			return wsFrame{}, tooBigErr(int64(v))
		}
		length = int64(v)
	}
	if length > maxPayload {
		return wsFrame{}, tooBigErr(length)
	}
	if f.opcode >= opClose {
		// Control frames: never fragmented, never longer than 125 bytes.
		if !f.fin || length > 125 {
			return wsFrame{}, protoErr("malformed control frame")
		}
	}
	var mask [4]byte
	if _, err := io.ReadFull(br, mask[:]); err != nil {
		return wsFrame{}, err
	}
	buf := make([]byte, length)
	if _, err := io.ReadFull(br, buf); err != nil {
		return wsFrame{}, err
	}
	for i := range buf {
		buf[i] ^= mask[i%4]
	}
	f.payload = buf
	return f, nil
}

// writeFrame emits a server frame. Server→client frames are never masked.
func writeFrame(bw *bufio.Writer, opcode byte, payload []byte) error {
	var head [10]byte
	head[0] = 0x80 | opcode // FIN + opcode; we never fragment outbound
	n := len(payload)
	switch {
	case n <= 125:
		head[1] = byte(n)
		if _, err := bw.Write(head[:2]); err != nil {
			return err
		}
	case n <= 0xffff:
		head[1] = 126
		binary.BigEndian.PutUint16(head[2:4], uint16(n))
		if _, err := bw.Write(head[:4]); err != nil {
			return err
		}
	default:
		head[1] = 127
		binary.BigEndian.PutUint64(head[2:10], uint64(n))
		if _, err := bw.Write(head[:10]); err != nil {
			return err
		}
	}
	if _, err := bw.Write(payload); err != nil {
		return err
	}
	return bw.Flush()
}

func closePayload(code int, reason string) []byte {
	if len(reason) > 123 {
		reason = reason[:123]
	}
	out := make([]byte, 2+len(reason))
	binary.BigEndian.PutUint16(out[:2], uint16(code))
	copy(out[2:], reason)
	return out
}

type wsError struct {
	code int
	msg  string
}

func (e wsError) Error() string { return fmt.Sprintf("ws %d: %s", e.code, e.msg) }

func protoErr(msg string) error { return wsError{closeProtocol, msg} }
func tooBigErr(n int64) error {
	return wsError{closeTooBig, fmt.Sprintf("payload %d exceeds limit", n)}
}

// ── The wire shape (S→C) ─────────────────────────────────────────────────────

// wireFrame is what a phone receives, and the ONLY shape it receives. Its body
// is `payload` — the same name the client has always used for the body of the
// frames it sends (mobile/src/net/ws.ts WsFrame) — and `cursor` is the resume
// position the client stores verbatim and echoes as ?cursor= on reconnect.
//
// Every other field is copied from the producer's notify.Frame unchanged, so
// `incidentId`, `key`, `priority`, `at` and `reduced` are top-level and the
// producer-specific fields (state, ownerMemberId, sealed, …) are inside
// `payload`. testdata/s2c_frames.golden.json is the catalogue.
type wireFrame struct {
	V          int             `json:"v"`
	Type       string          `json:"type"`
	Priority   notify.Priority `json:"priority"`
	Key        string          `json:"key,omitempty"`
	FamilyID   string          `json:"familyId"`
	IncidentID string          `json:"incidentId,omitempty"`
	At         int64           `json:"at"`
	Reduced    bool            `json:"reduced,omitempty"`
	Cursor     string          `json:"cursor"`
	Payload    json.RawMessage `json:"payload"`
}

// busFrame is notify.Frame as read back off the bus, with the body kept raw so
// a sealed blob is relayed byte-for-byte rather than round-tripped through a
// map[string]any (which would reorder keys under a client's AAD).
type busFrame struct {
	V          int             `json:"v"`
	Type       string          `json:"type"`
	Priority   notify.Priority `json:"priority"`
	Key        string          `json:"key"`
	FamilyID   string          `json:"familyId"`
	IncidentID string          `json:"incidentId"`
	At         int64           `json:"at"`
	Reduced    bool            `json:"reduced"`
	Data       json.RawMessage `json:"data"`
}

// outFrame is one queued S→C frame. seq is the bus position it came from (0
// for a frame this process originated: sync.complete, error, pong, and every
// ephemeral relay). The cursor is stamped by the writer at the moment of the
// write, never earlier — see conn.watermark.
type outFrame struct {
	seq uint64
	wf  wireFrame
}

var emptyObject = json.RawMessage(`{}`)

// toWire translates a bus record into the wire shape. An undecodable record is
// still delivered — as CRITICAL, with the raw bytes in the payload — because
// we would rather hand the client something it cannot classify than silently
// swallow what might have been a state transition.
func toWire(seq uint64, data []byte) *outFrame {
	var bf busFrame
	if err := json.Unmarshal(data, &bf); err != nil || bf.Type == "" {
		raw, _ := json.Marshal(map[string]any{"raw": string(data)})
		return &outFrame{seq: seq, wf: wireFrame{
			V: notify.FrameVersion, Type: "frame.undecodable", Priority: notify.PriorityCritical,
			At: time.Now().UnixMilli(), Payload: raw,
		}}
	}
	payload := bf.Data
	if len(payload) == 0 || string(payload) == "null" {
		payload = emptyObject
	}
	return &outFrame{seq: seq, wf: wireFrame{
		V: bf.V, Type: bf.Type, Priority: bf.Priority, Key: bf.Key,
		FamilyID: bf.FamilyID, IncidentID: bf.IncidentID, At: bf.At, Reduced: bf.Reduced,
		Payload: payload,
	}}
}

// serverFrame builds a frame this process originates.
func serverFrame(familyID, typ string, prio notify.Priority, payload map[string]any) *outFrame {
	body := emptyObject
	if payload != nil {
		if b, err := json.Marshal(payload); err == nil {
			body = b
		}
	}
	return &outFrame{wf: wireFrame{
		V: notify.FrameVersion, Type: typ, Priority: prio,
		FamilyID: familyID, At: time.Now().UnixMilli(), Payload: body,
	}}
}

// replayable says whether a durable record is worth re-delivering on
// reconnect. Family Watch signalling is live-only: an invite replayed on a
// reconnect would open the watched phone's camera for a viewer who left an
// hour ago — the exact failure D-029 exists to forbid, produced by the
// transport rather than by anyone's intent. New builds publish watch.signal
// ephemerally (never on disk); this filter is the belt for records an older
// build left on the durable stream.
func replayable(typ string) bool { return typ != "watch.signal" }

// ── Connection ───────────────────────────────────────────────────────────────

type conn struct {
	gw  *gateway
	log *slog.Logger
	raw net.Conn
	br  *bufio.Reader
	bw  *bufio.Writer

	ticket  ticket
	subject string

	// seqMu guards the cursor bookkeeping: cursor is the newest bus position
	// the pump has seen for this subject, pending the positions taken in but
	// not yet written (ascending). Together they give the watermark.
	seqMu   sync.Mutex
	cursor  uint64
	pending []uint64

	// CRITICAL: a bounded channel. Producers block on it deliberately.
	critical chan *outFrame
	// room signals a producer that a critical slot freed up.
	room chan struct{}

	// mu guards the HIGH/LOW queues; wmu serialises socket writes. They are
	// separate locks because the reader answers pings on the same socket the
	// writer is draining, and one mutex for both would let a slow write block
	// an enqueue.
	mu            sync.Mutex
	wmu           sync.Mutex
	overflow      []*outFrame          // HIGH
	coalesce      map[string]*outFrame // LOW: latest per key
	coalesceOrder []string
	overflowDrops int

	closeOnce   sync.Once
	closeMu     sync.Mutex
	closeCode   int
	closeReason string

	wake chan struct{}
}

func (c *conn) run(parent context.Context) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()

	var wg sync.WaitGroup
	wg.Add(3)
	go func() { defer wg.Done(); c.writer(ctx, cancel) }()
	go func() { defer wg.Done(); c.pump(ctx, cancel) }()
	go func() { defer wg.Done(); c.reader(ctx, cancel) }()

	// Closing the socket is the only thing that unblocks the reader, which is
	// parked in a blocking read. So the first goroutine to give up cancels the
	// context, and this watcher turns that into a close frame plus a hangup.
	watcherDone := make(chan struct{})
	go func() {
		defer close(watcherDone)
		<-ctx.Done()
		c.shutdown(closeNormal, "session ended")
	}()

	wg.Wait()
	cancel()
	<-watcherDone
	code, reason := c.closeInfo()
	c.log.Info("connection_closed", "code", code, "reason", reason, "overflowDrops", c.overflowDrops)
}

// ── Enqueue: the backpressure policy ─────────────────────────────────────────

// pushCritical never drops. State transitions, CLAIM, RELEASE and escalation
// tier changes take this path: the connection blocks for up to five seconds
// waiting for room, and if it still cannot deliver, the socket is closed with
// a resync code so the client reconnects from its cursor and rebuilds. Losing
// the frame silently is the one outcome that is not allowed.
func (c *conn) pushCritical(ctx context.Context, of *outFrame) {
	deadline := time.NewTimer(criticalBlockFor)
	defer deadline.Stop()
	for {
		select {
		case c.critical <- of:
			c.signal()
			return
		default:
		}
		select {
		case c.critical <- of:
			c.signal()
			return
		case <-c.room:
			// A slot freed; loop and try again.
		case <-deadline.C:
			c.log.Warn("critical_backpressure_forcing_resync",
				"queued", len(c.critical), "blockedFor", criticalBlockFor)
			c.shutdown(closeResyncNeeded, "critical backlog; reconnect with cursor")
			return
		case <-ctx.Done():
			return
		}
	}
}

// pushHigh uses a bounded overflow queue. Messages and alerts matter, but a
// client 200 frames behind on chat is not a correctness problem, so the oldest
// is dropped rather than blocking the socket. A dropped frame is marked done:
// the policy accepted its loss, and holding the watermark back for it would
// turn every later reconnect into a replay of everything since.
func (c *conn) pushHigh(of *outFrame) {
	c.mu.Lock()
	if len(c.overflow) >= overflowCap {
		dropped := c.overflow[0]
		c.overflow = c.overflow[1:]
		c.overflowDrops++
		c.done(dropped.seq)
	}
	c.overflow = append(c.overflow, of)
	c.mu.Unlock()
	c.signal()
}

// pushLow coalesces. A client forty frames behind on location wants the newest
// position, not a replay of a forty-second-old track — so we keep exactly one
// frame per key and overwrite it. The superseded frame is done: the newer one
// carries everything it said.
func (c *conn) pushLow(key string, of *outFrame) {
	if key == "" {
		key = "default"
	}
	c.mu.Lock()
	if old, seen := c.coalesce[key]; seen {
		c.done(old.seq)
	} else {
		c.coalesceOrder = append(c.coalesceOrder, key)
	}
	c.coalesce[key] = of
	c.mu.Unlock()
	c.signal()
}

func (c *conn) popHigh() (*outFrame, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.overflow) == 0 {
		return nil, false
	}
	d := c.overflow[0]
	c.overflow = c.overflow[1:]
	return d, true
}

func (c *conn) popLow() (*outFrame, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for len(c.coalesceOrder) > 0 {
		key := c.coalesceOrder[0]
		c.coalesceOrder = c.coalesceOrder[1:]
		if d, ok := c.coalesce[key]; ok {
			delete(c.coalesce, key)
			return d, true
		}
	}
	return nil, false
}

func (c *conn) signal() {
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

func (c *conn) freeRoom() {
	select {
	case c.room <- struct{}{}:
	default:
	}
}

// ── Cursor bookkeeping ───────────────────────────────────────────────────────
//
// The cursor a frame carries is a promise: "everything this connection owed
// you up to here has been written". Strict priority makes that promise hard —
// a CRITICAL frame at Seq 100 is written before a HIGH one at Seq 90 that was
// queued earlier, so stamping each frame with its own Seq would let a client
// that persisted "100" and then lost the socket resume past 90 and never see
// it. So the stamp is a WATERMARK: the newest position such that no earlier
// position is still queued. It is monotonic within a connection, it is what
// sync.complete carries, and resuming from it can only ever re-deliver, never
// skip.

// track records a bus position this connection has taken responsibility for.
func (c *conn) track(seq uint64) {
	if seq == 0 {
		return
	}
	c.seqMu.Lock()
	c.cursor = seq
	// Positions arrive ascending from the pump; the sort is only for safety.
	c.pending = append(c.pending, seq)
	if n := len(c.pending); n > 1 && c.pending[n-2] > seq {
		sort.Slice(c.pending, func(i, j int) bool { return c.pending[i] < c.pending[j] })
	}
	c.seqMu.Unlock()
}

// done records that a position has been written, superseded or dropped.
func (c *conn) done(seq uint64) {
	if seq == 0 {
		return
	}
	c.seqMu.Lock()
	i := sort.Search(len(c.pending), func(i int) bool { return c.pending[i] >= seq })
	if i < len(c.pending) && c.pending[i] == seq {
		c.pending = append(c.pending[:i], c.pending[i+1:]...)
	}
	c.seqMu.Unlock()
}

// watermark is the resume position the next written frame may advertise.
func (c *conn) watermark() uint64 {
	c.seqMu.Lock()
	defer c.seqMu.Unlock()
	if len(c.pending) == 0 {
		return c.cursor
	}
	return c.pending[0] - 1
}

// ── Writer ───────────────────────────────────────────────────────────────────

func (c *conn) writer(ctx context.Context, cancel context.CancelFunc) {
	defer cancel()
	ping := time.NewTicker(pingEvery)
	defer ping.Stop()

	for {
		// Strict priority: drain CRITICAL to empty before touching anything
		// else, then HIGH, then the coalesced LOW frames.
		select {
		case <-ctx.Done():
			return
		case d := <-c.critical:
			c.freeRoom()
			if !c.write(d) {
				return
			}
			continue
		default:
		}
		if d, ok := c.popHigh(); ok {
			if !c.write(d) {
				return
			}
			continue
		}
		if d, ok := c.popLow(); ok {
			if !c.write(d) {
				return
			}
			continue
		}

		select {
		case <-ctx.Done():
			return
		case d := <-c.critical:
			c.freeRoom()
			if !c.write(d) {
				return
			}
		case <-c.wake:
		case <-ping.C:
			c.wmu.Lock()
			_ = c.raw.SetWriteDeadline(time.Now().Add(10 * time.Second))
			err := writeFrame(c.bw, opPing, []byte("kv"))
			c.wmu.Unlock()
			if err != nil {
				return
			}
		}
	}
}

// write stamps the cursor and puts one frame on the socket. The position is
// marked done before the write rather than after: if the write fails the
// socket is gone, and the client resumes from the last cursor it actually
// received, which is at most this one.
func (c *conn) write(of *outFrame) bool {
	c.done(of.seq)
	of.wf.Cursor = strconv.FormatUint(c.watermark(), 10)
	data, err := json.Marshal(of.wf)
	if err != nil {
		c.log.Error("frame_marshal_failed", "type", of.wf.Type, "err", err)
		return true
	}
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_ = c.raw.SetWriteDeadline(time.Now().Add(10 * time.Second))
	if err := writeFrame(c.bw, opText, data); err != nil {
		c.log.Debug("write_failed", "err", err)
		return false
	}
	return true
}

// ── Bus pump ─────────────────────────────────────────────────────────────────

// pump replays from the cursor, emits sync.complete, then goes live. The
// replay burst is capped: a client that has been offline for a week wants the
// current state of the world, not a week of history, and it can fetch the rest
// over HTTP if sync.truncated says it should.
//
// Only the DURABLE stream comes through here. Frames that are never written
// to disk — Family Watch signalling and presence — arrive through
// gateway.relayLive, carry no position, and never move the cursor.
func (c *conn) pump(ctx context.Context, cancel context.CancelFunc) {
	defer cancel()
	ch, unsub := c.gw.bus.Subscribe(c.subject, c.cursor)
	defer unsub()

	replaying := true
	truncated := false
	var buf []*outFrame
	idle := time.NewTimer(replayIdle)
	defer idle.Stop()

	finishReplay := func() {
		for _, of := range buf {
			c.deliver(ctx, of)
		}
		buf = nil
		c.emit(ctx, "sync.complete", notify.PriorityCritical, map[string]any{"truncated": truncated})
		replaying = false
	}

	for {
		select {
		case <-ctx.Done():
			return
		case m, ok := <-ch:
			if !ok {
				return
			}
			of := toWire(m.Seq, m.Data)
			if replaying && !replayable(of.wf.Type) {
				// Seen, not owed: the cursor moves past it without it ever
				// entering pending.
				c.seqMu.Lock()
				c.cursor = m.Seq
				c.seqMu.Unlock()
				continue
			}
			c.track(m.Seq)
			if replaying {
				buf = append(buf, of)
				if len(buf) > maxReplayFrames {
					c.done(buf[0].seq)
					buf = buf[1:]
					truncated = true
				}
				if !idle.Stop() {
					select {
					case <-idle.C:
					default:
					}
				}
				idle.Reset(replayIdle)
				continue
			}
			c.deliver(ctx, of)
		case <-idle.C:
			if replaying {
				finishReplay()
			}
		}
	}
}

// deliver routes one frame to the right queue. The producer stamped the
// priority; the gateway trusts it, because the producer is the only party
// that knows what the frame means. Anything unclassifiable is CRITICAL.
func (c *conn) deliver(ctx context.Context, of *outFrame) {
	switch of.wf.Priority {
	case notify.PriorityLow:
		c.pushLow(of.wf.Key+"|"+of.wf.Type, of)
	case notify.PriorityHigh:
		c.pushHigh(of)
	default:
		c.pushCritical(ctx, of)
	}
}

// emit queues a frame this process originates. It always takes the CRITICAL
// (never-dropped) path whatever priority it is labelled with: there are only
// ever a handful per connection and every one of them is an answer the client
// is waiting for.
func (c *conn) emit(ctx context.Context, typ string, prio notify.Priority, payload map[string]any) {
	c.pushCritical(ctx, serverFrame(c.ticket.FamilyID, typ, prio, payload))
}

// ── Reader ───────────────────────────────────────────────────────────────────

func (c *conn) reader(ctx context.Context, cancel context.CancelFunc) {
	defer cancel()
	_ = c.raw.SetReadDeadline(time.Now().Add(pongDeadline))

	var assembling []byte
	var assemblingOp byte

	for {
		f, err := readFrame(c.br)
		if err != nil {
			var we wsError
			if errors.As(err, &we) {
				c.shutdown(we.code, we.msg)
			} else if !errors.Is(err, io.EOF) {
				c.shutdown(closeNormal, "read ended")
			} else {
				c.shutdown(closeNormal, "client closed")
			}
			return
		}
		// Any traffic proves liveness, not just a pong.
		_ = c.raw.SetReadDeadline(time.Now().Add(pongDeadline))

		switch f.opcode {
		case opClose:
			code := closeNormal
			if len(f.payload) >= 2 {
				code = int(binary.BigEndian.Uint16(f.payload[:2]))
			}
			c.shutdown(code, "client close")
			return
		case opPing:
			c.wmu.Lock()
			_ = c.raw.SetWriteDeadline(time.Now().Add(5 * time.Second))
			err := writeFrame(c.bw, opPong, f.payload)
			c.wmu.Unlock()
			if err != nil {
				return
			}
		case opPong:
			// Liveness already refreshed above.
		case opText, opBinary:
			if !f.fin {
				assembling = append(assembling[:0], f.payload...)
				assemblingOp = f.opcode
				continue
			}
			c.handleMessage(ctx, f.payload)
		case opContinuation:
			assembling = append(assembling, f.payload...)
			if len(assembling) > maxPayload {
				c.shutdown(closeTooBig, "fragmented message too large")
				return
			}
			if f.fin {
				if assemblingOp == 0 {
					c.shutdown(closeProtocol, "continuation without start")
					return
				}
				c.handleMessage(ctx, assembling)
				assembling = nil
				assemblingOp = 0
			}
		default:
			c.shutdown(closeProtocol, "unknown opcode")
			return
		}
	}
}

// handleMessage processes C→S frames. The catalogue the gateway accepts is
// exactly: ping, heartbeat, location.report, watch.signal. Everything else —
// including `ack` (t4 is `POST /v1/incidents/{id}/ack` on the control plane,
// where the engine that records it lives) and `incident.open` (an SOS goes to
// cmd/sos-ingest over the HTTPS legs; a relay through this binary would add a
// hop to the one path ADR-002 exists to keep short) — is answered with an
// `error` frame and published nowhere. testdata/c2s_frames.golden.json pins
// the accepted shapes.
func (c *conn) handleMessage(ctx context.Context, data []byte) {
	var in struct {
		Type string          `json:"type"`
		Data json.RawMessage `json:"data"`
		// ★ 6-D-7d — the client has ALWAYS sent this field, and this handler had
		// always read only `data`. `mobile/src/net/ws.ts`'s `WsFrame` has no
		// `data` at all: it is `{type, hlc, key, payload, priority}`. So every
		// C→S frame the app ever sent arrived here with `Data == nil`, was
		// relayed with a null body, and was then dropped by the client on the
		// far side for having nothing in it — silently, because a nil
		// json.RawMessage marshals to `null` rather than failing.
		//
		// `payload` is canonical; `data` is kept as an alias (and still wins
		// when both are present) so nothing already built changes shape.
		Payload json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal(data, &in); err != nil {
		c.emitError(ctx, "KV-1001", "malformed client frame")
		return
	}

	// A neighbour connection is read-mostly by construction: it may keep its
	// own socket alive, but it may not inject location, presence or Family
	// Watch signalling into a family it is not a cryptographic member of (F-20).
	if c.ticket.Reduced && in.Type != "ping" {
		c.emitError(ctx, "KV-2001", "reduced session may not publish "+in.Type)
		return
	}

	if len(in.Data) == 0 {
		in.Data = in.Payload
	}

	now := time.Now().UnixMilli()
	switch in.Type {
	case "heartbeat":
		// Presence is transient by definition (§2.5.2: a 45 s TTL). It is
		// relayed live and never written: a presence tick on the durable stream
		// would be replayed to every reconnecting socket for the life of the
		// deployment. The client's body is not echoed — nothing reads it, and an
		// unbounded echo is a fan-out amplifier.
		c.publishEphemeral(notify.Frame{
			V: notify.FrameVersion, Type: "presence.changed", Priority: notify.PriorityLow,
			Key: "presence:" + c.ticket.MemberID, FamilyID: c.ticket.FamilyID, At: now,
			Data: map[string]any{
				"memberId": c.ticket.MemberID, "deviceId": c.ticket.DeviceID, "lastSeenAt": now,
			},
		})
	case "location.report":
		// Sealed on the device; the gateway relays ciphertext and never parses
		// coordinates out of it (§10.2 — the server holds no Class A plaintext).
		if len(in.Data) == 0 {
			c.emitError(ctx, "KV-1001", "malformed location.report")
			return
		}
		f := notify.Frame{
			V: notify.FrameVersion, Type: "location.update", Priority: notify.PriorityLow,
			Key: "loc:" + c.ticket.MemberID, FamilyID: c.ticket.FamilyID, At: now,
			Data: map[string]any{
				"memberId": c.ticket.MemberID, "deviceId": c.ticket.DeviceID,
				"sealed": json.RawMessage(in.Data), "at": now,
			},
		}
		c.publish(f)
	case "watch.signal":
		// ★ Spec D1/E1 (phase6b-redesign-and-family-watch) — Family Watch
		// signalling. The gateway relays one opaque blob and two routing fields;
		// it never sees an SDP offer, an ICE candidate, or even which of the two
		// capabilities is in play. All of that is sealed on the device under the
		// family's own per-session key, the same §10.2 rule location.report
		// already follows — which is also why a session id is a cleartext
		// routing field here and the AAD binding the ciphertext to it is not.
		//
		// HIGH, not CRITICAL, and deliberately not LOW: a lost signalling frame
		// costs a failed (or relay-only) watch session, which is a feature
		// degrading rather than a responder losing track of who is going
		// (§2.5.2) — but LOW coalesces per key, and coalescing an ICE
		// candidate stream keeps only the last candidate, which is a session
		// that never connects.
		//
		// EPHEMERAL, never durable: signalling that outlives the session is an
		// invite that re-opens a camera on the next reconnect (D-029). Live
		// sockets on this gateway see it; nothing else ever will.
		var sig struct {
			SessionID  string          `json:"sessionId"`
			ToMemberID string          `json:"toMemberId"`
			Sealed     json.RawMessage `json:"sealed"`
		}
		if err := json.Unmarshal(in.Data, &sig); err != nil ||
			sig.SessionID == "" || sig.ToMemberID == "" || len(sig.Sealed) == 0 {
			c.emitError(ctx, "KV-1001", "malformed watch.signal")
			return
		}
		c.publishEphemeral(notify.Frame{
			V: notify.FrameVersion, Type: "watch.signal", Priority: notify.PriorityHigh,
			FamilyID: c.ticket.FamilyID, At: now,
			Data: map[string]any{
				"sessionId":    sig.SessionID,
				"fromMemberId": c.ticket.MemberID, "fromDeviceId": c.ticket.DeviceID,
				"toMemberId": sig.ToMemberID,
				"sealed":     sig.Sealed, "at": now,
			},
		})
	case "ping":
		c.emit(ctx, "pong", notify.PriorityHigh, map[string]any{"at": now})
	case "incident.open":
		c.emitError(ctx, "KV-1001", "incident.open is not accepted over the socket; an SOS goes to sos-ingest over the HTTPS legs")
	default:
		c.emitError(ctx, "KV-1001", "unknown frame type "+in.Type)
	}
}

func (c *conn) emitError(ctx context.Context, code, detail string) {
	c.emit(ctx, "error", notify.PriorityHigh, map[string]any{"code": code, "detail": detail})
}

// publish appends to the family's durable stream: history a reconnecting
// socket is owed.
func (c *conn) publish(f notify.Frame) {
	if err := c.gw.bus.Publish(notify.StreamSubject(c.ticket.FamilyID), f.Encode()); err != nil {
		c.log.Error("client_publish_failed", "type", f.Type, "err", err)
	}
}

// publishEphemeral hands a frame to the live sockets of this family on this
// gateway and to nobody else, ever. Nothing is written; no cursor moves.
func (c *conn) publishEphemeral(f notify.Frame) {
	c.gw.bus.PublishEphemeral(bus.Msg{
		Subject: notify.StreamSubject(c.ticket.FamilyID), FamilyID: c.ticket.FamilyID,
		At: f.At, Data: f.Encode(),
	})
}

// shutdown sends a close frame once and tears the socket down. Telling the
// client *why* is what makes a resync automatic rather than a support ticket.
func (c *conn) shutdown(code int, reason string) {
	c.closeOnce.Do(func() {
		c.closeMu.Lock()
		c.closeCode, c.closeReason = code, reason
		c.closeMu.Unlock()
		c.wmu.Lock()
		_ = c.raw.SetWriteDeadline(time.Now().Add(2 * time.Second))
		_ = writeFrame(c.bw, opClose, closePayload(code, reason))
		c.wmu.Unlock()
		_ = c.raw.Close()
	})
}

func (c *conn) closeInfo() (int, string) {
	c.closeMu.Lock()
	defer c.closeMu.Unlock()
	return c.closeCode, c.closeReason
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
