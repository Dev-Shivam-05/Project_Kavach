// Command sos-ingest is the one binary that must never break.
//
// ★ LOC SELF-CHECK — ADR-002 CI-ENFORCED BUDGET ★
//
//	≤1000 source lines (blank and comment lines excluded) · ≤5 direct
//	dependencies (this file has ZERO: stdlib only) · NO DB read on the request
//	path · no ORM, no reflection, no templates · no shared code with the control
//	plane · deployed ≤2×/year · own health check, own pipeline, own rollback.
//
// TestLOCBudget in main_test.go fails the build if this file outgrows the
// ceiling. The ceiling is the feature: "you will ship a bug to the control
// plane; when you do, SOS must still work" is only true while this file stays
// small enough that one person can read all of it before a deploy.
//
// The request path, in order, for every endpoint:
//  1. io.LimitReader(r.Body, 8 KB)
//  2. resolve the family from an IN-MEMORY cache (unknown family = 404; F-04)
//  3. verify Ed25519 against an IN-MEMORY key cache — bad signature is FLAGGED,
//     never rejected (ADR-018)
//  4. fsync the WAL BEFORE responding
//  5. publish to the bus
//  6. answer with the server timestamp, because "help is on the way" is itself
//     a safety feature
package main

import (
	"context"
	"crypto/hmac"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/kavach/backend/internal/bus"
	"github.com/kavach/backend/internal/envelope"
	sm "github.com/kavach/backend/internal/incident"
	"github.com/kavach/backend/internal/logx"
	"github.com/kavach/backend/internal/store"
	"github.com/kavach/backend/internal/wal"
)

const (
	// floodThreshold is the F-04 bound: beyond this many concurrent UNVERIFIED
	// incidents from one family inside floodWindow, further unverified opens
	// COALESCE into the first one. Coalescing preserves fail-open semantics
	// exactly — the family is still alerted — while capping the blast radius.
	floodThreshold = 3
	floodWindow    = 60 * time.Second
	// inc8TTL matches the Valkey TTL in §2.10.2.
	inc8TTL = 24 * time.Hour
	// sweepEvery bounds how often the hot-path maps are swept. ADR-002 deploys
	// this binary twice a year, so "it only leaks a little" compounds into an OOM,
	// and an OOM here is a dropped SOS.
	sweepEvery        = 5 * time.Minute
	defaultRefresh    = 60 * time.Minute
	smsWindowSeconds  = 300 // floor(ts/300): the F-09 determinism window
	projectorDurable  = "sos-ingest.projector"
	fanoutSubjectLeaf = "fanout"
)

// ── record: the single wire representation shared by the WAL and the bus ─────

// record is what gets fsynced and what gets published. Body is always a
// canonical envelope — the device's verbatim bytes on the HTTP paths, and a
// synthesised coarse-only envelope on the SMS path — so the projector has
// exactly one shape to understand.
//
// ★ There is deliberately no field on this struct that can hold a precise
// coordinate. Class A′ data reaches fan-out through bus.PublishEphemeral and
// never through anything that is written to disk (§2.4.6).
type record struct {
	Kind       string `json:"kind"`
	At         int64  `json:"at"`
	FamilyID   string `json:"family_id"`
	IncidentID string `json:"incident_id"`
	DeviceID   string `json:"device_id"`
	HLC        string `json:"hlc"`
	Transport  string `json:"transport"`
	EventType  string `json:"event_type,omitempty"`
	Flags      int64  `json:"flags"`
	Verified   bool   `json:"verified"`
	Signature  string `json:"signature,omitempty"`
	Body       string `json:"body"`
	RelayedBy  string `json:"relayed_by,omitempty"`
	Synthetic  bool   `json:"synthetic_from_sms,omitempty"`

	Access *store.AccessLog `json:"access,omitempty"`
}

type ack struct {
	IncidentID    string `json:"incidentId"`
	ServerTsMs    int64  `json:"serverTsMs"`
	Verified      bool   `json:"verified"`
	Flags         int64  `json:"flags"`
	Duplicate     bool   `json:"duplicate,omitempty"`
	CoalescedInto string `json:"coalescedInto,omitempty"`
	Code          string `json:"code,omitempty"`
}

// ── caches (F-22: persisted on every refresh, loaded at boot) ────────────────

type famEntry struct {
	ID     string `json:"id"`
	SMSKey []byte `json:"sms_key,omitempty"`
}

type keyEntry struct {
	DeviceID string `json:"device_id"`
	FamilyID string `json:"family_id"`
	MemberID string `json:"member_id"`
	Pub      []byte `json:"pub"`
}

type phoneEntry struct {
	Phone    string `json:"phone"`
	FamilyID string `json:"family_id"`
	MemberID string `json:"member_id"`
}

type cacheSnapshot struct {
	SavedAt  int64        `json:"saved_at"`
	Families []famEntry   `json:"families"`
	Keys     []keyEntry   `json:"keys"`
	Phones   []phoneEntry `json:"phones"`
}

type inc8Entry struct {
	IncidentID string
	ExpiresAt  int64
}

// seenEntry is one incident's accepted HLC set plus the last time it was
// touched, which is what makes the set expirable rather than permanent.
type seenEntry struct {
	hlcs    map[string]struct{}
	touched int64
}

type floodEntry struct {
	At     []int64
	Target string
}

type metrics struct {
	Open, Append, Relay, SMS                 atomic.Uint64
	Unverified, Flood, Coalesced, Duplicates atomic.Uint64
	UnknownFamily, BadRequest, Unauthorised  atomic.Uint64
	WALFailures, PublishFailures             atomic.Uint64
	Projected, ProjectFailures, FanoutAPrime atomic.Uint64
	CacheRefreshes, CacheRefreshFailures     atomic.Uint64
}

func (m *metrics) snapshot() map[string]uint64 {
	return map[string]uint64{
		"incident_open": m.Open.Load(), "incident_append": m.Append.Load(),
		"incident_relay": m.Relay.Load(), "sms_inbound": m.SMS.Load(),
		"unverified_incidents": m.Unverified.Load(), "flood_observed": m.Flood.Load(),
		"coalesced": m.Coalesced.Load(), "duplicates": m.Duplicates.Load(),
		"unknown_family": m.UnknownFamily.Load(), "bad_request": m.BadRequest.Load(),
		"unauthorised": m.Unauthorised.Load(), "wal_failures": m.WALFailures.Load(),
		"publish_failures": m.PublishFailures.Load(), "projected": m.Projected.Load(),
		"project_failures": m.ProjectFailures.Load(), "fanout_a_prime": m.FanoutAPrime.Load(),
		"cache_refreshes": m.CacheRefreshes.Load(), "cache_refresh_failures": m.CacheRefreshFailures.Load(),
	}
}

// ── server ───────────────────────────────────────────────────────────────────

type Config struct {
	Addr          string
	DataDir       string
	GatewaySecret string
	RefreshEvery  time.Duration
	Logger        *slog.Logger
	Now           func() time.Time
	// FanoutSink receives the composed Class A′ alert (§2.4.6). It is INJECTED,
	// not imported: sos-ingest must never take a dependency on the notify stack,
	// or a bad deploy there becomes a bad deploy here (ADR-002). Whatever is
	// wired in must not persist the coordinates it is handed. Nil means the
	// alert is composed in memory and released — the correct behaviour when no
	// transport is attached.
	FanoutSink func(alert string) error
}

type Server struct {
	cfg     Config
	log     *slog.Logger
	now     func() time.Time
	started time.Time

	wal *wal.WAL
	bus *bus.Bus
	st  *store.Store

	cacheMu   sync.RWMutex
	fams      map[string]famEntry
	keys      map[string]envelope.VerifyingKey
	phones    map[string]phoneEntry
	cacheAt   int64
	cachePath string

	hotMu     sync.Mutex
	seen      map[string]*seenEntry // incident_id → hlcs accepted for it
	inc8      map[string]inc8Entry  // family_id|inc8 → incident_id
	flood     map[string]*floodEntry
	lastSweep int64

	projector *bus.Sub
	fanout    *bus.EphSub
	projSeen  *bus.Deduper
	sink      func(string) error
	gwSecret  []byte
	m         metrics
}

func New(cfg Config) (*Server, error) {
	if cfg.DataDir == "" {
		cfg.DataDir = "data"
	}
	if cfg.RefreshEvery <= 0 {
		cfg.RefreshEvery = defaultRefresh
	}
	if cfg.Logger == nil {
		cfg.Logger = logx.New(logx.Dev())
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	s := &Server{
		cfg: cfg, log: cfg.Logger, now: cfg.Now, started: cfg.Now(),
		fams: map[string]famEntry{}, keys: map[string]envelope.VerifyingKey{},
		phones: map[string]phoneEntry{}, seen: map[string]*seenEntry{},
		inc8: map[string]inc8Entry{}, flood: map[string]*floodEntry{},
		projSeen:  bus.NewDeduper(8192),
		sink:      cfg.FanoutSink,
		cachePath: filepath.Join(cfg.DataDir, "cache.json"),
		gwSecret:  []byte(cfg.GatewaySecret),
	}

	var err error
	if s.wal, err = wal.Open(filepath.Join(cfg.DataDir, "sos.wal")); err != nil {
		return nil, err
	}
	if s.bus, err = bus.Open(filepath.Join(cfg.DataDir, "bus")); err != nil {
		return nil, err
	}
	if s.st, err = store.Open(filepath.Join(cfg.DataDir, "store")); err != nil {
		return nil, err
	}

	// ★ F-22: warm the caches from disk BEFORE anything can be served. A restart
	// during a store outage that started with an empty cache would flag every
	// incident UNVERIFIED and rate-limit families it no longer recognises.
	s.loadCache()
	s.refreshCache() // best effort; a failure leaves the disk-warmed cache intact

	if err := s.replayWAL(); err != nil {
		return nil, err
	}
	if s.projector, err = s.bus.SubscribeDurable(projectorDurable, "fam.*.>", bus.StartAll, s.project); err != nil {
		return nil, err
	}
	if s.fanout, err = s.bus.SubscribeEphemeral("fam.*."+fanoutSubjectLeaf, s.fanOutAPrime); err != nil {
		return nil, err
	}
	if torn, at := s.wal.TornTailTruncated(); torn {
		s.log.Warn("wal_torn_tail_repaired", "offset", at)
	}
	return s, nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/incident/open", s.handleOpen)
	mux.HandleFunc("POST /v1/incident/append", s.handleAppend)
	mux.HandleFunc("POST /v1/incident/relay", s.handleRelay)
	mux.HandleFunc("POST /v1/incident/sms-inbound", s.handleSMSInbound)
	mux.HandleFunc("GET /healthz", s.handleHealth)
	return mux
}

func (s *Server) Close() error {
	if s.projector != nil {
		s.projector.Drain(2 * time.Second)
		s.projector.Close()
	}
	if s.fanout != nil {
		s.fanout.Close()
	}
	var first error
	for _, err := range []error{s.bus.Close(), s.st.Flush(), s.wal.Close()} {
		if err != nil && first == nil {
			first = err
		}
	}
	return first
}

// ── cache ────────────────────────────────────────────────────────────────────

func (s *Server) loadCache() {
	raw, err := os.ReadFile(s.cachePath)
	if err != nil {
		return
	}
	var snap cacheSnapshot
	if json.Unmarshal(raw, &snap) != nil {
		return
	}
	s.cacheMu.Lock()
	defer s.cacheMu.Unlock()
	for _, f := range snap.Families {
		s.fams[f.ID] = f
	}
	for _, k := range snap.Keys {
		// A key we cannot parse is skipped, not fatal: its device's incidents then
		// arrive flagged UNVERIFIED, which is ADR-018 doing its job. Refusing to
		// load the whole cache over one bad row would be strictly worse.
		if vk, err := envelope.ParseVerifyingKey(k.Pub); err == nil {
			s.keys[k.DeviceID] = vk
		}
	}
	for _, p := range snap.Phones {
		s.phones[p.Phone] = p
	}
	s.cacheAt = snap.SavedAt
	s.log.Info("key_cache_loaded_from_disk", "families", len(s.fams), "keys", len(s.keys),
		"age_s", (s.now().UnixMilli()-snap.SavedAt)/1000)
}

// refreshCache rebuilds the caches from the store and persists them. It runs off
// the request path, on a timer. If the store is unreachable the caches simply go
// stale — incidents keep flowing, which is the whole design.
func (s *Server) refreshCache() {
	fams := s.st.Families()
	if len(fams) == 0 && s.st.Counts()["family"] == 0 {
		// Nothing to learn. Keep whatever the disk cache gave us rather than
		// replacing a warm cache with an empty one.
		s.m.CacheRefreshFailures.Add(1)
		return
	}
	nf := make(map[string]famEntry, len(fams))
	snap := cacheSnapshot{SavedAt: s.now().UnixMilli()}
	for _, f := range fams {
		key, _ := base64.StdEncoding.DecodeString(f.SMSHMACKeyB64)
		e := famEntry{ID: f.ID, SMSKey: key}
		nf[f.ID] = e
		snap.Families = append(snap.Families, e)
	}
	nk := map[string]envelope.VerifyingKey{}
	for _, d := range s.st.AllDevices() {
		if d.RevokedAt != 0 {
			continue
		}
		pub, err := base64.StdEncoding.DecodeString(d.SigningPubkey)
		if err != nil {
			continue
		}
		vk, err := envelope.ParseVerifyingKey(pub)
		if err != nil {
			continue
		}
		nk[d.ID] = vk
		snap.Keys = append(snap.Keys, keyEntry{DeviceID: d.ID, FamilyID: d.FamilyID, MemberID: d.MemberID, Pub: pub})
	}
	np := map[string]phoneEntry{}
	for _, m := range s.st.AllMembers() {
		if m.PhoneE164 == "" {
			continue
		}
		e := phoneEntry{Phone: m.PhoneE164, FamilyID: m.FamilyID, MemberID: m.ID}
		np[m.PhoneE164] = e
		snap.Phones = append(snap.Phones, e)
	}

	s.cacheMu.Lock()
	s.fams, s.keys, s.phones, s.cacheAt = nf, nk, np, snap.SavedAt
	s.cacheMu.Unlock()

	if raw, err := json.Marshal(snap); err == nil {
		tmp := s.cachePath + ".tmp"
		if os.WriteFile(tmp, raw, 0o600) == nil {
			_ = os.Rename(tmp, s.cachePath)
		}
	}
	s.m.CacheRefreshes.Add(1)
}

func (s *Server) family(id string) (famEntry, bool) {
	s.cacheMu.RLock()
	defer s.cacheMu.RUnlock()
	f, ok := s.fams[id]
	return f, ok
}

func (s *Server) key(deviceID string) (envelope.VerifyingKey, bool) {
	s.cacheMu.RLock()
	defer s.cacheMu.RUnlock()
	k, ok := s.keys[deviceID]
	return k, ok && k.Valid()
}

func (s *Server) phone(e164 string) (phoneEntry, bool) {
	s.cacheMu.RLock()
	defer s.cacheMu.RUnlock()
	p, ok := s.phones[e164]
	return p, ok
}

// ── hot-path state: idempotency, inc8 index, flood guard ─────────────────────

// markSeen reports whether this exact (incident_id, hlc) has already been
// accepted. P-053: the client generates the id, so firing the same incident over
// five transports must cost one incident, not five.
func (s *Server) markSeen(incidentID, hlc string) bool {
	now := s.now().UnixMilli()
	s.hotMu.Lock()
	defer s.hotMu.Unlock()
	e, ok := s.seen[incidentID]
	if !ok {
		s.sweepLocked(now) // only when the map is about to grow
		e = &seenEntry{hlcs: map[string]struct{}{}}
		s.seen[incidentID] = e
	}
	e.touched = now
	if _, dup := e.hlcs[hlc]; dup {
		return true
	}
	e.hlcs[hlc] = struct{}{}
	return false
}

// sweepLocked drops hot-path entries that can no longer affect a decision.
// Expiry is safe because it is not the last line of defence: the projector
// dedupes again on (incident_id, hlc) in the store, so a retry arriving after
// inc8TTL still cannot duplicate a timeline — it merely costs one WAL record.
func (s *Server) sweepLocked(now int64) {
	if now-s.lastSweep < sweepEvery.Milliseconds() {
		return
	}
	s.lastSweep = now
	for id, e := range s.seen {
		if now-e.touched > inc8TTL.Milliseconds() {
			delete(s.seen, id)
		}
	}
	for k, e := range s.inc8 {
		if e.ExpiresAt <= now {
			delete(s.inc8, k)
		}
	}
	for k, e := range s.flood {
		if len(e.At) == 0 || e.At[len(e.At)-1] < now-floodWindow.Milliseconds() {
			delete(s.flood, k)
		}
	}
}

func (s *Server) rememberInc8(familyID, i8, incidentID string) {
	s.hotMu.Lock()
	defer s.hotMu.Unlock()
	s.inc8[familyID+"|"+i8] = inc8Entry{IncidentID: incidentID, ExpiresAt: s.now().Add(inc8TTL).UnixMilli()}
}

func (s *Server) lookupInc8(familyID, i8 string) (string, bool) {
	s.hotMu.Lock()
	defer s.hotMu.Unlock()
	e, ok := s.inc8[familyID+"|"+i8]
	if !ok {
		return "", false
	}
	if e.ExpiresAt <= s.now().UnixMilli() {
		delete(s.inc8, familyID+"|"+i8)
		return "", false
	}
	return e.IncidentID, true
}

// observeFlood counts UNVERIFIED opens per FAMILY inside the window and returns
// the count plus the coalesce target.
//
// ★ F-04. Keyed on family_id, never on device_id: device_id is an
// attacker-chosen field in an UNAUTHENTICATED body, so keying the exemption on
// it would let one forged field mint unlimited exemptions — an unbounded
// fan-out and unbounded spend vector. family_id is also attacker-chosen, but it
// must name a family that actually exists, which bounds the whole thing.
func (s *Server) observeFlood(familyID, incidentID string) (int, string) {
	now := s.now().UnixMilli()
	cutoff := now - floodWindow.Milliseconds()
	s.hotMu.Lock()
	defer s.hotMu.Unlock()
	e, ok := s.flood[familyID]
	if !ok {
		e = &floodEntry{}
		s.flood[familyID] = e
	}
	kept := e.At[:0]
	for _, t := range e.At {
		if t > cutoff {
			kept = append(kept, t)
		}
	}
	e.At = kept
	if len(e.At) == 0 {
		e.Target = incidentID // the window's first unverified incident absorbs the rest
	}
	e.At = append(e.At, now)
	return len(e.At), e.Target
}

// ── request plumbing ─────────────────────────────────────────────────────────

type inbound struct {
	raw       []byte
	sig       string
	eventType string
	transport string
	relayedBy string
}

func (s *Server) read(w http.ResponseWriter, r *http.Request) (*inbound, bool) {
	body, err := io.ReadAll(io.LimitReader(r.Body, envelope.MaxBodyBytes))
	if err != nil || len(body) == 0 {
		s.problem(w, http.StatusBadRequest, "KV-1001", "unreadable body")
		return nil, false
	}
	in := &inbound{}
	var wrapper struct {
		envelope.Signed
		EventType string `json:"eventType"`
		Transport string `json:"transport"`
		RelayedBy string `json:"relayedBy"`
	}
	if json.Unmarshal(body, &wrapper) == nil && wrapper.Body != "" {
		in.raw, in.sig = []byte(wrapper.Body), wrapper.Signature
		in.eventType, in.transport, in.relayedBy = wrapper.EventType, wrapper.Transport, wrapper.RelayedBy
	} else {
		// Raw-envelope form: body is the canonical envelope, signature in a header.
		in.raw = body
	}
	if in.sig == "" {
		in.sig = r.Header.Get("X-Sig")
	}
	if in.transport == "" {
		in.transport = "http"
	}
	return in, true
}

func (s *Server) problem(w http.ResponseWriter, code int, kv, detail string) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"type": "about:blank", "title": kv, "status": code, "detail": detail,
	})
}

func (s *Server) writeAck(w http.ResponseWriter, a ack) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(a)
}

// commit is steps 4–6, shared by every accepting path: fsync, publish, ack.
func (s *Server) commit(rec record, subjectLeaf string) []byte {
	blob, err := json.Marshal(rec)
	if err != nil {
		return nil
	}
	if _, err := s.wal.AppendSync(blob); err != nil {
		// Durability failed, but the family has not been told anything yet. Publish
		// anyway: a delivered alert with no WAL row beats a WAL row nobody reads.
		s.m.WALFailures.Add(1)
		s.log.Error("wal_append_failed", "incident", rec.IncidentID, "err", err)
	}
	if _, err := s.bus.PublishMsg(bus.Msg{
		Subject: bus.Subject(rec.FamilyID, strings.Split(subjectLeaf, ".")...),
		Kind:    rec.Kind, IncidentID: rec.IncidentID, FamilyID: rec.FamilyID,
		HLC: rec.HLC, At: rec.At, Data: blob,
	}); err != nil {
		s.m.PublishFailures.Add(1)
		s.log.Error("bus_publish_failed", "incident", rec.IncidentID, "err", err)
	}
	return blob
}

// ── handlers ─────────────────────────────────────────────────────────────────

func (s *Server) handleOpen(w http.ResponseWriter, r *http.Request) {
	s.m.Open.Add(1)
	s.ingestEnvelope(w, r, bus.KindIncidentOpen, "incident", 0)
}

func (s *Server) handleAppend(w http.ResponseWriter, r *http.Request) {
	s.m.Append.Add(1)
	s.ingestEnvelope(w, r, bus.KindIncidentEvent, "incident.event", 0)
}

// handleRelay accepts a BLE peer relay. The body and signature are the ORIGINAL
// subject's — the relaying phone is a carrier, not the author — so the HLC and
// the signature are preserved verbatim and verified against the ORIGINAL
// device's key (§2.9.2). Rewriting either would destroy the causal timeline the
// whole mesh exists to protect.
func (s *Server) handleRelay(w http.ResponseWriter, r *http.Request) {
	s.m.Relay.Add(1)
	s.ingestEnvelope(w, r, bus.KindIncidentEvent, "incident.event", envelope.FlagRelay)
}

func (s *Server) ingestEnvelope(w http.ResponseWriter, r *http.Request, kind, leaf string, extraFlags int64) {
	in, ok := s.read(w, r)
	if !ok {
		return
	}
	env, anomaly, err := envelope.Parse(in.raw)
	if err != nil {
		s.m.BadRequest.Add(1)
		s.problem(w, http.StatusBadRequest, "KV-1001", "malformed envelope")
		return
	}
	if _, known := s.family(env.FamilyID); !known {
		// F-04: fail open, but BOUNDED. An unknown family is nobody to help.
		s.m.UnknownFamily.Add(1)
		s.problem(w, http.StatusNotFound, "KV-1001", "unknown family")
		return
	}

	verified := false
	if pk, ok := s.key(env.DeviceID); ok {
		verified = pk.VerifyB64(in.raw, in.sig)
	}
	flags := env.Flags | extraFlags
	incidentID, coalescedInto := env.IncidentID, ""
	if !verified {
		// ADR-018: accept, flag, count. A bad signature during an emergency is far
		// more likely to be a stale key cache than an attack.
		flags |= envelope.FlagUnverified
		s.m.Unverified.Add(1)
		if n, target := s.observeFlood(env.FamilyID, env.IncidentID); n > floodThreshold {
			s.m.Flood.Add(1)
			flags |= envelope.FlagUnverifiedFlood
			if target != "" && target != incidentID {
				incidentID, coalescedInto = target, target
				s.m.Coalesced.Add(1)
			}
		}
	}
	if anomaly != 0 {
		s.log.Warn("envelope_anomaly", "incident", incidentID, "anomaly", anomaly.String(), "verified", verified)
	}

	now := s.now().UnixMilli()
	if dup := s.markSeen(incidentID, env.HLC); dup {
		// KV-1003. §2.9.3 tells clients to treat a duplicate as success, so we
		// answer 200 and carry the code in the body: a 409 on an SOS retry is a
		// client bug generator, and this endpoint exists to remove those.
		s.m.Duplicates.Add(1)
		s.writeAck(w, ack{IncidentID: incidentID, ServerTsMs: now, Verified: verified,
			Flags: flags, Duplicate: true, Code: "KV-1003", CoalescedInto: coalescedInto})
		return
	}

	eventType := in.eventType
	if kind == bus.KindIncidentOpen || eventType == "" {
		eventType = openEvent()
	}
	s.rememberInc8(env.FamilyID, envelope.Inc8(incidentID), incidentID)

	s.commit(record{
		Kind: kind, At: now, FamilyID: env.FamilyID, IncidentID: incidentID,
		DeviceID: env.DeviceID, HLC: env.HLC, Transport: transportFor(in, extraFlags),
		EventType: eventType, Flags: flags, Verified: verified,
		Signature: in.sig, Body: string(in.raw), RelayedBy: in.relayedBy,
	}, leaf)

	s.writeAck(w, ack{IncidentID: incidentID, ServerTsMs: now, Verified: verified,
		Flags: flags, CoalescedInto: coalescedInto})
}

func transportFor(in *inbound, extraFlags int64) string {
	if extraFlags&envelope.FlagRelay != 0 {
		return "ble_relay"
	}
	return in.transport
}

// openEvent maps an opened incident onto the state machine. By the time an
// envelope leaves a device the incident IS pending, whatever the trigger:
// SUSPECT/PROBE/confidence all happened on-device and are not the server's
// business (§7.5). IDLE --MANUAL_TRIGGER--> PENDING is that transition.
func openEvent() string { return string(sm.EventManualTrigger) }

// ── sms-inbound (F-09 + F-10) ────────────────────────────────────────────────

type smsWebhook struct {
	From         string `json:"from"`
	Text         string `json:"text"`
	ReceivedAtMs int64  `json:"receivedAtMs"`
}

func (s *Server) handleSMSInbound(w http.ResponseWriter, r *http.Request) {
	s.m.SMS.Add(1)
	if len(s.gwSecret) > 0 {
		got := []byte(r.Header.Get("X-Gateway-Secret"))
		if subtle.ConstantTimeCompare(got, s.gwSecret) != 1 {
			s.m.Unauthorised.Add(1)
			s.problem(w, http.StatusUnauthorized, "KV-1002", "gateway secret mismatch")
			return
		}
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, envelope.MaxBodyBytes))
	if err != nil {
		s.problem(w, http.StatusBadRequest, "KV-1001", "unreadable body")
		return
	}
	var hook smsWebhook
	if json.Unmarshal(body, &hook) != nil || hook.Text == "" {
		s.m.BadRequest.Add(1)
		s.problem(w, http.StatusBadRequest, "KV-1001", "malformed webhook")
		return
	}
	// Step 1: resolve family from the sender MSISDN — in-memory, never the store.
	who, known := s.phone(strings.TrimSpace(hook.From))
	if !known {
		s.m.UnknownFamily.Add(1)
		s.problem(w, http.StatusNotFound, "KV-1001", "unknown sender")
		return
	}
	dec, signedBody, ok := envelope.DecodeSMS(hook.Text)
	if !ok {
		s.m.BadRequest.Add(1)
		s.problem(w, http.StatusBadRequest, "KV-1001", "not a K1 payload")
		return
	}
	// Step 2: verify sig8 — fail open (ADR-018).
	verified := false
	if fam, ok := s.family(who.FamilyID); ok && len(fam.SMSKey) > 0 {
		verified = hmac.Equal([]byte(envelope.SMSTag(fam.SMSKey, signedBody)), []byte(dec.Sig))
	}
	flags := int64(envelope.FlagSMSOrigin)
	if !verified {
		flags |= envelope.FlagUnverified
		s.m.Unverified.Add(1)
	}

	at := hook.ReceivedAtMs
	if at == 0 {
		at = s.now().UnixMilli()
	}
	// Step 3: inc8 index first; on miss mint a DETERMINISTIC id so a SECOND SMS
	// with the same inc8 maps to the same incident instead of a third.
	incidentID, hit := s.lookupInc8(who.FamilyID, dec.Inc8)
	if !hit {
		window := at / 1000 / smsWindowSeconds
		incidentID = envelope.UUIDv5(who.FamilyID + "|" + dec.Inc8 + "|" + strconv.FormatInt(window, 10))
	}
	s.rememberInc8(who.FamilyID, dec.Inc8, incidentID)

	now := s.now().UnixMilli()
	hlc := smsHLC(dec.AtMs, at)
	if dup := s.markSeen(incidentID, hlc); dup {
		s.m.Duplicates.Add(1)
		s.writeAck(w, ack{IncidentID: incidentID, ServerTsMs: now, Verified: verified,
			Flags: flags, Duplicate: true, Code: "KV-1003"})
		return
	}

	// ★ Class A′ (§2.4.6). The precise pair is used for fan-out IN MEMORY ONLY.
	// The durable envelope carries the ≈1 km cell and nothing finer.
	env := &envelope.Envelope{
		V: 1, IncidentID: incidentID, FamilyID: who.FamilyID, DeviceID: "",
		MemberID: who.MemberID, ClientTsMs: dec.AtMs, HLC: hlc,
		Trigger: envelope.TriggerForCode(dec.Code), ConfidencePct: 100, RiskContext: 0,
		Duress: false, IsDrill: dec.Code == "DRL", PolicyVersion: 1,
		CoarseCell: envelope.CoarseCell(dec.Lat, dec.Lon), BatteryPct: int64(dec.BatteryPct),
		SealedPayload: "", Flags: flags,
	}
	if err := envelope.Pad(env); err != nil {
		s.problem(w, http.StatusRequestEntityTooLarge, "KV-1004", "envelope too large")
		return
	}
	s.commit(record{
		Kind: bus.KindIncidentOpen, At: now, FamilyID: who.FamilyID, IncidentID: incidentID,
		HLC: env.HLC, Transport: "sms", EventType: string(sm.EventManualTrigger),
		Flags: flags, Verified: verified, Body: string(envelope.Canonical(env)),
		Synthetic: !hit,
	}, "incident")

	// The accountability row: "your precise location was sent unencrypted by SMS
	// during incident X". Durable, coarse, and surfaced to the subject.
	s.commit(record{
		Kind: bus.KindAccessLog, At: now, FamilyID: who.FamilyID, IncidentID: incidentID,
		HLC: env.HLC + ":access", Access: &store.AccessLog{
			FamilyID: who.FamilyID, AccessorMemberID: who.MemberID, SubjectMemberID: who.MemberID,
			What:    "precise location sent unencrypted by SMS (Class A′)",
			Context: incidentID, At: now, DegradedPlaintext: true,
		},
	}, "access")

	// Ephemeral: never written, never replayable, gone the moment fan-out ends.
	s.bus.PublishEphemeral(bus.Msg{
		Subject: bus.Subject(who.FamilyID, fanoutSubjectLeaf), Kind: bus.KindLocationPrecise,
		IncidentID: incidentID, FamilyID: who.FamilyID, HLC: env.HLC, At: now,
		Data: mustJSON(map[string]any{
			"lat": dec.Lat, "lon": dec.Lon, "accuracyM": dec.AccuracyM,
			"shortName": dec.ShortName, "trigger": envelope.TriggerForCode(dec.Code),
		}),
	})

	s.writeAck(w, ack{IncidentID: incidentID, ServerTsMs: now, Verified: verified, Flags: flags})
}

// fanOutAPrime consumes the precise pair in memory and produces the alert text
// the notify workers send. It records that the fan-out happened; it never
// records where. The durable coarse-cell incident is written by the projector.
func (s *Server) fanOutAPrime(m bus.Msg) error {
	var p struct {
		// Separate tags: a shared `json:"lat"` silently decodes longitude from the
		// latitude field, and the responder is sent to the wrong place.
		Lat       float64 `json:"lat"`
		Lon       float64 `json:"lon"`
		ShortName string  `json:"shortName"`
		Trigger   string  `json:"trigger"`
	}
	if json.Unmarshal(m.Data, &p) != nil {
		return nil
	}
	alert := fmt.Sprintf("%s %s. %.6f,%.6f", p.ShortName, p.Trigger, p.Lat, p.Lon)
	if s.sink != nil {
		if err := s.sink(alert); err != nil {
			s.log.Error("a_prime_sink_failed", "incident", m.IncidentID, "err", err)
		}
	}
	s.m.FanoutAPrime.Add(1)
	// Size, never content. The whole point of A′ is that this string exists for
	// the duration of one fan-out and leaves no trace anywhere.
	s.log.Info("a_prime_fanout", "incident", m.IncidentID, "bytes", len(alert))
	return nil
}

// ── health ───────────────────────────────────────────────────────────────────

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	torn, tornAt := s.wal.TornTailTruncated()
	s.cacheMu.RLock()
	fams, keys, cacheAt := len(s.fams), len(s.keys), s.cacheAt
	s.cacheMu.RUnlock()
	dead := 0
	if s.projector != nil {
		dead = len(s.projector.DeadLetters())
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"status": "ok", "uptimeS": int64(s.now().Sub(s.started).Seconds()),
		"walRecords": s.wal.Count(), "walBytes": s.wal.Size(),
		"walTornTailRepaired": torn, "walTornAt": tornAt,
		"busSeq": s.bus.LastSeq(), "busEphemeralDropped": s.bus.EphemeralDropped(),
		"cachedFamilies": fams, "cachedKeys": keys,
		"cacheAgeS":   (s.now().UnixMilli() - cacheAt) / 1000,
		"deadLetters": dead, "piiViolations": logx.Violations(),
		"metrics": s.m.snapshot(),
	})
}

// ── projector: everything that touches the store, off the request path ───────

func (s *Server) project(m bus.Msg) error {
	if m.IncidentID != "" && s.projSeen.Has(m.IncidentID, m.HLC) {
		return nil
	}
	var rec record
	if json.Unmarshal(m.Data, &rec) != nil {
		return nil // an unparseable record cannot become parseable on retry
	}
	var err error
	switch rec.Kind {
	case bus.KindIncidentOpen:
		err = s.projectOpen(rec)
	case bus.KindIncidentEvent:
		err = s.projectEvent(rec)
	case bus.KindAccessLog:
		err = s.projectAccess(rec)
	default:
		return nil
	}
	if err != nil {
		s.m.ProjectFailures.Add(1)
		return err
	}
	s.projSeen.Seen(m.IncidentID, m.HLC)
	s.m.Projected.Add(1)
	return nil
}

func (s *Server) projectOpen(rec record) error {
	env, _, err := envelope.Parse([]byte(rec.Body))
	if err != nil {
		return nil
	}
	if _, ok := s.st.Family(rec.FamilyID); !ok {
		// The control plane owns family creation. Nothing to attach to yet, and
		// retrying forever would stall the stream.
		return nil
	}
	state := sm.StatePending
	if env.Duress {
		// A duress PIN was entered: silent escalation, no visible change on the
		// device, ladder still climbing (§7.5).
		if next, ok := sm.NextState(state, sm.EventPinDuress, nil); ok {
			state = next
		}
	}
	inc, exists := s.st.Incident(rec.IncidentID)
	if !exists {
		inc = store.Incident{
			ID: rec.IncidentID, FamilyID: rec.FamilyID, SubjectMemberID: env.MemberID,
			State: state, Trigger: env.Trigger, PolicyVersion: int(env.PolicyVersion),
			Duress: env.Duress, IsDrill: env.IsDrill, CoarseH3R7: env.CoarseCell,
			OpenedAt: env.ClientTsMs, Inc8: envelope.Inc8(rec.IncidentID),
			SyntheticFromSms: rec.Synthetic, ConfidencePct: int(env.ConfidencePct),
			RiskContext: int(env.RiskContext), SealedPayload: env.SealedPayload,
		}
		if inc.OpenedAt == 0 {
			inc.OpenedAt = rec.At
		}
	}
	inc.Flags |= int(rec.Flags)
	inc.ServerReceivedAt = rec.At
	if env.CoarseCell != "" {
		inc.CoarseH3R7 = env.CoarseCell
	}
	// Auto-quiesce backstop (F-02): a forgotten incident must not freeze deploys
	// or keep escalation timers armed forever.
	if inc.AutoQuiesceAt == 0 {
		inc.AutoQuiesceAt = inc.OpenedAt + int64(quiesceAfterS())*1000
	}
	if err := s.st.PutIncident(inc); err != nil {
		return err
	}
	if err := s.st.AppendEvent(store.Event{
		IncidentID: rec.IncidentID, FamilyID: rec.FamilyID, HLC: rec.HLC,
		EventType: rec.EventType, SealedPayload: env.SealedPayload,
		SourceDeviceID: rec.DeviceID, SourceTransport: rec.Transport,
		PolicyVersion: int(env.PolicyVersion), ServerReceivedAt: rec.At,
		LocalCreatedAt: env.ClientTsMs, Flags: int(rec.Flags),
	}); err != nil {
		return err
	}
	return s.armTimers(inc)
}

func (s *Server) projectEvent(rec record) error {
	inc, exists := s.st.Incident(rec.IncidentID)
	if !exists {
		// An append can outrun its open across transports; materialise the incident
		// from the envelope the append itself carries rather than dropping it.
		return s.projectOpen(record{
			Kind: bus.KindIncidentOpen, At: rec.At, FamilyID: rec.FamilyID,
			IncidentID: rec.IncidentID, DeviceID: rec.DeviceID, HLC: rec.HLC,
			Transport: rec.Transport, EventType: string(sm.EventManualTrigger),
			Flags: rec.Flags, Verified: rec.Verified, Body: rec.Body,
		})
	}
	env, _, err := envelope.Parse([]byte(rec.Body))
	if err != nil {
		return nil
	}
	if err := s.st.AppendEvent(store.Event{
		IncidentID: rec.IncidentID, FamilyID: rec.FamilyID, HLC: rec.HLC,
		EventType: rec.EventType, SealedPayload: env.SealedPayload,
		SourceDeviceID: rec.DeviceID, SourceTransport: rec.Transport,
		PolicyVersion: int(env.PolicyVersion), ServerReceivedAt: rec.At,
		LocalCreatedAt: env.ClientTsMs, Flags: int(rec.Flags),
	}); err != nil {
		return err
	}
	// The projection is recomputable from the log (§7.5); we advance it here so
	// the deploy-freeze view is correct without a full fold on every read.
	if next, ok := sm.NextState(inc.State, sm.Event(rec.EventType), nil); ok {
		inc.State = next
		if sm.IsTerminal(next) && inc.ResolvedAt == 0 {
			inc.ResolvedAt = rec.At
		}
		inc.Flags |= int(rec.Flags)
		if err := s.st.PutIncident(inc); err != nil {
			return err
		}
		return s.armTimers(inc)
	}
	return nil
}

func (s *Server) projectAccess(rec record) error {
	if rec.Access == nil {
		return nil
	}
	if _, ok := s.st.Family(rec.FamilyID); !ok {
		return nil
	}
	return s.st.AppendAccess(*rec.Access)
}

// armTimers arms the escalation ladder straight from the generated state
// machine, so the server's timing and the device's timing come from one spec.
func (s *Server) armTimers(inc store.Incident) error {
	if sm.IsTerminal(inc.State) {
		return nil
	}
	base := inc.ServerReceivedAt
	if base == 0 {
		base = inc.OpenedAt
	}
	// ★ D-025 ★ The rung id is DERIVED, not minted, so a second open record for
	// an incident whose state has not moved derives the same ids — and PutTimer
	// is a blind upsert. Re-arming would put a rung an escalation worker is
	// already holding back to pending with attempts 0, and push a live deadline
	// out by the gap between the two reports. F-04 coalescing makes that
	// reachable from a repeated SOS, which is what a frightened person sends.
	// Skip per rung ID, never per incident: project() marks a record seen only
	// on success, so a redelivery after a partial failure must still arm what
	// is missing. A cancelled rung is skipped too — the engine cancelled it on
	// purpose and this binary does not get to resurrect its ladder.
	armed := make(map[string]bool, 2)
	for _, tm := range s.st.TimersForIncident(inc.ID) {
		armed[tm.ID] = true
	}
	for _, t := range sm.TimeoutsFor(inc.State) {
		id := inc.ID + "|" + string(inc.State) + "|" + string(t.On)
		if armed[id] {
			continue
		}
		if err := s.st.PutTimer(store.Timer{
			ID: id, FamilyID: inc.FamilyID, IncidentID: inc.ID,
			Action: string(t.On), TargetTier: tierFor(t.To),
			PolicyVersion: inc.PolicyVersion, FireAt: base + int64(t.AfterS)*1000,
			State: store.TimerPending, CreatedAt: s.now().UnixMilli(),
		}); err != nil {
			return err
		}
	}
	return nil
}

func tierFor(st sm.State) int {
	switch st {
	case sm.StateActiveL2:
		return 2
	case sm.StateActiveL3:
		return 3
	case sm.StateDormant:
		return 0
	default:
		return 1
	}
}

// quiesceAfterS reads the auto-quiesce delay out of the generated machine rather
// than hard-coding 6 hours in a second place.
func quiesceAfterS() int {
	for _, t := range sm.Transitions {
		if t.On == sm.EventAutoQuiesce && t.AfterS > 0 {
			return t.AfterS
		}
	}
	return 21600
}

// ── boot recovery ────────────────────────────────────────────────────────────

// replayWAL rebuilds the idempotency and inc8 indexes from durable state, and
// re-publishes anything the bus stream lost. Without this a restart mid-incident
// would mint a duplicate incident for the very next retry the phone sends.
func (s *Server) replayWAL() error {
	inStream := map[string]struct{}{}
	if err := s.bus.Replay("fam.>", 0, func(m bus.Msg) error {
		inStream[m.IncidentID+"|"+m.HLC] = struct{}{}
		return nil
	}); err != nil {
		return err
	}
	var replayed, republished int
	if err := s.wal.Replay(func(_ uint64, _ int64, payload []byte) error {
		var rec record
		if json.Unmarshal(payload, &rec) != nil {
			return nil
		}
		replayed++
		s.markSeen(rec.IncidentID, rec.HLC)
		if rec.IncidentID != "" && rec.FamilyID != "" {
			s.rememberInc8(rec.FamilyID, envelope.Inc8(rec.IncidentID), rec.IncidentID)
		}
		if _, ok := inStream[rec.IncidentID+"|"+rec.HLC]; ok {
			return nil
		}
		leaf := "incident"
		switch rec.Kind {
		case bus.KindIncidentEvent:
			leaf = "incident.event"
		case bus.KindAccessLog:
			leaf = "access"
		}
		if _, err := s.bus.PublishMsg(bus.Msg{
			Subject: bus.Subject(rec.FamilyID, strings.Split(leaf, ".")...),
			Kind:    rec.Kind, IncidentID: rec.IncidentID, FamilyID: rec.FamilyID,
			HLC: rec.HLC, At: rec.At, Data: payload,
		}); err != nil {
			return err
		}
		republished++
		return nil
	}); err != nil {
		return err
	}
	if replayed > 0 {
		s.log.Info("wal_replayed", "records", replayed, "republished", republished)
	}
	return nil
}

// smsHLC synthesises an ordering stamp for an SMS, which carries none. Derived
// from the payload's own second-resolution timestamp so that the same message
// delivered twice by the carrier produces the same stamp and dedupes.
func smsHLC(atMs, fallbackMs int64) string {
	if atMs == 0 {
		atMs = fallbackMs
	}
	return fmt.Sprintf("%012x0000sms000", atMs)
}

func mustJSON(v any) []byte {
	raw, err := json.Marshal(v)
	if err != nil {
		return []byte("{}")
	}
	return raw
}

// ── main ─────────────────────────────────────────────────────────────────────

func main() {
	addr := flag.String("addr", envOr("KAVACH_SOS_ADDR", ":8081"), "listen address")
	dataDir := flag.String("data", envOr("KAVACH_SOS_DATA", "data/sos-ingest"), "data directory")
	flag.Parse()

	log := logx.New(logx.Dev())
	srv, err := New(Config{
		Addr: *addr, DataDir: *dataDir,
		GatewaySecret: os.Getenv("KAVACH_SMS_GATEWAY_SECRET"),
		Logger:        log,
	})
	if err != nil {
		log.Error("boot_failed", "err", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		t := time.NewTicker(srv.cfg.RefreshEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				srv.refreshCache()
			}
		}
	}()

	h := &http.Server{
		Addr: *addr, Handler: srv.Handler(),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second,
		WriteTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second,
	}
	go func() {
		log.Info("sos_ingest_listening", "addr", *addr, "data", *dataDir)
		if err := h.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("listen_failed", "err", err)
			stop()
		}
	}()

	<-ctx.Done()
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = h.Shutdown(shutdown)
	if err := srv.Close(); err != nil {
		log.Error("shutdown_error", "err", err)
	}
	log.Info("sos_ingest_stopped")
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
