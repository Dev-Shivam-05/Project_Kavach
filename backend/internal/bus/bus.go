// Package bus is an in-process, file-backed pub/sub with the subject semantics
// ADR-007 assigns to NATS JetStream.
//
// ADR-007 chose NATS because it is a 15 MB binary a family can run at home. The
// stdlib-only constraint takes that reasoning one step further: at family scale
// the broker and its only publisher live in the same process, so the network hop
// buys nothing and costs an operational dependency. What we keep is everything
// the architecture actually relies on — subjects namespaced fam.{id}.* (§15.4),
// a durable replayable stream, cursors that survive restart, and at-least-once
// delivery with consumers deduping on (incident_id, hlc).
//
// ★ Class A′ (§2.4.6). PublishEphemeral delivers ONLY to ephemeral subscribers
// and is never written to the stream file. Durable subscribers cannot receive it
// even by mistake, because they are a different list. That is the structural
// enforcement of "precise coordinates are consumed in memory and never
// persisted" — a rule that a comment alone would eventually lose.
package bus

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kavach/backend/internal/wal"
)

// Message kinds carried on the stream.
const (
	KindIncidentOpen  = "incident_open"
	KindIncidentEvent = "incident_event"
	KindAccessLog     = "access_log"
	// KindLocationPrecise is Class A′ and may only ever travel via
	// PublishEphemeral. Publish rejects it.
	KindLocationPrecise = "location_precise"
)

// ErrClassAPrime is returned when precise-location data is offered to the
// durable stream. Refusing is correct: the fan-out worker is live in memory, so
// a durable copy would buy nothing and break NFR-013.
var ErrClassAPrime = errors.New("bus: precise location may not enter the durable stream (Class A′)")

var ErrClosed = errors.New("bus: closed")

// Msg is one stream record.
type Msg struct {
	Seq        uint64          `json:"seq"`
	Subject    string          `json:"subject"`
	Kind       string          `json:"kind"`
	IncidentID string          `json:"incident_id"`
	FamilyID   string          `json:"family_id"`
	HLC        string          `json:"hlc"`
	At         int64           `json:"at"`
	Data       json.RawMessage `json:"data"`
}

// DedupeKey is the at-least-once dedupe identity mandated by §2.5.1 step 3.
func (m Msg) DedupeKey() string { return m.IncidentID + "|" + m.HLC }

// Handler processes a message. Returning an error means "not consumed": the
// cursor does not advance and the message is retried.
type Handler func(Msg) error

// Start selects where a brand-new durable subscription begins. A durable that
// already has a persisted cursor always resumes from it, whatever this says.
type Start int

const (
	// StartAll replays the whole retained stream. This is what a projector wants
	// after a crash — it is cheap, and dedupe makes it harmless.
	StartAll Start = iota
	// StartNew ignores history.
	StartNew
)

const (
	maxDeliveryAttempts = 5
	retryBackoff        = 25 * time.Millisecond
	ephBuffer           = 256
	pollInterval        = 250 * time.Millisecond
)

// Bus is safe for concurrent use.
type Bus struct {
	mu      sync.RWMutex
	log     *wal.WAL
	dir     string
	msgs    []Msg
	subs    []*Sub
	eph     []*EphSub
	cursors map[string]uint64
	closed  bool
	anon    uint64

	ephDropped uint64
}

// Open loads (or creates) the stream in dir: stream.wal plus cursors.json.
func Open(dir string) (*Bus, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	lg, err := wal.Open(filepath.Join(dir, "stream.wal"))
	if err != nil {
		return nil, err
	}
	b := &Bus{log: lg, dir: dir, cursors: map[string]uint64{}}
	if err := lg.Replay(func(seq uint64, _ int64, payload []byte) error {
		var m Msg
		if err := json.Unmarshal(payload, &m); err != nil {
			return nil // a record we cannot parse is skipped, never fatal at boot
		}
		m.Seq = seq
		b.msgs = append(b.msgs, m)
		return nil
	}); err != nil {
		_ = lg.Close()
		return nil, err
	}
	if raw, err := os.ReadFile(filepath.Join(dir, "cursors.json")); err == nil {
		_ = json.Unmarshal(raw, &b.cursors)
	}
	return b, nil
}

// Subject builds fam.{id}.{leaf...} (§15.4). Every message on this bus is
// tenant-scoped by construction, which is what makes sharding by family a
// configuration change later rather than a migration.
func Subject(familyID string, leaf ...string) string {
	parts := append([]string{"fam", familyID}, leaf...)
	return strings.Join(parts, ".")
}

// FamilyOf extracts the family id from a fam.{id}.* subject.
func FamilyOf(subject string) string {
	p := strings.Split(subject, ".")
	if len(p) < 2 || p[0] != "fam" {
		return ""
	}
	return p[1]
}

// Match implements NATS token wildcards: '*' matches exactly one token, '>'
// matches one or more trailing tokens.
func Match(pattern, subject string) bool {
	pt := strings.Split(pattern, ".")
	st := strings.Split(subject, ".")
	for i, tok := range pt {
		if tok == ">" {
			return i < len(st)
		}
		if i >= len(st) {
			return false
		}
		if tok != "*" && tok != st[i] {
			return false
		}
	}
	return len(pt) == len(st)
}

func (b *Bus) publish(m Msg, sync bool) (uint64, error) {
	if m.Kind == KindLocationPrecise {
		return 0, ErrClassAPrime
	}
	if m.At == 0 {
		m.At = time.Now().UnixMilli()
	}
	if m.FamilyID == "" {
		m.FamilyID = FamilyOf(m.Subject)
	}

	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return 0, ErrClosed
	}
	m.Seq = uint64(len(b.msgs)) + 1
	payload, err := json.Marshal(m)
	if err != nil {
		b.mu.Unlock()
		return 0, err
	}
	if sync {
		_, err = b.log.AppendSync(payload)
	} else {
		_, err = b.log.Append(payload)
	}
	if err != nil {
		b.mu.Unlock()
		return 0, err
	}
	b.msgs = append(b.msgs, m)
	subs := make([]*Sub, len(b.subs))
	copy(subs, b.subs)
	b.mu.Unlock()

	for _, s := range subs {
		s.notify()
	}
	return m.Seq, nil
}

// PublishMsg appends to the durable stream and wakes matching subscribers. The
// fsync is deferred: the ingest WAL is the durability record of truth for an
// incident, and paying a second fsync on the request path would spend the very
// milliseconds ADR-002 exists to protect.
func (b *Bus) PublishMsg(m Msg) (uint64, error) { return b.publish(m, false) }

// Publish is the subject+bytes form NATS clients expect. The dedupe identity is
// recovered from the payload when it carries one, so a consumer that dedupes on
// (incident_id, hlc) works the same whichever form the publisher used.
func (b *Bus) Publish(subject string, data []byte) error {
	m := Msg{Subject: subject, Data: append([]byte(nil), data...)}
	var probe struct {
		Kind        string `json:"kind"`
		IncidentID  string `json:"incident_id"`
		IncidentID2 string `json:"incidentId"`
		HLC         string `json:"hlc"`
	}
	if json.Unmarshal(data, &probe) == nil {
		m.Kind, m.IncidentID, m.HLC = probe.Kind, probe.IncidentID, probe.HLC
		if m.IncidentID == "" {
			m.IncidentID = probe.IncidentID2
		}
	}
	_, err := b.publish(m, false)
	return err
}

// PublishSync fsyncs before returning. For anything not on the SOS hot path.
func (b *Bus) PublishSync(m Msg) (uint64, error) { return b.publish(m, true) }

// PublishEphemeral hands a message to live ephemeral subscribers only. Nothing
// is written to disk and no cursor moves. This is the ONLY channel Class A′
// precise coordinates may travel on (§2.4.6).
func (b *Bus) PublishEphemeral(m Msg) int {
	if m.At == 0 {
		m.At = time.Now().UnixMilli()
	}
	if m.FamilyID == "" {
		m.FamilyID = FamilyOf(m.Subject)
	}
	b.mu.RLock()
	if b.closed {
		b.mu.RUnlock()
		return 0
	}
	targets := make([]*EphSub, 0, len(b.eph))
	for _, e := range b.eph {
		if Match(e.pattern, m.Subject) {
			targets = append(targets, e)
		}
	}
	b.mu.RUnlock()

	delivered := 0
	for _, e := range targets {
		select {
		case e.ch <- m:
			delivered++
		default:
			// A wedged fan-out worker must not grow memory without bound. Count it;
			// the durable coarse-cell record of the same incident is unaffected.
			b.mu.Lock()
			b.ephDropped++
			b.mu.Unlock()
		}
	}
	return delivered
}

// Replay walks retained messages matching pattern with Seq > from.
func (b *Bus) Replay(pattern string, from uint64, fn func(Msg) error) error {
	b.mu.RLock()
	snapshot := make([]Msg, len(b.msgs))
	copy(snapshot, b.msgs)
	b.mu.RUnlock()
	for _, m := range snapshot {
		if m.Seq <= from || !Match(pattern, m.Subject) {
			continue
		}
		if err := fn(m); err != nil {
			return err
		}
	}
	return nil
}

func (b *Bus) LastSeq() uint64 {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return uint64(len(b.msgs))
}

func (b *Bus) EphemeralDropped() uint64 {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.ephDropped
}

// ── durable subscriptions ────────────────────────────────────────────────────

// Sub is a durable consumer. Its cursor is persisted, so a restart resumes
// where it stopped instead of re-notifying a family about a resolved incident.
type Sub struct {
	bus     *Bus
	durable string
	pattern string
	handler Handler
	persist bool
	wake    chan struct{}
	quit    chan struct{}
	done    chan struct{}

	mu     sync.Mutex
	cursor uint64
	dead   []Msg
}

// SubscribeDurable registers a named consumer whose cursor is persisted, and
// starts its worker.
func (b *Bus) SubscribeDurable(durable, pattern string, start Start, h Handler) (*Sub, error) {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return nil, ErrClosed
	}
	for _, s := range b.subs {
		if s.durable == durable {
			b.mu.Unlock()
			return nil, errors.New("bus: durable already subscribed: " + durable)
		}
	}
	cursor, resumed := b.cursors[durable]
	if !resumed && start == StartNew {
		cursor = uint64(len(b.msgs))
	}
	s := b.attach(durable, pattern, cursor, true, h)
	b.mu.Unlock()

	go s.run()
	s.notify()
	return s, nil
}

// attach must be called with b.mu held.
func (b *Bus) attach(durable, pattern string, cursor uint64, persist bool, h Handler) *Sub {
	s := &Sub{
		bus: b, durable: durable, pattern: pattern, handler: h, persist: persist,
		wake: make(chan struct{}, 1), quit: make(chan struct{}), done: make(chan struct{}),
		cursor: cursor,
	}
	b.subs = append(b.subs, s)
	return s
}

// Subscribe is the channel form: replay from cursor `from`, then go live. The
// returned cancel function stops the worker and closes the channel; it is safe
// to call more than once.
func (b *Bus) Subscribe(pattern string, from uint64) (<-chan Msg, func()) {
	ch := make(chan Msg, 64)
	done := make(chan struct{})
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		close(ch)
		return ch, func() {}
	}
	b.anon++
	name := "anon-" + strconv.FormatUint(b.anon, 10)
	s := b.attach(name, pattern, from, false, func(m Msg) error {
		select {
		case ch <- m:
		case <-done:
		}
		return nil
	})
	b.mu.Unlock()

	go s.run()
	s.notify()
	var once sync.Once
	return ch, func() {
		once.Do(func() {
			close(done)
			s.Close()
			close(ch)
		})
	}
}

func (s *Sub) notify() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *Sub) run() {
	defer close(s.done)
	t := time.NewTicker(pollInterval)
	defer t.Stop()
	for {
		s.drain()
		select {
		case <-s.quit:
			s.drain()
			return
		case <-s.wake:
		case <-t.C:
		}
	}
}

func (s *Sub) drain() {
	moved := false
	for {
		s.mu.Lock()
		cursor := s.cursor
		s.mu.Unlock()

		s.bus.mu.RLock()
		if int(cursor) >= len(s.bus.msgs) {
			s.bus.mu.RUnlock()
			break
		}
		m := s.bus.msgs[cursor]
		s.bus.mu.RUnlock()

		if Match(s.pattern, m.Subject) {
			if err := s.deliver(m); err != nil {
				// At-least-once has a floor: after maxDeliveryAttempts the message
				// goes to a dead-letter list that /healthz surfaces. Blocking the
				// whole stream on one poison record would stall every OTHER family's
				// incidents, which is a strictly worse failure.
				s.mu.Lock()
				s.dead = append(s.dead, m)
				s.mu.Unlock()
			}
		}
		s.mu.Lock()
		s.cursor = cursor + 1
		s.mu.Unlock()
		moved = true
	}
	if moved {
		s.persistCursor()
	}
}

func (s *Sub) deliver(m Msg) error {
	var err error
	for attempt := 1; attempt <= maxDeliveryAttempts; attempt++ {
		if err = s.handler(m); err == nil {
			return nil
		}
		select {
		case <-s.quit:
			return err
		case <-time.After(time.Duration(attempt) * retryBackoff):
		}
	}
	return err
}

func (s *Sub) persistCursor() {
	if !s.persist {
		return
	}
	s.mu.Lock()
	cursor := s.cursor
	s.mu.Unlock()

	b := s.bus
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return
	}
	b.cursors[s.durable] = cursor
	raw, err := json.Marshal(b.cursors)
	dir := b.dir
	b.mu.Unlock()
	if err != nil {
		return
	}
	writeAtomic(filepath.Join(dir, "cursors.json"), raw)
}

// Cursor reports the number of stream records this consumer has passed.
func (s *Sub) Cursor() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cursor
}

// DeadLetters returns messages that exhausted their delivery attempts.
func (s *Sub) DeadLetters() []Msg {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Msg, len(s.dead))
	copy(out, s.dead)
	return out
}

// Drain blocks until the consumer has caught up with the stream. Tests and
// shutdown use it; the request path never does.
func (s *Sub) Drain(timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if s.Cursor() >= s.bus.LastSeq() {
			return true
		}
		s.notify()
		time.Sleep(2 * time.Millisecond)
	}
	return s.Cursor() >= s.bus.LastSeq()
}

func (s *Sub) Close() {
	select {
	case <-s.quit:
		return
	default:
	}
	close(s.quit)
	<-s.done
	s.persistCursor()
}

// ── ephemeral subscriptions (Class A′) ───────────────────────────────────────

// EphSub receives live-only messages. It has no cursor and no history: if the
// worker was not running when the message was published, the message is gone.
// For precise coordinates that is the desired property, not a limitation.
type EphSub struct {
	pattern string
	ch      chan Msg
	quit    chan struct{}
	done    chan struct{}
}

func (b *Bus) SubscribeEphemeral(pattern string, h Handler) (*EphSub, error) {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return nil, ErrClosed
	}
	e := &EphSub{
		pattern: pattern,
		ch:      make(chan Msg, ephBuffer),
		quit:    make(chan struct{}),
		done:    make(chan struct{}),
	}
	b.eph = append(b.eph, e)
	b.mu.Unlock()

	go func() {
		defer close(e.done)
		for {
			select {
			case <-e.quit:
				return
			case m := <-e.ch:
				_ = h(m) // live fan-out; a failure has no durable retry by design
			}
		}
	}()
	return e, nil
}

func (e *EphSub) Close() {
	select {
	case <-e.quit:
		return
	default:
	}
	close(e.quit)
	<-e.done
}

// ── dedupe ───────────────────────────────────────────────────────────────────

// Deduper implements the (incident_id, hlc) dedupe every consumer owes the bus.
// Bounded: it forgets the oldest keys rather than growing without limit.
type Deduper struct {
	mu    sync.Mutex
	seen  map[string]struct{}
	order []string
	cap   int
}

func NewDeduper(capacity int) *Deduper {
	if capacity <= 0 {
		capacity = 4096
	}
	return &Deduper{seen: make(map[string]struct{}, capacity), cap: capacity}
}

// Has reports whether the key is already recorded, WITHOUT recording it. A
// consumer whose work can fail must check with Has and only Seen on success —
// marking first would turn a retryable failure into silent data loss.
func (d *Deduper) Has(incidentID, hlc string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	_, ok := d.seen[incidentID+"|"+hlc]
	return ok
}

// Seen records the key and reports whether it had already been recorded.
func (d *Deduper) Seen(incidentID, hlc string) bool {
	k := incidentID + "|" + hlc
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.seen[k]; ok {
		return true
	}
	d.seen[k] = struct{}{}
	d.order = append(d.order, k)
	if len(d.order) > d.cap {
		drop := d.order[0]
		d.order = d.order[1:]
		delete(d.seen, drop)
	}
	return false
}

func (b *Bus) Close() error {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return nil
	}
	subs := make([]*Sub, len(b.subs))
	copy(subs, b.subs)
	eph := make([]*EphSub, len(b.eph))
	copy(eph, b.eph)
	b.mu.Unlock()

	for _, s := range subs {
		s.Close()
	}
	for _, e := range eph {
		e.Close()
	}

	b.mu.Lock()
	b.closed = true
	raw, _ := json.Marshal(b.cursors)
	dir := b.dir
	b.mu.Unlock()
	writeAtomic(filepath.Join(dir, "cursors.json"), raw)
	return b.log.Close()
}

// writeAtomic is temp-then-rename so a crash cannot leave a half-written cursor
// file that would make a consumer replay from nowhere.
func writeAtomic(path string, data []byte) {
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return
	}
	_ = f.Sync()
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return
	}
	_ = os.Rename(tmp, path)
}
