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
	maxPayload       = 1 << 20 // 1 MiB; nothing legitimate here is close
	criticalCap      = 256
	overflowCap      = 200 // HIGH: bounded overflow queue
	criticalBlockFor = 5 * time.Second
	maxReplayFrames  = 500
	replayIdle       = 150 * time.Millisecond
	pingEvery        = 20 * time.Second
	pongDeadline     = 30 * time.Second
	subprotocol      = "kavach.v1"
)

func main() {
	var (
		addr    = flag.String("addr", env("KAVACH_RT_ADDR", ":8082"), "listen address")
		busDir  = flag.String("bus", env("KAVACH_BUS_DIR", "./data/bus"), "bus directory")
		dev     = flag.Bool("dev", env("KAVACH_DEV", "1") == "1", "developer logging")
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

	tickets := newTicketCache(log)
	go tickets.follow(ctx, b)

	gw := &gateway{log: log, bus: b, tickets: tickets, allowNoTicket: *allowNT}

	mux := http.NewServeMux()
	mux.HandleFunc("/v1/stream", gw.stream)
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
	rows map[string]ticket
}

func newTicketCache(log *slog.Logger) *ticketCache {
	return &ticketCache{log: log, rows: map[string]ticket{}}
}

func (c *ticketCache) follow(ctx context.Context, b *bus.Bus) {
	ch, cancel := b.Subscribe(notify.TicketSubject, 0)
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
			var t ticket
			if err := json.Unmarshal(m.Data, &t); err != nil || t.Ticket == "" {
				continue
			}
			c.mu.Lock()
			// Replayed tickets from before this process started are already
			// expired and get swept immediately; keeping them costs nothing and
			// avoids special-casing the boot replay.
			c.rows[t.Ticket] = t
			c.mu.Unlock()
		case <-sweep.C:
			now := time.Now().UnixMilli()
			c.mu.Lock()
			for k, v := range c.rows {
				if v.ExpiresAt <= now {
					delete(c.rows, k)
				}
			}
			c.mu.Unlock()
		}
	}
}

// consume validates and burns a ticket. Single use: a replayed ticket is a
// replayed credential, and the whole point of a 60-second single-use token is
// that observing it once buys nothing.
func (c *ticketCache) consume(raw string) (ticket, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	t, ok := c.rows[raw]
	if !ok {
		return ticket{}, false
	}
	delete(c.rows, raw)
	if t.ExpiresAt <= time.Now().UnixMilli() {
		return ticket{}, false
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

// stream is the only endpoint. GET /v1/stream?cursor=<seq>
func (g *gateway) stream(w http.ResponseWriter, r *http.Request) {
	proto := r.Header.Get("Sec-WebSocket-Protocol")
	tk, ok := g.authorise(proto)
	if !ok {
		// Refuse before the upgrade so the client gets a readable HTTP error
		// rather than an immediate close frame it has to decode.
		http.Error(w, `{"code":"KV-1002","detail":"missing or invalid connect ticket"}`,
			http.StatusUnauthorized)
		return
	}

	netConn, brw, err := upgrade(w, r)
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

	var cursor uint64
	if v := r.URL.Query().Get("cursor"); v != "" {
		if n, err := strconv.ParseUint(v, 10, 64); err == nil {
			cursor = n
		}
	}

	c := &conn{
		gw: g, log: g.log.With("device", tk.DeviceID, "family", tk.FamilyID),
		raw: netConn, br: brw.Reader, bw: brw.Writer,
		ticket: tk, subject: subject, cursor: cursor,
		critical: make(chan []byte, criticalCap),
		wake:     make(chan struct{}, 1),
		room:     make(chan struct{}, 1),
		coalesce: map[string][]byte{},
	}
	g.track(c)
	c.run(r.Context())
	g.untrack(c)
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
	defer r.Body.Close()
	var in struct {
		Sealed json.RawMessage `json:"sealed"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&in); err != nil || len(in.Sealed) == 0 {
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

func upgrade(w http.ResponseWriter, r *http.Request) (net.Conn, *bufio.ReadWriter, error) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return nil, nil, errors.New("ws: not a GET")
	}
	if !headerContainsToken(r.Header.Get("Connection"), "upgrade") ||
		!strings.EqualFold(strings.TrimSpace(r.Header.Get("Upgrade")), "websocket") {
		http.Error(w, "expected websocket upgrade", http.StatusBadRequest)
		return nil, nil, errors.New("ws: not an upgrade")
	}
	if r.Header.Get("Sec-WebSocket-Version") != "13" {
		w.Header().Set("Sec-WebSocket-Version", "13")
		http.Error(w, "unsupported websocket version", http.StatusUpgradeRequired)
		return nil, nil, errors.New("ws: bad version")
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		http.Error(w, "missing Sec-WebSocket-Key", http.StatusBadRequest)
		return nil, nil, errors.New("ws: missing key")
	}
	if raw, err := base64.StdEncoding.DecodeString(key); err != nil || len(raw) != 16 {
		http.Error(w, "malformed Sec-WebSocket-Key", http.StatusBadRequest)
		return nil, nil, errors.New("ws: malformed key")
	}

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

// ── Connection ───────────────────────────────────────────────────────────────

type conn struct {
	gw  *gateway
	log *slog.Logger
	raw net.Conn
	br  *bufio.Reader
	bw  *bufio.Writer

	ticket  ticket
	subject string
	cursor  uint64

	// CRITICAL: a bounded channel. Producers block on it deliberately.
	critical chan []byte
	// room signals a producer that a critical slot freed up.
	room chan struct{}

	// mu guards the HIGH/LOW queues; wmu serialises socket writes. They are
	// separate locks because the reader answers pings on the same socket the
	// writer is draining, and one mutex for both would let a slow write block
	// an enqueue.
	mu            sync.Mutex
	wmu           sync.Mutex
	seqMu         sync.Mutex
	overflow      [][]byte          // HIGH
	coalesce      map[string][]byte // LOW: latest per key
	coalesceOrder []string
	overflowDrops int
	closeOnce     sync.Once
	closeCode     int
	closeReason   string

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
	go func() {
		<-ctx.Done()
		c.shutdown(closeNormal, "session ended")
	}()

	wg.Wait()
	c.log.Info("connection_closed",
		"code", c.closeCode, "reason", c.closeReason, "overflowDrops", c.overflowDrops)
}

// ── Enqueue: the backpressure policy ─────────────────────────────────────────

// pushCritical never drops. State transitions, CLAIM, RELEASE and escalation
// tier changes take this path: the connection blocks for up to five seconds
// waiting for room, and if it still cannot deliver, the socket is closed with
// a resync code so the client reconnects from its cursor and rebuilds. Losing
// the frame silently is the one outcome that is not allowed.
func (c *conn) pushCritical(ctx context.Context, data []byte) {
	deadline := time.NewTimer(criticalBlockFor)
	defer deadline.Stop()
	for {
		select {
		case c.critical <- data:
			c.signal()
			return
		default:
		}
		select {
		case c.critical <- data:
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
// is dropped rather than blocking the socket.
func (c *conn) pushHigh(data []byte) {
	c.mu.Lock()
	if len(c.overflow) >= overflowCap {
		c.overflow = c.overflow[1:]
		c.overflowDrops++
	}
	c.overflow = append(c.overflow, data)
	c.mu.Unlock()
	c.signal()
}

// pushLow coalesces. A client forty frames behind on location wants the newest
// position, not a replay of a forty-second-old track — so we keep exactly one
// frame per key and overwrite it.
func (c *conn) pushLow(key string, data []byte) {
	if key == "" {
		key = "default"
	}
	c.mu.Lock()
	if _, seen := c.coalesce[key]; !seen {
		c.coalesceOrder = append(c.coalesceOrder, key)
	}
	c.coalesce[key] = data
	c.mu.Unlock()
	c.signal()
}

func (c *conn) popHigh() ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.overflow) == 0 {
		return nil, false
	}
	d := c.overflow[0]
	c.overflow = c.overflow[1:]
	return d, true
}

func (c *conn) popLow() ([]byte, bool) {
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

// ── Writer ───────────────────────────────────────────────────────────────────

func (c *conn) writer(ctx context.Context, cancel context.CancelFunc) {
	defer cancel()
	ping := time.NewTicker(pingEvery)
	defer ping.Stop()

	write := func(data []byte) bool {
		c.wmu.Lock()
		defer c.wmu.Unlock()
		_ = c.raw.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if err := writeFrame(c.bw, opText, data); err != nil {
			c.log.Debug("write_failed", "err", err)
			return false
		}
		return true
	}

	for {
		// Strict priority: drain CRITICAL to empty before touching anything
		// else, then HIGH, then the coalesced LOW frames.
		select {
		case <-ctx.Done():
			return
		case d := <-c.critical:
			c.freeRoom()
			if !write(d) {
				return
			}
			continue
		default:
		}
		if d, ok := c.popHigh(); ok {
			if !write(d) {
				return
			}
			continue
		}
		if d, ok := c.popLow(); ok {
			if !write(d) {
				return
			}
			continue
		}

		select {
		case <-ctx.Done():
			return
		case d := <-c.critical:
			c.freeRoom()
			if !write(d) {
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

// ── Bus pump ─────────────────────────────────────────────────────────────────

// pump replays from the cursor, emits sync.complete, then goes live. The
// replay burst is capped: a client that has been offline for a week wants the
// current state of the world, not a week of history, and it can fetch the rest
// over HTTP if sync.truncated says it should.
func (c *conn) pump(ctx context.Context, cancel context.CancelFunc) {
	defer cancel()
	ch, unsub := c.gw.bus.Subscribe(c.subject, c.cursor)
	defer unsub()

	replaying := true
	truncated := false
	var buf []busItem
	idle := time.NewTimer(replayIdle)
	defer idle.Stop()

	finishReplay := func() {
		for _, it := range buf {
			c.deliver(ctx, it.data)
		}
		buf = nil
		c.emit(ctx, notify.Frame{
			V: notify.FrameVersion, Type: "sync.complete", Priority: notify.PriorityCritical,
			FamilyID: c.ticket.FamilyID, At: time.Now().UnixMilli(),
			Data: map[string]any{"cursor": c.lastSeq(), "truncated": truncated},
		})
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
			c.setSeq(m.Seq)
			if replaying {
				buf = append(buf, busItem{seq: m.Seq, data: m.Data})
				if len(buf) > maxReplayFrames {
					buf = buf[len(buf)-maxReplayFrames:]
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
			c.deliver(ctx, m.Data)
		case <-idle.C:
			if replaying {
				finishReplay()
			}
		}
	}
}

type busItem struct {
	seq  uint64
	data []byte
}

// deliver classifies a bus payload and routes it to the right queue. The
// producer stamped the priority; the gateway trusts it, because the producer is
// the only party that knows what the frame means.
func (c *conn) deliver(ctx context.Context, data []byte) {
	var hdr struct {
		Priority notify.Priority `json:"priority"`
		Key      string          `json:"key"`
		Type     string          `json:"type"`
	}
	if err := json.Unmarshal(data, &hdr); err != nil {
		// An undecodable frame is treated as CRITICAL: we would rather deliver
		// something we could not classify than silently swallow a transition.
		c.pushCritical(ctx, data)
		return
	}
	switch hdr.Priority {
	case notify.PriorityLow:
		c.pushLow(hdr.Key+"|"+hdr.Type, data)
	case notify.PriorityHigh:
		c.pushHigh(data)
	default:
		c.pushCritical(ctx, data)
	}
}

func (c *conn) emit(ctx context.Context, f notify.Frame) {
	c.pushCritical(ctx, f.Encode())
}

func (c *conn) setSeq(s uint64) {
	c.seqMu.Lock()
	c.cursor = s
	c.seqMu.Unlock()
}

func (c *conn) lastSeq() uint64 {
	c.seqMu.Lock()
	defer c.seqMu.Unlock()
	return c.cursor
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

// handleMessage processes C→S frames (§9.2: heartbeat, location.report, ack;
// 6-D-7 adds watch.signal).
func (c *conn) handleMessage(ctx context.Context, data []byte) {
	var in struct {
		Type string          `json:"type"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(data, &in); err != nil {
		c.emit(ctx, notify.Frame{
			V: notify.FrameVersion, Type: "error", Priority: notify.PriorityHigh,
			FamilyID: c.ticket.FamilyID, At: time.Now().UnixMilli(),
			Data: map[string]any{"code": "KV-1001", "detail": "malformed client frame"},
		})
		return
	}

	// A neighbour connection is read-mostly by construction: it may acknowledge
	// an alert, but it may not inject location or presence into a family it is
	// not a cryptographic member of (F-20).
	if c.ticket.Reduced && in.Type != "ack" && in.Type != "heartbeat" {
		c.emit(ctx, notify.Frame{
			V: notify.FrameVersion, Type: "error", Priority: notify.PriorityHigh,
			FamilyID: c.ticket.FamilyID, At: time.Now().UnixMilli(),
			Data: map[string]any{"code": "KV-2001", "detail": "reduced session may not publish " + in.Type},
		})
		return
	}

	now := time.Now().UnixMilli()
	switch in.Type {
	case "heartbeat":
		f := notify.Frame{
			V: notify.FrameVersion, Type: "presence.changed", Priority: notify.PriorityLow,
			Key: "presence:" + c.ticket.MemberID, FamilyID: c.ticket.FamilyID, At: now,
			Data: map[string]any{
				"memberId": c.ticket.MemberID, "deviceId": c.ticket.DeviceID,
				"lastSeenAt": now, "raw": json.RawMessage(in.Data),
			},
		}
		c.publish(f)
	case "location.report":
		// Sealed on the device; the gateway relays ciphertext and never parses
		// coordinates out of it (§10.2 — the server holds no Class A plaintext).
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
		var sig struct {
			SessionID  string          `json:"sessionId"`
			ToMemberID string          `json:"toMemberId"`
			Sealed     json.RawMessage `json:"sealed"`
		}
		if err := json.Unmarshal(in.Data, &sig); err != nil ||
			sig.SessionID == "" || sig.ToMemberID == "" || len(sig.Sealed) == 0 {
			c.emit(ctx, notify.Frame{
				V: notify.FrameVersion, Type: "error", Priority: notify.PriorityHigh,
				FamilyID: c.ticket.FamilyID, At: now,
				Data: map[string]any{"code": "KV-1001", "detail": "malformed watch.signal"},
			})
			return
		}
		c.publish(notify.Frame{
			V: notify.FrameVersion, Type: "watch.signal", Priority: notify.PriorityHigh,
			FamilyID: c.ticket.FamilyID, At: now,
			Data: map[string]any{
				"sessionId":    sig.SessionID,
				"fromMemberId": c.ticket.MemberID, "fromDeviceId": c.ticket.DeviceID,
				"toMemberId": sig.ToMemberID,
				"sealed":     sig.Sealed, "at": now,
			},
		})
	case "ack":
		f := notify.Frame{
			V: notify.FrameVersion, Type: "incident.acked", Priority: notify.PriorityCritical,
			FamilyID: c.ticket.FamilyID, At: now,
			Data: map[string]any{
				"memberId": c.ticket.MemberID, "deviceId": c.ticket.DeviceID,
				"detail": json.RawMessage(in.Data),
			},
		}
		c.publish(f)
	case "ping":
		c.emit(ctx, notify.Frame{
			V: notify.FrameVersion, Type: "pong", Priority: notify.PriorityHigh,
			FamilyID: c.ticket.FamilyID, At: now,
		})
	default:
		c.emit(ctx, notify.Frame{
			V: notify.FrameVersion, Type: "error", Priority: notify.PriorityHigh,
			FamilyID: c.ticket.FamilyID, At: now,
			Data: map[string]any{"code": "KV-1001", "detail": "unknown frame type " + in.Type},
		})
	}
}

func (c *conn) publish(f notify.Frame) {
	if err := c.gw.bus.Publish(notify.StreamSubject(c.ticket.FamilyID), f.Encode()); err != nil {
		c.log.Error("client_publish_failed", "type", f.Type, "err", err)
	}
}

// shutdown sends a close frame once and tears the socket down. Telling the
// client *why* is what makes a resync automatic rather than a support ticket.
func (c *conn) shutdown(code int, reason string) {
	c.closeOnce.Do(func() {
		c.closeCode, c.closeReason = code, reason
		c.wmu.Lock()
		_ = c.raw.SetWriteDeadline(time.Now().Add(2 * time.Second))
		_ = writeFrame(c.bw, opClose, closePayload(code, reason))
		c.wmu.Unlock()
		_ = c.raw.Close()
	})
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
